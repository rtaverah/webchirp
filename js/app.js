// Interfaz de WebCHIRP: conecta la página con el motor (engine.js).
import { Engine } from './engine.js';
import { SerialBridge } from './serial-bridge.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
window.engine = engine; // útil para depurar desde la consola

const state = {
  radios: [],          // lista completa de modelos
  tabs: [],            // pestañas de trabajo (una imagen abierta cada una)
  cur: null,           // pestaña activa
  tabSeq: 0,           // contador #1, #2, #3…
  busy: false,
  portName: null,
  engineReady: false,
  scanning: false,
  paused: false,
};

// radio, dev, features, mems, dirty, settingsLoaded y hideDefaultSet pertenecen a la pestaña activa
const TAB_DEFAULTS = { radio: null, dev: 0, features: [], mems: [], dirty: false, settingsLoaded: false, hideDefaultSet: false };
for (const k of Object.keys(TAB_DEFAULTS)) {
  Object.defineProperty(state, k, {
    get() { return this.cur ? this.cur[k] : TAB_DEFAULTS[k]; },
    set(v) { if (this.cur) this.cur[k] = v; },
  });
}
const PALETTE = ['#1f6feb', '#e8590c', '#2f9e44', '#9c36b5', '#0c8599', '#e03131', '#7f8c1c', '#d6336c'];

let enginePromise = null;
// Espera a que el motor (Pyodide + chirp.zip) esté listo; la página ya es usable antes
async function ready() {
  if (state.engineReady) return;
  $('engine-status').hidden = false;
  await enginePromise;
}

let writing = false;
window.addEventListener('beforeunload', (e) => {
  if (writing) { e.preventDefault(); e.returnValue = ''; }
});

const canSerial = SerialBridge.supported() && typeof WebAssembly !== 'undefined' && !!WebAssembly.Suspending;

const DISCLAIMER = 'WebCHIRP se ofrece tal cual, sin garantía. Programar un radio puede borrar su configuración o dejarlo inutilizable si se interrumpe la grabación, se usa el modelo equivocado o el cable falla. Haz siempre una copia de seguridad. Los autores no se hacen responsables de daños, pérdida de datos ni del uso de frecuencias no autorizadas.';

// ---------- utilidades ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.filter((c) => c != null));
  return el;
}

