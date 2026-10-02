// ============================================================
// Dish Catalog ingredients, M3 (2026-10-02): the Menu Ingredients Generator checks the Dish Catalog before the AI.
// A row whose dish is in the catalog (lib/catalogIngredients.js: exact name within the row's category, case / spacing
// aside; an inactive dish counts -- same dish) AND has a saved, chef-approved list (menu_items.ingredients_text, saved
// by M2) uses that list; every other row -- new, ambiguous, unclear category, or a catalog dish with no saved list --
// goes to the AI exactly as before. With no saved lists anywhere, nothing changes: the same rows reach the AI and
// each row only gains `catalog: null`.
//
// The saved list is never trusted as filtered: it goes through the SAME cleanSuggestion as an AI answer
// (lib/menuIngredientsRequest.js -> lib/menuIngredientFilters.js: nut / sesame, spicy, halal, student seafood, plus the
// wording / repeat / comment clean-ups) for each row's OWN section, on every upload. Staff's saved Tuna Sandwich keeps
// its tuna; KG-LP's row loses it, with the red note.
// Pure: no AI, no database. main.js parse-and-suggest-menu-ingredients loads the catalog and calls these.
// ============================================================
const { planIngredientLookup } = require('./catalogIngredients');
const { cleanSuggestion, rowSeafoodAllowed, isServedAsIsRow } = require('./menuIngredientsRequest');
const { shareName, rowKey } = require('./menuIngredientsShare');

// files: [{ fileIndex, rows }] (parsed rows); catalog / categories as planIngredientLookup takes them.
// -> { fromCatalog: Map(rowKey -> catalog item with a saved list), aiRows: the rows still needing the AI (served-as-is
//    rows included, as before -- dishesForSuggestion skips them) }
function splitRowsByCatalog({ files, catalog, categories }) {
  const fromCatalog = new Map();
  const { rows } = planIngredientLookup({ files: files.map((f) => ({ fileName: String(f.fileIndex), rows: f.rows })), catalog, categories });
  for (const r of rows) {
    if (r.status === 'match' && r.saved) fromCatalog.set(`${r.fileName}|${r.sheetName}|${r.rowNumber}`, r.item);
  }
  const aiRows = files.flatMap((f) => f.rows.map((r) => ({ ...r, fileIndex: f.fileIndex }))).filter((r) => !fromCatalog.has(rowKey(r)));
  return { fromCatalog, aiRows };
}

// One row, cleaned for its own section (moved unchanged from main.js; `catalog` added). answers: Map(dish key -> raw AI
// answer); catalogItem: the row's catalog dish when its saved list is used, else null.
function annotateRow(r, fileIndex, { answers, catalogItem = null }) {
  // Fruit Bar / Fruit Basket / Salad Bar: served as is -- never sent, blank, even when another row shares its name.
  const servedAsIs = isServedAsIsRow(r);
  const est = servedAsIs ? null
    : catalogItem ? { ingredients: catalogItem.ingredients_text, allergens: catalogItem.allergens_text || '' }
    : answers.get(shareName(r.dishName));
  const res = est ? cleanSuggestion(est, { seafoodAllowed: rowSeafoodAllowed(r) }) : null;
  return {
    ...r,
    fileIndex,
    servedAsIs,
    ingredients: res ? res.ingredients : '',
    allergens: res ? res.allergens : '',
    // On screen only: basis ("Regional: Kabsa (Saudi)" / "General") and every segment the school's rules took
    // out of this row's suggestion, with its policy -- never silent, so she can type one back.
    basis: res ? res.basis : '',
    removedTerms: res ? res.removed.map(({ segment, policy }) => ({ segment, policy })) : [],
    removedAllergenTerms: res ? res.removedAllergens.map(({ segment, policy }) => ({ segment, policy })) : [],
    policyLog: res ? [...res.removed, ...res.removedAllergens] : [],
    // Where the list came from when it is the Dish Catalog's saved one (on screen: "From the Dish Catalog · saved ...").
    catalog: !servedAsIs && catalogItem ? { itemId: catalogItem.id, name: catalogItem.name, updatedAt: catalogItem.ingredients_updated_at || null, updatedBy: catalogItem.ingredients_updated_by || null } : null,
  };
}

module.exports = { splitRowsByCatalog, annotateRow };
