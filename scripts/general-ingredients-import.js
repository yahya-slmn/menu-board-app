#!/usr/bin/env node
// General Ingredients: the one-off import of the kitchen_ingredients Excel file into public.general_ingredients
// (migration 20261006110000 must be applied first). A separate reference list -- nothing else in the app reads it.
//
//   cd ~/menu-board && node scripts/general-ingredients-import.js [backups/kitchen-ingredients.xlsx]
//
// 1. asks for your login (run it in a normal Terminal window);
// 2. reads both sheets: "Items" (one row per ingredient) and "Department use" (item -> department pairs, which become
//    each row's `departments` list);
// 3. PREVIEW, nothing written yet: new / already in the table / skipped with the reason, plus every row whose
//    primary_department is not one of the kitchen's departments (the bread-type values -- imported as they are). The full
//    list goes to backups/general-ingredients-import-preview-<date-time>.txt;
// 4. writes only after you type IMPORT: the new rows, 200 at a time. Exact name matching (case and spacing aside); a row
//    already in the table is never changed, so running it again adds only what is missing.
// Then run scripts/general-ingredients-verify.js.
const fs = require('fs');
const { readKitchenWorkbook, planImport, applyImport, KITCHEN_DEPARTMENTS, BATCH_SIZE } = require('../lib/generalIngredients');
const { supabase, ask, signIn, fetchTable, filePathFromArgs, stamp, backupsPath } = require('./general-ingredients-common');

(async () => {
  const filePath = filePathFromArgs();
  const who = await signIn();

  const file = await readKitchenWorkbook(filePath);
  if (file.problems.length) { console.error(`Can't read ${filePath}:\n  ${file.problems.join('\n  ')}`); process.exit(1); }
  const existing = await fetchTable();
  const plan = planImport(file, existing);

  const L = [];
  const P = (s = '') => L.push(s);
  P(`General Ingredients import -- PREVIEW (nothing written) -- ${new Date().toLocaleString()}`);
  P(`File: ${filePath}`);
  P(`Items sheet: ${plan.fileItemCount} rows; Department use sheet: ${plan.departmentPairCount} pairs`);
  P(`Table now: ${existing.length} rows`);
  P('');
  P(`New (will be added):            ${plan.toInsert.length}  (${plan.toInsert.reduce((n, it) => n + it.departments.length, 0)} department pairs)`);
  P(`Already in the table (kept):    ${plan.present.length}`);
  P(`Skipped:                        ${plan.skipped.length}`);
  P(`Department pairs not used:      ${plan.pairNotes.length}`);
  P('');
  if (plan.skipped.length) {
    P('Skipped rows (row of the Items sheet):');
    plan.skipped.forEach((s) => P(`  row ${s.rowNumber}  ${s.item_code || '(no code)'}  ${s.name || '(no name)'} -- ${s.reason}`));
    P('');
  }
  if (plan.pairNotes.length) {
    P('Department pairs not used (row of the Department use sheet):');
    plan.pairNotes.forEach((p) => P(`  row ${p.rowNumber}  ${p.item_code || '(no code)'}  ${p.name || ''} -> ${p.department || '(blank)'} -- ${p.reason}`));
    P('');
  }
  const presentOtherCode = plan.present.filter((p) => !p.sameCode);
  if (presentOtherCode.length) {
    P('Already in the table under ANOTHER item_code (kept as they are):');
    presentOtherCode.forEach((p) => P(`  ${p.item.name}: file ${p.item.item_code}, table ${p.row.item_code}`));
    P('');
  }
  if (plan.withoutDepartments.length) P(`Items with no department pair: ${plan.withoutDepartments.length} (${plan.withoutDepartments.slice(0, 10).map((i) => i.name).join(', ')}${plan.withoutDepartments.length > 10 ? ' ...' : ''})`);
  if (plan.primaryNotInDepartments.length) P(`Items whose primary_department is not among their departments: ${plan.primaryNotInDepartments.length}`);

  const counts = {};
  plan.breadType.forEach((it) => { counts[it.primary_department] = (counts[it.primary_department] || 0) + 1; });
  P(`primary_department values that are not a kitchen department (${KITCHEN_DEPARTMENTS.join(', ')}):`);
  P(`  ${plan.breadType.length} rows, ${Object.keys(counts).length} different values -- imported AS THEY ARE; ${plan.otherDeptPairs} department pairs use such values too.`);
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([v, n]) => P(`  "${v}" (${n}): ${plan.breadType.filter((it) => it.primary_department === v).map((it) => `${it.item_code} ${it.name}`).join('; ')}`));

  const previewPath = backupsPath(`general-ingredients-import-preview-${stamp()}.txt`);
  fs.writeFileSync(previewPath, `${L.join('\n')}\n`);
  console.log(`\n${L.slice(0, 11).join('\n')}`);
  console.log(`Bread-type primary_department values: ${plan.breadType.length} rows (listed in the preview file)`);
  console.log(`\nFull preview: ${previewPath}`);

  if (!plan.toInsert.length) { console.log('\nNothing to add: the table already has every item of the file.'); process.exit(0); }
  const answer = (await ask(`\nType IMPORT to add ${plan.toInsert.length} rows to general_ingredients (anything else cancels): `)).trim();
  if (answer !== 'IMPORT') { console.log('Cancelled. Nothing was written.'); process.exit(0); }

  const result = await applyImport({
    db: supabase, plan, who,
    onProgress: (done, total) => process.stdout.write(`\r  ${done} / ${total}`),
  });
  process.stdout.write('\n');
  const R = [];
  R.push(`General Ingredients import -- RESULT -- ${new Date().toLocaleString()} (by ${who}, batches of ${BATCH_SIZE})`);
  R.push(`Planned: ${result.planned}; added: ${result.inserted}; already there by then (left as they were): ${result.alreadyThere}; failed: ${result.failed.length}`);
  result.failed.forEach((f) => R.push(`  FAILED ${f.item_code} ${f.name}: ${f.error}`));
  const after = await fetchTable();
  R.push(`Table now: ${after.length} rows (file: ${plan.fileItemCount} items).`);
  R.push(result.failed.length ? 'Some rows failed: run the import again (it adds only what is missing), then the verify.'
    : 'Now run: node scripts/general-ingredients-verify.js');
  const resultPath = previewPath.replace('-preview-', '-result-');
  fs.writeFileSync(resultPath, `${R.join('\n')}\n`);
  console.log(`\n${R.join('\n')}\nSaved: ${resultPath}`);
  process.exit(result.failed.length ? 1 : 0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
