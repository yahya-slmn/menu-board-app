#!/usr/bin/env node
// New rows get a version (lib/variantLink.js, phase MV6), checked against a stand-in database (npm test):
//   A. the rule: a new dish -> a new master item + version; ONE version -> join it; 2+ -> a new empty version.
//   B. linkNewRow: name matched case / spacing aside; a row already linked is left alone (safe to repeat); two new rows of
//      one new dish share its version; a row linked meanwhile keeps its link and the unused new version is removed.
//   C. relinkRenamedRow: same name -> nothing; renamed -> the new name's dish by the same rule; the old version keeps its
//      list and calories; a row whose version changed meanwhile is not moved.
//   D. a failure throws and leaves the row as it was (saved, unlinked).
//   F. relinkOnEdit (Edit Item's save, 2026-10-06): a row with no version saved WITHOUT a rename is linked like a new row
//      (joins its dish's only version / a new dish / a new version when 2+); renamed rows behave exactly as relinkRenamedRow
//      (an unlinked row goes to the new name's dish); a linked row keeping its name is untouched; a row linked meanwhile is
//      kept; a failure throws and leaves the row saved and unlinked.
//   E. 2,000 random catalogs: the preview's prediction (planLinks) equals what linkNewRow does, every row ends on a version
//      of its own name's dish, and nothing but menu_items.dish_variant_id changes on a row.
// No login, no Supabase.
const { nameKey, chooseVersion, planLinks, linkNewRow, relinkRenamedRow, relinkOnEdit } = require('../lib/variantLink');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

