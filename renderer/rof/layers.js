import { RISE_H } from './sheet.js';

// Layered tray (Sheet & Trim, "In layers"): several recipe processes stacked in one tray instead of mixed into
// one dough -- e.g. a puff pastry base (pre-baked alone) with a spinach / egg / cheese filling poured on top up
// to a height. Pure arithmetic, no DOM, no 3D: renderer.js feeds it the processes and the tray and shows what
// it returns. Session-only, like everything in Recipe on Fire (nothing is saved to the recipe).
//
// Conventions (confirmed with the chef, 2026-09-26):
//   - Heights are ASSEMBLY heights, what a ruler shows while filling. The estimated height after the final bake
//     is extra information, never the target.
//   - A layer's grams in the tray are RAW: its Total Quantity through every waste except Baking Waste (wastage
//     multiplies, so order doesn't matter). Its finished grams take the Baking Waste off too. (The single-dough
//     flow keeps using the finished Net Weight -- unchanged.)
//   - Height = grams / (tray area x density), the same formula as the single sheet, just stacked: a layer starts
//     where the one below it ends.
//   - The number of trays comes from the bottom layer: its Fill Weight (grams per tray, when the recipe saves one
//     FOR THIS TRAY) or a count she types. Each layer's recipe quantity is split evenly across the trays, except a
//     layer filled "up to a height", which takes only what that height needs; the rest is reported as not used
//     (or short), never folded into waste or scrap.
//   - Density defaults: 1.05 g/cm3 for a dough (flour found), 1.0 for a filling; both estimates, editable.

export const DENSITY_DOUGH = 1.05;
export const DENSITY_FILLING = 1.0;
// How much a flourless layer (a filling: egg, cheese, vegetables) grows in the oven, as the rise estimate's height
// multiplier (0.1 -> about +10% of its raw height). It sets and puffs a little; it doesn't rise like a dough. The
// rise estimate has no flour to read in a filling, so this stands in for it (an estimate, shown as one).
export const FILLING_H_MUL = 0.1;

const isBaking = (w) => /baking/i.test(w?.name || '');
const pctOf = (w) => { const v = parseFloat(w?.percent); return Number.isFinite(v) ? Math.min(Math.max(v, 0), 100) : 0; };
const retentionOf = (wastes, pick) => (wastes || []).filter(pick).reduce((acc, w) => acc * (1 - pctOf(w) / 100), 1);

// The grams of one layer's recipe that go into the tray(s) raw, and what share of them is left after baking.
export function layerGrams({ totalGrams, wastes }) {
  const total = Number(totalGrams) > 0 ? Number(totalGrams) : 0;
  const raw = total * retentionOf(wastes, (w) => !isBaking(w));
  const bakeRetention = retentionOf(wastes, isBaking);
  return { total, raw, bakeRetention, hasBakingWaste: (wastes || []).some(isBaking) };
}

// Grams <-> height over a tray area, at a density.
export const heightFromGrams = (grams, areaCm2, density) => (areaCm2 > 0 && density > 0 ? grams / (areaCm2 * density) : 0);
export const gramsFromHeight = (heightCm, areaCm2, density) => Math.max(0, heightCm) * areaCm2 * density;
// Height after baking, from the rise estimate's height multiplier (the sheet's own formula, see sheet.js RISE_H).
export const bakedHeight = (rawHeightCm, hMul) => rawHeightCm * (1 + RISE_H * (Number(hMul) > 0 ? Number(hMul) : 0));
// The other way round: the rise that takes a raw sheet to a baked height (what the 3D sheet is set to when she
// enters a measured height). A measurement below the raw height (docked or weighted pastry) gives a negative rise,
// so the sheet is drawn thinner, down to a tenth of its raw height at most.
export const riseForHeight = (rawHeightCm, bakedHeightCm) => (rawHeightCm > 0 && bakedHeightCm > 0 ? Math.max(-0.9 / RISE_H, (bakedHeightCm / rawHeightCm - 1) / RISE_H) : 0);

// How many trays the batch takes.
//   fillWeightGrams: the bottom layer's saved Fill Weight for this tray (or null); manualCount: her count (or null).
// Her count, when she typed one, wins; else the Fill Weight (rounded up, so no tray is over-filled); else 1.
export function trayCount({ baseRawGrams, fillWeightGrams, manualCount }) {
  const manual = Math.floor(Number(manualCount));
  if (manual >= 1) return { count: manual, source: 'manual' };
  const fw = Number(fillWeightGrams);
  if (fw > 0 && baseRawGrams > 0) return { count: Math.max(1, Math.ceil(baseRawGrams / fw - 1e-9)), source: 'fillWeight' };
  return { count: 1, source: 'default' };
}

