#!/usr/bin/env node
// Round trip: menu export -> Menu Ingredients Generator export -> read back (what the Recipe Generator will read).
//
//   npm run test:roundtrip
//
// Builds a real five-section workbook with lib/export.js's own exporter (sample dishes, no database), then checks
// lib/menuIngredients.js end to end and fails (exit 1) when any of these breaks:
//   1. A plain menu export reads every dish back (sheet, category, name, layout, period) and its rows carry NO
//      ingredientsText / allergensText keys -- files without those columns read exactly as before.
//   2. After restructureAndAppendIngredients (the Menu Ingredients export), every row reads back identically, now
//      with the ingredients / allergens written for THAT row (a dish shared by two sections keeps a different
//      value per section; a blank allergens cell reads as '').
//   3. Exporting again from an already-exported file (she re-uploads it to Menu Ingredients) leaves exactly one
//      Ingredients and one Allergens column, with the new values.
//   4. An Ingredients column moved LEFT of the dish column is still never read as the dish column (before the
//      parser named these columns, a left-most tie-break picked it).
//   4c. The export's "Same as" column (who a shared row follows) sits next to full Ingredients text: rows read back
//       unchanged, it is never the dish column, one column after re-exporting, and the Recipe Generator's dishes match.
//   4d. A "Same as" column moved left of the dish column is never read as the dish.
//   4b. A day whose header lost its "Ingredients" label (older exports) still reads its list from the sheet's column.
//   5. Every category the Recipe Generator makes recipes for lands in its category group (lib/recipeCategoryGroups.js)
//      from the label and meal period as they read back from the export -- Staff's "Main Dish" by its period. The
//      school categories carry their REAL printed names ("Lunch Main Course", "Lunch Starch/Side"...).
//   6. The Recipe Generator's dedupeWithinUpload, matching by NAME: Staff Main copies of KG-LP's mains / starches and
//      MS-UP's vegetable merge into those school dishes (Main Course / Sides), Staff's own mains -- matching nothing --
//      are Main Course, Staff Breakfast (shared and own) is AM Snack / Breakfast, a Staff Lunch Box option that is
//      also a Staff main is Main Course, a Staff breakfast that is Daycare's PM Snack is PM Snack, and a dish the
//      school and Staff spell differently keeps the school spelling. Same result with the Staff tab first, and one
//      entry per dish (one AI call each).
//
// Read-only: needs no login and never touches Supabase; its only file goes to a temp directory and is deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { SECTION_SLOTS } = require('../lib/generator');
const { exportCombinedWorkbook, SECTION_DISPLAY_NAMES } = require('../lib/export');
const { loadWorkbookFromBuffer, parseWorkbookDishes, restructureAndAppendIngredients } = require('../lib/menuIngredients');
const { categoryGroupFor } = require('../lib/recipeCategoryGroups');
const { dedupeWithinUpload, resolveSectionFromSheetName, reviewedIngredientsOf } = require('../lib/recipeGenerator');

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

// ---- sample menus, one per section, two school days -------------------------------------------------------
const SCHOOL = ['DAYCARE', 'KG_LP', 'MS_UP'];
const pretty = (code) => code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const BREAKFAST = /MILK|AM_SNACK|FRUIT_BASKET|BREAKFAST|YOGURT/;
const DAYS = [{ menu_date: '2026-10-04', day_of_week: 'Sunday' }, { menu_date: '2026-10-05', day_of_week: 'Monday' }];
// The school category names as the chef's real menus print them (September 2026 files).
const REAL_CATEGORY_NAME = {
  MILK: 'Milk', AM_SNACK: 'AM Snack', LUNCH_BREAD: 'Lunch Bread', LUNCH_MAIN: 'Lunch Main Course', LUNCH_SALAD: 'Lunch SALAD Side',
  SOUP_APPETIZER: 'Soup/Appetizer', JUICE: 'Juice', FRUIT_BAR: 'Fruit Bar', PM_SNACK: 'PM Snack', FRUIT_BASKET: 'Fruit Basket',
  LUNCH_STARCH: 'Lunch Starch/Side', SALAD_BAR: 'Salad Bar', LUNCH_VEGETABLE: 'Lunch Vegetable Side',
};
// The same dish in Daycare's and KG-LP's AM Snack (their shared snack), to check each keeps its own row's value.
const SHARED_SNACK = 'Cheese Croissant';
// The two real edge cases (confirmed with the chef 2026-09-30): a Staff Lunch Box option that is also a Staff main
// (-> Main Course), and a Staff breakfast dish that is Daycare's PM Snack (-> PM Snack, its school counterpart).
const PUMPKIN = 'Pumpkin & Red Beans';
const RICE_PUDDING = 'Rice Pudding Mango';
// KG-LP's soup and Staff's appetizer, the same dish spelled two ways (as in the real week 1): the near-duplicate test
// merges them, and the SCHOOL spelling must be the one kept, whatever the tab order.
const SCHOOL_SPELLING = 'Spring roll';
const STAFF_SPELLING = 'Spring Rolls';

