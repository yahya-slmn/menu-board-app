// Pure helpers for the Recipe Generator feature: which menu-row categories qualify for a
// generated recipe, and the 100g-reference normalization math -- no DB/network access, same
// "pure helper, main.js orchestrates" split as lib/nutFilter.js.

// Explicitly section-agnostic (confirmed with the chef): a dish qualifies by what its category
// TEXT means, not which section/sheet it came from. School menus combine Soup and Appetizers
// into one category (e.g. "Soup / Appetizer") -- it just matches both patterns below, still one
// dish, one recipe. Staff/CEO category labels are literal spreadsheet text rather than live DB
// category names (see lib/menuIngredients.js's own comment on this), so keyword matching against
// whatever text actually appears in the category column is the only approach that works
// uniformly across School/Staff/CEO uploads without hardcoding a category code per section.
const CATEGORY_KEYWORD_PATTERNS = [
  { label: 'AM / Breakfast', re: /\bam\b|\bbreakfast\b/i },
  { label: 'PM Snack', re: /\bpm\b/i },
  { label: 'Soup', re: /\bsoup\b/i },
  { label: 'Appetizers', re: /\bappetizer/i },
  { label: 'Main Course', re: /\bmain\b/i },
];

function matchesGeneratorCategory(categoryText) {
  if (!categoryText) return false;
  return CATEGORY_KEYWORD_PATTERNS.some((p) => p.re.test(categoryText));
}

// ------------------------------------------------------------------
// Ready-made/single-item exclusion -- a deterministic backstop alongside
// matchesGeneratorCategory, not a replacement for it. Bug found on a real school-provided menu
// file processed through the AI-assisted layout-agnostic fallback (extract-menu-dishes, used
// whenever a file isn't one of this app's own exports): that file's own category labeling is
// coarser than this app's clean DB taxonomy -- a plain "Plain Fresh Milk Full Fat" item was
// nested under the SAME "AM Snack" period label a genuine snack dish elsewhere in that block
// also carried, so matchesGeneratorCategory's category-text check alone let it through as
// "in scope". The extract-menu-dishes prompt was fixed to prefer a more specific same-row
// category and to recognize an unmistakably plain milk/juice/water/fruit item even with no
// specific label available at all -- but a prompt instruction is never a hard guarantee (same
// "belt and suspenders" reasoning as lib/nutFilter.js's own two-layer nut/sesame policy), so this
// checks the DISH NAME itself as a second, deterministic layer.
//
// Deliberately matched against the WHOLE dish name (after stripping common filler/descriptor
// words), never a bare substring test -- a substring check would also wrongly exclude a genuine
// composed dish that merely uses one of these as an ingredient (e.g. "Chia Pudding With Coconut
// Milk And Roasted Coconut Flakes", a real breakfast preparation with its own recipe, not a plain
// milk pour -- confirmed present in the same real file this bug was found on).
const READY_MADE_FILLER_WORDS = /\b(plain|fresh|full|fat|cold|chilled|whole|assorted|mixed|seasonal)\b/gi;
const READY_MADE_WHOLE_NAME_PATTERNS = [
  /^milks?$/i,
  /^(fruit\s*)?juices?$/i,
  /^water$/i,
  /^soft\s*drinks?$/i,
  /^fruit\s*(\(.*\))?$/i,
  /^fruit\s*(basket|bar)$/i,
  /^salad\s*bar$/i,
];

