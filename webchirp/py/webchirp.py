# WebCHIRP: capa de Python que une los drivers originales de CHIRP con la
# página web. Se ejecuta dentro de Pyodide. Todas las funciones públicas
# devuelven texto JSON para que JavaScript lo lea con JSON.parse.
#
# Basado en CHIRP (https://chirpmyradio.com), licencia GPLv3.

import json
import logging
import os
import time
import builtins

from pyodide.ffi import run_sync, to_js
import js

from chirp import chirp_common, directory, errors, settings as rsettings
from chirp.drivers import generic_csv

# CHIRP usa _() (gettext) en sus mensajes de error; sin esto fallan con NameError.
if not hasattr(builtins, '_'):
    builtins._ = lambda text: text

LOG = logging.getLogger('webchirp')
WORKDIR = '/tmp/webchirp'
os.makedirs(WORKDIR, exist_ok=True)

_bridge = None          # SerialBridge de JavaScript
_status_cb = None       # función JS (cur, max, msg)
_radios = {}            # pestaña -> radio abierto (desde archivo, descarga o CSV nuevo)
_settings = {}          # pestaña -> árbol de ajustes cargado con get_settings()
_next_tab = 0


def _new_tab(radio):
    global _next_tab
    _next_tab += 1
    _radios[_next_tab] = radio
    _settings.pop(_next_tab, None)
    return _next_tab


def _R(tab):
    radio = _radios.get(tab)
    if radio is None:
        raise errors.RadioError('No hay nada abierto en esa pestaña')
    return radio


# ---------------------------------------------------------------- utilidades

def _js_sleep(seconds):
    return js.Promise.new(lambda res, rej: js.setTimeout(res, int(seconds * 1000)))


PRECISE_SLEEP_MAX = 0.05   # pausas hasta este valor (s) se hacen con espera activa
_perf = time.perf_counter


def _busy_wait(end):
    """Espera activa hasta `end` (perf_counter). Devuelve False si el reloj está congelado
    (por ejemplo en pruebas con tiempo virtual) para no quedarse en un bucle sin fin."""
    last = None
    same = 0
    while True:
        now = _perf()
        if now >= end:
            return True
        if now == last:
            same += 1
            if same > 300000:
                return False
        else:
            same = 0
            last = now


def _sleep(seconds):
    """Pausa precisa. Los timers del navegador se alargan a 1 s o más si la pestaña está oculta,
    y algunos radios exigen pausas de 5 ms entre bytes del saludo; por eso las pausas cortas
    son de espera activa y las largas usan setTimeout y se completan con espera activa."""
    if seconds <= 0:
        return
    end = _perf() + seconds
    if seconds <= PRECISE_SLEEP_MAX:
        if _busy_wait(end):
            return
    try:
        run_sync(_js_sleep(seconds))
    except Exception:
        pass
    if _perf() < end:           # el timer se quedó corto: se completa el resto
        _busy_wait(end)


time.sleep = _sleep


class _JSLogHandler(logging.Handler):
    def emit(self, record):
        try:
            js.webchirpLog(record.levelname, self.format(record))
        except Exception:
            pass


def _setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    h = _JSLogHandler()
    h.setFormatter(logging.Formatter('%(name)s: %(message)s'))
    root.addHandler(h)


def _ok(**data):
    data['ok'] = True
    return json.dumps(data)


def _fail(e):
    LOG.exception('Error: %s', e)
    msg = str(e) or e.__class__.__name__
    return json.dumps({'ok': False, 'error': msg})


def _api(fn):
    def wrapper(*a, **k):
        try:
            return fn(*a, **k)
        except Exception as e:
            return _fail(e)
    wrapper.__name__ = fn.__name__
    return wrapper


def _radio_id(rclass):
    return directory.radio_class_id(rclass)


# ------------------------------------------------- puerto serie (tipo pyserial)

OPEN_SETTLE = 0.2        # espera tras abrir el puerto antes de hablar (CH340 y otros sueltan basura al abrir/DTR/RTS)
OPEN_DRAIN = True        # vaciar el búfer de entrada tras abrir (se puede desactivar para probar)
RECONFIG_SETTLE = 0.03   # tras un cambio de baudios solo se vacía (sin esperas largas a mitad de protocolo)
TRACE_FULL = 2048     # bytes de cada operación que se registran completos
TRACE_MAX_LINE = 64   # después, cada línea muestra como máximo esta cantidad de bytes
_trace_bytes = 0      # bytes ya registrados en la operación actual
TRACE_LOG = logging.getLogger('webchirp.serial')


def _trace_fmt(data):
    """Hex y ASCII imprimible de `data`; limita la línea si ya pasaron los primeros 2 KB."""
    global _trace_bytes
    n = len(data)
    shown = data
    omitted = 0
    if _trace_bytes >= TRACE_FULL and n > TRACE_MAX_LINE:
        shown = data[:TRACE_MAX_LINE]
        omitted = n - TRACE_MAX_LINE
    _trace_bytes += n
    hexs = ' '.join('%02X' % b for b in shown)
    ascii_ = ''.join(chr(b) if 32 <= b < 127 else '.' for b in shown)
    out = '%s |%s|' % (hexs, ascii_) if n else '(vacío)'
    if omitted:
        out += ' … (+%d bytes omitidos)' % omitted
    return out