const store = {
  get(k) { try { return localStorage.getItem('webchirp.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('webchirp.' + k, v); } catch { /* sin almacenamiento */ } },
};

let toastTimer;
function toast(msg, ok = false, ms = 0) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || (ok ? 3000 : 7000));
}

// Diálogo de confirmación. sections: [{title, text, warn}] -> Promise<boolean>
function confirmDialog(title, sections, okLabel = 'Continuar', { hideCancel = false, cancelLabel = 'Cancelar' } = {}) {
  const dlg = $('dlg');
  $('dlg-title').textContent = title;
  $('dlg-ok').textContent = okLabel;
  $('dlg-cancel').hidden = hideCancel;
  $('dlg-cancel').textContent = cancelLabel;
  const body = $('dlg-body');
  body.replaceChildren(...sections.map((s) =>
    h('div', { class: 'dlg-sec' + (s.warn ? ' exp' : '') }, h('b', { text: s.title }),
      s.text != null ? h('pre', { text: s.text }) : null, s.node || null)));
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { $('dlg-cancel').hidden = false; $('dlg-cancel').textContent = 'Cancelar'; resolve(dlg.returnValue === 'ok'); }, { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

// Mensajes típicos de CHIRP en español, con acciones claras y el original entre paréntesis
const FRIENDLY = [
  [/Operación cancelada/i, 'Operación cancelada.'],
  [/No response from radio|RadioNoResponse/i, 'El radio no respondió. Apaga y vuelve a encender el radio, revisa que el cable esté bien conectado (hasta el fondo), sube el volumen y vuelve a intentar.'],
  [/did not accept program mode|refused to enter programming mode|refused clone/i, 'El radio no aceptó el modo de programación. Apágalo y enciéndelo, conecta el cable hasta el fondo y vuelve a intentar.'],
  [/identification failed|Incorrect model|identifies as|Unexpected response from radio|Unknown response/i, 'El radio respondió, pero no coincide con el modelo elegido. Revisa la marca y el modelo en la lista, o usa «Detectar radio (barrido)».'],
  [/Failed to (read|send) block|refused to (send|accept) block|No ACK|Out of sync|Failed to communicate|did not (send|ack)|incomplete block/i, 'Se perdió la comunicación con el radio durante la transferencia. Revisa el cable, no lo muevas ni apagues el radio, y vuelve a intentar.'],
  [/puerto se cerró|desconect|NetworkError|Dispositivo perdido|device has been lost|puerto no está abierto/i, 'El cable se desconectó o el puerto se cerró. Vuelve a conectar el cable, elige el puerto otra vez y reintenta.'],
  [/Tiempo agotado/i, 'El radio tardó demasiado en responder. Apaga y enciende el radio, revisa el cable y reintenta.'],
];

function friendly(msg) {
  const m = String(msg);
  for (const [re, es] of FRIENDLY) if (re.test(m)) return `${es} (${m.replace(/\s+/g, ' ').trim()})`;
  return m;
}

// Diálogo de error con enlace pequeño para bajar el registro técnico (soporte)
function showError(msg, title = 'No se pudo completar') {
  return confirmDialog(title, [{ title: 'Detalle', text: friendly(msg), warn: true }, { title: 'Soporte', node: detailsLink() }],
    'Cerrar', { hideCancel: true });
}

function aboutSections() {
  return [
    { title: 'Sin garantía', warn: true, text: DISCLAIMER },
    { title: 'Créditos y licencia',
      node: h('p', {}, 'Basado en ', h('a', { href: 'https://chirpmyradio.com', target: '_blank', rel: 'noopener', text: 'CHIRP (chirpmyradio.com)' }),
        ' · Licencia ', h('a', { href: 'COPYING', target: '_blank', text: 'GPLv3' }), '.') },
  ];
}

// Mientras se habla con el radio la pestaña debe estar visible: oculta, Chrome alarga los temporizadores
// y los radios que exigen pausas de pocos milisegundos dejan de reconocer el saludo.
function checkVisibility() {
  const bad = state.busy && document.hidden;
  $('hidden-warn').hidden = !bad;
  if (bad && !state.hiddenLogged) {
    state.hiddenLogged = true;
    if (window.webchirpLog) window.webchirpLog('WARNING', 'La pestaña quedó oculta durante una operación con el radio');
  }
  if (!state.busy) state.hiddenLogged = false;
}
document.addEventListener('visibilitychange', checkVisibility);

function setBusy(busy, cancellable = false) {
  state.busy = busy;
  lastProgress = performance.now();
  $('slow-warn').hidden = true;
  checkVisibility();
  document.body.classList.toggle('busy', busy);
  $('btn-cancel').hidden = !(busy && cancellable);
  $('progress').hidden = !busy;
  if (busy) { maxWritePct = 0; $('progress-bar').style.width = '0'; $('progress-msg').textContent = ''; document.querySelector('#progress .bar').classList.remove('indeterminate'); }
  refreshButtons();
}

function refreshButtons() {
  const idle = !state.busy;
  const hasRadio = !!state.radio;
  $('btn-port').disabled = !idle || !canSerial;
  $('btn-read').disabled = !idle || !canSerial || !state.portName || !selectedRadio();
  $('btn-write').disabled = !idle || !canSerial || !state.portName || !hasRadio || !state.radio.clone || !selectedRadio();
  $('btn-save').disabled = !idle || !hasRadio;
  $('btn-new').disabled = !idle;
  $('btn-scan').disabled = !idle || !canSerial || !state.portName;
  const t = state.cur;
  const wb = $('btn-write');
  wb.textContent = t ? `Grabar #${t.num} en el radio` : 'Grabar en el radio';
  wb.style.background = t ? t.color : '';
  wb.style.borderColor = t ? t.color : '';
  $('btn-copy').disabled = !idle || !t || state.tabs.length < 1;
  $('btn-copy-sel').disabled = !idle || !t || !(t.selected && t.selected.size);
  $('btn-copy-rows').disabled = !idle || !t || !(t.selected && t.selected.size);
  $('btn-paste').disabled = !idle || !t;
  $('btn-undo').disabled = !idle || !t || !t.undoCount;
  for (const id of ['radio-filter', 'sel-vendor', 'sel-model']) $(id).disabled = !idle;
}

// Si pasan 20 s sin progreso (algunos drivers esperan 60-150 s con un radio mudo) se avisa y se ofrece cancelar
const SLOW_AFTER_MS = 20000;
let lastProgress = performance.now();
let maxWritePct = 0;   // la barra de grabación no retrocede dentro de una misma grabación
setInterval(() => {
  const slow = state.busy && !$('progress').hidden && performance.now() - lastProgress > SLOW_AFTER_MS;
  $('slow-warn').hidden = !slow;
}, 1000);

engine.onStatus = (cur, max, msg) => {
  lastProgress = performance.now();
  $('slow-warn').hidden = true;
  let pct = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
  const bar = document.querySelector('#progress .bar');
  // grabación: "Grabando…" con barra; "Comprobando…" con un indicador simple (sin detalle técnico)
  if (/^Comprobando/.test(msg || '')) {
    bar.classList.add('indeterminate');
    $('progress-msg').textContent = 'Comprobando…';
    return;
  }
  bar.classList.remove('indeterminate');
  if (/^Grabando/.test(msg || '')) { pct = maxWritePct = Math.max(maxWritePct, pct); }
  $('progress-bar').style.width = pct + '%';
  $('progress-msg').textContent = /^Grabando/.test(msg || '') ? `Grabando… ${Math.round(pct)} %` : `${msg || ''} ${max > 0 ? `(${cur}/${max})` : ''}`;
};

// ---------- selector de marca / modelo ----------
const radioKey = (r) => `${r.vendor}|${r.model}|${r.variant}`;
const radioLabel = (r) => r.model + (r.variant ? ' ' + r.variant : '') + (r.field_alias ? ` (compatible con ${r.compat})` : '');

function selectedRadio() {
  const v = $('sel-model').value;
  return v === '' ? null : state.radios[Number(v)];
}

function fillVendors(keepVendor) {
  const q = $('radio-filter').value.trim().toLowerCase();
  const match = (r) => !q || `${r.vendor} ${r.model} ${r.variant}`.toLowerCase().includes(q);
  const vendors = [...new Set(state.radios.filter(match).map((r) => r.vendor))];
  const sel = $('sel-vendor');
  sel.replaceChildren(...vendors.map((v) => h('option', { value: v, text: v })));
  if (vendors.includes(keepVendor)) sel.value = keepVendor;
  fillModels();
}

function fillModels(keepIndex) {
  const q = $('radio-filter').value.trim().toLowerCase();
  const vendor = $('sel-vendor').value;
  const sel = $('sel-model');
  const opts = [];
  state.radios.forEach((r, i) => {
    if (r.vendor !== vendor) return;
    if (q && !`${r.vendor} ${r.model} ${r.variant}`.toLowerCase().includes(q)) return;
    opts.push(h('option', { value: i, text: radioLabel(r) }));
  });
  sel.replaceChildren(...opts);
  if (keepIndex != null && opts.some((o) => Number(o.value) === keepIndex)) sel.value = keepIndex;
  refreshButtons();
}

// Preselecciona un modelo por id del driver (o por clave guardada)
function selectRadio(match) {
  let idx = state.radios.findIndex(match);
  if (idx < 0) return false;
  $('radio-filter').value = '';
  fillVendors(state.radios[idx].vendor);
  fillModels(idx);
  return true;
}

function rememberModel() {
  const r = selectedRadio();
  if (r) store.set('model', radioKey(r));
}

// ---------- puerto ----------
async function choosePort() {
  try {
    state.portName = await engine.bridge.choosePort();
    $('port-name').textContent = state.portName;
    store.set('port', state.portName);
  } catch (e) {
    if (e.name !== 'NotFoundError') toast('No se pudo elegir el puerto: ' + e.message);
  }
  refreshButtons();
}

// ---------- operaciones con el radio ----------
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date(), sep = ' ', tsep = ':') {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${sep}${pad(d.getHours())}${tsep}${pad(d.getMinutes())}${tsep}${pad(d.getSeconds())}`;
}
// Nombre visible del radio elegido (alias si lo hay): "Motorola C1"
const chosenName = (r) => (r.field_alias ? `${r.vendor} ${r.model}` : `${r.vendor} ${r.model}${r.variant ? ' ' + r.variant : ''}`);

// Lee el radio conectado con el modelo elegido y abre una pestaña nueva. Devuelve la pestaña o null.
async function doRead(r, { offerSave = true } = {}) {
  await ready();
  rememberModel();
  let prompts = {};
  try { prompts = (await engine.prompts(r.id, null)) || {}; } catch (e) { toast(e.message); return null; }
  const secs = [];
  if (prompts.info) secs.push({ title: 'Información', text: prompts.info });
  if (prompts.experimental) secs.push({ title: 'Controlador experimental', text: prompts.experimental, warn: true });
  secs.push({ title: 'Antes de descargar', text: prompts.pre_download ||
    'Conecta el cable al radio, enciéndelo y ponlo en el modo adecuado.' });
  if (!(await confirmDialog(`Leer ${r.vendor} ${radioLabel(r)}`, secs, 'Leer del radio'))) return null;

  engine.bridge.cancelled = false;
  setBusy(true, true);
  let tab = null;
  try {
    const desc = await engine.download(r.id);
    const when = new Date();
    tab = await loadRadio(desc, 'Descargado del radio', (num) => `${chosenName(r)} · ${stamp(when)}`);
    toast('Lectura completada', true);
    tab.readName = chosenName(r);
    tab.readWhen = when;
  } catch (e) {
    await showError('Error al leer el radio: ' + e.message);
  } finally {
    setBusy(false);
  }
  if (tab && offerSave) await offerSaveRead(tab);
  return tab;
}

// Una lectura guardada es la copia de seguridad del radio
async function offerSaveRead(tab) {
  const ok = await confirmDialog('Lectura terminada', [{ title: '¿Guardar esta lectura en el computador?',
    text: 'Esa copia sirve como respaldo: si algo sale mal al grabar, puedes volver a este estado.' }],
    'Guardar', { cancelLabel: 'Ahora no' });
  if (!ok) return;
  try {
    const { bytes } = await engine.saveFile(tab.id);
    const base = (tab.readName || `${tab.radio.vendor} ${tab.radio.model}`).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const name = `${base}_${stamp(tab.readWhen || new Date(), '_', '-')}.${tab.radio.extension || 'img'}`;
    if (await saveBytes(name, bytes)) { tab.saved = true; toast('Guardado: ' + name, true); }
  } catch (e) {
    await showError('No se pudo guardar: ' + e.message);
  }
}

async function readRadio() {
  const r = selectedRadio();
  if (!r) return;
  await doRead(r);
}

async function writeRadio() {
  const r = selectedRadio();
  const tab = state.cur;
  if (!r || !tab) return;
  await ready();
  rememberModel();
  if (r.id !== tab.radio.id) {
    // Bloqueo de modelo equivocado (se mantiene); se ofrece copiar solo los canales
    const go = await confirmDialog('Modelo equivocado', [{ title: 'Este archivo es de otro modelo', warn: true,
      text: `La pestaña #${tab.num} es de ${tab.radio.vendor} ${tab.radio.model}, pero el radio elegido es ${r.vendor} ${radioLabel(r)} (el modelo elegido no coincide con el del archivo). ` +
        'No se puede grabar una imagen completa de otro modelo.\n\n¿Quieres copiar solo los canales a este radio?' }],
      'Copiar canales', { cancelLabel: 'Cancelar' });
    if (go) await copyFlow(tab, null, { autoRead: true });
    return;
  }
  let prompts = {};
  try { prompts = (await engine.prompts(r.id, tab.id)) || {}; } catch (e) { toast(e.message); return; }
  const secs = [{ title: 'Confirmar', text: `¿Grabar ${tab.title} en el radio conectado?\nEsto reemplaza lo que tiene el radio ahora.` }];
  if (prompts.experimental) secs.push({ title: 'Controlador experimental', text: prompts.experimental, warn: true });
  if (prompts.pre_upload) secs.push({ title: 'Antes de grabar', text: prompts.pre_upload });
  if (!(await confirmDialog(`Grabar #${tab.num} en el radio`, secs, 'Grabar'))) return;

  engine.bridge.cancelled = false;
  setBusy(true, true);
  writing = true;
  let result = null;
  let failure = null;
  try {
    result = await engine.upload(r.id, tab.id);
  } catch (e) {
    failure = e;
  } finally {
    writing = false;
    setBusy(false);
  }
  if (failure) {
    await showError('Error al grabar: ' + failure.message + ' El radio podría quedar a medias: vuelve a grabar antes de usarlo.', 'Error al grabar');
    return;
  }
  await showVerifyResult(result.verify, tab, r.id);
}

