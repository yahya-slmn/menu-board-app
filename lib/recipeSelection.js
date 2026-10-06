// ============================================================
// Recipe Generator: "choose which dishes get a recipe" (2026-10-06). PURE: no AI, no database.
// An upload is read, parsed and deduped exactly as before (lib/recipeGenerator.js dedupeWithinUpload); the chef then ticks
// the dishes she wants and only those are generated. This file turns the deduped dishes into checklist rows, says which
// already have a Recipe Generator recipe (exact name, case and spacing aside -- a label only, never a block), splits the
// dishes into ticked / skipped, and estimates how long a run takes (no cost is shown, on purpose).
//
// A dish's key is its position in the deduped list of THAT upload. Each deduped entry is one object carrying its own
// reviewedIngredients (and recipeName for a later version of a name); selecting only filters which objects go on to
// generation, so a subset can never move a list onto another dish.
// ============================================================
const { categoryGroupInfo } = require('./recipeCategoryGroups');

// Measured with today's generate-dish-recipes prompt (Claude Opus 5.5) in the 2026-10-03 trial: 65 s per batch of 8 on average;
// batches run one after another. Retries add time, so the screen says "about".
const SECONDS_PER_BATCH = 65;

const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// recipes: generated_recipes rows { name, source_dish_name, status, code }. -> Map name key -> { status, code }. A confirmed
// recipe wins over a draft of the same name (its code is shown).
function existingRecipeIndex(recipes) {
  const out = new Map();
  for (const r of recipes || []) {
    const entry = { status: r.status === 'confirmed' ? 'confirmed' : 'draft', code: r.code || null };
    for (const k of new Set([nameKey(r.name), nameKey(r.source_dish_name)])) {
      if (!k) continue;
      const had = out.get(k);
      if (!had || (had.status === 'draft' && entry.status === 'confirmed')) out.set(k, entry);
    }
  }
  return out;
}

// dishes: dedupeWithinUpload's result. -> one row per dish, in the same order, for the checklist.
function checklistRows(dishes, existing = new Map()) {
  return (dishes || []).map((d, key) => {
    const g = categoryGroupInfo(d.categoryGroup);
    const name = d.recipeName || d.name;
    return {
      key,
      name,
      menuName: d.name,
      category: d.category || '',
      dayLabel: d.dayLabel || null,
      group: g.key,
      groupLabel: g.label,
      groupOrder: g.order,
      listCount: Array.isArray(d.reviewedIngredients) ? d.reviewedIngredients.length : 0,
      existing: existing.get(nameKey(name)) || null,
    };
  });
}

// -> { selected, skipped }: the dishes whose keys were ticked, and the others, both in the upload's own order. Keys that
// don't belong to this upload are ignored.
function selectDishes(dishes, keys) {
  const ticked = new Set((keys || []).map(Number).filter((k) => Number.isInteger(k)));
  const selected = [];
  const skipped = [];
  (dishes || []).forEach((d, i) => (ticked.has(i) ? selected : skipped).push(d));
  return { selected, skipped };
}

function generationEstimate(count, batchSize = 8) {
  const batches = Math.ceil(count / batchSize);
  return { batches, minutes: Math.ceil((batches * SECONDS_PER_BATCH) / 60) };
}

module.exports = { SECONDS_PER_BATCH, nameKey, existingRecipeIndex, checklistRows, selectDishes, generationEstimate };
