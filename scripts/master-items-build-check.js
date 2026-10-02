#!/usr/bin/env node
// Master Items build (lib/masterItemsBuild.js, phase MV2), checked against a stand-in database (npm test):
//   A. the plan: masters / variants / lists to carry, joining rows and rows to pick counted separately.
//   B. apply: master items and variants created, every saved list carried onto its variant (text, allergens, who / when,
//      source kept), each row linked to the variant it uses; joining rows only when ticked; rows to pick left alone.
//   C. nothing else on menu_items changes (the engine's data): every other column byte-identical before and after.
//   D. re-running is safe: nothing duplicated, nothing relinked; a row already linked meanwhile is not overwritten.
//   E. a list re-saved after the preview is reported; one history row per list carried.
// No login, no Supabase.
const { planBuild, applyBuild } = require('../lib/masterItemsBuild');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

function fakeDb(t) {
  const db = { t, next: { master_items: 1, dish_variants: 1, menu_item_ingredient_history: 1 } };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; },
      insert(v) { st.op = 'insert'; st.v = Array.isArray(v) ? v : [v]; return chain; },
      upsert(v, o) { st.op = 'upsert'; st.v = v; st.o = o; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; }, delete() { st.op = 'delete'; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; }, in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return chain; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return chain; },
      then(resolve) {
        const rows = (db.t[table] = db.t[table] || []);
        const add = (r) => { const row = { id: db.next[table]++, ...r }; rows.push(row); return row; };
        if (st.op === 'insert') return resolve({ data: st.v.map(add), error: null });
        if (st.op === 'upsert') {
          const out = [];
          for (const r of st.v) { if (rows.some((x) => x.name_key === r.name_key)) continue; out.push(add(r)); }
          return resolve({ data: out, error: null });
        }
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

const row = (id, name, cat, secs, list = null, at = null, extra = {}) => ({ id, name, category_name: cat, sections: secs, is_active: 1, protein_type_id: 3, am_snack_style: 'PASTRY',
  calories_per_100g: 150 + id, ingredients_text: list, allergens_text: list ? 'dairy' : null, ingredients_updated_at: at, ingredients_updated_by: list ? 'tetiana' : null,
  ingredients_source: list ? 'menu_upload' : null, dish_variant_id: null, ...extra });
const catalog = () => [
  row(1, 'Macaroni & Cheese', 'Lunch Starch/Side', ['KG_LP', 'MS_UP'], 'pasta - cheese - milk', '2026-10-02T08:00:00Z'),
  row(2, 'macaroni  & cheese', 'Lunch Vegetable Side', ['MS_UP'], 'milk - pasta - cheese', '2026-10-02T09:00:00Z'),
  row(3, 'Macaroni & Cheese', 'Main Dish', ['STAFF'], 'pasta - cheddar - cream', '2026-10-02T10:00:00Z'),
  row(4, 'Macaroni & Cheese', 'Main Dish', ['CEO']),
  row(5, 'Kabsa Rice', 'Lunch Starch/Side', ['KG_LP'], 'rice - chicken', '2026-10-01T08:00:00Z'),
  row(6, 'Kabsa Rice', 'Main Dish', ['STAFF']),
  row(7, 'Lentil Soup', 'Soup/Appetizer', ['DAYCARE']),
];

(async () => {
  // ---- A
  const rows = catalog();
  const plan = planBuild({ rows });
  expect(plan.summary, { mastersToCreate: 3, variantsToCreate: 4, listsToCarry: 3, listRowsToLink: 4, joiningRows: 1, plainRowsToLink: 1, rowsToPick: 1, savedListsInCatalog: 4 },
    'the plan: 3 masters, 4 variants, 3 lists (rows 1+2 identical), row 6 joining, row 4 to pick');

  // ---- B + C
  const db = fakeDb({ menu_items: catalog() });
  const before = JSON.parse(JSON.stringify(db.t.menu_items));
  const r = await applyBuild({ db, plan: JSON.parse(JSON.stringify(plan)), includeJoining: false, who: 'tetiana' });
  expect([r.mastersCreated, r.variantsCreated, r.rowsLinked, r.listsCarried, r.failed, r.historyError], [3, 4, 5, 3, [], null], 'created and linked (row 6 not ticked, row 4 to pick)');
  const v = (rowId) => db.t.dish_variants.find((x) => x.id === db.t.menu_items.find((m) => m.id === rowId).dish_variant_id);
  expect([v(1).id === v(2).id, v(3).id !== v(1).id, v(1).ingredients_text, v(1).ingredients_updated_by, v(1).ingredients_source, v(3).ingredients_text],
    [true, true, 'milk - pasta - cheese', 'tetiana', 'menu_upload', 'pasta - cheddar - cream'], 'identical lists share a variant (latest text kept); Staff has its own');
  expect([db.t.menu_items.find((m) => m.id === 6).dish_variant_id, db.t.menu_items.find((m) => m.id === 4).dish_variant_id], [null, null], 'the joining row (not ticked) and the row to pick stay unlinked');
  expect([v(7).ingredients_text, db.t.master_items.map((m) => m.name_key).sort()], [null, ['kabsa rice', 'lentil soup', 'macaroni & cheese']], 'a dish with no list gets an empty variant; one master per name');
  const strip = (rs) => rs.map(({ dish_variant_id, ...rest }) => rest);
  expect(strip(db.t.menu_items), strip(before), 'every other menu_items column is unchanged (the engine data)');
  expect(db.t.menu_item_ingredient_history.map((h) => [h.item_id, h.source, h.new_ingredients === h.old_ingredients]).sort(), [[1, 'variant_migration', true], [3, 'variant_migration', true], [5, 'variant_migration', true]],
    'one history row per list carried, nothing changed in the text');

  // ---- D: re-run with the joining row ticked -- nothing duplicated, only row 6 newly linked, to the existing variant.
  const plan2 = planBuild({ rows: db.t.menu_items, existingMasters: db.t.master_items });
  expect([plan2.summary.mastersToCreate, plan2.summary.variantsToCreate, plan2.summary.joiningRows, plan2.summary.rowsToPick], [0, 0, 1, 1], 'a second preview creates nothing new');
  const r2 = await applyBuild({ db, plan: plan2, includeJoining: true, who: 'tetiana' });
  expect([r2.mastersCreated, r2.variantsCreated, r2.rowsLinked, r2.listsCarried, db.t.dish_variants.length], [0, 0, 1, 0, 4], 're-run: only the ticked joining row is linked');
  expect(db.t.menu_items.find((m) => m.id === 6).dish_variant_id, db.t.menu_items.find((m) => m.id === 5).dish_variant_id, "the joining row uses its dish's only variant");

  // ---- E: a row linked by someone else after the preview is not overwritten; a list re-saved after the preview is reported.
  const db3 = fakeDb({ menu_items: catalog() });
  const plan3 = planBuild({ rows: db3.t.menu_items });
  db3.t.menu_items.find((m) => m.id === 3).ingredients_updated_at = '2026-10-03T07:00:00Z'; // re-saved after the preview
  db3.t.dish_variants = [{ id: 99, master_item_id: 0 }]; db3.next.dish_variants = 100;
  db3.t.menu_items.find((m) => m.id === 7).dish_variant_id = 99; // linked meanwhile
  const r3 = await applyBuild({ db: db3, plan: plan3, includeJoining: false, who: 'x' });
  expect([db3.t.menu_items.find((m) => m.id === 7).dish_variant_id, r3.alreadyLinked], [99, 1], 'a row linked meanwhile keeps its link');
  expect(r3.changedSincePreview, [{ id: 3 }], 'a list re-saved after the preview is reported');
  expect(db3.t.dish_variants.some((x) => x.ingredients_text === null && x.id !== 99), false, "the empty variant no row ended up using is removed again");

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Master Items build OK (${count} checks).`);
})();
