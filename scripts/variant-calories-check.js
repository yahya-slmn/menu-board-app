#!/usr/bin/env node
// Calorie writes on versions (lib/variantCalories.js + lib/calorieReview.js, phase MV5b), against a stand-in database
// (npm test):
//   A. what a row shows: its version's value or nothing (no fallback to the row's old column).
//   B. Edit Item: only a changed value is written, only while the version still holds what the form showed; setting a
//      value clears "unverified"; clearing is allowed; a bad number is refused.
//   C. Add Item / the backfill / Approve: a value only for a version that has none; an existing value is never overwritten.
//   D. the backfill's work list: one entry per empty version an in-scope row uses; described by a school row first; every
//      category / protein using it is checked; the version's approved list goes along.
//   E. the review import: rows of one version with the same value -> one write; different values -> skipped; unchanged;
//      a row with no version skipped; the other rows each change reaches are named; ID / name / number checks as before.
//   F. no code path writes menu_items' calorie columns any more (main.js and lib/, read as text).
// No login, no Supabase.
const fs = require('fs');
const path = require('path');
const { versionCalories, saveVersionCalories, setVersionCaloriesIfEmpty, planVersionEstimates, planVersionImport, applyVersionImport } = require('../lib/variantCalories');
const { validateReviewRows, planCalorieImport } = require('../lib/calorieReview');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

function fakeDb(t) {
  const db = { t };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return chain; },
      then(resolve) {
        const rows = db.t[table] || [];
        const hit = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === 'update') { if (table !== 'dish_variants') throw new Error(`wrote ${table}`); hit.forEach((r) => Object.assign(r, st.v)); }
        return resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return chain;
  };
  return db;
}
const V = (id, cal = null, flagged = false, list = null) => ({ id, calories_per_100g: cal, calories_unverified: flagged, ingredients_text: list });

