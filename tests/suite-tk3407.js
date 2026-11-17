// Kenwood TK-3407 (clon, familia Retevis RT22 con saludo "PROGRAM"): solo lectura, saludo tolerante al ruido,
// salida 'E' siempre y aviso desde el driver Kenwood TK-2402/3402.
import { engine, record, fetchImg, makeEmu, attach, eq, withTimeout } from './harness.js';

export const SUITE = 'tk3407';
const S = SUITE;
const RID = 'Kenwood_TK-3407_clon';
const RID_C1 = 'LUITON_LT-316';
const RID_TK = 'Kenwood_TK-2402';

export async function run() {
  const img = await fetchImg('Retevis_RT22.img');
  const py = engine.py;
  const tabCount = () => py.runPython('import webchirp; len(webchirp._radios)');

  // 1) aparece en el selector de marca Kenwood y en el buscador
  const r = engine.radios.find((x) => x.id === RID);
  record(S, 'el modelo "TK-3407 (clon)" está en la lista de Kenwood con su módulo', !!r && r.vendor === 'Kenwood' && r.model === 'TK-3407 (clon)' && r.modules.includes('kenwood_tk3407_clone'), JSON.stringify(r));
  const idx = (await (await fetch(new URL('../models.json', import.meta.url))).json()).radios.find((x) => x.id === RID);
  record(S, 'models.json trae el modelo (carga perezosa)', !!idx && idx.modules[0] === 'kenwood_tk3407_clone' && idx.vendor === 'Kenwood', JSON.stringify(idx));

  // 2) lectura completa
  let tab = null;
  try {
    const E = makeEmu('tk3407', img);
    const port = await attach(E);
    const before = tabCount();
    engine.logLines.length = 0;
    const d = await withTimeout(engine.download(RID), 60000, 'lectura tk3407');
    tab = d.tab;
    const saved = (await engine.saveFile()).bytes;
    const L = engine.logLines.join('\n');
    record(S, 'lectura: imagen idéntica a la memoria del emulador y crea pestaña', eq(saved.slice(0, 0x400), E.memory_js()) && tabCount() === before + 1 && d.model === 'TK-3407 (clon)' && d.vendor === 'Kenwood', `${d.vendor} ${d.model}, ${saved.length} bytes, pestañas ${before}->${tabCount()}`);
    record(S, 'la lectura manda la salida E y cierra el puerto', E.exits === 1 && port.state === 'closed', `E recibidas: ${E.exits}`);
    record(S, 'el registro trae el saludo y la identidad en hex y ASCII', /Saludo, intento 1 de 3: recibido 06/.test(L) && /Identidad: hex 50 33 32 30 37 33 F8 FF \| ASCII 'P32073\.\.'/.test(L), (L.match(/Identidad:.*/) || ['sin traza'])[0]);
  } catch (e) { record(S, 'lectura completa', false, e.stack || e.message); }

  // 3) con ruido 1C y byte basura antes del 06
  try {
    const E = makeEmu('tk3407_noise', img);
    await attach(E);
    engine.logLines.length = 0;
    const d = await withTimeout(engine.download(RID), 60000, 'lectura con ruido');
    const saved = (await engine.saveFile()).bytes;
    const L = engine.logLines.join('\n');
    record(S, 'con ruido 1C y byte basura (F0) antes del 06: también lee todo', eq(saved.slice(0, 0x400), E.memory_js()) && d.model === 'TK-3407 (clon)', `${d.model}`);
    record(S, 'el registro anota en hex lo descartado', /descartado F0 1C/.test(L), (L.match(/Saludo, intento.*/) || ['sin traza'])[0]);
  } catch (e) { record(S, 'lectura con ruido', false, e.stack || e.message); }

  // 4) el driver C1 (PROGRGS) sobre esta variante falla sin colgarse
  for (const kind of ['tk3407', 'tk3407_noise']) {
    try {
      const E = makeEmu(kind, img);
      const port = await attach(E);
      const before = tabCount();
      let err = null;
      const t0 = performance.now();
      try { await withTimeout(engine.download(RID_C1), 90000, 'driver C1'); } catch (e) { err = e; }
      record(S, `el driver C1 sobre la variante ${kind} falla sin colgarse y sin pestaña`, !!err && !/TIMEOUT/.test(err.message) && tabCount() === before && port.state === 'closed', `${err ? err.message.slice(0, 70) : 'no falló'} (${Math.round(performance.now() - t0)} ms)`);
    } catch (e) { record(S, `driver C1 sobre ${kind}`, false, e.message); }
  }

  // 5) grabar: mismo respaldo, primer bloque sin 06 e imagen inválida
  try {
    if (tab === null) throw new Error('no hay pestaña de la lectura');
    const E = makeEmu('tk3407', img);
    const before = E.memory_js();
    const port = await attach(E);
    const r = await withTimeout(engine.upload(RID, tab), 120000, 'grabar tk3407');
    record(S, 'grabar el mismo respaldo: memoria idéntica, verificación correcta y se manda E', eq(E.memory_js(), before) && E.writes.toJs().length > 0 && /ok|Quedó/i.test(JSON.stringify(r.verify || r)) && E.exits >= 1, `bloques ${E.writes.toJs().length}; ${JSON.stringify(r.verify || r).slice(0, 80)}`);
  } catch (e) { record(S, 'grabar el mismo respaldo', false, e.stack || e.message); }

  for (const kind of ['tk3407_dead0', 'tk3407_dead0_needs07']) {
    try {
      const E = makeEmu(kind, img);
      const port = await attach(E);
      let err = null;
      try { await withTimeout(engine.upload(RID, tab), 120000, 'primer bloque'); } catch (e) { err = e; }
      const hits = E.dead_hits.toJs();
      record(S, `primer bloque sin 06 (${kind}): error y no se escribe más allá del primer bloque`, !!err && /no aceptó la grabación/.test(err.message) && E.writes.toJs().length === 0 && hits.every((x) => x === 0) && E.exits >= 1, `${err ? err.message.slice(0, 80) : 'no falló'}; intentos ${hits.length}`);
    } catch (e) { record(S, `primer bloque sin 06 ${kind}`, false, e.stack || e.message); }
  }

  try {
    const E = makeEmu('tk3407', img);
    const port = await attach(E);
    const saved = (await engine.saveFile(tab)).bytes;
    saved[0x1B8] = 0x58;
    const tab2 = (await engine.openFile(new File([saved], 'otra.img'))).tab;
    let err = null;
    try { await engine.upload(RID, tab2); } catch (e) { err = e; }
    record(S, 'imagen con otra identidad: error, 0 bytes y 0 aperturas de puerto', !!err && /no es de un radio P3207x/.test(err.message) && port.writes === 0 && port.opens === 0, `${err ? err.message.slice(0, 90) : 'no falló'}; bytes ${port.writes}, aperturas ${port.opens}`);
  } catch (e) { record(S, 'imagen inválida', false, e.stack || e.message); }

  // 6) el driver Kenwood TK-2402 sobre este radio: manda E y explica
  try {
    const E = makeEmu('tk3407', img);
    const port = await attach(E);
    const before = tabCount();
    let err = null;
    try { await withTimeout(engine.download(RID_TK), 90000, 'driver TK-2402'); } catch (e) { err = e; }
    record(S, 'driver Kenwood TK-2402 sobre el clon: manda E y da el aviso', !!err && /Este radio no es un Kenwood original: responde como la familia Retevis RT22\. Elija Kenwood → TK-3407 \(clon\) y vuelva a leer\./.test(err.message) && E.exits >= 1 && tabCount() === before && port.state === 'closed', `${err ? err.message.slice(0, 100) : 'no falló'}; E recibidas ${E.exits}`);
  } catch (e) { record(S, 'driver TK-2402 sobre el clon', false, e.stack || e.message); }

  // 7) identidad rara tras el 06: error claro en español y salida E
  try {
    const E = makeEmu('tk3407_badident', img);
    await attach(E);
    let err = null;
    try { await engine.download(RID); } catch (e) { err = e; }
    record(S, 'identidad incorrecta tras el 06: error con el paso y lo recibido, y se manda E', !!err && /Falló el paso 02 \(identidad\).*00 00 00 00 00 00 00 00/.test(err.message) && E.exits === 1, `${err ? err.message.slice(0, 120) : 'no falló'}; E recibidas ${E.exits}`);
  } catch (e) { record(S, 'identidad incorrecta', false, e.stack || e.message); }

  // 8) la lectura se corta a mitad: error, sin pestaña y E enviada
  try {
    const E = makeEmu('tk3407_failmid', img);
    await attach(E);
    const before = tabCount();
    let err = null;
    try { await withTimeout(engine.download(RID), 90000, 'lectura cortada'); } catch (e) { err = e; }
    record(S, 'lectura cortada a mitad: error, sin pestaña y se manda E', !!err && tabCount() === before && E.exits >= 1, `${err ? err.message.slice(0, 100) : 'no falló'}; E recibidas ${E.exits}`);
  } catch (e) { record(S, 'lectura cortada', false, e.stack || e.message); }

  await runVariants();
}

