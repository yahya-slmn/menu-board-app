#!/usr/bin/env node
// General Ingredients -- READ-ONLY check of public.general_ingredients against the kitchen_ingredients Excel file.
// Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/general-ingredients-verify.js [backups/kitchen-ingredients.xlsx]
//
// PASS when: the table has exactly the file's items (same count, matched by exact name, case and spacing aside), none
// missing, none extra, no name twice, every field equal (item_code, Arabic name, parent, category, form,
// primary_department, item_type, storage, typical_uom), and each item's departments = its pairs on the "Department use"
// sheet (as a set; same total number of pairs). Asks for your login. Writes backups/general-ingredients-verify-<date-time>.txt.
const fs = require('fs');
const { readKitchenWorkbook, planImport, compareTableToFile } = require('../lib/generalIngredients');
const { signIn, fetchTable, filePathFromArgs, stamp, backupsPath } = require('./general-ingredients-common');

(async () => {
  const filePath = filePathFromArgs();
  await signIn();
  const file = await readKitchenWorkbook(filePath);
  if (file.problems.length) { console.error(`Can't read ${filePath}:\n  ${file.problems.join('\n  ')}`); process.exit(1); }
  const table = await fetchTable();
  const plan = planImport(file, []); // the file on its own: every item it would import
  const c = compareTableToFile(plan, table);

  const L = [];
  const P = (s = '') => L.push(s);
  P(`General Ingredients verify (read-only) -- ${new Date().toLocaleString()}`);
  P(`File: ${filePath}`);
  P(`File items: ${c.fileItems}${plan.skipped.length ? ` (${plan.skipped.length} rows of the file can't be imported: ${plan.skipped.map((s) => `row ${s.rowNumber} ${s.reason}`).join('; ')})` : ''}`);
  P(`Table rows: ${c.tableRows}`);
  P(`Department pairs: file ${c.pairsInFile}, table ${c.pairsInTable}`);
  P('');
  P(`Missing from the table: ${c.missing.length}`);
  c.missing.slice(0, 50).forEach((it) => P(`  ${it.item_code} ${it.name}`));
  P(`In the table but not in the file: ${c.extra.length}`);
  c.extra.slice(0, 50).forEach((r) => P(`  #${r.id} ${r.item_code} ${r.name}`));
  P(`Same name twice in the table: ${c.duplicateKeys.length}`);
  c.duplicateKeys.slice(0, 50).forEach((r) => P(`  #${r.id} ${r.item_code} ${r.name}`));
  P(`Different from the file: ${c.differs.length}`);
  c.differs.slice(0, 50).forEach((d) => P(`  ${d.item.item_code} ${d.item.name}: ${d.fields.map((f) => `${f} table "${[].concat(d.row[f] ?? '').join(', ')}" / file "${[].concat(d.item[f] ?? '').join(', ')}"`).join('; ')}`));
  const noCreator = table.filter((r) => !r.created_by).length;
  P(`Rows without created_by: ${noCreator}`);
  P('');
  P(c.pass ? 'PASS -- the table matches the file.' : 'FAIL -- see above.');

  const outPath = backupsPath(`general-ingredients-verify-${stamp()}.txt`);
  fs.writeFileSync(outPath, `${L.join('\n')}\n`);
  console.log(`\n${L.join('\n')}\n\nSaved: ${outPath}`);
  process.exit(c.pass ? 0 : 1);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
