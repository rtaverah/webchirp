// Utilidades comunes de las pruebas: arranque del motor, emuladores y registro de resultados.
import { Engine } from '../js/engine.js';
import { FakeSerialPort } from './fake-port.js';

export const results = [];   // {suite, test, model, ok, note, detail, ms}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let emuMod = null;
export let engine = null;

export function record(suite, test, ok, detail = '', model = '', note = '') {
  const r = { suite, test, model, ok, note, detail: String(detail).slice(0, 300) };
  results.push(r);
  if (window.onTestResult) window.onTestResult(r);
  return r;
}

export async function boot(log = () => {}, { all = true } = {}) {
  if (engine) return engine;
  engine = new Engine();
  window.engine = engine;
  await engine.load(log);
  await engine.loadIndex();
  const base = new URL('.', import.meta.url);
  const text = (p) => fetch(new URL(p, base)).then((r) => r.text());
  engine.py.FS.writeFile('/lib/webchirp/emulators.py', await text('emulators.py'));
  engine.py.FS.writeFile('/lib/webchirp/icom_clone_simulator.py', await text('fixtures/tests/icom_clone_simulator.py'));
  emuMod = engine.py.pyimport('emulators');
  if (all) engine.radios = await engine.listRadios();
  return engine;
}

export async function fetchImg(name) {
  const r = await fetch(new URL(`fixtures/tests/images/${name}`, import.meta.url));
  if (!r.ok) throw new Error('No existe la imagen ' + name);
  return new Uint8Array(await r.arrayBuffer());
}

export function makeEmu(kind, img = null, cls = null, rid = null) {
  return emuMod.make(kind, img, cls, rid);
}
export function setBlank(rid) { engine.activeTab = emuMod.set_blank(rid); return true; }

// Conecta un puerto simulado al puente (sin pasar por choosePort)
export async function attach(emu, faults = {}) {
  await engine.bridge.close().catch(() => {});
  const port = new FakeSerialPort(emu, faults);
  engine.bridge.port = port;
  engine.bridge.cancelled = false;
  return port;
}

export function radioId(vendor, model) {
  const r = engine.radios.find((x) => x.vendor === vendor && x.model === model && !x.alias_of);
  if (!r) throw new Error(`Modelo no encontrado: ${vendor} ${model}`);
  return r.id;
}

export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('TIMEOUT ' + label)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
