// ============================================================
// AI Menu Generator, Phase 2: turns a date range into a saved DRAFT run (ai_menu_runs /
// ai_menu_draft_dishes / ai_menu_draft_picks). Nothing here touches menu_items or generated_menus;
// that only happens on Approve.
//
//   1. Pools. Every AI category of every section gets a pool of AI dishes (POOL_SPECS). KG-LP and
//      MS-UP share one Lunch Main and one Lunch Starch pool, because the engine serves them
//      identical picks. Each pool starts at roughly "unique dishes the 28-day rule needs" plus a
//      small margin, split by the attributes its rules read (1 chicken + 1 beef, Pastry vs Cold
//      Kitchen days, one vegetarian a day...).
//   2. Every AI dish is checked in code before it is kept: shape and attribute values, the
//      nut/sesame/seafood check (lib/aiMenuSafety.js -- a failure is rejected and reported), then
//      the catalog duplicate check (findDuplicateMatch, same category): a match LINKS to the
//      existing item instead of creating a near-copy, and a match with a retired item is dropped.
//   3. The real engine (lib/aiMenu.computeDraftMenus -> MenuGenerator) schedules the whole run from
//      those pools. A flat "days x slots" pool isn't enough -- Staff Main's vegetarian dishes and
//      Staff Breakfast's concept spread ran short that way in Phase 1 -- so the engine's own
//      "reused after only N days" / "could not satisfy composition rule" / "no PASTRY AM Snack"
//      warnings, plus the distinct-attribute clashes it fills silently, are read back and ONLY the
//      short attribute of the short pool is topped up, then the engine runs again.
//   4. The final schedule is saved as draft picks, the dishes as draft dishes, and every rejected
//      dish and remaining rule warning goes into ai_menu_runs.warnings -- never silent.
// ============================================================
const { supabase, supaFail } = require('./supabaseClient');
const { SECTION_SLOTS, AM_SNACK_STYLE_BY_PATTERN, schoolDaysFrom, schoolDayCountBetween } = require('./generator');
const { cuisineForDate } = require('./nationalDay');
const { AI_CATEGORIES, DRAFT_SECTION_ORDER, isAiCategory, draftDishToPoolItem, computeDraftMenus } = require('./aiMenu');
const { getCategoryByCode, getSectionByCode, getProteinTypes, getProteinById } = require('./referenceData');
const { findDuplicateMatch, emptyDishIndex, addNameToIndex, normalizeDishName, isStudentSection } = require('./recipeGenerator');
const { checkDishSafety, safetyScanRecord } = require('./aiMenuSafety');
const { generateMenuDishes } = require('./generateMenuDishes');

// 28 calendar days (the engine's NO_REPEAT_DAYS) is 20 Sun-Thu school days: a dish can come back
// after that, so a pool never needs more than 20 days' worth of unique dishes. Tuesdays have their
// own National Day dishes, so the REGULAR pools only cover the other days: at most 16 of any 20.
const NO_REPEAT_SCHOOL_DAYS = 20;
const NO_REPEAT_REGULAR_DAYS = 16;
const MAX_DISHES_PER_CALL = 20;
const AI_CONCURRENCY = 4;
const MAX_TOPUP_ROUNDS = 3;
const TOPUP_FACTOR = 1.25;

const ENUMS = {
  sauce_type: ['RED', 'WHITE', 'ASIAN', 'GLAZED', 'GRAVY', 'DRY'],
  carb_type: ['RICE', 'PASTA', 'POTATO', 'OTHER'],
  dish_concept: ['EGG', 'PASTRY', 'SANDWICH', 'CEREAL_DAIRY', 'CHEESE', 'OTHER'],
  am_snack_style: ['PASTRY', 'COLD_KITCHEN'],
};
const ATTRS = ['protein_code', 'sauce_type', 'carb_type', 'dish_concept', 'am_snack_style'];

const AUDIENCE = {
  DAYCARE: 'Daycare children, about 1 to 3 years old. Soft, mild, easy to chew, cut small; no chili heat, nothing hard, round or chokeable (whole grapes, whole cherry tomatoes, hard raw vegetables, popcorn).',
  KG_LP: 'Kindergarten and lower-primary children, about 4 to 8 years old. Mild, familiar, kid-friendly flavours that are easy to eat.',
  MS_UP: 'Upper-primary and middle-school students, about 9 to 14 years old. Kid-friendly but a little more adventurous; filling.',
  KG_LP_MS_UP: 'Children from kindergarten to middle school, about 4 to 14 years old -- the SAME dish is served to all of them, so it must suit the younger ones too: mild, familiar, easy to eat.',
  STAFF: 'Adult school staff. Restaurant-quality buffet food; broader and bolder flavours, spice welcome.',
};

const GUIDANCE = {
  AM_SNACK: 'The mid-morning snack, one item per child. Either PASTRY style (baked or griddled: muffins, pancakes, croissants, manakish, waffles, cake slices, cheese rolls) or COLD_KITCHEN style (assembled savory: sandwiches, wraps, mini pizzas, omelettes, cheese or vegetable plates).',
  LUNCH_MAIN: 'The main course of school lunch: a protein-led hot dish with its sauce. Starch and vegetable sides are served separately, so do not build a full plate.',
  LUNCH_STARCH: 'The starch side served next to the lunch mains: rice dishes, pasta, potatoes, bulgur, couscous, freekeh and similar. A side dish, never meat-based.',
  LUNCH_VEGETABLE: 'A hot cooked vegetable side served with lunch (sauteed, roasted, steamed, braised or gratinated vegetables). No meat.',
  LUNCH_SALAD: 'The vegetable side for Daycare lunch: vegetable STICKS or FINGERS that toddlers pick up and eat by hand -- steamed or baked by default (e.g. steamed sweet potato and carrot fingers, baked pumpkin wedges with a yogurt dip, steamed broccoli and zucchini sticks). Soft raw vegetables such as cucumber are fine; carrot and celery must always be steamed or baked, never raw (choking risk), and say so in the name or description. An optional dip (yogurt, labneh) is welcome. NEVER a puree, mash or blended dish, and no meat.',
  SOUP_APPETIZER: 'A soup or small starter served before the lunch main: lentil, vegetable, chicken or cream soups, and small savory starters.',
  PM_SNACK: 'The light afternoon snack before home time, either PASTRY style (vanilla cake, muffins, date balls, small baked goods) or SALTY-SNACK style (salted pretzels, baked vegetable chips, crackers, savory bites). Never manakish of any kind -- manakish is served only at the morning snack.',
  STAFF_BREAKFAST: 'One dish on the staff breakfast buffet (six a day): egg dishes, pastries, sandwiches and wraps, oats / granola / yogurt bowls, cheese plates, foul, shakshuka and other hot or cold breakfast items.',
  STAFF_APPETIZER: 'A lunch starter for staff (two a day): hot or cold mezze, soups, small plates.',
  STAFF_MAIN: 'A main course on the staff lunch buffet (seven a day): protein-led or hearty vegetarian mains from any cuisine.',
  STAFF_LUNCHBOX: 'A dish for the staff grab-and-go lunch box: a complete, portable meal that travels well (rice or grain bowls, wraps, pasta, a protein with its side).',
  STAFF_SWEETS: 'A dessert on the staff lunch buffet (three a day): cakes, puddings, mousses, tarts, cookies, fruit desserts and Arabic sweets.',
};

