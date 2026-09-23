#!/usr/bin/env node
// One-time Staff Main backfill for the new Staff Main rule (1 vegan + 1 vegetarian with different
// starches). Run it AFTER supabase/migrations/20260924100000_menu_rules_v2.sql, in a normal
// Terminal window (it asks for your login):
//
//   cd ~/menu-board && node scripts/staff-main-backfill.js
//
// 1. Starch type: every active Staff Main dish without one gets the AI's estimate, written straight
//    away (like the calorie / AM Snack style backfills). Dishes with no starch stay empty.
// 2. Vegan: dishes tagged Vegetarian (or untagged) that the AI thinks are vegan are LISTED, and only
//    the ones you type in are marked Vegan. Nothing is marked vegan without your say-so.
// Everything is also saved to backups/staff-main-backfill-<date>.txt. Safe to run again: it only
// ever fills empty starch types and only offers dishes that aren't Vegan yet.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getProteinByCode } = require('../lib/referenceData');
const bf = require('../lib/staffMainBackfill');

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

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const lines = [];
  const log = (s = '') => { lines.push(s); console.log(s); };
  const items = await bf.loadStaffMainItems();
  log(`${items.length} active Staff Main dishes; ${items.filter((i) => !i.carb_type).length} without a starch type.`);
  const { estimates, failures } = await bf.estimateAll(items, { onProgress: (m) => console.log(`  ${m}`) });
  for (const f of failures) log(`  ! ${f}`);

  const written = await bf.applyCarbTypes(items, estimates);
  log(`\n1. Starch type written for ${written.length} dish(es):`);
  for (const w of written) log(`   ${w.carb_type.padEnd(7)} ${w.name}`);
  const noStarch = items.filter((it) => !it.carb_type && estimates.get(it.id)?.carb_type === 'NONE');
  if (noStarch.length) log(`   Left empty (no starch in the dish): ${noStarch.map((i) => i.name).join('; ')}`);

  if (!getProteinByCode('VEGAN')) {
    log('\n2. Vegan: skipped -- there is no VEGAN protein type yet. Run the menu rules v2 migration, then run this script again.');
  } else {
    const proposals = bf.veganProposals(items, estimates);
    log(`\n2. The AI thinks these ${proposals.length} dish(es) are vegan (no meat, fish, dairy, egg or honey as normally made):`);
    proposals.forEach((p, i) => log(`   ${String(i + 1).padStart(3)}. ${p.name}${p.currentProtein ? '' : '  (no protein type set yet)'}`));
    if (proposals.length) {
      let picked = null;
      while (picked === null) {
        const answer = await ask('\nWhich should be marked VEGAN? Numbers or ranges (e.g. 1,3,5-7), "all", or Enter for none: ');
        try { picked = bf.parseSelection(answer, proposals.length); } catch (err) { console.log(`   ${err.message} -- try again.`); }
      }
      const ids = picked.map((n) => proposals[n - 1].id);
      const done = ids.length ? await bf.applyVegan(ids) : [];
      log(`   Marked Vegan (${done.length}): ${done.map((d) => d.name).join('; ') || 'none'}`);
      log(`   Left as they were (${proposals.length - done.length}).`);
    }
  }
  const untagged = bf.untaggedReport(await bf.loadStaffMainItems(), estimates);
  if (untagged.length) {
    log(`\nFor information -- Staff Main dishes with no protein type at all (set these in the Dish Catalog if needed):`);
    for (const u of untagged) log(`   ${u.name}  (AI: ${u.diet.toLowerCase().replace(/_/g, ' ')})`);
  }

  const out = path.join(__dirname, '..', 'backups', `staff-main-backfill-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nReport saved to ${out}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });

