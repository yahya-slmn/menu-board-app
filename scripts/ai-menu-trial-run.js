#!/usr/bin/env node
// Trial run of the AI Menu Generator's draft step (Phase 2) before its review screen exists.
// Signs in as you (same login as the app), invents dishes with the generate-menu-dishes Edge
// Function, schedules them with the real engine and saves ONE draft run into ai_menu_runs /
// ai_menu_draft_dishes / ai_menu_draft_picks. Nothing else is written: no menu_items, no
// generated_menus -- a draft only reaches those on Approve (Phase 4).
//
//   cd ~/menu-board && node scripts/ai-menu-trial-run.js 2026-10-04 2026-10-08
//
// Start and end dates are inclusive (Sunday-Thursday school days in between). Keep the first trial
// short: a week is ~30 AI calls; a full 4-week run is ~50 calls and several minutes.
// Run it in a normal Terminal window (it asks for your password, which Claude Code's `!` can't
// answer). The report is also saved to backups/ai-menu-trial-<run id>.txt (gitignored).
// A trial run can be removed afterwards with:  delete from ai_menu_runs where id = <run id>;
// (the draft dishes and picks go with it).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData } = require('../lib/referenceData');
const { generateDraftRun } = require('../lib/aiMenuGenerate');

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
  const m = src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/);
  if (!m) throw new Error("Couldn't find LOGIN_ID_DOMAIN in main.js");
  return m[1];
}

(async () => {
  const [startDate, endDate] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
    console.error('Usage: node scripts/ai-menu-trial-run.js <start YYYY-MM-DD> <end YYYY-MM-DD>');
    process.exit(1);
  }
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const t0 = Date.now();
  const lines = [];
  const log = (...args) => { const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '); lines.push(line); console.log(line); };
  const result = await generateDraftRun({
    label: `Trial ${startDate} to ${endDate}`, startDate, endDate, createdBy: id,
    onProgress: (m) => log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`),
  });

  const { data: run } = await supabase.from('ai_menu_runs').select('*').eq('id', result.runId).single();
  const { data: dishes } = await supabase.from('ai_menu_draft_dishes').select('*').eq('run_id', result.runId);
  const { count: pickCount } = await supabase.from('ai_menu_draft_picks').select('id', { count: 'exact', head: true }).eq('run_id', result.runId);
  const { count: emptyCount } = await supabase.from('ai_menu_draft_picks').select('id', { count: 'exact', head: true })
    .eq('run_id', result.runId).is('draft_dish_id', null).is('item_id', null);

  log(`\nRun ${result.runId} (${run.status}), ${result.numWeekdays} school days, ${Math.round((Date.now() - t0) / 1000)}s`);
  log('Stats:', result.stats);
  log(`Picks saved: ${pickCount} (${emptyCount} empty)`);
  const byKind = {};
  for (const w of run.warnings) byKind[w.kind] = (byKind[w.kind] || 0) + 1;
  log('Warnings by kind:', byKind);
  for (const w of run.warnings.filter((x) => x.kind === 'safety')) log(`  REJECTED ${w.category} "${w.name}": ${w.reason}`);
  for (const w of run.warnings.filter((x) => x.kind !== 'safety').slice(0, 25)) log(`  ${w.kind}: ${w.message || w.name || ''}`);

  const byCat = {};
  for (const d of dishes) (byCat[d.category_code] = byCat[d.category_code] || []).push(d);
  log('\nSample dishes per category:');
  for (const [cat, list] of Object.entries(byCat)) {
    log(`  ${cat} (${list.length}, ${list.filter((d) => d.resolution === 'link').length} linked to the catalog):`);
    for (const d of list.slice(0, 4)) {
      const attrs = ['protein_code', 'sauce_type', 'carb_type', 'dish_concept', 'am_snack_style'].map((a) => d[a]).filter(Boolean).join('/');
      const risk = (d.safety_scan.known_risk || []).length ? ' [Made nut/sesame-free (kitchen standard)]' : '';
      log(`    - ${d.name} (${attrs || '-'})${risk}: ${d.key_ingredients.join(', ')}`);
    }
  }
  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `ai-menu-trial-${result.runId}.txt`);
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\nReport saved to ${outFile}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
