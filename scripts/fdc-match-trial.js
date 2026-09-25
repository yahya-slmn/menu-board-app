#!/usr/bin/env node
// USDA FoodData Central match trial (Nutrition Review, Phase 0, 2026-09-25). Read-only: nothing is
// written to Supabase. Measures how often a school dish's NAME finds a usable USDA match before the
// review screen is built.
//
// Takes ~50 active Daycare / KG-LP / MS-UP dishes (spread evenly over the categories, same sample
// every run), searches USDA for each name twice through the fdc-food Edge Function -- once across
// FNDDS + SR Legacy + Foundation, once FNDDS only (prepared / mixed dishes) -- and writes up to 8
// candidates per dish with their calories and core nutrients per 100 g. About 2 USDA requests a dish
// (limit: 1,000 an hour).
//
//   cd ~/menu-board && node scripts/fdc-match-trial.js            # asks for your login
//   node scripts/fdc-match-trial.js --n 80                        # a bigger sample
//
// Report: backups/fdc-match-trial.xlsx (+ .txt summary). In the workbook, mark each candidate that
// fits in "Verdict" (Exact / Close / Stand-in; leave blank if none fits), then score the marked copy:
//
//   node scripts/fdc-match-trial.js --score backups/fdc-match-trial.xlsx   # no login needed
//
// --out <dir> writes the reports somewhere other than backups/.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ExcelJS = require('exceljs');
const { extractPanel, DATA_TYPE_SHORT } = require('../lib/nutritionPanel');

const FNDDS = 'Survey (FNDDS)';
const MAX_SHOWN = 8;        // candidates written per dish
const FROM_COMBINED = 5;    // ...the combined search's top 5, then FNDDS-only results not already shown
const VERDICTS = ['Exact', 'Close', 'Stand-in'];
const VERDICT_RANK = { Exact: 3, Close: 2, 'Stand-in': 1 };
const SHEET = 'Review';
const COLS = {
  dishId: 1, dish: 2, category: 3, sections: 4, current: 5, rank: 6, foundBy: 7, dataset: 8, description: 9,
  kcal: 10, protein: 11, fat: 12, carbs: 13, fiber: 14, sugars: 15, sodium: 16, delta: 17, fdcId: 18, verdict: 19, notes: 20,
};
const SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP' };

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

// ---- matching signals (automatic proxies only; the chef's Verdict is the real measure) ----------

