const ExcelJS = require('exceljs');
const JSZip = require('jszip');

// ============================================================
// Menu Ingredients Generator -- parses a menu .xlsx this app itself produced (Export All
// Sections/Generate Menu/Build Menu, see lib/export.js's buildSchoolSheet/buildStaffSheet/
// buildCeoSheet), possibly hand-edited afterward (renamed dishes, added/removed/reordered
// columns -- she does this routinely, e.g. deleting the RC or grams columns before sending a
// menu out), back into a flat list of dishes so an AI ingredient suggestion can be attached to
// each and the result exported again. Nothing here reads from or writes to Supabase -- purely a
// file in, file out transform, matching this feature's one-shot/nothing-saved contract.
//
// Column position is NEVER assumed. Every column's role (date, weekday, RC, category/item-type,
// dish name) is inferred from its actual cell content, so deleting or reordering a column doesn't
// shift which column gets misread as the dish name -- the old position-indexed design broke on
// exactly that. A single-section export (Generate Menu/Build Menu) also names its sheet after the
// menu's own free-text label, not the section, so sheet NAME can't identify the layout either --
// each day's header row is content-sniffed the same way, which works identically for a combined
// Export All Sections workbook (sheets literally named "Daycare"/"Staff"/etc.) and a
// single-section one, and survives her renaming a sheet tab.
// ============================================================

