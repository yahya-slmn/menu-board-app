#!/usr/bin/env node
// Dish Catalog ingredients, M2 (lib/catalogIngredientsSave.js), checked on its own (npm test):
//   A. planIngredientsSave: one entry per catalog dish; rows that disagree become versions, the one on the most rows
//      preselected WITH its reason ("6 rows: Daycare, KG-LP, MS-UP (most rows)"); case / spacing / order don't make a
//      new version; new / changed / unchanged against the saved list; blank cells, dishes not in the catalog and
//      duplicate catalog dishes are never saved, only listed.
//   B. applyIngredientSaves against a stand-in database: the compare-and-swap on ingredients_updated_at (a list changed
//      since the preview is a conflict, reported with who and when, and NOT written), one history row per save.
// No login, no Supabase, no AI.
const { planIngredientsSave, applyIngredientSaves, listKey } = require('../lib/catalogIngredientsSave');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

// ---- A. the plan --------------------------------------------------------------------------------------------
expect(listKey('Chicken - basmati  rice - Onion'), listKey('onion -  chicken - Basmati Rice'), 'case, spacing and order are one list');
const categories = [{ code: 'AM_SNACK', name: 'AM Snack' }, { code: 'LUNCH_MAIN', name: 'Lunch Main Course' }, { code: 'SOUP_APPETIZER', name: 'Soup/Appetizer' }, { code: 'STAFF_MAIN', name: 'Main Dish' }];
const catalog = [
  { id: 1, name: 'Cheese Croissant', category_code: 'AM_SNACK', is_active: 1 },
  { id: 2, name: 'Chicken Kabsa', category_code: 'LUNCH_MAIN', is_active: 1, ingredients_text: 'chicken - basmati rice - kabsa spice', allergens_text: '', ingredients_updated_at: '2026-10-02T08:00:00.000+00:00', ingredients_updated_by: 'tetiana' },
  { id: 3, name: 'Lentil Soup', category_code: 'SOUP_APPETIZER', is_active: 1, ingredients_text: 'red lentils - onion - cumin', allergens_text: '', ingredients_updated_at: '2026-10-01T08:00:00.000+00:00', ingredients_updated_by: 'tetiana' },
  { id: 4, name: 'Pumpkin Soup', category_code: 'SOUP_APPETIZER', is_active: 1 },
  { id: 5, name: 'Pumpkin  soup', category_code: 'SOUP_APPETIZER', is_active: 1 },
  { id: 6, name: 'Tuna Pasta', category_code: 'LUNCH_MAIN', is_active: 1 },
];
const row = (sheetName, category, dishName, ingredientsText, allergensText = '', n = 1) => ({ sheetName, layout: sheetName === 'Staff' ? 'STAFF' : 'SCHOOL', category, period: 'Lunch', dishName, ingredientsText, allergensText, rowNumber: n, weekday: 'Sunday', date: `1${n}-09-2026` });
const croissant = 'flour - butter - cheese - milk';
const plan = planIngredientsSave({ catalog, categories, files: [{ fileName: 'September week_04_Ingredients', rows: [
  row('Daycare', 'AM Snack', 'Cheese Croissant', croissant, 'gluten - dairy', 1),
  row('KG - LP', 'AM Snack', 'cheese croissant', 'Flour - Butter -  cheese - milk', 'gluten - dairy', 2),   // same list, other case / spacing
  row('MS - UP (B-G)', 'AM Snack', 'Cheese Croissant', croissant, 'gluten - dairy', 3),
  row('Daycare', 'AM Snack', 'Cheese Croissant', 'flour - butter - cheese - milk - sesame seeds', 'gluten - dairy - sesame', 4), // a second version, 1 row
  row('KG - LP', 'Lunch Main Course', 'Chicken Kabsa', 'kabsa spice - chicken - Basmati Rice', '', 5),     // = saved, other order
  row('KG - LP', 'Soup/Appetizer', 'Lentil Soup', 'red lentils - onion - cumin - lemon', '', 6),          // changed
  row('KG - LP', 'Soup/Appetizer', 'Pumpkin Soup', 'pumpkin - onion', '', 7),                            // duplicate dishes
  row('KG - LP', 'Lunch Main Course', 'Tuna Pasta', '', '', 8),                                         // blank: nothing approved
  row('KG - LP', 'Lunch Main Course', 'Brand New Dish', 'rice - peas', '', 9),                          // not in the catalog
  row('KG - LP', 'Fruit Basket', 'Fruit (a Selection of Seasonal Fruits)', '', '', 10),
] }] });
expect(plan.hasLists, true, 'the file carries lists');
expect(plan.disagree.map((e) => e.name), ['Cheese Croissant'], 'rows that disagree are one entry');
const cr = plan.disagree[0];
expect(cr.versions.map((v) => v.reason), ['3 rows: Daycare, KG-LP, MS-UP (most rows)', '1 row: Daycare'], 'each version says where it came from; the preselected one why');
expect([cr.preselected, cr.versions[0].ingredients, cr.status, cr.versionStatus], [0, croissant, 'new', ['new', 'new']], 'the most-rows version is preselected');
expect(plan.new.map((e) => e.name), [], 'no other new list');
expect(plan.changed.map((e) => [e.name, e.saved.ingredients, e.versions[0].ingredients, e.expectedUpdatedAt]),
  [['Lentil Soup', 'red lentils - onion - cumin', 'red lentils - onion - cumin - lemon', '2026-10-01T08:00:00.000+00:00']], 'a changed list shows saved and file, and remembers the saved time');
