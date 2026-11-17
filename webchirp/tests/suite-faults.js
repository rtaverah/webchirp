// Inyección de fallas en TODOS los modelos clonables: radio mudo, basura y respuesta corta,
// al descargar y al grabar. Debe terminar siempre en error, rápido, con el puerto cerrado.
import { engine, record, fetchImg, makeEmu, setBlank, attach, withTimeout, hex } from './harness.js';

export const SUITE = 'fallas-modelos';
const S = SUITE;
const FAULTS = [['mudo', { mute: true }], ['basura', { garbage: true }], ['respuesta corta', { short: true }]];
export const errorKinds = {};
const SKIP = new Set((new URLSearchParams(location.search).get('skip') || '').split(',').filter(Boolean));
const SKIP_WHY = 'el driver original se queda en un bucle sin fin con un radio mudo (ver informe)';

async function attempt(fn, faults) {
  const port = await attach(null, faults);
  const t0 = performance.now();
  let err = null;
  let hung = false;
  const p = fn();
  p.catch(() => {});
  try { await withTimeout(p, 300000, 'operación'); } catch (e) { err = e; }
  if (err && /^TIMEOUT/.test(err.message)) {
    // el driver no termina: se cancela y se espera a que suelte el motor para no contaminar la siguiente prueba
    hung = true;
    engine.cancel();
    try { await withTimeout(p, 120000, 'cancelación'); } catch (e) { /* esperado */ }
    engine.bridge.cancelled = false;
  }
  return { err, port, ms: performance.now() - t0, hung };
}

export async function run() {
  // Con tiempo virtual (--virtual-time-budget) las esperas activas no avanzan el reloj: se usan timers
  engine.py.runPython('import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.0');
  try { await runAll(); } finally { engine.py.runPython('import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.05'); }
}

async function runAll() {
  const only = new URLSearchParams(location.search).get('only');
  const ids = [...new Map(engine.radios.filter((r) => !r.live && !r.alias_of && (!only || r.id.includes(only))).map((r) => [r.id, r])).values()];
  record(S, 'modelos clonables a probar', ids.length > 0, `${ids.length} modelos (de ${engine.radios.length} entradas en la lista)`);
  const baseImg = await fetchImg('Baofeng_UV-5R.img');
  const t00 = performance.now();

  // --- DESCARGA: con una imagen abierta que debe quedar intacta
  await engine.openFile(new File([baseImg], 'base.img'));
  const before = hex((await engine.saveFile()).bytes);
  for (const m of ids) {
    const name = `${m.vendor} ${m.model}${m.variant ? ' ' + m.variant : ''}`;
    fetch('/__result', { method: 'POST', body: JSON.stringify({ type: 'progress', op: 'download', model: name, id: m.id }) });
    if (SKIP.has(m.id)) { record(S, 'descarga: omitido por colgarse', false, 'EXCLUIDO de la ejecución: ' + SKIP_WHY, name, 'omitido'); continue; }
    for (const [fname, faults] of FAULTS) {
      const r = await attempt(() => engine.download(m.id), faults);
      const after = hex((await engine.saveFile()).bytes);
      const problems = [];
      if (r.hung) problems.push('el driver original no termina (colgado >300 s); se canceló');
      if (!r.err) problems.push('terminó sin error');
      if (r.ms >= 60000) problems.push(`tardó ${Math.round(r.ms / 1000)} s (espera paciente del driver original)`);
      if (r.port.state !== 'closed') problems.push('puerto sin cerrar');
      if (after !== before) problems.push('la imagen abierta cambió');
      if (r.err) { const k = String(r.err.message).slice(0, 60); errorKinds[k] = (errorKinds[k] || 0) + 1; }
      record(S, `descarga con radio ${fname}`, problems.length === 0, problems.join('; ') || (r.err.message.slice(0, 90) + ` (${Math.round(r.ms)} ms)`), name);
    }
  }

  // --- GRABACIÓN: con una imagen en blanco del modelo
  for (const m of ids) {
    const name = `${m.vendor} ${m.model}${m.variant ? ' ' + m.variant : ''}`;
    fetch('/__result', { method: 'POST', body: JSON.stringify({ type: 'progress', op: 'upload', model: name, id: m.id }) });
    if (SKIP.has(m.id)) continue;
    let blank = false;
    let blankTab = null;
    try { blank = setBlank(m.id); blankTab = engine.activeTab; } catch (e) { record(S, 'grabación: imagen en blanco', true, 'omitido, no se pudo crear imagen en blanco: ' + String(e.message).split('\n').pop().slice(0, 100), name, 'omitido'); continue; }
    for (const [fname, faults] of FAULTS) {
      const r = await attempt(async () => {
        const res = await engine.upload(m.id);
        if (res.verify.status !== 'ok') throw new Error('verificación: ' + (res.verify.error || res.verify.status));
      }, faults);
      const problems = [];
      if (r.hung) problems.push('el driver original no termina (colgado >300 s); se canceló');
      if (!r.err) problems.push('terminó sin error');
      if (r.ms >= 60000) problems.push(`tardó ${Math.round(r.ms / 1000)} s (espera paciente del driver original)`);
      if (r.port.state !== 'closed') problems.push('puerto sin cerrar (error: ' + (r.err ? r.err.message.slice(0, 120) : 'ninguno') + ')');
      if (r.err) { const k = String(r.err.message).slice(0, 60); errorKinds[k] = (errorKinds[k] || 0) + 1; }
      // ¿falló por culpa de nuestra capa y no del radio? (errores de Python típicos de código, no de CHIRP)
      if (r.err && /AttributeError|NameError|TypeError|KeyError|is not callable|not defined/.test(r.err.message)) problems.push('error de código: ' + r.err.message.slice(0, 80));
      record(S, `grabación con radio ${fname}`, problems.length === 0, problems.join('; ') || (r.err.message.slice(0, 90) + ` (${Math.round(r.ms)} ms)`), name);
    }
    if (blankTab != null) await engine.closeTab(blankTab).catch(() => {});
  }
  // Un driver con espera larga debe poder cancelarse al instante
  try {
    const ft = engine.radios.find((r) => r.id === 'Yaesu_FT-450');
    const port = await attach(null, { mute: true });
    setTimeout(() => engine.cancel(), 3000);
    const t0 = performance.now();
    let err = null;
    try { await withTimeout(engine.download(ft.id), 60000, 'cancelar'); } catch (e) { err = e; }
    const ms = performance.now() - t0;
    record(S, 'cancelar durante una espera larga (Yaesu FT-450)', !!err && ms < 10000 && port.state === 'closed', `${Math.round(ms)} ms, ${err && err.message.slice(0, 80)}`, 'Yaesu FT-450');
  } catch (e) { record(S, 'cancelar espera larga', false, e.message); }
  record(S, 'resumen de tipos de error', true, JSON.stringify(Object.entries(errorKinds).sort((a, b) => b[1] - a[1]).slice(0, 12)));
  record(S, 'duración total', true, `${Math.round((performance.now() - t00) / 1000)} s`);
}
