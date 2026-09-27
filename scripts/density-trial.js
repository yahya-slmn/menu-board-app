#!/usr/bin/env node
// Read-only trial of Recipe on Fire's AI density estimate (phase D1; supabase/functions/estimate-density must be deployed).
// Two sets, one report:
//   1. Reference mixtures with known real densities (whipped cream, meringue, puff pastry, a cheese-and-egg filling, a
//      cake batter, a bread dough): each estimate is checked against the known range.
//   2. Real Recipe Book recipes: every process as its own layer, and all of a recipe's processes merged as a One dough.
// Nothing is written to Supabase. Each run makes a few paid Sonnet 5 calls (one per reference batch and per recipe).
//
//   cd ~/menu-board && node scripts/density-trial.js                  # references + 6 recipes with 2+ processes
//   cd ~/menu-board && node scripts/density-trial.js TTY-00012 TTY-00031  # references + these recipes
//   cd ~/menu-board && node scripts/density-trial.js --references-only    # the reference mixtures only, no login
//
// Asks for your login (run it in a normal Terminal window) unless --references-only (the function only needs the
// project's public key; recipes need a signed-in session because of RLS). Report: backups/density-trial.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { estimateDensity, toDensityItem } = require('../lib/estimateDensity');

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

// Known densities of the raw mass (g/cm3), from standard kitchen / food-science figures.
const REFERENCES = [
  { label: 'Whipped cream (stiff peaks)', role: 'filling', known: [0.3, 0.55], rows: [['Heavy cream 35%', 500], ['Icing sugar', 50], ['Vanilla extract', 5]], method: 'Whip the cream with the sugar and vanilla to stiff peaks.' },
  { label: 'French meringue', role: 'filling', known: [0.1, 0.35], rows: [['Egg whites', 200], ['Caster sugar', 400]], method: 'Whisk the whites to soft peaks, then add the sugar gradually and whisk until stiff and glossy.' },
  { label: 'Puff pastry (laminated)', role: 'dough', known: [1.05, 1.25], rows: [['Flour', 500], ['Butter', 400], ['Water', 250], ['Salt', 10]], method: 'Make a dough of flour, water and salt, rest, laminate with the butter block, 3 double turns.' },
  { label: 'Cheese and egg filling', role: 'filling', known: [0.95, 1.15], rows: [['Feta cheese', 300], ['Mozzarella, grated', 200], ['Eggs', 150], ['Milk', 100]], method: 'Mix everything together.' },
  { label: 'Butter cake batter', role: 'filling', known: [0.8, 1.05], rows: [['Butter', 250], ['Sugar', 250], ['Eggs', 250], ['Flour', 250], ['Baking powder', 8]], method: 'Cream the butter and sugar until light and fluffy, beat in the eggs, fold in the flour and baking powder.' },
  { label: 'Bread dough (before proofing)', role: 'dough', known: [1.05, 1.25], rows: [['Bread flour', 1000], ['Water', 650], ['Yeast', 10], ['Salt', 20]], method: 'Mix and knead 10 minutes until smooth.' },
];

const hasFlour = (rows) => rows.some(r => /flour|semolina|farine|طحين/i.test(r.name || ''));

(async () => {
  const args = process.argv.slice(2);
  const refsOnly = args.includes('--references-only');
  const codes = args.filter(a => !a.startsWith('--')).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!refsOnly) {
    const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
    const password = await ask('Password: ', { hidden: true });
    const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
    if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  }

  const out = [];
  const line = (s = '') => { out.push(s); console.log(s); };
  const fmt = (e) => `${e.density} g/cm3 (${e.low}-${e.high}, ${e.confidence}) -- ${e.basis}`;
  line(`Density trial, ${new Date().toISOString()}`);

  // 1. References
  line('\n== Reference mixtures (known densities) ==');
  const refItems = REFERENCES.map((r, i) => toDensityItem({ index: i, label: r.label, role: r.role, sources: [{ rows: r.rows.map(([name, quantity]) => ({ name, quantity, unit: 'GR' })), method: r.method }] }));
  const ref = await estimateDensity(refItems);
  let inside = 0;
  REFERENCES.forEach((r, i) => {
    const e = ref.estimates.get(i);
    if (!e) { line(`- ${r.label}: NO ANSWER`); return; }
    const okRange = e.density >= r.known[0] && e.density <= r.known[1];
    if (okRange) inside++;
    line(`- ${r.label}: ${fmt(e)}\n    known ${r.known[0]}-${r.known[1]} -> ${okRange ? 'inside' : 'OUTSIDE'}`);
  });
  line(`References inside the known range: ${inside} of ${REFERENCES.length} (prompt version ${ref.promptVersion})`);

  // 2. Real recipes
  let recipes = [];
  if (refsOnly) {
    line('\n(Recipes skipped: --references-only.)');
  } else if (codes.length) {
    const { data, error } = await supabase.from('recipes').select('id, name, code').in('code', codes);
    if (error) throw error;
    recipes = data;
  } else {
    const { data: procs, error } = await supabase.from('recipe_processes').select('recipe_id');
    if (error) throw error;
    const counts = new Map();
    procs.forEach(p => counts.set(p.recipe_id, (counts.get(p.recipe_id) || 0) + 1));
    const multi = [...counts].filter(([, n]) => n >= 2).map(([rid]) => rid).slice(0, 6);
    const { data, error: e2 } = await supabase.from('recipes').select('id, name, code').in('id', multi.length ? multi : [-1]);
    if (e2) throw e2;
    recipes = data;
  }
  line(`\n== Recipes (${recipes.length}) ==`);
  for (const rec of recipes) {
    const { data: procs, error: pErr } = await supabase.from('recipe_processes').select('id, name, method, sort_order').eq('recipe_id', rec.id).order('sort_order');
    if (pErr) throw pErr;
    const { data: ings, error: iErr } = await supabase.from('recipe_ingredients').select('process_id, ingredient_id, quantity, unit, sort_order').in('process_id', procs.map(p => p.id).concat(-1)).order('sort_order');
    if (iErr) throw iErr;
    const { data: names, error: nErr } = await supabase.from('ingredients').select('id, name').in('id', [...new Set(ings.map(i => i.ingredient_id).filter(Boolean))].concat(-1));
    if (nErr) throw nErr;
    const nameOf = new Map(names.map(n => [n.id, n.name]));
    const rowsOf = (pid) => ings.filter(i => i.process_id === pid).map(i => ({ name: nameOf.get(i.ingredient_id) || '', quantity: i.quantity, unit: i.unit }));
    const items = procs.map((p, i) => toDensityItem({ index: i, label: p.name, role: hasFlour(rowsOf(p.id)) ? 'dough' : 'filling', sources: [{ rows: rowsOf(p.id), method: p.method }] }));
    if (procs.length > 1) items.push(toDensityItem({ index: procs.length, label: `${rec.name} (all processes as One dough)`, role: 'mixed', sources: procs.map(p => ({ rows: rowsOf(p.id), method: p.method })) }));
    line(`\n${rec.code} ${rec.name}`);
    try {
      const r = await estimateDensity(items);
      items.forEach(it => { const e = r.estimates.get(it.index); line(`- ${it.label} [${it.role}, ${it.ingredients.length} ingredients]: ${e ? fmt(e) : 'NO ANSWER'}`); });
    } catch (err) {
      line(`- failed: ${err.message}`);
    }
  }

  const file = path.join(__dirname, '..', 'backups', 'density-trial.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(`\nReport: ${file}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
