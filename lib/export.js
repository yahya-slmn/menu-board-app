const ExcelJS = require('exceljs');
const Jimp = require('jimp');
const { SECTION_SLOTS, schoolDaysFrom } = require('./generator');

const GREEN = 'FF70AD47';
const YELLOW = 'FFFFFF00';
const GREY = 'FFD9D9D9';
const thinBorder = { style: 'thin', color: { argb: 'FF000000' } };
const thickBorder = { style: 'thick', color: { argb: 'FF000000' } };
const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

// Every date shown anywhere in any export is this exact "DD-MM-YYYY" string, never a native
// Excel date value -- exceljs requires an explicit numFmt on a Date cell or Excel renders the
// raw underlying serial number (this was the "-287860" / "####..." bug in the school sheets).
// A plain string sidesteps numFmt and Excel-locale differences entirely, guaranteeing the same
// format everywhere regardless of the reader's Excel settings or column width. Parses/reads
// with UTC getters since date-only ISO strings ("2026-08-05") parse as UTC midnight -- local
// getters could roll the displayed date back a day in negative-UTC-offset timezones.
function formatDateDDMMYYYY(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Daycare's slot spec (see SECTION_SLOTS) is exactly one item per category -- every row is a
// new category, so a boundary line on every row would be visual noise, not a grouping aid.
const NO_CATEGORY_LINES = new Set(['DAYCARE']);

// Overrides just the top side of a row's cells with a thick border, marking a category-group
// boundary, without disturbing the bottom/left/right sides those cells already have. Spreads
// into a new object each time rather than mutating cell.border in place, since several cells
// share the same `allBorders` object by reference -- mutating it would corrupt every other
// cell that points at it.
function markCategoryBoundary(sheet, rowNum, colStart, colEnd) {
  for (let c = colStart; c <= colEnd; c++) {
    const cell = sheet.getCell(rowNum, c);
    cell.border = { ...cell.border, top: thickBorder };
  }
}

const WEEK_SEPARATOR_FILL = 'FF0070C0';

// Fills an entire spacer row solid blue, marking a school-week boundary -- called on the blank
// row already added right after each day's content, specifically when that day was a Thursday
// (SCHOOL_WEEKDAYS in lib/generator.js is Sun-Thu, so Thursday is always the last school day of
// a week). Every other day's spacer row stays blank as before; only visually meaningful when a
// menu spans more than one week.
function fillWeekSeparatorRow(row, colStart, colEnd) {
  for (let c = colStart; c <= colEnd; c++) {
    fillCell(row.getCell(c), WEEK_SEPARATOR_FILL);
  }
}

// Hardcoded per-category display labels for CEO and Staff's two-column (meal period, item
// type) layout. Hardcoded rather than derived from the DB's category name (e.g. stripping a
// "CEO "/"Staff " prefix) because the desired wording ("Main Dish", "Juice", "Salad", ...)
// doesn't match that format closely enough for a mechanical string transform -- these are
// exact labels, keyed by the same category codes SECTION_SLOTS.CEO/STAFF already declare, in
// the same order, so iterating Object.keys() below naturally produces Breakfast-then-Lunch
// (then Lunch Box for Staff) grouping without depending on the DB's own sort_order.
// CEO v2 (2026-09-25, the "September week_04" layout): CEO_RAW_VEG is no longer generated but stays
// here so an old menu re-exports its Raw Veg row as served; CEO_FRUITS is the Snack category (renamed,
// code kept), so an old menu's Fruits row now reads "Snack" too.
const CEO_ROW_MAP = {
  CEO_BREAKFAST_MAIN: { period: 'Breakfast', item: 'Main Dish' },
  CEO_RAW_VEG: { period: 'Breakfast', item: 'Raw Veg' }, // old menus only
  CEO_BREAKFAST_JUICE: { period: 'Breakfast', item: 'Juice' },
  CEO_YOGURT: { period: 'Breakfast', item: 'Yogurt' },
  CEO_LUNCH_MAIN: { period: 'Lunch', item: 'Main Dish' },
  CEO_SALAD: { period: 'Lunch', item: 'Salad' },
  CEO_LUNCH_JUICE: { period: 'Lunch', item: 'Juice' },
  CEO_FRUITS: { period: 'Lunch', item: 'Snack' },
  CEO_BREAD: { period: 'Lunch', item: 'Bread' },
};
// Lunch's "Protein" row: a second LABEL beside the Lunch Main Dish, whose dish cells are merged down
// over it (one dish, two labels). Not a category, slot or pick -- nothing else knows it exists except
// the parser (lib/menuIngredients.js skips it as the Main Dish's continuation).
const CEO_PROTEIN_ROW_OF = 'CEO_LUNCH_MAIN';
const CEO_PROTEIN_LABEL = 'Protein';
const CEO_FONT = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };

// Fixed, non-editable person columns for the CEO sheet -- both show identical content except
// CEO_BREAD_CODE, which CEO_BREAD_EXCLUDED_PERSON never gets (left entirely blank: no value,
// no RC, no dropdown).
// Shared with the parser (lib/menuLayout.js), which recognises a CEO sheet by these header names.
const { CEO_PERSONS } = require('./menuLayout');
const CEO_BREAD_CODE = 'CEO_BREAD';
const CEO_BREAD_EXCLUDED_PERSON = 'Dr Steffen';

// Staff's Lunch Box item label isn't a fixed word per category -- it's "Option 1/2/3" by
// position among the 3 Lunch Box rows (2 from STAFF_LUNCHBOX + 1 from STAFF_LUNCHBOX_SALAD),
// so its map entries use item: null as a marker and the row-building loop numbers them instead.
const STAFF_ROW_MAP = {
  STAFF_BREAKFAST: { period: 'Breakfast', item: 'Main Dish' },
  STAFF_BREAKFAST_JUICE: { period: 'Breakfast', item: 'Juice' },
  STAFF_APPETIZER: { period: 'Lunch', item: 'Appetizer' },
  STAFF_SALAD: { period: 'Lunch', item: 'Salad' },
  STAFF_MAIN: { period: 'Lunch', item: 'Main Dish' },
  STAFF_SWEETS: { period: 'Lunch', item: 'Sweets' },
  STAFF_BREAD: { period: 'Lunch', item: 'Bread' },
  // Old saved menus, re-exported from History (confirmed with the chef 2026-09-24): their single
  // rotating STAFF_JUICE row prints under the same "Beverages" heading as today's fixed drinks,
  // and STAFF_FRUIT_BASKET (removed from Staff lunch) has NO entry here, so an old menu's Fruit
  // Basket row is left out of the file. The saved menu data itself is never changed.
  STAFF_JUICE: { period: 'Lunch', item: 'Beverages' },
  // The three fixed drinks share ONE "Beverages" label (merged across their rows like any other
  // repeated item label).
  STAFF_WATER: { period: 'Lunch', item: 'Beverages' },
  STAFF_SOFT_DRINK: { period: 'Lunch', item: 'Beverages' },
  STAFF_FRESH_JUICE: { period: 'Lunch', item: 'Beverages' },
  STAFF_LUNCHBOX: { period: 'Lunch Box', item: null },
  STAFF_LUNCHBOX_SALAD: { period: 'Lunch Box', item: null },
};
const centerMiddle = { horizontal: 'center', vertical: 'middle', wrapText: true };

function fillCell(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ============================================================
// School sections (Daycare / KG-LP / MS-UP) -- Meal Period | Category | Item Name, nothing else.
// The RC column and the one plain Quantity column ("150g", "05 option") were removed on
// 2026-09-24 at the chef's request -- the school handles portioning itself and this export is just
// the menu; RC stays as in-app Dish Catalog data. (The per-age-group headcount columns went earlier.)
// ============================================================
// exportData comes from main.js's fetchGeneratedMenuExportData(): { section, ageGroups,
// days: [{ id, menu_date, day_of_week, items: [{item_id, name, rc_code, is_daily_repeating,
// category_name, category_code, meal_period_name, period_order, cat_order}] }], getPortion }
// -- all of it lives in Supabase now (generated_menus/menu_days/menu_day_items/menu_items/
// item_portions as tables; sections/age_groups/categories/meal_periods via the cached
// lib/referenceData.js accessors), pre-joined into this shape asynchronously before this
// (still fully synchronous) builder runs.
// The day's weekday header cell: "TUESDAY", or on an AI Menu Generator National Day Tuesday
// "TUESDAY · ARMENIAN DAY" (day.theme, set by main.js only for menus of an approved AI run).
// lib/menuIngredients.js reads the weekday back as the text before NATIONAL_DAY_SEPARATOR.
const NATIONAL_DAY_SEPARATOR = ' · ';
function weekdayHeaderText(day) {
  const weekday = day.day_of_week.toUpperCase();
  return day.theme ? `${weekday}${NATIONAL_DAY_SEPARATOR}${String(day.theme).toUpperCase()} DAY` : weekday;
}

function buildSchoolSheet(workbook, exportData, sheetName) {
  const { section, days } = exportData;

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  // Columns: 1=Meal Period, 2=Category, 3=Item Name. No RC and no quantity column (removed
  // 2026-09-24 at the chef's request: the school handles portioning; the export is just the menu).
  // lib/menuIngredients.js reads this layout back by its date + weekday header and category words.
  // The weekday column is wider only when a National Day label has to fit ("TUESDAY · JORDANIAN
  // DAY" at 14 pt bold); every other sheet keeps its width.
  const weekdayWidth = days.some(d => d.theme) ? 34 : 20;
  sheet.columns = [{ width: 16 }, { width: weekdayWidth }, { width: 60 }];
  const totalCols = 3;

  for (const day of days) {
    const items = day.items.slice().sort((a, b) => (a.period_order - b.period_order) || (a.cat_order - b.cat_order));

    const headerRow = sheet.addRow([formatDateDDMMYYYY(day.menu_date), weekdayHeaderText(day), '']);
    headerRow.height = 26;
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = allBorders;
      cell.alignment = centerMiddle;
      if (colNumber === 2) {
        fillCell(cell, YELLOW);
        cell.font = { name: 'Calibri', size: 14, bold: true };
      } else {
        fillCell(cell, GREEN);
        cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      }
    });

    const startRow = sheet.rowCount + 1;
    let categoryRunStart = null, lastCategory = null, lastPeriod = null, periodRunStart = null;

    items.forEach((it, idx) => {
      const row = sheet.addRow(['', it.category_name, it.name]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 2) fillCell(cell, GREY);
      });
      // Dish-name dropdown (same category's items) so the file can still be edited in Excel.
      if (it.is_daily_repeating !== 1) {
        row.getCell(3).dataValidation = { ...VALIDATION_STYLE, formulae: [definedNameFor(section.code, it.category_code)] };
      }

      const rowNum = row.number;
      if (it.category_name !== lastCategory) {
        if (lastCategory !== null) sheet.mergeCells(categoryRunStart, 2, rowNum - 1, 2);
        categoryRunStart = rowNum; lastCategory = it.category_name;
      }
      // Bold boundary at meal-PERIOD changes only (Breakfast -> Lunch -> PM Snack, etc.), not at
      // every category change within the same period -- most School categories hold just 1 item,
      // so bolding on category alone put a thick line after nearly every row. Meal periods group
      // several categories together, so this reads as one clean separator between periods.
      if (it.meal_period_name !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          sheet.getCell(periodRunStart, 1).value = lastPeriod;
          markCategoryBoundary(sheet, rowNum, 1, totalCols);
        }
        periodRunStart = rowNum; lastPeriod = it.meal_period_name;
      }
      if (idx === items.length - 1) {
        sheet.mergeCells(categoryRunStart, 2, rowNum, 2);
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.getCell(periodRunStart, 1).value = lastPeriod;
      }
    });

    for (let r = startRow; r <= sheet.rowCount; r++) {
      const cell = sheet.getCell(r, 1);
      cell.font = { name: 'Calibri', size: 12, bold: true };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    }
    const spacerRow = sheet.addRow([]);
    if (day.day_of_week === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, totalCols);
  }
}