class WebSerial:
    """Imita la parte de pyserial.Serial que usan los drivers de CHIRP."""

    PARITY_MAP = {'N': 'none', 'E': 'even', 'O': 'odd'}

    def __init__(self, bridge, baudrate=9600, rtscts=False, timeout=0.25,
                 rts=None, dtr=None):
        self._b = bridge
        self._baudrate = baudrate
        self._rtscts = rtscts
        self._parity = 'N'
        self._stopbits = 1
        self._bytesize = 8
        self._rts = rts
        self._dtr = dtr
        self.timeout = timeout
        self.write_timeout = 2
        self.drain_on_reconfig = True
        self.max_tx = 0       # mayor mensaje enviado (para saber si ya se empezó a escribir bloques)
        self.tx_total = 0
        self.port = 'WebSerial'
        self.xonxoff = False
        self.dsrdtr = False
        self.last_write = None

    def log(self, message):
        """Los drivers anotan eventos con pipe.log(); en CHIRP va al archivo de traza."""
        LOG.debug('%s', message)

    # --- apertura / cierre
    def _js_opts(self):
        return to_js({
            'baudRate': int(self._baudrate),
            'dataBits': int(self._bytesize),
            'stopBits': 2 if self._stopbits == 2 else 1,
            'parity': self.PARITY_MAP.get(self._parity, 'none'),
            'flowControl': 'hardware' if self._rtscts else 'none',
        }, dict_converter=js.Object.fromEntries)

    def open(self):
        global _trace_bytes
        _trace_bytes = 0
        sig = {}
        if self._rts is not None:
            sig['requestToSend'] = bool(self._rts)
        if self._dtr is not None:
            sig['dataTerminalReady'] = bool(self._dtr)
        run_sync(self._b.setSignals(to_js(sig, dict_converter=js.Object.fromEntries)))
        run_sync(self._b.open(self._js_opts()))
        try:
            info = str(self._b.portInfo())
        except Exception:
            info = '?'
        self._settle_and_drain(OPEN_SETTLE, 'al abrir')
        TRACE_LOG.debug('Puerto abierto: %s, %i baudios, paridad %s, %i bits, %s bit(s) de parada, '
                        'control de flujo %s, RTS=%s, DTR=%s', info, self._baudrate,
                        self.PARITY_MAP.get(self._parity, 'none'), self._bytesize, self._stopbits,
                        'hardware' if self._rtscts else 'ninguno', self._rts, self._dtr)

    def close(self):
        run_sync(self._b.close())

    @property
    def is_open(self):
        return bool(self._b.isOpen)

    def _settle_and_drain(self, wait, when):
        """Espera a que se asiente la línea y vacía lo recibido hasta ahora (basura o ACK viejos)."""
        if not OPEN_DRAIN:
            return
        # Siempre con run_sync: una espera activa bloquearía el event loop y el lector de JavaScript
        # no podría meter en el búfer los bytes que ya llegaron (drain() no vería nada).
        try:
            if wait > 0:
                run_sync(_js_sleep(wait))
            run_sync(_js_sleep(0))      # cede el control al menos una vez
        except Exception:
            pass
        junk = bytes(self._b.drain().to_py())
        if junk:
            TRACE_LOG.debug('Descartados %i bytes %s: %s', len(junk), when,
                            ' '.join('%02X' % b for b in junk[:64]) + (' …' if len(junk) > 64 else ''))

    def _reconfigure(self):
        if self.is_open:
            run_sync(self._b.reconfigure(self._js_opts()))
            # Algunos protocolos (Kenwood TK-2402) reciben una respuesta justo al cambiar de baudios:
            # su driver pone drain_on_reconfig = False para no descartarla.
            if self.drain_on_reconfig:
                self._settle_and_drain(RECONFIG_SETTLE, 'tras cambiar los parámetros del puerto')

    # --- parámetros de línea
    @property
    def baudrate(self):
        return self._baudrate

    @baudrate.setter
    def baudrate(self, v):
        v = int(v)
        if v != self._baudrate:
            LOG.debug('Cambio de baudios a %i', v)
            self._baudrate = v
            self._reconfigure()

    @property
    def parity(self):
        return self._parity

    @parity.setter
    def parity(self, v):
        if v != self._parity:
            self._parity = v
            self._reconfigure()

    @property
    def stopbits(self):
        return self._stopbits

    @stopbits.setter
    def stopbits(self, v):
        if v != self._stopbits:
            self._stopbits = v
            self._reconfigure()

    @property
    def bytesize(self):
        return self._bytesize

    @bytesize.setter
    def bytesize(self, v):
        if v != self._bytesize:
            self._bytesize = v
            self._reconfigure()

    databits = bytesize

    @property
    def rtscts(self):
        return self._rtscts

    @rtscts.setter
    def rtscts(self, v):
        if bool(v) != self._rtscts:
            self._rtscts = bool(v)
            self._reconfigure()

    # --- señales de control
    def _signal(self, name, value):
        TRACE_LOG.debug('Señal %s = %s', name, bool(value))
        run_sync(self._b.setSignals(
            to_js({name: bool(value)}, dict_converter=js.Object.fromEntries)))

    @property
    def rts(self):
        return self._rts

    @rts.setter
    def rts(self, v):
        self._rts = v
        if v is not None:
            self._signal('requestToSend', v)

    @property
    def dtr(self):
        return self._dtr

    @dtr.setter
    def dtr(self, v):
        self._dtr = v
        if v is not None:
            self._signal('dataTerminalReady', v)

    def setRTS(self, v=True):
        self.rts = v

    def setDTR(self, v=True):
        self.dtr = v

    # --- datos
    def read(self, size=1):
        if size <= 0:
            return b''
        timeout = None if self.timeout is None else int(self.timeout * 1000)
        t0 = _perf()
        data = bytes(run_sync(self._b.read(size, timeout)).to_py())
        ms = (_perf() - t0) * 1000
        got = len(data)
        note = ''
        if got == 0:
            note = ' VACÍO: no llegó nada en %s' % ('%.2f s' % self.timeout if self.timeout is not None else 'sin límite')
        elif got < size:
            note = ' INCOMPLETO: se esperaban %i bytes (timeout %.2f s)' % (size, self.timeout or 0)
        TRACE_LOG.debug('RX %i/%i (%.0f ms): %s%s', got, size, ms, _trace_fmt(data), note)
        return data

    def read_until(self, expected=b'\n', size=None):
        out = bytearray()
        start = time.monotonic()
        while True:
            c = self.read(1)
            if not c:
                break
            out += c
            if out.endswith(expected) or (size and len(out) >= size):
                break
            if self.timeout is not None and time.monotonic() - start > max(self.timeout * 4, 1):
                break
        return bytes(out)

    def readline(self, size=None):
        return self.read_until(b'\n', size)

    def write(self, data):
        if isinstance(data, str):
            data = data.encode()
        data = bytes(data)
        self.max_tx = max(self.max_tx, len(data))
        self.tx_total += len(data)
        TRACE_LOG.debug('TX %i: %s', len(data), _trace_fmt(data))
        run_sync(self._b.write(to_js(data)))
        return len(data)

    def flush(self):
        pass

    @property
    def in_waiting(self):
        # Algunos drivers esperan datos con un bucle `while time.time() < t: if inWaiting()`.
        # Sin ceder el control al navegador, los bytes nunca llegarían: se espera 1 ms.
        if int(self._b.available) == 0:
            try:
                run_sync(_js_sleep(0.001))
            except Exception:
                pass
        return int(self._b.available)

    def inWaiting(self):
        return self.in_waiting

    def reset_input_buffer(self):
        self._b.clearInput()

    def reset_output_buffer(self):
        pass

    flushInput = reset_input_buffer
    flushOutput = reset_output_buffer

    def __repr__(self):
        return '<WebSerial %i baud>' % self._baudrate


def _open_serial(rclass_or_radio):
    pipe = WebSerial(_bridge,
                     baudrate=rclass_or_radio.BAUD_RATE,
                     rtscts=rclass_or_radio.HARDWARE_FLOW,
                     timeout=0.25,
                     rts=getattr(rclass_or_radio, 'WANTS_RTS', True),
                     dtr=getattr(rclass_or_radio, 'WANTS_DTR', True))
    pipe.open()
    return pipe


# --------------------------------------------- radios "en vivo" (Kenwood, Icom…)

class LiveAdapter(generic_csv.CSVRadio):
    """Hace que un radio en vivo se comporte como uno de clonación.

    Copia de chirp/wxui/common.py (la original importa wx)."""
    FILE_EXTENSION = 'csv'

    def __init__(self, liveradio):
        generic_csv.CSVRadio.__init__(self, None)
        self._liveradio = liveradio
        self.VENDOR = liveradio.VENDOR
        self.MODEL = liveradio.MODEL
        self.VARIANT = liveradio.VARIANT
        self.BAUD_RATE = liveradio.BAUD_RATE
        self.HARDWARE_FLOW = liveradio.HARDWARE_FLOW
        self.pipe = liveradio.pipe
        self._features = self._liveradio.get_features()

    def get_features(self):
        return self._features

    def set_pipe(self, pipe):
        self.pipe = pipe
        self._liveradio.pipe = pipe

    def _status(self, i):
        status = chirp_common.Status()
        status.max = self._features.memory_bounds[1]
        status.cur = i
        status.msg = 'Clonando'
        self.status_fn(status)

    def sync_in(self):
        for i in range(*self._features.memory_bounds):
            self.set_memory(self._liveradio.get_memory(i))
            self._status(i)

    def sync_out(self):
        for i in range(*self._features.memory_bounds):
            mem = self.get_memory(i)
            try:
                if mem.freq == 0:
                    self._liveradio.erase_memory(i)
                else:
                    self._liveradio.set_memory(mem)
            except errors.RadioError as e:
                LOG.error(e)
            self._status(i)

    def get_settings(self):
        return self._liveradio.get_settings()

    def set_settings(self, settings):
        return self._liveradio.set_settings(settings)


