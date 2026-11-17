// Copiar SOLO los canales entre radios de modelos distintos (C1/LT-316 -> BF-888) en una pestaña nueva.
import { engine, record, fetchImg, makeEmu, attach, hex, eq } from './harness.js';

export const SUITE = 'copiar-canales';
const S = SUITE;
const scr = (img, a, b, k) => { const x = img.slice(); for (let i = a; i < b; i++) x[i] = (i * k + 5) & 0xff; return x; };

export async function run() {
  const rt = await fetchImg('Retevis_RT22.img');
  const bf = await fetchImg('Baofeng_BF-888.img');
  // #1: leer el C1 (protocolo RT22)   #2: leer el BF-888
  await attach(makeEmu('rt22', rt, null, 'LUITON_LT-316'));
  const A = await engine.download('LUITON_LT-316');
  await attach(makeEmu('bf888', bf));
  const B = await engine.download('Baofeng_BF-888');
  record(S, 'leer C1 y BF-888 crea dos pestañas distintas', A.tab !== B.tab && !!A.tab && !!B.tab, `tabs ${A.tab} y ${B.tab}`);
  const snapA = hex((await engine.saveFile(A.tab)).bytes);
  const snapB = hex((await engine.saveFile(B.tab)).bytes);
  const setB = JSON.stringify(await engine.settings(B.tab));
  const memsA = await engine.memories(0, A.tab);
  const used = memsA.filter((m) => !m.empty);

  let C;
  try {
    const res = await engine.copyChannels(A.tab, B.tab);
    C = res;
    const sm = res.summary;
    record(S, 'copiar canales de #1 a #2 crea una pestaña nueva (#3)', res.tab !== A.tab && res.tab !== B.tab,
      `${sm.copied} copiados, ${sm.adjusted} ajustados, ${sm.skipped} sin copiar (${used.length} con datos en el origen; destino con ${sm.dst_channels} canales)`);
    record(S, 'cuenta: copiados + ajustados + sin copiar == canales con datos del origen', sm.copied + sm.adjusted + sm.skipped === used.length);
    const memsC = await engine.memories(0, res.tab);
    const bad = res.details.filter((d) => d.status !== 'no copiado').filter((d) => {
      const a = memsA.find((m) => m.number === d.number), c = memsC.find((m) => m.number === d.number);
      return !c || c.empty || a.freq !== c.freq;
    });
    record(S, 'cada canal copiado queda en el MISMO número con la misma frecuencia', bad.length === 0, bad.length ? JSON.stringify(bad[0]) : `${res.details.filter((d) => d.status !== 'no copiado').length} canales verificados`);
  } catch (e) { record(S, 'copiar canales', false, e.stack || e.message); return; }

  record(S, 'las pestañas originales #1 y #2 siguen intactas', hex((await engine.saveFile(A.tab)).bytes) === snapA && hex((await engine.saveFile(B.tab)).bytes) === snapB);
  record(S, 'los ajustes del BF-888 no cambiaron en la copia', JSON.stringify(await engine.settings(C.tab)) === setB && setB.length > 100, `${setB.length} bytes de ajustes comparados`);

  // grabar #3 en el BF-888 con escritura y comprobación
  try {
    const emuB = makeEmu('bf888', scr(bf, 0x10, 0x110, 13));
    await attach(emuB);
    const up = await engine.upload('Baofeng_BF-888', C.tab);
    record(S, 'grabar la copia en el BF-888: comprobación OK', up.verify.status === 'ok', `${up.verify.status} ${up.verify.error || ''} (${up.verify.matching}/${up.verify.compared}), bytes: ${up.verify.byte_check}`);
  } catch (e) { record(S, 'grabar la copia', false, e.message); }
  // protección de modelo: la imagen completa del C1 NO se puede grabar en el BF-888
  try {
    await attach(makeEmu('bf888', bf));
    let err = null;
    try { await engine.upload('Baofeng_BF-888', A.tab); } catch (e) { err = e; }
    record(S, 'grabar la imagen completa del C1 en un BF-888 sigue bloqueado (modelo equivocado)', !!err && /elegiste|Elige el mismo modelo/.test(err.message), err && err.message.slice(0, 100));
  } catch (e) { record(S, 'bloqueo de modelo', false, e.message); }

  // origen con canales fuera de banda y con más canales que el destino: UV-5R (VHF, 128 canales) -> H777S (UHF, 16 canales)
  try {
    const uv = await engine.openFile(new File([await fetchImg('Baofeng_UV-5R.img')], 'uv5r.img'));
    const hs = await engine.openFile(new File([await fetchImg('Retevis_H777S.img')], 'h777s.img'));
    const r = await engine.copyChannels(uv.tab, hs.tab);
    const sk = r.details.filter((d) => d.status === 'no copiado');
    const oob = sk.find((d) => /fuera de banda|out of range|range/i.test(d.notes.join(' ')) && d.number <= 16);
    const many = sk.find((d) => /solo tiene 16 canales/.test(d.notes.join(' ')));
    record(S, 'canal fuera de banda queda "no copiado" con su razón', !!oob, oob ? `canal ${oob.number}: ${oob.notes[0]}` : `sin coincidencias; ejemplo: ${JSON.stringify(sk[0])}`);
    record(S, 'origen con más canales que el destino: se informa "el destino solo tiene 16 canales"', !!many && r.summary.dst_channels === 16 && r.summary.src_channels === 128, many ? `canal ${many.number}: ${many.notes[0]}` : '');
    record(S, 'resumen simple con totales', r.summary.skipped === sk.length, JSON.stringify(r.summary));
    // solo algunos canales (copiar/pegar de filas seleccionadas)
    const only = await engine.copyChannels(uv.tab, hs.tab, [1, 2]);
    record(S, 'copiar solo canales indicados (numbers_json)', only.details.every((d) => d.number === 1 || d.number === 2) && only.details.length <= 2, `${only.details.length} canales en el detalle`);
  } catch (e) { record(S, 'fuera de banda / más canales', false, e.stack || e.message); }
}
