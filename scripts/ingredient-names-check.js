#!/usr/bin/env node
// Ingredient name map (unification U2: lib/ingredientMatch.js + lib/ingredientNames.js), checked on its own (npm test):
//   A. resolve: exact master name (case / spacing aside), then a saved spelling, then "per recipe"; nothing else links --
//      not plural, not word order, not a near spelling.
//   B. candidates: ALL fitting products returned, best first, on real-style purchasing names; nothing is ever picked.
//   C. the queue: spellings of one word grouped ("egg" / "Eggs"), resolved rows left out, most-used first, coverage.
//   D. merge suggestions: punctuation and word-order duplicates only, never Full Fat / Low Fat.
//   E. the writes against a stand-in database: a decision per spelling; someone else's earlier decision handed back,
//      ours not written; a new ingredient marked 'name_review' with its other spellings as aliases; a merge moving recipe
//      rows and aliases, keeping the duplicate's name, deleting it, logging it; product-code choice.
// No login, no Supabase.
const { nameKey, spellingKey, buildResolver, candidatesFor, buildQueue, suggestMerges } = require('../lib/ingredientMatch');
const { saveDecision, addIngredientFromReview, undoDecision, planMerge, applyMerge } = require('../lib/ingredientNames');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

// Real names from the master list (U0 report).
const names = ['Salt Fine Grain', 'Salt Rock', 'Salt Citric (Lemon Salt)', 'Pop Corn Salt & Vinegar', 'Spice Pepper Whole Black', 'Oil Olive', 'Olive Oil Mini Jar',
  'Butter Kitchen', 'Butter Pastry', 'Butter Portion', 'Flat Butter Sheet', 'Egg Whole', 'Egg Powder', 'Can Quail Egg', 'Veg Carrot Baby', 'Veg Carrot Big',
  'Spice Cumin Powder', 'Spice Cumin Seed', 'Sugar', 'Water', 'Powder Corn Flour', 'Beef Short Rib', 'Beef Short-Rib', 'Frozen Corn Sweet', 'Frozen Sweet Corn',
  'Milk Liquid Full Fat', 'Milk Liquid Low Fat', 'Veg Onion', 'Spice Onion Powder', 'Veg Garlic'];
const master = names.map((name, i) => ({ id: i + 1, name, product_code: `FB-${100 + i}`, category: 'x', default_unit: 'G' }));
const idOf = (n) => master.find((m) => m.name === n).id;

// ---- A. resolve -----------------------------------------------------------------------------------------------
const aliases = [{ name_key: 'olive oil', ingredient_id: idOf('Oil Olive'), decision: 'alias' }, { name_key: 'butter', ingredient_id: null, decision: 'per_recipe' }];
const resolve = buildResolver({ master, aliases });
expect(resolve('  SUGAR '), { ingredientId: idOf('Sugar'), via: 'exact' }, 'exact master name, case / spacing aside');
expect(resolve('Olive  Oil'), { ingredientId: idOf('Oil Olive'), via: 'alias' }, 'a saved spelling');
expect(resolve('butter'), { perRecipe: true }, '"decide per recipe"');
expect([resolve('olive oils'), resolve('Oil olive extra'), resolve('salt'), resolve('Sugars')], [null, null, null, null], 'nothing else links: plural, extra words, a partial name');

// ---- B. candidates --------------------------------------------------------------------------------------------
expect(candidatesFor('salt', master).map((c) => c.name), ['Salt Rock', 'Salt Fine Grain', 'Pop Corn Salt & Vinegar', 'Salt Citric (Lemon Salt)'], 'salt: every salt product, shortest first');
expect(candidatesFor('black pepper', master).map((c) => c.name), ['Spice Pepper Whole Black'], 'black pepper -> the one product');
expect(candidatesFor('olive oil', master).slice(0, 2).map((c) => c.name), ['Oil Olive', 'Olive Oil Mini Jar'], 'olive oil: word order found');
expect(candidatesFor('eggs', master).map((c) => c.name), ['Egg Powder', 'Egg Whole', 'Can Quail Egg'], 'eggs (plural) finds the egg products (ties alphabetical)');
expect(candidatesFor('Butter', master).length, 4, 'butter: all four butter products returned');
expect(candidatesFor('ground cumin', master).map((c) => [c.name, c.tier]), [['Spice Cumin Powder', 2], ['Spice Cumin Seed', 2]], 'a descriptor word ("ground") ranks, never decides');
expect(candidatesFor('cornstarch', master), [], 'no word in common -> nothing offered (the search box finds "Powder Corn Flour")');