// Every sample dish gets its own made-up two-word name (seeded, so runs repeat): names like "Main dish 1" / "Main dish 2"
// would differ by one letter, and the Recipe Generator's near-duplicate test rightly merges those as one dish.
// NAME_INFO remembers which section and category each name was made for.
const NAME_INFO = new Map();
function madeUpWord(seed) {
  const letters = 'bcdfghklmnprstvzaeiou';
  let x = seed, w = '';
  for (let i = 0; i < 7; i++) { x = (x * 1103515245 + 12345) % 2147483648; w += letters[x % letters.length]; }
  return w[0].toUpperCase() + w.slice(1);
}
let nameSeed = 1;
function ownName(sectionCode, categoryCode, di, k) {
  const key = `${sectionCode}|${categoryCode}|${di}|${k}`;
  for (const [name, info] of NAME_INFO) if (info.key === key) return name;
  const name = `${madeUpWord(nameSeed++ * 7919)} ${madeUpWord(nameSeed++ * 104729)}`;
  NAME_INFO.set(name, { key, section: sectionCode, code: categoryCode });
  return name;
}
// Day di's k-th pick of a category, named the way a real menu repeats dishes: Staff Main carries KG-LP's two mains
// and two starches and MS-UP's vegetable BY NAME, then Staff's own; Staff Breakfast carries Daycare's and MS-UP's AM
// Snacks, then Staff's own four.
function dishName(sectionCode, categoryCode, di, k) {
  if (categoryCode === 'AM_SNACK' && (sectionCode === 'DAYCARE' || sectionCode === 'KG_LP') && di === 0) return SHARED_SNACK;
  if (sectionCode === 'DAYCARE' && categoryCode === 'PM_SNACK' && di === 0) return RICE_PUDDING;
  if (sectionCode === 'STAFF' && categoryCode === 'STAFF_MAIN') {
    if (k < 2) return dishName('KG_LP', 'LUNCH_MAIN', di, k);
    if (k < 4) return dishName('KG_LP', 'LUNCH_STARCH', di, k - 2);
    if (k === 4) return dishName('MS_UP', 'LUNCH_VEGETABLE', di, 0);
    if (k === 6 && di === 1) return PUMPKIN;
  }
  if (sectionCode === 'STAFF' && categoryCode === 'STAFF_BREAKFAST') {
    if (k === 0) return dishName('DAYCARE', 'AM_SNACK', di, 0);
    if (k === 1) return dishName('MS_UP', 'AM_SNACK', di, 0);
    if (k === 2 && di === 1) return RICE_PUDDING;
  }
  if (sectionCode === 'STAFF' && categoryCode === 'STAFF_LUNCHBOX' && k === 1 && di === 0) return PUMPKIN;
  if (sectionCode === 'KG_LP' && categoryCode === 'SOUP_APPETIZER' && di === 0) return SCHOOL_SPELLING;
  if (sectionCode === 'STAFF' && categoryCode === 'STAFF_APPETIZER' && k === 0 && di === 0) return STAFF_SPELLING;
  return ownName(sectionCode, categoryCode, di, k);
}

