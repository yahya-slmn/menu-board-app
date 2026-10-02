#!/usr/bin/env node
// Master Items -- READ-ONLY measurement before the design is fixed. Groups every Dish Catalog row (menu_items) by its
// EXACT name (case / spacing aside -- the matching rule used everywhere) and classifies each name by HOW it is
// duplicated, from real data:
//   single           -- one catalog row
//   cross-section    -- several rows, but every section has exactly ONE category for it (e.g. a school Lunch Main and
//                       its Staff Main Dish copy): section checkboxes alone would describe it
//   within-section   -- some section has the name under TWO+ categories (e.g. MS-UP: Lunch Starch AND Lunch Vegetable;
//                       Staff: Salad AND Main Dish): section checkboxes alone would LOSE this
//   same-category    -- the same name stored twice in one category (spelling duplicates)
// A row's sections come from its item_portions (age group -> section), as the engine uses them. Also sizes what a merge into
// one master row would have to reconcile: rows of one name whose saved ingredient lists differ, or whose calories differ.
// Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/master-items-measure.js [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Report (default): backups/master-items-measure-<date>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryById, getSections, getAgeGroupsForSection } = require('../lib/referenceData');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `master-items-measure-${new Date().toISOString().slice(0, 10)}.txt`);
const key = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const listKey = (s) => String(s ?? '').split(' - ').map((x) => key(x)).filter(Boolean).sort().join('|');

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
async function fetchAll(table, cols, order = 'id') {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(order).range(from, from + 999);
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
  await loadReferenceData();

  let items;
  try { items = await fetchAll('menu_items', 'id, name, category_id, is_active, calories_per_100g, ingredients_text'); }
  catch { items = (await fetchAll('menu_items', 'id, name, category_id, is_active, calories_per_100g')).map((i) => ({ ...i, ingredients_text: null })); }
  if (!items.length) throw new Error('The catalog came back empty -- is the login right?');
  const sectionOfAg = new Map();
  for (const s of getSections()) for (const ag of getAgeGroupsForSection(s.id)) sectionOfAg.set(ag.id, s.code);
  const sectionsOf = new Map();
  for (const p of await fetchAll('item_portions', 'item_id, age_group_id', 'item_id')) {
    const sec = sectionOfAg.get(p.age_group_id);
    if (!sec) continue;
    if (!sectionsOf.has(p.item_id)) sectionsOf.set(p.item_id, new Set());
    sectionsOf.get(p.item_id).add(sec);
  }
  const rows = items.map((it) => ({ ...it, cat: getCategoryById(it.category_id)?.code || '?', catName: getCategoryById(it.category_id)?.name || '?', sections: [...(sectionsOf.get(it.id) || [])] }));

  const groups = new Map();
  for (const r of rows) { const k = key(r.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const classes = { single: [], 'cross-section': [], 'within-section': [], 'same-category': [] };
  const conflicts = { lists: [], calories: [] };
  for (const [, g] of groups) {
    if (g.length === 1) { classes.single.push(g); continue; }
    const cats = new Set(g.map((r) => r.cat));
    if (cats.size < g.length) classes['same-category'].push(g);
    // per section: which categories does this name appear under?
    const perSection = new Map();
    for (const r of g) for (const s of r.sections) { if (!perSection.has(s)) perSection.set(s, new Set()); perSection.get(s).add(r.cat); }
    if ([...perSection.values()].some((c) => c.size > 1)) classes['within-section'].push(g);
    else if (cats.size === g.length) classes['cross-section'].push(g);
    const lists = new Set(g.map((r) => listKey(r.ingredients_text)).filter(Boolean));
    if (lists.size > 1) conflicts.lists.push(g);
    const cals = new Set(g.map((r) => r.calories_per_100g).filter((c) => c != null));
    if (cals.size > 1) conflicts.calories.push(g);
  }
  const show = (g) => `    ${g[0].name}: ${g.map((r) => `#${r.id} ${r.catName} [${r.sections.join(', ') || 'no section'}]${r.is_active ? '' : ' (inactive)'}`).join('  |  ')}`;
  const L = [`Master Items -- measurement, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only)`, '',
    `Dish Catalog rows: ${rows.length}; distinct names (case / spacing aside) = master rows if grouped by exact name: ${groups.size}`,
    `Rows with no section at all (no portions): ${rows.filter((r) => !r.sections.length).length}`, '',
    `  single:          ${classes.single.length} names`,
    `  cross-section:   ${classes['cross-section'].length} names -- each section has ONE category for it (section checkboxes describe it)`,
    `  within-section:  ${classes['within-section'].length} names -- a section has it under 2+ categories (section checkboxes alone LOSE this)`,
    `  same-category:   ${classes['same-category'].length} names -- stored twice in one category`, '',
    'WITHIN-SECTION, every one:', ...classes['within-section'].map(show), '',
    'SAME-CATEGORY, every one:', ...classes['same-category'].map(show), '',
    'CROSS-SECTION, the first 25:', ...classes['cross-section'].slice(0, 25).map(show), '',
    'Category pairs behind the cross-section names (how often):'];
  const pairs = new Map();
  for (const g of classes['cross-section']) { const p = [...new Set(g.map((r) => r.catName))].sort().join(' + '); pairs.set(p, (pairs.get(p) || 0) + 1); }
  L.push(...[...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([p, n]) => `    ${n} x ${p}`), '',
    'WHAT ONE MASTER ROW PER NAME WOULD HAVE TO RECONCILE:',
    `  names whose rows have DIFFERENT saved ingredient lists: ${conflicts.lists.length}`, ...conflicts.lists.slice(0, 15).map((g) => `    ${g[0].name}: ${g.filter((r) => r.ingredients_text).map((r) => `#${r.id} "${String(r.ingredients_text).slice(0, 70)}"`).join('  |  ')}`),
    `  names whose rows have DIFFERENT calories: ${conflicts.calories.length}`, ...conflicts.calories.slice(0, 15).map((g) => `    ${g[0].name}: ${g.map((r) => `#${r.id} ${r.catName} ${r.calories_per_100g ?? '-'}`).join('  |  ')}`),
    `  rows with a saved ingredient list: ${rows.filter((r) => String(r.ingredients_text || '').trim()).length}; with calories: ${rows.filter((r) => r.calories_per_100g != null).length}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nReport: ${outPath}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
