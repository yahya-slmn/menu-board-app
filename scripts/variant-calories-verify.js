#!/usr/bin/env node
// Calorie writes on versions (MV5b) -- READ-ONLY, on the live data. Nothing is written to Supabase.
//   1. the old menu_items calorie columns are FROZEN: compared value by value with a snapshot taken before (the MV5a
//      verify's backups/menu-items-calories-snapshot-<date-time>.json, --compare); any change there is a FAILURE;
//   2. the versions: with calories / flagged unverified / empty, and how many rows show a value (the version's);
//   3. what "Estimate missing calories" would do now: empty versions an in-scope row uses (Daycare / KG-LP / MS-UP rows,
//      or AI-generated ones) -- one estimate each.
//
//   cd ~/menu-board && node scripts/variant-calories-verify.js --compare backups/menu-items-calories-snapshot-<date-time>.json
//
// Asks for your login (run it in a normal Terminal window). Writes backups/variant-calories-verify-<date-time>.txt.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');

const args = process.argv.slice(2);
const cmpAt = args.indexOf('--compare');
const comparePath = cmpAt >= 0 ? args[cmpAt + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(__dirname, '..', 'backups', `variant-calories-verify-${stamp}.txt`);
const num = (v) => (v == null || v === '' ? null : Number(v));

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
async function fetchAll(table, cols, orderCol = 'id') {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(orderCol).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

(async () => {
  if (!comparePath) { console.error('Pass --compare <the MV5a snapshot> (backups/menu-items-calories-snapshot-<date-time>.json).'); process.exit(1); }
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const items = await fetchAll('menu_items', 'id, name, is_ai_generated, dish_variant_id, calories_per_100g, calories_unverified');
  const variants = await fetchAll('dish_variants', 'id, calories_per_100g, calories_unverified');
  const sections = await fetchAll('sections', 'id, code');
  const ageGroups = await fetchAll('age_groups', 'id, section_id');
  const portions = await fetchAll('item_portions', 'id, item_id, age_group_id');
  if (!items.length) { console.error('No menu_items came back -- check the login (RLS returns nothing when signed out).'); process.exit(1); }
  const L = [];
  const P = (s = '') => L.push(s);
  const problems = [];

  // 1. frozen columns
  const old = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
  const oldById = new Map(old.map((r) => [r.id, r]));
  const changed = items.filter((r) => oldById.has(r.id) && (num(r.calories_per_100g) !== num(oldById.get(r.id).calories_per_100g) || !!r.calories_unverified !== !!oldById.get(r.id).calories_unverified));
  const added = items.filter((r) => !oldById.has(r.id));
  const addedWithCalories = added.filter((r) => num(r.calories_per_100g) != null);
  P(`Calorie writes on versions (MV5b) -- ${new Date().toLocaleString()}`);
  P(`menu_items: ${items.length}; dish_variants: ${variants.length}`);
  P('');
  P(`1. Old menu_items calorie columns vs ${path.basename(comparePath)}`);
  P(`   rows whose old calories changed: ${changed.length}${changed.length ? ` (${changed.slice(0, 15).map((r) => `#${r.id} ${r.name}`).join(', ')})` : ''}`);
  P(`   rows added since: ${added.length}, of which with a value in the old column: ${addedWithCalories.length}`);
  if (changed.length) problems.push(`${changed.length} row(s) had their old calorie columns written`);
  if (addedWithCalories.length) problems.push(`${addedWithCalories.length} new row(s) got a value in the old calorie column`);

  // 2. versions and what rows show
  const vById = new Map(variants.map((v) => [v.id, v]));
  const withValue = variants.filter((v) => num(v.calories_per_100g) != null);
  const shown = items.filter((r) => num(vById.get(r.dish_variant_id)?.calories_per_100g) != null).length;
  P('');
  P('2. Versions');
  P(`   with calories: ${withValue.length} (flagged unverified: ${withValue.filter((v) => v.calories_unverified).length}); empty: ${variants.length - withValue.length}`);
  P(`   catalog rows showing a value (their version's): ${shown} of ${items.length}; rows without a version: ${items.filter((r) => r.dish_variant_id == null).length}`);

  // 3. what the backfill would estimate
  const school = new Set(sections.filter((s) => ['DAYCARE', 'KG_LP', 'MS_UP'].includes(s.code)).map((s) => s.id));
  const schoolAg = new Set(ageGroups.filter((a) => school.has(a.section_id)).map((a) => a.id));
  const schoolRows = new Set(portions.filter((p) => schoolAg.has(p.age_group_id)).map((p) => p.item_id));
  const inScope = items.filter((r) => schoolRows.has(r.id) || r.is_ai_generated);
  const emptyInScope = new Set(inScope.map((r) => r.dish_variant_id).filter((v) => v != null && vById.has(v) && num(vById.get(v).calories_per_100g) == null));
  P('');
  P(`3. "Estimate missing calories" would estimate ${emptyInScope.size} version(s) now (one AI estimate each; ${inScope.length} in-scope rows)`);

  P('');
  P(problems.length ? `RESULT: FAIL -- ${problems.join('; ')}` : 'RESULT: PASS -- the old calorie columns are untouched; every value lives on a version');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nWritten to ${outPath}`);
  process.exit(problems.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
