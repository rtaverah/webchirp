# Driver de WebCHIRP para el "Kenwood TK-3407 (clon)": un radio chino vendido como Kenwood TK-3407 que por
# dentro es de la familia Retevis RT22 / LUITON LT-316 (Motorola C1), pero con otro saludo.
#
# EXPERIMENTAL. Reutiliza de CHIRP (sin modificarlo) la clase LT316 (_ranges, _memsize); el saludo, la lectura
# y la grabación son propios y tolerantes al ruido del cable:
#   PC "PROGRAM" (byte a byte, ~50 ms) -> radio 0x06 (puede haber ruido/eco antes: se descarta)
#   PC 0x02 -> radio "P32073" F8 FF
#   PC 0x06 -> radio 0x06
#   Lectura: SIN paso 07 (el radio real no lo contesta). Bloques de 0x40 con 'R' (0x20 si el primero llega corto).
#   Si el primer bloque no llega: 'E', espera y se repite la sesión completa enviando 07 (acepta 'N' o nada).
#   Grabación: mismo saludo (sin 07); por cada región de _ranges, bloques 'W' addrH addrL tamaño + datos, byte a
#   byte con 5 ms de pausa (como _rt22_write_block de CHIRP), y se espera 06 por bloque.
#   Si el primer bloque no recibe 06: 'E', 1.5 s, saludo con 07 y un solo reintento de ese bloque.
#   Fin: PC 'E'
import logging
import struct
import time

from chirp import chirp_common, directory, errors, memmap

from chirp.drivers import retevis_rt22

LOG = logging.getLogger(__name__)

ACK = b'\x06'
PROGRAM = b'PROGRAM'
BYTE_GAP = 0.05             # pausa entre bytes de PROGRAM
ACK_WINDOW = 1.0            # segundos buscando el 0x06 tras PROGRAM
GREETING_TRIES = 3
RETRY_WAIT = 1.5            # espera entre la sesión sin 07 y la repetición con 07
BLOCK_SIZES = (0x40, 0x20)  # 0x20: algunos clones Kenwood leen de 32 en 32
BLOCK_TRIES = 3
IDENT_TAG = b'P3207'
IDENT_LEN = 8
IMAGE_IDENT_ADDR = 0x1B8    # donde las imágenes RT22 guardan la identidad
WRITE_BYTE_GAP = 0.005      # pausa entre bytes al escribir un bloque (igual que _rt22_write_block)
WRITE_BLOCK_RETRIES = 2     # reintentos de un bloque posterior al primero


def _hex(data):
    return data.hex(' ').upper() or 'nada'


def _ascii(data):
    return ''.join(chr(x) if 32 <= x < 127 else '.' for x in data)


def _read_until(pipe, window, done):
    """Lee durante hasta `window` segundos, parando en cuanto done(buf) sea verdadero. Devuelve lo recibido."""
    buf = b''
    old = pipe.timeout
    pipe.timeout = 0.1
    try:
        end = time.monotonic() + window
        while time.monotonic() < end and not done(buf):
            buf += pipe.read(16)
    finally:
        pipe.timeout = old
    return buf


def _step(pipe, name, send, want):
    """Envía `send` y espera un byte `want`; si llega otra cosa, error que dice el paso y lo recibido."""
    pipe.write(send)
    got = _read_until(pipe, 1.0, lambda b: len(b) >= 1)
    LOG.info('Paso %s: enviado %s, recibido %s', name, _hex(send), _hex(got))
    if got[:1] != want:
        raise errors.RadioError('Falló el paso %s del saludo: se esperaba %s y llegó %s.'
                                % (name, _hex(want), _hex(got)))


class _FirstBlockError(errors.RadioError):
    """El primer bloque no llegó (sin respuesta, cabecera distinta o corto)."""


