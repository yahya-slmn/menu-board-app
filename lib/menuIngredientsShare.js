// ============================================================
// Menu Ingredients Generator: the same dish served the same day in another section (2026-10-01, pipeline Phase D).
// Daycare's AM Snack is KG-LP's; KG-LP's lunch is MS-UP's; Staff's main often repeats a school one. Such a row FOLLOWS
// the first row of that dish that day: it shows that row's ingredients, read-only, "Same as Daycare's ... -- not
// repeated", until the chef edits it for its own section. Only the same DAY in another section (another sheet, or
// another file of the same upload) -- the same section on another day is its own row (confirmed with the chef).
//
// Matching is by name ignoring case and spacing only, never fuzzy (in the Dish Catalog import ~1 in 4 "similar" names
// were different dishes). Two safety conditions, so a "follows" link can never put unfiltered food on a row:
//   1. a student row (Daycare / KG-LP / MS-UP, or a sheet whose section can't be told) never follows a Staff / CEO row
//      -- edits flow from a source to its followers, so they may only flow to rows that are as strict or less strict;
//   2. a row follows only when its OWN filtered result (ingredients + allergens, after its own section's rules) is
//      identical to the source's -- so "Same as ..." is literally true: a Staff Tuna Sandwich does not follow KG-LP's,
//      whose tuna was removed for students.
// Pure: no AI, no database.
// ============================================================
const { resolveSectionFromSheetName } = require('./recipeGenerator');

const shareName = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isAdultSheet = (sheetName) => ['STAFF', 'CEO'].includes(resolveSectionFromSheetName(sheetName));
const rowKey = (r) => `${r.fileIndex}|${r.sheetName}|${r.rowNumber}`;

// rows: every row of the upload in order (files in upload order, rows in sheet order), each with { fileIndex,
// sheetName, rowNumber, date, dishName, ingredients, allergens } -- ingredients / allergens being THIS row's own
// filtered result. Returns Map(rowKey -> source row) for the rows that follow one.
function planShares(rows) {
  const groups = new Map(); // date | name -> rows that hold their own result (sources), in order
  const follows = new Map();
  for (const r of rows) {
    if (!r.date) continue; // no day: nothing to share with
    if (r.servedAsIs) continue; // Fruit Bar / Basket, Salad Bar: blank on purpose, never "Same as" (menuIngredientsRequest.js)
    const key = `${r.date}|${shareName(r.dishName)}`;
    const earlier = groups.get(key) || [];
    const source = earlier.find((s) => (s.fileIndex !== r.fileIndex || s.sheetName !== r.sheetName)
      && !(isAdultSheet(s.sheetName) && !isAdultSheet(r.sheetName))
      && s.ingredients === r.ingredients && s.allergens === r.allergens);
    if (source) { follows.set(rowKey(r), source); continue; }
    earlier.push(r);
    groups.set(key, earlier);
  }
  return follows;
}

// The export's "Same as" column (2026-10-01, the chef's request): for each row still FOLLOWING another section's row
// when she exports (followsRef set, not "Edit for this section"), who it follows -- "Daycare's Cheese Croissant", plus
// "(file name)" when the source is in another file of the upload. The Ingredients cell keeps the full text either way:
// the Recipe Generator matches dishes by name AND list, so a reference in place of the list would break it.
// files: [{ fileIndex, fileName, rows }] as the renderer sends them for export. Returns Map(rowKey -> label).
function sameAsLabels(files) {
  const byKey = new Map();
  for (const f of files) for (const r of f.rows || []) byKey.set(rowKey({ ...r, fileIndex: f.fileIndex }), { ...r, fileIndex: f.fileIndex, fileName: f.fileName });
  const labels = new Map();
  for (const r of byKey.values()) {
    if (!r.followsRef || r.unlinked) continue;
    const source = byKey.get(rowKey(r.followsRef));
    if (!source) continue;
    const other = source.fileIndex !== r.fileIndex ? ` (${source.fileName || 'another file'})` : '';
    labels.set(rowKey(r), `${source.sheetName}'s ${source.dishName}${other}`);
  }
  return labels;
}

module.exports = { planShares, shareName, isAdultSheet, rowKey, sameAsLabels };