// Resultado: si coincide, un mensaje breve que se cierra solo; si no, aviso claro con detalles opcionales
async function showVerifyResult(v, tab, rid) {
  if (v.status === 'ok') {
    toast('✓ Quedó bien grabado', true, 5000);
    return;
  }
  if (v.status === 'error') {
    const sent = v.sent_complete
      ? 'La grabación se envió completa (el radio confirmó cada bloque), pero no se pudo comprobar. Apaga y enciende el radio y usa «Comprobar de nuevo».'
      : 'No hay garantía de que el radio haya quedado bien.';
    const again = await confirmDialog('No se pudo comprobar', [{ title: '⚠ No se pudo comprobar la grabación', warn: true,
      text: `${sent}\n\n${friendly(v.error)}` }, { title: 'Soporte', node: detailsLink() }],
      'Comprobar de nuevo', { cancelLabel: 'Cerrar' });
    if (again) {
      engine.bridge.cancelled = false;
      setBusy(true, true);
      let res = null;
      try { res = await engine.verifyTab(rid, tab.id); } catch (e) { res = { verify: { status: 'error', error: e.message, sent_complete: v.sent_complete } }; } finally { setBusy(false); }
      await showVerifyResult(res.verify, tab, rid);
    }
    return;
  }
  const see = await confirmDialog('La grabación no quedó igual', [{ title: '⚠ La grabación no quedó igual. Vuelve a grabar.', warn: true,
    text: 'Se volvió a leer el radio y algunos datos no coinciden con lo que se grabó.' },
    { title: 'Soporte', node: detailsLink() }], 'Ver detalles', { cancelLabel: 'Cerrar' });
  if (!see) return;
  const lines = v.diffs.slice(0, 40).map((d) => `Canal ${d.channel}${d.device ? ' (dispositivo ' + (d.device + 1) + ')' : ''}: ${d.fields.map(fieldLabel).join(', ')}`);
  if (v.diff_count > 40) lines.push(`… y ${v.diff_count - 40} canales más`);
  if (v.byte_diffs.length) lines.push(...v.byte_diffs.map((b) => `Bytes distintos en la región 0x${b.start.toString(16)}-0x${b.end.toString(16)} (primero en 0x${b.first_diff.toString(16)})`));
  await confirmDialog('Detalles', [{ title: `${v.diff_count} canal(es) distintos`, text: lines.join('\n') }], 'Cerrar', { hideCancel: true });
}

function detailsLink() {
  return h('a', { href: '#', class: 'small-link', text: 'Descargar detalles técnicos', onclick: (e) => { e.preventDefault(); downloadLog(); } });
}

// ---------- archivos ----------
async function openFile(file) {
  if (!file) return;
  if (state.busy) { toast('Hay una operación en curso. Espera a que termine para abrir el archivo.'); return; }
  setBusy(true);
  $('progress').hidden = true;
  try {
    await ready();
    const desc = await engine.openFile(file, (step) => { $('file-info').textContent = step; });
    await loadRadio(desc, file.name, () => file.name);
  } catch (e) {
    await showError('No se pudo abrir el archivo: ' + e.message);
  } finally {
    setBusy(false);
  }
}

// Guarda bytes en el computador (selector de carpeta si el navegador lo ofrece). Devuelve true si se guardó.
async function saveBytes(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  if (window.showSaveFilePicker) {
    try {
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.img';
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Archivo de radio', accept: { 'application/octet-stream': [ext] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // si falla el selector, se cae a la descarga normal
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

async function saveFile() {
  setBusy(true);
  $('progress').hidden = true;
  try {
    const { name, bytes } = await engine.saveFile();
    if (await saveBytes(name, bytes)) {
      state.dirty = false;
      toast('Archivo guardado: ' + name, true);
    }
  } catch (e) {
    await showError('No se pudo guardar: ' + e.message);
  } finally {
    setBusy(false);
  }
}

async function newCsv() {
  setBusy(true);
  $('progress').hidden = true;
  try {
    await ready();
    await loadRadio(await engine.newCsv(), 'Archivo nuevo', () => `Nuevo CSV · ${stamp()}`);
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(false);
  }
}

// Crea una pestaña de trabajo para un radio recién abierto/descargado y la activa
async function loadRadio(desc, origin, titleFn = () => `${desc.vendor} ${desc.model}`) {
  state.tabSeq += 1;
  const num = state.tabSeq;
  const tab = { id: desc.tab, num, color: PALETTE[(num - 1) % PALETTE.length], title: '', radio: desc,
    dev: 0, features: [], mems: [], dirty: false, settingsLoaded: false, hideDefaultSet: false, selected: new Set(), anchor: null, undoCount: 0, selIndex: null };
  tab.title = titleFn(num);
  // Si el usuario tenía elegido un alias (p. ej. Motorola C1) del mismo driver, se conserva
  const cur = selectedRadio();
  const keepAlias = !!(cur && desc.id && cur.id === desc.id);
  if (desc.id && !keepAlias) selectRadio((r) => r.id === desc.id && !r.alias_of && r.model === desc.model) ||
    selectRadio((r) => r.id === desc.id);
  const shown = keepAlias ? `${cur.vendor} ${radioLabel(cur)}` : `${desc.vendor} ${desc.model}${desc.variant ? ' ' + desc.variant : ''}`;
  $('file-info').textContent = `${origin} · ${shown}`;
  tab.selIndex = $('sel-model').value === '' ? null : Number($('sel-model').value);
  state.tabs.push(tab);
  await activateTab(tab);
  return tab;
}

function renderTabs() {
  const box = $('doc-tabs');
  box.hidden = state.tabs.length === 0;
  box.replaceChildren(...state.tabs.map((t) => {
    const active = state.cur === t;
    const el = h('div', { class: 'doctab' + (active ? ' active' : ''), role: 'tab', 'data-tab-id': t.id, style: `--tabcolor:${t.color}` },
      h('button', { type: 'button', class: 'doctab-main', title: t.title, onclick: () => { if (!state.busy) activateTab(t); } },
        h('span', { class: 'doctab-num', text: `#${t.num}` }),
        h('span', { class: 'doctab-title', text: t.title + (t.dirty ? ' •' : '') })),
      h('button', { type: 'button', class: 'doctab-close', title: 'Cerrar pestaña', 'aria-label': 'Cerrar pestaña', text: '×',
        onclick: () => { if (!state.busy) closeTab(t); } }));
    return el;
  }));
}

async function activateTab(tab) {
  state.cur = tab;
  engine.activeTab = tab.id;
  tab.settingsLoaded = false;
  $('tab-set').replaceChildren();
  if (tab.selIndex != null) selectRadio((r, i) => i === tab.selIndex);
  const d = tab.radio;
  $('bf888-note').hidden = !(d.vendor === 'Baofeng' && d.model === 'BF-888' && !d.variant);
  $('editor').hidden = false;
  renderTabs();
  buildDevTabs();
  await showDevice(tab.dev);
  showTab('mem');
  refreshButtons();
}

async function closeTab(tab) {
  if (tab.dirty && !(await confirmDialog('Cambios sin guardar', [{ title: 'Atención', warn: true,
    text: `La pestaña #${tab.num} tiene cambios sin guardar. Si la cierras, se pierden.` }], 'Cerrar sin guardar'))) return;
  const idx = state.tabs.indexOf(tab);
  try { await engine.closeTab(tab.id); } catch (e) { console.warn(e); }
  state.tabs.splice(idx, 1);
  if (state.cur === tab) {
    state.cur = null;
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) await activateTab(next);
    else { engine.activeTab = null; $('editor').hidden = true; $('mem-table').replaceChildren(); refreshButtons(); }
  }
  renderTabs();
  refreshButtons();
}

// ---------- pestañas ----------
function showTab(name) {
  document.querySelectorAll('#editor > .tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-mem').hidden = name !== 'mem';
  $('tab-set').hidden = name !== 'set';
  if (name === 'set' && !state.settingsLoaded) loadSettings();
}

function buildDevTabs() {
  const box = $('dev-tabs');
  const devs = state.radio.devices;
  box.hidden = devs.length <= 1;
  box.replaceChildren(...devs.map((name, i) =>
    h('button', { type: 'button', class: 'tab' + (i === 0 ? ' active' : ''), text: name, onclick: () => showDevice(i) })));
}

async function showDevice(dev) {
  state.dev = dev;
  [...$('dev-tabs').children].forEach((b, i) => b.classList.toggle('active', i === dev));
  try {
    if (!state.features[dev]) state.features[dev] = await engine.features(dev);
    if (!state.mems[dev]) {
      $('mem-table').replaceChildren(h('caption', { text: 'Leyendo memorias…' }));
      await new Promise((r) => setTimeout(r, 0)); // deja pintar el mensaje
      state.mems[dev] = await engine.memories(dev);
    }
    if (!state.hideDefaultSet) {
      $('hide-empty').checked = state.mems[dev].length > 200;
      state.hideDefaultSet = true;
    }
    renderMemories();
  } catch (e) {
    $('mem-table').replaceChildren(h('caption', { class: 'error', text: 'No se pudieron leer las memorias: ' + e.message }));
    $('mem-count').textContent = '';
    toast('No se pudieron leer las memorias: ' + e.message);
  }
}

// ---------- tabla de memorias ----------
// "Scan": el valor interno sigue siendo '', 'S' o 'P'; solo cambia lo que se muestra
const SKIP_LABELS = { '': 'Sí', S: 'No', P: 'Prioridad' };
const FIELD_LABELS = { freq: 'frecuencia', name: 'nombre', duplex: 'dúplex', offset: 'offset', tmode: 'modo de tono', rtone: 'tono',
  ctone: 'subtono', dtcs: 'DTCS', rx_dtcs: 'DTCS RX', dtcs_polarity: 'polaridad DTCS', cross_mode: 'modo cruzado', mode: 'modo',
  power: 'potencia', skip: 'Scan', empty: 'vacío' };
const fieldLabel = (f) => FIELD_LABELS[f] || f;
const TMODE_LABELS = { '': '(ninguno)', Tone: 'Tono', TSQL: 'TSQL', DTCS: 'DTCS', 'DTCS-R': 'DTCS-R', 'Tone->Tone': 'Tono→Tono', 'Cross': 'Cruzado' };
const DUPLEX_LABELS = { '': '(simplex)' };
const dtcsLabel = (c) => String(c).padStart(3, '0');

// Columnas: key, título, cuándo se muestra
function columnsFor(f) {
  return [
    { key: 'number', title: 'Canal' },
    { key: 'freq', title: 'Frecuencia (MHz)' },
    f.has_name && { key: 'name', title: 'Nombre' },
    f.valid_tmodes.length > 0 && { key: 'tmode', title: 'Tono modo' },
    f.has_ctone || f.valid_tones.length ? { key: 'rtone', title: 'Tono' } : null,
    f.has_ctone && f.valid_tones.length ? { key: 'ctone', title: 'Tono SQL' } : null,
    f.has_dtcs && { key: 'dtcs', title: 'DTCS' },
    f.valid_duplexes.length > 0 && { key: 'duplex', title: 'Dúplex' },
    f.has_offset && { key: 'offset', title: 'Offset' },
    f.has_mode && f.valid_modes.length > 0 && { key: 'mode', title: 'Modo' },
    f.valid_power_levels.length > 0 && { key: 'power', title: 'Potencia' },
    f.valid_skips.length > 0 && { key: 'skip', title: 'Scan' },
    f.has_comment && { key: 'comment', title: 'Comentario' },
    { key: 'del', title: '' },
  ].filter(Boolean);
}

// Lista de opciones [valor, etiqueta] para cada columna con <select>
function optionsFor(key, f) {
  switch (key) {
    case 'tmode': return f.valid_tmodes.map((v) => [v, TMODE_LABELS[v] || v]);
    case 'duplex': return f.valid_duplexes.map((v) => [v, DUPLEX_LABELS[v] ?? v]);
    case 'mode': return f.valid_modes.map((v) => [v, v]);
    case 'power': return f.valid_power_levels.map((v) => [String(v), String(v)]);
    case 'skip': return f.valid_skips.map((v) => [v, SKIP_LABELS[v] ?? v]);
    case 'rtone': case 'ctone': return f.valid_tones.map((v) => [String(v), v.toFixed(1)]);
    case 'dtcs': return f.valid_dtcs_codes.map((v) => [String(v), dtcsLabel(v)]);
    default: return null;
  }
}

// <select> liviano: crea las opciones completas solo al enfocarlo (mil filas × decenas de tonos pesan mucho)
function lazySelect(key, value, opts, onchange) {
  const cur = String(value ?? '');
  const label = (opts.find((o) => o[0] === cur) || [cur, cur])[1];
  const sel = h('select', { 'data-key': key }, h('option', { value: cur, text: label }));
  sel.addEventListener('focus', () => {
    if (sel.dataset.full) return;
    sel.dataset.full = '1';
    const now = sel.value;
    const list = opts.some((o) => o[0] === now) ? opts : [[now, now], ...opts];
    sel.replaceChildren(...list.map(([v, l]) => h('option', { value: v, text: l })));
    sel.value = now;
  });
  sel.addEventListener('mousedown', () => sel.dispatchEvent(new Event('focus')));
  sel.addEventListener('change', onchange);
  return sel;
}

function renderMemories() {
  const dev = state.dev;
  const f = state.features[dev];
  const mems = state.mems[dev];
  if (!f || !mems) return;
  const cols = columnsFor(f);
  const hideEmpty = $('hide-empty').checked;
  const optCache = {};
  for (const c of cols) optCache[c.key] = optionsFor(c.key, f);

  const table = $('mem-table');
  const head = h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { text: c.title }))));
  const body = h('tbody');
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const mem of mems) {
    if (hideEmpty && mem.empty) continue;
    frag.append(buildRow(mem, cols, optCache, f));
    shown++;
  }
  body.append(frag);
  table.replaceChildren(head, body);
  $('mem-count').textContent = `${shown} de ${mems.length} canales`;
}