# ------------------------------------------------------------------- arranque

def _patch_bf888():
    """Baofeng BF-888 (clase H777Radio exacta): permite VHF y UHF.

    Solo el BF-888 (no sus alias ni las subclases como Retevis H777 o BF-1901). El código de
    CHIRP no se modifica: se envuelve get_features solo para esa clase."""
    from chirp.drivers import h777
    original = h777.H777Radio.get_features

    def get_features(self):
        rf = original(self)
        # Los archivos abiertos con metadatos se instancian como una subclase
        # dinámica (DynamicRadioAlias) con _orig_rclass; se mira esa clase base.
        orig = getattr(self, '_orig_rclass', type(self))
        if orig is h777.H777Radio and self.VENDOR == 'Baofeng' and self.MODEL == 'BF-888':
            rf.valid_bands = [(136000000, 174000000), (400000000, 520000000)]
        return rf

    h777.H777Radio.get_features = get_features


_loaded_modules = set()
_all_loaded = False
EXTRA_DRIVERS = {'kenwood_tk2402', 'kenwood_tk3407_clone'}   # py/drivers_extra/*.py
# drivers de CHIRP que un driver extra reutiliza (así reciben también los parches de WebCHIRP)
EXTRA_DEPENDS = {'kenwood_tk3407_clone': ('retevis_rt22',)}


BLOCK_READ_RETRIES = 3     # reenvíos de un bloque 'R' cuando la respuesta llega corta
BLOCK_RETRY_WAIT = 0.1


def _patch_short_block_reads(module, func_name):
    """Algunos drivers (h777, retevis_rt22) piden un bloque con 'R' y solo validan el encabezado: si la
    respuesta llega corta (bytes perdidos por la línea), devuelven un bloque corto y la imagen queda
    desplazada. Aquí se vacía la entrada y se repite la lectura del mismo bloque antes de rendirse.
    El código de CHIRP no se modifica; se envuelve la función del módulo."""
    original = getattr(module, func_name)
    if getattr(original, '_webchirp_patched', False):
        return

    def read_block(radio, block_addr, block_size, *args, **kwargs):
        data = original(radio, block_addr, block_size, *args, **kwargs)
        for attempt in range(1, BLOCK_READ_RETRIES + 1):
            if len(data) >= block_size:
                break
            LOG.warning('Bloque %04x incompleto (%i de %i bytes); reintento %i de %i', block_addr,
                        len(data), block_size, attempt, BLOCK_READ_RETRIES)
            try:
                radio.pipe.reset_input_buffer()
            except Exception:
                pass
            time.sleep(BLOCK_RETRY_WAIT)
            data = original(radio, block_addr, block_size, *args, **kwargs)
        if len(data) < block_size:
            raise errors.RadioError('Bloque %04x incompleto tras %i reintentos (%i de %i bytes)'
                                    % (block_addr, BLOCK_READ_RETRIES, len(data), block_size))
        return data

    read_block._webchirp_patched = True
    setattr(module, func_name, read_block)


INCOMPLETE_READ_MSG = ('Lectura incompleta: el radio no envió todos los datos (posible cable/conexión). '
                       'No se creó la pestaña; vuelve a leer.')
INCOMPLETE_IMAGE_MSG = ('La imagen está incompleta (%i de %i bytes): no se grabó nada en el radio. '
                        'Vuelve a leer el radio o abre un archivo completo.')


def _image_shortfall(radio):
    """(tiene, esperado) si la imagen de un radio de clonación es más corta que su _memsize; si no, None."""
    if not isinstance(radio, chirp_common.CloneModeRadio):
        return None
    expected = getattr(radio, '_memsize', 0)
    have = len(radio.get_mmap())
    return (have, expected) if expected and have < expected else None


def _import_driver(name):
    """Importa un módulo de chirp.drivers una sola vez y le aplica los parches de WebCHIRP."""
    if name in _loaded_modules:
        return
    if name in EXTRA_DRIVERS:
        for dep in EXTRA_DEPENDS.get(name, ()):
            _import_driver(dep)
        __import__('drivers_extra.%s' % name)     # drivers propios de WebCHIRP (no vienen de CHIRP)
    else:
        __import__('chirp.drivers.%s' % name)
    _loaded_modules.add(name)
    if name == 'h777':
        _patch_bf888()
        from chirp.drivers import h777
        _patch_short_block_reads(h777, '_h777_read_block')
    elif name == 'retevis_rt22':
        from chirp.drivers import retevis_rt22
        _patch_short_block_reads(retevis_rt22, '_rt22_read_block')


def init(bridge, status_cb):
    """Arranque rápido: NO importa los drivers (se cargan bajo demanda)."""
    global _bridge, _status_cb
    _bridge = bridge
    _status_cb = status_cb
    _setup_logging()
    return _ok()


@_api
def load_driver(modules_json):
    """Importa solo los módulos de driver indicados (sus dependencias se resuelven solas)."""
    names = json.loads(modules_json)
    for n in names:
        if not n.replace('_', '').isalnum():
            raise errors.RadioError('Nombre de driver no válido: %s' % n)
        _import_driver(n)
    return _ok(loaded=len(_loaded_modules))


def _load_all():
    global _all_loaded
    if _all_loaded:
        return []
    import chirp.drivers
    drvdir = os.path.dirname(chirp.drivers.__file__)
    failed = []
    for fn in sorted(os.listdir(drvdir)):
        if not fn.endswith('.py') or fn == '__init__.py':
            continue
        try:
            _import_driver(fn[:-3])
        except Exception as e:
            LOG.error('No se pudo cargar el driver %s: %s', fn, e)
            failed.append(fn)
    for name in sorted(EXTRA_DRIVERS):
        try:
            _import_driver(name)
        except Exception as e:
            LOG.error('No se pudo cargar el driver extra %s: %s', name, e)
            failed.append(name)
    _all_loaded = True
    LOG.info('Drivers cargados: %i modelos', len(directory.DRV_TO_RADIO))
    return failed


@_api
def load_all_drivers():
    failed = _load_all()
    return _ok(count=len(directory.DRV_TO_RADIO), failed=failed)


@_api
def list_radios():
    """Lista de modelos (carga todos los drivers) con el módulo que hay que importar para cada uno."""
    _load_all()
    out = []
    children = {}
    for rid, rclass in directory.DRV_TO_RADIO.items():
        parent = getattr(rclass, '_DETECTED_BY', None)
        if parent:
            children.setdefault(parent, set()).add(rclass.__module__.split('.')[-1])
    for rid, rclass in directory.DRV_TO_RADIO.items():
        live = issubclass(rclass, chirp_common.LiveRadio)
        if not (issubclass(rclass, chirp_common.CloneModeRadio) or live):
            continue
        if getattr(rclass, '_DETECTED_BY', None):
            continue
        mod = rclass.__module__.split('.')[-1]
        modules = [mod] + sorted(children.get(rclass, set()) - {mod})
        out.append({'id': rid, 'vendor': rclass.VENDOR, 'model': rclass.MODEL,
                    'variant': rclass.VARIANT or '', 'live': live, 'modules': modules})
        for alias in getattr(rclass, 'ALIASES', []):
            out.append({'id': rid, 'vendor': alias.VENDOR, 'model': alias.MODEL,
                        'variant': getattr(alias, 'VARIANT', '') or '',
                        'live': live, 'modules': modules,
                        'alias_of': '%s %s' % (rclass.VENDOR, rclass.MODEL)})
    out.sort(key=lambda r: (r['vendor'].lower(), r['model'].lower(), r['variant']))
    return _ok(radios=out)


