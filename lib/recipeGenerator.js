// Pure helpers for the Recipe Generator feature: which menu-row categories qualify for a
// generated recipe, and the reference-recipe normalization math -- no DB/network access, same
// "pure helper, main.js orchestrates" split as lib/nutFilter.js.

// EXCLUDE-list, not include-list (reversed from the original 5-category scope, per the chef's
// own explicit request): every dish gets a generated recipe EXCEPT Bread, Milk, and Juice --
// matched by category TEXT, section-agnostic, same reasoning as the old include-list had (school
// menus combine categories in ways that just need to match one pattern, e.g. a combined "Soup /
// Appetizer" category is irrelevant here since neither word means bread/milk/juice). Staff/CEO
// category labels are literal spreadsheet text rather than live DB category names (see
// lib/menuIngredients.js's own comment on this), so keyword matching against whatever text
// actually appears in the category column is the only approach that works uniformly across
// School/Staff/CEO uploads without hardcoding a category code per section.
//
// Category is the PRIMARY signal here, but deliberately not the only one -- see
// isReadyMadeItem's own comment below for why a name-based backstop is still required
// (confirmed necessary by a real bug, not a hypothetical). Bread gets no equivalent name-based
// backstop in THIS file on purpose: unlike milk/juice/water's small closed vocabulary, real bread
// item names vary too much ("Pita Bread", "Dinner Roll", "Baguette", "Whole Wheat Bread", ...) to
// safely enumerate as a fixed pattern list without real sample data to validate against -- the
// extract-menu-dishes AI prompt's own semantic categorization (see that Edge Function) is the
// better tool for that variety, extended to recognize a plain bread item by MEANING the same way
// it already does for milk/juice/fruit-basket.
const EXCLUDED_CATEGORY_PATTERNS = [
  { label: 'Bread', re: /\bbread\b/i },
  { label: 'Milk', re: /\bmilk\b/i },
  { label: 'Juice', re: /\bjuice/i },
];

function isExcludedCategory(categoryText) {
  if (!categoryText) return false;
  return EXCLUDED_CATEGORY_PATTERNS.some((p) => p.re.test(categoryText));
}

// ------------------------------------------------------------------
// Section resolution -- which of the 5 real sections (SECTION_SLOTS in lib/generator.js:
// DAYCARE/KG_LP/MS_UP/STAFF/CEO) a parsed row came from, needed for two section-conditional
// rules the chef gave explicitly: (1) CEO dishes never get a recipe generated at all, (2) seafood/
// fish is banned as an ingredient for the 3 student sections but allowed for Staff. Resolved from
// the sheet/tab name text alone -- for THIS app's own exports that's exact and deterministic
// (lib/export.js's SECTION_DISPLAY_NAMES are literally "Daycare"/"KG - LP"/"MS - UP (B-G)"/
// "Staff"/"CEO"), and the chef's own confirmation that real school-provided files are already
// well-organized program output (only individual item cells vary) means this same keyword match
// against the tab name should work there too -- no separate AI-inferred section signal needed on
// top of it for now. Returns null when the tab name doesn't confidently say any of the 5 --
// callers must treat null as the SAFE default (not Staff, not CEO), never guess permissive.
const SECTION_SHEET_NAME_PATTERNS = [
  { section: 'CEO', re: /\bceo\b/i },
  { section: 'STAFF', re: /\bstaff\b/i },
  { section: 'DAYCARE', re: /\bday\s*care\b/i },
  { section: 'KG_LP', re: /\bkg\b.*\blp\b/i },
  { section: 'MS_UP', re: /\bms\b.*\bup\b/i },
];

function resolveSectionFromSheetName(sheetName) {
  if (!sheetName) return null;
  for (const p of SECTION_SHEET_NAME_PATTERNS) {
    if (p.re.test(sheetName)) return p.section;
  }
  return null;
}

const STUDENT_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];

function isStudentSection(section) {
  return STUDENT_SECTIONS.includes(section);
}

