// General Ingredients (2026-10-06): the one-off import of the kitchen_ingredients Excel file into public.general_ingredients
// (migration 20261006110000). A separate REFERENCE list -- not Nayyara Ingredients (public.ingredients), never linked to it,
// never read by Recipe Book, the Name map or any generator.
//
// Pure apart from `applyImport`, which takes the database client as an argument (a fake in the check):
//   readKitchenWorkbook(path)  -> { items, departmentPairs, problems }   both sheets: "Items" + "Department use"
//   planImport(file, existing) -> new / already present / skipped (with reasons) / bread-type departments
//   applyImport({ db, plan })  -> inserts the plan's new rows in batches; safe to re-run
//   compareTableToFile(...)    -> what the verify script reports
//
// Matching is by EXACT name, case and spacing aside (name_key, the rule the table itself enforces with a unique index).
// A row already in the table is never changed: re-running the import adds only what is missing.
const ExcelJS = require('exceljs');

const ITEM_COLUMNS = ['item_code', 'name', 'name_ar', 'parent_name', 'category', 'form', 'primary_department', 'item_type',
  'storage', 'typical_uom'];
// The kitchen's real departments. Any other primary_department value (the file has ~50 bread types there: "whole wheat",
// "biscuit", "croissant ready by portions" ...) is imported AS IT IS and listed in the preview.
const KITCHEN_DEPARTMENTS = ['Hot kitchen', 'Cold kitchen', 'Butchery', 'Vegetables', 'Pastry', 'Bakery', 'Fruit', 'Canned',
  'Salads', 'Appetizers'];
const BATCH_SIZE = 200;

// Same rule as the table's generated name_key column: lowercase(trim, runs of whitespace -> one space).
function nameKey(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
}
function cellText(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if (v.text != null) v = v.text;
    else if (v.result != null) v = v.result;
    else v = String(v);
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}
const isKitchenDepartment = (d) => KITCHEN_DEPARTMENTS.includes(d);

// Reads both sheets by header NAME. `problems` = anything that stops the file being read as expected (a missing sheet or
// column); rows themselves are judged in planImport.
async function readKitchenWorkbook(source) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source)) await wb.xlsx.load(source); else await wb.xlsx.readFile(source);
  const problems = [];
  const sheetRows = (sheetName, columns) => {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) { problems.push(`No "${sheetName}" sheet.`); return []; }
    const header = {};
    ws.getRow(1).eachCell((c, col) => { const h = cellText(c.value); if (h) header[h.toLowerCase()] = col; });
    const missing = columns.filter((c) => !header[c]);
    if (missing.length) { problems.push(`"${sheetName}" has no ${missing.join(', ')} column.`); return []; }
    const out = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rec = { rowNumber: r };
      columns.forEach((c) => { rec[c] = cellText(row.getCell(header[c]).value); });
      if (columns.every((c) => rec[c] == null)) continue; // an empty line
      out.push(rec);
    }
    return out;
  };
  const items = sheetRows('Items', ITEM_COLUMNS);
  const departmentPairs = sheetRows('Department use', ['item_code', 'name', 'department']);
  return { items, departmentPairs, problems };
}

// file = readKitchenWorkbook's result; existing = the table's rows ({ id, item_code, name, name_key, ... }).
function planImport(file, existing = []) {
  const skipped = [];      // { rowNumber, item_code, name, reason }
  const pairNotes = [];    // department pairs not used, with the reason
  const skippedCodes = new Set();
  const skip = (it, reason) => {
    skipped.push({ rowNumber: it.rowNumber, item_code: it.item_code, name: it.name, reason });
    if (it.item_code) skippedCodes.add(it.item_code);
  };

  // 1. The file's own items: one per code and per name.
  const seenCode = new Map();
  const seenKey = new Map();
  const fileItems = [];
  for (const it of file.items) {
    if (!it.name) { skip(it, 'no name'); continue; }
    if (!it.item_code) { skip(it, 'no item_code'); continue; }
    const key = nameKey(it.name);
    if (seenCode.has(it.item_code)) { skip(it, `item_code ${it.item_code} already used on row ${seenCode.get(it.item_code).rowNumber} of the file`); continue; }
    if (seenKey.has(key)) { skip(it, `same name as row ${seenKey.get(key).rowNumber} of the file ("${seenKey.get(key).name}")`); continue; }
    seenCode.set(it.item_code, it);
    seenKey.set(key, it);
    fileItems.push({ ...it, name_key: key, departments: [] });
  }

  // 2. Departments from the "Department use" sheet, by item_code (the name must agree), in the file's order, each once.
  const byCode = new Map(fileItems.map((it) => [it.item_code, it]));
  for (const p of file.departmentPairs) {
    const it = byCode.get(p.item_code);
    if (!p.department) { pairNotes.push({ ...p, reason: 'no department' }); continue; }
    if (!it) { pairNotes.push({ ...p, reason: !p.item_code ? 'no item_code' : skippedCodes.has(p.item_code) ? 'its item is skipped' : 'item_code not on the Items sheet' }); continue; }
    if (p.name && nameKey(p.name) !== it.name_key) { pairNotes.push({ ...p, reason: `name differs from the Items sheet ("${it.name}")` }); continue; }
    if (it.departments.includes(p.department)) { pairNotes.push({ ...p, reason: 'listed twice' }); continue; }
    it.departments.push(p.department);
  }

  // 3. Against the table: exact name (name_key) = already present, never changed. A code the table holds under another
  // name is skipped (the table's item_code is unique).
  const tableByKey = new Map(existing.map((r) => [r.name_key || nameKey(r.name), r]));
  const tableByCode = new Map(existing.map((r) => [r.item_code, r]));
  const toInsert = [];
  const present = [];
  for (const it of fileItems) {
    const there = tableByKey.get(it.name_key);
    if (there) { present.push({ item: it, row: there, sameCode: there.item_code === it.item_code }); continue; }
    const codeOwner = tableByCode.get(it.item_code);
    if (codeOwner) { skip(it, `item_code ${it.item_code} is already in the table for "${codeOwner.name}"`); continue; }
    toInsert.push(it);
  }

  const breadType = fileItems.filter((it) => it.primary_department && !isKitchenDepartment(it.primary_department));
  const otherDeptPairs = fileItems.reduce((n, it) => n + it.departments.filter((d) => !isKitchenDepartment(d)).length, 0);
  return {
    fileItemCount: file.items.length,
    departmentPairCount: file.departmentPairs.length,
    toInsert,
    present,
    skipped: skipped.sort((a, b) => a.rowNumber - b.rowNumber),
    pairNotes,
    breadType,
    otherDeptPairs,
    withoutDepartments: fileItems.filter((it) => !it.departments.length),
    primaryNotInDepartments: fileItems.filter((it) => it.primary_department && it.departments.length && !it.departments.includes(it.primary_department)),
  };
}

