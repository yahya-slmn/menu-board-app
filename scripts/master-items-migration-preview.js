#!/usr/bin/env node
// Master Items + Dish Variants -- READ-ONLY preview of the migration (lib/masterItemsPlan.js), on the live Dish Catalog,
// before anything is built: how many master items and variants it would make, and EXACTLY where each of the saved
// ingredient lists (M2) would go -- one line per list. Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/master-items-migration-preview.js [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Report (default):
// backups/master-items-migration-preview-<date>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryById, getSections, getAgeGroupsForSection } = require('../lib/referenceData');
const { planMasterItems, variantDisplayName } = require('../lib/masterItemsPlan');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `master-items-migration-preview-${new Date().toISOString().slice(0, 10)}.txt`);

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
  const items = await fetchAll('menu_items', 'id, name, category_id, is_active, ingredients_text, allergens_text, ingredients_updated_at, ingredients_updated_by, ingredients_source');
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
  const rows = items.map((it) => ({ ...it, category_name: getCategoryById(it.category_id)?.name || '?', sections: [...(sectionsOf.get(it.id) || [])] }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { masters, stats } = planMasterItems(rows);
  const s = stats;
  const L = [`Master Items + Dish Variants -- migration preview, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only)`, '',
    `Dish Catalog rows: ${s.rows} -> master items: ${s.masters}, dish variants: ${s.variants} (${s.mastersWithSeveralVariants} master items get 2+ variants)`,
    `Saved ingredient lists: ${s.listsSaved}; carried onto variants: ${s.listsCarried} (${s.listsSaved === s.listsCarried ? 'every one' : 'MISMATCH'}); variants holding a list: ${s.variantsWithList}`,
    `Rows without a list that join their name's only (listed) variant: ${s.rowsJoiningAListedVariant} -- from then on Menu Ingredients would serve them that list`,
    `Rows left for the chef to pick a variant (their name has 2+ different lists): ${s.rowsToPick}`, '',
    'EVERY SAVED LIST, WHERE IT GOES:'];
  for (const m of masters) {
    const listed = m.variants.filter((v) => v.list);
    if (!listed.length) continue;
    L.push(`  ${m.name}  (${m.rowCount} catalog row(s), ${m.variants.length} variant(s))`);
    for (const v of m.variants) {
      if (!v.list) continue;
      const joined = v.rowIds.filter((idd) => !v.list.fromRowIds.includes(idd));
      L.push(`    variant "${variantDisplayName({ sections: v.sections, date: v.date, createdAt: new Date().toISOString() })}" (${v.label}): list from row(s) ${v.list.fromRowIds.map((x) => `#${x}`).join(', ')}${v.list.fromRowIds.length > 1 ? ' (identical lists, one kept)' : ''}` +
        `${joined.length ? `; also used by row(s) without a list: ${joined.map((x) => `#${x} ${byId.get(x).category_name}`).join(', ')}` : ''}`);
      L.push(`      "${String(v.list.ingredients).slice(0, 110)}${String(v.list.ingredients).length > 110 ? '…' : ''}"  [${v.list.updatedBy || '?'}, ${String(v.list.updatedAt || '').slice(0, 10)}]`);
    }
    if (m.unassigned.length) L.push(`    to pick: ${m.unassigned.map((x) => `#${x} ${byId.get(x).category_name} [${byId.get(x).sections.join(', ')}]`).join(', ')}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.slice(0, 7).join('\n'));
  console.log(`\nEvery list, one by one: ${outPath}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
