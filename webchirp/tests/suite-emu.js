// Pruebas funcionales con emuladores: descarga, guardado, clonación A→B, edición y BF-888.
import { engine, record, fetchImg, makeEmu, attach, radioId, eq, hex } from './harness.js';

const S = 'emuladores';

// Radios a probar: emulador, imagen, regiones que el driver lee
const CASES = [
  { name: 'Baofeng UV-5R', kind: 'uv5r', vendor: 'Baofeng', model: 'UV-5R', img: 'Baofeng_UV-5R.img',
    // el .img = ident(8) + memoria 0x0000-0x17FF + 0x1EC0-0x1FFF
    expectImg: (emu) => { const m = emu.memory_js(); const id = emu.ident.toJs ? emu.ident.toJs() : emu.ident;
      const out = new Uint8Array(8 + 0x1800 + 0x140); out.set(id, 0); out.set(m.slice(0, 0x1800), 8); out.set(m.slice(0x1EC0, 0x2000), 8 + 0x1800); return out; },
    scramble: (img) => { const b = img.slice(); for (let i = 8 + 8; i < 8 + 0xCF0; i++) b[i] = (i * 31 + 7) & 0xff; return b; },
    channelFreq: '146.520' },
  { name: 'Baofeng BF-888', kind: 'bf888', vendor: 'Baofeng', model: 'BF-888', img: 'Baofeng_BF-888.img',
    expectImg: (emu) => emu.memory_js().slice(0, 0x3E0),
    scramble: (img) => { const b = img.slice(); for (let i = 0x10; i < 0x110; i++) b[i] = (i * 17 + 3) & 0xff; return b; },
    channelFreq: '146.520' },
];

