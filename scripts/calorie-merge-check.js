#!/usr/bin/env node
// Calories onto versions (lib/calorieMerge.js, phase MV5a), checked against a stand-in database (npm test):
//   A. what a row shows: its version's value, else its own frozen value (marked 'row'), else nothing.
//   B. the plan: agree / trusted (an unflagged value beats a flagged one) / pick / none / already; rows with no version.
//   C. the writes: picks must be one of the listed values; no pick = left empty.
//   D. apply: only empty versions are written, a re-run writes nothing, menu_items is never touched.
//   E. 2,000 random catalogs: a carried value is always one its rows hold, never a flagged one when an unflagged exists,
//      and every row's shown value is unchanged unless its version's rows disagreed (a row with none shows its version's).
// No login, no Supabase.
const { effectiveCalories, planCalorieMerge, mergeWrites, applyCalorieMerge } = require('../lib/calorieMerge');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

function fakeDb(t) {
  const db = { t, writes: 0 };
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
        if (st.op === 'update') { if (table !== 'dish_variants') throw new Error(`wrote ${table}`); db.writes++; hit.forEach((r) => Object.assign(r, st.v)); }
        return resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return chain;
  };
  return db;
}
const row = (id, v, cal, flagged = false, name = `Dish ${v}`) => ({ id, name, dish_variant_id: v, calories_per_100g: cal, calories_unverified: flagged });
const variant = (id, cal = null, flagged = false) => ({ id, calories_per_100g: cal, calories_unverified: flagged });

// A. what a row shows
expect(effectiveCalories(row(1, 1, 120), variant(1, 150)), { value: 150, unverified: false, source: 'version' }, 'A1 version wins');
expect(effectiveCalories(row(1, 1, 120, true), variant(1)), { value: 120, unverified: true, source: 'row' }, 'A2 empty version -> row, flag kept');
expect(effectiveCalories(row(1, null, 90), null), { value: 90, unverified: false, source: 'row' }, 'A3 no version -> row');
expect(effectiveCalories(row(1, 1, null), variant(1)), { value: null, unverified: false, source: null }, 'A4 nothing');
expect(effectiveCalories(row(1, 1, 0), variant(1)), { value: 0, unverified: false, source: 'row' }, 'A5 zero is a value');
expect(effectiveCalories(row(1, 1, 50), variant(1, '0', true)), { value: 0, unverified: true, source: 'version' }, 'A6 version zero (numeric text) wins');

// B. the plan
const rowsB = [
  row(1, 10, 120), row(2, 10, 120),                    // agree
  row(3, 11, 200), row(4, 11, 35, true),               // trusted: unflagged 200 beats flagged 35
  row(5, 12, 140), row(6, 12, 160),                    // pick: two unflagged
  row(7, 13, 300, true), row(8, 13, 310, true),        // pick: flagged only
  row(9, 14, null), row(10, 14, null),                 // none
  row(11, 15, 99),                                     // already (version has 80)
  row(12, null, 77), row(13, null, null),              // unlinked
  row(14, 16, 50), row(15, 16, null),                  // agree (blank rows don't count)
  row(16, 17, 60, true), row(17, 17, 60),              // same value, mixed flag -> unflagged
];
const varsB = [variant(10), variant(11), variant(12), variant(13), variant(14), variant(15, 80), variant(16), variant(17)];
const planB = planCalorieMerge({ rows: rowsB, variants: varsB });
const out = Object.fromEntries(planB.versions.map((v) => [v.variantId, [v.outcome, v.value, v.unverified]]));
expect(out, { 10: ['agree', 120, false], 11: ['trusted', 200, false], 12: ['pick', null, false], 13: ['pick', null, false], 14: ['none', null, false],
  15: ['already', 80, false], 16: ['agree', 50, false], 17: ['trusted', 60, false] }, 'B1 outcomes');
expect(planB.versions.find((v) => v.variantId === 12).candidates.map((c) => [c.value, c.unverified, c.rowIds]), [[140, false, [5]], [160, false, [6]]], 'B2 unflagged candidates');
expect(planB.versions.find((v) => v.variantId === 13).candidates.map((c) => [c.value, c.unverified]), [[300, true], [310, true]], 'B3 flagged-only candidates stay flagged');
expect(planB.unlinked, [12], 'B4 unlinked rows with a value');
expect(planB.summary, { versions: 8, agree: 2, trusted: 2, pick: 2, none: 1, already: 1, rowsWithValue: 13, unlinkedWithValue: 1 }, 'B5 summary');
// trust order beats "newer": a flagged value is never a candidate while an unflagged one exists
const planB6 = planCalorieMerge({ rows: [row(1, 1, 10, true), row(2, 1, 200), row(3, 1, 210), row(4, 1, 15, true)], variants: [variant(1)] });
expect(planB6.versions[0].candidates.map((c) => c.value), [200, 210], 'B6 flagged values never candidates beside unflagged');
// most-used candidate first
const planB7 = planCalorieMerge({ rows: [row(1, 1, 300), row(2, 1, 100), row(3, 1, 100)], variants: [variant(1)] });
expect(planB7.versions[0].candidates.map((c) => c.value), [100, 300], 'B7 most-used candidate listed first (not chosen)');

