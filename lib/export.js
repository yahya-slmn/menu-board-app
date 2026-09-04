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
const CEO_ROW_MAP = {
  CEO_BREAKFAST_MAIN: { period: 'Breakfast', item: 'Main Dish' },
  CEO_RAW_VEG: { period: 'Breakfast', item: 'Raw Veg' },
  CEO_BREAKFAST_JUICE: { period: 'Breakfast', item: 'Juice' },
  CEO_YOGURT: { period: 'Breakfast', item: 'Yogurt' },
  CEO_LUNCH_MAIN: { period: 'Lunch', item: 'Main Dish' },
  CEO_SALAD: { period: 'Lunch', item: 'Salad' },
  CEO_LUNCH_JUICE: { period: 'Lunch', item: 'Juice' },
  CEO_FRUITS: { period: 'Lunch', item: 'Fruits' },
  CEO_BREAD: { period: 'Lunch', item: 'Bread' },
};

// Fixed, non-editable person columns for the CEO sheet -- both show identical content except
// CEO_BREAD_CODE, which CEO_BREAD_EXCLUDED_PERSON never gets (left entirely blank: no value,
// no RC, no dropdown).
const CEO_PERSONS = ['Dr Steffen', 'Khodary'];
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
  STAFF_FRUIT_BASKET: { period: 'Lunch', item: 'Fruit Basket' },
  STAFF_JUICE: { period: 'Lunch', item: 'Juice' },
  STAFF_LUNCHBOX: { period: 'Lunch Box', item: null },
  STAFF_LUNCHBOX_SALAD: { period: 'Lunch Box', item: null },
};
const centerMiddle = { horizontal: 'center', vertical: 'middle', wrapText: true };