@_api
def get_prompts(radio_id=None, tab=None):
    target = directory.get_radio(radio_id) if radio_id else _radios.get(tab)
    if target is None:
        return _ok(prompts={})
    p = target.get_prompts()
    return _ok(prompts={k: getattr(p, k, None) for k in
                        ('info', 'experimental', 'pre_download', 'pre_upload')})


# ------------------------------------------------------------- estado/descarga

_last_max = 0  # último 'max' que informó el driver (para cerrar la barra al 100 %)
_phase = ''   # 'Escribiendo' / 'Verificando' mientras dura una grabación con verificación


def _status_fn(status):
    global _last_max
    if _status_cb is not None:
        try:
            _last_max = int(status.max)
            msg = '%s… %s' % (_phase, status.msg) if _phase else str(status.msg)
            _status_cb(int(status.cur), int(status.max), msg)
        except Exception:
            pass


def _describe(radio):
    if radio is None:
        return None
    try:
        base = radio._liveradio.__class__ if isinstance(radio, LiveAdapter) else radio.__class__
        rid = _radio_id(getattr(radio, '_DETECTED_BY', None) or base)
    except Exception:
        rid = None
    devices = [radio]
    if radio.get_features().has_sub_devices:
        devices = radio.get_sub_devices()
    return {
        'vendor': radio.VENDOR, 'model': radio.MODEL,
        'variant': radio.VARIANT or '', 'id': rid,
        'clone': isinstance(radio, chirp_common.CloneModeRadio),
        'extension': getattr(radio, 'FILE_EXTENSION', 'img'),
        'devices': [d.VARIANT or d.MODEL for d in devices],
    }


def _close_pipe(radio):
    pipe = getattr(radio, 'pipe', None)
    if isinstance(pipe, WebSerial):
        try:
            pipe.close()
        except Exception as e:
            LOG.warning('No se pudo cerrar el puerto: %s', e)


def _safe_close(pipe):
    try:
        pipe.close()
    except Exception as e:
        LOG.warning('No se pudo cerrar el puerto: %s', e)


# Errores que ocurren DENTRO del saludo (antes de escribir ningún bloque)
_GREETING_ERRORS = ('no response', 'refused to enter programming', 'did not accept program',
                    'no ack after reading ident', 'identification failed', 'unexpected response from radio',
                    'bad ack after reading ident', 'refused clone')
GREETING_RETRIES = 2          # reintentos del saludo (lectura y grabación)
GREETING_RETRY_WAIT = 1.5     # segundos entre intentos (se cierra, espera, reabre y vacía)


def _is_greeting_error(e):
    msg = str(e).lower()
    return isinstance(e, errors.RadioNoResponse) or any(k in msg for k in _GREETING_ERRORS)


def _read_from_radio(radio_id, read_only=False, retry=True):
    """Descarga del radio y devuelve el objeto radio (sin tocar el abierto).

    Si falla enseguida en el saludo, se reintenta una vez tras 1 s con el búfer vacío (solo lectura:
    es seguro). No se reintenta en el barrido ni si el usuario canceló."""
    t0 = _perf()
    attempt = 0
    while True:
        try:
            return _read_once(radio_id, read_only)
        except Exception as e:
            attempt += 1
            if not retry or read_only or attempt > GREETING_RETRIES or not _is_greeting_error(e) \
                    or 'cancel' in str(e).lower() or _perf() - t0 > 20:
                raise
            LOG.warning('Falló el saludo (%s); reintento %i de %i tras %.1f s', e, attempt,
                        GREETING_RETRIES, GREETING_RETRY_WAIT)
            time.sleep(GREETING_RETRY_WAIT)


def _read_once(radio_id, read_only=False):
    _bridge.cancelled = False
    rclass = directory.get_radio(radio_id)
    pipe = None
    try:
        pipe = _open_serial(rclass)
        try:
            rclass = rclass.detect_from_serial(pipe)
            LOG.info('Modelo detectado: %s', rclass)
        except NotImplementedError:
            pass
        radio = rclass(pipe)
        if isinstance(radio, chirp_common.LiveRadio):
            radio = LiveAdapter(radio)
        radio.status_fn = _status_fn
        if read_only:
            _lock_writes(radio)
        radio.sync_in()
        short = _image_shortfall(radio)
        if short:
            LOG.error('Lectura incompleta: %i de %i bytes', *short)
            raise errors.RadioError(INCOMPLETE_READ_MSG)
        return radio
    finally:
        if pipe is not None:
            _safe_close(pipe)


@_api
def download(radio_id):
    """Lee la memoria del radio por el puerto serie."""
    radio = _read_from_radio(radio_id)
    # Solo si todo salió bien se crea la pestaña nueva; las demás no se tocan
    tab = _new_tab(radio)
    return _ok(radio=_describe(radio), tab=tab)


def _image_bytes(radio):
    ext = getattr(radio, 'FILE_EXTENSION', 'img')
    name = '_'.join(x for x in (radio.VENDOR, radio.MODEL, radio.VARIANT) if x) + '.' + ext
    name = name.replace(' ', '_').replace('/', '-')
    path = os.path.join(WORKDIR, 'salida.' + ext)
    radio.save(path)
    with open(path, 'rb') as f:
        return name, f.read()


VERIFY_FIELDS = ['freq', 'name', 'duplex', 'offset', 'tmode', 'rtone', 'ctone', 'dtcs', 'rx_dtcs',
                 'dtcs_polarity', 'cross_mode', 'mode', 'power', 'skip', 'empty']
VERIFY_DELAY = 3.0   # espera inicial entre grabar y volver a leer (el radio se reinicia tras 'E')
VERIFY_RETRY_WAITS = (2.0, 3.0, 4.0)   # esperas antes de cada reintento de la lectura de comprobación


def _verify_by_rereading(radio, rid, first_wait):
    """Vuelve a leer el radio en una instancia aparte y compara. La lectura es de solo lectura, así que
    si falla en el saludo se reintenta (cerrando, reabriendo y vaciando el búfer entre intentos)."""
    time.sleep(first_wait)
    last = None
    attempts = 0
    for attempt in range(1 + len(VERIFY_RETRY_WAITS)):
        attempts += 1
        try:
            readback = _read_from_radio(rid, retry=False)
            res = compare_radios(radio, readback)
            res['attempts'] = attempts
            return res
        except Exception as e:
            last = e
            LOG.warning('Comprobación: intento %i falló: %s', attempts, e)
            if 'cancel' in str(e).lower() or _bridge.cancelled:
                break
            if attempt < len(VERIFY_RETRY_WAITS):
                time.sleep(VERIFY_RETRY_WAITS[attempt])
    return {'status': 'error', 'error': str(last), 'attempts': attempts, 'sent_complete': True}


@_api
def verify_tab(tab, radio_id=None):
    """'Comprobar de nuevo': lee el radio y lo compara con la pestaña (sin escribir nada)."""
    global _phase
    radio = _R(tab)
    rid = radio_id or _describe(radio)['id']
    _bridge.cancelled = False
    _phase = 'Comprobando'
    try:
        return _ok(verify=_verify_by_rereading(radio, rid, 0.5))
    finally:
        _phase = ''


def _devices_of(radio):
    return radio.get_sub_devices() if radio.get_features().has_sub_devices else [radio]


