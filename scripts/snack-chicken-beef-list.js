#!/usr/bin/env node
// Read-only list of the Dish Catalog's AM / PM Snack dishes that break the chicken / beef rule
// (lib/categoryRules.js: chicken and beef are lunch only -- by protein type or by a whole word in the
// name). Since 2026-09-24 the engine, Build Menu and the AI review screen never put these on a new
// menu; they stay in the catalog until a chef renames them (e.g. a turkey version), moves them to
// another category, or deactivates them. Menus already in History are not touched or flagged.
//
// For each dish: category, sections (portion rows), active or not, protein type, what matched, and
// how often / when it was last served in a saved menu (context only). Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/snack-chicken-beef-list.js
//
// Asks for your login (run it in a normal Terminal window). Report: backups/snack-chicken-beef-list.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryByCode, getAgeGroups, getSectionById, getProteinById } = require('../lib/referenceData');
const { snackLunchOnlyHit, SNACK_CATEGORIES } = require('../lib/categoryRules');

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

const SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };
const CATEGORY_LABEL = { AM_SNACK: 'AM Snack', PM_SNACK: 'PM Snack' };

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const lines = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  const found = [];
  for (const code of SNACK_CATEGORIES) {
    const cat = getCategoryByCode(code);
    const items = await fetchAll(() => supabase.from('menu_items')
      .select('id, name, is_active, protein_type_id, created_by_label').eq('category_id', cat.id).order('id'));
    for (const it of items) {
      const proteinCode = it.protein_type_id ? getProteinById(it.protein_type_id)?.code : null;
      const hit = snackLunchOnlyHit(code, proteinCode, [['name', it.name]]);
      if (hit) found.push({ ...it, category: code, proteinCode, hit });
    }
  }

  // Sections (portion rows) and saved-menu use, for the found dishes only.
  const ids = found.map((f) => f.id);
  const sectionsOf = new Map();
  const servedOf = new Map(); // id -> { count, last }
  if (ids.length) {
    const agSection = new Map(getAgeGroups().map((a) => [a.id, getSectionById(a.section_id)?.code]));
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const portions = await fetchAll(() => supabase.from('item_portions').select('item_id, age_group_id').in('item_id', chunk).order('item_id').order('age_group_id'));
      for (const p of portions) {
        if (!sectionsOf.has(p.item_id)) sectionsOf.set(p.item_id, new Set());
        const s = agSection.get(p.age_group_id);
        if (s) sectionsOf.get(p.item_id).add(s);
      }
      const uses = await fetchAll(() => supabase.from('menu_day_items').select('id, item_id, menu_day_id').in('item_id', chunk).order('id'));
      const dayIds = [...new Set(uses.map((u) => u.menu_day_id))];
      const dateOf = new Map();
      for (let j = 0; j < dayIds.length; j += 200) {
        const days = await fetchAll(() => supabase.from('menu_days').select('id, menu_date').in('id', dayIds.slice(j, j + 200)).order('id'));
        for (const d of days) dateOf.set(d.id, d.menu_date);
      }
      for (const u of uses) {
        const cur = servedOf.get(u.item_id) || { count: 0, last: '' };
        const date = dateOf.get(u.menu_day_id) || '';
        servedOf.set(u.item_id, { count: cur.count + 1, last: date > cur.last ? date : cur.last });
      }
    }
  }

  const active = found.filter((f) => f.is_active === 1);
  const inactive = found.filter((f) => f.is_active !== 1);
  log(`Chicken / beef in AM / PM Snack -- ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  log(`${found.length} catalog snack dish(es) break the rule: ${active.length} active (these would have been picked before the`);
  log(`rule; now never put on a new menu), ${inactive.length} already inactive. Saved History menus are unchanged.`);
  log('Fix in the Dish Catalog: rename (e.g. a turkey version), move to another category, or deactivate.\n');
  const row = (f) => {
    const secs = [...(sectionsOf.get(f.id) || [])].map((s) => SECTION_LABEL[s] || s).sort().join(', ') || 'no section';
    const used = servedOf.get(f.id);
    const why = f.hit.field === 'protein_code' ? `protein type ${f.proteinCode}` : `"${f.hit.term}" in the name`;
    return `  #${String(f.id).padEnd(6)} ${f.name}\n          ${CATEGORY_LABEL[f.category]} | ${secs} | ${why}${f.proteinCode && f.hit.field !== 'protein_code' ? ` (protein type ${f.proteinCode})` : ''} | ` +
      `${used ? `served ${used.count}x, last ${used.last}` : 'never served'}${f.created_by_label ? ` | created by ${f.created_by_label}` : ''}`;
  };
  for (const [title, list] of [['ACTIVE', active], ['INACTIVE (already not offered)', inactive]]) {
    log(`== ${title}: ${list.length}`);
    for (const code of SNACK_CATEGORIES) {
      const ofCat = list.filter((f) => f.category === code).sort((a, b) => a.name.localeCompare(b.name));
      if (!ofCat.length) continue;
      log(`-- ${CATEGORY_LABEL[code]} (${ofCat.length})`);
      for (const f of ofCat) log(row(f));
    }
    log('');
  }

  const out = path.join(__dirname, '..', 'backups', 'snack-chicken-beef-list.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`Report saved: ${out}`);
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
