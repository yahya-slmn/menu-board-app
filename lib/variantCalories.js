// ============================================================
// Master Items + Dish Variants, MV5b (2026-10-04): every calorie WRITE goes to the dish version (dish_variants
// .calories_per_100g / calories_unverified), shared by every Dish Catalog row using it -- Edit Item, Add Item, the
// "Estimate missing calories" backfill, the calorie review import and the calorie step after AI Approve. The old
// menu_items calorie columns are never written again (a frozen copy, dropped by hand in U8) and never shown: a row shows
// its version's value or nothing (decided with the chef: no fallback to the old column).
// Pure planners + small writers; database writes take the client as `db` (main.js passes Supabase; the check a stand-in).
// ============================================================

const num = (v) => (v == null || v === '' ? null : Number(v));

// What a catalog row shows: its version's calories, or nothing. Pure.
function versionCalories(variant) {
  const value = variant ? num(variant.calories_per_100g) : null;
  return { value, unverified: value != null && !!variant.calories_unverified };
}

// Edit Item: a value she CHANGED (or cleared: null), written only while the version still holds what the form opened
// with (`expected`, null = empty). Setting a value clears "unverified". -> { saved } | { unchanged } | { conflict: { now } }
async function saveVersionCalories({ db, variantId, value, expected }) {
  const v = num(value);
  if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error('Calories must be a number of 0 or more.');
  if (v === num(expected)) return { unchanged: true };
  let q = db.from('dish_variants').update({ calories_per_100g: v, calories_unverified: false }).eq('id', variantId);
  q = num(expected) == null ? q.is('calories_per_100g', null) : q.eq('calories_per_100g', num(expected));
  const { data, error } = await q.select('id');
  if (error) throw new Error(error.message || String(error));
  if (!data || !data.length) {
    const { data: cur } = await db.from('dish_variants').select('calories_per_100g').eq('id', variantId);
    return { conflict: { now: cur && cur[0] ? num(cur[0].calories_per_100g) : null } };
  }
  return { saved: true };
}

// Add Item, the backfill, the Approve step: a value for a version that has NONE yet (never overwrites).
// -> { saved } | { alreadySet: value }
async function setVersionCaloriesIfEmpty({ db, variantId, value, unverified = false }) {
  const { data, error } = await db.from('dish_variants').update({ calories_per_100g: num(value), calories_unverified: !!unverified })
    .eq('id', variantId).is('calories_per_100g', null).select('id');
  if (error) throw new Error(error.message || String(error));
  if (data && data.length) return { saved: true };
  const { data: cur } = await db.from('dish_variants').select('calories_per_100g').eq('id', variantId);
  return { alreadySet: cur && cur[0] ? num(cur[0].calories_per_100g) : null };
}

// The backfill's work list, ONE entry per version without calories that an in-scope row uses. Pure.
// inScopeRows: the in-scope catalog rows [{ id, name, category_id, protein_type_id, is_ai_generated, dish_variant_id }];
// allRows: every catalog row using those versions (same shape); variants: [{ id, calories_per_100g, ingredients_text }];
// schoolRowIds: Set of row ids served in a school section.
// -> [{ variantId, name, category_id, protein_type_id, aiRowIds, rowIds, checks: [{ category_id, protein_type_id }], list }]
// The prompt describes the version by ONE row: a school row first, else the lowest id; the plausibility check runs against
// every category / protein using the version.
function planVersionEstimates({ inScopeRows, allRows, variants, schoolRowIds = new Set() }) {
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const wanted = new Set(inScopeRows.map((r) => r.dish_variant_id).filter((id) => id != null && variantById.has(id) && num(variantById.get(id).calories_per_100g) == null));
  const rowsOf = new Map();
  for (const r of allRows) {
    if (!wanted.has(r.dish_variant_id)) continue;
    if (!rowsOf.has(r.dish_variant_id)) rowsOf.set(r.dish_variant_id, []);
    if (!rowsOf.get(r.dish_variant_id).some((x) => x.id === r.id)) rowsOf.get(r.dish_variant_id).push(r);
  }
  for (const r of inScopeRows) if (wanted.has(r.dish_variant_id) && !(rowsOf.get(r.dish_variant_id) || []).some((x) => x.id === r.id)) {
    if (!rowsOf.has(r.dish_variant_id)) rowsOf.set(r.dish_variant_id, []);
    rowsOf.get(r.dish_variant_id).push(r);
  }
  return [...rowsOf.entries()].sort((a, b) => a[0] - b[0]).map(([variantId, rows]) => {
    rows.sort((a, b) => a.id - b.id);
    const rep = rows.find((r) => schoolRowIds.has(r.id)) || rows[0];
    const seen = new Set();
    const checks = [];
    for (const r of rows) { const k = `${r.category_id}|${r.protein_type_id ?? ''}`; if (!seen.has(k)) { seen.add(k); checks.push({ category_id: r.category_id, protein_type_id: r.protein_type_id ?? null }); } }
    return { variantId, name: rep.name, category_id: rep.category_id, protein_type_id: rep.protein_type_id ?? null,
      aiRowIds: rows.filter((r) => r.is_ai_generated).map((r) => r.id), rowIds: rows.map((r) => r.id), checks,
      list: String(variantById.get(variantId).ingredients_text || '').trim() || null };
  });
}

