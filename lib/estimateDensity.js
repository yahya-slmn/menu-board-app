const { supabase, supaFail } = require('./supabaseClient');

// Recipe on Fire's AI density estimate (g/cm3) of a raw dough or filling -- the estimate-density Edge Function holds the
// Anthropic key server-side (see supabase/functions/estimate-density), same trust boundary as estimateCalories.js.
//
// The renderer sends plain "masses": each one a layer (one process) or a merged One dough (several processes), as the
// ingredient rows it already has plus the method text. Everything that shapes the request or the answer is here and
// pure (toDensityItem / mergeIngredientRows / sanitizeEstimate / reconcileEstimates), so it is unit-tested without a
// network; estimateDensity() is the only function that calls out.
//
// An estimate is never the truth: it comes back as a value, a range and a confidence, and the chef's own number
// always wins in the UI.

const ESTIMATE_TIMEOUT_MS = 75_000; // Sonnet 5 backstop, same as estimateAmSnackStyle.js
const MIN_DENSITY = 0.1;
const MAX_DENSITY = 1.6;
const ROLES = new Set(['dough', 'filling', 'mixed']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const MAX_BASIS = 240;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round3 = (v) => Math.round(v * 1000) / 1000;

// A quantity as a number, or null ("a pinch", blank).
function qtyNumber(q) {
  if (typeof q === 'number') return Number.isFinite(q) ? q : null;
  const s = String(q ?? '').trim();
  return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : null;
}
const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ');
const normUnit = (u) => String(u || '').trim().toUpperCase();

// Several processes' ingredient rows as ONE list (a One dough): the same ingredient (name, case- and space-insensitive)
// in the same unit is summed; order is first appearance. Rows without a name are dropped. A row whose quantity isn't a
// number keeps its text, and the same ingredient with a numeric quantity elsewhere is kept as a separate row, since
// the two can't be added.
function mergeIngredientRows(rowSets) {
  const out = [], byKey = new Map();
  for (const rows of rowSets || []) {
    for (const r of rows || []) {
      const name = normName(r.name ?? r.ingredient_name);
      if (!name) continue;
      const unit = normUnit(r.unit), q = qtyNumber(r.quantity);
      const key = `${name.toLowerCase()}|${unit}|${q == null ? 'text' : 'num'}`;
      const hit = byKey.get(key);
      if (hit && q != null) { hit.quantity = round3(hit.quantity + q); continue; }
      if (hit) continue; // the same unquantified ingredient twice adds nothing
      const row = { name, quantity: q == null ? (String(r.quantity ?? '').trim() || null) : round3(q), unit: unit || null };
      byKey.set(key, row);
      out.push(row);
    }
  }
  return out;
}

// One mass for the Edge Function. sources: [{ rows, method }] -- one for a layer, several for a One dough.
function toDensityItem({ index, label, role, sources }) {
  const srcs = Array.isArray(sources) ? sources : [];
  const ingredients = mergeIngredientRows(srcs.map(s => s.rows));
  const method = srcs.map(s => String(s.method || '').trim()).filter(Boolean).join('\n\n').slice(0, 3000);
  return {
    index,
    label: label ? String(label).slice(0, 200) : null,
    role: ROLES.has(role) ? role : (srcs.length > 1 ? 'mixed' : 'dough'),
    ingredients: ingredients.slice(0, 80),
    method: method || null,
  };
}

// One estimate, made safe to show: numbers clamped to 0.1-1.6, low <= value <= high, a known confidence, a short basis.
// Null when the value itself is missing or not a number.
function sanitizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = Number(raw.density_g_cm3);
  if (!Number.isFinite(d)) return null;
  const value = round3(clamp(d, MIN_DENSITY, MAX_DENSITY));
  let low = Number(raw.low), high = Number(raw.high);
  low = Number.isFinite(low) ? clamp(low, MIN_DENSITY, MAX_DENSITY) : value;
  high = Number.isFinite(high) ? clamp(high, MIN_DENSITY, MAX_DENSITY) : value;
  if (low > high) [low, high] = [high, low];
  low = round3(Math.min(low, value)); high = round3(Math.max(high, value));
  const confidence = CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low';
  const basis = String(raw.basis || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BASIS);
  return { density: value, low, high, confidence, basis };
}

// The Edge Function's estimates matched to the requested indices: unknown indices dropped, the first of any duplicate
// kept, unusable values dropped. Returns a Map index -> sanitized estimate.
function reconcileEstimates(requestedIndices, estimates) {
  const want = new Set(requestedIndices), out = new Map();
  for (const e of estimates || []) {
    const i = e && Number(e.index);
    if (!want.has(i) || out.has(i)) continue;
    const s = sanitizeEstimate(e);
    if (s) out.set(i, s);
  }
  return out;
}

async function invokeOnce(items) {
  const invoke = supabase.functions.invoke('estimate-density', { body: { items } });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Density estimate timed out after ${ESTIMATE_TIMEOUT_MS / 1000}s`)), ESTIMATE_TIMEOUT_MS));
  const { data, error } = await Promise.race([invoke, timeout]);
  if (error) throw supaFail('estimateDensity', error);
  if (!data || !data.success) throw new Error(data?.error || 'Density estimate failed');
  return data.data;
}

// items: toDensityItem() results. Returns { estimates: Map index -> { density, low, high, confidence, basis },
// promptVersion, missing: [indices with no usable answer after one retry] }.
async function estimateDensity(items) {
  const list = (items || []).filter(it => it && it.ingredients && it.ingredients.length);
  if (!list.length) return { estimates: new Map(), promptVersion: null, missing: [] };
  const first = await invokeOnce(list);
  const got = reconcileEstimates(list.map(i => i.index), first.estimates);
  let promptVersion = first.prompt_version ?? null;
  const retry = list.filter(i => !got.has(i.index));
  if (retry.length) {
    const second = await invokeOnce(retry);
    promptVersion = second.prompt_version ?? promptVersion;
    for (const [i, e] of reconcileEstimates(retry.map(r => r.index), second.estimates)) got.set(i, e);
  }
  return { estimates: got, promptVersion, missing: list.filter(i => !got.has(i.index)).map(i => i.index) };
}

module.exports = { estimateDensity, toDensityItem, mergeIngredientRows, sanitizeEstimate, reconcileEstimates, MIN_DENSITY, MAX_DENSITY };