function toRow(it, who) {
  const row = {};
  ITEM_COLUMNS.forEach((c) => { row[c] = it[c] == null ? null : it[c]; });
  row.departments = it.departments || [];
  row.created_by = who || null;
  return row;
}

// Inserts the plan's new rows, BATCH_SIZE at a time. "on conflict (name_key) do nothing": a name someone added meanwhile is
// counted as already present, never overwritten. A batch refused for another reason (an item_code added meanwhile under
// another name) is retried row by row so one row can't block the rest; each such row is reported.
async function applyImport({ db, plan, who, batchSize = BATCH_SIZE, onProgress }) {
  const rows = plan.toInsert.map((it) => toRow(it, who));
  let inserted = 0;
  let alreadyThere = 0;
  const failed = [];
  const insert = async (chunk) => {
    const { data, error } = await db.from('general_ingredients')
      .upsert(chunk, { onConflict: 'name_key', ignoreDuplicates: true }).select('id');
    return { data, error };
  };
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { data, error } = await insert(chunk);
    if (!error) {
      inserted += data.length;
      alreadyThere += chunk.length - data.length;
    } else {
      for (const row of chunk) {
        const one = await insert([row]);
        if (one.error) failed.push({ item_code: row.item_code, name: row.name, error: one.error.message });
        else if (one.data.length) inserted++;
        else alreadyThere++;
      }
    }
    if (onProgress) onProgress(Math.min(i + batchSize, rows.length), rows.length);
  }
  return { planned: rows.length, inserted, alreadyThere, failed };
}

// The verify: the table against the file. Every field of every file item, departments compared as a set.
function compareTableToFile(plan, tableRows) {
  const fileItems = [...plan.toInsert, ...plan.present.map((p) => p.item)];
  const fileByKey = new Map(fileItems.map((it) => [it.name_key, it]));
  const tableByKey = new Map();
  const duplicateKeys = [];
  for (const r of tableRows) {
    const k = r.name_key || nameKey(r.name);
    if (tableByKey.has(k)) duplicateKeys.push(r); else tableByKey.set(k, r);
  }
  const missing = [];
  const differs = [];
  for (const it of fileItems) {
    const r = tableByKey.get(it.name_key);
    if (!r) { missing.push(it); continue; }
    const fields = ITEM_COLUMNS.filter((c) => (r[c] == null ? null : r[c]) !== (it[c] == null ? null : it[c]));
    const a = [...(r.departments || [])].sort().join('|');
    const b = [...it.departments].sort().join('|');
    if (a !== b) fields.push('departments');
    if (fields.length) differs.push({ item: it, row: r, fields });
  }
  const extra = tableRows.filter((r) => !fileByKey.has(r.name_key || nameKey(r.name)));
  const pairsInTable = tableRows.reduce((n, r) => n + (r.departments || []).length, 0);
  const pairsInFile = fileItems.reduce((n, it) => n + it.departments.length, 0);
  return {
    fileItems: fileItems.length,
    tableRows: tableRows.length,
    missing,
    extra,
    differs,
    duplicateKeys,
    pairsInFile,
    pairsInTable,
    pass: !missing.length && !extra.length && !differs.length && !duplicateKeys.length
      && tableRows.length === fileItems.length && pairsInTable === pairsInFile,
  };
}

module.exports = {
  ITEM_COLUMNS, KITCHEN_DEPARTMENTS, BATCH_SIZE,
  nameKey, isKitchenDepartment, readKitchenWorkbook, planImport, applyImport, compareTableToFile, toRow,
};
