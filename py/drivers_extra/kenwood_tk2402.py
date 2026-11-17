# Driver de WebCHIRP para los Kenwood TK-2402 (VHF) y TK-3402 (UHF).
#
# NO viene de CHIRP ni se basa en el código de otro programa: es una implementación propia, con estilo
# CHIRP, escrita a partir de los hechos del protocolo (secuencia de saludo, cifrado XOR, mapa de memoria),
# que no tienen derechos de autor. EXPERIMENTAL: FASE 1, SOLO LECTURA. La grabación está desactivada
# hasta confirmar el mapa de memoria con una lectura real.
#
# Protocolo (9600 baudios, 8 bits, sin paridad, 2 bits de parada):
#   PC "PROGRAM"  -> radio 0x16 -> el PC pasa a 19200 baudios -> radio 0x06
#   PC 0x02       -> radio ~40 bytes de identidad
#   PC 0x00 (clave 1), PC 0x06 -> radio 0x06
#   desde aquí todo va con XOR (clave fija 0xBB):
#   PC 'P'^BB -> radio 10 bytes -> PC 0x06^BB -> radio confirma
#   Lectura:  PC ['R',hi,lo,len]^BB (10 ms entre bytes) -> radio cabecera de 4 bytes ('W',hi,lo,len)^BB
#             + len bytes de datos ^BB -> PC 0x06^BB -> radio confirma
#   Fin:      PC 'E'^BB
import logging
import time

from chirp import chirp_common, directory, errors, memmap, util
from chirp.settings import (RadioSetting, RadioSettingGroup, RadioSettings,
                            RadioSettingValueString)

LOG = logging.getLogger(__name__)

KEY = 0xBB                  # clave XOR fija de la segunda capa
ACK = 0x06
LISTENING = 0x16
EEPROM_SIZE = 0x2000
GREETING_BYTEWISE = True    # saludo byte a byte (False = método anterior, solo para comparar en pruebas)
BLOCK = 0x20
CH_BASE = 0x12C0            # 16 canales de 0x20 bytes: 0x12C0-0x14BF
CH_COUNT = 16
CH_END = CH_BASE + CH_COUNT * BLOCK
ADDR_MODEL = 0x0070         # "P2402\r" + 0xFF
ADDR_BUTTON = 0x0FD0
ADDR_ENABLE = 0x1000        # mapa de bits invertido de canales habilitados (2 bytes)

# Valores de relleno de un canal nuevo (hechos del formato)
CHANNEL_TEMPLATE = bytes([0xFF, 0xFF] + [0xFF] * 4 + [0xFF] * 4 + [0xFF, 0xFF] + [0xFF, 0xFF, 0xFF, 0xFF]
                         + [0x18, 0xEC, 0xE6, 0x00] + [0xFF] * 8 + [0x00, 0x0F, 0xFF, 0xFF])
assert len(CHANNEL_TEMPLATE) == 0x20

# Pasos de frecuencia (bandera, divisor en unidades de 10 Hz), en este orden de prioridad
FREQ_STEPS = [(2, 1250), (1, 500), (0, 750), (3, 250)]


def _x(data):
    return bytes(b ^ KEY for b in data)


def _decode_freq(raw):
    """4 bytes -> Hz. Son 8 dígitos BCD en unidades de 10 Hz con los bytes en orden inverso
    (146.520 MHz = 14652000 -> 00 20 65 14). 0xFF o dígitos no BCD = sin frecuencia."""
    if len(raw) != 4 or raw[3] == 0xFF or raw[2] == 0xFF:
        return 0
    digits = ''.join('%02X' % b for b in reversed(raw))
    if not digits.isdigit():
        return 0
    return int(digits) * 10


def _encode_freq(hz):
    n = int(round(hz / 10.0))
    digits = '%08d' % n
    return bytes(int(digits[i:i + 2], 16) for i in range(6, -1, -2))


def _step_flag(hz):
    frac = int(round((hz % 1000000) / 10.0))      # parte decimal en unidades de 10 Hz
    for flag, div in FREQ_STEPS:
        if frac % div == 0:
            return flag
    return 0


