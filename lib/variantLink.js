// ============================================================
// Master Items + Dish Variants, MV6 (2026-10-04): every NEW Dish Catalog row gets a version when it is created (Add Item,
// AI Approve, Import dishes from menus), and a row renamed in Edit Item moves to its new name's dish. One rule for both,
// decided with the chef -- the same as MV2's for a row with no list of its own:
//   no dish of that name yet         -> a new master item and a new, empty version
//   the dish has exactly ONE version -> the row joins it (it then shows that version's ingredients and calories)
//   the dish has 2+ versions         -> a new, empty version (she moves the row in Master Items if it should share one)
// The dish is found by its exact name, case / spacing aside (master_items.name_key, the matching rule used everywhere).
// Linking never blocks the caller: the row is already saved; a failure comes back as an error for a warning, and the row
// stays unlinked (scripts/variant-link-verify.js lists such rows; Dish Catalog's catch-up button was removed 2026-10-06). A rename's old version keeps its list
// and calories. Only menu_items.dish_variant_id is written on the catalog row, by compare-and-swap.
// Database writes take the client as `db` (main.js / aiMenuApprove pass Supabase; the check passes a stand-in).
// ============================================================
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Pure: the rule above. versionIds: the dish's existing versions (none when the dish is new).
function chooseVersion(versionIds) {
  return versionIds.length === 1 ? { join: versionIds[0] } : { create: true };
}

const fail = (e) => new Error((e && (e.message || String(e))) || 'unknown error');

// The master item of `name`: found, or created (by someone else meanwhile is fine). -> { id, created }
async function masterFor(db, name, who) {
  const k = nameKey(name);
  if (!k) throw new Error('The dish has no name.');
  const { data: found, error } = await db.from('master_items').select('id').eq('name_key', k);
  if (error) throw fail(error);
  if (found && found.length) return { id: found[0].id, created: false };
  const { data: made, error: insErr } = await db.from('master_items')
    .upsert([{ name: String(name).trim().replace(/\s+/g, ' '), name_key: k, created_by: who || null }], { onConflict: 'name_key', ignoreDuplicates: true }).select('id');
  if (insErr) throw fail(insErr);
  if (made && made.length) return { id: made[0].id, created: true };
  const { data: again, error: aErr } = await db.from('master_items').select('id').eq('name_key', k);
  if (aErr || !again || !again.length) throw fail(aErr || 'the dish could not be created');
  return { id: again[0].id, created: false };
}

// The version a row of `name` should use: joined or newly created (empty).
// -> { variantId, outcome, masterId, createdVariant, createdMaster }
async function targetVersion(db, name, who) {
  const master = await masterFor(db, name, who);
  const { data: vs, error } = await db.from('dish_variants').select('id').eq('master_item_id', master.id);
  if (error) { await dropIfUnused(db, { createdMaster: master.created, masterId: master.id }); throw fail(error); }
  const choice = chooseVersion((vs || []).map((v) => v.id).sort((a, b) => a - b));
  if (choice.join) return { variantId: choice.join, outcome: 'joined', masterId: master.id, createdVariant: false, createdMaster: false };
  const { data: made, error: vErr } = await db.from('dish_variants').insert({ master_item_id: master.id, created_by: who || null }).select('id');
  if (vErr || !made || !made.length) { await dropIfUnused(db, { createdMaster: master.created, masterId: master.id }); throw fail(vErr || 'the version could not be created'); }
  return { variantId: made[0].id, outcome: master.created ? 'new-dish' : 'new-version', masterId: master.id, createdVariant: true, createdMaster: master.created };
}

// What targetVersion created for a row that, in the end, did not take it (linked meanwhile, or a write failed): the new
// version removed if nothing uses it, then a master item created in the same step removed if it has no versions left --
// so an abandoned link leaves nothing behind (else the dish's next row would see an empty dish, not a new one).
async function dropIfUnused(db, { createdVariant = false, variantId = null, createdMaster = false, masterId = null }) {
  if (createdVariant && variantId != null) {
    const { data } = await db.from('menu_items').select('id').eq('dish_variant_id', variantId);
    if (!(data || []).length) await db.from('dish_variants').delete().eq('id', variantId);
  }
  if (createdMaster && masterId != null) {
    const { data } = await db.from('dish_variants').select('id').eq('master_item_id', masterId);
    if (!(data || []).length) await db.from('master_items').delete().eq('id', masterId);
  }
}

