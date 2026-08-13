const ExcelJS = require('exceljs');
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

function buildRecipeSheet(workbook, recipe, ingredients, sheetName, options = {}) {
  const showTotalQuantity = !!options.showTotalQuantity;
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [{ width: 29.5 }, { width: 9.2 }, { width: 10 }, { width: 49.7 }];
  sheet.pageSetup = { paperSize: 9, orientation: 'portrait', fitToWidth: 1, fitToHeight: 0, horizontalCentered: true };
  sheet.views = [{ showGridLines: false }];

  // Row 1 -- "RECIPE FOR:" (B:C merged label) | dish name (D)
  const r1 = sheet.addRow([null, 'RECIPE FOR:', null, recipe.name]);
  sheet.mergeCells(r1.number, 2, r1.number, 3);
  r1.height = 28;
  sheet.getCell(`B${r1.number}`).font = { bold: true, underline: true, size: 16, name: RECIPE_FONT };
  sheet.getCell(`B${r1.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`B${r1.number}`).border = { top: recipeDoubleBorder };
  sheet.getCell(`A${r1.number}`).border = { top: recipeDoubleBorder, left: recipeDoubleBorder };
  sheet.getCell(`D${r1.number}`).font = { size: 14, name: 'Arial' };
  sheet.getCell(`D${r1.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`D${r1.number}`).border = { top: recipeDoubleBorder, right: recipeDoubleBorder };

  const r2 = sheet.addRow([]);
  sheet.getCell(`A${r2.number}`).border = { left: recipeDoubleBorder };
  sheet.getCell(`D${r2.number}`).border = { right: recipeDoubleBorder };

  // Row 3 -- "Quantity Produced:" label(A) / value(B:C) | "Prepared By:  <value>" (D, one cell)
  const r3 = sheet.addRow(['Quantity Produced:  ', recipe.quantity_produced || '', null, `Prepared By:  ${recipe.prepared_by || ''}`]);
  sheet.mergeCells(r3.number, 2, r3.number, 3);
  sheet.getCell(`A${r3.number}`).font = { underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`A${r3.number}`).border = { left: recipeDoubleBorder };
  sheet.getCell(`B${r3.number}`).font = { bold: true, underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`B${r3.number}`).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getCell(`D${r3.number}`).font = { underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`D${r3.number}`).border = { right: recipeDoubleBorder };

  // Row 4 -- "Category: <value>" (A, one cell) | raw date, unlabeled (D) -- matches template exactly
  const r4 = sheet.addRow([`Category: ${recipe.category || ''}`, null, null, formatDateDDMMYYYY(recipe.date_created)]);
  sheet.getCell(`A${r4.number}`).font = { underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`A${r4.number}`).border = { left: recipeDoubleBorder };
  sheet.getCell(`D${r4.number}`).font = { underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`D${r4.number}`).alignment = { horizontal: 'left' };
  sheet.getCell(`D${r4.number}`).border = { right: recipeDoubleBorder };

  // Row 5 -- "Country \ Origin:" label(A) / value(B:C) | yield notes, unlabeled, bold red (D)
  const r5 = sheet.addRow([`Country \\ Origin: ${recipe.country_origin || ''}`, null, null, recipe.yield_notes || '']);
  sheet.mergeCells(r5.number, 2, r5.number, 3);
  sheet.getCell(`A${r5.number}`).font = { underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(`A${r5.number}`).border = { left: recipeDoubleBorder };
  sheet.getCell(`D${r5.number}`).font = { bold: true, underline: true, size: 14, name: RECIPE_FONT, color: { argb: 'FFFF0000' } };
  sheet.getCell(`D${r5.number}`).border = { right: recipeDoubleBorder };

  // Small, unobtrusive TTY code line -- not part of the original template, but central to
  // how the app tracks recipes, so it gets a quiet line of its own under the header block.
  const ttyRow = sheet.addRow([`TTY Code: ${recipe.code}`]);
  sheet.mergeCells(ttyRow.number, 1, ttyRow.number, 4);
  sheet.getCell(`A${ttyRow.number}`).font = { size: 9, italic: true, name: RECIPE_FONT, color: { argb: 'FF8A8477' } };
  sheet.getCell(`A${ttyRow.number}`).alignment = { horizontal: 'right' };
  sheet.getCell(`A${ttyRow.number}`).border = { left: recipeDoubleBorder };
  sheet.getCell(`D${ttyRow.number}`).border = { right: recipeDoubleBorder };

  sheet.addRow([]);
  sheet.addRow([]);

  // Ingredients header
  const header = sheet.addRow(['INGREDIENTS', 'Quantity', 'Unit', 'METHOD']);
  header.height = 20;
  header.eachCell({ includeEmpty: true }, cell => {
    cell.font = { bold: true, underline: true, size: 14, name: RECIPE_FONT };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sheet.getCell(`A${header.number}`).border = { left: recipeDoubleBorder, top: recipeDoubleBorder, bottom: recipeDoubleBorder };
  sheet.getCell(`B${header.number}`).border = { left: recipeDoubleBorder, right: thinBorder, top: recipeDoubleBorder, bottom: recipeDoubleBorder };
  sheet.getCell(`C${header.number}`).border = { left: thinBorder, right: recipeDoubleBorder, top: recipeDoubleBorder, bottom: recipeDoubleBorder };
  sheet.getCell(`D${header.number}`).border = { left: recipeDoubleBorder, right: recipeDoubleBorder, top: recipeDoubleBorder, bottom: recipeDoubleBorder };

  // Ingredient rows are sized to the actual data (not padded to the template's fixed 25
  // blank slots) -- these are digital records generated with data already filled in.
  const ingredientRows = ingredients.length > 0 ? ingredients : [null];
  ingredientRows.forEach((ing, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === ingredientRows.length - 1 && !showTotalQuantity;
    const row = ing
      ? sheet.addRow([ing.ingredient_name, ing.quantity ?? '', ing.unit || '', ing.method || ''])
      : sheet.addRow(['(no ingredients)', '', '', '']);

    row.getCell(1).font = ing ? { size: 13, name: RECIPE_FONT } : { italic: true, size: 12, name: RECIPE_FONT, color: { argb: 'FF8A8477' } };
    row.getCell(1).alignment = { horizontal: 'left' };
    row.getCell(2).font = { size: 13, name: RECIPE_FONT };
    row.getCell(2).alignment = { horizontal: 'center' };
    row.getCell(3).font = { size: 13, name: RECIPE_FONT };
    row.getCell(3).alignment = { horizontal: 'center' };
    row.getCell(4).font = { size: 13, name: RECIPE_FONT };
    row.getCell(4).alignment = { horizontal: 'left', wrapText: true };

    const topB = isFirst ? recipeDoubleBorder : thinBorder;
    const bottomB = isLast ? recipeDoubleBorder : thinBorder;
    row.getCell(1).border = { left: recipeDoubleBorder, top: topB, bottom: bottomB };
    row.getCell(2).border = { left: recipeDoubleBorder, right: thinBorder, top: topB, bottom: bottomB };
    row.getCell(3).border = { left: thinBorder, right: recipeDoubleBorder, top: topB, bottom: bottomB };
    row.getCell(4).border = { left: recipeDoubleBorder, right: recipeDoubleBorder, top: topB, bottom: bottomB };
  });

  // Total Quantity row (both Recipe Book and Recipe Calculator exports): sums every
  // ingredient's raw quantity number regardless of unit (120 GR + 5 PC = 125), since units
  // aren't commensurable and the ask is a plain numeric total, not a unit conversion. Rounded
  // to avoid floating-point noise (0.1 + 0.2 displaying as 0.30000000000000004).
  if (showTotalQuantity) {
    const rawTotal = ingredients.reduce((sum, ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return isNaN(q) ? sum : sum + q;
    }, 0);
    const total = Math.round(rawTotal * 100) / 100;

    const totalRow = sheet.addRow(['Total Quantity', total, '', '']);
    totalRow.getCell(1).font = { bold: true, size: 13, name: RECIPE_FONT };
    totalRow.getCell(1).alignment = { horizontal: 'left' };
    totalRow.getCell(2).font = { bold: true, size: 13, name: RECIPE_FONT };
    totalRow.getCell(2).alignment = { horizontal: 'center' };

    totalRow.getCell(1).border = { left: recipeDoubleBorder, top: thinBorder, bottom: recipeDoubleBorder };
    totalRow.getCell(2).border = { left: recipeDoubleBorder, right: thinBorder, top: thinBorder, bottom: recipeDoubleBorder };
    totalRow.getCell(3).border = { left: thinBorder, right: recipeDoubleBorder, top: thinBorder, bottom: recipeDoubleBorder };
    totalRow.getCell(4).border = { left: recipeDoubleBorder, right: recipeDoubleBorder, top: thinBorder, bottom: recipeDoubleBorder };
  }

  sheet.addRow([]);

  // Preparation and Cooking
  const prepLabelRow = sheet.addRow(['Preparation and Cooking:']);
  sheet.getCell(`A${prepLabelRow.number}`).font = { bold: true, underline: true, size: 13, name: RECIPE_FONT };
  sheet.getCell(`A${prepLabelRow.number}`).border = { left: recipeDoubleBorder, top: recipeDoubleBorder, bottom: recipeHairBorder };
  sheet.getCell(`B${prepLabelRow.number}`).border = { top: recipeDoubleBorder, bottom: recipeHairBorder };
  sheet.getCell(`C${prepLabelRow.number}`).border = { top: recipeDoubleBorder, bottom: recipeHairBorder };
  sheet.getCell(`D${prepLabelRow.number}`).border = { right: recipeDoubleBorder, top: recipeDoubleBorder, bottom: recipeHairBorder };

  const prepText = recipe.preparation_cooking || '';
  const prepLines = Math.max(3, Math.ceil(prepText.length / 90) + (prepText.match(/\n/g) || []).length);
  const prepValueRow = sheet.addRow([prepText]);
  sheet.mergeCells(prepValueRow.number, 1, prepValueRow.number, 4);
  prepValueRow.height = Math.max(20, prepLines * 15);
  sheet.getCell(`A${prepValueRow.number}`).font = { size: 13, name: RECIPE_FONT };
  sheet.getCell(`A${prepValueRow.number}`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
  sheet.getCell(`A${prepValueRow.number}`).border = { left: recipeDoubleBorder, top: recipeHairBorder, bottom: recipeDoubleBorder };
  sheet.getCell(`D${prepValueRow.number}`).border = { right: recipeDoubleBorder, top: recipeHairBorder, bottom: recipeDoubleBorder };

  sheet.addRow([]);

  // Photo (empty placeholder, A:B -- no image inserted) + Presentation/Decoration/Serving
  // (C:D, one line per row like the template). Photo's row-span matches however many rows
  // Presentation actually needs, so the two blocks stay the same height side by side.
  const presentationLines = (recipe.presentation_serving || '').split('\n').map(l => l.trim()).filter(Boolean);
  const presentationRowCount = Math.max(presentationLines.length, 4);
  const blockStartRow = sheet.rowCount + 1;

  sheet.mergeCells(blockStartRow, 1, blockStartRow + presentationRowCount, 2);
  const photoCell = sheet.getCell(blockStartRow, 1);
  if (recipe.photoBuffer) {
    // Two-cell anchor (tl+br, both 0-indexed cell-boundary coordinates) stretches the image to
    // exactly fill the merged A:B box rather than a fixed pixel size -- it can't overflow into
    // Presentation's columns C:D or the rows below no matter how big the source photo is.
    const imageId = workbook.addImage({ buffer: recipe.photoBuffer, extension: recipe.photoExt || 'jpeg' });
    sheet.addImage(imageId, {
      tl: { col: 0, row: blockStartRow - 1 },
      br: { col: 2, row: blockStartRow + presentationRowCount },
    });
  } else {
    photoCell.value = 'Photo';
    photoCell.font = { size: 14, name: RECIPE_FONT };
    photoCell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  sheet.getCell(blockStartRow, 1).border = { left: recipeDoubleBorder, top: recipeDoubleBorder };
  sheet.getCell(blockStartRow, 2).border = { right: recipeDoubleBorder, top: recipeDoubleBorder };
  sheet.getCell(blockStartRow + presentationRowCount, 1).border = { left: recipeDoubleBorder, bottom: recipeDoubleBorder };
  sheet.getCell(blockStartRow + presentationRowCount, 2).border = { right: recipeDoubleBorder, bottom: recipeDoubleBorder };
  for (let r = blockStartRow + 1; r < blockStartRow + presentationRowCount; r++) {
    sheet.getCell(r, 1).border = { left: recipeDoubleBorder };
    sheet.getCell(r, 2).border = { right: recipeDoubleBorder };
  }

  sheet.mergeCells(blockStartRow, 3, blockStartRow, 4);
  sheet.getCell(blockStartRow, 3).value = 'Presentation, Decoration & Serving Instructions:';
  sheet.getCell(blockStartRow, 3).font = { bold: true, underline: true, size: 14, name: RECIPE_FONT };
  sheet.getCell(blockStartRow, 3).alignment = { horizontal: 'center' };
  sheet.getCell(blockStartRow, 3).border = { left: recipeDoubleBorder, top: recipeDoubleBorder, bottom: thinBorder };
  sheet.getCell(blockStartRow, 4).border = { right: recipeDoubleBorder, top: recipeDoubleBorder, bottom: thinBorder };

  for (let i = 0; i < presentationRowCount; i++) {
    const rowNum = blockStartRow + 1 + i;
    const isLastLine = i === presentationRowCount - 1;
    sheet.mergeCells(rowNum, 3, rowNum, 4);
    sheet.getCell(rowNum, 3).value = presentationLines[i] || '';
    sheet.getCell(rowNum, 3).font = { size: 14, name: RECIPE_FONT };
    sheet.getCell(rowNum, 3).alignment = { horizontal: 'left' };
    sheet.getCell(rowNum, 3).border = { left: recipeDoubleBorder, top: recipeHairBorder, bottom: isLastLine ? recipeDoubleBorder : recipeHairBorder };
    sheet.getCell(rowNum, 4).border = { right: recipeDoubleBorder, top: recipeHairBorder, bottom: isLastLine ? recipeDoubleBorder : recipeHairBorder };
  }

  sheet.addRow([]);

  // Comment / Checked By
  const commentHeaderRow = sheet.addRow(['Comment:', null, null, 'Checked By:']);
  sheet.getCell(`A${commentHeaderRow.number}`).font = { size: 11, name: RECIPE_FONT };
  sheet.getCell(`D${commentHeaderRow.number}`).font = { size: 11, name: RECIPE_FONT };

  const commentValueRow = sheet.addRow([recipe.comment || '', null, null, recipe.checked_by || '']);
  sheet.mergeCells(commentValueRow.number, 1, commentValueRow.number, 2);
  sheet.getCell(`A${commentValueRow.number}`).font = { size: 12, name: RECIPE_FONT };
  sheet.getCell(`A${commentValueRow.number}`).alignment = { wrapText: true, vertical: 'top' };
  sheet.getCell(`D${commentValueRow.number}`).font = { size: 12, name: RECIPE_FONT };

  // ---- Polish pass: fills, bold section headers, and a 3-tier border system (thin
  // gridlines inside the ingredients table, medium between sections, thick around the
  // whole sheet). Every call only fills in a currently-unset side, except the final outer
  // frame -- so none of the exact-template double/hair borders set above are disturbed.
  const lastIngredientRow = header.number + ingredientRows.length + (showTotalQuantity ? 1 : 0);
  const photoPresentationEndRow = blockStartRow + presentationRowCount;
  const finalRow = commentValueRow.number;

  // Section header fills (light sage) + bold
  fillRecipeRegion(sheet, r1.number, 1, r1.number, 4, RECIPE_SECTION_FILL);
  fillRecipeRegion(sheet, header.number, 1, header.number, 4, RECIPE_SECTION_FILL);
  fillRecipeRegion(sheet, prepLabelRow.number, 1, prepLabelRow.number, 4, RECIPE_SECTION_FILL);
  fillRecipeRegion(sheet, blockStartRow, 3, blockStartRow, 4, RECIPE_SECTION_FILL);
  fillRecipeRegion(sheet, commentHeaderRow.number, 1, commentHeaderRow.number, 4, RECIPE_SECTION_FILL);
  sheet.getCell(`A${commentHeaderRow.number}`).font = { ...sheet.getCell(`A${commentHeaderRow.number}`).font, bold: true };
  sheet.getCell(`D${commentHeaderRow.number}`).font = { ...sheet.getCell(`D${commentHeaderRow.number}`).font, bold: true };

  // Empty Photo placeholder box -- very light grey so it reads as a reserved area
  fillRecipeRegion(sheet, blockStartRow, 1, photoPresentationEndRow, 2, RECIPE_PHOTO_FILL);

  // Full internal gridlines for the ingredients table
  gridRecipeRegion(sheet, header.number, 1, lastIngredientRow, 4, thinBorder);

  // Section borders (medium) -- header block, ingredients table, Preparation and Cooking,
  // Photo + Presentation, Comment/Checked By
  frameRecipeRegion(sheet, 1, 1, header.number - 1, 4, recipeMediumBorder, false);
  frameRecipeRegion(sheet, header.number, 1, lastIngredientRow, 4, recipeMediumBorder, false);
  frameRecipeRegion(sheet, prepLabelRow.number, 1, prepValueRow.number, 4, recipeMediumBorder, false);
  frameRecipeRegion(sheet, blockStartRow, 1, photoPresentationEndRow, 4, recipeMediumBorder, false);
  frameRecipeRegion(sheet, commentHeaderRow.number, 1, finalRow, 4, recipeMediumBorder, false);

  // Outer document frame (thick), applied last with force so the perimeter is one uniform
  // line rather than a patchwork of whatever border happened to already be there
  frameRecipeRegion(sheet, 1, 1, finalRow, 4, recipeThickBorder, true);
}

// fetchRecipe(recipeId) -> Promise<{ recipe, ingredients }>, supplied by the caller (main.js
// reads recipes/recipe_ingredients from Supabase) so this module stays DB-agnostic.
async function exportRecipes(fetchRecipe, recipeIds, savePath) {
  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set();
  for (const recipeId of recipeIds) {
    const { recipe, ingredients } = await fetchRecipe(recipeId);
    const base = sanitizeSheetName(recipe.name);
    let sheetName = base;
    let n = 2;
    while (usedNames.has(sheetName)) {
      const suffix = ` (${n})`;
      sheetName = base.slice(0, 31 - suffix.length) + suffix;
      n++;
    }
    usedNames.add(sheetName);
    buildRecipeSheet(workbook, recipe, ingredients, sheetName, { showTotalQuantity: true });
  }
  await workbook.xlsx.writeFile(savePath);
}

// Same sheet builder as exportRecipes, but fed an in-memory (possibly scaled) recipe +
// ingredient list instead of a DB id -- nothing is read from or written to the database.
async function exportScaledRecipe(recipe, ingredients, savePath) {
  const workbook = new ExcelJS.Workbook();
  buildRecipeSheet(workbook, recipe, ingredients, sanitizeSheetName(recipe.name), { showTotalQuantity: true });
  await workbook.xlsx.writeFile(savePath);
}

module.exports = {
  exportSingleMenu, exportCombinedWorkbook, exportBlankTemplateWorkbook, exportRecipes, exportScaledRecipe, sanitizeSheetName, SECTION_DISPLAY_NAMES,
};