function sampleMenu(sectionCode) {
  let order = 0;
  const days = DAYS.map((d, di) => ({
    ...d,
    items: SECTION_SLOTS[sectionCode].flatMap(([categoryCode, count], ci) => Array.from({ length: count }, (_, k) => ({
      category_code: categoryCode, category_name: REAL_CATEGORY_NAME[categoryCode] || pretty(categoryCode),
      name: dishName(sectionCode, categoryCode, di, k), is_daily_repeating: 0,
      meal_period_name: BREAKFAST.test(categoryCode) ? 'Breakfast' : 'Lunch',
      period_order: BREAKFAST.test(categoryCode) ? 1 : 2, cat_order: ci, order: order++,
    }))),
  }));
  return { section: { code: sectionCode }, days };
}
const schoolCategoryNames = [...new Set(SCHOOL.flatMap((s) => SECTION_SLOTS[s].map(([c]) => REAL_CATEGORY_NAME[c] || pretty(c))))];

// What the Menu Ingredients screen would hold after review: a value per physical row, different per section.
const ingredientsFor = (r) => `${r.dishName.toLowerCase()} base - olive oil - salt (${r.sheetName})`;
const allergensFor = (r) => (r.rowNumber % 3 === 0 ? '' : 'gluten - dairy');
const dishKey = (r) => [r.sheetName, r.rowNumber, r.date, r.weekday, r.category, r.dishName, r.layout, r.period].join(' | ');

