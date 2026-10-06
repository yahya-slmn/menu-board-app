#!/usr/bin/env node
// Menu Ingredients history (2026-10-06) -- checks, with a stand-in database (no login, no AI, nothing written but a temp file):
//   1. exporting a history entry gives the SAME file as exporting right after the generation: every part of the .xlsx is
//      identical except docProps/core.xml (the file's own created / modified time);
//   2. an edited entry exports the edits (read back from the exported file), and every other row is unchanged;
//   3. a save from someone who opened an older version is refused and changes nothing; a deleted entry takes its files along;
//   4. exporting twice gives the same file (each export starts from a fresh copy of the original).
// The export is built exactly as main.js export-menu-ingredients does it: "Same as" labels (lib/menuIngredientsShare.js), a
// fresh copy of the original workbook, lib/menuIngredients.js restructureAndAppendIngredients. Part of npm test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { SECTION_SLOTS } = require('../lib/generator');
const { exportCombinedWorkbook } = require('../lib/export');
const { loadWorkbookFromBuffer, parseWorkbookDishes, restructureAndAppendIngredients } = require('../lib/menuIngredients');
const { sameAsLabels, rowKey: shareRowKey } = require('../lib/menuIngredientsShare');
const H = require('../lib/menuIngredientsHistory');

let passed = 0;
const failures = [];
const check = (ok, what) => { if (ok) passed++; else failures.push(what); };

// ---- a real menu file, made with the app's own exporter (two school days, every section) ------------------------------
const pretty = (code) => code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const DAYS = [{ menu_date: '2026-10-04', day_of_week: 'Sunday' }, { menu_date: '2026-10-05', day_of_week: 'Monday' }];
const SHARED = 'Cheese Croissant'; // Daycare's and KG-LP's AM Snack on day 1: KG-LP's row follows Daycare's ("Same as")
function sampleMenu(code) {
  let order = 0;
  return { section: { code }, days: DAYS.map((d, di) => ({ ...d, items: SECTION_SLOTS[code].flatMap(([cat, count], ci) => Array.from({ length: count }, (_, k) => ({
    category_code: cat, category_name: pretty(cat), is_daily_repeating: 0, meal_period_name: /AM_SNACK|MILK|BREAKFAST|YOGURT/.test(cat) ? 'Breakfast' : 'Lunch',
    period_order: /AM_SNACK|MILK|BREAKFAST|YOGURT/.test(cat) ? 1 : 2, cat_order: ci, order: order++,
    name: cat === 'AM_SNACK' && di === 0 && (code === 'DAYCARE' || code === 'KG_LP') ? SHARED : `${pretty(cat)} ${code.slice(0, 2)} d${di} n${k}`,
  }))) })) };
}
const vocab = [...new Set(['DAYCARE', 'KG_LP', 'MS_UP'].flatMap((s) => SECTION_SLOTS[s].map(([c]) => pretty(c))))];

