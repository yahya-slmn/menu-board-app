// ============================================================
// Menu Ingredients Generator -> suggest-dish-ingredients: what is sent for each dish and how each answer is
// cleaned (2026-10-01, Phase C). Shared by main.js and scripts/mi-prompt-trial.js so the trial runs exactly
// what the app runs. Pure: no AI, no database.
//
// One request per dish NAME across the whole upload, ignoring case and spacing (Phase D, 2026-10-01; was exact name,
// per file): a dish repeated over days, sections or files costs one call. The dish carries the context of its FIRST
// row (category, section, meal period) so the model knows what kind of dish it is; seafoodAllowed is true only when NO
// row of it is on a student sheet (Daycare / KG-LP / MS-UP, or a sheet whose section can't be told -- the safe default).
// The answer is then cleaned PER ROW for that row's own section (cleanSuggestion): prompt v2.2 lists a real seafood
// dish's real ingredients whatever the flag, so one answer serves Staff (keeps its tuna) and KG-LP (tuna removed, with
// its red note) alike.
// ============================================================
const { resolveSectionFromSheetName, isServedAsIsCategory } = require('./recipeGenerator');
const { filterMenuIngredients } = require('./menuIngredientFilters');
const { shareName } = require('./menuIngredientsShare');

const SECTION_NAMES = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };
const ADULT_SECTIONS = new Set(['STAFF', 'CEO']);

// A row served as it is -- Fruit Bar, Fruit Basket, Salad Bar, in every section (2026-10-01; the SAME list the Recipe
// Generator skips, lib/recipeGenerator.js SERVED_AS_IS_CATEGORY_PATTERNS). Never sent to the AI; the row keeps its dish
// name with blank Ingredients / Allergens (no restated "seasonal fruits"), and takes no part in "Same as" sharing.
const isServedAsIsRow = (row) => isServedAsIsCategory(row.category);

// rows: parseWorkbookDishes(...).rows (of every file) -> [{ key, name, category, section, period, seafoodAllowed }],
// first-seen order; key = the name ignoring case and spacing (lib/menuIngredientsShare.js shareName). Served-as-is
// rows are left out (isServedAsIsRow).
function dishesForSuggestion(rows) {
  const byName = new Map();
  for (const r of rows) {
    if (isServedAsIsRow(r)) continue;
    const section = resolveSectionFromSheetName(r.sheetName);
    const adult = ADULT_SECTIONS.has(section);
    const key = shareName(r.dishName);
    const existing = byName.get(key);
    if (existing) { if (!adult) existing.seafoodAllowed = false; continue; }
    byName.set(key, {
      key,
      name: r.dishName,
      category: r.category || '',
      section: SECTION_NAMES[section] || r.sheetName || '',
      period: r.period || '',
      seafoodAllowed: adult,
    });
  }
  return [...byName.values()];
}

// The item suggest-dish-ingredients receives (an older deployment only reads index + name).
function toPayloadItem(dish, index) {
  return { index, name: dish.name, category: dish.category, section: dish.section, period: dish.period, seafoodAllowed: dish.seafoodAllowed };
}

// basis from the model -> 'Regional: Kabsa (Saudi)' / 'General' / '' (an older deployment returns none).
function basisText(basis) {
  if (!basis || !basis.kind) return '';
  if (basis.kind !== 'regional') return 'General';
  const dish = String(basis.dish || '').trim();
  const cuisine = String(basis.cuisine || '').trim();
  return `Regional: ${dish || 'regional dish'}${cuisine ? ` (${cuisine})` : ''}`;
}

// One answer -> what the app keeps for one row: the school's rules applied in code (lib/menuIngredientFilters.js).
// `who` is anything with seafoodAllowed (a dish from dishesForSuggestion, or { seafoodAllowed } for one row's section).
function cleanSuggestion(est, who) {
  const f = filterMenuIngredients({ ingredients: est.ingredients, allergens: est.allergens }, { seafoodAllowed: !!who.seafoodAllowed });
  return { ingredients: f.ingredients, allergens: f.allergens, removed: f.removed, removedAllergens: f.removedAllergens, tidied: f.tidied, basis: basisText(est.basis) };
}

// A row's own seafood rule: allowed only on a Staff / CEO sheet.
const rowSeafoodAllowed = (row) => ADULT_SECTIONS.has(resolveSectionFromSheetName(row.sheetName));

module.exports = { dishesForSuggestion, toPayloadItem, cleanSuggestion, basisText, rowSeafoodAllowed, isServedAsIsRow };
