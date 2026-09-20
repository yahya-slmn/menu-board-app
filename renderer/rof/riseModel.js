// Deterministic "how will this dough rise and brown" model, from a process's ingredient list. No AI:
// it reads ingredient NAMES with keyword matching and works in percentages of flour weight (baker's
// percentages), so the same recipe always gives the same answer and every number can be explained
// to the chef. Quantities are grams (the app sums them without unit conversion; kg/l are the only
// units scaled here).
//
// Output multipliers are relative to the standard lean yeast dough each shape is tuned for:
//   hMul, wMul   how much taller / wider it grows than that standard (1 = standard)
//   proofShare   how much of the rise happens BEFORE the oven (yeast proofs; baking powder springs
//                mostly in the oven)
//   brownSpeed   how much faster than a lean dough it colours (sugar, egg, milk)
// `notes` are the plain-language reasons, shown in the Bake panel.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function grams(row) {
  const q = typeof row.quantity === 'number' ? row.quantity : parseFloat(row.quantity);
  if (!(q > 0)) return 0;
  const unit = String(row.unit || 'g').trim().toLowerCase();
  if (unit === 'kg') return q * 1000;
  return q; // g, ml, l-as-entered... the app itself treats every quantity as grams
}

const RX = {
  flour: /\b(flour|farina|semolina|atta|maida)\b/,
  notFlour: /(starch|cornflour|corn flour|almond|coconut|rice flour|chickpea|gram flour|besan)/,
  yeast: /\byeast\b/,
  fresh: /(fresh|compressed|cake)/,
  starter: /\b(starter|levain|sourdough|biga|poolish|preferment|pre-ferment|pate fermentee|pâte fermentée)\b/,
  bakingPowder: /baking powder/,
  soda: /(baking soda|bicarb|sodium bicarbonate)/,
  water: /\bwater\b/,
  milk: /\b(milk|buttermilk|yogh?urt|kefir|laban)\b/,
  cream: /\bcream\b/,
  egg: /\begg/,
  sugar: /\b(sugar|honey|syrup|molasses|glucose|treacle|dibs|date paste)\b/,
  fat: /\b(butter|oil|margarine|shortening|ghee|lard|fat)\b/,
  salt: /\bsalt\b/,
};

