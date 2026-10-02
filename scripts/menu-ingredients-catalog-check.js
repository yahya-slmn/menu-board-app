#!/usr/bin/env node
// Dish Catalog ingredients, M3 (lib/menuIngredientsCatalog.js), checked on its own (npm test):
//   A. No saved lists = today, exactly: the same rows reach the AI (same dishesForSuggestion), and every row is cleaned
//      field for field as before M3 (a frozen copy of the pre-M3 code below), plus `catalog: null`.
//   B. A catalog dish WITH a saved list is not sent; one without is; a name with rows of both kinds is sent once, for
//      the rows that need it; an inactive dish's list is used too.
//   C. The saved list is re-filtered for every row's own section by the same cleanSuggestion as an AI answer: student
//      seafood removed with its note (Staff keeps it), a nut term removed with its note, "-free" wording tidied.
//   D. "Same as" sharing (Phase D) on top: two catalog rows with the same filtered list follow; a Staff catalog row and a
//      KG-LP one whose seafood was removed do not; a catalog row and an AI row follow only when identical.
// No login, no Supabase, no AI.
const { splitRowsByCatalog, annotateRow } = require('../lib/menuIngredientsCatalog');
const { dishesForSuggestion, cleanSuggestion, rowSeafoodAllowed, isServedAsIsRow } = require('../lib/menuIngredientsRequest');
const { planShares, shareName, rowKey } = require('../lib/menuIngredientsShare');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

// The row cleaning exactly as main.js had it before M3 (frozen here on purpose: the "no change" proof).
function annotateBeforeM3(r, fileIndex, answers) {
  const servedAsIs = isServedAsIsRow(r);
  const est = servedAsIs ? null : answers.get(shareName(r.dishName));
  const res = est ? cleanSuggestion(est, { seafoodAllowed: rowSeafoodAllowed(r) }) : null;
  return {
    ...r, fileIndex, servedAsIs,
    ingredients: res ? res.ingredients : '', allergens: res ? res.allergens : '', basis: res ? res.basis : '',
    removedTerms: res ? res.removed.map(({ segment, policy }) => ({ segment, policy })) : [],
    removedAllergenTerms: res ? res.removedAllergens.map(({ segment, policy }) => ({ segment, policy })) : [],
    policyLog: res ? [...res.removed, ...res.removedAllergens] : [],
  };
}

const categories = [
  { code: 'AM_SNACK', name: 'AM Snack' }, { code: 'LUNCH_MAIN', name: 'Lunch Main Course' }, { code: 'SOUP_APPETIZER', name: 'Soup/Appetizer' },
  { code: 'FRUIT_BASKET', name: 'Fruit Basket' }, { code: 'STAFF_MAIN', name: 'Main Dish' },
];
let n = 0;
const school = (sheetName, category, dishName, date = '13-09-2026') => ({ sheetName, layout: 'SCHOOL', category, period: 'Lunch', dishName, rowNumber: ++n, weekday: 'Sunday', date });
const staff = (dishName, date = '13-09-2026') => ({ sheetName: 'Staff', layout: 'STAFF', category: 'Main Dish', period: 'Lunch', dishName, rowNumber: ++n, weekday: 'Sunday', date });
const saved = (id, name, category_code, ingredients_text, extra = {}) => ({ id, name, category_code, is_active: 1, ingredients_text, allergens_text: 'gluten',
  ingredients_updated_at: '2026-10-02T08:00:00.000+00:00', ingredients_updated_by: 'tetiana', ...extra });

const rows = [
  school('Daycare', 'AM Snack', 'Cheese Croissant'),                    // 1 saved list
  school('KG - LP', 'AM Snack', 'cheese  croissant'),                   // 2 saved list (case / spacing)
  school('MS - UP (B-G)', 'Lunch Main Course', 'Tuna Sandwich'),       // 3 saved list WITH tuna -> removed for students
  staff('Tuna Sandwich'),                                               // 4 Staff copy of the school dish -> keeps tuna
  school('KG - LP', 'Lunch Main Course', 'Walnut Brownie Bites'),      // 5 saved list with walnuts + "-free" wording
  school('KG - LP', 'Lunch Main Course', 'Vermicelli Rice'),           // 6 catalog dish, NO saved list -> AI
  school('KG - LP', 'Soup/Appetizer', 'Vermicelli Rice'),              // 7 not in that category -> AI (same name as 6: one call)
  school('Daycare', 'Lunch Main Course', 'Old Lentil Stew'),           // 8 inactive dish with a saved list -> used
  school('KG - LP', 'Lunch Main Course', 'Brand New Dish'),            // 9 not in the catalog -> AI
  school('MS - UP (B-G)', 'Lunch Main Course', 'Brand New Dish'),      // 10 same name, same day, AI too
  school('KG - LP', 'Fruit Basket', 'Fruit (a Selection of Seasonal Fruits)'), // 11 served as is
];
const catalog = [
  saved(1, 'Cheese Croissant', 'AM_SNACK', 'flour - butter - cheese - milk'),
  saved(2, 'Tuna Sandwich', 'LUNCH_MAIN', 'brown bread - tuna - mayonnaise - lettuce'),
  saved(3, 'Walnut Brownie Bites', 'LUNCH_MAIN', 'flour - cocoa - walnuts - sesame-free sunflower seeds - sugar - sugar'),
  { id: 4, name: 'Vermicelli Rice', category_code: 'LUNCH_MAIN', is_active: 1, ingredients_text: null },
  saved(5, 'Old Lentil Stew', 'LUNCH_MAIN', 'red lentils - onion - cumin', { is_active: 0 }),
];
const files = [{ fileIndex: 0, rows }];
const answers = new Map([
  ['vermicelli rice', { ingredients: 'rice - vermicelli - butter - salt', allergens: 'dairy', basis: { kind: 'regional', dish: 'Riz bi shaariyeh', cuisine: 'Lebanese' } }],
  ['brand new dish', { ingredients: 'rice - peas - carrot', allergens: '', basis: { kind: 'general' } }],
  ['cheese croissant', { ingredients: 'AI croissant - should not be used', allergens: '' }],
]);
const withIdx = (r) => ({ ...r, fileIndex: 0 });

