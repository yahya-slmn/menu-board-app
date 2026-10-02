// ============================================================
// Master Items + Dish Variants, MV3 + MV4 (2026-10-04). The Master Items screen's data and its writes, and the one place
// that turns a catalog row's version into the list it uses.
//
// One list per VERSION (dish_variants), shared by every Dish Catalog row using it (menu_items.dish_variant_id). From MV4
// every ingredient feature reads and writes the version: Menu Ingredients' reuse (M3), the approved-file save (M2), Edit
// Item's fields and this screen. The old list columns on menu_items are no longer written (a frozen copy). A catalog row
// is never changed here except its dish_variant_id (moving it to another version of the same dish, or unlinking it).
// Database writes take the client as `db` (main.js passes Supabase; the checks pass a stand-in).
// ============================================================
const { variantDisplayName } = require('./masterItemsPlan');

const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const blankToNull = (s) => (tidy(s) ? String(s).trim() : null);
const LIST_FIELDS = ['ingredients_text', 'allergens_text', 'ingredients_updated_at', 'ingredients_updated_by', 'ingredients_source'];

// Each catalog row with the list of the version it uses (and that version's id) in place of the row's own (frozen) list
// columns. A row with no version has no list. Pure. items: menu_items rows; variants: dish_variants rows.
function withVariantLists(items, variants) {
  const byId = new Map(variants.map((v) => [v.id, v]));
  return items.map((it) => {
    const v = it.dish_variant_id != null ? byId.get(it.dish_variant_id) : null;
    const out = { ...it, variant_id: v ? v.id : null };
    for (const f of LIST_FIELDS) out[f] = v ? (v[f] ?? null) : null;
    return out;
  });
}