export function estimateRise(rows) {
  const t = { flour: 0, water: 0, milk: 0, egg: 0, yeastDry: 0, starter: 0, chem: 0, sugar: 0, fat: 0, salt: 0 };
  for (const row of rows || []) {
    const name = String(row.name || '').toLowerCase();
    const g = grams(row);
    if (!g || !name) continue;
    if (RX.starter.test(name)) t.starter += g;
    else if (RX.yeast.test(name)) t.yeastDry += RX.fresh.test(name) ? g / 3 : g; // fresh yeast is ~3x weaker by weight
    else if (RX.bakingPowder.test(name)) t.chem += g;
    else if (RX.soda.test(name)) t.chem += g * 0.5;
    else if (RX.flour.test(name) && !RX.notFlour.test(name)) t.flour += g;
    else if (RX.water.test(name)) t.water += g;
    else if (RX.milk.test(name)) t.milk += g;
    else if (RX.cream.test(name)) t.milk += g * 0.6;
    else if (RX.egg.test(name)) t.egg += g;
    else if (RX.sugar.test(name)) t.sugar += g;
    else if (RX.fat.test(name)) t.fat += g;
    else if (RX.salt.test(name)) t.salt += g;
  }
  // A starter is roughly half flour and half water by weight.
  const flour = t.flour + t.starter * 0.5;
  const liquid = t.water + t.milk * 0.87 + t.egg * 0.75 + t.starter * 0.5;

  const standard = { hMul: 1, wMul: 1, proofShare: 0.4, brownSpeed: 1, leaven: 1, hydration: 0.65, notes: [], identified: false };
  if (flour <= 0) {
    return { ...standard, notes: ["No flour found in this dough's ingredients -- using a standard rise."] };
  }

  const pct = (g) => (g / flour) * 100;
  const yeastPct = pct(t.yeastDry), starterPct = pct(t.starter), chemPct = pct(t.chem);
  const sugarPct = pct(t.sugar), fatPct = pct(t.fat), eggPct = pct(t.egg), saltPct = pct(t.salt);
  const hydration = liquid / flour;

  // Leavening strength: about 0.9 for a normal lean yeast dough (1.4% instant yeast, or ~25% starter).
  // Yeast saturates -- doubling it does not double the rise.
  const yeastPower = 1.2 * (1 - Math.exp(-yeastPct / 1.1));
  const starterPower = Math.min(0.95, starterPct / 26);
  const chemPower = Math.min(0.75, (chemPct / 2.2) * 0.7); // quick spring, but it never gets as tall
  let leaven = Math.min(1.4, yeastPower + starterPower + chemPower);

  // Sugar, fat and too much salt slow the yeast down.
  const drag = 1 - clamp((sugarPct - 8) / 60, 0, 0.28) - clamp((fatPct - 8) / 70, 0, 0.26) - clamp((saltPct - 2.4) * 0.1, 0, 0.15);
  const steamOnly = leaven < 0.08; // unleavened: a little steam spring, nothing more
  let hMul = steamOnly ? 0.16 : clamp(0.22 + 0.86 * leaven * drag, 0.15, 1.35);

  // Wet doughs spread wide and slump; stiff ones stay tight and tall.
  let wMul = clamp(1 + (hydration - 0.66) * 1.4, 0.72, 1.4);
  // Rich, sugary chemically-leavened doughs (cookies, scones) melt and spread rather than climb.
  wMul += clamp((sugarPct + fatPct - 40) / 160, 0, 0.5);
  if (hydration > 0.75) hMul *= 0.88;
  else if (hydration < 0.55) hMul *= 0.95;

  const proofPower = yeastPower + starterPower;
  const proofShare = steamOnly ? 0.05 : clamp(0.1 + 0.55 * (proofPower / Math.max(proofPower + chemPower, 0.001)), 0.1, 0.65);
  const brownSpeed = clamp(1 + Math.min(0.35, sugarPct / 60) + Math.min(0.15, eggPct / 80) + (t.milk > 0 ? 0.08 : 0), 0.85, 1.45);

  const label = leaven < 0.08 ? 'no leavening' : leaven < 0.25 ? 'little rise' : leaven < 0.5 ? 'moderate rise' : leaven < 1.0 ? 'strong rise' : 'very strong rise';
  const notes = [];
  if (steamOnly) notes.push('No yeast, starter or baking powder found -- only a little steam spring.');
  else {
    if (yeastPct > 0) notes.push(`Yeast ${yeastPct.toFixed(1)}% of flour`);
    if (starterPct > 0) notes.push(`Starter ${Math.round(starterPct)}% of flour`);
    if (chemPct > 0) notes.push(`Baking powder/soda ${chemPct.toFixed(1)}% of flour`);
    notes.push(`→ ${label}`);
  }
  const enriched = sugarPct > 8 || fatPct > 8 || eggPct > 12 || t.milk > 0;
  // Hydration only means "stiff/slack" for a plain dough -- eggs and fat change what it tells you.
  notes.push(`Hydration ${Math.round(hydration * 100)}%${enriched ? '' : ' → ' + (hydration < 0.55 ? 'stiff, stays tight' : hydration > 0.75 ? 'slack, spreads wide' : 'standard')}`);
  if (sugarPct > 8 || fatPct > 8 || eggPct > 12 || t.milk > 0) {
    const bits = [];
    if (sugarPct > 8) bits.push(`sugar ${Math.round(sugarPct)}%`);
    if (fatPct > 8) bits.push(`fat ${Math.round(fatPct)}%`);
    if (eggPct > 12) bits.push(`egg ${Math.round(eggPct)}%`);
    if (t.milk > 0) bits.push('milk');
    notes.push(`Enriched (${bits.join(', ')}) → browns ${brownSpeed > 1.2 ? 'much ' : ''}faster${drag < 0.95 ? ', rises slower' : ''}`);
  }
  return { hMul, wMul, proofShare, brownSpeed, leaven, hydration, notes, identified: true,
    percents: { yeast: yeastPct, starter: starterPct, chemical: chemPct, sugar: sugarPct, fat: fatPct, egg: eggPct, salt: saltPct } };
}