// The review import, per VERSION. Pure. entries: the file's usable rows [{ id, value, rowNumber, name }] (already matched by
// ID + name, valid numbers); rowsById: Map(row id -> { id, name, dish_variant_id }); variantById: Map(id -> version);
// usersOf: Map(variant id -> [{ id, name, where }]) every row using it.
// -> { updates: [{ variantId, rowIds, name, from, fromFlagged, to, alsoChanges: [{ id, name, where }] }], unchanged,
//      skipped: [{ rowNumber, id, name, reason }] }
function planVersionImport({ entries, rowsById, variantById, usersOf }) {
  const skipped = [];
  const byVariant = new Map();
  for (const e of entries) {
    const row = rowsById.get(e.id);
    if (!row || row.dish_variant_id == null || !variantById.has(row.dish_variant_id)) { skipped.push({ rowNumber: e.rowNumber, id: String(e.id), name: e.name, reason: 'this dish has no version yet' }); continue; }
    if (!byVariant.has(row.dish_variant_id)) byVariant.set(row.dish_variant_id, []);
    byVariant.get(row.dish_variant_id).push(e);
  }
  const updates = [];
  let unchanged = 0;
  for (const [variantId, es] of [...byVariant.entries()].sort((a, b) => a[0] - b[0])) {
    const values = new Set(es.map((e) => e.value));
    if (values.size > 1) {
      for (const e of es) skipped.push({ rowNumber: e.rowNumber, id: String(e.id), name: e.name,
        reason: `shares one version with ${es.filter((x) => x !== e).map((x) => `ID ${x.id}`).join(', ')}, which has a different reviewed value (${[...values].join(' / ')})` });
      continue;
    }
    const v = variantById.get(variantId);
    const to = es[0].value;
    if (num(v.calories_per_100g) === to && !v.calories_unverified) { unchanged += es.length; continue; }
    const rowIds = es.map((e) => e.id);
    updates.push({ variantId, rowIds, name: rowsById.get(rowIds[0]).name, from: num(v.calories_per_100g), fromFlagged: !!v.calories_unverified, to,
      alsoChanges: (usersOf.get(variantId) || []).filter((u) => !rowIds.includes(u.id)) });
  }
  skipped.sort((a, b) => a.rowNumber - b.rowNumber);
  return { updates, unchanged, skipped };
}

// Writes the planned import values to the versions (reviewed values: "unverified" cleared). -> { written, failed }
async function applyVersionImport({ db, updates }) {
  let written = 0;
  const failed = [];
  for (let i = 0; i < updates.length; i += 20) {
    const results = await Promise.all(updates.slice(i, i + 20).map((u) =>
      db.from('dish_variants').update({ calories_per_100g: u.to, calories_unverified: false }).eq('id', u.variantId).select('id')
        .then(({ data, error }) => ({ u, data, error }))));
    for (const { u, data, error } of results) {
      if (error || !data || !data.length) failed.push({ id: u.variantId, name: u.name, message: error ? (error.message || String(error)) : 'the version no longer exists' });
      else written++;
    }
  }
  return { written, failed };
}

module.exports = { versionCalories, saveVersionCalories, setVersionCaloriesIfEmpty, planVersionEstimates, planVersionImport, applyVersionImport };
