// ============================================================
// Misk school policy: seafood/fish is prohibited as an ingredient in any generated recipe for a
// STUDENT section (Daycare/KG-LP/MS-UP) -- Staff (and CEO, though CEO never reaches this code at
// all, see main.js's dedupeWithinUpload) is exempt. This is deliberately a DIFFERENT shape from
// nutFilter.js's nut/sesame policy, not a copy-paste of it, for two reasons worth stating
// explicitly since they drove every design choice below:
//
//   1. SECTION-CONDITIONAL, not universal -- nuts are banned for everyone, always, so
//      matchNutTerms runs unconditionally on every generated ingredient. Seafood is fine for
//      Staff, so this module's matchSeafoodTerms is the SAME kind of blunt, unconditional,
//      ingredient-NAME-only match -- but the caller (main.js's persistGeneratedRecipeDraft) must
//      only ever invoke it when the recipe's own resolved section is a student section. This
//      file has no opinion on section at all; it just matches text, same "pure helper" split as
//      every other lib/ module here.
//   2. The genuinely hard part (a dish NAME describing a shape -- "fish-shaped sandwich" -- vs.
//      an actual seafood ingredient) is NOT this module's problem to solve, and isn't solved by
//      matching harder here. It's a PROMPT-level concern (see generate-dish-recipes'
//      seafoodAllowed/PLAIN_STAPLE-style rule), because the ambiguity lives in the DISH NAME
//      field, which this module never looks at. Once gated by section, this module only needs to
//      answer one much simpler question per INGREDIENT row: "does this ingredient's own name
//      describe real seafood?" -- and for a student-section recipe, the answer to that question
//      is ALWAYS "strip it" regardless of how the ingredient got there (a correctly-generated
//      shape-named sandwich has nothing to strip; a model mistake that snuck real fish into an
//      ingredient list gets caught here) -- exactly the same unconditional-within-its-gate logic
//      nutFilter.js already relies on, just gated by section instead of applying everywhere.
//
// Same false-positive discipline nutFilter.js's NUT_TERMS list went through (word-boundary
// matching, explicit negative-lookahead exceptions for real non-seafood foods that happen to
// share a word) -- confirmed two genuine cases while building this list:
//   - "crab apple(s)" -- a real fruit, botanically unrelated to crab.
//   - "lobster mushroom(s)" -- a real mushroom species (Hypomyces lactifluorum), zero seafood.
// "Worcestershire sauce" is included defensively (it traditionally contains anchovies) on the
// same "false positive is cheaper than a false negative" reasoning nutFilter.js already applies
// to halva/za'atar (ambiguous-derivative products the AI can't verify a specific variant of).
const SEAFOOD_TERMS = [
  // -- fish (generic + common named fish) --
  { label: 'fish (generic)', re: /\bfish\b/i },
  { label: 'seafood (generic)', re: /\bseafood\b/i },
  { label: 'shellfish (generic)', re: /\bshellfish\b/i },
  { label: 'salmon', re: /\bsalmons?\b/i },
  { label: 'tuna', re: /\btunas?\b/i },
  { label: 'cod', re: /\bcods?\b/i },
  { label: 'tilapia', re: /\btilapias?\b/i },
  { label: 'halibut', re: /\bhalibuts?\b/i },
  { label: 'snapper', re: /\bsnappers?\b/i },
  { label: 'mackerel', re: /\bmackerels?\b/i },
  { label: 'herring', re: /\bherrings?\b/i },
  { label: 'sardine', re: /\bsardines?\b/i },
  { label: 'anchovy', re: /\banchov(y|ies)\b/i },
  { label: 'trout', re: /\btrouts?\b/i },
  { label: 'catfish', re: /\bcatfish\b/i },
  { label: 'swordfish', re: /\bswordfish\b/i },
  { label: 'monkfish', re: /\bmonkfish\b/i },
  { label: 'bass', re: /\b(sea\s*)?bass\b/i },
  { label: 'mahi mahi', re: /\bmahi[\s-]?mahi\b/i },
  { label: 'grouper', re: /\bgroupers?\b/i },
  // -- shellfish/crustaceans/mollusks --
  { label: 'shrimp', re: /\bshrimps?\b/i },
  { label: 'prawn', re: /\bprawns?\b/i },
  // Negative lookahead excludes "crab apple(s)" -- see file-level comment above.
  { label: 'crab', re: /\bcrabs?\b(?!\s*apples?)/i },
  // Negative lookahead excludes "lobster mushroom(s)" -- see file-level comment above.
  { label: 'lobster', re: /\blobsters?\b(?!\s*mushrooms?)/i },
  { label: 'scallop', re: /\bscallops?\b/i },
  { label: 'squid', re: /\bsquids?\b/i },
  { label: 'calamari', re: /\bcalamari\b/i },
  { label: 'octopus', re: /\boctopus(es)?\b/i },
  { label: 'mussel', re: /\bmussels?\b/i },
  { label: 'clam', re: /\bclams?\b/i },
  { label: 'oyster', re: /\boysters?\b/i },
  { label: 'crawfish/crayfish', re: /\bcra[wy]fish\b/i },
  { label: 'surimi/imitation crab', re: /\bsurimi\b|\bimitation\s*crab\b/i },
  // -- roe/caviar --
  { label: 'caviar', re: /\bcaviar\b/i },
  { label: 'roe', re: /\broe\b/i },
  // -- fish-derived condiments/products (same "derived product, still banned" severity nuts get) --
  { label: 'fish sauce', re: /\bfish\s*sauce\b/i },
  { label: 'fish stock/broth', re: /\bfish\s*(stock|broth)\b/i },
  { label: 'anchovy paste', re: /\banchovy\s*paste\b/i },
  { label: 'worcestershire sauce', re: /\bworcestershire\b/i },
];

// Row-level check, matching nutFilter.js's own matchNutTerms shape exactly (Recipe Generator's
// generated_recipe_ingredients rows are already structured {name, quantity, unit, method}, one
// `name` string per row to test -- there's no dash-separated string to split here, unlike
// suggest-dish-ingredients' own format, so this module has no filterNutIngredients-style
// counterpart). Returns the matched label(s), or an empty array when clean.
function matchSeafoodTerms(text) {
  if (!text) return [];
  return SEAFOOD_TERMS.filter((t) => t.re.test(text)).map((t) => t.label);
}

module.exports = { matchSeafoodTerms };