// Attributes the AI must fill for the engine's rules to work on this category.
const REQUIRED_ATTRS = {
  AM_SNACK: ['am_snack_style', 'dish_concept'],
  LUNCH_MAIN: ['protein_code', 'sauce_type'],
  LUNCH_STARCH: ['carb_type'],
  STAFF_BREAKFAST: ['dish_concept'],
  // Staff Main's own pair must differ in starch, so each needs one.
  STAFF_MAIN: ['protein_code', 'carb_type'],
  STAFF_LUNCHBOX: ['protein_code'],
};

const MEAT_PROTEINS = ['CHICKEN', 'BEEF', 'LAMB', 'FISH'];

function withMargin(n) {
  return n + Math.ceil(n * 0.1) + 1;
}

// One entry per AI pool. `ruleAttrs` = what a replacement dish must match when one of this pool's
// dishes had to be reused (the attributes this pool's rules select on); `spreadAttr` = what to vary
// in a group when nothing else is fixed. initialGroups(d) gets d = unique school days needed.
function poolSpecs() {
  // tuesdayGroups(ctx) is the National Day order for ONE Tuesday: exactly what that day's rules need
  // in that cuisine, plus a spare, so every rule can hold on the day (ctx.style = that day's AM Snack
  // style for this section). Default: the slot's count + 1.
  const perSection = (sectionCode, category, perDay, extra = {}) => ({
    key: `${sectionCode}:${category}`, sections: [sectionCode], category, perDay,
    audience: AUDIENCE[sectionCode], ruleAttrs: [], spreadAttr: null, guidance: null, requiredAttrs: null,
    initialGroups: (d) => [{ count: withMargin(d * perDay) }],
    tuesdayGroups: function () { return [{ count: this.perDay + 1, ...(this.spreadAttr ? { spread: { attr: this.spreadAttr } } : {}) }]; },
    ...extra,
  });
  const amSnack = (sectionCode) => perSection(sectionCode, 'AM_SNACK', 1, {
    ruleAttrs: ['am_snack_style'], spreadAttr: 'dish_concept',
    initialGroups: (d) => ['PASTRY', 'COLD_KITCHEN'].map((style) => ({
      count: withMargin(Math.ceil(d / 2)), fixed: { am_snack_style: style }, spread: { attr: 'dish_concept' },
    })),
    tuesdayGroups: (ctx) => [{ count: 2, fixed: { am_snack_style: ctx.style[sectionCode] }, spread: { attr: 'dish_concept' } }],
  });
  const coupled = (category, extra) => ({
    key: `KG_LP+MS_UP:${category}`, sections: ['KG_LP', 'MS_UP'], category, perDay: 2,
    audience: AUDIENCE.KG_LP_MS_UP, guidance: null, requiredAttrs: null, ...extra,
  });
  return [
    amSnack('DAYCARE'),
    // Daycare has no separate starch slot, so its main is one combined plate with the starch built
    // in -- which is why the starch type is required here and not for KG-LP / MS-UP's mains.
    perSection('DAYCARE', 'LUNCH_MAIN', 1, {
      ruleAttrs: ['protein_code'], spreadAttr: 'protein_code',
      requiredAttrs: ['protein_code', 'sauce_type', 'carb_type'],
      guidance: 'The Daycare lunch main: ONE combined dish with its starch built in -- protein and starch together on the plate, since Daycare has no separate starch side (e.g. chicken molokhiyya with white rice, beef with pasta in pink sauce, lamb and vegetable stew with bulgur). Soft and easy for toddlers to eat.',
      initialGroups: (d) => [{ count: withMargin(d), spread: { attr: 'protein_code', values: ['CHICKEN', 'BEEF', 'LAMB'] } }],
      // Three proteins, so one always differs from Monday's (no-consecutive-protein rule).
      tuesdayGroups: () => [{ count: 3, spread: { attr: 'protein_code', values: ['CHICKEN', 'BEEF', 'LAMB'] } }],
    }),
    perSection('DAYCARE', 'LUNCH_SALAD', 1),
    perSection('DAYCARE', 'SOUP_APPETIZER', 1),
    perSection('DAYCARE', 'PM_SNACK', 1, {
      guidance: 'The Daycare afternoon snack: SOFT pastry-style or savory items only (vanilla cake, soft muffins, date balls, soft pretzel bites) -- nothing hard or crunchy, no hard pretzels or chips (choking risk). Never manakish -- that is only for the morning snack.',
    }),
    amSnack('KG_LP'),
    perSection('KG_LP', 'SOUP_APPETIZER', 1),
    perSection('KG_LP', 'PM_SNACK', 1),
    amSnack('MS_UP'),
    perSection('MS_UP', 'LUNCH_VEGETABLE', 1),
    perSection('MS_UP', 'SOUP_APPETIZER', 1),
    perSection('MS_UP', 'PM_SNACK', 1),
    coupled('LUNCH_MAIN', {
      ruleAttrs: ['protein_code', 'sauce_type'], spreadAttr: 'sauce_type',
      initialGroups: (d) => ['CHICKEN', 'BEEF'].map((p) => ({ count: withMargin(d), fixed: { protein_code: p }, spread: { attr: 'sauce_type' } })),
      tuesdayGroups: () => ['CHICKEN', 'BEEF'].map((p) => ({ count: 2, fixed: { protein_code: p }, spread: { attr: 'sauce_type' } })),
    }),
    coupled('LUNCH_STARCH', {
      ruleAttrs: ['carb_type'], spreadAttr: 'carb_type',
      initialGroups: (d) => [{ count: withMargin(2 * d), spread: { attr: 'carb_type' } }],
      tuesdayGroups: () => [{ count: 3, spread: { attr: 'carb_type' } }],
    }),
    // Staff's own picks per day, after the shared ones: Breakfast 6 - 3 school AM Snacks; Main 7 -
    // 5 shared (KG-LP/MS-UP 2 mains + 2 starches, MS-UP's vegetable) = exactly 1 vegan + 1 vegetarian.
    //
    // The vegetarian groups are bigger than "one a day" on purpose: after the composition rule
    // takes its one vegetarian, the engine's general fill draws from the whole pool, vegetarian
    // dishes included, so they get used up faster than the rest. With c composition picks and f
    // fill picks a day, a pool of T dishes needs V >= c*d / (1 - f*d/T) vegetarian ones.
    perSection('STAFF', 'STAFF_BREAKFAST', 3, {
      ruleAttrs: ['dish_concept'], spreadAttr: 'dish_concept', compositionTopupFactor: 2,
      initialGroups: (d) => [
        { count: withMargin(2 * d), fixed: { protein_code: 'VEGETARIAN' }, spread: { attr: 'dish_concept' } },
        { count: withMargin(2 * d), spread: { attr: 'dish_concept' } },
      ],
      // The 3 shared AM Snacks' types aren't known in advance, so one dish of every type, plus
      // meat-free ones of several types: any 3 free types can then be filled, one of them meat-free.
      tuesdayGroups: () => [
        { count: 6, spread: { attr: 'dish_concept', values: ENUMS.dish_concept } },
        { count: 3, fixed: { protein_code: 'VEGETARIAN' }, spread: { attr: 'dish_concept' } },
      ],
    }),
    perSection('STAFF', 'STAFF_APPETIZER', 2),
    perSection('STAFF', 'STAFF_SWEETS', 3),
    // No general fill here any more (5 shared + the 2 composition picks = 7), so one of each a day
    // plus the usual margin is enough; starch types spread so the pair can always differ.
    perSection('STAFF', 'STAFF_MAIN', 2, {
      ruleAttrs: ['protein_code', 'carb_type'], spreadAttr: 'carb_type',
      initialGroups: (d) => ['VEGAN', 'VEGETARIAN'].map((p) => ({
        count: withMargin(d), fixed: { protein_code: p }, spread: { attr: 'carb_type', values: ['RICE', 'PASTA', 'POTATO', 'OTHER'] },
      })),
      tuesdayGroups: () => ['VEGAN', 'VEGETARIAN'].map((p) => ({ count: 2, fixed: { protein_code: p }, spread: { attr: 'carb_type', values: ['RICE', 'PASTA', 'POTATO', 'OTHER'] } })),
    }),
    perSection('STAFF', 'STAFF_LUNCHBOX', 2, {
      ruleAttrs: ['protein_code'], spreadAttr: 'protein_code',
      initialGroups: (d) => [
        { count: withMargin(d), spread: { attr: 'protein_code', values: MEAT_PROTEINS } },
        { count: withMargin(d), fixed: { protein_code: 'VEGETARIAN' } },
      ],
      tuesdayGroups: () => [
        { count: 2, spread: { attr: 'protein_code', values: MEAT_PROTEINS } },
        { count: 2, fixed: { protein_code: 'VEGETARIAN' } },
      ],
    }),
  ];
}

