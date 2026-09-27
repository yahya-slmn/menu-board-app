import { doughOutlines } from './dough.js';
import { regionFromFootprint, trayPlanFromDims } from './trayModels.js';
import { createPlacement, autoArrangeStep } from './placement.js';
import { MAX_PIECES, MIN_GRAMS } from './portions.js';

// Shape & Place's Batch Calculator (phase S1): a target portion count, a tray, a shape and a portion weight give how many
// pieces fit on one tray, how many trays that takes, and how much dough to make. Pure: no DOM, no 3D (the pieces here are
// plain objects). Session-only, like everything in Recipe on Fire: the result scales a session copy of the recipe.
//
// Conventions (confirmed with the chef, 2026-09-27):
//   - One placed piece is one portion, of the chosen FINISHED weight (the Net Weight already has every waste off, Baking
//     included) -- the same as the Place step's planPortions.
//   - Pieces per tray is what Auto-arrange places: the SAME placement.js scan over the SAME collision outline
//     (dough.js doughOutlines, the risen footprint with the rise model's spread) on the SAME tray bounds and interior
//     (trayModels.js trayPlanFromDims / regionFromFootprint). A muffin tray holds one piece per cup. Never more than
//     MAX_PIECES (60, what the bench lays out); the result says when that limit, not the tray, set the count.
//   - Exactly the target is made: trays = ceil(target / per tray), and the last tray may be partly filled (never rounded
//     up to full trays).
//   - Required Net Weight = target x portion weight. One multiplier scales the whole dough (every process by the same
//     factor, so a One dough keeps its proportions): required / the dough's current Net Weight (Setup's combined wastage),
//     times SAFETY_MARGIN -- the Recipe Calculator's TARGET_PORTIONS_SAFETY_MARGIN (renderer.js), which keeps the
//     hundredth-of-a-gram rounding from ever costing a whole portion.

export const SAFETY_MARGIN = 1.0008; // = renderer.js TARGET_PORTIONS_SAFETY_MARGIN (checked by the tests)
const PIECE_SCALE_MIN = 0.55, PIECE_SCALE_MAX = 1.9;

// One piece's size for a portion weight: the shape preset scaled in every direction by the cube root of weight / the
// preset's weight, kept within 0.55-1.9x (renderer.js startPlacementSession).
export function pieceSpecFor(shape, grams) {
  const k = Math.min(PIECE_SCALE_MAX, Math.max(PIECE_SCALE_MIN, Math.cbrt(grams / shape.weight)));
  return { ...shape, lengthCm: shape.lengthCm * k, widthCm: shape.widthCm * k, heightCm: shape.heightCm * k };
}

// How many pieces of `spec` Auto-arrange puts on one tray. tray: { shapeType, dims, footprint }; spread: the rise model's
// width multiplier (how much room a piece reserves to rise). Returns { count, capped, cups }.
export function piecesPerTray({ tray, spec, spread = 1 }) {
  if (tray?.shapeType === 'muffin_tray') {
    const cups = Math.max(0, Math.floor(Number(tray.dims?.cupRows) || 0) * Math.floor(Number(tray.dims?.cupColumns) || 0));
    return { count: Math.min(cups, MAX_PIECES), capped: cups > MAX_PIECES, cups };
  }
  const region = regionFromFootprint(tray?.shapeType, tray?.footprint);
  const plan = tray && trayPlanFromDims(tray.shapeType, tray.dims);
  if (!region || !plan || !spec) return { count: 0, capped: false, cups: 0 };
  const { poly, rawPoly } = doughOutlines(spec, spread);
  const radius = Math.max(...poly.map(([x, y]) => Math.hypot(x, y)));
  const benchRadius = Math.max(...rawPoly.map(([x, y]) => Math.hypot(x, y)));
  const pieces = Array.from({ length: MAX_PIECES }, () => ({ home: 'bench', tx: 0, ty: 0, rotT: 0, poly, benchPoly: rawPoly, radius, benchRadius, baseYT: 0 }));
  const placement = createPlacement({ getItems: () => pieces, getTray: () => ({ region, plan, floorTopY: 0 }), getBench: () => null });
  // Auto-arrange gives each piece the FIRST free spot scanning the plan box top row first, left to right (placement.js
  // firstFree). With identical pieces, every spot before the last piece's was already refused for that piece, and one
  // more piece on the tray can only make them more crowded -- so the next piece's spot is never earlier in the scan.
  // ONE pass over the same grid, placing a piece wherever one fits, therefore gives exactly Auto-arrange's count (and
  // positions) without re-scanning from the top for every piece: milliseconds instead of seconds.
  const step = autoArrangeStep(plan);
  let count = 0;
  for (let y = plan.maxY; y >= plan.minY && count < MAX_PIECES; y -= step) {
    for (let x = plan.minX; x <= plan.maxX && count < MAX_PIECES; x += step) {
      const piece = pieces[count];
      if (!placement.trayValid(piece, x, y)) continue;
      piece.tx = x; piece.ty = y; piece.home = 'tray';
      count++;
    }
  }
  return { count, capped: count >= MAX_PIECES, cups: 0 };
}

// The whole calculation.
//   tray:   { shapeType, dims, footprint }
//   shape:  the preset { archetype, lengthCm, widthCm, heightCm, taper?, weight }
//   grams:  portion weight (finished)
//   target: portions wanted (a whole number >= 1)
//   net:    the dough's current Net Weight (g) -- Setup's combined total through its combined wastage
//   spread: the rise model's width multiplier for this dough
// Returns { ok, errors, perTray, trays, lastTray, totalPortions, capped, cups, spec, requiredNet, multiplier,
//   perTrayNet, lastTrayNet }.
export function solveShapeBatch({ tray, shape, grams, target, net, spread = 1 }) {
  const errors = [];
  const fail = () => ({ ok: false, errors });
  const g = Number(grams), n = Number(target), available = Number(net);
  if (!tray || !tray.shapeType) errors.push('Choose a tray.');
  else if (tray.shapeType !== 'muffin_tray' && !regionFromFootprint(tray.shapeType, tray.footprint)) errors.push('Choose a tray with its size set.');
  if (!shape || !(Number(shape.weight) > 0) || !(Number(shape.lengthCm) > 0) || !(Number(shape.widthCm) > 0) || !(Number(shape.heightCm) > 0)) errors.push('Choose a shape.');
  if (!(g >= MIN_GRAMS)) errors.push(`Enter a portion weight of at least ${MIN_GRAMS} g.`);
  if (!(Number.isInteger(n) && n >= 1)) errors.push('Enter a target of at least 1 portion (a whole number).');
  if (!(available > 0)) errors.push('The dough has no Net Weight to scale.');
  if (errors.length) return fail();

  const spec = pieceSpecFor(shape, g);
  const fit = piecesPerTray({ tray, spec, spread });
  if (fit.count < 1) {
    errors.push(tray.shapeType === 'muffin_tray' ? 'This muffin tray has no cups set.' : 'A piece that size does not fit in this tray.');
    return fail();
  }
  const perTray = fit.count;
  const trays = Math.ceil(n / perTray);
  const lastTray = n - (trays - 1) * perTray;
  const requiredNet = n * g;
  return {
    ok: true, errors,
    perTray, trays, lastTray, totalPortions: n, capped: fit.capped, cups: fit.cups,
    spec, requiredNet,
    multiplier: (requiredNet / available) * SAFETY_MARGIN,
    perTrayNet: perTray * g, lastTrayNet: lastTray * g,
  };
}
