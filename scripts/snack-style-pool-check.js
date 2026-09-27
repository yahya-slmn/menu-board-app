#!/usr/bin/env node
// Read-only pool-size check for the planned AM / PM Snack sharing + Pastry / Cold Kitchen rule
// (2026-09-24): Daycare and KG-LP will serve ONE shared AM Snack and ONE shared PM Snack each day,
// MS-UP keeps its own, and the day's four snack cells are always 2 Pastry + 2 Cold Kitchen; Staff
// Breakfast becomes 3 Pastry + 3 Cold Kitchen (2 shared + 2 + 2 of its own).
//
// For each pool the engine would draw from, it counts the dishes by style (menu_items.am_snack_style)
// and compares that with what 4 weeks without a repeat need. The pool is what the engine uses: active
// dishes of that category with a portion row in the section; a SHARED Daycare / KG-LP dish must be in
// BOTH catalogs, so the dishes only one of them has are listed too (they would drop out of the shared
// pool). Daily-repeating dishes are left out (they never rotate). Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/snack-style-pool-check.js
//
// Asks for your login (run it in a normal Terminal window). Report: backups/snack-style-pool-check.txt
// Run it again after "Estimate missing styles" in the Dish Catalog to see the untagged dishes tagged.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryByCode, getSectionByCode, getAgeGroupsForSection, getProteinById } = require('../lib/referenceData');

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

async function fetchAll(buildQuery) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// 4 weeks = 20 school days (NO_REPEAT_DAYS 28). Each snack cell alternates style daily, so it needs
// 10 dishes of each style; Staff's own 4 breakfast dishes are 2 Pastry + 2 Cold Kitchen every day.
const SCHOOL_DAYS_4_WEEKS = 20;
const STYLES = ['PASTRY', 'COLD_KITCHEN'];
const STYLE_LABEL = { PASTRY: 'Pastry', COLD_KITCHEN: 'Cold Kitchen', null: 'untagged' };
const MEAT_FREE = new Set(['VEGAN', 'VEGETARIAN']);

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const lines = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  const portions = await fetchAll(() => supabase.from('item_portions').select('item_id, age_group_id').order('item_id').order('age_group_id'));
  const items = await fetchAll(() => supabase.from('menu_items')
    .select('id, name, category_id, is_active, is_daily_repeating, am_snack_style, protein_type_id').order('id'));
  const idsInSection = (code) => {
    const ags = new Set(getAgeGroupsForSection(getSectionByCode(code).id).map((a) => a.id));
    return new Set(portions.filter((p) => ags.has(p.age_group_id)).map((p) => p.item_id));
  };
  const SECTION_IDS = Object.fromEntries(['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF'].map((c) => [c, idsInSection(c)]));
  const pool = (sections, category) => {
    const catId = getCategoryByCode(category).id;
    return items.filter((i) => i.category_id === catId && i.is_active === 1 && !i.is_daily_repeating
      && sections.every((s) => SECTION_IDS[s].has(i.id)));
  };
  const byStyle = (list) => {
    const out = { PASTRY: 0, COLD_KITCHEN: 0, null: 0 };
    for (const i of list) out[STYLES.includes(i.am_snack_style) ? i.am_snack_style : 'null']++;
    return out;
  };
  const verdict = (count, need) => (count >= need ? 'OK' : `SHORT by ${need - count} (repeats inside 4 weeks)`);
  const styleLines = (list, needPerStyle) => {
    const c = byStyle(list);
    for (const s of STYLES) log(`    ${STYLE_LABEL[s].padEnd(13)} ${String(c[s]).padStart(4)}   need ${needPerStyle} -> ${verdict(c[s], needPerStyle)}`);
    log(`    ${'untagged'.padEnd(13)} ${String(c.null).padStart(4)}${c.null ? '   (run "Estimate missing styles" in the Dish Catalog)' : ''}`);
  };

  log(`Snack style pool check -- ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  log(`Pools = active, non-daily dishes with a portion in the section. "need" = distinct dishes of that style`);
  log(`for ${SCHOOL_DAYS_4_WEEKS} school days (4 weeks) with no repeat.\n`);

  for (const category of ['AM_SNACK', 'PM_SNACK']) {
    const label = category === 'AM_SNACK' ? 'AM Snack' : 'PM Snack';
    const shared = pool(['DAYCARE', 'KG_LP'], category);
    const daycareOnly = pool(['DAYCARE'], category).filter((i) => !SECTION_IDS.KG_LP.has(i.id));
    const kgOnly = pool(['KG_LP'], category).filter((i) => !SECTION_IDS.DAYCARE.has(i.id));
    log(`== ${label}: SHARED Daycare / KG-LP (in both catalogs) -- ${shared.length} dishes`);
    styleLines(shared, SCHOOL_DAYS_4_WEEKS / 2);
    log(`  Daycare only (would drop out of the shared pool): ${daycareOnly.length}  ${JSON.stringify(byStyle(daycareOnly))}`);
    log(`  KG-LP only (would drop out of the shared pool):   ${kgOnly.length}  ${JSON.stringify(byStyle(kgOnly))}`);
    for (const i of [...daycareOnly.map((x) => ['Daycare', x]), ...kgOnly.map((x) => ['KG-LP', x])].slice(0, 40)) {
      log(`      ${i[0].padEnd(8)} ${STYLE_LABEL[i[1].am_snack_style] || 'untagged'}  ${i[1].name}`);
    }
    if (daycareOnly.length + kgOnly.length > 40) log(`      … and ${daycareOnly.length + kgOnly.length - 40} more`);
    const ms = pool(['MS_UP'], category);
    log(`== ${label}: MS-UP (its own) -- ${ms.length} dishes`);
    styleLines(ms, SCHOOL_DAYS_4_WEEKS / 2);
    log('');
  }

  const staff = pool(['STAFF'], 'STAFF_BREAKFAST');
  log(`== Staff Breakfast: Staff's own -- ${staff.length} dishes (2 Pastry + 2 Cold Kitchen of its own every day)`);
  styleLines(staff, SCHOOL_DAYS_4_WEEKS * 2);
  const meatFree = staff.filter((i) => i.protein_type_id && MEAT_FREE.has(getProteinById(i.protein_type_id)?.code));
  log(`  of which meat-free (vegan / vegetarian, 1 needed among the 6 each day): ${meatFree.length}  ${JSON.stringify(byStyle(meatFree))}`);

  const untagged = [['AM_SNACK', ['DAYCARE', 'KG_LP', 'MS_UP']], ['PM_SNACK', ['DAYCARE', 'KG_LP', 'MS_UP']], ['STAFF_BREAKFAST', ['STAFF']]]
    .flatMap(([cat, secs]) => [...new Set(secs.flatMap((s) => pool([s], cat)))].filter((i) => !STYLES.includes(i.am_snack_style)));
  const untaggedUnique = [...new Map(untagged.map((i) => [i.id, i])).values()];
  log(`\nUntagged dishes in scope: ${untaggedUnique.length}`);

  const out = path.join(__dirname, '..', 'backups', 'snack-style-pool-check.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nReport saved: ${out}`);
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