def _norm(v):
    return str(v) if v is not None else ''


def _write_regions(radio):
    """Regiones (inicio, fin) del mmap que el driver escribe, si las expone y coinciden con el mmap."""
    ranges = getattr(radio, '_ranges', None)
    if not ranges or not isinstance(radio, chirp_common.CloneModeRadio):
        return None
    try:
        regions = [(int(r[0]), int(r[1])) for r in ranges]
    except Exception:
        return None
    size = len(radio.get_mmap())
    return [r for r in regions if r[1] <= size] or None


def compare_radios(written, readback):
    """Compara lo escrito con lo leído de vuelta: por canales y (si se puede) por bytes."""
    diffs = []
    compared = 0
    non_empty = 0
    for di, (w, r) in enumerate(zip(_devices_of(written), _devices_of(readback))):
        rf = w.get_features()
        lo, hi = rf.memory_bounds
        for n in list(range(lo, hi + 1)) + list(rf.valid_special_chans):
            # Un canal que no se puede decodificar (datos raros en la imagen) cuenta como igual si falla
            # igual en los dos lados: la comparación por bytes ya cubre esos datos.
            ew = er = None
            mw = mr = None
            try:
                mw = w.get_memory(n)
            except Exception as e:
                ew = str(e)
            try:
                mr = r.get_memory(n)
            except Exception as e:
                er = str(e)
            if ew is not None or er is not None:
                compared += 1
                if ew != er:
                    diffs.append({'device': di, 'channel': n, 'fields': ['error: %s | %s' % (ew or 'ok', er or 'ok')]})
                continue
            compared += 1
            if not mw.empty:
                non_empty += 1
            if mw.empty and mr.empty:
                continue
            bad = [f for f in VERIFY_FIELDS if _norm(getattr(mw, f, None)) != _norm(getattr(mr, f, None))]
            if bad:
                diffs.append({'device': di, 'channel': n, 'fields': bad})
            else:
                pass
    byte_check = 'no disponible: el driver no expone las regiones que escribe (solo se comparó por canales)'
    byte_diffs = []
    regions = _write_regions(written)
    if regions is not None and isinstance(readback, chirp_common.CloneModeRadio):
        wm = written.get_mmap().get_byte_compatible()
        rm = readback.get_mmap().get_byte_compatible()
        total = 0
        for a, b in regions:
            total += b - a
            x, y = bytes(wm[a:b]), bytes(rm[a:b])
            if x != y:
                first = a + next(i for i in range(len(x)) if x[i] != y[i])
                byte_diffs.append({'start': a, 'end': b, 'first_diff': first})
        byte_check = 'ok' if not byte_diffs else 'diferencias'
        byte_total = total
    else:
        byte_total = 0
    matching = compared - len({(d['device'], d['channel']) for d in diffs})
    status = 'ok' if not diffs and not byte_diffs else 'diff'
    return {'status': status, 'compared': compared, 'non_empty': non_empty, 'matching': matching,
            'diffs': diffs[:200], 'diff_count': len(diffs), 'byte_check': byte_check,
            'byte_diffs': byte_diffs, 'byte_total': byte_total}


@_api
def upload(tab, radio_id=None):
    """Graba en el radio la imagen abierta y la verifica leyendo el radio de nuevo."""
    global _phase, _last_max
    if _scan_active:
        raise errors.RadioError('No se puede grabar mientras se detecta el radio')
    radio = _R(tab)
    if radio_id:
        chosen = directory.get_radio(radio_id)
        mine = getattr(radio, '_DETECTED_BY', None) or radio.__class__
        if not (issubclass(radio.__class__, chosen) or chosen is mine):
            raise errors.RadioError(
                'El archivo es de un %s %s y elegiste %s %s. Elige el mismo modelo.'
                % (radio.VENDOR, radio.MODEL, chosen.VENDOR, chosen.MODEL))
    if getattr(radio, 'READ_ONLY', False):      # antes de abrir el puerto: no se envía nada
        LOG.error('Grabación rechazada: modelo de solo lectura (%s %s)', radio.VENDOR, radio.MODEL)
        raise errors.RadioError(getattr(radio, 'READ_ONLY_MSG', 'Este modelo es de solo lectura.'))
    if hasattr(radio, 'check_image_before_upload'):     # validación propia del driver, antes de abrir el puerto
        try:
            radio.check_image_before_upload()
        except errors.RadioError as e:
            LOG.error('Grabación rechazada: %s', e)
            raise
    short = _image_shortfall(radio)
    if short:
        LOG.error('Grabación rechazada: imagen incompleta (%i de %i bytes)', *short)
        raise errors.RadioError(INCOMPLETE_IMAGE_MSG % short)
    rid = radio_id or _describe(radio)['id']
    _bridge.cancelled = False
    _phase = 'Grabando'
    greeting_attempts = 0
    try:
        while True:
            pipe = None
            t_attempt = _perf()
            try:
                pipe = _open_serial(radio)
                radio.set_pipe(pipe)
                radio.status_fn = _status_fn
                radio._status_fn = _status_fn
                _last_max = 0
                radio.sync_out()
                # Algunos drivers graban los rangos fuera de orden y terminan con cur < max: se cierra al 100 %
                if _last_max > 0 and _status_cb is not None:
                    try:
                        _status_cb(_last_max, _last_max, 'Grabando')
                    except Exception:
                        pass
                break
            except Exception as e:
                # Solo se reintenta si falló el saludo y NO se envió ningún mensaje de más de 8 bytes
                # (es decir, todavía no se escribió ningún bloque en el radio).
                started = pipe is not None and pipe.max_tx > 8
                greeting_attempts += 1
                if (greeting_attempts > GREETING_RETRIES or started or not _is_greeting_error(e)
                        or 'cancel' in str(e).lower() or _bridge.cancelled
                        or _perf() - t_attempt > 20):      # un intento lento (driver paciente) no se repite
                    if started:
                        LOG.error('La escritura ya había empezado; no se reintenta: %s', e)
                    raise
                LOG.warning('Falló el saludo al grabar (%s); reintento %i de %i tras %.1f s', e,
                            greeting_attempts, GREETING_RETRIES, GREETING_RETRY_WAIT)
            finally:
                if pipe is not None:
                    _safe_close(pipe)
            time.sleep(GREETING_RETRY_WAIT)
    finally:
        _phase = ''
    # Verificación: se vuelve a leer en una instancia aparte (no reemplaza la imagen abierta)
    verify = {'status': 'error', 'error': 'sin identificador de modelo para verificar'}
    if rid:
        _phase = 'Comprobando'
        try:
            verify = _verify_by_rereading(radio, rid, VERIFY_DELAY)
        except Exception as e:
            LOG.error('Verificación fallida: %s', e)
            verify = {'status': 'error', 'error': str(e), 'sent_complete': True}
        finally:
            _phase = ''
    return _ok(verify=verify)


# --------------------------------------------------------------- archivos

@_api
def open_file(name, data):
    safe = os.path.basename(name) or 'archivo.img'
    path = os.path.join(WORKDIR, safe)
    with open(path, 'wb') as f:
        raw = data.to_py() if hasattr(data, 'to_py') else data
        f.write(bytes(raw))
    radio = directory.get_radio_by_image(path)
    tab = _new_tab(radio)
    return _ok(radio=_describe(radio), tab=tab)


@_api
def save_file(tab):
    name, data = _image_bytes(_R(tab))
    return json.dumps({'ok': True, 'name': name, 'hex': data.hex()})


