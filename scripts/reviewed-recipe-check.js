#!/usr/bin/env node
// Recipe Generator keeps the chef's reviewed list (lib/reviewedRecipe.js, Phase F), checked on its own (npm test):
//   A. origin: 'reviewed' for her ingredients (case / spacing aside), 'added' for the AI's, null with no list;
//   B. missing: her ingredients the recipe left out, a reworded or split one included ("sugar syrup" -> "sugar");
//   C. the filters with the chef's decisions: a nut match on HER ingredient kept as an override, an AI-added one
//      removed; student seafood ALWAYS removed, hers flagged; Staff seafood kept; no list = today's behaviour;
//   D. settleRetry: a complete retry wins, else the attempt leaving out fewer of her ingredients, else the first.
// Pure functions only: no login, no database, no AI.
const { missingReviewed, markRecipeIngredients, reviewFlagsValue, settleRetry } = require('../lib/reviewedRecipe');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};
const proc = (name, ...ingredients) => ({ name, method_steps: [], wastes: [], ingredients: ingredients.map((n) => ({ name: n, quantity: 10, unit: 'g', method: null })) });
const flat = (m) => m.processes.flatMap((p) => p.ingredients.map((i) => `${i.name}:${i.origin}${i.overridePolicy ? `:${i.overridePolicy}` : ''}`));

// ---- A + B. origin and missing --------------------------------------------------------------------------------
const reviewed = ['Egg Noodles', 'chicken breast', 'fresh thyme', 'sugar syrup'];
const m1 = markRecipeIngredients([proc('Dish', 'egg noodles', 'Chicken  Breast', 'fresh thyme', 'sugar', 'water', 'olive oil')], { reviewed });
expect(flat(m1), ['egg noodles:reviewed', 'Chicken  Breast:reviewed', 'fresh thyme:reviewed', 'sugar:added', 'water:added', 'olive oil:added'], 'origin per row');
expect(m1.flags.missing, ['sugar syrup'], '"sugar syrup" split into sugar + water counts as missing');
expect(missingReviewed(['zucchini', 'milk'], ['Zucchini', 'milk', 'salt']), [], 'nothing missing');
expect(missingReviewed(null, ['x']), [], 'no list: nothing can be missing');
const noList = markRecipeIngredients([proc('Dish', 'flour', 'water')], {});
expect(flat(noList), ['flour:null', 'water:null'], 'no reviewed list: origin null');
expect(reviewFlagsValue(noList.flags), null, 'nothing to flag -> null');

// ---- C. filters ---------------------------------------------------------------------------------------------
const nuts = markRecipeIngredients([proc('Dish', 'sesame-free burger bun', 'pine nuts', 'beef patty')], { reviewed: ['sesame-free burger bun', 'beef patty'] });
expect(flat(nuts), ['sesame-free burger bun:reviewed:nut', 'beef patty:reviewed'], 'a nut match on HER ingredient is kept as an override; the AI-added pine nuts are removed');
expect(nuts.removed, [{ name: 'pine nuts', policy: 'nut' }], 'the removal is reported');
const studentTuna = markRecipeIngredients([proc('Dish', 'tuna', 'mayonnaise', 'shrimp paste')], { reviewed: ['tuna', 'mayonnaise'], studentSeafoodBanned: true });
expect(flat(studentTuna), ['mayonnaise:reviewed'], 'student seafood ALWAYS removed, hers too -- no override');
expect(studentTuna.flags.seafoodRemoved, ['tuna'], 'her removed seafood is flagged on the draft');
expect(studentTuna.flags.missing, [], 'removed-for-students is not also counted as missing');
expect(reviewFlagsValue(studentTuna.flags), { missing: [], seafoodRemoved: ['tuna'] }, 'the flags stored');
const staffTuna = markRecipeIngredients([proc('Dish', 'tuna', 'mayonnaise')], { reviewed: ['tuna', 'mayonnaise'], studentSeafoodBanned: false });
expect(flat(staffTuna), ['tuna:reviewed', 'mayonnaise:reviewed'], 'Staff keeps its seafood');
const today = markRecipeIngredients([proc('Dish', 'walnuts', 'salmon', 'rice')], { studentSeafoodBanned: true });
expect(flat(today), ['rice:null'], 'no list: nut and student seafood removed as before');

// ---- D. settleRetry -------------------------------------------------------------------------------------------
const A = { name: 'A' }, B = { name: 'B' }, C = { name: 'C' }, D = { name: 'D' };
const s = settleRetry(
  [{ dish: A, gen: 'A1', absent: ['x'] }, { dish: B, gen: 'B1', absent: ['x', 'y'] }, { dish: C, gen: 'C1', absent: ['x'] }, { dish: D, gen: 'D1', absent: ['x'] }],
  { created: [{ dish: A, gen: 'A2' }], incomplete: [{ dish: B, gen: 'B2', absent: ['y'] }, { dish: C, gen: 'C2', absent: ['x', 'z'] }] },
);
expect(s.persist.map((x) => `${x.dish.name}:${x.gen}`).sort(), ['B:B2', 'C:C1', 'D:D1'], 'fewer missing wins; a failed retry keeps the first (A is complete: the caller saves A2)');
expect([...s.done].map((d) => d.name).sort(), ['A', 'B', 'C', 'D'], 'every dish ends with a recipe');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Reviewed-list rules OK (${count} checks).`);
