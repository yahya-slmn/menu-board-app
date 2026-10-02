#!/usr/bin/env node
// Old dish code removal (unification U1) -- READ-ONLY check after the removal: how many dishes still have something in
// menu_items.rc_code (expected 0), and what menu_item_code_history holds per batch (expected one batch of 2,107
// 'rc_removal' rows: 493 RC codes + 1,614 "NEW"), plus whether every history row's dish is now empty. Nothing is
// written to Supabase.
//
//   cd ~/menu-board && node scripts/code-removal-verify.js
//
// Asks for your login (run it in a normal Terminal window).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');

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

  const items = await fetchAll('menu_items', 'id, name, rc_code');
  if (!items.length) throw new Error('The catalog came back empty -- is the login right?');
  const stillCoded = items.filter((it) => it.rc_code != null && String(it.rc_code).trim() !== '');
  const history = await fetchAll('menu_item_code_history', 'id, item_id, old_code, new_code, reason, batch_id, changed_by, changed_at');
  const batches = new Map();
  for (const h of history) { if (!batches.has(h.batch_id)) batches.set(h.batch_id, []); batches.get(h.batch_id).push(h); }
  const byId = new Map(items.map((it) => [it.id, it]));

  console.log(`\nDishes: ${items.length}`);
  console.log(`Dishes with a non-empty code: ${stillCoded.length}${stillCoded.length ? ` -- e.g. ${stillCoded.slice(0, 10).map((it) => `#${it.id} ${it.name} (${it.rc_code})`).join('; ')}` : ''}`);
  console.log(`History rows: ${history.length} in ${batches.size} batch(es)`);
  for (const [batch, rows] of batches) {
    const kinds = { NEW: 0, RC: 0, other: 0 };
    for (const r of rows) { const c = String(r.old_code || '').trim().toUpperCase(); kinds[c === 'NEW' ? 'NEW' : /^RC/.test(c) ? 'RC' : 'other']++; }
    const items1 = new Set(rows.map((r) => r.item_id));
    const notEmpty = rows.filter((r) => r.item_id != null && byId.get(r.item_id) && String(byId.get(r.item_id).rc_code ?? '').trim() !== '');
    console.log(`  batch ${batch}: ${rows.length} rows (${[...new Set(rows.map((r) => r.reason))].join(', ')}), by ${[...new Set(rows.map((r) => r.changed_by))].join(', ')}, ` +
      `${String(rows[0].changed_at).slice(0, 19)}; old codes: RC ${kinds.RC}, "NEW" ${kinds.NEW}, other ${kinds.other}; ` +
      `${items1.size} distinct dishes; new_code set on ${rows.filter((r) => r.new_code != null).length}; dishes not empty now: ${notEmpty.length}`);
  }
  const ok = stillCoded.length === 0 && batches.size === 1 && history.length === 2107 && new Set(history.map((h) => h.item_id)).size === 2107;
  console.log(ok ? '\nPASS: no dish has a code; 2,107 history rows, one batch, one row per dish.' : '\nNOT AS EXPECTED -- see the lines above.');
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