// Every (section, AI category) must be covered by exactly one pool.
(function assertPoolsCoverAiCategories() {
  const covered = new Map();
  for (const p of poolSpecs()) for (const s of p.sections) {
    const k = `${s}:${p.category}`;
    if (covered.has(k)) throw new Error(`aiMenuGenerate: ${k} is in two pools`);
    covered.set(k, p.key);
  }
  for (const [s, cats] of Object.entries(AI_CATEGORIES)) for (const c of cats) {
    if (!covered.has(`${s}:${c}`)) throw new Error(`aiMenuGenerate: no pool for ${s} ${c}`);
  }
})();

// Splits a pool request into Edge Function calls of at most MAX_DISHES_PER_CALL dishes, cutting a
// big group across calls rather than asking for 60 dishes at once.
function planCalls(groups) {
  const calls = [];
  let current = [];
  let room = MAX_DISHES_PER_CALL;
  for (const g of groups) {
    let left = g.count;
    while (left > 0) {
      const n = Math.min(left, room);
      current.push({ ...g, count: n });
      left -= n;
      room -= n;
      if (room === 0) { calls.push(current); current = []; room = MAX_DISHES_PER_CALL; }
    }
  }
  if (current.length) calls.push(current);
  return calls;
}

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// Pages through .range() like generator.js's fetchAllRows (PostgREST caps a response at 1000 rows).
async function fetchAll(buildQuery, context) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw supaFail(context, error);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// The real Dish Catalog for every AI category: an index for findDuplicateMatch (same category
// only), the row behind each indexed name, and a few names per category as naming-style examples.
async function loadCatalog() {
  const categoryIds = [...new Set(Object.values(AI_CATEGORIES).flat())].map((c) => getCategoryByCode(c).id);
  const rows = await fetchAll(() => supabase.from('menu_items')
    .select('id, name, category_id, is_active, protein_type_id, sauce_type, carb_type, dish_concept, am_snack_style')
    .in('category_id', categoryIds).order('id'), 'aiMenuGenerate: load catalog');
  const byCategoryId = new Map();
  for (const r of rows) {
    if (!byCategoryId.has(r.category_id)) byCategoryId.set(r.category_id, { index: emptyDishIndex(), byNormalized: new Map(), activeNames: [] });
    const entry = byCategoryId.get(r.category_id);
    addNameToIndex(entry.index, r.name);
    const norm = normalizeDishName(r.name);
    // An active row wins over a retired one with the same normalized name.
    if (!entry.byNormalized.has(norm) || (r.is_active && !entry.byNormalized.get(norm).is_active)) entry.byNormalized.set(norm, r);
    if (r.is_active) entry.activeNames.push(r.name);
  }
  return {
    forCategory(code) {
      return byCategoryId.get(getCategoryByCode(code).id) || { index: emptyDishIndex(), byNormalized: new Map(), activeNames: [] };
    },
  };
}

