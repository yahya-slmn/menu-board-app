const { supabase, supaFail } = require('./supabaseClient');
const { getCategoryByCode, getCategoryById, getSectionByCode, getProteinByCode, getProteinById, getAgeGroupsForSection } = require('./referenceData');
const { snackLunchOnlyHit } = require('./categoryRules');

const NO_REPEAT_DAYS = 28;

// Slot format: [categoryCode, count, options]
// options: { distinctProtein, distinctAttr: 'sauce_type'|'carb_type'|'dish_concept',
//            composition: [ { proteins: ['CHICKEN'], count: 1 }, ... ] }
// composition entries are satisfied FIRST (in order), then remaining picks fill the slot.
const SECTION_SLOTS = {
  DAYCARE: [
    ['MILK', 1, {}], ['AM_SNACK', 1, {}], ['LUNCH_BREAD', 1, {}],
    // Daycare's vegetable-side slot moved to its own split-out category (LUNCH_SALAD,
    // id 37, "Lunch SALAD Side") -- LUNCH_VEGETABLE stayed MS-UP-only after the split.
    // One combined dish (protein + starch) -- never the same protein two school days running,
    // counting the last saved school day before the run (noConsecutiveProtein).
    ['LUNCH_MAIN', 1, { noConsecutiveProtein: true }], ['LUNCH_SALAD', 1, {}],
    ['SOUP_APPETIZER', 1, {}], ['JUICE', 1, {}],
    ['FRUIT_BAR', 1, {}], ['PM_SNACK', 1, {}],
  ],
  KG_LP: [
    ['FRUIT_BASKET', 1, {}], ['AM_SNACK', 1, {}], ['MILK', 1, {}],
    ['LUNCH_BREAD', 1, {}],
    // strictly one chicken + one beef, with different sauce styles
    ['LUNCH_MAIN', 2, {
      composition: [{ proteins: ['CHICKEN'], count: 1 }, { proteins: ['BEEF'], count: 1 }],
      distinctAttr: 'sauce_type',
    }],
    ['LUNCH_STARCH', 2, { distinctAttr: 'carb_type' }],
    ['SALAD_BAR', 1, {}], ['FRUIT_BAR', 1, {}],
    ['SOUP_APPETIZER', 1, {}], ['JUICE', 1, {}], ['PM_SNACK', 1, {}],
  ],
  MS_UP: [
    ['FRUIT_BASKET', 1, {}], ['AM_SNACK', 1, {}], ['MILK', 1, {}],
    ['LUNCH_BREAD', 1, {}],
    // strictly one chicken + one beef, with different sauce styles
    ['LUNCH_MAIN', 2, {
      composition: [{ proteins: ['CHICKEN'], count: 1 }, { proteins: ['BEEF'], count: 1 }],
      distinctAttr: 'sauce_type',
    }],
    ['LUNCH_VEGETABLE', 1, {}],
    ['LUNCH_STARCH', 2, { distinctAttr: 'carb_type' }],
    ['SALAD_BAR', 1, {}], ['FRUIT_BAR', 1, {}],
    ['SOUP_APPETIZER', 1, {}], ['JUICE', 1, {}], ['PM_SNACK', 1, {}],
  ],
  STAFF: [
    // 6 breakfast dishes (incl. 1 meat-free -- vegan or vegetarian, varied concepts, 3 Pastry + 3 Cold
    // Kitchen), THEN the juice pick
    ['STAFF_BREAKFAST', 6, {
      distinctAttr: 'dish_concept',
      composition: [{ proteins: ['VEGAN', 'VEGETARIAN'], count: 1 }],
      // 3 Pastry + 3 Cold Kitchen across all six, the two shared school AM Snacks included (they are
      // always one of each), so Staff's own four are 2 + 2 (2026-09-24).
      styleMix: { PASTRY: 3, COLD_KITCHEN: 3 },
    }],
    ['STAFF_BREAKFAST_JUICE', 1, {}],
    ['STAFF_APPETIZER', 2, {}], ['STAFF_SALAD', 5, {}],
    // Exactly 7 (confirmed 2026-09-23): 5 shared -- KG-LP/MS-UP's 2 Lunch Mains + 2 Lunch Starches
    // and MS-UP's Lunch Vegetable (STAFF_MAIN_SHARES) -- then Staff's own 1 vegan + 1 vegetarian,
    // which must differ in starch type. distinctAmongOwnOnly: the shared starches don't count
    // against the pair (only the pair must differ from each other).
    ['STAFF_MAIN', 7, {
      composition: [{ proteins: ['VEGAN'], count: 1 }, { proteins: ['VEGETARIAN'], count: 1 }],
      distinctAttr: 'carb_type',
      distinctAmongOwnOnly: true,
    }],
    ['STAFF_SWEETS', 3, {}], ['STAFF_BREAD', 3, {}],
    // Three FIXED beverages, the same every day (replacing the rotating STAFF_JUICE pick): each
    // category's daily-repeating item, never a rotating pick (fixedDaily). Staff Fruit Basket was
    // removed from Staff lunch 2026-09-24 (the category stays for menus saved before that).
    ['STAFF_WATER', 1, { fixedDaily: true }], ['STAFF_SOFT_DRINK', 1, { fixedDaily: true }], ['STAFF_FRESH_JUICE', 1, { fixedDaily: true }],
    // lunch box: 1 meat protein (turkey included, 2026-09-24) + 1 meat-free (vegan or vegetarian), then 1
    // salad from its own pool
    ['STAFF_LUNCHBOX', 2, {
      composition: [
        { proteins: ['CHICKEN', 'BEEF', 'LAMB', 'FISH', 'TURKEY'], count: 1 },
        { proteins: ['VEGAN', 'VEGETARIAN'], count: 1 },
      ],
    }],
    ['STAFF_LUNCHBOX_SALAD', 1, {}],
  ],
  CEO: [
    ['CEO_BREAKFAST_MAIN', 1, {}], ['CEO_RAW_VEG', 1, {}], ['CEO_BREAKFAST_JUICE', 1, {}],
    ['CEO_YOGURT', 1, {}], ['CEO_LUNCH_MAIN', 1, {}], ['CEO_SALAD', 1, {}],
    ['CEO_LUNCH_JUICE', 1, {}], ['CEO_FRUITS', 1, {}], ['CEO_BREAD', 1, {}],
  ],
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHOOL_WEEKDAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']);

// Sections that serve IDENTICAL picks in some categories. Whichever of the pair is generated second
// (for the same date range) copies the first one's picks; generated fresh, the pick comes from the
// dishes BOTH catalogs have, scored against both sections' history.
// - KG-LP / MS-UP: Lunch Main and Lunch Starch (Daycare has its own combined main).
// - Daycare / KG-LP: AM Snack and PM Snack (2026-09-24; MS-UP keeps its own snacks).
// KG-LP is in both pairs, so a section can have a different partner per category.
const SECTION_COUPLINGS = [
  { sections: ['KG_LP', 'MS_UP'], categories: ['LUNCH_MAIN', 'LUNCH_STARCH'] },
  { sections: ['DAYCARE', 'KG_LP'], categories: ['AM_SNACK', 'PM_SNACK'] },
];
const COUPLED_LUNCH_CATEGORIES = SECTION_COUPLINGS[0].categories;
// { categoryCode: partnerSectionCode } for this section's shared categories.
function couplingPartners(sectionCode) {
  const out = {};
  for (const { sections, categories } of SECTION_COUPLINGS) {
    if (!sections.includes(sectionCode)) continue;
    const partner = sections.find(x => x !== sectionCode);
    for (const c of categories) out[c] = partner;
  }
  return out;
}

// Staff's STAFF_MAIN slot (7 choices) always carries these shared picks from the same day,
// verbatim (confirmed 2026-09-23): KG-LP/MS-UP's Lunch Main pair and Lunch Starch pair (the two
// sections are forced identical, so whichever has a saved menu for the exact date range is used)
// and MS-UP's own Lunch Vegetable. The remaining 2 are Staff's own vegan + vegetarian (SECTION_SLOTS).
// Daycare's Lunch Main is no longer shared into Staff Main (it became one combined dish).
const STAFF_MAIN_SOURCE_SECTIONS = ['KG_LP', 'MS_UP'];
const STAFF_MAIN_SHARED_CATEGORIES = ['LUNCH_MAIN', 'LUNCH_STARCH'];
const STAFF_MAIN_VEGETABLE_SECTION = 'MS_UP';
const STAFF_MAIN_VEGETABLE_CATEGORY = 'LUNCH_VEGETABLE';

// Staff's STAFF_BREAKFAST slot (6 choices) always carries that day's school AM Snacks: since
// 2026-09-24 that is TWO distinct dishes -- the shared Daycare / KG-LP one (either section: they are
// identical, Daycare first) and MS-UP's own. They are always one Pastry + one Cold Kitchen (see
// SNACK_STYLE_BY_PATTERN), and the slot's styleMix makes the whole six 3 Pastry + 3 Cold Kitchen, so
// Staff's own four are 2 + 2. The existing rules still hold: 1 meat-free among the 6 (composition),
// different dish concepts.
const STAFF_BREAKFAST_SOURCE_GROUPS = [['DAYCARE', 'KG_LP'], ['MS_UP']];
const STAFF_BREAKFAST_SOURCE_SECTIONS = STAFF_BREAKFAST_SOURCE_GROUPS.flat();
const STAFF_BREAKFAST_SOURCE_CATEGORY = 'AM_SNACK';

// Pastry / Cold Kitchen rotation for the four daily snack cells (Daycare/KG-LP share one AM and one
// PM Snack, MS-UP has its own of each). One flip per school day, Pattern A on the first school day of
// each generation run (resets per run, not pinned to a fixed calendar epoch -- confirmed with the
// chef: simplicity over cross-run continuity). Within a day: Daycare/KG-LP's AM and MS-UP's AM are
// opposite, the two PMs are opposite, and Daycare/KG-LP's own AM and PM are opposite -- so every day
// is exactly 2 Pastry + 2 Cold Kitchen. AM Snack keeps exactly the pattern it had before PM Snack
// joined (2026-09-24). `am_snack_style` is a nullable menu_items column ('PASTRY'/'COLD_KITCHEN'),
// despite its name also used for PM Snack and Staff Breakfast; AI-estimated (estimate-am-snack-style
// Edge Function / main.js's estimate-missing-am-snack-styles), manually correctable in Edit Item.
const SNACK_ROTATION_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];
const SNACK_STYLE_BY_PATTERN = {
  A: {
    AM_SNACK: { DAYCARE: 'PASTRY', KG_LP: 'PASTRY', MS_UP: 'COLD_KITCHEN' },
    PM_SNACK: { DAYCARE: 'COLD_KITCHEN', KG_LP: 'COLD_KITCHEN', MS_UP: 'PASTRY' },
  },
  B: {
    AM_SNACK: { DAYCARE: 'COLD_KITCHEN', KG_LP: 'COLD_KITCHEN', MS_UP: 'PASTRY' },
    PM_SNACK: { DAYCARE: 'PASTRY', KG_LP: 'PASTRY', MS_UP: 'COLD_KITCHEN' },
  },
};
// The AM Snack half, in its original shape (section -> style), for existing callers.
const AM_SNACK_STYLE_BY_PATTERN = { A: SNACK_STYLE_BY_PATTERN.A.AM_SNACK, B: SNACK_STYLE_BY_PATTERN.B.AM_SNACK };
const STYLE_LABEL = { PASTRY: 'Pastry', COLD_KITCHEN: 'Cold Kitchen' };
const SNACK_LABEL = { AM_SNACK: 'AM Snack', PM_SNACK: 'PM Snack' };
// Style for a snack cell on the run's `dayIndex`-th school day (1-based), or null when not rotated.
function snackStyleFor(dayIndex, categoryCode, sectionCode) {
  const byCat = SNACK_STYLE_BY_PATTERN[dayIndex % 2 === 1 ? 'A' : 'B'][categoryCode];
  return (byCat && SNACK_ROTATION_SECTIONS.includes(sectionCode) && byCat[sectionCode]) || null;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Supabase-backed eligible-item pool the generator scores from, exposed standalone so IPC
// handlers and the Excel export builders can query it without a MenuGenerator instance.
async function eligibleItemsSupabase(sectionId, categoryId) {
  const ageGroupIds = getAgeGroupsForSection(sectionId).map(a => a.id);
  if (ageGroupIds.length === 0) return [];

  const { data: portionRows, error: portErr } = await supabase
    .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
  if (portErr) throw supaFail('eligibleItemsSupabase: load item_portions', portErr);
  const itemIds = [...new Set(portionRows.map(r => r.item_id))];
  if (itemIds.length === 0) return [];

  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, am_snack_style, category_id, is_active')
    .eq('category_id', categoryId)
    .eq('is_active', 1)
    .in('id', itemIds);
  if (itemsErr) throw supaFail('eligibleItemsSupabase: load menu_items', itemsErr);

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

// Same two queries as eligibleItemsSupabase, but for a section's ENTIRE active item pool
// rather than one category at a time -- shared by MenuGenerator._loadSectionItemPool (which
// layers its own per-run cache on top of this) and the Build Menu IPC path
// (get-section-item-pool in main.js), which fetches this once per section and groups by
// category in memory instead of re-querying once per section*category slot.
async function sectionItemPoolSupabase(sectionId) {
  const ageGroupIds = getAgeGroupsForSection(sectionId).map(a => a.id);
  if (ageGroupIds.length === 0) return [];

  const { data: portionRows, error: portErr } = await supabase
    .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
  if (portErr) throw supaFail('sectionItemPoolSupabase: load item_portions', portErr);
  const itemIds = [...new Set(portionRows.map(r => r.item_id))];
  if (itemIds.length === 0) return [];

  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, am_snack_style, category_id, is_active')
    .eq('is_active', 1)
    .in('id', itemIds);
  if (itemsErr) throw supaFail('sectionItemPoolSupabase: load menu_items', itemsErr);

  return items;
}

// Sun-Thu school days starting at startDate, extracted so both the generator and the
// blank-template exporter walk calendars identically.
function schoolDaysFrom(startDate, numWeekdays) {
  const days = [];
  let current = new Date(startDate);
  while (days.length < numWeekdays) {
    const weekday = WEEKDAY_NAMES[current.getDay()];
    if (SCHOOL_WEEKDAYS.has(weekday)) days.push({ date: isoDate(current), weekday });
    current = new Date(current.getTime() + 86400000);
  }
  return days;
}

// The reverse of schoolDaysFrom: inclusive count of Sun-Thu school days between two calendar
// dates, for UI flows that take an end date instead of a day count (Generate Menu/Build
// Menu/Export All Sections' "End date" field).
function schoolDayCountBetween(startDate, endDate) {
  let count = 0;
  let current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    if (SCHOOL_WEEKDAYS.has(WEEKDAY_NAMES[current.getDay()])) count++;
    current = new Date(current.getTime() + 86400000);
  }
  return count;
}

// PostgREST caps a single response at 1000 rows by default; this pages through .range()
// until a page comes back short, so a section's full history is never silently truncated.
// buildQuery() must return a *fresh* Postgrest query builder each call (e.g.
// () => supabase.from('t').select('c').eq(...)) -- .range() is applied per page here.
async function fetchAllRows(buildQuery) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

class MenuGenerator {
  // Both options exist for the AI Menu Generator (lib/aiMenu.js) and default to off, so every
  // existing caller behaves exactly as before:
  // - draftPools: { [categoryCode]: [item, ...] } for THIS section -- AI-invented dishes (ids like
  //   'd:17', carrying the same attribute columns as a menu_items row) that replace the catalog
  //   pool for those categories. Every rule below then runs on them unchanged.
  // - partnerPicks: { [sectionCode]: { [date]: { [categoryCode]: [item, ...] } } } -- other
  //   sections' picks for this run, held in memory because a draft isn't saved anywhere yet.
  //   When given, it REPLACES the generated_menus lookup in _loadCoupledPartnerPicks.
  // - dayTheme: (isoDate) => cuisine | null -- National Day (lib/nationalDay.js). On a themed day,
  //   draft pools are split into that cuisine's dishes (tried first) and regular dishes (the
  //   fallback), see _pickThemed; on other days only regular dishes are used, so themed dishes are
  //   kept for their own Tuesday. Only ever passed by the AI Menu Generator.
  constructor({ draftPools = null, partnerPicks = null, dayTheme = null } = {}) {
    this.warnings = [];
    this._draftPools = draftPools;
    this._partnerPicks = partnerPicks;
    this._dayTheme = dayTheme;
  }

  // Splits a draft pool for `date` under dayTheme: { pool, fallback, cuisine }. fallback is null on
  // a regular day (and whenever dayTheme is off), which keeps _pickItems' normal path.
  _themeSplit(pool, date) {
    if (!pool || !this._dayTheme) return { pool, fallback: null, cuisine: null };
    const cuisine = this._dayTheme(date);
    const regular = pool.filter(it => !it.cuisine);
    if (!cuisine) return { pool: regular, fallback: null, cuisine: null };
    return { pool: pool.filter(it => it.cuisine === cuisine), fallback: regular, cuisine };
  }

  // Narrows a snack slot's candidates to today's Pastry / Cold Kitchen style: { pool, fallback }. On a
  // National Day (fallback = the regular dishes) both lists are narrowed -- themed dishes of today's
  // style first, then regular ones of today's style: the style rotation outranks the theme, like
  // every other rule. With nothing of that style at all, the full pool is used for the day, warned.
  _styleSplit(pool, fallback, requiredStyle, sectionCode, date, catCode) {
    const stylePool = pool.filter(it => it.am_snack_style === requiredStyle);
    if (fallback) {
      const regularStyle = fallback.filter(it => it.am_snack_style === requiredStyle);
      return { pool: stylePool, fallback: regularStyle.length ? regularStyle : fallback };
    }
    if (!stylePool.length) {
      const label = SNACK_LABEL[catCode] || catCode;
      this.warnings.push(
        `${sectionCode} ${date}: no ${requiredStyle} ${label} items available -- falling ` +
        `back to the full ${label} pool for this day (Pastry/Cold-Kitchen rotation not honored)`
      );
      return { pool, fallback };
    }
    return { pool: stylePool, fallback };
  }

  // National Day picking for one slot: the same rules as _pickItems, tried in the confirmed
  // fallback order -- (1) a themed dish keeping every rule, (2) a themed dish with the distinct
  // sauce / carb / concept rule relaxed, (3) a regular dish keeping every rule, (4) a regular dish
  // with it relaxed -- each step after (1) warning, so the draft shows where the theme gave way.
  // A dish with the previous school day's protein (noConsecutiveProtein) is only used after all
  // four fail. Composition rules go through the same order first. Safety is never involved here:
  // every pool dish already passed it.
  async _pickThemed(sectionId, onDate, count, options, excludeIds, sectionCode, categoryCode, themedPool, regularPool, cuisine, forceInclude = [], avoidProteinIds = null) {
    const { distinctAttr, composition } = options;
    const date = isoDate(onDate);
    const chosen = [];
    const usedAttr = new Set();
    const style = this._styleMixTracker(options.styleMix, sectionCode, onDate, categoryCode);
    const avoid = options.noConsecutiveProtein && avoidProteinIds && avoidProteinIds.size ? avoidProteinIds : null;
    for (const c of forceInclude) {
      if (chosen.length >= count || chosen.find(x => x.id === c.id)) continue;
      chosen.push(c);
      style.take(c, false);
      if (distinctAttr && c[distinctAttr] && !options.distinctAmongOwnOnly) usedAttr.add(c[distinctAttr]);
    }
    const tiers = [
      { pool: themedPool, relax: false, regular: false },
      { pool: themedPool, relax: true, regular: false },
      { pool: regularPool, relax: false, regular: true },
      { pool: regularPool, relax: true, regular: true },
      // styleMix slots: the mix outranks the theme, so it gives way only after every tier above.
      ...(style.active ? [
        { pool: themedPool, relax: true, regular: false, ignoreStyle: true },
        { pool: regularPool, relax: true, regular: true, ignoreStyle: true },
      ] : []),
      { pool: themedPool, relax: true, regular: false, sameProtein: true, ignoreStyle: true },
      { pool: regularPool, relax: true, regular: true, sameProtein: true, ignoreStyle: true },
    ];
    const ok = (c, t) => {
      if (excludeIds.has(c.id) || chosen.find(x => x.id === c.id)) return false;
      if (!t.ignoreStyle && !style.fits(c)) return false;
      if (!t.relax && distinctAttr && c[distinctAttr] && usedAttr.has(c[distinctAttr])) return false;
      if (avoid && !t.sameProtein && c.protein_type_id && avoid.has(c.protein_type_id)) return false;
      return true;
    };
    const add = (c, t) => {
      const last = this._lastUsedIncludingRun(sectionId, c.id, onDate);
      const gap = last ? Math.round((onDate - last) / 86400000) : 999;
      if (gap < NO_REPEAT_DAYS) {
        this.warnings.push(`${sectionCode} ${date}: '${c.name}' reused after only ${gap} days (pool too small to respect ${NO_REPEAT_DAYS}-day rule)`);
      }
      if (t.regular) {
        this.warnings.push(`${sectionCode} ${date}: National Day (${cuisine}) not honored for ${categoryCode}: used regular dish '${c.name}'`);
      } else if (distinctAttr && c[distinctAttr] && usedAttr.has(c[distinctAttr])) {
        this.warnings.push(`${sectionCode} ${date}: National Day (${cuisine}) relaxed the different-${distinctAttr} rule for ${categoryCode} to keep '${c.name}'`);
      }
      if (t.sameProtein && avoid && c.protein_type_id && avoid.has(c.protein_type_id)) {
        this.warnings.push(`${sectionCode} ${date}: '${c.name}' has the same protein as the previous school day for ${categoryCode} (no eligible dish with a different protein)`);
      }
      chosen.push(c);
      style.take(c, true);
      if (distinctAttr && c[distinctAttr]) usedAttr.add(c[distinctAttr]);
    };

    for (const rule of composition || []) {
      const wanted = new Set((rule.proteins || []).map(code => this._proteinId(code)).filter(Boolean));
      let added = 0;
      for (const t of tiers) {
        if (added >= (rule.count || 1)) break;
        for (const c of this._scoreAndSort(sectionId, t.pool.filter(c => wanted.has(c.protein_type_id)), onDate)) {
          if (added >= (rule.count || 1) || chosen.length >= count) break;
          if (ok(c, t)) { add(c, t); added++; }
        }
      }
      if (added < (rule.count || 1)) {
        this.warnings.push(
          `${sectionCode} ${date}: could not satisfy composition rule [${(rule.proteins || []).join('/')}] x${rule.count || 1} ` +
          `for ${categoryCode} (no eligible items with that protein type)`
        );
      }
    }
    for (const t of tiers) {
      if (chosen.length >= count) break;
      for (const c of this._scoreAndSort(sectionId, t.pool, onDate)) {
        if (chosen.length >= count) break;
        if (ok(c, t)) add(c, t);
      }
    }
    return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name), items: chosen };
  }

  _draftPool(categoryCode) {
    const pool = (this._draftPools && this._draftPools[categoryCode]) || null;
    if (!pool) return null;
    this._draftPoolAllowed = this._draftPoolAllowed || new Map();
    if (!this._draftPoolAllowed.has(pool)) this._draftPoolAllowed.set(pool, pool.filter(it => this._snackAllowed(it, categoryCode)));
    return this._draftPoolAllowed.get(pool);
  }

  // Chicken / beef never go into AM or PM Snack (lib/categoryRules.js) -- for every dish, catalog ones
  // included: an older catalog snack with chicken in its name or protein type is never picked,
  // copied from a partner's saved menu, or shared into Staff Breakfast for a new menu.
  _snackAllowed(item, categoryCode) {
    const proteinCode = item.protein_type_id ? getProteinById(item.protein_type_id)?.code : null;
    return !snackLunchOnlyHit(categoryCode, proteinCode, [['name', item.name]]);
  }

  _categoryId(code) {
    return getCategoryByCode(code).id;
  }

  _sectionId(code) {
    return getSectionByCode(code).id;
  }

  _proteinId(code) {
    const row = getProteinByCode(code);
    return row ? row.id : null;
  }

  // Loads (and caches, per section, for the lifetime of this MenuGenerator instance) the
  // full eligible-item pool for a section, then filters by category in memory. This is the
  // difference between ~2 Supabase requests per section per run and one per (section,
  // category, day) combination -- the latter would be hundreds to thousands of round trips
  // for a full month across 5 sections.
  async _loadSectionItemPool(sectionId) {
    this._itemPoolCache = this._itemPoolCache || new Map();
    if (this._itemPoolCache.has(sectionId)) return this._itemPoolCache.get(sectionId);
    const items = await sectionItemPoolSupabase(sectionId);
    this._itemPoolCache.set(sectionId, items);
    return items;
  }

  async _eligibleItems(sectionId, categoryId) {
    const pool = await this._loadSectionItemPool(sectionId);
    const categoryCode = getCategoryById(categoryId)?.code;
    return pool.filter(it => it.category_id === categoryId && this._snackAllowed(it, categoryCode))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Pre-loads every item's most recent use date within this section, once per computeMenu()
  // run, into an in-memory Map -- replaces the old per-candidate v_item_last_used lookup
  // (fine as a SQLite view query, but would be a Supabase round trip per candidate per slot
  // per day otherwise).
  async _loadLastUsedMap(sectionId) {
    if (this._lastUsedMemo) {
      if (!this._lastUsedMemo.has(sectionId)) this._lastUsedMemo.set(sectionId, this._loadLastUsedMapUncached(sectionId));
      return this._lastUsedMemo.get(sectionId);
    }
    return this._loadLastUsedMapUncached(sectionId);
  }

  async _loadLastUsedMapUncached(sectionId) {
    const { data: menus, error: menusErr } = await supabase
      .from('generated_menus').select('id').eq('section_id', sectionId);
    if (menusErr) throw supaFail('_loadLastUsedMap: load generated_menus', menusErr);
    const menuIds = menus.map(m => m.id);
    if (menuIds.length === 0) return new Map();

    const days = await fetchAllRows(
      () => supabase.from('menu_days').select('id, menu_date').in('generated_menu_id', menuIds)
    ).catch(err => { throw supaFail('_loadLastUsedMap: load menu_days', err); });
    const dateByDayId = new Map(days.map(d => [d.id, d.menu_date]));
    const dayIds = days.map(d => d.id);
    if (dayIds.length === 0) return new Map();

    const items = await fetchAllRows(
      () => supabase.from('menu_day_items').select('item_id, menu_day_id').in('menu_day_id', dayIds)
    ).catch(err => { throw supaFail('_loadLastUsedMap: load menu_day_items', err); });

    const lastUsed = new Map();
    for (const row of items) {
      const date = dateByDayId.get(row.menu_day_id);
      const cur = lastUsed.get(row.item_id);
      if (!cur || date > cur) lastUsed.set(row.item_id, date);
    }
    return lastUsed;
  }

  // Union of two sections' no-repeat history, taking the more recent date per item where both
  // have one -- used for KG-LP/MS-UP's coupled Lunch Main/Starch scoring, since a shared pick
  // scored against only one section's history could look "fresh" to one side while the other
  // just served it days ago.
  async _loadCoupledLastUsedMap(sectionIdA, sectionIdB) {
    const [mapA, mapB] = await Promise.all([
      this._loadLastUsedMap(sectionIdA),
      this._loadLastUsedMap(sectionIdB),
    ]);
    const merged = new Map(mapA);
    for (const [itemId, date] of mapB) {
      const existing = merged.get(itemId);
      if (!existing || date > existing) merged.set(itemId, date);
    }
    return merged;
  }

  // Looks for an already-persisted generated_menus row for the partner section with the exact
  // same start_date/end_date as this run (simplest possible match -- no fuzzy overlap, no
  // staleness cutoff), and if found, returns its picks (in `categoryCodes`) per calendar date so
  // this section can copy them exactly. This is what makes KG-LP and MS-UP end up identical
  // regardless of which one is generated first, or generated alone weeks apart from its
  // partner: whichever runs second (for the same dates) just finds the first one's picks
  // already sitting in the DB. Returns null if no matching partner menu exists yet, in which
  // case the caller generates fresh instead.
  //
  // `categoryCodes` defaults to COUPLED_LUNCH_CATEGORIES (every existing call site's own need --
  // KG-LP/MS-UP's Lunch Main/Starch coupling, and Staff Main Dish's force-share, which happens to
  // want LUNCH_MAIN, already one of those two). Staff Breakfast's own force-share (AM Snack from
  // Daycare/KG-LP/MS-UP) needs a category NOT in that list, so this takes an explicit override
  // instead of a second near-duplicate function -- same query shape either way, just a different
  // category filter.
  //
  // `numWeekdays` is REQUIRED to compute the run's actual end date (via schoolDaysFrom, the same
  // helper computeMenu's own day loop uses) -- this used to compare the partner's end_date
  // against `startDate` a second time instead of the run's real end date, which only ever matched
  // a partner menu that was exactly ONE DAY long. Confirmed against a real ~20-school-day Export
  // All Sections run: Staff Main Dish's own force-share (the mechanism this was modeled on) came
  // back 0-for-20 days against Daycare/KG-LP/MS-UP's actual Lunch Main picks -- not something
  // Staff Breakfast introduced, but a pre-existing latent bug in this shared function that just
  // never showed up because nobody had cross-checked it item-by-item on a multi-day run before.
  async _loadCoupledPartnerPicks(partnerSectionCode, startDate, numWeekdays, categoryCodes = COUPLED_LUNCH_CATEGORIES) {
    if (this._partnerPicks) return this._memoryPartnerPicks(partnerSectionCode, categoryCodes);

    const partnerSectionId = this._sectionId(partnerSectionCode);
    const targetStart = isoDate(startDate);
    const runDays = schoolDaysFrom(startDate, numWeekdays);
    const targetEnd = runDays[runDays.length - 1].date;

    const { data: menus, error: menuErr } = await supabase
      .from('generated_menus')
      .select('id')
      .eq('section_id', partnerSectionId)
      .eq('start_date', targetStart)
      .eq('end_date', targetEnd)
      .order('created_at', { ascending: false })
      .limit(1);
    if (menuErr) throw supaFail('_loadCoupledPartnerPicks: load generated_menus', menuErr);
    if (!menus.length) return null;
    const partnerMenuId = menus[0].id;

    const { data: days, error: daysErr } = await supabase
      .from('menu_days').select('id, menu_date').eq('generated_menu_id', partnerMenuId);
    if (daysErr) throw supaFail('_loadCoupledPartnerPicks: load menu_days', daysErr);
    if (!days.length) return null;
    const dateByDayId = new Map(days.map(d => [d.id, d.menu_date]));
    const dayIds = days.map(d => d.id);

    const { data: dayItemRows, error: diErr } = await supabase
      .from('menu_day_items').select('menu_day_id, item_id').in('menu_day_id', dayIds);
    if (diErr) throw supaFail('_loadCoupledPartnerPicks: load menu_day_items', diErr);
    if (!dayItemRows.length) return null;

    const itemIds = [...new Set(dayItemRows.map(r => r.item_id))];
    const { data: items, error: itemsErr } = await supabase
      .from('menu_items')
      .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, am_snack_style, category_id, is_active')
      .in('id', itemIds);
    if (itemsErr) throw supaFail('_loadCoupledPartnerPicks: load menu_items', itemsErr);
    const itemById = new Map(items.map(i => [i.id, i]));

    const catIdByCode = new Map(categoryCodes.map(code => [this._categoryId(code), code]));

    // Full item rows (not just {id, name}) so a caller like Staff's forced-include can score/
    // constrain-check these exactly like any other candidate.
    const result = {}; // { [menu_date]: { [categoryCode]: [item, ...] } }
    for (const row of dayItemRows) {
      const item = itemById.get(row.item_id);
      const catCode = item && catIdByCode.get(item.category_id);
      if (!catCode) continue;
      const date = dateByDayId.get(row.menu_day_id);
      if (!date) continue;
      if (!result[date]) result[date] = {};
      if (!result[date][catCode]) result[date][catCode] = [];
      result[date][catCode].push(item);
    }
    return result;
  }

  // In-memory counterpart of the query above, same return shape (null when the partner hasn't
  // been computed in this run). Filters by the SLOT category the partner filled, not the item's
  // own category_id -- a draft dish has no category_id, and for the school sections read here the
  // two are the same thing.
  _memoryPartnerPicks(partnerSectionCode, categoryCodes) {
    const byDate = this._partnerPicks[partnerSectionCode];
    if (!byDate) return null;
    const result = {};
    for (const [date, byCat] of Object.entries(byDate)) {
      for (const catCode of categoryCodes) {
        if (!byCat[catCode] || !byCat[catCode].length) continue;
        if (!result[date]) result[date] = {};
        result[date][catCode] = byCat[catCode].slice();
      }
    }
    return Object.keys(result).length ? result : null;
  }

  _lastUsedIncludingRun(sectionId, itemId, beforeDate) {
    const key = `${sectionId}:${itemId}`;
    const runDates = (this._runUsage[key] || []).slice();
    const dbDateStr = this._lastUsedMap.get(itemId);
    if (dbDateStr) runDates.push(new Date(dbDateStr));
    const past = runDates.filter(d => d < beforeDate);
    if (past.length === 0) return null;
    return new Date(Math.max(...past.map(d => d.getTime())));
  }

  _recordUsage(sectionId, itemId, onDate) {
    const key = `${sectionId}:${itemId}`;
    if (!this._runUsage[key]) this._runUsage[key] = [];
    this._runUsage[key].push(onDate);
  }

  _scoreAndSort(sectionId, candidates, onDate) {
    const scored = candidates.map(c => {
      const last = this._lastUsedIncludingRun(sectionId, c.id, onDate);
      const gap = last ? Math.round((onDate - last) / 86400000) : 999;
      return { gap, rnd: Math.random(), ...c };
    });
    scored.sort((a, b) => (b.gap - a.gap) || (a.rnd - b.rnd));
    return scored;
  }

  // Counts a styleMix slot's remaining Pastry / Cold Kitchen places. fits(c): c's style still has a
  // place (always true when the slot has no styleMix). take(c, warn): uses c's place; with warn, a
  // pick that doesn't fit is reported (the mix gave way), e.g.
  // "STAFF 2026-10-06: STAFF_BREAKFAST style mix short of PASTRY -- used 'X' (COLD_KITCHEN)".
  _styleMixTracker(styleMix, sectionCode, onDate, categoryCode) {
    if (!styleMix) return { active: false, fits: () => true, take: () => {} };
    const left = { ...styleMix };
    const fits = (c) => (c.am_snack_style in left) && left[c.am_snack_style] > 0;
    return {
      active: true,
      fits,
      take: (c, warn) => {
        if (warn && !fits(c)) {
          const short = Object.keys(left).find(k => left[k] > 0);
          if (short) {
            this.warnings.push(
              `${sectionCode} ${isoDate(onDate)}: ${categoryCode} style mix short of ${short} -- used '${c.name}' ` +
              `(${c.am_snack_style || 'no style'})`
            );
          }
        }
        if (c.am_snack_style in left) left[c.am_snack_style]--;
      },
    };
  }

  // overridePool, when given, replaces the normal per-section eligible-item lookup -- used for
  // KG-LP/MS-UP's coupled Lunch Main/Starch picks, which draw from the intersection of both
  // sections' pools instead of just this one's. forceInclude, when given, seeds `chosen` with
  // specific items up front, bypassing distinct/no-repeat checks entirely (used for Staff's
  // Main Dish slot, which must always include that day's KG-LP/MS-UP Lunch Main pair verbatim
  // among its 7 choices). Every other rule (composition, distinctAttr, no-repeat scoring) is
  // unchanged either way.
  //
  // Options added 2026-09-23 (menu rules v2), each off unless the slot sets it:
  // - fixedDaily: the slot is the category's daily-repeating item and nothing else (Staff's three
  //   fixed beverages) -- if there isn't one, the slot stays empty and a warning says so, rather
  //   than rotating some other item in.
  // - distinctAmongOwnOnly: forced-in items don't count against distinctAttr (Staff Main: only
  //   the own vegan + vegetarian pair must differ in starch, not the shared starches).
  // - noConsecutiveProtein + avoidProteinIds: prefer items whose protein differs from the
  //   previous school day's (Daycare Lunch Main); falls back with a warning if the pool can't.
  // - styleMix ({ PASTRY: 3, COLD_KITCHEN: 3 }, Staff Breakfast, 2026-09-24): how many of each
  //   am_snack_style the slot holds, forced-in items included. The meat-free composition pick comes
  //   first and may take either style (it breaks the mix only if no meat-free dish of a style still
  //   needed exists, warned); then the mix outranks the different-dish-concept rule, which is relaxed
  //   before the mix is. In such a slot a dish not served in NO_REPEAT_DAYS also outranks the
  //   different-concept rule: six dishes and six concepts leave few dishes that fit a given day, and
  //   serving the same dish again within weeks is worse than two of one kind on a six-dish buffet.
  async _pickItems(sectionId, categoryId, onDate, count, options, excludeIds, sectionCode, categoryCode, overridePool = null, forceInclude = [], avoidProteinIds = null) {
    const { distinctProtein, distinctAttr, composition } = options;
    const pool = overridePool || await this._eligibleItems(sectionId, categoryId);
    let candidates = pool.filter(c => !excludeIds.has(c.id));

    const repeating = candidates.filter(c => c.is_daily_repeating === 1);
    if (options.fixedDaily) {
      const fixed = repeating.slice(0, count);
      if (fixed.length < count) {
        this.warnings.push(
          `${sectionCode} ${isoDate(onDate)}: no fixed daily item set for ${categoryCode} -- add one in the ` +
          `Dish Catalog with "Repeats every day automatically" ticked (left empty)`
        );
      }
      return { ids: fixed.map(c => c.id), names: fixed.map(c => c.name), items: fixed };
    }
    if (repeating.length && !forceInclude.length) {
      const chosen = repeating.slice(0, count);
      return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name), items: chosen };
    }

    const chosen = [];
    const usedProteins = new Set();
    const usedAttrValues = new Set();
    const style = this._styleMixTracker(options.styleMix, sectionCode, onDate, categoryCode);

    // Seed with items forced in from elsewhere -- an intentional, expected duplication (not a
    // pool-scarcity fallback), so these bypass distinct-protein/attr checks and the no-repeat
    // warning entirely.
    for (const c of forceInclude) {
      if (chosen.length >= count) break;
      if (chosen.find(x => x.id === c.id)) continue;
      chosen.push(c);
      style.take(c, false);
      if (c.protein_type_id) usedProteins.add(c.protein_type_id);
      if (distinctAttr && c[distinctAttr] && !options.distinctAmongOwnOnly) usedAttrValues.add(c[distinctAttr]);
    }
    candidates = candidates.filter(c => !chosen.find(x => x.id === c.id));
    const avoid = options.noConsecutiveProtein && avoidProteinIds && avoidProteinIds.size ? avoidProteinIds : null;
    const isAvoided = (c) => !!(avoid && c.protein_type_id && avoid.has(c.protein_type_id));

    // opts.ignoreDistinct / opts.ignoreStyle relax just one rule (styleMix slots only).
    const tryAdd = (c, ignoreConstraints = false, opts = {}) => {
      if (chosen.length >= count) return false;
      if (opts.freshOnly) {
        const seen = this._lastUsedIncludingRun(sectionId, c.id, onDate);
        if (seen && Math.round((onDate - seen) / 86400000) < NO_REPEAT_DAYS) return false;
      }
      if (!ignoreConstraints) {
        if (!opts.ignoreDistinct) {
          if (distinctProtein && c.protein_type_id && usedProteins.has(c.protein_type_id)) return false;
          if (distinctAttr && c[distinctAttr] && usedAttrValues.has(c[distinctAttr])) return false;
        }
        if (!opts.ignoreStyle && !style.fits(c)) return false;
      }
      const last = this._lastUsedIncludingRun(sectionId, c.id, onDate);
      const gap = last ? Math.round((onDate - last) / 86400000) : 999;
      if (gap < NO_REPEAT_DAYS) {
        this.warnings.push(
          `${sectionCode} ${isoDate(onDate)}: '${c.name}' reused after only ${gap} days ` +
          `(pool too small to respect ${NO_REPEAT_DAYS}-day rule)`
        );
      }
      chosen.push(c);
      style.take(c, true);
      if (c.protein_type_id) usedProteins.add(c.protein_type_id);
      if (distinctAttr && c[distinctAttr]) usedAttrValues.add(c[distinctAttr]);
      return true;
    };

    // Step 1: satisfy composition rules in order (e.g. exactly 1 chicken then 1 beef,
    // or 1 meat-protein then 1 vegetarian)
    if (composition && composition.length) {
      for (const rule of composition) {
        const wantedIds = new Set(
          (rule.proteins || []).map(code => this._proteinId(code)).filter(Boolean)
        );
        const pool = candidates.filter(c =>
          wantedIds.has(c.protein_type_id) && !chosen.find(x => x.id === c.id));
        const scoredPool = this._scoreAndSort(sectionId, pool, onDate);
        let added = 0;
        for (const c of scoredPool) {
          if (added >= (rule.count || 1)) break;
          if (tryAdd(c)) added++;
        }
        // The composition rule (e.g. the meat-free breakfast) outranks the style mix.
        if (style.active && added < (rule.count || 1)) {
          for (const c of scoredPool) {
            if (added >= (rule.count || 1)) break;
            if (!chosen.find(x => x.id === c.id) && tryAdd(c, false, { ignoreStyle: true })) added++;
          }
        }
        if (added < (rule.count || 1)) {
          this.warnings.push(
            `${sectionCode} ${isoDate(onDate)}: could not satisfy composition rule ` +
            `[${(rule.proteins || []).join('/')}] x${rule.count || 1} for ${categoryCode} ` +
            `(no eligible items with that protein type)`
          );
        }
      }
    }

    // Step 2: fill remaining picks respecting distinct-protein / distinct-attribute constraints
    // (and, where the slot asks, a different protein from the previous school day)
    const remaining = candidates.filter(c => !chosen.find(x => x.id === c.id));
    const scored = this._scoreAndSort(sectionId, remaining, onDate);
    // Style-mix slots: dishes not served recently first, keeping every rule, then with the concept
    // rule relaxed -- only then (below) may a dish come back inside NO_REPEAT_DAYS.
    if (style.active) {
      for (const opts of [{ freshOnly: true }, { freshOnly: true, ignoreDistinct: true }]) {
        for (const c of scored) {
          if (chosen.length >= count) break;
          if (!chosen.find(x => x.id === c.id)) tryAdd(c, false, opts);
        }
      }
    }
    for (const c of scored) {
      if (chosen.length >= count) break;
      if (isAvoided(c)) continue;
      tryAdd(c);
    }
    if (avoid && chosen.length < count) {
      for (const c of scored) {
        if (chosen.length >= count) break;
        if (!isAvoided(c) || chosen.find(x => x.id === c.id)) continue;
        if (tryAdd(c)) {
          this.warnings.push(
            `${sectionCode} ${isoDate(onDate)}: '${c.name}' has the same protein as the previous school day ` +
            `for ${categoryCode} (no eligible dish with a different protein)`
          );
        }
      }
    }

    // Style-mix slots: keep the mix and let two dishes share a concept, then (last) break the mix.
    if (style.active) {
      for (const opts of [{ ignoreDistinct: true }, { ignoreStyle: true }]) {
        for (const c of scored) {
          if (chosen.length >= count) break;
          if (!chosen.find(x => x.id === c.id)) tryAdd(c, false, opts);
        }
      }
    }

    // Step 3: if still short (constraints too strict for the pool), fill regardless
    if (chosen.length < count) {
      for (const c of scored) {
        if (chosen.length >= count) break;
        if (chosen.find(x => x.id === c.id)) continue;
        tryAdd(c, true);
      }
    }

    return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name), items: chosen };
  }

  // Protein ids served in `categoryCode` on this section's last saved school day before
  // `beforeDate` (looking back two weeks), so a run's first day can respect noConsecutiveProtein
  // across runs. Where several saved menus cover that day, the most recently created one counts.
  async _loadLastServedProteins(sectionId, categoryCode, beforeDate) {
    const catId = this._categoryId(categoryCode);
    const { data: menus, error: menusErr } = await supabase
      .from('generated_menus').select('id, created_at').eq('section_id', sectionId);
    if (menusErr) throw supaFail('_loadLastServedProteins: load generated_menus', menusErr);
    if (!menus.length) return new Set();
    const createdById = new Map(menus.map(m => [m.id, m.created_at || '']));
    const from = isoDate(new Date(beforeDate.getTime() - 14 * 86400000));
    const days = await fetchAllRows(() => supabase.from('menu_days').select('id, menu_date, generated_menu_id')
      .in('generated_menu_id', menus.map(m => m.id)).gte('menu_date', from).lt('menu_date', isoDate(beforeDate)))
      .catch(err => { throw supaFail('_loadLastServedProteins: load menu_days', err); });
    if (!days.length) return new Set();
    const lastDate = days.reduce((m, d) => (d.menu_date > m ? d.menu_date : m), '');
    const day = days.filter(d => d.menu_date === lastDate)
      .sort((a, b) => String(createdById.get(b.generated_menu_id)).localeCompare(String(createdById.get(a.generated_menu_id))))[0];
    const [{ data: rows, error: rowsErr }, { data: slots, error: slotErr }] = await Promise.all([
      supabase.from('menu_day_items').select('item_id, slot_id').eq('menu_day_id', day.id),
      supabase.from('menu_slots').select('id, category_id').eq('section_id', sectionId),
    ]);
    if (rowsErr) throw supaFail('_loadLastServedProteins: load menu_day_items', rowsErr);
    if (slotErr) throw supaFail('_loadLastServedProteins: load menu_slots', slotErr);
    const slotCat = new Map(slots.map(sl => [sl.id, sl.category_id]));
    const itemIds = rows.filter(r => slotCat.get(r.slot_id) === catId).map(r => r.item_id);
    if (!itemIds.length) return new Set();
    const { data: items, error: itemsErr } = await supabase.from('menu_items').select('id, protein_type_id').in('id', itemIds);
    if (itemsErr) throw supaFail('_loadLastServedProteins: load menu_items', itemsErr);
    return new Set(items.map(i => i.protein_type_id).filter(Boolean));
  }

  // Pure selection: no DB writes. Used both by generate() and by the manual builder's
  // "Fill with suggestions" preview (which must not persist anything on its own).
  async computeMenu(sectionCode, startDate, numWeekdays) {
    this._runUsage = {};
    this._lastUsedMemo = new Map(); // one history load per section per run (KG-LP has two partners)
    const sectionId = this._sectionId(sectionCode);
    this._lastUsedMap = await this._loadLastUsedMap(sectionId);
    const slots = SECTION_SLOTS[sectionCode];
    const resultDays = [];

    // Shared categories (SECTION_COUPLINGS: KG-LP/MS-UP lunch, Daycare/KG-LP snacks): per category,
    // the partner's already-persisted picks for this exact date range (if any), plus the pool of
    // dishes both sections have and their merged history, needed to generate fresh when there are
    // no partner picks yet (or they don't cover every day of this run).
    const coupled = {}; // catCode -> { partnerCode, picksByDate, pool, lastUsedMap }
    const partnersByCat = couplingPartners(sectionCode);
    for (const partnerCode of [...new Set(Object.values(partnersByCat))]) {
      const cats = Object.keys(partnersByCat).filter(c => partnersByCat[c] === partnerCode);
      const partnerSectionId = this._sectionId(partnerCode);
      const [picks, lastUsed, poolA, poolB] = await Promise.all([
        this._loadCoupledPartnerPicks(partnerCode, startDate, numWeekdays, cats),
        this._loadCoupledLastUsedMap(sectionId, partnerSectionId),
        this._loadSectionItemPool(sectionId),
        this._loadSectionItemPool(partnerSectionId),
      ]);
      for (const catCode of cats) {
        // A draft pool for a shared category is built for both sections at once, so it IS the
        // shared pool -- no intersection needed.
        let pool = this._draftPool(catCode);
        if (!pool) {
          const catId = this._categoryId(catCode);
          const idsInPartner = new Set(poolB.filter(i => i.category_id === catId).map(i => i.id));
          pool = poolA
            .filter(i => i.category_id === catId && idsInPartner.has(i.id) && this._snackAllowed(i, catCode))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        coupled[catCode] = { partnerCode, picksByDate: picks, pool, lastUsedMap: lastUsed };
      }
    }

    // Staff Main Dish carries that day's KG-LP/MS-UP Lunch Main + Lunch Starch pairs (either
    // section: they're forced identical, so whichever has a persisted menu for this exact date
    // range is fine) and MS-UP's Lunch Vegetable -- see STAFF_MAIN_SOURCE_SECTIONS.
    let staffMainSourcePicks = null;
    let staffMainVegetablePicks = null;
    if (sectionCode === 'STAFF') {
      for (const src of STAFF_MAIN_SOURCE_SECTIONS) {
        staffMainSourcePicks = await this._loadCoupledPartnerPicks(src, startDate, numWeekdays, STAFF_MAIN_SHARED_CATEGORIES);
        if (staffMainSourcePicks) break;
      }
      if (!staffMainSourcePicks) {
        this.warnings.push(
          `STAFF: no KG-LP/MS-UP menu found for start date ${isoDate(startDate)} -- ` +
          `Staff Main Dish generated without the school Lunch Main / Starch shares`
        );
      }
      staffMainVegetablePicks = await this._loadCoupledPartnerPicks(STAFF_MAIN_VEGETABLE_SECTION, startDate, numWeekdays, [STAFF_MAIN_VEGETABLE_CATEGORY]);
      if (!staffMainVegetablePicks) {
        this.warnings.push(
          `STAFF: no MS-UP menu found for start date ${isoDate(startDate)} -- ` +
          `Staff Main Dish generated without MS-UP's Lunch Vegetable share`
        );
      }
    }

    // Slots with noConsecutiveProtein (Daycare Lunch Main): the previous school day's proteins,
    // starting from the last saved school day before this run.
    const prevProteinsByCat = {};
    for (const [catCode, , options] of slots) {
      if (options.noConsecutiveProtein) prevProteinsByCat[catCode] = await this._loadLastServedProteins(sectionId, catCode, startDate);
    }

    // Staff Breakfast must always include that day's Daycare/KG-LP/MS-UP AM Snack picks, one
    // from each (all 3 required -- see STAFF_BREAKFAST_SOURCE_SECTIONS' own comment). Loaded once
    // per source section here, up front, same as Staff Main's own sourcing above.
    let staffBreakfastSourcePicks = null;
    if (sectionCode === 'STAFF') {
      staffBreakfastSourcePicks = {};
      for (const src of STAFF_BREAKFAST_SOURCE_SECTIONS) {
        staffBreakfastSourcePicks[src] = await this._loadCoupledPartnerPicks(src, startDate, numWeekdays, [STAFF_BREAKFAST_SOURCE_CATEGORY]);
      }
      for (const group of STAFF_BREAKFAST_SOURCE_GROUPS) {
        if (group.some(src => staffBreakfastSourcePicks[src])) continue;
        this.warnings.push(
          `STAFF: no ${group.join('/')} menu found for start date ${isoDate(startDate)} -- ` +
          `Staff Breakfast's ${group.join('/')} AM Snack share generated independently for this run`
        );
      }
    }

    let amSnackDayIndex = 0; // 1-based, reset per computeMenu() run -- see AM_SNACK_STYLE_BY_PATTERN's own comment
    for (const { date, weekday } of schoolDaysFrom(startDate, numWeekdays)) {
      amSnackDayIndex++;
      const current = new Date(date);
      const dayUsed = new Set();
      const dayItems = [];

      for (const [catCode, count, options] of slots) {
        const catId = this._categoryId(catCode);
        const cp = coupled[catCode] || null;
        let partnerPicksForDay = cp && cp.picksByDate && cp.picksByDate[date] && cp.picksByDate[date][catCode];
        let partnerRefused = false;
        // A partner menu saved before the chicken / beef snack rule may hold such a snack: never copy
        // it into a new menu -- this day is generated fresh instead (the two sections then differ).
        if (partnerPicksForDay && partnerPicksForDay.some(it => !this._snackAllowed(it, catCode))) {
          const bad = partnerPicksForDay.find(it => !this._snackAllowed(it, catCode));
          this.warnings.push(
            `${sectionCode} ${date}: ${cp.partnerCode}'s saved ${catCode} '${bad.name}' has chicken or beef (lunch only) -- ` +
            `not copied; this day's ${catCode} is generated here instead`
          );
          partnerPicksForDay = null;
          partnerRefused = true;
        }
        // Pastry / Cold Kitchen for this snack cell today (null for every other slot).
        const requiredStyle = snackStyleFor(amSnackDayIndex, catCode, sectionCode);

        let forceInclude = [];
        if (sectionCode === 'STAFF' && catCode === 'STAFF_MAIN') {
          if (staffMainSourcePicks) {
            for (const shared of STAFF_MAIN_SHARED_CATEGORIES) {
              const picks = staffMainSourcePicks[date] && staffMainSourcePicks[date][shared];
              if (picks && picks.length) forceInclude.push(...picks);
              else {
                this.warnings.push(
                  `STAFF ${date}: KG-LP/MS-UP menu doesn't cover ${shared} for this date -- Main Dish ` +
                  `missing that share for this day`
                );
              }
            }
          }
          if (staffMainVegetablePicks) {
            const veg = staffMainVegetablePicks[date] && staffMainVegetablePicks[date][STAFF_MAIN_VEGETABLE_CATEGORY];
            if (veg && veg.length) forceInclude.push(veg[0]);
            else {
              this.warnings.push(
                `STAFF ${date}: MS-UP menu doesn't cover this date -- Main Dish missing MS-UP's ` +
                `Lunch Vegetable share for this day`
              );
            }
          }
        }

        if (sectionCode === 'STAFF' && catCode === 'STAFF_BREAKFAST') {
          const forcedIds = new Set();
          for (const group of STAFF_BREAKFAST_SOURCE_GROUPS) {
            const loaded = group.filter(src => staffBreakfastSourcePicks[src]);
            if (!loaded.length) continue; // already warned once for the whole run, above
            // Daycare and KG-LP serve the same dish: whichever of them has this date (Daycare first).
            const src = loaded.find(x => {
              const d = staffBreakfastSourcePicks[x][date];
              return d && d[STAFF_BREAKFAST_SOURCE_CATEGORY] && d[STAFF_BREAKFAST_SOURCE_CATEGORY].length;
            });
            if (!src) {
              this.warnings.push(
                `STAFF ${date}: ${group.join('/')} menu doesn't cover this date -- Staff Breakfast missing ` +
                `that AM Snack share for this day`
              );
              continue;
            }
            const item = staffBreakfastSourcePicks[src][date][STAFF_BREAKFAST_SOURCE_CATEGORY][0];
            if (!this._snackAllowed(item, STAFF_BREAKFAST_SOURCE_CATEGORY)) {
              this.warnings.push(
                `STAFF ${date}: ${src}'s saved AM Snack '${item.name}' has chicken or beef (lunch only) -- not shared ` +
                `into Staff Breakfast; Staff's own dish is used instead`
              );
              continue;
            }
            // The shared Daycare/KG-LP dish and MS-UP's are normally opposite styles, so never the same
            // dish; if they coincide anyway it is one shared slot, flagged.
            if (forcedIds.has(item.id)) {
              this.warnings.push(
                `STAFF ${date}: ${src}'s AM Snack pick ('${item.name}') matches another source ` +
                `section's pick for this day -- Staff Breakfast gets fewer than 2 distinct shared items`
              );
              continue;
            }
            forcedIds.add(item.id);
            forceInclude.push(item);
          }
        }

        // Snack Pastry / Cold Kitchen rotation (SNACK_STYLE_BY_PATTERN): narrows this day's candidate
        // pool to the required style via overridePool -- _pickItems' own scoring / no-repeat logic
        // runs unchanged, just against a smaller list. A shared (coupled) snack gets the same filter
        // on its both-catalogs pool below.
        let { pool: overridePool, fallback: themeFallback, cuisine: themeCuisine } = this._themeSplit(this._draftPool(catCode), date);
        if (requiredStyle && !cp) {
          const fullPool = overridePool || await this._eligibleItems(sectionId, catId);
          ({ pool: overridePool, fallback: themeFallback } = this._styleSplit(fullPool, themeFallback, requiredStyle, sectionCode, date, catCode));
        }

        let ids, names;
        if (cp && partnerPicksForDay && partnerPicksForDay.length) {
          // Partner section already generated this exact date range -- copy its picks
          // verbatim so both sections end up identical.
          ids = partnerPicksForDay.map(p => p.id);
          names = partnerPicksForDay.map(p => p.name);
        } else if (cp) {
          if (cp.picksByDate && !partnerRefused) {
            this.warnings.push(
              `${sectionCode} ${date}: partner section ${cp.partnerCode}'s matching menu doesn't ` +
              `cover ${catCode} for this date -- generating independently for this day`
            );
          }
          // No partner picks available for this day/category -- generate fresh from the
          // intersected pool, scored against the two sections' merged history so the pick
          // stays fair to whichever section serves it "second" once both are persisted.
          const savedLastUsedMap = this._lastUsedMap;
          this._lastUsedMap = cp.lastUsedMap;
          try {
            let split = this._draftPool(catCode) ? this._themeSplit(cp.pool, date) : { pool: cp.pool, fallback: null, cuisine: null };
            if (requiredStyle) split = { ...split, ...this._styleSplit(split.pool, split.fallback, requiredStyle, sectionCode, date, catCode) };
            if (split.fallback) {
              ({ ids, names } = await this._pickThemed(sectionId, current, count, options, dayUsed, sectionCode, catCode,
                split.pool, split.fallback, split.cuisine));
            } else {
              ({ ids, names } = await this._pickItems(sectionId, catId, current, count, options,
                dayUsed, sectionCode, catCode, split.pool));
            }
          } finally {
            this._lastUsedMap = savedLastUsedMap;
          }
        } else {
          let items;
          if (themeFallback) {
            ({ ids, names, items } = await this._pickThemed(sectionId, current, count, options, dayUsed, sectionCode, catCode,
              overridePool, themeFallback, themeCuisine, forceInclude, prevProteinsByCat[catCode] || null));
          } else {
            ({ ids, names, items } = await this._pickItems(sectionId, catId, current, count, options,
              dayUsed, sectionCode, catCode, overridePool, forceInclude, prevProteinsByCat[catCode] || null));
          }
          if (options.noConsecutiveProtein) prevProteinsByCat[catCode] = new Set(items.map(it => it.protein_type_id).filter(Boolean));
        }

        ids.forEach((itemId, i) => {
          dayUsed.add(itemId);
          this._recordUsage(sectionId, itemId, current);
          dayItems.push({ category: catCode, id: itemId, name: names[i] });
        });
      }
      resultDays.push({ date, weekday, items: dayItems });
    }
    return { resultDays, warnings: this.warnings };
  }

  // Writes a resultDays-shaped menu (from computeMenu(), or manually assembled by the
  // builder UI) into the same tables generate() always has. Items only need `category`
  // and `id` -- iterates SECTION_SLOTS itself (not the caller's item order) so same-category
  // rows always land contiguously, which the Excel export's category merge-cells depend on.
  // Batches every insert (one generated_menus row, one menu_slots lookup/create pass, one
  // multi-row menu_days insert, one multi-row menu_day_items insert) instead of row-by-row,
  // since there's no cross-request transaction to hide hundreds of round trips behind.
  // batchId (a UUID) links several sections' generated_menus rows together as one bulk
  // export -- e.g. Export All Sections or Build Menu's "Export" both save all 5 sections in
  // one user action, and History groups rows sharing a batch_id into a single "All Sections"
  // entry. null for a single-section save (Generate Menu, or a lone Build Menu save).
  async persistMenu(sectionCode, label, startDate, resultDays, batchId = null, createdBy = null) {
    const sectionId = this._sectionId(sectionCode);
    const slots = SECTION_SLOTS[sectionCode];

    const { data: menuRow, error: menuErr } = await supabase
      .from('generated_menus')
      .insert({
        section_id: sectionId, label, start_date: isoDate(startDate),
        end_date: resultDays[resultDays.length - 1].date,
        status: 'DRAFT', created_at: new Date().toISOString(), batch_id: batchId,
        created_by: createdBy || null,
      })
      .select('id')
      .single();
    if (menuErr) throw supaFail('persistMenu: insert generated_menus', menuErr);
    const menuId = menuRow.id;

    // Resolve (or lazily create) this section's menu_slots rows, once, up front.
    const { data: existingSlots, error: slotErr } = await supabase
      .from('menu_slots').select('id, category_id').eq('section_id', sectionId);
    if (slotErr) throw supaFail('persistMenu: load menu_slots', slotErr);
    const slotIdByCategory = new Map(existingSlots.map(s => [s.category_id, s.id]));

    const missingSlots = [];
    for (const [catCode, count, options] of slots) {
      const catId = this._categoryId(catCode);
      if (!slotIdByCategory.has(catId)) {
        missingSlots.push({
          section_id: sectionId, category_id: catId, slot_order: 0,
          items_required: count, require_distinct_protein: options.distinctProtein ? 1 : 0,
          // Set explicitly rather than relying on Supabase having the same column default
          // SQLite's schema.sql declares -- generated_menus.created_at and
          // menu_day_items.is_manual_override both turned out not to have theirs.
          is_auto_filled: 0,
        });
      }
    }
    if (missingSlots.length) {
      const { data: created, error: createErr } = await supabase
        .from('menu_slots').insert(missingSlots).select('id, category_id');
      if (createErr) throw supaFail('persistMenu: create menu_slots', createErr);
      for (const s of created) slotIdByCategory.set(s.category_id, s.id);
    }

    const dayRows = resultDays.map(day => ({
      generated_menu_id: menuId, menu_date: day.date, day_of_week: day.weekday,
    }));
    const { data: insertedDays, error: dayErr } = await supabase
      .from('menu_days').insert(dayRows).select('id, menu_date');
    if (dayErr) throw supaFail('persistMenu: insert menu_days', dayErr);
    const dayIdByDate = new Map(insertedDays.map(d => [d.menu_date, d.id]));

    const itemRows = [];
    for (const day of resultDays) {
      const dayId = dayIdByDate.get(day.date);
      for (const [catCode] of slots) {
        const catId = this._categoryId(catCode);
        const slotId = slotIdByCategory.get(catId);
        const itemsForCat = day.items.filter(it => it.category === catCode && it.id);
        for (const it of itemsForCat) {
          // Matches the old SQLite column's DEFAULT 0 -- persistMenu never marks anything as
          // manually overridden (whether the caller is the auto-generator or a Build Menu
          // save); only the swap-menu-item flow ever sets this to 1, as a post-hoc edit marker.
          itemRows.push({ menu_day_id: dayId, slot_id: slotId, item_id: it.id, is_manual_override: 0 });
        }
      }
    }
    if (itemRows.length) {
      const { error: itemErr } = await supabase.from('menu_day_items').insert(itemRows);
      if (itemErr) throw supaFail('persistMenu: insert menu_day_items', itemErr);
    }

    return menuId;
  }

  async generate(sectionCode, label, startDate, numWeekdays, batchId = null, createdBy = null) {
    const { resultDays } = await this.computeMenu(sectionCode, startDate, numWeekdays);
    const menuId = await this.persistMenu(sectionCode, label, startDate, resultDays, batchId, createdBy);
    return { menuId, resultDays };
  }
}

module.exports = { MenuGenerator, SECTION_SLOTS, AM_SNACK_STYLE_BY_PATTERN, SNACK_STYLE_BY_PATTERN, snackStyleFor, SECTION_COUPLINGS, couplingPartners, eligibleItemsSupabase, sectionItemPoolSupabase, schoolDaysFrom, schoolDayCountBetween };