// ------------------------------------------------------------------
// Ready-made/single-item exclusion -- a deterministic backstop alongside
// isExcludedCategory, not a replacement for it. Bug found on a real school-provided menu
// file processed through the AI-assisted layout-agnostic fallback (extract-menu-dishes, used
// whenever a file isn't one of this app's own exports): that file's own category labeling is
// coarser than this app's clean DB taxonomy -- a plain "Plain Fresh Milk Full Fat" item was
// nested under the SAME "AM Snack" period label a genuine snack dish elsewhere in that block
// also carried, so a category-text check alone let it through as "in scope". The
// extract-menu-dishes prompt was fixed to prefer a more specific same-row category and to
// recognize an unmistakably plain milk/juice/water/fruit item even with no specific label
// available at all -- but a prompt instruction is never a hard guarantee (same "belt and
// suspenders" reasoning as lib/nutFilter.js's own two-layer nut/sesame policy), so this checks
// the DISH NAME itself as a second, deterministic layer. Also the mechanism keeping Fruit
// Basket/Fruit Bar/Salad Bar/Water/Soft Drinks out of scope now that the category model flipped
// to exclude-only (confirmed with the chef: keep excluding these too, even though they're not
// one of the 3 named categories -- a "recipe" for a fruit basket or salad bar isn't meaningful).
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
  // A single flavor word immediately before "juice(s)" -- "Orange Juice", "Pineapple Juice",
  // "Apple Juice", "Mango Juice" -- covers the plain-flavored-juice case the bare "Juice" pattern
  // above doesn't (that one only matches the generic word alone). Deliberately requires EXACTLY
  // one leading word: a genuinely more composed drink almost always says so with an extra word
  // ("Fruit Juice Blend", "Detox Juice With Ginger And Turmeric", "Orange Mango Juice") which this
  // anchored ($-terminated) pattern won't match, so it stays un-excluded, erring toward "generate
  // a recipe for it" over wrongly skipping something that isn't actually plain -- same
  // conservative bias findDuplicateMatch's own word-count gate already applies elsewhere in this
  // file.
  /^\w+\s+juices?$/i,
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

// Empty index with the { exact, byWordCount } shape findDuplicateMatch expects -- an exact-match
// Map for the common case, plus names bucketed by word count for the near-duplicate pass (so that
// pass only ever compares within a bucket, never across word counts). Grown incrementally one
// name at a time via addNameToIndex (dedupeWithinUpload below needs to check each new row against
// every PRIOR row's name before adding it, not check a fixed pre-built list once) -- there is no
// cross-upload version of this anymore (removed per the chef's own explicit request: every
// upload generates its own complete recipe set, regardless of what any EARLIER upload already
// generated -- only within-upload repeats still dedupe).
function emptyDishIndex() {
  return { exact: new Map(), byWordCount: new Map() };
}