const STOPWORDS = new Set(['and', 'with', 'the', 'of', 'in', 'on', 'a', 'an', 'style', 'mini', 'homemade', 'fresh']);
function contentWords(text) {
  return (text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
// Share of the dish name's words that the USDA description contains (0-1).
function wordCoverage(dishName, description) {
  const dish = [...new Set(contentWords(dishName))];
  if (!dish.length) return 0;
  const desc = new Set(contentWords(description));
  return dish.filter((w) => desc.has(w)).length / dish.length;
}

// Combined top 5, then FNDDS-only results not already shown, up to MAX_SHOWN.
function mergeCandidates(combined, fnddsOnly) {
  const out = [];
  const seen = new Set();
  const add = (food, foundBy) => {
    if (out.length >= MAX_SHOWN || seen.has(food.fdcId)) return;
    seen.add(food.fdcId);
    out.push({ ...food, foundBy, panel: extractPanel(food.nutrients) });
  };
  combined.slice(0, FROM_COMBINED).forEach((f) => add(f, 'All datasets'));
  fnddsOnly.forEach((f) => add(f, 'FNDDS only'));
  combined.slice(FROM_COMBINED).forEach((f) => add(f, 'All datasets'));
  return out;
}

function kcalDelta(candidateKcal, currentKcal) {
  if (candidateKcal == null || currentKcal == null || currentKcal <= 0) return null;
  return (candidateKcal - currentKcal) / currentKcal;
}

// [{ id, name, category, sections, calories, unverified }] -- every active dish with a portion row in
// Daycare / KG-LP / MS-UP. Own loader (not calorieReview.js's) so this branch stands on main alone.
async function loadSchoolDishes(supabase) {
  const { getSectionByCode, getAgeGroupsForSection, getCategoryById } = require('../lib/referenceData');
  const fetchAll = async (buildQuery) => {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await buildQuery().range(from, from + 999);
      if (error) throw new Error(error.message);
      all.push(...data);
      if (data.length < 1000) return all;
    }
  };
  const sectionOfAgeGroup = new Map();
  for (const code of Object.keys(SECTION_LABEL)) {
    const section = getSectionByCode(code);
    if (section) for (const ag of getAgeGroupsForSection(section.id)) sectionOfAgeGroup.set(ag.id, code);
  }
  const portions = await fetchAll(() => supabase.from('item_portions').select('item_id, age_group_id')
    .in('age_group_id', [...sectionOfAgeGroup.keys()]).order('item_id').order('age_group_id'));
  const sectionsOf = new Map();
  for (const p of portions) {
    if (!sectionsOf.has(p.item_id)) sectionsOf.set(p.item_id, new Set());
    sectionsOf.get(p.item_id).add(sectionOfAgeGroup.get(p.age_group_id));
  }
  const items = await fetchAll(() => supabase.from('menu_items')
    .select('id, name, category_id, calories_per_100g, calories_unverified').eq('is_active', 1).order('id'));
  return items.filter((it) => sectionsOf.has(it.id)).map((it) => ({
    id: it.id, name: it.name, category: getCategoryById(it.category_id)?.name || '',
    sections: Object.keys(SECTION_LABEL).filter((s) => sectionsOf.get(it.id).has(s)),
    calories: it.calories_per_100g, unverified: !!it.calories_unverified,
  }));
}

// Every active school dish's row -> ~n spread evenly over categories, deterministic (a fixed hash of
// the id orders each category), so a rerun samples the same dishes.
function sampleRows(rows, n) {
  const hash = (id) => (Math.imul(id, 2654435761) >>> 0);
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const queues = [...byCat.values()].map((list) => list.sort((a, b) => hash(a.id) - hash(b.id)));
  const out = [];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && out.length < n) out.push(q.shift());
  }
  return out;
}

// ---- report -----------------------------------------------------------------------------------

function pct(num, den) { return den ? `${Math.round((100 * num) / den)}%` : '-'; }
function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function summarize(results) {
  const lines = [];
  const withHits = results.filter((r) => r.candidates.length);
  const top = (r) => r.candidates[0];
  const bestCover = (r) => Math.max(0, ...r.candidates.map((c) => wordCoverage(r.name, c.description)));
  const stat = (label, list) => {
    const fullCover = list.filter((r) => bestCover(r) === 1).length;
    const topFullCover = list.filter((r) => r.candidates.length && wordCoverage(r.name, top(r).description) === 1).length;
    const fnddsShown = list.filter((r) => r.candidates.some((c) => c.dataType === FNDDS)).length;
    const deltas = list.map((r) => (r.candidates.length ? kcalDelta(top(r).panel.energy_kcal, r.calories) : null)).filter((d) => d != null);
    const med = median(deltas.map(Math.abs));
    return `${label.padEnd(28)} ${String(list.length).padStart(4)}   no results ${pct(list.length - list.filter((r) => r.candidates.length).length, list.length).padStart(4)}`
      + `   top result has every dish word ${pct(topFullCover, list.length).padStart(4)}   some candidate does ${pct(fullCover, list.length).padStart(4)}`
      + `   FNDDS among candidates ${pct(fnddsShown, list.length).padStart(4)}   median |top kcal vs current| ${med == null ? '-' : `${Math.round(med * 100)}%`}`;
  };
  lines.push(`USDA FoodData Central match trial -- ${results.length} dishes, ${withHits.length} with at least one result.`);
  lines.push('Automatic signals only (word overlap, dataset, kcal difference): mark the workbook\'s Verdict column and run --score for the real match rate.');
  lines.push('');
  lines.push(stat('All', results));
  const cats = [...new Set(results.map((r) => r.category))];
  for (const c of cats) lines.push(stat(c, results.filter((r) => r.category === c)));
  lines.push('');
  for (const r of results) {
    lines.push(`${r.name}  [${r.category}]  current ${r.calories ?? '-'} kcal${r.unverified ? ' (flagged)' : ''}`);
    if (!r.candidates.length) lines.push('    (no USDA results)');
    for (const c of r.candidates.slice(0, 3)) {
      lines.push(`    ${DATA_TYPE_SHORT[c.dataType] || c.dataType}: ${c.description} -- ${c.panel.energy_kcal ?? '?'} kcal (fdc ${c.fdcId})`);
    }
  }
  return lines.join('\n');
}