const WEEKDAY_NAMES = new Set(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']);
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const HIDDEN_SHEET_STATES = new Set(['hidden', 'veryHidden']);
const OPTION_RE = /^Option \d+$/i; // Staff's Lunch Box item label, numbered by position (buildStaffSheet)
const PORTION_RE = /^\d+(\.\d+)?\s*(g|gr|gm|ml|kg|l|oz)$/i; // e.g. "150g" -- an age-group/weight column value, never a dish
const PURE_NUMBER_RE = /^\d+(\.\d+)?$/; // a hand-typed pax count, never a dish

// Fixed vocabularies for Staff/CEO's own item-type labels -- these are hardcoded display strings
// in lib/export.js's STAFF_ROW_MAP/CEO_ROW_MAP, not DB category names, so they can't be looked up
// live the way School's category vocabulary is (see parseWorkbookDishes' own
// `schoolCategoryNames` param) -- mirrored here by hand instead.
const STAFF_ITEM_VOCAB = new Set(['Main Dish', 'Juice', 'Appetizer', 'Salad', 'Sweets', 'Bread', 'Fruit Basket']);
const CEO_ITEM_VOCAB = new Set(['Main Dish', 'Raw Veg', 'Juice', 'Yogurt', 'Salad', 'Fruits', 'Bread']);
// Meal-period labels every layout's item rows carry in their own column (buildSchoolSheet/
// buildStaffSheet/buildCeoSheet all merge a period label down column 1) -- kept OUT of the
// item-type vocabularies above (mixing them in would make the period column tie with the real
// category/item-type column on vocabScore, since both are 100%-vocabulary-match columns) and used
// only to keep a period value from being mistaken for a dish name during dish-column scoring.
const PERIOD_VOCAB = new Set(['Breakfast', 'Lunch', 'Lunch Box']);

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// Hands control back to the event loop (via setImmediate, which runs after I/O callbacks but
// before timers -- the soonest a synchronous run can yield) -- parseWorkbookDishes/
// appendIngredientsColumn are otherwise tight synchronous loops over every row of every sheet,
// which on a large enough workbook can hold the main process (and therefore the whole app, since
// IPC/UI all run on it too) unresponsive for longer than is acceptable, even though in practice
// it's nowhere near as slow as a genuinely stuck promise. Called periodically (every N rows/
// sheets) rather than once per row -- once per row would add far more overhead than the work
// being yielded around.
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Resolves a cell's displayed value regardless of whether it's the anchor of a merge or one of
// the merged-away cells beneath/beside it -- category/item-type columns are merged across a run
// of same-value rows (see buildSchoolSheet/buildStaffSheet/buildCeoSheet), so reading `.value`
// directly would come back null for every row but the first in that run. Robust to her disturbing
// the exact merge boundaries when hand-editing, unlike a manual carry-forward tracker would be.
function cellText(row, col) {
  const cell = row.getCell(col);
  if (!cell) return '';
  const raw = cell.isMerged ? cell.master.value : cell.value;
  if (raw == null) return '';
  if (typeof raw === 'object') {
    if (Array.isArray(raw.richText)) return raw.richText.map(t => t.text).join('');
    if (raw.result != null) return String(raw.result); // formula cell -- never expected in the columns we read, guarded anyway
    return '';
  }
  return String(raw).trim();
}

// RC codes look like "RC01-02113" (letters, then a digit, then more alphanumerics/dashes, no
// spaces) or literally "NEW" -- distinct enough from both category/item-type words (pure letters,
// e.g. "Bread") and dish names (multi-word, e.g. "Beef Ragu Red Sauce with Rice") to score a
// column's contents against.
function looksLikeRcCode(v) {
  return v === 'NEW' || /^[A-Za-z]{1,5}\d[A-Za-z0-9-]*$/.test(v);
}

// Scans every cell in a row (not fixed indices) for the literal/shaped markers that identify a
// header row and which layout it belongs to -- see detectHeader below. Returns the COLUMN each
// marker was found in (not just its value), since callers need to exclude those exact columns
// before inferring category/dish-name columns from the data rows beneath.
function scanRowMarkers(row, maxCol) {
  let dateCol = null, dateVal = null, weekdayCol = null, weekdayVal = null, gmMlCol = null, weightUnitCol = null;
  const rcCols = [];
  for (let c = 1; c <= maxCol; c++) {
    const v = cellText(row, c);
    if (!v) continue;
    if (dateCol === null && DATE_RE.test(v)) { dateCol = c; dateVal = v; continue; }
    if (weekdayCol === null && WEEKDAY_NAMES.has(v.toUpperCase())) { weekdayCol = c; weekdayVal = v; continue; }
    if (v === 'RC') { rcCols.push(c); continue; }
    if (v === 'GM/ML') { gmMlCol = c; continue; }
    if (v === 'Weight/Unit') { weightUnitCol = c; continue; }
  }
  return { dateCol, dateVal, weekdayCol, weekdayVal, rcCols, gmMlCol, weightUnitCol };
}

// Detects which of the 3 real layouts (see lib/export.js) a given row is the header row for, by
// content alone -- position-independent, so it doesn't matter which column she's moved the RC/
// date/weekday cells to, or whether she's added new columns of her own around them. Only date +
// weekday are REQUIRED (the one thing identifying which day a block belongs to at all, and not
// something she'd realistically delete) -- RC/GM-ML/Weight-Unit are refinements on top, since
// she does delete those:
//
//   CEO    (buildCeoSheet):    date + weekday + 2 "RC" cells (one per person column)
//   School (buildSchoolSheet): date + weekday + a "GM/ML" cell
//   Staff  (buildStaffSheet):  date + weekday + a "Weight/Unit" cell
//
// If neither "GM/ML" nor "Weight/Unit" survives and there aren't 2 "RC" cells either, layout
// comes back 'AMBIGUOUS' -- parseWorkbookDishes resolves it by checking which of School's or
// Staff's own vocabulary the block's data actually matches better (see resolveAmbiguousLayout).
function detectHeader(row, maxCol) {
  const m = scanRowMarkers(row, maxCol);
  if (!m.dateVal || !m.weekdayVal) return null;
  const base = { date: m.dateVal, weekday: m.weekdayVal, ...m };
  if (m.rcCols.length >= 2) return { ...base, layout: 'CEO' };
  if (m.gmMlCol) return { ...base, layout: 'SCHOOL' };
  if (m.weightUnitCol) return { ...base, layout: 'STAFF' };
  return { ...base, layout: 'AMBIGUOUS' };
}

// Scores each candidate column (i.e. every column not already claimed by a structurally-stable
// marker -- RC, GM/ML, Weight/Unit, CEO's own 2 dish columns; NOT date/weekday, which get
// repurposed for period/category/dish values in the item rows below the header, unlike those
// other markers which keep the same shape all the way down) for how "category-like" vs
// "dish-like" its non-blank values are, over the given item rows. A value counts toward
// vocabScore if it's an exact match against `itemVocab` (or Staff's "Option N" pattern); it
// counts toward dishScore if it's free text that ISN'T a vocabulary match (`itemVocab` OR the
// shared PERIOD_VOCAB, since every layout's item rows also carry a period label in some column),
// an RC code, a portion/weight value ("150g"), or a bare number (a hand-typed pax count).
function scoreColumns(candidateCols, itemRows, itemVocab) {
  return candidateCols.map(col => {
    let nonBlank = 0, vocabHits = 0, dishHits = 0;
    for (const row of itemRows) {
      const v = cellText(row, col);
      if (!v) continue;
      nonBlank++;
      if (itemVocab.has(v) || OPTION_RE.test(v)) vocabHits++;
      else if (!PERIOD_VOCAB.has(v) && !looksLikeRcCode(v) && !PORTION_RE.test(v) && !PURE_NUMBER_RE.test(v)) dishHits++;
    }
    return { col, nonBlank, vocabScore: nonBlank ? vocabHits / nonBlank : 0, dishScore: nonBlank ? dishHits / nonBlank : 0 };
  }).filter(s => s.nonBlank > 0);
}

// The category/item-type column is whichever candidate scores highest against the vocabulary;
// the dish-name column is whichever OTHER candidate scores highest as free text -- computed after
// removing the category pick so the two roles can never collapse onto the same column even if a
// small vocabulary set happens to also score decently on "dishness".
function pickCategoryAndDishColumns(candidateCols, itemRows, vocab) {
  const scored = scoreColumns(candidateCols, itemRows, vocab);
  if (scored.length === 0) return { categoryCol: null, dishCol: null };
  const bestCategory = [...scored].sort((a, b) => b.vocabScore - a.vocabScore)[0];
  const categoryCol = bestCategory.vocabScore > 0 ? bestCategory.col : null;
  const dishCandidates = scored.filter(s => s.col !== categoryCol).sort((a, b) => b.dishScore - a.dishScore);
  const dishCol = dishCandidates.length && dishCandidates[0].dishScore > 0 ? dishCandidates[0].col : null;
  return { categoryCol, dishCol };
}

// Highest vocabScore any candidate column achieves against `vocab` -- used only to break an
// AMBIGUOUS (School-vs-Staff) header tie by checking which vocabulary the actual data fits best.
function bestVocabFit(candidateCols, itemRows, vocab) {
  const scored = scoreColumns(candidateCols, itemRows, vocab);
  return scored.reduce((max, s) => Math.max(max, s.vocabScore), 0);
}

// CEO's two dish columns are found relative to each "RC" column (name immediately follows its own
// RC, per buildCeoSheet's fixed RC|Name, RC|Name pairing) rather than by vocabulary, since person
// names have no closed vocabulary to score against -- the one place this parser still relies on a
// positional relationship, but it's a relationship inherent to the layout itself (the two columns
// move together), not a fixed absolute position. Reads whichever of the two is non-blank, same as
// before -- the only time they differ is the Bread row (CEO_BREAD_EXCLUDED_PERSON's side is
// blanked entirely in buildCeoSheet), never two genuinely different dishes in one row.
function extractRowDish(block, row) {
  const { layout, categoryCol, dishCols } = block;
  const category = categoryCol ? cellText(row, categoryCol) : '';
  if (layout === 'CEO') {
    for (const c of dishCols) {
      const v = cellText(row, c);
      if (v) return { category, dishName: v };
    }
    return null;
  }
  const dishName = dishCols[0] ? cellText(row, dishCols[0]) : '';
  if (!dishName) return null;
  return { category, dishName };
}

// Any sqref implying more cells than this is treated as "applied to an implausibly large range"
// rather than a genuine per-column/per-row validation -- a real menu file's data range never
// remotely approaches this (even Staff's largest sheet is ~175 rows x a handful of columns), so
// this only ever catches the degenerate "whole sheet/column/row" case, never a legitimate one.
const MAX_DATA_VALIDATION_CELLS = 50_000;
const DATA_VALIDATION_ELEMENT_RE = /<dataValidation\b[^>]*?(?:\/>|>[\s\S]*?<\/dataValidation>)/g;
const SQREF_PART_RE = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/;

function columnLettersToNumber(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  return n;
}

// A `sqref` attribute is a space-separated list of single cells or ranges, e.g. "E4:L9 N4:U9" or
// a bare "D43" -- sums the cell count across every part, since a multi-range sqref could in
// principle add up to something enormous even with no single part as obviously outsized as
// "A1:XFD1048576".
function sqrefCellCount(sqref) {
  let total = 0;
  for (const part of sqref.trim().split(/\s+/)) {
    const m = SQREF_PART_RE.exec(part);
    if (!m) continue;
    const c1 = columnLettersToNumber(m[1]);
    const r1 = parseInt(m[2], 10);
    const c2 = m[3] ? columnLettersToNumber(m[3]) : c1;
    const r2 = m[4] ? parseInt(m[4], 10) : r1;
    total += (Math.abs(c2 - c1) + 1) * (Math.abs(r2 - r1) + 1);
  }
  return total;
}

// Root cause of a real hang: ExcelJS's own DataValidationsXform expands a <dataValidation>'s
// sqref into one object key PER CELL in the range (node_modules/exceljs/lib/xlsx/xform/sheet/
// data-validations-xform.js, parseClose -> Range.forEachAddress) -- a synchronous, non-yielding
// loop with no escape hatch. A validation that was meant for one column but got applied to an
// entire sheet (e.g. "A1:XFD1048576", which happens if the whole sheet is selected in Excel
// before Data > Data Validation is applied -- an easy accidental click, not a malicious file) is
// ~17.18 BILLION iterations of that loop. Confirmed directly: a real file with exactly this
// anomaly on one sheet hung workbook.xlsx.load() at 95-99% CPU with zero event-loop yields for
// 90+ seconds (killed, not self-resolved); removing only that one element (leaving every formula,
// defined name, and external link untouched) made the same file load in 55ms. This feature never
// reads data validations at all, so dropping the oversized ones outright (rather than trying to
// shrink them to something sane) is both simpler and sufficient -- every other caller of
// loadWorkbookFromBuffer is this same feature, so there's no other code path that could miss them.
//
// Operates on the raw zip via jszip (the same library ExcelJS itself uses internally to read the
// .xlsx, but not currently one of this app's own direct dependencies) BEFORE handing anything to
// ExcelJS, since the point is to never let ExcelJS's own parser see the oversized element at all.
// A file that isn't a valid zip, or has no worksheets matching the expected path, passes through
// unchanged -- ExcelJS's own load() is left to surface whatever the real error is.
async function stripRunawayDataValidations(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { buffer, warnings: [] };
  }

  const sheetPaths = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  const warnings = [];
  let changed = false;

  for (const path of sheetPaths) {
    const xml = await zip.file(path).async('string');
    let strippedCount = 0;
    const cleaned = xml.replace(DATA_VALIDATION_ELEMENT_RE, (element) => {
      const sqrefMatch = element.match(/\bsqref="([^"]*)"/);
      if (sqrefMatch && sqrefCellCount(sqrefMatch[1]) > MAX_DATA_VALIDATION_CELLS) {
        strippedCount++;
        return '';
      }
      return element;
    });
    if (strippedCount > 0) {
      zip.file(path, cleaned);
      changed = true;
      warnings.push(
        `${path.replace('xl/worksheets/', '')}: removed ${strippedCount} data-validation rule(s) applied ` +
        `to an implausibly large range (e.g. a whole sheet/column) -- these were ignored rather than ` +
        `evaluated, since reading them as-is would hang indefinitely; the rest of the sheet was read normally.`
      );
    }
  }

  if (!changed) return { buffer, warnings: [] };
  const rebuilt = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer: rebuilt, warnings };
}