// A stand-in for the few Supabase calls variantLink makes. failOn: 'table.op' throws that call's error once.
function fakeDb(t, opts = {}) {
  const db = { t, next: { master_items: 100, dish_variants: 100 }, failOn: opts.failOn || null, beforeUpdate: opts.beforeUpdate || null };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      select() { if (!st.op) st.op = 'select'; return chain; },
      insert(v) { st.op = 'insert'; st.v = Array.isArray(v) ? v : [v]; return chain; },
      upsert(v) { st.op = 'upsert'; st.v = v; return chain; },
      update(v) { st.op = 'update'; st.v = v; return chain; },
      delete() { st.op = 'delete'; return chain; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return chain; },
      is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return chain; },
      then(resolve) {
        if (db.failOn === `${table}.${st.op}`) { db.failOn = null; return resolve({ data: null, error: { message: `stand-in failure on ${table}.${st.op}` } }); }
        const rows = (db.t[table] = db.t[table] || []);
        const add = (r) => { const row = { id: db.next[table]++, ...r }; rows.push(row); return row; };
        if (st.op === 'insert') return resolve({ data: st.v.map(add), error: null });
        if (st.op === 'upsert') return resolve({ data: st.v.filter((r) => !rows.some((x) => x.name_key === r.name_key)).map(add), error: null });
        if (st.op === 'update' && table === 'menu_items' && db.beforeUpdate) { const f = db.beforeUpdate; db.beforeUpdate = null; f(db.t); }
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
const base = () => ({
  master_items: [{ id: 1, name: 'Lentil Soup', name_key: 'lentil soup' }, { id: 2, name: 'Macaroni & Cheese', name_key: 'macaroni & cheese' }, { id: 3, name: 'Empty Dish', name_key: 'empty dish' }],
  dish_variants: [
    { id: 10, master_item_id: 1, ingredients_text: 'lentils - onion', calories_per_100g: 70, calories_unverified: false },
    { id: 20, master_item_id: 2, ingredients_text: 'macaroni - cheddar', calories_per_100g: 160, calories_unverified: false },
    { id: 21, master_item_id: 2, ingredients_text: 'macaroni - cheddar - cream', calories_per_100g: 190, calories_unverified: false },
  ],
  menu_items: [
    { id: 1, name: 'Lentil Soup', category_id: 5, calories_per_100g: 70, dish_variant_id: 10 },
    { id: 2, name: '  lentil   SOUP ', category_id: 9, calories_per_100g: null, dish_variant_id: null },
    { id: 3, name: 'Macaroni & Cheese', category_id: 5, calories_per_100g: null, dish_variant_id: null },
    { id: 4, name: 'Shakshuka', category_id: 7, calories_per_100g: null, dish_variant_id: null },
    { id: 5, name: 'shakshuka', category_id: 8, calories_per_100g: null, dish_variant_id: null },
    { id: 6, name: 'Empty Dish', category_id: 8, calories_per_100g: null, dish_variant_id: null },
  ],
});
const vOf = (t, id) => t.menu_items.find((r) => r.id === id).dish_variant_id;
const masterOfV = (t, vid) => t.dish_variants.find((v) => v.id === vid)?.master_item_id;

(async () => {
  // A. the rule
  expect([chooseVersion([]), chooseVersion([7]), chooseVersion([7, 8])], [{ create: true }, { join: 7 }, { create: true }], 'A1 rule');
  expect(nameKey('  Lentil   SOUP '), 'lentil soup', 'A2 name key');

  // B. linkNewRow
  {
    const t = base(); const db = fakeDb(t);
    expect(planLinks(t.menu_items.filter((r) => r.dish_variant_id == null), new Map([['lentil soup', 1], ['macaroni & cheese', 2], ['empty dish', 0]])).map((p) => p.outcome),
      ['joined', 'new-version', 'new-dish', 'joined', 'new-version'], 'B0 planLinks');
    const r2 = await linkNewRow({ db, rowId: 2, name: t.menu_items[1].name, who: 'tetiana' });
    expect([r2.outcome, vOf(t, 2)], ['joined', 10], 'B1 one version -> joined (case / spacing aside)');
    const r3 = await linkNewRow({ db, rowId: 3, name: 'Macaroni & Cheese', who: 'tetiana' });
    expect([r3.outcome, masterOfV(t, vOf(t, 3)), t.dish_variants.find((v) => v.id === vOf(t, 3)).ingredients_text ?? null], ['new-version', 2, null], 'B2 two versions -> a new empty one');
    const r4 = await linkNewRow({ db, rowId: 4, name: 'Shakshuka', who: 'tetiana' });
    const r5 = await linkNewRow({ db, rowId: 5, name: 'shakshuka', who: 'tetiana' });
    expect([r4.outcome, r5.outcome, vOf(t, 4) === vOf(t, 5), t.master_items.filter((m) => m.name_key === 'shakshuka').length], ['new-dish', 'joined', true, 1], 'B3 a new dish, then its second row joins');
    const r6 = await linkNewRow({ db, rowId: 6, name: 'Empty Dish', who: 'tetiana' });
    expect([r6.outcome, masterOfV(t, vOf(t, 6))], ['new-version', 3], 'B4 a dish with no versions gets one');
    const nV = t.dish_variants.length, nM = t.master_items.length;
    const again = await linkNewRow({ db, rowId: 4, name: 'Shakshuka', who: 'tetiana' });
    expect([again.outcome, again.variantId === vOf(t, 4), t.dish_variants.length, t.master_items.length], ['already', true, nV, nM], 'B5 repeat changes nothing');
    expect(t.dish_variants.filter((v) => [10, 20, 21].includes(v.id)), base().dish_variants, 'B6 existing versions untouched');
  }
  {
    // linked meanwhile (between reading the row and writing the link): keeps its link; the new version is removed
    const t = base();
    const db = fakeDb(t, { beforeUpdate: (tt) => { tt.menu_items.find((r) => r.id === 3).dish_variant_id = 20; } });
    const r = await linkNewRow({ db, rowId: 3, name: 'Macaroni & Cheese', who: 'x' });
    expect([r.outcome, vOf(t, 3), t.dish_variants.length], ['already', 20, 3], 'B7 linked meanwhile -> kept, new version removed');
    const t8 = base();
    const db8 = fakeDb(t8, { beforeUpdate: (tt) => { tt.menu_items.find((r) => r.id === 4).dish_variant_id = 10; } });
    const r8 = await linkNewRow({ db: db8, rowId: 4, name: 'Shakshuka', who: 'x' });
    expect([r8.outcome, t8.master_items.length, t8.dish_variants.length], ['already', 3, 3], 'B8 a new dish linked meanwhile -> its new master and version removed');
  }

  // C. relinkRenamedRow
  {
    const t = base(); const db = fakeDb(t);
    expect(await relinkRenamedRow({ db, rowId: 1, oldName: 'Lentil Soup', newName: 'lentil  soup', fromVariantId: 10, who: 'x' }), { moved: false, unchanged: true }, 'C1 same name');
    t.menu_items.push({ id: 7, name: 'Lentil Soop', category_id: 5, calories_per_100g: 55, dish_variant_id: null });
    t.dish_variants.push({ id: 30, master_item_id: 1, ingredients_text: 'typo version', calories_per_100g: 55 }); // a 2nd version under master 1 would change the rule; give the typo its own master
    t.dish_variants[t.dish_variants.length - 1].master_item_id = 4; t.master_items.push({ id: 4, name: 'Lentil Soop', name_key: 'lentil soop' });
    t.menu_items.find((r) => r.id === 7).dish_variant_id = 30;
    const c2 = await relinkRenamedRow({ db, rowId: 7, oldName: 'Lentil Soop', newName: 'Lentil Soup', fromVariantId: 30, who: 'x' });
    expect([c2.moved, c2.outcome, vOf(t, 7)], [true, 'joined', 10], 'C2 typo fixed -> joins the real dish');
    expect(t.dish_variants.find((v) => v.id === 30), { id: 30, master_item_id: 4, ingredients_text: 'typo version', calories_per_100g: 55 }, 'C3 old version keeps its list and calories');
    const c4 = await relinkRenamedRow({ db, rowId: 1, oldName: 'Lentil Soup', newName: 'Red Lentil Soup', fromVariantId: 10, who: 'x' });
    expect([c4.moved, c4.outcome, t.master_items.some((m) => m.name_key === 'red lentil soup'), masterOfV(t, vOf(t, 1)) !== 1], [true, 'new-dish', true, true], 'C4 new name -> new dish');
    const nV = t.dish_variants.length;
    const c5 = await relinkRenamedRow({ db, rowId: 2, oldName: 'lentil soup', newName: 'Shorba', fromVariantId: 999, who: 'x' });
    expect([c5, vOf(t, 2), t.dish_variants.length, t.master_items.some((m) => m.name_key === 'shorba')], [{ moved: false, stale: true }, null, nV, false], 'C5 version changed meanwhile -> not moved, nothing left behind');
    const c6 = await relinkRenamedRow({ db, rowId: 2, oldName: 'lentil soup', newName: 'Shorba', fromVariantId: null, who: 'x' });
    expect([c6.moved, c6.outcome], [true, 'new-dish'], 'C6 an unlinked row renamed gets linked');
  }

  // D. failures leave the row as it was
  {
    const t = base(); const db = fakeDb(t, { failOn: 'dish_variants.insert' });
    let threw = false;
    try { await linkNewRow({ db, rowId: 4, name: 'Shakshuka', who: 'x' }); } catch { threw = true; }
    expect([threw, vOf(t, 4), t.menu_items.length, t.master_items.length], [true, null, 6, 3], 'D1 version insert fails -> throws, row saved and unlinked, no empty master left');
    const t2 = base(); const db2 = fakeDb(t2, { failOn: 'menu_items.update' });
    threw = false;
    try { await linkNewRow({ db: db2, rowId: 4, name: 'Shakshuka', who: 'x' }); } catch { threw = true; }
    expect([threw, vOf(t2, 4), t2.dish_variants.length, t2.master_items.length], [true, null, 3, 3], 'D2 link write fails -> throws, the new version and master removed');
  }

  // F. Edit Item's save: link a row that has no version (relinkOnEdit)
  {
    const t = base(); const db = fakeDb(t);
    const r1 = await relinkOnEdit({ db, rowId: 2, oldName: '  lentil   SOUP ', newName: '  lentil   SOUP ', fromVariantId: null, who: 'chef' });
    expect([r1.moved, r1.via, r1.outcome, r1.variantId, vOf(t, 2)], [true, 'link', 'joined', 10, 10], 'F1 unlinked, not renamed -> joins its dish\'s only version');
    expect(t.dish_variants.find((v) => v.id === 10).ingredients_text, 'lentils - onion', 'F1 the joined version keeps its list');
    const r2 = await relinkOnEdit({ db, rowId: 4, oldName: 'Shakshuka', newName: 'Shakshuka', fromVariantId: null, who: 'chef' });
    expect([r2.moved, r2.via, r2.outcome, t.master_items.length], [true, 'link', 'new-dish', 4], 'F2 unlinked, a dish not in Master Items yet -> new master item + version');
    const r3 = await relinkOnEdit({ db, rowId: 3, oldName: 'Macaroni & Cheese', newName: 'Macaroni & Cheese', fromVariantId: null, who: 'chef' });
    expect([r3.moved, r3.outcome, [20, 21].includes(r3.variantId), masterOfV(t, r3.variantId)], [true, 'new-version', false, 2], 'F3 unlinked, a dish with 2 versions -> a new empty version of it');
    const r4 = await relinkOnEdit({ db, rowId: 1, oldName: 'Lentil Soup', newName: 'Lentil Soup', fromVariantId: 10, who: 'chef' });
    expect([r4, vOf(t, 1)], [{ moved: false, unchanged: true }, 10], 'F4 linked, not renamed -> untouched');
    const before = JSON.stringify(t);
    const r5 = await relinkOnEdit({ db, rowId: 1, oldName: 'Lentil  soup', newName: 'lentil soup', fromVariantId: 10, who: 'chef' });
    expect([r5.unchanged, JSON.stringify(t) === before], [true, true], 'F5 a case / spacing change is not a rename -> nothing written');
  }
  {
    // Renames behave exactly as relinkRenamedRow (an unlinked row renamed goes to the NEW name's dish).
    const t = base(); const db = fakeDb(t);
    const r = await relinkOnEdit({ db, rowId: 5, oldName: 'shakshuka', newName: 'Lentil Soup', fromVariantId: null, who: 'chef' });
    expect([r.moved, r.via, r.variantId, vOf(t, 5)], [true, 'rename', 10, 10], 'F6 unlinked and renamed -> the new name\'s dish (rename rule)');
    const t2 = base(); const db2 = fakeDb(t2);
    const ref = await relinkRenamedRow({ db: db2, rowId: 1, oldName: 'Lentil Soup', newName: 'Shakshuka', fromVariantId: 10, who: 'chef' });
    const t3 = base(); const db3 = fakeDb(t3);
    const got = await relinkOnEdit({ db: db3, rowId: 1, oldName: 'Lentil Soup', newName: 'Shakshuka', fromVariantId: 10, who: 'chef' });
    expect([got.moved, got.outcome, got.via, JSON.stringify(t3)], [ref.moved, ref.outcome, 'rename', JSON.stringify(t2)], 'F7 a linked row renamed: the same writes as relinkRenamedRow');
  }
  {
    // Linked by someone else meanwhile: kept, nothing new left behind.
    const t = base(); const db = fakeDb(t, { beforeUpdate: (tt) => { tt.menu_items.find((r) => r.id === 4).dish_variant_id = 21; } });
    const r = await relinkOnEdit({ db, rowId: 4, oldName: 'Shakshuka', newName: 'Shakshuka', fromVariantId: null, who: 'chef' });
    expect([r.moved, r.already, vOf(t, 4), t.master_items.length, t.dish_variants.length], [false, true, 21, 3, 3], 'F8 linked meanwhile -> kept, the unused new dish removed');
    // A failure throws; the row stays saved and unlinked, nothing new left behind.
    const t2 = base(); const db2 = fakeDb(t2, { failOn: 'menu_items.update' });
    let threw = false;
    try { await relinkOnEdit({ db: db2, rowId: 4, oldName: 'Shakshuka', newName: 'Shakshuka', fromVariantId: null, who: 'chef' }); } catch { threw = true; }
    expect([threw, vOf(t2, 4), t2.master_items.length, t2.dish_variants.length], [true, null, 3, 3], 'F9 link fails -> throws, row unlinked, nothing left behind');
  }

  // E. random catalogs (HIGH bits of the LCG -- the low bits repeat)
  let seed = 61004;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const NAMES = ['Lentil Soup', 'lentil soup', 'Shakshuka', 'Fattoush', 'Kabsa', 'Mujaddara', 'Maqluba', 'Chicken Alfredo', ' kabsa '];
  let bad = 0;
  for (let k = 0; k < 2000; k++) {
    const t = { master_items: [], dish_variants: [], menu_items: [] };
    let vid = 1;
    const keys = [...new Set(NAMES.map(nameKey))];
    keys.forEach((kk, i) => { if (rnd(2)) { t.master_items.push({ id: i + 1, name: kk, name_key: kk }); for (let j = rnd(3); j > 0; j--) t.dish_variants.push({ id: vid++, master_item_id: i + 1 }); } });
    const n = 1 + rnd(10);
    for (let i = 1; i <= n; i++) {
      const name = NAMES[rnd(NAMES.length)];
      const m = t.master_items.find((x) => x.name_key === nameKey(name));
      const vs = m ? t.dish_variants.filter((v) => v.master_item_id === m.id) : [];
      t.menu_items.push({ id: i, name, category_id: rnd(4), calories_per_100g: rnd(3) ? 100 + i : null, dish_variant_id: vs.length && rnd(3) === 0 ? vs[rnd(vs.length)].id : null });
    }
    const perMaster = new Map();
    for (const v of t.dish_variants) perMaster.set(v.master_item_id, (perMaster.get(v.master_item_id) || 0) + 1);
    const predicted = planLinks(t.menu_items.filter((r) => r.dish_variant_id == null), new Map(t.master_items.map((m) => [m.name_key, perMaster.get(m.id) || 0])));
    const snap = t.menu_items.map(({ dish_variant_id, ...rest }) => rest);
    const linkedBefore = new Map(t.menu_items.filter((r) => r.dish_variant_id != null).map((r) => [r.id, r.dish_variant_id]));
    const db = fakeDb(t);
    for (const p of predicted) {
      const r = await linkNewRow({ db, rowId: p.id, name: p.name, who: 'x' });
      if (r.outcome !== p.outcome) bad++;
    }
    if (JSON.stringify(t.menu_items.map(({ dish_variant_id, ...rest }) => rest)) !== JSON.stringify(snap)) bad++;
    for (const r of t.menu_items) {
      if (r.dish_variant_id == null) { bad++; continue; }
      if (linkedBefore.has(r.id) && linkedBefore.get(r.id) !== r.dish_variant_id) bad++;
      const m = t.master_items.find((x) => x.id === masterOfV(t, r.dish_variant_id));
      if (!m || m.name_key !== nameKey(r.name)) bad++;
    }
    if (new Set(t.master_items.map((m) => m.name_key)).size !== t.master_items.length) bad++;
  }
  expect(bad, 0, 'E random catalogs');

  if (failures.length) { console.error(`Variant links FAILED:\n  ${failures.join('\n  ')}`); process.exit(1); }
  console.log(`Variant links OK (${count} checks, incl. 2,000 random catalogs).`);
})();
