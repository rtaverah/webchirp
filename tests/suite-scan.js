// Detección automática (barrido) contra los emuladores: debe encontrar el radio, no escribir nada,
// y terminar sin colgarse con un puerto mudo o que responde basura.
import { engine, record, fetchImg, makeEmu, attach, withTimeout } from './harness.js';

export const SUITE = 'barrido';
const S = SUITE;

async function scenario(name, emu, faults, check) {
  const port = await attach(emu, faults);
  await engine.scanReset();
  const progress = [];
  const t0 = performance.now();
  let res = null; let err = null;
  try {
    res = await withTimeout(engine.scan((p) => progress.push(p.group.module), { timeoutMs: 7000, settleMs: 300 }), 3600000, 'barrido');
  } catch (e) { err = e; }
  const ms = performance.now() - t0;
  const stats = (await engine.scanStats());
  const info = res ? `${res.tested} de ${res.groups} protocolos probados, ${Math.round(ms / 1000)} s (tiempo simulado), encontrados: ${res.found.map((f) => f.radio.vendor + ' ' + f.radio.model).join(', ') || 'ninguno'}` : String(err);
  record(S, `${name}: el barrido termina sin colgarse`, !!res, info);
  if (res) {
    record(S, `${name}: puerto cerrado al terminar`, port.state === 'closed', port.state);
    check(res, emu, stats);
  }
  return res;
}

export async function run() {
  const uv = await fetchImg('Baofeng_UV-5R.img');
  const bf = await fetchImg('Baofeng_BF-888.img');
  const cands = await engine.call('scan_candidates');
  record(S, 'grupos de protocolo (firmas distintas)', cands.groups.length > 10,
    `${cands.groups.length} grupos para ${cands.total_models} modelos; primeros: ${cands.groups.slice(0, 5).map((g) => g.vendor + ' ' + g.model + ' @' + g.baud).join(' | ')}`);

  const g = JSON.parse(engine.py.runPython("import emulators; emulators.guard_test()"));
  record(S, 'seguridad: sync_out bloqueado durante el barrido', g.sync_out === 'bloqueado' && g.violaciones_registradas === 1, JSON.stringify(g.sync_out));
  record(S, 'seguridad: upload() rechazado durante un barrido', g.upload_durante_barrido.ok === false, g.upload_durante_barrido.error);

  await scenario('UV-5R emulado', makeEmu('uv5r', uv), {}, (res, emu, st) => {
    const f = res.found[0];
    record(S, 'UV-5R emulado: encuentra Baofeng UV-5R o compatible', !!f && f.group.members.some((m) => m.id === 'Baofeng_UV-5R'),
      f ? `${f.radio.vendor} ${f.radio.model} (grupo ${f.group.members.length} modelos, módulo ${f.group.module})` : 'nada');
    record(S, 'UV-5R emulado: 0 escrituras de memoria en el radio', emu.writes.toJs().length === 0 && st.violations === 0, `escrituras ${emu.writes.toJs().length}, violaciones ${st.violations}`);
  });

  await scenario('BF-888 emulado', makeEmu('bf888', bf), {}, (res, emu, st) => {
    const f = res.found[0];
    record(S, 'BF-888 emulado: encuentra BF-888 o compatible', !!f && f.group.module === 'h777',
      f ? `${f.radio.vendor} ${f.radio.model} (grupo ${f.group.members.length} modelos, módulo ${f.group.module})` : 'nada');
    record(S, 'BF-888 emulado: 0 escrituras de memoria en el radio', emu.writes.toJs().length === 0 && st.violations === 0, `escrituras ${emu.writes.toJs().length}, violaciones ${st.violations}`);
  });

  await scenario('RT22 emulado (LUITON LT-316)', makeEmu('rt22', await fetchImg('Retevis_RT22.img'), null, 'LUITON_LT-316'), {}, (res, emu, st) => {
    const f = res.found[0];
    const names = f ? engine.aliasesFor(f.group.members.map((m) => m.id)) : [];
    record(S, 'RT22 emulado: encuentra el protocolo del LT-316 y menciona Motorola C1',
      !!f && f.group.members.some((m) => m.id === 'LUITON_LT-316') && names.includes('Motorola C1'),
      f ? `${f.radio.vendor} ${f.radio.model} (grupo de ${f.group.members.length}); alias: ${names.join(', ')}` : 'nada');
    record(S, 'RT22 emulado: 0 escrituras en el radio', emu.writes.toJs().length === 0 && st.violations === 0, `escrituras ${emu.writes.toJs().length}`);
  });

  await scenario('puerto mudo', null, { mute: true }, (res) => {
    record(S, 'puerto mudo: "No se encontró ningún radio compatible"', res.found.length === 0 && !res.cancelled && res.tested === res.groups, `${res.tested}/${res.groups}`);
  });
  await scenario('puerto con basura', null, { garbage: true }, (res) => {
    record(S, 'puerto con basura: "No se encontró ningún radio compatible"', res.found.length === 0 && !res.cancelled && res.tested === res.groups, `${res.tested}/${res.groups}`);
  });

  // Cancelar a mitad del barrido
  await attach(null, { mute: true });
  setTimeout(() => engine.cancel(), 20000);
  const t0 = performance.now();
  const rc = await engine.scan(() => {}, { timeoutMs: 7000, settleMs: 300 });
  record(S, 'cancelar el barrido a mitad termina rápido', rc.cancelled && rc.tested < rc.groups, `${rc.tested}/${rc.groups}, ${Math.round(performance.now() - t0)} ms`);

  // Después del barrido el motor sigue operativo
  const emu = makeEmu('uv5r', uv);
  await attach(emu);
  try { const d = await engine.download('Baofeng_UV-5R'); record(S, 'tras el barrido se puede leer normalmente', d.model === 'UV-5R'); }
  catch (e) { record(S, 'tras el barrido se puede leer normalmente', false, e.message); }
}