// The screen's list: [{ id, name, rows, versions: [{ id, displayName, ingredients, allergens, updatedAt, updatedBy, source,
// calories, recipe, rows: [{ id, name, category, sections, active }] }] }], sorted by name. Pure.
// rows: [{ id, name, category_name, sections: [code], sectionNames: [name], is_active, dish_variant_id }];
// recipes: [{ id, code, name }] (linked recipes, U3).
function buildMasterList({ masters, variants, rows, recipes = [] }) {
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const rowsOf = new Map();
  for (const r of rows) if (r.dish_variant_id != null) { if (!rowsOf.has(r.dish_variant_id)) rowsOf.set(r.dish_variant_id, []); rowsOf.get(r.dish_variant_id).push(r); }
  const versionsOf = new Map();
  for (const v of variants) { if (!versionsOf.has(v.master_item_id)) versionsOf.set(v.master_item_id, []); versionsOf.get(v.master_item_id).push(v); }
  return masters.map((m) => {
    const versions = (versionsOf.get(m.id) || []).sort((a, b) => a.id - b.id).map((v) => {
      const used = (rowsOf.get(v.id) || []).sort((a, b) => a.id - b.id);
      const recipe = v.recipe_id != null ? recipeById.get(v.recipe_id) || null : null;
      const sections = [...new Set(used.flatMap((r) => r.sections || []))];
      return {
        id: v.id, displayName: variantDisplayName({ sections, date: v.ingredients_updated_at, createdAt: v.created_at, recipeName: recipe && recipe.name }),
        ingredients: v.ingredients_text || '', allergens: v.allergens_text || '', updatedAt: v.ingredients_updated_at || null, updatedBy: v.ingredients_updated_by || null,
        source: v.ingredients_source || null, calories: v.calories_per_100g ?? null, recipe: recipe ? { id: recipe.id, code: recipe.code, name: recipe.name } : null,
        rows: used.map((r) => ({ id: r.id, name: r.name, category: r.category_name, sections: r.sectionNames || r.sections || [], active: r.is_active !== 0 && r.is_active !== false })),
      };
    });
    return { id: m.id, name: m.name, rows: versions.reduce((n, v) => n + v.rows.length, 0), versions };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// A version's list, edited (this screen, Edit Item). Written only if nobody saved it since it was read
// (expectedUpdatedAt); one history row (dish_variant_id, no catalog row). -> { saved, updatedAt } | { conflict: { by, at } }
async function saveVariantList({ db, variantId, ingredients, allergens, expectedUpdatedAt = null, who, source = 'manual', sourceFile = null, now = () => new Date().toISOString() }) {
  const { data: cur, error: rErr } = await db.from('dish_variants').select('id, ingredients_text, allergens_text, ingredients_updated_at, ingredients_updated_by').eq('id', variantId);
  if (rErr) throw new Error(rErr.message || String(rErr));
  const v = (cur || [])[0];
  if (!v) throw new Error('This version no longer exists.');
  if (tidy(v.ingredients_text) === tidy(ingredients) && tidy(v.allergens_text) === tidy(allergens)) return { saved: false, unchanged: true, updatedAt: v.ingredients_updated_at };
  const at = now();
  let q = db.from('dish_variants').update({ ingredients_text: blankToNull(ingredients), allergens_text: blankToNull(allergens), ingredients_updated_at: at, ingredients_updated_by: who || null, ingredients_source: source }).eq('id', variantId);
  q = expectedUpdatedAt == null ? q.is('ingredients_updated_at', null) : q.eq('ingredients_updated_at', expectedUpdatedAt);
  const { data, error } = await q.select('id');
  if (error) throw new Error(error.message || String(error));
  if (!data || !data.length) return { conflict: { by: v.ingredients_updated_by || null, at: v.ingredients_updated_at || null } };
  const { error: hErr } = await db.from('menu_item_ingredient_history').insert({ item_id: null, dish_variant_id: variantId, old_ingredients: blankToNull(v.ingredients_text),
    new_ingredients: blankToNull(ingredients), old_allergens: blankToNull(v.allergens_text), new_allergens: blankToNull(allergens), source, source_file: sourceFile, changed_by: who || null, changed_at: at });
  return { saved: true, updatedAt: at, historyError: hErr ? (hErr.message || String(hErr)) : null };
}

// A catalog row moved to another version of the SAME dish, or to a new version (a copy of its current list, to edit).
// Only menu_items.dish_variant_id changes, and only if the row still uses fromVariantId. -> { moved, toVariantId } | { stale }
async function moveRowToVersion({ db, rowId, fromVariantId, toVariantId = null, who }) {
  const { data: from } = await db.from('dish_variants').select('id, master_item_id, ingredients_text, allergens_text, ingredients_updated_at, ingredients_updated_by, ingredients_source').eq('id', fromVariantId);
  const f = (from || [])[0];
  if (!f) throw new Error('The version this row used no longer exists.');
  let target = toVariantId;
  if (target != null) {
    const { data: to } = await db.from('dish_variants').select('id, master_item_id').eq('id', target);
    const t = (to || [])[0];
    if (!t) throw new Error('That version no longer exists.');
    if (t.master_item_id !== f.master_item_id) throw new Error('A row can only use a version of its own dish.');
  } else {
    const { data: made, error } = await db.from('dish_variants').insert({ master_item_id: f.master_item_id, ingredients_text: f.ingredients_text, allergens_text: f.allergens_text,
      ingredients_updated_at: f.ingredients_updated_at, ingredients_updated_by: f.ingredients_updated_by, ingredients_source: f.ingredients_source, created_by: who || null }).select('id');
    if (error) throw new Error(error.message || String(error));
    target = made[0].id;
  }
  const { data, error } = await db.from('menu_items').update({ dish_variant_id: target }).eq('id', rowId).eq('dish_variant_id', fromVariantId).select('id');
  if (error) throw new Error(error.message || String(error));
  if (!data || !data.length) {
    if (toVariantId == null) await db.from('dish_variants').delete().eq('id', target); // the new version is not needed after all
    return { stale: true };
  }
  return { moved: true, toVariantId: target, created: toVariantId == null };
}

// Delete a version, or a whole master item. Refused while catalog rows use it unless `unlink`: then those rows' link is
// cleared first (only their dish_variant_id -- the rows stay in the catalog, served by the AI until linked again).
// A version's list is kept in the history (source 'version_deleted').
async function deleteVersionOrMaster({ db, variantId = null, masterId = null, unlink = false, who }) {
  const { data: vs } = variantId != null ? await db.from('dish_variants').select('id, master_item_id, ingredients_text, allergens_text').eq('id', variantId)
    : await db.from('dish_variants').select('id, master_item_id, ingredients_text, allergens_text').eq('master_item_id', masterId);
  const ids = (vs || []).map((v) => v.id);
  const { data: users } = ids.length ? await db.from('menu_items').select('id').in('dish_variant_id', ids) : { data: [] };
  const inUse = (users || []).length;
  if (inUse && !unlink) return { inUse };
  if (inUse) {
    const { error } = await db.from('menu_items').update({ dish_variant_id: null }).in('dish_variant_id', ids);
    if (error) throw new Error(error.message || String(error));
  }
  const kept = (vs || []).filter((v) => tidy(v.ingredients_text));
  if (kept.length) {
    await db.from('menu_item_ingredient_history').insert(kept.map((v) => ({ item_id: null, dish_variant_id: v.id, old_ingredients: v.ingredients_text, new_ingredients: null,
      old_allergens: v.allergens_text || null, new_allergens: null, source: 'version_deleted', changed_by: who || null })));
  }
  const del = masterId != null ? db.from('master_items').delete().eq('id', masterId) : db.from('dish_variants').delete().eq('id', variantId);
  const { error } = await del;
  if (error) throw new Error(error.message || String(error));
  return { deleted: true, unlinked: inUse };
}

// The Master Items LIST (what the screen shows before a dish is opened -- nothing else is loaded for it): per master item
// its code(s) from linked recipes, its Created By (the labels of the Dish Catalog rows using its versions, most common first,
// the Dish Catalog's own read-only attribution: AI / OLD / a chef's name), and its version ids (for the Ingredients button).
// Pure. rows: [{ id, dish_variant_id, created_by_label }]; variants: [{ id, master_item_id, recipe_id, ingredients_text }].
function buildMasterSummaries({ masters, variants, rows, recipes = [] }) {
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const labelsOfVariant = new Map();
  for (const r of rows) {
    if (r.dish_variant_id == null) continue;
    if (!labelsOfVariant.has(r.dish_variant_id)) labelsOfVariant.set(r.dish_variant_id, []);
    labelsOfVariant.get(r.dish_variant_id).push(tidy(r.created_by_label));
  }
  const versionsOf = new Map();
  for (const v of variants) { if (!versionsOf.has(v.master_item_id)) versionsOf.set(v.master_item_id, []); versionsOf.get(v.master_item_id).push(v); }
  return masters.map((m) => {
    const vs = (versionsOf.get(m.id) || []).sort((a, b) => a.id - b.id);
    const count = new Map();
    for (const v of vs) for (const l of labelsOfVariant.get(v.id) || []) if (l) count.set(l, (count.get(l) || 0) + 1);
    const codes = [...new Set(vs.map((v) => recipeById.get(v.recipe_id)?.code).filter(Boolean))];
    return {
      id: m.id, name: m.name, codes,
      createdBy: [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l),
      versions: vs.map((v) => ({ id: v.id, hasList: !!tidy(v.ingredients_text) })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { withVariantLists, buildMasterList, buildMasterSummaries, saveVariantList, moveRowToVersion, deleteVersionOrMaster };