@_api
def new_csv():
    """Crea una lista vacía en formato CSV genérico de CHIRP."""
    radio = generic_csv.CSVRadio(None)
    tab = _new_tab(radio)
    return _ok(radio=_describe(radio), tab=tab)


@_api
def close_tab(tab):
    _radios.pop(tab, None)
    _settings.pop(tab, None)
    _undo.pop(tab, None)
    return _ok()


# --------------------------------------------------------------- memorias

def _device(tab, index):
    radio = _R(tab)
    if index and radio.get_features().has_sub_devices:
        return radio.get_sub_devices()[index]
    if radio.get_features().has_sub_devices:
        return radio.get_sub_devices()[0]
    return radio


def _list(v):
    return [x if isinstance(x, (int, float, str)) or x is None else str(x) for x in v]


@_api
def get_features(tab, device=0):
    rf = _device(tab, device).get_features()
    keys = ['has_dtcs', 'has_rx_dtcs', 'has_dtcs_polarity', 'has_mode',
            'has_offset', 'has_name', 'has_tuning_step', 'has_ctone',
            'has_cross', 'has_comment', 'has_settings', 'has_variable_power',
            'has_nostep_tuning', 'valid_name_length', 'valid_characters']
    lists = ['valid_modes', 'valid_tmodes', 'valid_duplexes',
             'valid_tuning_steps', 'valid_skips', 'valid_power_levels',
             'valid_cross_modes', 'valid_tones', 'valid_dtcs_pols',
             'valid_dtcs_codes', 'valid_special_chans']
    out = {k: getattr(rf, k) for k in keys}
    for k in lists:
        out[k] = _list(getattr(rf, k))
    out['memory_bounds'] = list(rf.memory_bounds)
    out['valid_bands'] = [list(b) for b in rf.valid_bands]
    return _ok(features=out)


def _mem_to_dict(mem):
    return {
        'number': mem.number,
        'extd_number': mem.extd_number or '',
        'empty': bool(mem.empty),
        'freq': chirp_common.format_freq(mem.freq) if mem.freq else '',
        'name': (mem.name or '').rstrip(),
        'duplex': mem.duplex,
        'offset': chirp_common.format_freq(mem.offset) if mem.offset else '0.000000',
        'tmode': mem.tmode,
        'rtone': mem.rtone,
        'ctone': mem.ctone,
        'dtcs': mem.dtcs,
        'rx_dtcs': mem.rx_dtcs,
        'dtcs_polarity': mem.dtcs_polarity,
        'cross_mode': mem.cross_mode,
        'mode': mem.mode,
        'tuning_step': mem.tuning_step,
        'skip': mem.skip,
        'power': str(mem.power) if mem.power is not None else '',
        'comment': mem.comment or '',
        'immutable': list(mem.immutable or []),
    }


@_api
def get_memories(tab, device=0):
    dev = _device(tab, device)
    rf = dev.get_features()
    lo, hi = rf.memory_bounds
    numbers = list(range(lo, hi + 1)) + list(rf.valid_special_chans)
    mems = []
    for n in numbers:
        try:
            mems.append(_mem_to_dict(dev.get_memory(n)))
        except Exception as e:
            LOG.warning('Memoria %s: %s', n, e)
    return _ok(memories=mems)


def _set_from_values(dev, v, fresh=False):
    """Aplica un dict de valores (como los de la tabla) a un canal. Devuelve (errores, avisos).
    fresh=True parte de un canal en blanco (pegado desde texto): no hereda datos viejos."""
    number = v['number']
    mem = dev.get_memory(number)
    if mem.empty or fresh:
        newmem = chirp_common.Memory()
        newmem.number = mem.number
        newmem.extd_number = mem.extd_number
        newmem.immutable = mem.immutable
        mem = newmem
    mem.empty = False
    rf = dev.get_features()
    if 'freq' in v:
        mem.freq = chirp_common.parse_freq(str(v['freq']))
    if 'offset' in v:
        mem.offset = chirp_common.parse_freq(str(v['offset'] or '0'))
    for k in ('name', 'duplex', 'tmode', 'dtcs_polarity', 'cross_mode',
              'mode', 'skip', 'comment'):
        if k in v and k not in mem.immutable:
            setattr(mem, k, v[k])
    for k in ('rtone', 'ctone', 'tuning_step'):
        if k in v and k not in mem.immutable:
            setattr(mem, k, float(v[k]))
    for k in ('dtcs', 'rx_dtcs'):
        if k in v and k not in mem.immutable:
            setattr(mem, k, int(v[k]))
    if 'power' in v and rf.valid_power_levels:
        match = [p for p in rf.valid_power_levels if str(p) == v['power']]
        mem.power = match[0] if match else rf.valid_power_levels[0]
    if 'name' in v and rf.has_name:
        mem.name = v['name'][:rf.valid_name_length]
    msgs = dev.validate_memory(mem)
    errs = [str(m) for m in msgs if isinstance(m, chirp_common.ValidationError)]
    warns = [str(m) for m in msgs if not isinstance(m, chirp_common.ValidationError)]
    if not errs:
        dev.set_memory(mem)
    return errs, warns


@_api
def set_memory(tab, device, values_json):
    dev = _device(tab, device)
    v = json.loads(values_json)
    errs, warns = _set_from_values(dev, v)
    if errs:
        return json.dumps({'ok': False, 'error': '; '.join(errs)})
    return _ok(memory=_mem_to_dict(dev.get_memory(v['number'])), warnings=warns)


@_api
def erase_memory(tab, device, number):
    dev = _device(tab, device)
    dev.erase_memory(number)
    return _ok(memory=_mem_to_dict(dev.get_memory(number)))


# --------------------------------------------------------------- ajustes

def _value_to_dict(val):
    d = {'mutable': val.get_mutable(), 'value': None}
    if isinstance(val, rsettings.RadioSettingValueBoolean):
        d.update(type='bool', value=bool(val.get_value()))
    elif isinstance(val, rsettings.RadioSettingValueList):
        d.update(type='list', options=[str(o) for o in val.get_options()],
                 value=str(val.get_value()))
    elif isinstance(val, rsettings.RadioSettingValueInteger):
        d.update(type='int', min=val.get_min(), max=val.get_max(),
                 step=val.get_step(), value=int(val.get_value()))
    elif isinstance(val, rsettings.RadioSettingValueFloat):
        d.update(type='float', min=val.get_min(), max=val.get_max(),
                 value=float(val.get_value()))
    elif isinstance(val, rsettings.RadioSettingValueString):
        d.update(type='string', value=str(val.get_value()),
                 maxlength=getattr(val, '_maxlength', None))
    else:
        d.update(type='string', value=str(val.get_value()))
    return d


def _group_to_dict(group, path):
    out = {'name': group.get_name(), 'path': path, 'groups': [], 'settings': []}
    for el in group:
        p = path + [el.get_name()]
        if isinstance(el, rsettings.RadioSetting):
            vals = [_value_to_dict(v) for v in el.values()] if len(el) > 1 \
                else [_value_to_dict(el.value)]
            out['settings'].append({'name': el.get_name(),
                                    'label': el.get_shortname(),
                                    'path': p, 'values': vals})
        else:
            out['groups'].append(_group_to_dict(el, p))
    return out


@_api
def get_settings(tab):
    radio = _R(tab)
    if not radio.get_features().has_settings:
        return _ok(groups=[])
    _settings[tab] = radio.get_settings()
    groups = [_group_to_dict(g, [g.get_name()]) for g in _settings[tab]]
    return _ok(groups=groups)


