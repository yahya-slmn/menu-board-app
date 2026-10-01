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
// Served as they are, whatever each row's own name (2026-09-30): the name backstop below only caught a row
// literally named "Fruit Bar", so every single fruit under a Fruit Bar heading ("Melon Cubes", "Orange
// Segments") got a recipe, as did Staff's cut-fruit basket and its drinks. ONE list for two features (2026-10-01):
// no recipe here, and no AI ingredients in the Menu Ingredients Generator (lib/menuIngredientsRequest.js), in every
// section. Matched by CATEGORY, so KG-LP / MS-UP's "Fruit (a Selection of Seasonal Fruits)" (filed under Fruit Basket)
// is caught whatever its wording; CEO's "Fruits" category (real dishes: Papaya Slice, Chia Pudding) is not.
const SERVED_AS_IS_CATEGORY_PATTERNS = [
  { label: 'Fruit Bar', re: /\bfruit\s*bars?\b/i },
  { label: 'Fruit Basket', re: /\bfruit\s*baskets?\b/i },
  { label: 'Salad Bar', re: /\bsalad\s*bars?\b/i },
];

const EXCLUDED_CATEGORY_PATTERNS = [
  { label: 'Bread', re: /\bbread\b/i },
  { label: 'Milk', re: /\bmilk\b/i },
  { label: 'Juice', re: /\bjuice/i },
  ...SERVED_AS_IS_CATEGORY_PATTERNS,
  { label: 'Beverages', re: /\bbeverages?\b/i },
];

function isExcludedCategory(categoryText) {
  if (!categoryText) return false;
  return EXCLUDED_CATEGORY_PATTERNS.some((p) => p.re.test(categoryText));
}