// The export, as main.js export-menu-ingredients builds it. registered: Map fileIndex -> { fileName, base64, dishColumnBySheet }.
async function exportLikeMain(files, registered) {
  const sameAs = sameAsLabels(files.map((f) => ({ ...f, fileName: registered.get(f.fileIndex)?.fileName })));
  const out = [];
  for (const { fileIndex, rows: sent } of files) {
    const rows = sent.map((r) => ({ ...r, sameAs: sameAs.get(shareRowKey({ ...r, fileIndex })) || '' }));
    const entry = registered.get(fileIndex);
    const { workbook } = await loadWorkbookFromBuffer(Buffer.from(entry.base64, 'base64'));
    await restructureAndAppendIngredients(workbook, rows, entry.dishColumnBySheet);
    out.push(Buffer.from(await workbook.xlsx.writeBuffer()));
  }
  return out;
}
// Every part of two .xlsx files: the names of the parts that differ.
async function differingParts(a, b) {
  const [za, zb] = [await JSZip.loadAsync(a), await JSZip.loadAsync(b)];
  // Folder entries carry only a timestamp, no content: files only.
  const files = (z) => Object.keys(z.files).filter((n) => !z.files[n].dir);
  const names = [...new Set([...files(za), ...files(zb)])].sort();
  const diff = [];
  for (const n of names) {
    const [x, y] = [za.file(n), zb.file(n)];
    if (!x || !y) { diff.push(n); continue; }
    if (Buffer.compare(await x.async('nodebuffer'), await y.async('nodebuffer')) !== 0) diff.push(n);
  }
  return { diff, total: names.length };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-history-check-'));
  try {
    const file = path.join(tmp, 'September week_04.xlsx');
    const order = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
    await exportCombinedWorkbook(async (c) => sampleMenu(c), async (codes) => ({ bySection: Object.fromEntries(codes.map((c) => [c, { categories: Object.fromEntries(SECTION_SLOTS[c].map(([cat]) => [cat, { items: [] }])) }])) }),
      Object.fromEntries(order.map((c) => [c, c])), file);
    const base64 = fs.readFileSync(file).toString('base64');

    // ---- the generation: parse, then the review rows as parse-and-suggest-menu-ingredients returns them ----------------
    const { workbook } = await loadWorkbookFromBuffer(Buffer.from(base64, 'base64'));
    const parsed = await parseWorkbookDishes(workbook, vocab);
    const sheetOf = (r) => r.sheetName;
    const daycareShared = parsed.rows.find((r) => r.dishName === SHARED && /day/i.test(sheetOf(r)));
    const rows = parsed.rows.map((r, i) => ({
      ...r, fileIndex: 0, servedAsIs: /fruit bar|fruit basket|salad bar/i.test(r.category),
      ingredients: /fruit bar|fruit basket|salad bar/i.test(r.category) ? '' : `${r.dishName.toLowerCase()} base - olive oil - salt`,
      allergens: i % 3 ? 'gluten - dairy' : '', basis: i % 5 ? 'General' : 'Regional: Kabsa (Saudi)',
      removedTerms: i % 7 ? [] : [{ segment: 'pine nuts', policy: 'nut' }], removedAllergenTerms: [],
      catalog: i % 11 ? null : { itemId: 9, name: r.dishName, updatedAt: '2026-10-02T08:00:00.000Z', updatedBy: 'tetiana' },
      followsRef: r !== daycareShared && r.dishName === SHARED ? { fileIndex: 0, sheetName: daycareShared.sheetName, rowNumber: daycareShared.rowNumber } : null,
    }));
    const review = [{ fileIndex: 0, fileName: 'September week_04.xlsx', success: true, rows, failures: [] }];
    check(rows.some((r) => r.followsRef) && rows.some((r) => r.servedAsIs) && rows.some((r) => r.catalog), 'the sample has "Same as" links, served-as-is rows and catalog notes');

    // ---- export right after the generation (in memory) -----------------------------------------------------------------
    const registered = new Map([[0, { fileName: 'September week_04.xlsx', base64, dishColumnBySheet: parsed.dishColumnBySheet }]]);
    const exportFiles = (rv) => rv.filter((f) => f.rows && f.rows.length).map((f) => ({ fileIndex: f.fileIndex, rows: f.rows }));
    const [first] = await exportLikeMain(exportFiles(review), registered);
    const [again] = await exportLikeMain(exportFiles(review), registered);
    const twice = await differingParts(first, again);
    check(twice.diff.every((n) => n === 'docProps/core.xml'), `exporting twice gives the same file (differing: ${twice.diff.join(', ') || 'none'})`);

    // ---- the history round trip: save, open (originals re-registered as main.js mi-history-open does), export ---------
    const db = makeDb();
    const saved = await H.createRun(db, { who: 'tetiana', files: review, originals: [{ fileIndex: 0, fileName: 'September week_04.xlsx', base64 }] });
    check(saved.complete && saved.version === 1, 'the generation is saved complete, version 1');
    const list = await H.listRuns(db);
    check(list.length === 1 && list[0].row_count === rows.length && list[0].created_by === 'tetiana' && !('rows_gz' in list[0]), 'the list: one entry, its row count and who ran it, never the review itself');
    const opened = await H.loadRun(db, saved.id);
    check(JSON.stringify(opened.review) === JSON.stringify(review), 'reopening gives back the review exactly (rows, "Same as" links, served-as-is, notes)');
    const reg2 = new Map();
    for (const o of opened.originals) {
      const { workbook: wb } = await loadWorkbookFromBuffer(Buffer.from(o.base64, 'base64'));
      reg2.set(o.fileIndex, { fileName: o.fileName, base64: o.base64, dishColumnBySheet: (await parseWorkbookDishes(wb, vocab)).dishColumnBySheet });
    }
    const [fromHistory] = await exportLikeMain(exportFiles(opened.review), reg2);
    const same = await differingParts(first, fromHistory);
    check(same.diff.every((n) => n === 'docProps/core.xml'), `history export = export after generation (${same.total} parts; differing: ${same.diff.join(', ') || 'none'})`);
    var sameNote = `${same.total} parts compared, differing: ${same.diff.join(', ') || 'none'}`;

    // ---- an edit: her change to one row (and so to the KG-LP row that follows it), saved, exported -----------------------
    const edited = JSON.parse(JSON.stringify(opened.review));
    const src = edited[0].rows.find((r) => r === edited[0].rows.find((x) => x.sheetName === daycareShared.sheetName && x.rowNumber === daycareShared.rowNumber));
    src.ingredients = 'croissant - edam cheese - butter (edited by the chef)';
    for (const r of edited[0].rows) if (r.followsRef && !r.unlinked) r.ingredients = src.ingredients; // what the screen does
    const other = edited[0].rows.find((r) => !r.servedAsIs && !r.followsRef && r !== src);
    other.allergens = 'egg';
    const ok1 = await H.saveRunEdits(db, { id: saved.id, expectedVersion: 1, files: edited, who: 'hana' });
    check(ok1.saved && ok1.version === 2, 'saving edits on the version she opened: saved, version 2');
    const stale = JSON.parse(JSON.stringify(opened.review));
    stale[0].rows[0].ingredients = 'someone else, from version 1';
    const clash = await H.saveRunEdits(db, { id: saved.id, expectedVersion: 1, files: stale, who: 'tetiana' });
    check(clash.conflict && clash.conflict.by === 'hana' && clash.conflict.version === 2, 'a save from an older version is refused, naming who saved since');
    const after = await H.loadRun(db, saved.id);
    check(JSON.stringify(after.review) === JSON.stringify(edited) && after.meta.version === 2 && after.meta.updated_by === 'hana', 'the refused save changed nothing: the stored entry is her edit, version 2');
    const [editedFile] = await exportLikeMain(exportFiles(after.review), reg2);
    const { workbook: back } = await loadWorkbookFromBuffer(editedFile);
    const readBack = (await parseWorkbookDishes(back, vocab)).rows;
    const at = (r) => readBack.find((x) => x.sheetName === r.sheetName && x.rowNumber === r.rowNumber);
    check(at(src).ingredientsText === src.ingredients, 'the edited row exports its edit');
    check(edited[0].rows.filter((r) => r.followsRef).every((r) => at(r).ingredientsText === src.ingredients), 'the rows following it ("Same as") export the same edit, in full');
    check(at(other).allergensText === 'egg', 'an edited allergens cell exports its edit');
    const untouched = edited[0].rows.filter((r) => r !== src && r !== other && !r.followsRef);
    check(untouched.every((r) => at(r).ingredientsText === (r.ingredients || '') && at(r).allergensText === (r.allergens || '')), `every other row exports unchanged (${untouched.length} rows)`);

    // ---- size, a saved-as-new copy, delete ----------------------------------------------------------------------------
    const gz = H.encodeReview(review).length;
    check(gz < JSON.stringify(review).length / 4, `the review is stored compressed (${Math.round(gz / 1024)} KB for ${rows.length} rows)`);
    const copy = await H.saveRunAsNew(db, { fromId: saved.id, files: stale, who: 'tetiana' });
    check(copy.complete && copy.id !== saved.id && (await H.loadRun(db, copy.id)).originals[0].base64 === base64, '"Save mine as a new entry": a new entry with the same original file');
    await H.deleteRun(db, saved.id);
    check(!(await H.loadRun(db, saved.id)) && db.t('menu_ingredient_run_files').every((f) => f.run_id !== saved.id), 'delete removes the entry and its original files');
    const goneSave = await H.saveRunEdits(db, { id: saved.id, expectedVersion: 2, files: edited, who: 'hana' });
    check(goneSave.gone === true, 'saving to a deleted entry says so (nothing written)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) { console.error(`Menu Ingredients history FAILED (${failures.length}):\n  ${failures.join('\n  ')}`); process.exit(1); }
  console.log(`Menu Ingredients history OK (${passed} checks; history export vs export after generation: ${sameNote}).`);
})().catch((err) => { console.error(err); process.exit(1); });

// A stand-in for the Supabase query builder: enough for lib/menuIngredientsHistory.js (insert / select / update / delete with
// eq / order / limit / single / maybeSingle). Deleting a run deletes its files, as the foreign key does.
function makeDb() {
  const tables = { menu_ingredient_runs: [], menu_ingredient_run_files: [] };
  let nextId = 1;
  const db = { t: (n) => tables[n] };
  db.from = (name) => {
    const filters = [];
    let op = 'select', payload = null, cols = null, single = false, maybe = false, lim = null, ord = null, ret = false;
    const pick = (r) => { if (!cols) return { ...r }; const o = {}; for (const c of cols.split(',').map((x) => x.trim())) if (c in r) o[c] = r[c]; return o; };
    const q = {
      select(c) { if (op === 'select') cols = c; else { ret = true; cols = c; } return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      order(c, o) { ord = [c, o && o.ascending === false ? -1 : 1]; return q; },
      limit(n) { lim = n; return q; },
      single() { single = true; return q; },
      maybeSingle() { maybe = true; return q; },
      then(res, rej) {
        let data;
        const rows = tables[name];
        if (op === 'insert') {
          const row = name === 'menu_ingredient_runs' ? { id: nextId++, created_at: new Date().toISOString(), version: 1, complete: false, updated_at: new Date().toISOString(), ...payload } : { ...payload };
          rows.push(row);
          data = ret ? (single ? pick(row) : [pick(row)]) : null;
        } else if (op === 'update') {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          hit.forEach((r) => Object.assign(r, payload));
          data = ret ? hit.map(pick) : null;
        } else if (op === 'delete') {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          tables[name] = rows.filter((r) => !hit.includes(r));
          if (name === 'menu_ingredient_runs') tables.menu_ingredient_run_files = tables.menu_ingredient_run_files.filter((f) => !hit.some((h) => h.id === f.run_id));
          data = ret ? hit.map(pick) : null;
        } else {
          let hit = rows.filter((r) => filters.every((f) => f(r)));
          if (ord) hit = [...hit].sort((a, b) => (a[ord[0]] > b[ord[0]] ? 1 : a[ord[0]] < b[ord[0]] ? -1 : 0) * ord[1]);
          if (lim != null) hit = hit.slice(0, lim);
          data = single || maybe ? (hit[0] ? pick(hit[0]) : null) : hit.map(pick);
        }
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return db;
}
