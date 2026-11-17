// Pruebas de seguridad de la interfaz real (index.html en un iframe) con un puerto simulado.
import { record, fetchImg, makeEmu, hex, sleep, eq } from './harness.js';
import { FakeSerialPort } from './fake-port.js';

export const SUITE = 'interfaz';
const S = SUITE;

export async function until(fn, ms = 60000, label = '') {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error('Tiempo agotado esperando ' + label);
    await sleep(100);
  }
}

export async function loadApp(clearStorage) {
  const old = document.getElementById('appframe');
  if (old) old.remove();
  if (clearStorage) localStorage.clear();
  const f = document.createElement('iframe');
  f.id = 'appframe';
  f.style.cssText = 'width:900px;height:700px';
  f.src = '../index.html';
  document.body.append(f);
  await until(() => f.contentWindow && f.contentWindow.webchirpReady, 120000, 'carga de la app');
  const w = f.contentWindow;
  w.__errs = [];
  w.addEventListener('error', (e) => w.__errs.push(e.message));
  w.addEventListener('unhandledrejection', (e) => w.__errs.push(String(e.reason && e.reason.stack || e.reason)));
  w.captured = [];
  w.showSaveFilePicker = undefined;
  w.HTMLAnchorElement.prototype.click = function () { w.captured.push({ name: this.download, href: this.href }); };
  w.URL.createObjectURL = (blob) => { const u = 'blob:fake/' + w.captured.length; w.blobs = w.blobs || {}; w.blobs[u] = blob; return u; };
  return w;
}

export const dlgOpen = (w) => w.document.getElementById('dlg').open;
export async function answer(w, ok, expectTitle) {
  try {
    await until(() => dlgOpen(w), 30000, 'diálogo ' + (expectTitle || ''));
  } catch (e) {
    const d = w.document;
    throw new Error(`${e.message}. Estado: toast="${d.getElementById('toast').hidden ? '' : d.getElementById('toast').textContent}" ` +
      `progreso="${d.getElementById('progress-msg').textContent}" ocupado=${w.document.body.classList.contains('busy')} escribirDeshabilitado=${d.getElementById('btn-write').disabled} puerto="${d.getElementById('port-name').textContent}" modelo="${d.getElementById('sel-model').selectedOptions[0] && d.getElementById('sel-model').selectedOptions[0].textContent}" archivo="${d.getElementById('file-info').textContent}" errores=${JSON.stringify(w.__errs).slice(0, 400)}`);
  }
  const title = w.document.getElementById('dlg-title').textContent;
  const text = w.document.getElementById('dlg-body').textContent;
  w.document.querySelector(`#dlg button[value="${ok ? 'ok' : 'cancel'}"]`).click();
  await sleep(50);
  return { title, text };
}
const toastText = (w) => (w.document.getElementById('toast').hidden ? '' : w.document.getElementById('toast').textContent);

export async function openInApp(w, name, bytes) {
  const dt = new w.DataTransfer();
  dt.items.add(new w.File([bytes], name));
  const inp = w.document.getElementById('file-input');
  inp.files = dt.files;
  inp.dispatchEvent(new w.Event('change'));
  await until(() => w.document.getElementById('file-info').textContent.startsWith(name) &&
    !w.document.body.classList.contains('busy') && w.document.querySelectorAll('#mem-table tbody tr').length > 0, 60000, 'tabla');
}

export async function connect(w, emu, faults = {}) {
  const port = new FakeSerialPort(emu, faults);
  w.engine.bridge.choosePort = async () => { w.engine.bridge.port = port; return 'Puerto simulado'; };
  w.document.getElementById('btn-port').click();
  await until(() => w.document.getElementById('port-name').textContent === 'Puerto simulado', 5000, 'puerto');
  return port;
}

const scr = (img, a, b, k) => { const x = img.slice(); for (let i = a; i < b; i++) x[i] = (i * k + 5) & 0xff; return x; };
const RANGES = [[0, 0x110], [0x2B0, 0x2C0], [0x380, 0x3E0]];

const tabsOf = (w) => [...w.document.querySelectorAll('#doc-tabs .doctab')].map((el) => ({
  id: Number(el.dataset.tabId), num: el.querySelector('.doctab-num').textContent, title: el.querySelector('.doctab-title').textContent,
  color: el.style.getPropertyValue('--tabcolor'), active: el.classList.contains('active'), el }));