function fillCell(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ============================================================
// School sections (Daycare / KG-LP / MS-UP) -- age-group columns
// with GM/ML unit header + blank B=/L=/P= pax header per group
// ============================================================
// exportData comes from main.js's fetchGeneratedMenuExportData(): { section, ageGroups,
// days: [{ id, menu_date, day_of_week, items: [{item_id, name, rc_code, is_daily_repeating,
// category_name, category_code, meal_period_name, period_order, cat_order}] }], getPortion }
// -- all of it lives in Supabase now (generated_menus/menu_days/menu_day_items/menu_items/
// item_portions as tables; sections/age_groups/categories/meal_periods via the cached
// lib/referenceData.js accessors), pre-joined into this shape asynchronously before this
// (still fully synchronous) builder runs.
function buildSchoolSheet(workbook, exportData, sheetName) {
  const { section, ageGroups, days, getPortion } = exportData;

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  // Columns: 1=Meal Period, 2=Category, 3=RC, 4=Item Name, then per age group: unit + pax
  sheet.columns = [
    { width: 16 }, { width: 20 }, { width: 14 }, { width: 60 },
    ...ageGroups.flatMap(() => [{ width: 14 }, { width: 22 }]),
  ];
  const totalCols = 4 + ageGroups.length * 2;

  for (const day of days) {
    const items = day.items.slice().sort((a, b) => (a.period_order - b.period_order) || (a.cat_order - b.cat_order));

    const headerRow = sheet.addRow([
      formatDateDDMMYYYY(day.menu_date), day.day_of_week.toUpperCase(), 'RC', '',
      ...ageGroups.flatMap(ag => ['GM/ML', `${ag.name} - B= L= P=`]),
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

    items.forEach((it, idx) => {
      const rowValues = ['', it.category_name, it.rc_code || 'NEW', it.name];
      for (const ag of ageGroups) {
        const portion = getPortion(it.item_id, ag.id);
        rowValues.push(portion ? `${portion.quantity}${portion.unit}` : '');
        rowValues.push('');
      }
      const row = sheet.addRow(rowValues);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 2) fillCell(cell, GREY);
        if (colNumber === 3 && (it.rc_code === 'NEW' || !it.rc_code)) {
          cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FFB00000' } };
        }
      });
      if (it.is_daily_repeating !== 1) {
        const spec = { definedName: definedNameFor(section.code, it.category_code), lookupName: lookupNameFor(section.code, it.category_code) };
        const nameCellAddr = `D${row.number}`;
        row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(3).value = { formula: lookupFormula(nameCellAddr, spec, 2) };
        ageGroups.forEach((ag, agIdx) => {
          const portionCol = 5 + agIdx * 2;
          row.getCell(portionCol).value = { formula: lookupFormula(nameCellAddr, spec, 3 + agIdx) };
        });
      }

      const rowNum = row.number;
      if (it.category_name !== lastCategory) {
        if (lastCategory !== null) {
          sheet.mergeCells(categoryRunStart, 2, rowNum - 1, 2);
          if (!NO_CATEGORY_LINES.has(section.code)) markCategoryBoundary(sheet, rowNum, 1, totalCols);
        }
        categoryRunStart = rowNum; lastCategory = it.category_name;
      }
      if (it.meal_period_name !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          sheet.getCell(periodRunStart, 1).value = lastPeriod;
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
// Staff (buffet order form) -- Category | Item | Weight | blank
// order-count columns per department, for kitchen to fill in
// ============================================================
function buildStaffSheet(workbook, exportData, sheetName) {
  const { days, ageGroups, getPortion } = exportData;
  const staffAgeGroupId = ageGroups[0]?.id;

  const DEPARTMENTS = ['Admin', 'LP', 'KG', 'UPB', 'M&SB', 'M&SG', 'UPG'];
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  // Columns: 1=Meal Period, 2=Item Type, 3=RC, 4=Item, 5=Weight, then departments
  sheet.columns = [
    { width: 14 }, { width: 18 }, { width: 14 }, { width: 50 }, { width: 14 },
    ...DEPARTMENTS.map(() => ({ width: 10 })),
  ];
  const totalCols = 5 + DEPARTMENTS.length;

  for (const day of days) {
    // Fixed STAFF_ROW_MAP order (Breakfast, then Lunch, then Lunch Box), not the DB's own
    // cat_order -- each category can have several items (e.g. 6 STAFF_BREAKFAST picks), so
    // this flattens all of them per category rather than assuming one row per category.
    const items = Object.keys(STAFF_ROW_MAP)
      .flatMap(code => day.items.filter(it => it.category_code === code))
      .map(it => {
        const portion = staffAgeGroupId ? getPortion(it.item_id, staffAgeGroupId) : null;
        return { ...it, unit: portion?.unit, quantity: portion?.quantity };
      });
    const headerRow = sheet.addRow([
      day.day_of_week.toUpperCase(), '', 'RC', formatDateDDMMYYYY(day.menu_date), 'Weight/Unit', ...DEPARTMENTS,
    ]);
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

      const weight = it.quantity ? `${it.quantity}${it.unit}` : '';
      const row = sheet.addRow([map.period, itemLabel, it.rc_code || 'NEW', it.name, weight, ...DEPARTMENTS.map(() => '')]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 11 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
        if (colNumber === 3 && (it.rc_code === 'NEW' || !it.rc_code)) {
          cell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFB00000' } };
        }
      });
      if (it.is_daily_repeating !== 1) {
        const spec = { definedName: definedNameFor('STAFF', it.category_code), lookupName: lookupNameFor('STAFF', it.category_code) };
        const nameCellAddr = `D${row.number}`;
        row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(3).value = { formula: lookupFormula(nameCellAddr, spec, 2) };
        row.getCell(5).value = { formula: lookupFormula(nameCellAddr, spec, 3) };
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
// Columns: 1=Meal Period, 2=Item Type, 3=RC(Steffen), 4=Item(Steffen), 5=RC(Khodary), 6=Item(Khodary).
// Both person-columns show identical content except CEO_BREAD_CODE, which
// CEO_BREAD_EXCLUDED_PERSON never gets at all (blank, no dropdown) -- see CEO_ROW_MAP notes.
function buildCeoSheet(workbook, exportData, sheetName) {
  const { days } = exportData;

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = [
    { width: 14 }, { width: 16 }, { width: 12 }, { width: 42 }, { width: 12 }, { width: 42 },
  ];

  for (const day of days) {
    // Fixed CEO_ROW_MAP order (Breakfast items, then Lunch items), not the DB's own cat_order.
    const items = Object.keys(CEO_ROW_MAP)
      .map(code => day.items.find(it => it.category_code === code))
      .filter(Boolean);

    const headerRow = sheet.addRow([
      day.day_of_week.toUpperCase(), formatDateDDMMYYYY(day.menu_date), 'RC', CEO_PERSONS[0], 'RC', CEO_PERSONS[1],
    ]);
    headerRow.height = 22;
    headerRow.eachCell(cell => {
      fillCell(cell, GREEN);
      cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    });

    let lastPeriod = null, periodRunStart = null;
    let lastItemLabel = null, itemRunStart = null;
    items.forEach((it, idx) => {
      const map = CEO_ROW_MAP[it.category_code];
      const isBreadRow = it.category_code === CEO_BREAD_CODE;
      const rcDisplay = it.rc_code || 'NEW';

      const row = sheet.addRow([map.period, map.item, rcDisplay, it.name, rcDisplay, it.name]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
        if ((colNumber === 3 || colNumber === 5) && !it.rc_code) {
          cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FFB00000' } };
        }
      });

      if (it.is_daily_repeating !== 1) {
        const spec = { definedName: definedNameFor('CEO', it.category_code), lookupName: lookupNameFor('CEO', it.category_code) };
        const khodaryNameAddr = `F${row.number}`;
        row.getCell(6).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(5).value = { formula: lookupFormula(khodaryNameAddr, spec, 2) };
        if (!isBreadRow) {
          const steffenNameAddr = `D${row.number}`;
          row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
          row.getCell(3).value = { formula: lookupFormula(steffenNameAddr, spec, 2) };
        }
      }

      // CEO_BREAD_EXCLUDED_PERSON never gets Bread -- blank his side entirely for this row,
      // overriding whatever the blocks above just set (value, RC display, "missing RC" font).
      if (isBreadRow) {
        row.getCell(3).value = '';
        row.getCell(4).value = '';
        row.getCell(3).font = { name: 'Calibri', size: 12 };
      }

      const rowNum = row.number;
      if (map.period !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          markCategoryBoundary(sheet, rowNum, 1, 6);
        }
        periodRunStart = rowNum; lastPeriod = map.period;
      }
      if (map.item !== lastItemLabel) {
        if (lastItemLabel !== null) sheet.mergeCells(itemRunStart, 2, rowNum - 1, 2);
        itemRunStart = rowNum; lastItemLabel = map.item;
      }
      if (idx === items.length - 1) {
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.mergeCells(itemRunStart, 2, rowNum, 2);
      }
    });
    const spacerRow = sheet.addRow([]);
    if (day.day_of_week === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, 6);
  }
}

// ============================================================
// Blank template builders -- same visual layout as the real
// builders above, but rows are synthesized from SECTION_SLOTS +
// each section's Supabase item pool instead of a real generated
// menu, since there is no menu yet. Daily-repeating slots are
// pre-filled (matching in-app auto-fill behavior); everything
// else is a blank cell with an Excel data-validation dropdown
// wired to a named range. listsData comes from main.js's
// fetchListsSheetData() -- the same Supabase-backed fetch already
// used by the real single/combined menu exports (Stage 4).
// ============================================================

function definedNameFor(sectionCode, categoryCode) {
  return `List_${sectionCode}_${categoryCode}`;
}

// Lookup table (name + RC + grammage/weight columns) for the same category+section pool,
// so the RC/portion cells next to a dropdown can look up whatever the person picks.
function lookupNameFor(sectionCode, categoryCode) {
  return `Lookup_${sectionCode}_${categoryCode}`;
}

const SCHOOL_SECTIONS = new Set(['DAYCARE', 'KG_LP', 'MS_UP']);

const VALIDATION_STYLE = {
  type: 'list', allowBlank: true, showErrorMessage: true,
  errorTitle: 'Invalid item', error: 'Please choose from the list.',
};

// Excel-2007-compatible INDEX/MATCH (not XLOOKUP): MATCH finds the picked item's row in
// the dropdown's own name range, INDEX pulls the value at that row from the lookup block's
// `colIndex`-th column (1 = name, 2 = RC, 3+ = grammage/weight). IFERROR only catches a
// genuinely unmatched name (blank cell, or text outside the dropdown) -- an item that's
// legitimately missing an RC code still resolves to the literal "NEW" stored in the table.
function lookupFormula(nameCellAddr, spec, colIndex) {
  return `IFERROR(INDEX(${spec.lookupName},MATCH(${nameCellAddr},${spec.definedName},0),${colIndex}),"")`;
}

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
        lookupName: !isDaily && items.length > 0 ? lookupNameFor(sectionCode, categoryCode) : null,
      });
    }
  }
  specs.sort((a, b) => (a.periodSortOrder - b.periodSortOrder) || (a.catSortOrder - b.catSortOrder));
  return specs;
}