async function writeWorkbook(results, file) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = { dishId: 8, dish: 36, category: 18, sections: 16, current: 10, rank: 4, foundBy: 12, dataset: 11, description: 60,
    kcal: 7, protein: 8, fat: 7, carbs: 8, fiber: 7, sugars: 8, sodium: 9, delta: 11, fdcId: 10, verdict: 11, notes: 40 };
  const headers = { dishId: 'Dish ID', dish: 'Dish', category: 'Category', sections: 'Section(s)', current: 'Current kcal /100g', rank: '#',
    foundBy: 'Found by', dataset: 'Dataset', description: 'USDA description', kcal: 'kcal', protein: 'Protein g', fat: 'Fat g',
    carbs: 'Carbs g', fiber: 'Fiber g', sugars: 'Sugars g', sodium: 'Sodium mg', delta: 'kcal vs current', fdcId: 'FDC ID',
    verdict: 'Verdict', notes: 'Better search words / notes' };
  for (const [key, col] of Object.entries(COLS)) {
    sheet.getColumn(col).width = widths[key];
    sheet.getRow(1).getCell(col).value = headers[key];
  }
  sheet.getRow(1).font = { bold: true };
  let rowNo = 2;
  for (const r of results) {
    const head = sheet.getRow(rowNo++);
    head.getCell(COLS.dishId).value = r.id;
    head.getCell(COLS.dish).value = r.name;
    head.getCell(COLS.category).value = r.category;
    head.getCell(COLS.sections).value = r.sections.map((s) => SECTION_LABEL[s] || s).join(', ');
    head.getCell(COLS.current).value = r.calories == null ? '' : (r.unverified ? `${r.calories} (flagged)` : r.calories);
    head.font = { bold: true };
    head.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col <= COLS.notes) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    });
    if (!r.candidates.length) {
      sheet.getRow(rowNo++).getCell(COLS.description).value = '(no USDA results)';
      continue;
    }
    r.candidates.forEach((c, i) => {
      const row = sheet.getRow(rowNo++);
      const p = c.panel;
      row.getCell(COLS.dishId).value = r.id;
      row.getCell(COLS.dishId).font = { color: { argb: 'FF999999' } };
      row.getCell(COLS.rank).value = i + 1;
      row.getCell(COLS.foundBy).value = c.foundBy;
      row.getCell(COLS.dataset).value = DATA_TYPE_SHORT[c.dataType] || c.dataType;
      row.getCell(COLS.description).value = c.description;
      row.getCell(COLS.kcal).value = p.energy_kcal;
      row.getCell(COLS.protein).value = p.protein_g;
      row.getCell(COLS.fat).value = p.fat_g;
      row.getCell(COLS.carbs).value = p.carbs_g;
      row.getCell(COLS.fiber).value = p.fiber_g;
      row.getCell(COLS.sugars).value = p.sugars_g;
      row.getCell(COLS.sodium).value = p.sodium_mg;
      const d = kcalDelta(p.energy_kcal, r.calories);
      if (d != null) {
        row.getCell(COLS.delta).value = d;
        row.getCell(COLS.delta).numFmt = '+0%;-0%;0%';
        if (Math.abs(d) >= 0.4) row.getCell(COLS.delta).font = { color: { argb: 'FFC0392B' } };
      }
      row.getCell(COLS.fdcId).value = c.fdcId;
      row.getCell(COLS.verdict).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${VERDICTS.join(',')}"`] };
    });
  }
  const how = wb.addWorksheet('How to mark');
  [
    'For each dish, set Verdict on the candidate(s) that fit; leave every candidate blank when none does.',
    'Exact = this IS the dish.  Close = same kind of dish, numbers you would accept.  Stand-in = nearest USDA food, only a rough proxy.',
    'If a different search would obviously find it (e.g. "chicken stew" for a braise), write the words in "Better search words / notes" on the dish row.',
    'Then run: node scripts/fdc-match-trial.js --score <this file>',
    '',
    'kcal vs current compares with the dish\'s calories today (AI estimate or reviewed value); red = 40% or more apart.',
    'Nutrients are per 100 g, straight from USDA FoodData Central (public domain).',
  ].forEach((t, i) => { how.getRow(i + 1).getCell(1).value = t; });
  how.getColumn(1).width = 140;
  await wb.xlsx.writeFile(file);
}

