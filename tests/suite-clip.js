// Copiar/pegar filas de canales y posición de destino al copiar canales, en la interfaz real (iframe).
import { record, fetchImg, makeEmu, sleep } from './harness.js';
import { until, loadApp, answer, openInApp, connect, dlgOpen } from './suite-ui.js';

export const SUITE = 'clip';
const S = SUITE;

const tabsOf = (w) => [...w.document.querySelectorAll('#doc-tabs .doctab')].map((el) => ({
  id: Number(el.dataset.tabId), num: el.querySelector('.doctab-num').textContent, title: el.querySelector('.doctab-title').textContent, el,
  active: el.classList.contains('active') }));
const tabByNum = (w, num) => tabsOf(w).find((t) => t.num === num);
async function clickTab(w, num) {
  tabByNum(w, num).el.querySelector('.doctab-main').click();
  await until(() => tabByNum(w, num).active && w.document.querySelectorAll('#mem-table tbody tr').length > 0 &&
    !w.document.body.classList.contains('busy'), 30000, 'pestaña ' + num);
  await sleep(300);
}
function chooseModel(w, vendor, modelText) {
  const d = w.document;
  d.getElementById('radio-filter').value = '';
  const vend = d.getElementById('sel-vendor');
  vend.value = vendor; vend.dispatchEvent(new w.Event('change'));
  const sel = d.getElementById('sel-model');
  sel.value = [...sel.options].find((o) => o.textContent === modelText).value;
  sel.dispatchEvent(new w.Event('change'));
}

const rowOf = (w, n) => w.document.querySelector(`#mem-table tbody tr[data-number="${n}"]`);
const click = (w, n, mods = {}) => rowOf(w, n).querySelector('td.num').dispatchEvent(new w.MouseEvent('click', { bubbles: true, ...mods }));
const selectedRows = (w) => [...w.document.querySelectorAll('#mem-table tbody tr.sel')].map((tr) => Number(tr.dataset.number));
const toastOf = (w) => { const t = w.document.getElementById('toast'); return t.hidden ? '' : t.textContent; };
const mems = (w, tabNum) => w.engine.memories(0, tabByNum(w, tabNum).id);
const byNum = (list) => Object.fromEntries(list.map((m) => [m.number, m]));
const freqOf = (m) => (m && !m.empty ? Number(m.freq) : null);
const settingsOf = async (w, tabNum) => JSON.stringify(await w.engine.settings(tabByNum(w, tabNum).id));

function copyEvent(w, target = null) {
  const dt = new w.DataTransfer();
  const ev = new w.ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
  (target || w.document.body).dispatchEvent(ev);
  return { text: dt.getData('text/plain'), prevented: ev.defaultPrevented };
}
function pasteEvent(w, text, target = null) {
  const dt = new w.DataTransfer();
  dt.setData('text/plain', text);
  const ev = new w.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  (target || w.document.body).dispatchEvent(ev);
  return ev;
}
const undoKey = (w, target = null) => (target || w.document.body).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));

// Espera el final de un pegado: contesta "Reemplazar" si se pide y devuelve lo que se mostró
async function settle(w, { confirm = true } = {}) {
  const out = { confirmText: '', dialog: null, toast: '' };
  const t0 = performance.now();
  for (;;) {
    if (dlgOpen(w)) {
      const title = w.document.getElementById('dlg-title').textContent;
      if (title === 'Pegar canales' || title === 'Copiar canales') {
        out.confirmText = w.document.getElementById('dlg-body').textContent;
        await answer(w, confirm);
        if (!confirm) return out;
      } else {
        out.dialog = await answer(w, true);
        return out;
      }
    } else if (toastOf(w)) { out.toast = toastOf(w); return out; }
    if (performance.now() - t0 > 40000) throw new Error('Tiempo agotado esperando el pegado');
    await sleep(100);
  }
}
// canales con datos en bandas válidas para el BF-888 (para que la copia no dependa de recortes)
const goodOf = (list) => list.filter((m) => !m.empty && Number(m.freq) >= 136 && Number(m.freq) <= 174).map((m) => m.number);
const clearToast = (w) => { w.document.getElementById('toast').hidden = true; };

