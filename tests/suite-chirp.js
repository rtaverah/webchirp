// Pruebas propias de CHIRP (tests/test_drivers.py: edges, copy_all, clone, settings, brute_force, features, detect...)
// ejecutadas con pytest dentro de Pyodide, por lotes de imágenes. Parámetros: ?batch=8&limit=40&only=Baofeng
import { engine, record } from './harness.js';

export const SUITE = 'chirp';
const S = SUITE;
const params = new URLSearchParams(location.search);
const post = (o) => fetch('/__result', { method: 'POST', body: JSON.stringify(o) }).catch(() => {});

const RUNNER = `
import os, sys, json, importlib
import pytest

class Rep:
    def __init__(self):
        self.items = []
    def pytest_runtest_logreport(self, report):
        if report.when == 'call' or (report.when == 'setup' and report.outcome != 'passed') or (report.when == 'teardown' and report.outcome == 'failed'):
            xf = hasattr(report, 'wasxfail')
            if xf:
                kind = 'xpassed' if report.outcome == 'passed' else 'xfailed'
            else:
                kind = report.outcome
            msg = ''
            if report.outcome == 'failed' and not xf:
                msg = str(report.longrepr).strip().splitlines()[-1][:200] if report.longrepr else ''
            self.items.append([report.nodeid, kind, msg])

def run_batch(images, kexpr=''):
    import serial
    serial.Serial.__init__ = lambda self, *a, **k: None    # los simuladores de CHIRP heredan de serial.Serial
    os.chdir('/work')
    if '/work' not in sys.path:
        sys.path.insert(0, '/work')
    os.environ['CHIRP_TESTIMG'] = ' '.join(images)
    for m in [m for m in sys.modules if m == 'tests' or m.startswith('tests.')]:
        del sys.modules[m]
    importlib.invalidate_caches()
    rep = Rep()
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        args = ['tests/test_drivers.py', '-q', '-p', 'no:cacheprovider', '--no-header', '-W', 'ignore']
        if kexpr:
            args += ['-k', kexpr]
        code = pytest.main(args, plugins=[rep])
    return json.dumps({'code': int(code), 'items': rep.items, 'out': buf.getvalue()[-1500:]})
`;

export async function run() {
  const py = engine.py;
  const t0 = performance.now();
  await py.loadPackage(['pytest', 'pyyaml']);
  const base = new URL('fixtures/tests/', import.meta.url);
  const text = async (p) => (await fetch(new URL(p, base))).text();
  const files = (await text('files.txt')).split('\n').filter(Boolean);
  let images = (await text('images.txt')).split('\n').filter(Boolean);
  py.FS.mkdirTree('/work/tests/images');
  // chirp.serialtrace importa la configuración de la interfaz gráfica (no incluida): se simula
  py.FS.mkdirTree('/lib/webchirp/chirp/wxui');
  py.FS.writeFile('/lib/webchirp/chirp/wxui/__init__.py', '');
  py.FS.writeFile('/lib/webchirp/chirp/wxui/config.py', [
    'class _Conf:',
    '    def __getattr__(self, name):',
    '        return lambda *a, **k: (False if name.startswith("get_bool") else None)',
    'def get():',
    '    return _Conf()',
  ].join('\n'));
  for (const f of files) py.FS.writeFile('/work/tests/' + f, await text(f));
  const only = params.get('only');
  if (only) images = images.filter((i) => i.includes(only));
  // reparto en varias páginas en paralelo: ?part=0&parts=6 prueba las imágenes i % parts == part
  const parts = Number(params.get('parts') || 1);
  const part = Number(params.get('part') || 0);
  if (parts > 1) images = images.filter((_, i) => i % parts === part);
  // las imágenes con muchos canales tardan minutos: ?maxsize=bytes las omite y ?maxsecs=N corta la ejecución (se informa la cobertura)
  const sizes = {};
  const maxsize = Number(params.get('maxsize') || 0);
  if (maxsize) {
    for (const img of images) {
      const r = await fetch(new URL('images/' + img, base), { method: 'HEAD' });
      sizes[img] = Number(r.headers.get('content-length') || 0);
    }
    images = images.filter((i) => sizes[i] <= maxsize).sort((a, b) => sizes[a] - sizes[b]);
  }
  const maxsecs = Number(params.get('maxsecs') || 0);
  const limit = Number(params.get('limit') || 0);
  if (limit) images = images.slice(0, limit);
  const batch = Number(params.get('batch') || 8);
  for (let i = 0; i < images.length; i += 8) {
    await Promise.all(images.slice(i, i + 8).map(async (img) => {
      const r = await fetch(new URL('images/' + img, base));
      py.FS.writeFile('/work/tests/images/' + img, new Uint8Array(await r.arrayBuffer()));
    }));
  }
  py.runPython(RUNNER);
  const runBatch = py.globals.get('run_batch');
  const tot = { passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  const unexpected = [];
  let covered = 0;
  for (let i = 0; i < images.length; i += batch) {
    if (maxsecs && (performance.now() - t0) / 1000 > maxsecs) break;
    const chunk = images.slice(i, i + batch);
    const tb = performance.now();
    let res;
    try {
      res = JSON.parse(runBatch(py.toPy(chunk), params.get('k') || ''));
    } catch (e) {
      record(S, `lote ${chunk[0]}…`, false, 'pytest no pudo ejecutarse: ' + String(e.message).slice(-200));
      continue;
    }
    if (!res.items.length) record(S, `lote ${chunk[0]}…: pytest no recolectó pruebas (código ${res.code})`, false, res.out.slice(-600));
    for (const [id, kind, msg] of res.items) {
      tot[kind] = (tot[kind] || 0) + 1;
      if (kind === 'failed' || kind === 'xpassed') unexpected.push([id, kind, msg]);
    }
    covered += chunk.length;
    post({ type: 'progress', part, image: chunk.join(','), suite: S, done: Math.min(i + batch, images.length), of: images.length, totals: tot, secs: Math.round((performance.now() - tb) / 1000) });
  }
  for (const [id, kind, msg] of unexpected) record(S, id, false, `${kind}: ${msg}`, '', kind);
  const total = Object.values(tot).reduce((a, b) => a + b, 0);
  record(S, `pytest sobre ${covered} de ${images.length} imágenes (parte ${part + 1} de ${parts})`, true,
    `total ${total}; pasaron ${tot.passed}; fallaron (inesperados) ${tot.failed}; omitidos ${tot.skipped}; xfail esperados ${tot.xfailed}; xpass (esperaban fallar y pasaron) ${tot.xpassed}; ${Math.round((performance.now() - t0) / 1000)} s`);
}