function buildRow(mem, cols, optCache, f) {
  const tr = h('tr', { class: mem.empty ? 'empty-row' : '' });
  tr.dataset.number = mem.number;
  fillRow(tr, mem, cols, optCache, f);
  return tr;
}

function fillRow(tr, mem, cols, optCache, f) {
  tr._mem = mem;
  tr.className = (mem.empty ? 'empty-row' : '') + (state.cur && state.cur.selected.has(mem.number) ? ' sel' : '');
  const onchange = (e) => commitRow(tr, mem, e.target);
  const cells = cols.map((c) => {
    const td = h('td', { class: 'col-' + c.key });
    const locked = mem.immutable.includes(c.key);
    if (c.key === 'number') {
      td.className = 'num';
      const cb = h('input', { type: 'checkbox', class: 'rowsel', title: 'Seleccionar canal (copiar, pegar)' });
      cb.checked = !!(state.cur && state.cur.selected.has(mem.number));
      let shift = false;
      cb.addEventListener('click', (e) => { shift = e.shiftKey; e.stopPropagation(); });
      cb.addEventListener('change', () => pickRow(mem.number, { shift, toggle: !shift }));
      td.addEventListener('click', (e) => { if (e.target !== cb) pickRow(mem.number, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey }); });
      td.append(cb, ' ' + mem.number + (mem.extd_number ? ` (${mem.extd_number})` : ''));
      td.title = 'Clic: seleccionar · Shift: rango · Cmd/Ctrl: sumar';
    } else if (c.key === 'del') {
      td.append(h('button', { type: 'button', title: 'Borrar canal', text: '✕', disabled: mem.empty,
        onclick: () => deleteRow(tr, mem, cols, optCache, f) }));
    } else if (optCache[c.key]) {
      const sel = lazySelect(c.key, mem[c.key], optCache[c.key], onchange);
      sel.disabled = locked;
      td.append(sel);
    } else {
      const inp = h('input', { type: 'text', 'data-key': c.key, value: mem[c.key] ?? '', disabled: locked,
        maxlength: c.key === 'name' ? f.valid_name_length || null : null,
        spellcheck: 'false', autocomplete: 'off' });
      inp.addEventListener('change', onchange);
      td.append(inp);
    }
    return td;
  });
  tr.replaceChildren(...cells);
  tr._ctx = { cols, optCache, f };
}

const NUMERIC_KEYS = ['rtone', 'ctone', 'dtcs'];

// Construye el objeto completo de la fila y lo envía al motor
async function commitRow(tr, mem, target) {
  const values = { ...mem };
  tr.querySelectorAll('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    values[k] = NUMERIC_KEYS.includes(k) ? Number(el.value) : el.value;
  });
  const dev = state.dev;
  target.disabled = true;
  try {
    const res = await engine.setMemory(dev, values);
    Object.assign(mem, res.memory);
    state.dirty = true;
    renderTabs();
    if (res.warnings && res.warnings.length) toast('Aviso: ' + res.warnings.join('; '), true);
  } catch (e) {
    toast(`Canal ${mem.number}: ${e.message}`);
  }
  const { cols, optCache, f } = tr._ctx;
  fillRow(tr, mem, cols, optCache, f); // refleja el valor real (o revierte si hubo error)
  $('mem-count').textContent = $('mem-count').textContent; // sin cambios
}