// ============================================================
// Staff (buffet menu) -- Meal Period | Item Type | Item. The RC and Weight/Unit columns were
// removed 2026-09-24 (like every export's RC / quantity), and the per-department order-count
// columns before that, both at the chef's request.
// ============================================================
function buildStaffSheet(workbook, exportData, sheetName) {
  const { days } = exportData;

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  // Columns: 1=Meal Period, 2=Item Type, 3=Item
  sheet.columns = [{ width: 14 }, { width: 18 }, { width: 50 }];
  const totalCols = 3;

  for (const day of days) {
    // Fixed STAFF_ROW_MAP order (Breakfast, then Lunch, then Lunch Box), not the DB's own
    // cat_order -- each category can have several items (e.g. 6 STAFF_BREAKFAST picks), so
    // this flattens all of them per category rather than assuming one row per category.
    const items = Object.keys(STAFF_ROW_MAP).flatMap(code => day.items.filter(it => it.category_code === code));
    const headerRow = sheet.addRow([weekdayHeaderText(day), '', formatDateDDMMYYYY(day.menu_date)]);
    sheet.mergeCells(headerRow.number, 1, headerRow.number, 2);
    headerRow.height = 22;
    headerRow.eachCell({ includeEmpty: true }, cell => {
      fillCell(cell, GREEN);
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    });

    let lastPeriod = null, periodRunStart = null, lunchBoxCounter = 0;
    let lastItemLabel = null, itemRunStart = null;

    items.forEach((it, idx) => {
      const map = STAFF_ROW_MAP[it.category_code];
      let itemLabel = map.item;
      if (map.period === 'Lunch Box') {
        lunchBoxCounter++;
        itemLabel = `Option ${lunchBoxCounter}`;
      }

      const row = sheet.addRow([map.period, itemLabel, it.name]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 11 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
      });
      if (it.is_daily_repeating !== 1) {
        row.getCell(3).dataValidation = { ...VALIDATION_STYLE, formulae: [definedNameFor('STAFF', it.category_code)] };
      }
      const rowNum = row.number;
      if (map.period !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          markCategoryBoundary(sheet, rowNum, 1, totalCols);
        }
        periodRunStart = rowNum; lastPeriod = map.period;
      }
      if (itemLabel !== lastItemLabel) {
        if (lastItemLabel !== null) sheet.mergeCells(itemRunStart, 2, rowNum - 1, 2);
        itemRunStart = rowNum; lastItemLabel = itemLabel;
      }
      if (idx === items.length - 1) {
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.mergeCells(itemRunStart, 2, rowNum, 2);
      }
    });
    const spacerRow = sheet.addRow([]);
    if (day.day_of_week === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, totalCols);
  }
}

// ============================================================
// CEO (personalized executive menu) -- its own separate item
// table entirely, single daily selection
// ============================================================
// Columns: 1=Meal Period, 2=Item Type, 3=Dr Steffen, 4=Khodary (no RC columns since 2026-09-24).
// Layout = the "September week_04" reference (2026-09-25): each day's header is the weekday and date
// (yellow) beside the two person names (green), all black bold; Breakfast (Main Dish, Juice, Yogurt)
// then Lunch (Main Dish + its Protein label, Salad, Juice, Snack, Bread); no blank row between days,
// only the blue week separator after Thursday. Both people get the same dish, except Bread, which
// CEO_BREAD_EXCLUDED_PERSON never gets (blank, no dropdown). Row heights are left to Excel.
// The person names in the header row are how lib/menuIngredients.js recognises CEO.
const CEO_COLUMN_WIDTHS = [{ width: 14 }, { width: 14 }, { width: 56 }, { width: 56 }];

// One day's block. `rows` are in CEO_ROW_MAP order: [{ code, name, list }] -- name '' leaves the cell
// empty (blank template), list is the dropdown's defined name or null (daily item: no dropdown).
function addCeoDay(sheet, { weekday, date }, rows) {
  const headerRow = sheet.addRow([weekday, date, CEO_PERSONS[0], CEO_PERSONS[1]]);
  headerRow.eachCell((cell, colNumber) => {
    fillCell(cell, colNumber <= 2 ? YELLOW : GREEN);
    cell.font = CEO_FONT;
    cell.border = allBorders;
    cell.alignment = centerMiddle;
  });

  const lines = [];
  for (const r of rows) {
    const map = CEO_ROW_MAP[r.code];
    lines.push({ ...r, period: map.period, label: map.item });
    if (r.code === CEO_PROTEIN_ROW_OF) lines.push({ ...r, period: map.period, label: CEO_PROTEIN_LABEL, mirror: true });
  }

  let lastPeriod = null, periodRunStart = null;
  lines.forEach((ln, idx) => {
    const isBreadRow = ln.code === CEO_BREAD_CODE;
    const row = sheet.addRow([ln.period, ln.label, ln.mirror || isBreadRow ? '' : ln.name, ln.mirror ? '' : ln.name]);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = allBorders;
      cell.alignment = centerMiddle;
      cell.font = CEO_FONT;
      if (colNumber === 2) fillCell(cell, GREY);
    });
    const rowNum = row.number;
    if (ln.mirror) {
      // The Main Dish row's two dish cells continue down over the Protein label: one dish, one dropdown.
      sheet.mergeCells(rowNum - 1, 3, rowNum, 3);
      sheet.mergeCells(rowNum - 1, 4, rowNum, 4);
    } else if (ln.list) {
      row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [ln.list] };
      if (!isBreadRow) row.getCell(3).dataValidation = { ...VALIDATION_STYLE, formulae: [ln.list] };
    }

    if (ln.period !== lastPeriod) {
      if (lastPeriod !== null) {
        sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
        markCategoryBoundary(sheet, rowNum, 1, 4);
      }
      periodRunStart = rowNum; lastPeriod = ln.period;
    }
    if (idx === lines.length - 1) sheet.mergeCells(periodRunStart, 1, rowNum, 1);
  });
  if (weekday === 'Thursday') fillWeekSeparatorRow(sheet.addRow([]), 1, 4);
}

function buildCeoSheet(workbook, exportData, sheetName) {
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = CEO_COLUMN_WIDTHS;
  for (const day of exportData.days) {
    // Fixed CEO_ROW_MAP order (Breakfast items, then Lunch items), not the DB's own cat_order.
    const rows = Object.keys(CEO_ROW_MAP)
      .map(code => day.items.find(it => it.category_code === code))
      .filter(Boolean)
      .map(it => ({ code: it.category_code, name: it.name, list: it.is_daily_repeating !== 1 ? definedNameFor('CEO', it.category_code) : null }));
    addCeoDay(sheet, { weekday: day.day_of_week, date: formatDateDDMMYYYY(day.menu_date) }, rows);
  }
}

function definedNameFor(sectionCode, categoryCode) {
  return `List_${sectionCode}_${categoryCode}`;
}

const VALIDATION_STYLE = {
  type: 'list', allowBlank: true, showErrorMessage: true,
  errorTitle: 'Invalid item', error: 'Please choose from the list.',
};

// One row-spec per slot instance (count-many per SECTION_SLOTS entry, or fewer for a
// daily-repeating slot whose eligible pool is smaller than `count` -- see the same
// slice(0, count) quirk in MenuGenerator._pickItems), sorted by each category's real
// (meal period, category) sort_order so a blank template's row order always matches
// what a filled-in export of the same section actually shows.
function buildSlotSpecsFromData(sectionCode, listsData) {
  const { categories } = listsData.bySection[sectionCode];

  const specs = [];
  for (const [categoryCode, count] of SECTION_SLOTS[sectionCode]) {
    const { items, meta } = categories[categoryCode];
    const dailyItems = items.filter(i => i.is_daily_repeating === 1).slice(0, count);
    const isDaily = dailyItems.length > 0;
    const instanceCount = isDaily ? dailyItems.length : count;

    for (let i = 0; i < instanceCount; i++) {
      specs.push({
        categoryCode,
        categoryName: meta.name,
        mealPeriodName: meta.meal_period_name,
        periodSortOrder: meta.meal_period_sort_order,
        catSortOrder: meta.sort_order,
        isDaily,
        dailyItem: isDaily ? dailyItems[i] : null,
        definedName: !isDaily && items.length > 0 ? definedNameFor(sectionCode, categoryCode) : null,
      });
    }
  }
  specs.sort((a, b) => (a.periodSortOrder - b.periodSortOrder) || (a.catSortOrder - b.catSortOrder));
  return specs;
}

function buildSchoolTemplateSheet(workbook, listsData, sectionCode, sheetName, days) {
  const ageGroups = listsData.bySection[sectionCode].ageGroups;
  const specs = buildSlotSpecsFromData(sectionCode, listsData);

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  // Meal Period | Category | Item Name, then one blank "B= L= P=" headcount column per age group for
  // the school to fill in. No RC or GM/ML columns (removed 2026-09-24, like every other export).
  sheet.columns = [{ width: 16 }, { width: 20 }, { width: 60 }, ...ageGroups.map(() => ({ width: 22 }))];
  const totalCols = 3 + ageGroups.length;

  for (const day of days) {
    const headerRow = sheet.addRow([
      formatDateDDMMYYYY(day.date), day.weekday.toUpperCase(), '',
      ...ageGroups.map(ag => `${ag.name} - B= L= P=`),
    ]);
    headerRow.height = 26;
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = allBorders;
      cell.alignment = centerMiddle;
      if (colNumber === 2) {
        fillCell(cell, YELLOW);
        cell.font = { name: 'Calibri', size: 14, bold: true };
      } else {
        fillCell(cell, GREEN);
        cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      }
    });

    const startRow = sheet.rowCount + 1;
    let categoryRunStart = null, lastCategory = null, lastPeriod = null, periodRunStart = null;

    specs.forEach((spec, idx) => {
      const name = spec.isDaily ? spec.dailyItem.name : '';
      const row = sheet.addRow(['', spec.categoryName, name, ...ageGroups.map(() => '')]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 2) fillCell(cell, GREY);
      });
      if (spec.definedName) {
        row.getCell(3).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
      }

      const rowNum = row.number;
      if (spec.categoryName !== lastCategory) {
        if (lastCategory !== null) {
          sheet.mergeCells(categoryRunStart, 2, rowNum - 1, 2);
          if (!NO_CATEGORY_LINES.has(sectionCode)) markCategoryBoundary(sheet, rowNum, 1, totalCols);
        }
        categoryRunStart = rowNum; lastCategory = spec.categoryName;
      }
      if (spec.mealPeriodName !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          sheet.getCell(periodRunStart, 1).value = lastPeriod;
        }
        periodRunStart = rowNum; lastPeriod = spec.mealPeriodName;
      }
      if (idx === specs.length - 1) {
        sheet.mergeCells(categoryRunStart, 2, rowNum, 2);
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.getCell(periodRunStart, 1).value = lastPeriod;
      }
    });

    for (let r = startRow; r <= sheet.rowCount; r++) {
      const cell = sheet.getCell(r, 1);
      cell.font = { name: 'Calibri', size: 12, bold: true };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    }
    const spacerRow = sheet.addRow([]);
    if (day.weekday === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, totalCols);
  }
}

