// ============================================================
// Menu Planner's optional "Created By mix" (2026-09-25): target percentages per Created By value
// (menu_items.created_by_label -- "AI", "OLD", "Tetiana", ...; '' = not set) that Generate Menu /
// Export All Sections pass to the engine as a BEST-EFFORT bias, applied independently per section +
// category. Pure: no DB, no engine state.
//
// How it biases (lib/generator.js _scoreAndSort, only when a mix is set): candidates are ranked as
// always (longest since served first, random tie-break), then split at NO_REPEAT_DAYS. Only the FRESH
// part is reordered: repeatedly take the Created By value furthest behind its target for this section
// + category (counting this run's picks so far) and offer its longest-unserved dish. The not-fresh part
// keeps today's order after it, so the mix can never bring a dish back sooner. Every rule still
// accepts or rejects each candidate in _pickItems exactly as before; the mix only changes which
// allowed dish is tried first.
// ============================================================

const labelOf = (item) => String(item?.created_by_label ?? '').trim();

// { label: percent } -> { label: fraction } (labels trimmed, 0% entries dropped), or null for "off".
// Throws a readable error unless every value is 0-100 and they add up to 100.
function normalizeMix(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw).map(([label, pct]) => [String(label).trim(), Number(pct)]);
  if (!entries.length) return null;
  for (const [label, pct] of entries) {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`Created By mix: "${label || 'not set'}" must be 0-100%`);
  }
  const total = entries.reduce((n, [, pct]) => n + pct, 0);
  if (Math.abs(total - 100) > 0.5) throw new Error(`Created By mix must add up to 100% (it adds up to ${total}%)`);
  const mix = {};
  for (const [label, pct] of entries) if (pct > 0) mix[label] = (mix[label] || 0) + pct / 100;
  return mix;
}

// `scored`: candidates in today's order (each with .gap). tally: Map(label -> picks so far in this
// section + category). Returns the fresh ones interleaved by deficit, then the rest unchanged.
function mixOrder(scored, mix, tally, freshDays) {
  const fresh = [], stale = [];
  for (const c of scored) (c.gap >= freshDays ? fresh : stale).push(c);
  if (fresh.length < 2) return scored;
  const groups = new Map(); // label -> candidates in today's order
  for (const c of fresh) {
    const l = labelOf(c);
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(c);
  }
  const counts = new Map(tally);
  let total = [...counts.values()].reduce((a, b) => a + b, 0);
  const firstPos = new Map(fresh.map((c, i) => [c, i]));
  const out = [];
  // Furthest behind its target first; ties: the higher target, then the better-ranked dish.
  const key = (l) => [(mix[l] || 0) * (total + 1) - (counts.get(l) || 0), mix[l] || 0, -firstPos.get(groups.get(l)[0])];
  const better = (a, b) => { for (let i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] > b[i]; return false; };
  while (out.length < fresh.length) {
    let best = null, bestKey = null;
    for (const [l, list] of groups) {
      if (!list.length) continue;
      const k = key(l);
      if (!best || better(k, bestKey)) { best = l; bestKey = k; }
    }
    out.push(groups.get(best).shift());
    counts.set(best, (counts.get(best) || 0) + 1);
    total++;
  }
  return [...out, ...stale];
}

// Target vs achieved, per section + category the mix could act on. raw: [{ section, category, picks,
// byLabel: {label: n}, pool: {label: n} }] from MenuGenerator.createdByMixReport(). A value short of
// its target by more than SHORT_POINTS is explained from the category's own pool.
const SHORT_POINTS = 10;
function summarizeMixReport(raw, mix) {
  const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
  return raw.filter(r => r.picks > 0).map((r) => {
    const labels = [...new Set([...Object.keys(mix), ...Object.keys(r.byLabel)])];
    const rows = labels.map((label) => {
      const target = Math.round((mix[label] || 0) * 100);
      const achieved = pct(r.byLabel[label] || 0, r.picks);
      const inPool = r.pool[label] || 0;
      let note = null;
      if (target - achieved > SHORT_POINTS) {
        note = inPool === 0 ? 'no dishes in this category'
          : inPool < r.picks * (target / 100) ? `only ${inPool} dish${inPool === 1 ? '' : 'es'} for ${r.picks} picks (each can be served once in 28 days)`
            : 'its dishes were served recently or kept out by the menu rules';
      }
      return { label, target, achieved, picks: r.byLabel[label] || 0, inPool, note };
    }).sort((a, b) => b.target - a.target || b.achieved - a.achieved || a.label.localeCompare(b.label));
    return { section: r.section, category: r.category, picks: r.picks, rows, short: rows.some(x => x.note) };
  });
}

// Before generating: the most a value could reach in a category, from its dish count alone -- each dish
// at most once per NO_REPEAT_DAYS (28) calendar days of the run, ignoring recent history. Percent 0-100.
function shareCeiling(dishes, picks, numWeekdays) {
  if (!picks) return 100;
  const usesPerDish = Math.max(1, Math.ceil((numWeekdays * 7) / 5 / 28));
  return Math.min(100, Math.floor((100 * dishes * usesPerDish) / picks));
}

module.exports = { labelOf, normalizeMix, mixOrder, summarizeMixReport, shareCeiling, SHORT_POINTS };