function isReadyMadeItem(dishName) {
  if (!dishName) return false;
  const stripped = dishName.replace(READY_MADE_FILLER_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return READY_MADE_WHOLE_NAME_PATTERNS.some((re) => re.test(stripped));
}

// ------------------------------------------------------------------
// Dish-dedup matching -- skip regenerating a recipe for a dish that already has one (draft or
// confirmed, from any menu ever uploaded), checked BEFORE the expensive generate-dish-recipes AI
// call (see parse-and-generate-recipes). Two tiers only, both string-only/no AI:
//
//   1. Exact match (normalized) -- the dominant real case, the same dish repeating verbatim
//      across weekly menus.
//   2. Near-duplicate match -- a cheap character-bigram similarity check, but ONLY between names
//      with the SAME WORD COUNT. That gate is deliberate: it's what lets "Whit Rice" match
//      "White Rice" (both 2 words, obviously a typo -- a real pair pulled from an actual uploaded
//      file) while refusing to even consider "Chicken Piccata" (2 words) against "Chicken
//      Piccata With Butter Creamy Sauce" (6 words) -- a longer name is very often distinguished
//      by exactly the words it added (a different sauce/cut/prep method), not just "more detail"
//      on the same dish, so word-count equality is required before any similarity score is even
//      computed. A wrongly-skipped unique dish is worse than an occasional duplicate slipping
//      through and costing one extra generation call, so this stays conservative on purpose.
// ------------------------------------------------------------------

function normalizeDishName(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// Dice coefficient over character bigrams -- no external library needed, and (unlike a raw edit-
// distance ratio) stays meaningful across the short school-dish-name lengths seen in practice.
// 1 = identical, 0 = no shared bigrams at all.
function diceCoefficient(a, b) {
  if (a === b) return 1;
  const bgA = bigrams(a), bgB = bigrams(b);
  if (bgA.length === 0 || bgB.length === 0) return 0;
  const counts = new Map();
  for (const bg of bgA) counts.set(bg, (counts.get(bg) || 0) + 1);
  let matches = 0;
  for (const bg of bgB) {
    const c = counts.get(bg) || 0;
    if (c > 0) { matches++; counts.set(bg, c - 1); }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}

// Calibrated against real dish-name pairs (bigram Dice score), not guessed: genuine typo/variant
// pairs score 0.82-0.98 ("Whit Rice"/"White Rice" 0.824, "Mashed potato"/"Mashed Potatoes" 0.923,
// "marqouk"/"marqouq" 0.833), while the highest score found between genuinely DIFFERENT
// same-word-count dishes was 0.571 ("orange juice"/"apple juice") -- "chicken jareesh"/"chicken
// kebab" 0.538, "white rice"/"brown rice" 0.444, "salad bar"/"fruit bar" 0.375. 0.80 sits well
// inside that gap, comfortably above every false-positive risk seen and comfortably below every
// real variant.
const NEAR_DUPLICATE_DICE_THRESHOLD = 0.80;

// Builds the lookup findDuplicateMatch checks a new dish name against: an exact-match Map for
// the common case, plus existing names bucketed by word count for the near-duplicate pass (so
// that pass only ever compares within a bucket, never across word counts).
function buildExistingDishIndex(existingNames) {
  const exact = new Map(); // normalized name -> original name
  const byWordCount = new Map(); // word count -> [{ normalized, original }]
  for (const original of existingNames) {
    const normalized = normalizeDishName(original);
    if (!normalized) continue;
    if (!exact.has(normalized)) exact.set(normalized, original);
    const wordCount = normalized.split(' ').length;
    if (!byWordCount.has(wordCount)) byWordCount.set(wordCount, []);
    byWordCount.get(wordCount).push({ normalized, original });
  }
  return { exact, byWordCount };
}

// Returns { matchedName, matchType: 'exact'|'similar' } when `name` already has a recipe
// somewhere in `index`, else null.
function findDuplicateMatch(name, index) {
  const normalized = normalizeDishName(name);
  if (!normalized) return null;

  const exactMatch = index.exact.get(normalized);
  if (exactMatch) return { matchedName: exactMatch, matchType: 'exact' };

  const wordCount = normalized.split(' ').length;
  const candidates = index.byWordCount.get(wordCount) || [];
  for (const candidate of candidates) {
    if (diceCoefficient(normalized, candidate.normalized) >= NEAR_DUPLICATE_DICE_THRESHOLD) {
      return { matchedName: candidate.original, matchType: 'similar' };
    }
  }
  return null;
}

function roundNice(n) {
  return Math.round(n * 100) / 100;
}

function sumProcessQuantities(processes) {
  return (processes || []).reduce((sum, proc) => (
    sum + (proc.ingredients || []).reduce((s, ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return isNaN(q) ? s : s + q;
    }, 0)
  ), 0);
}

// Scales every ingredient's quantity (across every process) so their combined sum lands on
// `targetGrams` (100, per the "100g reference recipe" requirement) -- generation asks the AI for
// a realistic NATURAL-scale recipe on purpose (LLMs are unreliable at hitting an exact numeric
// total), and this reuses the exact same multiplier = target / currentSum math Recipe
// Calculator's own "scale to target quantity" mode already relies on (renderer.js's
// computeMultiplierFromTarget/scaleIngredients) -- proven scaling math, just applied here right
// after generation instead of on demand. A recipe with nothing to sum (every ingredient came
// back quantity-less) is returned untouched -- nothing to scale from.
function normalizeProcessesToGrams(processes, targetGrams) {
  const currentSum = sumProcessQuantities(processes);
  if (!currentSum || currentSum <= 0) return processes;

  const multiplier = targetGrams / currentSum;
  return (processes || []).map((proc) => ({
    ...proc,
    ingredients: (proc.ingredients || []).map((ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return { ...ing, quantity: isNaN(q) ? ing.quantity : roundNice(q * multiplier) };
    }),
  }));
}

module.exports = {
  matchesGeneratorCategory, isReadyMadeItem, normalizeProcessesToGrams, sumProcessQuantities,
  buildExistingDishIndex, findDuplicateMatch,
};
