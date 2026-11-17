// Orquesta los grupos de pruebas. Modo automático: index.html?auto=emu,faults (envía resultados a /__result).
import { boot, results, record } from './harness.js';

const SUITES = {
  emu: () => import('./suite-emu.js'),
  faults: () => import('./suite-faults.js'),
  faultsemu: () => import('./suite-faults-emu.js'),
  chirp: () => import('./suite-chirp.js'),
  ui: () => import('./suite-ui.js'),
  scan: () => import('./suite-scan.js'),
  verify: () => import('./suite-verify.js'),
  alias: () => import('./suite-alias.js'),
  tk: () => import('./suite-tk.js'),
  settle: () => import('./suite-settle.js'),
  copy: () => import('./suite-copy.js'),
  clip: () => import('./suite-clip.js'),
  rt22: () => import('./suite-rt22.js'),
  tk3407: () => import('./suite-tk3407.js'),
};

const $ = (id) => document.getElementById(id);
const post = (obj) => fetch('/__result', { method: 'POST', body: JSON.stringify(obj) }).catch(() => {});

window.onTestResult = (r) => {
  const line = `${r.ok ? 'OK   ' : 'FALLA'} [${r.suite}] ${r.model ? r.model + ' · ' : ''}${r.test}${r.detail ? ' — ' + r.detail : ''}${r.note ? ' (' + r.note + ')' : ''}`;
  const span = document.createElement('span');
  span.className = r.ok ? 'ok' : 'bad';
  span.textContent = line + '\n';
  $('out').append(span);
  post({ type: 'result', ...r });
};

export async function runSuite(name) {
  await boot((s) => { $('status').textContent = s; });
  $('status').textContent = `Ejecutando ${name}…`;
  const t0 = performance.now();
  const mod = await SUITES[name]();
  await mod.run();
  const mine = results.filter((r) => r.suite === (mod.SUITE || r.suite));
  $('status').textContent = `${name} terminado en ${Math.round((performance.now() - t0) / 1000)} s. Pruebas: ${results.length}, fallos: ${results.filter((r) => !r.ok).length}`;
  post({ type: 'done', suite: name, total: results.length, failed: results.filter((r) => !r.ok).length });
}
window.runSuite = runSuite;

export function summaryText() {
  const failed = results.filter((r) => !r.ok);
  return `WebCHIRP pruebas ${new Date().toISOString()}\nTotal: ${results.length}  Pasaron: ${results.length - failed.length}  Fallaron: ${failed.length}\n\n` +
    results.map((r) => `${r.ok ? 'OK   ' : 'FALLA'} [${r.suite}] ${r.model ? r.model + ' · ' : ''}${r.test} ${r.detail}${r.note ? ' (' + r.note + ')' : ''}`).join('\n');
}

document.querySelectorAll('button[data-s]').forEach((b) => { b.onclick = () => runSuite(b.dataset.s).catch((e) => record('runner', b.dataset.s, false, e.stack)); });
$('all').onclick = async () => { for (const k of Object.keys(SUITES)) await runSuite(k); };
$('dl').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([summaryText()], { type: 'text/plain' }));
  a.download = 'webchirp-pruebas.txt';
  a.click();
};

(async () => {
  try {
    await boot((s) => { $('status').textContent = s; });
    $('status').textContent = 'Listo.';
    post({ type: 'ready' });
    const auto = new URLSearchParams(location.search).get('auto');
    if (auto) {
      for (const name of auto.split(',')) {
        try { await runSuite(name); } catch (e) { record('runner', name, false, e.stack); }
      }
      post({ type: 'finished' });
    }
  } catch (e) {
    $('status').textContent = 'Error: ' + e.message;
    post({ type: 'error', detail: e.stack });
  }
})();