@directory.register
class KenwoodTK3407Clone(retevis_rt22.LT316):
    """Kenwood TK-3407 (clon, familia Retevis RT22) - EXPERIMENTAL"""
    VENDOR = 'Kenwood'
    MODEL = 'TK-3407 (clon)'

    @classmethod
    def get_prompts(cls):
        rp = chirp_common.RadioPrompts()
        rp.experimental = ('Este controlador es EXPERIMENTAL. Antes de grabar, lea el radio y guarde '
                           'esa copia de respaldo: si la grabación se corta, hay que volver a grabarla.')
        rp.pre_upload = ('Conecte el cable de programación, encienda el radio y espere a que esté en reposo. '
                         'No lo apague ni desconecte el cable mientras graba.')
        rp.pre_download = ('Conecte el cable de programación, encienda el radio y espere a que esté en reposo. '
                           'Si falla, apáguelo y enciéndelo y reintente.')
        return rp

    @classmethod
    def match_model(cls, filedata, filename):
        return False        # se identifica por los metadatos del archivo

    # ---------------------------------------------------------------- saludo
    def _wait_ack(self):
        """Hasta 3 intentos de PROGRAM; en cada uno se busca el 0x06 y se descarta todo lo demás."""
        pipe = self.pipe
        seen = b''
        for attempt in range(1, GREETING_TRIES + 1):
            pipe.reset_input_buffer()
            for b in PROGRAM:
                pipe.write(bytes([b]))
                time.sleep(BYTE_GAP)
            got = _read_until(pipe, ACK_WINDOW, lambda buf: ACK in buf)
            i = got.find(ACK)
            junk = got if i < 0 else got[:i] + got[i + 1:]
            LOG.info('Saludo, intento %i de %i: recibido %s; descartado %s', attempt, GREETING_TRIES,
                     _hex(got), _hex(junk))
            seen += got
            if i >= 0:
                return
            time.sleep(0.3)
        if not seen:
            raise errors.RadioError('El radio no respondió al saludo PROGRAM (no llegó nada). '
                                    'Revise el cable y que el radio esté encendido.')
        raise errors.RadioError('El radio no aceptó el modo de programación (no llegó 06). Recibido: %s'
                                % _hex(seen[:20]))

    def _enter(self, send07):
        """Saludo completo. Con send07=True manda además el paso 07 y acepta 'N' o nada."""
        pipe = self.pipe
        self._wait_ack()
        self._acked = True      # el radio ya contestó: al salir hay que mandarle 'E'
        pipe.write(b'\x02')
        got = _read_until(pipe, 1.0, lambda b: b.find(IDENT_TAG) >= 0 and len(b) - b.find(IDENT_TAG) >= IDENT_LEN)
        i = got.find(IDENT_TAG)
        LOG.info('Identidad: hex %s | ASCII %r', _hex(got), _ascii(got))
        if i < 0 or len(got) - i < IDENT_LEN:
            raise errors.RadioError('Falló el paso 02 (identidad): se esperaba P3207... (8 bytes) y llegó %s.'
                                    % _hex(got))
        _step(pipe, '06 (confirmación)', b'\x06', ACK)
        self._got07 = None
        if send07:
            pipe.write(b'\x07')
            self._got07 = _read_until(pipe, 1.0, lambda b: len(b) >= 1)
            LOG.info('Paso 07: enviado 07, recibido %s (se acepta N o nada)', _hex(self._got07))

    def _drain(self, why, window=0.2):
        """Vacía la entrada y registra lo descartado."""
        junk = _read_until(self.pipe, window, lambda b: False)
        self.pipe.reset_input_buffer()
        LOG.info('Antes de %s: descartado %s', why, _hex(junk))

    def _request(self, addr, size, first=False):
        """Pide un bloque 'R'. Devuelve (respuesta completa, cabecera esperada)."""
        pipe = self.pipe
        cmd = struct.pack('>cHb', b'R', addr, size)
        for j in range(len(cmd)):       # byte a byte, como RT22
            time.sleep(0.005)
            pipe.write(cmd[j:j + 1])
        want = b'W' + cmd[1:]
        resp = _read_until(pipe, 1.0, lambda b: len(b) >= 4 + size)
        if first:
            LOG.info('Primer bloque: enviado %s, recibidos %i bytes: %s', _hex(cmd), len(resp), _hex(resp[:16]))
        return resp, want

    def _ack_block(self, addr):
        self.pipe.write(ACK)
        ack = _read_until(self.pipe, 1.0, lambda b: len(b) >= 1)
        if ack[:1] != ACK:
            raise errors.RadioError('No se pudo leer el bloque 0x%04X: el radio no confirmó (llegó %s).'
                                    % (addr, _hex(ack)))

    def _read_first_block(self):
        """Lee el bloque 0x0000 (0x40, o 0x20 si llega corto). Devuelve (datos, tamaño de bloque)."""
        self._drain('leer el primer bloque')
        seen = []
        for size in BLOCK_SIZES:
            resp, want = self._request(0, size, first=True)
            seen.append('bloque 0x%02X: %s' % (size, _hex(resp[:16])))
            if resp[:4] == want and len(resp) >= 4 + size:
                self._ack_block(0)
                if size != BLOCK_SIZES[0]:
                    LOG.info('El radio responde con bloques de 0x%02X; se usa ese tamaño', size)
                return resp[4:], size
            if resp[:4] != want:
                break               # sin respuesta o cabecera distinta: no sirve probar otro tamaño
            LOG.info('Cabecera correcta pero bloque corto (%i de %i bytes); se prueba con otro tamaño',
                     len(resp) - 4, size)
            self._drain('reintentar con otro tamaño de bloque')
        raise _FirstBlockError('; '.join(seen))

    def _read_all(self):
        data, size = self._read_first_block()
        status = chirp_common.Status()
        status.msg = 'Leyendo el radio'
        status.max = self._memsize
        for addr in range(size, self._memsize, size):
            status.cur = addr + size
            self.status_fn(status)
            n = min(size, self._memsize - addr)
            for attempt in range(1, BLOCK_TRIES + 1):
                resp, want = self._request(addr, n)
                if resp[:4] == want and len(resp) >= 4 + n:
                    break
                LOG.warning('Bloque %04X incompleto (%s); reintento %i de %i', addr, _hex(resp[:8]),
                            attempt, BLOCK_TRIES)
                self._drain('reintentar el bloque')
            else:
                raise errors.RadioError('No se pudo leer el bloque 0x%04X: llegó %s.' % (addr, _hex(resp[:8])))
            self._ack_block(addr)
            data += resp[4:]
        if len(data) != self._memsize:
            raise errors.RadioError('Lectura incompleta: %i de %i bytes.' % (len(data), self._memsize))
        return data

    # ---------------------------------------------------------------- lectura
    def sync_in(self):
        self._acked = False
        failures = []
        data = None
        try:
            for send07 in (False, True):
                label = 'con 07' if send07 else 'sin 07'
                try:
                    self._enter(send07)
                    data = self._read_all()
                    break
                except _FirstBlockError as e:
                    got07 = '' if not send07 else ' (tras 07 llegó %s)' % _hex(self._got07 or b'')
                    failures.append('variante %s%s: el primer bloque no llegó bien; %s' % (label, got07, e))
                    LOG.warning('%s', failures[-1])
                    try:
                        self.pipe.write(b'E')
                    except Exception as e2:
                        LOG.warning('No se pudo mandar la salida: %s', e2)
                    if not send07:
                        LOG.info('Se repite la sesión completa enviando 07, tras %.1f s', RETRY_WAIT)
                        time.sleep(RETRY_WAIT)
                except errors.RadioError as e:
                    if failures:
                        raise errors.RadioError('%s (variante %s, después de: %s)' % (e, label, failures[0]))
                    raise
            if data is None:
                raise errors.RadioError('El radio saludó bien pero no entregó el primer bloque de memoria. '
                                        'Se probaron dos variantes. %s.' % ' | '.join(failures))
        except errors.RadioError:
            raise
        except Exception as e:
            LOG.exception('Error inesperado durante la lectura')
            raise errors.RadioError('Error inesperado al comunicarse con el radio: %s' % e)
        finally:
            if self._acked:         # el radio ya contestó: se le manda la salida para liberarlo
                try:
                    self.pipe.write(b'E')
                except Exception as e:
                    LOG.warning('No se pudo mandar la salida: %s', e)
        self._mmap = memmap.MemoryMapBytes(data)
        self.process_mmap()

    # ---------------------------------------------------------------- grabación
    def check_image_before_upload(self):
        """Se llama antes de abrir el puerto: la imagen debe ser completa y de un radio P3207x."""
        size = len(self.get_mmap())
        if size != self._memsize:
            raise errors.RadioError('La imagen mide %i bytes y debe medir %i: no se grabó nada.'
                                    % (size, self._memsize))
        ident = bytes(self.get_mmap()[IMAGE_IDENT_ADDR:IMAGE_IDENT_ADDR + IDENT_LEN])
        if not ident.startswith(IDENT_TAG):
            raise errors.RadioError('La imagen no es de un radio P3207x (en 0x%03X hay %s): no se grabó nada.'
                                    % (IMAGE_IDENT_ADDR, _hex(ident)))

    def _send_block(self, addr, size):
        """Envía 'W' addr tamaño + datos byte a byte (como CHIRP) y devuelve (comando+datos, respuesta)."""
        pipe = self.pipe
        cmd = struct.pack('>cHb', b'W', addr, size)
        frame = cmd + bytes(self.get_mmap()[addr:addr + size])
        for j in range(len(frame)):
            time.sleep(WRITE_BYTE_GAP)
            pipe.write(frame[j:j + 1])
        return frame, _read_until(pipe, 1.0, lambda b: len(b) >= 1)

    def _write_first_block(self, addr, size, tag):
        self._drain('escribir el primer bloque')
        frame, resp = self._send_block(addr, size)
        LOG.info('Primer bloque (%s): enviado %s; respuesta %s', tag, _hex(frame), _hex(resp))
        return resp

    def _write_all(self):
        blocks = [(a, min(size, end - a)) for start, end, size in self._ranges for a in range(start, end, size)]
        status = chirp_common.Status()
        status.msg = 'Grabando en el radio'
        status.max = self._memsize
        first_addr, first_size = blocks[0]
        status.cur = first_addr + first_size
        self.status_fn(status)
        resp = self._write_first_block(first_addr, first_size, 'sin 07')
        if resp[:1] != ACK:
            LOG.warning('El primer bloque no recibió 06 (llegó %s); se manda E y se repite el saludo con 07',
                        _hex(resp))
            self.pipe.write(b'E')
            time.sleep(RETRY_WAIT)
            self._enter(True)
            resp2 = self._write_first_block(first_addr, first_size, 'con 07')
            if resp2[:1] != ACK:
                raise errors.RadioError('El radio no aceptó la grabación; no se escribió nada más allá del '
                                        'primer bloque. Respuesta sin 07: %s; respuesta con 07: %s.'
                                        % (_hex(resp), _hex(resp2)))
        for addr, size in blocks[1:]:
            status.cur = addr + size
            self.status_fn(status)
            for attempt in range(1 + WRITE_BLOCK_RETRIES):
                if attempt:
                    self._drain('reintentar el bloque de escritura')
                    LOG.warning('Bloque 0x%04X sin 06; reintento %i de %i', addr, attempt, WRITE_BLOCK_RETRIES)
                _, resp = self._send_block(addr, size)
                if resp[:1] == ACK:
                    break
            else:
                raise errors.RadioError(
                    'El radio no confirmó el bloque 0x%04X (llegó %s) tras %i intentos. El radio puede haber '
                    'quedado a medias: apáguelo, enciéndalo y vuelva a grabar el respaldo.'
                    % (addr, _hex(resp), 1 + WRITE_BLOCK_RETRIES))

    def sync_out(self):
        self._acked = False
        try:
            self.check_image_before_upload()
            self._enter(False)      # si la identidad no es P3207..., falla aquí sin escribir
            self._write_all()
        except errors.RadioError:
            raise
        except Exception as e:
            LOG.exception('Error inesperado durante la grabación')
            raise errors.RadioError('Error inesperado al comunicarse con el radio: %s' % e)
        finally:
            if self._acked:
                try:
                    self.pipe.write(b'E')
                except Exception as e:
                    LOG.warning('No se pudo mandar la salida: %s', e)
