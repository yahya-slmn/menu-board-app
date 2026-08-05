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
    ['LUNCH_MAIN', 1, {}], ['LUNCH_VEGETABLE', 1, {}],
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

    const ageGroupIds = getAgeGroupsForSection(sectionId).map(a => a.id);
    if (ageGroupIds.length === 0) { this._itemPoolCache.set(sectionId, []); return []; }

    const { data: portionRows, error: portErr } = await supabase
      .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
    if (portErr) throw supaFail('_loadSectionItemPool: load item_portions', portErr);
    const itemIds = [...new Set(portionRows.map(r => r.item_id))];
    if (itemIds.length === 0) { this._itemPoolCache.set(sectionId, []); return []; }

    const { data: items, error: itemsErr } = await supabase
      .from('menu_items')
      .select('id, name, rc_code, protein_type_id, is_daily_repeating, sauce_type, carb_type, dish_concept, category_id, is_active')
      .eq('is_active', 1)
      .in('id', itemIds);
    if (itemsErr) throw supaFail('_loadSectionItemPool: load menu_items', itemsErr);

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

  async _pickItems(sectionId, categoryId, onDate, count, options, excludeIds, sectionCode, categoryCode) {
    const { distinctProtein, distinctAttr, composition } = options;
    let candidates = (await this._eligibleItems(sectionId, categoryId)).filter(c => !excludeIds.has(c.id));

    const repeating = candidates.filter(c => c.is_daily_repeating === 1);
    if (repeating.length) {
      const chosen = repeating.slice(0, count);
      return { ids: chosen.map(c => c.id), names: chosen.map(c => c.name) };
    }

    const chosen = [];
    const usedProteins = new Set();
    const usedAttrValues = new Set();

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

    for (const { date, weekday } of schoolDaysFrom(startDate, numWeekdays)) {
      const current = new Date(date);
      const dayUsed = new Set();
      const dayItems = [];

      for (const [catCode, count, options] of slots) {
        const catId = this._categoryId(catCode);
        const { ids, names } = await this._pickItems(sectionId, catId, current, count, options,
          dayUsed, sectionCode, catCode);
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
  async persistMenu(sectionCode, label, startDate, resultDays) {
    const sectionId = this._sectionId(sectionCode);
    const slots = SECTION_SLOTS[sectionCode];

    const { data: menuRow, error: menuErr } = await supabase
      .from('generated_menus')
      .insert({
        section_id: sectionId, label, start_date: isoDate(startDate), end_date: isoDate(startDate),
        status: 'DRAFT', created_at: new Date().toISOString(),
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

  async generate(sectionCode, label, startDate, numWeekdays) {
    const { resultDays } = await this.computeMenu(sectionCode, startDate, numWeekdays);
    const menuId = await this.persistMenu(sectionCode, label, startDate, resultDays);
    return { menuId, resultDays };
  }
}

module.exports = { MenuGenerator, SECTION_SLOTS, eligibleItemsSupabase, schoolDaysFrom };
