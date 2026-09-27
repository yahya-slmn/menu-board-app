// ============================================================
// One-time Staff Main catalog backfill (menu rules v2, Phase C), run by
// scripts/staff-main-backfill.js. Two different trust levels, confirmed with the chef 2026-09-23:
// - Starch type (menu_items.carb_type) is written DIRECTLY for active Staff Main dishes that have
//   none, like the calorie / AM Snack style backfills. "No starch" leaves it empty (a dish without
//   a starch never clashes with another in the vegan-vs-vegetarian "different starch" rule).
// - Vegan is only PROPOSED: dishes tagged Vegetarian (or untagged) that the AI thinks are vegan are
//   returned for the chef to confirm; applyVegan writes only the ids the chef picked.
// ============================================================
const { supabase, supaFail } = require('./supabaseClient');
const { getCategoryByCode, getProteinByCode } = require('./referenceData');

const BATCH_SIZE = 50;
const TIMEOUT_MS = 90_000;
const CARB_TYPES = new Set(['RICE', 'PASTA', 'POTATO', 'OTHER']);

async function invokeEstimate(items) {
  let timer;
  const call = supabase.functions.invoke('estimate-staff-main-attributes', { body: { items } });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Estimate timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS); });
  try {
    const { data, error } = await Promise.race([call, timeout]);
    if (error) throw supaFail('estimateStaffMainAttributes', error);
    if (!data || !data.success) throw new Error(data?.error || 'Estimate failed');
    return data.data.estimates;
  } finally {
    clearTimeout(timer);
  }
}

async function loadStaffMainItems() {
  const category = getCategoryByCode('STAFF_MAIN');
  if (!category) throw new Error('No STAFF_MAIN category in the reference data.');
  const { data, error } = await supabase.from('menu_items')
    .select('id, name, carb_type, protein_type_id').eq('category_id', category.id).eq('is_active', 1).order('name');
  if (error) throw supaFail('staffMainBackfill: load Staff Main items', error);
  return data;
}

// Estimates every item (batched, one retry for anything that didn't come back).
// Returns Map(itemId -> { carb_type, diet }) and a list of failure messages.
async function estimateAll(items, { estimate = invokeEstimate, onProgress = () => {} } = {}) {
  const result = new Map();
  const failures = [];
  const run = async (list, label) => {
    const missing = [];
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);
      onProgress(`${label}: ${Math.min(i + BATCH_SIZE, list.length)} of ${list.length}`);
      let estimates = [];
      try {
        estimates = await estimate(batch.map((it, idx) => ({ index: idx, name: it.name })));
      } catch (err) {
        failures.push(`${label} batch ${i / BATCH_SIZE + 1}: ${err.message}`);
      }
      const byIndex = new Map(estimates.map((e) => [e.index, e]));
      batch.forEach((it, idx) => {
        const e = byIndex.get(idx);
        if (e && e.carb_type && e.diet) result.set(it.id, { carb_type: e.carb_type, diet: e.diet });
        else missing.push(it);
      });
    }
    return missing;
  };
  const missing = await run(items, 'Estimating');
  const stillMissing = missing.length ? await run(missing, 'Retrying') : [];
  for (const it of stillMissing) failures.push(`No estimate for "${it.name}"`);
  return { estimates: result, failures };
}

// Writes carb_type for dishes that have none. Returns [{ id, name, carb_type }] actually written.
async function applyCarbTypes(items, estimates) {
  const written = [];
  for (const it of items) {
    const e = estimates.get(it.id);
    if (it.carb_type || !e || !CARB_TYPES.has(e.carb_type)) continue;
    const { error } = await supabase.from('menu_items').update({ carb_type: e.carb_type }).eq('id', it.id).is('carb_type', null);
    if (error) throw supaFail(`staffMainBackfill: write carb_type for ${it.id}`, error);
    written.push({ id: it.id, name: it.name, carb_type: e.carb_type });
  }
  return written;
}

// Dishes the AI thinks are vegan among those not already tagged Vegan and not tagged with a meat
// or fish protein. Nothing is written.
function veganProposals(items, estimates) {
  const vegetarian = getProteinByCode('VEGETARIAN');
  const vegan = getProteinByCode('VEGAN');
  return items.filter((it) => {
    const e = estimates.get(it.id);
    if (!e || e.diet !== 'VEGAN') return false;
    if (vegan && it.protein_type_id === vegan.id) return false;
    return it.protein_type_id == null || (vegetarian && it.protein_type_id === vegetarian.id);
  }).map((it) => ({ id: it.id, name: it.name, currentProtein: it.protein_type_id === vegetarian?.id ? 'VEGETARIAN' : null }));
}

// Untagged dishes, for information only (the chef may want to set their protein type by hand).
function untaggedReport(items, estimates) {
  return items.filter((it) => it.protein_type_id == null).map((it) => ({ id: it.id, name: it.name, diet: estimates.get(it.id)?.diet || 'unknown' }));
}

// Marks exactly the chef-confirmed ids as Vegan (and only if they are still Vegetarian / untagged).
async function applyVegan(ids) {
  const vegan = getProteinByCode('VEGAN');
  if (!vegan) throw new Error('There is no VEGAN protein type yet -- run the menu rules v2 migration first, then press Refresh or sign in again.');
  const vegetarian = getProteinByCode('VEGETARIAN');
  const written = [];
  for (const id of ids) {
    let q = supabase.from('menu_items').update({ protein_type_id: vegan.id }).eq('id', id);
    q = vegetarian ? q.or(`protein_type_id.is.null,protein_type_id.eq.${vegetarian.id}`) : q.is('protein_type_id', null);
    const { data, error } = await q.select('id, name');
    if (error) throw supaFail(`staffMainBackfill: mark ${id} vegan`, error);
    written.push(...data);
  }
  return written;
}

// The script's "which numbers?" answer: "1,3, 5-7" -> [1,3,5,6,7]; "all" -> every number; "" -> [].
function parseSelection(input, max) {
  const s = input.trim().toLowerCase();
  if (!s || s === 'none' || s === 'n') return [];
  if (s === 'all') return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`"${part}" isn't a number or a range`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
      if (n < 1 || n > max) throw new Error(`${n} isn't on the list (1-${max})`);
      out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

module.exports = { parseSelection, loadStaffMainItems, estimateAll, applyCarbTypes, veganProposals, untaggedReport, applyVegan, BATCH_SIZE };