async function deleteRow(tr, mem, cols, optCache, f) {
  try {
    Object.assign(mem, await engine.eraseMemory(state.dev, mem.number));
    state.dirty = true;
    if ($('hide-empty').checked) tr.remove();
    else fillRow(tr, mem, cols, optCache, f);
  } catch (e) {
    toast(`No se pudo borrar el canal ${mem.number}: ${e.message}`);
  }
}

// ---------- ajustes ----------
async function loadSettings() {
  const box = $('tab-set');
  box.replaceChildren(h('p', { class: 'muted', text: 'Cargando ajustes…' }));
  try {
    const groups = await engine.settings();
    state.settingsLoaded = true;
    box.className = 'settings';
    box.replaceChildren(...(groups.length
      ? groups.map((g, i) => renderGroup(g, i === 0))
      : [h('p', { class: 'muted', text: 'Este radio no tiene ajustes editables.' })]));
  } catch (e) {
    box.replaceChildren(h('p', { class: 'error', text: 'No se pudieron leer los ajustes: ' + e.message }));
  }
}

function renderGroup(g, open = false) {
  const d = h('details', { open }, h('summary', { text: g.name }));
  for (const s of g.settings) d.append(renderSetting(s));
  for (const sub of g.groups) d.append(renderGroup(sub));
  return d;
}

function renderSetting(s) {
  const vals = h('div', { class: 'set-vals' });
  s.values.forEach((v, index) => vals.append(settingInput(s, v, index)));
  return h('div', { class: 'set-row' }, h('label', { text: s.label || s.name }), vals);
}

function settingInput(s, v, index) {
  let el;
  let read;
  const dis = !v.mutable;
  switch (v.type) {
    case 'bool':
      el = h('input', { type: 'checkbox', disabled: dis });
      el.checked = v.value;
      read = () => el.checked;
      break;
    case 'list':
      el = h('select', { disabled: dis }, ...v.options.map((o) => h('option', { value: o, text: o })));
      el.value = v.value;
      read = () => el.value;
      break;
    case 'int':
      el = h('input', { type: 'number', min: v.min, max: v.max, step: v.step || 1, value: v.value, disabled: dis });
      read = () => parseInt(el.value, 10);
      break;
    case 'float':
      el = h('input', { type: 'number', min: v.min, max: v.max, step: 'any', value: v.value, disabled: dis });
      read = () => parseFloat(el.value);
      break;
    default:
      el = h('input', { type: 'text', value: v.value ?? '', maxlength: v.maxlength || null, disabled: dis });
      read = () => el.value;
  }
  el.addEventListener('change', async () => {
    const value = read();
    if (typeof value === 'number' && Number.isNaN(value)) { toast('Valor no válido'); return; }
    try {
      await engine.setSetting(s.path, value, index);
      state.dirty = true;
    } catch (e) {
      toast(`${s.label || s.name}: ${e.message}`);
      state.settingsLoaded = false;
      loadSettings(); // vuelve a leer los valores reales
    }
  });
  return el;
}


// ---------- seleccionar, copiar y pegar filas ----------
// Los canales copiados se guardan completos en Python (clipCopy) y el texto en columnas con tabuladores
// va al portapapeles del sistema para pegarlo también en Excel/Sheets. Pegar solo escribe canales.
let clip = null;   // { text, count, ready: Promise } de la última copia hecha aquí

function visibleRows() { return [...document.querySelectorAll('#mem-table tbody tr')]; }

function paintSelection() {
  const sel = state.cur ? state.cur.selected : new Set();
  for (const tr of visibleRows()) {
    const on = !!tr._mem && sel.has(tr._mem.number);
    tr.classList.toggle('sel', on);
    const cb = tr.querySelector('input.rowsel');
    if (cb) cb.checked = on;
  }
}

// Clic simple: solo esa fila. Shift: rango desde la última clicada. Cmd/Ctrl: suma o quita la fila.
function pickRow(num, { shift = false, toggle = false } = {}) {
  const t = state.cur;
  if (!t) return;
  if (shift && t.anchor != null) {
    const nums = visibleRows().map((tr) => tr._mem.number);
    const a = nums.indexOf(t.anchor), b = nums.indexOf(num);
    if (a >= 0 && b >= 0) {
      if (!toggle) t.selected.clear();
      for (const n of nums.slice(Math.min(a, b), Math.max(a, b) + 1)) t.selected.add(n);
    }
  } else if (toggle) {
    if (t.selected.has(num)) t.selected.delete(num); else t.selected.add(num);
    t.anchor = num;
  } else {
    t.selected.clear();
    t.selected.add(num);
    t.anchor = num;
  }
  paintSelection();
  refreshButtons();
}

const selectedNumbers = () => (state.cur ? [...state.cur.selected] : []);
const selectedMems = () => {
  const sel = state.cur ? state.cur.selected : new Set();
  return (state.mems[state.dev] || []).filter((m) => sel.has(m.number));
};

// Columnas que se copian/pegan como texto: las de la tabla, sin el botón de borrar
const clipColumns = () => columnsFor(state.features[state.dev]).filter((c) => c.key !== 'del');
const cleanCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

function optionLabel(key, mem, f) {
  const opts = optionsFor(key, f);
  const v = String(mem[key] ?? '');
  const o = opts && opts.find((x) => x[0] === v);
  return o ? o[1] : v;
}

function rowsToTsv(mems) {
  const f = state.features[state.dev];
  const cols = clipColumns();
  return mems.map((m) => cols.map((c) => cleanCell(
    m.empty && c.key !== 'number' ? '' : c.key === 'number' ? m.number : optionLabel(c.key, m, f))).join('\t')).join('\n');
}

// Interpreta texto con tabuladores (p. ej. de Excel) con el mismo orden de columnas de la tabla.
// Devuelve { rows } o { error }. No toca nada del radio.
function parseTsv(text) {
  const f = state.features[state.dev];
  const all = clipColumns();
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { error: 'No hay texto para pegar.' };
  const grid = lines.map((l) => l.split('\t'));
  const n = Math.max(...grid.map((r) => r.length));
  const withNum = grid.every((r) => /^\d+$/.test(r[0].trim()));
  const cols = withNum ? all : all.slice(1);
  if (n > cols.length) {
    return { error: `El texto pegado tiene ${n} columnas y esta tabla espera ${cols.length} (${cols.map((c) => c.title).join(', ')}). ` +
      'Pega las columnas en el mismo orden de la tabla. No se cambió nada.' };
  }
  const rows = [];
  for (let i = 0; i < grid.length; i++) {
    const row = { };
    const cells = grid[i].map((c) => c.trim());
    const get = (key) => { const j = cols.findIndex((c) => c.key === key); return j >= 0 ? (cells[j] ?? '') : ''; };
    if (!get('freq')) { rows.push({ empty: true }); continue; }
    for (let j = 0; j < cols.length; j++) {
      const key = cols[j].key;
      if (key === 'number') continue;
      const raw = cells[j] ?? '';
      const bad = (why) => ({ error: `Fila ${i + 1}, columna «${cols[j].title}»: ${why}. No se cambió nada.` });
      if (key === 'freq' || key === 'offset') {
        if (!raw && key === 'offset') { row.offset = '0'; continue; }
        if (!/^\d+([.,]\d+)?$/.test(raw)) return bad(`«${raw}» no es una frecuencia en MHz`);
        row[key] = raw.replace(',', '.');
      } else if (optionsFor(key, f)) {
        if (raw === '' && key !== 'skip' && key !== 'duplex') continue; // deja el valor por defecto
        const low = raw.toLowerCase();
        const o = optionsFor(key, f).find((x) => x[0].toLowerCase() === low || x[1].toLowerCase() === low ||
          (/^[\d.]+$/.test(raw) && Number(x[0]) === Number(raw)));
        if (!o) return bad(`«${raw}» no es un valor válido`);
        row[key] = NUMERIC_KEYS.includes(key) ? Number(o[0]) : o[0];
      } else {
        row[key] = raw;
      }
    }
    rows.push(row);
  }
  return { rows };
}

