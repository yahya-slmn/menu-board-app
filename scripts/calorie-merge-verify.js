#!/usr/bin/env node
// Calories onto versions (MV5a) -- READ-ONLY, on the live data. Nothing is written to Supabase.
// Run it BEFORE "Carry calories to versions…" (the measurement) and AFTER (the verification):
//   1. the merge plan as it stands now (lib/calorieMerge.js planCalorieMerge, the code the MV5a carry ran): versions whose
//      rows agree / where an unflagged value wins / where rows disagree (each listed) / with none / already set;
//   2. every Dish Catalog row's calories as the app now SHOWS them (effectiveCalories: the version's, else the row's own
//      frozen value) against the row's own value: unchanged, a blank row now showing its version's value, changed because
//      its version's rows disagreed (an unflagged value won, or her pick) -- and anything else, which is a FAILURE;
//   3. menu_items untouched: saves a snapshot of every menu_items column (a NEW file each run); with --compare <snapshot>
//      it compares byte for byte with an earlier one (take one before carrying, compare after).
//
//   cd ~/menu-board && node scripts/calorie-merge-verify.js [--compare backups/menu-items-calories-snapshot-<date-time>.json]
//
// Asks for your login (run it in a normal Terminal window). Writes backups/calorie-merge-verify-<date-time>.txt.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { planCalorieMerge, effectiveCalories } = require('../lib/calorieMerge');