def _decode_qt(raw):
    """2 bytes little-endian = décimas de Hz (67.0 Hz = 670). 0 o 0xFFFF = sin tono."""
    v = raw[0] | (raw[1] << 8)
    if v in (0, 0xFFFF) or not (600 <= v <= 2600):
        return None if v in (0, 0xFFFF) else ('?', v)
    return v / 10.0


def _encode_qt(tone):
    v = int(round(tone * 10))
    return bytes([v & 0xFF, v >> 8])


class _Protocol:
    """Conversación con el radio a través de radio.pipe (puerto serie tipo pyserial).

    Los cables Kenwood de dos pines (tipo KPG-22) unen TX y RX en un solo hilo: todo lo que se envía
    vuelve a llegar como ECO. Se detecta tras "PROGRAM" y, en modo eco, cada envío (_send) lee de
    vuelta exactamente los mismos bytes antes de seguir."""

    def __init__(self, pipe):
        self.pipe = pipe
        self.echo = False
        self.established = False     # solo entonces tiene sentido enviar 'E' al terminar
        self.acked = False           # el radio ya contestó 0x06/0x16 al saludo

    def _read_exact(self, n):
        got = b''
        while len(got) < n:
            chunk = self.pipe.read(n - len(got))
            if not chunk:
                break
            got += chunk
        return got

    def _send(self, data, lenient=False):
        """Envía y, si el cable hace eco, lee y comprueba el eco de esos mismos bytes.

        Con lenient=True no lanza el error: devuelve el mensaje (para terminar de enviar un comando
        completo antes de reintentar y no dejar al radio con medio comando)."""
        data = bytes(data)
        self.pipe.write(data)
        if self.echo:
            got = self._read_exact(len(data))
            if got != data:
                msg = ('Eco del cable no coincide: posible cable dañado o radio respondiendo a la vez '
                       '(enviado %s, eco %s)' % (data.hex(), got.hex() or 'nada'))
                if lenient:
                    return msg
                raise errors.RadioError(msg)
        return None

    def _greet_block(self):
        """(Método anterior, solo para comparar en pruebas) Envía PROGRAM de una vez y devuelve la respuesta real (hasta ~20), separando el eco.

        El eco puede llegar troceado, incompleto (parte ya vaciada) o con la respuesta pegada detrás:
        se ignoran los bytes iniciales que coincidan con el final (o el inicio) de lo enviado."""
        p = self.pipe
        prog = b'PROGRAM'
        p.write(prog)
        time.sleep(0.01)
        p.timeout = 0.4
        buf = b''
        for _ in range(12):                      # se acumula mientras siga llegando algo
            chunk = p.read(16)
            if not chunk:
                break
            buf += chunk
        p.timeout = 2
        # eco = bytes iniciales que coinciden con el final de lo enviado (eco completo o con el inicio perdido)
        k = next((n for n in range(len(prog), 0, -1) if buf[:n] == prog[-n:]), 0)
        if k == 0:
            # eco cortado al final (todavía llegando): coincide con el inicio de lo enviado
            kp = next((n for n in range(len(prog), 0, -1) if buf[:n] == prog[:n]), 0)
            if kp:
                more = self._read_exact(len(prog) - kp)
                buf += more
                k = kp + len(more) if (prog[:kp] + more) == prog else 0
                if k == 0:
                    raise errors.RadioError('Eco del cable no coincide: posible cable dañado o radio respondiendo a la vez '
                                            '(enviado %s, recibido %s)' % (prog.hex(), buf[:20].hex(' ')))
        self.echo = k > 0
        LOG.info('Modo eco: %s%s', 'sí (el cable devuelve lo que se envía)' if self.echo else 'no',
                 ' (eco parcial de %i bytes: el resto ya se había vaciado)' % k if 0 < k < len(prog) else '')
        rest = buf[k:]
        if not rest:
            rest = p.read(20)
        if len(rest) < 20:
            p.timeout = 0.1
            rest += p.read(20 - len(rest))
            p.timeout = 2
        return rest[:20]

    def _greet(self):
        """Envía PROGRAM BYTE A BYTE y devuelve los bytes de la respuesta real (hasta ~20).

        En un cable de un solo hilo, si el radio empieza a responder mientras todavía sale PROGRAM, las
        señales chocan: el eco se corta y puede llegar un byte alterado (bit 7 en 1) seguido del 0x06/0x16
        del radio. Por eso: se escribe 1 byte, se lee su eco con un timeout corto, y lo que no sea eco
        (0x06/0x16) se guarda como respuesta sin tratarlo como error. La verificación estricta del eco
        solo se aplica después del saludo."""
        if not GREETING_BYTEWISE:
            return self._greet_block()
        p = self.pipe
        prog = b'PROGRAM'
        letters = {b & 0x7F for b in prog}
        echoed = 0
        found = b''          # bytes que no son eco (respuesta del radio)
        raw = b''            # todo lo recibido, para mostrarlo si falla
        p.timeout = 0.05
        for b in prog:
            p.write(bytes([b]))
            got = p.read(1)
            raw += got
            if not got:
                continue
            if (got[0] & 0x7F) == (b & 0x7F):
                echoed += 1                      # eco (igual o con el bit 7 alterado)
            elif got[0] in (LISTENING, ACK):
                found += got                     # el radio ya responde (el eco de este byte se perdió)
            elif (got[0] & 0x7F) in letters:
                echoed += 1                      # eco de otra letra de PROGRAM (corrida/alterada)
            else:
                found += got
            time.sleep(0.002)
        # se junta durante ~300 ms todo lo que siga llegando y se quita lo que sea eco
        p.timeout = 0.3
        tail = b''
        for _ in range(12):
            chunk = p.read(16)
            if not chunk:
                break
            tail += chunk
        raw += tail
        p.timeout = 2
        for x in tail:
            if (x & 0x7F) in letters:
                echoed += 1
            else:
                found += bytes([x])
        self.echo = echoed > 0
        LOG.info('Modo eco: %s (%i de %i bytes de PROGRAM devueltos)', 'sí' if self.echo else 'no', echoed, len(prog))
        LOG.info('Recibido durante el saludo: %s', raw.hex(' ') or 'nada')
        # la respuesta es el primer 0x16 o 0x06 que quede
        for i, x in enumerate(found):
            if x in (LISTENING, ACK):
                return found[i:i + 20]
        if not found:
            more = p.read(1)                     # un radio lento: se espera hasta el timeout normal
            if more and more[0] in (LISTENING, ACK):
                return more
            found += more
        if not found:
            return b''
        raise errors.RadioError('El radio no aceptó el modo de programación (no apareció 0x16 ni 0x06). '
                                'Bytes recibidos tras PROGRAM: %s' % raw[:20].hex(' '))

    def enter(self):
        """Saludo completo. Si el radio ya contestó (0x06/0x16) y un paso posterior falla, se le manda la
        salida 'E' (sin XOR: la clave aún no está activa) antes de lanzar el error, para no dejarlo colgado."""
        try:
            return self._enter_steps()
        except Exception:
            if self.acked and not self.established:
                try:
                    self.pipe.write(b'E')
                except Exception as e:
                    LOG.warning('No se pudo mandar la salida tras el fallo: %s', e)
            raise

    def _enter_steps(self):
        p = self.pipe
        p.timeout = 2
        # 9600 8N2 (en Web Serial cambiar los parámetros reabre el puerto)
        try:
            p.stopbits = 2
        except Exception as e:
            LOG.warning('No se pudo fijar 2 bits de parada: %s', e)
        time.sleep(0.01)
        rest = self._greet()
        if not rest:
            raise errors.RadioNoResponse()
        first = rest[0]
        self.acked = first in (LISTENING, ACK)
        if first == LISTENING:
            # Camino del TK-2402: 0x16 y el radio pasa a 19200. El eco de lo enviado antes del cambio ya se
            # leyó. En Web Serial cambiar los baudios cierra y reabre el puerto; no se vacía el búfer en
            # ese cambio (podría llevarse el 0x06 legítimo del radio).
            LOG.info('Camino del saludo: 0x16 -> cambio a 19200 baudios')
            if hasattr(p, 'drain_on_reconfig'):
                p.drain_on_reconfig = False
            p.baudrate = 19200
            if not (len(rest) > 1 and rest[1] == ACK):
                conf = p.read(1)
                if conf != bytes([ACK]):
                    LOG.warning('Tras cambiar a 19200 no llegó el 0x06 (%r); se continúa', conf)
        elif first == ACK:
            # Hipótesis para el TK-3402: contesta 0x06 directamente, sin 0x16 ni cambio de baudios
            LOG.info('Camino del saludo: 0x06 directo -> se sigue a 9600 baudios (sin cambiar de velocidad)')
        else:
            raise errors.RadioError('El radio no aceptó el modo de programación (respondió %02X en vez de 16 o 06). '
                                    'Bytes recibidos tras PROGRAM: %s' % (first, rest.hex(' ')))
        ident = self._read_identity()
        LOG.info('Identidad del radio (%i bytes): hex %s | ASCII %r', len(ident), ident.hex(' '),
                 ''.join(chr(x) if 32 <= x < 127 else '.' for x in ident))
        k = ident.find(b'P3207')
        if 0 <= k <= 4:
            # clon de la familia Retevis RT22 (responde 'P32073'); enter() manda la 'E' al fallar
            raise errors.RadioError('Este radio no es un Kenwood original: responde como la familia Retevis RT22. '
                                    'Elija Kenwood → TK-3407 (clon) y vuelva a leer.')
        if len(ident) < 8:
            raise errors.RadioError('Identidad del radio incompleta (%i bytes: %s)' % (len(ident), ident[:20].hex(' ')))
        self._send_greeting(b'\x00', 0)    # clave de la primera capa (0x00 = sin cambio)
        time.sleep(0.01)
        self._confirm_send(0x00, greeting=True)
        resp = self._send_greeting(bytes([0x50 ^ KEY]), 10)      # 'P': versión de software
        if len(resp) < 10:
            raise errors.RadioError('Respuesta de versión incompleta (%i de 10 bytes: %s)' % (len(resp), resp.hex(' ')))
        self._confirm_send(KEY, greeting=True)
        self.established = True
        return ident

    def _send_greeting(self, data, resp_len):
        """Como _send pero solo para el saludo: si lo leído no es el eco, se toma como parte de la
        respuesta (el eco se perdió por choque en el hilo) en vez de fallar. Devuelve hasta resp_len bytes.
        Límite: si el byte enviado y el de respuesta son iguales no se distinguen."""
        data = bytes(data)
        self.pipe.write(data)
        resp = b''
        if self.echo:
            got = self._read_exact(len(data))
            if got != data:
                LOG.warning('Saludo: se esperaba el eco %s y llegó %s; se toma como respuesta del radio',
                            data.hex(' '), got.hex(' ') or 'nada')
                resp = got
        if len(resp) < resp_len:
            resp += self._read_exact(resp_len - len(resp))
        return resp[:resp_len]

    def _read_identity(self):
        """Envía 0x02 y devuelve la identidad (hasta 40 bytes), tolerando un eco perdido o tardío."""
        self.pipe.write(b'\x02')
        ident = b''
        if self.echo:
            got = self._read_exact(1)
            if got != b'\x02':
                # (a) el eco del 0x02 se perdió por choque y lo leído ya es el inicio de la identidad;
                # (b) o es un eco tardío de PROGRAM. Se guarda y abajo se separa la basura.
                LOG.warning('Identidad: se esperaba el eco 02 y llegó %s; se toma como inicio de la respuesta',
                            got.hex(' ') or 'nada')
                ident = got
        ident += self._read_exact(40 - len(ident))
        # Caso (b), conservador: solo se quita si, dentro de los primeros 7 bytes, aparece un 0x02 y TODO lo
        # anterior son letras de PROGRAM (sin bit 7). Una identidad real que empiece con 'P' (p. ej. 'P3402')
        # no cumple porque sus siguientes bytes no son letras de PROGRAM seguidas de 0x02.
        i = ident[:7].find(b'\x02')
        if i > 0 and all(x in b'PROGRAM' for x in ident[:i]):
            LOG.warning('Identidad: se quitan %i bytes de eco tardío de PROGRAM (%s) y el 02 de eco',
                        i, ident[:i].hex(' '))
            ident = ident[i + 1:]
            ident += self._read_exact(40 - len(ident))
        return ident

    def _confirm_send(self, key, greeting=False):
        p = self.pipe
        if greeting:
            c = self._send_greeting(bytes([ACK ^ key]), 1)
        else:
            self._send(bytes([ACK ^ key]))
            time.sleep(0.01)
            c = p.read(1)
        if len(c) != 1 or (c[0] ^ key) != ACK:
            raise errors.RadioError('El radio no confirmó (recibido %s)' % (c.hex(' ') or 'nada'))

    def read_block(self, addr, length):
        """Lee un bloque; si el eco del cable no coincide, se reintenta el bloque una vez."""
        try:
            return self._read_block_once(addr, length)
        except errors.RadioError as e:
            if 'Eco del cable' not in str(e):
                raise
            LOG.warning('Bloque 0x%04X: %s; se reintenta una vez', addr, e)
            time.sleep(0.3)                  # se deja pasar lo que el radio siga enviando y se descarta
            self.pipe.reset_input_buffer()
            # el radio recibió el comando completo y espera el ACK del bloque: se cierra esa transacción
            try:
                self.pipe.write(bytes([ACK ^ KEY]))
                time.sleep(0.15)
            except Exception:
                pass
            self.pipe.reset_input_buffer()
            return self._read_block_once(addr, length)

    def _read_block_once(self, addr, length):
        p = self.pipe
        bad = None
        for b in (0x52, addr >> 8, addr & 0xFF, length):      # 'R', dirección, largo
            r = self._send(bytes([b ^ KEY]), lenient=True)    # el comando se envía completo aunque falle un eco
            bad = bad or r
            time.sleep(0.01)
        if bad:
            raise errors.RadioError(bad)
        head = p.read(4)
        want = bytes([0x57, addr >> 8, addr & 0xFF, length])    # 'W' ...
        if _x(head) != want:
            raise errors.RadioError('Cabecera inesperada en 0x%04X: %s' % (addr, head.hex()))
        data = p.read(length)
        if len(data) != length:
            raise errors.RadioError('Bloque 0x%04X incompleto (%i de %i bytes)' % (addr, len(data), length))
        self._confirm_send(KEY)
        return _x(data)

    def end(self):
        """Termina la sesión ('E'). Solo se llama si el saludo completo se hizo bien."""
        if not self.established:
            return
        try:
            self._send(bytes([0x45 ^ KEY]))                      # 'E'
            self.pipe.read(1)
        except Exception as e:
            LOG.warning('No se pudo terminar la sesión: %s', e)


