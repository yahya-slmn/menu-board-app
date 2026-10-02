// ============================================================
// Master Items + Dish Variants, phase MV2 (2026-10-03): build the master items and variants from the live Dish Catalog
// and link each catalog row to the variant it uses, carrying every saved, approved ingredient list (M2) onto its variant.
// The grouping is lib/masterItemsPlan.js; this plans the WRITES from it (pure) and applies them (database passed in --
// main.js passes Supabase, the checks pass a stand-in).
//
// What is written: master_items, dish_variants (with the carried list, who / when / source) and menu_items.dish_variant_id
// -- nothing else on menu_items: no section, category, portion, list or calorie value changes, so the menu engine, Build
// Menu and exports are untouched (they never read dish_variant_id). Safe to re-run: masters are matched by name_key,
// a row already linked is never relinked, and a variant whose rows are already linked to one variant reuses it.
// Rows of a dish with 2+ variants and no list of their own are left unlinked (the chef picks -- MV3). Rows with no list
// that would join their dish's ONLY variant (assumption B) are linked only when she ticks it in the preview.
// ============================================================
const { planMasterItems, listKey } = require('./masterItemsPlan');

const tidy = (s) => String(s ?? '').trim();

// rows: every Dish Catalog row with { id, name, category_name, sections, ingredients_text, allergens_text,
// ingredients_updated_at, ingredients_updated_by, ingredients_source, dish_variant_id }.
// existingMasters: [{ id, name_key }]. -> the build plan (plain data, kept by main.js between preview and apply).
function planBuild({ rows, existingMasters = [] }) {
  const { masters, stats } = planMasterItems(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const masterIdByKey = new Map(existingMasters.map((m) => [m.name_key, m.id]));
  const out = [];
  const conflicts = [];
  for (const m of masters) {
    const variants = [];
    for (const v of m.variants) {
      const linked = new Set(v.rowIds.map((id) => byId.get(id).dish_variant_id).filter((x) => x != null));
      if (linked.size > 1) { conflicts.push({ name: m.name, rowIds: v.rowIds, variantIds: [...linked] }); continue; }
      const fromList = new Set(v.list ? v.list.fromRowIds : []);
      const unlinked = v.rowIds.filter((id) => byId.get(id).dish_variant_id == null);
      variants.push({
        reuseVariantId: linked.size ? [...linked][0] : null,
        list: v.list, sections: v.sections, date: v.date, label: v.label,
        listRowIds: unlinked.filter((id) => fromList.has(id)),
        // Rows with no list of their own. Of a variant WITH a list they are "joining" (assumption B, her tick); of an empty
        // variant (the dish has no list anywhere) they are simply its rows.
        joiningRowIds: v.list ? unlinked.filter((id) => !fromList.has(id)) : [],
        plainRowIds: v.list ? [] : unlinked,
        listStamp: Object.fromEntries(unlinked.filter((id) => fromList.has(id)).map((id) => [id, byId.get(id).ingredients_updated_at || null])),
      });
    }
    out.push({ name: m.name, key: m.key, masterId: masterIdByKey.get(m.key) || null, variants, unassigned: m.unassigned.filter((id) => byId.get(id).dish_variant_id == null) });
  }
  const sum = (f) => out.reduce((n, m) => n + m.variants.reduce((x, v) => x + f(v), 0), 0);
  return {
    masters: out, conflicts, plannerStats: stats,
    summary: {
      mastersToCreate: out.filter((m) => !m.masterId).length,
      variantsToCreate: sum((v) => (v.reuseVariantId ? 0 : 1)),
      listsToCarry: sum((v) => (v.list && !v.reuseVariantId ? 1 : 0)),
      listRowsToLink: sum((v) => v.listRowIds.length),
      joiningRows: sum((v) => v.joiningRowIds.length),
      plainRowsToLink: sum((v) => v.plainRowIds.length),
      rowsToPick: out.reduce((n, m) => n + m.unassigned.length, 0),
      savedListsInCatalog: rows.filter((r) => tidy(r.ingredients_text)).length,
    },
  };
}

const variantKey = (masterId, list) => `${masterId}|${list ? listKey(list.ingredients, list.allergens) : ''}`;

// includeJoining: link the rows with no list of their own to their dish's only (listed) variant (assumption B).
// -> { mastersCreated, variantsCreated, rowsLinked, listsCarried, changedSinceIdPreview: [{ id, name }], alreadyLinked,
//      conflicts, failed: [{ step, error }], historyError }
async function applyBuild({ db, plan, includeJoining, who, parallel = 8 }) {
  const failed = [];
  const err = (step, e) => failed.push({ step, error: (e && (e.message || String(e))) || 'unknown' });

  // 1. master items: get-or-create by name_key.
  const masterId = new Map(plan.masters.filter((m) => m.masterId).map((m) => [m.key, m.masterId]));
  const toCreate = plan.masters.filter((m) => !m.masterId);
  let mastersCreated = 0;
  for (let i = 0; i < toCreate.length; i += 500) {
    const part = toCreate.slice(i, i + 500);
    const { data, error } = await db.from('master_items').upsert(part.map((m) => ({ name: m.name, name_key: m.key, created_by: who || null })), { onConflict: 'name_key', ignoreDuplicates: true }).select('id, name_key');
    if (error) { err('master items', error); continue; }
    mastersCreated += (data || []).length;
    for (const r of data || []) masterId.set(r.name_key, r.id);
    // Created by someone else meanwhile (ignored as duplicates): read their ids.
    const missing = part.filter((m) => !masterId.has(m.key)).map((m) => m.key);
    if (missing.length) {
      const { data: have } = await db.from('master_items').select('id, name_key').in('name_key', missing);
      for (const r of have || []) masterId.set(r.name_key, r.id);
    }
  }

  // 2. variants: create those not reused, matched back by (master, list) -- unique within a master.
  const newVariants = [];
  for (const m of plan.masters) {
    const mid = masterId.get(m.key);
    if (!mid) continue;
    for (const v of m.variants) {
      if (v.reuseVariantId) { v.variantId = v.reuseVariantId; continue; }
      newVariants.push({ v, mid, row: {
        master_item_id: mid,
        ingredients_text: v.list ? v.list.ingredients : null, allergens_text: v.list ? (v.list.allergens || null) : null,
        ingredients_updated_at: v.list ? v.list.updatedAt : null, ingredients_updated_by: v.list ? v.list.updatedBy : null,
        ingredients_source: v.list ? (v.list.source || 'menu_upload') : null, created_by: who || null } });
    }
  }
  let variantsCreated = 0;
  for (let i = 0; i < newVariants.length; i += 500) {
    const part = newVariants.slice(i, i + 500);
    const { data, error } = await db.from('dish_variants').insert(part.map((x) => x.row)).select('id, master_item_id, ingredients_text, allergens_text');
    if (error) { err('variants', error); continue; }
    variantsCreated += (data || []).length;
    const idByKey = new Map((data || []).map((r) => [variantKey(r.master_item_id, r.ingredients_text ? { ingredients: r.ingredients_text, allergens: r.allergens_text } : null), r.id]));
    for (const x of part) x.v.variantId = idByKey.get(variantKey(x.mid, x.v.list)) || null;
  }

  // 3. links: only rows still unlinked.
  let rowsLinked = 0;
  let alreadyLinked = 0;
  const linkedListRows = [];
  const linkedPerVariant = new Map(); // planned variant -> rows actually linked to it now
  const jobs = [];
  for (const m of plan.masters) for (const v of m.variants) {
    if (!v.variantId) continue;
    const ids = [...v.listRowIds, ...v.plainRowIds, ...(includeJoining ? v.joiningRowIds : [])];
    for (let i = 0; i < ids.length; i += 200) jobs.push({ v, ids: ids.slice(i, i + 200) });
  }
  const run = async ({ v, ids }) => {
    const { data, error } = await db.from('menu_items').update({ dish_variant_id: v.variantId }).in('id', ids).is('dish_variant_id', null).select('id, ingredients_updated_at');
    if (error) { err('links', error); return; }
    rowsLinked += (data || []).length;
    alreadyLinked += ids.length - (data || []).length;
    linkedPerVariant.set(v, (linkedPerVariant.get(v) || 0) + (data || []).length);
    for (const r of data || []) if (Object.prototype.hasOwnProperty.call(v.listStamp, r.id)) linkedListRows.push({ id: r.id, now: r.ingredients_updated_at || null, then: v.listStamp[r.id], v });
  };
  for (let i = 0; i < jobs.length; i += parallel) await Promise.all(jobs.slice(i, i + parallel).map(run));

  // 4. a list re-saved on its row after the preview: the variant holds the older text -- reported, never silent.
  const changed = linkedListRows.filter((x) => String(x.now) !== String(x.then)).map((x) => ({ id: x.id }));

  // 5. a new variant no row ended up using (all its rows were linked meanwhile) is removed again.
  for (const m of plan.masters) for (const v of m.variants) {
    if (!v.variantId || v.reuseVariantId) continue;
    if (!linkedPerVariant.get(v)) {
      const { data } = await db.from('menu_items').select('id').eq('dish_variant_id', v.variantId);
      if (!(data || []).length) { await db.from('dish_variants').delete().eq('id', v.variantId); variantsCreated--; v.variantId = null; }
    }
  }

  // 6. one history row per list carried: which row's list became which variant's.
  const history = [];
  for (const m of plan.masters) for (const v of m.variants) {
    if (!v.variantId || v.reuseVariantId || !v.list) continue;
    history.push({ item_id: v.list.fromRowIds[0], dish_variant_id: v.variantId, old_ingredients: v.list.ingredients, new_ingredients: v.list.ingredients,
      old_allergens: v.list.allergens || null, new_allergens: v.list.allergens || null, source: 'variant_migration', changed_by: who || null });
  }
  let historyError = null;
  for (let i = 0; i < history.length && !historyError; i += 500) {
    const { error } = await db.from('menu_item_ingredient_history').insert(history.slice(i, i + 500));
    if (error) historyError = error.message || String(error);
  }
  return { mastersCreated, variantsCreated, rowsLinked, listsCarried: history.length, changedSincePreview: changed, alreadyLinked, conflicts: plan.conflicts, failed, historyError };
}

module.exports = { planBuild, applyBuild };