function isServedAsIsCategory(categoryText) {
  if (!categoryText) return false;
  return SERVED_AS_IS_CATEGORY_PATTERNS.some((p) => p.re.test(categoryText));
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
  // Staff's drinks as one row ("Water/soft drink", "Water & Soft Drinks"), either way round.
  /^(water|soft\s*drinks?)\s*(\/|&|and|,)\s*(water|soft\s*drinks?)$/i,
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
//   4. The category GROUP (lib/recipeCategoryGroups.js, how the lists are grouped within a day) is chosen
//      by priority, not by first occurrence (confirmed with the chef 2026-09-30): a student row wins (a
//      shared dish sits with its school counterpart -- a Staff breakfast that is Daycare's PM Snack goes
//      under PM Snack), then a Staff "Main Dish" row (any Staff main is a main course, even one that is
//      also a Staff Lunch Box option), then the first occurrence. Matching is by NAME only (exact or
//      near-duplicate, as above), never by the engine's sharing structure: the chef hand-edits menus.
//      A dish whose group comes from a Staff LUNCH "Main Dish" row (no student row) is marked staffMainRole:
//      its group is Main Hot Dish or Starch / Side Vegetables, decided after generation from the dish itself
//      (meat / fish, else the AI's main-or-side role -- lib/recipeCategoryGroups.js staffMainGroup).
//      ALL Staff rows are also taken LAST (keeping their own order), so whichever row is kept for a dish
//      she shares with the students -- its category text, day and spelling ("Spring roll" over Staff's
//      "Spring Rolls") -- is the student one, whatever the tab order.
//
// Returns [{ name, category, dayLabel, section, categoryGroup, staffMainRole, reviewedIngredients, recipeName }], all
// from whichever row was accepted as the FIRST occurrence of that dish, except `section` (point 3) and the group
// (point 4). `name` is always the menu's own dish name; `recipeName` is set only for a later version of a name.
const STAFF_MAIN_DISH_RE = /^main\s*dish$/i;
const isStaffMainDishRow = (r) => r.section === 'STAFF' && STAFF_MAIN_DISH_RE.test(String(r.category || '').trim());
// Point 4's priority: 3 student row, 2 Staff "Main Dish" row, 1 anything else (first occurrence).
const groupRank = (r) => (isStudentSection(r.section) ? 3 : isStaffMainDishRow(r) ? 2 : 1);
const isStaffLunchMainRow = (r) => isStaffMainDishRow(r) && /^lunch$/i.test(String(r.period || '').trim());

// An Ingredients cell (" - "-separated, as Menu Ingredients writes it) -> the reviewed list, or null when the row has
// none. Kept as she wrote it (no case change); empty and repeated entries dropped.
function reviewedIngredientsOf(text) {
  if (text == null) return null;
  const seen = new Set();
  const list = String(text).split(' - ').map((x) => x.trim()).filter((x) => {
    const k = x.toLowerCase().replace(/\s+/g, ' ');
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return list.length ? list : null;
}

// Phase E (2026-10-01): a row read from a Menu Ingredients export carries the chef's reviewed list
// (reviewedIngredients). Two rows are ONE dish only when their names match (as above) AND their reviewed lists
// do -- compared ignoring case, spacing and order -- so a copy she edited for one section ("Edit for this
// section") gets its own recipe instead of being merged away. A row with no list (a plain menu, or a day without
// an Ingredients column) joins its name's first version, as before; a version that has no list yet takes the first
// list that comes. When one name ends up with several versions, the later ones get a distinct recipe name:
// "Zucchini Gratin (Staff)", or "(Staff, Monday 05-10-2026)" if the section alone still clashes (recipeName).
const listKeyOf = (list) => (Array.isArray(list) && list.length
  ? [...new Set(list.map((x) => String(x).toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean))].sort().join(' | ')
  : '');
const SECTION_LABELS = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };

function dedupeWithinUpload(rows) {
  const index = emptyDishIndex();
  const versionsOf = new Map(); // normalized name -> the entries (versions) already pushed to `results`
  const rankOf = new Map(); // entry -> rank of the row its categoryGroup came from
  const results = [];
  const ordered = [...rows.filter((r) => r.section !== 'STAFF'), ...rows.filter((r) => r.section === 'STAFF')];
  for (const r of ordered) {
    if (r.section === 'CEO') continue;
    if (isExcludedCategory(r.category)) continue;
    if (isReadyMadeItem(r.dishName)) continue;

    const listKey = listKeyOf(r.reviewedIngredients);
    const match = findDuplicateMatch(r.dishName, index);
    const versions = match ? versionsOf.get(normalizeDishName(match.matchedName)) || [] : [];
    const existing = !listKey ? versions[0]
      : versions.find((v) => v.listKey === listKey) || versions.find((v) => !v.listKey);
    if (existing) {
      // Already seen (exact or near-duplicate name, same reviewed list) earlier in THIS upload -- restrictive-wins
      // for section only (see point 3 above); every other field keeps its first-occurrence value.
      if (listKey && !existing.listKey) { existing.listKey = listKey; existing.reviewedIngredients = r.reviewedIngredients; }
      if (isStudentSection(r.section) && !isStudentSection(existing.section)) {
        existing.section = r.section;
      }
      if (groupRank(r) > rankOf.get(existing)) {
        existing.categoryGroup = r.categoryGroup ?? null;
        existing.staffMainRole = isStaffLunchMainRow(r);
        rankOf.set(existing, groupRank(r));
      }
      continue;
    }

    if (!match) addNameToIndex(index, r.dishName);
    // staffMainRole: the group came from a Staff LUNCH "Main Dish" row that no student row claims -- Main Hot Dish or
    // Starch / Side Vegetables is then decided after generation (lib/recipeCategoryGroups.js staffMainGroup).
    const entry = {
      name: r.dishName, category: r.category, dayLabel: r.dayLabel ?? null, section: r.section ?? null,
      categoryGroup: r.categoryGroup ?? null, staffMainRole: isStaffLunchMainRow(r),
      reviewedIngredients: listKey ? r.reviewedIngredients : null, listKey, recipeName: null,
    };
    rankOf.set(entry, groupRank(r));
    const key = normalizeDishName(match ? match.matchedName : r.dishName);
    if (!versionsOf.has(key)) versionsOf.set(key, []);
    versionsOf.get(key).push(entry);
    results.push(entry);
  }
  // Distinct recipe names for a name's later versions (the first keeps the plain name).
  for (const versions of versionsOf.values()) {
    if (versions.length < 2) continue;
    const used = new Set([normalizeDishName(versions[0].name)]);
    for (const v of versions.slice(1)) {
      const section = SECTION_LABELS[v.section] || 'another section';
      let name = `${v.name} (${section})`;
      if (used.has(normalizeDishName(name)) && v.dayLabel) name = `${v.name} (${section}, ${v.dayLabel})`;
      let n = 2;
      while (used.has(normalizeDishName(name))) name = `${v.name} (${section} ${n++})`;
      used.add(normalizeDishName(name));
      v.recipeName = name;
    }
  }
  return results.map(({ listKey, ...e }) => e);
}

// The NET WEIGHT every newly generated recipe is scaled to: the recipe-level Net Weight, i.e. what is left after each process's own
// waste %, added up across the processes -- NOT the raw ingredient total, which is whatever it takes to get there (about 164 g with
// an 8.5% baking waste). Recipes generated earlier stay at whatever they were saved with (~100 g); nothing rescales them. The
// Recipe Generator subtitle in renderer.js says the same number.
const REFERENCE_NET_WEIGHT_GRAMS = 150;

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
// `targetGrams` (a RAW total; new generations use normalizeProcessesToNetWeight below instead) -- generation asks the AI for
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

// A Salad-category dish gets its dressing as its own process (see SALAD_DRESSING_RULE in the generate-dish-recipes Edge Function).
// Decided here in code, from the menu category, and sent as a flag -- not left for the model to infer: any category containing the
// word "salad", case-insensitively ("Salad", "Salads", "Side Salad", "salad bar").
function isSaladCategory(category) {
  return /salad/i.test(String(category || ''));
}

// A process's Net Weight: its raw total run through its wastes, each taking its percent off what is left, rounded to 0.01 -- the
// same arithmetic as compoundWasteYield in renderer.js (the recipe form's own Net Weight), so the number shown there matches.
function compoundWasteYield(baseQty, wastes) {
  return roundNice((wastes || []).reduce((acc, w) => {
    const raw = parseFloat(w.percent);
    const pct = isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 100);
    return acc * (1 - pct / 100);
  }, baseQty));
}

// The recipe-level Net Weight of a list of processes: each process's own waste-adjusted total, added together (what the recipe
// form shows as Net Weight). 0 when nothing has a numeric quantity.
function netWeightOfProcesses(processes) {
  return roundNice((processes || []).reduce((sum, proc) => {
    const total = roundNice((proc.ingredients || []).reduce((s, ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return isNaN(q) ? s : s + q;
    }, 0));
    return sum + compoundWasteYield(total, proc.wastes);
  }, 0));
}

// Scales every ingredient (across every process) so the recipe-level NET WEIGHT lands on `targetNet` exactly, not the raw total:
// the raw total is whatever it takes for the summed, waste-adjusted process totals to come out at targetNet. The model is asked
// for a natural-size recipe and the ratios between ingredients (and between processes) are kept, exactly as with
// normalizeProcessesToGrams; only the size changes. Because each process rounds its own Net Weight to 0.01 after its wastes, the
// exact multiplier alone can display 149.99 or 150.01, so this tries the totals around it a hundredth at a time until the
// DISPLAYED Net Weight equals the target, then fine-tunes a few hundredths on each process's largest ingredient if several
// processes are involved -- the same approach as scaleSetsToNetWeight in renderer.js (the recipe form's own Net Weight edit).
// A recipe whose wastes leave nothing (or that has no numeric quantity) falls back to scaling the raw total.
function normalizeProcessesToNetWeight(processes, targetNet) {
  const slots = [], exact = [];
  (processes || []).forEach((proc, pi) => (proc.ingredients || []).forEach((ing, ii) => {
    const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
    if (!isNaN(q)) { slots.push([pi, ii]); exact.push(q); }
  }));
  const rawTotal = exact.reduce((a, b) => a + b, 0);
  if (!rawTotal || rawTotal <= 0) return processes;

  const retention = (wastes) => (wastes || []).reduce((acc, w) => {
    const raw = parseFloat(w.percent);
    return acc * (1 - (isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 100)) / 100);
  }, 1);
  const perProcessRaw = (processes || []).map(() => 0);
  slots.forEach(([pi], k) => { perProcessRaw[pi] += exact[k]; });
  const currentNet = perProcessRaw.reduce((acc, t, pi) => acc + t * retention(processes[pi].wastes), 0);
  if (!(currentNet > 0.001)) return normalizeProcessesToGrams(processes, targetNet);

  const displayedNet = (ticks) => {
    const totals = (processes || []).map(() => 0);
    slots.forEach(([pi], k) => { totals[pi] += ticks[k]; });
    return roundNice(totals.reduce((acc, t, pi) => acc + compoundWasteYield(roundNice(t / 100), processes[pi].wastes), 0));
  };
  const multiplierForNet = targetNet / currentNet;
  const centre = Math.round(rawTotal * multiplierForNet * 100);
  const allocate = (totalTicks) => allocateHundredths(exact.map((q) => (q * totalTicks) / 100 / rawTotal), totalTicks);
  let best = null;
  for (let step = 0; step <= 12 && !(best && best.miss < 0.0005); step++) {
    for (const k of (step === 0 ? [0] : [step, -step])) {
      if (centre + k <= 0) continue;
      const ticks = allocate(centre + k);
      const miss = Math.abs(displayedNet(ticks) - targetNet);
      if (!best || miss < best.miss) best = { ticks, miss };
      if (miss < 0.0005) break;
    }
  }
  // Fine-tune (several processes each rounding their own net): nudge one process's largest ingredient by a few hundredths.
  for (let round = 0; round < 6 && best.miss >= 0.0005; round++) {
    let improved = false;
    for (let pi = 0; pi < processes.length && best.miss >= 0.0005; pi++) {
      let bigK = -1;
      slots.forEach(([p], k) => { if (p === pi && (bigK < 0 || best.ticks[k] > best.ticks[bigK])) bigK = k; });
      if (bigK < 0) continue;
      for (let d = 1; d <= 25 && best.miss >= 0.0005; d++) {
        for (const sign of [1, -1]) {
          if (best.ticks[bigK] + sign * d < 0) continue;
          const ticks = best.ticks.slice(); ticks[bigK] += sign * d;
          const miss = Math.abs(displayedNet(ticks) - targetNet);
          if (miss < best.miss - 1e-12) { best = { ticks, miss }; improved = true; }
        }
      }
    }
    if (!improved) break;
  }
  const out = (processes || []).map((proc) => ({ ...proc, ingredients: (proc.ingredients || []).map((ing) => ({ ...ing })) }));
  slots.forEach(([pi, ii], k) => { out[pi].ingredients[ii].quantity = best.ticks[k] / 100; });
  return out;
}

module.exports = {
  REFERENCE_NET_WEIGHT_GRAMS, isExcludedCategory, isServedAsIsCategory, isReadyMadeItem, normalizeProcessesToGrams, normalizeProcessesToNetWeight, netWeightOfProcesses,
  sumProcessQuantities, allocateHundredths, isSaladCategory,
  findDuplicateMatch, dedupeWithinUpload, resolveSectionFromSheetName, isStudentSection, reviewedIngredientsOf,
  // Also used by the AI Menu Generator to index the real Dish Catalog / recently served names.
  emptyDishIndex, addNameToIndex, normalizeDishName,
};
