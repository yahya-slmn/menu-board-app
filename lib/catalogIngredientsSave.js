// ============================================================
// Dish Catalog ingredients, M2 (2026-10-02): "Save approved lists to the Dish Catalog". The chef reviews a Menu
// Ingredients export in Excel and uploads it; each row is matched to its catalog dish (lib/catalogIngredients.js, exact
// name within the row's category) and its Ingredients / Allergens become that dish's saved list
// (on its dish VERSION since MV4: dish_variants.ingredients_text / allergens_text; before, menu_items) -- only what she ticks, after a preview.
//
// planIngredientsSave (pure): one entry per catalog dish, not per row -- a dish is on many rows (days, sections), and its
// rows can disagree (a student row lost its seafood, a Staff copy was edited for Staff). Each distinct list is a VERSION
// with the rows it came from; the one on the most rows is preselected and the preview says so ("6 rows: Daycare, KG-LP,
// MS-UP" against "2 rows: Staff"), so choosing another is an informed choice. Two lists are the same when only case,
// spacing or the order of ingredients differ. Blank cells approve nothing and are never saved.
//
// applyIngredientSaves (database passed in, so it is tested with a stand-in): each save -- on the dish VERSION since MV4 --
// is a compare-and-swap on ingredients_updated_at -- written only if the dish's list is still the one the preview read (people use the app at the
// same time), otherwise reported as a conflict with who changed it and when. Every save appends a history row
// (menu_item_ingredient_history). The text is stored exactly as approved: the safety filters run when a list is reused
// (M3), the same as for an AI answer.
// ============================================================
const { planIngredientLookup } = require('./catalogIngredients');
const { SECTION_ORDER } = require('./catalogImport');

const SECTION_LABELS = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };
const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const blankToNull = (v) => (tidy(v) ? tidy(v) : null);

// A list's identity: its ingredients, case / spacing / order aside ("Chicken - Rice" = "rice -  chicken").
function listKey(text) {
  return String(text ?? '').split(' - ').map((x) => x.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean).sort().join('|');
}
const versionKey = (ingredients, allergens) => `${listKey(ingredients)}||${listKey(allergens)}`;

function sectionsText(sections) {
  return SECTION_ORDER.filter((s) => sections.includes(s)).map((s) => SECTION_LABELS[s] || s).join(', ');
}

// files: [{ fileName, rows }] (parseWorkbookDishes rows of Menu Ingredients exports); catalog: [{ id, name,
// category_code, is_active, ingredients_text, allergens_text, ingredients_updated_at, ingredients_updated_by }];
// categories: [{ code, name }].
function planIngredientsSave({ files, catalog, categories, sectionOverrides = {} }) {
  const { rows } = planIngredientLookup({ files, catalog, categories, sectionOverrides });
  const categoryName = new Map(categories.map((c) => [c.code, c.name]));
  const hasLists = rows.some((r) => tidy(r.ingredients));

  // One entry per dish VERSION (MV4, 2026-10-04): the list belongs to the version (dish_variants), shared by every catalog
  // row using it -- catalog items reach here with their version's list and id (lib/masterItems.js withVariantLists).
  // A catalog row linked to no version can't hold a list: listed under notSaved.notLinked.
  const byItem = new Map(); // version id -> group
  const blankOnly = new Map(); // version id -> name, for matched dishes whose rows are all blank
  const notLinked = new Map();
  for (const r of rows.filter((x) => x.status === 'match')) {
    const vid = r.item.variant_id ?? null;
    if (vid == null) { if (tidy(r.ingredients)) notLinked.set(r.itemId, r.itemName); continue; }
    if (!tidy(r.ingredients)) { if (!byItem.has(vid)) blankOnly.set(vid, r.itemName); continue; }
    blankOnly.delete(vid);
    if (!byItem.has(vid)) byItem.set(vid, { item: r.item, versions: new Map(), sections: new Set() });
    const g = byItem.get(vid);
    g.sections.add(r.section);
    const key = versionKey(r.ingredients, r.allergens);
    if (!g.versions.has(key)) g.versions.set(key, { ingredients: tidy(r.ingredients), allergens: tidy(r.allergens), rows: 0, sections: [], days: [], files: [] });
    const v = g.versions.get(key);
    v.rows++;
    if (!v.sections.includes(r.section)) v.sections.push(r.section);
    if (r.day && !v.days.includes(r.day)) v.days.push(r.day);
    if (!v.files.includes(r.fileName)) v.files.push(r.fileName);
  }

  const entries = [];
  for (const [variantId, g] of byItem) {
    const it = g.item;
    const saved = tidy(it.ingredients_text)
      ? { ingredients: tidy(it.ingredients_text), allergens: tidy(it.allergens_text), updatedAt: it.ingredients_updated_at || null, updatedBy: it.ingredients_updated_by || null }
      : null;
    const savedKey = saved ? versionKey(saved.ingredients, saved.allergens) : null;
    // Most rows first; a tie keeps the order the file has them in (stable sort).
    const versions = [...g.versions.entries()].map(([key, v]) => ({ ...v, sameAsSaved: key === savedKey }))
      .sort((a, b) => b.rows - a.rows);
    versions.forEach((v, i) => {
      v.reason = `${v.rows} row${v.rows === 1 ? '' : 's'}: ${sectionsText(v.sections)}`;
      if (i === 0 && versions.length > 1) v.reason += versions[1].rows === v.rows ? ' (first in the file -- same number of rows)' : ' (most rows)';
    });
    const statusOf = (v) => (!saved ? 'new' : v.sameAsSaved ? 'unchanged' : 'changed');
    entries.push({
      key: `variant:${variantId}`, variantId, name: it.name, categoryCode: it.category_code, categoryName: categoryName.get(it.category_code) || it.category_code,
      sections: SECTION_ORDER.filter((s) => g.sections.has(s)), inactive: it.is_active === 0 || it.is_active === false,
      saved, expectedUpdatedAt: saved ? saved.updatedAt : (it.ingredients_updated_at || null),
      versions, preselected: 0, disagree: versions.length > 1, status: statusOf(versions[0]),
      versionStatus: versions.map(statusOf),
    });
  }
  const order = new Map(categories.map((c, i) => [c.code, i]));
  entries.sort((a, b) => SECTION_ORDER.indexOf(a.sections[0]) - SECTION_ORDER.indexOf(b.sections[0])
    || (order.get(a.categoryCode) ?? 999) - (order.get(b.categoryCode) ?? 999) || a.name.localeCompare(b.name));

  const names = (list) => [...new Set(list.map((r) => r.dishName))];
  const fresh = rows.filter((r) => r.status === 'new' && tidy(r.ingredients));
  const ambiguous = rows.filter((r) => r.status === 'ambiguous');
  const dupByName = new Map();
  for (const r of ambiguous) if (!dupByName.has(r.dishName.toLowerCase())) dupByName.set(r.dishName.toLowerCase(), { name: r.dishName, candidates: r.candidates });
  return {
    hasLists,
    rowsRead: rows.length,
    disagree: entries.filter((e) => e.disagree),
    new: entries.filter((e) => !e.disagree && e.status === 'new'),
    changed: entries.filter((e) => !e.disagree && e.status === 'changed'),
    unchangedCount: entries.filter((e) => !e.disagree && e.status === 'unchanged').length,
    notSaved: {
      notInCatalog: names(fresh).map((n) => ({ name: n, sections: sectionsText([...new Set(fresh.filter((r) => r.dishName === n).map((r) => r.section))]) })),
      duplicates: [...dupByName.values()],
      blankDishes: [...new Set(blankOnly.values())],
      notLinked: [...new Set(notLinked.values())],
      blankRows: rows.filter((r) => r.status === 'match' && !tidy(r.ingredients)).length,
      unclear: rows.filter((r) => r.status === 'unclear').length,
      servedAsIs: rows.filter((r) => r.status === 'servedAsIs').length,
    },
  };
}

