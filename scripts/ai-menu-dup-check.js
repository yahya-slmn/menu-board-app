#!/usr/bin/env node
// Read-only diagnostic for the AI Menu Generator's catalog duplicate check. For one draft run, it
// re-runs the exact check the generator uses (findDuplicateMatch, same category) against the Dish
// Catalog, and ALSO a looser word-overlap comparison, to show whether dishes that are really the
// same as a catalog item are slipping through under different wording. Nothing is written to
// Supabase.
//
//   cd ~/menu-board && node scripts/ai-menu-dup-check.js <run id>
//
// Asks for your login (run it in a normal Terminal window). Report: backups/ai-menu-dup-check-<run id>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryByCode, getCategoryById } = require('../lib/referenceData');
const { findDuplicateMatch, emptyDishIndex, addNameToIndex } = require('../lib/recipeGenerator');

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

// Word-set comparison, independent of order and filler words: "Chicken Shawarma Rice Bowl" vs
// "Shawarma Chicken with Rice" -> {chicken, shawarma, rice, bowl} vs {shawarma, chicken, rice}.
const STOP = new Set(['with', 'and', 'in', 'of', 'the', 'a', 'on', 'style', 'mini', 'side', 'served', 'fresh', 'homemade', 'classic', 'dish', 'plate', 'cup', 'cups', 'bites']);
function tokens(name) {
  return new Set(name.toLowerCase().replace(/&/g, ' ').replace(/[^a-z؀-ۿ\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)));
}
function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return { jaccard: 0, contained: 0 };
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), contained: inter / Math.min(A.size, B.size) };
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

(async () => {
  const runId = Number(process.argv[2]);
  if (!runId) { console.error('Usage: node scripts/ai-menu-dup-check.js <run id>'); process.exit(1); }
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const lines = [];
  const log = (s = '') => { lines.push(s); console.log(s); };

  const dishes = await fetchAll(() => supabase.from('ai_menu_draft_dishes').select('id, name, category_code, resolution, dup_match_item_id, dup_match_type').eq('run_id', runId).order('id'));
  const catCodes = [...new Set(dishes.map((d) => d.category_code))];
  const catalog = await fetchAll(() => supabase.from('menu_items').select('id, name, category_id, is_active').order('id'));
  log(`Run ${runId}: ${dishes.length} draft dishes, ${dishes.filter((d) => d.resolution === 'link').length} linked. Catalog: ${catalog.length} items (${catalog.filter((i) => i.is_active).length} active).`);

  log('\nCatalog size per AI category (active / all):');
  for (const code of catCodes) {
    const cid = getCategoryByCode(code).id;
    const rows = catalog.filter((i) => i.category_id === cid);
    log(`  ${code}: ${rows.filter((i) => i.is_active).length} / ${rows.length}`);
  }

  // 1. Re-run the generator's own check, to confirm it behaves as designed on real names.
  const indexByCat = new Map();
  for (const it of catalog) {
    if (!indexByCat.has(it.category_id)) indexByCat.set(it.category_id, emptyDishIndex());
    addNameToIndex(indexByCat.get(it.category_id), it.name);
  }
  let exactAgain = 0, similarAgain = 0, disagree = 0;
  for (const d of dishes) {
    const m = findDuplicateMatch(d.name, indexByCat.get(getCategoryByCode(d.category_code).id) || emptyDishIndex());
    if (m && m.matchType === 'exact') exactAgain++;
    if (m && m.matchType === 'similar') similarAgain++;
    // A stored "new" dish that now matches means the check missed it at generation time.
    if (m && d.resolution !== 'link') { disagree++; log(`  MISSED AT GENERATION: ${d.category_code} "${d.name}" ~ "${m.matchedName}" (${m.matchType})`); }
  }
  log(`\nfindDuplicateMatch re-run: ${exactAgain} exact, ${similarAgain} similar; ${disagree} disagreement(s) with what was stored.`);

  // 2. Looser word-overlap: likely same-dish pairs the strict check can't see.
  log('\nClosest catalog item per draft dish by word overlap (same category), strongest first:');
  const rows = [];
  for (const d of dishes) {
    if (d.resolution === 'link') continue;
    const cid = getCategoryByCode(d.category_code).id;
    let best = null;
    for (const it of catalog) {
      if (it.category_id !== cid) continue;
      const o = overlap(d.name, it.name);
      if (!best || o.jaccard > best.o.jaccard) best = { it, o };
    }
    if (best) rows.push({ d, ...best });
  }
  rows.sort((a, b) => b.o.jaccard - a.o.jaccard);
  const buckets = { '>= 0.75': 0, '0.5 - 0.75': 0, '< 0.5': 0 };
  for (const r of rows) {
    if (r.o.jaccard >= 0.75) buckets['>= 0.75']++; else if (r.o.jaccard >= 0.5) buckets['0.5 - 0.75']++; else buckets['< 0.5']++;
  }
  log(`  word-overlap buckets (Jaccard): ${JSON.stringify(buckets)}`);
  for (const r of rows.filter((x) => x.o.jaccard >= 0.4).slice(0, 60)) {
    log(`  ${r.o.jaccard.toFixed(2)}  ${r.d.category_code}: "${r.d.name}"  vs  "${r.it.name}"${r.it.is_active ? '' : ' (retired)'}`);
  }

  // 3. Same name in a DIFFERENT category (the check is same-category only by design).
  log('\nExact name matches in a different category (not linked by design):');
  const byNorm = new Map();
  for (const it of catalog) {
    const k = it.name.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(it);
  }
  let cross = 0;
  for (const d of dishes) {
    const hits = (byNorm.get(d.name.toLowerCase().trim().replace(/\s+/g, ' ')) || []).filter((it) => it.category_id !== getCategoryByCode(d.category_code).id);
    for (const it of hits) { cross++; log(`  ${d.category_code} "${d.name}" = catalog item ${it.id} in ${getCategoryById(it.category_id)?.code}`); }
  }
  if (!cross) log('  none');

  const out = path.join(__dirname, '..', 'backups', `ai-menu-dup-check-${runId}.txt`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nReport saved to ${out}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