// A defined name's range resolves into an external (linked) workbook when ExcelJS's own decoder
// prefixes the sheet name with a bracketed workbook index, e.g. "'[1]_Lists'!$A$1:$A$57" --
// exactly how Excel itself denotes "sheet _Lists, in whichever OTHER workbook is external link
// #1" (xl/externalLinks/externalLink1.xml, referenced from workbook.xml's <externalReferences>).
const EXTERNAL_WORKBOOK_RANGE_RE = /\[\d+\]/;

// ExcelJS's xlsx reader has no code path at all for xl/externalLinks/*.xml or workbook.xml's
// <externalReferences> (confirmed by reading its own source -- neither appears anywhere in
// xlsx.js's load dispatch), so loading a file with a real external link silently drops that part
// entirely while still carrying the affected defined names' raw range text forward unchanged
// (including the "[1]" workbook-index prefix). Re-saving such a workbook therefore produces a
// defined name that points at external-workbook index 1 with no corresponding
// <externalReferences>/externalLink part anywhere in the output file -- invalid per the OOXML
// spec, and confirmed directly as the cause of a real exported file needing Excel's "we found a
// problem with some content" repair prompt (the output's workbook.xml had definedNames like
// '[1]_Lists'!$P$1:$P$14 with zero <externalReferences> and no xl/externalLinks directory at
// all). This feature never reads named ranges (only raw cell text), so dropping any defined name
// that resolves through an external workbook is safe, and is the only fix available to us short
// of reconstructing a valid external-link part ourselves -- simply leaving them in place is not
// an option, since ExcelJS itself is what breaks them on the round-trip, not our own code.
function stripExternalDefinedNames(workbook) {
  const before = workbook.definedNames.model;
  const kept = before.filter((dn) => !dn.ranges.some((r) => EXTERNAL_WORKBOOK_RANGE_RE.test(r)));
  const removedCount = before.length - kept.length;
  if (removedCount > 0) workbook.definedNames.model = kept;
  return removedCount;
}

