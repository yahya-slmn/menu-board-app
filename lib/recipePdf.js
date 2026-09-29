// Recipe on Fire -> one-page A4 PDF. The renderer sends plain data (see the shape below); this builds an HTML page
// and prints it with Electron's own PDF engine (webContents.printToPDF), so Arabic / right-to-left names shape and
// order correctly -- a hand-drawn PDF library would not. No PDF dependency; nothing here touches the database.
//
// data = {
//   title, subtitle, dateText,
//   image: { dataUrl } | null,
//   sections: [{ title, rows: [{ label, value, est?, note?, emphasis? }], note? }],   // left to right, top to bottom
//   footnotes: [string],
//   batchRecipe: { target, trays, perTray, totalPortions, trayLabel, cutLabel, trimmingNote, recipe, processes,
//                  portionsProduced, makesLabel?, shapeLabel?, notes? } | undefined   -- Batch Calculator: the scaled
//                  recipe, printed from page 2 (below). A layered batch has a cut; a Shape & Place batch (S4) a shape,
//                  its own "Makes" text (the last tray may be partly filled) and footer notes.
// }
//
// Page 1 is always ONE page (shrunk to fit). A batch adds "Recipe for X portions:" after a page break, at full size, as
// many pages as it takes: built with lib/export.js buildRecipeContentModel -- the Excel recipe view's own model, so the
// numbers, rounding and waste breakdown are the same as the Recipe Calculator's export.

const fs = require('fs/promises');
const { buildRecipeContentModel } = require('./export');
const os = require('os');
const path = require('path');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only a JPEG / PNG data URL is ever put in an <img>; anything else is dropped.
const safeImage = (img) => (img && typeof img.dataUrl === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(img.dataUrl) ? img.dataUrl : null);

function rowHtml(r) {
  const value = `<span class="v" dir="auto">${esc(r.value)}</span>${r.est ? '<span class="est"> est.</span>' : ''}`;
  return `<tr class="${r.emphasis ? 'em' : ''}"><td class="k" dir="auto">${esc(r.label)}</td><td class="val">${value}${r.note ? `<div class="note" dir="auto">${esc(r.note)}</div>` : ''}</td></tr>`;
}
function sectionHtml(s) {
  return `<section><h2>${esc(s.title)}</h2>${s.rows && s.rows.length ? `<table>${s.rows.map(rowHtml).join('')}</table>` : ''}${s.note ? `<p class="snote" dir="auto">${esc(s.note)}</p>` : ''}</section>`;
}

// Excel's quantity format (lib/export.js ingredientQtyNumFmt): one decimal, two under 0.1, none for a whole number.
function fmtQty(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (v === '' || v == null || !Number.isFinite(n) || !/^\s*-?\d*\.?\d+\s*$/.test(String(v))) return String(v ?? '');
  const abs = Math.abs(n), k = abs > 0 && abs < 0.1 ? 100 : 10;
  return String(Math.round(n * k) / k);
}

