// ============================================================
// Master Items + Dish Variants, MV5a (2026-10-04): calories move onto the dish VERSION (dish_variants.calories_per_100g /
// calories_unverified), like the ingredient lists did in MV4. This file is the merge (each version's value from the
// catalog rows using it, preview -> confirm) and the one rule every reader uses to show a row's calories.
//
// Trust order (confirmed with the chef): the database does not record where a value came from -- a typed value, a reviewed
// import and an AI estimate that passed the plausibility check all look the same; only an AI value that failed it carries
// calories_unverified. So: an UNFLAGGED value always beats a FLAGGED one, whichever is newer; when two or more different
// values of the same trust disagree, the chef picks in the preview (none preselected).
//
// HISTORICAL since MV5b (2026-10-04): the merge was run once on the live data and verified; the app no longer uses this
// file (reads and writes are lib/variantCalories.js, with NO fallback to the row's old column). Kept for the MV5a scripts
// (scripts/calorie-merge-check.js in npm test, scripts/calorie-merge-verify.js), which compare with the old columns.
// Database writes take the client as `db` (main.js passes Supabase; the check passes a stand-in).
// ============================================================

const num = (v) => (v == null || v === '' ? null : Number(v));

// What a catalog row shows: its version's value, else (during the transition) the row's own frozen value, marked.
// row: { calories_per_100g, calories_unverified, dish_variant_id }; variant: the version it uses, or null.
// -> { value, unverified, source: 'version' | 'row' | null }. Pure.
function effectiveCalories(row, variant) {
  if (variant && num(variant.calories_per_100g) != null) {
    return { value: num(variant.calories_per_100g), unverified: !!variant.calories_unverified, source: 'version' };
  }
  if (num(row.calories_per_100g) != null) return { value: num(row.calories_per_100g), unverified: !!row.calories_unverified, source: 'row' };
  return { value: null, unverified: false, source: null };
}

// The merge plan. rows: menu_items [{ id, name, dish_variant_id, calories_per_100g, calories_unverified }];
// variants: dish_variants [{ id, calories_per_100g, calories_unverified }]. Pure.
// Each version used by at least one row gets ONE outcome:
//   'already' -- the version already has a value: never overwritten (a re-run, or a later step wrote it)
//   'none'    -- none of its rows has a value: stays empty
//   'agree'   -- its rows with a value all say the same (same flag): carried as it is
//   'trusted' -- they differ, but only one value is unflagged: that one is carried (the flagged ones lose)
//   'pick'    -- two or more different values of the same (top) trust: the chef picks one, or it stays empty
// -> { versions: [{ variantId, outcome, value, unverified, candidates, rows }], unlinked: [rowIds with a value], summary }
function planCalorieMerge({ rows, variants }) {
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const rowsOf = new Map();
  const unlinked = [];
  for (const r of rows) {
    const value = num(r.calories_per_100g);
    if (r.dish_variant_id == null || !variantById.has(r.dish_variant_id)) { if (value != null) unlinked.push(r.id); continue; }
    if (!rowsOf.has(r.dish_variant_id)) rowsOf.set(r.dish_variant_id, []);
    rowsOf.get(r.dish_variant_id).push({ id: r.id, name: r.name, value, unverified: value != null && !!r.calories_unverified });
  }
  const versions = [];
  for (const [variantId, used] of [...rowsOf.entries()].sort((a, b) => a[0] - b[0])) {
    used.sort((a, b) => a.id - b.id);
    const v = variantById.get(variantId);
    const base = { variantId, rows: used, candidates: [] };
    if (num(v.calories_per_100g) != null) { versions.push({ ...base, outcome: 'already', value: num(v.calories_per_100g), unverified: !!v.calories_unverified }); continue; }
    const withValue = used.filter((r) => r.value != null);
    if (!withValue.length) { versions.push({ ...base, outcome: 'none', value: null, unverified: false }); continue; }
    const unflagged = withValue.filter((r) => !r.unverified);
    const top = unflagged.length ? unflagged : withValue; // trust order: unflagged first
    const byValue = new Map();
    for (const r of top) { if (!byValue.has(r.value)) byValue.set(r.value, []); byValue.get(r.value).push(r.id); }
    const candidates = [...byValue.entries()].map(([value, rowIds]) => ({ value, unverified: !unflagged.length, rowIds }))
      .sort((a, b) => b.rowIds.length - a.rowIds.length || a.value - b.value);
    if (candidates.length === 1) {
      const lost = withValue.length !== top.length || withValue.some((r) => r.value !== candidates[0].value);
      versions.push({ ...base, candidates, outcome: lost ? 'trusted' : 'agree', value: candidates[0].value, unverified: candidates[0].unverified });
    } else {
      versions.push({ ...base, candidates, outcome: 'pick', value: null, unverified: false });
    }
  }
  const count = (o) => versions.filter((x) => x.outcome === o).length;
  return {
    versions, unlinked,
    summary: {
      versions: versions.length, agree: count('agree'), trusted: count('trusted'), pick: count('pick'), none: count('none'), already: count('already'),
      rowsWithValue: rows.filter((r) => num(r.calories_per_100g) != null).length, unlinkedWithValue: unlinked.length,
    },
  };
}

// What the apply writes: 'agree' / 'trusted' versions, plus each 'pick' version the chef chose a candidate for
// (picks: { [variantId]: value }; a value that isn't one of that version's candidates is refused). Pure.
// -> { writes: [{ variantId, value, unverified }], refused: [variantId], unpicked: [variantId] }
function mergeWrites(plan, picks = {}) {
  const writes = [];
  const refused = [];
  const unpicked = [];
  for (const v of plan.versions) {
    if (v.outcome === 'agree' || v.outcome === 'trusted') { writes.push({ variantId: v.variantId, value: v.value, unverified: v.unverified }); continue; }
    if (v.outcome !== 'pick') continue;
    const chosen = picks[v.variantId];
    if (chosen == null || chosen === '') { unpicked.push(v.variantId); continue; }
    const c = v.candidates.find((x) => x.value === Number(chosen));
    if (!c) { refused.push(v.variantId); continue; }
    writes.push({ variantId: v.variantId, value: c.value, unverified: c.unverified });
  }
  return { writes, refused, unpicked };
}

// Writes the merge: each version only while it is STILL empty (never overwrites a value written meanwhile).
// -> { written, alreadySet: [variantId], failed: [{ variantId, error }] }
async function applyCalorieMerge({ db, writes }) {
  let written = 0;
  const alreadySet = [];
  const failed = [];
  for (let i = 0; i < writes.length; i += 20) {
    const results = await Promise.all(writes.slice(i, i + 20).map((w) =>
      db.from('dish_variants').update({ calories_per_100g: w.value, calories_unverified: !!w.unverified })
        .eq('id', w.variantId).is('calories_per_100g', null).select('id')
        .then(({ data, error }) => ({ w, data, error }))));
    for (const { w, data, error } of results) {
      if (error) failed.push({ variantId: w.variantId, error: error.message || String(error) });
      else if (!data || !data.length) alreadySet.push(w.variantId);
      else written++;
    }
  }
  return { written, alreadySet, failed };
}

module.exports = { effectiveCalories, planCalorieMerge, mergeWrites, applyCalorieMerge };