def _find_setting(tab, path):
    for g in _settings[tab]:
        if g.get_name() != path[0]:
            continue
        node = g
        for name in path[1:]:
            node = node[name]
        return node
    raise KeyError('/'.join(path))


@_api
def set_setting(tab, path_json, value_json, index=0):
    if _settings.get(tab) is None:
        raise errors.RadioError('Carga los ajustes primero')
    path = json.loads(path_json)
    value = json.loads(value_json)
    setting = _find_setting(tab, path)
    vals = list(setting.values()) if len(setting) > 1 else [setting.value]
    vals[index].set_value(value)
    if setting.has_apply_callback():
        setting.run_apply_callback()
    _R(tab).set_settings(_settings[tab])
    return _ok()


# ------------------------------------------------- detección automática (barrido)
# El barrido SOLO lee: a cada radio de prueba se le bloquea sync_out y cualquier escritura.

_scan_active = False
_scan_violations = 0     # intentos de escritura bloqueados (debe ser 0 en un barrido normal)
_scan_found = {}         # id -> radio descargado correctamente

SCAN_PRIORITY = ['Baofeng', 'Retevis', 'Quansheng', 'BTECH', 'TYT', 'Radioddity',
                 'Wouxun', 'AnyTone', 'Kenwood', 'Yaesu', 'Icom']
SIG_ATTRS = ['_magic', 'MAGIC', '_fileid', '_ident', 'IDENT', '_magic_response',
             '_idents', '_magics', '_fingerprint', '_model', 'PROGRAM_CMD']


def _forbidden_write(*a, **k):
    global _scan_violations
    _scan_violations += 1
    raise errors.RadioError('Escritura bloqueada: el barrido solo lee')


def _lock_writes(radio):
    """Hace fallar cualquier intento de escribir en el radio (a nivel de instancia)."""
    radio.sync_out = _forbidden_write
    live = getattr(radio, '_liveradio', None)
    if live is not None:
        for name in ('set_memory', 'erase_memory', 'set_settings'):
            setattr(live, name, _forbidden_write)


def _signature(rclass):
    parts = [rclass.__module__, getattr(rclass, 'BAUD_RATE', 9600),
             bool(getattr(rclass, 'HARDWARE_FLOW', False)),
             issubclass(rclass, chirp_common.LiveRadio)]
    for a in SIG_ATTRS:
        if hasattr(rclass, a):
            parts.append((a, repr(getattr(rclass, a))))
    return repr(parts)


def _tier(vendor):
    return SCAN_PRIORITY.index(vendor) if vendor in SCAN_PRIORITY else len(SCAN_PRIORITY)


@_api
def scan_candidates():
    """Grupos de modelos que comparten protocolo; se prueba un representante por grupo."""
    _load_all()
    groups = {}
    for rid, rclass in directory.DRV_TO_RADIO.items():
        live = issubclass(rclass, chirp_common.LiveRadio)
        if not (issubclass(rclass, chirp_common.CloneModeRadio) or live):
            continue
        if getattr(rclass, '_DETECTED_BY', None) or rclass.VENDOR == 'CHIRP':
            continue
        groups.setdefault(_signature(rclass), []).append((rid, rclass))
    out = []
    for sig, members in groups.items():
        members.sort(key=lambda m: (_tier(m[1].VENDOR), m[1].VENDOR, m[1].MODEL))
        rid, rclass = members[0]
        out.append({'rep_id': rid, 'vendor': rclass.VENDOR, 'model': rclass.MODEL,
                    'baud': getattr(rclass, 'BAUD_RATE', 9600),
                    'module': rclass.__module__.split('.')[-1],
                    'live': issubclass(rclass, chirp_common.LiveRadio),
                    'tier': _tier(rclass.VENDOR),
                    'members': [{'id': m[0], 'vendor': m[1].VENDOR, 'model': m[1].MODEL,
                                 'variant': m[1].VARIANT or ''} for m in members]})
    # primero los modelos comunes, luego por baudios (menos reaperturas), los "en vivo" al final
    out.sort(key=lambda g: (g['live'], g['tier'], g['baud'], g['module']))
    return _ok(groups=out, total_models=sum(len(g['members']) for g in out))


def _sane_image(radio):
    """Comprueba que la imagen descargada se puede leer (get_memories no lanza error)."""
    dev = radio
    rf = radio.get_features()
    if rf.has_sub_devices:
        dev = radio.get_sub_devices()[0]
        rf = dev.get_features()
    lo, hi = rf.memory_bounds
    for n in range(lo, min(hi, lo + 4000) + 1):
        dev.get_memory(n)


@_api
def probe(radio_id, timeout=8):
    """Prueba un protocolo SOLO leyendo. No reemplaza el radio abierto: guarda el resultado
    aparte (accept_probe lo adopta). `timeout` lo aplica el lado JavaScript con engine.cancel()."""
    global _scan_active
    _scan_active = True
    try:
        radio = _read_from_radio(radio_id, read_only=True)
        _sane_image(radio)
    finally:
        _scan_active = False
    _scan_found[radio_id] = radio
    return _ok(radio=_describe(radio), id=radio_id)


@_api
def accept_probe(radio_id):
    if radio_id not in _scan_found:
        raise errors.RadioError('No hay un resultado de detección para %s' % radio_id)
    radio = _scan_found[radio_id]
    _scan_found.clear()
    tab = _new_tab(radio)
    return _ok(radio=_describe(radio), tab=tab)


@_api
def scan_reset():
    global _scan_violations
    _scan_found.clear()
    _scan_violations = 0
    return _ok()


@_api
def scan_stats():
    return _ok(violations=_scan_violations, active=_scan_active)


# ------------------------------------------------- copiar canales entre radios distintos

_CH_FIELDS = [('freq', 'frecuencia'), ('name', 'nombre'), ('duplex', 'dúplex'), ('offset', 'offset'),
              ('tmode', 'modo de tono'), ('rtone', 'tono'), ('ctone', 'subtono'), ('dtcs', 'DTCS'),
              ('rx_dtcs', 'DTCS RX'), ('cross_mode', 'modo cruzado'), ('mode', 'modo'),
              ('power', 'potencia'), ('skip', 'Scan')]
_SCAN_LABEL = {'': 'Sí', 'S': 'No', 'P': 'Prioridad'}


def _fmt_field(field, mem):
    v = getattr(mem, field, None)
    if field in ('freq', 'offset'):
        return chirp_common.format_freq(v or 0)
    if field == 'skip':
        return _SCAN_LABEL.get(v, str(v))
    return '' if v is None else str(v)


def _import_channel(ddev, src_rf, mem, n):
    """Pone el canal `mem` (de un radio con features src_rf) en el número n del destino ddev usando la
    lógica de importación de CHIRP. Devuelve ('copiado'|'ajustado'|'no copiado', [notas])."""
    from chirp import import_logic
    try:
        newmem = import_logic.import_mem(ddev, src_rf, mem, {'number': n})
        ddev.set_memory(newmem)
        got = ddev.get_memory(n)
    except Exception as e:
        reason = str(e)
        if 'out of range' in reason.lower() or 'not in' in reason.lower() and 'band' in reason.lower():
            reason = 'frecuencia fuera de banda (%s)' % reason
        return 'no copiado', [reason]
    notes = []
    for field, label in _CH_FIELDS:
        a, b = _fmt_field(field, mem), _fmt_field(field, got)
        if field in ('rtone', 'ctone', 'dtcs', 'rx_dtcs') and mem.tmode == '' and got.tmode == '':
            continue
        if a != b:
            if field == 'name':
                notes.append('nombre recortado a %i caracteres' % len(got.name.rstrip()))
            else:
                notes.append('%s: %s → %s' % (label, a or '(vacío)', b or '(vacío)'))
    return ('ajustado' if notes else 'copiado'), notes


