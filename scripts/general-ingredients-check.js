// General Ingredients import (lib/generalIngredients.js) -- no login, nothing written anywhere.
//   A. reading both sheets by header name; B. the plan (new / present / skipped with reasons, department pairs, bread-type
//   values); C. the write against a fake table that enforces the real unique keys (name_key, item_code): batches, re-run
//   adds nothing, a name / code added meanwhile; D. the verify comparison; E. the real file, if backups/ has it (read-only).
//   node scripts/general-ingredients-check.js
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const g = require('../lib/generalIngredients');

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function workbook(items, pairs, { itemsHeader = g.ITEM_COLUMNS, pairsSheet = 'Department use' } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Items');
  ws.addRow(itemsHeader);
  items.forEach((r) => ws.addRow(itemsHeader.map((c) => r[c] ?? null)));
  const ps = wb.addWorksheet(pairsSheet);
  ps.addRow(['item_code', 'name', 'department']);
  pairs.forEach((p) => ps.addRow(p));
  return g.readKitchenWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
}
const item = (code, name, extra = {}) => ({ item_code: code, name, name_ar: `ع ${name}`, category: 'vegetable', form: 'fresh',
  primary_department: 'Vegetables', item_type: 'commodity', storage: 'chill', typical_uom: 'kg', ...extra });

// A fake general_ingredients: name_key worked out like the generated column; unique name_key and item_code.
function fakeDb(initial = []) {
  const rows = [];
  let nextId = 1;
  const calls = [];
  const add = (r) => rows.push({ id: nextId++, ...r, name_key: g.nameKey(r.name) });
  initial.forEach(add);
  return {
    rows, calls,
    from(table) {
      if (table !== 'general_ingredients') throw new Error(`unexpected table ${table}`);
      return {
        upsert(chunk, opts) {
          calls.push({ size: chunk.length, opts });
          return {
            select: async () => {
              if (opts.onConflict !== 'name_key' || !opts.ignoreDuplicates) return { data: null, error: { message: 'bad options' } };
              // Like Postgres: the whole statement fails on another unique key; nothing of it is kept.
              const keys = new Set(rows.map((r) => r.name_key));
              const codes = new Set(rows.map((r) => r.item_code));
              const take = [];
              for (const r of chunk) {
                const k = g.nameKey(r.name);
                if (keys.has(k)) continue; // on conflict (name_key) do nothing
                if (codes.has(r.item_code)) return { data: null, error: { message: `duplicate key value violates unique constraint "general_ingredients_item_code_key"` } };
                keys.add(k); codes.add(r.item_code); take.push(r);
              }
              const before = rows.length;
              take.forEach(add);
              return { data: rows.slice(before).map((r) => ({ id: r.id })), error: null };
            },
          };
        },
      };
    },
  };
}

