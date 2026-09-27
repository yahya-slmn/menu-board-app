// ============================================================
// Dish Catalog import from menu exports (2026-09-25): reads menu .xlsx files this app exported and a
// chef then edited in Excel, finds every dish the Dish Catalog doesn't have yet, and plans adding them.
// PURE: no Supabase. main.js loads the catalog and categories, parses the files
// (lib/menuIngredients.js parseWorkbookDishes) and passes plain data in; the review screen shows the
// plan and apply-catalog-import writes only what the chef ticked.
//
// Matching reuses the Recipe Generator's dedup unchanged (lib/recipeGenerator.js: normalizeDishName +
// same-word-count bigram Dice >= 0.80), against EVERY catalog item -- inactive ones and every category
// included -- so a same-name dish is never created a second time under another category.
//
// A row's section: Staff / CEO by the layout the parser detected, School by the sheet (tab) name, or
// the chef's pick when the tab doesn't say (a single-section export is named after the menu). Its
// category: School by the category label (the category's own name), Staff / CEO by (meal period,
// item label) through the export's own STAFF_ROW_MAP / CEO_ROW_MAP, reversed.
//
// Shared copies: Staff's Lunch "Main Dish" and Breakfast "Main Dish" rows repeat school dishes (the
// export copies KG-LP / MS-UP mains and starches, and Daycare / MS-UP snacks, into Staff). A dish seen
// in a school section is filed by its school rows; its Staff copy adds no category and no Staff section
// (same as the AI Menu Generator's Approve: shared copies don't add Staff portions).
// ============================================================
const { SECTION_SLOTS } = require('./generator');
const { STAFF_ROW_MAP, CEO_ROW_MAP } = require('./export');
const { emptyDishIndex, addNameToIndex, findDuplicateMatch, normalizeDishName, resolveSectionFromSheetName } = require('./recipeGenerator');
const { detectProtein } = require('./classify');
const { snackLunchOnlyHit } = require('./categoryRules');

const SECTION_ORDER = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
const SCHOOL_SECTIONS = new Set(['DAYCARE', 'KG_LP', 'MS_UP']);
// Staff rows that can be copies of a school section's pick (see the header).
const STAFF_SHARED_CODES = new Set(['STAFF_MAIN', 'STAFF_BREAKFAST']);
const OPTION_RE = /^Option (\d+)$/i;
// Labels in older exports that still mean a live category.
const LABEL_ALIASES = { CEO: { 'Lunch|Fruits': 'CEO_FRUITS' } };

const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const inSlots = (section, code) => SECTION_SLOTS[section].some(([c]) => c === code);

// "Lunch|Main Dish" -> code, for the codes the section still generates (a retired row maps to its
// code too, so it can be reported as retired rather than unknown).
function reverseRowMap(map, section) {
  const out = new Map();
  for (const [code, { period, item }] of Object.entries(map)) {
    if (item == null) continue; // Staff Lunch Box: "Option N", handled by position
    const key = `${period}|${item}`;
    if (!out.has(key) || inSlots(section, code)) out.set(key, code);
  }
  for (const [key, code] of Object.entries(LABEL_ALIASES[section] || {})) out.set(key, code);
  return out;
}
const STAFF_LABELS = reverseRowMap(STAFF_ROW_MAP, 'STAFF');
const CEO_LABELS = reverseRowMap(CEO_ROW_MAP, 'CEO');

function dayLabel(row) {
  return [row.weekday, row.date].filter(Boolean).join(' ');
}

// -> { code } or { skip: reason }
function resolveCategory(row, section, categoryCodeByName) {
  const label = tidy(row.category);
  const period = tidy(row.period);
  let code = null;
  if (section === 'STAFF') {
    const opt = label.match(OPTION_RE);
    if (opt) code = Number(opt[1]) <= 2 ? 'STAFF_LUNCHBOX' : 'STAFF_LUNCHBOX_SALAD'; // the export's order: 2 Lunch Box, then the salad
    else if (label === 'Beverages') return { skip: 'Staff beverages are the three fixed daily drinks' };
    else code = STAFF_LABELS.get(`${period}|${label}`) || null;
  } else if (section === 'CEO') {
    code = CEO_LABELS.get(`${period}|${label}`) || null;
  } else {
    code = categoryCodeByName.get(label.toLowerCase()) || null;
  }
  if (!code) return { skip: `unknown category label "${label}"${period && !SCHOOL_SECTIONS.has(section) ? ` under ${period}` : ''}` };
  if (!inSlots(section, code)) return { skip: `"${label}" is no longer on the ${section.replace('_', '-')} menu` };
  return { code };
}