// A new row (no version yet). Safe to repeat: a row already linked is left as it is.
// -> { variantId, outcome: 'joined' | 'new-version' | 'new-dish' | 'already' }
async function linkNewRow({ db, rowId, name, who }) {
  const { data: rows, error } = await db.from('menu_items').select('id, dish_variant_id').eq('id', rowId);
  if (error) throw fail(error);
  if (!rows || !rows.length) throw new Error(`Dish Catalog row #${rowId} not found.`);
  if (rows[0].dish_variant_id != null) return { variantId: rows[0].dish_variant_id, outcome: 'already' };
  const t = await targetVersion(db, name, who);
  const { data: set, error: uErr } = await db.from('menu_items').update({ dish_variant_id: t.variantId }).eq('id', rowId).is('dish_variant_id', null).select('id, dish_variant_id');
  if (uErr) { await dropIfUnused(db, t); throw fail(uErr); }
  if (!set || !set.length) {
    await dropIfUnused(db, t);
    const { data: now } = await db.from('menu_items').select('dish_variant_id').eq('id', rowId);
    return { variantId: now && now[0] ? now[0].dish_variant_id : null, outcome: 'already' };
  }
  return { variantId: t.variantId, outcome: t.outcome };
}

// A row renamed in Edit Item: moves to its NEW name's dish by the same rule, only if it still uses fromVariantId (null =
// unlinked). Same name (case / spacing aside) -> nothing. The old version keeps its list and calories.
// -> { moved, variantId, outcome } | { moved: false, unchanged: true } | { moved: false, stale: true }
async function relinkRenamedRow({ db, rowId, oldName, newName, fromVariantId, who }) {
  if (nameKey(oldName) === nameKey(newName)) return { moved: false, unchanged: true };
  const t = await targetVersion(db, newName, who);
  let q = db.from('menu_items').update({ dish_variant_id: t.variantId }).eq('id', rowId);
  q = fromVariantId == null ? q.is('dish_variant_id', null) : q.eq('dish_variant_id', fromVariantId);
  const { data, error } = await q.select('id');
  if (error) { await dropIfUnused(db, t); throw fail(error); }
  if (!data || !data.length) { await dropIfUnused(db, t); return { moved: false, stale: true }; }
  return { moved: true, variantId: t.variantId, outcome: t.outcome };
}

// A row SAVED in Edit Item (2026-10-06). Renamed -> relinkRenamedRow, exactly as before (an unlinked row is linked to its new
// name's dish). Same name and NO version yet (an earlier automatic link failed) -> linked now, exactly like a new row
// (linkNewRow). Same name and a version -> nothing. Throws like the two it calls (the caller turns it into a warning).
// -> { moved: true, variantId, outcome, via: 'rename' | 'link' } | { moved: false, unchanged: true }
//    | { moved: false, stale: true } (rename: its version changed meanwhile) | { moved: false, already: true, variantId } (link:
//    linked by someone else meanwhile -- kept as it is)
async function relinkOnEdit({ db, rowId, oldName, newName, fromVariantId, who }) {
  if (nameKey(oldName) !== nameKey(newName)) {
    const r = await relinkRenamedRow({ db, rowId, oldName, newName, fromVariantId, who });
    return r.moved ? { ...r, via: 'rename' } : r;
  }
  if (fromVariantId != null) return { moved: false, unchanged: true };
  const r = await linkNewRow({ db, rowId, name: newName, who });
  if (r.outcome === 'already') return { moved: false, already: true, variantId: r.variantId };
  return { moved: true, variantId: r.variantId, outcome: r.outcome, via: 'link' };
}

// Pure: what linkNewRow will do for each unlinked row, in id order (an earlier row of a new dish creates it, so a later one
// joins its version). rows: [{ id, name }]; versionsByKey: Map(name_key -> number of versions of that dish).
// -> [{ id, name, outcome: 'joined' | 'new-version' | 'new-dish' }]
function planLinks(rows, versionsByKey) {
  const count = new Map(versionsByKey);
  return [...rows].sort((a, b) => a.id - b.id).map((r) => {
    const k = nameKey(r.name);
    const n = count.get(k);
    const outcome = n === undefined ? 'new-dish' : n === 1 ? 'joined' : 'new-version';
    if (outcome !== 'joined') count.set(k, (n || 0) + 1);
    return { id: r.id, name: r.name, outcome };
  });
}

module.exports = { nameKey, chooseVersion, planLinks, linkNewRow, relinkRenamedRow, relinkOnEdit };