// Copia al portapapeles del sistema: con el evento 'copy' (síncrono) o, desde botones, con la API
async function writeSystemClipboard(text, ev) {
  if (ev && ev.clipboardData) { ev.clipboardData.setData('text/plain', text); return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* sin permiso: se prueba el método antiguo */ }
  const ta = h('textarea', { style: 'position:fixed;left:-1000px' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* nada */ }
  ta.remove();
  return ok;
}

async function copyRows(ev = null) {
  const mems = selectedMems();
  if (!state.cur || !mems.length) { toast('Selecciona primero una o varias filas (clic en el número de canal).'); return false; }
  const text = rowsToTsv(mems);
  const nums = mems.map((m) => m.number);
  const entry = { text, count: nums.length, ready: null };
  clip = entry;
  entry.ready = engine.clipCopy(state.dev, nums, state.cur.id).then((r) => {
    entry.count = r.count;
    if (r.ignored) toast(`${r.ignored} canal(es) especial(es) no se copian (solo canales numerados).`);
  }).catch((e) => { if (clip === entry) clip = null; toast('No se pudo copiar: ' + e.message); });
  const sys = await writeSystemClipboard(text, ev);
  await entry.ready;
  if (clip === entry) toast(`${entry.count} ${entry.count === 1 ? 'fila copiada' : 'filas copiadas'}` +
    (sys ? '.' : ' (solo dentro de WebCHIRP: el navegador no dejó usar el portapapeles del sistema).'), true, 2500);
  return true;
}

const normText = (s) => String(s || '').replace(/\r\n?/g, '\n').trim();

// Pega desde la fila seleccionada. clipText: texto del portapapeles del sistema (o null si no se pudo leer)
async function pasteRows(clipText = null) {
  const t = state.cur;
  if (!t || state.busy) return;
  if (!t.selected.size) { toast('Selecciona la fila donde quieres pegar (clic en el número de canal).'); return; }
  const dev = state.dev;
  const f = state.features[dev];
  const nums = [...t.selected].filter((n) => Number.isInteger(n));
  if (!nums.length) { toast('Elige un canal numerado como destino del pegado.'); return; }
  const start = Math.min(...nums);
  if (clip) await clip.ready;
  const external = normText(clipText) && (!clip || normText(clipText) !== normText(clip.text));
  let rows = null, count;
  if (external) {
    const p = parseTsv(clipText);
    if (p.error) { await showError(p.error, 'No se pudo pegar'); return; }
    rows = p.rows;
    count = rows.length;
  } else if (clip && clip.count) {
    count = clip.count;
  } else {
    toast('No hay nada copiado. Selecciona filas y usa «Copiar filas» o Cmd/Ctrl+C.');
    return;
  }
  const hi = f.memory_bounds[1];
  const fit = Math.max(0, Math.min(count, hi - start + 1));
  if (!fit) { toast(`El canal ${start} no está dentro de la memoria de este radio (hasta el ${hi}). No se pegó nada.`); return; }
  const occupied = (state.mems[dev] || []).filter((m) => Number.isInteger(m.number) && m.number >= start && m.number < start + fit && !m.empty).length;
  const cut = fit < count ? `\n\nSolo caben ${fit} de ${count} canales (la memoria llega hasta el canal ${hi}); el resto no se pegará.` : '';
  if (occupied && !(await confirmDialog('Pegar canales', [{ title: `Desde el canal ${start}`, text: `¿Reemplazar ${occupied} ${occupied === 1 ? 'canal' : 'canales'}?${cut}` }], 'Reemplazar'))) return;
  setBusy(true);
  $('progress').hidden = true;
  let res;
  try {
    res = rows ? await engine.pasteRows(dev, start, rows, t.id) : await engine.clipPaste(dev, start, t.id);
    state.mems[dev] = await engine.memories(dev, t.id);
  } catch (e) {
    setBusy(false);
    await showError(e.message, 'No se pudo pegar');
    return;
  }
  t.undoCount++;
  t.dirty = true;
  t.selected = new Set(Array.from({ length: res.pasted }, (_, i) => start + i));
  t.anchor = start;
  setBusy(false);
  renderMemories();
  renderTabs();
  const sm = res.summary || { copied: res.pasted, adjusted: 0, skipped: 0 };
  const parts = [`${res.pasted - sm.skipped} ${res.pasted - sm.skipped === 1 ? 'canal pegado' : 'canales pegados'}`];
  if (sm.adjusted) parts.push(`${sm.adjusted} ajustados`);
  if (sm.skipped) parts.push(`${sm.skipped} sin pegar`);
  let msg = parts.join(', ') + `, desde el canal ${start}.` + (fit < count ? ` Solo cabían ${fit} de ${count}.` : '') + ' Cmd/Ctrl+Z para deshacer.';
  if (res.warnings && res.warnings.length) msg += ' Aviso: ' + res.warnings.join('; ');
  const notes = (res.details || []).filter((d) => d.notes.length);
  if (notes.length) {
    const lines = notes.map((d) => `Canal ${d.number}: ${d.status}${d.notes.length ? ' — ' + d.notes.join('; ') : ''}`);
    await confirmDialog('Pegado con ajustes', [{ title: msg, text: lines.join('\n') }], 'Cerrar', { hideCancel: true });
  } else {
    toast(msg, true, 5000);
  }
}

async function pasteFromButton() {
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch (e) { /* sin permiso: se usa lo copiado dentro de la página */ }
  return pasteRows(text);
}

async function undoPaste() {
  const t = state.cur;
  if (!t || state.busy) return;
  if (!t.undoCount) { toast('No hay ningún pegado para deshacer.'); return; }
  try {
    const r = await engine.undoPaste(t.id);
    t.undoCount--;
    t.dirty = true;
    state.mems[r.device] = await engine.memories(r.device, t.id);
    if (state.cur === t && state.dev === r.device) renderMemories();
    renderTabs();
    refreshButtons();
    toast(`Pegado deshecho (${r.count} canales restaurados).`, true, 3000);
  } catch (e) {
    toast('No se pudo deshacer: ' + e.message);
  }
}

async function deleteSelected() {
  const t = state.cur;
  const mems = selectedMems().filter((m) => !m.empty);
  if (!t || !mems.length) { toast('No hay canales con datos seleccionados.'); return; }
  if (mems.length > 1 && !(await confirmDialog('Borrar canales', [{ title: 'Borrar', text: `¿Borrar ${mems.length} canales?`, warn: true }], 'Borrar'))) return;
  try {
    for (const m of mems) Object.assign(m, await engine.eraseMemory(state.dev, m.number, t.id));
  } catch (e) {
    toast('No se pudo borrar: ' + e.message);
  }
  t.dirty = true;
  renderMemories();
  renderTabs();
}

// Cuando el foco está escribiendo en una celda, Cmd+C/V/Z son los normales del texto
function isEditing(el) {
  if (!el || !el.closest) return false;
  if (el.closest('select, textarea, [contenteditable=""], [contenteditable="true"]')) return true;
  const i = el.closest('input');
  return !!i && !['checkbox', 'radio', 'button'].includes(i.type);
}
const clipboardActive = () => !!state.cur && !$('editor').hidden && !$('tab-mem').hidden && !$('dlg').open;

function hideCtx() { $('ctx-menu').hidden = true; }
function showCtx(x, y) {
  const m = $('ctx-menu');
  const n = state.cur ? state.cur.selected.size : 0;
  m.querySelector('[data-act=copy]').textContent = n > 1 ? `Copiar ${n} filas` : 'Copiar';
  m.querySelector('[data-act=delete]').textContent = n > 1 ? `Borrar ${n} canales` : 'Borrar canal';
  m.hidden = false;
  m.style.left = Math.max(0, Math.min(x, innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = Math.max(0, Math.min(y, innerHeight - m.offsetHeight - 4)) + 'px';
}

function wireClipboard() {
  $('btn-copy-rows').onclick = () => copyRows();
  $('btn-paste').onclick = pasteFromButton;
  $('btn-undo').onclick = undoPaste;
  document.addEventListener('copy', (e) => {
    if (!clipboardActive() || isEditing(e.target) || String(getSelection()) || !state.cur.selected.size) return;
    e.preventDefault();
    copyRows(e);
  });
  document.addEventListener('paste', (e) => {
    if (!clipboardActive() || isEditing(e.target)) return;
    e.preventDefault();
    pasteRows(e.clipboardData ? e.clipboardData.getData('text/plain') : null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtx();
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && clipboardActive() && !isEditing(e.target)) {
      e.preventDefault();
      undoPaste();
    }
  });
  $('mem-table').addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr || !tr._mem) return;
    e.preventDefault();
    if (!state.cur.selected.has(tr._mem.number)) pickRow(tr._mem.number);
    showCtx(e.clientX, e.clientY);
  });
  $('ctx-menu').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    hideCtx();
    if (act === 'copy') copyRows();
    else if (act === 'paste') pasteFromButton();
    else if (act === 'delete') deleteSelected();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu')) hideCtx(); });
  window.addEventListener('scroll', hideCtx, true);
}