// Returns { workbook, warnings } -- warnings is non-empty only when something was actually
// removed (a runaway data validation and/or a defined name pointing at an external workbook);
// callers should surface it the same way parseWorkbookDishes' own warnings are surfaced (see
// parse-and-suggest-menu-ingredients in main.js), since it reflects a real (if harmless)
// discrepancy between the uploaded file and what got read.
async function loadWorkbookFromBuffer(buffer) {
  const { buffer: sanitized, warnings } = await stripRunawayDataValidations(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sanitized);

  const removedNameCount = stripExternalDefinedNames(workbook);
  if (removedNameCount > 0) {
    warnings.push(
      `${removedNameCount} defined name(s) pointing at an external/linked workbook were dropped -- ` +
      `keeping them would make the exported file need Excel's own repair on open, since this app ` +
      `has no way to preserve the external link they depend on; nothing else in this feature uses them.`
    );
  }

  return { workbook, warnings };
}

// Returns { rows, warnings }. `rows` is a flat, row-order-preserving list of every dish found
// across every recognized sheet: { sheetName, rowNumber, date, weekday, category, dishName }.
// `rowNumber` is the stable key appendIngredientsColumn later uses to write each row's (possibly
// her-edited) ingredients back into the exact same physical row -- never re-derived from dish
// name, since the same dish name legitimately repeats across many days/rows and her edits are
// per-occurrence, not per-name.
//
// `schoolCategoryNames` is the live list of category display names for Daycare/KG-LP/MS-UP
// (main.js pulls this from the cached reference data -- see parse-and-suggest-menu-ingredients),
// so School's vocabulary can never drift from the real categories table; Staff/CEO's vocabularies
// are the small fixed sets above (mirroring lib/export.js's own hardcoded row maps).
async function parseWorkbookDishes(workbook, schoolCategoryNames = []) {
  const schoolVocab = new Set(schoolCategoryNames.filter(Boolean));
  const rows = [];
  const warnings = [];
  // Rightmost dish column actually detected per sheet -- appendIngredientsColumn inserts the new
  // "Ingredients" column immediately after this (rather than appending past every other column,
  // e.g. the age-group GM/ML/pax columns or Staff's department columns, which would otherwise
  // leave it stranded several columns away from the dish names it's attached to). Tracks the MAX
  // across every header block in a sheet, in case a day's detected dish column ever genuinely
  // differs from another day's in the same sheet -- inserting after the rightmost one can never
  // truncate a narrower day's own dish column.
  const dishColumnBySheet = {};

  for (const sheet of workbook.worksheets) {
    if (sheet.name === '_Lists') continue;
    if (HIDDEN_SHEET_STATES.has(sheet.state)) continue;

    const maxCol = Math.max(sheet.columnCount || 0, 10);
    const headers = [];
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const h = detectHeader(sheet.getRow(rowNumber), maxCol);
      if (h) headers.push({ rowNumber, ...h });
      if (rowNumber % 300 === 0) await yieldToEventLoop();
    }
    if (headers.length === 0) continue; // not a menu sheet this parser recognizes -- skip quietly

    for (let hi = 0; hi < headers.length; hi++) {
      const h = headers[hi];
      const endRow = hi + 1 < headers.length ? headers[hi + 1].rowNumber - 1 : sheet.rowCount;
      const itemRowNumbers = range(h.rowNumber + 1, endRow);
      const itemRows = itemRowNumbers.map(r => sheet.getRow(r));

      // Only RC/GM-ML/Weight-Unit/CEO's-own-dish-columns are excluded here -- NOT date/weekday.
      // Those two hold a genuinely different value in the item rows below the header (a meal
      // period label, "Breakfast"/"Lunch" -- see PERIOD_VOCAB's own comment), so excluding them
      // would wrongly hide the real category/dish columns whenever they happen to land in the
      // same physical column the header's date/weekday cell used.
      const markerCols = new Set([h.gmMlCol, h.weightUnitCol, ...h.rcCols].filter(Boolean));

      let layout = h.layout;
      let categoryCol = null;
      let dishCols = [];

      if (layout === 'CEO') {
        dishCols = h.rcCols.map(c => c + 1);
        dishCols.forEach(c => markerCols.add(c));
        const candidateCols = range(1, maxCol).filter(c => !markerCols.has(c));
        categoryCol = pickCategoryAndDishColumns(candidateCols, itemRows, CEO_ITEM_VOCAB).categoryCol;
      } else {
        const candidateCols = range(1, maxCol).filter(c => !markerCols.has(c));
        if (layout === 'AMBIGUOUS') {
          const schoolFit = bestVocabFit(candidateCols, itemRows, schoolVocab);
          const staffFit = bestVocabFit(candidateCols, itemRows, STAFF_ITEM_VOCAB);
          // Ties default to SCHOOL -- arbitrary, but School sections vastly outnumber Staff in
          // real usage (3 school sections vs 1 Staff), so it's the more likely guess when the
          // data gives no real signal either way (e.g. an entirely category-less block). CEO is
          // deliberately not a candidate here -- resolving it needs 2 "RC" cells (see the CEO
          // branch above) to locate its 2 dish columns at all, so a CEO sheet that's lost both of
          // those can't be recovered as CEO regardless of vocabulary fit (it'll fall back to a
          // single dish column here, which can silently drop the Bread row's data -- see the
          // warning below).
          layout = staffFit > schoolFit ? 'STAFF' : 'SCHOOL';
          warnings.push(
            `${sheet.name}, ${h.weekday} ${h.date}: this day's RC/GM-ML/Weight-Unit columns were ` +
            `missing, so the layout was inferred from the dish/category data instead (read as ` +
            `${layout === 'STAFF' ? 'Staff' : 'School'}) -- worth a quick check of this day's rows, ` +
            `and if this sheet is actually CEO's, restore at least one "RC" column per person and re-upload.`
          );
        }
        const vocab = layout === 'STAFF' ? STAFF_ITEM_VOCAB : schoolVocab;
        const picked = pickCategoryAndDishColumns(candidateCols, itemRows, vocab);
        categoryCol = picked.categoryCol;
        dishCols = picked.dishCol ? [picked.dishCol] : [];
      }

      if (!dishCols.length) {
        warnings.push(
          `${sheet.name}, ${h.weekday} ${h.date}: couldn't confidently identify a dish name ` +
          `column for this day -- skipped rather than guess wrong. If you deleted or heavily ` +
          `edited the dish column, add it back and re-upload.`
        );
        continue; // next header in this sheet, not next sheet -- this was a forEach `return` before the loop conversion
      }

      itemRows.forEach((row, idx) => {
        const dish = extractRowDish({ layout, categoryCol, dishCols }, row);
        if (!dish) return; // blank/spacer row, or a row she cleared entirely
        rows.push({
          sheetName: sheet.name, rowNumber: itemRowNumbers[idx], date: h.date, weekday: h.weekday,
          category: dish.category, dishName: dish.dishName,
        });
      });

      const maxDishCol = Math.max(...dishCols);
      if (!dishColumnBySheet[sheet.name] || maxDishCol > dishColumnBySheet[sheet.name]) {
        dishColumnBySheet[sheet.name] = maxDishCol;
      }

      if (hi % 10 === 0) await yieldToEventLoop();
    }
  }

  return { rows, warnings, dishColumnBySheet };
}

