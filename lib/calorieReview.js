// ============================================================
// One-time calorie review (2026-09-25): export every ACTIVE Daycare / KG-LP / MS-UP dish to Excel for a
// researcher to look up real calories, then import the reviewed values back. No AI anywhere.
//
// Export: one row per dish (a dish in several sections is one row, "Section(s)" lists them), sorted by
// its first section (Daycare, KG-LP, MS-UP), then the app's category order, then name. Columns (read
// back by HEADER NAME, so reordering / extra columns are fine): ID | Item name | Category | Section(s) |
// Current calories per 100g | Reviewed calories per 100g | Notes.
//
// Import: planCalorieImport() matches each row by ID AND checks the name still belongs to that ID
// (guards against shifted / pasted-over rows); only rows with a Reviewed value change anything; bad
// numbers, unknown IDs, name mismatches and conflicting duplicate IDs are skipped with a reason. The
// renderer shows that plan; applyCalorieImport() then writes calories_per_100g (and clears
// calories_unverified) for the planned rows only. Notes are for the researcher and are not saved.
// ============================================================
const ExcelJS = require('exceljs');
const { supabase, supaFail } = require('./supabaseClient');
const { getSectionByCode, getAgeGroupsForSection, getCategoryById } = require('./referenceData');

const REVIEW_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];
const SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP' };
const MAX_CALORIES = 900; // kcal per 100 g: pure fat is ~900, so anything above is a typo
const HEADERS = {
  id: 'ID',
  name: 'Item name',
  category: 'Category',
  sections: 'Section(s)',
  current: 'Current calories per 100g',
  reviewed: 'Reviewed calories per 100g',
  notes: 'Notes',
};

async function fetchAll(buildQuery, context) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw supaFail(context, error);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// [{ id, name, category, sections: ['DAYCARE', ...], calories, unverified }] -- active dishes with a
// portion row in any of the three school sections, in export order.
async function loadCalorieReviewRows() {
  const sectionOfAgeGroup = new Map();
  for (const code of REVIEW_SECTIONS) {
    const section = getSectionByCode(code);
    if (!section) continue;
    for (const ag of getAgeGroupsForSection(section.id)) sectionOfAgeGroup.set(ag.id, code);
  }
  const portions = await fetchAll(() => supabase.from('item_portions').select('item_id, age_group_id')
    .in('age_group_id', [...sectionOfAgeGroup.keys()]).order('item_id').order('age_group_id'), 'calorieReview: load item_portions');
  const sectionsOf = new Map();
  for (const p of portions) {
    if (!sectionsOf.has(p.item_id)) sectionsOf.set(p.item_id, new Set());
    sectionsOf.get(p.item_id).add(sectionOfAgeGroup.get(p.age_group_id));
  }
  const items = await fetchAll(() => supabase.from('menu_items')
    .select('id, name, category_id, is_active, calories_per_100g, calories_unverified').eq('is_active', 1).order('id'), 'calorieReview: load menu_items');
  const rows = items.filter((it) => sectionsOf.has(it.id)).map((it) => {
    const cat = getCategoryById(it.category_id);
    const sections = REVIEW_SECTIONS.filter((s) => sectionsOf.get(it.id).has(s));
    return {
      id: it.id, name: it.name, category: cat?.name || '', sections,
      calories: it.calories_per_100g, unverified: !!it.calories_unverified,
      _sort: [REVIEW_SECTIONS.indexOf(sections[0]), cat?.meal_period_sort_order ?? 0, cat?.sort_order ?? 0],
    };
  });
  rows.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2] || a.name.localeCompare(b.name));
  return rows.map(({ _sort, ...r }) => r);
}

function currentCaloriesText(row) {
  if (row.calories == null) return '';
  return row.unverified ? `${row.calories} (flagged)` : row.calories;
}

async function writeCalorieReviewWorkbook(rows, savePath) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Calories review');
  sheet.columns = [
    { header: HEADERS.id, key: 'id', width: 9 },
    { header: HEADERS.name, key: 'name', width: 48 },
    { header: HEADERS.category, key: 'category', width: 22 },
    { header: HEADERS.sections, key: 'sections', width: 22 },
    { header: HEADERS.current, key: 'current', width: 16 },
    { header: HEADERS.reviewed, key: 'reviewed', width: 17 },
    { header: HEADERS.notes, key: 'notes', width: 44 },
  ];
  for (const r of rows) {
    sheet.addRow({ id: r.id, name: r.name, category: r.category, sections: r.sections.map((s) => SECTION_LABEL[s]).join(', '), current: currentCaloriesText(r), reviewed: null, notes: null });
  }
  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F3E' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  header.getCell(1).note = "Don't change: this ID is how the import finds the dish.";
  header.getCell(5).note = '"(flagged)" = stored as an unverified estimate. Blank = no value yet.';
  header.getCell(6).note = 'Fill in the real value (0-900 kcal per 100 g). Leave blank to keep the current value.';
  header.getCell(7).note = 'For your own reference (source, assumption). Not imported.';
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    row.getCell(1).font = { color: { argb: 'FF8A8A8A' } };
    row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
    row.getCell(6).dataValidation = {
      type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, MAX_CALORIES],
      showErrorMessage: true, errorTitle: 'Calories per 100 g', error: `Enter a number from 0 to ${MAX_CALORIES}, or leave blank.`,
    };
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'G1' };
  await wb.xlsx.writeFile(savePath);
  return rows.length;
}