expect(plan.unchangedCount, 1, 'the kabsa list in another order is unchanged');
expect(plan.notSaved.duplicates.map((d) => [d.name, d.candidates.map((c) => c.id)]), [['Pumpkin Soup', [4, 5]]], 'duplicate catalog dishes are listed, not saved');
expect(plan.notSaved.notInCatalog, [{ name: 'Brand New Dish', sections: 'KG-LP' }], 'a dish not in the catalog is listed');
expect([plan.notSaved.blankDishes, plan.notSaved.blankRows, plan.notSaved.servedAsIs], [['Tuna Pasta'], 1, 1], 'blank rows and served-as-is rows are never saved');
const tie = planIngredientsSave({ catalog, categories, files: [{ fileName: 'f', rows: [
  row('KG - LP', 'Lunch Main Course', 'Tuna Pasta', 'pasta - tomato', '', 1), row('Staff', 'Main Dish', 'Tuna Pasta', 'pasta - tomato - tuna', '', 2),
] }] });
expect(tie.disagree[0].versions.map((v) => v.reason), ['1 row: KG-LP (first in the file -- same number of rows)', '1 row: Staff'], 'a tie says so');
expect(planIngredientsSave({ catalog, categories, files: [{ fileName: 'f', rows: [row('KG - LP', 'AM Snack', 'Cheese Croissant', undefined, undefined, 1)] }] }).hasLists, false, 'a plain menu (no Ingredients column) is recognised');

// ---- B. the save, against a stand-in database ---------------------------------------------------------------
function fakeDb(items) {
  const log = [];
  const db = {
    log, items, history: [],
    from(table) {
      const st = { table, filters: [], op: null, values: null };
      const chain = {
        update(values) { st.op = 'update'; st.values = values; return chain; },
        select(cols) { if (!st.op) st.op = 'select'; st.cols = cols; return chain; },
        insert(rows) { st.op = 'insert'; st.values = rows; return chain; },
        eq(col, v) { st.filters.push((r) => r[col] === v); return chain; },
        is(col, v) { st.filters.push((r) => (r[col] ?? null) === v); return chain; },
        then(resolve) {
          log.push({ table, op: st.op });
          if (st.op === 'insert') { db.history.push(...st.values); return resolve({ data: null, error: null }); }
          const hit = items.filter((r) => st.filters.every((f) => f(r)));
          if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.values)); return resolve({ data: hit.map((r) => ({ id: r.id })), error: null }); }
          return resolve({ data: hit.map((r) => ({ ...r })), error: null });
        },
      };
      return chain;
    },
  };
  return db;
}
(async () => {
  const items = [
    { id: 2, ingredients_text: 'old', ingredients_updated_at: '2026-10-02T08:00:00.000+00:00', ingredients_updated_by: 'tetiana' },
    { id: 3, ingredients_text: 'old', ingredients_updated_at: '2026-10-02T09:30:00.000+00:00', ingredients_updated_by: 'chef2' }, // changed after the preview
    { id: 4, ingredients_text: null, ingredients_updated_at: null },
  ];
  const db = fakeDb(items);
  const r = await applyIngredientSaves({ db, who: 'tetiana', source: 'menu_upload', sourceFile: 'September week_04_Ingredients.xlsx', now: () => '2026-10-02T10:00:00.000Z', saves: [
    { itemId: 2, name: 'Chicken Kabsa', ingredients: 'chicken - rice', allergens: '', expectedUpdatedAt: '2026-10-02T08:00:00.000+00:00', oldIngredients: 'old', oldAllergens: '' },
    { itemId: 3, name: 'Lentil Soup', ingredients: 'lentils', allergens: '', expectedUpdatedAt: '2026-10-01T08:00:00.000+00:00', oldIngredients: 'old', oldAllergens: '' },
    { itemId: 4, name: 'Cheese Croissant', ingredients: croissant, allergens: 'gluten - dairy', expectedUpdatedAt: null, oldIngredients: null, oldAllergens: null },
    { itemId: 99, name: 'Deleted Dish', ingredients: 'x', allergens: '', expectedUpdatedAt: null },
  ] });
  expect(r.saved.map((s) => s.itemId).sort(), [2, 4], 'unchanged-since-preview dishes are saved');
  expect(r.conflicts, [{ itemId: 3, name: 'Lentil Soup', by: 'chef2', at: '2026-10-02T09:30:00.000+00:00' }], 'a list saved by someone else since the preview is a conflict, with who and when');
  expect(items[1].ingredients_text, 'old', 'a conflict writes nothing');
  expect(r.failed.map((f) => [f.itemId, f.error]), [[99, 'the dish is no longer in the catalog']], 'a deleted dish fails cleanly');
  expect([items[2].ingredients_text, items[2].allergens_text, items[2].ingredients_updated_by, items[2].ingredients_source, items[2].ingredients_updated_at],
    [croissant, 'gluten - dairy', 'tetiana', 'menu_upload', '2026-10-02T10:00:00.000Z'], 'the saved fields');
  expect(items[0].allergens_text, null, 'a blank allergens cell is stored as nothing');
  expect(db.history.map((h) => [h.item_id, h.old_ingredients, h.new_ingredients, h.source, h.source_file, h.changed_by]).sort(), [
    [2, 'old', 'chicken - rice', 'menu_upload', 'September week_04_Ingredients.xlsx', 'tetiana'],
    [4, null, croissant, 'menu_upload', 'September week_04_Ingredients.xlsx', 'tetiana'],
  ], 'one history row per save, none for a conflict');
  expect(r.historyError, null, 'history written');

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Dish Catalog ingredients save OK (${count} checks).`);
})();
