#!/usr/bin/env node
// MV4 switch-over proof (npm test): Menu Ingredients serves the SAME list for every row before and after the ingredient
// features moved from menu_items onto dish versions. For 300 generated catalogs + menus:
//   BEFORE -- the catalog rows' own lists (menu_items.ingredients_text, as M3 read them up to MV3);
//   the real MV2 build (lib/masterItemsBuild.js, against a stand-in database) makes the versions and links;
//   AFTER  -- the same rows through lib/masterItems.js withVariantLists (what M3 reads from MV4 on).
// Then lib/menuIngredientsCatalog.js (split + per-section cleaning, unchanged) runs on both. Every menu row whose catalog
// row HAD a list must come out byte-identical (ingredients, allergens, removals, which rows reach the AI). The only
// allowed difference: a catalog row with no list of its own that joined its dish's only version (the ticked assumption B)
// is now served that version's list -- counted and checked to be exactly that version's list.
// No login, no Supabase.
const { planBuild, applyBuild } = require('../lib/masterItemsBuild');
const { withVariantLists } = require('../lib/masterItems');
const { splitRowsByCatalog, annotateRow } = require('../lib/menuIngredientsCatalog');
const { rowKey } = require('../lib/menuIngredientsShare');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g.slice(0, 300)}, expected ${w.slice(0, 300)}`);
};

function fakeDb(t) {
  const db = { t, next: 1 };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; },
      insert(v) { st.op = 'insert'; st.v = Array.isArray(v) ? v : [v]; return chain; },
      upsert(v) { st.op = 'upsert'; st.v = v; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; }, delete() { st.op = 'delete'; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; }, in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return chain; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return chain; },
      then(resolve) {
        const rows = (db.t[table] = db.t[table] || []);
        const add = (r) => { const row = { id: db.next++, ...r }; rows.push(row); return row; };
        if (st.op === 'insert') return resolve({ data: st.v.map(add), error: null });
        if (st.op === 'upsert') return resolve({ data: st.v.filter((r) => !rows.some((x) => x.name_key === r.name_key)).map(add), error: null });
        const hit = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.v)); return resolve({ data: hit.map((r) => ({ ...r })), error: null }); }
        if (st.op === 'delete') { db.t[table] = rows.filter((r) => !hit.includes(r)); return resolve({ data: hit, error: null }); }
        return resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return chain;
  };
  return db;
}

let seed = 11;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 16) % n; }; // high bits: the low ones repeat
const categories = [{ code: 'LUNCH_MAIN', name: 'Lunch Main Course' }, { code: 'AM_SNACK', name: 'AM Snack' }, { code: 'STAFF_MAIN', name: 'Main Dish' }];
const CAT = { LUNCH_MAIN: ['Lunch Main Course', 'SCHOOL', ['KG - LP', 'MS - UP (B-G)']], AM_SNACK: ['AM Snack', 'SCHOOL', ['Daycare', 'KG - LP']], STAFF_MAIN: ['Main Dish', 'STAFF', ['Staff']] };
const DISHES = ['Tuna Sandwich', 'Walnut Brownie', 'Chicken Kabsa', 'Cheese Croissant', 'Lentil Stew', 'Pesto Pasta'];
// Lists with things the per-section rules act on (seafood, nuts, "-free" wording, repeats), so cleaning differences would show.
const LISTS = [null, null, 'bread - tuna - mayonnaise', 'flour - walnuts - sesame-free seeds - sugar - sugar', 'rice - chicken - kabsa spice', 'flour - butter - cheese', 'lentils - onion - cumin'];

(async () => {
  let rowsCompared = 0, identical = 0, joinedServed = 0, mismatch = 0;
  for (let t = 0; t < 300; t++) {
    // a catalog: each dish in 1-3 categories, each row with a list or not
    const items = [];
    let id = 1;
    for (const d of DISHES) {
      const cats = Object.keys(CAT).filter(() => rnd(2));
      for (const c of (cats.length ? cats : ['LUNCH_MAIN'])) {
        const list = LISTS[rnd(LISTS.length)];
        items.push({ id: id++, name: rnd(4) ? d : d.toLowerCase(), category_id: c, category_code: c, category_name: CAT[c][0], sections: [], is_active: 1,
          ingredients_text: list, allergens_text: list ? 'gluten' : null, ingredients_updated_at: list ? `2026-10-02T0${rnd(9)}:00:00Z` : null,
          ingredients_updated_by: list ? 'tetiana' : null, ingredients_source: list ? 'menu_upload' : null, dish_variant_id: null });
      }
    }
    // MV2 on a stand-in database (assumption B ticked)
    const db = fakeDb({ menu_items: items.map((r) => ({ ...r })) });
    await applyBuild({ db, plan: planBuild({ rows: db.t.menu_items }), includeJoining: true, who: 'x' });
    const linked = db.t.menu_items;
    const after = withVariantLists(linked, db.t.dish_variants || []).map((r) => ({ ...r, category_code: r.category_code }));
    const before = items.map((r) => ({ ...r }));
    // a menu upload: each catalog row on a day in each of its sheets
    const fileRows = [];
    let n = 0;
    for (const it of items) for (const sheet of CAT[it.category_code][2]) {
      fileRows.push({ sheetName: sheet, layout: CAT[it.category_code][1], category: CAT[it.category_code][0], period: 'Lunch', dishName: it.name, rowNumber: ++n, weekday: 'Sunday', date: '13-09-2026', _item: it.id });
    }
    const files = [{ fileIndex: 0, rows: fileRows }];
    const serve = (catalog) => {
      const split = splitRowsByCatalog({ files, catalog, categories });
      return fileRows.map((r) => {
        const out = annotateRow(r, 0, { answers: new Map(), catalogItem: split.fromCatalog.get(rowKey({ ...r, fileIndex: 0 })) || null });
        return { ai: !split.fromCatalog.has(rowKey({ ...r, fileIndex: 0 })), ingredients: out.ingredients, allergens: out.allergens, removed: out.removedTerms, catalogItem: out.catalog ? out.catalog.itemId : null };
      });
    };
    const b = serve(before), a = serve(after);
    fileRows.forEach((r, i) => {
      const own = items.find((x) => x.id === r._item);
      rowsCompared++;
      const strip = (o) => ({ ai: o.ai, ingredients: o.ingredients, allergens: o.allergens, removed: o.removed });
      // A menu row is matched to the catalog by name within its category; both sides use the same match, so compare.
      if (JSON.stringify(strip(a[i])) === JSON.stringify(strip(b[i]))) { identical++; return; }
      // Allowed: the matched catalog row had no list of its own and now gets its version's list (it joined, ticked).
      const matched = after.find((x) => x.id === a[i].catalogItem);
      const ownHadNone = matched && !String(items.find((x) => x.id === matched.id).ingredients_text || '').trim();
      if (b[i].ai && !a[i].ai && ownHadNone && matched.variant_id != null) { joinedServed++; return; }
      mismatch++;
      if (mismatch <= 3) failures.push(`catalog ${t}, row "${r.dishName}" (${r.sheetName}): before ${JSON.stringify(strip(b[i]))} after ${JSON.stringify(strip(a[i]))} (own list: ${own && own.ingredients_text})`);
    });
  }
  count++;
  if (mismatch) failures.push(`${mismatch} menu row(s) served differently`);
  console.log(`  compared ${rowsCompared} menu rows: ${identical} identical, ${joinedServed} newly served their dish's only version (assumption B), ${mismatch} different`);
  expect(identical > 0 && joinedServed > 0, true, 'both kinds occur in the generated data (the check is not vacuous)');

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`MV4 switch-over OK (${count} checks): every row with its own list is served byte-identically before and after.`);
})();