// C. the writes
const w = mergeWrites(planB, { 12: 160, 13: 999 });
expect(w.writes, [{ variantId: 10, value: 120, unverified: false }, { variantId: 11, value: 200, unverified: false }, { variantId: 12, value: 160, unverified: false },
  { variantId: 16, value: 50, unverified: false }, { variantId: 17, value: 60, unverified: false }], 'C1 writes');
expect([w.refused, w.unpicked], [[13], []], 'C2 a value that is not a candidate is refused');
expect(mergeWrites(planB, {}).unpicked, [12, 13], 'C3 no pick = left empty');
expect(mergeWrites(planB, { 13: '310' }).writes.find((x) => x.variantId === 13), { variantId: 13, value: 310, unverified: true }, 'C4 a flagged pick stays flagged');

// D. apply
(async () => {
  const t = { menu_items: rowsB.map((r) => ({ ...r })), dish_variants: varsB.map((v) => ({ ...v })) };
  const before = JSON.stringify(t.menu_items);
  const db = fakeDb(t);
  const r1 = await applyCalorieMerge({ db, writes: w.writes });
  expect([r1.written, r1.alreadySet, r1.failed], [5, [], []], 'D1 written');
  expect(t.dish_variants.map((v) => [v.id, v.calories_per_100g, v.calories_unverified]),
    [[10, 120, false], [11, 200, false], [12, 160, false], [13, null, false], [14, null, false], [15, 80, false], [16, 50, false], [17, 60, false]], 'D2 versions');
  expect(JSON.stringify(t.menu_items) === before, true, 'D3 menu_items untouched');
  const r2 = await applyCalorieMerge({ db, writes: w.writes });
  expect([r2.written, r2.alreadySet.length], [0, 5], 'D4 re-run writes nothing');
  expect(planCalorieMerge({ rows: t.menu_items, variants: t.dish_variants }).summary.already, 6, 'D5 re-plan sees them as already set');
  // shown values afterwards
  const byV = new Map(t.dish_variants.map((v) => [v.id, v]));
  const shown = t.menu_items.map((r) => [r.id, effectiveCalories(r, byV.get(r.dish_variant_id) || null).value]);
  expect(shown, [[1, 120], [2, 120], [3, 200], [4, 200], [5, 160], [6, 160], [7, 300], [8, 310], [9, null], [10, null], [11, 80], [12, 77], [13, null], [14, 50], [15, 50], [16, 60], [17, 60]], 'D6 shown values');

  // E. random catalogs (HIGH bits of the LCG -- the low bits repeat)
  let seed = 20261004;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  let bad = 0;
  for (let k = 0; k < 2000; k++) {
    const nv = 1 + rnd(6);
    const vars = Array.from({ length: nv }, (_, i) => variant(i + 1, rnd(8) === 0 ? 100 + rnd(5) : null, false));
    const rows = Array.from({ length: 1 + rnd(12) }, (_, i) => row(i + 1, rnd(7) === 0 ? null : 1 + rnd(nv), rnd(3) === 0 ? null : 100 + 10 * rnd(4), rnd(4) === 0));
    const plan = planCalorieMerge({ rows, variants: vars });
    const picks = {};
    for (const v of plan.versions) if (v.outcome === 'pick' && rnd(2)) picks[v.variantId] = v.candidates[rnd(v.candidates.length)].value;
    const tt = { menu_items: rows.map((r) => ({ ...r })), dish_variants: vars.map((v) => ({ ...v })) };
    const snap = JSON.stringify(tt.menu_items);
    await applyCalorieMerge({ db: fakeDb(tt), writes: mergeWrites(plan, picks).writes });
    if (JSON.stringify(tt.menu_items) !== snap) { bad++; continue; }
    const after = new Map(tt.dish_variants.map((v) => [v.id, v]));
    for (const v of plan.versions) {
      const used = rows.filter((r) => r.dish_variant_id === v.variantId && r.calories_per_100g != null);
      const got = after.get(v.variantId);
      if (v.outcome === 'already') { if (JSON.stringify(got) !== JSON.stringify(vars.find((x) => x.id === v.variantId))) bad++; continue; }
      if (got.calories_per_100g == null) { if (v.outcome !== 'none' && v.outcome !== 'pick') bad++; continue; }
      if (!used.some((r) => r.calories_per_100g === got.calories_per_100g)) bad++;
      if (used.some((r) => !r.calories_unverified) && (got.calories_unverified || !used.some((r) => !r.calories_unverified && r.calories_per_100g === got.calories_per_100g))) bad++;
    }
    for (const r of rows) {
      const old = effectiveCalories(r, null).value;
      const now = effectiveCalories(r, after.get(r.dish_variant_id) || null).value;
      const v = plan.versions.find((x) => x.variantId === r.dish_variant_id);
      // A row with no value of its own now shows its version's (as MV4's lists): expected, not a change of a value.
      if (old !== now && old != null && !(v && (v.outcome === 'trusted' || v.outcome === 'pick' || v.outcome === 'already'))) bad++;
    }
  }
  expect(bad, 0, 'E random catalogs');

  if (failures.length) { console.error(`Calorie merge FAILED:\n  ${failures.join('\n  ')}`); process.exit(1); }
  console.log(`Calorie merge OK (${count} checks, incl. 2,000 random catalogs).`);
})();
