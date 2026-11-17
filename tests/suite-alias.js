// Alias verificados en campo (aliases.json): Motorola C1 -> LUITON LT-316.
import { engine, record, fetchImg, makeEmu, attach } from './harness.js';

export const SUITE = 'alias';
const S = SUITE;

export async function run() {
  const alias = engine.entries.find((r) => r.vendor === 'Motorola' && r.model === 'C1');
  record(S, 'el alias Motorola C1 aparece en la lista mezclada', !!alias && alias.id === 'LUITON_LT-316' && alias.compat === 'LUITON LT-316',
    alias ? `id ${alias.id}, módulos ${alias.modules}, compatible con ${alias.compat}` : 'no está');
  record(S, 'el alias comparte el driver (módulo) del destino', !!alias && alias.modules.includes('retevis_rt22'));

  // Leer con el id del destino (lo que usa la interfaz al elegir el alias) con el emulador del protocolo RT22
  const img = await fetchImg('Retevis_RT22.img');
  try {
    const emu = makeEmu('rt22', img, null, 'LUITON_LT-316');
    const port = await attach(emu);
    const d = await engine.download('LUITON_LT-316');
    const s = await engine.saveFile();
    const meta = JSON.parse(atob(new TextDecoder().decode(s.bytes.slice(1032)).replace(/^[^e]*(eyJ)/, '$1').trim()));
    record(S, 'leer con el alias (emulador RT22): driver LT-316', d.vendor === 'LUITON' && d.model === 'LT-316' && port.state === 'closed', `${d.vendor} ${d.model}`);
    record(S, 'el .img guardado conserva los metadatos reales (LUITON LT-316)', meta.vendor === 'LUITON' && meta.model === 'LT-316', JSON.stringify(meta));
    record(S, 'el archivo guardado se reabre como LT-316', (await engine.openFile(new File([s.bytes], s.name))).model === 'LT-316', s.name);
    // grabar sobre el archivo LT-316 con el mismo id (alias elegido) verifica bien
    const emuB = makeEmu('rt22', (() => { const b = img.slice(); for (let i = 0x20; i < 0x200; i++) b[i] = (i * 7 + 1) & 0xff; return b; })(), null, 'LUITON_LT-316');
    await attach(emuB);
    const up = await engine.upload('LUITON_LT-316');
    record(S, 'grabar con el alias sobre un archivo LT-316: sin error de modelo y verificado', up.verify.status === 'ok', `verificación ${up.verify.status} ${up.verify.error || ''} (${up.verify.matching}/${up.verify.compared}), bytes: ${up.verify.byte_check}`);
  } catch (e) { record(S, 'leer/grabar con el alias', false, e.stack || e.message); }

  // Abrir/guardar con la imagen de un modelo hermano del mismo driver (no hay imagen LT-316 en CHIRP)
  try {
    const d = await engine.openFile(new File([img], 'Retevis_RT22.img'));
    const s = await engine.saveFile();
    const d2 = await engine.openFile(new File([s.bytes], s.name));
    record(S, 'abrir/guardar/reabrir con el driver compartido', d.model === d2.model, `${d.vendor} ${d.model}`);
  } catch (e) { record(S, 'abrir/guardar', false, e.message); }
}
