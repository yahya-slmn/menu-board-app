// ============================================================
// Recipe Generator bulk delete (2026-10-04) -- the pure plan the confirmation shows. What is deleted: the selected
// generated recipes (drafts and / or confirmed), each through the app's existing single-recipe delete (its processes, with
// their ingredient and waste rows, and its photo in the Recipe Generator's own store). Nothing else: Recipe Book, Recipe
// Extractor, the Dish Catalog, Master Items / dish versions and their saved lists, the ingredients master and menus are not
// touched -- no table links a generated recipe to any of them (a version's recipe_id points at Recipe Book recipes).
// Per recipe the plan names the menu dish it was made for and, by EXACT name (case / spacing aside), the Master Item of that
// name if there is one, with its versions and saved lists -- shown so she sees which real Dish Catalog work shares the name,
// and that it is not affected.
// ============================================================
const key = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// recipes: the selected generated recipes [{ id, name, code, status, source_menu_label, source_dish_name }];
// masters: [{ id, name, name_key, versions, versionsWithList }] (every master item; matched by exact name).
// dependents: Map(recipeId -> { processes, ingredients }) -- rows that go with each recipe (optional, for the totals).
function planGeneratedDelete({ recipes, masters = [], dependents = new Map() }) {
  const masterByKey = new Map(masters.map((m) => [m.name_key || key(m.name), m]));
  const folders = new Map();
  for (const r of [...recipes].sort((a, b) => a.id - b.id)) {
    const folder = r.source_menu_label || 'Unknown source';
    if (!folders.has(folder)) folders.set(folder, { folder, drafts: 0, confirmed: 0, recipes: [] });
    const f = folders.get(folder);
    if (r.status === 'confirmed') f.confirmed++; else f.drafts++;
    const dish = r.source_dish_name || r.name;
    const m = masterByKey.get(key(dish)) || masterByKey.get(key(r.name)) || null;
    f.recipes.push({ id: r.id, name: r.name, code: r.code || null, status: r.status === 'confirmed' ? 'confirmed' : 'draft', dish,
      master: m ? { name: m.name, versions: m.versions || 0, versionsWithList: m.versionsWithList || 0 } : null });
  }
  const list = [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  const sum = (f) => recipes.reduce((n, r) => n + f(r), 0);
  return {
    folders: list,
    total: recipes.length,
    drafts: sum((r) => (r.status === 'confirmed' ? 0 : 1)),
    confirmed: sum((r) => (r.status === 'confirmed' ? 1 : 0)),
    codes: recipes.map((r) => r.code).filter(Boolean).sort(),
    sharingAMasterItem: list.reduce((n, f) => n + f.recipes.filter((x) => x.master).length, 0),
    dependentRows: recipes.reduce((acc, r) => {
      const d = dependents.get(r.id) || { processes: 0, ingredients: 0 };
      return { processes: acc.processes + d.processes, ingredients: acc.ingredients + d.ingredients };
    }, { processes: 0, ingredients: 0 }),
  };
}

// The next RG code: the highest number among codes IN USE and codes of DELETED recipes, plus one -- so a deleted
// recipe's code is never given to another one (chef's decision 2026-10-04).
function nextRgCode(usedCodes, deletedCodes = []) {
  let max = 0;
  for (const c of [...usedCodes, ...deletedCodes]) {
    const m = /^RG-(\d+)$/.exec(String(c || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `RG-${String(max + 1).padStart(5, '0')}`;
}

module.exports = { planGeneratedDelete, nextRgCode };