async function reload(workbook) {
  return (await loadWorkbookFromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()))).workbook;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-ingredients-roundtrip-'));
  try {
    // ---- 1. a plain menu export ---------------------------------------------------------------------------
    const order = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
    const file = path.join(tmp, 'menu.xlsx');
    await exportCombinedWorkbook(
      async (code) => sampleMenu(code),
      async (codes) => ({ bySection: Object.fromEntries(codes.map((c) => [c, { categories: Object.fromEntries(SECTION_SLOTS[c].map(([cat]) => [cat, { items: [] }])) }])) }),
      Object.fromEntries(order.map((c) => [c, c])),
      file,
    );
    const { workbook: plainWb } = await loadWorkbookFromBuffer(fs.readFileSync(file));
    const plain = await parseWorkbookDishes(plainWb, schoolCategoryNames);
    // Every section's sheet reads back every dish: one row per pick (CEO: one row per item, both persons in it).
    for (const code of order) {
      const expected = DAYS.length * SECTION_SLOTS[code].reduce((m, [, count]) => m + (code === 'CEO' ? 1 : count), 0);
      const got = plain.rows.filter((r) => r.sheetName === SECTION_DISPLAY_NAMES[code]).length;
      check(got === expected, `plain export: ${code} read ${got} dish rows, expected ${expected}`);
    }
    check(plain.warnings.length === 0, `plain export: ${plain.warnings.length} parser warning(s): ${plain.warnings.join(' / ')}`);
    const schoolSheets = new Set(SCHOOL.map((c) => SECTION_DISPLAY_NAMES[c]));
    check(plain.rows.filter((r) => r.dishName === SHARED_SNACK && schoolSheets.has(r.sheetName)).length === 2, 'plain export: the shared snack should appear once in Daycare and once in KG-LP');
    check(plain.rows.every((r) => !('ingredientsText' in r) && !('allergensText' in r)), 'plain export: rows must not carry ingredientsText / allergensText');

    // ---- 2. the Menu Ingredients export -------------------------------------------------------------------
    const reviewed = plain.rows.map((r) => ({ ...r, ingredients: ingredientsFor(r), allergens: allergensFor(r) }));
    await restructureAndAppendIngredients(plainWb, reviewed, plain.dishColumnBySheet);
    const miWb = await reload(plainWb);
    const back = await parseWorkbookDishes(miWb, schoolCategoryNames);
    check(back.warnings.length === 0, `ingredients export: ${back.warnings.length} parser warning(s): ${back.warnings.join(' / ')}`);
    check(back.rows.length === plain.rows.length, `ingredients export: read ${back.rows.length} rows, the plain export had ${plain.rows.length}`);
    const byKey = new Map(back.rows.map((r) => [dishKey(r), r]));
    for (const r of plain.rows) {
      const b = byKey.get(dishKey(r));
      if (!b) { failures.push(`ingredients export: row changed or lost: ${dishKey(r)}`); continue; }
      check(b.ingredientsText === ingredientsFor(r), `ingredients export: ${dishKey(r)} ingredients "${b.ingredientsText}"`);
      check(b.allergensText === allergensFor(r), `ingredients export: ${dishKey(r)} allergens "${b.allergensText}"`);
    }
    const shared = back.rows.filter((r) => r.dishName === SHARED_SNACK);
    check(shared.length === 3 && new Set(shared.map((r) => r.ingredientsText)).size === 3, 'ingredients export: the shared snack must keep a separate value per section');

    // ---- 3. exported again from the exported file ---------------------------------------------------------
    const again = back.rows.map((r) => ({ ...r, ingredients: `${r.ingredientsText || ''} - v2`, allergens: r.allergensText }));
    await restructureAndAppendIngredients(miWb, again, back.dishColumnBySheet);
    const twiceWb = await reload(miWb);
    for (const sheet of twiceWb.worksheets.filter((s) => s.state !== 'veryHidden' && s.state !== 'hidden')) {
      let ing = 0, all = 0;
      sheet.getRow(1).eachCell((c) => { if (/^ingredients$/i.test(String(c.value))) ing++; if (/^allergens$/i.test(String(c.value))) all++; });
      check(ing === 1 && all === 1, `exported twice: sheet "${sheet.name}" has ${ing} Ingredients and ${all} Allergens columns`);
    }
    const twice = await parseWorkbookDishes(twiceWb, schoolCategoryNames);
    check(twice.rows.length === plain.rows.length && twice.rows.every((r) => (r.ingredientsText || '').endsWith(' - v2')), 'exported twice: rows or values not read back');

    // ---- 4. an Ingredients column left of the dish column -------------------------------------------------
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KG - LP');
    ws.addRow(['Sunday', '04-10-2026', 'Ingredients', '', 'Allergens']);
    ws.addRow(['Lunch', 'Lunch Main Course', 'chicken thighs - freekeh - onion - olive oil', 'Chicken Freekeh', 'gluten']);
    ws.addRow(['Lunch', 'Lunch Starch/Side', 'white rice - vermicelli - butter', 'Vermicelli Rice', 'gluten - dairy']);
    const moved = await parseWorkbookDishes(await reload(wb), schoolCategoryNames);
    check(moved.rows.map((r) => r.dishName).join(',') === 'Chicken Freekeh,Vermicelli Rice', `Ingredients moved left: read dishes "${moved.rows.map((r) => r.dishName).join(', ')}"`);
    check(moved.rows[0] && moved.rows[0].ingredientsText === 'chicken thighs - freekeh - onion - olive oil', 'Ingredients moved left: ingredients not read from their own column');

    // ---- 4c. the "Same as" column (who a shared row follows) next to full Ingredients text --------------------
    {
      const { workbook: wb4 } = await loadWorkbookFromBuffer(fs.readFileSync(file));
      const base = await parseWorkbookDishes(wb4, schoolCategoryNames);
      const withSame = base.rows.map((r, i) => ({ ...r, ingredients: ingredientsFor(r), allergens: allergensFor(r), sameAs: i % 4 === 1 ? `Daycare's ${r.dishName}` : '' }));
      await restructureAndAppendIngredients(wb4, withSame, base.dishColumnBySheet);
      let reread = await reload(wb4);
      const hdr = (sheet) => { const vals = []; sheet.getRow(1).eachCell((c) => vals.push(String(c.value))); return vals; };
      const daycare = reread.getWorksheet(SECTION_DISPLAY_NAMES.DAYCARE);
      check(JSON.stringify(hdr(daycare).slice(-3)) === JSON.stringify(['Ingredients', 'Allergens', 'Same as']), `"Same as" header: ${JSON.stringify(hdr(daycare).slice(-3))}`);
      const p4 = await parseWorkbookDishes(reread, schoolCategoryNames);
      check(p4.rows.length === base.rows.length && p4.rows.every((r, i) => r.dishName === base.rows[i].dishName && r.ingredientsText === ingredientsFor(base.rows[i])),
        '"Same as" column: every row reads back with its dish and its FULL ingredient text');
      // Exported again: still one "Same as" column.
      await restructureAndAppendIngredients(reread, p4.rows.map((r) => ({ ...r, ingredients: r.ingredientsText, allergens: r.allergensText, sameAs: '' })), p4.dishColumnBySheet);
      reread = await reload(reread);
      check(hdr(reread.getWorksheet(SECTION_DISPLAY_NAMES.DAYCARE)).filter((v) => v === 'Same as').length === 1, '"Same as" column: one after exporting twice');
      // The Recipe Generator sees the same dishes with or without the column.
      const toMeta = (rows) => rows.map((r) => ({ ...r, section: resolveSectionFromSheetName(r.sheetName), dayLabel: r.date, categoryGroup: categoryGroupFor({ category: r.category, period: r.period }), reviewedIngredients: reviewedIngredientsOf(r.ingredientsText) }));
      const plainBack = (await parseWorkbookDishes(await reload((await loadWorkbookFromBuffer(fs.readFileSync(file))).workbook), schoolCategoryNames)).rows;
      const noCol = await (async () => { const { workbook: w } = await loadWorkbookFromBuffer(fs.readFileSync(file)); await restructureAndAppendIngredients(w, plainBack.map((r) => ({ ...r, ingredients: ingredientsFor(r), allergens: allergensFor(r) })), base.dishColumnBySheet); return (await parseWorkbookDishes(await reload(w), schoolCategoryNames)).rows; })();
      check(dedupeWithinUpload(toMeta(p4.rows)).length === dedupeWithinUpload(toMeta(noCol)).length, '"Same as" column: the Recipe Generator finds the same dishes with or without it');
    }

    // ---- 4d. a "Same as" column moved LEFT of the dish column is never read as the dish
    {
      const w = new ExcelJS.Workbook();
      const ws2 = w.addWorksheet('MS - UP (B-G)');
      ws2.addRow(['Sunday', '04-10-2026', 'Same as', '', 'Ingredients', 'Allergens']);
      ws2.addRow(['Lunch', 'Lunch Main Course', "KG - LP's Chicken Freekeh", 'Chicken Freekeh', 'chicken thighs - freekeh', 'gluten']);
      ws2.addRow(['Lunch', 'Lunch Starch/Side', "KG - LP's Vermicelli Rice", 'Vermicelli Rice', 'white rice - vermicelli', 'gluten']);
      const pm = await parseWorkbookDishes(await reload(w), schoolCategoryNames);
      check(pm.rows.map((r) => r.dishName).join(',') === 'Chicken Freekeh,Vermicelli Rice', `"Same as" moved left: read dishes "${pm.rows.map((r) => r.dishName).join(', ')}"`);
    }

    // ---- 4b. a day whose header lost its Ingredients label (files exported before the parser read "date + note")
    const legacy = new ExcelJS.Workbook();
    const lw = legacy.addWorksheet('Staff');
    lw.addRow(['MONDAY', '28-09-2026', 'Main Dish', 'Ingredients', 'Allergens']);
    lw.addRow(['Breakfast', 'Main Dish', 'Shakshuka', 'eggs - tomatoes - onion', 'egg']);
    lw.addRow(['TUESDAY', '29-09-2026 Arminian Day', '', 'lavash bread - grilled meat - tomatoes', 'gluten']); // label overwritten
    lw.addRow(['Breakfast', 'Main Dish', 'Crepe with Cottage Cheese', 'all-purpose flour - eggs - milk - cottage cheese', 'gluten - egg - dairy']);
    const lr = await parseWorkbookDishes(await reload(legacy), schoolCategoryNames);
    const tue = lr.rows.find((r) => r.date === '29-09-2026');
    check(tue && tue.dishName === 'Crepe with Cottage Cheese', `legacy day: dish read as "${tue && tue.dishName}"`);
    check(tue && tue.ingredientsText === 'all-purpose flour - eggs - milk - cottage cheese', `legacy day: ingredients "${tue && tue.ingredientsText}" (the sheet's own Ingredients column)`);

    // ---- 5. category groups from what the export says ------------------------------------------------------
    // A row's own label and period -> its group (categories the Recipe Generator skips -- bread, milk, juice, fruit,
    // water, salad bar, CEO -- have none here). Only rows in their own section: Staff's copies of school dishes are
    // check 6's business.
    const EXPECTED_GROUP = {
      AM_SNACK: 'AM_SNACK_BREAKFAST', PM_SNACK: 'PM_SNACK', LUNCH_MAIN: 'MAIN', LUNCH_STARCH: 'SIDES', LUNCH_VEGETABLE: 'SIDES',
      LUNCH_SALAD: 'SALAD', SOUP_APPETIZER: 'SOUP_APPETIZER', STAFF_BREAKFAST: 'AM_SNACK_BREAKFAST', STAFF_APPETIZER: 'SOUP_APPETIZER',
      STAFF_SALAD: 'SALAD', STAFF_MAIN: 'MAIN', STAFF_SWEETS: 'SWEETS', STAFF_LUNCHBOX: 'LUNCH_BOX', STAFF_LUNCHBOX_SALAD: 'LUNCH_BOX',
    };
    const sectionOfRow = (r) => resolveSectionFromSheetName(r.sheetName);
    const codeOfRow = (r) => {
      if (r.dishName === SHARED_SNACK) return SCHOOL.includes(sectionOfRow(r)) ? 'AM_SNACK' : null;
      const info = NAME_INFO.get(r.dishName);
      return info && info.section === sectionOfRow(r) && info.code in EXPECTED_GROUP ? info.code : null;
    };
    let grouped = 0;
    for (const r of back.rows) {
      const code = codeOfRow(r);
      if (!code) continue;
      grouped++;
      const got = categoryGroupFor({ category: r.category, period: r.period });
      check(got === EXPECTED_GROUP[code], `category group: ${code} ("${r.category}", period "${r.period}") -> ${got}, expected ${EXPECTED_GROUP[code]}`);
    }
    check(Object.keys(EXPECTED_GROUP).every((code) => back.rows.some((r) => codeOfRow(r) === code)), 'category group: not every expected category was found in the export');

    // ---- 6. the Recipe Generator's dedup + group, by NAME, whatever the tab order ---------------------------
    // Same steps as main.js prepare-recipe-generation: section from the tab name, group from label + period, then
    // dedupeWithinUpload. Run in file order and with the Staff tab first; both must give one entry per dish (one AI
    // call each) and the same group for every dish, as the chef's rule says.
    const meta = back.rows.map((r) => ({ ...r, section: sectionOfRow(r), dayLabel: `${r.weekday} ${r.date}`, categoryGroup: categoryGroupFor({ category: r.category, period: r.period }) }));
    const staffFirst = [...meta.filter((r) => r.section === 'STAFF'), ...meta.filter((r) => r.section !== 'STAFF')];
    const expectDish = new Map(); // name -> { group, section? }
    for (const di of [0, 1]) {
      for (const k of [0, 1]) expectDish.set(dishName('KG_LP', 'LUNCH_MAIN', di, k), { group: 'MAIN', section: 'KG_LP', category: 'Lunch Main Course' });
      for (const k of [0, 1]) expectDish.set(dishName('KG_LP', 'LUNCH_STARCH', di, k), { group: 'SIDES', section: 'KG_LP', category: 'Lunch Starch/Side' });
      expectDish.set(dishName('MS_UP', 'LUNCH_VEGETABLE', di, 0), { group: 'SIDES', section: 'MS_UP', category: 'Lunch Vegetable Side' });
      expectDish.set(ownName('STAFF', 'STAFF_MAIN', di, 5), { group: 'MAIN', section: 'STAFF', role: true }); // Staff's own, matches nothing
      expectDish.set(dishName('DAYCARE', 'AM_SNACK', di, 0), { group: 'AM_SNACK_BREAKFAST', section: 'DAYCARE', category: 'AM Snack' });
      expectDish.set(dishName('MS_UP', 'AM_SNACK', di, 0), { group: 'AM_SNACK_BREAKFAST', section: 'MS_UP', category: 'AM Snack' });
      expectDish.set(ownName('STAFF', 'STAFF_BREAKFAST', di, 3), { group: 'AM_SNACK_BREAKFAST', section: 'STAFF' }); // Staff's own
    }
    expectDish.set(ownName('STAFF', 'STAFF_MAIN', 0, 6), { group: 'MAIN', section: 'STAFF', role: true });
    expectDish.set(PUMPKIN, { group: 'MAIN', section: 'STAFF', role: true }); // also a Lunch Box option: still a Staff lunch main
    expectDish.set(RICE_PUDDING, { group: 'PM_SNACK', section: 'DAYCARE', category: 'PM Snack' });
    expectDish.set(SCHOOL_SPELLING, { group: 'SOUP_APPETIZER', section: 'KG_LP', category: 'Soup/Appetizer' });
    const results = {};
    for (const [label, rowsIn] of [['file order', meta], ['Staff tab first', staffFirst]]) {
      const unique = dedupeWithinUpload(rowsIn);
      results[label] = unique;
      const names = unique.map((u) => u.name.toLowerCase());
      check(new Set(names).size === names.length, `recipe dedup (${label}): a dish appears twice`);
      for (const [name, want] of expectDish) {
        const u = unique.find((x) => x.name === name);
        if (!u) { failures.push(`recipe dedup (${label}): "${name}" missing`); continue; }
        check(u.categoryGroup === want.group, `recipe dedup (${label}): "${name}" -> ${u.categoryGroup}, expected ${want.group}`);
        check(u.section === want.section, `recipe dedup (${label}): "${name}" kept from ${u.section}, expected ${want.section}`);
        // The kept row (its category text is what the recipe shows and the AI is told) is the school one for a
        // shared dish -- Staff "Main Dish" rows are taken last, whatever the tab order.
        if (want.category) check(u.category === want.category, `recipe dedup (${label}): "${name}" kept category "${u.category}", expected "${want.category}"`);
        // staffMainRole: only a Staff lunch main no student dish claims waits for its main / side decision (made after
        // generation, lib/recipeCategoryGroups.js staffMainGroup); a shared one takes its school dish's group as is.
        check(!!u.staffMainRole === !!want.role, `recipe dedup (${label}): "${name}" staffMainRole ${!!u.staffMainRole}, expected ${!!want.role}`);
      }
    }
    for (const [label, unique] of Object.entries(results)) {
      check(!unique.some((u) => u.name === STAFF_SPELLING), `recipe dedup (${label}): Staff's spelling "${STAFF_SPELLING}" was kept over the school's`);
    }
    // Served-as-is rows never become recipes, whatever each row's own name (Fruit Bar / Basket, Salad Bar, drinks).
    for (const [label, unique] of Object.entries(results)) {
      const leaked = unique.filter((u) => /fruit\s*(bar|basket)|salad\s*bar|beverages/i.test(u.category || ''));
      check(!leaked.length, `recipe dedup (${label}): ${leaked.length} Fruit Bar / Basket / Salad Bar / Beverages row(s) would get a recipe: ${leaked.map((u) => u.name).slice(0, 3).join(', ')}`);
    }
    const a = results['file order'], b = results['Staff tab first'];
    check(a.length === b.length, `recipe dedup: ${a.length} dishes in file order, ${b.length} with the Staff tab first`);
    const groupOf = (list) => new Map(list.map((u) => [u.name, u.categoryGroup]));
    const ga = groupOf(a), gb = groupOf(b);
    check([...ga].every(([n, g]) => gb.get(n) === g), 'recipe dedup: a dish changed group when the Staff tab moved first');

    console.log(`plain export: ${plain.rows.length} dish rows across ${new Set(plain.rows.map((r) => r.sheetName)).size} sheets`);
    console.log(`ingredients export: ${back.rows.length} rows read back with their own ingredients / allergens`);
    console.log(`category groups: ${grouped} rows filed in their expected group`);
    console.log(`recipe dedup: ${results['file order'].length} dishes (one AI call each), same groups with the Staff tab first; ${expectDish.size} named cases checked`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    const byCheck = new Map();
    for (const f of failures) { const k = f.split(':')[0]; byCheck.set(k, (byCheck.get(k) || 0) + 1); }
    console.log(`\nFAILED (${failures.length}): ${[...byCheck].map(([k, n]) => `${k} x${n}`).join('; ')}`);
    console.log(`  ${failures.slice(0, 20).join('\n  ')}${failures.length > 20 ? `\n  ... and ${failures.length - 20} more` : ''}`);
    process.exit(1);
  }
  console.log('\nRound trip OK.');
})().catch((err) => { console.error(err); process.exit(1); });
