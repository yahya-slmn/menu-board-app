// ============================================================
// Remove the old dish codes (unification phase U1, 2026-10-03). menu_items.rc_code held the kitchen's RC codes (493)
// and, on 1,614 dishes, the literal text "NEW" (a placeholder, not a code). The chef's decision: every dish loses its
// old code now; a dish gets a code again only from its linked Recipe Book recipe (TTY-, phase U3).
//
// planCodeRemoval (pure): every dish with something in rc_code, grouped -- real codes, the "NEW" placeholder, anything
// else -- for the preview and its downloadable list.
// applyCodeRemoval (database passed in, tested with a stand-in): clears the codes in chunks, each dish ONLY if its code
// is still the one the preview read (eq on the old value -- people use the app at the same time), and writes one
// menu_item_code_history row per dish actually cleared, all with one batch id. A dish whose code changed since the
// preview is reported, never cleared.
// ============================================================
const ExcelJS = require('exceljs');

const PLACEHOLDER = 'NEW';

// items: [{ id, name, category_name, sections: [names], rc_code }] -> { entries, groups: { codes, placeholder, other } }
function planCodeRemoval(items) {
  const entries = items
    .filter((it) => it.rc_code != null && String(it.rc_code).trim() !== '')
    .map((it) => {
      const code = String(it.rc_code);
      const kind = code.trim().toUpperCase() === PLACEHOLDER ? 'placeholder' : /^RC/i.test(code.trim()) ? 'code' : 'other';
      return { id: it.id, name: it.name, categoryName: it.category_name || '', sections: it.sections || [], oldCode: code, kind };
    })
    .sort((a, b) => a.id - b.id);
  const of = (kind) => entries.filter((e) => e.kind === kind);
  return { entries, groups: { codes: of('code'), placeholder: of('placeholder'), other: of('other') } };
}

// entries: planCodeRemoval(...).entries. Returns { removed: [id], changed: [{ id, name }], failed: [{ ids, error }],
// historyError, history: the history rows NOT written (only when historyError) }.
async function applyCodeRemoval({ db, entries, who, batchId, chunkSize = 200, parallel = 8 }) {
  // One request per (old code, chunk of dishes): the guard is "rc_code is still exactly this value".
  const byCode = new Map();
  for (const e of entries) {
    if (!byCode.has(e.oldCode)) byCode.set(e.oldCode, []);
    byCode.get(e.oldCode).push(e);
  }
  const jobs = [];
  for (const [code, list] of byCode) for (let i = 0; i < list.length; i += chunkSize) jobs.push({ code, list: list.slice(i, i + chunkSize) });

  const removed = [], changed = [], failed = [], history = [];
  const run = async ({ code, list }) => {
    const ids = list.map((e) => e.id);
    const { data, error } = await db.from('menu_items').update({ rc_code: null }).in('id', ids).eq('rc_code', code).select('id');
    if (error) { failed.push({ ids, error: error.message || String(error) }); return; }
    const done = new Set((data || []).map((r) => r.id));
    for (const e of list) {
      if (done.has(e.id)) {
        removed.push(e.id);
        history.push({ item_id: e.id, item_name: e.name, old_code: e.oldCode, new_code: null, reason: 'rc_removal', batch_id: batchId, changed_by: who || null });
      } else changed.push({ id: e.id, name: e.name });
    }
  };
  for (let i = 0; i < jobs.length; i += parallel) await Promise.all(jobs.slice(i, i + parallel).map(run));

  // History rows not written are handed back (unwritten), so the caller can keep them elsewhere -- an old code is never
  // left recorded nowhere.
  let historyError = null;
  const unwritten = [];
  for (let i = 0; i < history.length; i += 500) {
    const part = history.slice(i, i + 500);
    if (historyError) { unwritten.push(...part); continue; }
    const { error } = await db.from('menu_item_code_history').insert(part);
    if (error) { historyError = error.message || String(error); unwritten.push(...part); }
  }
  return { removed: removed.sort((a, b) => a - b), changed, failed, historyError, history: historyError ? unwritten : [] };
}

// The list she keeps before confirming: every dish and the code it had (one row per dish of the plan).
async function writeCodeRemovalWorkbook(entries, savePath) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Old codes');
  sheet.columns = [
    { header: 'ID', key: 'id', width: 9 }, { header: 'Dish', key: 'name', width: 48 }, { header: 'Category', key: 'category', width: 22 },
    { header: 'Section(s)', key: 'sections', width: 24 }, { header: 'Old code', key: 'code', width: 18 }, { header: 'Kind', key: 'kind', width: 22 },
  ];
  const KIND = { code: 'RC code', placeholder: 'the text "NEW" (no code)', other: 'other' };
  for (const e of entries) sheet.addRow({ id: e.id, name: e.name, category: e.categoryName, sections: e.sections.join(', '), code: e.oldCode, kind: KIND[e.kind] });
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F3E' } };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'F1' };
  await wb.xlsx.writeFile(savePath);
}

module.exports = { planCodeRemoval, applyCodeRemoval, writeCodeRemovalWorkbook, PLACEHOLDER };
