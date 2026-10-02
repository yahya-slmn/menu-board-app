#!/usr/bin/env node
// Dish Catalog ingredients, M3 real-data check -- READ-ONLY, no AI calls: what a Menu Ingredients upload of real menu
// files would take from the Dish Catalog's SAVED lists, exactly as the app does it (lib/menuIngredientsCatalog.js
// splitRowsByCatalog + annotateRow), and whether every one of those rows is safe for its own section. Nothing is
// written to Supabase.
//
//   cd ~/menu-board && node scripts/catalog-ingredients-reuse-check.js ~/Downloads/tetiana/"September week_04.xlsx" [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Needs at least one saved list (an M2 save from Menu
// Ingredients -> "Save approved lists to the Dish Catalog..."); it stops and says so when there is none.
// Checks, per row served from the catalog: the list shown is the saved list after THIS row's section's rules, and
// running the rules again on it removes nothing (no nut / sesame, spicy, halal or -- on a student row -- seafood term
// left). Report (default): backups/catalog-ingredients-reuse-check-<date>.txt
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryById, getCategories, getCategoryByCode } = require('../lib/referenceData');
const { SECTION_SLOTS } = require('../lib/generator');
const { loadWorkbookFromBuffer, parseWorkbookDishes } = require('../lib/menuIngredients');
const { splitRowsByCatalog, annotateRow } = require('../lib/menuIngredientsCatalog');
const { dishesForSuggestion, rowSeafoodAllowed } = require('../lib/menuIngredientsRequest');
const { filterMenuIngredients } = require('../lib/menuIngredientFilters');
const { rowKey } = require('../lib/menuIngredientsShare');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const inputs = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1)).map((a) => a.replace(/^~(?=$|\/)/, os.homedir()));
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `catalog-ingredients-reuse-check-${new Date().toISOString().slice(0, 10)}.txt`);
if (!inputs.length) { console.error('Usage: node scripts/catalog-ingredients-reuse-check.js <menu.xlsx> [...] [--out report.txt]'); process.exit(2); }

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
function loginDomain() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  return src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/)[1];
}
const schoolVocabulary = () => [...new Set(['DAYCARE', 'KG_LP', 'MS_UP'].flatMap((s) => SECTION_SLOTS[s].map(([c]) => c)))].map((c) => getCategoryByCode(c)?.name).filter(Boolean);

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  // The catalog as the app's upload reads it (main.js loadCatalogForIngredients).
  const items = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('menu_items')
      .select('id, name, category_id, is_active, ingredients_text, allergens_text, ingredients_updated_at, ingredients_updated_by, ingredients_source')
      .order('id').range(from, from + 999);
    if (error) {
      if (/ingredients_text/.test(error.message || '')) { console.error('The Dish Catalog ingredients migration (20261002100000) is not applied yet.'); process.exit(1); }
      throw error;
    }
    items.push(...data);
    if (data.length < 1000) break;
  }
  if (!items.length) throw new Error('The catalog came back empty -- is the login right? (RLS returns no rows when signed out.)');
  const catalog = items.map((it) => ({ ...it, category_code: getCategoryById(it.category_id)?.code }));
  const withLists = catalog.filter((it) => String(it.ingredients_text || '').trim());
  if (!withLists.length) {
    console.log('No dish in the Dish Catalog has a saved list yet. Do an M2 save first: Menu Ingredients -> "Save approved lists to the Dish Catalog...".');
    process.exit(0);
  }
  const categories = getCategories().map((c) => ({ code: c.code, name: c.name }));

  const files = [];
  for (let i = 0; i < inputs.length; i++) {
    const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(inputs[i]));
    const { rows } = await parseWorkbookDishes(workbook, schoolVocabulary());
    files.push({ fileIndex: i, fileName: path.basename(inputs[i]), rows });
  }
  const allRows = files.flatMap((f) => f.rows);
  const { fromCatalog, aiRows } = splitRowsByCatalog({ files: files.map((f) => ({ fileIndex: f.fileIndex, rows: f.rows })), catalog, categories });

  const lines = [
    `Dish Catalog ingredients -- M3 real-data check, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only, no AI calls)`,
    `Files: ${files.map((f) => f.fileName).join(', ')} -- ${allRows.length} rows`,
    `Catalog: ${catalog.length} dishes, ${withLists.length} with a saved list: ${withLists.map((it) => `#${it.id} ${it.name} (${it.ingredients_updated_by || '?'}, ${String(it.ingredients_updated_at || '').slice(0, 10)})`).join('; ')}`,
    '',
    `AI calls (one per dish name): without the catalog ${dishesForSuggestion(allRows).length} -> with it ${dishesForSuggestion(aiRows).length}`,
    `Rows from the Dish Catalog: ${fromCatalog.size}`,
    '',
  ];
  let problems = 0;
  for (const f of files) {
    for (const r of f.rows) {
      const item = fromCatalog.get(rowKey({ ...r, fileIndex: f.fileIndex }));
      if (!item) continue;
      const row = annotateRow(r, f.fileIndex, { answers: new Map(), catalogItem: item });
      const seafoodAllowed = rowSeafoodAllowed(r);
      const independent = filterMenuIngredients({ ingredients: item.ingredients_text, allergens: item.allergens_text || '' }, { seafoodAllowed });
      const again = filterMenuIngredients({ ingredients: row.ingredients, allergens: row.allergens }, { seafoodAllowed });
      const issues = [];
      if (independent.ingredients !== row.ingredients || independent.allergens !== row.allergens) issues.push('shown list differs from the saved list under this section\'s rules');
      if (again.removed.length || again.removedAllergens.length) issues.push(`a forbidden term is left: ${[...again.removed, ...again.removedAllergens].map((x) => x.segment).join(', ')}`);
      if (!row.catalog || row.catalog.itemId !== item.id) issues.push('not marked as from the Dish Catalog');
      problems += issues.length ? 1 : 0;
      lines.push(`${issues.length ? 'PROBLEM' : 'ok     '} ${r.sheetName} ${r.weekday} ${r.date} | ${r.category} | ${r.dishName} -> #${item.id}${item.is_active === 0 ? ' (inactive)' : ''}`);
      lines.push(`          saved:  ${item.ingredients_text}${item.allergens_text ? ` | allergens: ${item.allergens_text}` : ''}`);
      if (row.ingredients !== item.ingredients_text) lines.push(`          shown:  ${row.ingredients}`);
      if (row.removedTerms.length) lines.push(`          removed for this section: ${row.removedTerms.map((t) => `${t.segment} (${t.policy})`).join(', ')}`);
      for (const i of issues) lines.push(`          !! ${i}`);
    }
  }
  lines.push('', problems ? `${problems} PROBLEM row(s) -- see above.` : `All ${fromCatalog.size} catalog rows: the saved list, filtered for their own section, nothing forbidden left.`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(lines.slice(0, 7).join('\n'));
  console.log(lines[lines.length - 1]);
  console.log(`\nFull report: ${outPath}`);
  process.exit(problems ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
