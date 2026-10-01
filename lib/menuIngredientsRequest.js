// ============================================================
// Menu Ingredients Generator -> suggest-dish-ingredients: what is sent for each dish and how each answer is
// cleaned (2026-10-01, Phase C). Shared by main.js and scripts/mi-prompt-trial.js so the trial runs exactly
// what the app runs. Pure: no AI, no database.
//
// One request per dish NAME (exact, trimmed -- as before): a dish repeated over days / sections costs one call
// and its answer goes to every row. The dish carries the context of its FIRST row (category, section, meal
// period) so the model knows what kind of dish it is; seafood is allowed only when NO row of it is on a student
// sheet (Daycare / KG-LP / MS-UP, or a sheet whose section can't be told -- the safe default).
// ============================================================
const { resolveSectionFromSheetName } = require('./recipeGenerator');
const { filterMenuIngredients } = require('./menuIngredientFilters');

const SECTION_NAMES = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };
const ADULT_SECTIONS = new Set(['STAFF', 'CEO']);

// rows: parseWorkbookDishes(...).rows -> [{ name, category, section, period, seafoodAllowed }], first-seen order.
function dishesForSuggestion(rows) {
  const byName = new Map();
  for (const r of rows) {
    const section = resolveSectionFromSheetName(r.sheetName);
    const adult = ADULT_SECTIONS.has(section);
    const existing = byName.get(r.dishName);
    if (existing) { if (!adult) existing.seafoodAllowed = false; continue; }
    byName.set(r.dishName, {
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

// One answer -> what the app keeps: the school's rules applied in code (lib/menuIngredientFilters.js).
function cleanSuggestion(est, dish) {
  const f = filterMenuIngredients({ ingredients: est.ingredients, allergens: est.allergens }, { seafoodAllowed: dish.seafoodAllowed });
  return { ingredients: f.ingredients, allergens: f.allergens, removed: f.removed, removedAllergens: f.removedAllergens, tidied: f.tidied, basis: basisText(est.basis) };
}

module.exports = { dishesForSuggestion, toPayloadItem, cleanSuggestion, basisText };