(async () => {
  // ---- A + B: reading and planning
  const file = await workbook([
    item('ING-1', 'salt'),
    item('ING-2', 'deglet noor date', { parent_name: 'date', primary_department: 'Fruit' }),
    item('ING-3', ''),                                   // no name
    item('ING-1', 'pepper'),                             // code used above
    item('ING-4', '  Deglet   NOOR date '),              // same name, case / spacing aside
    item('ING-5', 'khubz', { primary_department: 'khubz', category: 'bread' }),
    item(null, 'orphan'),                                // no code
    item('ING-6', 'تمر'),
  ], [
    ['ING-1', 'salt', 'Hot kitchen'], ['ING-1', 'salt', 'Cold kitchen'], ['ING-1', 'salt', 'Hot kitchen'], // listed twice
    ['ING-2', 'deglet noor date', 'Fruit'], ['ING-2', 'deglet noor date', 'Pastry'],
    ['ING-5', 'khubz', 'khubz'], ['ING-5', 'khubz', 'Bakery'],
    ['ING-9', 'ghost', 'Bakery'],                        // not on the Items sheet
    ['ING-6', 'something else', 'Fruit'],                // name differs
    ['ING-6', 'تمر', null],                              // no department
    ['ING-4', 'deglet noor date', 'Fruit'],              // its item is skipped
  ]);
  check('A1 both sheets read, no problems', !file.problems.length && file.items.length === 8 && file.departmentPairs.length === 11, JSON.stringify(file.problems));
  const missingCol = await workbook([item('ING-1', 'salt')], [], { itemsHeader: g.ITEM_COLUMNS.filter((c) => c !== 'storage') });
  check('A2 a missing column is a problem, not a guess', missingCol.problems.some((p) => /storage/.test(p)));
  const missingSheet = await workbook([item('ING-1', 'salt')], [], { pairsSheet: 'Other' });
  check('A3 a missing sheet is a problem', missingSheet.problems.some((p) => /Department use/.test(p)));

  const plan = g.planImport(file, []);
  check('B1 new = the valid, distinct items', eq(plan.toInsert.map((i) => i.item_code), ['ING-1', 'ING-2', 'ING-5', 'ING-6']), JSON.stringify(plan.toInsert.map((i) => i.item_code)));
  const reasons = plan.skipped.map((s) => `${s.rowNumber}:${s.reason}`);
  check('B2 skipped with reasons, in file order', eq(reasons, ['4:no name', '5:item_code ING-1 already used on row 2 of the file',
    '6:same name as row 3 of the file ("deglet noor date")', '8:no item_code']), JSON.stringify(reasons));
  check('B3 departments in the file\'s order, each once', eq(plan.toInsert.map((i) => i.departments),
    [['Hot kitchen', 'Cold kitchen'], ['Fruit', 'Pastry'], ['khubz', 'Bakery'], []]), JSON.stringify(plan.toInsert.map((i) => i.departments)));
  check('B4 unused pairs with reasons', eq(plan.pairNotes.map((p) => p.reason).sort(), ['item_code not on the Items sheet', 'its item is skipped',
    'listed twice', 'name differs from the Items sheet ("تمر")', 'no department'].sort()), JSON.stringify(plan.pairNotes.map((p) => p.reason)));
  check('B5 bread-type primary_department listed, imported as is', eq(plan.breadType.map((i) => i.name), ['khubz'])
    && plan.toInsert.find((i) => i.name === 'khubz').primary_department === 'khubz' && plan.otherDeptPairs === 1);
  check('B6 item with no department pair reported', eq(plan.withoutDepartments.map((i) => i.name), ['تمر']));
  check('B7 row values carried as they are (Arabic name, parent)', eq(g.toRow(plan.toInsert[1], 'chef'), {
    item_code: 'ING-2', name: 'deglet noor date', name_ar: 'ع deglet noor date', parent_name: 'date', category: 'vegetable', form: 'fresh',
    primary_department: 'Fruit', item_type: 'commodity', storage: 'chill', typical_uom: 'kg', departments: ['Fruit', 'Pastry'], created_by: 'chef' }));
  check('B8 nameKey = the table\'s rule (trim, whitespace runs, lowercase)', g.nameKey(' Deglet\t\tNOOR  Date ') === 'deglet noor date' && g.nameKey('تمر ') === 'تمر');

  // Against a table that already has some
  const plan2 = g.planImport(file, [{ id: 7, item_code: 'ING-1', name: 'SALT', name_key: 'salt' }, { id: 8, item_code: 'ING-6', name: 'something', name_key: 'something' },
    { id: 9, item_code: 'ING-77', name: 'deglet noor date', name_key: 'deglet noor date' }]);
  check('B9 exact name (case aside) = already present, never re-added', eq(plan2.present.map((p) => [p.item.item_code, p.sameCode]), [['ING-1', true], ['ING-2', false]]));
  check('B10 a code the table holds under another name is skipped', plan2.skipped.some((s) => s.item_code === 'ING-6' && /already in the table for "something"/.test(s.reason))
    && eq(plan2.toInsert.map((i) => i.item_code), ['ING-5']));

  // ---- C: writing
  const db = fakeDb();
  const r1 = await g.applyImport({ db, plan, who: 'chef', batchSize: 3 });
  check('C1 all new rows added, in batches', r1.inserted === 4 && r1.alreadyThere === 0 && !r1.failed.length && eq(db.calls.map((c) => c.size), [3, 1]), JSON.stringify({ r1, calls: db.calls }));
  check('C2 created_by and departments written', db.rows.every((r) => r.created_by === 'chef') && eq(db.rows.find((r) => r.name === 'salt').departments, ['Hot kitchen', 'Cold kitchen']));
  const again = g.planImport(file, db.rows);
  check('C3 re-run: nothing new, all present', again.toInsert.length === 0 && again.present.length === 4);
  const r2 = await g.applyImport({ db, plan, who: 'chef', batchSize: 3 }); // even with the OLD plan
  check('C4 re-running an old plan adds nothing and changes nothing', r2.inserted === 0 && r2.alreadyThere === 4 && db.rows.length === 4);

  const db3 = fakeDb([{ item_code: 'ING-50', name: 'Deglet Noor Date' }, { item_code: 'ING-5', name: 'flatbread' }]);
  const r3 = await g.applyImport({ db: db3, plan, who: 'chef', batchSize: 10 }); // both added meanwhile, after the preview
  check('C5 a name added meanwhile is left alone; a code clash fails only that row', r3.inserted === 2 && r3.alreadyThere === 1
    && eq(r3.failed.map((f) => f.item_code), ['ING-5']) && db3.rows.find((r) => r.name_key === 'deglet noor date').item_code === 'ING-50', JSON.stringify(r3));

  // ---- D: verify
  const fullPlan = g.planImport(file, []);
  check('D1 the imported table PASSES', g.compareTableToFile(fullPlan, db.rows).pass);
  const changed = db.rows.map((r) => ({ ...r, departments: [...r.departments] }));
  changed[0].storage = 'dry'; changed[1].departments = ['Fruit'];
  const cd = g.compareTableToFile(fullPlan, changed);
  check('D2 a changed field and a changed department list are reported', !cd.pass && eq(cd.differs.map((d) => d.fields), [['storage'], ['departments']]), JSON.stringify(cd.differs.map((d) => d.fields)));
  const cm = g.compareTableToFile(fullPlan, [...db.rows.slice(1), { id: 99, item_code: 'ING-99', name: 'extra', name_key: 'extra', departments: [] }]);
  check('D3 a missing row and an extra row are reported', !cm.pass && cm.missing.length === 1 && cm.extra.length === 1);
  const cdup = g.compareTableToFile(fullPlan, [...db.rows, { ...db.rows[0], id: 100 }]);
  check('D4 a name twice is reported', !cdup.pass && cdup.duplicateKeys.length === 1);
  const reordered = db.rows.map((r) => ({ ...r, departments: [...r.departments].reverse() }));
  check('D5 departments compared as a set (order aside)', g.compareTableToFile(fullPlan, reordered).pass);

  // ---- E: the real file (read-only), when it is in backups/
  const real = path.join(__dirname, '..', 'backups', 'kitchen-ingredients.xlsx');
  if (fs.existsSync(real)) {
    const rf = await g.readKitchenWorkbook(real);
    const rp = g.planImport(rf, []);
    check('E1 real file: 2,156 items, all new, none skipped', !rf.problems.length && rp.fileItemCount === 2156 && rp.toInsert.length === 2156 && !rp.skipped.length);
    check('E2 real file: every one of 7,431 department pairs used', rp.departmentPairCount === 7431 && !rp.pairNotes.length
      && rp.toInsert.reduce((n, i) => n + i.departments.length, 0) === 7431 && !rp.withoutDepartments.length && !rp.primaryNotInDepartments.length);
    check('E3 real file: 99 rows with bread-type primary_department (50 values)', rp.breadType.length === 99 && new Set(rp.breadType.map((i) => i.primary_department)).size === 50);
    const rdb = fakeDb();
    await g.applyImport({ db: rdb, plan: rp, who: 't' });
    check('E4 real file through the fake table: PASS, 11 batches of up to 200', g.compareTableToFile(rp, rdb.rows).pass && rdb.calls.length === 11);
  } else {
    console.log('(E skipped: backups/kitchen-ingredients.xlsx is not here)');
  }

  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed` : `General Ingredients import OK (${passes} checks).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
