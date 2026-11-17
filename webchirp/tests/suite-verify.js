// Grabación con verificación: escribir, volver a leer y comparar (canales y bytes).
import { engine, record, fetchImg, makeEmu, attach, radioId, withTimeout } from './harness.js';

export const SUITE = 'verificacion';
const S = SUITE;

const CASES = [
  { name: 'Baofeng UV-5R', kind: 'uv5r', vendor: 'Baofeng', model: 'UV-5R', img: 'Baofeng_UV-5R.img', dropIdx: 20,
    scramble: (img) => { const b = img.slice(); for (let i = 8 + 8; i < 8 + 0xCF0; i++) b[i] = (i * 31 + 7) & 0xff; return b; } },
  { name: 'Baofeng BF-888', kind: 'bf888', vendor: 'Baofeng', model: 'BF-888', img: 'Baofeng_BF-888.img', dropIdx: 6,
    scramble: (img) => { const b = img.slice(); for (let i = 0x10; i < 0x110; i++) b[i] = (i * 17 + 3) & 0xff; return b; } },
];

export async function run() {
  for (const c of CASES) {
    const T = (t, ok, d = '') => record(S, `${c.name}: ${t}`, ok, d, c.name);
    const rid = radioId(c.vendor, c.model);
    const img = await fetchImg(c.img);
    const emuA = makeEmu(c.kind, img);
    await attach(emuA);
    await engine.download(rid);

    // (a) grabación normal: la verificación coincide
    try {
      const emuB = makeEmu(c.kind, c.scramble(img));
      const port = await attach(emuB);
      const res = await engine.upload(rid);
      const v = res.verify;
      T('a) grabación normal: verificación OK', v.status === 'ok' && v.matching === v.compared && v.compared > 0,
        `estado ${v.status}${v.error ? ' (' + v.error + ')' : ''}, ${v.matching}/${v.compared} canales (${v.non_empty} con datos), bytes: ${v.byte_check === 'ok' ? 'ok, ' + v.byte_total + ' comparados' : v.byte_check}`);
      T('a) puerto cerrado tras verificar', port.state === 'closed');
    } catch (e) { T('a) grabación normal', false, e.message); }

    // (b) el radio "pierde" una escritura: debe detectarse y señalar canales
    try {
      const emuB = makeEmu(c.kind, c.scramble(img));
      emuB.drop_write = c.dropIdx;
      await attach(emuB);
      const res = await engine.upload(rid);
      const v = res.verify;
      const chans = [...new Set(v.diffs.map((d) => d.channel))];
      T('b) escritura perdida: la verificación detecta diferencias', v.status === 'diff' && v.diff_count > 0,
        `estado ${v.status}, canales con diferencias: ${chans.join(',') || '(ninguno)'}; campos del primero: ${v.diffs[0] ? v.diffs[0].fields.join(',') : '-'}; bytes: ${v.byte_check}${v.byte_diffs.length ? ' (' + v.byte_diffs.length + ' región/es)' : ''}`);
    } catch (e) { T('b) escritura perdida', false, e.message); }

    // (c) desconexión durante la verificación: error claro, nunca "verificado"
    try {
      const emuB = makeEmu(c.kind, c.scramble(img));
      const port = await attach(emuB, { disconnectWhen: () => emuB.read_after_write >= 3 });
      const res = await withTimeout(engine.upload(rid), 120000, 'upload');
      const v = res.verify;
      T('c) desconexión durante la verificación: error, no "verificado"', v.status === 'error' && !!v.error, `estado ${v.status}: ${String(v.error).slice(0, 100)}`);
      T('c) puerto cerrado tras la desconexión', port.state === 'closed', port.state);
      T('c) la escritura sí llegó al radio (el aviso debe decirlo)', emuB.writes.toJs().length > 0, `${emuB.writes.toJs().length} bloques`);
    } catch (e) { T('c) desconexión en verificación', false, e.message); }
  }

  // (d) BF-888 con canal VHF 146.520 verificado OK
  try {
    const img = await fetchImg('Baofeng_BF-888.img');
    const rid = radioId('Baofeng', 'BF-888');
    await attach(makeEmu('bf888', img));
    await engine.download(rid);
    const m = (await engine.memories(0))[0];
    await engine.setMemory(0, { ...m, freq: '146.520', duplex: '', offset: '0.000000' });
    const emuB = makeEmu('bf888', (() => { const b = img.slice(); for (let i = 0x10; i < 0x110; i++) b[i] = (i * 13 + 5) & 0xff; return b; })());
    await attach(emuB);
    const v = (await engine.upload(rid)).verify;
    await attach(emuB);
    await engine.download(rid);
    const after = (await engine.memories(0))[0];
    record(S, 'BF-888 con 146.520 MHz (VHF): grabado y verificado', v.status === 'ok' && after.freq === '146.520000',
      `verificación ${v.status} (${v.matching}/${v.compared}), canal 1 en el radio: ${after.freq}`, 'Baofeng BF-888');
  } catch (e) { record(S, 'BF-888 VHF verificado', false, e.message, 'Baofeng BF-888'); }
}
