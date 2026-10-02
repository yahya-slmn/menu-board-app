#!/usr/bin/env node
// New rows get a version (MV6) -- READ-ONLY, on the live data. Nothing is written to Supabase.
//   1. Dish Catalog rows WITHOUT a version (each listed) -- after MV6 there should be none; Dish Catalog -> "Link rows
//      without a version…" links any a failed link left behind;
//   2. rows whose version belongs to a dish of ANOTHER name (case / spacing aside) -- a rename from before MV6, or a row
//      moved by hand in Master Items; each listed, to check;
//   3. master items with no version, and versions no row uses (counts; Master Items shows them);
//   4. the counts.
//
//   cd ~/menu-board && node scripts/variant-link-verify.js
//
// Asks for your login (run it in a normal Terminal window). Writes backups/variant-link-verify-<date-time>.txt.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { nameKey } = require('../lib/variantLink');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(__dirname, '..', 'backups', `variant-link-verify-${stamp}.txt`);

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

  const [items, masters, variants] = [await fetchAll('menu_items', 'id, name, is_active, dish_variant_id, created_at'),
    await fetchAll('master_items', 'id, name, name_key'), await fetchAll('dish_variants', 'id, master_item_id')];
  if (!items.length) { console.error('No menu_items came back -- check the login (RLS returns nothing when signed out).'); process.exit(1); }
  const L = [];
  const P = (s = '') => L.push(s);
  const masterById = new Map(masters.map((m) => [m.id, m]));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const unlinked = items.filter((r) => r.dish_variant_id == null);
  const missingVersion = items.filter((r) => r.dish_variant_id != null && !variantById.has(r.dish_variant_id));
  const otherName = items.filter((r) => {
    const v = variantById.get(r.dish_variant_id);
    const m = v && masterById.get(v.master_item_id);
    return m && m.name_key !== nameKey(r.name);
  });
  const used = new Set(items.map((r) => r.dish_variant_id).filter((x) => x != null));
  const hasVersion = new Set(variants.map((v) => v.master_item_id));
  const emptyMasters = masters.filter((m) => !hasVersion.has(m.id));
  const unusedVersions = variants.filter((v) => !used.has(v.id));

  P(`New rows get a version (MV6) -- ${new Date().toLocaleString()}`);
  P(`menu_items: ${items.length}; master_items: ${masters.length}; dish_variants: ${variants.length}`);
  P('');
  P(`1. Rows without a version: ${unlinked.length}`);
  unlinked.slice(0, 60).forEach((r) => P(`   #${r.id} ${r.name}${r.is_active ? '' : ' (inactive)'} -- added ${String(r.created_at || '').slice(0, 10)}`));
  if (missingVersion.length) { P(`   Rows pointing at a version that no longer exists: ${missingVersion.length}`); missingVersion.slice(0, 20).forEach((r) => P(`   #${r.id} ${r.name} -> v${r.dish_variant_id}`)); }
  P('');
  P(`2. Rows whose version belongs to a dish of another name: ${otherName.length}`);
  otherName.slice(0, 60).forEach((r) => { const m = masterById.get(variantById.get(r.dish_variant_id).master_item_id); P(`   #${r.id} "${r.name}" uses a version of "${m.name}" (v${r.dish_variant_id})`); });
  P('');
  P(`3. Master items with no version: ${emptyMasters.length}${emptyMasters.length ? ` (${emptyMasters.slice(0, 15).map((m) => m.name).join(', ')}${emptyMasters.length > 15 ? ' …' : ''})` : ''}`);
  P(`   Versions no row uses: ${unusedVersions.length}`);
  P('');
  const problems = unlinked.length + missingVersion.length;
  P(problems ? `RESULT: FAIL -- ${problems} row(s) without a usable version` : `RESULT: PASS -- every row uses a version${otherName.length ? ` (${otherName.length} under another name's dish: see 2)` : ''}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nWritten to ${outPath}`);
  process.exit(problems ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