// ---------- copiar canales a otro radio ----------
// Copia solo los canales (no los ajustes) usando la lógica de importación de CHIRP, en una pestaña nueva.
// Resume números como rangos: [1,2,3,7] -> "1–3, 7"
function rangesText(nums, max = 12) {
  const out = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return out.length > max ? out.slice(0, max).join(', ') + '…' : out.join(', ') || 'ninguna';
}

// Primera posición donde caben `count` canales seguidos y libres (o null)
function firstFreeRun(mems, lo, hi, count) {
  const busy = new Set(mems.filter((m) => !m.empty && Number.isInteger(m.number)).map((m) => m.number));
  for (let s = lo; s + count - 1 <= hi; s++) {
    let ok = true;
    for (let k = 0; k < count && ok; k++) if (busy.has(s + k)) ok = false;
    if (ok) return s;
  }
  return null;
}

// Diálogo de destino: pestaña (o radio conectado) y posición de inicio con vista previa.
// numbers: canales elegidos (van consecutivos desde la posición) o null (todos, conservando su separación).
async function pickDestination(src, { autoRead = false, numbers = null } = {}) {
  const others = state.tabs.filter((t) => t !== src);
  const sel = selectedRadio();
  const readOpt = sel && state.portName ? `Leer el radio conectado ahora (modelo elegido: ${chosenName(sel)})` : null;
  if (autoRead) return readOpt ? { read: true } : (await showError('Para copiar los canales hay que leer el radio de destino: elige su puerto y su modelo en la lista.', 'Falta el radio de destino'), null);
  const select = h('select', { id: 'copy-dest' },
    ...others.map((t) => h('option', { value: String(t.id), text: `#${t.num} ${t.title}` })),
    ...(readOpt ? [h('option', { value: 'read', text: readOpt })] : []));
  if (!select.options.length) { await showError('No hay otra pestaña abierta ni radio conectado para usar de destino. Lee primero el radio de destino.', 'Falta el destino'); return null; }
  const picked = new Set(numbers || []);
  const used = (src.mems[0] || []).filter((m) => !m.empty && Number.isInteger(m.number) && (!numbers || picked.has(m.number))).sort((x, y) => x.number - y.number);
  const destOf = (start) => used.map((m, i) => ({ m, pos: numbers ? start + i : start + m.number - used[0].number }));
  const info = h('p', { id: 'copy-info', class: 'muted' });
  const startInp = h('input', { id: 'copy-start', type: 'number', min: '0', step: '1', style: 'width:7rem' });
  const posBox = h('div', { id: 'copy-pos' }, info,
    h('label', { text: 'Desde la posición ' }, startInp),
    h('pre', { id: 'copy-preview', style: 'max-height:14rem;overflow:auto' }));
  const cache = {};
  let cur = null, overwrite = 0, valid = false, token = 0;

  const render = () => {
    const prev = $('copy-preview');
    if (!cur) { valid = false; return; }
    const { lo, hi, busy } = cur;
    const start = Number(startInp.value);
    const lines = [];
    let bad = startInp.value === '' || !Number.isInteger(start);
    overwrite = 0;
    if (!bad) {
      for (const { m, pos } of destOf(start)) {
        const fit = pos >= lo && pos <= hi;
        const over = fit && busy.has(pos);
        if (!fit) bad = true;
        if (over) overwrite++;
        lines.push(`Canal ${m.number} (${m.name || 'sin nombre'}) → posición ${pos}` +
          (!fit ? `   ✗ NO CABE: el radio solo llega hasta ${hi}` : over ? '   ⚠ sobrescribe un canal ocupado' : ''));
      }
    }
    if (!used.length) { lines.push('No hay canales con datos para copiar.'); bad = true; }
    if (startInp.value !== '' && !bad && !lines.length) bad = true;
    prev.textContent = (bad && startInp.value === '' ? 'Escribe una posición.' : lines.slice(0, 300).join('\n')) +
      (lines.length > 300 ? `\n… y ${lines.length - 300} más` : '') +
      (bad && lines.length && startInp.value !== '' ? '\n\nCambia la posición para que todos quepan.' : '');
    valid = !bad;
    $('dlg-ok').disabled = !valid;
  };

  const refresh = async () => {
    const my = ++token;
    const isRead = select.value === 'read';
    posBox.hidden = isRead;
    $('dlg-ok').disabled = !isRead;
    if (isRead) { cur = null; return; }
    const id = Number(select.value);
    if (!cache[id]) {
      info.textContent = 'Leyendo el destino…';
      const [f, mems] = await Promise.all([engine.features(0, id), engine.memories(0, id)]);
      cache[id] = { f, mems };
    }
    if (my !== token) return;
    const { f, mems } = cache[id];
    const [lo, hi] = f.memory_bounds;
    const ints = mems.filter((m) => Number.isInteger(m.number));
    const busyList = ints.filter((m) => !m.empty).map((m) => m.number).sort((x, y) => x - y);
    cur = { lo, hi, busy: new Set(busyList) };
    info.textContent = `Este modelo tiene posiciones ${lo}–${hi} (${hi - lo + 1}). Ocupadas: ${busyList.length} (${rangesText(busyList)}). Libres: ${hi - lo + 1 - busyList.length}.`;
    const def = numbers ? firstFreeRun(ints, lo, hi, used.length) : used.length ? used[0].number : lo;
    startInp.value = String(def ?? lo);
    render();
  };
  select.addEventListener('change', refresh);
  startInp.addEventListener('input', render);
  startInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  const title = numbers ? `Copiar ${used.length} ${used.length === 1 ? 'canal seleccionado' : 'canales seleccionados'} de #${src.num} a…` : `Copiar canales de #${src.num} a…`;
  const p = confirmDialog(title, [{ title: 'Destino',
    text: 'Se copian solo los canales (frecuencia, nombre, dúplex/offset, tonos, DTCS, potencia, modo y Scan), sin los ajustes generales. ' +
      'El destino debe venir de una lectura real del radio de destino, para conservar sus ajustes y calibración. ' +
      'El resultado se abre en una pestaña nueva; las originales no se modifican.', node: select }, { title: 'Posición', node: posBox }], 'Copiar');
  refresh().catch((e) => { info.textContent = 'No se pudo leer el destino: ' + e.message; });
  const ok = await p;
  $('dlg-ok').disabled = false;
  if (!ok) return null;
  if (select.value === 'read') return { read: true };
  if (overwrite && !(await confirmDialog('Copiar canales', [{ title: `Desde la posición ${startInp.value}`,
    text: `¿Reemplazar ${overwrite} ${overwrite === 1 ? 'canal' : 'canales'}?`, warn: true }], 'Reemplazar'))) return null;
  return { tab: state.tabs.find((t) => String(t.id) === select.value), start: Number(startInp.value) };
}

async function copyFlow(src, numbers = null, opts = {}) {
  const dest = await pickDestination(src, { ...opts, numbers });
  if (!dest) return;
  let dst = dest.tab;
  if (dest.read) {
    const r = selectedRadio();
    dst = await doRead(r, { offerSave: true });
    if (!dst) return;
  }
  setBusy(true);
  $('progress').hidden = true;
  try {
    await ready();
    const res = await engine.copyChannels(src.id, dst.id, numbers, dest.read ? null : dest.start);
    const when = new Date();
    const t = await loadRadio({ ...res.radio, tab: res.tab }, 'Copia de canales', (num) =>
      `${dst.radio.model}${dst.radio.variant ? ' ' + dst.radio.variant : ''} con canales de #${src.num} · ${stamp(when)}`);
    t.selIndex = dst.selIndex;
    t.dirty = true;
    renderTabs();
    setBusy(false);
    const sm = res.summary;
    const text = `${sm.copied} canales copiados, ${sm.adjusted} ajustados, ${sm.skipped} sin copiar` +
      (sm.dst_channels < sm.src_channels ? `\n(el destino solo tiene ${sm.dst_channels} canales)` : '') +
      `\n\nSe abrió la pestaña #${t.num}. Para ponerla en el radio usa «Grabar #${t.num} en el radio».`;
    const more = await confirmDialog('Canales copiados', [{ title: `Resultado en #${t.num}`, text }], 'Ver detalles', { cancelLabel: 'Cerrar' });
    if (more) {
      const lines = res.details.map((d) => `${d.src != null && d.src !== d.number ? `Canal ${d.src} → posición ${d.number}` : `Canal ${d.number}`}: ${d.status}${d.notes.length ? ' — ' + d.notes.join('; ') : ''}`);
      await confirmDialog('Detalles de la copia', [{ title: `${res.details.length} canales con datos`, text: lines.join('\n') }], 'Cerrar', { hideCancel: true });
    }
  } catch (e) {
    await showError('No se pudieron copiar los canales: ' + e.message);
  } finally {
    setBusy(false);
  }
}

