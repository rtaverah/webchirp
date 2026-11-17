"""Emuladores de radio (lado radio del protocolo) para probar WebCHIRP sin hardware.

Se ejecutan dentro de Pyodide. El FakeSerialPort de JavaScript les pasa lo que el
driver escribe (feed_js) y entrega por el puerto simulado lo que devuelven."""
import struct

from pyodide.ffi import to_js


class Emu:
    name = 'base'

    def reset(self):
        pass

    def on_open(self, baud):
        self.baud = baud
        if getattr(self, 'dirty_mode', False) and getattr(self, 'state', 'idle') != 'idle':
            self.dirty = True
        self.reset()

    def open_junk(self):
        """Bytes viejos que el radio 'suelta' justo al abrir el puerto (estado sucio)."""
        if getattr(self, 'dirty', False):
            self.dirty = False
            return to_js(b'\x06\x00')
        return to_js(b'')

    def mark_dirty(self):
        self.dirty = True

    def feed(self, data):
        return b''

    def feed_js(self, data, now=None):
        self.now = now
        out = self.feed(bytes(data.to_py()))
        return to_js(bytes(out))

    def memory_js(self):
        return to_js(bytes(self.mem))


class Uv5rEmu(Emu):
    """Baofeng UV-5R (driver uv5r.py): ident por 'magic', lectura S/X y escritura X por bloques."""
    name = 'UV-5R'

    def __init__(self, img, ident_ok=True):
        from chirp.drivers import uv5r
        self.magic = uv5r.UV5R_MODEL_291
        img = bytes(img)
        self.ident = img[:8]
        self.mem = bytearray(0x2000)
        self.mem[0:0x1800] = img[8:8 + 0x1800]
        self.mem[0x1EC0:0x2000] = img[8 + 0x1800:8 + 0x1800 + 0x140]
        self.writes = []   # (addr, len) escritos por el driver
        self.read_after_write = 0
        self.drop_write = None  # índice de una escritura que el radio "pierde" (acepta pero no guarda)
        self.reset()

    def reset(self):
        self.buf = b''
        self.state = 'idle'
        self.first = True

    def feed(self, data):
        self.buf += data
        out = b''
        while self.buf:
            b = self.buf
            if self.state == 'idle':
                if b == self.magic:
                    out += b'\x06'
                    self.state = 'magic'
                    self.buf = b''
                elif not self.magic.startswith(b):
                    self.buf = b''  # ruido: se ignora
                break
            if self.state == 'magic':
                self.buf = b[1:]
                if b[0] == 2:
                    out += self.ident
                    self.state = 'ident'
                continue
            if self.state == 'ident':
                self.buf = b[1:]
                if b[0] == 6:
                    out += b'\x06'
                    self.state = 'cmd'
                    self.first = True
                continue
            # estado 'cmd'
            c = b[0]
            if c == 0x06:
                self.buf = b[1:]
            elif c == 0x53:  # 'S' leer bloque
                if len(b) < 4:
                    break
                _, addr, size = struct.unpack('>BHB', b[:4])
                self.buf = b[4:]
                if self.writes:
                    self.read_after_write += 1
                if not self.first:
                    out += b'\x06'
                self.first = False
                out += struct.pack('>BHB', 0x58, addr, size) + bytes(self.mem[addr:addr + size])
            elif c == 0x58:  # 'X' escribir bloque
                if len(b) < 4:
                    break
                _, addr, size = struct.unpack('>BHB', b[:4])
                if len(b) < 4 + size:
                    break
                if self.drop_write is None or len(self.writes) != self.drop_write:
                    self.mem[addr:addr + size] = b[4:4 + size]
                self.writes.append((addr, size))
                self.buf = b[4 + size:]
                out += b'\x06'
            else:
                self.buf = b[1:]
        return out

    def regions_read(self):
        return [(0x0000, 0x1800), (0x1EC0, 0x2000)]


