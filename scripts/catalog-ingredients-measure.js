#!/usr/bin/env node
// Dish Catalog ingredients, phase M1 measurement -- READ-ONLY: how many dishes in real menu uploads are already a Dish
// Catalog dish (exact name within the row's category, lib/catalogIngredients.js), so a saved approved list could replace
// the AI call, how many would still need the AI, and which rows have no usable category. Nothing is written to Supabase.
//
//   cd ~/menu-board && node scripts/catalog-ingredients-measure.js ~/Downloads/tetiana/"September week_0"*.xlsx [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Each file is measured as its own upload, then all of them as
// one upload (Menu Ingredients makes one AI call per dish name across an upload). Report (default):
// backups/catalog-ingredients-measure-<date>.txt
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryById, getCategories, getCategoryByCode } = require('../lib/referenceData');
const { SECTION_SLOTS } = require('../lib/generator');
const { loadWorkbookFromBuffer, parseWorkbookDishes } = require('../lib/menuIngredients');
const { planIngredientLookup } = require('../lib/catalogIngredients');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const inputs = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1)).map((a) => a.replace(/^~(?=$|\/)/, os.homedir()));
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `catalog-ingredients-measure-${new Date().toISOString().slice(0, 10)}.txt`);
if (!inputs.length) { console.error('Usage: node scripts/catalog-ingredients-measure.js <menu.xlsx> [...] [--out report.txt]'); process.exit(2); }

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

// The catalog as the catalog import loads it (main.js loadCatalogForImport), plus the saved list once the M1 migration
// is applied (before that the column doesn't exist and nothing is saved).
async function loadCatalog() {
  let items;
  let migrated = true;
  try {
    items = await fetchAll(() => supabase.from('menu_items').select('id, name, category_id, is_active, ingredients_text').order('id'));
  } catch (err) {
    if (!/ingredients_text/.test(err.message || '')) throw err;
    migrated = false;
    items = await fetchAll(() => supabase.from('menu_items').select('id, name, category_id, is_active').order('id'));
  }
  return { migrated, catalog: items.map((it) => ({ id: it.id, name: it.name, category_code: getCategoryById(it.category_id)?.code, is_active: it.is_active, ingredients_text: it.ingredients_text || null })) };
}
const schoolVocabulary = () => [...new Set(['DAYCARE', 'KG_LP', 'MS_UP'].flatMap((s) => SECTION_SLOTS[s].map(([c]) => c)))].map((c) => getCategoryByCode(c)?.name).filter(Boolean);

const pct = (x, y) => (y ? `${Math.round((100 * x) / y)}%` : '-');
function describe(title, plan) {
  const s = plan.summary;
  const sent = s.rows - s.servedAsIs;
  return [
    `== ${title}`,
    `  rows: ${s.rows} (${s.servedAsIs} served as is: no AI today either)`,
    `  rows matching a catalog dish exactly: ${s.match} of ${sent} (${pct(s.match, sent)})` +
      `${s.matchShared ? `, incl. ${s.matchShared} Staff shared copies` : ''}${s.matchInactive ? `, ${s.matchInactive} on inactive dishes` : ''}`,
    `  rows needing the AI: ${s.new} new to their category + ${s.ambiguous} ambiguous (two catalog spellings) + ${s.unclear} unclear category`,
    `  AI calls (one per dish name): today ${s.calls.today}; with nothing saved yet ${s.calls.today - s.calls.savedNow};` +
      ` if every matched dish had an approved list ${s.calls.today - s.calls.ifAllSaved} (saves ${s.calls.ifAllSaved}, ${pct(s.calls.ifAllSaved, s.calls.today)})`,
  ];
}

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();
  const { migrated, catalog } = await loadCatalog();
  if (!catalog.length) throw new Error('The catalog came back empty -- is the login right? (RLS returns no rows when signed out.)');
  const categories = getCategories().map((c) => ({ code: c.code, name: c.name }));

  const files = [];
  for (const p of inputs) {
    const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(p));
    const { rows } = await parseWorkbookDishes(workbook, schoolVocabulary());
    files.push({ fileName: path.basename(p).replace(/\.xlsx$/i, ''), rows });
  }

  const lines = [
    `Dish Catalog ingredients -- M1 measurement, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only)`,
    `Catalog: ${catalog.length} dishes (${catalog.filter((c) => c.is_active === 0 || c.is_active === false).length} inactive);` +
      ` saved lists: ${migrated ? catalog.filter((c) => c.ingredients_text).length : 'none (the M1 migration is not applied yet)'}`,
    'Matching: exact name within the row\'s category, case / spacing ignored (no fuzzy). Section / category: the catalog import\'s own reading.',
    '',
  ];
  for (const f of files) lines.push(...describe(f.fileName, planIngredientLookup({ files: [f], catalog, categories })), '');
  const all = planIngredientLookup({ files, catalog, categories });
  if (files.length > 1) lines.push(...describe(`All ${files.length} files as one upload`, all), '');

  const bySection = new Map();
  for (const r of all.rows.filter((x) => x.status !== 'servedAsIs')) {
    const k = r.section || '(unknown)';
    if (!bySection.has(k)) bySection.set(k, { match: 0, other: 0 });
    bySection.get(k)[r.status === 'match' ? 'match' : 'other']++;
  }
  lines.push('Match rate by section (rows):');
  for (const [k, v] of bySection) lines.push(`  ${k}: ${v.match} of ${v.match + v.other} (${pct(v.match, v.match + v.other)})`);
  lines.push('');

  const group = (rows, keyOf) => { const m = new Map(); for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const unclear = all.rows.filter((r) => r.status === 'unclear');
  lines.push(`UNCLEAR CATEGORY -- no match possible (${unclear.length} rows):`);
  for (const [reason, rs] of group(unclear, (r) => `${r.section || '?'}: ${r.reason}`)) {
    lines.push(`  ${reason} -- ${rs.length} row(s): ${[...new Set(rs.map((r) => r.dishName))].slice(0, 8).join(' | ')}${rs.length > 8 ? ' ...' : ''}`);
  }
  lines.push('');
  const amb = all.rows.filter((r) => r.status === 'ambiguous');
  lines.push(`AMBIGUOUS -- more than one catalog dish of the name (${amb.length} rows):`);
  for (const [name, rs] of group(amb, (r) => r.dishName)) lines.push(`  ${name} (${rs[0].section}): ${rs[0].candidates.map((c) => `#${c.id} "${c.name}" ${c.categoryCode}`).join(', ')}`);
  lines.push('');
  const fresh = all.rows.filter((r) => r.status === 'new');
  const freshNames = group(fresh, (r) => `${r.section} / ${r.label}`);
  lines.push(`NEW TO THEIR CATEGORY -> AI (${fresh.length} rows, ${new Set(fresh.map((r) => r.dishName.toLowerCase())).size} names), by section / menu label:`);
  for (const [k, rs] of [...freshNames].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${k}: ${rs.length} row(s) -- ${[...new Set(rs.map((r) => r.dishName))].slice(0, 6).join(' | ')}${new Set(rs.map((r) => r.dishName)).size > 6 ? ' ...' : ''}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(lines.slice(0, 4 + files.length * 6 + 7).join('\n'));
  console.log(`\nFull report: ${outPath}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