// ---- --score: read a marked workbook back -----------------------------------------------------

async function scoreWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet(SHEET);
  if (!sheet) throw new Error(`No "${SHEET}" sheet in ${file}`);
  const text = (cell) => {
    const v = cell.value;
    if (v == null) return '';
    if (typeof v === 'object' && v.richText) return v.richText.map((t) => t.text).join('').trim();
    return String(v).trim();
  };
  const dishes = [];
  let dish = null;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const name = text(row.getCell(COLS.dish));
    if (name) {
      dish = { name, category: text(row.getCell(COLS.category)), notes: text(row.getCell(COLS.notes)), candidates: 0, best: null };
      dishes.push(dish);
      return;
    }
    if (!dish || !text(row.getCell(COLS.fdcId))) return;
    dish.candidates++;
    const verdict = VERDICTS.find((v) => v.toLowerCase() === text(row.getCell(COLS.verdict)).toLowerCase());
    if (!verdict) return;
    const pick = { verdict, rank: Number(text(row.getCell(COLS.rank))), foundBy: text(row.getCell(COLS.foundBy)), dataset: text(row.getCell(COLS.dataset)) };
    if (!dish.best || VERDICT_RANK[verdict] > VERDICT_RANK[dish.best.verdict]
      || (VERDICT_RANK[verdict] === VERDICT_RANK[dish.best.verdict] && pick.rank < dish.best.rank)) dish.best = pick;
  });

  const lines = [];
  const line = (label, list) => {
    const count = (v) => list.filter((d) => d.best?.verdict === v).length;
    const usable = count('Exact') + count('Close');
    return `${label.padEnd(28)} ${String(list.length).padStart(4)}   Exact ${pct(count('Exact'), list.length).padStart(4)}   Close ${pct(count('Close'), list.length).padStart(4)}`
      + `   Exact+Close ${pct(usable, list.length).padStart(4)}   Stand-in ${pct(count('Stand-in'), list.length).padStart(4)}   none ${pct(list.filter((d) => !d.best).length, list.length).padStart(4)}`;
  };
  lines.push(`Scored ${dishes.length} dishes from ${path.basename(file)} (best verdict per dish).`);
  lines.push('');
  lines.push(line('All', dishes));
  for (const c of [...new Set(dishes.map((d) => d.category))]) lines.push(line(c, dishes.filter((d) => d.category === c)));
  const picked = dishes.filter((d) => d.best && VERDICT_RANK[d.best.verdict] >= 2);
  if (picked.length) {
    lines.push('');
    lines.push(`Where the Exact / Close pick was (${picked.length} dishes):`);
    lines.push(`  ranked #1: ${pct(picked.filter((d) => d.best.rank === 1).length, picked.length)}   in the top 3: ${pct(picked.filter((d) => d.best.rank <= 3).length, picked.length)}`);
    lines.push(`  found only by the FNDDS-only search: ${pct(picked.filter((d) => d.best.foundBy === 'FNDDS only').length, picked.length)}`);
    const byDataset = {};
    for (const d of picked) byDataset[d.best.dataset] = (byDataset[d.best.dataset] || 0) + 1;
    lines.push(`  dataset: ${Object.entries(byDataset).map(([k, v]) => `${k} ${pct(v, picked.length)}`).join(', ')}`);
  }
  const withNotes = dishes.filter((d) => d.notes);
  if (withNotes.length) {
    lines.push('');
    lines.push(`Better search words suggested for ${withNotes.length} dishes:`);
    for (const d of withNotes) lines.push(`  ${d.name}: ${d.notes}`);
  }
  return lines.join('\n');
}