function buildStaffTemplateSheet(workbook, listsData, sectionCode, sheetName, days) {
  const rawSpecs = buildSlotSpecsFromData(sectionCode, listsData);
  // Reorder into STAFF_ROW_MAP's fixed Breakfast/Lunch/Lunch Box order -- buildSlotSpecsFromData
  // sorts by the DB's own (meal_period, category) sort_order by default, which the school
  // template still wants, but this layout needs the same fixed grouping the real export uses.
  const specsByCategory = new Map();
  for (const spec of rawSpecs) {
    if (!specsByCategory.has(spec.categoryCode)) specsByCategory.set(spec.categoryCode, []);
    specsByCategory.get(spec.categoryCode).push(spec);
  }
  const specs = Object.keys(STAFF_ROW_MAP).flatMap(code => specsByCategory.get(code) || []);

  // Meal Period | Item Type | Item, then the blank per-department order-count columns for the
  // school to fill in. No RC or Weight/Unit columns (removed 2026-09-24).
  const DEPARTMENTS = ['Admin', 'LP', 'KG', 'UPB', 'M&SB', 'M&SG', 'UPG'];
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = [{ width: 14 }, { width: 18 }, { width: 50 }, ...DEPARTMENTS.map(() => ({ width: 10 }))];
  const totalCols = 3 + DEPARTMENTS.length;

  for (const day of days) {
    const headerRow = sheet.addRow([day.weekday.toUpperCase(), '', formatDateDDMMYYYY(day.date), ...DEPARTMENTS]);
    sheet.mergeCells(headerRow.number, 1, headerRow.number, 2);
    headerRow.height = 22;
    headerRow.eachCell({ includeEmpty: true }, cell => {
      fillCell(cell, GREEN);
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    });

    let lastPeriod = null, periodRunStart = null, lunchBoxCounter = 0;
    let lastItemLabel = null, itemRunStart = null;

    specs.forEach((spec, idx) => {
      const map = STAFF_ROW_MAP[spec.categoryCode];
      let itemLabel = map.item;
      if (map.period === 'Lunch Box') {
        lunchBoxCounter++;
        itemLabel = `Option ${lunchBoxCounter}`;
      }

      const name = spec.isDaily ? spec.dailyItem.name : '';
      const row = sheet.addRow([map.period, itemLabel, name, ...DEPARTMENTS.map(() => '')]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 11 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
      });
      if (spec.definedName) {
        row.getCell(3).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
      }

      const rowNum = row.number;
      if (map.period !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          markCategoryBoundary(sheet, rowNum, 1, totalCols);
        }
        periodRunStart = rowNum; lastPeriod = map.period;
      }
      if (itemLabel !== lastItemLabel) {
        if (lastItemLabel !== null) sheet.mergeCells(itemRunStart, 2, rowNum - 1, 2);
        itemRunStart = rowNum; lastItemLabel = itemLabel;
      }
      if (idx === specs.length - 1) {
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.mergeCells(itemRunStart, 2, rowNum, 2);
      }
    });
    const spacerRow = sheet.addRow([]);
    if (day.weekday === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, totalCols);
  }
}

function buildCeoTemplateSheet(workbook, listsData, sectionCode, sheetName, days) {
  const rawSpecs = buildSlotSpecsFromData(sectionCode, listsData);
  const specsByCategory = new Map();
  for (const spec of rawSpecs) {
    if (!specsByCategory.has(spec.categoryCode)) specsByCategory.set(spec.categoryCode, []);
    specsByCategory.get(spec.categoryCode).push(spec);
  }
  const rows = Object.keys(CEO_ROW_MAP).flatMap(code => specsByCategory.get(code) || [])
    .map(spec => ({ code: spec.categoryCode, name: spec.isDaily ? spec.dailyItem.name : '', list: spec.definedName }));

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = CEO_COLUMN_WIDTHS;
  for (const day of days) addCeoDay(sheet, { weekday: day.weekday, date: formatDateDDMMYYYY(day.date) }, rows);
}

const TEMPLATE_BUILDERS = {
  DAYCARE: buildSchoolTemplateSheet,
  KG_LP: buildSchoolTemplateSheet,
  MS_UP: buildSchoolTemplateSheet,
  STAFF: buildStaffTemplateSheet,
  CEO: buildCeoTemplateSheet,
};

// A1-style column letter, kept local rather than reaching into exceljs internals.
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Hidden helper sheet: one column of dish NAMES per category+section that needs a dropdown, named
// `List_*` for the dropdown's validation list. (It also carried RC and quantity lookup columns until
// 2026-09-24; no export shows RC or quantities any more, so neither is written here.)
// Shared by every export that needs named-range dropdowns: single/combined real menu exports and
// the Blank Menu template alike. listsData comes from main.js's fetchListsSheetData():
// { bySection: { [sectionCode]: { ageGroups: [{id,name}], categories: { [categoryCode]: { items:
// [{id,name,rc_code,is_daily_repeating}], meta } } } }, getPortion }
function buildListsSheetFromData(workbook, order, listsData) {
  const listsSheet = workbook.addWorksheet('_Lists', { state: 'veryHidden' });
  const { bySection } = listsData;

  let col = 1;
  const registered = new Set();
  for (const sectionCode of order) {
    const { categories } = bySection[sectionCode];

    for (const [categoryCode] of SECTION_SLOTS[sectionCode]) {
      const key = `${sectionCode}:${categoryCode}`;
      if (registered.has(key)) continue;
      registered.add(key);

      const items = categories[categoryCode].items;
      const isDaily = items.some(i => i.is_daily_repeating === 1);
      if (isDaily || items.length === 0) continue; // pre-filled or no options -- no dropdown needed

      items.forEach((it, i) => { listsSheet.getCell(i + 1, col).value = it.name; });
      const colL = colLetter(col);
      workbook.definedNames.add(`'_Lists'!$${colL}$1:$${colL}$${items.length}`, definedNameFor(sectionCode, categoryCode));
      col += 1;
    }
  }
}

// fetchListsData(sectionCodes) -> Promise<listsData>, the same Supabase-backed fetcher
// main.js passes to exportSingleMenu/exportCombinedWorkbook (Stage 4) -- menu_items/
// item_portions live in Supabase, so the template's item pools come from there too now.
// Removes any dish-name dropdown whose list was never created, just before a menu workbook is saved.
// _Lists only gets a range for a category that is still in SECTION_SLOTS and still has active dishes,
// but a saved menu can hold a row whose category has since left the menu shape (CEO Raw Veg, Staff's
// old single Juice) or whose dishes were all deactivated -- its dropdown would point at nothing.
function dropDanglingDropdowns(workbook) {
  const defined = new Set(workbook.definedNames.model.map(n => n.name));
  for (const sheet of workbook.worksheets) {
    const validations = sheet.dataValidations.model;
    for (const [address, v] of Object.entries(validations)) {
      if (v.type === 'list' && (v.formulae || []).some(f => !defined.has(f))) delete validations[address];
    }
  }
}

async function exportBlankTemplateWorkbook(fetchListsData, startDate, numWeekdays, savePath) {
  const workbook = new ExcelJS.Workbook();
  const order = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
  const days = schoolDaysFrom(startDate, numWeekdays);

  // Named ranges instead of inline lists, avoiding Excel's inline-list length limits and
  // sidestepping comma/quote escaping in item names.
  const listsData = await fetchListsData(order);
  buildListsSheetFromData(workbook, order, listsData);

  for (const sectionCode of order) {
    const builder = TEMPLATE_BUILDERS[sectionCode];
    builder(workbook, listsData, sectionCode, SECTION_DISPLAY_NAMES[sectionCode], days);
  }

  dropDanglingDropdowns(workbook);
  await workbook.xlsx.writeFile(savePath);
}

const SECTION_BUILDERS = {
  DAYCARE: buildSchoolSheet,
  KG_LP: buildSchoolSheet,
  MS_UP: buildSchoolSheet,
  STAFF: buildStaffSheet,
  CEO: buildCeoSheet,
};

const SECTION_DISPLAY_NAMES = {
  DAYCARE: 'Daycare',
  KG_LP: 'KG - LP',
  MS_UP: 'MS - UP (B-G)',
  STAFF: 'Staff',
  CEO: 'CEO',
};

// fetchExportData(generatedMenuId) -> Promise<exportData for buildSchoolSheet/etc>
// fetchListsData(sectionCodes) -> Promise<listsData for buildListsSheetFromData>
// Both supplied by main.js, which owns the Supabase client and the cached reference-data
// lookups -- keeps this module DB-agnostic, same pattern as exportRecipes (Stage 3).
async function exportSingleMenu(fetchExportData, fetchListsData, generatedMenuId, savePath) {
  const exportData = await fetchExportData(generatedMenuId);
  const workbook = new ExcelJS.Workbook();
  const listsData = await fetchListsData([exportData.section.code]);
  buildListsSheetFromData(workbook, [exportData.section.code], listsData);
  const builder = SECTION_BUILDERS[exportData.section.code] || buildSchoolSheet;
  builder(workbook, exportData, exportData.menu.label);
  dropDanglingDropdowns(workbook);
  await workbook.xlsx.writeFile(savePath);
}

async function exportCombinedWorkbook(fetchExportData, fetchListsData, menuIdsBySection, savePath) {
  const workbook = new ExcelJS.Workbook();
  const order = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
  const presentOrder = order.filter(sectionCode => menuIdsBySection[sectionCode]);
  const listsData = await fetchListsData(presentOrder);
  buildListsSheetFromData(workbook, presentOrder, listsData);
  for (const sectionCode of presentOrder) {
    const generatedMenuId = menuIdsBySection[sectionCode];
    const exportData = await fetchExportData(generatedMenuId);
    const builder = SECTION_BUILDERS[sectionCode];
    builder(workbook, exportData, SECTION_DISPLAY_NAMES[sectionCode]);
  }
  dropDanglingDropdowns(workbook);
  await workbook.xlsx.writeFile(savePath);
}

// ============================================================
// Recipe Book -- one recipe per sheet, cloned field-for-field and
// style-for-style from the company's real recipe card template
// (Downloads/"beef steak mushroom sauce.xlsx", sheet "RECIPE
// SPECIFICATION"): Times New Roman throughout, double/thin/hair
// border conventions, exact label wording and merge layout,
// including quirks like the unlabeled Date/Yield cells and the
// Category/Prepared-By labels being concatenated into their value
// cell -- reproduced as-is since this needs to match the company
// standard exactly, not a cleaned-up version of it.
//
// Row/column layout mirrors the template 1:1 (RECIPE FOR / Quantity
// Produced / Prepared By / Category / Country-Origin / Yield header
// block, INGREDIENTS table, Preparation and Cooking, an empty Photo
// placeholder beside Presentation/Decoration/Serving, then Comment /
// Checked By), except the ingredient rows and the Preparation/
// Presentation blocks size themselves to the actual recipe data
// instead of the template's fixed print-form blank rows, since these
// are generated digital records, not blank forms to fill in by hand.
// A small TTY-code line is added under the header block (not present
// in the original template) since the code is central to how the app
// tracks recipes.
// ============================================================
const RECIPE_FONT = 'Times New Roman';
const recipeDoubleBorder = { style: 'double', color: { argb: 'FF000000' } };
const recipeHairBorder = { style: 'hair', color: { argb: 'FF000000' } };
const recipeMediumBorder = { style: 'medium', color: { argb: 'FF000000' } };
const recipeThickBorder = { style: 'thick', color: { argb: 'FF000000' } };
const RECIPE_SECTION_FILL = 'FFDCE6DC'; // light sage, matches the app's --sage accent
const RECIPE_PHOTO_FILL = 'FFF2F2F2';   // very light grey for the empty photo placeholder

// Excel forbids \ / ? * [ ] : in sheet names and caps them at 31 chars.
function sanitizeSheetName(name) {
  const cleaned = (name || 'Recipe').replace(/[\\/?*[\]:]/g, '').trim();
  return (cleaned || 'Recipe').slice(0, 31);
}

