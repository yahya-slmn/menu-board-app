import { packCutters } from './packing.js';
import { planKnifeGrid } from './knifeGrid.js';
import { regionFromFootprint } from './trayModels.js';
import { gramsFromHeight, isBaking, isTrimming, retentionOf, planLayers } from './layers.js';

// Batch Calculator (Sheet & Trim, In layers): the layered tray (layers.js) run in reverse. The layered flow starts from
// the recipe's saved quantities and works out how far they reach; this starts from a TARGET portion count, a tray, a cut
// (a cutter or a knife grid) and each layer's thickness, and works out how many trays that takes and how much of each
// process to make. Pure arithmetic, no DOM, no 3D. Session-only, like everything in Recipe on Fire: the result scales a
// session copy of the recipe, never the saved one.
//
// Conventions (confirmed with the chef, 2026-09-27):
//   - Each layer is set by its THICKNESS as it goes into the tray (raw: rolled or poured), not its height from the
//     floor. Grams per tray = thickness x interior area x density (layers.js gramsFromHeight), so the quantities never
//     depend on the rise estimate. A pre-baked base's thickness is its raw, rolled thickness.
//   - Pieces per tray come from the SAME packer / knife grid Trim uses, with the same margin and gap, so the count
//     here is exactly what Auto-arrange or the knife will cut later. Trays = ceil(target / pieces per tray); the last
//     tray is a full tray, so the batch can make a few more than the target (reported as extra).
//   - Trimming Waste is LEFT OUT of the reverse calculation, on purpose (unlike the forward L1 plan, which counts it as a
//     pre-tray waste): here the cut layout is the real trimming measurement, and taking the recipe's Trimming % off as
//     well would overstate what she has to prepare. Every other non-Baking waste is prepared-but-not-in-the-tray, so
//     Total Quantity = raw in the trays / those wastes. Baking Waste turns raw into finished weight, as everywhere else.
//   - The answer is checked by running it forward through planLayers (every layer "All of it", the batch's tray count,
//     excludeTrimming): each layer must come back at its thickness. That run also gives the heights and rim warnings.

// Same margin / gap as Trim's Auto-arrange (renderer.js TRIM_MARGIN_CM / TRIM_GAP_CM).
export const TRIM_MARGIN_CM = 0.3;
export const TRIM_GAP_CM = 0.2;

// Area of one cut piece (cm2). A cutter's entered size is its inner cutting size; a knife cell is across x down.
// Mirrors cutterUnitAreaCm2 in renderer.js.
export function cutPieceAreaCm2(cut) {
  if (!cut) return 0;
  if (cut.kind === 'knife') return (Number(cut.acrossCm) || 0) * (Number(cut.downCm) || 0);
  const d = cut.dims || {};
  if (cut.shapeType === 'round') return Math.PI * ((Number(d.diameterCm) || 0) / 2) ** 2;
  if (cut.shapeType === 'rectangular') return (Number(d.lengthCm) || 0) * (Number(d.widthCm) || 0);
  if (cut.shapeType === 'triangle') return 0.5 * (Number(d.baseCm) || 0) * (Number(d.triHeightCm) || 0);
  return 0;
}

// How many pieces the cut gives on one tray (0 when it doesn't fit or isn't set).
export function piecesPerTray(region, cut) {
  if (!region || !cut) return 0;
  if (cut.kind === 'knife') return planKnifeGrid({ region, acrossCm: Number(cut.acrossCm), downCm: Number(cut.downCm) }).count;
  if (!(cutPieceAreaCm2(cut) > 0)) return 0;
  return packCutters({ region, shapeType: cut.shapeType, dims: cut.dims, marginCm: TRIM_MARGIN_CM, gapCm: TRIM_GAP_CM }).placements.length;
}