export async function run() {
  const bf = await fetchImg('Baofeng_BF-888.img');
  const uvImg = await fetchImg('Baofeng_UV-5R.img');
  const rt = await fetchImg('Retevis_RT22.img');
  const w = await loadApp(true);
  const doc = w.document;
  const sysclip = { text: '' };
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true,
    value: { writeText: async (t) => { sysclip.text = t; }, readText: async () => sysclip.text } });

  try {
    await answer(w, true, 'aviso');
    await sleep(200);
    await openInApp(w, 'Baofeng_BF-888.img', bf);                 // #1
    await openInApp(w, 'Baofeng_UV-5R.img', uvImg);               // #2
    chooseModel(w, 'Motorola', 'C1 (compatible con LUITON LT-316)');
    await connect(w, makeEmu('rt22', rt, null, 'LUITON_LT-316'));
    doc.getElementById('btn-read').click();
    await answer(w, true, 'leer C1');
    await answer(w, false, 'guardar lectura C1');                 // #3
    await until(() => tabsOf(w).length === 3, 30000, 'tres pestañas');
    record(S, 'preparación: pestañas #1 BF-888, #2 UV-5R y #3 C1 abiertas', tabsOf(w).map((t) => t.num).join() === '#1,#2,#3', tabsOf(w).map((t) => t.title).join(' | '));
  } catch (e) { record(S, 'preparación', false, e.stack); return; }

  const uv = tabByNum(w, '#2');
  await clickTab(w, '#2');
  const uvm = await mems(w, '#2');
  const ne = uvm.filter((m) => !m.empty).map((m) => m.number);
  const em = uvm.filter((m) => m.empty).map((m) => m.number);
  const heads = [...doc.querySelectorAll('#mem-table th')].map((x) => x.textContent).filter((x) => x !== '');
  record(S, 'la tabla UV-5R tiene canales con datos y vacíos para probar', ne.length >= 6 && em.length >= 10, `${ne.length} con datos, ${em.length} vacíos`);

  // 1. Selección con clic, Shift y Cmd/Ctrl
  try {
    click(w, ne[0]);
    record(S, 'clic en el número selecciona solo esa fila (resaltada)', selectedRows(w).join() === String(ne[0]) && rowOf(w, ne[0]).classList.contains('sel') && rowOf(w, ne[0]).querySelector('.rowsel').checked);
    click(w, 1);
    click(w, 3, { shiftKey: true });
    record(S, 'Shift+clic selecciona un rango', selectedRows(w).join() === '1,2,3', selectedRows(w).join());
    click(w, 6, { metaKey: true });
    record(S, 'Cmd+clic suma una fila', selectedRows(w).join() === '1,2,3,6', selectedRows(w).join());
    click(w, 2, { ctrlKey: true });
    record(S, 'Ctrl+clic sobre una fila seleccionada la quita', selectedRows(w).join() === '1,3,6', selectedRows(w).join());
    rowOf(w, 8).querySelector('.rowsel').click();
    record(S, 'la casilla del inicio de la fila también selecciona', selectedRows(w).includes(8), selectedRows(w).join());
    record(S, 'con filas seleccionadas se habilitan "Copiar filas" y "Pegar"', !doc.getElementById('btn-copy-rows').disabled && !doc.getElementById('btn-paste').disabled);
  } catch (e) { record(S, 'selección de filas', false, e.stack); }

  // 2. Copiar 1 fila y pegar en otra, misma pestaña; TSV al portapapeles; deshacer
  const m0 = byNum(uvm);
  try {
    click(w, ne[0]);
    const c = copyEvent(w);
    const fields = c.text.split('\n')[0].split('\t');
    record(S, 'Cmd+C pone en el portapapeles una línea con columnas separadas por tabulador (sin encabezados)',
      c.prevented && c.text.split('\n').length === 1 && fields.length === heads.length && fields[0] === String(ne[0]) && Number(fields[1]) === Number(m0[ne[0]].freq), `${fields.length} columnas de ${heads.length}: ${c.text.slice(0, 70)}`);
    await sleep(500);
    click(w, em[0]);
    clearToast(w);
    pasteEvent(w, c.text);
    const r = await settle(w);
    const after = byNum(await mems(w, '#2'));
    record(S, 'copiar 1 fila y pegarla en otra de la misma pestaña (destino vacío: sin confirmación)', !r.confirmText && freqOf(after[em[0]]) === freqOf(m0[ne[0]]) && after[em[0]].name === m0[ne[0]].name, `${r.toast}`);
    record(S, 'tras pegar la pestaña queda marcada como modificada', /•$/.test(tabByNum(w, '#2').title) && !/•$/.test(tabByNum(w, '#3').title));
    record(S, 'la fila de origen no cambia', freqOf(after[ne[0]]) === freqOf(m0[ne[0]]));
    undoKey(w);
    await until(() => toastOf(w).includes('deshecho'), 20000, 'deshacer');
    const un = byNum(await mems(w, '#2'));
    record(S, 'Cmd+Z deshace el último pegado', un[em[0]].empty === true, `canal ${em[0]} vacío: ${un[em[0]].empty}`);
  } catch (e) { record(S, 'copiar 1 fila y pegar', false, e.stack); }

  // 3. Varias filas con Shift (rango con huecos), pegar en orden, confirmación al sobrescribir y deshacer en 2 niveles
  try {
    const a = ne[0];
    click(w, a);
    click(w, a + 2, { shiftKey: true });
    const sel3 = selectedRows(w);
    const c = copyEvent(w);
    record(S, 'varias filas con Shift: el texto tiene una línea por fila', c.text.split('\n').length === 3 && sel3.length === 3, sel3.join());
    await sleep(500);
    const dst = em[3];            // se pegan dst, dst+1, dst+2 (vacíos si hay hueco; si no, pide confirmar)
    click(w, dst);
    pasteEvent(w, c.text);
    await settle(w);
    const p1 = byNum(await mems(w, '#2'));
    const ok1 = [0, 1, 2].every((i) => freqOf(p1[dst + i]) === freqOf(m0[a + i]));
    record(S, 'pegar varias filas respeta el orden desde la fila destino', ok1, [0, 1, 2].map((i) => `${dst + i}:${p1[dst + i].freq}`).join(' '));
    // segundo pegado encima: 1 fila (la última con datos) en dst -> pide confirmar
    click(w, ne[ne.length - 1]);
    const c2 = copyEvent(w);
    await sleep(500);
    click(w, dst);
    clearToast(w);
    pasteEvent(w, c2.text);
    const rNo = await settle(w, { confirm: false });
    const pNo = byNum(await mems(w, '#2'));
    record(S, 'al sobrescribir pide confirmar: "¿Reemplazar 1 canal?"', /¿Reemplazar 1 canal\?/.test(rNo.confirmText), rNo.confirmText.slice(0, 80));
    record(S, 'cancelar la confirmación no cambia nada', freqOf(pNo[dst]) === freqOf(m0[a]));
    clearToast(w);
    pasteEvent(w, c2.text);
    await settle(w);
    const pYes = byNum(await mems(w, '#2'));
    record(S, 'aceptar reemplaza el canal', freqOf(pYes[dst]) === freqOf(m0[ne[ne.length - 1]]));
    // varias filas encima de ocupadas: confirmación con el total
    click(w, dst);
    click(w, dst + 2, { shiftKey: true });
    const c3 = copyEvent(w);
    await sleep(500);
    click(w, dst);
    clearToast(w);
    pasteEvent(w, c3.text);
    const r3 = await settle(w);
    record(S, 'pegar 3 filas sobre filas con datos pide "¿Reemplazar N canales?" (N = las ocupadas: 2, la tercera está vacía)', /¿Reemplazar 2 canales\?/.test(r3.confirmText), r3.confirmText.slice(0, 80));
    // deshacer 3 niveles: vuelve a lo anterior en cada paso
    undoKey(w);
    await until(() => toastOf(w).includes('deshecho'), 20000, 'deshacer 1');
    const u1 = byNum(await mems(w, '#2'));
    record(S, 'deshacer (nivel 1) restaura el estado previo al último pegado', freqOf(u1[dst]) === freqOf(m0[ne[ne.length - 1]]));
    clearToast(w);
    undoKey(w);
    await until(() => toastOf(w).includes('deshecho'), 20000, 'deshacer 2');
    const u2 = byNum(await mems(w, '#2'));
    record(S, 'deshacer (nivel 2) restaura el pegado anterior', freqOf(u2[dst]) === freqOf(m0[a]));
    clearToast(w);
    undoKey(w);
    await until(() => toastOf(w).includes('deshecho'), 20000, 'deshacer 3');
    const u3 = byNum(await mems(w, '#2'));
    record(S, 'deshacer (nivel 3) deja los destinos como al inicio', [0, 1, 2].every((i) => u3[dst + i].empty === m0[dst + i].empty && freqOf(u3[dst + i]) === freqOf(m0[dst + i])));
  } catch (e) { record(S, 'varias filas, sobrescribir y deshacer', false, e.stack); }

  // 4. Editar celdas sigue funcionando (y Cmd+C dentro de una celda no copia filas)
  try {
    click(w, ne[1]);
    const inp = rowOf(w, ne[1]).querySelector('[data-key=freq]');
    const sBefore = selectedRows(w).join();
    inp.focus();
    inp.value = '146.550';
    inp.dispatchEvent(new w.Event('change'));
    await sleep(1200);
    const e1 = byNum(await mems(w, '#2'))[ne[1]];
    record(S, 'editar una celda sigue funcionando', Math.abs(Number(e1.freq) - 146.55) < 1e-6, e1.freq);
    record(S, 'editar una celda no cambia la selección de filas', selectedRows(w).join() === sBefore);
    const cc = copyEvent(w, rowOf(w, ne[1]).querySelector('[data-key=freq]'));
    record(S, 'Cmd+C dentro de una celda no se intercepta (copia de texto normal)', !cc.prevented && cc.text === '');
    const pv = pasteEvent(w, 'x', rowOf(w, ne[1]).querySelector('[data-key=freq]'));
    record(S, 'Cmd+V dentro de una celda no se intercepta', !pv.defaultPrevented);
  } catch (e) { record(S, 'editar celdas', false, e.stack); }

  // 5. Texto con tabuladores desde Excel
  try {
    click(w, ne[0]);
    const line = copyEvent(w).text.split('\n')[0].split('\t');
    await sleep(500);
    const iName = heads.indexOf('Nombre');
    const f1 = line.slice(); f1[1] = '145.500'; f1[iName] = 'EXCEL';
    click(w, em[5]);
    clearToast(w);
    pasteEvent(w, f1.join('\t') + '\n');
    await settle(w);
    let ms = byNum(await mems(w, '#2'));
    record(S, 'pegar texto con tabuladores (mismo orden de columnas, con número) lo interpreta', Math.abs(Number(ms[em[5]].freq) - 145.5) < 1e-6 && ms[em[5]].name === 'EXCEL', `${ms[em[5]].freq} ${ms[em[5]].name}`);
    click(w, em[6]);
    clearToast(w);
    pasteEvent(w, f1.slice(1).join('\t'));
    await settle(w);
    ms = byNum(await mems(w, '#2'));
    record(S, 'también acepta las columnas sin el número de canal', Math.abs(Number(ms[em[6]].freq) - 145.5) < 1e-6 && ms[em[6]].name === 'EXCEL');
    // errores: no cambia nada
    const before = JSON.stringify(await mems(w, '#2'));
    const bad = async (text, re, label) => {
      click(w, em[8]);
      pasteEvent(w, text);
      await until(() => dlgOpen(w), 20000, 'aviso de pegado');
      const r = await answer(w, true);
      const same = JSON.stringify(await mems(w, '#2')) === before;
      record(S, label, r.title === 'No se pudo pegar' && re.test(r.text) && same, `${r.title}: ${r.text.slice(0, 110)}`);
    };
    await bad('hola mundo', /no es una frecuencia/, 'texto que no es de canales: aviso claro y no cambia nada');
    await bad(line.concat(['a', 'b', 'c']).join('\t'), /columnas/, 'columnas de más: aviso claro y no cambia nada');
    const g = line.slice(); g[1] = '1.000';
    await bad(f1.join('\t') + '\n' + g.join('\t'), /No se cambió nada/, 'segunda fila inválida (fuera de banda): se revierte todo, incluida la primera');
    const g2 = line.slice(); g2[heads.indexOf('Modo')] = 'ZZZ';
    await bad(g2.join('\t'), /no es un valor válido/, 'valor desconocido en una columna de opciones: aviso y no cambia nada');
  } catch (e) { record(S, 'pegar desde Excel', false, e.stack); }

  // 6. Botones y menú contextual (portapapeles simulado)
  try {
    click(w, ne[2]);
    doc.getElementById('btn-copy-rows').click();
    await until(() => toastOf(w).includes('copiada'), 20000, 'toast de copiar');
    record(S, 'el botón "Copiar filas" deja el texto en el portapapeles del sistema', sysclip.text.split('\t')[0] === String(ne[2]), sysclip.text.slice(0, 60));
    click(w, em[9]);
    clearToast(w);
    doc.getElementById('btn-paste').click();
    await settle(w);
    let ms = byNum(await mems(w, '#2'));
    record(S, 'el botón "Pegar" pega en la fila seleccionada', freqOf(ms[em[9]]) === freqOf(m0[ne[2]]));
    // menú contextual
    const tr = rowOf(w, em[9]);
    tr.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    const menu = doc.getElementById('ctx-menu');
    record(S, 'clic derecho sobre la fila abre el menú Copiar / Pegar / Borrar canal', !menu.hidden &&
      [...menu.querySelectorAll('button')].map((b) => b.textContent).join('|') === 'Copiar|Pegar|Borrar canal', [...menu.querySelectorAll('button')].map((b) => b.textContent).join('|'));
    menu.querySelector('[data-act=delete]').click();
    await sleep(1200);
    ms = byNum(await mems(w, '#2'));
    record(S, 'menú > Borrar canal vacía la fila', ms[em[9]].empty === true && menu.hidden);
    click(w, ne[3]);
    rowOf(w, em[9]).dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    record(S, 'clic derecho sobre una fila no seleccionada la selecciona', selectedRows(w).join() === String(em[9]));
    menu.querySelector('[data-act=copy]').click();
    await until(() => toastOf(w).includes('copiada'), 20000, 'copiar desde menú');
    record(S, 'menú > Copiar deja la fila en el portapapeles', sysclip.text.split('\t')[0] === String(em[9]));
  } catch (e) { record(S, 'botones y menú contextual', false, e.stack); }

  // 7. Entre pestañas de modelos distintos: C1 -> BF-888 (compatibilidad, sin ajustes)
  try {
    await clickTab(w, '#3');
    const c1 = await mems(w, '#3');
    const c1ne = c1.filter((m) => !m.empty).map((m) => m.number);
    const c1set = await settingsOf(w, '#3');
    click(w, c1ne[0]);
    click(w, c1ne[1], { metaKey: true });
    const cp = copyEvent(w);
    await sleep(500);
    await clickTab(w, '#1');
    const bfSet = await settingsOf(w, '#1');
    const bfBefore = byNum(await mems(w, '#1'));
    click(w, 5);
    clearToast(w);
    pasteEvent(w, cp.text);
    const r = await settle(w);
    const bfAfter = byNum(await mems(w, '#1'));
    const src = byNum(c1);
    const dests = [5, 6];
    const srcs = [c1ne[0], c1ne[1]];
    const okMap = dests.every((d, i) => {
      const s = src[srcs[i]], t = bfAfter[d];
      if (r.dialog && /no copiado/.test(r.dialog.text) && freqOf(t) !== freqOf(s)) return freqOf(t) === freqOf(bfBefore[d]); // no cupo: queda lo anterior
      return !t.empty && Math.abs(Number(t.freq) - Number(s.freq)) < 1e-6 && s.name.startsWith(t.name);
    });
    record(S, 'pegar filas del C1 en un BF-888 (otra pestaña, otro modelo): consecutivas desde la fila elegida', okMap, `${srcs.map((n) => src[n].freq)} -> ${dests.map((n) => bfAfter[n].freq)} ${r.dialog ? r.dialog.text.slice(0, 80) : r.toast}`);
    record(S, 'los ajustes del BF-888 no cambian al pegar canales del C1', (await settingsOf(w, '#1')) === bfSet && bfSet.length > 100);
    record(S, 'la pestaña de origen (C1) no cambia ni se marca como modificada', (await settingsOf(w, '#3')) === c1set && !/•$/.test(tabByNum(w, '#3').title) && JSON.stringify(await mems(w, '#3')) === JSON.stringify(c1));
    record(S, 'el BF-888 queda marcado como modificado (sin grabar nada al radio)', /•$/.test(tabByNum(w, '#1').title));
    // nombres largos / compatibilidad: desde el UV-5R (nombres de hasta 7 y tonos) con aviso de ajustes si hace falta
    // Pasarse del final: 3 filas del UV-5R en la fila 15 del BF-888 (16 canales)
    await clickTab(w, '#2');
    const good = goodOf(uvm);
    click(w, good[0]); click(w, good[1], { metaKey: true }); click(w, good[2], { metaKey: true });
    const c3 = copyEvent(w);
    await sleep(500);
    await clickTab(w, '#1');
    click(w, 15);
    clearToast(w);
    pasteEvent(w, c3.text);
    const rr = await settle(w);
    const end = byNum(await mems(w, '#1'));
    const txt = rr.confirmText + ' ' + (rr.dialog ? rr.dialog.title + rr.dialog.text : rr.toast);
    record(S, 'pegar más allá del final avisa que solo caben 2 de 3', /Solo cab(en|ían) 2 de 3/.test(txt), txt.slice(0, 160));
    record(S, 'solo se pegan los que caben (15 y 16) y no se crea el 17', Math.abs(Number(end[15].freq) - Number(byNum(uvm)[good[0]].freq)) < 1e-6 && !end[17], `${end[15].freq} ${end[16].freq}`);
    let err = '';
    try { await w.engine.clipPaste(0, 17, tabByNum(w, '#1').id); } catch (e) { err = e.message; }
    record(S, 'pegar con destino fuera de la memoria da error claro y no cambia nada', /no existe/.test(err), err);
  } catch (e) { record(S, 'pegar entre modelos / más allá del final', false, e.stack); }

  // 8. "Copiar canales seleccionados a…" con posición de destino
  async function openCopyDialog(w, destNum) {
    doc.getElementById('btn-copy-sel').click();
    await until(() => dlgOpen(w), 30000, 'diálogo copiar');
    const sel = doc.getElementById('copy-dest');
    sel.value = [...sel.options].find((o) => o.textContent.startsWith(destNum + ' ')).value;
    sel.dispatchEvent(new w.Event('change'));
    await until(() => doc.getElementById('copy-start').value !== '' && !/Leyendo/.test(doc.getElementById('copy-info').textContent), 30000, 'datos del destino');
  }
  const setStart = (w, v) => { const i = doc.getElementById('copy-start'); i.value = String(v); i.dispatchEvent(new w.Event('input')); };
  const okBtn = () => doc.getElementById('dlg-ok');
  const finishCopy = async () => {   // acepta, confirma reemplazo si lo pide y cierra el resumen
    okBtn().click();
    let confirm = '';
    for (;;) {
      await until(() => dlgOpen(w), 60000, 'diálogo tras copiar');
      const title = doc.getElementById('dlg-title').textContent;
      if (title === 'Copiar canales') { confirm = doc.getElementById('dlg-body').textContent; await answer(w, true); continue; }
      await answer(w, false);
      return confirm;
    }
  };
  try {
    await clickTab(w, '#2');
    for (const n of [11, 12, 13]) await w.engine.eraseMemory(0, n, tabByNum(w, '#1').id);   // hueco de 3 en el BF-888
    const bf0 = byNum(await mems(w, '#1'));
    const freeRun = (list, k) => { for (let s = 1; s + k - 1 <= 16; s++) if ([...Array(k)].every((_, i) => list[s + i].empty)) return s; return null; };
    // 8a. un canal -> posición exacta
    click(w, goodOf(uvm)[0]);
    await openCopyDialog(w, '#1');
    const info = doc.getElementById('copy-info').textContent;
    record(S, 'el diálogo muestra el rango del modelo destino y ocupadas/libres', /1–16/.test(info) && /Ocupadas: \d+/.test(info) && /Libres: \d+/.test(info), info);
    const def1 = freeRun(bf0, 1);
    record(S, 'valor por defecto: primera posición libre donde cabe', Number(doc.getElementById('copy-start').value) === (def1 ?? 1), `${doc.getElementById('copy-start').value} (esperado ${def1})`);
    setStart(w, 9);
    const prev = doc.getElementById('copy-preview').textContent;
    record(S, 'vista previa línea por línea: "Canal N (nombre) → posición 9"', new RegExp(`^Canal ${goodOf(uvm)[0]} \\(.*\\) → posición 9`).test(prev), prev.slice(0, 100));
    const nTabs = tabsOf(w).length;
    const conf = await finishCopy();
    record(S, bf0[9].empty ? 'copiar 1 canal a la posición 9 (libre) sin pedir reemplazo' : 'copiar 1 canal a la posición 9 (ocupada) pide "¿Reemplazar 1 canal?"', bf0[9].empty ? conf === '' : /¿Reemplazar 1 canal\?/.test(conf), conf.slice(0, 60));
    await until(() => tabsOf(w).length === nTabs + 1, 30000, 'pestaña nueva');
    const nt = tabsOf(w)[tabsOf(w).length - 1];
    const nm = byNum(await w.engine.memories(0, nt.id));
    record(S, '1 canal va exactamente a la posición elegida (9) y el resto del destino queda igual',
      Math.abs(Number(nm[9].freq) - Number(byNum(uvm)[goodOf(uvm)[0]].freq)) < 1e-6 && [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 16].every((n) => freqOf(nm[n]) === freqOf(bf0[n])), `${nm[9].freq}`);
    record(S, 'el destino original (#1) no se modificó con la copia', JSON.stringify(await mems(w, '#1')) === JSON.stringify(Object.values(bf0)));
    // 8b. 3 canales -> consecutivos en orden
    await clickTab(w, '#2');
    const g = goodOf(uvm);
    const uvNow = byNum(await mems(w, '#2'));
    click(w, g[0]); click(w, g[1], { metaKey: true }); click(w, g[2], { metaKey: true });
    await openCopyDialog(w, '#1');
    const def3 = freeRun(bf0, 3);
    record(S, 'valor por defecto con 3 canales: primer hueco con 3 libres seguidos', Number(doc.getElementById('copy-start').value) === (def3 ?? 1), `${doc.getElementById('copy-start').value} (esperado ${def3})`);
    setStart(w, 4);
    const lines = doc.getElementById('copy-preview').textContent.split('\n').filter((l) => l.startsWith('Canal'));
    record(S, 'vista previa de 3 canales en posiciones 4, 5, 6 y en el orden del origen', lines.length === 3 && lines.every((l, i) => l.startsWith(`Canal ${g[i]} `) && l.includes(`→ posición ${4 + i}`)), lines.join(' / ').slice(0, 200));
    record(S, 'si sobrescribe canales ocupados la vista previa lo marca', (bf0[4].empty && bf0[5].empty && bf0[6].empty) || /sobrescribe/.test(doc.getElementById('copy-preview').textContent));
    setStart(w, 15);
    record(S, 'pasarse del final: la vista previa avisa "NO CABE" y no deja confirmar', /NO CABE/.test(doc.getElementById('copy-preview').textContent) && okBtn().disabled);
    setStart(w, 14);
    record(S, 'corregir la posición (14, 15, 16) vuelve a permitir confirmar', !okBtn().disabled && !/NO CABE/.test(doc.getElementById('copy-preview').textContent));
    setStart(w, 4);
    const nTabs2 = tabsOf(w).length;
    const conf2 = await finishCopy();
    const anyBusy = [4, 5, 6].filter((n) => !bf0[n].empty).length;
    record(S, 'sobrescribir canales ocupados pide una confirmación "¿Reemplazar N canales?"', anyBusy ? new RegExp(`¿Reemplazar ${anyBusy} (canal|canales)\\?`).test(conf2) : conf2 === '', `${anyBusy} ocupados; "${conf2.slice(0, 50)}"`);
    await until(() => tabsOf(w).length === nTabs2 + 1, 30000, 'pestaña nueva 2');
    const nt2 = tabsOf(w)[tabsOf(w).length - 1];
    const nm2 = byNum(await w.engine.memories(0, nt2.id));
    record(S, '3 canales quedan consecutivos en 4, 5, 6 con el mismo orden del origen',
      [0, 1, 2].every((i) => Math.abs(Number(nm2[4 + i].freq) - Number(uvNow[g[i]].freq)) < 1e-6), [4, 5, 6].map((n) => nm2[n].freq).join(' '));
    // 8c. C1 -> BF-888 con posición, sin ajustes
    await clickTab(w, '#3');
    const c1 = await mems(w, '#3');
    const c1ne = c1.filter((m) => !m.empty).map((m) => m.number);
    click(w, c1ne[0]);
    await openCopyDialog(w, '#1');
    setStart(w, 3);
    const nTabs3 = tabsOf(w).length;
    await finishCopy();
    await until(() => tabsOf(w).length === nTabs3 + 1, 30000, 'pestaña nueva 3');
    const nt3 = tabsOf(w)[tabsOf(w).length - 1];
    const nm3 = byNum(await w.engine.memories(0, nt3.id));
    const srcC = byNum(c1)[c1ne[0]];
    record(S, 'C1 → BF-888: el canal queda en la posición 3 con su frecuencia', Math.abs(Number(nm3[3].freq) - Number(srcC.freq)) < 1e-6 && srcC.name.startsWith(nm3[3].name), `${srcC.freq} -> ${nm3[3].freq}`);
    record(S, 'C1 → BF-888: no se copian ajustes (los del BF-888 quedan iguales)', JSON.stringify(await w.engine.settings(nt3.id)) === (await settingsOf(w, '#1')));
  } catch (e) { record(S, 'copiar canales con posición de destino', false, e.stack); }

  record(S, 'sin errores de JavaScript en la página', w.__errs.length === 0, JSON.stringify(w.__errs).slice(0, 300));
}