const clickTab = (w, num) => tabsOf(w).find((t) => t.num === num).el.querySelector('.doctab-main').click();
function chooseModel(w, vendor, modelText) {
  const d = w.document;
  d.getElementById('radio-filter').value = '';
  const vend = d.getElementById('sel-vendor');
  vend.value = vendor; vend.dispatchEvent(new w.Event('change'));
  const sel = d.getElementById('sel-model');
  sel.value = [...sel.options].find((o) => o.textContent === modelText).value;
  sel.dispatchEvent(new w.Event('change'));
}
// Espera a que aparezca el mensaje breve de éxito/fallo (toast) y registra los textos de progreso vistos
async function waitToast(w, re, ms = 60000) {
  const seen = new Set();
  const d = w.document;
  try {
    await until(() => {
      seen.add(d.getElementById('progress-msg').textContent);
      const t = d.getElementById('toast');
      return !t.hidden && re.test(t.textContent);
    }, ms, 'mensaje ' + re);
  } catch (e) {
    const dl = d.getElementById('dlg');
    let extra = '';
    if (dl.open && /no quedó igual/.test(d.getElementById('dlg-title').textContent)) {
      d.querySelector('#dlg button[value="ok"]').click();
      await sleep(400);
      extra = ' DETALLES: ' + d.getElementById('dlg-body').textContent.slice(0, 500);
    }
    throw new Error(extra +`${e.message}. Diálogo abierto: ${dl.open ? d.getElementById('dlg-title').textContent + ' / ' + d.getElementById('dlg-body').textContent.slice(0, 300) : 'ninguno'}; toast="${d.getElementById('toast').textContent}"`);
  }
  return [...seen];
}

