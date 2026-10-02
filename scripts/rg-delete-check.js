#!/usr/bin/env node
// Recipe Generator bulk delete (lib/generatedRecipeDelete.js), checked on its own (npm test):
//   A. the plan: per folder, every selected recipe with its status / code and the menu dish it was made for; totals.
//   B. Master Items sharing the dish's name: EXACT name only (case / spacing aside) -- shown with versions and saved lists;
//      a similar name is not matched.
//   C. the RG counter: a deleted confirmed recipe's code is never reused.
// No login, no Supabase.
const { planGeneratedDelete, nextRgCode } = require('../lib/generatedRecipeDelete');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

const recipes = [
  { id: 3, name: 'Macaroni & Cheese (Staff)', code: 'RG-00072', status: 'confirmed', source_menu_label: 'September week_04.xlsx', source_dish_name: 'Macaroni  & cheese' },
  { id: 1, name: 'Chicken Kabsa', code: null, status: 'draft', source_menu_label: 'September week_04.xlsx', source_dish_name: 'Chicken Kabsa' },
  { id: 2, name: 'Lentil Soups', code: null, status: 'draft', source_menu_label: 'September week_03.xlsx', source_dish_name: 'Lentil Soups' },
  { id: 4, name: 'Mystery Dish', code: null, status: 'draft', source_menu_label: null, source_dish_name: null },
];
const masters = [
  { id: 10, name: 'Macaroni & Cheese', name_key: 'macaroni & cheese', versions: 2, versionsWithList: 2 },
  { id: 11, name: 'Chicken Kabsa', name_key: 'chicken kabsa', versions: 1, versionsWithList: 0 },
  { id: 12, name: 'Lentil Soup', name_key: 'lentil soup', versions: 1, versionsWithList: 1 },
];
const p = planGeneratedDelete({ recipes, masters, dependents: new Map([[1, { processes: 1, ingredients: 9 }], [3, { processes: 2, ingredients: 14 }]]) });

// ---- A
expect(p.folders.map((f) => [f.folder, f.drafts, f.confirmed, f.recipes.map((r) => r.id)]),
  [['September week_03.xlsx', 1, 0, [2]], ['September week_04.xlsx', 1, 1, [1, 3]], ['Unknown source', 1, 0, [4]]], 'grouped by folder (menu), sorted; drafts / confirmed per folder');
expect([p.total, p.drafts, p.confirmed, p.codes, p.dependentRows], [4, 3, 1, ['RG-00072'], { processes: 3, ingredients: 23 }], 'totals, the codes that go, the rows that go with them');
// ---- B
const r3 = p.folders[1].recipes.find((r) => r.id === 3);
expect([r3.dish, r3.master], ['Macaroni  & cheese', { name: 'Macaroni & Cheese', versions: 2, versionsWithList: 2 }], 'the dish it was made for, and the Master Item of that exact name (case / spacing aside)');
expect(p.folders[0].recipes[0].master, null, '"Lentil Soups" is NOT matched to the Master Item "Lentil Soup" (exact names only)');
expect([p.folders[2].recipes[0].dish, p.folders[2].recipes[0].master], ['Mystery Dish', null], 'no source dish: its own name is used');
expect(p.sharingAMasterItem, 2, 'how many share a name with a Master Item');
// ---- C
expect(nextRgCode(['RG-00070', 'RG-00071']), 'RG-00072', 'next code without deletions');
expect(nextRgCode(['RG-00070', 'RG-00071'], ['RG-00072', 'RG-00073']), 'RG-00074', 'deleted codes are never reused');
expect(nextRgCode([], ['RG-00009', 'junk', null]), 'RG-00010', 'only deleted ones known -- still after them');
expect(nextRgCode([]), 'RG-00001', 'the first code');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Recipe Generator bulk delete OK (${count} checks).`);
