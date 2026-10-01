// ============================================================
// Recipe Generator keeps the chef's reviewed ingredient list (Menu Ingredients -> Recipe Generator pipeline, Phase F,
// 2026-10-01). A recipe generated for a dish with a reviewed list (Phase E) is checked and marked here, in CODE:
//   - each recipe ingredient's ORIGIN: 'reviewed' when its name is on her list (case and spacing ignored), 'added' when
//     the AI added it (only what the method needs is allowed); null when the dish had no list;
//   - which of her ingredients the recipe left out (missingReviewed) -- main.js regenerates such a dish once, then
//     saves it flagged "Missing from the reviewed list: ...";
//   - the safety filters, with the chef's decisions: a NUT / sesame match on one of HER ingredients is kept and marked
//     override_policy 'nut' ("chef-confirmed override" -- the filter's word match is a false positive she corrected,
//     e.g. "sesame-free bun"); an AI-added one is removed as before. SEAFOOD for a student dish is ALWAYS removed, hers
//     too (absolute school policy -- seafood she put back usually means the dish is on the wrong section's menu), and
//     the draft is flagged "Seafood removed (student menu): ..." so it is never silent.
// Pure: no AI, no database.
// ============================================================
const { matchNutTerms } = require('./nutFilter');
const { matchSeafoodTerms } = require('./seafoodFilter');

const matchKey = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Her ingredients that no recipe row carries (exact name, case / spacing ignored; a reworded or split one counts as
// missing -- "sugar syrup" -> "sugar" + "water" left "sugar syrup" out).
function missingReviewed(reviewed, ingredientNames) {
  if (!Array.isArray(reviewed) || !reviewed.length) return [];
  const have = new Set(ingredientNames.map(matchKey));
  return reviewed.filter((r) => !have.has(matchKey(r)));
}

const namesOfProcesses = (processes) => (processes || []).flatMap((p) => (p.ingredients || []).map((i) => i.name));

// processes: [{ ...process, ingredients: [{ name, ... }] }] from the model. Returns the processes with each kept
// ingredient carrying `origin` / `overridePolicy`, plus `flags` ({ missing, seafoodRemoved }, empty arrays when clean)
// and `removed` (what the filters dropped, for the log).
function markRecipeIngredients(processes, { reviewed = null, studentSeafoodBanned = false } = {}) {
  const hasList = Array.isArray(reviewed) && reviewed.length > 0;
  const onList = new Set(hasList ? reviewed.map(matchKey) : []);
  const seafoodRemoved = [];
  const removed = [];
  const out = (processes || []).map((proc) => ({
    ...proc,
    ingredients: (proc.ingredients || []).flatMap((ing) => {
      const isReviewed = onList.has(matchKey(ing.name));
      if (studentSeafoodBanned && matchSeafoodTerms(ing.name).length) {
        removed.push({ name: ing.name, policy: 'seafood' });
        if (isReviewed) seafoodRemoved.push(ing.name);
        return [];
      }
      let overridePolicy = null;
      if (matchNutTerms(ing.name).length) {
        if (!isReviewed) { removed.push({ name: ing.name, policy: 'nut' }); return []; }
        overridePolicy = 'nut';
      }
      return [{ ...ing, origin: hasList ? (isReviewed ? 'reviewed' : 'added') : null, overridePolicy }];
    }),
  }));
  return {
    processes: out,
    flags: { missing: hasList ? missingReviewed(reviewed, namesOfProcesses(processes)) : [], seafoodRemoved },
    removed,
  };
}

// review_flags for the database: null when there is nothing to show.
function reviewFlagsValue(flags) {
  return flags && (flags.missing.length || flags.seafoodRemoved.length) ? flags : null;
}

// After main.js's one retry of the dishes whose recipe came back incomplete (or not at all): which answer to keep for
// each. firstIncomplete: [{ dish, gen, absent }] from the first attempt; retry: { created: [{ dish, gen }], incomplete:
// [{ dish, gen, absent }] }. A complete retry wins; two incomplete answers -> the one leaving out FEWER of her
// ingredients (the first on a tie); a dish whose retry failed outright keeps its first answer. Returns { persist:
// [{ dish, gen }] (beyond retry.created, which the caller adds itself), done: Set of every dish now with a recipe }.
function settleRetry(firstIncomplete, retry) {
  const first = new Map(firstIncomplete.map((x) => [x.dish, x]));
  const done = new Set(retry.created.map((x) => x.dish));
  const persist = [];
  for (const second of retry.incomplete) {
    const f = first.get(second.dish);
    const pick = f && f.absent.length <= second.absent.length ? f : second;
    persist.push({ dish: pick.dish, gen: pick.gen });
    done.add(second.dish);
  }
  for (const [dish, f] of first) {
    if (!done.has(dish)) { persist.push({ dish, gen: f.gen }); done.add(dish); }
  }
  return { persist, done };
}

module.exports = { matchKey, missingReviewed, namesOfProcesses, markRecipeIngredients, reviewFlagsValue, settleRetry };
