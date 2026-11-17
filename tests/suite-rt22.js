// Protocolo retevis_rt22 (LUITON LT-316 / Motorola C1): lectura, clonación A→B, grabar con verificación,
// reintento tras fallo y pestaña "oculta" simulada (timers de 1 s) gracias a las pausas precisas.
import { engine, record, fetchImg, makeEmu, attach, radioId, eq, hex } from './harness.js';

export const SUITE = 'rt22';
const S = SUITE;
const RID = 'LUITON_LT-316';
const scr = (img) => { const b = img.slice(); for (let i = 0x20; i < 0x200; i++) b[i] = (i * 7 + 1) & 0xff; return b; };
const nativeSetTimeout = window.setTimeout.bind(window);

async function withHiddenTab(fn) {
  window.setTimeout = (f, ms, ...a) => nativeSetTimeout(f, Math.max(ms || 0, 1000), ...a);   // como una pestaña oculta
  try { return await fn(); } finally { window.setTimeout = nativeSetTimeout; }
}

export async function run() {
  const img = await fetchImg('Retevis_RT22.img');
  // 1) lectura normal
  const A = makeEmu('rt22', img, null, RID);
  try {
    await attach(A);
    const d = await engine.download(RID);
    const saved = (await engine.saveFile()).bytes;
    const mem = A.memory_js();
    const ranges = A.ranges.toJs().map((r) => [r[0], r[1]]);
    const same = ranges.every(([a, b]) => eq(saved.slice(a, b), mem.slice(a, b)));
    record(S, 'lectura: bytes descargados == memoria del emulador (regiones que lee el driver)', same && d.model === 'LT-316', `${d.vendor} ${d.model}, regiones ${JSON.stringify(ranges)}`);
  } catch (e) { record(S, 'lectura', false, e.message); return; }
  // 1b) traza serie en el registro (para diagnosticar con radios reales)
  const L = engine.logLines.join('\n');
  record(S, 'traza: TX del saludo byte a byte con hex y ASCII (P R O G R G S)', /TX 1: 50 \|P\|[\s\S]*TX 1: 52 \|R\|[\s\S]*TX 1: 53 \|S\|/.test(L), (L.match(/TX 1: .*/) || ['no hay'])[0]);
  record(S, 'traza: RX con tiempo y hex', /RX 1\/1 \(\d+ ms\): 06 \|\.\|/.test(L), (L.match(/RX 1\/1 .*/) || ['no hay'])[0]);
  record(S, 'traza: se registra la apertura del puerto (baudios, paridad, flujo, señales, VID:PID)', /Puerto abierto: USB 1A86:7523, \d+ baudios, paridad none, 8 bits.*control de flujo ninguno, RTS=.*DTR=/.test(L), (L.match(/Puerto abierto.*/) || ['no hay'])[0]);
  // 2) clonación A -> B con verificación
  try {
    const B = makeEmu('rt22', scr(img), null, RID);
    const port = await attach(B);
    const up = await engine.upload(RID);
    const w = B.writes.toJs();
    const a = A.memory_js(), b = B.memory_js();
    record(S, 'clonación A→B: memoria de B == A en lo que se escribe', w.length > 0 && w.every(([x, n]) => eq(a.slice(x, x + n), b.slice(x, x + n))), `${w.length} bloques`);
    record(S, 'grabar con verificación: ok', up.verify.status === 'ok' && port.state === 'closed', `${up.verify.status} ${up.verify.error || ''} (${up.verify.matching}/${up.verify.compared}), bytes: ${up.verify.byte_check}`);
  } catch (e) { record(S, 'clonación A→B', false, e.message); }
  // 2b) traza de lecturas vacías/incompletas y límite de líneas tras los primeros 2 KB
  try {
    engine.logLines.length = 0;
    await attach(null, { mute: true });
    try { await engine.download(RID); } catch (e) { /* esperado */ }
    const Lm = engine.logLines.join('\n');
    record(S, 'traza: lectura vacía indicada con el tiempo esperado', /RX 0\/1 \(\d+ ms\): \(vacío\) VACÍO: no llegó nada en 0\.\d+ s/.test(Lm), (Lm.match(/RX 0\/1.*/) || ['no hay'])[0]);
    engine.logLines.length = 0;
    const uv = await fetchImg('Baofeng_UV-5R.img');
    await attach(makeEmu('uv5r', uv));
    await engine.download('Baofeng_UV-5R');
    const Lu = engine.logLines.join('\n');
    const lim = engine.py.runPython("import webchirp; webchirp._trace_bytes = 5000; webchirp._trace_fmt(bytes(range(200)))");
    record(S, 'traza: tras 2 KB una línea larga se limita a 64 bytes e indica los omitidos', /\(\+136 bytes omitidos\)$/.test(lim) && !/ C7 /.test(lim), lim.slice(-60));
    const full = engine.py.runPython("import webchirp; webchirp._trace_bytes = 0; webchirp._trace_fmt(bytes(range(200)))");
    record(S, 'traza: en los primeros 2 KB no se limita', !/omitidos/.test(full) && / C7 /.test(full));
    record(S, 'traza: las primeras líneas largas (< 2 KB) no se limitan', /RX 64\/64 \([^)]*\): ([0-9A-F]{2} ){63}[0-9A-F]{2} \|[^|]*\|\n/.test(Lu));
    record(S, 'traza: el UV-5R sigue leyendo bien con la traza activa', true, `${engine.logLines.length} líneas de registro en una lectura completa`);
  } catch (e) { record(S, 'traza (vacío/limite)', false, e.message); }

  // 3) reintento seguro: falla (radio mudo) y vuelve a leer sin recargar
  try {
    const port = await attach(null, { mute: true });
    let err = null;
    try { await engine.download(RID); } catch (e) { err = e; }
    record(S, 'radio mudo: falla con error', !!err && port.state === 'closed', err && err.message.slice(0, 80));
    const port2 = await attach(makeEmu('rt22', img, null, RID));
    engine.bridge.cancelled = true;               // un estado sucio de la operación anterior
    const d = await engine.download(RID);
    record(S, 'reintento tras el fallo: lee bien (puerto reabierto, búfer limpio, cancelled=false)', d.model === 'LT-316' && port2.opens === 1 && !engine.bridge.cancelled);
  } catch (e) { record(S, 'reintento tras fallo', false, e.message); }
  // 4) desconexión fatal y reintento sobre el MISMO puerto simulado (readable=null pero el puerto sigue abierto)
  try {
    const E = makeEmu('rt22', img, null, RID);
    const port = await attach(E, { disconnectAtWrite: 30 });
    let err = null;
    try { await engine.download(RID); } catch (e) { err = e; }
    record(S, 'desconexión a mitad: error y puerto cerrado', !!err && port.state === 'closed', err && err.message.slice(0, 80));
    port.faults = {};
    const d = await engine.download(RID);
    record(S, 'reintento sobre el mismo puerto tras una desconexión: funciona', d.model === 'LT-316' && port.state === 'closed');
  } catch (e) { record(S, 'reintento tras desconexión', false, e.message); }
  // 5) pestaña oculta simulada: las pausas de 5 ms del saludo no deben estirarse
  const py = engine.py;
  try {
    const E = makeEmu('rt22', img, null, RID);
    await attach(E);
    const t0 = performance.now();
    const d = await withHiddenTab(() => engine.download(RID));
    record(S, 'pestaña oculta simulada (timers de 1 s): el saludo funciona con pausas precisas', d.model === 'LT-316', `${Math.round(performance.now() - t0)} ms`);
  } catch (e) { record(S, 'pestaña oculta con pausas precisas', false, e.message); }
  // 6) contraste: con las pausas antiguas (setTimeout puro) el mismo escenario falla
  try {
    py.runPython("import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.0");
    const E = makeEmu('rt22', img, null, RID);
    await attach(E);
    let err = null;
    try { await withHiddenTab(() => engine.download(RID)); } catch (e) { err = e; }
    record(S, 'contraste: sin espera activa, con timers de 1 s el saludo falla (demuestra la corrección)', !!err, err ? err.message.slice(0, 90) : 'no falló');
  } catch (e) { record(S, 'contraste sin espera activa', false, e.message); }
  finally { py.runPython("import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.05"); }

  // 7) bloques que llegan con la cola perdida: el reintento deja la lectura completa e idéntica
  const tabCount = () => py.runPython('import webchirp; len(webchirp._radios)');
  try {
    const E = makeEmu('rt22', img, null, RID);
    E.lose_next = 3;                       // las 3 primeras respuestas 'R' llegan cortas
    await attach(E);
    engine.logLines.length = 0;
    const d = await engine.download(RID);
    const saved = (await engine.saveFile()).bytes;
    const mem = E.memory_js();
    const ranges = E.ranges.toJs().map((r) => [r[0], r[1]]);
    const same = ranges.every(([a, b]) => eq(saved.slice(a, b), mem.slice(a, b)));
    const retries = (engine.logLines.join('\n').match(/incompleto \(\d+ de \d+ bytes\); reintento/g) || []).length;
    record(S, 'bloques con cola perdida: la lectura sale completa e idéntica gracias a los reintentos', same && d.model === 'LT-316' && E.lost_blocks === 3 && retries === 3, `${saved.length} bytes, ${E.lost_blocks} bloques perdidos, ${retries} reintentos`);
  } catch (e) { record(S, 'bloques con cola perdida', false, e.message); }
  // 8) el radio pierde siempre: falla con el mensaje claro y sin crear pestaña
  try {
    const E = makeEmu('rt22', img, null, RID);
    E.lose_always = true;
    const port = await attach(E);
    const before = tabCount();
    let err = null;
    try { await engine.download(RID); } catch (e) { err = e; }
    record(S, 'pérdida permanente: la lectura falla y no se crea pestaña', !!err && tabCount() === before && port.state === 'closed', err ? err.message.slice(0, 110) : 'no falló');
  } catch (e) { record(S, 'pérdida permanente', false, e.message); }
  // 8b) guarda genérica de lectura: si el driver devolviera una imagen corta, no se crea la pestaña
  try {
    // el driver "devuelve" una imagen de 0x300 bytes aunque el radio tenga 0x400 (lo que haría un bloque corto no detectado)
    py.runPython(`
import webchirp
from chirp import memmap
from chirp.drivers import retevis_rt22
_orig_do_download = retevis_rt22.do_download
def _short_do_download(radio):
    return memmap.MemoryMapBytes(bytes(_orig_do_download(radio)[0:0x300]))
retevis_rt22.do_download = _short_do_download
`);
    await attach(makeEmu('rt22', img, null, RID));
    const before = tabCount();
    let err = null;
    try { await engine.download(RID); } catch (e) { err = e; }
    record(S, 'guarda de lectura: imagen corta -> "Lectura incompleta" y sin pestaña', !!err && /Lectura incompleta/.test(err.message) && tabCount() === before, err ? err.message.slice(0, 110) : 'no falló');
  } catch (e) { record(S, 'guarda de lectura', false, e.message); }
  finally { py.runPython('from chirp.drivers import retevis_rt22\nretevis_rt22.do_download = _orig_do_download'); }
  // 9) guarda de grabación: una imagen corta se rechaza sin enviar ni un byte
  try {
    const A2 = makeEmu('rt22', img, null, RID);
    await attach(A2);
    const d = await engine.download(RID);
    py.runPython(`import webchirp\nfrom chirp import memmap\nr = webchirp._radios[${d.tab}]\nr._mmap = memmap.MemoryMapBytes(bytes(r.get_mmap()[0:0x100]))`);
    const B = makeEmu('rt22', scr(img), null, RID);
    const port = await attach(B);
    let err = null;
    try { await engine.upload(RID, d.tab); } catch (e) { err = e; }
    record(S, 'grabar una imagen corta se rechaza sin enviar ni un byte', !!err && /incompleta/.test(err.message) && port.writes === 0 && B.writes.toJs().length === 0 && port.opens === 0, `${err ? err.message.slice(0, 90) : 'no falló'}; bytes escritos ${port.writes}, aperturas ${port.opens}`);
  } catch (e) { record(S, 'grabar imagen corta', false, e.message); }
}