// ---- variantes del paso 07 y del tamaño de bloque (radio real: no contesta 07)
export async function runVariants() {
  const img = await fetchImg('Retevis_RT22.img');
  const readWith = async (kind, name) => {
    const E = makeEmu(kind, img);
    const port = await attach(E);
    engine.logLines.length = 0;
    const d = await withTimeout(engine.download(RID), 90000, name);
    const saved = (await engine.saveFile()).bytes;
    return { E, port, d, saved, L: engine.logLines.join('\n') };
  };

  try {
    const { E, saved, L } = await readWith('tk3407', 'sin 07');
    record(S, 'radio sin 07 (real): lee completo sin mandar 07, una sola sesión', eq(saved.slice(0, 0x400), E.memory_js()) && saved.length >= 0x400 && E.exits === 1 && !/Paso 07/.test(L), `E ${E.exits}`);
    record(S, 'el registro anota el comando R del primer bloque y los bytes recibidos', /Primer bloque: enviado 52 00 00 40, recibidos 68 bytes: 57 00 00 40/.test(L) && /Antes de leer el primer bloque: descartado/.test(L), (L.match(/Primer bloque.*/) || ['sin traza'])[0]);
  } catch (e) { record(S, 'radio sin 07', false, e.stack || e.message); }

  for (const [kind, label, reply] of [['tk3407_needs07', 'necesita 07 y calla', 'nada'], ['tk3407_n', "necesita 07 y contesta 'N'", '4E']]) {
    try {
      const { E, saved, L } = await readWith(kind, kind);
      record(S, `variante que ${label}: lee completo tras el reintento con 07`, eq(saved.slice(0, 0x400), E.memory_js()) && E.exits === 2 && new RegExp('Paso 07: enviado 07, recibido ' + reply, 'i').test(L) && /variante sin 07/.test(L), `E ${E.exits}; ${(L.match(/Paso 07.*/) || ['sin traza'])[0]}`);
    } catch (e) { record(S, `variante ${kind}`, false, e.stack || e.message); }
  }

  try {
    const { E, saved, L } = await readWith('tk3407_b32', 'bloque 32');
    record(S, 'clon de bloques de 0x20: reintenta con 32 bytes y la imagen queda completa', eq(saved.slice(0, 0x400), E.memory_js()) && saved.length >= 0x400 && /bloque corto/.test(L) && /bloques de 0x20/.test(L), (L.match(/Cabecera correcta.*/) || ['sin traza'])[0]);
  } catch (e) { record(S, 'bloques de 0x20', false, e.stack || e.message); }

  // el radio no entrega el primer bloque con ninguna variante: error claro con el hex
  try {
    const E = makeEmu('tk3407_failmid', img);
    E.fail_after = 0;
    await attach(E);
    let err = null;
    try { await withTimeout(engine.download(RID), 90000, 'sin primer bloque'); } catch (e) { err = e; }
    record(S, 'sin primer bloque en ninguna variante: error en español con las variantes y el hex', !!err && /Se probaron dos variantes/.test(err.message) && /variante sin 07/.test(err.message) && /variante con 07/.test(err.message) && E.exits >= 2, `${err ? err.message.slice(0, 160) : 'no falló'}`);
  } catch (e) { record(S, 'sin primer bloque', false, e.stack || e.message); }
}