// Cell text, whatever Excel / Sheets made of it (formula results, rich text, hyperlinks).
function cellText(cell) {
  let v = cell && cell.value;
  if (v && typeof v === 'object') v = v.result !== undefined ? v.result : v.richText ? v.richText.map((t) => t.text).join('') : v.text !== undefined ? v.text : null;
  return v == null ? '' : String(v).trim();
}

// Reads the reviewed file back: [{ rowNumber, id, name, reviewed }] (reviewed as the raw text), or
// throws when no sheet has the ID / Item name / Reviewed headers.
async function parseCalorieReviewWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  for (const sheet of wb.worksheets) {
    for (let h = 1; h <= Math.min(sheet.rowCount, 5); h++) {
      const colOf = {};
      sheet.getRow(h).eachCell((cell, col) => {
        const t = cellText(cell).toLowerCase();
        for (const [key, label] of Object.entries(HEADERS)) if (t === label.toLowerCase()) colOf[key] = col;
      });
      if (!colOf.id || !colOf.name || !colOf.reviewed) continue;
      const rows = [];
      for (let r = h + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const id = cellText(row.getCell(colOf.id));
        const name = cellText(row.getCell(colOf.name));
        const reviewed = cellText(row.getCell(colOf.reviewed));
        if (!id && !name && !reviewed) continue;
        rows.push({ rowNumber: r, id, name, reviewed });
      }
      return rows;
    }
  }
  throw new Error(`This file has no "${HEADERS.id}", "${HEADERS.name}" and "${HEADERS.reviewed}" columns -- use the file from "Export calories for review".`);
}

const tidyName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Pure: parsed rows + the dishes they name -> { updates: [{ id, name, from, to }], unchanged, blank,
// skipped: [{ rowNumber, id, name, reason }] }. dishesById: Map(id -> { id, name, calories_per_100g, calories_unverified }).
function planCalorieImport(parsed, dishesById) {
  const skipped = [];
  const byId = new Map(); // id -> { value, rowNumber, name }
  let blank = 0;
  for (const row of parsed) {
    if (!row.reviewed) { blank++; continue; }
    const id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0) { skipped.push({ ...row, reason: 'no valid ID in this row' }); continue; }
    const dish = dishesById.get(id);
    if (!dish) { skipped.push({ ...row, reason: `no active Daycare / KG-LP / MS-UP dish has ID ${id}` }); continue; }
    if (tidyName(dish.name) !== tidyName(row.name)) { skipped.push({ ...row, reason: `ID ${id} is "${dish.name}" in the app, not "${row.name}" -- the row may have shifted` }); continue; }
    const value = Number(String(row.reviewed).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > MAX_CALORIES) { skipped.push({ ...row, reason: `"${row.reviewed}" isn't a number from 0 to ${MAX_CALORIES}` }); continue; }
    const rounded = Math.round(value * 10) / 10;
    const prev = byId.get(id);
    if (prev) {
      if (prev.value !== rounded) prev.conflict = true;
      continue;
    }
    byId.set(id, { value: rounded, rowNumber: row.rowNumber, name: dish.name });
  }
  const updates = [];
  let unchanged = 0;
  for (const [id, e] of byId) {
    if (e.conflict) { skipped.push({ rowNumber: e.rowNumber, id: String(id), name: e.name, reason: `ID ${id} appears more than once with different values` }); continue; }
    const dish = dishesById.get(id);
    if (dish.calories_per_100g != null && Number(dish.calories_per_100g) === e.value && !dish.calories_unverified) { unchanged++; continue; }
    updates.push({ id, name: dish.name, from: dish.calories_per_100g, fromFlagged: !!dish.calories_unverified, to: e.value });
  }
  skipped.sort((a, b) => a.rowNumber - b.rowNumber);
  return { updates, unchanged, blank, skipped };
}

// The dishes an import may touch (same scope as the export), keyed by id.
async function loadImportTargets() {
  const rows = await loadCalorieReviewRows();
  const ids = rows.map((r) => r.id);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase.from('menu_items').select('id, name, calories_per_100g, calories_unverified').in('id', ids.slice(i, i + 300));
    if (error) throw supaFail('calorieReview: load import targets', error);
    for (const d of data) out.set(d.id, d);
  }
  return out;
}

// Writes the planned values. Returns { written, failed: [{ id, name, message }] }.
async function applyCalorieImport(updates) {
  let written = 0;
  const failed = [];
  for (let i = 0; i < updates.length; i += 20) {
    const results = await Promise.all(updates.slice(i, i + 20).map((u) =>
      supabase.from('menu_items').update({ calories_per_100g: u.to, calories_unverified: false }).eq('id', u.id)
        .then(({ error }) => ({ u, error }))));
    for (const { u, error } of results) {
      if (error) failed.push({ id: u.id, name: u.name, message: error.message });
      else written++;
    }
  }
  return { written, failed };
}

module.exports = {
  HEADERS, MAX_CALORIES, loadCalorieReviewRows, writeCalorieReviewWorkbook, parseCalorieReviewWorkbook,
  planCalorieImport, loadImportTargets, applyCalorieImport,
};
