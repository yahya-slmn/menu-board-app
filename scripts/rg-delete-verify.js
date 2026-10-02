#!/usr/bin/env node
// Recipe Generator bulk delete -- READ-ONLY check on the live data BEFORE using it: for each selection she can make (every
// draft = "Select all" on the Drafts folder list; each draft folder; every confirmed recipe), the numbers the confirmation
// would show -- computed by the SAME planner the app uses (lib/generatedRecipeDelete.js) from the same queries -- against
// an INDEPENDENT count straight from the database (count queries per status / folder, and the process / ingredient rows that
// would go with them). Every line must match. Nothing is deleted or written.
//
//   cd ~/menu-board && node scripts/rg-delete-verify.js
//
// Asks for your login (run it in a normal Terminal window). Report: backups/rg-delete-verify-<date>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { planGeneratedDelete } = require('../lib/generatedRecipeDelete');

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
async function fetchAll(table, cols, refine = (q) => q) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await refine(supabase.from(table).select(cols)).order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}
async function countWhere(table, refine) {
  const { count, error } = await refine(supabase.from(table).select('id', { count: 'exact', head: true }));
  if (error) throw new Error(`${table}: ${error.message}`);
  return count;
}
async function countIn(table, col, ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) n += await countWhere(table, (q) => q.in(col, ids.slice(i, i + 200)));
  return n;
}

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const recipes = await fetchAll('generated_recipes', 'id, name, code, status, source_menu_label, source_dish_name');
  const procs = await fetchAll('generated_recipe_processes', 'id, generated_recipe_id');
  const ings = await fetchAll('generated_recipe_ingredients', 'id, process_id');
  const recipeOfProc = new Map(procs.map((p) => [p.id, p.generated_recipe_id]));
  const dependents = new Map();
  for (const p of procs) { const d = dependents.get(p.generated_recipe_id) || { processes: 0, ingredients: 0 }; d.processes++; dependents.set(p.generated_recipe_id, d); }
  for (const i of ings) { const d = dependents.get(recipeOfProc.get(i.process_id)); if (d) d.ingredients++; }

  const L = [`Recipe Generator bulk delete -- read-only check, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (nothing deleted)`, '',
    `Generated recipes: ${recipes.length} (${recipes.filter((r) => r.status !== 'confirmed').length} drafts, ${recipes.filter((r) => r.status === 'confirmed').length} confirmed)`, ''];
  let mismatches = 0;
  const check = async (label, selected, dbCount) => {
    const plan = planGeneratedDelete({ recipes: selected, dependents });
    const ids = selected.map((r) => r.id);
    const procIds = procs.filter((p) => ids.includes(p.generated_recipe_id)).map((p) => p.id);
    const dbProcs = await countIn('generated_recipe_processes', 'generated_recipe_id', ids);
    const dbIngs = procIds.length ? await countIn('generated_recipe_ingredients', 'process_id', procIds) : 0;
    const ok = plan.total === dbCount && plan.dependentRows.processes === dbProcs && plan.dependentRows.ingredients === dbIngs;
    if (!ok) mismatches++;
    L.push(`${ok ? 'MATCH   ' : 'MISMATCH'} ${label}: confirmation shows ${plan.total} recipe(s) in ${plan.folders.length} folder(s) (${plan.drafts} draft, ${plan.confirmed} confirmed), ` +
      `${plan.dependentRows.processes} process(es), ${plan.dependentRows.ingredients} ingredient row(s) -- database: ${dbCount} recipe(s), ${dbProcs} process(es), ${dbIngs} ingredient row(s)`);
  };
  const drafts = recipes.filter((r) => r.status !== 'confirmed');
  await check('EVERY DRAFT (Drafts -> Select all)', drafts, await countWhere('generated_recipes', (q) => q.eq('status', 'draft')));
  const folders = [...new Set(drafts.map((r) => r.source_menu_label || 'Unknown source'))].sort();
  for (const f of folders) {
    const sel = drafts.filter((r) => (r.source_menu_label || 'Unknown source') === f);
    const db = await countWhere('generated_recipes', (q) => (f === 'Unknown source' ? q.is('source_menu_label', null) : q.eq('source_menu_label', f)).eq('status', 'draft'));
    await check(`  draft folder "${f}"`, sel, db);
  }
  const confirmed = recipes.filter((r) => r.status === 'confirmed');
  await check('EVERY CONFIRMED (Recipe Generated -> all ticked)', confirmed, await countWhere('generated_recipes', (q) => q.eq('status', 'confirmed')));
  L.push('', mismatches ? `${mismatches} MISMATCH(ES) -- do not use the bulk delete until this is understood.` : 'PASS: every count the confirmation would show matches the database.');
  const out = path.join(__dirname, '..', 'backups', `rg-delete-verify-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nReport: ${out}`);
  process.exit(mismatches ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