// Names served in the 28 days before the run, per category, so the AI doesn't spend a slot on
// something the engine would reject as too recent anyway.
async function loadRecentlyServedNames(startDate) {
  const sectionIds = DRAFT_SECTION_ORDER.map((c) => getSectionByCode(c).id);
  const from = new Date(new Date(startDate).getTime() - 28 * 86400000).toISOString().slice(0, 10);
  const to = new Date(startDate).toISOString().slice(0, 10);
  const menus = await fetchAll(() => supabase.from('generated_menus').select('id').in('section_id', sectionIds).order('id'),
    'aiMenuGenerate: load generated_menus');
  const result = new Map();
  if (!menus.length) return result;
  const days = await fetchAll(() => supabase.from('menu_days').select('id')
    .in('generated_menu_id', menus.map((m) => m.id)).gte('menu_date', from).lt('menu_date', to).order('id'),
  'aiMenuGenerate: load menu_days');
  if (!days.length) return result;
  const dayItems = await fetchAll(() => supabase.from('menu_day_items').select('item_id')
    .in('menu_day_id', days.map((d) => d.id)).order('id'), 'aiMenuGenerate: load menu_day_items');
  const itemIds = [...new Set(dayItems.map((r) => r.item_id))];
  for (let i = 0; i < itemIds.length; i += 500) {
    const { data, error } = await supabase.from('menu_items').select('name, category_id').in('id', itemIds.slice(i, i + 500));
    if (error) throw supaFail('aiMenuGenerate: load recent items', error);
    for (const r of data) {
      if (!result.has(r.category_id)) result.set(r.category_id, new Set());
      result.get(r.category_id).add(r.name);
    }
  }
  return result;
}

function sample(list, n) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function requiredAttrsOf(pool) {
  return pool.requiredAttrs || REQUIRED_ATTRS[pool.category] || [];
}

// Raw AI dish -> clean dish fields, or { error } when it can't be used as-is.
function normalizeAiDish(raw, pool, proteinCodes) {
  const dish = {
    name: String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 500) || null,
    key_ingredients: (Array.isArray(raw.key_ingredients) ? raw.key_ingredients : [])
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15),
  };
  if (!dish.name) return { error: 'no name' };
  for (const attr of ATTRS) {
    const v = raw[attr] && raw[attr] !== 'NONE' ? String(raw[attr]) : null;
    const allowed = attr === 'protein_code' ? proteinCodes : ENUMS[attr];
    if (v && !allowed.includes(v)) return { error: `invalid ${attr} ${v}` };
    dish[attr] = v;
  }
  for (const attr of requiredAttrsOf(pool)) {
    if (!dish[attr]) return { error: `missing ${attr}` };
  }
  return { dish };
}

function catalogProteinCode(item) {
  const p = item.protein_type_id ? getProteinById(item.protein_type_id) : null;
  return p ? p.code : null;
}

// The generate-menu-dishes request body for one pool (also used by the review screen's "Ask AI").
function buildDishRequest(pool, groups, proteinCodes, avoidNames, styleExamples, cuisine = null) {
  const student = pool.sections.some(isStudentSection);
  const category = getCategoryByCode(pool.category);
  return {
    category: { code: pool.category, label: category.name || pool.category, guidance: pool.guidance || GUIDANCE[pool.category] },
    audience: pool.audience,
    seafoodAllowed: !student,
    proteinCodes: proteinCodes.filter((c) => (student ? c !== 'FISH' : true)),
    requiredAttrs: requiredAttrsOf(pool),
    groups: groups.map((g) => ({
      count: g.count,
      ...(g.cuisine ? { cuisine: g.cuisine } : {}),
      ...(g.fixed ? { fixed: g.fixed } : {}),
      ...(g.spread ? { spread: { attr: g.spread.attr, ...(g.spread.values ? { values: g.spread.values.filter((v) => g.spread.attr !== 'protein_code' || proteinCodes.includes(v)) } : {}) } } : {}),
    })),
    avoidNames: avoidNames.slice(0, 400),
    styleExamples,
    ...(cuisine ? { cuisine } : {}),
  };
}

class DraftRun {
  constructor({ startDate, numWeekdays, onProgress }) {
    this.startDate = startDate;
    this.numWeekdays = numWeekdays;
    this.onProgress = onProgress || (() => {});
    this.proteinCodes = getProteinTypes().map((p) => p.code);
    this.pools = poolSpecs();
    this.poolByKey = new Map(this.pools.map((p) => [p.key, p]));
    this.poolBySectionCategory = new Map();
    for (const p of this.pools) {
      p.items = [];
      for (const s of p.sections) this.poolBySectionCategory.set(`${s}:${p.category}`, p);
    }
    this.dishes = new Map();          // tempId -> dish record
    this.runIndex = new Map();        // category -> { index, byNormalized: norm -> tempId }
    this.nextTempId = 1;
    this.warnings = [];
    this.dropped = new Map();         // pool.key -> { invalid, duplicate }
    this.stats = { aiCalls: 0, aiFailures: 0, returned: 0, rejectedSafety: 0, droppedInvalid: 0, droppedDuplicate: 0, linked: 0, created: 0, rounds: 0 };
  }

  async load() {
    this.onProgress('Loading the Dish Catalog and recent menus...');
    [this.catalog, this.recentByCategoryId] = await Promise.all([loadCatalog(), loadRecentlyServedNames(this.startDate)]);
  }

  _drop(pool, kind) {
    const d = this.dropped.get(pool.key) || { invalid: 0, duplicate: 0 };
    d[kind]++;
    this.dropped.set(pool.key, d);
  }

  _runIndexFor(category) {
    if (!this.runIndex.has(category)) this.runIndex.set(category, { index: emptyDishIndex(), byNormalized: new Map() });
    return this.runIndex.get(category);
  }