(async () => {
  // A
  expect([versionCalories(V(1, 150)), versionCalories(V(1, '0', true)), versionCalories(V(1)), versionCalories(null)],
    [{ value: 150, unverified: false }, { value: 0, unverified: true }, { value: null, unverified: false }, { value: null, unverified: false }], 'A1 version only');

  // B. Edit Item
  {
    const t = { dish_variants: [V(1, 150, true), V(2), V(3, 90)], menu_items: [{ id: 1, calories_per_100g: 80, dish_variant_id: 1 }] };
    const before = JSON.stringify(t.menu_items);
    const db = fakeDb(t);
    expect(await saveVersionCalories({ db, variantId: 1, value: 150, expected: 150 }), { unchanged: true }, 'B1 same value -> nothing');
    expect(await saveVersionCalories({ db, variantId: 1, value: 165, expected: 150 }), { saved: true }, 'B2 changed -> saved');
    expect([t.dish_variants[0].calories_per_100g, t.dish_variants[0].calories_unverified], [165, false], 'B3 value set, unverified cleared');
    expect(await saveVersionCalories({ db, variantId: 1, value: 170, expected: 150 }), { conflict: { now: 165 } }, 'B4 changed meanwhile -> refused');
    expect(await saveVersionCalories({ db, variantId: 2, value: 120, expected: null }), { saved: true }, 'B5 empty -> set');
    t.dish_variants[1].calories_per_100g = 125; // someone else
    expect(await saveVersionCalories({ db, variantId: 2, value: 130, expected: 120 }), { conflict: { now: 125 } }, 'B6 refused, names the new value');
    expect(await saveVersionCalories({ db, variantId: 3, value: null, expected: 90 }), { saved: true }, 'B7 clearing allowed');
    expect(t.dish_variants[2].calories_per_100g, null, 'B8 cleared');
    let threw = false; try { await saveVersionCalories({ db, variantId: 3, value: -5, expected: null }); } catch { threw = true; }
    expect(threw, true, 'B9 negative refused');
    expect(JSON.stringify(t.menu_items) === before, true, 'B10 menu_items untouched');
  }

  // C. set only if empty
  {
    const t = { dish_variants: [V(1), V(2, 200)] };
    const db = fakeDb(t);
    expect(await setVersionCaloriesIfEmpty({ db, variantId: 1, value: 140, unverified: true }), { saved: true }, 'C1 empty -> set');
    expect([t.dish_variants[0].calories_per_100g, t.dish_variants[0].calories_unverified], [140, true], 'C2 flag kept as given');
    expect(await setVersionCaloriesIfEmpty({ db, variantId: 2, value: 999 }), { alreadySet: 200 }, 'C3 existing value never overwritten');
    expect(t.dish_variants[1].calories_per_100g, 200, 'C4 still 200');
  }

  // D. the backfill's work list
  {
    const row = (id, v, cat, prot = null, ai = false, name = `Dish ${v}`) => ({ id, name, category_id: cat, protein_type_id: prot, is_ai_generated: ai, dish_variant_id: v });
    const variants = [V(1, null, false, 'lentils - onion'), V(2), V(3, 150), V(4)];
    const inScopeRows = [row(10, 1, 5), row(11, 2, 6, 1, true), row(12, 3, 5), row(14, null, 5)];
    const allRows = [row(10, 1, 5), row(9, 1, 20, 2, false, 'Lentil Soup (Staff)'), row(13, 1, 5), row(11, 2, 6, 1, true), row(12, 3, 5), row(30, 4, 5)];
    const plan = planVersionEstimates({ inScopeRows, allRows, variants, schoolRowIds: new Set([10, 13]) });
    expect(plan.map((p) => p.variantId), [1, 2], 'D1 one per empty in-scope version (3 has a value, 4 not in scope)');
    expect([plan[0].name, plan[0].rowIds, plan[0].list], ['Dish 1', [9, 10, 13], 'lentils - onion'], 'D2 described by a school row; every row using it; its list');
    expect(plan[0].checks, [{ category_id: 20, protein_type_id: 2 }, { category_id: 5, protein_type_id: null }], 'D3 every category / protein, once');
    expect([plan[1].aiRowIds, plan[1].list], [[11], null], 'D4 AI rows kept for key ingredients');
  }

  // E. the review import, per version
  {
    const rowsById = new Map([[1, { id: 1, name: 'Lentil Soup', dish_variant_id: 10 }], [2, { id: 2, name: 'Lentil Soup', dish_variant_id: 10 }],
      [3, { id: 3, name: 'Kabsa', dish_variant_id: 11 }], [4, { id: 4, name: 'Kabsa', dish_variant_id: 11 }], [5, { id: 5, name: 'Fattoush', dish_variant_id: 12 }],
      [6, { id: 6, name: 'Shakshuka', dish_variant_id: 13 }], [7, { id: 7, name: 'Maqluba', dish_variant_id: null }]]);
    const variantById = new Map([[10, V(10, 60)], [11, V(11, 150)], [12, V(12, 40, true)], [13, V(13, 110)]]);
    const usersOf = new Map([[10, [{ id: 1, name: 'Lentil Soup', where: 'Lunch Soup [Daycare]' }, { id: 2, name: 'Lentil Soup', where: 'Lunch Soup [KG-LP]' }, { id: 8, name: 'Lentil Soup', where: 'Main Dish [Staff]' }]],
      [11, []], [12, [{ id: 5, name: 'Fattoush', where: 'x' }]], [13, [{ id: 6, name: 'Shakshuka', where: 'y' }]]]);
    const entries = [{ id: 1, value: 70, rowNumber: 2, name: 'Lentil Soup' }, { id: 2, value: 70, rowNumber: 3, name: 'Lentil Soup' },
      { id: 3, value: 160, rowNumber: 4, name: 'Kabsa' }, { id: 4, value: 170, rowNumber: 5, name: 'Kabsa' },
      { id: 5, value: 40, rowNumber: 6, name: 'Fattoush' }, { id: 6, value: 110, rowNumber: 7, name: 'Shakshuka' }, { id: 7, value: 200, rowNumber: 8, name: 'Maqluba' }];
    const p = planVersionImport({ entries, rowsById, variantById, usersOf });
    expect(p.updates.map((u) => [u.variantId, u.rowIds, u.from, u.fromFlagged, u.to]), [[10, [1, 2], 60, false, 70], [12, [5], 40, true, 40]], 'E1 one write per version; a flagged equal value is confirmed');
    expect(p.updates[0].alsoChanges, [{ id: 8, name: 'Lentil Soup', where: 'Main Dish [Staff]' }], 'E2 names the other rows it reaches');
    expect(p.unchanged, 1, 'E3 unchanged');
    expect(p.skipped.map((k) => [k.rowNumber, k.reason.slice(0, 22)]), [[4, 'shares one version wit'], [5, 'shares one version wit'], [8, 'this dish has no versi']], 'E4 skipped with reasons');
    // ID / name / number checks as before, then per version
    const dishesById = new Map([[1, { id: 1, name: 'Lentil Soup' }], [2, { id: 2, name: 'Lentil Soup' }]]);
    const parsed = [{ rowNumber: 2, id: '1', name: 'lentil  soup', reviewed: '70' }, { rowNumber: 3, id: '2', name: 'Kabsa', reviewed: '70' },
      { rowNumber: 4, id: '9', name: 'X', reviewed: '1' }, { rowNumber: 5, id: '1', name: 'Lentil Soup', reviewed: '' }, { rowNumber: 6, id: '2', name: 'Lentil Soup', reviewed: '950' }];
    const v = validateReviewRows(parsed, dishesById);
    expect([v.entries.map((e) => [e.id, e.value]), v.blank, v.skipped.map((k) => k.rowNumber)], [[[1, 70]], 1, [3, 4, 6]], 'E5 validation unchanged');
    const full = planCalorieImport(parsed, { dishesById, rowsById, variantById, usersOf });
    expect([full.updates.map((u) => [u.variantId, u.rowIds]), full.skipped.map((k) => k.rowNumber)], [[[10, [1]]], [3, 4, 6]], 'E6 the whole plan');
    const t = { dish_variants: [V(10, 60), V(12, 40, true)], menu_items: [{ id: 1, calories_per_100g: 55 }] };
    const r = await applyVersionImport({ db: fakeDb(t), updates: p.updates });
    expect([r.written, t.dish_variants.map((x) => [x.calories_per_100g, x.calories_unverified]), t.menu_items[0].calories_per_100g], [2, [[70, false], [40, false]], 55], 'E7 written to versions only');
  }

  // F. nothing writes menu_items' calorie columns
  {
    const root = path.join(__dirname, '..');
    const files = ['main.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js') && f !== 'calorieMerge.js').map((f) => `lib/${f}`)];
    const hits = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      // an update of menu_items naming a calorie column, within one statement
      for (const m of src.matchAll(/from\(\s*'menu_items'\s*\)[^;]*?\.update\(\s*\{[^;]*?calories_(per_100g|unverified)/gs)) hits.push(`${f}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`);
      // an insert into menu_items setting calories to anything but null
      for (const m of src.matchAll(/from\(\s*'menu_items'\s*\)\s*\.insert\(\s*\{[^;]*?calories_per_100g:\s*([^,\n}]+)/gs)) if (m[1].trim() !== 'null') hits.push(`${f}: insert sets calories_per_100g: ${m[1].trim()}`);
    }
    expect(hits, [], 'F1 no write to menu_items calorie columns');
  }

  if (failures.length) { console.error(`Version calories FAILED:\n  ${failures.join('\n  ')}`); process.exit(1); }
  console.log(`Version calories OK (${count} checks).`);
})();