// The whole calculation.
//   tray:   { shapeType, footprint }  (footprint = renderer.js trayInteriorFootprint: areaCm2, usableHeightCm, innerR |
//           innerL / innerW | innerPts)
//   cut:    { kind: 'cutter', shapeType, dims } | { kind: 'knife', acrossCm, downCm }
//   target: portions wanted (a whole number >= 1)
//   layers: bottom first, each { key, name, totalGrams (the recipe's saved Total Quantity), wastes: [{ name, percent }],
//           density, thicknessCm, prebake (bottom only), hMul (rise estimate's height multiplier, for the check's
//           after-bake heights; optional) }
// Returns { ok, errors, warnings, perTray, trays, totalPortions, extraPortions, pieceAreaCm2, trayAreaCm2,
//   layers: [...], rawPerTrayGrams, finishedPerTrayGrams, rawPerPieceGrams, finishedPerPieceGrams, stackThicknessCm,
//   check }. Per layer: rawPerTray, rawTotal, requiredTotal (the Total Quantity to make), multiplier (x the saved
//   quantity), finishedPerTray, finishedTotal, trimmingExcluded ([{ name, percent }] left out, see above).
//   `check` is the forward planLayers result for the scaled quantities (null when there are errors).
export function solveBatch({ tray, cut, target, layers }) {
  const errors = [], warnings = [];
  const fp = tray?.footprint;
  const area = Number(fp?.areaCm2) || 0;
  const region = tray?.shapeType === 'muffin_tray' ? null : regionFromFootprint(tray?.shapeType, fp);
  const fail = () => ({ ok: false, errors, warnings, layers: [], check: null });

  if (tray?.shapeType === 'muffin_tray') errors.push('The Batch Calculator needs a sheet tray -- a muffin tray has a portion per cup already.');
  else if (!region || !(area > 0)) errors.push('Choose a tray with its size set.');
  if (!Array.isArray(layers) || layers.length < 2) errors.push('The Batch Calculator needs at least two layers.');
  const n = Number(target);
  if (!(Number.isInteger(n) && n >= 1)) errors.push('Enter a target of at least 1 portion (a whole number).');
  const pieceArea = cutPieceAreaCm2(cut);
  if (!cut || !(pieceArea > 0)) errors.push(cut?.kind === 'knife' ? 'Enter the knife piece size, across and down.' : 'Choose a cutter with its size set.');
  if (errors.length) return fail();

  const perTray = piecesPerTray(region, cut);
  if (perTray < 1) {
    errors.push(cut.kind === 'knife' ? 'A piece that size does not fit in this tray.' : 'This cutter does not fit in this tray.');
    return fail();
  }
  const trays = Math.ceil(n / perTray);

  const out = layers.map((l, i) => {
    const name = l.name || 'A layer';
    const density = Number(l.density), thickness = Number(l.thicknessCm), saved = Number(l.totalGrams);
    if (!(density > 0)) errors.push(`${name} needs a density above 0.`);
    if (!(thickness > 0)) errors.push(`${name} needs a thickness above 0.`);
    if (!(saved > 0)) errors.push(`${name} has no quantity in the recipe to scale.`);
    // Wastes the prepared quantity loses before it goes into the tray: everything but Baking and Trimming.
    const preTray = retentionOf(l.wastes, (w) => !isBaking(w) && !isTrimming(w));
    const bake = retentionOf(l.wastes, isBaking);
    if (!(preTray > 0)) errors.push(`${name}: its wastes take away all of it (100%).`);
    const rawPerTray = gramsFromHeight(thickness, area, density);
    const rawTotal = rawPerTray * trays;
    const requiredTotal = preTray > 0 ? rawTotal / preTray : 0;
    return {
      key: l.key, name: l.name, index: i, density, thicknessCm: thickness, prebake: i === 0 && !!l.prebake,
      savedTotal: saved, rawPerTray, rawTotal, requiredTotal,
      multiplier: saved > 0 ? requiredTotal / saved : 0,
      preTrayRetention: preTray, bakeRetention: bake, hasBakingWaste: (l.wastes || []).some(isBaking),
      finishedPerTray: rawPerTray * bake, finishedTotal: rawTotal * bake,
      trimmingExcluded: (l.wastes || []).filter(isTrimming).map(w => ({ name: w.name, percent: parseFloat(w.percent) || 0 })),
    };
  });
  if (errors.length) return fail();

  const rawPerTrayGrams = out.reduce((s, r) => s + r.rawPerTray, 0);
  const finishedPerTrayGrams = out.reduce((s, r) => s + r.finishedPerTray, 0);
  const share = pieceArea / area; // the sheet is uniform, so a piece's share of the grams is its share of the area

  // Forward check: the scaled quantities through the unchanged layered-tray plan.
  const check = planLayers({
    tray: { areaCm2: area, usableHeightCm: fp.usableHeightCm },
    trays: { manualCount: trays },
    excludeTrimming: true,
    layers: layers.map((l, i) => ({
      key: l.key, name: l.name, totalGrams: out[i].requiredTotal, wastes: l.wastes, density: out[i].density,
      prebake: i === 0 && !!l.prebake, fill: { kind: 'all' }, hMul: l.hMul,
    })),
  });
  if (!check.ok) errors.push(...check.errors);
  else check.layers.forEach((row, i) => {
    if (Math.abs(row.rawHeightCm - out[i].thicknessCm) > 1e-6) errors.push(`${out[i].name || 'A layer'}: the check came back at ${row.rawHeightCm} cm, not ${out[i].thicknessCm} cm.`);
  });
  warnings.push(...(check.warnings || []));

  return {
    ok: errors.length === 0, errors, warnings,
    perTray, trays, totalPortions: trays * perTray, extraPortions: trays * perTray - n,
    pieceAreaCm2: pieceArea, trayAreaCm2: area,
    layers: out,
    rawPerTrayGrams, finishedPerTrayGrams,
    rawPerPieceGrams: rawPerTrayGrams * share, finishedPerPieceGrams: finishedPerTrayGrams * share,
    stackThicknessCm: out.reduce((s, r) => s + r.thicknessCm, 0),
    check,
  };
}