  // One AI dish through every gate, into the pool (or not).
  // `cuisine`: the National Day cuisine this call was made for (null for regular dishes).
  accept(raw, pool, cuisine = null) {
    this.stats.returned++;
    const { dish, error } = normalizeAiDish(raw, pool, this.proteinCodes);
    if (error) { this.stats.droppedInvalid++; this._drop(pool, 'invalid'); return; }

    const safety = checkDishSafety({ ...dish, category_code: pool.category, section_codes: pool.sections });
    if (!safety.ok) {
      this.stats.rejectedSafety++;
      this.warnings.push({ kind: 'safety', sections: pool.sections, category: pool.category, name: dish.name, key_ingredients: dish.key_ingredients, reason: safety.reason, hits: safety.hits });
      return;
    }

    // Catalog duplicate check, same category only.
    const cat = this.catalog.forCategory(pool.category);
    const match = findDuplicateMatch(dish.name, cat.index);
    let linkedItem = null;
    let matchType = null;
    if (match) {
      const item = cat.byNormalized.get(normalizeDishName(match.matchedName));
      if (item && !item.is_active) {
        this.warnings.push({ kind: 'duplicate_retired', sections: pool.sections, category: pool.category, name: dish.name, matched_item_id: item.id, matched_name: item.name });
        this._drop(pool, 'duplicate');
        this.stats.droppedDuplicate++;
        return;
      }
      if (item) { linkedItem = item; matchType = match.matchType; }
    }
    const finalName = linkedItem ? linkedItem.name : dish.name;

    // Same dish already in this run (from another call or another section's pool)?
    const run = this._runIndexFor(pool.category);
    const runMatch = findDuplicateMatch(finalName, run.index);
    if (runMatch) {
      const existing = this.dishes.get(run.byNormalized.get(normalizeDishName(runMatch.matchedName)));
      const inPool = pool.items.some((it) => it.draftDishId === existing.tempId);
      // A themed dish is kept for its own Tuesday, so it is never shared with a regular slot (or
      // another cuisine's Tuesday) -- the duplicate is simply dropped.
      if ((existing.cuisine || null) !== (cuisine || null)) {
        this.stats.droppedDuplicate++;
        this._drop(pool, 'duplicate');
        return;
      }
      const union = [...new Set([...existing.section_codes, ...pool.sections])];
      if (inPool || !checkDishSafety({ ...existing, section_codes: union }).ok) {
        this.stats.droppedDuplicate++;
        this._drop(pool, 'duplicate');
        return;
      }
      existing.section_codes = union;
      pool.items.push(this._poolItem(existing));
      return;
    }

    const record = {
      tempId: `n${this.nextTempId++}`,
      name: finalName,
      category_code: pool.category,
      section_codes: [...pool.sections],
      description: dish.description,
      key_ingredients: dish.key_ingredients,
      resolution: linkedItem ? 'link' : 'new',
      dup_match_item_id: linkedItem ? linkedItem.id : null,
      dup_match_type: matchType,
      ai_name: dish.name,
      known_risk: safety.knownRisk,
      cuisine: cuisine || null,
    };
    // A linked dish is scheduled on the catalog item's own attributes (that is what will be
    // served); the AI's values only fill gaps the catalog row leaves empty.
    for (const attr of ATTRS) {
      const catalogValue = linkedItem ? (attr === 'protein_code' ? catalogProteinCode(linkedItem) : linkedItem[attr]) : null;
      record[attr] = catalogValue || dish[attr];
    }
    record.safety_scan = safetyScanRecord({ ...record }, checkDishSafety(record));
    if (linkedItem) this.stats.linked++; else this.stats.created++;

    this.dishes.set(record.tempId, record);
    addNameToIndex(run.index, finalName);
    run.byNormalized.set(normalizeDishName(finalName), record.tempId);
    pool.items.push(this._poolItem(record));
  }

  _poolItem(record) {
    return draftDishToPoolItem({ ...record, id: record.tempId });
  }

  _avoidNames(pool) {
    const recent = this.recentByCategoryId.get(getCategoryByCode(pool.category).id) || new Set();
    // This run's own names first (those matter most), capped under the Edge Function's list limit.
    return [...new Set([...pool.items.map((i) => i.name), ...recent])].slice(0, 400);
  }

  // Each group may carry a National Day cuisine; a pool's regular and Tuesday dishes share calls.
  async _generateForPool(pool, groups) {
    const styleExamples = sample(this.catalog.forCategory(pool.category).activeNames, 25);
    for (const callGroups of planCalls(groups)) {
      this.stats.aiCalls++;
      const request = buildDishRequest(pool, callGroups, this.proteinCodes, this._avoidNames(pool), styleExamples);
      let dishes;
      try {
        dishes = await generateMenuDishes(request);
      } catch (err) {
        this.stats.aiFailures++;
        this.warnings.push({ kind: 'ai_error', sections: pool.sections, category: pool.category, message: err.message });
        continue;
      }
      for (const raw of dishes) {
        // The dish must come back in a real group and say the same cuisine as that group asked for
        // (NONE for regular), so a regular dish is never mistaken for a National Day one.
        const group = Number.isInteger(raw.group) ? callGroups[raw.group] : null;
        const want = (group && group.cuisine) || null;
        const said = raw.cuisine && raw.cuisine !== 'NONE' ? raw.cuisine : null;
        if (!group || said !== want) { this.stats.returned++; this.stats.droppedInvalid++; this._drop(pool, 'invalid'); continue; }
        this.accept(raw, pool, want);
      }
    }
  }

  async generatePools(requests, label) {
    const entries = [...requests.entries()].filter(([, groups]) => groups.length);
    let done = 0;
    const tasks = entries.map(([key, groups]) => async () => {
      await this._generateForPool(this.poolByKey.get(key), groups);
      done++;
      this.onProgress(`${label}: ${done} of ${entries.length} dish lists done...`);
    });
    this.onProgress(`${label}: asking the AI for ${entries.reduce((n, [, g]) => n + g.reduce((m, x) => m + x.count, 0), 0)} dishes across ${entries.length} lists...`);
    await runLimited(tasks, AI_CONCURRENCY);
  }

  draftPools() {
    const out = {};
    for (const p of this.pools) for (const s of p.sections) {
      (out[s] = out[s] || {})[p.category] = p.items;
    }
    return out;
  }

  async schedule() {
    return computeDraftMenus({ startDate: this.startDate, numWeekdays: this.numWeekdays, draftPools: this.draftPools() });
  }

