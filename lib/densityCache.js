const { densityCacheKey } = require('./densityKey');
const { sanitizeEstimate } = require('./estimateDensity');

// The shared density cache (phase D2): one paid estimate per composition, for everyone. Table density_estimates
// (supabase/migrations/20260927100000_density_estimates.sql), keyed by (cache_key, prompt_version); see lib/densityKey.js
// for what the key covers. Estimates are AI answers, not recipe data: nothing about a recipe is ever written here.
//
// Flow: look every mass up by its key -> call the Edge Function only for the misses (identical compositions in one
// request go once) -> save the new answers. The cache is best-effort in both directions: if the table can't be read
// (not migrated yet, a network blip) every mass is simply estimated; if a save fails the estimate is still returned.
//
// DENSITY_PROMPT_VERSION is the oldest prompt whose answers are still trusted; keep it equal to the Edge Function's
// PROMPT_VERSION (supabase/functions/estimate-density) so a revised prompt stops reusing old answers.

const DENSITY_PROMPT_VERSION = 1;
const TABLE = 'density_estimates';

// items: lib/estimateDensity.js toDensityItem() results (distinct indices).
// deps:  { db: a Supabase client, estimate: (items) => estimateDensity(items) }
// Returns { estimates: Map index -> { density, low, high, confidence, basis }, cached: [indices answered from the cache],
//   missing: [indices with no answer], promptVersion, cacheAvailable, cacheError, saveError }.
async function estimateDensityCached(items, { db, estimate }) {
  const keyed = (items || []).filter(it => it && it.ingredients && it.ingredients.length).map(it => ({ it, key: densityCacheKey(it) }));
  const out = { estimates: new Map(), cached: [], missing: [], promptVersion: null, cacheAvailable: true, cacheError: null, saveError: null };
  if (!keyed.length) return out;

  // 1. Look up. The newest trusted prompt version wins when a key has several.
  const hits = new Map();
  try {
    const { data, error } = await db.from(TABLE)
      .select('cache_key, prompt_version, density, low, high, confidence, basis')
      .in('cache_key', [...new Set(keyed.map(k => k.key))])
      .gte('prompt_version', DENSITY_PROMPT_VERSION);
    if (error) throw error;
    for (const row of data || []) {
      const prev = hits.get(row.cache_key);
      if (!prev || row.prompt_version > prev.prompt_version) hits.set(row.cache_key, row);
    }
  } catch (err) {
    out.cacheAvailable = false;
    out.cacheError = String(err?.message || err);
    hits.clear();
  }

  const misses = [];
  for (const k of keyed) {
    const row = hits.get(k.key);
    const est = row && sanitizeEstimate({ density_g_cm3: Number(row.density), low: Number(row.low), high: Number(row.high), confidence: row.confidence, basis: row.basis });
    if (est) { out.estimates.set(k.it.index, est); out.cached.push(k.it.index); } else misses.push(k);
  }
  if (!misses.length) return out;

  // 2. Estimate the misses, each distinct composition once.
  const firstByKey = new Map();
  for (const m of misses) if (!firstByKey.has(m.key)) firstByKey.set(m.key, m.it);
  const r = await estimate([...firstByKey.values()]);
  out.promptVersion = r.promptVersion ?? null;
  for (const m of misses) {
    const e = r.estimates.get(firstByKey.get(m.key).index);
    if (e) out.estimates.set(m.it.index, e); else out.missing.push(m.it.index);
  }

  // 3. Save the new answers (best-effort). A row another user saved meanwhile is left as it is.
  if (out.cacheAvailable && Number.isInteger(out.promptVersion)) {
    const rows = [];
    for (const [key, it] of firstByKey) {
      const e = r.estimates.get(it.index);
      if (e) rows.push({ cache_key: key, prompt_version: out.promptVersion, density: e.density, low: e.low, high: e.high, confidence: e.confidence, basis: e.basis, label: it.label || null });
    }
    if (rows.length) {
      try {
        const { error } = await db.from(TABLE).upsert(rows, { onConflict: 'cache_key,prompt_version', ignoreDuplicates: true });
        if (error) throw error;
      } catch (err) {
        out.saveError = String(err?.message || err);
      }
    }
  }
  return out;
}

module.exports = { estimateDensityCached, DENSITY_PROMPT_VERSION };
