const crypto = require('crypto');

// The shared density cache's key (phase D2): what a density estimate depends on, and nothing else.
//   - The COMPOSITION as proportions, not grams: each ingredient's share of the total, rounded to 0.5%. Scaling a recipe
//     (the Batch Calculator, the Recipe Calculator) multiplies every quantity by the same factor, so the shares -- and
//     the key -- stay the same and the estimate is reused. Adding or removing an ingredient, or changing a ratio by more
//     than about half a percent, gives a new key: a new estimate, never a stale one. (A 0.5% shift in one ingredient
//     moves a density by far less than the estimate's own range, so reusing it there is right.)
//   - Ingredient names case- and space-insensitive, in any order; units kept (grams and pieces are not the same thing).
//   - The mass type (dough / filling / mixed) and the method text (the only evidence of aeration), whitespace-insensitive.
//   - NOT the process name or recipe: the same composition in two recipes is the same mass.
// The prompt version is stored beside the key (the cache table's own column), not inside it.
// KEY_FORMAT changes only if this recipe for the key changes, so old rows simply stop matching.

const KEY_FORMAT = 1;
const SHARE_STEP = 0.005;

const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
const normUnit = (u) => String(u || '').trim().toUpperCase();
const normMethod = (m) => String(m || '').trim().replace(/\s+/g, ' ').toLowerCase();
function qtyNumber(q) {
  if (typeof q === 'number') return Number.isFinite(q) ? q : null;
  const s = String(q ?? '').trim();
  return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : null;
}

// The normalized composition of a density item (lib/estimateDensity.js toDensityItem): sorted [name, unit, share] rows,
// where share is a rounded fraction of the numeric total, or the literal text for a quantity that isn't a number.
function compositionOf(item) {
  const rows = (item?.ingredients || []).filter(r => normName(r.name));
  const total = rows.reduce((s, r) => { const q = qtyNumber(r.quantity); return q != null && q > 0 ? s + q : s; }, 0);
  const merged = new Map();
  for (const r of rows) {
    const q = qtyNumber(r.quantity);
    const k = `${normName(r.name)}|${normUnit(r.unit)}|${q == null ? 'text' : 'num'}`;
    const prev = merged.get(k);
    if (q == null) { if (!prev) merged.set(k, { name: normName(r.name), unit: normUnit(r.unit), text: String(r.quantity ?? '').trim().toLowerCase() }); continue; }
    merged.set(k, { name: normName(r.name), unit: normUnit(r.unit), q: (prev?.q || 0) + Math.max(0, q) });
  }
  return [...merged.values()]
    .map(r => [r.name, r.unit, r.text !== undefined ? `text:${r.text}` : (total > 0 ? Math.round(r.q / total / SHARE_STEP) * SHARE_STEP : 0).toFixed(3)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

// The cache key: a sha256 hex of the composition, the mass type and the method.
function densityCacheKey(item) {
  const payload = JSON.stringify({ f: KEY_FORMAT, role: item?.role || 'dough', rows: compositionOf(item), method: normMethod(item?.method) });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { densityCacheKey, compositionOf, KEY_FORMAT, SHARE_STEP };