// saves: [{ variantId, name, ingredients, allergens, expectedUpdatedAt, oldIngredients, oldAllergens }] -- written to the
// dish VERSION (dish_variants, MV4). Returns { saved: [{ variantId, name, updatedAt }], conflicts: [{ variantId, name, by, at }],
// failed: [{ variantId, name, error }], historyError }.
async function applyIngredientSaves({ db, saves, who, source, sourceFile = null, now = () => new Date().toISOString() }) {
  const saved = [], conflicts = [], failed = [], history = [];
  const one = async (s) => {
    const at = now();
    let q = db.from('dish_variants').update({
      ingredients_text: blankToNull(s.ingredients), allergens_text: blankToNull(s.allergens),
      ingredients_updated_at: at, ingredients_updated_by: who || null, ingredients_source: source,
    }).eq('id', s.variantId);
    q = s.expectedUpdatedAt == null ? q.is('ingredients_updated_at', null) : q.eq('ingredients_updated_at', s.expectedUpdatedAt);
    const { data, error } = await q.select('id');
    if (error) { failed.push({ variantId: s.variantId, name: s.name, error: error.message || String(error) }); return; }
    if (!data || !data.length) {
      const { data: now2 } = await db.from('dish_variants').select('ingredients_updated_at, ingredients_updated_by').eq('id', s.variantId);
      const cur = (now2 || [])[0];
      if (!cur) { failed.push({ variantId: s.variantId, name: s.name, error: 'this version of the dish no longer exists' }); return; }
      conflicts.push({ variantId: s.variantId, name: s.name, by: cur.ingredients_updated_by || null, at: cur.ingredients_updated_at || null });
      return;
    }
    saved.push({ variantId: s.variantId, name: s.name, updatedAt: at });
    history.push({ item_id: null, dish_variant_id: s.variantId, old_ingredients: blankToNull(s.oldIngredients), new_ingredients: blankToNull(s.ingredients),
      old_allergens: blankToNull(s.oldAllergens), new_allergens: blankToNull(s.allergens), source, source_file: sourceFile, changed_by: who || null, changed_at: at });
  };
  for (let i = 0; i < saves.length; i += 10) await Promise.all(saves.slice(i, i + 10).map(one));
  let historyError = null;
  for (let i = 0; i < history.length && !historyError; i += 500) {
    const { error } = await db.from('menu_item_ingredient_history').insert(history.slice(i, i + 500));
    if (error) historyError = error.message || String(error);
  }
  return { saved, conflicts, failed, historyError };
}

module.exports = { planIngredientsSave, applyIngredientSaves, listKey };
