// Portion arithmetic for Shape & Place: the chef decides the grams per portion, the app works out how many
// WHOLE portions the dough makes and reports exactly what is left over (never silently rounded away).

export const MAX_PIECES = 60;      // what the stage will lay out on the bench
export const MIN_GRAMS = 5;

const EPS = 1e-9;                  // 1742 / (1742 / 19) must come out as 19, not 18.999999999999996
const NOISE_GRAMS = 0.05;          // leftovers below this are float noise, not dough

// net      the dough available (g)
// grams    portion weight the chef chose (g)          -- ignored when `cups` is given
// cups     number of cups on a muffin tray: one piece per cup, so the portion is net / cups and nothing is left over
export function planPortions({ net, grams, cups = 0 }) {
  if (!(net > 0)) return { count: 0, grams: 0, leftover: 0, capped: false, tooBig: true, wanted: 0 };
  if (cups > 0) return { count: cups, grams: net / cups, leftover: 0, capped: false, tooBig: false, wanted: cups };
  if (!(grams >= MIN_GRAMS)) return { count: 0, grams: grams || 0, leftover: net, capped: false, tooBig: false, invalid: true, wanted: 0 };
  const wanted = Math.floor(net / grams + EPS);
  if (wanted < 1) return { count: 0, grams, leftover: net, capped: false, tooBig: true, wanted: 0 };
  const count = Math.min(MAX_PIECES, wanted);
  let leftover = net - count * grams;
  if (Math.abs(leftover) < NOISE_GRAMS) leftover = 0;
  return { count, grams, leftover, capped: wanted > MAX_PIECES, tooBig: false, wanted };
}

// The portion weight that divides `net` into exactly `count` portions (the stepper sets this). Kept exact, not
// rounded: rounding it would strand a fraction of a gram and turn 19 portions into 18.
export const gramsForCount = (net, count) => (count > 0 ? net / count : 0);

// What to start from: the recipe's own portion weight if it has one, otherwise the shape preset's weight.
export function defaultGrams({ recipePortionGrams, shapeWeight }) {
  const r = Number(recipePortionGrams);
  if (r >= MIN_GRAMS) return r;
  const s = Number(shapeWeight);
  return s >= MIN_GRAMS ? s : 100;
}

// One-decimal text for grams ("91.7", "20", "0.3").
export const fmtGrams = (g) => String(Math.round(g * 10) / 10);