const args = process.argv.slice(2);
const cmpAt = args.indexOf('--compare');
const comparePath = cmpAt >= 0 ? args[cmpAt + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(__dirname, '..', 'backups', `calorie-merge-verify-${stamp}.txt`);
const snapPath = path.join(__dirname, '..', 'backups', `menu-items-calories-snapshot-${stamp}.json`);

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
async function fetchAll(table, cols) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const items = await fetchAll('menu_items', '*');
  const variants = await fetchAll('dish_variants', 'id, master_item_id, calories_per_100g, calories_unverified');
  if (!items.length) { console.error('No menu_items came back -- check the login (RLS returns nothing when signed out).'); process.exit(1); }
  const L = [];
  const P = (s = '') => { L.push(s); };
  const problems = [];
  const kcal = (v, f) => (v == null ? '—' : `${v}${f ? ' (flagged)' : ''}`);

  // ---- 1. the plan
  const plan = planCalorieMerge({ rows: items, variants });
  const s = plan.summary;
  const nameOf = new Map(items.map((r) => [r.id, r.name]));
  P(`Calories onto versions (MV5a) -- ${new Date().toLocaleString()}`);
  P(`menu_items: ${items.length} rows, ${s.rowsWithValue} with calories; dish_variants: ${variants.length}`);
  P('');
  P('1. The merge plan as it stands now');
  P(`   versions used by a row: ${s.versions}`);
  P(`   rows agree -> carried:              ${s.agree}`);
  P(`   unflagged value wins -> carried:    ${s.trusted}`);
  P(`   rows disagree -> the chef picks:     ${s.pick}`);
  P(`   no calories on any row -> empty:    ${s.none}`);
  P(`   version already has a value:         ${s.already}`);
  P(`   rows with calories and NO version:   ${s.unlinkedWithValue}`);
  const listVersion = (v) => `   v${v.variantId} ${nameOf.get(v.rows[0].id)}: ${v.rows.map((r) => `#${r.id} ${kcal(r.value, r.unverified)}`).join(', ')}${v.value != null ? ` -> ${kcal(v.value, v.unverified)}` : ''}`;
  const picks = plan.versions.filter((v) => v.outcome === 'pick');
  const trusted = plan.versions.filter((v) => v.outcome === 'trusted');
  if (picks.length) { P(''); P(`   Rows disagree (${picks.length}):`); picks.forEach((v) => P(listVersion(v))); }
  if (trusted.length) { P(''); P(`   Unflagged value wins (${trusted.length}):`); trusted.forEach((v) => P(listVersion(v))); }
  if (plan.unlinked.length) { P(''); P(`   Rows with calories and no version (${plan.unlinked.length}): ${plan.unlinked.slice(0, 40).map((i) => `#${i} ${nameOf.get(i)}`).join(', ')}${plan.unlinked.length > 40 ? ' …' : ''}`); }

  // ---- 2. what the app shows, row by row
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const c = { same: 0, filledFromVersion: 0, trusted: 0, picked: 0, fromRow: 0, fromVersion: 0, none: 0 };
  for (const r of items) {
    const own = effectiveCalories(r, null);
    const shown = effectiveCalories(r, variantById.get(r.dish_variant_id) || null);
    if (shown.source === 'version') c.fromVersion++; else if (shown.source === 'row') c.fromRow++; else c.none++;
    if (own.value === shown.value && own.unverified === shown.unverified) { c.same++; continue; }
    if (own.value == null) { c.filledFromVersion++; continue; }
    // A version's value that differs from this row's: explained only if its rows disagreed when it was carried. After the
    // carry the plan sees the version as 'already', so explain it from the rows themselves.
    const sibs = items.filter((x) => x.dish_variant_id === r.dish_variant_id && x.calories_per_100g != null);
    const sibValues = new Set(sibs.map((x) => `${Number(x.calories_per_100g)}|${!!x.calories_unverified}`));
    const holds = sibs.some((x) => Number(x.calories_per_100g) === shown.value && !!x.calories_unverified === shown.unverified);
    if (!holds) { problems.push(`#${r.id} ${r.name}: shows ${kcal(shown.value, shown.unverified)}, which none of its version's rows holds`); continue; }
    if (sibValues.size < 2) { problems.push(`#${r.id} ${r.name}: shows ${kcal(shown.value, shown.unverified)} though its rows agree on ${kcal(own.value, own.unverified)}`); continue; }
    if (shown.unverified && sibs.some((x) => !x.calories_unverified)) { problems.push(`#${r.id} ${r.name}: shows a FLAGGED ${shown.value} though an unflagged value exists`); continue; }
    if (r.calories_unverified && !shown.unverified) c.trusted++; else c.picked++;
  }
  P('');
  P('2. What the app shows, row by row (the version\'s value, else the row\'s own, greyed)');
  P(`   shown from the version: ${c.fromVersion}; from the row's old value (greyed): ${c.fromRow}; no calories: ${c.none}`);
  P(`   unchanged: ${c.same}`);
  P(`   a blank row now showing its version's value: ${c.filledFromVersion}`);
  P(`   changed -- its flagged value lost to an unflagged one: ${c.trusted}`);
  P(`   changed -- its version's rows disagreed (the chef's pick): ${c.picked}`);
  P(`   anything else (FAILURE): ${problems.length}`);
  problems.slice(0, 50).forEach((p) => P(`     ${p}`));

  // ---- 3. menu_items untouched
  const snapshot = items.slice().sort((a, b) => a.id - b.id);
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify(snapshot));
  P('');
  P(`3. Snapshot of every menu_items column saved: ${path.basename(snapPath)}`);
  if (comparePath) {
    const old = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    const oldById = new Map(old.map((r) => [r.id, r]));
    const changed = snapshot.filter((r) => oldById.has(r.id) && JSON.stringify(r) !== JSON.stringify(oldById.get(r.id)));
    const added = snapshot.filter((r) => !oldById.has(r.id)).length;
    const removed = old.filter((r) => !snapshot.some((x) => x.id === r.id)).length;
    const line = `Compared with ${path.basename(comparePath)}: ${changed.length} row(s) changed, ${added} added, ${removed} removed` +
      (changed.length ? ` (first: ${changed.slice(0, 10).map((r) => `#${r.id}`).join(', ')})` : '');
    P(`   ${line}`);
    if (changed.length || removed) problems.push(line);
  }

  P('');
  P(problems.length ? `RESULT: FAIL (${problems.length} problem(s))` : 'RESULT: PASS');
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nWritten to ${outPath}`);
  process.exit(problems.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