// ---- main ---------------------------------------------------------------------------------------

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

async function runTrial() {
  const { supabase } = require('../lib/supabaseClient');
  const { loadReferenceData } = require('../lib/referenceData');
  const { searchFdc } = require('../lib/fdcClient');

  const n = Math.max(1, Number(argValue('--n')) || 50);
  const outDir = path.resolve(argValue('--out') || path.join(__dirname, '..', 'backups'));
  fs.mkdirSync(outDir, { recursive: true });

  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }
  await loadReferenceData();

  const all = await loadSchoolDishes(supabase);
  const sample = sampleRows(all, n);
  console.log(`${all.length} active school dishes; sampling ${sample.length} across ${new Set(sample.map((r) => r.category)).size} categories.`);

  const results = [];
  let remaining = null;
  for (const [i, r] of sample.entries()) {
    try {
      const combined = await searchFdc({ query: r.name, pageSize: 10 });
      const fnddsOnly = await searchFdc({ query: r.name, dataTypes: [FNDDS], pageSize: 10 });
      remaining = fnddsOnly.rateLimitRemaining ?? remaining;
      results.push({ ...r, candidates: mergeCandidates(combined.foods, fnddsOnly.foods) });
      console.log(`  ${i + 1}/${sample.length}  ${r.name}: ${results.at(-1).candidates.length} candidates`);
    } catch (err) {
      console.error(`Stopped at ${r.name}: ${err.message}`);
      break;
    }
  }
  if (!results.length) process.exit(1);

  const xlsx = path.join(outDir, 'fdc-match-trial.xlsx');
  const txt = path.join(outDir, 'fdc-match-trial.txt');
  await writeWorkbook(results, xlsx);
  const summary = summarize(results);
  fs.writeFileSync(txt, `${summary}\n`);
  console.log(`\n${summary.split('\n\n')[0]}\n${summary.split('\n\n')[1] || ''}`);
  console.log(`\nUSDA requests left this hour: ${remaining ?? 'unknown'}`);
  console.log(`Wrote ${xlsx}\n  and ${txt}`);
  console.log('Mark the Verdict column, then: node scripts/fdc-match-trial.js --score <the marked file>');
  process.exit(0);
}

if (require.main === module) {
  const scoreFile = argValue('--score');
  const run = scoreFile
    ? scoreWorkbook(path.resolve(scoreFile)).then((report) => {
      console.log(report);
      const outDir = argValue('--out');
      if (outDir) fs.writeFileSync(path.join(path.resolve(outDir), 'fdc-match-trial-score.txt'), `${report}\n`);
    })
    : runTrial();
  run.catch((err) => { console.error(err.message || err); process.exit(1); });
}

module.exports = { wordCoverage, mergeCandidates, sampleRows, summarize, writeWorkbook, scoreWorkbook };