  // Reads the engine's result back into "this pool needs N more dishes with these attributes".
  // Returns { requests: Map(poolKey -> groups), leftover: [{ section, message }] } -- leftover is
  // every problem in THIS schedule, whether or not a top-up was requested for it.
  analyzeShortfalls(out) {
    const needs = new Map(); // poolKey -> Map(sigJson -> count)
    const leftover = [];
    const itemById = new Map();
    for (const p of this.pools) for (const it of p.items) itemById.set(it.id, it);
    const codeOf = (it, attr) => (attr === 'protein_code' ? (it.protein_type_id ? getProteinById(it.protein_type_id)?.code : null) : it[attr]);
    // A shortfall on a National Day Tuesday is topped up with that Tuesday's cuisine.
    const need = (pool, sig, n = 1, date = null) => {
      const key = `${pool.key}|${(date && cuisineForDate(date)) || ''}`;
      if (!needs.has(key)) needs.set(key, new Map());
      const m = needs.get(key);
      const k = JSON.stringify(sig);
      m.set(k, (m.get(k) || 0) + n);
    };
    // The attribute value this pool has fewest dishes of, among `values` minus `exclude`.
    const scarcest = (pool, attr, values, exclude = new Set()) => {
      const options = values.filter((v) => !exclude.has(v));
      if (!options.length) return null;
      const count = (v) => pool.items.filter((it) => codeOf(it, attr) === v).length;
      return options.reduce((best, v) => (count(v) < count(best) ? v : best), options[0]);
    };

    const REUSE = /^(\w+) (\d{4}-\d{2}-\d{2}): '(.*)' reused after only \d+ days/;
    const SAME_PROTEIN = /^(\w+) (\d{4}-\d{2}-\d{2}): '(.*)' has the same protein as the previous school day for (\w+)/;
    const COMPOSITION = /^(\w+) (\S+): could not satisfy composition rule \[([\w/]+)\] x(\d+) for (\w+)/;
    const STYLE = /^(\w+) (\S+): no (PASTRY|COLD_KITCHEN) AM Snack items available/;
    const NOT_HONORED = /^(\w+) (\S+): National Day \(\w+\) not honored for (\w+): used regular dish '(.*)'/;

    for (const [sectionCode, { resultDays, warnings }] of Object.entries(out)) {
      const dayByDate = new Map(resultDays.map((d) => [d.date, d]));
      for (const w of warnings) {
        // Every engine warning is reported (the last round's are what the chef sees); the ones
        // below are also turned into a top-up request.
        leftover.push({ section: sectionCode, message: w });
        let m;
        if ((m = REUSE.exec(w))) {
          const day = dayByDate.get(m[2]);
          const pick = day && day.items.find((i) => i.name === m[3] && isAiCategory(sectionCode, i.category));
          const pool = pick && this.poolBySectionCategory.get(`${sectionCode}:${pick.category}`);
          const item = pick && itemById.get(pick.id);
          if (pool && item) {
            const sig = {};
            for (const a of pool.ruleAttrs) { const v = codeOf(item, a); if (v) sig[a] = v; }
            need(pool, sig, 1, m[2]);
            continue;
          }
        } else if ((m = COMPOSITION.exec(w))) {
          const pool = this.poolBySectionCategory.get(`${sectionCode}:${m[5]}`);
          if (pool) {
            const proteins = m[3].split('/').filter((c) => this.proteinCodes.includes(c));
            const protein = proteins.length === 1 ? proteins[0] : scarcest(pool, 'protein_code', proteins);
            if (protein) {
              // The engine applies the slot's distinct-attribute rule inside the composition step
              // too, so a vegetarian breakfast whose concept clashes with that day's shared AM
              // Snacks is refused. Ask for one with a concept that is still free that day.
              const sig = { protein_code: protein };
              const slot = SECTION_SLOTS[sectionCode].find(([c]) => c === m[5]);
              const attr = slot && slot[2].distinctAttr;
              const day = dayByDate.get(m[2]);
              if (attr && day) {
                const usedValues = new Set(day.items.filter((i) => i.category === m[5])
                  .map((i) => codeOf(itemById.get(i.id) || {}, attr)).filter(Boolean));
                const value = scarcest(pool, attr, ENUMS[attr], usedValues);
                if (value) sig[attr] = value;
              }
              need(pool, sig, (Number(m[4]) || 1) * (pool.compositionTopupFactor || 1), m[2]);
              continue;
            }
          }
        } else if ((m = SAME_PROTEIN.exec(w))) {
          // Daycare's no-consecutive-protein rule ran out of dishes with another protein that day.
          const pool = this.poolBySectionCategory.get(`${sectionCode}:${m[4]}`);
          const day = dayByDate.get(m[2]);
          const pick = pool && day && day.items.find((i) => i.name === m[3] && i.category === m[4]);
          const item = pick && itemById.get(pick.id);
          if (pool && item) {
            const values = ['CHICKEN', 'BEEF', 'LAMB'].filter((c) => this.proteinCodes.includes(c));
            const protein = scarcest(pool, 'protein_code', values, new Set([codeOf(item, 'protein_code')]));
            if (protein) { need(pool, { protein_code: protein }, 2, m[2]); continue; }
          }
        } else if ((m = STYLE.exec(w))) {
          const pool = this.poolBySectionCategory.get(`${sectionCode}:AM_SNACK`);
          if (pool) { need(pool, { am_snack_style: m[3] }, 1, m[2]); continue; }
        } else if ((m = NOT_HONORED.exec(w))) {
          // A regular dish stood in for a themed one: order a themed dish with the same rule attributes.
          const pool = this.poolBySectionCategory.get(`${sectionCode}:${m[3]}`);
          const day = dayByDate.get(m[2]);
          const pick = pool && day && day.items.find((i) => i.name === m[4] && i.category === m[3]);
          const item = pick && itemById.get(pick.id);
          if (pool) {
            const sig = {};
            if (item) for (const a of pool.ruleAttrs) { const v = codeOf(item, a); if (v) sig[a] = v; }
            need(pool, sig, 1, m[2]);
            continue;
          }
        }
      }

      // Slots the engine couldn't fill at all (an empty or exhausted pool raises no warning).
      for (const [category, count] of SECTION_SLOTS[sectionCode]) {
        if (!isAiCategory(sectionCode, category)) continue;
        const pool = this.poolBySectionCategory.get(`${sectionCode}:${category}`);
        for (const day of resultDays) {
          const short = count - day.items.filter((i) => i.category === category).length;
          if (short > 0) {
            need(pool, {}, short, day.date);
            leftover.push({ section: sectionCode, message: `${sectionCode} ${day.date}: ${category} has ${short} empty slot(s)` });
          }
        }
      }

      // Distinct-attribute clashes the engine fills without a warning (its "fill regardless" step):
      // two of a section's OWN picks sharing a sauce / carb / concept, or an own pick repeating a
      // shared dish's value (Staff Breakfast vs the school AM Snacks). MS-UP's coupled picks are
      // copies of KG-LP's, so they are checked once, on KG-LP.
      for (const [category, , options] of SECTION_SLOTS[sectionCode]) {
        const attr = options.distinctAttr;
        if (!attr || !isAiCategory(sectionCode, category)) continue;
        if (sectionCode === 'MS_UP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(category)) continue;
        const pool = this.poolBySectionCategory.get(`${sectionCode}:${category}`);
        for (const day of resultDays) {
          const forcedIds = new Set();
          const shared = (s, cats) => {
            const d = out[s] && out[s].resultDays.find((x) => x.date === day.date);
            for (const it of (d ? d.items.filter((i) => cats.includes(i.category)) : [])) forcedIds.add(it.id);
          };
          if (sectionCode === 'STAFF' && category === 'STAFF_BREAKFAST') for (const s of ['DAYCARE', 'KG_LP', 'MS_UP']) shared(s, ['AM_SNACK']);
          if (sectionCode === 'STAFF' && category === 'STAFF_MAIN') { shared('KG_LP', ['LUNCH_MAIN', 'LUNCH_STARCH']); shared('MS_UP', ['LUNCH_VEGETABLE']); }
          const picks = day.items.filter((i) => i.category === category);
          const used = new Set();
          // Shared picks count against the rule unless the slot says only its own picks must differ.
          if (!options.distinctAmongOwnOnly) {
            for (const p of picks.filter((i) => forcedIds.has(i.id))) {
              const v = codeOf(itemById.get(p.id) || {}, attr);
              if (v) used.add(v);
            }
          }
          for (const p of picks.filter((i) => !forcedIds.has(i.id))) {
            const v = codeOf(itemById.get(p.id) || {}, attr);
            if (v && used.has(v)) {
              const allOwn = new Set(picks.map((i) => codeOf(itemById.get(i.id) || {}, attr)).filter(Boolean));
              const value = scarcest(pool, attr, ENUMS[attr], allOwn);
              // If the clashing dish was there for a composition rule (e.g. Staff Breakfast's meat-free
              // dish), the replacement must satisfy that rule too, or it can never take the slot.
              const protein = codeOf(itemById.get(p.id) || {}, 'protein_code');
              const forRule = (options.composition || []).some((r) => (r.proteins || []).includes(protein));
              if (value) need(pool, { [attr]: value, ...(forRule ? { protein_code: protein } : {}) }, 1, day.date);
              leftover.push({ section: sectionCode, message: `${sectionCode} ${day.date}: two ${category} picks share ${attr} ${v}` });
            }
            if (v) used.add(v);
          }
        }
      }
    }

    // Requests are per pool (regular and Tuesday groups together); each group keeps its cuisine.
    const requests = new Map();
    for (const [key, sigs] of needs) {
      const [poolKey, cuisine] = key.split('|');
      const pool = this.poolByKey.get(poolKey);
      const cap = cuisine ? Math.max(pool.perDay * 3, 6) : Math.min(this.numWeekdays, NO_REPEAT_SCHOOL_DAYS) * pool.perDay;
      let total = 0;
      const groups = [];
      for (const [sigJson, n] of sigs) {
        const fixed = JSON.parse(sigJson);
        const count = Math.min(Math.ceil(n * TOPUP_FACTOR), cap - total);
        if (count <= 0) break;
        total += count;
        const spreadAttr = pool.spreadAttr && !fixed[pool.spreadAttr] ? pool.spreadAttr : null;
        groups.push({ count, ...(cuisine ? { cuisine } : {}), ...(Object.keys(fixed).length ? { fixed } : {}), ...(spreadAttr ? { spread: { attr: spreadAttr } } : {}) });
      }
      requests.set(poolKey, [...(requests.get(poolKey) || []), ...groups]);
    }
    return { requests, leftover };
  }
}

// The saved shape: one ai_menu_draft_picks row per slot per day per section.
function buildPickRows(runId, out, dbIdByTempId) {
  const rows = [];
  const dayOf = (section, date) => out[section] && out[section].resultDays.find((d) => d.date === date);
  const idsIn = (section, date, category) => new Set((dayOf(section, date)?.items || []).filter((i) => i.category === category).map((i) => i.id));
  for (const section of DRAFT_SECTION_ORDER) {
    for (const day of out[section].resultDays) {
      const slotIndex = new Map();
      for (const it of day.items) {
        const idx = slotIndex.get(it.category) || 0;
        slotIndex.set(it.category, idx + 1);
        let source = null;
        if (section === 'MS_UP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(it.category)) {
          if (idsIn('KG_LP', day.date, it.category).has(it.id)) source = 'KG_LP';
        } else if (section === 'STAFF' && it.category === 'STAFF_MAIN') {
          if (idsIn('KG_LP', day.date, 'LUNCH_MAIN').has(it.id) || idsIn('KG_LP', day.date, 'LUNCH_STARCH').has(it.id)) source = 'KG_LP';
          else if (idsIn('MS_UP', day.date, 'LUNCH_VEGETABLE').has(it.id)) source = 'MS_UP';
        } else if (section === 'STAFF' && it.category === 'STAFF_BREAKFAST') {
          source = ['DAYCARE', 'KG_LP', 'MS_UP'].find((s) => idsIn(s, day.date, 'AM_SNACK').has(it.id)) || null;
        }
        const draftDishId = it.draftDishId ? dbIdByTempId.get(it.draftDishId) : null;
        if (it.draftDishId && !draftDishId) throw new Error(`aiMenuGenerate: pick ${it.name} lost its draft dish`);
        rows.push({
          run_id: runId, section_code: section, menu_date: day.date, weekday: day.weekday,
          category_code: it.category, slot_index: idx,
          draft_dish_id: draftDishId || null,
          item_id: draftDishId ? null : (typeof it.id === 'number' ? it.id : null),
          source_section_code: source,
        });
      }
      // An unfilled slot is saved as an explicit empty row (both ids null), which blocks Approve.
      for (const [category, count] of SECTION_SLOTS[section]) {
        for (let idx = slotIndex.get(category) || 0; idx < count; idx++) {
          rows.push({
            run_id: runId, section_code: section, menu_date: day.date, weekday: day.weekday,
            category_code: category, slot_index: idx, draft_dish_id: null, item_id: null, source_section_code: null,
          });
        }
      }
    }
  }
  return rows;
}

async function insertChunked(table, rows, size, select) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    let q = supabase.from(table).insert(rows.slice(i, i + size));
    if (select) q = q.select(select);
    const { data, error } = await q;
    if (error) throw supaFail(`aiMenuGenerate: insert ${table}`, error);
    if (data) out.push(...data);
  }
  return out;
}

