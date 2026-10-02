#!/usr/bin/env node
// Ingredient name map (unification U2) -- READ-ONLY look at the real queue before deciding anything: how many kitchen names
// need a decision, how much of the recipes' ingredient rows each share of them covers, how the 30 most-used names would be
// offered (every candidate, best first, nothing picked), and the suggested master-list merges. Uses exactly the app's code
// (lib/ingredientMatch.js). Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/name-map-measure.js [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Works before the U2 migration is applied (no decisions yet).
// Report (default): backups/name-map-measure-<date>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { buildQueue, candidatesFor, suggestMerges } = require('../lib/ingredientMatch');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `name-map-measure-${new Date().toISOString().slice(0, 10)}.txt`);

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
async function fetchAll(table, cols, optional = false) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order('id').range(from, from + 999);
    if (error) { if (optional) return []; throw new Error(`${table}: ${error.message}`); }
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const master = await fetchAll('ingredients', 'id, name, product_code, category, default_unit');
  if (!master.length) throw new Error('The ingredients list came back empty -- is the login right?');
  const aliases = await fetchAll('ingredient_aliases', 'id, name_key, ingredient_id, decision', true);
  // The same usages the Name map reads (main.js recipeIngredientUsages).
  const genRecipes = new Map((await fetchAll('generated_recipes', 'id, name')).map((r) => [r.id, r.name]));
  const genProcs = new Map((await fetchAll('generated_recipe_processes', 'id, generated_recipe_id')).map((p) => [p.id, p.generated_recipe_id]));
  const usages = (await fetchAll('generated_recipe_ingredients', 'id, name, process_id')).map((i) => ({ name: i.name, recipe: genRecipes.get(genProcs.get(i.process_id)) || null }));
  const exRecipes = new Map((await fetchAll('extracted_recipes', 'id, name')).map((r) => [r.id, r.name]));
  const exProcs = new Map((await fetchAll('extracted_recipe_processes', 'id, extracted_recipe_id')).map((p) => [p.id, p.extracted_recipe_id]));
  const exNames = new Map((await fetchAll('extracted_ingredients', 'id, name')).map((i) => [i.id, i.name]));
  const exRows = await fetchAll('extracted_recipe_ingredients', 'id, extracted_ingredient_id, extracted_recipe_process_id');
  for (const i of exRows) usages.push({ name: exNames.get(i.extracted_ingredient_id) || '', recipe: exRecipes.get(exProcs.get(i.extracted_recipe_process_id)) || null });

  const q = buildQueue({ usages, master, aliases });
  const L = [`Ingredient name map -- U2 real-data look, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only)`, '',
    `Master list: ${master.length} products; decisions saved so far: ${aliases.length}`,
    `Recipe ingredient rows: ${q.totalRows} (generated ${usages.length - exRows.length}, extracted ${exRows.length}); linked already: ${q.resolvedRows} (${Math.round((100 * q.resolvedRows) / Math.max(1, q.totalRows))}%)`,
    `Names to decide: ${q.queue.length} (spellings of one word counted once)`];
  let rows = q.resolvedRows;
  const marks = [];
  q.queue.forEach((g, i) => { rows += g.rows; for (const p of [50, 80, 90, 95]) if (!marks.find((m) => m.p === p) && rows / q.totalRows >= p / 100) marks.push({ p, n: i + 1 }); });
  L.push(`Deciding the most-used names first reaches: ${marks.map((m) => `${m.p}% of rows after ${m.n} names`).join(', ')}`, '', 'THE 30 MOST-USED NAMES, AS THE NAME MAP OFFERS THEM (nothing is picked):');
  for (const g of q.queue.slice(0, 30)) {
    const c = candidatesFor(g.spellings[0].name, master);
    L.push(`  ${g.spellings.map((s) => `"${s.name}"`).join(' / ')} -- ${g.rows} rows -- ${c.length} candidate(s)${c.length ? ': ' + c.slice(0, 8).map((x) => `${x.name}${x.product_code ? ` [${x.product_code}]` : ''}`).join(', ') + (c.length > 8 ? ` +${c.length - 8} more` : '') : ' (search or add as new)'}`);
  }
  const sm = suggestMerges(master);
  L.push('', `SUGGESTED MERGES (punctuation / word order only): ${sm.length}`, ...sm.map((s) => `  [${s.why}] ${s.items.map((m) => `"${m.name}"${m.product_code ? ` ${m.product_code}` : ''}`).join(' + ')}`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nReport: ${outPath}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
