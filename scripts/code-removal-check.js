#!/usr/bin/env node
// Remove the old dish codes (lib/codeRemoval.js, unification phase U1), checked on its own (npm test):
//   A. planCodeRemoval: every dish with something in rc_code, grouped (RC codes / the "NEW" placeholder / other); blank
//      and whitespace-only codes are not dishes to clear.
//   B. applyCodeRemoval against a stand-in database: only dishes whose code is still the previewed one are cleared;
//      one that changed since the preview is reported, not cleared; one history row per dish cleared, one batch id;
//      chunking does not lose or repeat a dish.
// No login, no Supabase.
const { planCodeRemoval, applyCodeRemoval } = require('../lib/codeRemoval');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

const items = [
  { id: 1, name: 'Cheese Croissant', category_name: 'AM Snack', sections: ['Daycare'], rc_code: 'RC-00237' },
  { id: 2, name: 'Plain Milk', category_name: 'Milk', sections: ['KG-LP'], rc_code: 'NEW' },
  { id: 3, name: 'Fruit Bar', category_name: 'Fruit Bar', sections: ['KG-LP'], rc_code: 'new ' },
  { id: 4, name: 'Lentil Soup', category_name: 'Soup', sections: ['MS-UP'], rc_code: null },
  { id: 5, name: 'Kabsa', category_name: 'Lunch Main', sections: ['Staff'], rc_code: '   ' },
  { id: 6, name: 'Odd Dish', category_name: 'Lunch Main', sections: ['Staff'], rc_code: 'X-12' },
  { id: 7, name: 'Kofta', category_name: 'Lunch Main', sections: ['KG-LP'], rc_code: 'RC01-02288' },
];
const plan = planCodeRemoval(items);
expect(plan.entries.map((e) => e.id), [1, 2, 3, 6, 7], 'dishes with a code (blank / spaces-only left alone)');
expect([plan.groups.codes.map((e) => e.id), plan.groups.placeholder.map((e) => e.id), plan.groups.other.map((e) => e.id)], [[1, 7], [2, 3], [6]], 'grouped: RC codes / "NEW" / other');
expect(plan.entries.find((e) => e.id === 3).oldCode, 'new ', 'the stored value is kept exactly (the guard compares it as stored)');

function fakeDb(rows, { failCode = null, failHistory = false } = {}) {
  const db = { rows, history: [], calls: 0 };
  db.from = (table) => {
    const st = { filters: [] };
    const chain = {
      update(v) { st.op = 'update'; st.v = v; return chain; },
      insert(v) { st.op = 'insert'; st.v = v; return chain; },
      in(col, vals) { st.filters.push((r) => vals.includes(r[col])); return chain; },
      eq(col, val) { st.eq = val; st.filters.push((r) => r[col] === val); return chain; },
      select() { return chain; },
      then(resolve) {
        db.calls++;
        if (st.op === 'insert') {
          if (failHistory) return resolve({ error: { message: 'history down' } });
          db.history.push(...st.v); return resolve({ error: null });
        }
        if (failCode !== null && st.eq === failCode) return resolve({ data: null, error: { message: 'network' } });
        const hit = rows.filter((r) => st.filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, st.v));
        return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      },
    };
    return chain;
  };
  return db;
}

(async () => {
  // Dish 7's code was changed by someone after the preview.
  const live = items.map((i) => ({ ...i }));
  live.find((i) => i.id === 7).rc_code = 'RC-99999';
  const db = fakeDb(live);
  const r = await applyCodeRemoval({ db, entries: plan.entries, who: 'tetiana', batchId: 'b1', chunkSize: 1 });
  expect(r.removed, [1, 2, 3, 6], 'cleared: the dishes still holding the previewed code');
  expect(r.changed, [{ id: 7, name: 'Kofta' }], 'a code changed since the preview is reported');
  expect(live.find((i) => i.id === 7).rc_code, 'RC-99999', '...and not cleared');
  expect(live.filter((i) => [1, 2, 3, 6].includes(i.id)).map((i) => i.rc_code), [null, null, null, null], 'the cleared codes are gone');
  expect([live.find((i) => i.id === 4).rc_code, live.find((i) => i.id === 5).rc_code], [null, '   '], 'dishes not in the plan are untouched');
  expect(db.history.map((h) => [h.item_id, h.old_code, h.new_code, h.reason, h.batch_id, h.changed_by]).sort((a, b) => a[0] - b[0]),
    [[1, 'RC-00237', null, 'rc_removal', 'b1', 'tetiana'], [2, 'NEW', null, 'rc_removal', 'b1', 'tetiana'], [3, 'new ', null, 'rc_removal', 'b1', 'tetiana'], [6, 'X-12', null, 'rc_removal', 'b1', 'tetiana']],
    'one history row per cleared dish, with its old code, one batch');
  expect(db.history.find((h) => h.item_id === 1).item_name, 'Cheese Croissant', 'the history keeps the dish name');

  // 450 dishes with "NEW", chunks of 200 -> 3 requests, each dish once.
  const many = Array.from({ length: 450 }, (_, i) => ({ id: 100 + i, name: `D${i}`, rc_code: 'NEW' }));
  const db2 = fakeDb(many.map((m) => ({ ...m })));
  const r2 = await applyCodeRemoval({ db: db2, entries: planCodeRemoval(many).entries, who: 'x', batchId: 'b2' });
  expect([r2.removed.length, new Set(r2.removed).size, db2.history.length, db2.calls], [450, 450, 450, 4], 'chunked: 3 updates + 1 history insert, every dish exactly once');

  // A failed chunk is reported and nothing of it is written to history; a history failure is reported.
  const db3 = fakeDb(items.map((i) => ({ ...i })), { failCode: 'NEW' });
  const r3 = await applyCodeRemoval({ db: db3, entries: plan.entries, who: 'x', batchId: 'b3' });
  expect([r3.failed.map((f) => f.ids), r3.removed, db3.history.map((h) => h.item_id).sort()], [[[2]], [1, 3, 6, 7], [1, 3, 6, 7]], 'a failed chunk is reported, not in the history');
  const db4 = fakeDb(items.map((i) => ({ ...i })), { failHistory: true });
  const r4 = await applyCodeRemoval({ db: db4, entries: plan.entries, who: 'x', batchId: 'b4' });
  expect([r4.removed.length, r4.historyError], [5, 'history down'], 'a history failure is reported');
  expect(r4.history.length, 5, 'and the unwritten history rows are handed back to be saved elsewhere');

  if (failures.length) {
    console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Old code removal OK (${count} checks).`);
})();