@directory.register
class KenwoodTK2402(chirp_common.CloneModeRadio):
    """Kenwood TK-2402 (VHF) - EXPERIMENTAL, solo lectura (no viene de CHIRP)"""
    VENDOR = 'Kenwood'
    MODEL = 'TK-2402'
    BAUD_RATE = 9600
    VALID_BANDS = (136000000, 174000000)
    MODEL_TAG = b'P2402'
    OTHER_TAGS = (b'P3402',)
    POWER_LEVELS = [chirp_common.PowerLevel('Low', watts=1.0), chirp_common.PowerLevel('High', watts=5.0)]
    _memsize = EEPROM_SIZE

    @classmethod
    def get_prompts(cls):
        rp = chirp_common.RadioPrompts()
        rp.experimental = (
            'Este controlador es EXPERIMENTAL y no viene de CHIRP. Por ahora solo LEE el radio: la grabación '
            'está desactivada hasta confirmar el mapa de memoria con una lectura real. La lectura guarda toda '
            'la memoria accesible, así que el archivo sirve como copia de seguridad.')
        rp.pre_download = ('Conecta el cable de programación al radio, enciéndelo y espera a que esté en '
                           'reposo. Si falla, apágalo y enciéndelo y reintenta.')
        return rp

    @classmethod
    def match_model(cls, filedata, filename):
        return False        # se identifica por los metadatos del archivo

    def get_features(self):
        rf = chirp_common.RadioFeatures()
        rf.has_settings = True
        rf.has_bank = False
        rf.has_name = False
        rf.has_tuning_step = False
        rf.has_dtcs = False
        rf.has_rx_dtcs = False
        rf.has_dtcs_polarity = False
        rf.has_ctone = True
        rf.has_cross = True
        rf.has_offset = True
        rf.can_odd_split = True
        rf.memory_bounds = (1, CH_COUNT)
        rf.valid_bands = [self.VALID_BANDS]
        rf.valid_modes = ['FM', 'NFM']
        rf.valid_tmodes = ['', 'Tone', 'TSQL', 'Cross']
        rf.valid_cross_modes = ['Tone->Tone']
        rf.valid_duplexes = ['', '+', '-', 'split', 'off']
        rf.valid_skips = ['', 'S']
        rf.valid_power_levels = self.POWER_LEVELS
        rf.valid_tones = list(chirp_common.TONES)
        rf.valid_tuning_steps = [2.5, 5.0, 6.25, 12.5]
        return rf

    def process_mmap(self):
        pass        # los canales se decodifican a mano desde self._mmap

    # ---------------------------------------------------------------- lectura
    def sync_in(self):
        pipe = self.pipe
        proto = _Protocol(pipe)
        data = bytearray(b'\xff' * EEPROM_SIZE)
        failed = []
        status = chirp_common.Status()
        status.msg = 'Leyendo la memoria del radio'
        status.max = EEPROM_SIZE
        try:
            ident = proto.enter()
            # primero lo imprescindible (canales, modelo, botón, habilitación) y después el resto
            vital = [(a, BLOCK) for a in range(CH_BASE, CH_END, BLOCK)] + \
                    [(ADDR_MODEL & ~0x1F, BLOCK), (ADDR_BUTTON & ~0x1F, BLOCK), (ADDR_ENABLE, BLOCK)]
            rest = [(a, BLOCK) for a in range(0, EEPROM_SIZE, BLOCK) if (a, BLOCK) not in vital]
            consecutive = 0
            done = 0
            for addr, length in vital + rest:
                critical = (addr, length) in vital
                try:
                    data[addr:addr + length] = proto.read_block(addr, length)
                    consecutive = 0
                except errors.RadioError as e:
                    LOG.warning('Bloque 0x%04X no se pudo leer: %s', addr, e)
                    failed.append(addr)
                    pipe.reset_input_buffer()
                    if critical:
                        raise errors.RadioError('No se pudo leer la zona de canales/modelo (0x%04X): %s' % (addr, e))
                    consecutive += 1
                    if consecutive >= 4:
                        LOG.warning('Cuatro bloques seguidos sin respuesta; se deja el resto sin leer')
                        break
                done += BLOCK
                status.cur = min(done, EEPROM_SIZE)
                self.status_fn(status)
        finally:
            proto.end()
        tag = bytes(data[ADDR_MODEL:ADDR_MODEL + 5])
        LOG.info('Modelo en 0x%04X: %r; bloques sin leer: %s', ADDR_MODEL, tag, [hex(a) for a in failed])
        if tag in self.OTHER_TAGS:
            raise errors.RadioError('El radio dice ser %s pero elegiste %s %s. Elige el modelo correcto.'
                                    % (tag.decode('ascii', 'replace'), self.VENDOR, self.MODEL))
        self._mmap = memmap.MemoryMapBytes(bytes(data))
        self.process_mmap()

    def sync_out(self):
        raise errors.RadioError(
            'Grabación aún no disponible para este modelo: primero necesitamos una lectura real para '
            'confirmar el mapa de memoria. Por ahora el archivo sirve para copia de seguridad y para ver '
            'los canales.')

    # --------------------------------------------------------------- canales
    def _rec(self, number):
        off = CH_BASE + (number - 1) * BLOCK
        return bytes(self._mmap[off:off + BLOCK]), off

    def get_memory(self, number):
        rec, _ = self._rec(number)
        mem = chirp_common.Memory()
        mem.number = number
        rx = _decode_freq(rec[2:6])
        if rec[0] == 0xFF or rx == 0:
            mem.empty = True
            return mem
        tx = _decode_freq(rec[6:10]) or rx
        mem.freq = rx
        if tx == rx:
            mem.duplex = ''
        else:
            mem.duplex = 'split'
            mem.offset = tx
        rxqt, txqt = _decode_qt(rec[12:14]), _decode_qt(rec[14:16])
        if isinstance(rxqt, tuple) or isinstance(txqt, tuple):
            LOG.warning('Canal %i: subtono no reconocido %s %s', number, rxqt, txqt)
            rxqt = txqt = None
        mem.tmode = ''
        if txqt and rxqt and txqt == rxqt:
            mem.tmode, mem.rtone, mem.ctone = 'TSQL', txqt, rxqt
        elif txqt and rxqt:
            mem.tmode, mem.rtone, mem.ctone, mem.cross_mode = 'Cross', txqt, rxqt, 'Tone->Tone'
        elif txqt:
            mem.tmode, mem.rtone = 'Tone', txqt
        elif rxqt:
            mem.tmode, mem.rtone, mem.ctone, mem.cross_mode = 'Cross', 88.5, rxqt, 'Tone->Tone'
        psw = rec[17]
        mem.power = self.POWER_LEVELS[1 if psw & 0x20 else 0]
        mem.skip = 'S' if (psw & 0x10) else ''
        mem.mode = 'FM' if (psw & 0x01) else 'NFM'
        return mem

    def set_memory(self, mem):
        """Edita el canal en la imagen (EXPERIMENTAL; no se puede grabar en el radio todavía)."""
        rec, off = self._rec(mem.number)
        rec = bytearray(rec if rec[0] != 0xFF else CHANNEL_TEMPLATE)
        if mem.empty:
            self._mmap[off] = b'\xff' * BLOCK
            return
        rx = mem.freq
        tx = {'': rx, 'off': rx, '+': rx + mem.offset, '-': rx - mem.offset, 'split': mem.offset}[mem.duplex]
        rec[0] = mem.number
        rec[2:6] = _encode_freq(rx)
        rec[6:10] = _encode_freq(tx)
        rec[10] = _step_flag(rx)
        rec[11] = _step_flag(tx)
        none = b'\x00\x00'
        rxqt = txqt = none
        if mem.tmode == 'Tone':
            txqt = _encode_qt(mem.rtone)
        elif mem.tmode == 'TSQL':
            txqt = rxqt = _encode_qt(mem.ctone)
        elif mem.tmode == 'Cross':
            txqt, rxqt = _encode_qt(mem.rtone), _encode_qt(mem.ctone)
        rec[12:14], rec[14:16] = rxqt, txqt
        high = 1 if (mem.power is None or str(mem.power) == 'High') else 0
        rec[17] = 0xCC + high * 0x20 + (0x10 if mem.skip == 'S' else 0) + (1 if mem.mode == 'FM' else 0)
        self._mmap[off] = bytes(rec)

    def get_settings(self):
        """Datos del radio, solo lectura (para comprobar la lectura)."""
        mm = self._mmap
        model = bytes(mm[ADDR_MODEL:ADDR_MODEL + 6])
        enable = bytes(mm[ADDR_ENABLE:ADDR_ENABLE + 2])
        group = RadioSettingGroup('info', 'Información leída del radio (solo lectura)')

        def ro(name, label, value):
            v = RadioSettingValueString(0, 64, value)
            v.set_mutable(False)
            group.append(RadioSetting(name, label, v))
        ro('model', 'Modelo (0x0070)', model.decode('ascii', 'replace').strip('\r\x00\xff�'))
        ro('enable', 'Canales habilitados (0x1000, bitmap invertido)', '%02X %02X' % tuple(enable))
        ro('button', 'Botón programable 1 (0x0FD0)', '%02X' % bytes(mm[ADDR_BUTTON:ADDR_BUTTON + 1])[0])
        return RadioSettings(group)

    def set_settings(self, settings):
        pass        # solo lectura


@directory.register
class KenwoodTK3402(KenwoodTK2402):
    """Kenwood TK-3402 (UHF) - EXPERIMENTAL, solo lectura (no viene de CHIRP)"""
    MODEL = 'TK-3402'
    VALID_BANDS = (400000000, 520000000)
    MODEL_TAG = b'P3402'
    OTHER_TAGS = (b'P2402',)