// Inserts two new columns, "Ingredients" then "Allergens", immediately after the dish-name column
// (rather than appending past every other column -- age-group GM/ML/pax columns for School,
// department columns for Staff -- which otherwise leaves them stranded several empty-looking
// columns away from the dish names they belong to; see dishColumnBySheet, from
// parseWorkbookDishes). Inserting there (not before or elsewhere in the sheet) is specifically
// what keeps this safe:
// every RC/portion lookup formula this app's own exports write (lookupFormula/definedNameFor in
// lib/export.js) references the dish cell by its OWN fixed address (e.g. "D5"), baked into the
// formula string -- and that address never changes here, since the dish column itself is never
// the one being shifted, only columns to its right are. ExcelJS's Row.splice moves each shifted
// cell's `.value` (formula text included) and `.style` verbatim to its new column, so a formula
// that already referenced the still-unmoved dish column stays correct regardless of where the
// cell holding that formula itself ends up.
//
// `rowsWithIngredients` is the SAME flat shape parseWorkbookDishes returned, each entry now
// carrying `ingredients` and `allergens` strings (possibly her inline edits, possibly untouched
// from the AI suggestion) -- looked up by the exact (sheetName, rowNumber) pair, not by dish
// name, so two occurrences of the same dish that she deliberately edited differently land
// correctly.
//
// Re-detects each sheet's own header rows fresh (rather than reusing parseWorkbookDishes' output)
// so this function works correctly even if called against a workbook whose columns already
// shifted since parsing -- it never assumes the column layout it saw at parse time still holds.
// `dishColumnBySheet` (also from parseWorkbookDishes) is the one exception -- the insertion point
// genuinely does need to be decided before this function re-detects anything of its own, since
// re-detecting it here would require duplicating the same category/dish-column scoring logic.
async function appendIngredientsColumn(workbook, rowsWithIngredients, dishColumnBySheet = {}) {
  const bySheet = new Map();
  for (const r of rowsWithIngredients) {
    if (!bySheet.has(r.sheetName)) bySheet.set(r.sheetName, []);
    bySheet.get(r.sheetName).push(r);
  }

  for (const [sheetName, rows] of bySheet) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const dishCol = dishColumnBySheet[sheetName];
    const ingredientsCol = dishCol ? dishCol + 1 : sheet.columnCount + 1;
    const allergensCol = ingredientsCol + 1;
    // Only needed when something already occupies `ingredientsCol` (age-group/department
    // columns, etc.) -- if the dish column happens to already be the sheet's last one, inserting
    // would just shift in empty columns for nothing; writing straight into ingredientsCol/
    // allergensCol is equivalent and simpler. Two empty-column inserts (not one) since both new
    // columns need to land before whatever was already there. Computed/applied before `maxCol`
    // below, since a real insert shifts the sheet's own column count and header-row re-detection
    // needs to scan across the post-insert width.
    if (ingredientsCol <= sheet.columnCount) sheet.spliceColumns(ingredientsCol, 0, [], []);
    sheet.getColumn(ingredientsCol).width = 60;
    sheet.getColumn(allergensCol).width = 30;
    const maxCol = Math.max(sheet.columnCount || 0, 10);

    const headerRows = [];
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      if (detectHeader(sheet.getRow(rowNumber), maxCol)) headerRows.push(rowNumber);
      if (rowNumber % 300 === 0) await yieldToEventLoop();
    }
    for (const rowNumber of headerRows) {
      const row = sheet.getRow(rowNumber);
      const ingredientsCell = row.getCell(ingredientsCol);
      ingredientsCell.value = 'Ingredients';
      ingredientsCell.font = { bold: true };
      ingredientsCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      const allergensCell = row.getCell(allergensCol);
      allergensCell.value = 'Allergens';
      allergensCell.font = { bold: true };
      allergensCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const row = sheet.getRow(r.rowNumber);
      const ingredientsCell = row.getCell(ingredientsCol);
      ingredientsCell.value = r.ingredients || '';
      ingredientsCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      const allergensCell = row.getCell(allergensCol);
      allergensCell.value = r.allergens || '';
      allergensCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      if (i % 300 === 0) await yieldToEventLoop();
    }
  }
}

module.exports = { loadWorkbookFromBuffer, parseWorkbookDishes, appendIngredientsColumn };