// ---- A. no saved lists = today ------------------------------------------------------------------------------
for (const [label, cat] of [['an empty catalog', []], ['a catalog with no saved lists', catalog.map((c) => ({ ...c, ingredients_text: null }))]]) {
  const split = splitRowsByCatalog({ files, catalog: cat, categories });
  expect(split.fromCatalog.size, 0, `${label}: nothing from the catalog`);
  expect(dishesForSuggestion(split.aiRows), dishesForSuggestion(rows), `${label}: the same dishes reach the AI`);
  const now = rows.map((r) => annotateRow(r, 0, { answers, catalogItem: split.fromCatalog.get(rowKey(withIdx(r))) || null }));
  const before = rows.map((r) => ({ ...annotateBeforeM3(r, 0, answers), catalog: null }));
  expect(now, before, `${label}: every row cleaned field for field as before M3`);
}

// ---- B. what goes where -------------------------------------------------------------------------------------
const split = splitRowsByCatalog({ files, catalog, categories });
const fromCat = (i) => split.fromCatalog.get(rowKey(withIdx(rows[i - 1])))?.id ?? null;
expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(fromCat), [1, 1, 2, 2, 3, null, null, 5, null, null, null], 'rows served from the catalog (inactive dish 5 included)');
expect(dishesForSuggestion(split.aiRows).map((d) => d.name), ['Vermicelli Rice', 'Brand New Dish'], 'only the rest go to the AI, once per name');

// ---- C. re-filtered per row, every time ---------------------------------------------------------------------
const out = rows.map((r) => annotateRow(r, 0, { answers, catalogItem: split.fromCatalog.get(rowKey(withIdx(r))) || null }));
const at = (i) => out[i - 1];
expect([at(1).ingredients, at(1).basis, at(1).catalog], ['flour - butter - cheese - milk', '', { itemId: 1, name: 'Cheese Croissant', updatedAt: '2026-10-02T08:00:00.000+00:00', updatedBy: 'tetiana' }],
  'the saved list is used (not the AI answer), with where it came from');
expect([at(3).ingredients, at(3).removedTerms], ['brown bread - mayonnaise - lettuce', [{ segment: 'tuna', policy: 'seafood' }]], 'MS-UP: the saved tuna is removed, with its note');
expect([at(4).ingredients, at(4).removedTerms], ['brown bread - tuna - mayonnaise - lettuce', []], 'Staff: the same saved list keeps its tuna');
expect(at(5).ingredients, 'flour - cocoa - sunflower seeds - sugar', 'a saved nut term removed, "-free" wording and a repeat tidied -- the same clean-up as an AI answer');
expect(at(5).removedTerms.map((t) => t.policy), ['nut'], 'the nut removal is noted');
expect([at(6).ingredients, at(6).basis, at(6).catalog], ['rice - vermicelli - butter - salt', 'Regional: Riz bi shaariyeh (Lebanese)', null], 'an AI row is unchanged');
expect([at(11).servedAsIs, at(11).ingredients, at(11).catalog], [true, '', null], 'served as is stays blank');
const again = rows.map((r) => annotateRow(r, 0, { answers, catalogItem: split.fromCatalog.get(rowKey(withIdx(r))) || null }));
expect(again, out, 'the same input gives the same rows every time (nothing cached)');

// ---- D. "Same as" on top -------------------------------------------------------------------------------------
const follows = planShares(out);
const src = (i) => { const s = follows.get(rowKey(at(i))); return s ? s.rowNumber : null; };
expect(src(2), rows[0].rowNumber, 'KG-LP\'s croissant (catalog) follows Daycare\'s (catalog): same filtered list');
expect([src(3), src(4)], [null, null], 'the Staff Tuna Sandwich (tuna kept) and MS-UP\'s (tuna removed) hold their own lists');
expect(src(10), rows[8].rowNumber, 'two AI rows of a new dish still share as before');
const mixed = [annotateRow(school('Daycare', 'AM Snack', 'Cheese Croissant', '14-09-2026'), 0, { answers, catalogItem: catalog[0] }),
  annotateRow(school('KG - LP', 'Soup/Appetizer', 'Cheese Croissant', '14-09-2026'), 0, { answers: new Map([['cheese croissant', { ingredients: 'flour - butter - cheese - milk', allergens: 'gluten' }]]) })];
expect(planShares(mixed).size, 1, 'a catalog row and an AI row with the identical list share');
const mixed2 = [mixed[0], annotateRow(school('KG - LP', 'Soup/Appetizer', 'Cheese Croissant', '14-09-2026'), 0, { answers })];
expect(planShares(mixed2).size, 0, 'a catalog row and a different AI row do not');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Menu Ingredients from the Dish Catalog OK (${count} checks).`);