// RTL is now determined by the chosen EXPORT language, not by scanning the recipe's own text --
// stored recipe content is always English since extraction dropped its language picker (see
// conversation notes), so scanning text for RTL script would never fire again. Every builder
// below that used to call the old content-scanning isRtlRecipe() now takes the export's
// targetLanguage and checks it against this fixed list instead; names match EXTRACT_LANGUAGES'
// wording in renderer.js (kept in sync by hand -- there are only 4 entries, low drift risk).
const RTL_LANGUAGES = new Set(['Arabic', 'Hebrew', 'Persian (Farsi)', 'Urdu']);
function isRtlLanguage(targetLanguage) {
  return RTL_LANGUAGES.has(targetLanguage);
}

// Row-height calculation for merged, wrapped text cells (Comment, Method blocks, per-field
// rows, etc. across all 3 builders below). Excel's own row-height "AutoFit on wrap" does NOT
// apply to merged cells -- confirmed directly by inspecting a generated file: every such row
// came back with height left unset (Excel's own single-line default), regardless of how long
// the actual wrapped text was. There's no way to get true glyph metrics without an actual
// font-rendering engine, so this is a calibrated estimate, not exact math -- deliberately erring
// wide (fewer estimated characters per line, i.e. more estimated lines) rather than narrow,
// since undershooting clips text and overshooting just leaves a little extra blank space.

// Excel's own column-width unit -> pixels: ~7px per unit plus 5px of fixed cell padding, the
// same approximation openpyxl and most Excel-file tooling use (calibrated against Calibri 11,
// this workbook's implicit default font).
function excelColWidthToPixels(width) {
  return width * 7 + 5;
}

// Total pixel width of a cell merged across sheet.columns[startCol..endCol] (0-indexed,
// inclusive) -- summed per-column (each column's own padding applies), not "total width, then
// convert once".
function mergedWidthPx(sheet, startCol, endCol) {
  let px = 0;
  for (let c = startCol; c <= endCol; c++) {
    px += excelColWidthToPixels(sheet.columns[c].width);
  }
  return px;
}

// ~0.52em is a standard rule-of-thumb average glyph width for normal-weight proportional Latin/
// Arabic text at typical sizes (Calibri and similar fonts) -- not exact for any specific string,
// but a reasonable, consistently-conservative estimate across this app's font sizes (11-16pt).
function estimateCharWidthPx(fontSize) {
  return fontSize * 0.52;
}

// Estimates how many wrapped lines `text` needs inside a cell of `widthPx` pixels at `fontSize`,
// then converts that to an Excel row height in points. Existing `\n` line breaks wrap
// independently (each forces a new line regardless of remaining width); an empty/blank string
// still gets a real height (never fewer than 1 line) since a cell always needs its base line
// height even with nothing in it yet.
function estimateWrappedRowHeight(text, widthPx, fontSize) {
  const charWidthPx = estimateCharWidthPx(fontSize);
  const charsPerLine = Math.max(1, Math.floor(widthPx / charWidthPx));
  const paragraphs = (text || '').split('\n');
  let totalLines = 0;
  for (const p of paragraphs) {
    totalLines += Math.max(1, Math.ceil(p.length / charsPerLine));
  }
  // ~1.3x the font's point size per line is a standard single-line-height approximation
  // (leading/spacing, not just glyph height), plus a little fixed padding so a single short
  // line doesn't come out visually cramped against the cell border.
  const lineHeightPt = fontSize * 1.3;
  return Math.max(20, Math.ceil(totalLines * lineHeightPt) + 4);
}

// ---- Shared pure content-shaping helpers ----------------------------------------------------
// Used by both the Excel builders below (buildRecipeSheet/buildRecipePhotosSheet) and the
// preview content-model builder (buildRecipeContentModel) -- so a numbering/rounding/label
// decision can never drift between what the real .xlsx export shows and what the in-app
// "preview export" modal shows for the same recipe.

// Splits free text into trimmed, non-empty lines -- used for Preparation/Method/Presentation
// blocks across all three builders. An empty/blank string yields an empty array.
function splitLines(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean);
}

// Sums an ingredient list's raw quantity numbers regardless of unit (120 GR + 5 PC = 125, since
// units aren't commensurable and every caller wants a plain numeric total, not a conversion),
// rounded to 2dp to avoid floating-point noise (0.1 + 0.2 -> 0.30000000000000004). `field`
// defaults to 'quantity' (every existing caller) -- the Calculator's own "Include Original
// Quantity column" export toggle also sums the same list's 'original_quantity' field, to compute
// the Original-basis counterpart of Total Quantity/Net Weight (see computeProcessTotals).
function sumQuantities(ingredients, field = 'quantity') {
  const raw = (ingredients || []).reduce((sum, ing) => {
    const q = typeof ing[field] === 'number' ? ing[field] : parseFloat(ing[field]);
    return isNaN(q) ? sum : sum + q;
  }, 0);
  return Math.round(raw * 100) / 100;
}

// One extracted-recipe process's own Total Quantity/Net Weight (Waste % applied) -- same
// arithmetic as the form's live per-process calc (updateProcessNetWeight in renderer.js).
// Each applied waste type is compounded sequentially, not summed -- Qty x (1-w1%) x (1-w2%) x
// ... -- confirmed with the chef. This is mathematically order-independent (multiplication
// commutes), so `proc.wastes`'s own order only matters for display, not for this result.
function compoundNetWeight(total, wastes) {
  return (wastes || []).reduce((acc, w) => {
    const pct = w.percent != null ? Math.min(Math.max(w.percent, 0), 100) : 0;
    return acc * (1 - pct / 100);
  }, total);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Per-waste breakdown for display: how much THIS waste removed (against the running total right
// before it, not the original Total Quantity) and what's left running into the next one --
// mirrors renderer.js's own computeWasteWaterfall (same formula, independent copy since the
// renderer and this main-process file are different JS environments with no shared module). Each
// row's `after` is computed fresh from the raw, unrounded `total` via compoundNetWeight(total,
// wastes.slice(0, i+1)), rounding only once per call -- exactly like computeProcessTotals' own
// single rounding of the real Net Weight -- rather than chaining through previously-ROUNDED
// `after` values, which can drift from the real Net Weight by a hundredth of a gram once there
// are 3+ wastes. So the LAST row's `after` here is always bit-for-bit the same number
// computeProcessTotals(proc).netWeight produces -- feeds both the export preview modal
// (buildRecipeContentModel below) and the real .xlsx (buildRecipeSheet), so those two can never
// show different numbers from each other or from the real Net Weight.
function computeWasteWaterfall(total, wastes) {
  const list = wastes || [];
  const rows = [];
  let before = round2(total);
  for (let i = 0; i < list.length; i++) {
    const after = round2(compoundNetWeight(total, list.slice(0, i + 1)));
    rows.push({ before, after, reduced: round2(before - after) });
    before = after;
  }
  return rows;
}

// `field` mirrors sumQuantities' own -- defaults to 'quantity' (the scaled/as-exported basis
// every existing caller wants); pass 'original_quantity' to get the same process's Original-basis
// Total Quantity/Net Weight instead, with the same waste percentages applied (waste % is a
// process-level property, invariant to scale, so it applies the same way to either basis).
function computeProcessTotals(proc, field = 'quantity') {
  const total = sumQuantities(proc.ingredients, field);
  const netWeight = Math.round(compoundNetWeight(total, proc.wastes) * 100) / 100;
  return { total, netWeight };
}

// Rounds a RECIPE-LEVEL combined figure (buildRecipeSheet's own combinedTotalQuantity/
// combinedNetWeight) to 1 decimal place for display -- summing several already-rounded
// per-process totals (each already rounded to 2dp by sumQuantities/computeProcessTotals above)
// can still reintroduce floating-point noise past those 2dp purely from the addition itself
// (e.g. 1050 + 800 landing on 1850.0000000000002, or 1875 - 25 landing on 1849.9999999999998,
// since most decimals have no exact binary representation) -- confirmed by inspecting a
// generated file directly, showing as "12433.199999999999 g". Deliberately coarser (1dp, not the
// 2dp those per-process figures use) since this is a second, compounding rounding on top of
// values that are already individually rounded. `Number`'s own default string conversion already
// drops a trailing ".0" (1850, not 1850.0), so no separate whole-number formatting is needed here.
function roundForDisplay(n) {
  return Math.round(n * 10) / 10;
}

// Excel number format for an ingredient quantity cell: one decimal place, two under 0.1 g (a pinch of spice must not read 0),
// none for a whole number. Only the FORMAT changes -- the cell keeps the exact stored number, so the file is still the
// source of truth. Mirrors formatIngredientQty in renderer.js.
function ingredientQtyNumFmt(v) {
  const n = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(n)) return null;
  if (Math.abs(n) > 0 && Math.abs(n) < 0.1) return '0.00';
  return Number.isInteger(Math.round(n * 10) / 10) ? '0' : '0.0';
}

// How many of this process's linked material (tray/pan/mold) are needed to hold its full Net
// Weight, rounded UP -- same convention and reasoning as updateProcessNetWeight in renderer.js
// (a partially-filled tray still counts as one you need to prepare). Null (not 0) when no
// material is linked or its per-use fill weight isn't set -- same "omit, don't placeholder"
// convention every other optional field on this sheet already follows.
function computeTraysNeeded(proc, netWeight) {
  const fill = proc.material_fill_weight_grams;
  if (!proc.material_id || fill == null || isNaN(fill) || fill <= 0) return null;
  return Math.ceil(netWeight / fill);
}

// Recipe-level Portions Produced -- combinedNetWeight (the plain sum of every process's own Net
// Weight, the same figure recipes.yield_notes is set from) divided by the recipe's Portion
// Weight, floored: this counts whole, actually-cuttable portions, not a capacity requirement like
// Trays Needed, so there's no reason to round up a partial portion into a full one. Null when
// Portion Weight isn't set.
function computePortionsProduced(combinedNetWeight, portionWeightGrams) {
  if (portionWeightGrams == null || isNaN(portionWeightGrams) || portionWeightGrams <= 0) return null;
  return Math.floor(combinedNetWeight / portionWeightGrams);
}

function resolveLabels(options) {
  return { ...DEFAULT_LABELS, ...((options && options.labels) || {}) };
}

// Builds a plain row array padded to `numCols` columns with `value` placed at 1-indexed column
// `col` -- used for every "Label: value" row inside a process's ingredient-table section (Total
// Quantity, Net Weight, Waste %, Material/Trays) so `value` lands under the same column as the
// table's own Quantity column, whether or not the Original Qty column (buildRecipeSheet's
// `includeOriginalQty`) has shifted that column one to the right.
function labelValueRow(label, value, col, numCols) {
  const row = new Array(numCols).fill(null);
  row[0] = label;
  row[col - 1] = value;
  return row;
}

// ---- Square photo box helpers --------------------------------------------------------------
// ExcelJS has no "crop to fill" option -- an image anchored between two cell corners is always
// stretched to exactly fill that rectangle, distorting anything that isn't already the right
// aspect ratio. True crop-to-fill requires cropping the actual pixel data before embedding.
const PX_PER_PT = 96 / 72; // Excel row heights are in points; the column-width px math above assumes 96dpi.
const DEFAULT_ROW_HEIGHT_PT = 15; // ExcelJS/Excel's own implicit default when a row's height is left unset.

function pxToPt(px) {
  return px / PX_PER_PT;
}

// Center-crops `buffer` to a square (the shorter side), preserving the original format so the
// caller's `ext` (passed straight through to workbook.addImage) still matches the bytes.
async function squareCropBuffer(buffer, ext) {
  const img = await Jimp.read(buffer);
  const side = Math.min(img.bitmap.width, img.bitmap.height);
  img.crop((img.bitmap.width - side) / 2, (img.bitmap.height - side) / 2, side, side);
  return img.getBufferAsync(ext === 'png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG);
}

// Grows (never shrinks) every row in [r1, r2]'s height, distributing the shortfall evenly, so
// the block's TOTAL height in pixels reaches at least targetPx -- used to make a merged photo
// cell square against its fixed column width without ever clipping whatever real content
// (Presentation/Method lines, etc.) already sized those same rows to fit. Must be called only
// after every row in the block already has its final content-driven height set, since a row
// height set afterward would silently overwrite the growth applied here.
function growBlockToSquare(sheet, r1, r2, targetPx) {
  const rows = [];
  let currentPt = 0;
  for (let r = r1; r <= r2; r++) {
    const row = sheet.getRow(r);
    rows.push(row);
    currentPt += row.height || DEFAULT_ROW_HEIGHT_PT;
  }
  const targetPt = pxToPt(targetPx);
  if (targetPt <= currentPt) return;
  const extraPerRowPt = (targetPt - currentPt) / rows.length;
  rows.forEach(row => { row.height = (row.height || DEFAULT_ROW_HEIGHT_PT) + extraPerRowPt; });
}

// Every literal label string in buildRecipeSheet/buildRecipePhotosSheet is a lookup
// into a `labels` object instead of a hardcoded
// string, defaulting to this exact English dictionary -- so the untranslated path (the default,
// no `labels` argument passed) produces byte-for-byte the same output as before this existed.
// Deliberately bare phrases with no colon/punctuation baked in (e.g. 'Category', not
// 'Category:') -- each call site still builds its own exact surrounding punctuation/spacing the
// same way it always did, just substituting a label lookup for the literal word, so every
// existing formatting quirk (a trailing double-space here, a bare two-cell row there) survives
// unchanged. Sent to/from the translate-recipe Edge Function as-is (a flat string dictionary) --
// the Edge Function has no hardcoded copy of its own, so there's nothing to keep in sync by hand.
const DEFAULT_LABELS = {
  recipeFor: 'RECIPE FOR:',
  quantityProduced: 'Quantity Produced',
  portionWeight: 'Portion Weight (g)',
  preparedBy: 'Prepared By',
  category: 'Category',
  countryOrigin: 'Country \\ Origin',
  waste: 'Waste',
  netWeight: 'Net Weight',
  portionsProduced: 'Portions Produced',
  portionsUnit: 'portions',
  materialLabel: 'Material / Tray',
  fillWeight: 'Fill Weight (g)',
  traysNeeded: 'Trays Needed',
  date: 'Date',
  ttyCode: 'TTY Code',
  exCode: 'EX Code',
  rgCode: 'RG Code',
  ingredientsHeader: 'INGREDIENTS',
  originalQtyHeader: 'Original Qty',
  quantityHeader: 'Quantity',
  unitHeader: 'Unit',
  methodColumnHeader: 'METHOD',
  noteColumnHeader: 'Note',
  noIngredientsPlaceholder: '(no ingredients)',
  totalQuantity: 'Total Quantity',
  preparationAndCooking: 'Preparation and Cooking:',
  presentationDecorationServing: 'Presentation, Decoration & Serving Instructions:',
  comment: 'Comment',
  checkedBy: 'Checked By',
  methodLabel: 'Method:',
  photosAndPresentation: 'Photos & Presentation',
  photoPlaceholder: 'Photo',
};

// Sets one border side without touching a cell's other sides. `force` overwrites an
// already-set side (used only for the single outer document frame, so its perimeter reads
// as one uniform thick line); otherwise a side is only filled in if currently unset, so
// none of the template-accurate double/hair/thin borders already placed below are altered.
function setRecipeBorderSide(cell, side, style, force) {
  if (!force && cell.border && cell.border[side]) return;
  cell.border = { ...cell.border, [side]: style };
}

function frameRecipeRegion(sheet, r1, c1, r2, c2, style, force) {
  for (let c = c1; c <= c2; c++) {
    setRecipeBorderSide(sheet.getCell(r1, c), 'top', style, force);
    setRecipeBorderSide(sheet.getCell(r2, c), 'bottom', style, force);
  }
  for (let r = r1; r <= r2; r++) {
    setRecipeBorderSide(sheet.getCell(r, c1), 'left', style, force);
    setRecipeBorderSide(sheet.getCell(r, c2), 'right', style, force);
  }
}

function gridRecipeRegion(sheet, r1, c1, r2, c2, style) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = sheet.getCell(r, c);
      setRecipeBorderSide(cell, 'top', style, false);
      setRecipeBorderSide(cell, 'bottom', style, false);
      setRecipeBorderSide(cell, 'left', style, false);
      setRecipeBorderSide(cell, 'right', style, false);
    }
  }
}

