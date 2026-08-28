const { supabase, supaFail } = require('./supabaseClient');
const { getCategoryByCode, getSectionByCode, getProteinByCode, getAgeGroupsForSection } = require('./referenceData');

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
    ['LUNCH_MAIN', 1, {}], ['LUNCH_SALAD', 1, {}],
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
    // 6 breakfast dishes (incl. 1 vegan, varied concepts), THEN the juice pick
    ['STAFF_BREAKFAST', 6, {
      distinctAttr: 'dish_concept',
      composition: [{ proteins: ['VEGETARIAN'], count: 1 }],
    }],
    ['STAFF_BREAKFAST_JUICE', 1, {}],
    ['STAFF_APPETIZER', 2, {}], ['STAFF_SALAD', 5, {}],
    ['STAFF_MAIN', 7, { composition: [{ proteins: ['VEGETARIAN'], count: 1 }] }],
    ['STAFF_SWEETS', 3, {}], ['STAFF_BREAD', 3, {}],
    ['STAFF_FRUIT_BASKET', 1, {}], ['STAFF_JUICE', 1, {}],
    // lunch box: 1 meat protein + 1 vegan/vegetarian, then 1 salad from its own pool
    ['STAFF_LUNCHBOX', 2, {
      composition: [
        { proteins: ['CHICKEN', 'BEEF', 'LAMB', 'FISH'], count: 1 },
        { proteins: ['VEGETARIAN'], count: 1 },
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

// KG-LP and MS-UP must get IDENTICAL Lunch Main/Starch picks (Daycare is untouched -- it has
// its own independent, uncoupled LUNCH_MAIN and no LUNCH_STARCH at all). Keyed both ways so
// computeMenu can look up "my partner" from either side.
const COUPLED_SCHOOL_SECTIONS = { KG_LP: 'MS_UP', MS_UP: 'KG_LP' };
const COUPLED_LUNCH_CATEGORIES = ['LUNCH_MAIN', 'LUNCH_STARCH'];

// Staff's STAFF_MAIN slot (7 choices) must always include that day's KG-LP/MS-UP Lunch Main
// pair verbatim -- checked against whichever of the two already has a persisted menu for the
// exact same date (they're forced identical to each other, so it doesn't matter which) --
// PLUS Daycare's own (independent, uncoupled) Lunch Main pick for that day. So of the 7:
// 2 come from KG-LP/MS-UP, 1 comes from Daycare, and the remaining 4 are picked with the
// existing rules (composition still requires 1 vegetarian among them).
const STAFF_MAIN_SOURCE_SECTIONS = ['KG_LP', 'MS_UP'];
const STAFF_MAIN_DAYCARE_SOURCE_SECTION = 'DAYCARE';
const STAFF_MAIN_SOURCE_CATEGORY = 'LUNCH_MAIN';

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
    .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, category_id, is_active')
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
    .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, category_id, is_active')
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
  constructor() {
    this.warnings = [];
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
    return pool.filter(it => it.category_id === categoryId).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Pre-loads every item's most recent use date within this section, once per computeMenu()
  // run, into an in-memory Map -- replaces the old per-candidate v_item_last_used lookup
  // (fine as a SQLite view query, but would be a Supabase round trip per candidate per slot
  // per day otherwise).
  async _loadLastUsedMap(sectionId) {
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
  // staleness cutoff), and if found, returns its Lunch Main/Starch picks per calendar date so
  // this section can copy them exactly. This is what makes KG-LP and MS-UP end up identical
  // regardless of which one is generated first, or generated alone weeks apart from its
  // partner: whichever runs second (for the same dates) just finds the first one's picks
  // already sitting in the DB. Returns null if no matching partner menu exists yet, in which
  // case the caller generates fresh instead.
  async _loadCoupledPartnerPicks(partnerSectionCode, startDate) {
    const partnerSectionId = this._sectionId(partnerSectionCode);
    const targetDate = isoDate(startDate);

    const { data: menus, error: menuErr } = await supabase
      .from('generated_menus')
      .select('id')
      .eq('section_id', partnerSectionId)
      .eq('start_date', targetDate)
      .eq('end_date', targetDate)
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
      .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, category_id, is_active')
      .in('id', itemIds);
    if (itemsErr) throw supaFail('_loadCoupledPartnerPicks: load menu_items', itemsErr);
    const itemById = new Map(items.map(i => [i.id, i]));

    const catIdByCode = new Map(COUPLED_LUNCH_CATEGORIES.map(code => [this._categoryId(code), code]));

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

  // overridePool, when given, replaces the normal per-section eligible-item lookup -- used for
  // KG-LP/MS-UP's coupled Lunch Main/Starch picks, which draw from the intersection of both
  // sections' pools instead of just this one's. forceInclude, when given, seeds `chosen` with
  // specific items up front, bypassing distinct/no-repeat checks entirely (used for Staff's
  // Main Dish slot, which must always include that day's KG-LP/MS-UP Lunch Main pair verbatim
  // among its 7 choices). Every other rule (composition, distinctAttr, no-repeat scoring) is
  // unchanged either way.
  async _pickItems(sectionId, categoryId, onDate, count, options, excludeIds, sectionCode, categoryCode, overridePool = null, forceInclude = []) {
    const { distinctProtein, distinctAttr, composition } = options;
    const pool = overridePool || await this._eligibleItems(sectionId, categoryId);
    let candidates = pool.filter(c => !excludeIds.has(c.id));

    const repeating = candidates.filter(c => c.is_daily_repeating === 1);
    if (repeating.length && !forceInclude.length) {
      const chosen = repeating.slice(0, count);
      return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name) };
    }

    const chosen = [];
    const usedProteins = new Set();
    const usedAttrValues = new Set();

    // Seed with items forced in from elsewhere -- an intentional, expected duplication (not a
    // pool-scarcity fallback), so these bypass distinct-protein/attr checks and the no-repeat
    // warning entirely.
    for (const c of forceInclude) {
      if (chosen.length >= count) break;
      if (chosen.find(x => x.id === c.id)) continue;
      chosen.push(c);
      if (c.protein_type_id) usedProteins.add(c.protein_type_id);
      if (distinctAttr && c[distinctAttr]) usedAttrValues.add(c[distinctAttr]);
    }
    candidates = candidates.filter(c => !chosen.find(x => x.id === c.id));

    const tryAdd = (c, ignoreConstraints = false) => {
      if (chosen.length >= count) return false;
      if (!ignoreConstraints) {
        if (distinctProtein && c.protein_type_id && usedProteins.has(c.protein_type_id)) return false;
        if (distinctAttr && c[distinctAttr] && usedAttrValues.has(c[distinctAttr])) return false;
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
    const remaining = candidates.filter(c => !chosen.find(x => x.id === c.id));
    const scored = this._scoreAndSort(sectionId, remaining, onDate);
    for (const c of scored) {
      if (chosen.length >= count) break;
      tryAdd(c);
    }

    // Step 3: if still short (constraints too strict for the pool), fill regardless
    if (chosen.length < count) {
      for (const c of scored) {
        if (chosen.length >= count) break;
        if (chosen.find(x => x.id === c.id)) continue;
        tryAdd(c, true);
      }
    }

    return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name) };
  }

  // Pure selection: no DB writes. Used both by generate() and by the manual builder's
  // "Fill with suggestions" preview (which must not persist anything on its own).
  async computeMenu(sectionCode, startDate, numWeekdays) {
    this._runUsage = {};
    const sectionId = this._sectionId(sectionCode);
    this._lastUsedMap = await this._loadLastUsedMap(sectionId);
    const slots = SECTION_SLOTS[sectionCode];
    const resultDays = [];

    // KG-LP/MS-UP coupling: load the partner's already-persisted picks for this exact date
    // range (if any), plus the intersected pool + merged history needed to generate fresh
    // when no partner menu exists yet (or it doesn't cover every day of this run).
    const partnerCode = COUPLED_SCHOOL_SECTIONS[sectionCode];
    let coupledPicksByDate = null;
    let coupledPool = null;
    let coupledLastUsedMap = null;
    if (partnerCode) {
      const partnerSectionId = this._sectionId(partnerCode);
      const [picks, lastUsed, poolA, poolB] = await Promise.all([
        this._loadCoupledPartnerPicks(partnerCode, startDate),
        this._loadCoupledLastUsedMap(sectionId, partnerSectionId),
        this._loadSectionItemPool(sectionId),
        this._loadSectionItemPool(partnerSectionId),
      ]);
      coupledPicksByDate = picks;
      coupledLastUsedMap = lastUsed;
      coupledPool = {};
      for (const catCode of COUPLED_LUNCH_CATEGORIES) {
        const catId = this._categoryId(catCode);
        const idsInPartner = new Set(poolB.filter(i => i.category_id === catId).map(i => i.id));
        coupledPool[catCode] = poolA
          .filter(i => i.category_id === catId && idsInPartner.has(i.id))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    // Staff Main Dish must always include that day's KG-LP/MS-UP Lunch Main pair, plus
    // Daycare's own Lunch Main pick. Try both KG-LP/MS-UP source sections (they're forced
    // identical to each other once both exist, so whichever has a persisted menu for this
    // exact date range is fine) and Daycare separately.
    let staffMainSourcePicks = null;
    let staffMainDaycarePicks = null;
    if (sectionCode === 'STAFF') {
      for (const src of STAFF_MAIN_SOURCE_SECTIONS) {
        staffMainSourcePicks = await this._loadCoupledPartnerPicks(src, startDate);
        if (staffMainSourcePicks) break;
      }
      if (!staffMainSourcePicks) {
        this.warnings.push(
          `STAFF: no KG-LP/MS-UP menu found for start date ${isoDate(startDate)} -- ` +
          `Staff Main Dish generated independently, not aligned with the school Lunch Main`
        );
      }

      staffMainDaycarePicks = await this._loadCoupledPartnerPicks(STAFF_MAIN_DAYCARE_SOURCE_SECTION, startDate);
      if (!staffMainDaycarePicks) {
        this.warnings.push(
          `STAFF: no Daycare menu found for start date ${isoDate(startDate)} -- ` +
          `Staff Main Dish generated independently of Daycare's Lunch Main`
        );
      }
    }

    for (const { date, weekday } of schoolDaysFrom(startDate, numWeekdays)) {
      const current = new Date(date);
      const dayUsed = new Set();
      const dayItems = [];

      for (const [catCode, count, options] of slots) {
        const catId = this._categoryId(catCode);
        const isCoupled = partnerCode && COUPLED_LUNCH_CATEGORIES.includes(catCode);
        const partnerPicksForDay = isCoupled && coupledPicksByDate && coupledPicksByDate[date] &&
          coupledPicksByDate[date][catCode];

        let forceInclude = [];
        if (sectionCode === 'STAFF' && catCode === 'STAFF_MAIN') {
          if (staffMainSourcePicks) {
            const dayMains = staffMainSourcePicks[date] && staffMainSourcePicks[date][STAFF_MAIN_SOURCE_CATEGORY];
            if (dayMains && dayMains.length) {
              forceInclude.push(...dayMains);
            } else {
              this.warnings.push(
                `STAFF ${date}: KG-LP/MS-UP menu doesn't cover this date -- Main Dish ` +
                `generated independently of the school Lunch Main for this day`
              );
            }
          }
          if (staffMainDaycarePicks) {
            const dayDaycareMain = staffMainDaycarePicks[date] && staffMainDaycarePicks[date][STAFF_MAIN_SOURCE_CATEGORY];
            if (dayDaycareMain && dayDaycareMain.length) {
              forceInclude.push(dayDaycareMain[0]);
            } else {
              this.warnings.push(
                `STAFF ${date}: Daycare menu doesn't cover this date -- Main Dish generated ` +
                `independently of Daycare's Lunch Main for this day`
              );
            }
          }
        }

        let ids, names;
        if (isCoupled && partnerPicksForDay && partnerPicksForDay.length) {
          // Partner section already generated this exact date range -- copy its picks
          // verbatim so both sections end up identical.
          ids = partnerPicksForDay.map(p => p.id);
          names = partnerPicksForDay.map(p => p.name);
        } else if (isCoupled) {
          if (coupledPicksByDate) {
            this.warnings.push(
              `${sectionCode} ${date}: partner section ${partnerCode}'s matching menu doesn't ` +
              `cover ${catCode} for this date -- generating independently for this day`
            );
          }
          // No partner picks available for this day/category -- generate fresh from the
          // intersected pool, scored against the two sections' merged history so the pick
          // stays fair to whichever section serves it "second" once both are persisted.
          const savedLastUsedMap = this._lastUsedMap;
          this._lastUsedMap = coupledLastUsedMap;
          try {
            ({ ids, names } = await this._pickItems(sectionId, catId, current, count, options,
              dayUsed, sectionCode, catCode, coupledPool[catCode]));
          } finally {
            this._lastUsedMap = savedLastUsedMap;
          }
        } else {
          ({ ids, names } = await this._pickItems(sectionId, catId, current, count, options,
            dayUsed, sectionCode, catCode, null, forceInclude));
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

module.exports = { MenuGenerator, SECTION_SLOTS, eligibleItemsSupabase, sectionItemPoolSupabase, schoolDaysFrom, schoolDayCountBetween };