// ---- C. queue -------------------------------------------------------------------------------------------------
const usages = [
  ...Array(5).fill({ name: 'salt', recipe: 'Kabsa' }), ...Array(3).fill({ name: 'Salt', recipe: 'Soup' }),
  ...Array(2).fill({ name: 'eggs', recipe: 'Cake' }), { name: 'Egg', recipe: 'Omelette' },
  ...Array(4).fill({ name: 'sugar', recipe: 'Cake' }), ...Array(2).fill({ name: 'olive oil', recipe: 'Salad' }), { name: 'butter', recipe: 'Croissant' },
];
const q = buildQueue({ usages, master, aliases });
expect(q.queue.map((g) => [g.key, g.rows, g.spellings.map((s) => `${s.name}:${s.rows}`)]), [['salt', 8, ['salt:8']], ['egg', 3, ['eggs:2', 'Egg:1']]],
  'grouped by word (case-only variants are one spelling), resolved names (sugar exact, olive oil alias, butter per recipe) left out, most-used first');
expect([q.totalRows, q.resolvedRows], [18, 7], 'coverage counts');
expect(q.queue[0].examples, ['Kabsa', 'Soup'], 'examples of where a name is used');
expect([spellingKey('Eggs'), spellingKey("egg's"), spellingKey('Tomatoes'), spellingKey('Couscous')], ['egg', 'egg', 'tomato', 'couscous'], 'spelling groups');

// ---- D. merge suggestions -------------------------------------------------------------------------------------
expect(suggestMerges(master).map((s) => [s.why, s.items.map((m) => m.name)]),
  [['spelling', ['Beef Short Rib', 'Beef Short-Rib']], ['word order', ['Frozen Corn Sweet', 'Frozen Sweet Corn']]], 'only true duplicates, never Full Fat / Low Fat');

// ---- E. writes ------------------------------------------------------------------------------------------------
function fakeDb(tables) {
  const db = { t: tables, nextId: 1000 };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; }, single() { st.single = true; return chain; },
      insert(v) { st.op = 'insert'; st.v = Array.isArray(v) ? v : [v]; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; }, delete() { st.op = 'delete'; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; }, in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return chain; },
      ilike(c, v) { st.filters.push((r) => String(r[c]).toLowerCase() === String(v).toLowerCase()); return chain; },
      then(resolve) {
        const rows = db.t[table] = db.t[table] || [];
        if (st.op === 'insert') {
          if (table === 'ingredient_aliases' && st.v.some((r) => rows.some((x) => x.name_key === r.name_key))) return resolve({ error: { code: '23505', message: 'duplicate' } });
          const added = st.v.map((r) => ({ id: db.nextId++, ...r })); rows.push(...added);
          return resolve({ data: st.single ? added[0] : added, error: null });
        }
        const hit = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.v)); return resolve({ data: hit, error: null }); }
        if (st.op === 'delete') { db.t[table] = rows.filter((r) => !hit.includes(r)); return resolve({ data: hit, error: null }); }
        return resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return chain;
  };
  return db;
}

