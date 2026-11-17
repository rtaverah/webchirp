// Puerto serie simulado con la misma interfaz de Web Serial que usa SerialBridge.
// Lo que el driver escribe va al emulador (Python); las respuestas llegan por
// readable troceadas en fragmentos de 1 a 64 bytes con pequeños retardos.

const nativeSetTimeout = window.setTimeout.bind(window);   // no se ve afectado por los timers lentos simulados
const sleep = (ms) => new Promise((r) => nativeSetTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export class FakeSerialPort {
  // faults: { mute, garbage, short, corruptAfter, disconnectAtWrite, cancelAtWrite, onCancel }
  constructor(emu, faults = {}) {
    this.emu = emu;           // objeto Python con feed_js/on_open (o null = radio mudo)
    this.faults = faults;
    this.state = 'closed';    // 'closed' | 'open'
    this.readable = null;
    this.writable = null;
    this.opens = 0;
    this.writes = 0;
    this.baudHistory = [];
    this._q = Promise.resolve();
    this._col = 0;           // bytes de PROGRAM ya enviados (modo colisión)
    this._gen = 0;
  }

  getInfo() { return { usbVendorId: 0x1a86, usbProductId: 0x7523 }; }

  async setSignals() {
    if (this.state !== 'open') throw new DOMException('puerto cerrado', 'InvalidStateError');
  }

  async open(opts) {
    if (this.state !== 'closed') throw new DOMException('El puerto ya está abierto', 'InvalidStateError');
    this.state = 'open';
    this.opens++;
    this.baudHistory.push(opts.baudRate);
    this._gen++;
    if (this.emu) this.emu.on_open(opts.baudRate);
    const gen = this._gen;
    this.readable = new ReadableStream({ start: (c) => { this._ctrl = c; this._ctrlGen = gen; } });
    this.writable = new WritableStream({ write: (chunk) => this._onWrite(chunk, gen) });
    // basura al abrir (CH340, DTR/RTS) o un ACK viejo de la sesión anterior: llega antes de que el driver escriba
    const junk = this.faults.junkOnOpen;
    if (junk && junk.length) this._ctrl.enqueue(Uint8Array.from(junk));
    if (this.emu && this.emu.open_junk) {
      const j = new Uint8Array(this.emu.open_junk());
      if (j.length) this._ctrl.enqueue(j);
    }
  }

  async close() {
    if (this.state !== 'open') throw new DOMException('El puerto no está abierto', 'InvalidStateError');
    if ((this.readable && this.readable.locked) || (this.writable && this.writable.locked)) {
      throw new TypeError('No se puede cerrar con flujos bloqueados');
    }
    this.state = 'closed';
    this._gen++;
    this.readable = null;
    this.writable = null;
  }

  // Error fatal (cable desconectado): readable/writable pasan a null pero el puerto sigue "abierto" hasta close()
  _fatal() {
    try { this._ctrl.error(new DOMException('Dispositivo perdido', 'NetworkError')); } catch (_) { /* ya cerrado */ }
    this.readable = null;
    this.writable = null;
  }

  async _onWrite(chunk, gen) {
    if (gen !== this._gen) throw new DOMException('puerto cerrado', 'InvalidStateError');
    this.writes++;
    const f = this.faults;
    if (f.cancelAtWrite && this.writes === f.cancelAtWrite && f.onCancel) f.onCancel();
    if ((f.disconnectAtWrite && this.writes === f.disconnectAtWrite) || (f.disconnectWhen && f.disconnectWhen())) {
      this._fatal();
      throw new DOMException('Dispositivo perdido', 'NetworkError');
    }
    // Cable de un solo hilo (Kenwood KPG-22): todo lo escrito vuelve a llegar como eco, antes de la respuesta
    let dropRadioResp = false;
    if (f.echo && f.collision && this._col < 7 && this.emu) {
      // el radio empieza a responder mientras todavía sale PROGRAM: en el hilo compartido las señales chocan
      this._col++;
      const first = this.emu.direct06 ? 0x06 : 0x16;
      if (this._col === 1) this._deliver(new Uint8Array(chunk).slice(), gen, true);
      else if (this._col === 2) this._deliver(Uint8Array.of(new Uint8Array(chunk)[0] | 0x80, first), gen, true);   // 'R' alterada + respuesta
      if (this._col === 7) dropRadioResp = true;       // la respuesta ya se entregó antes
      // el resto del eco de PROGRAM se pierde
    } else if (f.echo) {
      let echo = new Uint8Array(chunk).slice();
      if (f.echoCorruptAt && this.writes === f.echoCorruptAt) echo[0] ^= 0x10;
      if (f.echoCorruptFrom && this.writes >= f.echoCorruptFrom) echo[0] ^= 0x10;     // cable dañado: todos los ecos salen mal
      if (f.echoDropFirst && !this._echoDropped) { echo = echo.slice(f.echoDropFirst); this._echoDropped = true; }   // parte del eco ya se vació
      const c0 = new Uint8Array(chunk);
      if (f.lateEchoP && !this._lateHeld && c0.length === 1 && c0[0] === 0x50) { this._lateHeld = true; echo = new Uint8Array(0); }   // eco de la 'P' de PROGRAM retenido
      else if (f.lateEchoP && this._lateHeld === true && c0.length === 1 && c0[0] === 0x02) { this._lateHeld = 'done'; echo = Uint8Array.of(0x50, 0x02); }   // llega tarde, antes del eco del 0x02
      if (f.echoLost02 && c0.length === 1 && c0[0] === 0x02) echo = new Uint8Array(0);   // el eco del 0x02 se pierde por choque
      this._deliver(echo, gen, !!f.echoChunked);
    }
    let resp = new Uint8Array(0);
    if (this.emu && !f.mute) {
      const r = this.emu.feed_js(new Uint8Array(chunk), performance.now() / 1000);
      resp = new Uint8Array(r);
    }
    if (f.short && !this.emu) {
      resp = Uint8Array.of(rnd(0, 255));
    } else if (f.corruptDataOnce && !this._corrupted && this.writes >= f.corruptDataOnce && resp.length >= 8) {
      this._corrupted = true;
      resp = resp.slice();
      resp[rnd(resp.length >> 1, resp.length - 1)] ^= 1 << rnd(0, 7);
    } else if (f.garbage) {
      resp = new Uint8Array(rnd(1, 24)).map(() => rnd(0, 255));
    } else if (f.short && resp.length > 1) {
      resp = resp.slice(0, Math.max(1, Math.floor(resp.length / 2)));
    } else if (f.corruptAfter != null && this.writes > f.corruptAfter && resp.length) {
      resp = resp.slice();
      resp[rnd(0, resp.length - 1)] ^= 1 << rnd(0, 7);
    }
    if (!dropRadioResp) this._deliver(resp, gen);
  }

  _deliver(bytes, gen, single = false) {
    let off = 0;
    while (off < bytes.length) {
      const n = single ? 1 : Math.min(rnd(1, 64), bytes.length - off);
      const piece = bytes.slice(off, off + n);
      off += n;
      this._q = this._q.then(async () => {
        await sleep(rnd(0, 2));
        if (gen !== this._gen || !this.readable) return;
        try { this._ctrl.enqueue(piece); } catch (_) { /* flujo cerrado */ }
      });
    }
  }
}
