// Puente entre Web Serial (asíncrono) y los drivers de CHIRP (que esperan
// un puerto serie estilo pyserial con lecturas bloqueantes y timeout).
// Python llama a estos métodos a través de pyodide.ffi.run_sync().

export class SerialBridge {
  constructor() {
    this.port = null;
    this.options = null;
    this.signals = { requestToSend: undefined, dataTerminalReady: undefined };
    this._chunks = [];        // Uint8Array recibidos y aún no consumidos
    this._buffered = 0;
    this._waiter = null;      // resolver para despertar a read()
    this._reader = null;
    this._readLoop = null;
    this.cancelled = false;
    this.lineErrors = 0;      // errores de línea (BreakError, FramingError…) vistos; se lee desde Python
  }

  static supported() {
    return 'serial' in navigator;
  }

  get isOpen() {
    return !!(this.port && this.port.readable);
  }

  // Abre el selector de puertos del navegador (debe llamarse desde un clic).
  async choosePort() {
    const port = await navigator.serial.requestPort();
    await this.close();
    this.port = port;
    return SerialBridge.describe(port);
  }

  portInfo() {
    return this.port ? SerialBridge.describe(this.port) : 'sin puerto';
  }

  static describe(port) {
    const info = port.getInfo ? port.getInfo() : {};
    if (info.usbVendorId !== undefined) {
      const hex = (n) => n.toString(16).padStart(4, '0').toUpperCase();
      return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
    }
    return 'Puerto serie';
  }

  async open(opts) {
    if (!this.port) throw new Error('No se ha elegido un puerto COM');
    this.options = {
      baudRate: opts.baudRate || 9600,
      dataBits: opts.dataBits || 8,
      stopBits: opts.stopBits || 1,
      parity: opts.parity || 'none',
      flowControl: opts.flowControl || 'none',
      bufferSize: 65536,
    };
    // Siempre se intenta cerrar antes: tras un error fatal readable es null pero el puerto sigue abierto
    await this.close();
    await this.port.open(this.options);
    this._clear();
    try {
      await this._applySignals();
    } catch (e) {
      try { await this.port.close(); } catch (_) { /* ignore */ }
      throw e;
    }
    this._readLoop = this._startReading();
  }

  // Cambia baudios/paridad/etc. con el puerto abierto (algunos drivers lo hacen).
  async reconfigure(changes) {
    const next = { ...(this.options || {}), ...changes };
    const same = this.options && Object.keys(changes).every((k) => this.options[k] === changes[k]);
    if (same && this.isOpen) return;
    if (this.isOpen) await this.close();
    await this.open(next);
  }

  async setSignals(sig) {
    Object.assign(this.signals, sig);
    if (this.isOpen) await this._applySignals();
  }

  async _applySignals() {
    const s = {};
    for (const [k, v] of Object.entries(this.signals)) if (v !== undefined) s[k] = !!v;
    if (Object.keys(s).length) await this.port.setSignals(s);
  }

  async _startReading() {
    while (this.port && this.port.readable) {
      this._reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value && value.length) {
            this._chunks.push(value);
            this._buffered += value.length;
            this._wake();
          }
        }
      } catch (e) {
        // Error de línea (p. ej. framing/break): seguimos leyendo si el puerto sigue abierto.
        console.warn('Lectura serie:', e);
        this.lineErrors++;
        try {
          if (window.webchirpLog) window.webchirpLog('ERROR', `ERROR DE LÍNEA: ${e && e.name} ${e && e.message} (nº ${this.lineErrors})`);
        } catch (_) { /* el registro nunca debe romper la lectura */ }
      } finally {
        try { this._reader.releaseLock(); } catch (_) { /* ignore */ }
        this._reader = null;
      }
      if (this._closing) break;
    }
  }

  _wake() {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w();
    }
  }

  _clear() {
    this._chunks = [];
    this._buffered = 0;
  }

  get available() {
    return this._buffered;
  }

  _take(n) {
    const out = new Uint8Array(Math.min(n, this._buffered));
    let off = 0;
    while (off < out.length) {
      const c = this._chunks[0];
      const need = out.length - off;
      if (c.length <= need) {
        out.set(c, off);
        off += c.length;
        this._chunks.shift();
      } else {
        out.set(c.subarray(0, need), off);
        this._chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this._buffered -= out.length;
    return out;
  }

  // Lee hasta n bytes; espera como máximo timeoutMs (null = sin límite).
  // Nota: la espera usa setTimeout para volver a comprobar el plazo. En una pestaña oculta Chrome
  // alarga los timers (1 s o más), así que un timeout corto puede tardar más de lo pedido; los datos
  // que llegan sí despiertan la lectura de inmediato (no dependen del timer).
  async read(n, timeoutMs) {
    if (this.cancelled) throw new Error('Operación cancelada');
    const deadline = timeoutMs == null ? Infinity : performance.now() + timeoutMs;
    while (this._buffered < n) {
      if (this.cancelled) throw new Error('Operación cancelada');
      const left = deadline - performance.now();
      if (left <= 0 || !this.isOpen) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1000));
        this._waiter = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (this.cancelled) throw new Error('Operación cancelada');
    if (this._buffered < n && !this.isOpen) {
      throw new Error('El puerto se cerró o el radio se desconectó');
    }
    return this._take(n);
  }

  async write(bytes) {
    if (this.cancelled) throw new Error('Operación cancelada');
    if (!this.isOpen) throw new Error('El puerto no está abierto');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
    return bytes.length;
  }

  // Cancela la operación en curso y despierta cualquier lectura pendiente.
  cancel() {
    this.cancelled = true;
    this._wake();
  }

  // Devuelve (y descarta) lo que haya en el búfer de entrada: basura al abrir, restos de la sesión anterior
  drain() {
    const out = this._take(this._buffered);
    return out;
  }

  clearInput() {
    this._clear();
  }

  async close() {
    if (!this.port) return;
    this._closing = true;
    try {
      try { if (this._reader) await this._reader.cancel(); } catch (e) { console.warn('Cancelando lector:', e); }
      try { if (this._readLoop) await this._readLoop; } catch (e) { console.warn('Esperando lectura:', e); }
      // Se intenta cerrar siempre: tras un error fatal readable es null pero el puerto sigue abierto.
      try { await this.port.close(); } catch (e) { console.warn('Cerrando puerto:', e); }
    } finally {
      this._closing = false;
      this._readLoop = null;
      this._clear();
      this._wake();
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