class H777Emu(Emu):
    """Baofeng BF-888 (driver h777.py): PROGRAM, ident, bloques de 8 bytes R/W, 'E' para salir."""
    name = 'BF-888'
    BLOCK = 8
    now = None
    max_gap = None     # segundos máximos entre bytes del saludo (None = sin control de tiempo)
    reboot_secs = 0    # tras 'E' el radio se reinicia y no atiende durante este tiempo
    reboot_mode = 'mute'   # 'mute' (no responde) o 'garbage' (responde 46/00)
    reboot_until = None
    dirty_mode = False   # tras una sesión sin 'E' o un saludo fallido, el siguiente saludo trae bytes viejos
    dirty = False
    last_t = None
    lose_next = 0        # cuántas respuestas 'R' siguientes llegan con la cola perdida
    lose_always = False  # todas las respuestas 'R' llegan cortas
    lost_blocks = 0

    def __init__(self, img, rclass_name='H777Radio'):
        from chirp.drivers import h777
        cls = getattr(h777, rclass_name)
        self.program = cls.PROGRAM_CMD
        self.ident = cls.IDENT[0].ljust(8, b'\x00')
        self.ranges = cls._ranges
        self.mem = bytearray(bytes(img)[:cls._memsize].ljust(cls._memsize, b'\xff'))
        self.writes = []
        self.read_after_write = 0
        self.drop_write = None
        self.reset()

    def reset(self):
        self.buf = b''
        self.state = 'idle'

    def end_reboot(self):
        self.reboot_until = None

    def feed(self, data):
        if self.reboot_until is not None and self.now is not None:
            if self.now < self.reboot_until:
                self.buf = b''
                return b'\x46' if self.reboot_mode == 'garbage' else b''
            self.reboot_until = None
        if self.state == 'idle' and self.max_gap and self.now is not None:
            if self.buf and self.last_t is not None and self.now - self.last_t > self.max_gap:
                self.buf = b''   # el saludo se enfrió: el radio lo ignora
            self.last_t = self.now
        self.buf += data
        out = b''
        while self.buf:
            b = self.buf
            if self.state == 'idle':
                b = b.lstrip(b'\x02')
                if b == self.program:
                    out += b'\x06'
                    self.state = 'prog'
                    self.buf = b''
                elif self.program.startswith(b):
                    self.buf = b
                else:
                    self.buf = b''  # ruido: se ignora
                break
            if self.state == 'prog':
                self.buf = b[1:]
                if b[0] == 2:
                    out += self.ident
                    self.state = 'ident'
                continue
            if self.state == 'ident':
                self.buf = b[1:]
                if b[0] == 6:
                    out += b'\x06'
                    self.state = 'seven' if getattr(self, 'needs07', False) else 'cmd'
                continue
            if self.state == 'seven':
                self.buf = b[1:]
                if b[0] == 7:
                    out += b'N'
                    self.state = 'cmd'
                continue
            c = b[:1]
            if c == b'R':
                if len(b) < 4:
                    break
                _, addr, n = struct.unpack('>cHb', b[:4])
                self.buf = b[4:]
                if self.writes:
                    self.read_after_write += 1
                resp = b'W' + b[1:4] + bytes(self.mem[addr:addr + n])
                if self.lose_always or self.lose_next > 0:
                    # la línea "pierde" la cola del bloque (como el BreakError real); el ACK posterior sí llega
                    self.lose_next = max(0, self.lose_next - 1)
                    self.lost_blocks += 1
                    resp = resp[:4 + n // 3]
                out += resp
            elif c == b'W':
                if len(b) < 4:
                    break
                _, addr, n = struct.unpack('>cHb', b[:4])
                if len(b) < 4 + n:
                    break
                if addr in getattr(self, 'dead_blocks', ()):     # el radio no contesta este bloque (ni lo guarda)
                    self.dead_hits.append(addr)
                    self.buf = b[4 + n:]
                    continue
                if self.drop_write is None or len(self.writes) != self.drop_write:
                    self.mem[addr:addr + n] = b[4:4 + n]
                self.writes.append((addr, n))
                self.buf = b[4 + n:]
                out += b'\x06'
            elif c == b'\x06':
                self.buf = b[1:]
                out += b'\x06'
            elif c == b'E':
                self.buf = b[1:]
                self.state = 'idle'
                if self.reboot_secs and self.now is not None:
                    self.reboot_until = self.now + self.reboot_secs
            else:
                self.buf = b[1:]
        return out


class Rt22Emu(H777Emu):
    """Protocolo RT22 (retevis_rt22.py): como el H777 pero con 'PROGRGS', ident por _fileid y un paso 0x07."""
    name = 'RT22'
    needs07 = True
    max_gap = 0.25     # los bytes de "PROGRGS" deben llegar con poca separación

    def __init__(self, img, rid='LUITON_LT-316'):
        from chirp import directory
        cls = directory.get_radio(rid)
        self.program = b'PROGRGS'
        self.ident = bytes(cls._fileid[0]).ljust(8, b'\x00')
        self.mem = bytearray(bytes(img)[:cls._memsize].ljust(cls._memsize, b'\xff'))
        self.ranges = getattr(cls, '_ranges', [])
        self.writes = []
        self.read_after_write = 0
        self.drop_write = None
        self.reset()


class Tk3407Emu(Rt22Emu):
    """Kenwood TK-3407 (clon, familia RT22): acepta solo "PROGRAM" (ignora "PROGRGS"), identidad 'P32073' F8 FF.

    noise: antes del saludo llega un byte basura (F0) y un 1C por cada byte recibido (ruido del cable).
    bad_ident: tras el 06 responde una identidad que no es P3207...
    fail_after: tras ese número de comandos 'R' las respuestas de bloque llegan cortas (lectura que se corta).
    exits: cuántas 'E' recibió estando dentro del modo de programación.
    seven: 'none' (radio real: ignora el 07 y lee sin él), 'n' (exige 07 y responde 'N'),
           'needs07' (exige 07 y no responde nada: no lee si no lo recibió).
    max_block: si se pide un bloque mayor, responde solo ese tamaño (clon de 32 bytes)."""
    name = 'TK-3407 clon'

    def __init__(self, img, noise=False, bad_ident=False, fail_after=None, seven='none', max_block=None):
        Rt22Emu.__init__(self, img, 'Kenwood_TK-3407_clon')
        self.needs07 = seven != 'none'
        self.seven_reply = b'N' if seven == 'n' else b''
        self.max_block = max_block
        self.program = b'PROGRAM'
        self.ident = b'\x00' * 8 if bad_ident else b'P32073\xf8\xff'
        self.noise = noise
        self.fail_after = fail_after
        self.dead_blocks = set()    # direcciones de bloque 'W' que nunca reciben 06
        self.dead_hits = []
        self.junk_sent = False
        self.exits = 0
        self.blocks = 0

    def feed(self, data):
        pre = b''
        if self.state == 'idle' and self.noise:
            if not self.junk_sent:
                pre += b'\xf0'
                self.junk_sent = True
            pre += b'\x1c' * len(data)
        if self.state != 'idle' and data == b'E':
            self.exits += 1
        if self.state == 'seven' and data == b'E':      # salir sin haber mandado 07
            self.state = 'idle'
            self.buf = b''
            return pre
        if self.state == 'cmd' and data == b'R':
            self.blocks += 1
            if self.fail_after is not None and self.blocks > self.fail_after:
                self.lose_always = True
        if self.state == 'seven':
            # el 07 se contesta aquí (el emulador base responde siempre 'N')
            if data == b'\x07':
                self.state = 'cmd'
                return pre + self.seven_reply
            return pre
        out = Rt22Emu.feed(self, data)
        if self.max_block and out[:1] == b'W' and len(out) > 4 + self.max_block and out[3] > self.max_block:
            out = out[:4 + self.max_block]              # el bloque llega corto
        return pre + out


class Tk2402Emu(Emu):
    """Kenwood TK-2402 / TK-3402: saludo PROGRAM, cambio a 19200, ident de 40 bytes y XOR 0xBB.

    Escrito a partir de la descripción del protocolo, independiente del driver. Los canales se
    codifican aquí con una fórmula propia (8 dígitos BCD de 10 Hz, bytes invertidos)."""
    name = 'TK-2402'
    KEY = 0xBB

    def __init__(self, model=b'P2402', channels=None, unreadable=(), direct06=False, prog_reply=None, ident_starts_p=False):
        self.prog_reply = prog_reply   # respuesta rara a PROGRAM (para probar el mensaje de error)
        self.direct06 = direct06    # hipótesis TK-3402: contesta 0x06 a PROGRAM, sin 0x16 ni cambio de baudios
        self.mem = bytearray(b'\xff' * 0x2000)
        self.mem[0x70:0x70 + 6] = model + b'\r'
        # el resto de la EEPROM con un patrón reconocible (para comprobar la copia completa)
        for a in range(0x100, 0x1000):
            self.mem[a] = (a * 7 + 3) & 0xFF
        self.mem[0x1000:0x1002] = b'\xf0\xff'
        self.mem[0xFD0] = 0x0D
        self.ident = (b'KENWOOD ' + model + b' V1.00 ').ljust(40, b'\x20')
        if ident_starts_p:     # TK-3402 real: la identidad empieza con 'P' (0x50)
            self.ident = (model + b' V1.00 KENWOOD ').ljust(40, b'\x20')
        self.unreadable = set(unreadable)       # direcciones de bloque que el radio no responde
        self.reads = []
        self.writes = []                        # no debe haber escrituras en la fase 1
        for n, rx, tx, qrx, qtx, high, scan, wide in (channels or []):
            self.set_channel(n, rx, tx, qrx, qtx, high, scan, wide)
        self.reset()

    @staticmethod
    def _bcd(hz):
        digits = '%08d' % int(round(hz / 10.0))
        return bytes(int(digits[i:i + 2], 16) for i in range(6, -1, -2))

    def set_channel(self, n, rx, tx, qrx, qtx, high, scan, wide):
        rec = bytearray(b'\xff' * 32)
        rec[0] = n
        rec[2:6] = self._bcd(rx)
        rec[6:10] = self._bcd(tx)
        rec[10] = rec[11] = 2
        rec[12:14] = int(qrx * 10).to_bytes(2, 'little') if qrx else b'\x00\x00'
        rec[14:16] = int(qtx * 10).to_bytes(2, 'little') if qtx else b'\x00\x00'
        rec[16] = 0x18
        rec[17] = 0xCC + (0x20 if high else 0) + (0 if scan else 0x10) + (1 if wide else 0)
        self.mem[0x12C0 + (n - 1) * 32:0x12C0 + n * 32] = rec

    def reset(self):
        self.buf = b''
        self.state = 'idle'
        self._junk = b''

    def on_open(self, baud):
        self.baud = baud
        if self.state == 'wait_baud' and baud == 19200:
            # el radio confirma con 0x06 ya a 19200 (la sesión continúa tras reabrir el puerto)
            self.state = 'wait_02'
            self.buf = b''
            self._junk = b'\x06'
        else:
            self.reset()

    def open_junk(self):
        j, self._junk = self._junk, b''
        return to_js(j)

    def feed(self, data):
        K = self.KEY
        self.buf += data
        out = b''
        while self.buf:
            b = self.buf
            st = self.state
            if st == 'idle':
                if b == b'PROGRAM':
                    if self.prog_reply is not None:
                        out += self.prog_reply
                        self.state = 'idle'
                    elif self.direct06:
                        out += b'\x06'
                        self.state = 'wait_02'
                    else:
                        out += b'\x16'
                        self.state = 'wait_baud'
                    self.buf = b''
                elif b'PROGRAM'.startswith(b):
                    break
                else:
                    self.buf = b''
                    break
            elif st == 'wait_baud':
                self.buf = b''
            elif st == 'wait_02':
                self.buf = b[1:]
                if b[0] == 0x02:
                    out += self.ident
                    self.state = 'wait_key1'
            elif st == 'wait_key1':
                self.buf = b[1:]
                if b[0] == 0x00:
                    self.state = 'wait_conf1'
            elif st == 'wait_conf1':
                self.buf = b[1:]
                if b[0] == 0x06:
                    out += b'\x06'
                    self.state = 'wait_p'
            elif st == 'wait_p':
                self.buf = b[1:]
                if b[0] ^ K == 0x50:
                    out += b'VER-1.00\x00\x00'
                    self.state = 'wait_conf2'
            elif st == 'wait_conf2':
                self.buf = b[1:]
                if b[0] ^ K == 0x06:
                    out += bytes([0x06 ^ K])
                    self.state = 'cmd'
            elif st == 'cmd':
                c = b[0] ^ K
                if c == 0x45:      # 'E'
                    self.buf = b[1:]
                    out += bytes([0x06 ^ K])
                    self.state = 'idle'
                elif c == 0x52:    # 'R'
                    if len(b) < 4:
                        break
                    hi, lo, ln = b[1] ^ K, b[2] ^ K, b[3] ^ K
                    self.buf = b[4:]
                    addr = (hi << 8) | lo
                    self.reads.append(addr)
                    if addr in self.unreadable:
                        continue     # no responde
                    out += bytes(x ^ K for x in (0x57, hi, lo, ln)) + bytes(x ^ K for x in self.mem[addr:addr + ln])
                    self.state = 'wait_ack'
                else:
                    self.buf = b[1:]
            elif st == 'wait_ack':
                if b[0] ^ K == 0x52:     # un radio tolerante: acepta un comando nuevo en vez del ACK
                    self.state = 'cmd'
                    continue
                self.buf = b[1:]
                if b[0] ^ K == 0x06:
                    out += bytes([0x06 ^ K])
                    self.state = 'cmd'
            else:
                self.buf = b''
        return out


class PySerialAdapter(Emu):
    """Envuelve los simuladores de CHIRP que imitan pyserial (write()/read())."""

    def __init__(self, obj, name='fake'):
        self.obj = obj
        self.name = name
        self.mem = b''

    def feed(self, data):
        self.obj.write(bytes(data))
        out = b''
        while True:
            chunk = self.obj.read(4096)
            if not chunk:
                break
            out += chunk
        return out

    def memory_js(self):
        mem = getattr(self.obj, '_memory', b'')
        return to_js(bytes(mem))


# (canal, rx Hz, tx Hz, qt rx, qt tx, potencia alta, scan, ancho)
TK_CHANNELS = [
    (1, 146520000, 146520000, 0, 0, True, True, True),
    (2, 146512500, 146512500, 0, 88.5, False, True, False),        # paso de 12,5 kHz, tono TX
    (3, 147000000, 147600000, 110.9, 110.9, True, False, True),    # repetidor +600, TSQL, sin scan
    (4, 155000000, 150000000, 67.0, 100.0, False, True, True),     # cruzado, TX distinto
    (16, 173975000, 173975000, 0, 0, True, True, False),
]
TK_CHANNELS_UHF = [
    (1, 462562500, 462562500, 0, 0, True, True, True),
    (2, 450000000, 455000000, 0, 141.3, False, True, True),
]


def make(kind, img=None, cls=None, rid=None):
    kw = {'cls': cls, 'rid': rid}
    if img is not None and hasattr(img, 'to_py'):
        img = bytes(img.to_py())
    if kind == 'uv5r':
        return Uv5rEmu(img)
    if kind == 'bf888':
        return H777Emu(img)
    if kind == 'tk2402':
        return Tk2402Emu(b'P2402', TK_CHANNELS)
    if kind == 'tk3402':
        return Tk2402Emu(b'P3402', TK_CHANNELS_UHF)
    if kind == 'tk3402_direct06':
        return Tk2402Emu(b'P3402', TK_CHANNELS_UHF, direct06=True)
    if kind == 'tk3402_pident':
        return Tk2402Emu(b'P3402', TK_CHANNELS_UHF, direct06=True, ident_starts_p=True)
    if kind == 'tk_badack':
        return Tk2402Emu(b'P2402', TK_CHANNELS, prog_reply=b'\x99\x42')
    if kind == 'tk2402_bad':
        return Tk2402Emu(b'P2402', TK_CHANNELS, unreadable={0x0800, 0x0820})
    if kind == 'tk2402_nochan':
        return Tk2402Emu(b'P2402', TK_CHANNELS, unreadable={0x1300})
    if kind == 'tk_wrongmodel':
        return Tk2402Emu(b'P3402', TK_CHANNELS_UHF)
    if kind == 'rt22':
        return Rt22Emu(img, rid or 'LUITON_LT-316')
    if kind == 'tk3407':
        return Tk3407Emu(img)
    if kind == 'tk3407_n':
        return Tk3407Emu(img, seven='n')
    if kind == 'tk3407_needs07':
        return Tk3407Emu(img, seven='needs07')
    if kind == 'tk3407_b32':
        return Tk3407Emu(img, max_block=0x20)
    if kind == 'tk3407_noise':
        return Tk3407Emu(img, noise=True)
    if kind in ('tk3407_dead0', 'tk3407_dead0_needs07', 'tk3407_deadmid'):
        e = Tk3407Emu(img, seven='needs07' if kind == 'tk3407_dead0_needs07' else 'none')
        e.dead_blocks = {0x100} if kind == 'tk3407_deadmid' else {0}
        return e
    if kind == 'tk3407_badident':
        return Tk3407Emu(img, bad_ident=True)
    if kind == 'tk3407_failmid':
        return Tk3407Emu(img, fail_after=5)
    if kind == 'bf888_class':
        return H777Emu(img, kw['cls'])
    if kind == 'kenwood':
        from chirp.drivers import fake
        return PySerialAdapter(fake.FakeKenwoodSerial(), 'FakeKenwoodSerial')
    if kind == 'uv17':
        from chirp.drivers import fake
        return PySerialAdapter(fake.FakeUV17Serial(), 'FakeUV17Serial')
    if kind == 'uv17pro':
        from chirp.drivers import fake
        return PySerialAdapter(fake.FakeUV17ProSerial(), 'FakeUV17ProSerial')
    if kind == 'uvpro':
        from chirp.drivers import fake
        return PySerialAdapter(fake.FakeUVProSerial(), 'FakeUVProSerial')
    if kind == 'icom':
        from chirp import directory
        from icom_clone_simulator import FakeIcomRadio
        radio = directory.get_radio(kw['rid'])(None)
        sim = FakeIcomRadio(radio)
        if img is not None:
            sim._memory = bytes(img)
        return PySerialAdapter(sim, 'FakeIcomRadio')
    raise ValueError(kind)


def set_blank(rid):
    """Deja abierta una imagen en blanco del modelo (para probar grabaciones sin archivo)."""
    import webchirp
    from chirp import directory, memmap
    r = directory.get_radio(rid)(None)
    if getattr(r, '_mmap', None) is None:
        r._mmap = memmap.MemoryMapBytes(bytes([0xFF]) * r.get_memsize())
        r.process_mmap()
    return webchirp._new_tab(r)


def guard_test():
    """Comprueba que el modo de solo lectura del barrido bloquea toda escritura."""
    import json
    import webchirp
    from chirp import directory, errors
    res = {}
    r = directory.get_radio('Baofeng_UV-5R')(None)
    webchirp._lock_writes(r)
    before = webchirp._scan_violations
    try:
        r.sync_out()
        res['sync_out'] = 'NO BLOQUEADO'
    except errors.RadioError:
        res['sync_out'] = 'bloqueado'
    res['violaciones_registradas'] = webchirp._scan_violations - before
    webchirp._scan_active = True
    try:
        res['upload_durante_barrido'] = json.loads(webchirp.upload(0, 'Baofeng_UV-5R'))
    finally:
        webchirp._scan_active = False
    return json.dumps(res)
