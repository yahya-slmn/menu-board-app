#!/usr/bin/env node
// Master Items + Dish Variants planner (lib/masterItemsPlan.js, phase MV1), checked on its own (npm test):
//   A. one master item per exact name (case / spacing aside); different names never merge, however similar.
//   B. variants: identical lists (case / spacing / order aside) share one variant, keeping the most recent save's text and
//      who / when; different lists get one variant each.
//   C. rows without a list: join the only variant (assumption B); with 2+ variants they are left to pick; a name with no
//      list gets one empty variant.
//   D. the display name: "<sections> — <date>" until a recipe is linked, then the recipe's name.
//   E. randomised (2,000 catalogs): every saved list is carried exactly once, every row is in exactly one variant or left
//      to pick, nothing invented -- the guarantees for the real saved lists.
// No login, no Supabase.
const { planMasterItems, variantDisplayName } = require('../lib/masterItemsPlan');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};
const row = (id, name, cat, secs, list = null, at = null, by = null, al = null) => ({ id, name, category_name: cat, sections: secs, is_active: 1,
  ingredients_text: list, allergens_text: al, ingredients_updated_at: at, ingredients_updated_by: by, ingredients_source: list ? 'menu_upload' : null });

const p = planMasterItems([
  row(1, 'Macaroni & Cheese', 'Lunch Starch/Side', ['KG_LP', 'MS_UP'], 'pasta - cheese - milk', '2026-10-02T08:00:00Z', 'tetiana', 'dairy'),
  row(2, 'macaroni  &  cheese', 'Lunch Vegetable Side', ['MS_UP'], 'Milk - pasta -  cheese', '2026-10-02T09:00:00Z', 'chef2', 'Dairy'),
  row(3, 'Macaroni & Cheese', 'Main Dish', ['STAFF'], 'pasta - cheddar - cream', '2026-10-02T10:00:00Z', 'tetiana', 'dairy'),
  row(4, 'Macaroni & Cheese', 'Main Dish', ['CEO']),
  row(5, 'Kabsa Rice', 'Lunch Starch/Side', ['KG_LP'], 'rice - chicken', '2026-10-01T08:00:00Z', 'tetiana'),
  row(6, 'Kabsa Rice', 'Main Dish', ['STAFF']),
  row(7, 'Lentil Soup', 'Soup/Appetizer', ['DAYCARE']),
  row(8, 'Lentil Soups', 'Soup/Appetizer', ['KG_LP']),
]);
const m = (name) => p.masters.find((x) => x.name === name);

// ---- A
expect(p.masters.map((x) => x.name).sort(), ['Kabsa Rice', 'Lentil Soup', 'Lentil Soups', 'Macaroni & Cheese'], 'one master per exact name; "Lentil Soups" stays separate');
expect(m('Macaroni & Cheese').rowCount, 4, 'case / spacing variants of a name join one master');
// ---- B
const mac = m('Macaroni & Cheese');
expect(mac.variants.map((v) => v.rowIds), [[1, 2], [3]], 'identical lists (order / case aside) share a variant; a different list gets its own');
expect([mac.variants[0].list.ingredients, mac.variants[0].list.updatedBy, mac.variants[0].list.fromRowIds], ['Milk - pasta -  cheese', 'chef2', [1, 2]], 'the most recent save of identical lists is kept, with who / when');
// ---- C
expect(mac.unassigned, [4], 'with 2+ variants, a row without a list is left to pick');
expect(m('Kabsa Rice').variants.map((v) => v.rowIds), [[5, 6]], 'with one variant, a row without a list joins it (assumption B)');
expect([m('Lentil Soup').variants.length, m('Lentil Soup').variants[0].list, m('Lentil Soup').variants[0].rowIds], [1, null, [7]], 'no list at all: one empty variant');
expect([mac.variants[0].sections, m('Kabsa Rice').variants[0].sections], [['KG_LP', 'MS_UP'], ['KG_LP', 'STAFF']], "a variant's sections are every using row's");
expect(p.stats, { rows: 8, masters: 4, variants: 5, mastersWithSeveralVariants: 1, listsSaved: 4, listsCarried: 4, variantsWithList: 3, rowsJoiningAListedVariant: 1, rowsToPick: 1 }, 'the counts');
// ---- D
expect(variantDisplayName({ sections: mac.variants[1].sections, date: mac.variants[1].date }), 'Staff — 2 Oct 2026', 'section name — date (the date the list was saved)');
expect(variantDisplayName({ sections: ['STAFF', 'KG_LP'], date: null, createdAt: '2026-10-03T12:00:00Z' }), 'KG-LP, Staff — 3 Oct 2026', 'no list: the date it was created; sections in their usual order');
expect(variantDisplayName({ sections: ['STAFF'], date: '2026-10-02T10:00:00Z', recipeName: 'Macaroni & Cheese (Staff)' }), 'Macaroni & Cheese (Staff)', "a linked recipe's name wins");

// ---- E. randomised: the guarantees for the real lists
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 16) % n; }; // high bits: the low ones repeat
const NAMES = ['Kabsa', 'kabsa', 'KABSA ', 'Mac & Cheese', 'mac  & cheese', 'Soup', 'Soups', 'Rice', 'Pie'];
const LISTS = [null, null, 'a - b', 'b - A', 'a - b - c', 'x', ' X ', 'y - z'];
const SECS = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
let broken = 0;
for (let t = 0; t < 2000; t++) {
  const rows = Array.from({ length: 1 + rnd(14) }, (_, i) => row(i + 1, NAMES[rnd(NAMES.length)], 'c', [SECS[rnd(5)]], LISTS[rnd(LISTS.length)], `2026-10-0${1 + rnd(3)}T0${rnd(9)}:00:00Z`, 'u'));
  const q = planMasterItems(rows);
  const placed = q.masters.flatMap((x) => [...x.variants.flatMap((v) => v.rowIds), ...x.unassigned]);
  const carried = q.masters.flatMap((x) => x.variants.flatMap((v) => (v.list ? v.list.fromRowIds : [])));
  const listed = rows.filter((r) => r.ingredients_text && r.ingredients_text.trim()).map((r) => r.id);
  const ok = placed.length === rows.length && new Set(placed).size === rows.length
    && carried.length === listed.length && new Set(carried).size === listed.length && listed.every((id) => carried.includes(id))
    && q.masters.every((x) => x.variants.every((v) => !v.list || v.list.fromRowIds.every((id) => v.rowIds.includes(id))))
    && q.masters.every((x) => x.variants.filter((v) => v.list).length === new Set(x.variants.filter((v) => v.list).map((v) => v.list.ingredients.toLowerCase().split(' - ').map((s) => s.trim()).filter(Boolean).sort().join('|'))).size);
  if (!ok) broken++;
}
expect(broken, 0, '2,000 random catalogs: every row placed once, every list carried once onto a variant its rows use, no two variants with the same list');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Master Items planner OK (${count} checks, incl. 2,000 random catalogs).`);
