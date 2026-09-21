// Recipe on Fire -> one-page A4 PDF. The renderer sends plain data (see the shape below); this builds an HTML page
// and prints it with Electron's own PDF engine (webContents.printToPDF), so Arabic / right-to-left names shape and
// order correctly -- a hand-drawn PDF library would not. No PDF dependency; nothing here touches the database.
//
// data = {
//   title, subtitle, dateText,
//   image: { dataUrl } | null,
//   sections: [{ title, rows: [{ label, value, est?, note?, emphasis? }], note? }],   // left to right, top to bottom
//   footnotes: [string],
// }

const fs = require('fs/promises');
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

function buildRecipePdfHtml(data, { scale = 1 } = {}) {
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
${scale < 1 ? `  body { zoom: ${scale}; }\n  ${scale <= 0.84 ? `.photo img { max-height: ${Math.round(64 / scale)}mm; width: auto; margin: 0 auto; }` : ''}` : ''}
</style></head>
<body>
<header>
  <div><h1 dir="auto">${esc(data.title)}</h1>${data.subtitle ? `<div class="sub" dir="auto">${esc(data.subtitle)}</div>` : ''}</div>
  <div class="date">${esc(data.dateText)}</div>
</header>
<div class="grid">
  ${img ? `<div class="photo"><img alt="" src="${img}"></div>` : ''}
  ${sections.map((s) => `${s.wide ? '<div class="wide">' : ''}${sectionHtml(s)}${s.wide ? '</div>' : ''}`).join('\n  ')}
</div>
<footer>${(data.footnotes || []).map((f) => `<p dir="auto">${esc(f)}</p>`).join('')}</footer>
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

// Builds the page and prints it at full size; if it runs onto a second page, shrinks everything a step at a time (and, from
// the third step, shortens the picture) until it fits on one. Real recipes fit at full size or one step down.
const FIT_SCALES = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52];
async function renderFitPdf(data, BrowserWindow) {
  let out = null;
  for (const scale of FIT_SCALES) {
    out = await renderPdf(buildRecipePdfHtml(data, { scale }), BrowserWindow);
    if (out.pages <= 1) break;
  }
  return out;
}

// A file-name-safe version of a title (keeps letters of any script, drops path characters).
const safeFileName = (s) => String(s || 'Recipe on Fire').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recipe on Fire';

module.exports = { buildRecipePdfHtml, renderPdf, renderFitPdf, safeFileName };