// Entry point (main.js ai-menu-generate). Returns { runId, stats, warningCount }.
async function generateDraftRun({ label, startDate, endDate, createdBy, onProgress }) {
  const numWeekdays = schoolDayCountBetween(startDate, endDate);
  if (numWeekdays < 1) throw new Error('The date range has no school days (Sunday to Thursday) in it.');
  const days = schoolDaysFrom(new Date(startDate), numWeekdays);

  const { data: runRow, error: runErr } = await supabase.from('ai_menu_runs').insert({
    label: (label || '').trim() || `AI menu ${days[0].date} to ${days[days.length - 1].date}`,
    created_by: createdBy || null,
    start_date: days[0].date,
    end_date: days[days.length - 1].date,
    num_weekdays: numWeekdays,
    status: 'generating',
  }).select('id').single();
  if (runErr) throw supaFail('aiMenuGenerate: create run', runErr);
  const runId = runRow.id;

  const run = new DraftRun({ startDate: days[0].date, numWeekdays, onProgress });
  try {
    await run.load();
    // Regular dishes cover the non-Tuesday days; each Tuesday gets its own National Day order
    // (tuesdayGroups), in that Tuesday's cuisine, generated to exactly what its rules need.
    const tuesdays = days.map((day, i) => ({ ...day, index: i + 1, cuisine: cuisineForDate(day.date) })).filter((t) => t.cuisine);
    const d = Math.min(numWeekdays - tuesdays.length, NO_REPEAT_REGULAR_DAYS);
    const initial = new Map(run.pools.map((p) => [p.key, d > 0 ? p.initialGroups(d) : []]));
    for (const t of tuesdays) {
      const style = AM_SNACK_STYLE_BY_PATTERN[t.index % 2 === 1 ? 'A' : 'B'];
      for (const p of run.pools) initial.get(p.key).push(...p.tuesdayGroups({ style }).map((g) => ({ ...g, cuisine: t.cuisine })));
    }
    run.stats.nationalDays = tuesdays.map((t) => `${t.date} ${t.cuisine}`);
    await run.generatePools(initial, 'Inventing dishes');

    let out;
    let leftover = [];
    for (let round = 0; ; round++) {
      onProgress && onProgress('Building the menu from the dishes...');
      out = await run.schedule();
      run.stats.rounds = round + 1;
      const analysis = run.analyzeShortfalls(out);
      leftover = analysis.leftover;
      if (!analysis.requests.size || round >= MAX_TOPUP_ROUNDS) break;
      await run.generatePools(analysis.requests, `Top-up ${round + 1}`);
    }

    onProgress && onProgress('Saving the draft...');
    // A dish's sections = its pool's sections plus wherever it was actually served (Staff's shared
    // Main and Breakfast picks are school dishes).
    for (const section of DRAFT_SECTION_ORDER) for (const day of out[section].resultDays) for (const it of day.items) {
      const rec = it.draftDishId && run.dishes.get(it.draftDishId);
      if (rec && !rec.section_codes.includes(section)) rec.section_codes.push(section);
    }
    const records = [...run.dishes.values()];
    const inserted = await insertChunked('ai_menu_draft_dishes', records.map((r) => ({
      run_id: runId, name: r.name, category_code: r.category_code, section_codes: r.section_codes,
      protein_code: r.protein_code, sauce_type: r.sauce_type, carb_type: r.carb_type, dish_concept: r.dish_concept,
      am_snack_style: r.am_snack_style, description: r.description, key_ingredients: r.key_ingredients,
      safety_scan: { ...r.safety_scan, ai_name: r.ai_name },
      dup_match_item_id: r.dup_match_item_id, dup_match_type: r.dup_match_type, resolution: r.resolution,
      cuisine: r.cuisine || null,
    })), 200, 'id, category_code, name');
    const dbIdByKey = new Map(inserted.map((row) => [`${row.category_code}|${normalizeDishName(row.name)}`, row.id]));
    const dbIdByTempId = new Map(records.map((r) => [r.tempId, dbIdByKey.get(`${r.category_code}|${normalizeDishName(r.name)}`)]));
    await insertChunked('ai_menu_draft_picks', buildPickRows(runId, out, dbIdByTempId), 500, null);

    for (const [key, d2] of run.dropped) {
      if (d2.invalid) run.warnings.push({ kind: 'ai_invalid', pool: key, message: `${d2.invalid} AI dish(es) for ${key} came back without the attributes the menu rules need and were dropped` });
    }
    const warnings = [...run.warnings, ...leftover.map((l) => ({ kind: 'rule', section: l.section, message: l.message }))];
    const { error: finErr } = await supabase.from('ai_menu_runs').update({ status: 'draft', warnings }).eq('id', runId);
    if (finErr) throw supaFail('aiMenuGenerate: finish run', finErr);

    return { runId, numWeekdays, stats: { ...run.stats, dishes: records.length }, warningCount: warnings.length };
  } catch (err) {
    // Left in 'generating' (the migration's "crashed mid-way" state) with the reason attached.
    await supabase.from('ai_menu_runs').update({
      warnings: [...run.warnings, { kind: 'error', message: err.message }],
    }).eq('id', runId);
    throw err;
  }
}

module.exports = {
  generateDraftRun, poolSpecs, planCalls, DraftRun, buildPickRows, normalizeAiDish, buildDishRequest, loadCatalog, sample,
  ATTRS, ENUMS, REQUIRED_ATTRS, requiredAttrsOf,
};