// ---------- detección automática (barrido) ----------
const fmtTime = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

// Diálogo de resultado con tres salidas: usar / seguir buscando / descartar
function scanResultDialog(found, tested, total) {
  const dlg = $('dlg');
  const g = found.group;
  const aliases = engine.aliasesFor(g.members.map((m) => m.id));
  const others = [...aliases.map((a) => a + ' (alias verificado)'),
    ...g.members.filter((m) => m.id !== g.rep_id).slice(0, 12).map((m) => `${m.vendor} ${m.model}${m.variant ? ' ' + m.variant : ''}`)];
  $('dlg-title').textContent = 'Radio detectado';
  $('dlg-ok').textContent = 'Usar este modelo';
  const more = $('dlg-more');
  more.hidden = false;
  $('dlg-body').replaceChildren(
    h('div', { class: 'dlg-sec' }, h('b', { text: `Encontrado: ${found.radio.vendor} ${found.radio.model}${aliases.length ? ' (también ' + aliases.join(', ') + ')' : ''}` }),
      h('pre', { text: `¿Usar este modelo? La memoria del radio ya se leyó y quedó abierta (no se escribió nada).\n` +
        `Protocolo probado ${tested} de ${total}.` +
        (others.length ? `\nComparten protocolo: ${others.join(', ')}${g.members.length > 13 ? '…' : ''}.` : '') })));
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { more.hidden = true; resolve(dlg.returnValue); }, { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

async function scanRadio() {
  if (!(await confirmDialog('Detectar radio (barrido)', [
    { title: 'Antes de empezar', text: 'Enciende el radio, pon el volumen bajo y conecta el cable. ' +
      'El barrido prueba los protocolos uno por uno y SOLO LEE: nunca escribe en el radio. ' +
      'Puede tardar varios minutos. Si tras muchas pruebas fallidas el radio se queda colgado, apágalo y enciéndelo ' +
      '(puedes pausar el barrido para hacerlo).' }], 'Empezar barrido'))) return;
  await ready();
  let scanSaveTab = null;
  state.scanning = true;
  state.paused = false;
  const pauseGate = async () => { while (state.paused) { await new Promise((r) => { state.release = r; }); } };
  const pauseBtn = $('btn-pause');
  pauseBtn.hidden = false;
  pauseBtn.textContent = 'Pausar';
  pauseBtn.onclick = () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? 'Reanudar' : 'Pausar';
    if (!state.paused && state.release) state.release();
  };
  setBusy(true, true);
  engine.bridge.cancelled = false;
  let startAt = 0;
  try {
    for (;;) {
      const res = await engine.scan((p) => {
        lastProgress = performance.now();
        $('progress-bar').style.width = (p.i / p.n) * 100 + '%';
        $('progress-msg').textContent = `Probando ${p.i} de ${p.n}: ${p.group.vendor} ${p.group.model}…` +
          (p.etaMs ? ` · quedan unos ${fmtTime(p.etaMs)}` : '');
      }, { pauseGate, startAt });
      if (res.cancelled) { toast('Detección cancelada'); break; }
      if (!res.found.length) {
        await showError(`No se encontró ningún radio compatible (${res.tested} protocolos probados). Revisa el cable, el puerto y que el radio esté encendido.`, 'Sin resultado');
        break;
      }
      const f = res.found[res.found.length - 1];
      const choice = await scanResultDialog(f, f.index + 1, res.groups);
      if (choice === 'ok') {
        const desc = await engine.acceptProbe(f.group.rep_id);
        const when = new Date();
        const t = await loadRadio(desc, 'Detectado y leído del radio', () => `${desc.vendor} ${desc.model} · ${stamp(when)}`);
        t.readName = `${desc.vendor} ${desc.model}`; t.readWhen = when;
        toast(`Radio detectado: ${desc.vendor} ${desc.model}`, true);
        scanSaveTab = t;
        break;
      }
      if (choice === 'more') { startAt = f.index + 1; continue; }
      break;
    }
  } catch (e) {
    await showError('Error en la detección: ' + e.message);
  } finally {
    state.scanning = false;
    state.paused = false;
    pauseBtn.hidden = true;
    setBusy(false);
  }
  if (scanSaveTab) await offerSaveRead(scanSaveTab);
}

// ---------- registro técnico (sin panel; se baja desde el diálogo de error) ----------
const APP_VERSION = 'WebCHIRP 2026-11-17';

function downloadLog() {
  const sel = selectedRadio();
  const header = [
    `${APP_VERSION} (Pyodide 0.29.0, ${engine.modelCount} modelos en el índice)`,
    `Fecha: ${new Date().toISOString()}`,
    `Navegador: ${navigator.userAgent}`,
    `Modelo elegido: ${sel ? `${sel.vendor} ${radioLabel(sel)} (id ${sel.id})` : '(ninguno)'}`,
    `Archivo/radio abierto: ${state.radio ? `${state.radio.vendor} ${state.radio.model} ${state.radio.variant || ''} (id ${state.radio.id})` : '(ninguno)'}`,
    `Puerto: ${state.portName || '(ninguno)'}  Pestaña visible: ${!document.hidden}`,
    '--- registro ---',
  ];
  const blob = new Blob([header.join('\n') + '\n' + engine.logLines.join('\n') + '\n'], { type: 'text/plain' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'webchirp-registro.txt' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- arranque ----------
function wireEvents() {
  $('btn-port').onclick = choosePort;
  $('btn-read').onclick = readRadio;
  $('btn-scan').onclick = scanRadio;
  $('btn-copy').onclick = () => state.cur && copyFlow(state.cur);
  $('btn-copy-sel').onclick = () => state.cur && copyFlow(state.cur, [...state.cur.selected]);
  $('btn-write').onclick = writeRadio;
  wireClipboard();
  $('btn-slow-cancel').onclick = () => $('btn-cancel').click();
  $('btn-cancel').onclick = () => { engine.cancel(); state.paused = false; if (state.release) state.release(); $('progress-msg').textContent = 'Cancelando…'; };
  $('btn-save').onclick = saveFile;
  $('btn-new').onclick = newCsv;
  $('file-input').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('radio-filter').oninput = () => fillVendors($('sel-vendor').value);
  $('sel-vendor').onchange = () => { fillModels(); };
  $('sel-model').onchange = () => { rememberModel(); refreshButtons(); };
  $('hide-empty').onchange = () => state.radio && renderMemories();
  document.querySelectorAll('#editor > .tabs .tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('drop').hidden = false; });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    openFile(e.dataTransfer.files[0]);
  });
}

function showDisclaimer() {
  if (store.get('aceptado') === '1') return;
  confirmDialog('Aviso importante', aboutSections(), 'Entiendo y acepto')
    .then((ok) => {
      if (ok) store.set('aceptado', '1');
      else { document.body.classList.add('busy'); $('btn-read').disabled = $('btn-write').disabled = true; }
    });
}

async function main() {
  $('compat').hidden = canSerial;
  wireEvents();
  refreshButtons();
  const t0 = performance.now();
  // 1) El motor se descarga en segundo plano (sin importar ningún driver)
  $('engine-status').textContent = 'Preparando motor…';
  enginePromise = engine.load((step) => { $('engine-status').textContent = step; })
    .then(() => {
      state.engineReady = true;
      state.engineMs = Math.round(performance.now() - t0);
      window.webchirpEngineMs = state.engineMs;
      $('engine-status').textContent = 'Motor listo';
      setTimeout(() => { $('engine-status').hidden = true; }, 2500);
      window.webchirpReady = true;
    })
    .catch((e) => {
      $('engine-status').textContent = 'No se pudo preparar el motor: ' + e.message;
      $('engine-status').classList.add('error');
      console.error(e);
      throw e;
    });
  enginePromise.catch(() => {});
  // 2) Marca/Modelo salen del índice estático al instante
  try {
    state.radios = await engine.loadIndex();
  } catch (e) {
    toast(e.message);
    return;
  }
  fillVendors();
  const saved = store.get('model');
  if (saved) selectRadio((r) => radioKey(r) === saved);
  const port = store.get('port');
  if (port) $('port-name').textContent = 'Último usado: ' + port + ' (vuelve a elegirlo)';
  window.webchirpUsableMs = Math.round(performance.now() - t0);
  refreshButtons();
  showDisclaimer();
}

main();
