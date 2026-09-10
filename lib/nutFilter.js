// ============================================================
// Misk school-wide policy: no nuts or nut-derived ingredients in ANY suggested ingredient list.
// This is the post-processing safety net behind the prompt-level instruction in
// supabase/functions/suggest-dish-ingredients/index.ts -- an LLM following instructions well
// most of the time still isn't a hard guarantee, so every suggestion gets scanned here
// regardless of how the prompt was worded, and anything matching is stripped before it ever
// reaches a chef's screen or an exported file.
//
// Scope: this only applies to INVENTED ingredient suggestions (Menu Ingredients Generator,
// suggest-dish-ingredients), where the AI is guessing a plausible list from a dish NAME alone
// with no real source to check against. It does NOT apply to Recipe Extractor (extract-recipe),
// which transcribes an actual recipe card/photo -- silently stripping "walnuts" from a real
// recipe that genuinely contains walnuts would make the system claim a nut-containing dish has
// no nuts, which is a worse safety outcome than doing nothing. Recipe Book has no AI ingredient
// suggestion at all (ingredients are picked manually from the ingredients master list), so
// there's nothing to filter there either.
//
// Matching is word-boundary-aware specifically to avoid two classes of real false positive:
//   1. Words that merely CONTAIN "nut" as a substring but aren't a nut at all -- "nutmeg" (a
//      spice, unrelated plant), "coconut", "doughnut"/"donut", "butternut squash". None of these
//      match here: a bare \bnuts?\b boundary can't trigger inside a glued compound word like
//      "nutmeg" or "coconut" (no boundary exists between two word characters), so these are safe
//      by construction, not by a special-cased exclusion list.
//   2. "water chestnut(s)" -- a real, common, safe stir-fry ingredient (an aquatic tuber,
//      botanically unrelated to tree-nut chestnuts) that WOULD otherwise false-positive against
//      a bare "chestnut" entry, since "chestnuts" there genuinely is its own whole word. This one
//      needs an explicit negative-lookbehind exception (see CHESTNUT_RE below) because the
//      word-boundary trick alone can't distinguish it from a real chestnut.
//
// Coconut is deliberately NOT on this list (confirmed with the school 2026-09) -- FDA allergen
// labeling groups it under "tree nuts," but it's botanically and medically unrelated to tree-nut
// allergies, and the policy here is "no nuts," not "follow FDA labeling."
//
// Dessert/product names that ONLY SOMETIMES contain nuts (nougat, satay, amaretto/amaretti) are
// included anyway, on explicit instruction: the AI can't verify which variant it meant, and a
// false positive (a chef manually re-adds a term they know is nut-free) is far cheaper than a
// false negative (a genuinely nut-containing suggestion reaching a Misk menu unflagged).
const NUT_TERMS = [
  // -- tree nuts --
  { label: 'almond', re: /\balmonds?\b/i },
  { label: 'cashew', re: /\bcashews?(nuts?)?\b/i },
  { label: 'walnut', re: /\bwalnuts?\b/i },
  { label: 'pistachio', re: /\bpistachios?\b/i },
  { label: 'hazelnut', re: /\b(hazelnuts?|filberts?)\b/i },
  { label: 'pecan', re: /\bpecans?\b/i },
  { label: 'macadamia', re: /\bmacadamias?(\s*nuts?)?\b|\bqueensland\s*nuts?\b/i },
  { label: 'brazil nut', re: /\bbrazil\s*nuts?\b/i },
  { label: 'pine nut', re: /\bpine\s*nuts?\b|\bpignolis?\b|\bpignolias?\b|\bpi[nñ]ons?\b/i },
  // Negative lookbehind excludes "water chestnut(s)" -- a real, safe, common stir-fry ingredient
  // unrelated to tree-nut chestnuts; see the file-level comment above.
  { label: 'chestnut', re: /(?<!water[\s-])\bchestnuts?\b/i },
  { label: 'beechnut', re: /\bbeechnuts?\b/i },
  { label: 'hickory nut', re: /\bhickory\s*nuts?\b/i },
  { label: 'candlenut', re: /\bcandlenuts?\b/i },
  { label: 'ginkgo nut', re: /\b(gink?go)\s*nuts?\b/i },
  // -- peanut (a legume botanically, but treated as a "nut" for allergy purposes everywhere) --
  { label: 'peanut', re: /\bpeanuts?\b/i },
  { label: 'groundnut', re: /\bgroundnuts?\b/i },
  { label: 'monkey nut', re: /\bmonkey\s*nuts?\b/i },
  { label: 'arachis', re: /\barachis\b/i },
  // -- generic / unnamed "nut" references --
  { label: 'nut (generic)', re: /\bnuts?\b/i },
  { label: 'tree nut', re: /\btree\s*nuts?\b/i },
  { label: 'nut butter', re: /\bnut\s*butters?\b/i },
  { label: 'nut milk', re: /\bnut\s*milks?\b/i },
  { label: 'nut oil', re: /\bnut\s*oils?\b/i },
  { label: 'nut flour', re: /\bnut\s*flours?\b/i },
  { label: 'nut meal', re: /\bnut\s*meals?\b/i },
  { label: 'nut paste', re: /\bnut\s*pastes?\b/i },
  { label: 'nut cream', re: /\bnut\s*creams?\b/i },
  // -- nut-derived products (near-universally nut-based, or included defensively per the
  // "block by default, let a human override per-dish" call above) --
  { label: 'marzipan', re: /\bmarzipan\b/i },
  { label: 'praline', re: /\bpralines?\b/i },
  { label: 'nougat', re: /\bnougats?\b/i },
  { label: 'nutella', re: /\bnutella\b/i },
  { label: 'frangipane', re: /\bfrangipane\b/i },
  { label: 'gianduja', re: /\bgianduja\b/i },
  { label: 'amaretto', re: /\bamarettos?\b/i },
  { label: 'amaretti', re: /\bamarettis?\b/i },
  { label: 'satay', re: /\bsatays?\b/i },
];

// `ingredientsString` is the dash-separated format suggest-dish-ingredients/index.ts asks the AI
// for (e.g. "zucchini - red onions - walnuts - olive oil - salt"). Splits on " - ", drops any
// segment matching ANY term above (the whole segment, not just the matched word, since a segment
// can be a full descriptive phrase like "toasted chopped walnuts"), and rejoins what's left.
// Returns { cleaned, removed } -- `removed` is the list of exact original segments that got
// dropped (for logging AND for showing the chef what was removed, per the school's request that
// this never happen silently), each paired with which blocklist term(s) matched it.
function filterNutIngredients(ingredientsString) {
  if (!ingredientsString) return { cleaned: ingredientsString || '', removed: [] };

  const segments = ingredientsString.split(' - ').map((s) => s.trim()).filter(Boolean);
  const kept = [];
  const removed = [];

  for (const segment of segments) {
    const matchedLabels = NUT_TERMS.filter((t) => t.re.test(segment)).map((t) => t.label);
    if (matchedLabels.length) {
      removed.push({ segment, matchedLabels });
    } else {
      kept.push(segment);
    }
  }

  return { cleaned: kept.join(' - '), removed };
}

module.exports = { filterNutIngredients };