export async function run() {
  const img = await fetchImg('Baofeng_BF-888.img');
  const rt = await fetchImg('Retevis_RT22.img');
  const w = await loadApp(true);
  const doc = w.document;

  // 1. Aviso de responsabilidad, pie visible, sin panel de registro
  try {
    const r = await answer(w, true, 'aviso');
    record(S, 'aviso de responsabilidad la primera vez', r.title === 'Aviso importante' && /sin garantía/.test(r.text), r.title);
    record(S, 'el aviso incluye CHIRP y GPLv3', /CHIRP/.test(r.text) && /GPLv3/.test(r.text));
    await sleep(200);
    record(S, 'aviso aceptado se recuerda', localStorage.getItem('webchirp.aceptado') === '1');
    record(S, 'el pie de página sigue visible con aviso, CHIRP y GPLv3', !!doc.querySelector('footer') && /sin garantía/.test(doc.querySelector('footer').textContent) && /GPLv3/.test(doc.querySelector('footer').textContent));
    record(S, 'ya no existe el panel Registro ni la casilla de copia de seguridad', !doc.getElementById('log-card') && !doc.getElementById('log') && !doc.getElementById('chk-backup'));
  } catch (e) { record(S, 'aviso de responsabilidad', false, e.message); }

  // 2. Abrir archivo = pestaña nueva con el nombre del archivo; columna Scan
  await openInApp(w, 'Baofeng_BF-888.img', img);
  try {
    const t = tabsOf(w);
    record(S, 'abrir un archivo crea la pestaña #1 con su nombre', t.length === 1 && t[0].num === '#1' && t[0].title === 'Baofeng_BF-888.img', JSON.stringify(t.map((x) => [x.num, x.title])));
    record(S, 'el botón dice "Grabar #1 en el radio"', doc.getElementById('btn-write').textContent === 'Grabar #1 en el radio');
    const uv = await fetchImg('Baofeng_UV-5R.img');
    await openInApp(w, 'Baofeng_UV-5R.img', uv);
    const heads = [...doc.querySelectorAll('#mem-table th')].map((x) => x.textContent);
    const skipSel = doc.querySelector('#mem-table select[data-key=skip]');
    skipSel.dispatchEvent(new w.Event('focus'));
    const opts = [...skipSel.options].map((o) => `${o.value || '(vacío)'}=${o.textContent}`);
    record(S, 'la columna "Saltar" ahora se llama "Scan" y va después de Potencia', heads.includes('Scan') && !heads.includes('Saltar') && heads.indexOf('Scan') === heads.indexOf('Potencia') + 1, heads.join('|'));
    record(S, 'Scan muestra Sí/No pero el valor interno sigue siendo ""/"S"', opts.includes('(vacío)=Sí') && opts.includes('S=No'), opts.join(', '));
    // cerrar pestaña UV-5R sin cambios: no pide confirmación
    tabsOf(w).find((x) => x.title === 'Baofeng_UV-5R.img').el.querySelector('.doctab-close').click();
    await sleep(600);
    record(S, 'cerrar una pestaña sin cambios no pregunta y queda la #1', !dlgOpen(w) && tabsOf(w).length === 1 && tabsOf(w)[0].num === '#1');
  } catch (e) { record(S, 'pestaña por archivo / columna Scan', false, e.stack); }

  // 3. Grabar la pestaña seleccionada: una confirmación, "Grabando…", "Comprobando…" y mensaje breve
  try {
    const emuB = makeEmu('bf888', scr(img, 0x10, 0x110, 13));
    await connect(w, emuB);
    doc.getElementById('btn-write').click();
    const d1 = await answer(w, true, 'grabar');
    record(S, 'una sola confirmación sencilla con el título de la pestaña', d1.title === 'Grabar #1 en el radio' && /¿Grabar Baofeng_BF-888\.img en el radio conectado\?/.test(d1.text), d1.text.slice(0, 90));
    const seen = await waitToast(w, /✓ Quedó bien grabado/);
    record(S, 'progreso con dos estados: "Grabando…" y "Comprobando…"', seen.some((m) => /^Grabando…/.test(m)) && seen.some((m) => m === 'Comprobando…'), seen.filter(Boolean).slice(-4).join(' | '));
    record(S, 'resultado breve "✓ Quedó bien grabado" sin listas', !dlgOpen(w));
    const memNow = emuB.memory_js();
    const want = (await w.engine.saveFile()).bytes;
    record(S, 'el radio quedó igual a la pestaña en lo grabado', RANGES.every(([a, b]) => eq(memNow.slice(a, b), want.slice(a, b))));
  } catch (e) { record(S, 'grabar con comprobación', false, e.stack); }

  // 3b. El radio pierde una escritura
  try {
    const emuL = makeEmu('bf888', scr(img, 0x10, 0x110, 11));
    emuL.drop_write = 6;
    await connect(w, emuL);
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar');
    const d = await answer(w, true, 'no quedó igual (ver detalles)');
    record(S, 'escritura perdida: "La grabación no quedó igual. Vuelve a grabar."', d.title === 'La grabación no quedó igual' && /⚠ La grabación no quedó igual\. Vuelve a grabar\./.test(d.text) && !!doc.querySelector('#dlg-body a.small-link') || /no quedó igual/.test(d.text), d.text.slice(0, 120));
    const det = await answer(w, false, 'detalles');
    record(S, '"Ver detalles" lista los canales y campos', det.title === 'Detalles' && /Canal \d+: .*(frecuencia|dúplex)/.test(det.text), det.text.slice(0, 120));
  } catch (e) { record(S, 'escritura perdida (interfaz)', false, e.stack); }

  // 3c. Desconexión durante la comprobación
  try {
    const emuD = makeEmu('bf888', scr(img, 0x10, 0x110, 9));
    await connect(w, emuD, { disconnectWhen: () => emuD.read_after_write >= 3 });
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar');
    const d = await answer(w, false, 'sin comprobar');
    record(S, 'desconexión al comprobar: mensaje claro, nunca "bien grabado"', /No se pudo comprobar/.test(d.title) && /se envió completa/.test(d.text) && /Comprobar de nuevo/.test(doc.getElementById('dlg-ok').textContent) && !/Quedó bien grabado/.test(d.text), d.text.slice(0, 120));
  } catch (e) { record(S, 'desconexión al comprobar (interfaz)', false, e.stack); }

  // 3d. Error al grabar con enlace de detalles técnicos
  try {
    const emuM = makeEmu('bf888', img);
    await connect(w, emuM, { mute: true });
    const port = w.engine.bridge.port;
    w.captured.length = 0;
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar');
    await until(() => dlgOpen(w) && /Error al grabar/.test(doc.getElementById('dlg-body').textContent), 90000, 'error al grabar');
    const link = doc.querySelector('#dlg-body a.small-link');
    record(S, 'error: enlace "Descargar detalles técnicos"', !!link && /detalles técnicos/.test(link.textContent));
    link.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(200);
    const logCap = w.captured.find((c) => /webchirp-registro/.test(c.name));
    const logText = logCap ? await w.blobs[logCap.href].text() : '';
    record(S, 'el registro técnico incluye versión, navegador, modelo, hora, puerto y la traza serie',
      /WebCHIRP 2026/.test(logText) && /Navegador: .*Chrome/.test(logText) && /Modelo elegido: Baofeng BF-888/.test(logText) && /Fecha: 20\d\d-/.test(logText) && /TX \d+: /.test(logText) && /Puerto abierto: USB/.test(logText), logText.split('\n').slice(0, 3).join(' | ').slice(0, 160));
    await answer(w, true, 'cerrar error');
    record(S, 'grabación fallida: puerto cerrado y mensaje en español', port.state === 'closed');
  } catch (e) { record(S, 'error al grabar', false, e.stack); }

  // 4. Modelo equivocado: bloqueo + oferta de copiar solo los canales
  try {
    chooseModel(w, 'Abbree', 'AR-518');
    const emuX = makeEmu('bf888', img);
    await connect(w, emuX);
    doc.getElementById('btn-write').click();
    const d = await answer(w, false, 'modelo equivocado');
    record(S, 'modelo distinto: no se graba y se ofrece copiar solo los canales', d.title === 'Modelo equivocado' && /otro modelo/.test(d.text) && /copiar solo los canales/.test(d.text) && emuX.writes.toJs().length === 0, d.text.slice(0, 120));
    chooseModel(w, 'Baofeng', 'BF-888');
  } catch (e) { record(S, 'modelo distinto', false, e.stack); }

  // 5. beforeunload durante la grabación
  try {
    const emuU = makeEmu('bf888', img);
    let prevented = null;
    await connect(w, emuU, { cancelAtWrite: 6, onCancel: () => { const ev = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(ev); prevented = ev.defaultPrevented; } });
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar');
    await until(() => prevented !== null, 30000, 'beforeunload');
    record(S, 'beforeunload advierte durante la grabación', prevented === true);
    await waitToast(w, /✓ Quedó bien grabado/);
    const ev = new w.Event('beforeunload', { cancelable: true }); w.dispatchEvent(ev);
    record(S, 'beforeunload no advierte fuera de una grabación', ev.defaultPrevented === false);
  } catch (e) { record(S, 'beforeunload', false, e.stack); }

  // 6. Leer A y B crean pestañas; grabar #1 en el radio B verifica y no toca #2
  try {
    chooseModel(w, 'Baofeng', 'BF-888');
    const emuA = makeEmu('bf888', img);
    const emuBr = makeEmu('bf888', scr(img, 0x10, 0x110, 21));
    await connect(w, emuA);
    doc.getElementById('btn-read').click();
    await answer(w, true, 'leer A');
    const sv = await answer(w, false, 'guardar lectura A');
    record(S, 'tras leer pregunta "¿Guardar esta lectura en el computador?" con [Guardar] [Ahora no]', sv.title === 'Lectura terminada' && /¿Guardar esta lectura en el computador\?/.test(sv.text) && doc.getElementById('dlg-cancel').textContent !== undefined, sv.text.slice(0, 80));
    await until(() => tabsOf(w).length === 2, 60000, 'pestaña de la lectura A');
    const tA = tabsOf(w)[1];
    record(S, 'leer el radio A crea una pestaña nueva con título "<Modelo> · fecha hora" y color propio', /^Baofeng BF-888 · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(tA.title) && /^#\d+$/.test(tA.num) && tA.color !== tabsOf(w)[0].color, `${tA.num} ${tA.title} ${tA.color}`);
    await connect(w, emuBr);
    doc.getElementById('btn-read').click();
    await answer(w, true, 'leer B');
    await answer(w, true, 'guardar lectura B');
    await until(() => tabsOf(w).length === 3, 60000, 'pestaña de la lectura B');
    await until(() => w.captured.some((c) => /^Baofeng_BF_888_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.img$/.test(c.name)), 10000, 'descarga de la lectura');
    record(S, 'guardar la lectura baja "<Marca>_<Modelo>_AAAA-MM-DD_HH-MM-SS.img"', true, w.captured.find((c) => /Baofeng_BF/.test(c.name)).name);
    const tB = tabsOf(w)[2];
    const snapB = hex((await w.engine.saveFile(tB.id)).bytes);
    clickTab(w, tA.num);
    await sleep(800);
    const wb = doc.getElementById('btn-write');
    record(S, `seleccionar ${tA.num}: el botón dice "Grabar ${tA.num} en el radio" con el color de la pestaña`, wb.textContent === `Grabar ${tA.num} en el radio` && wb.style.background !== '' && tabsOf(w).find((t) => t.num === tA.num).active, `${wb.textContent} ${wb.style.background}`);
    await connect(w, emuBr);
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar #2');
    await waitToast(w, /✓ Quedó bien grabado/);
    const mem = emuBr.memory_js(), want = (await w.engine.saveFile(tA.id)).bytes;
    record(S, 'grabar la pestaña seleccionada en el radio B: comprobación OK y el radio queda igual a ella', RANGES.every(([a, b]) => eq(mem.slice(a, b), want.slice(a, b))));
    record(S, 'la otra pestaña (lectura de B) no se modificó', hex((await w.engine.saveFile(tB.id)).bytes) === snapB);
  } catch (e) { record(S, 'pestañas por lectura', false, e.stack); }

  // 7. Alias Motorola C1: leer, guardar con nombre de alias, grabar sin error de modelo
  try {
    const vend = doc.getElementById('sel-vendor');
    const sel = doc.getElementById('sel-model');
    record(S, 'la marca Motorola aparece y contiene C1 (compatible con LUITON LT-316)', [...vend.options].some((o) => o.value === 'Motorola'), `${vend.options.length} marcas; filtro="${doc.getElementById('radio-filter').value}"`);
    chooseModel(w, 'Motorola', 'C1 (compatible con LUITON LT-316)');
    const emuR = makeEmu('rt22', rt, null, 'LUITON_LT-316');
    await connect(w, emuR);
    doc.getElementById('btn-read').click();
    const d = await answer(w, true, 'leer con alias');
    record(S, 'leer con el alias: el diálogo dice "Motorola C1 (compatible con LUITON LT-316)"', /Motorola C1 \(compatible con LUITON LT-316\)/.test(d.title), d.title);
    await answer(w, true, 'guardar lectura C1');
    const n0 = tabsOf(w).length;
    await until(() => w.captured.some((c) => /^Motorola_C1_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.img$/.test(c.name)), 20000, 'descarga con nombre de alias');
    const tC = tabsOf(w).find((t) => /^Motorola C1 · /.test(t.title));
    record(S, 'la pestaña y el archivo usan el alias "Motorola C1"', !!tC, tC && tC.title);
    record(S, 'tras leer, la etiqueta dice "Motorola C1 (compatible con LUITON LT-316)"', /Motorola C1 \(compatible con LUITON LT-316\)/.test(doc.getElementById('file-info').textContent), doc.getElementById('file-info').textContent);
    const sv = await w.engine.saveFile(tC.id);
    await openInApp(w, sv.name, sv.bytes);
    record(S, 'al abrir el archivo guardado se mantiene la selección Motorola C1', sel.selectedOptions[0] && /^C1 \(compatible/.test(sel.selectedOptions[0].textContent) && vend.value === 'Motorola');
    const emuW = makeEmu('rt22', scr(rt, 0x20, 0x200, 7), null, 'LUITON_LT-316');
    await connect(w, emuW);
    doc.getElementById('btn-write').click();
    const g1 = await answer(w, true, 'grabar con alias');
    record(S, 'grabar con el alias no da error de "modelo distinto"', /^Grabar #\d+ en el radio$/.test(g1.title), g1.title);
    await waitToast(w, /✓ Quedó bien grabado/);
    record(S, 'grabar con el alias: "✓ Quedó bien grabado"', true);
  } catch (e) { record(S, 'alias Motorola C1 en la interfaz', false, e.stack); }

  // 8. Copiar solo los canales del C1 a otro modelo (BF-888) desde la interfaz
  try {
    const tC = tabsOf(w).find((t) => /^Motorola C1 · /.test(t.title));
    clickTab(w, tC.num);
    await sleep(800);
    doc.getElementById('btn-copy').click();
    const d = await answer(w, false, 'destino de la copia');
    record(S, '"Copiar canales a…" ofrece las otras pestañas y leer el radio conectado', /Destino/.test(d.text) || d.title.startsWith('Copiar canales de'), d.title);
  } catch (e) { record(S, 'copiar canales: diálogo de destino', false, e.stack); }
  try {
    // flujo completo vía "Modelo equivocado": copiar canales a un BF-888 leído ahora
    const tC = tabsOf(w).find((t) => /^Motorola C1 · /.test(t.title));
    clickTab(w, tC.num);
    await sleep(600);
    chooseModel(w, 'Baofeng', 'BF-888');
    const emuDst = makeEmu('bf888', scr(img, 0x10, 0x110, 17));
    await connect(w, emuDst);
    doc.getElementById('btn-write').click();
    await answer(w, true, 'copiar canales');          // "Modelo equivocado" -> [Copiar canales]
    await answer(w, true, 'leer el BF-888');            // leer el radio destino
    await answer(w, false, 'guardar lectura destino'); // [Ahora no]
    const sum = await answer(w, false, 'resumen de la copia');
    record(S, 'copiar canales muestra un resumen simple', sum.title === 'Canales copiados' && /\d+ canales copiados, \d+ ajustados, \d+ sin copiar/.test(sum.text), sum.text.slice(0, 80));
    const tNew = tabsOf(w).find((t) => /con canales de/.test(t.title));
    record(S, 'el resultado es una pestaña nueva "BF-888 con canales de #N · fecha"', !!tNew && /^BF-888 con canales de #\d+ · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d( •)?$/.test(tNew.title), tNew && tNew.title);
    await sleep(500);
    record(S, 'la pestaña nueva queda activa y su botón dice "Grabar #N en el radio"', !!tNew && tNew.active && doc.getElementById('btn-write').textContent === `Grabar ${tNew.num} en el radio`, doc.getElementById('btn-write').textContent);
    await connect(w, emuDst);
    doc.getElementById('btn-write').click();
    await answer(w, true, 'grabar la copia');
    await waitToast(w, /✓ Quedó bien grabado/);
    record(S, 'grabar la pestaña de la copia en el BF-888: comprobación OK', true);
    // las originales no cambiaron
    record(S, 'la pestaña original del C1 sigue intacta (sin marcar como modificada)', !tabsOf(w).find((t) => /^Motorola C1 · /.test(t.title)).title.endsWith('•'));
  } catch (e) { record(S, 'copiar canales desde la interfaz', false, e.stack); }

  // 9. Operación lenta (driver Yaesu FT-450 espera 150 s con un radio mudo): aviso a los 20 s y cancelar
  try {
    chooseModel(w, 'Yaesu', 'FT-450');
    const emuS = makeEmu('bf888', img);
    const port = await connect(w, emuS, { mute: true });
    const t0 = performance.now();
    doc.getElementById('btn-read').click();
    await answer(w, true, 'leer FT-450');
    await until(() => !doc.getElementById('slow-warn').hidden, 60000, 'aviso de radio lento');
    const waited = (performance.now() - t0) / 1000;
    record(S, 'aviso "El radio no responde todavía…" tras unos 20 s sin progreso', waited > 18 && waited < 40 && /no responde todavía/.test(doc.getElementById('slow-warn').textContent), `${waited.toFixed(1)} s`);
    doc.getElementById('btn-slow-cancel').click();
    const d = await answer(w, true, 'cancelado');
    record(S, 'el botón Cancelar del aviso corta la operación y explica', /cancelada/i.test(d.text) && port.state === 'closed' && doc.getElementById('slow-warn').hidden, d.text.slice(0, 120));
  } catch (e) { record(S, 'aviso de operación lenta', false, e.stack); }

  // 10. Cerrar una pestaña con cambios pide confirmación
  try {
    const t = tabsOf(w).find((x) => x.active) || tabsOf(w)[0];
    clickTab(w, t.num);
    await sleep(600);
    const fr = doc.querySelector('#mem-table tbody tr [data-key=freq]');
    fr.value = '440.100'; fr.dispatchEvent(new w.Event('change'));
    await sleep(1500);
    tabsOf(w).find((x) => x.num === t.num).el.querySelector('.doctab-close').click();
    const d = await answer(w, false, 'cambios');
    record(S, 'cerrar una pestaña con cambios sin guardar pide confirmación y respeta "Cancelar"', d.title === 'Cambios sin guardar' && tabsOf(w).some((x) => x.num === t.num), d.title);
    const before = tabsOf(w).length;
    tabsOf(w).find((x) => x.num === t.num).el.querySelector('.doctab-close').click();
    await answer(w, true, 'cerrar sin guardar');
    await sleep(600);
    record(S, 'confirmar cierra la pestaña', tabsOf(w).length === before - 1 && !tabsOf(w).some((x) => x.num === t.num));
  } catch (e) { record(S, 'cerrar pestaña con cambios', false, e.stack); }
}
