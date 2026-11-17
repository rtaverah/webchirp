// Motor: carga Pyodide + los drivers de CHIRP y expone una API en JavaScript.
import { SerialBridge } from './serial-bridge.js';

const EXTRA_DRIVER_FILES = ['kenwood_tk2402.py', 'kenwood_tk3407_clone.py'];
const PYODIDE_VERSION = '0.29.0';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export class Engine {
  constructor() {
    this.bridge = new SerialBridge();
    this.py = null;
    this.api = null;
    this.onStatus = () => {};
    this.onLog = () => {};
    this.logLines = [];
  }

  // Arranque rápido: baja Pyodide y chirp.zip en paralelo y NO importa ningún driver.
  async load(onStep = () => {}) {
    window.webchirpLog = (level, msg) => {
      const line = `[${level}] ${msg}`;
      this.logLines.push(line);
      if (this.logLines.length > 60000) this.logLines.shift();
      this.onLog(level, msg);
    };

    onStep('Cargando Python…');
    const base = new URL('..', import.meta.url);
    const text = (p) => fetch(new URL(p, base)).then((r) => r.text());
    // Estas descargas empiezan ya, mientras Pyodide se inicializa
    const zipP = fetch(new URL('chirp.zip', base)).then((r) => {
      if (!r.ok) throw new Error('Falta chirp.zip (ejecuta build.sh)');
      return r.arrayBuffer();
    });
    const extraP = {};
    for (const f of EXTRA_DRIVER_FILES) { extraP[f] = text('py/drivers_extra/' + f); extraP[f].catch(() => {}); }
    const glueP = Promise.all([text('py/webchirp.py'), text('py/serial_stub.py')]);
    zipP.catch(() => {}); glueP.catch(() => {});
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PYODIDE_URL + 'pyodide.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('No se pudo descargar Pyodide'));
        document.head.appendChild(s);
      });
    }
    this.py = await window.loadPyodide({ indexURL: PYODIDE_URL });

    onStep('Preparando los drivers de CHIRP…');
    const [zip, [glue, serialStub]] = await Promise.all([zipP, glueP]);
    this.py.unpackArchive(zip, 'zip', { extractDir: '/lib/webchirp' });
    this.py.FS.writeFile('/lib/webchirp/webchirp.py', glue);
    this.py.FS.writeFile('/lib/webchirp/serial.py', serialStub);
    // drivers propios de WebCHIRP (no vienen de CHIRP)
    this.py.FS.mkdirTree('/lib/webchirp/drivers_extra');
    this.py.FS.writeFile('/lib/webchirp/drivers_extra/__init__.py', '');
    for (const f of EXTRA_DRIVER_FILES) this.py.FS.writeFile('/lib/webchirp/drivers_extra/' + f, await extraP[f]);
    this.py.runPython("import sys; sys.path.insert(0, '/lib/webchirp')");

    this.api = this.py.pyimport('webchirp');
    const status = (cur, max, msg) => this.onStatus(cur, max, msg);
    JSON.parse(this.api.init(this.bridge, status));
    this.loadedModules = new Set();
    this.allLoaded = false;
    this.index = null;
    this.modelCount = 0;
  }

  // Índice estático de modelos (models.json): permite elegir modelo sin esperar a Pyodide
  async loadIndex(url = new URL('../models.json', import.meta.url)) {
    const data = await fetch(url).then((r) => {
      if (!r.ok) throw new Error('Falta models.json (genéralo con tools/build-index.html)');
      return r.json();
    });
    this.index = new Map();
    for (const r of data.radios) if (!r.alias_of) this.index.set(r.id, r);
    // aliases verificados en campo (aliases.json): se mezclan en la lista y usan el driver del destino
    this.fieldAliases = [];
    try {
      const list = await fetch(new URL('../aliases.json', import.meta.url)).then((r) => (r.ok ? r.json() : []));
      for (const a of list) {
        const t = this.index.get(a.target);
        if (!t || !a.vendor || !a.model) { console.warn('Alias ignorado (destino desconocido):', a); continue; }
        this.fieldAliases.push({ id: t.id, vendor: a.vendor, model: a.model, variant: '', live: t.live, modules: t.modules,
          alias_of: `${t.vendor} ${t.model}`, field_alias: true,
          compat: `${t.vendor} ${t.model}${t.variant ? ' ' + t.variant : ''}`, note: a.note || '' });
      }
    } catch (e) { console.warn('aliases.json no válido:', e); }
    const radios = [...data.radios, ...this.fieldAliases].sort((a, b) =>
      a.vendor.toLowerCase().localeCompare(b.vendor.toLowerCase()) || a.model.toLowerCase().localeCompare(b.model.toLowerCase()) ||
      (a.variant || '').localeCompare(b.variant || ''));
    this.entries = radios;
    this.modelCount = radios.length;
    return radios;
  }

  // Alias verificados que apuntan a alguno de estos ids de driver (para mostrarlos en el barrido)
  aliasesFor(ids) {
    const set = new Set(ids);
    return (this.fieldAliases || []).filter((a) => set.has(a.id)).map((a) => `${a.vendor} ${a.model}`);
  }

  async loadAll(onStep = () => {}) {
    if (this.allLoaded) return;
    onStep('Cargando todos los drivers…');
    const res = await this.call('load_all_drivers');
    this.allLoaded = true;
    this.failedDrivers = res.failed;
    this.modelCount = res.count;
  }

  // Importa solo el driver del modelo (o todos si no está en el índice)
  async ensureDriver(radioId, onStep = () => {}) {
    if (this.allLoaded) return;
    const entry = this.index && this.index.get(radioId);
    if (!entry) return this.loadAll(onStep);
    const missing = entry.modules.filter((m) => !this.loadedModules.has(m));
    if (!missing.length) return;
    onStep('Cargando el driver…');
    await this.call('load_driver', JSON.stringify(missing));
    missing.forEach((m) => this.loadedModules.add(m));
  }

  // Lee los metadatos de un .img (magic + JSON en base64) para identificar el modelo sin cargar todo
  static readMetadata(bytes) {
    const magic = [0x00, 0xff, 0x63, 0x68, 0x69, 0x72, 0x70, 0xee, 0x69, 0x6d, 0x67, 0x00, 0x01];
    outer: for (let i = bytes.length - magic.length; i >= 0 && i > bytes.length - 4096; i--) {
      for (let j = 0; j < magic.length; j++) if (bytes[i + j] !== magic[j]) continue outer;
      try {
        const b64 = new TextDecoder().decode(bytes.subarray(i + magic.length)).trim();
        return JSON.parse(atob(b64));
      } catch (_) { return null; }
    }
    return null;
  }

  // Llama a una función de webchirp.py. Las que tocan el puerto serie usan
  // callPromising para que Python pueda "esperar" a JavaScript (JSPI).
  async call(name, ...args) {
    const fn = this.api[name];
    const raw = fn.callPromising ? await fn.callPromising(...args) : fn(...args);
    const res = JSON.parse(raw);
    if (!res.ok) throw new Error(res.error);
    return res;
  }

  async listRadios() { await this.loadAll(); return this.call('list_radios').then((r) => r.radios); }
  // Cada lectura, archivo abierto o CSV nuevo crea una pestaña (imagen independiente en Python).
  // activeTab es la pestaña sobre la que operan memories(), upload(), saveFile()... si no se indica otra.
  async prompts(radioId, tab = this.activeTab) { if (radioId) await this.ensureDriver(radioId); return this.call('get_prompts', radioId || null, tab ?? null).then((r) => r.prompts); }
  async download(radioId) {
    await this.ensureDriver(radioId);
    this.bridge.cancelled = false;
    const r = await this.call('download', radioId);
    this.activeTab = r.tab;
    return { ...r.radio, tab: r.tab };
  }
  async upload(radioId, tab = this.activeTab) {
    if (radioId) await this.ensureDriver(radioId);
    this.bridge.cancelled = false;
    return this.call('upload', tab, radioId || null);
  }
  async copyChannels(srcTab, dstTab, numbers = null, start = null) {
    const r = await this.call('copy_channels', srcTab, dstTab, numbers ? JSON.stringify(numbers) : null, start);
    this.activeTab = r.tab;
    return r;
  }
  async verifyTab(radioId, tab = this.activeTab) {
    if (radioId) await this.ensureDriver(radioId);
    this.bridge.cancelled = false;
    return this.call('verify_tab', tab, radioId || null);
  }
  closeTab(tab) {
    if (this.activeTab === tab) this.activeTab = null;
    return this.call('close_tab', tab);
  }
  cancel() { this._scanAbort = true; this.bridge.cancel(); }

  async openFile(file, onStep = () => {}) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.prepareForFile(file.name, bytes, onStep);
    const pyBytes = this.py.toPy(bytes);
    try {
      const r = await this.call('open_file', file.name, pyBytes);
      this.activeTab = r.tab;
      return { ...r.radio, tab: r.tab };
    } finally {
      pyBytes.destroy();
    }
  }

  async saveFile(tab = this.activeTab) {
    const r = await this.call('save_file', tab);
    const bytes = new Uint8Array(r.hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(r.hex.substr(i * 2, 2), 16);
    return { name: r.name, bytes };
  }

  // Carga solo el driver del archivo (según sus metadatos); sin metadatos, todos
  async prepareForFile(name, bytes, onStep = () => {}) {
    if (this.allLoaded || /\.csv$/i.test(name)) return;
    const meta = Engine.readMetadata(bytes);
    if (meta && this.index) {
      const compat = { 'Retevis|RT-5R': 'Retevis|RT5R', 'Retevis|RT-5RV': 'Retevis|RT5RV', 'Signus|XTR-5': 'Cignus|XTR-5' };
      const key = compat[`${meta.vendor}|${meta.model}`] || `${meta.vendor}|${meta.model}`;
      const hit = this.entries.find((r) => `${r.vendor}|${r.model}` === key &&
        (meta.variant == null || (r.variant || '') === meta.variant));
      if (hit) return this.ensureDriver(hit.id, onStep);
    }
    onStep('Identificando archivo…');
    await this.loadAll(onStep);
  }

  newCsv() { return this.call('new_csv').then((r) => { this.activeTab = r.tab; return { ...r.radio, tab: r.tab }; }); }
  features(dev = 0, tab = this.activeTab) { return this.call('get_features', tab, dev).then((r) => r.features); }
  memories(dev = 0, tab = this.activeTab) { return this.call('get_memories', tab, dev).then((r) => r.memories); }
  setMemory(dev, values, tab = this.activeTab) { return this.call('set_memory', tab, dev, JSON.stringify(values)); }
  eraseMemory(dev, number, tab = this.activeTab) { return this.call('erase_memory', tab, dev, number).then((r) => r.memory); }
  // Copiar/pegar filas: el portapapeles interno vive en Python (copias completas, sin ajustes)
  clipCopy(dev, numbers, tab = this.activeTab) { return this.call('clip_copy', tab, dev, JSON.stringify(numbers)); }
  clipPaste(dev, start, tab = this.activeTab) { return this.call('clip_paste', tab, dev, start); }
  pasteRows(dev, start, rows, tab = this.activeTab) { return this.call('paste_rows', tab, dev, start, JSON.stringify(rows)); }
  undoPaste(tab = this.activeTab) { return this.call('undo_paste', tab); }
  settings(tab = this.activeTab) { return this.call('get_settings', tab).then((r) => r.groups); }
  setSetting(path, value, index = 0, tab = this.activeTab) {
    return this.call('set_setting', tab, JSON.stringify(path), JSON.stringify(value), index);
  }

  // ---------- Detección automática (barrido): SOLO lee, nunca escribe en el radio ----------

  scanReset() { return this.call('scan_reset'); }
  scanStats() { return this.call('scan_stats'); }

  // Prueba un protocolo; el límite de tiempo se aplica cancelando la lectura pendiente del puente
  async probe(radioId, timeoutMs = 7000) {
    this.bridge.cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.bridge.cancel(); }, timeoutMs);
    try {
      const r = await this.call('probe', radioId, timeoutMs / 1000);
      return r.radio;
    } catch (e) {
      if (timedOut) e.message = 'Tiempo agotado (' + e.message + ')';
      throw e;
    } finally {
      clearTimeout(timer);
      this.bridge.cancelled = false;
    }
  }

  acceptProbe(radioId) { return this.call('accept_probe', radioId).then((r) => { this.activeTab = r.tab; return { ...r.radio, tab: r.tab }; }); }

  // onProgress({i, n, group, found, elapsedMs, etaMs}); opts: {timeoutMs, pauseGate, all}
  async scan(onProgress = () => {}, opts = {}) {
    const timeoutMs = opts.timeoutMs || 7000;
    await this.loadAll();
    if (!opts.startAt) await this.scanReset();
    const { groups } = await this.call('scan_candidates');
    this._scanAbort = false;
    const found = [];
    const t0 = performance.now();
    let tested = 0;
    for (let i = opts.startAt || 0; i < groups.length; i++) {
      if (this._scanAbort) break;
      if (opts.pauseGate) await opts.pauseGate();
      if (this._scanAbort) break;
      const g = groups[i];
      const elapsed = performance.now() - t0;
      onProgress({ i: i + 1, n: groups.length, group: g, found, elapsedMs: elapsed,
        etaMs: tested ? (elapsed / tested) * (groups.length - i) : null });
      let desc = null;
      try {
        desc = await this.probe(g.rep_id, timeoutMs);
      } catch (e) {
        // sin respuesta o protocolo distinto: se sigue con el siguiente
      }
      tested++;
      if (this._scanAbort) break;
      if (desc) {
        found.push({ group: g, radio: desc, index: i });
        if (!opts.all) break;
      }
      // el puerto ya se cerró dentro de probe(); pausa corta y búfer limpio antes de la siguiente
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 300));
      this.bridge.clearInput();
    }
    return { found, groups: groups.length, tested, cancelled: !!this._scanAbort,
      elapsedMs: performance.now() - t0 };
  }
}