// files: [{ fileName, rows }] (parseWorkbookDishes rows); catalog: [{ id, name, category_code, is_active,
// sections: [code] }]; categories: [{ code, name }] in display order; sectionOverrides: { 'file::sheet': code }.
function planCatalogImport({ files, catalog, categories, sectionOverrides = {} }) {
  const categoryCodeByName = new Map(categories.map(c => [tidy(c.name).toLowerCase(), c.code]));
  const categoryOrder = new Map(categories.map((c, i) => [c.code, i]));
  const categoryName = new Map(categories.map(c => [c.code, c.name]));

  const unresolvedSheets = new Map();
  const skipped = [];
  const occurrences = [];
  let rowsRead = 0;
  for (const { fileName, rows } of files) {
    for (const row of rows) {
      rowsRead++;
      const name = tidy(row.dishName);
      if (!name) continue;
      let section = row.layout === 'STAFF' ? 'STAFF' : row.layout === 'CEO' ? 'CEO' : null;
      if (!section) {
        const key = `${fileName}::${row.sheetName}`;
        section = sectionOverrides[key] || resolveSectionFromSheetName(row.sheetName);
        if (!section || !SCHOOL_SECTIONS.has(section)) {
          if (!sectionOverrides[key]) unresolvedSheets.set(key, { fileName, sheetName: row.sheetName });
          if (!section) continue;
        }
      }
      const cat = resolveCategory(row, section, categoryCodeByName);
      if (cat.skip) { skipped.push({ fileName, sheetName: row.sheetName, day: dayLabel(row), name, reason: cat.skip }); continue; }
      occurrences.push({ name, norm: normalizeDishName(name), section, code: cat.code, fileName, day: dayLabel(row) });
    }
  }

  // The catalog, indexed exactly as the Recipe Generator indexes names.
  const catalogIndex = emptyDishIndex();
  const itemsByNorm = new Map();
  for (const it of catalog) {
    addNameToIndex(catalogIndex, it.name);
    const n = normalizeDishName(it.name);
    if (!itemsByNorm.has(n)) itemsByNorm.set(n, []);
    itemsByNorm.get(n).push(it);
  }

  // New spellings merge only WITHIN a category: across categories a 0.80 name match joined different
  // dishes ("Fresh watermelon slices" as a Snack, "Fresh watermelon juice" as a Juice).
  const newIndexByCode = new Map(); // category code -> name index
  const newByNorm = new Map(); // `${code}|${normalized first spelling}` -> { name, variants, occurrences }
  const similar = new Map();   // file spelling (normalized) -> { name, matchedName, occurrences }
  const notInSection = new Map();
  const alreadyIn = new Set();
  const isSharedCopy = (o) => o.section === 'STAFF' && STAFF_SHARED_CODES.has(o.code);
  const note = (entry, o) => {
    if (!entry.files[o.fileName]) entry.files[o.fileName] = [];
    if (o.day && !entry.files[o.fileName].includes(o.day)) entry.files[o.fileName].push(o.day);
  };

  // Staff's shared copies last, so their school original (possibly from a later file) is grouped first.
  const ordered = [...occurrences.filter(o => !isSharedCopy(o)), ...occurrences.filter(isSharedCopy)];
  for (const o of ordered) {
    const match = findDuplicateMatch(o.name, catalogIndex);
    if (match?.matchType === 'exact') {
      const items = itemsByNorm.get(o.norm) || [];
      if (items.some(it => it.sections.includes(o.section))) { alreadyIn.add(o.norm); continue; }
      const sameCategory = items.find(it => it.category_code === o.code);
      // A Staff Main Dish / Breakfast row naming a school dish is the export's shared copy: nothing to add.
      if (!sameCategory && isSharedCopy(o)) { alreadyIn.add(o.norm); continue; }
      // In the catalog, but not on this section's menu. Same category: offer adding this section to
      // that dish. Another category (e.g. a school Soup/Appetizer used as Staff's own Appetizer): offer
      // a separate catalog dish under this section's category. Both opt-in, off by default.
      const key = sameCategory ? `add:${sameCategory.id}|${o.section}` : `copy:${o.norm}|${o.code}|${o.section}`;
      if (!notInSection.has(key)) {
        const ref = sameCategory || items[0];
        notInSection.set(key, sameCategory
          ? { key, kind: 'addSection', itemId: ref.id, name: ref.name, categoryCode: o.code, categoryName: categoryName.get(o.code) || o.code,
            section: o.section, inSections: ref.sections.slice(), isActive: ref.is_active === 1, files: {} }
          : { key, kind: 'copy', name: o.name, categoryCode: o.code, categoryName: categoryName.get(o.code) || o.code, section: o.section,
            existingCategories: [...new Set(items.map(it => categoryName.get(it.category_code) || it.category_code))], files: {} });
      }
      note(notInSection.get(key), o);
      continue;
    }
    if (match?.matchType === 'similar') {
      if (!similar.has(o.norm)) similar.set(o.norm, { name: o.name, variants: [], matchedName: match.matchedName, occurrences: [] });
      similar.get(o.norm).occurrences.push(o);
      continue;
    }
    // Genuinely new: merge spellings of one new dish ("Whit Rice" / "White Rice") the same way. A Staff
    // shared copy files under its school original's category, so it is looked up across the school ones.
    if (!newIndexByCode.has(o.code)) newIndexByCode.set(o.code, emptyDishIndex());
    let group = null;
    for (const [code, index] of isSharedCopy(o) ? newIndexByCode : [[o.code, newIndexByCode.get(o.code)]]) {
      const same = findDuplicateMatch(o.name, index);
      if (same) { group = newByNorm.get(`${code}|${normalizeDishName(same.matchedName)}`); break; }
    }
    if (!group) {
      group = { name: o.name, variants: [], occurrences: [] };
      newByNorm.set(`${o.code}|${o.norm}`, group);
      addNameToIndex(newIndexByCode.get(o.code), o.name);
    } else if (o.name !== group.name && !group.variants.includes(o.name)) {
      group.variants.push(o.name);
    }
    group.occurrences.push(o);
  }

  // One entry per dish PER CATEGORY (a school Soup/Appetizer and Staff's own Appetizer of the same
  // name are two catalog dishes), in the sections where it appeared under that category. Staff's
  // shared Main Dish / Breakfast rows are dropped when the dish also appears in a school section.
  const place = (group, prefix) => {
    const hasSchool = group.occurrences.some(o => SCHOOL_SECTIONS.has(o.section));
    const own = hasSchool ? group.occurrences.filter(o => !isSharedCopy(o)) : group.occurrences;
    const codes = [...new Set(own.map(o => o.code))];
    return codes.map((categoryCode) => {
      const occ = own.filter(o => o.code === categoryCode);
      const entry = { key: `${prefix}:${normalizeDishName(group.name)}:${categoryCode}`, name: group.name, variants: group.variants,
        categoryCode, categoryName: categoryName.get(categoryCode) || categoryCode,
        sections: SECTION_ORDER.filter(sec => occ.some(o => o.section === sec)), files: {}, seen: occ.length };
      occ.forEach(o => note(entry, o));
      // What the review screen may re-file it under: categories on EVERY one of its sections' menus.
      entry.categoryOptions = categories.filter(c => entry.sections.every(sec => inSlots(sec, c.code))).map(c => ({ code: c.code, name: c.name }));
      entry.proteinCode = detectProtein(group.name.toLowerCase());
      entry.snackWarning = !!snackLunchOnlyHit(categoryCode, entry.proteinCode, [['name', group.name]]);
      if (group.matchedName) {
        entry.matchedName = group.matchedName;
        entry.matchedCategories = [...new Set((itemsByNorm.get(normalizeDishName(group.matchedName)) || []).map(it => categoryName.get(it.category_code) || it.category_code))];
      }
      return entry;
    });
  };
  const sortKey = (e) => [SECTION_ORDER.indexOf(e.sections?.[0] ?? e.section), categoryOrder.get(e.categoryCode) ?? 999, e.name.toLowerCase()];
  const bySortKey = (a, b) => { const x = sortKey(a), y = sortKey(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };

  // A name listed under more than one category (the same dish in two rows of the menu, or a school
  // Soup that is also Staff's own Appetizer) -- each row says so, so it isn't added twice by accident.
  const newDishes = [...newByNorm.values()].flatMap(g => place(g, 'new'));
  const categoriesOfName = new Map();
  for (const e of newDishes) {
    const n = normalizeDishName(e.name);
    if (!categoriesOfName.has(n)) categoriesOfName.set(n, []);
    categoriesOfName.get(n).push(e.categoryName);
  }
  for (const e of newDishes) e.alsoListedAs = categoriesOfName.get(normalizeDishName(e.name)).filter(c => c !== e.categoryName);

  return {
    rowsRead,
    newDishes: newDishes.sort(bySortKey),
    similar: [...similar.values()].flatMap(g => place(g, 'similar')).sort(bySortKey),
    notInSection: [...notInSection.values()].sort(bySortKey),
    alreadyInCount: alreadyIn.size,
    unresolvedSheets: [...unresolvedSheets.values()],
    skipped,
  };
}

module.exports = { planCatalogImport, SECTION_ORDER };