// The whole plan.
//   tray:   { areaCm2, usableHeightCm }
//   layers: bottom first, each { key, name, totalGrams, wastes: [{ name, percent }], density, prebake (bottom only),
//           fill: { kind: 'all' } | { kind: 'height', targetCm } (not the bottom), measuredHeightCm (bottom,
//           after pre-baking; wins over the estimate), hMul (rise estimate's height multiplier) }
//   trays:  { fillWeightGrams, manualCount }
// Returns { ok, errors, warnings, trays, traySource, layers: [...per layer...], assembledHeightCm, finalHeightEstCm,
//   finishedPerTrayGrams, rawPerTrayGrams }. Grams per layer are per tray unless named *Total.
export function planLayers({ tray, layers, trays = {} }) {
  const errors = [], warnings = [];
  const area = Number(tray?.areaCm2) || 0, usable = Number(tray?.usableHeightCm) || 0;
  if (!(area > 0)) errors.push('The tray has no inside area.');
  if (!Array.isArray(layers) || layers.length < 2) errors.push('A layered tray needs at least two processes.');
  if (errors.length) return { ok: false, errors, warnings, layers: [] };

  const g = layers.map(l => layerGrams(l));
  const base = layers[0];
  const tc = trayCount({ baseRawGrams: g[0].raw, fillWeightGrams: trays.fillWeightGrams, manualCount: trays.manualCount });
  const n = tc.count;

  let top = 0;          // assembly height so far (cm from the tray floor)
  let finalTop = 0;     // estimated height after the final bake
  const out = [];
  layers.forEach((l, i) => {
    const density = Number(l.density) > 0 ? Number(l.density) : null;
    const gi = g[i];
    const row = {
      key: l.key, name: l.name, index: i, density,
      totalGrams: gi.total, availableRawTotal: gi.raw, bakeRetention: gi.hasBakingWaste ? gi.bakeRetention : 1, hasBakingWaste: gi.hasBakingWaste,
      prebake: i === 0 && !!l.prebake, fill: i === 0 ? { kind: 'all' } : (l.fill || { kind: 'all' }),
    };
    if (!density) { errors.push(`${l.name || 'A layer'} needs a density above 0.`); out.push(row); return; }
    if (!(gi.raw > 0)) errors.push(`${l.name || 'A layer'} has no quantity.`);

    if (row.fill.kind === 'height' && i > 0) {
      const target = Number(row.fill.targetCm);
      row.targetCm = target;
      if (!(target > top + 1e-9)) {
        errors.push(`${l.name || 'A layer'}: the target (${round(target)} cm) must be above the layers under it (${round(top)} cm).`);
        row.rawPerTray = 0;
      } else {
        row.rawPerTray = gramsFromHeight(target - top, area, density);
      }
      row.neededTotal = row.rawPerTray * n;
      const diff = gi.raw - row.neededTotal;
      row.notUsedTotal = diff > 1e-6 ? diff : 0;
      row.shortTotal = diff < -1e-6 ? -diff : 0;
      // If she wants to use it all instead: the height it would reach on every tray.
      row.heightIfAllUsedCm = top + heightFromGrams(gi.raw / n, area, density);
      // When short: how many trays it fills to the target (the rest get none).
      row.fullTraysAtTarget = row.rawPerTray > 0 ? Math.min(n, Math.floor(gi.raw / row.rawPerTray + 1e-9)) : 0;
    } else {
      row.rawPerTray = gi.raw / n;
      row.neededTotal = gi.raw;
      row.notUsedTotal = 0; row.shortTotal = 0;
    }

    row.rawHeightCm = heightFromGrams(row.rawPerTray, area, density);
    row.bakedHeightEstCm = bakedHeight(row.rawHeightCm, l.hMul);
    // What the layer is at assembly: a pre-baked bottom layer is already baked (her measurement, else the estimate);
    // anything else goes in raw.
    const measured = Number(l.measuredHeightCm);
    row.measured = row.prebake && measured > 0;
    row.assemblyHeightCm = row.prebake ? (row.measured ? measured : row.bakedHeightEstCm) : row.rawHeightCm;
    row.bottomCm = top;
    top += row.assemblyHeightCm;
    row.topCm = top;
    // After the final bake: a pre-baked layer stays as it went in; the rest rise by their own estimate.
    const finalH = row.prebake ? row.assemblyHeightCm : row.bakedHeightEstCm;
    row.finalBottomCm = finalTop;
    finalTop += finalH;
    row.finalHeightEstCm = finalH;
    row.finishedPerTray = row.rawPerTray * row.bakeRetention;
    out.push(row);
  });

  if (!errors.length && usable > 0) {
    if (top > usable + 1e-9) warnings.push(`At assembly the layers stand ${round(top)} cm, above the tray's ${round(usable)} cm usable height.`);
    else if (finalTop > usable + 1e-9) warnings.push(`After baking the layers may reach about ${round(finalTop)} cm, above the tray's ${round(usable)} cm usable height.`);
  }
  for (const r of out) if (r.shortTotal > 0) warnings.push(`${r.name || 'A layer'} is short by ${round(r.shortTotal)} g for ${n} tray${n === 1 ? '' : 's'}.`);

  return {
    ok: errors.length === 0, errors, warnings,
    trays: n, traySource: tc.source,
    layers: out,
    assembledHeightCm: top, finalHeightEstCm: finalTop,
    rawPerTrayGrams: out.reduce((s, r) => s + (r.rawPerTray || 0), 0),
    finishedPerTrayGrams: out.reduce((s, r) => s + (r.finishedPerTray || 0), 0),
  };
}

function round(v) { return Math.round(v * 100) / 100; }