(async () => {
  const db = fakeDb({ ingredients: master.map((m) => ({ ...m })), ingredient_aliases: [{ id: 1, name_key: 'egg', ingredient_id: idOf('Egg Whole'), decision: 'alias', decided_by: 'chef2' }], recipe_ingredients: [] });
  expect(await saveDecision({ db, spellings: ['salt', 'Salt'], ingredientId: idOf('Salt Fine Grain'), who: 'tetiana' }), { saved: 1 }, 'one alias per spelling (case aside: one)');
  expect(db.t.ingredient_aliases.find((a) => a.name_key === 'salt').ingredient_id, idOf('Salt Fine Grain'), 'the chosen product');
  const taken = await saveDecision({ db, spellings: ['eggs', 'egg'], ingredientId: idOf('Egg Powder'), who: 'tetiana' });
  expect([taken.taken.map((t) => [t.name_key, t.decided_by]), db.t.ingredient_aliases.some((a) => a.name_key === 'eggs')], [[['egg', 'chef2']], false],
    'someone decided first: their decision comes back, none of ours is written');
  expect(await saveDecision({ db, spellings: ['Butter'], decision: 'per_recipe', who: 'tetiana' }), { saved: 1 }, '"decide per recipe" saved without a product');
  let threw = false; try { await saveDecision({ db, spellings: ['x'], who: 'a' }); } catch { threw = true; }
  expect(threw, true, 'an alias needs a product');

  const added = await addIngredientFromReview({ db, name: 'Juice  Lemon', category: 'Juice', defaultUnit: '', spellings: ['lemon juice', 'Lemon juice', 'juice lemon'], who: 'tetiana' });
  const row = db.t.ingredients.find((m) => m.name === 'Juice Lemon');
  expect([row.added_from, row.added_by, row.product_code, row.default_unit, added.saved], ['name_review', 'tetiana', null, 'G', 1], 'a new master row marked from the review; its other spelling becomes an alias');
  expect((await addIngredientFromReview({ db, name: 'oil olive', spellings: ['olive oil'], who: 'x' })).duplicate.name, 'Oil Olive', 'a name already in the list is refused, not duplicated');

  const before = db.t.ingredient_aliases.length;
  await undoDecision({ db, aliasIds: [db.t.ingredient_aliases.find((a) => a.name_key === 'butter').id] });
  expect(db.t.ingredient_aliases.length, before - 1, 'undo removes the decision');

  // Merge "Beef Short-Rib" into "Beef Short Rib": 2 recipe rows and 1 alias move.
  const keep = idOf('Beef Short Rib'), dup = idOf('Beef Short-Rib');
  db.t.recipe_ingredients.push({ id: 1, ingredient_id: dup }, { id: 2, ingredient_id: dup }, { id: 3, ingredient_id: keep });
  db.t.ingredient_aliases.push({ id: 50, name_key: 'short ribs', ingredient_id: dup, decision: 'alias' });
  const plan = await planMerge({ db, survivorId: keep, mergedId: dup });
  expect([plan.recipeRows, plan.aliases, plan.codeChoice], [2, 1, true], 'merge preview: rows, aliases, two different product codes');
  const r = await applyMerge({ db, survivorId: keep, mergedId: dup, keepCode: 'merged', who: 'tetiana' });
  expect([db.t.recipe_ingredients.map((x) => x.ingredient_id), db.t.ingredient_aliases.find((a) => a.id === 50).ingredient_id], [[keep, keep, keep], keep], 'recipe rows and aliases moved');
  expect(db.t.ingredient_aliases.find((a) => a.name_key === 'beef short-rib').ingredient_id, keep, "the duplicate's name now matches the survivor");
  expect([db.t.ingredients.some((m) => m.id === dup), db.t.ingredients.find((m) => m.id === keep).product_code, r.keptCode], [false, `FB-${100 + names.indexOf('Beef Short-Rib')}`, `FB-${100 + names.indexOf('Beef Short-Rib')}`],
    'the duplicate is deleted; the chosen product code kept');
  expect([db.t.ingredient_merge_history.length, db.t.ingredient_merge_history[0].recipe_rows_moved, db.t.ingredient_merge_history[0].merged_name], [1, 2, 'Beef Short-Rib'], 'the merge is logged');

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Ingredient name map OK (${count} checks).`);
})();
