#!/usr/bin/env node
// Dish Catalog / Recipe Book / ingredients unification, phase U0 -- READ-ONLY measurement. Nothing is written to
// Supabase. Sizes the work and informs the safety design before anything is built:
//   A. Dish Catalog codes: how many dishes carry an RC (or any) code, by prefix, repeats -- the size of the RC removal.
//   B. Dish names stored under two or more categories (D3: one recipe can't carry two dishes' codes).
//   C. The three recipe stores: counts, code formats, and how each recipe's name matches the catalog (exactly one dish /
//      several / none) -- how linking recipes to dishes by exact name would go.
//   D. The ingredient master lists (ingredients, extracted_ingredients): naming conventions and inconsistencies --
//      spellings that differ only by case / spacing / punctuation, singular vs plural, word order, descriptor words
//      ("fresh", "chopped"...), sizes / brands written into the name -- with real examples.
//   E. What exact matching would do: every distinct ingredient name in generated and extracted recipes against the
//      master list -- exact (case / spacing aside), only after a looser tidy, or not at all (would need a new row).
//
//   cd ~/menu-board && node scripts/unification-measure.js [--out report.txt]
//
// Asks for your login (run it in a normal Terminal window). Report (default): backups/unification-measure-<date>.txt
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { loadReferenceData, getCategoryById } = require('../lib/referenceData');

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `unification-measure-${new Date().toISOString().slice(0, 10)}.txt`);

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
const unreadable = [];
async function fetchAll(table, cols, optional = false, order = 'id') {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(order).range(from, from + 999);
    if (error) { if (optional) { console.warn(`(could not read ${table}: ${error.message})`); unreadable.push(`${table}: ${error.message}`); return null; } throw new Error(`${table}: ${error.message}`); }
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// ---- name keys, strict to loose --------------------------------------------------------------------------------
const exactKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); // the matching rule (case / spacing)
const punctKey = (s) => exactKey(s).replace(/[^a-z0-9؀-ۿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w) => (w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /(ches|shes|sses|xes|oes)$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
const pluralKey = (s) => punctKey(s).split(' ').map(singular).join(' ');
const orderKey = (s) => pluralKey(s).split(' ').sort().join(' ');
const DESCRIPTORS = new Set(['fresh', 'chopped', 'minced', 'ground', 'dried', 'dry', 'raw', 'frozen', 'whole', 'large', 'small', 'medium', 'sliced', 'diced',
  'grated', 'shredded', 'boneless', 'skinless', 'peeled', 'cooked', 'canned', 'tinned', 'plain', 'natural', 'organic', 'extra', 'virgin', 'fine', 'coarse',
  'powder', 'powdered', 'crushed', 'unsalted', 'salted', 'low', 'fat', 'full', 'cream', 'light', 'pure', 'of', 'the', 'and', 'with', 'in']);
const looseKey = (s) => orderKey(s).split(' ').filter((w) => w && !DESCRIPTORS.has(w)).join(' ') || orderKey(s);
const SIZE_OR_BRAND = /\b\d+(\.\d+)?\s*(g|gm|gr|kg|ml|l|ltr|lb|oz|pcs?|x)\b|\d+\s*%|\(.*\)/i;

function groupsBy(names, keyFn, prevKeyFn) {
  const m = new Map();
  for (const n of names) { const k = keyFn(n); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(n); }
  // a group counts at this level only if its members differ by something the previous (stricter) key didn't catch
  return [...m.values()].map((s) => [...s]).filter((g) => g.length > 1 && (!prevKeyFn || new Set(g.map(prevKeyFn)).size > 1));
}
const show = (groups, n = 12) => groups.slice(0, n).map((g) => `    ${g.map((x) => `"${x}"`).join('  |  ')}`);

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();
  const L = [`Unification -- U0 measurement, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (read-only)`, ''];

  // ---- A. Dish Catalog codes -----------------------------------------------------------------------------------
  const items = (await fetchAll('menu_items', 'id, name, category_id, is_active, rc_code')).map((it) => ({ ...it, cat: getCategoryById(it.category_id)?.code || '?' }));
  if (!items.length) throw new Error('The catalog came back empty -- is the login right? (RLS returns no rows when signed out.)');
  const coded = items.filter((it) => String(it.rc_code || '').trim());
  const prefix = (c) => { const m = String(c).trim().match(/^[A-Za-z]+/); return m ? m[0].toUpperCase() : '(starts with a digit / symbol)'; };
  const byPrefix = new Map();
  for (const it of coded) byPrefix.set(prefix(it.rc_code), (byPrefix.get(prefix(it.rc_code)) || 0) + 1);
  const codeUse = new Map();
  for (const it of coded) { const k = it.rc_code.trim().toUpperCase(); codeUse.set(k, [...(codeUse.get(k) || []), it]); }
  const repeated = [...codeUse.entries()].filter(([, v]) => v.length > 1);
  L.push('A. DISH CATALOG CODES',
    `  dishes: ${items.length} (${items.filter((i) => !i.is_active).length} inactive); with a code: ${coded.length}; blank: ${items.length - coded.length}`,
    `  by prefix: ${[...byPrefix.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`,
    `  examples: ${coded.slice(0, 12).map((i) => i.rc_code).join(', ')}`,
    `  the same code on more than one dish: ${repeated.length}${repeated.length ? ` -- e.g. ${repeated.slice(0, 6).map(([c, v]) => `${c}: ${v.map((x) => `#${x.id} ${x.name}`).join(' / ')}`).join('; ')}` : ''}`, '');

  // ---- B. one name, several categories ------------------------------------------------------------------------
  const byName = new Map();
  for (const it of items) { const k = exactKey(it.name); byName.set(k, [...(byName.get(k) || []), it]); }
  const multiCat = [...byName.values()].filter((v) => new Set(v.map((x) => x.cat)).size > 1);
  const sameCatDup = [...byName.values()].filter((v) => v.length > new Set(v.map((x) => x.cat)).size);
  L.push('B. ONE DISH NAME, SEVERAL CATALOG ENTRIES (D3)',
    `  names under 2+ categories: ${multiCat.length} (${multiCat.reduce((s, v) => s + v.length, 0)} catalog entries)`,
    ...multiCat.slice(0, 15).map((v) => `    ${v[0].name}: ${v.map((x) => `#${x.id} ${x.cat}${x.is_active ? '' : ' (inactive)'}`).join(', ')}`),
    `  names stored twice in the SAME category (case / spacing): ${sameCatDup.length}`, '');

  // ---- C. recipe stores ----------------------------------------------------------------------------------------
  const book = await fetchAll('recipes', 'id, code, name');
  const extracted = await fetchAll('extracted_recipes', 'id, code, name', true);
  const generated = await fetchAll('generated_recipes', 'id, code, status, name, source_dish_name');
  // The REAL codes (an earlier version printed only their shape, digits masked as 9 -- "TTY-99999 x3" meant three codes
  // of the form TTY-#####, which read like one repeated placeholder): lowest, highest, how many repeat, and a few.
  const codeShapes = (rows) => {
    const codes = rows.map((r) => r.code).filter(Boolean);
    if (!codes.length) return '(none)';
    const sorted = [...codes].sort();
    const seen = new Map(); for (const c of codes) seen.set(c, (seen.get(c) || 0) + 1);
    const rep = [...seen.entries()].filter(([, n]) => n > 1);
    return `${codes.length} coded, ${seen.size} distinct, lowest ${sorted[0]}, highest ${sorted[sorted.length - 1]}${rep.length ? `, REPEATED: ${rep.slice(0, 5).map(([c, n]) => `${c} x${n}`).join(', ')}` : ', none repeated'}; e.g. ${sorted.slice(0, 6).join(', ')}`;
  };
  const linkability = (rows, nameOf) => {
    const r = { one: 0, several: 0, none: 0, severalEx: [], noneEx: [] };
    for (const x of rows) {
      const hits = byName.get(exactKey(nameOf(x))) || [];
      if (hits.length === 1) r.one++; else if (hits.length > 1) { r.several++; r.severalEx.push(`${nameOf(x)} (${hits.map((h) => h.cat).join(', ')})`); } else { r.none++; r.noneEx.push(nameOf(x)); }
    }
    return r;
  };
  const conf = generated.filter((g) => g.status === 'confirmed');
  L.push('C. RECIPE STORES AND THEIR LINK TO THE CATALOG (exact name, case / spacing aside)');
  for (const [label, rows, nameOf] of [['Recipe Book (recipes)', book, (x) => x.name], ['Recipe Extractor (extracted_recipes)', extracted || [], (x) => x.name],
    ['Recipe Generator, confirmed', conf, (x) => x.source_dish_name || x.name], ['Recipe Generator, drafts', generated.filter((g) => g.status === 'draft'), (x) => x.source_dish_name || x.name]]) {
    const k = linkability(rows, nameOf);
    L.push(`  ${label}: ${rows.length}; codes ${codeShapes(rows)}`,
      `    one catalog dish: ${k.one}; several: ${k.several}${k.severalEx.length ? ` (e.g. ${k.severalEx.slice(0, 4).join('; ')})` : ''}; none: ${k.none}${k.noneEx.length ? ` (e.g. ${k.noneEx.slice(0, 5).join('; ')})` : ''}`);
  }
  const rgOnDishes = coded.filter((i) => /^RG-/i.test(i.rc_code.trim()));
  const genByCode = new Map(generated.filter((g) => g.code).map((g) => [g.code.toUpperCase(), g]));
  L.push(`  dishes carrying an RG- code: ${rgOnDishes.length}; of those, the code is a confirmed generated recipe's: ${rgOnDishes.filter((i) => genByCode.has(i.rc_code.trim().toUpperCase())).length}`, '');

  // ---- D. ingredient master lists -------------------------------------------------------------------------------
  const master = await fetchAll('ingredients', 'id, product_code, name, default_unit, category');
  const exIngr = await fetchAll('extracted_ingredients', 'id, product_code, name, default_unit', true) || [];
  for (const [label, rows] of [['ingredients (Recipe Book master)', master], ['extracted_ingredients (Recipe Extractor)', exIngr]]) {
    const names = rows.map((r) => r.name).filter(Boolean);
    const style = { upper: 0, title: 0, lower: 0, mixed: 0 };
    for (const n of names) { if (n === n.toUpperCase() && /[A-Z]/.test(n)) style.upper++; else if (n === n.toLowerCase()) style.lower++; else if (n.split(' ').every((w) => !/[a-z]/.test(w[0] || ''))) style.title++; else style.mixed++; }
    const g1 = groupsBy(names, exactKey);
    const g2 = groupsBy(names, punctKey, exactKey);
    const g3 = groupsBy(names, pluralKey, punctKey);
    const g4 = groupsBy(names, orderKey, pluralKey);
    const g5 = groupsBy(names, looseKey, orderKey);
    const sized = names.filter((n) => SIZE_OR_BRAND.test(n));
    const prefixes = new Map();
    for (const r of rows) { const p = String(r.product_code || '').match(/^[A-Za-z]+(-[A-Za-z]+)?/); const k = p ? p[0].toUpperCase() : '(blank)'; prefixes.set(k, (prefixes.get(k) || 0) + 1); }
    const units = new Map();
    for (const r of rows) { const u = String(r.default_unit || '(blank)').trim().toUpperCase(); units.set(u, (units.get(u) || 0) + 1); }
    L.push(`D. ${label.toUpperCase()}: ${rows.length} rows`,
      `  product codes: ${[...prefixes.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`,
      `  default units: ${[...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, n]) => `${u} ${n}`).join(', ')}`,
      `  writing style: ALL CAPS ${style.upper}, Title Case ${style.title}, lower case ${style.lower}, mixed ${style.mixed}`,
      `  random sample: ${[...names].sort(() => 0.5 - Math.random()).slice(0, 25).map((n) => `"${n}"`).join(', ')}`,
      `  same name, case / spacing only: ${g1.length} group(s)`, ...show(g1),
      `  + punctuation / hyphens / brackets: ${g2.length}`, ...show(g2),
      `  + singular vs plural: ${g3.length}`, ...show(g3),
      `  + word order: ${g4.length}`, ...show(g4),
      `  + descriptor words (fresh, chopped, ground, dried...): ${g5.length} -- may be genuinely different products`, ...show(g5, 20),
      `  sizes / percentages / brackets inside the name: ${sized.length}${sized.length ? ` -- e.g. ${sized.slice(0, 10).map((n) => `"${n}"`).join(', ')}` : ''}`, '');
  }
  const masterExact = new Set(master.map((m) => exactKey(m.name)));
  const masterLoose = new Map(master.map((m) => [looseKey(m.name), m.name]));
  const crossEx = exIngr.filter((e) => masterExact.has(exactKey(e.name))).length;
  L.push(`  extracted_ingredients already in the master by exact name: ${crossEx} of ${exIngr.length}`, '');

  // ---- E. what exact matching would do to recipe ingredients ---------------------------------------------------
  const genIngr = await fetchAll('generated_recipe_ingredients', 'id, name');
  // Its column is extracted_ingredient_id (not Recipe Book's ingredient_id); the process link is extracted_recipe_process_id.
  const exUse = (await fetchAll('extracted_recipe_ingredients', 'id, extracted_ingredient_id', true) || []).map((u) => ({ ingredient_id: u.extracted_ingredient_id }));
  const exNameById = new Map(exIngr.map((e) => [e.id, e.name]));
  for (const [label, names] of [['generated recipes (free text)', genIngr.map((g) => g.name)], ['extracted recipes', exUse.map((u) => exNameById.get(u.ingredient_id)).filter(Boolean)]]) {
    // One entry per name, case / spacing aside ("Salt" and "salt" are ONE name; an earlier version listed them twice,
    // each with the combined count).
    const spell = new Map(); const freq = new Map();
    for (const n of names) { const k = exactKey(n); freq.set(k, (freq.get(k) || 0) + 1); if (!spell.has(k)) spell.set(k, new Set()); spell.get(k).add(n.trim()); }
    const keys = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a));
    const label1 = (k) => `"${[...spell.get(k)].join('" / "')}" x${freq.get(k)}`;
    const exact = keys.filter((k) => masterExact.has(k));
    const loose = keys.filter((k) => !masterExact.has(k) && masterLoose.has(looseKey(k)));
    const none = keys.filter((k) => !masterExact.has(k) && !masterLoose.has(looseKey(k)));
    const rowsOf = (ks) => ks.reduce((s, k) => s + freq.get(k), 0);
    let cum = 0; const cover = [50, 80, 90, 95].map((p) => { let i = 0; cum = 0; while (i < keys.length && cum < (p / 100) * names.length) cum += freq.get(keys[i++]); return `${p}% of rows: ${i} names`; });
    const words = (k) => k.split(/[^a-z]+/).filter((w) => w.length > 2);
    const masterHolding = (k) => master.filter((m) => words(k).every((w) => exactKey(m.name).split(/[^a-z]+/).map(singular).includes(singular(w)))).map((m) => m.name);
    L.push(`E. ${label.toUpperCase()}: ${names.length} ingredient rows, ${keys.length} distinct names (case / spacing aside)`,
      `  how concentrated: ${cover.join(', ')}`,
      `  exact match in the master: ${exact.length} names, ${rowsOf(exact)} rows -- ${exact.slice(0, 15).map(label1).join(', ')}`,
      `  no exact match, a looser tidy finds one: ${loose.length} names, ${rowsOf(loose)} rows -- e.g. ${loose.slice(0, 12).map((k) => `${label1(k)} ~ "${masterLoose.get(looseKey(k))}"`).join('; ')}`,
      `  nothing at all: ${none.length} names, ${rowsOf(none)} rows`,
      '  the 30 most-used names and what the master list holds containing all their words:',
      ...keys.slice(0, 30).map((k) => { const h = masterHolding(k); return `    ${label1(k)} -> ${masterExact.has(k) ? 'EXACT' : h.length ? h.slice(0, 6).map((x) => `"${x}"`).join(', ') + (h.length > 6 ? ` +${h.length - 6}` : '') : '(nothing)'}`; }), '');
  }
  if (unreadable.length) L.push('TABLES THAT COULD NOT BE READ (their numbers above are missing):', ...unreadable.map((u) => `  ${u}`), '');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nReport: ${outPath}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