// The batch's recipe pages from the content model (m) and the batch facts (b).
function batchRecipeHtml(m, b) {
  const h = m.header, L = m.labels;
  const meta = [
    ['Makes', b.makesLabel || `${b.totalPortions} portions: ${b.trays} trays × ${b.perTray}`],
    ['Tray', b.trayLabel], ['Cut', b.cutLabel], ['Shape', b.shapeLabel],
    [L.portionWeight, h.portionWeight !== '' ? `${h.portionWeight} (one piece, finished)` : ''],
    [L.netWeight, h.netWeight], [L.portionsProduced, h.portionsProduced],
    ['Code', h.code], [L.category, h.category], [L.preparedBy, h.preparedBy], [L.date, h.date],
  ].filter(([, v]) => v !== '' && v != null);
  const lines = (blk) => (blk.lines.length ? (blk.numbered ? `<ol>${blk.lines.map(l => `<li dir="auto">${esc(l)}</li>`).join('')}</ol>` : `<p dir="auto">${esc(blk.lines[0])}</p>`) : '');
  const procHtml = (p) => `
    <section class="proc">
      <h3 dir="auto">${esc(p.name)}</h3>
      <table class="ing">
        <thead><tr><th>${esc(L.ingredientsHeader)}</th><th class="q">${esc(L.quantityHeader)}</th><th>${esc(L.unitHeader)}</th><th>${esc(L.noteColumnHeader)}</th></tr></thead>
        <tbody>${p.ingredients.length ? p.ingredients.map(i => `<tr><td dir="auto">${esc(i.name)}</td><td class="q">${esc(fmtQty(i.quantity))}</td><td>${esc(i.unit)}</td><td dir="auto">${esc(i.method)}</td></tr>`).join('')
          : `<tr><td colspan="4">${esc(L.noIngredientsPlaceholder)}</td></tr>`}</tbody>
      </table>
      <table class="tot">
        <tr><td>${esc(L.totalQuantity)}</td><td class="q">${esc(p.totalQuantity)}</td></tr>
        ${p.wastes.map(w => `<tr class="w"><td dir="auto">${esc(w.name)} ${esc(w.percent)}%</td><td class="q">${esc(w.reduced)} → ${esc(w.after)}</td></tr>`).join('')}
        <tr class="net"><td>${esc(L.netWeight)}</td><td class="q">${esc(p.netWeight)}</td></tr>
      </table>
      ${p.method.lines.length ? `<div class="method"><div class="k">${esc(L.methodLabel)}</div>${lines(p.method)}</div>` : ''}
    </section>`;
  return `
<div class="appendix">
  <header>
    <div><h1 dir="auto">Recipe for ${esc(b.target)} portions:</h1><div class="sub" dir="auto">${esc(h.name)}</div></div>
    <div class="date">Whole batch, every tray</div>
  </header>
  <table class="meta">${meta.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td dir="auto">${esc(v)}</td></tr>`).join('')}</table>
  ${m.processes.map(procHtml).join('')}
  <table class="tot all"><tr class="net"><td>${esc(L.totalQuantity)} (all processes)</td><td class="q">${esc(m.totalQuantity)}</td></tr></table>
  ${m.presentation.lines.length ? `<div class="method"><div class="k">${esc(L.presentationDecorationServing)}</div>${lines(m.presentation)}</div>` : ''}
  ${m.comment ? `<div class="method"><div class="k">${esc(L.comment)}</div><p dir="auto">${esc(m.comment)}</p></div>` : ''}
  <footer>${b.trimmingNote ? `<p dir="auto">${esc(b.trimmingNote)}</p>` : ''}${(Array.isArray(b.notes) ? b.notes : []).map(n => `<p dir="auto">${esc(n)}</p>`).join('')}<p>Quantities are for the whole batch: every tray together. Generated by Menu Board · Recipe on Fire.</p></footer>
