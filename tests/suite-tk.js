// Kenwood TK-2402 / TK-3402 (driver propio de WebCHIRP, fase 1 = solo lectura) contra un emulador del protocolo.
import { engine, record, makeEmu, attach, eq, hex } from './harness.js';

export const SUITE = 'kenwood-tk';
const S = SUITE;
const RID2 = 'Kenwood_TK-2402';
const RID3 = 'Kenwood_TK-3402';

export async function run() {
  const have = (m) => engine.entries.some((r) => r.vendor === 'Kenwood' && r.model === m);
  record(S, 'los modelos Kenwood TK-2402 y TK-3402 están en la lista', have('TK-2402') && have('TK-3402'),
    `entradas: ${engine.entries.filter((r) => /TK-[23]402/.test(r.model)).map((r) => `${r.id} (${r.modules})`).join(', ')}`);

  // lectura completa del TK-2402 emulado
  const emu = makeEmu('tk2402');
  const port = await attach(emu);
  let d;
  try { d = await engine.download(RID2); } catch (e) { record(S, 'lectura del TK-2402', false, e.message); return; }
  const mem = emu.memory_js();
  const img = (await engine.saveFile()).bytes;
  record(S, 'TK-2402: lectura completa, el .img es un respaldo de TODA la EEPROM (0x0000-0x1FFF)', eq(img.slice(0, 0x2000), mem), `${d.vendor} ${d.model}, ${emu.reads.toJs().length} bloques leídos`);
  record(S, 'protocolo: 9600 -> 19200 baudios con puerto reabierto, y cerrado al terminar', port.baudHistory.includes(19200) && port.baudHistory[0] === 9600 && port.state === 'closed', `baudios: ${port.baudHistory.join(',')}`);
  record(S, 'TK-2402: no se escribió nada en el radio', emu.writes.toJs().length === 0);
  const L = engine.logLines.join('\n');
  record(S, 'la identidad del radio queda en el registro', /Identidad del radio \(40 bytes\)/.test(L) && /KENWOOD|4B 45 4E 57/i.test(L), (L.match(/Identidad del radio.*/) || ['no hay'])[0].slice(0, 120));

  const ms = await engine.memories(0);
  const by = (n) => ms.find((m) => m.number === n);
  const c1 = by(1), c2 = by(2), c3 = by(3), c4 = by(4), c16 = by(16), c5 = by(5);
  record(S, 'canal 1: 146.520 simplex, FM ancho, potencia alta, scan', c1.freq === '146.520000' && c1.duplex === '' && c1.mode === 'FM' && c1.power === 'High' && c1.skip === '' && c1.tmode === '', JSON.stringify([c1.freq, c1.duplex, c1.mode, c1.power, c1.skip, c1.tmode]));
  record(S, 'canal 2: 146.5125 (paso de 12,5 kHz), tono TX 88.5, estrecho, baja', c2.freq === '146.512500' && c2.tmode === 'Tone' && c2.rtone === 88.5 && c2.mode === 'NFM' && c2.power === 'Low', JSON.stringify([c2.freq, c2.tmode, c2.rtone, c2.mode, c2.power]));
  record(S, 'canal 3: repetidor (TX 147.600), TSQL 110.9, fuera del scan', c3.freq === '147.000000' && c3.duplex === 'split' && c3.offset === '147.600000' && c3.tmode === 'TSQL' && c3.ctone === 110.9 && c3.skip === 'S', JSON.stringify([c3.freq, c3.duplex, c3.offset, c3.tmode, c3.ctone, c3.skip]));
  record(S, 'canal 4: tonos cruzados (TX 100.0 / RX 67.0)', c4.tmode === 'Cross' && c4.rtone === 100 && c4.ctone === 67, JSON.stringify([c4.tmode, c4.rtone, c4.ctone]));
  record(S, 'canal 16 (último) y canales vacíos', c16.freq === '173.975000' && c5.empty === true, `${c16.freq}; canal 5 vacío=${c5.empty}`);
  const st = await engine.settings();
  record(S, 'ajustes de solo lectura: modelo leído del radio', JSON.stringify(st).includes('P2402'), JSON.stringify(st).slice(0, 140));

  // grabar: bloqueado con mensaje claro (fase 1)
  try {
    await attach(makeEmu('tk2402'));
    let err = null;
    try { await engine.upload(RID2); } catch (e) { err = e; }
    record(S, 'grabar está bloqueado con un mensaje claro', !!err && /Grabación aún no disponible para este modelo/.test(err.message), err ? err.message.slice(0, 100) : 'no falló');
  } catch (e) { record(S, 'grabar bloqueado', false, e.message); }

  // TK-3402 (UHF)
  try {
    await attach(makeEmu('tk3402'));
    const d3 = await engine.download(RID3);
    const m3 = await engine.memories(0);
    const f3 = await engine.features(0);
    record(S, 'TK-3402 (UHF 400-520): lectura y canales', d3.model === 'TK-3402' && m3.find((m) => m.number === 1).freq === '462.562500' && f3.valid_bands[0][0] === 400000000, `${d3.model}, canal 1 ${m3[0].freq}, banda ${f3.valid_bands[0]}`);
  } catch (e) { record(S, 'TK-3402', false, e.message); }

  // modelo equivocado: elegiste TK-2402 pero el radio dice P3402
  try {
    await attach(makeEmu('tk_wrongmodel'));
    let err = null;
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, 'si el radio dice ser otro modelo (P3402) se rechaza', !!err && /dice ser P3402/.test(err.message), err ? err.message.slice(0, 100) : 'no falló');
  } catch (e) { record(S, 'modelo equivocado', false, e.message); }

  // bloques ilegibles no críticos: se sigue y se informa; un bloque de canales ilegible: error
  try {
    const eb = makeEmu('tk2402_bad');
    await attach(eb);
    const db = await engine.download(RID2);
    const Lb = engine.logLines.join('\n');
    record(S, 'dos bloques no críticos sin respuesta: la lectura sigue y lo registra', db.model === 'TK-2402' && /Bloque 0x0800 no se pudo leer/.test(Lb), (Lb.match(/Bloque 0x0800.*/) || ['no hay'])[0].slice(0, 100));
    await attach(makeEmu('tk2402_nochan'));
    let err = null;
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, 'un bloque de canales ilegible: error claro (no se entrega una lectura a medias)', !!err && /zona de canales/.test(err.message), err ? err.message.slice(0, 100) : 'no falló');
  } catch (e) { record(S, 'bloques ilegibles', false, e.message); }

  // fallas: mudo, basura, desconexión a mitad, cancelar; y que se pueda reintentar
  for (const [name, faults] of [['radio mudo', { mute: true }], ['respuestas basura', { garbage: true }], ['respuesta corta', { short: true }]]) {
    const p = await attach(makeEmu('tk2402'), faults);
    let err = null;
    const t0 = performance.now();
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, `falla: ${name} termina en error y el puerto queda cerrado`, !!err && p.state === 'closed', `${err ? err.message.slice(0, 70) : 'sin error'} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  try {
    const p = await attach(makeEmu('tk2402'), { disconnectAtWrite: 120 });
    let err = null;
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, 'falla: desconexión a mitad de la lectura', !!err && p.state === 'closed', err ? err.message.slice(0, 80) : 'sin error');
    const p2 = await attach(makeEmu('tk2402'));
    const again = await engine.download(RID2);
    record(S, 'tras las fallas se puede volver a leer sin recargar', again.model === 'TK-2402' && p2.state === 'closed');
  } catch (e) { record(S, 'desconexión y reintento', false, e.message); }

  // edición local de un canal (para copiar canales) y relectura
  try {
    await attach(makeEmu('tk3402'));
    const d3 = await engine.download(RID3);
    const m = (await engine.memories(0)).find((x) => x.number === 3);
    await engine.setMemory(0, { ...m, number: 3, freq: '462.612500', duplex: '', offset: '0.000000', tmode: 'Tone', rtone: 100.0, mode: 'FM', power: 'High', skip: '' });
    const back = (await engine.memories(0)).find((x) => x.number === 3);
    record(S, 'editar un canal en la imagen (para copiar canales) y volver a leerlo', back.freq === '462.612500' && back.tmode === 'Tone' && back.rtone === 100 && back.power === 'High', JSON.stringify([back.freq, back.tmode, back.rtone, back.power]));
  } catch (e) { record(S, 'edición local', false, e.stack || e.message); }

  // ---------- cable de un solo hilo (eco) ----------
  const emuFull = (kind) => makeEmu(kind);
  try {
    // el TX 0xFE era el 'E' de fin de sesión enviado aunque el saludo falló: ya no se envía
    engine.logLines.length = 0;
    await attach(emuFull('tk2402'), { garbage: true });
    try { await engine.download(RID2); } catch (e) { /* esperado */ }
    const Lg = engine.logLines.join('\n');
    record(S, 'si el saludo falla NO se envía el byte de fin de sesión (el "TX FE" de la traza real)', !/TX 1: FE/.test(Lg), (Lg.match(/TX 1: FE.*/) || ['sin TX FE'])[0]);
  } catch (e) { record(S, 'sin TX FE tras saludo fallido', false, e.message); }

  for (const [label, faults, kind] of [
    ['con eco (cable de un solo hilo)', { echo: true }, 'tk2402'],
    ['con eco troceado byte a byte', { echo: true, echoChunked: true }, 'tk2402'],
    ['TK-3402 con eco', { echo: true }, 'tk3402'],
  ]) {
    try {
      engine.logLines.length = 0;
      const e = emuFull(kind);
      const p = await attach(e, faults);
      const rid = kind === 'tk3402' ? RID3 : RID2;
      const dd = await engine.download(rid);
      const img2 = (await engine.saveFile()).bytes;
      const Le = engine.logLines.join('\n');
      record(S, `lectura completa ${label}`, dd.model.startsWith('TK-') && eq(img2.slice(0, 0x2000), e.memory_js()) && /Modo eco: sí/.test(Le) && p.state === 'closed',
        `${dd.model}; ${(Le.match(/Modo eco: \w+/) || ['sin traza de eco'])[0]}; ${img2.length} bytes`);
    } catch (e2) { record(S, `lectura completa ${label}`, false, e2.message); }
  }
  try {
    engine.logLines.length = 0;
    await attach(emuFull('tk2402'), {});
    await engine.download(RID2);
    record(S, 'sin eco la traza dice "Modo eco: no"', /Modo eco: no/.test(engine.logLines.join('\n')));
  } catch (e) { record(S, 'traza sin eco', false, e.message); }
  // la respuesta 0x16 pegada justo detrás del eco: lo cubre el eco troceado/agrupado de arriba; eco corrupto -> error claro
  try {
    await attach(emuFull('tk2402'), { echo: true, echoCorruptFrom: 40 });
    let err = null;
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, 'eco siempre corrupto (cable dañado): error claro "Eco del cable no coincide" tras reintentar', !!err && /Eco del cable no coincide/.test(err.message), err ? err.message.slice(0, 120) : 'no falló');
    const p = await attach(emuFull('tk2402'), { echo: true, mute: true });
    let err2 = null;
    try { await engine.download(RID2); } catch (e) { err2 = e; }
    record(S, 'eco con radio mudo: "No response" y puerto cerrado', !!err2 && p.state === 'closed', err2 ? err2.message.slice(0, 80) : 'no falló');
    const p3 = await attach(emuFull('tk2402'), { echo: true, disconnectAtWrite: 150 });
    let err3 = null;
    try { await engine.download(RID2); } catch (e) { err3 = e; }
    record(S, 'eco con desconexión a mitad: error y puerto cerrado', !!err3 && p3.state === 'closed', err3 ? err3.message.slice(0, 80) : 'no falló');
    await attach(emuFull('tk2402'), { echo: true });
    const ok = await engine.download(RID2);
    record(S, 'tras las fallas con eco se puede volver a leer', ok.model === 'TK-2402');
  } catch (e) { record(S, 'fallas con eco', false, e.message); }

  // ---------- hipótesis del TK-3402: 0x06 directo, eco parcial, bytes completos en el error ----------
  try {
    engine.logLines.length = 0;
    const e = makeEmu('tk3402_direct06');
    const p = await attach(e, { echo: true });
    const dd = await engine.download(RID3);
    const Ld = engine.logLines.join('\n');
    record(S, 'TK-3402 que contesta 0x06 directo (sin 0x16): se sigue a 9600 y se lee todo', dd.model === 'TK-3402' && eq((await engine.saveFile()).bytes.slice(0, 0x2000), e.memory_js()) && !p.baudHistory.includes(19200),
      `${(Ld.match(/Camino del saludo.*/) || ['sin traza'])[0]}; baudios: ${p.baudHistory.join(',')}`);
    record(S, 'la traza registra el camino tomado (0x06 directo) y el modo eco', /Camino del saludo: 0x06 directo/.test(Ld) && /Modo eco: sí/.test(Ld));
    engine.logLines.length = 0;
    await attach(makeEmu('tk2402'), {});
    await engine.download(RID2);
    record(S, 'el TK-2402 sigue por el camino 0x16 -> 19200', /Camino del saludo: 0x16 -> cambio a 19200/.test(engine.logLines.join('\n')));
  } catch (e) { record(S, 'camino 0x06 directo', false, e.stack || e.message); }
  try {
    engine.logLines.length = 0;
    const e = makeEmu('tk2402');
    await attach(e, { echo: true, echoDropFirst: 3 });
    const dd = await engine.download(RID2);
    const Lp = engine.logLines.join('\n');
    record(S, 'eco parcial (ya se había vaciado el principio): se detecta y la lectura sale bien', dd.model === 'TK-2402' && /Modo eco: sí \(\d de 7 bytes/.test(Lp), (Lp.match(/Modo eco.*/) || ['sin traza'])[0]);
  } catch (e) { record(S, 'eco parcial', false, e.message); }
  try {
    // un radio que responde otra cosa: el error muestra los bytes completos recibidos
    class Dummy {}
    await attach(makeEmu('tk_badack'), {});
    let err = null;
    try { await engine.download(RID2); } catch (e) { err = e; }
    record(S, 'el error del saludo muestra todos los bytes recibidos (hasta 20)', !!err && /Bytes recibidos tras PROGRAM: 99 42/.test(err.message), err ? err.message.slice(0, 160) : 'no falló');
  } catch (e) { record(S, 'bytes completos en el error', false, e.message); }

  // ---------- matriz: TK-2402 y TK-3402, con y sin eco, camino 0x16 y 0x06 directo ----------
  for (const [label, kind, rid, faults] of [
    ['TK-2402 sin eco', 'tk2402', RID2, {}],
    ['TK-2402 con eco', 'tk2402', RID2, { echo: true }],
    ['TK-3402 sin eco (0x16)', 'tk3402', RID3, {}],
    ['TK-3402 con eco (0x16)', 'tk3402', RID3, { echo: true }],
    ['TK-3402 sin eco (0x06 directo)', 'tk3402_direct06', RID3, {}],
    ['TK-3402 con eco (0x06 directo)', 'tk3402_direct06', RID3, { echo: true }],
  ]) {
    try {
      const e = makeEmu(kind);
      await attach(e, faults);
      const dd = await engine.download(rid);
      const ok = eq((await engine.saveFile()).bytes.slice(0, 0x2000), e.memory_js());
      const f = await engine.features(0);
      const band = rid === RID2 ? f.valid_bands[0][0] === 136000000 && f.valid_bands[0][1] === 174000000 : f.valid_bands[0][0] === 400000000 && f.valid_bands[0][1] === 520000000;
      record(S, `matriz: ${label}: lectura completa, banda y modelo correctos`, ok && band && dd.model === (rid === RID2 ? 'TK-2402' : 'TK-3402'), `${dd.model}, banda ${f.valid_bands[0]}`);
    } catch (e2) { record(S, `matriz: ${label}`, false, e2.message); }
  }
  // cada modelo rechaza frecuencias fuera de su banda
  try {
    await attach(makeEmu('tk2402'));
    await engine.download(RID2);
    const m = (await engine.memories(0))[0];
    let err = null;
    try { await engine.setMemory(0, { ...m, freq: '462.5625' }); } catch (e) { err = e; }
    record(S, 'TK-2402 (VHF) rechaza 462.5625 MHz fuera de su banda 136-174', !!err, err ? err.message.slice(0, 80) : 'lo aceptó');
    await attach(makeEmu('tk3402'));
    await engine.download(RID3);
    const m3 = (await engine.memories(0))[0];
    let err3 = null;
    try { await engine.setMemory(0, { ...m3, freq: '146.520' }); } catch (e) { err3 = e; }
    record(S, 'TK-3402 (UHF) rechaza 146.520 MHz fuera de su banda 400-520', !!err3, err3 ? err3.message.slice(0, 80) : 'lo aceptó');
  } catch (e) { record(S, 'validación de banda', false, e.message); }

  // ---------- colisión en el hilo compartido (traza real del TK-3402) ----------
  for (const [label, kind, rid] of [['respuesta 0x06 (TK-3402 real)', 'tk3402_direct06', RID3], ['respuesta 0x16 (TK-2402)', 'tk2402', RID2]]) {
    try {
      engine.logLines.length = 0;
      const e = makeEmu(kind);
      await attach(e, { echo: true, collision: true });
      const dd = await engine.download(rid);
      const okc = eq((await engine.saveFile()).bytes.slice(0, 0x2000), e.memory_js());
      record(S, `colisión (eco cortado, 'R' alterada con bit 7, y ${label} durante PROGRAM): la lectura completa sale bien`, okc && !!dd.model, `${dd.model}; ${(engine.logLines.join('\n').match(/Recibido durante el saludo.*/) || ['sin traza'])[0].slice(0, 100)}`);
    } catch (e2) { record(S, `colisión con ${label}`, false, e2.message); }
  }
  try {
    engine.py.runPython("import drivers_extra.kenwood_tk2402 as k; k.GREETING_BYTEWISE = False");
    await attach(makeEmu('tk3402_direct06'), { echo: true, collision: true });
    let err = null;
    try { await engine.download(RID3); } catch (e) { err = e; }
    record(S, 'contraste: con el saludo anterior (todo de una vez) la colisión falla', !!err, err ? err.message.slice(0, 110) : 'no falló');
  } catch (e) { record(S, 'contraste colisión', false, e.message); }
  finally { engine.py.runPython("import drivers_extra.kenwood_tk2402 as k; k.GREETING_BYTEWISE = True"); }
  // el eco que falla DESPUÉS del saludo se reintenta una vez por bloque
  try {
    engine.logLines.length = 0;
    const e = makeEmu('tk2402');
    await attach(e, { echo: true, echoCorruptAt: 60 });
    const dd = await engine.download(RID2);
    const Lr = engine.logLines.join('\n');
    record(S, 'un eco corrupto en un comando de lectura se reintenta una vez y la lectura sale bien', dd.model === 'TK-2402' && /se reintenta una vez/.test(Lr), (Lr.match(/Bloque 0x\w+: Eco.*/) || ['sin reintento'])[0].slice(0, 100));
  } catch (e) { record(S, 'reintento del bloque', false, e.message); }

  // ---------- TK-3402 real: la identidad empieza con 'P' y el eco del 0x02 se pierde o llega tarde ----------
  for (const [label, faults, rx] of [
    ["identidad que empieza con 'P' y eco del 0x02 perdido", { echo: true, echoLost02: true }, /se esperaba el eco 02 y llegó 50/],
    ["eco tardío de la 'P' de PROGRAM seguido del eco 02 y la identidad", { echo: true, lateEchoP: true }, /eco tardío de PROGRAM/],
  ]) {
    try {
      engine.logLines.length = 0;
      const e = makeEmu('tk3402_pident');
      await attach(e, faults);
      const dd = await engine.download(RID3);
      const okm = eq((await engine.saveFile()).bytes.slice(0, 0x2000), e.memory_js());
      const Li = engine.logLines.join('\n');
      const idLine = (Li.match(/Identidad del radio.*/) || [''])[0];
      record(S, `TK-3402: ${label}: lectura completa`, okm && dd.model === 'TK-3402' && rx.test(Li) && /Identidad del radio \(40 bytes\): hex 50 33 34 30 32/.test(Li),
        `${dd.model}; ${idLine.slice(0, 90)}`);
    } catch (e2) { record(S, `TK-3402: ${label}`, false, e2.stack || e2.message); }
  }
}