function fillRecipeRegion(sheet, r1, c1, r2, c2, argb) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) fillCell(sheet.getCell(r, c), argb);
  }
}

// ============================================================
// Recipe Book & Recipe Extractor share this one builder -- one recipe per sheet, one section per
// named process. recipes/recipe_processes/recipe_ingredients and extracted_recipes/
// extracted_recipe_processes/extracted_recipe_ingredients are both process-shaped now (see
// conversation notes on the Recipe Book multi-process migration), so there is no longer a
// separate fixed single-process paper-template builder -- that layout is retired entirely for
// both recipe types, not just kept around for Book.
//
// Every recipe-level field below gets its own row, so "omit this field's row when it's blank"
// has an unambiguous answer per field -- there's no shared row where omitting one side while the
// other has content would leave a partial row. Net Weight/Yield, Total Quantity, and each
// process's own name heading are never omitted (all effectively always populated); every other
// recipe-level field, each process's Method block, each process's ingredient table (for a
// method-only process), and the Presentation/Decoration/Serving block are all omitted entirely
// when blank. Each process's own Quantity Produced/Total Quantity/Waste/Net Weight rows (inside
// its ingredient table section) follow the same rule as the block they live in -- shown only
// when that process has ingredients, and its Quantity Produced/Waste rows specifically only when
// actually entered for that process.
//
// options.codeLabelKey ('ttyCode' or 'exCode', default 'exCode') picks which DEFAULT_LABELS
// entry labels the code footer line -- the one remaining difference between a Recipe Book and a
// Recipe Extractor sheet.
// ============================================================

// Adds one "Label: value" row spanning A:D -- or nothing at all when `value` is blank, which
// is the whole point: every optional field on this sheet goes through this one helper so
// omission is consistent and centralized rather than a bespoke blank-check per field.
function addOptionalFieldRow(sheet, label, value, align, numCols = 4) {
  const trimmed = (value ?? '').toString().trim();
  if (!trimmed) return null;
  const text = `${label}: ${trimmed}`;
  const row = sheet.addRow([text]);
  sheet.mergeCells(row.number, 1, row.number, numCols);
  // Excel does not auto-size row height for merged cells even with wrapText set (confirmed by
  // inspecting a generated file directly -- every such row came back with height left unset,
  // regardless of actual content length) -- an explicit estimate is required, not optional,
  // for a long Comment/Checked By value in particular.
  row.height = estimateWrappedRowHeight(text, mergedWidthPx(sheet, 0, numCols - 1), 13);
  sheet.getCell(row.number, 1).font = { size: 13, name: RECIPE_FONT };
  sheet.getCell(row.number, 1).alignment = { horizontal: align || 'left', vertical: 'top', wrapText: true };
  return row;
}