</div>`;
}

function buildRecipePdfHtml(data, { scale = 1, recipeModel = null } = {}) {
  const img = safeImage(data.image);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(data.title)}</title>
<style>
  @page { size: A4; margin: 11mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 10pt/1.34 -apple-system, "SF Pro Text", "Helvetica Neue", "Geeza Pro", "Arial", sans-serif; color: #1b2a22; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; padding-bottom: 7px; border-bottom: 2px solid #2f5d46; margin-bottom: 9px; }
  h1 { margin: 0; font-size: 19pt; line-height: 1.12; font-weight: 700; unicode-bidi: plaintext; overflow-wrap: anywhere; }
  .sub { margin-top: 2px; color: #55665c; font-size: 9.4pt; unicode-bidi: plaintext; }
  .date { color: #55665c; font-size: 8.8pt; white-space: nowrap; text-align: right; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; align-items: start; }
  .photo { grid-column: 1 / -1; border-radius: 7px; overflow: hidden; background: #1d2a24; }
  .photo img { display: block; width: 100%; height: auto; }
  section { break-inside: avoid; border: 1px solid #d5ddd6; border-radius: 7px; padding: 6px 9px 7px; background: #fbfcfa; }
  h2 { margin: 0 0 3px; font-size: 8.4pt; letter-spacing: .07em; text-transform: uppercase; color: #2f5d46; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1.6px 0; vertical-align: top; }
  td.k { color: #55665c; padding-right: 8px; width: 46%; unicode-bidi: plaintext; }
  td.val { text-align: right; font-variant-numeric: tabular-nums; }
  td.val .v { font-weight: 600; unicode-bidi: plaintext; }
  tr.em td.val .v { color: #a3271c; }
  .est { color: #7a877f; font-size: 8pt; }
  .note { color: #6a776f; font-size: 8pt; font-weight: 400; margin-top: 0; }
  .snote { margin: 4px 0 0; color: #6a776f; font-size: 8.2pt; }
  .wide { grid-column: 1 / -1; }
  footer { margin-top: 9px; padding-top: 6px; border-top: 1px solid #d5ddd6; color: #6a776f; font-size: 8pt; }
  footer p { margin: 0 0 2px; }
  .appendix { break-before: page; }
  .appendix h1 { font-size: 17pt; }
  .appendix table.meta { width: auto; margin: 0 0 8px; }
  .appendix table.meta td { padding: 1px 14px 1px 0; }
  .appendix table.meta td.k { color: #55665c; width: auto; }
  .appendix .proc { break-inside: auto; margin: 0 0 9px; padding: 7px 10px 8px; }
  .appendix h3 { margin: 0 0 4px; font-size: 11pt; color: #2f5d46; unicode-bidi: plaintext; }
  .appendix table.ing th { text-align: left; font-size: 8pt; letter-spacing: .05em; color: #55665c; border-bottom: 1px solid #d5ddd6; padding: 2px 8px 2px 0; }
  .appendix table.ing td { padding: 2px 8px 2px 0; border-bottom: 1px solid #eef2ee; }
  .appendix .q { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .appendix tr { break-inside: avoid; }
  .appendix table.tot { width: auto; min-width: 55%; margin: 5px 0 0 auto; }
  .appendix table.tot td { padding: 1px 0 1px 14px; }
  .appendix table.tot tr.w td { color: #55665c; font-size: 9pt; }
  .appendix table.tot tr.net td { font-weight: 700; border-top: 1px solid #d5ddd6; }
  .appendix table.all { margin-top: 2px; }
  .appendix .method { margin-top: 5px; }
  .appendix .method .k { font-weight: 600; color: #55665c; font-size: 9pt; }
  .appendix .method ol, .appendix .method p { margin: 2px 0 0; padding-left: 18px; }
  .appendix .method p { padding-left: 0; }
${scale < 1 ? `  .page1 { zoom: ${scale}; }\n  ${scale <= 0.84 ? `.photo img { max-height: ${Math.round(64 / scale)}mm; width: auto; margin: 0 auto; }` : ''}` : ''}
</style></head>
<body>
<div class="page1">
<header>
  <div><h1 dir="auto">${esc(data.title)}</h1>${data.subtitle ? `<div class="sub" dir="auto">${esc(data.subtitle)}</div>` : ''}</div>
  <div class="date">${esc(data.dateText)}</div>
</header>
<div class="grid">
  ${img ? `<div class="photo"><img alt="" src="${img}"></div>` : ''}
  ${sections.map((s) => `${s.wide ? '<div class="wide">' : ''}${sectionHtml(s)}${s.wide ? '</div>' : ''}`).join('\n  ')}
</div>
<footer>${(data.footnotes || []).map((f) => `<p dir="auto">${esc(f)}</p>`).join('')}</footer>
</div>${recipeModel && data.batchRecipe ? batchRecipeHtml(recipeModel, data.batchRecipe) : ''}
</body></html>`;
}

// Prints `html` to a PDF buffer in a hidden window with scripting off. The page is written to a temp file (a very
// large data: URL is not reliable to load) and removed afterwards. Returns { pdf: Buffer, pages }.
async function renderPdf(html, BrowserWindow) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rof-pdf-'));
  const file = path.join(dir, 'page.html');
  await fs.writeFile(file, html, 'utf8');
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  try {
    await win.loadFile(file);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    return { pdf, pages };
  } finally {
    win.destroy();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Builds page 1 and prints it at full size; if it runs onto a second page, shrinks it a step at a time (and, from the third
// step, shortens the picture) until it fits on one. Real recipes fit at full size or one step down. A batch's recipe pages
// are then added after it at full size (only page 1 is fitted; the recipe takes the pages it needs).
const FIT_SCALES = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52];
// The batch recipe's content model (null without a batch): the scaled recipe through the Excel view's own builder.
function batchRecipeModel(data) {
  const b = data && data.batchRecipe;
  if (!b || typeof b !== 'object' || !b.recipe || !Array.isArray(b.processes)) return null;
  return buildRecipeContentModel(b.recipe, b.processes, { portionsProduced: b.portionsProduced });
}
async function renderFitPdf(data, BrowserWindow) {
  let out = null, fitted = 1;
  for (const scale of FIT_SCALES) {
    fitted = scale;
    out = await renderPdf(buildRecipePdfHtml(data, { scale }), BrowserWindow);
    if (out.pages <= 1) break;
  }
  const recipeModel = batchRecipeModel(data);
  if (recipeModel) out = await renderPdf(buildRecipePdfHtml(data, { scale: fitted, recipeModel }), BrowserWindow);
  return out;
}

// A file-name-safe version of a title (keeps letters of any script, drops path characters).
const safeFileName = (s) => String(s || 'Recipe on Fire').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recipe on Fire';

module.exports = { buildRecipePdfHtml, renderPdf, renderFitPdf, safeFileName, batchRecipeModel };
