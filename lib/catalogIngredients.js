// ============================================================
// Dish Catalog ingredients (phase M1, 2026-10-02): which rows of a Menu Ingredients upload are a Dish Catalog dish, so a
// saved, chef-approved list (menu_items.ingredients_text, migration 20261002100000) can be used instead of an AI call.
// PURE: no Supabase, no AI. The caller loads the catalog and parses the files (lib/menuIngredients.js
// parseWorkbookDishes).
//
// A row's section and category come from the catalog import's own reading of a menu (lib/catalogImport.js placeRow),
// so both features agree on where a row sits. The dish is then matched by EXACT name within that category, ignoring
// only letter case and spacing (lib/menuIngredientsShare.js shareName, Phase D's rule) -- never fuzzy: in the catalog
// import about 1 in 4 "similar" names were really different dishes, and a wrong match here would put another dish's
// ingredients on a menu. A miss is safe: the dish goes to the AI as today.
//
// Staff's Lunch / Breakfast "Main Dish" rows are often the export's copies of a school dish (catalogImport.js header):
// with no Staff dish of that name, they match the school dish of that name, if exactly one school category has it.
// ============================================================
const { placeRow, SCHOOL_SECTIONS, STAFF_SHARED_CODES } = require('./catalogImport');
const { SECTION_SLOTS } = require('./generator');
const { shareName } = require('./menuIngredientsShare');
const { isServedAsIsRow } = require('./menuIngredientsRequest');

const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const SCHOOL_CATEGORY_CODES = new Set([...SCHOOL_SECTIONS].flatMap((s) => SECTION_SLOTS[s].map(([code]) => code)));

// Row statuses:
//   'match'      -- exactly one catalog dish of this name in the row's category (or, for a Staff shared copy, in one
//                   school category); `itemId`, `saved` (it has an approved list).
//   'new'        -- the category is known, the catalog has no dish of this exact name in it -> AI.
//   'ambiguous'  -- two catalog dishes of this name in that category once case / spacing are ignored ("White rice" and
//                   "White Rice") -> AI, and listed so the duplicate can be tidied.
//   'unclear'    -- no category could be worked out (unknown label, retired row, a sheet whose section isn't known):
//                   no match is possible -> AI. `reason` says why.
//   'servedAsIs' -- Fruit Bar / Fruit Basket / Salad Bar: never sent, never saved.
//
// files: [{ fileName, rows }]; catalog: [{ id, name, category_code, is_active, ingredients_text? }];
// categories: [{ code, name }]; sectionOverrides: { 'file::sheet': sectionCode } (as the catalog import takes).
function planIngredientLookup({ files, catalog, categories, sectionOverrides = {} }) {
  const categoryCodeByName = new Map(categories.map((c) => [tidy(c.name).toLowerCase(), c.code]));
  const byKey = new Map(); // `${category_code}|${shareName}` -> catalog items
  for (const it of catalog) {
    const key = `${it.category_code}|${shareName(it.name)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  const schoolItemsNamed = (name) => [...SCHOOL_CATEGORY_CODES].flatMap((code) => byKey.get(`${code}|${name}`) || []);

  const rows = [];
  for (const { fileName, rows: fileRows } of files) {
    for (const row of fileRows) {
      const dishName = tidy(row.dishName);
      if (!dishName) continue;
      const base = { fileName, sheetName: row.sheetName, rowNumber: row.rowNumber, day: [row.weekday, row.date].filter(Boolean).join(' '), dishName, label: tidy(row.category),
        // The row's own text when the file is a Menu Ingredients export (null otherwise) -- what a save stores (M2).
        ingredients: row.ingredientsText ?? null, allergens: row.allergensText ?? null };
      if (isServedAsIsRow(row)) { rows.push({ ...base, status: 'servedAsIs' }); continue; }
      const placed = placeRow(row, fileName, categoryCodeByName, sectionOverrides);
      if (!placed.section) { rows.push({ ...base, status: 'unclear', reason: `the sheet "${row.sheetName}" doesn't say which section it is` }); continue; }
      if (placed.skip) { rows.push({ ...base, section: placed.section, status: 'unclear', reason: placed.skip }); continue; }
      const name = shareName(dishName);
      const placedBase = { ...base, section: placed.section, code: placed.code };
      let items = byKey.get(`${placed.code}|${name}`) || [];
      let sharedCopy = false;
      if (!items.length && placed.section === 'STAFF' && STAFF_SHARED_CODES.has(placed.code)) {
        const school = schoolItemsNamed(name);
        if (school.length) { items = school; sharedCopy = true; }
      }
      if (items.length > 1) { rows.push({ ...placedBase, status: 'ambiguous', candidates: items.map((it) => ({ id: it.id, name: it.name, categoryCode: it.category_code })) }); continue; }
      if (!items.length) { rows.push({ ...placedBase, status: 'new' }); continue; }
      const it = items[0];
      rows.push({ ...placedBase, status: 'match', itemId: it.id, itemName: it.name, itemCategory: it.category_code, sharedCopy, item: it,
        inactive: it.is_active === 0 || it.is_active === false, saved: !!tidy(it.ingredients_text) });
    }
  }
  return { rows, summary: summarize(rows) };
}

// Per row and per AI CALL (Menu Ingredients makes one call per dish name across the upload, case / spacing ignored):
// a name needs no call only when every one of its rows matches a dish with a saved list. `ifAllSaved` is the same count
// assuming every matched dish had one -- the most this feature can save on this upload.
function summarize(rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const names = new Map(); // shareName -> rows (served-as-is rows make no call)
  for (const r of rows) {
    if (r.status === 'servedAsIs') continue;
    const n = shareName(r.dishName);
    if (!names.has(n)) names.set(n, []);
    names.get(n).push(r);
  }
  const callsToday = names.size;
  const noCall = (pred) => [...names.values()].filter((rs) => rs.every(pred)).length;
  return {
    rows: rows.length,
    servedAsIs: count('servedAsIs'),
    match: count('match'),
    matchShared: rows.filter((r) => r.status === 'match' && r.sharedCopy).length,
    matchInactive: rows.filter((r) => r.status === 'match' && r.inactive).length,
    matchSaved: rows.filter((r) => r.status === 'match' && r.saved).length,
    new: count('new'),
    ambiguous: count('ambiguous'),
    unclear: count('unclear'),
    calls: {
      today: callsToday,
      savedNow: noCall((r) => r.status === 'match' && r.saved),
      ifAllSaved: noCall((r) => r.status === 'match'),
    },
  };
}

module.exports = { planIngredientLookup };