async function buildRecipeSheet(workbook, recipe, processes, sheetName, options = {}) {
  const labels = resolveLabels(options);
  // Recipe Calculator-only ("Include Original Quantity column" export toggle, see
  // renderScaledRecipeResult) -- Recipe Book/Extractor never pass this, so their sheets keep the
  // exact 4-column layout this function always had. Adds one column between the ingredient name
  // and the Quantity column, matching the on-screen Calculator's own left-to-right order
  // (Ingredient, Original Qty, Quantity, Unit, Method); every other row that must land a value
  // under the Quantity column (Total Quantity, Net Weight, Waste %, Material/Trays) reads
  // `qtyCol`/`unitCol` below instead of a hardcoded column index so it stays aligned either way.
  const includeOriginalQty = !!options.includeOriginalQty;
  const numCols = includeOriginalQty ? 5 : 4;
  const qtyCol = numCols - 2;
  const unitCol = numCols - 1;
  const noteCol = numCols;
  const sheet = workbook.addWorksheet(sheetName);
  // Original Qty's own width (14, not the 9.2 the Quantity/Unit columns use) -- "Original Qty" is
  // half again as long as "Quantity" and bold in the header row, so it clipped against the
  // Quantity column's neighboring cell at that narrower width (confirmed by inspecting a
  // generated file directly).
  sheet.columns = includeOriginalQty
    ? [{ width: 29.5 }, { width: 14 }, { width: 9.2 }, { width: 10 }, { width: 49.7 }]
    : [{ width: 29.5 }, { width: 9.2 }, { width: 10 }, { width: 49.7 }];
  sheet.pageSetup = { paperSize: 9, orientation: 'portrait', fitToWidth: 1, fitToHeight: 0, horizontalCentered: true };

  // Adds one "Label | value | g" row -- shared by every Total Quantity/Net Weight row in this
  // function (per-process and aggregate) so the label/value/unit styling and column placement
  // can't drift between them. `valueBold` distinguishes the aggregate Total Quantity row (bold
  // value, size 13) from every per-process row (plain value, size 12) -- the one styling
  // difference that already existed between them before this helper did.
  //
  // `originalValue`, when includeOriginalQty is on, fills this same row's Original Qty cell (the
  // column immediately before Quantity) with the corresponding unscaled figure -- the SAME row
  // showing both values side by side in their existing columns, exactly like an individual
  // ingredient row already does, rather than a second "(Original)" row (tried and reverted: too
  // heavy for a summary line, and it renamed the labels).
  function addQuantityRow(label, value, { valueBold = false, size = 12, originalValue } = {}) {
    const row = sheet.addRow(labelValueRow(label, value, qtyCol, numCols));
    row.getCell(1).font = { bold: true, size, name: RECIPE_FONT };
    row.getCell(qtyCol).font = { bold: valueBold, size, name: RECIPE_FONT };
    row.getCell(qtyCol).alignment = { horizontal: 'center' };
    row.getCell(unitCol).value = 'g';
    row.getCell(unitCol).font = { bold: valueBold, size, name: RECIPE_FONT };
    row.getCell(unitCol).alignment = { horizontal: 'center' };
    if (includeOriginalQty && originalValue !== undefined) {
      row.getCell(2).value = originalValue;
      row.getCell(2).font = { bold: valueBold, size, name: RECIPE_FONT };
      row.getCell(2).alignment = { horizontal: 'center' };
    }
    return row;
  }

  // Full mirrored sheet view for the export's target language (not just cell-level right-
  // alignment below): rightToLeft flips which screen side each column renders on without moving
  // any cell/merge/image to a different row/column index, so nothing else in this function needs
  // to change -- our column order (name/label -> ... -> note/value) already reads in the correct
  // sequence for either direction; the view flip alone makes that sequence read right-to-left
  // correctly. See isRtlLanguage -- this checks the chosen export language, not recipe content
  // (stored content is always English now; there's nothing left to scan).
  const isRtl = isRtlLanguage(options.targetLanguage);
  sheet.views = [{ showGridLines: false, rightToLeft: isRtl }];

  // Cell-level (on top of the view-level mirror above): the sheet's own template labels ("RECIPE
  // FOR:", "Total Quantity", "Method:", etc.) stay exactly where they are; only cells holding
  // this recipe's own dynamic text right-align when the export language reads RTL.
  const dataAlign = isRtl ? 'right' : 'left';

  // ---- Header: recipe name (always) + EX code (always) + one row per optional field.
  // Name value always lands in the LAST column -- a plain single cell when there's no Original
  // Qty column (numCols === 4, identical to this row's shape before that option existed), merged
  // across the extra column(s) beyond D when there is, so the value cell just gets wider rather
  // than needing its own column-specific styling.
  const nameRow = sheet.addRow([null, labels.recipeFor]);
  sheet.mergeCells(nameRow.number, 2, nameRow.number, 3);
  // Value always set on column 4, the merge's anchor/top-left cell -- ExcelJS only renders a
  // value set on that cell, so it must be assigned before (or regardless of) the extra merge
  // below, never on the merge's trailing column(s).
  nameRow.getCell(4).value = recipe.name;
  if (numCols > 4) sheet.mergeCells(nameRow.number, 4, nameRow.number, numCols);
  sheet.getCell(`B${nameRow.number}`).font = { bold: true, underline: true, size: 16, name: RECIPE_FONT };
  sheet.getCell(`B${nameRow.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  nameRow.getCell(4).font = { size: 14, name: 'Arial' };
  // wrapText, not a fixed height -- a long recipe name (AI-generated ones from Recipe Generator
  // run noticeably longer than hand-typed Book/Extractor names, e.g. "Mashed Potatoes with
  // Garlic, Coriander and Paprika") was getting visually clipped on both ends in this single
  // centered column otherwise, since a centered cell with no wrap and a blocked neighbor clips
  // symmetrically rather than overflowing. Same wrap-and-measure convention as
  // addOptionalFieldRow's Comment/Checked By rows below -- mergedWidthPx/estimateWrappedRowHeight
  // are 0-indexed column bounds, so column 4 (1-indexed, D) is index 3.
  nameRow.getCell(4).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  nameRow.height = Math.max(28, estimateWrappedRowHeight(recipe.name, mergedWidthPx(sheet, 3, numCols - 1), 14));
  fillRecipeRegion(sheet, nameRow.number, 1, nameRow.number, numCols, RECIPE_SECTION_FILL);

  // codeLabelKey ('ttyCode' or 'exCode') picks which DEFAULT_LABELS entry labels the code --
  // defaults to 'exCode' so a caller that omits it (none should, but a safe fallback matters
  // more than a hard error here) still produces a real label rather than `undefined: ...`.
  const codeLabelKey = options.codeLabelKey || 'exCode';
  const codeRow = sheet.addRow([`${labels[codeLabelKey]}: ${recipe.code}`]);
  sheet.mergeCells(codeRow.number, 1, codeRow.number, numCols);
  sheet.getCell(`A${codeRow.number}`).font = { size: 9, italic: true, name: RECIPE_FONT, color: { argb: 'FF8A8477' } };
  sheet.getCell(`A${codeRow.number}`).alignment = { horizontal: 'right' };

  addOptionalFieldRow(sheet, labels.quantityProduced, recipe.quantity_produced, dataAlign, numCols);
  addOptionalFieldRow(sheet, labels.portionWeight, recipe.portion_weight_grams, dataAlign, numCols);
  addOptionalFieldRow(sheet, labels.preparedBy, recipe.prepared_by, dataAlign, numCols);
  addOptionalFieldRow(sheet, labels.category, recipe.category, dataAlign, numCols);
  addOptionalFieldRow(sheet, labels.countryOrigin, recipe.country_origin, dataAlign, numCols);
  addOptionalFieldRow(sheet, labels.date, formatDateDDMMYYYY(recipe.date_created), dataAlign, numCols);

  // Total Quantity/Net Weight (recipe-level, combined across every process) -- computed live,
  // same convention as combinedNetWeight below, so neither can drift from what this exact sheet
  // actually shows. This USED to be two separate things: Net Weight lived here in the header
  // (recipe.yield_notes) while Total Quantity was a second, standalone row way down after the
  // last process's Method block with no heading tying it to anything -- confirmed by inspecting
  // a generated file directly, it read as an orphaned duplicate, especially on a single-process
  // recipe where it just repeated that process's own Total Quantity right below it. Printed here
  // instead, directly above Net Weight, matching the Total Quantity -> Net Weight order already
  // used inside each process's own section -- this is now the ONLY recipe-level summary.
  const combinedTotalQuantity = roundForDisplay((processes || []).reduce((sum, proc) => sum + computeProcessTotals(proc).total, 0));
  const totalQuantityRow = sheet.addRow([`${labels.totalQuantity}: ${combinedTotalQuantity} g`]);
  sheet.mergeCells(totalQuantityRow.number, 1, totalQuantityRow.number, numCols);
  sheet.getCell(`A${totalQuantityRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT, color: { argb: 'FFFF0000' } };

  // Net Weight/Yield is always shown -- computed live as the sum of every process's own Net
  // Weight (see the per-process Total Quantity/Waste/Net Weight rows below), so it's
  // effectively never truly blank the way the fields above can be. There's no recipe-level
  // Waste row anymore -- waste is set per process now, not on the recipe as a whole.
  const yieldRow = sheet.addRow([`${labels.netWeight}: ${recipe.yield_notes || ''}`]);
  sheet.mergeCells(yieldRow.number, 1, yieldRow.number, numCols);
  sheet.getCell(`A${yieldRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT, color: { argb: 'FFFF0000' } };

  let lastHeaderRowNumber = yieldRow.number;
  // Portions Produced -- computed here (not read off yield_notes, a free-text string) from the
  // same per-process Net Weight figures the section loop below prints, summed fresh, so it can
  // never drift from what this exact sheet actually shows even if yield_notes were ever stale.
  // Rounded the same way as combinedTotalQuantity above -- besides display, this also protects
  // computePortionsProduced's Math.floor from a boundary case where noise just under a whole
  // number (e.g. 1199.9999999999998 instead of 1200) would floor to one portion less than it should.
  const combinedNetWeight = roundForDisplay((processes || []).reduce((sum, proc) => sum + computeProcessTotals(proc).netWeight, 0));
  const portionsProduced = computePortionsProduced(combinedNetWeight, recipe.portion_weight_grams);
  if (portionsProduced != null) {
    const portionsRow = sheet.addRow([`${labels.portionsProduced}: ${portionsProduced} ${labels.portionsUnit}`]);
    sheet.mergeCells(portionsRow.number, 1, portionsRow.number, numCols);
    sheet.getCell(`A${portionsRow.number}`).font = { bold: true, size: 12, name: RECIPE_FONT, color: { argb: 'FFFF0000' } };
    lastHeaderRowNumber = portionsRow.number;
  }

  frameRecipeRegion(sheet, nameRow.number, 1, lastHeaderRowNumber, numCols, recipeMediumBorder, false);
  sheet.addRow([]);

  // ---- One section per process: name heading (always), then an ingredients table (only if
  // that process has any) and a Method block (only if that process has method text).
  for (const proc of processes) {
    const headingText = proc.name || '';
    const headingRow = sheet.addRow([headingText]);
    sheet.mergeCells(headingRow.number, 1, headingRow.number, numCols);
    headingRow.height = estimateWrappedRowHeight(headingText, mergedWidthPx(sheet, 0, numCols - 1), 14);
    sheet.getCell(`A${headingRow.number}`).font = { bold: true, size: 14, name: RECIPE_FONT };
    sheet.getCell(`A${headingRow.number}`).alignment = { horizontal: dataAlign, wrapText: true };
    fillRecipeRegion(sheet, headingRow.number, 1, headingRow.number, numCols, RECIPE_SECTION_FILL);
    let sectionLastRow = headingRow.number;

    const procIngredients = proc.ingredients || [];
    if (procIngredients.length > 0) {
      // "Note", not "METHOD" -- this column holds a short per-ingredient note (e.g. "optional"),
      // distinct from the process-level "Method:" steps block below the table. Recipe Book's
      // own ingredient table (buildRecipeSheet, above) keeps "METHOD" -- not touched here. Gets
      // an extra "Original Qty" column, immediately before Quantity, only when includeOriginalQty
      // (the Calculator's own export toggle) is on -- Recipe Book/Extractor never set it.
      const headerValues = includeOriginalQty
        ? [labels.ingredientsHeader, labels.originalQtyHeader, labels.quantityHeader, labels.unitHeader, labels.noteColumnHeader]
        : [labels.ingredientsHeader, labels.quantityHeader, labels.unitHeader, labels.noteColumnHeader];
      const header = sheet.addRow(headerValues);
      header.height = 20;
      header.eachCell({ includeEmpty: true }, cell => {
        cell.font = { bold: true, size: 13, name: RECIPE_FONT };
        // dataAlign (left for LTR, right for RTL export languages -- see isRtlLanguage above),
        // not a hardcoded 'center': these are column headers over a left-to-right (or mirrored
        // RTL) data table, same reading direction as every value cell beneath them, not a
        // decorative centered label. wrapText stays as a safety net, not the primary fix for
        // clipping -- the English labels are sized to fit their own column on one line (see the
        // width comment above), but a translated label could still run long, and wrapping to a
        // second line reads far better than clipping into the neighboring cell.
        cell.alignment = { horizontal: dataAlign, vertical: 'middle', wrapText: true };
      });

      procIngredients.forEach(ing => {
        const rowValues = includeOriginalQty
          ? [ing.ingredient_name, ing.original_quantity ?? '', ing.quantity ?? '', ing.unit || '', ing.method || '']
          : [ing.ingredient_name, ing.quantity ?? '', ing.unit || '', ing.method || ''];
        const row = sheet.addRow(rowValues);
        row.getCell(1).font = { size: 13, name: RECIPE_FONT };
        row.getCell(1).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        if (includeOriginalQty) {
          row.getCell(2).font = { size: 13, name: RECIPE_FONT };
          row.getCell(2).alignment = { horizontal: 'center', wrapText: true };
        }
        row.getCell(qtyCol).font = { size: 13, name: RECIPE_FONT };
        row.getCell(qtyCol).alignment = { horizontal: 'center', wrapText: true };
        const qtyFmt = ingredientQtyNumFmt(ing.quantity);
        if (qtyFmt) row.getCell(qtyCol).numFmt = qtyFmt;
        const origFmt = includeOriginalQty ? ingredientQtyNumFmt(ing.original_quantity) : null;
        if (origFmt) row.getCell(2).numFmt = origFmt;
        row.getCell(unitCol).font = { size: 13, name: RECIPE_FONT };
        row.getCell(unitCol).alignment = { horizontal: 'center', wrapText: true };
        row.getCell(noteCol).font = { size: 13, name: RECIPE_FONT };
        row.getCell(noteCol).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
      });

      // This process's own Total Quantity/Waste/Net Weight -- same arithmetic as the form's live
      // per-process calc (updateProcessNetWeight in renderer.js), printed here since it's
      // actionable per-component info (unlike the old recipe-level blanket waste%, which was
      // deliberately kept internal-only). Quantity and unit are split into their own cells --
      // qtyCol/unitCol, the same columns the ingredient table's own Quantity/Unit values use --
      // rather than one combined "1180 G" string, and the unit is lowercase "g" to match the
      // ingredient table's own Unit column exactly.
      const { total: procTotal, netWeight: procNetWeight } = computeProcessTotals(proc);

      // includeOriginalQty fills this same row's Original Qty cell too (see addQuantityRow) --
      // one "Total Quantity"/"Net Weight" row either way, never a separate row or renamed label.
      const procOriginalTotals = includeOriginalQty ? computeProcessTotals(proc, 'original_quantity') : null;

      const procTotalRow = addQuantityRow(labels.totalQuantity, procTotal, { originalValue: procOriginalTotals?.total });

      // One row per applied waste type (e.g. "Baking Waste: 8%", "Trimming Waste: 5%") --
      // omitted entirely when the process has none, same convention as every other optional
      // row on this sheet. Each row uses the waste type's own chef-entered name, not a fixed
      // label, since there's no single generic "Waste" line anymore. The Unit/Note columns
      // (otherwise blank on this row) carry the waterfall pair -- how much THIS waste removed
      // (red, same as the live form's own waste rows) and the running total after it, computed
      // via computeWasteWaterfall against procTotal so it can never drift from procNetWeight below.
      const wasteWaterfall = computeWasteWaterfall(procTotal, proc.wastes);
      (proc.wastes || []).forEach((w, wi) => {
        const { reduced, after } = wasteWaterfall[wi];
        const procWasteRow = sheet.addRow(labelValueRow(w.name, `${w.percent}%`, qtyCol, numCols));
        procWasteRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procWasteRow.getCell(qtyCol).font = { size: 12, name: RECIPE_FONT };
        procWasteRow.getCell(qtyCol).alignment = { horizontal: 'center' };
        if (reduced > 0) {
          procWasteRow.getCell(unitCol).value = `−${reduced} g`;
          // Same red as the app's own --danger CSS variable (#A6473D), so the exported file's
          // waste rows read the same way the live form's do, not just in text but in color too.
          procWasteRow.getCell(unitCol).font = { size: 11, name: RECIPE_FONT, color: { argb: 'FFA6473D' } };
          procWasteRow.getCell(unitCol).alignment = { horizontal: 'center' };
        }
        procWasteRow.getCell(noteCol).value = `→ ${after} g`;
        procWasteRow.getCell(noteCol).font = { size: 11, name: RECIPE_FONT };
        procWasteRow.getCell(noteCol).alignment = { horizontal: dataAlign };
      });

      let procClosingRow = addQuantityRow(labels.netWeight, procNetWeight, { originalValue: procOriginalTotals?.netWeight });

      // Material/Tray + Trays Needed -- omitted entirely when this process has no material
      // linked, same "no placeholder" convention as the Wastes Applied rows above.
      const traysNeeded = computeTraysNeeded(proc, procNetWeight);
      if (proc.material_id && traysNeeded != null) {
        const materialLabel = proc.material_code ? `${proc.material_code} — ${proc.material_name}` : (proc.material_name || '');
        const procMaterialRow = sheet.addRow(labelValueRow(labels.materialLabel, materialLabel, qtyCol, numCols));
        procMaterialRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procMaterialRow.getCell(qtyCol).font = { size: 12, name: RECIPE_FONT };
        procMaterialRow.getCell(qtyCol).alignment = { horizontal: 'center' };

        const procTraysRow = sheet.addRow(labelValueRow(labels.traysNeeded, traysNeeded, qtyCol, numCols));
        procTraysRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procTraysRow.getCell(qtyCol).font = { size: 12, name: RECIPE_FONT };
        procTraysRow.getCell(qtyCol).alignment = { horizontal: 'center' };
        procClosingRow = procTraysRow;
      }

      // Grid extended through here (was previously applied right after the ingredient rows,
      // before Quantity Produced/Total Quantity/Waste/Net Weight existed) -- confirmed by
      // inspecting a generated file directly that these 4 rows had NO borders at all, a real
      // gap between the ingredient table's closing line and the Method block below, not just a
      // styling nitpick. The section's actual closing row (Net Weight, or Trays Needed when a
      // material is linked) gets the same fill the process heading uses, bookending the section
      // the same way buildRecipeSheet's own Total Quantity row now does. Total Quantity (the
      // opening row of this same summary block) gets that fill too, so the highlight reads as one
      // continuous band across both, not just its closing line.
      gridRecipeRegion(sheet, header.number, 1, sheet.rowCount, numCols, thinBorder);
      fillRecipeRegion(sheet, procClosingRow.number, 1, procClosingRow.number, numCols, RECIPE_SECTION_FILL);
      fillRecipeRegion(sheet, procTotalRow.number, 1, procTotalRow.number, numCols, RECIPE_SECTION_FILL);

      sectionLastRow = sheet.rowCount;
    }

    const methodText = proc.method || '';
    const methodLines = splitLines(methodText);
    if (methodLines.length > 0) {
      const methodLabelRow = sheet.addRow([labels.methodLabel]);
      sheet.getCell(`A${methodLabelRow.number}`).font = { bold: true, size: 13, name: RECIPE_FONT };

      // Same "more than one non-empty line -> numbered steps" heuristic buildRecipeSheet's
      // Preparation and Cooking block uses (mirrors initTextListField's Text/List detection).
      const methodMergedWidthPx = mergedWidthPx(sheet, 0, numCols - 1);
      if (methodLines.length > 1) {
        methodLines.forEach((line, idx) => {
          const stepText = `${idx + 1}. ${line}`;
          const stepRow = sheet.addRow([stepText]);
          sheet.mergeCells(stepRow.number, 1, stepRow.number, numCols);
          stepRow.height = estimateWrappedRowHeight(stepText, methodMergedWidthPx, 13);
          sheet.getCell(`A${stepRow.number}`).font = { size: 13, name: RECIPE_FONT };
          sheet.getCell(`A${stepRow.number}`).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        });
      } else {
        const valueRow = sheet.addRow([methodText]);
        sheet.mergeCells(valueRow.number, 1, valueRow.number, numCols);
        // Excel does not auto-size row height for merged cells even with wrapText set --
        // confirmed by inspecting a generated file directly; an explicit estimate is required.
        valueRow.height = estimateWrappedRowHeight(methodText, methodMergedWidthPx, 13);
        sheet.getCell(`A${valueRow.number}`).font = { size: 13, name: RECIPE_FONT };
        sheet.getCell(`A${valueRow.number}`).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
      }
      sectionLastRow = sheet.rowCount;
    }

    frameRecipeRegion(sheet, headingRow.number, 1, sectionLastRow, numCols, recipeMediumBorder, false);
    sheet.addRow([]);
  }

  // ---- Photo (always shown, image or placeholder) + Presentation/Decoration/Serving --
  // only when this recipe has 1 photo or fewer. 2+ photos moves both of these to their own
  // dedicated sheet instead (see buildRecipePhotosSheet/exportRecipes) so the
  // main sheet keeps its fixed one-page paper-template shape regardless of gallery size.
  const photos = recipe.photos || [];
  if (photos.length <= 1) {
    // Photo box always uses A:B (standardized -- previously spanned the full A:D width when
    // there was no presentation text, which made "make it square" ambiguous there). The
    // "Presentation, Decoration & Serving" header itself is still omitted entirely when blank,
    // leaving C:D beside the photo simply blank rather than an empty section header.
    const presentationLines = splitLines(recipe.presentation_serving);
    const hasPresentation = presentationLines.length > 0;
    const blockStartRow = sheet.rowCount + 1;
    const presentationRowCount = hasPresentation ? presentationLines.length : 3;
    const photoEndCol = 2;

    sheet.mergeCells(blockStartRow, 1, blockStartRow + presentationRowCount, photoEndCol);
    const photoCell = sheet.getCell(blockStartRow, 1);
    const photo = photos[0];
    if (photo) {
      // Cropped to a square before embedding -- see squareCropBuffer's own comment.
      const ext = photo.ext || 'jpeg';
      const croppedBuffer = await squareCropBuffer(photo.buffer, ext);
      const imageId = workbook.addImage({ buffer: croppedBuffer, extension: ext });
      sheet.addImage(imageId, {
        tl: { col: 0, row: blockStartRow - 1 },
        br: { col: photoEndCol, row: blockStartRow + presentationRowCount },
      });
    } else {
      photoCell.value = labels.photoPlaceholder;
      photoCell.font = { size: 14, name: RECIPE_FONT };
      photoCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
    fillRecipeRegion(sheet, blockStartRow, 1, blockStartRow + presentationRowCount, photoEndCol, RECIPE_PHOTO_FILL);

    if (hasPresentation) {
      sheet.mergeCells(blockStartRow, 3, blockStartRow, numCols);
      sheet.getCell(blockStartRow, 3).value = labels.presentationDecorationServing;
      sheet.getCell(blockStartRow, 3).font = { bold: true, size: 13, name: RECIPE_FONT };
      fillRecipeRegion(sheet, blockStartRow, 3, blockStartRow, numCols, RECIPE_SECTION_FILL);

      const numberLines = presentationLines.length > 1;
      const presMergedWidthPx = mergedWidthPx(sheet, 2, numCols - 1);
      presentationLines.forEach((line, i) => {
        const rowNum = blockStartRow + 1 + i;
        const lineText = numberLines ? `${i + 1}. ${line}` : line;
        sheet.mergeCells(rowNum, 3, rowNum, numCols);
        sheet.getCell(rowNum, 3).value = lineText;
        sheet.getCell(rowNum, 3).font = { size: 13, name: RECIPE_FONT };
        sheet.getCell(rowNum, 3).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        sheet.getRow(rowNum).height = estimateWrappedRowHeight(lineText, presMergedWidthPx, 13);
      });
    }

    // Grows this block's rows (never shrinks -- Presentation's own per-line heights above are
    // never clipped) just enough that the A:B photo box comes out square.
    growBlockToSquare(sheet, blockStartRow, blockStartRow + presentationRowCount, mergedWidthPx(sheet, 0, 1));

    frameRecipeRegion(sheet, blockStartRow, 1, blockStartRow + presentationRowCount, numCols, recipeMediumBorder, false);
    sheet.addRow([]);
  }

  // ---- Comment / Checked By -- each its own row, omitted entirely when blank.
  const commentRow = addOptionalFieldRow(sheet, labels.comment, recipe.comment, dataAlign, numCols);
  if (commentRow) frameRecipeRegion(sheet, commentRow.number, 1, commentRow.number, numCols, recipeMediumBorder, false);
  const checkedByRow = addOptionalFieldRow(sheet, labels.checkedBy, recipe.checked_by, dataAlign, numCols);
  if (checkedByRow) frameRecipeRegion(sheet, checkedByRow.number, 1, checkedByRow.number, numCols, recipeMediumBorder, false);

  // Outer document frame (thick), applied last with force so the perimeter is one uniform
  // line rather than a patchwork of whatever border happened to already be there.
  frameRecipeRegion(sheet, 1, 1, sheet.rowCount, numCols, recipeThickBorder, true);
}

// Built only when a recipe has 2+ saved photos -- buildRecipeSheet skips its own Photo
// cell and Presentation/Decoration/Serving section in that case and points here instead, so the
// main sheet keeps its fixed one-page paper-template shape no matter how large the gallery gets.
// Presentation text is placed above the photo grid (context before pictures); photos are laid
// out 2-per-row rather than stacked, for better use of page width across up to 10 photos.
async function buildRecipePhotosSheet(workbook, recipe, sheetName, options = {}) {
  const labels = resolveLabels(options);
  const sheet = workbook.addWorksheet(sheetName);
  // Four even columns (unlike the main sheet's uneven 29.5/9.2/10/49.7 template widths) so the
  // 2-wide photo grid comes out visually symmetric -- this sheet has no fixed paper template to
  // match, so it's free to use its own layout. Landscape, since a wide grid prints better that way.
  sheet.columns = [{ width: 24.85 }, { width: 24.85 }, { width: 24.85 }, { width: 24.85 }];
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, horizontalCentered: true };

  // Same full mirrored-view approach as buildRecipeSheet -- see the comment there.
  const isRtl = isRtlLanguage(options.targetLanguage);
  sheet.views = [{ showGridLines: false, rightToLeft: isRtl }];

  // Cell-level, on top of the view-level mirror above -- see isRtlLanguage.
  const dataAlign = isRtl ? 'right' : 'left';

  const nameRow = sheet.addRow([null, labels.recipeFor, null, recipe.name]);
  sheet.mergeCells(nameRow.number, 2, nameRow.number, 3);
  nameRow.height = 28;
  sheet.getCell(`B${nameRow.number}`).font = { bold: true, underline: true, size: 16, name: RECIPE_FONT };
  sheet.getCell(`B${nameRow.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`D${nameRow.number}`).value = labels.photosAndPresentation;
  sheet.getCell(`D${nameRow.number}`).font = { size: 13, italic: true, name: RECIPE_FONT };
  sheet.getCell(`D${nameRow.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  fillRecipeRegion(sheet, nameRow.number, 1, nameRow.number, 4, RECIPE_SECTION_FILL);
  frameRecipeRegion(sheet, nameRow.number, 1, nameRow.number, 4, recipeMediumBorder, false);
  sheet.addRow([]);

  // Omitted entirely when blank, same convention as the main sheet.
  const presentationLines = splitLines(recipe.presentation_serving);
  if (presentationLines.length > 0) {
    const labelRow = sheet.addRow([labels.presentationDecorationServing]);
    sheet.mergeCells(labelRow.number, 1, labelRow.number, 4);
    sheet.getCell(`A${labelRow.number}`).font = { bold: true, size: 13, name: RECIPE_FONT };
    fillRecipeRegion(sheet, labelRow.number, 1, labelRow.number, 4, RECIPE_SECTION_FILL);

    const numberLines = presentationLines.length > 1;
    const stepsStartRow = labelRow.number + 1;
    const photosPresMergedWidthPx = mergedWidthPx(sheet, 0, 3);
    presentationLines.forEach((line, i) => {
      const rowNum = stepsStartRow + i;
      const lineText = numberLines ? `${i + 1}. ${line}` : line;
      sheet.mergeCells(rowNum, 1, rowNum, 4);
      sheet.getCell(rowNum, 1).value = lineText;
      sheet.getCell(rowNum, 1).font = { size: 13, name: RECIPE_FONT };
      sheet.getCell(rowNum, 1).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
      sheet.getRow(rowNum).height = estimateWrappedRowHeight(lineText, photosPresMergedWidthPx, 13);
    });
    frameRecipeRegion(sheet, labelRow.number, 1, stepsStartRow + presentationLines.length - 1, 4, recipeMediumBorder, false);
    sheet.addRow([]);
  }

  // ---- Photo grid: 2 tiles per row, each spanning 2 columns x TILE_ROWS sheet rows, cropped to
  // a square and grown-to-square (see squareCropBuffer/growBlockToSquare) for consistency with
  // the now-square main Photo cell on the other two sheets.
  const TILE_ROWS = 12;
  const photos = recipe.photos || [];
  for (let i = 0; i < photos.length; i += 2) {
    const rowStart = sheet.rowCount + 1;
    // for..of (not .forEach) since each tile's crop needs to be awaited in order.
    for (const [pairIdx, photo] of [photos[i], photos[i + 1]].entries()) {
      if (!photo) continue; // odd photo count -- last row's right tile just stays empty
      const c1 = pairIdx === 0 ? 1 : 3;
      const c2 = pairIdx === 0 ? 2 : 4;
      sheet.mergeCells(rowStart, c1, rowStart + TILE_ROWS - 1, c2);
      const ext = photo.ext || 'jpeg';
      const croppedBuffer = await squareCropBuffer(photo.buffer, ext);
      const imageId = workbook.addImage({ buffer: croppedBuffer, extension: ext });
      sheet.addImage(imageId, {
        tl: { col: c1 - 1, row: rowStart - 1 },
        br: { col: c2, row: rowStart + TILE_ROWS - 1 },
      });
      frameRecipeRegion(sheet, rowStart, c1, rowStart + TILE_ROWS - 1, c2, recipeMediumBorder, false);
    }
    growBlockToSquare(sheet, rowStart, rowStart + TILE_ROWS - 1, mergedWidthPx(sheet, 0, 1));
    sheet.addRow([]); // spacer row between tile rows
  }

  frameRecipeRegion(sheet, 1, 1, sheet.rowCount, 4, recipeThickBorder, true);
}

// Shared by both sheet names exportRecipes/exportScaledRecipe create for one recipe (the main
// sheet and, for a 2+-photo recipe, the photos sheet) so neither can collide with any other
// recipe's sheets in the same workbook.
function uniqueSheetName(usedNames, base) {
  let name = base.slice(0, 31);
  let n = 2;
  while (usedNames.has(name)) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  usedNames.add(name);
  return name;
}

// fetchRecipe(recipeId) -> Promise<{ recipe, processes, labels, targetLanguage, codeLabelKey }>,
// supplied by the caller (main.js reads its own recipe/process tables from Supabase, and
// translates when the export's target language isn't English) so this module stays DB/
// Anthropic-agnostic -- and, since the Recipe Book multi-process migration, recipe-type-agnostic
// too. Recipe Book and Recipe Extractor both call this same function with their own fetchRecipe,
// differing only in which tables that callback reads and which codeLabelKey it returns ('ttyCode'
// vs 'exCode'). `onProgress(message)` is optional -- called once, right before the (potentially
// slow, for a large multi-recipe workbook) final write -- so a batch export's status can move
// past "Translating recipe N of M…" (reported by fetchRecipe itself, which already tracks that
// loop) into a distinct final phase instead of sitting on a static "Exporting…" the whole time.
async function exportRecipes(fetchRecipe, recipeIds, savePath, onProgress) {
  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set();
  for (const recipeId of recipeIds) {
    const { recipe, processes, labels, targetLanguage, codeLabelKey } = await fetchRecipe(recipeId);
    const sheetName = uniqueSheetName(usedNames, sanitizeSheetName(recipe.name));
    await buildRecipeSheet(workbook, recipe, processes, sheetName, { labels, targetLanguage, codeLabelKey });

    if ((recipe.photos || []).length >= 2) {
      const photoSheetName = uniqueSheetName(usedNames, sanitizeSheetName(`${recipe.name} - Photos`));
      await buildRecipePhotosSheet(workbook, recipe, photoSheetName, { labels, targetLanguage });
    }
  }
  if (onProgress) onProgress('Building Excel file…');
  await workbook.xlsx.writeFile(savePath);
}

// Same builder as exportRecipes, but fed an in-memory (possibly scaled, possibly already
// translated) recipe + process list instead of a DB id -- nothing is read from or written to the
// database. `options.labels`/`options.targetLanguage`/`options.codeLabelKey` mirror exportRecipes'
// callback shape; `options.onProgress` mirrors it too. `processes` may be just the one process
// the chef chose to scale or the full set ("All Processes" mode), and `recipe.photos` gets the
// same 0-1-vs-2+ branching the regular export already has -- both handled entirely inside
// buildRecipeSheet/buildRecipePhotosSheet, nothing new to teach them here.
async function exportScaledRecipe(recipe, processes, savePath, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set();
  const sheetName = uniqueSheetName(usedNames, sanitizeSheetName(recipe.name));
  await buildRecipeSheet(workbook, recipe, processes, sheetName, options);

  if ((recipe.photos || []).length >= 2) {
    const photoSheetName = uniqueSheetName(usedNames, sanitizeSheetName(`${recipe.name} - Photos`));
    await buildRecipePhotosSheet(workbook, recipe, photoSheetName, options);
  }
  if (options.onProgress) options.onProgress('Building Excel file…');
  await workbook.xlsx.writeFile(savePath);
}

// ============================================================
// In-app export preview ("eye" icon on the Recipe Book/Extractor list rows) -- returns a plain,
// JSON-safe content model instead of writing to a worksheet, built from the exact same shared
// helpers (splitLines/sumQuantities/computeProcessTotals/resolveLabels) that buildRecipeSheet
// itself calls, so a numbering/rounding/label decision can never drift between what the real
// .xlsx shows and what the preview modal shows. Deliberately excludes photo bytes (the renderer
// already has ns.api.getPhoto/getPhotos for that) and is never passed a targetLanguage -- the
// preview always shows the recipe's original saved English content, regardless of what's
// selected in the list screen's export-language picker (translation only happens on an actual
// export). One entry per named process (each with its own ingredients/method/totals), and a
// hasSeparatePhotoSheet flag so the preview modal knows whether to also render a "Photos" page
// the way exportRecipes would (see buildRecipePhotosSheet) -- 2+ photos. Recipe Book recipes stay
// single-photo, so hasSeparatePhotoSheet is always false there -- no special-casing needed.
// ============================================================
function buildRecipeContentModel(recipe, processes, options = {}) {
  const labels = resolveLabels(options);
  const photoCount = (recipe.photos || []).length;
  const hasSeparatePhotoSheet = photoCount >= 2;
  const presentationLines = splitLines(recipe.presentation_serving);
  // See buildRecipeSheet's identical comment -- computed fresh from processes, not parsed out of
  // the yield_notes string, so the preview can never drift from what the real .xlsx shows.
  const combinedNetWeight = (processes || []).reduce((sum, proc) => sum + computeProcessTotals(proc).netWeight, 0);
  const portionsProduced = computePortionsProduced(combinedNetWeight, recipe.portion_weight_grams);

  return {
    labels,
    header: {
      name: recipe.name || '',
      code: recipe.code || '',
      quantityProduced: recipe.quantity_produced || '',
      portionWeight: recipe.portion_weight_grams ?? '',
      preparedBy: recipe.prepared_by || '',
      category: recipe.category || '',
      countryOrigin: recipe.country_origin || '',
      date: formatDateDDMMYYYY(recipe.date_created),
      netWeight: recipe.yield_notes || '',
      // Formatted here (not left as a bare number for the renderer to suffix) so the preview
      // shows exactly the same text buildRecipeSheet's own portionsRow does -- same reasoning as
      // totalQuantity/netWeight below.
      portionsProduced: portionsProduced != null ? `${portionsProduced} ${labels.portionsUnit}` : '',
    },
    processes: (processes || []).map(proc => {
      const methodLines = splitLines(proc.method);
      const { total, netWeight } = computeProcessTotals(proc);
      const traysNeeded = computeTraysNeeded(proc, netWeight);
      return {
        name: proc.name || '',
        ingredients: (proc.ingredients || []).map(ing => ({
          name: ing.ingredient_name || '', quantity: ing.quantity ?? '', unit: ing.unit || '', method: ing.method || '',
        })),
        materialName: proc.material_id ? (proc.material_code ? `${proc.material_code} — ${proc.material_name}` : (proc.material_name || '')) : '',
        traysNeeded: traysNeeded ?? '',
        // "G" suffix formatted here, not left for the caller to append, so the preview modal
        // (renderer.js's renderRecipePreviewBody, the only consumer of this model) shows the same
        // text as buildRecipeSheet's own procTotalRow/procNetRow without duplicating the format
        // string on the renderer side.
        totalQuantity: `${total} G`,
        // reduced/after mirror exactly what buildRecipeSheet's own waste rows now print (both
        // built from the same computeWasteWaterfall(total, proc.wastes) call), so the preview
        // modal can never show a different waterfall than the real export produces.
        wastes: (() => {
          const waterfall = computeWasteWaterfall(total, proc.wastes);
          return (proc.wastes || []).map((w, wi) => ({
            name: w.name,
            percent: w.percent,
            reduced: waterfall[wi].reduced > 0 ? `−${waterfall[wi].reduced} g` : '0 g',
            after: `${waterfall[wi].after} g`,
          }));
        })(),
        netWeight: `${netWeight} G`,
        method: { lines: methodLines, numbered: methodLines.length > 1 },
      };
    }),
    totalQuantity: `${sumQuantities((processes || []).flatMap(p => p.ingredients || []))} G`,
    photoCount,
    // Presentation text is shown either way in the real export -- inline beside the Photo cell
    // on the main sheet (buildRecipeSheet, photos.length <= 1) or above the photo grid on the
    // separate Photos sheet (buildRecipePhotosSheet, 2+ photos). This flag only tells the caller
    // (the preview renderer) WHERE to place `presentation`, not whether to.
    hasSeparatePhotoSheet,
    presentation: { lines: presentationLines, numbered: presentationLines.length > 1 },
    comment: recipe.comment || '',
    checkedBy: recipe.checked_by || '',
  };
}

module.exports = {
  exportSingleMenu, exportCombinedWorkbook, exportBlankTemplateWorkbook, exportRecipes, exportScaledRecipe,
  sanitizeSheetName, SECTION_DISPLAY_NAMES, DEFAULT_LABELS, buildRecipeContentModel,
};