// Adds one more name into an existing index in place.
function addNameToIndex(index, original) {
  const normalized = normalizeDishName(original);
  if (!normalized) return;
  if (!index.exact.has(normalized)) index.exact.set(normalized, original);
  const wordCount = normalized.split(' ').length;
  if (!index.byWordCount.has(wordCount)) index.byWordCount.set(wordCount, []);
  index.byWordCount.get(wordCount).push({ normalized, original });
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

// Filters raw parsed rows down to one entry per genuinely distinct dish -- CEO/category/ready-
// made exclusion, THEN within-upload dedup, in one pass over `rows` ({ category, dishName,
// dayLabel, section } each). Three things this handles over the naive "dedupe by exact dishName
// string" a raw Map would give:
//
//   1. Case/whitespace/typo variants of the SAME dish within one upload now collapse into one
//      entry too, via exact-normalized-then-near-duplicate matching (findDuplicateMatch), built
//      incrementally here (each new row is checked against every row already accepted THIS
//      upload, via addNameToIndex) -- this is the ONLY dedup layer left in the app now (there is
//      no cross-upload/DB-catalog check anymore, removed per the chef's own explicit request:
//      every upload generates its own complete recipe set, regardless of what an EARLIER upload
//      already generated). Confirmed as a real gap in a raw exact-string Map, not a hypothetical:
//      "White Rice"/"white rice"/"White  Rice"/"Whit Rice" would otherwise land as 4 separate
//      entries (re-tested with a ~230-row synthetic upload after the exclude-only scope
//      expansion, which multiplies how many raw rows -- and therefore how many chances at a
//      stray variant -- flow through this pass on every real upload).
//   2. First-occurrence wins for every attribute that can legitimately vary across repeats of the
//      same dish (category, day label) -- same tie-break precedent this file already had for
//      category alone, now applied consistently to day label too (confirmed with the chef: keep
//      this simple, first occurrence only, not "show under every day it appeared on").
//   3. Section is the ONE exception to "first occurrence wins": if the SAME dish name shows up
//      under a student section (Daycare/KG-LP/MS-UP) on ANY occurrence, the deduped entry is
//      pinned to that student section even if a Staff/unknown occurrence was seen first -- the
//      seafood restriction downstream (see generate-dish-recipes' seafoodAllowed) needs the
//      MORE RESTRICTIVE reading to win on ambiguity, not whichever row happened to come first.
//      CEO rows are dropped outright, before dedup even runs -- confirmed with the chef: no
//      recipe is ever generated for CEO dishes, full stop, not a seafood-specific rule.
//
// Returns [{ name, category, dayLabel, section }], all from whichever row was accepted as the
// FIRST occurrence of that dish, except `section` (see point 3 above).
function dedupeWithinUpload(rows) {
  const index = emptyDishIndex();
  const byNormalized = new Map(); // normalized name -> the entry already pushed to `results`
  const results = [];
  for (const r of rows) {
    if (r.section === 'CEO') continue;
    if (isExcludedCategory(r.category)) continue;
    if (isReadyMadeItem(r.dishName)) continue;

    const match = findDuplicateMatch(r.dishName, index);
    if (match) {
      // Already seen (exact or near-duplicate) earlier in THIS upload -- restrictive-wins for
      // section only (see point 3 above); every other field keeps its first-occurrence value.
      const existing = byNormalized.get(normalizeDishName(match.matchedName));
      if (existing && isStudentSection(r.section) && !isStudentSection(existing.section)) {
        existing.section = r.section;
      }
      continue;
    }

    addNameToIndex(index, r.dishName);
    const entry = { name: r.dishName, category: r.category, dayLabel: r.dayLabel ?? null, section: r.section ?? null };
    byNormalized.set(normalizeDishName(r.dishName), entry);
    results.push(entry);
  }
  return results;
}

// The size every newly generated recipe is scaled to (grams of ingredients in total). Recipes generated earlier stay at whatever
// they were saved with (they were ~100 g); nothing rescales them. The Recipe Generator subtitle in renderer.js says the same number.
const REFERENCE_RECIPE_GRAMS = 150;

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

// Turns exact (unrounded) quantities into whole hundredths of a gram that add up to `targetTicks` exactly: every value is
// floored to a whole hundredth, then the hundredths still missing from the target go to the values with the LARGEST
// fractional remainders (largest-remainder allocation). Rounding each value on its own instead makes the rounded parts
// drift off the total in a third to two thirds of recipes (a 150 g target came back as 149.99 or 150.02), because the
// errors don't cancel. Each value ends up within one hundredth of its exact value. Mirrored in renderer.js
// (allocateHundredths) -- the renderer is a classic script and cannot require() this file.
function allocateHundredths(exact, targetTicks) {
  const scaled = exact.map((v) => v * 100);
  const base = scaled.map((v) => Math.floor(v + 1e-7));
  let missing = targetTicks - base.reduce((a, b) => a + b, 0);
  const byRemainder = scaled.map((v, i) => ({ i, r: v - base[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; missing > 0 && byRemainder.length; k = (k + 1) % byRemainder.length, missing--) base[byRemainder[k].i] += 1;
  // Only reachable through floating-point noise: take a hundredth back from the smallest remainders.
  for (let k = byRemainder.length - 1; missing < 0 && k >= 0; k--) {
    if (base[byRemainder[k].i] > 0) { base[byRemainder[k].i] -= 1; missing++; }
  }
  return base;
}

// Scales every ingredient's quantity (across every process) so their combined sum lands on
// `targetGrams` (REFERENCE_RECIPE_GRAMS, per the "reference recipe" requirement) -- generation asks the AI for
// a realistic NATURAL-scale recipe on purpose (LLMs are unreliable at hitting an exact numeric
// total), and this reuses the same multiplier = target / currentSum math Recipe
// Calculator's own "scale to target quantity" mode already relies on (renderer.js's
// computeMultiplierFromTarget/scaleIngredients) -- proven scaling math, just applied here right
// after generation instead of on demand. The rounded quantities add up to `targetGrams` EXACTLY
// (see allocateHundredths). A recipe with nothing to sum (every ingredient came
// back quantity-less) is returned untouched -- nothing to scale from.
function normalizeProcessesToGrams(processes, targetGrams) {
  const currentSum = sumProcessQuantities(processes);
  if (!currentSum || currentSum <= 0) return processes;

  const multiplier = targetGrams / currentSum;
  const slots = []; // [process index, ingredient index] of every ingredient with a numeric quantity
  const exact = [];
  (processes || []).forEach((proc, pi) => (proc.ingredients || []).forEach((ing, ii) => {
    const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
    if (!isNaN(q)) { slots.push([pi, ii]); exact.push(q * multiplier); }
  }));
  const ticks = allocateHundredths(exact, Math.round(targetGrams * 100));
  const out = (processes || []).map((proc) => ({ ...proc, ingredients: (proc.ingredients || []).map((ing) => ({ ...ing })) }));
  slots.forEach(([pi, ii], k) => { out[pi].ingredients[ii].quantity = ticks[k] / 100; });
  return out;
}

module.exports = {
  REFERENCE_RECIPE_GRAMS, isExcludedCategory, isReadyMadeItem, normalizeProcessesToGrams, sumProcessQuantities, allocateHundredths,
  findDuplicateMatch, dedupeWithinUpload, resolveSectionFromSheetName, isStudentSection,
};
