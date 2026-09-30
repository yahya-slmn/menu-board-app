// ============================================================
// One-time "Re-group from the original menu..." (Recipe Generator Drafts folder, 2026-09-30). Recipes generated
// before generated_recipes.source_category_group existed only have their category text, and a bare Staff "Main
// Dish" can't say Breakfast or Lunch -- they sit under Other. The chef picks the menu file they came from; this
// re-reads it the same way an upload does (parse -> section + group per row -> dedupeWithinUpload, the same
// priority rules) and plans a group for each such recipe. Pure: main.js fetches the recipes and their saved
// ingredients, shows the plan, and writes only after she confirms (and only where the group is still empty).
// ============================================================
const { dedupeWithinUpload, resolveSectionFromSheetName, emptyDishIndex, addNameToIndex, findDuplicateMatch, normalizeDishName } = require('./recipeGenerator');
const { categoryGroupFor, categoryGroupInfo, staffMainGroup } = require('./recipeCategoryGroups');

// rows: parseWorkbookDishes(...).rows of the original menu file.
// recipes: [{ id, name, source_dish_name, ingredientNames: string[] }] -- the recipes without a saved group.
// Returns { assignments: [{ id, name, group, basis }], notFound: [{ id, name }] }. A recipe is matched by the dish
// name it was generated from (exact, then the usual near-duplicate spelling test); a Staff lunch main no student
// dish shares is decided by staffMainGroup from its SAVED ingredients (her edits count), with no AI role.
function planRegroup({ rows, recipes }) {
  const meta = rows.map((r) => ({
    ...r,
    section: resolveSectionFromSheetName(r.sheetName),
    categoryGroup: categoryGroupFor({ category: r.category, period: r.period }),
  }));
  const dishes = dedupeWithinUpload(meta);
  const index = emptyDishIndex();
  const byName = new Map();
  for (const d of dishes) {
    addNameToIndex(index, d.name);
    byName.set(normalizeDishName(d.name), d);
  }
  const assignments = [];
  const notFound = [];
  for (const recipe of recipes) {
    const source = recipe.source_dish_name || recipe.name;
    const match = findDuplicateMatch(source, index) || (recipe.name !== source ? findDuplicateMatch(recipe.name, index) : null);
    const dish = match && byName.get(normalizeDishName(match.matchedName));
    if (!dish) { notFound.push({ id: recipe.id, name: recipe.name }); continue; }
    if (dish.staffMainRole) {
      const { group, basis } = staffMainGroup({ name: dish.name, ingredientNames: recipe.ingredientNames || [] });
      assignments.push({ id: recipe.id, name: recipe.name, group, basis });
    } else {
      assignments.push({ id: recipe.id, name: recipe.name, group: categoryGroupInfo(dish.categoryGroup).key, basis: `menu row: ${dish.category || 'no label'}` });
    }
  }
  return { assignments, notFound };
}

module.exports = { planRegroup };
