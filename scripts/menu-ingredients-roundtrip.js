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
//
// Read-only: needs no login and never touches Supabase; its only file goes to a temp directory and is deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { SECTION_SLOTS } = require('../lib/generator');
const { exportCombinedWorkbook, SECTION_DISPLAY_NAMES } = require('../lib/export');
const { loadWorkbookFromBuffer, parseWorkbookDishes, restructureAndAppendIngredients } = require('../lib/menuIngredients');

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

// ---- sample menus, one per section, two school days -------------------------------------------------------
const SCHOOL = ['DAYCARE', 'KG_LP', 'MS_UP'];
const pretty = (code) => code.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
const BREAKFAST = /MILK|AM_SNACK|FRUIT_BASKET|BREAKFAST|YOGURT/;
const DAYS = [{ menu_date: '2026-10-04', day_of_week: 'Sunday' }, { menu_date: '2026-10-05', day_of_week: 'Monday' }];
// The same dish in Daycare's and KG-LP's AM Snack (their shared snack), to check each keeps its own row's value.
const SHARED_SNACK = 'Cheese Croissant';

function sampleMenu(sectionCode) {
  let order = 0;
  const days = DAYS.map((d, di) => ({
    ...d,
    items: SECTION_SLOTS[sectionCode].flatMap(([categoryCode, count], ci) => Array.from({ length: count }, (_, k) => {
      const name = categoryCode === 'AM_SNACK' && sectionCode !== 'MS_UP' && di === 0 ? SHARED_SNACK
        : `${pretty(categoryCode)} dish ${sectionCode.toLowerCase()} day${di + 1} no${k + 1}`;
      return {
        category_code: categoryCode, category_name: pretty(categoryCode), name, is_daily_repeating: 0,
        meal_period_name: BREAKFAST.test(categoryCode) ? 'Breakfast' : 'Lunch',
        period_order: BREAKFAST.test(categoryCode) ? 1 : 2, cat_order: ci, order: order++,
      };
    })),
  }));
  return { section: { code: sectionCode }, days };
}
const schoolCategoryNames = [...new Set(SCHOOL.flatMap((s) => SECTION_SLOTS[s].map(([c]) => pretty(c))))];

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
    check(plain.rows.filter((r) => r.dishName === SHARED_SNACK).length === 2, 'plain export: the shared snack should appear once in Daycare and once in KG-LP');
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
    check(shared.length === 2 && shared[0].ingredientsText !== shared[1].ingredientsText, 'ingredients export: the shared snack must keep a separate value per section');

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
    ws.addRow(['Lunch', 'Lunch Main', 'chicken thighs - freekeh - onion - olive oil', 'Chicken Freekeh', 'gluten']);
    ws.addRow(['Lunch', 'Lunch Starch', 'white rice - vermicelli - butter', 'Vermicelli Rice', 'gluten - dairy']);
    const moved = await parseWorkbookDishes(await reload(wb), schoolCategoryNames);
    check(moved.rows.map((r) => r.dishName).join(',') === 'Chicken Freekeh,Vermicelli Rice', `Ingredients moved left: read dishes "${moved.rows.map((r) => r.dishName).join(', ')}"`);
    check(moved.rows[0] && moved.rows[0].ingredientsText === 'chicken thighs - freekeh - onion - olive oil', 'Ingredients moved left: ingredients not read from their own column');

    console.log(`plain export: ${plain.rows.length} dish rows across ${new Set(plain.rows.map((r) => r.sheetName)).size} sheets`);
    console.log(`ingredients export: ${back.rows.length} rows read back with their own ingredients / allergens`);
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
