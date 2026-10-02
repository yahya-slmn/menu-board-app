#!/usr/bin/env node
// Master Items screen data + writes (lib/masterItems.js, MV3), checked against a stand-in database (npm test):
//   A. withVariantLists: a catalog row gets its VERSION's list (shared by every row using it); a row with no version none.
//   B. buildMasterList: masters with their versions, display names, the rows using each.
//   C. saveVariantList: one save changes the list for every row using the version; a save made after someone else's
//      newer save is refused (who / when returned); an unchanged list writes nothing; one history row per save.
//   D. moveRowToVersion: only the row's dish_variant_id changes; never to another dish's version; "new version" starts as
//      a copy of the current list; a row moved meanwhile is reported, the unneeded new version removed.
//   E. delete: refused while used; unlink-and-delete clears only the users' links, keeps the list in history.
// No login, no Supabase.
const { withVariantLists, buildMasterList, saveVariantList, moveRowToVersion, deleteVersionOrMaster } = require('../lib/masterItems');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};
function fakeDb(t) {
  const db = { t, next: 100 };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; },
      insert(v) { st.op = 'insert'; st.v = Array.isArray(v) ? v : [v]; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; }, delete() { st.op = 'delete'; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; }, in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return chain; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return chain; },
      then(resolve) {
        const rows = (db.t[table] = db.t[table] || []);
        if (st.op === 'insert') { const added = st.v.map((r) => ({ id: db.next++, ...r })); rows.push(...added); return resolve({ data: added, error: null }); }
        const hit = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.v)); return resolve({ data: hit.map((r) => ({ ...r })), error: null }); }
        if (st.op === 'delete') { db.t[table] = rows.filter((r) => !hit.includes(r)); if (table === 'master_items') db.t.dish_variants = (db.t.dish_variants || []).filter((v) => !hit.some((m) => m.id === v.master_item_id)); return resolve({ data: hit, error: null }); }
        return resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return chain;
  };
  return db;
}
const state = () => ({
  master_items: [{ id: 1, name: 'Macaroni & Cheese', name_key: 'macaroni & cheese' }, { id: 2, name: 'Kabsa Rice', name_key: 'kabsa rice' }],
  dish_variants: [
    { id: 10, master_item_id: 1, ingredients_text: 'pasta - cheese - milk', allergens_text: 'dairy', ingredients_updated_at: '2026-10-02T09:00:00Z', ingredients_updated_by: 'tetiana', ingredients_source: 'menu_upload', created_at: '2026-10-03T10:00:00Z' },
    { id: 11, master_item_id: 1, ingredients_text: 'pasta - cheddar - cream', allergens_text: 'dairy', ingredients_updated_at: '2026-10-02T10:00:00Z', ingredients_updated_by: 'tetiana', ingredients_source: 'menu_upload', created_at: '2026-10-03T10:00:00Z' },
    { id: 12, master_item_id: 2, ingredients_text: null, allergens_text: null, ingredients_updated_at: null, created_at: '2026-10-03T10:00:00Z' },
  ],
  menu_items: [
    { id: 1, name: 'Macaroni & Cheese', category_name: 'Lunch Starch/Side', sections: ['KG_LP', 'MS_UP'], is_active: 1, dish_variant_id: 10, ingredients_text: 'old frozen copy', calories_per_100g: 150 },
    { id: 2, name: 'Macaroni & Cheese', category_name: 'Lunch Vegetable Side', sections: ['MS_UP'], is_active: 1, dish_variant_id: 10, ingredients_text: null, calories_per_100g: 160 },
    { id: 3, name: 'Macaroni & Cheese', category_name: 'Main Dish', sections: ['STAFF'], is_active: 1, dish_variant_id: 11, ingredients_text: 'pasta - cheddar - cream', calories_per_100g: 170 },
    { id: 4, name: 'Kabsa Rice', category_name: 'Lunch Starch/Side', sections: ['KG_LP'], is_active: 1, dish_variant_id: 12, ingredients_text: null },
    { id: 5, name: 'Lentil Soup', category_name: 'Soup/Appetizer', sections: ['DAYCARE'], is_active: 1, dish_variant_id: null, ingredients_text: 'old list, no version' },
  ],
  menu_item_ingredient_history: [],
});