function buildSchoolTemplateSheet(workbook, listsData, sectionCode, sheetName, days) {
  const { ageGroups } = listsData.bySection[sectionCode];
  const getPortion = listsData.getPortion;
  const specs = buildSlotSpecsFromData(sectionCode, listsData);

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = [
    { width: 16 }, { width: 20 }, { width: 14 }, { width: 60 },
    ...ageGroups.flatMap(() => [{ width: 14 }, { width: 22 }]),
  ];
  const totalCols = 4 + ageGroups.length * 2;

  for (const day of days) {
    const headerRow = sheet.addRow([
      formatDateDDMMYYYY(day.date), day.weekday.toUpperCase(), 'RC', '',
      ...ageGroups.flatMap(ag => ['GM/ML', `${ag.name} - B= L= P=`]),
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
      const rc = spec.isDaily ? (spec.dailyItem.rc_code || 'NEW') : '';
      const rowValues = ['', spec.categoryName, rc, name];
      for (const ag of ageGroups) {
        const portion = spec.isDaily ? getPortion(spec.dailyItem.id, ag.id) : null;
        rowValues.push(portion ? `${portion.quantity}${portion.unit}` : '');
        rowValues.push('');
      }
      const row = sheet.addRow(rowValues);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 2) fillCell(cell, GREY);
        if (colNumber === 3 && spec.isDaily && (spec.dailyItem.rc_code === 'NEW' || !spec.dailyItem.rc_code)) {
          cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FFB00000' } };
        }
      });
      if (spec.definedName) {
        const nameCellAddr = `D${row.number}`;
        row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(3).value = { formula: lookupFormula(nameCellAddr, spec, 2) };
        ageGroups.forEach((ag, agIdx) => {
          const portionCol = 5 + agIdx * 2;
          row.getCell(portionCol).value = { formula: lookupFormula(nameCellAddr, spec, 3 + agIdx) };
        });
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

  const staffAgeGroup = listsData.bySection[sectionCode].ageGroups[0];
  const getPortion = listsData.getPortion;

  const DEPARTMENTS = ['Admin', 'LP', 'KG', 'UPB', 'M&SB', 'M&SG', 'UPG'];
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = [
    { width: 14 }, { width: 18 }, { width: 14 }, { width: 50 }, { width: 14 },
    ...DEPARTMENTS.map(() => ({ width: 10 })),
  ];
  const totalCols = 5 + DEPARTMENTS.length;

  for (const day of days) {
    const headerRow = sheet.addRow([
      day.weekday.toUpperCase(), '', 'RC', formatDateDDMMYYYY(day.date), 'Weight/Unit', ...DEPARTMENTS,
    ]);
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
      const rc = spec.isDaily ? (spec.dailyItem.rc_code || 'NEW') : '';
      const portion = spec.isDaily && staffAgeGroup ? getPortion(spec.dailyItem.id, staffAgeGroup.id) : null;
      const weight = portion ? `${portion.quantity}${portion.unit}` : '';

      const row = sheet.addRow([map.period, itemLabel, rc, name, weight, ...DEPARTMENTS.map(() => '')]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 11 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
        if (colNumber === 3 && spec.isDaily && (spec.dailyItem.rc_code === 'NEW' || !spec.dailyItem.rc_code)) {
          cell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFB00000' } };
        }
      });
      if (spec.definedName) {
        const nameCellAddr = `D${row.number}`;
        row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(3).value = { formula: lookupFormula(nameCellAddr, spec, 2) };
        row.getCell(5).value = { formula: lookupFormula(nameCellAddr, spec, 3) };
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
  const specs = Object.keys(CEO_ROW_MAP).flatMap(code => specsByCategory.get(code) || []);

  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.columns = [
    { width: 14 }, { width: 16 }, { width: 12 }, { width: 42 }, { width: 12 }, { width: 42 },
  ];

  for (const day of days) {
    const headerRow = sheet.addRow([
      day.weekday.toUpperCase(), formatDateDDMMYYYY(day.date), 'RC', CEO_PERSONS[0], 'RC', CEO_PERSONS[1],
    ]);
    headerRow.height = 22;
    headerRow.eachCell(cell => {
      fillCell(cell, GREEN);
      cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = allBorders;
      cell.alignment = centerMiddle;
    });

    let lastPeriod = null, periodRunStart = null;
    let lastItemLabel = null, itemRunStart = null;
    specs.forEach((spec, idx) => {
      const map = CEO_ROW_MAP[spec.categoryCode];
      const isBreadRow = spec.categoryCode === CEO_BREAD_CODE;
      const name = spec.isDaily ? spec.dailyItem.name : '';
      const rc = spec.isDaily ? (spec.dailyItem.rc_code || 'NEW') : '';

      const row = sheet.addRow([map.period, map.item, rc, name, rc, name]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = allBorders;
        cell.alignment = centerMiddle;
        cell.font = { name: 'Calibri', size: 12 };
        if (colNumber === 1 || colNumber === 2) fillCell(cell, GREY);
        if ((colNumber === 3 || colNumber === 5) && spec.isDaily && (spec.dailyItem.rc_code === 'NEW' || !spec.dailyItem.rc_code)) {
          cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FFB00000' } };
        }
      });

      if (spec.definedName) {
        const khodaryNameAddr = `F${row.number}`;
        row.getCell(6).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
        row.getCell(5).value = { formula: lookupFormula(khodaryNameAddr, spec, 2) };
        if (!isBreadRow) {
          const steffenNameAddr = `D${row.number}`;
          row.getCell(4).dataValidation = { ...VALIDATION_STYLE, formulae: [spec.definedName] };
          row.getCell(3).value = { formula: lookupFormula(steffenNameAddr, spec, 2) };
        }
      }

      // CEO_BREAD_EXCLUDED_PERSON never gets Bread, even on the blank template.
      if (isBreadRow) {
        row.getCell(3).value = '';
        row.getCell(4).value = '';
        row.getCell(3).font = { name: 'Calibri', size: 12 };
      }

      const rowNum = row.number;
      if (map.period !== lastPeriod) {
        if (lastPeriod !== null) {
          sheet.mergeCells(periodRunStart, 1, rowNum - 1, 1);
          markCategoryBoundary(sheet, rowNum, 1, 6);
        }
        periodRunStart = rowNum; lastPeriod = map.period;
      }
      if (map.item !== lastItemLabel) {
        if (lastItemLabel !== null) sheet.mergeCells(itemRunStart, 2, rowNum - 1, 2);
        itemRunStart = rowNum; lastItemLabel = map.item;
      }
      if (idx === specs.length - 1) {
        sheet.mergeCells(periodRunStart, 1, rowNum, 1);
        sheet.mergeCells(itemRunStart, 2, rowNum, 2);
      }
    });
    const spacerRow = sheet.addRow([]);
    if (day.weekday === 'Thursday') fillWeekSeparatorRow(spacerRow, 1, 6);
  }
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

// Hidden helper sheet: one block of columns per category+section that needs a dropdown --
// [Name, RC, <grammage per age group, or weight for Staff>] -- so the visible sheets' RC/
// portion cells can look up whichever item the person picks. `List_*` names the Name
// column alone (for the dropdown's validation list); `Lookup_*` names the whole block.
// Shared by every export that needs named-range dropdowns: single/combined real menu
// exports and the Blank Menu template alike. listsData comes from main.js's
// fetchListsSheetData(): { bySection: { [sectionCode]: { ageGroups: [{id,name}], categories:
// { [categoryCode]: { items: [{id,name,rc_code,is_daily_repeating}], meta } } } }, getPortion }
function buildListsSheetFromData(workbook, order, listsData) {
  const listsSheet = workbook.addWorksheet('_Lists', { state: 'veryHidden' });
  const { bySection, getPortion } = listsData;

  let col = 1;
  const registered = new Set();
  for (const sectionCode of order) {
    const { ageGroups, categories } = bySection[sectionCode];
    const staffAgeGroup = sectionCode === 'STAFF' ? ageGroups[0] : null;

    for (const [categoryCode] of SECTION_SLOTS[sectionCode]) {
      const key = `${sectionCode}:${categoryCode}`;
      if (registered.has(key)) continue;
      registered.add(key);

      const items = categories[categoryCode].items;
      const isDaily = items.some(i => i.is_daily_repeating === 1);
      if (isDaily || items.length === 0) continue; // pre-filled or no options -- no dropdown needed

      const nameCol = col;
      const rcCol = col + 1;
      const extraCols = SCHOOL_SECTIONS.has(sectionCode) ? ageGroups.length : (sectionCode === 'STAFF' ? 1 : 0);

      items.forEach((it, i) => {
        const r = i + 1;
        listsSheet.getCell(r, nameCol).value = it.name;
        listsSheet.getCell(r, rcCol).value = it.rc_code || 'NEW';
        if (SCHOOL_SECTIONS.has(sectionCode)) {
          ageGroups.forEach((ag, agIdx) => {
            const p = getPortion(it.id, ag.id);
            listsSheet.getCell(r, rcCol + 1 + agIdx).value = p ? `${p.quantity}${p.unit}` : '';
          });
        } else if (sectionCode === 'STAFF' && staffAgeGroup) {
          const p = getPortion(it.id, staffAgeGroup.id);
          listsSheet.getCell(r, rcCol + 1).value = p ? `${p.quantity}${p.unit}` : '';
        }
      });

      const nameColL = colLetter(nameCol);
      const lastColL = colLetter(rcCol + extraCols);
      workbook.definedNames.add(`'_Lists'!$${nameColL}$1:$${nameColL}$${items.length}`, definedNameFor(sectionCode, categoryCode));
      workbook.definedNames.add(`'_Lists'!$${nameColL}$1:$${lastColL}$${items.length}`, lookupNameFor(sectionCode, categoryCode));

      col = rcCol + extraCols + 1;
    }
  }
}

// fetchListsData(sectionCodes) -> Promise<listsData>, the same Supabase-backed fetcher
// main.js passes to exportSingleMenu/exportCombinedWorkbook (Stage 4) -- menu_items/
// item_portions live in Supabase, so the template's item pools come from there too now.
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
// rounded to 2dp to avoid floating-point noise (0.1 + 0.2 -> 0.30000000000000004).
function sumQuantities(ingredients) {
  const raw = (ingredients || []).reduce((sum, ing) => {
    const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
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

function computeProcessTotals(proc) {
  const total = sumQuantities(proc.ingredients);
  const netWeight = Math.round(compoundNetWeight(total, proc.wastes) * 100) / 100;
  return { total, netWeight };
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
  materialLabel: 'Material / Tray',
  fillWeight: 'Fill Weight (g)',
  traysNeeded: 'Trays Needed',
  date: 'Date',
  ttyCode: 'TTY Code',
  exCode: 'EX Code',
  ingredientsHeader: 'INGREDIENTS',
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
function addOptionalFieldRow(sheet, label, value, align) {
  const trimmed = (value ?? '').toString().trim();
  if (!trimmed) return null;
  const text = `${label}: ${trimmed}`;
  const row = sheet.addRow([text]);
  sheet.mergeCells(row.number, 1, row.number, 4);
  // Excel does not auto-size row height for merged cells even with wrapText set (confirmed by
  // inspecting a generated file directly -- every such row came back with height left unset,
  // regardless of actual content length) -- an explicit estimate is required, not optional,
  // for a long Comment/Checked By value in particular.
  row.height = estimateWrappedRowHeight(text, mergedWidthPx(sheet, 0, 3), 13);
  sheet.getCell(row.number, 1).font = { size: 13, name: RECIPE_FONT };
  sheet.getCell(row.number, 1).alignment = { horizontal: align || 'left', vertical: 'top', wrapText: true };
  return row;
}

async function buildRecipeSheet(workbook, recipe, processes, sheetName, options = {}) {
  const labels = resolveLabels(options);
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [{ width: 29.5 }, { width: 9.2 }, { width: 10 }, { width: 49.7 }];
  sheet.pageSetup = { paperSize: 9, orientation: 'portrait', fitToWidth: 1, fitToHeight: 0, horizontalCentered: true };

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
  const nameRow = sheet.addRow([null, labels.recipeFor, null, recipe.name]);
  sheet.mergeCells(nameRow.number, 2, nameRow.number, 3);
  nameRow.height = 28;
  sheet.getCell(`B${nameRow.number}`).font = { bold: true, underline: true, size: 16, name: RECIPE_FONT };
  sheet.getCell(`B${nameRow.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`D${nameRow.number}`).font = { size: 14, name: 'Arial' };
  sheet.getCell(`D${nameRow.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  fillRecipeRegion(sheet, nameRow.number, 1, nameRow.number, 4, RECIPE_SECTION_FILL);

  // codeLabelKey ('ttyCode' or 'exCode') picks which DEFAULT_LABELS entry labels the code --
  // defaults to 'exCode' so a caller that omits it (none should, but a safe fallback matters
  // more than a hard error here) still produces a real label rather than `undefined: ...`.
  const codeLabelKey = options.codeLabelKey || 'exCode';
  const codeRow = sheet.addRow([`${labels[codeLabelKey]}: ${recipe.code}`]);
  sheet.mergeCells(codeRow.number, 1, codeRow.number, 4);
  sheet.getCell(`A${codeRow.number}`).font = { size: 9, italic: true, name: RECIPE_FONT, color: { argb: 'FF8A8477' } };
  sheet.getCell(`A${codeRow.number}`).alignment = { horizontal: 'right' };

  addOptionalFieldRow(sheet, labels.quantityProduced, recipe.quantity_produced, dataAlign);
  addOptionalFieldRow(sheet, labels.portionWeight, recipe.portion_weight_grams, dataAlign);
  addOptionalFieldRow(sheet, labels.preparedBy, recipe.prepared_by, dataAlign);
  addOptionalFieldRow(sheet, labels.category, recipe.category, dataAlign);
  addOptionalFieldRow(sheet, labels.countryOrigin, recipe.country_origin, dataAlign);
  addOptionalFieldRow(sheet, labels.date, formatDateDDMMYYYY(recipe.date_created), dataAlign);

  // Net Weight/Yield is always shown -- computed live as the sum of every process's own Net
  // Weight (see the per-process Total Quantity/Waste/Net Weight rows below), so it's
  // effectively never truly blank the way the fields above can be. There's no recipe-level
  // Waste row anymore -- waste is set per process now, not on the recipe as a whole.
  const yieldRow = sheet.addRow([`${labels.netWeight}: ${recipe.yield_notes || ''}`]);
  sheet.mergeCells(yieldRow.number, 1, yieldRow.number, 4);
  sheet.getCell(`A${yieldRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT, color: { argb: 'FFFF0000' } };

  let lastHeaderRowNumber = yieldRow.number;
  // Portions Produced -- computed here (not read off yield_notes, a free-text string) from the
  // same per-process Net Weight figures the section loop below prints, summed fresh, so it can
  // never drift from what this exact sheet actually shows even if yield_notes were ever stale.
  const combinedNetWeight = (processes || []).reduce((sum, proc) => sum + computeProcessTotals(proc).netWeight, 0);
  const portionsProduced = computePortionsProduced(combinedNetWeight, recipe.portion_weight_grams);
  if (portionsProduced != null) {
    const portionsRow = sheet.addRow([`${labels.portionsProduced}: ${portionsProduced}`]);
    sheet.mergeCells(portionsRow.number, 1, portionsRow.number, 4);
    sheet.getCell(`A${portionsRow.number}`).font = { bold: true, size: 12, name: RECIPE_FONT };
    lastHeaderRowNumber = portionsRow.number;
  }

  frameRecipeRegion(sheet, nameRow.number, 1, lastHeaderRowNumber, 4, recipeMediumBorder, false);
  sheet.addRow([]);

  // ---- One section per process: name heading (always), then an ingredients table (only if
  // that process has any) and a Method block (only if that process has method text).
  let allIngredients = [];
  for (const proc of processes) {
    const headingText = proc.name || '';
    const headingRow = sheet.addRow([headingText]);
    sheet.mergeCells(headingRow.number, 1, headingRow.number, 4);
    headingRow.height = estimateWrappedRowHeight(headingText, mergedWidthPx(sheet, 0, 3), 14);
    sheet.getCell(`A${headingRow.number}`).font = { bold: true, size: 14, name: RECIPE_FONT };
    sheet.getCell(`A${headingRow.number}`).alignment = { horizontal: dataAlign, wrapText: true };
    fillRecipeRegion(sheet, headingRow.number, 1, headingRow.number, 4, RECIPE_SECTION_FILL);
    let sectionLastRow = headingRow.number;

    const procIngredients = proc.ingredients || [];
    if (procIngredients.length > 0) {
      allIngredients = allIngredients.concat(procIngredients);
      // "Note", not "METHOD" -- this column holds a short per-ingredient note (e.g. "optional"),
      // distinct from the process-level "Method:" steps block below the table. Recipe Book's
      // own ingredient table (buildRecipeSheet, above) keeps "METHOD" -- not touched here.
      const header = sheet.addRow([labels.ingredientsHeader, labels.quantityHeader, labels.unitHeader, labels.noteColumnHeader]);
      header.height = 20;
      header.eachCell({ includeEmpty: true }, cell => {
        cell.font = { bold: true, underline: true, size: 13, name: RECIPE_FONT };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });

      procIngredients.forEach(ing => {
        const row = sheet.addRow([ing.ingredient_name, ing.quantity ?? '', ing.unit || '', ing.method || '']);
        row.getCell(1).font = { size: 13, name: RECIPE_FONT };
        row.getCell(1).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        row.getCell(2).font = { size: 13, name: RECIPE_FONT };
        row.getCell(2).alignment = { horizontal: 'center', wrapText: true };
        row.getCell(3).font = { size: 13, name: RECIPE_FONT };
        row.getCell(3).alignment = { horizontal: 'center', wrapText: true };
        row.getCell(4).font = { size: 13, name: RECIPE_FONT };
        row.getCell(4).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
      });

      // This process's own Total Quantity/Waste/Net Weight -- same arithmetic as the form's live
      // per-process calc (updateProcessNetWeight in renderer.js), printed here since it's
      // actionable per-component info (unlike the old recipe-level blanket waste%, which was
      // deliberately kept internal-only).
      const { total: procTotal, netWeight: procNetWeight } = computeProcessTotals(proc);

      const procTotalRow = sheet.addRow([labels.totalQuantity, procTotal]);
      procTotalRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
      procTotalRow.getCell(2).font = { size: 12, name: RECIPE_FONT };
      procTotalRow.getCell(2).alignment = { horizontal: 'center' };

      // One row per applied waste type (e.g. "Baking Waste: 8%", "Trimming Waste: 5%") --
      // omitted entirely when the process has none, same convention as every other optional
      // row on this sheet. Each row uses the waste type's own chef-entered name, not a fixed
      // label, since there's no single generic "Waste" line anymore.
      (proc.wastes || []).forEach(w => {
        const procWasteRow = sheet.addRow([w.name, `${w.percent}%`]);
        procWasteRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procWasteRow.getCell(2).font = { size: 12, name: RECIPE_FONT };
        procWasteRow.getCell(2).alignment = { horizontal: 'center' };
      });

      const procNetRow = sheet.addRow([labels.netWeight, procNetWeight]);
      procNetRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
      procNetRow.getCell(2).font = { size: 12, name: RECIPE_FONT };
      procNetRow.getCell(2).alignment = { horizontal: 'center' };
      let procClosingRow = procNetRow;

      // Material/Tray + Trays Needed -- omitted entirely when this process has no material
      // linked, same "no placeholder" convention as the Wastes Applied rows above.
      const traysNeeded = computeTraysNeeded(proc, procNetWeight);
      if (proc.material_id && traysNeeded != null) {
        const materialLabel = proc.material_code ? `${proc.material_code} — ${proc.material_name}` : (proc.material_name || '');
        const procMaterialRow = sheet.addRow([labels.materialLabel, materialLabel]);
        procMaterialRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procMaterialRow.getCell(2).font = { size: 12, name: RECIPE_FONT };
        procMaterialRow.getCell(2).alignment = { horizontal: 'center' };

        const procTraysRow = sheet.addRow([labels.traysNeeded, traysNeeded]);
        procTraysRow.getCell(1).font = { bold: true, size: 12, name: RECIPE_FONT };
        procTraysRow.getCell(2).font = { size: 12, name: RECIPE_FONT };
        procTraysRow.getCell(2).alignment = { horizontal: 'center' };
        procClosingRow = procTraysRow;
      }

      // Grid extended through here (was previously applied right after the ingredient rows,
      // before Quantity Produced/Total Quantity/Waste/Net Weight existed) -- confirmed by
      // inspecting a generated file directly that these 4 rows had NO borders at all, a real
      // gap between the ingredient table's closing line and the Method block below, not just a
      // styling nitpick. The section's actual closing row (Net Weight, or Trays Needed when a
      // material is linked) gets the same fill the process heading uses, bookending the section
      // the same way buildRecipeSheet's own Total Quantity row now does.
      gridRecipeRegion(sheet, header.number, 1, sheet.rowCount, 4, thinBorder);
      fillRecipeRegion(sheet, procClosingRow.number, 1, procClosingRow.number, 4, RECIPE_SECTION_FILL);

      sectionLastRow = sheet.rowCount;
    }

    const methodText = proc.method || '';
    const methodLines = splitLines(methodText);
    if (methodLines.length > 0) {
      const methodLabelRow = sheet.addRow([labels.methodLabel]);
      sheet.getCell(`A${methodLabelRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT };

      // Same "more than one non-empty line -> numbered steps" heuristic buildRecipeSheet's
      // Preparation and Cooking block uses (mirrors initTextListField's Text/List detection).
      const methodMergedWidthPx = mergedWidthPx(sheet, 0, 3);
      if (methodLines.length > 1) {
        methodLines.forEach((line, idx) => {
          const stepText = `${idx + 1}. ${line}`;
          const stepRow = sheet.addRow([stepText]);
          sheet.mergeCells(stepRow.number, 1, stepRow.number, 4);
          stepRow.height = estimateWrappedRowHeight(stepText, methodMergedWidthPx, 13);
          sheet.getCell(`A${stepRow.number}`).font = { size: 13, name: RECIPE_FONT };
          sheet.getCell(`A${stepRow.number}`).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        });
      } else {
        const valueRow = sheet.addRow([methodText]);
        sheet.mergeCells(valueRow.number, 1, valueRow.number, 4);
        // Excel does not auto-size row height for merged cells even with wrapText set --
        // confirmed by inspecting a generated file directly; an explicit estimate is required.
        valueRow.height = estimateWrappedRowHeight(methodText, methodMergedWidthPx, 13);
        sheet.getCell(`A${valueRow.number}`).font = { size: 13, name: RECIPE_FONT };
        sheet.getCell(`A${valueRow.number}`).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
      }
      sectionLastRow = sheet.rowCount;
    }

    frameRecipeRegion(sheet, headingRow.number, 1, sectionLastRow, 4, recipeMediumBorder, false);
    sheet.addRow([]);
  }

  // ---- Total Quantity: aggregate across every process's ingredients combined (raw, before any
  // waste is applied) -- same convention as buildRecipeSheet's. Distinct from the recipe-level
  // Net Weight above, which sums each process's own waste-adjusted Net Weight instead (see
  // updateNetWeightSum/updateProcessNetWeight in renderer.js).
  const totalRow = sheet.addRow([labels.totalQuantity, sumQuantities(allIngredients)]);
  totalRow.getCell(1).font = { bold: true, size: 13, name: RECIPE_FONT };
  totalRow.getCell(2).font = { bold: true, size: 13, name: RECIPE_FONT };
  totalRow.getCell(2).alignment = { horizontal: 'center' };
  frameRecipeRegion(sheet, totalRow.number, 1, totalRow.number, 4, recipeMediumBorder, false);
  sheet.addRow([]);

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
      sheet.mergeCells(blockStartRow, 3, blockStartRow, 4);
      sheet.getCell(blockStartRow, 3).value = labels.presentationDecorationServing;
      sheet.getCell(blockStartRow, 3).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT };
      fillRecipeRegion(sheet, blockStartRow, 3, blockStartRow, 4, RECIPE_SECTION_FILL);

      const numberLines = presentationLines.length > 1;
      const presMergedWidthPx = mergedWidthPx(sheet, 2, 3);
      presentationLines.forEach((line, i) => {
        const rowNum = blockStartRow + 1 + i;
        const lineText = numberLines ? `${i + 1}. ${line}` : line;
        sheet.mergeCells(rowNum, 3, rowNum, 4);
        sheet.getCell(rowNum, 3).value = lineText;
        sheet.getCell(rowNum, 3).font = { size: 13, name: RECIPE_FONT };
        sheet.getCell(rowNum, 3).alignment = { horizontal: dataAlign, vertical: 'top', wrapText: true };
        sheet.getRow(rowNum).height = estimateWrappedRowHeight(lineText, presMergedWidthPx, 13);
      });
    }

    // Grows this block's rows (never shrinks -- Presentation's own per-line heights above are
    // never clipped) just enough that the A:B photo box comes out square.
    growBlockToSquare(sheet, blockStartRow, blockStartRow + presentationRowCount, mergedWidthPx(sheet, 0, 1));

    frameRecipeRegion(sheet, blockStartRow, 1, blockStartRow + presentationRowCount, 4, recipeMediumBorder, false);
    sheet.addRow([]);
  }

  // ---- Comment / Checked By -- each its own row, omitted entirely when blank.
  const commentRow = addOptionalFieldRow(sheet, labels.comment, recipe.comment, dataAlign);
  if (commentRow) frameRecipeRegion(sheet, commentRow.number, 1, commentRow.number, 4, recipeMediumBorder, false);
  const checkedByRow = addOptionalFieldRow(sheet, labels.checkedBy, recipe.checked_by, dataAlign);
  if (checkedByRow) frameRecipeRegion(sheet, checkedByRow.number, 1, checkedByRow.number, 4, recipeMediumBorder, false);

  // Outer document frame (thick), applied last with force so the perimeter is one uniform
  // line rather than a patchwork of whatever border happened to already be there.
  frameRecipeRegion(sheet, 1, 1, sheet.rowCount, 4, recipeThickBorder, true);
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
    sheet.getCell(`A${labelRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT };
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
      portionsProduced: portionsProduced ?? '',
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
        totalQuantity: total,
        wastes: (proc.wastes || []).map(w => ({ name: w.name, percent: w.percent })),
        netWeight,
        method: { lines: methodLines, numbered: methodLines.length > 1 },
      };
    }),
    totalQuantity: sumQuantities((processes || []).flatMap(p => p.ingredients || [])),
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
