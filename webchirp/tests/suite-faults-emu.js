// Inyección de fallas con los emuladores UV-5R y BF-888: la operación debe terminar en error,
// dejar el puerto cerrado, no corromper la imagen abierta y permitir reintentar con éxito.
import { engine, record, fetchImg, makeEmu, attach, radioId, eq, hex, withTimeout } from './harness.js';

export const SUITE = 'fallas-emu';
const S = SUITE;

const MODELS = [
  { name: 'Baofeng UV-5R', kind: 'uv5r', vendor: 'Baofeng', model: 'UV-5R', img: 'Baofeng_UV-5R.img' },
  { name: 'Baofeng BF-888', kind: 'bf888', vendor: 'Baofeng', model: 'BF-888', img: 'Baofeng_BF-888.img' },
];

async function attempt(op, rid, emu, faults) {
  const port = await attach(emu, faults);
  const t0 = performance.now();
  let err = null;
  try {
    const res = await withTimeout(op === 'download' ? engine.download(rid) : engine.upload(rid), 90000, op);
    // una grabación sin verificación correcta cuenta como fallo detectado
    if (op === 'upload' && res.verify.status !== 'ok') err = new Error('verificación: ' + (res.verify.error || res.verify.status));
  } catch (e) { err = e; }
  return { err, port, ms: performance.now() - t0 };
}

export async function run() {
  // con tiempo virtual las esperas activas no avanzan el reloj: se usan timers (solo para esta prueba)
  engine.py.runPython('import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.0');
  try { await runAll(); } finally { engine.py.runPython('import webchirp; webchirp.PRECISE_SLEEP_MAX = 0.05'); }
}

async function runAll() {
  for (const m of MODELS) {
    const img = await fetchImg(m.img);
    const rid = radioId(m.vendor, m.model);
    // Referencia: operación limpia para saber cuántas escrituras hace el driver
    const clean = {};
    for (const op of ['download', 'upload']) {
      const e0 = makeEmu(m.kind, img);
      const r = await attempt(op, rid, e0, {});
      clean[op] = r.port.writes;
      if (op === 'upload') clean.blocks = e0.writes.toJs().length;     // bloques que escribe el driver (sin la comprobación)
      record(S, `${op} limpio termina bien`, !r.err, r.err ? r.err.message : `${r.port.writes} escrituras`, m.name);
    }
    await engine.download(rid).catch(() => {});
    const baseline = async () => hex((await engine.saveFile()).bytes);

    const faults = [
      ['radio mudo', () => ({ mute: true }), true],
      ['respuestas basura', () => ({ garbage: true }), true],
      ['respuesta corta', () => ({ short: true }), true],
      // al grabar, "a mitad" se mide en bloques escritos (la comprobación posterior es otra fase)
      ['desconexión a mitad', (op, emu) => (op === 'upload'
        ? { disconnectWhen: () => emu.writes.toJs().length >= Math.floor(clean.blocks / 2) }
        : { disconnectAtWrite: Math.max(2, Math.floor(clean[op] / 2)) }), true],
      // al grabar, el último envío cae en la comprobación (ya leyó todo): se cubre en la suite de verificación
      ['desconexión casi al final', (op) => ({ disconnectAtWrite: Math.max(2, clean[op] - 1) }), true, 'download'],
      ['cancelar a mitad', (op) => ({ cancelAtWrite: Math.max(2, Math.floor(clean[op] / 2)), onCancel: () => engine.cancel() }), true],
      ['un byte de datos corrupto (una vez)', (op) => ({ corruptDataOnce: Math.floor(clean[op] / 3) }), false],
      // Corrupción de bytes: estos protocolos no llevan checksum; si el golpe cae en datos no se detecta
      ['bytes corruptos a mitad', (op) => ({ corruptAfter: Math.floor(clean[op] / 2) }), false],
    ];
    for (const op of ['download', 'upload']) {
      for (const [fname, mk, mustFail, onlyOp] of faults) {
        if (onlyOp && onlyOp !== op) continue;
        const label = `${op} con ${fname}`;
        const before = await baseline();
        const emuGood = makeEmu(m.kind, img);
        const r = await attempt(op, rid, emuGood, mk(op, emuGood));
        const after = await baseline();
        const closed = r.port.state === 'closed';
        let detail = r.err ? r.err.message : 'sin error';
        if (mustFail) {
          record(S, `${label}: termina con error`, !!r.err, detail, m.name);
          record(S, `${label}: tarda < 60 s`, r.ms < 60000, `${Math.round(r.ms)} ms`, m.name);
        } else {
          // informativo: si no hay error, se anota que el protocolo no lo detectó
          record(S, `${label}: no cuelga`, r.ms < 60000, r.err ? 'detectado: ' + detail : 'NO detectado (sin checksum en el protocolo)', m.name,
            r.err ? '' : 'limitación del driver original');
        }
        record(S, `${label}: puerto cerrado`, closed, `estado ${r.port.state}`, m.name);
        if (op === 'download') record(S, `${label}: imagen abierta intacta`, !r.err || !mustFail ? true : before === after, '', m.name);
        // Reintento sin recargar
        const retry = await attempt(op, rid, makeEmu(m.kind, img), {});
        record(S, `${label}: reintento posterior funciona`, !retry.err, retry.err ? retry.err.message : '', m.name);
        await engine.download(rid).catch(() => {}); // deja una imagen abierta para el siguiente caso
        engine.bridge.cancelled = false;
      }
    }
  }
}