(async () => {
  // ---- A
  const s0 = state();
  const served = withVariantLists(s0.menu_items, s0.dish_variants);
  expect(served.map((r) => [r.id, r.variant_id, r.ingredients_text]), [[1, 10, 'pasta - cheese - milk'], [2, 10, 'pasta - cheese - milk'], [3, 11, 'pasta - cheddar - cream'], [4, 12, null], [5, null, null]],
    "each row gets its version's list (row 1's frozen copy and row 5's old list are not used)");
  expect([served[0].calories_per_100g, served[0].category_name], [150, 'Lunch Starch/Side'], 'nothing else of the row changes');

  // ---- B
  const list = buildMasterList({ masters: s0.master_items, variants: s0.dish_variants, rows: s0.menu_items });
  expect(list.map((m) => [m.name, m.rows, m.versions.map((v) => [v.id, v.displayName, v.rows.map((r) => r.id)])]),
    [['Kabsa Rice', 1, [[12, 'KG-LP — 3 Oct 2026', [4]]]], ['Macaroni & Cheese', 3, [[10, 'KG-LP, MS-UP — 2 Oct 2026', [1, 2]], [11, 'Staff — 2 Oct 2026', [3]]]]],
    'masters, versions (display names) and the rows using each');

  // ---- C
  const db = fakeDb(state());
  const r1 = await saveVariantList({ db, variantId: 10, ingredients: 'pasta - cheese - milk - butter', allergens: 'dairy', expectedUpdatedAt: '2026-10-02T09:00:00Z', who: 'tetiana', now: () => '2026-10-04T08:00:00Z' });
  expect([r1.saved, withVariantLists(db.t.menu_items, db.t.dish_variants).filter((r) => r.variant_id === 10).map((r) => r.ingredients_text)], [true, ['pasta - cheese - milk - butter', 'pasta - cheese - milk - butter']],
    'one save changes the list for both rows using the version');
  expect(db.t.menu_items.find((r) => r.id === 1).ingredients_text, 'old frozen copy', "the catalog row's own (frozen) list column is not written");
  const r2 = await saveVariantList({ db, variantId: 10, ingredients: 'something else', allergens: '', expectedUpdatedAt: '2026-10-02T09:00:00Z', who: 'chef2' });
  expect(r2, { conflict: { by: 'tetiana', at: '2026-10-04T08:00:00Z' } }, "a save based on an older read is refused, with who / when of the newer one");
  expect((await saveVariantList({ db, variantId: 10, ingredients: ' pasta -  cheese - milk - butter', allergens: 'dairy', expectedUpdatedAt: '2026-10-04T08:00:00Z', who: 'x' })).unchanged, true, 'an unchanged list writes nothing');
  expect(db.t.menu_item_ingredient_history.map((h) => [h.item_id, h.dish_variant_id, h.old_ingredients, h.new_ingredients, h.source]), [[null, 10, 'pasta - cheese - milk', 'pasta - cheese - milk - butter', 'manual']], 'one history row, on the version');

  // ---- D
  const before = JSON.parse(JSON.stringify(db.t.menu_items));
  expect((await moveRowToVersion({ db, rowId: 2, fromVariantId: 10, toVariantId: 11, who: 't' })).moved, true, 'row 2 moved to the Staff version');
  const strip = (rs) => rs.map(({ dish_variant_id, ...rest }) => rest);
  expect([db.t.menu_items.find((r) => r.id === 2).dish_variant_id, JSON.stringify(strip(db.t.menu_items)) === JSON.stringify(strip(before))], [11, true], 'only dish_variant_id changed');
  let threw = ''; try { await moveRowToVersion({ db, rowId: 4, fromVariantId: 12, toVariantId: 10 }); } catch (e) { threw = e.message; }
  expect(threw, 'A row can only use a version of its own dish.', "never to another dish's version");
  const made = await moveRowToVersion({ db, rowId: 3, fromVariantId: 11, toVariantId: null, who: 't' });
  expect([made.created, db.t.dish_variants.find((v) => v.id === made.toVariantId).ingredients_text], [true, 'pasta - cheddar - cream'], 'a new version starts as a copy of the current list');
  const nVariants = db.t.dish_variants.length;
  expect((await moveRowToVersion({ db, rowId: 3, fromVariantId: 11, toVariantId: null })).stale, true, 'a row moved meanwhile is reported');
  expect(db.t.dish_variants.length, nVariants, '...and the new version it did not need is removed again');

  // ---- E
  expect(await deleteVersionOrMaster({ db, variantId: 10 }), { inUse: 1 }, 'delete refused while a row uses the version');
  const d = await deleteVersionOrMaster({ db, variantId: 10, unlink: true, who: 't' });
  expect([d.deleted, d.unlinked, db.t.menu_items.find((r) => r.id === 1).dish_variant_id, db.t.dish_variants.some((v) => v.id === 10)], [true, 1, null, false], 'unlink and delete: the row stays, only its link cleared');
  expect(db.t.menu_item_ingredient_history.slice(-1).map((h) => [h.dish_variant_id, h.new_ingredients, h.source]), [[10, null, 'version_deleted']], "the deleted version's list is kept in the history");
  expect((await deleteVersionOrMaster({ db, masterId: 2 })).inUse, 1, 'a master item in use is refused too');

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Master Items screen OK (${count} checks).`);
})();
