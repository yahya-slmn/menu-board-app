#!/usr/bin/env node
// Recipe Generator, "choose which dishes get a recipe" -- checks of lib/recipeSelection.js on dishes deduped by the real
// dedupeWithinUpload. Above all: generating only a SUBSET keeps every dish's own reviewed list and name (two versions of one
// name included). No AI, no database. Part of npm test.
const assert = require('assert');
const { dedupeWithinUpload } = require('../lib/recipeGenerator');
const { existingRecipeIndex, checklistRows, selectDishes, generationEstimate } = require('../lib/recipeSelection');

let passed = 0;
const check = (name, fn) => { try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack || err.message}`); process.exitCode = 1; } };

const row = (dishName, category, section, list, dayLabel = 'Monday 05-10-2026', categoryGroup = 'MAIN') =>
  ({ dishName, category, section, dayLabel, categoryGroup, period: 'Lunch', reviewedIngredients: list });
const rows = [
  row('Zucchini Gratin', 'Lunch Main Course', 'KG_LP', ['zucchini', 'milk', 'flour', 'butter', 'cheddar']),
  row('Cheese Croissant', 'AM Snack', 'DAYCARE', ['croissant', 'cheese'], 'Monday 05-10-2026', 'AM_SNACK_BREAKFAST'),
  row('White Rice', 'Lunch Starch/Side', 'MS_UP', null, 'Monday 05-10-2026', 'SIDES'),
  row('Zucchini Gratin', 'Main Dish', 'STAFF', ['zucchini', 'cream', 'gruyere']), // her Staff edit: its own version
  row('zucchini  gratin', 'Lunch Main Course', 'MS_UP', ['zucchini', 'milk', 'flour', 'butter', 'cheddar']), // same as the first
  row('Lentil Soup', 'Soup/Appetizer', 'KG_LP', ['red lentils', 'onion', 'cumin', 'water'], 'Tuesday 06-10-2026', 'SOUP_APPETIZER'),
];
const dishes = dedupeWithinUpload(rows);

check('the dedupe is unchanged: one dish per name and list, a second version of a name kept apart and renamed', () => {
  assert.deepStrictEqual(dishes.map((d) => d.recipeName || d.name), ['Zucchini Gratin', 'Cheese Croissant', 'White Rice', 'Lentil Soup', 'Zucchini Gratin (Staff)']);
});

check('a subset keeps each dish\'s OWN list and name -- including just the second version of a name', () => {
  const keyOf = (n) => dishes.findIndex((d) => (d.recipeName || d.name) === n);
  const { selected, skipped } = selectDishes(dishes, [keyOf('Zucchini Gratin (Staff)'), keyOf('White Rice')]);
  assert.deepStrictEqual(selected.map((d) => d.recipeName || d.name), ['White Rice', 'Zucchini Gratin (Staff)'], 'the upload\'s own order');
  assert.deepStrictEqual(selected[1].reviewedIngredients, ['zucchini', 'cream', 'gruyere']);
  assert.strictEqual(selected[0].reviewedIngredients, null, 'a dish without a list stays without one');
  assert.strictEqual(selected[1], dishes[keyOf('Zucchini Gratin (Staff)')], 'the very same object goes on to generation');
  assert.deepStrictEqual(skipped.map((d) => d.recipeName || d.name), ['Zucchini Gratin', 'Cheese Croissant', 'Lentil Soup']);
  // What the generation loop sends per batch (main.js toItem: reviewedIngredients from the dish itself), by batch position.
  const items = selected.map((d, index) => ({ index, name: d.name, ...(d.reviewedIngredients ? { reviewedIngredients: d.reviewedIngredients } : {}) }));
  assert.deepStrictEqual(items, [{ index: 0, name: 'White Rice' }, { index: 1, name: 'Zucchini Gratin', reviewedIngredients: ['zucchini', 'cream', 'gruyere'] }]);
});

check('every subset of these dishes keeps every list (all 32 combinations)', () => {
  for (let mask = 0; mask < 1 << dishes.length; mask++) {
    const keys = dishes.map((_, i) => i).filter((i) => mask & (1 << i));
    const { selected, skipped } = selectDishes(dishes, keys);
    assert.strictEqual(selected.length + skipped.length, dishes.length);
    selected.forEach((d) => assert.ok(dishes.includes(d)));
    keys.forEach((k) => assert.ok(selected.includes(dishes[k])));
  }
});

check('keys not in the upload are ignored; nothing ticked selects nothing', () => {
  assert.strictEqual(selectDishes(dishes, [99, -1, 'x']).selected.length, 0);
  assert.strictEqual(selectDishes(dishes, []).selected.length, 0);
  assert.strictEqual(selectDishes(dishes, ['2']).selected[0].name, 'White Rice', 'a key sent as text still counts');
});

check('checklist rows: the recipe name, the menu category, day and group, how many listed ingredients', () => {
  const r = checklistRows(dishes);
  assert.deepStrictEqual(r.map((x) => [x.key, x.name, x.listCount, x.groupLabel]),
    [[0, 'Zucchini Gratin', 5, 'Main Hot Dish'], [1, 'Cheese Croissant', 2, 'Breakfast'], [2, 'White Rice', 0, 'Starch / Side Vegetables'],
      [3, 'Lentil Soup', 4, 'Soup / Appetizer'], [4, 'Zucchini Gratin (Staff)', 3, 'Main Hot Dish']]);
  assert.strictEqual(r[3].dayLabel, 'Tuesday 06-10-2026');
  assert.strictEqual(r[0].category, 'Lunch Main Course');
});

check('"already has a recipe": exact name only (case and spacing aside), draft or confirmed, confirmed wins; never a near spelling', () => {
  const idx = existingRecipeIndex([
    { name: 'white  RICE', source_dish_name: 'White Rice', status: 'draft', code: null },
    { name: 'Lentil Soup', source_dish_name: 'Lentil Soup', status: 'draft', code: null },
    { name: 'Lentil Soup', source_dish_name: 'Lentil Soup', status: 'confirmed', code: 'RG-00042' },
    { name: 'Cheese Croissants', source_dish_name: 'Cheese Croissants', status: 'confirmed', code: 'RG-00007' },
    { name: 'Gratin, renamed', source_dish_name: 'Zucchini Gratin', status: 'draft', code: null },
  ]);
  const r = checklistRows(dishes, idx);
  assert.deepStrictEqual(r.map((x) => x.existing), [{ status: 'draft', code: null }, null, { status: 'draft', code: null }, { status: 'confirmed', code: 'RG-00042' }, null]);
});

check('the estimate: batches of 8, 65 s each -- time only, no cost', () => {
  assert.deepStrictEqual(generationEstimate(196), { batches: 25, minutes: 28 });
  assert.deepStrictEqual(generationEstimate(1), { batches: 1, minutes: 2 });
});

console.log(`Recipe selection OK (${passed} checks)${process.exitCode ? ' -- some FAILED' : ''}.`);