@_api
def copy_channels(src_tab, dst_tab, numbers_json=None, start=None):
    """Copia SOLO los canales de la pestaña origen a una COPIA de la pestaña destino (pestaña nueva).

    Usa chirp.import_logic.import_mem (potencias, tonos, bandas, largo del nombre...). Cada canal
    conserva su número, salvo que se indique `start` (posición de destino): con canales elegidos van
    consecutivos desde start, en el orden del origen; sin elegir, se desplaza todo igual. No se tocan los ajustes del destino ni las pestañas originales."""
    src = _R(src_tab)
    dst0 = _R(dst_tab)
    # copia independiente del destino (se guarda y se vuelve a abrir)
    ext = getattr(dst0, 'FILE_EXTENSION', 'img')
    path = os.path.join(WORKDIR, 'copia_destino.' + ext)
    dst0.save(path)
    new = directory.get_radio_by_image(path)
    sdev, ddev = _device(src_tab, 0), None
    ddev = new.get_sub_devices()[0] if new.get_features().has_sub_devices else new
    src_rf, dst_rf = sdev.get_features(), ddev.get_features()
    slo, shi = src_rf.memory_bounds
    dlo, dhi = dst_rf.memory_bounds
    if numbers_json:
        numbers = json.loads(numbers_json)
    else:
        numbers = list(range(slo, shi + 1)) + list(src_rf.valid_special_chans)
    pairs = [(n, n) for n in numbers]
    if start is not None:
        used = []
        for n in numbers:
            try:
                if isinstance(n, int) and not sdev.get_memory(n).empty:
                    used.append(n)
            except Exception:
                pass
        used.sort()
        if numbers_json:
            pairs = [(n, start + i) for i, n in enumerate(used)]
        else:
            pairs = [(n, start + n - used[0]) for n in used] if used else []
    details = []
    copied = adjusted = skipped = 0
    for sn, n in pairs:
        try:
            mem = sdev.get_memory(sn)
        except Exception as e:
            details.append({'number': n, 'src': sn, 'status': 'no copiado', 'notes': ['no se pudo leer en el origen: %s' % e]})
            skipped += 1
            continue
        if mem.empty:
            continue
        if isinstance(n, int) and not (dlo <= n <= dhi):
            details.append({'number': n, 'src': sn, 'status': 'no copiado',
                            'notes': ['el destino solo tiene %i canales (%i-%i)' % (dhi - dlo + 1, dlo, dhi)]})
            skipped += 1
            continue
        status, notes = _import_channel(ddev, src_rf, mem, n)
        if status == 'no copiado':
            details.append({'number': n, 'src': sn, 'status': status, 'notes': notes})
            skipped += 1
            continue
        if notes:
            adjusted += 1
        else:
            copied += 1
        details.append({'number': n, 'src': sn, 'status': status, 'notes': notes})
    tab = _new_tab(new)
    return _ok(tab=tab, radio=_describe(new), details=details,
               summary={'copied': copied, 'adjusted': adjusted, 'skipped': skipped,
                        'src_channels': shi - slo + 1, 'dst_channels': dhi - dlo + 1})


# ------------------------------------------------- copiar / pegar filas
# El portapapeles interno guarda copias completas de los canales (independientes de la pestaña de
# origen). Pegar escribe SOLO canales en la pestaña destino, nunca ajustes.
import copy as _copy

_clip = {'mems': [], 'rf': None}   # canales copiados + características del radio de origen
_undo = {}                         # pestaña -> pila de (dispositivo, [(número, Memory)])
_UNDO_LEVELS = 10


def _dst_numbers(dev, start, count):
    """Números de canal consecutivos a partir de start que existen en el destino."""
    lo, hi = dev.get_features().memory_bounds
    if not isinstance(start, int) or not (lo <= start <= hi):
        raise errors.RadioError('El canal %s no existe en este radio' % start)
    return [n for n in range(start, start + count) if n <= hi]


def _snapshot(dev, numbers):
    return [(n, _copy.deepcopy(dev.get_memory(n))) for n in numbers]


def _restore(dev, snap):
    for n, mem in snap:
        if mem.empty:
            dev.erase_memory(n)
        else:
            dev.set_memory(mem)


def _push_undo(tab, device, snap):
    stack = _undo.setdefault(tab, [])
    stack.append((device, snap))
    del stack[:-_UNDO_LEVELS]


@_api
def clip_copy(tab, device, numbers_json):
    """Guarda en memoria copias de los canales (solo numerados; los especiales se ignoran)."""
    dev = _device(tab, device)
    nums = json.loads(numbers_json)
    ints = sorted(n for n in nums if isinstance(n, int))
    _clip['mems'] = [_copy.deepcopy(dev.get_memory(n)) for n in ints]
    _clip['rf'] = dev.get_features()
    return _ok(count=len(ints), ignored=len(nums) - len(ints))


@_api
def clip_paste(tab, device, start):
    """Pega los canales guardados desde start, en orden, con la compatibilidad de «copiar canales»."""
    mems = _clip['mems']
    if not mems:
        raise errors.RadioError('No hay canales copiados')
    dev = _device(tab, device)
    numbers = _dst_numbers(dev, start, len(mems))
    snap = _snapshot(dev, numbers)
    details = []
    copied = adjusted = skipped = 0
    for n, mem in zip(numbers, mems):
        if mem.empty:
            try:
                dev.erase_memory(n)
            except Exception as e:
                details.append({'number': n, 'status': 'no copiado', 'notes': [str(e)]})
                skipped += 1
            continue
        status, notes = _import_channel(dev, _clip['rf'], mem, n)
        details.append({'number': n, 'status': status, 'notes': notes})
        if status == 'no copiado':
            skipped += 1
        elif notes:
            adjusted += 1
        else:
            copied += 1
    _push_undo(tab, device, snap)
    _settings.pop(tab, None)
    return _ok(details=details, first=numbers[0], pasted=len(numbers), requested=len(mems),
               summary={'copied': copied, 'adjusted': adjusted, 'skipped': skipped})


@_api
def paste_rows(tab, device, start, rows_json):
    """Pega filas venidas de texto (Excel): lista de dicts como los de set_memory. Todo o nada."""
    rows = json.loads(rows_json)
    dev = _device(tab, device)
    numbers = _dst_numbers(dev, start, len(rows))
    snap = _snapshot(dev, numbers)
    warns = []
    try:
        for n, row in zip(numbers, rows):
            if row.get('empty'):
                dev.erase_memory(n)
                continue
            errs, w = _set_from_values(dev, dict(row, number=n), fresh=True)
            if errs:
                raise errors.RadioError('Canal %i: %s' % (n, '; '.join(errs)))
            warns += ['Canal %i: %s' % (n, x) for x in w]
    except Exception as e:
        _restore(dev, snap)
        raise errors.RadioError('%s. No se cambió nada.' % e)
    _push_undo(tab, device, snap)
    _settings.pop(tab, None)
    return _ok(first=numbers[0], pasted=len(numbers), requested=len(rows), warnings=warns)


@_api
def undo_paste(tab):
    stack = _undo.get(tab)
    if not stack:
        raise errors.RadioError('No hay nada que deshacer')
    device, snap = stack.pop()
    _restore(_device(tab, device), snap)
    return _ok(device=device, count=len(snap))