async function testCase(c) {
  const T = (t, ok, d = '') => record(S, `${c.name}: ${t}`, ok, d, c.name);
  const rid = radioId(c.vendor, c.model);
  const img = await fetchImg(c.img);

  // a) descarga == memoria del emulador
  const emuA = makeEmu(c.kind, img);
  await attach(emuA);
  try {
    await engine.download(rid);
    const saved = (await engine.saveFile()).bytes;
    const want = c.expectImg(emuA);
    T('a) descarga == memoria del emulador', eq(saved.slice(0, want.length), want), `bytes ${want.length}`);
  } catch (e) { T('a) descarga', false, e.message); return; }

  // b) guardar -> abrir -> memorias idénticas
  try {
    const m1 = await engine.memories(0);
    const f1 = await engine.features(0);
    const s = await engine.saveFile();
    await engine.openFile(new File([s.bytes], s.name));
    const m2 = await engine.memories(0);
    const s2 = await engine.saveFile();
    T('b) guardar/abrir: memorias idénticas', JSON.stringify(m1) === JSON.stringify(m2), `${m1.length} canales`);
    const n = c.expectImg(emuA).length;
    const meta = (b) => { try { return atob((() => { const t = new TextDecoder().decode(b.slice(n)); return t.slice(t.indexOf('eyJ')).trim(); })()); } catch (e) { return '?'; } };
    T('b) guardar/abrir/guardar: datos idénticos', eq(s.bytes.slice(0, n), s2.bytes.slice(0, n)), s.name);
    // rclass cambia a "DynamicRadioAlias" al reabrir (comportamiento original de CHIRP); se compara el modelo
    const id = (b) => { const j = JSON.parse(meta(b)); return [j.vendor, j.model, j.variant].join('|'); };
    T('b) guardar/abrir/guardar: metadatos (marca/modelo/variante) idénticos', id(s.bytes) === id(s2.bytes), id(s.bytes));
  } catch (e) { T('b) guardar/abrir', false, e.message); }

  // c) clonación A -> B (B = mismo modelo con otra memoria)
  const imgB = c.scramble(img);
  const emuB = makeEmu(c.kind, imgB);
  const before = hex(emuB.memory_js());
  const memsA = await engine.memories(0);
  await attach(emuB);
  try {
    await engine.upload(rid);
    const a = emuA.memory_js(), b = emuB.memory_js();
    const writes = emuB.writes.toJs();
    let ok = writes.length > 0;
    let bytes = 0;
    for (const [addr, n] of writes) { bytes += n; if (!eq(a.slice(addr, addr + n), b.slice(addr, addr + n))) ok = false; }
    T('c) A→B: memoria de B == A en lo que el driver escribe', ok, `${writes.length} bloques, ${bytes} bytes`);
    T('c) A→B: la memoria de B cambió respecto al inicio', hex(b) !== before);
  } catch (e) { T('c) A→B', false, e.message); }

  // d) editar canal, grabar en B, descargar de B y comprobar
  try {
    const m0 = (await engine.memories(0)).find((m) => !m.empty) || (await engine.memories(0))[0];
    const res = await engine.setMemory(0, { ...m0, freq: c.channelFreq, name: m0.name });
    await attach(emuB);
    await engine.upload(rid);
    await attach(emuB);
    await engine.download(rid);
    const after = (await engine.memories(0)).find((m) => m.number === m0.number);
    T('d) editar → grabar en B → descargar: cambio presente', Math.abs(parseFloat(after.freq) - parseFloat(c.channelFreq)) < 1e-6, `canal ${m0.number}: ${after.freq}`);
  } catch (e) { T('d) editar y grabar', false, e.message); }

  // e) BF-888: 146.520 (VHF) sobrevive descarga → guardado → grabado → nueva descarga
  if (c.kind === 'bf888') {
    try {
      const emuC = makeEmu('bf888', img);
      await attach(emuC);
      await engine.download(rid);
      const m = (await engine.memories(0))[0];
      await engine.setMemory(0, { ...m, freq: '146.520', duplex: '', offset: '0.000000' });
      const s = await engine.saveFile();
      await engine.openFile(new File([s.bytes], s.name));
      const m2 = (await engine.memories(0))[0];
      const emuD = makeEmu('bf888', c.scramble(img));
      await attach(emuD);
      const prevOnStatus = engine.onStatus, seen = [];
      engine.onStatus = (cur, max, msg) => { if (/^Grabando/.test(msg || '')) seen.push(max > 0 ? cur / max : 0); if (prevOnStatus) prevOnStatus(cur, max, msg); };
      try { await engine.upload(rid); } finally { engine.onStatus = prevOnStatus; }
      T('e) BF-888: el último progreso de la grabación es 100 %', seen.length > 0 && seen[seen.length - 1] === 1, `último ${seen[seen.length - 1]} de ${seen.length} avisos`);
      await attach(emuD);
      await engine.download(rid);
      const m3 = (await engine.memories(0))[0];
      T('e) BF-888: 146.520 VHF sobrevive el ciclo completo',
        m2.freq === '146.520000' && m3.freq === '146.520000', `tras abrir ${m2.freq}, tras regrabar ${m3.freq}`);
    } catch (e) { T('e) BF-888 VHF', false, e.message); }
  }
}

// Reapertura del puerto al cambiar baudios (drivers que lo hacen)
async function testBaudChange() {
  const port = await attach(makeEmu('uv5r', await fetchImg('Baofeng_UV-5R.img')));
  await engine.bridge.setSignals({});
  await engine.bridge.open({ baudRate: 9600 });
  await engine.bridge.reconfigure({ baudRate: 19200 });
  await engine.bridge.reconfigure({ baudRate: 57600 });
  await engine.bridge.close();
  record(S, 'cambio de baudios reabre el puerto', port.opens === 3 && port.state === 'closed' &&
    port.baudHistory.join() === '9600,19200,57600', `aperturas ${port.opens}, historial ${port.baudHistory}`);
}

export async function run() {
  for (const c of CASES) {
    try { await testCase(c); } catch (e) { record(S, c.name, false, e.stack); }
  }
  try { await testBaudChange(); } catch (e) { record(S, 'cambio de baudios', false, e.message); }
}
