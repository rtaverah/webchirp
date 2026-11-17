// Basura al abrir, ACK viejo y reinicio del radio tras grabar (traza real de un BF-888 con cable CH340).
import { engine, record, fetchImg, makeEmu, attach, radioId, eq } from './harness.js';

export const SUITE = 'asentar';
const S = SUITE;
const scr = (img) => { const b = img.slice(); for (let i = 0x10; i < 0x110; i++) b[i] = (i * 13 + 5) & 0xff; return b; };
const setPy = (code) => engine.py.runPython(`import webchirp\n${code}`);

async function tryDownload(rid) {
  try { return { d: await engine.download(rid) }; } catch (e) { return { err: e }; }
}

export async function run() {
  const bf = await fetchImg('Baofeng_BF-888.img');
  const rt = await fetchImg('Retevis_RT22.img');
  const ridBF = radioId('Baofeng', 'BF-888');

  // (a) basura 00 y 46 al abrir, antes de que el driver escriba
  for (const [name, mk, rid] of [['BF-888', () => makeEmu('bf888', bf), ridBF], ['RT22 (LT-316)', () => makeEmu('rt22', rt, null, 'LUITON_LT-316'), 'LUITON_LT-316']]) {
    engine.logLines.length = 0;
    await attach(mk(), { junkOnOpen: [0x00, 0x46] });
    const r = await tryDownload(rid);
    const L = engine.logLines.join('\n');
    record(S, `(a) ${name}: basura 00 46 al abrir, la lectura sale bien`, !!r.d && !r.err, r.err ? r.err.message : `${r.d.vendor} ${r.d.model}`);
    record(S, `(a) ${name}: el registro dice "Descartados 2 bytes al abrir: 00 46"`, /Descartados 2 bytes al abrir: 00 46/.test(L), (L.match(/Descartados.*/) || ['no hay'])[0]);
  }
  // (b) un ACK 06 viejo en el búfer debe descartarse
  {
    await attach(makeEmu('bf888', bf), { junkOnOpen: [0x06] });
    const r = await tryDownload(ridBF);
    record(S, '(b) un 06 viejo en el búfer se descarta y la lectura sale bien', !!r.d, r.err ? r.err.message : '');
    await attach(makeEmu('rt22', rt, null, 'LUITON_LT-316'), { junkOnOpen: [0x06, 0x06, 0x50] });
    const r2 = await tryDownload('LUITON_LT-316');
    record(S, '(b) lo mismo con RT22 y varios bytes viejos', !!r2.d, r2.err ? r2.err.message : '');
  }
  // (d) contraste: sin vaciar el búfer, (a) y (b) fallan
  try {
    setPy('webchirp.OPEN_DRAIN = False');
    await attach(makeEmu('bf888', bf), { junkOnOpen: [0x00, 0x46] });
    const r = await tryDownload(ridBF);
    record(S, '(d) contraste: sin vaciar el búfer la basura al abrir rompe la lectura', !!r.err, r.err ? r.err.message.slice(0, 90) : 'no falló');
    await attach(makeEmu('bf888', bf), { junkOnOpen: [0x06] });
    const r2 = await tryDownload(ridBF);
    record(S, '(d) contraste: sin vaciar, un 06 viejo se toma como ACK y falla', !!r2.err, r2.err ? r2.err.message.slice(0, 90) : 'no falló');
  } finally { setPy('webchirp.OPEN_DRAIN = True'); }

  // (c) el radio se reinicia tras 'E' y no responde (o responde basura) durante unos segundos
  for (const [mode, secs, label] of [['mute', 6, 'mudo 6 s'], ['garbage', 6, 'basura 6 s']]) {
    try {
      const emuB = makeEmu('bf888', scr(bf));
      emuB.reboot_secs = secs; emuB.reboot_mode = mode;
      await attach(emuB);
      const tab = (await engine.openFile(new File([bf], 'x.img'))).tab;   // sin leer el radio: el reinicio empieza al terminar de grabar
      const t0 = performance.now();
      const up = await engine.upload(ridBF, tab);
      record(S, `(c) el BF-888 se reinicia (${label}) tras 'E': la comprobación pasa con espera y reintentos`, up.verify.status === 'ok', `${up.verify.status} tras ${up.verify.attempts} intento(s), ${((performance.now() - t0) / 1000).toFixed(1)} s${up.verify.error ? ' ' + up.verify.error : ''}`);
    } catch (e) { record(S, `(c) reinicio ${label}`, false, e.message); }
  }
  // (c2) reinicio más largo que todos los reintentos: "No se pudo comprobar" + "Comprobar de nuevo" luego funciona
  try {
    const emuB = makeEmu('bf888', scr(bf));
    await attach(emuB);
    const tab = (await engine.openFile(new File([bf], 'y.img'))).tab;
    emuB.reboot_secs = 40; emuB.reboot_mode = 'mute';
    const up = await engine.upload(ridBF, tab);
    record(S, '(c) reinicio de 40 s: se agotan los intentos y se avisa sin decir "verificado"', up.verify.status === 'error' && up.verify.sent_complete === true && up.verify.attempts === 4, `${up.verify.status}, ${up.verify.attempts} intentos: ${String(up.verify.error).slice(0, 60)}`);
    emuB.end_reboot();            // pasa el tiempo: el radio vuelve a responder
    const again = await engine.verifyTab(ridBF, tab);
    record(S, '"Comprobar de nuevo" lee y compara con la pestaña grabada', again.verify.status === 'ok', `${again.verify.status} ${again.verify.error || ''} (${again.verify.matching}/${again.verify.compared})`);
  } catch (e) { record(S, 'reinicio largo + comprobar de nuevo', false, e.message); }

  // (3) lectura normal: si falla el saludo, un reintento automático tras 1 s
  try {
    const emu = makeEmu('bf888', bf);
    const port = await attach(emu, { mute: true });
    setTimeout(() => { port.faults = {}; }, 400);      // el radio "despierta" enseguida
    const t0 = performance.now();
    const r = await tryDownload(ridBF);
    record(S, 'lectura: un fallo en el saludo se reintenta solo tras 1 s y sale bien', !!r.d, `${r.err ? r.err.message.slice(0, 70) : 'ok'} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { record(S, 'reintento de lectura', false, e.message); }

  // (e) la secuencia del usuario SIN apagar el radio: leer A -> grabar en B recién conectado (con basura) -> comprobar -> grabar de nuevo
  const retries = () => engine.logLines.filter((l) => /Falló el saludo|Comprobación: intento/.test(l)).length;
  async function sequence(label) {
    const emuA = makeEmu('bf888', bf); emuA.dirty_mode = true;
    const emuB = makeEmu('bf888', scr(bf)); emuB.dirty_mode = true; emuB.reboot_secs = 2.5;
    engine.logLines.length = 0;
    const out = { ok: true, notes: [] };
    try {
      await attach(emuA, { junkOnOpen: [0x00] });
      emuA.mark_dirty();                                       // el radio A venía de una sesión sin cerrar
      const A = await engine.download(ridBF);
      out.notes.push('lectura A ok');
      await attach(emuB, { junkOnOpen: [0x46] });              // B recién conectado: basura al abrir
      emuB.mark_dirty();
      const up1 = await engine.upload(ridBF, A.tab);
      out.notes.push(`grabar B: ${up1.verify.status}`);
      await new Promise((r) => setTimeout(r, 3000));         // el usuario tarda unos segundos en pulsar de nuevo
      emuB.mark_dirty();
      const up2 = await engine.upload(ridBF, A.tab);            // grabar de nuevo, sin apagar
      out.notes.push(`grabar otra vez: ${up2.verify.status}`);
      out.ok = up1.verify.status === 'ok' && up2.verify.status === 'ok';
    } catch (e) { out.ok = false; out.notes.push('ERROR ' + e.message.slice(0, 80)); }
    out.retries = retries();
    out.lines = engine.logLines.filter((l) => /Falló el saludo|Comprobación: intento/.test(l)).join(' // ').slice(0, 300);
    return out;
  }
  try {
    const r = await sequence('con arreglos');
    record(S, '(e) secuencia del usuario (leer A, grabar B con basura, comprobar, grabar otra vez): todo bien al primer intento', r.ok && r.retries === 0, `${r.notes.join('; ')}; reintentos automáticos: ${r.retries} ${r.lines || ''}`);
    setPy('webchirp.OPEN_DRAIN = False');
    const c = await sequence('sin vaciar');
    record(S, '(e) contraste: con OPEN_DRAIN=False la misma secuencia falla (reproduce el fallo del usuario)', !c.ok, c.notes.join('; '));
  } catch (e) { record(S, '(e) secuencia del usuario', false, e.message); }
  finally { setPy('webchirp.OPEN_DRAIN = True'); }

  // reintento del saludo al grabar solo si todavía no se escribió ningún bloque
  try {
    const emuB = makeEmu('bf888', scr(bf));
    const port = await attach(emuB, { mute: true });
    const tab = (await engine.openFile(new File([bf], 'z.img'))).tab;
    engine.logLines.length = 0;
    setTimeout(() => { port.faults = {}; }, 2500);            // el radio "despierta" tras el primer intento
    const up = await engine.upload(ridBF, tab);
    const nRetry = engine.logLines.filter((l) => /Falló el saludo al grabar/.test(l)).length;
    record(S, 'grabar: si falla el saludo se reintenta solo (cerrar, esperar 1,5 s, reabrir, vaciar) y graba', up.verify.status === 'ok' && nRetry >= 1, `${up.verify.status}, reintentos del saludo: ${nRetry}`);
  } catch (e) { record(S, 'reintento del saludo al grabar', false, e.message); }
  try {
    const emuB = makeEmu('bf888', scr(bf));
    const tab = (await engine.openFile(new File([bf], 'w.img'))).tab;
    await attach(emuB, { disconnectAtWrite: 30 });
    engine.logLines.length = 0;
    let err = null;
    try { await engine.upload(ridBF, tab); } catch (e) { err = e; }
    const nRetry = engine.logLines.filter((l) => /Falló el saludo al grabar/.test(l)).length;
    record(S, 'grabar: si ya se escribieron bloques NO se reintenta', !!err && nRetry === 0, `${err ? err.message.slice(0, 60) : 'sin error'}; reintentos: ${nRetry}`);
  } catch (e) { record(S, 'sin reintento tras escribir', false, e.message); }
}
