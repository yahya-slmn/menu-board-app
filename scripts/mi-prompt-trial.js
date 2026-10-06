#!/usr/bin/env node
// Menu Ingredients prompt trial: the OLD prompt (the live suggest-dish-ingredients) against the NEW one (deployed for
// the trial only as suggest-dish-ingredients-trial), side by side on one real menu, for the chef's review BEFORE the
// new prompt replaces the live one.
//
//   node scripts/mi-prompt-trial.js "~/Downloads/tetiana/September week_04.xlsx" [--out backups/mi-prompt-trial.xlsx]
//
// Each side is run the way the app runs it: OLD = name only, 50 dishes per call, the nut filter only (the app today);
// NEW = name + category / section / meal period, 20 per call, then lib/menuIngredientsRequest.js cleanSuggestion
// (nut / sesame, spicy, halal, seafood for students). One retry for any dish a call didn't return.
// Writes an Excel report (default backups/mi-prompt-trial-<date>.xlsx): a Comparison sheet, one row per dish, and a
// Summary sheet. Read-only on the app's data: it saves nothing to the database. Costs two AI runs over the menu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadWorkbookFromBuffer, parseWorkbookDishes } = require('../lib/menuIngredients');
const { filterNutIngredients } = require('../lib/nutFilter');
const { dishesForSuggestion, toPayloadItem, cleanSuggestion } = require('../lib/menuIngredientsRequest');
const { POLICY_LABELS, dedupeSegments } = require('../lib/menuIngredientFilters');

// Raw-answer checks (before the app's clean-ups), so the report shows what the PROMPT itself got right.
const splitList = (s) => String(s || '').split(' - ').map((x) => x.trim()).filter(Boolean);
const NEGATED_FORBIDDEN = /\b(sesame|nuts?|pine|peanut|almond|tahini|alcohol|wine|pork|chili|chilli|spice)[\s-]*(free|shaped)\b|\bwithout\s+(nuts?|sesame|pork|alcohol)/i;
const PLACEHOLDER = /\b(dough|batter|breading|filling|patt(y|ies)|topping|marinade)\b/i;
function rawChecks(answer) {
  const segs = splitList(answer && answer.ingredients);
  return {
    repeated: dedupeSegments(segs).duplicates.length > 0,
    negated: segs.some((x) => NEGATED_FORBIDDEN.test(x)),
    placeholder: segs.filter((x) => PLACEHOLDER.test(x)),
  };
}

// The school category names the parser needs (normally read from the database): as the chef's menus print them.
const SCHOOL_VOCAB = ['AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch SALAD Side', 'Fruit Bar', 'Soup/Appetizer', 'Juice',
  'PM Snack', 'Fruit Basket', 'Lunch Starch/Side', 'Salad Bar', 'Lunch Vegetable Side'];

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const menuPath = (args.find((a, i) => a !== '--out' && !(outAt >= 0 && i === outAt + 1)) || '').replace(/^~(?=$|\/)/, os.homedir());
const outPath = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, '..', 'backups', `mi-prompt-trial-${new Date().toISOString().slice(0, 10)}.xlsx`);
if (!menuPath) { console.error('Usage: node scripts/mi-prompt-trial.js <menu.xlsx> [--out report.xlsx]'); process.exit(2); }

// The app's own Supabase URL, as lib/supabaseClient.js has it.
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supabaseClient.js'), 'utf8');
const SUPABASE_URL = clientSrc.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const { signIn, functionHeaders } = require('./script-auth'); // functions need a signed-in session (2026-10-06)

async function callFunction(slug, items) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
    method: 'POST',
    headers: await functionHeaders(),
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(150_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data;
}

// Runs every dish through one side; returns Map(name -> answer) and the names that never came back.
async function runSide(label, slug, dishes, batchSize, toItem) {
  const answers = new Map();
  let promptVersion = null;
  const runBatch = async (batch) => {
    try {
      const data = await callFunction(slug, batch.map(toItem));
      promptVersion = data.prompt_version || promptVersion;
      const byIndex = new Map(data.estimates.map((e) => [e.index, e]));
      batch.forEach((d, i) => { if (byIndex.has(i)) answers.set(d.name, byIndex.get(i)); });
    } catch (err) {
      console.log(`  ${label}: a batch of ${batch.length} failed (${err.message})`);
    }
  };
  for (let i = 0; i < dishes.length; i += batchSize) {
    console.log(`  ${label}: dishes ${i + 1}-${Math.min(i + batchSize, dishes.length)} of ${dishes.length}`);
    await runBatch(dishes.slice(i, i + batchSize));
  }
  const missing = dishes.filter((d) => !answers.has(d.name));
  if (missing.length) {
    console.log(`  ${label}: retrying ${missing.length}`);
    for (let i = 0; i < missing.length; i += batchSize) await runBatch(missing.slice(i, i + batchSize));
  }
  return { answers, missing: dishes.filter((d) => !answers.has(d.name)).map((d) => d.name), promptVersion };
}

const count = (s) => String(s || '').split(' - ').map((x) => x.trim()).filter(Boolean).length;

(async () => {
  await signIn();
  const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(menuPath));
  const { rows } = await parseWorkbookDishes(workbook, SCHOOL_VOCAB);
  const dishes = dishesForSuggestion(rows);
  const firstRow = new Map();
  const dayCount = new Map();
  for (const r of rows) {
    if (!firstRow.has(r.dishName)) firstRow.set(r.dishName, r);
    dayCount.set(r.dishName, (dayCount.get(r.dishName) || 0) + 1);
  }
  console.log(`${path.basename(menuPath)}: ${rows.length} rows, ${dishes.length} dishes`);
  const started = Date.now();
  const [oldSide, newSide] = await Promise.all([
    runSide('OLD', 'suggest-dish-ingredients', dishes, 50, (d, i) => ({ index: i, name: d.name })),
    runSide('NEW', 'suggest-dish-ingredients-trial', dishes, 20, (d, i) => toPayloadItem(d, i)),
  ]);

  // ---- the report ---------------------------------------------------------------------------------------
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('Comparison', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: 'Section', key: 'section', width: 10 },
    { header: 'First served', key: 'day', width: 16 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Dish', key: 'dish', width: 34 },
    { header: 'OLD ingredients', key: 'oldIng', width: 52 },
    { header: 'Old #', key: 'oldN', width: 7 },
    { header: 'NEW ingredients', key: 'newIng', width: 64 },
    { header: 'New #', key: 'newN', width: 7 },
    { header: 'Basis (new)', key: 'basis', width: 26 },
    { header: 'Removed by the school rules (new)', key: 'removed', width: 34 },
    { header: 'Tidied by the app (new): repeats / "-free" wording / comments', key: 'tidied', width: 30 },
    { header: 'Placeholder words in the raw answer (new)', key: 'placeholder', width: 24 },
    { header: 'Old allergens', key: 'oldAll', width: 18 },
    { header: 'New allergens', key: 'newAll', width: 18 },
  ];
  const stats = { oldCounts: [], newCounts: [], regional: [], removedByPolicy: {}, raw: { old: { repeated: 0, negated: 0, placeholder: 0 }, new: { repeated: 0, negated: 0, placeholder: 0 } }, placeholderNew: [] };
  for (const d of dishes) {
    const r = firstRow.get(d.name);
    const o = oldSide.answers.get(d.name);
    const n = newSide.answers.get(d.name);
    const oldClean = o ? { ing: filterNutIngredients(o.ingredients).cleaned, all: filterNutIngredients(o.allergens).cleaned } : null;
    const newClean = n ? cleanSuggestion(n, d) : null;
    if (oldClean) stats.oldCounts.push(count(oldClean.ing));
    if (newClean) stats.newCounts.push(count(newClean.ingredients));
    const rawOld = rawChecks(o), rawNew = rawChecks(n);
    for (const [side, raw] of [['old', rawOld], ['new', rawNew]]) {
      if (raw.repeated) stats.raw[side].repeated++;
      if (raw.negated) stats.raw[side].negated++;
      if (raw.placeholder.length) stats.raw[side].placeholder++;
    }
    if (rawNew.placeholder.length) stats.placeholderNew.push(`${d.name}: ${rawNew.placeholder.join(', ')}`);
    if (newClean && newClean.basis.startsWith('Regional')) stats.regional.push(`${d.name} -> ${newClean.basis}`);
    for (const x of newClean ? [...newClean.removed, ...newClean.removedAllergens] : []) {
      (stats.removedByPolicy[x.policy] = stats.removedByPolicy[x.policy] || []).push(`${d.name}: ${x.segment}`);
    }
    sheet.addRow({
      section: d.section, day: `${r.weekday || ''} ${r.date || ''}`.trim() + (dayCount.get(d.name) > 1 ? ` (+${dayCount.get(d.name) - 1})` : ''),
      category: d.category, dish: d.name,
      oldIng: oldClean ? oldClean.ing : '(no answer)', oldN: oldClean ? count(oldClean.ing) : null,
      newIng: newClean ? newClean.ingredients : '(no answer)', newN: newClean ? count(newClean.ingredients) : null,
      basis: newClean ? newClean.basis : '',
      removed: newClean ? [...newClean.removed, ...newClean.removedAllergens].map((x) => `${x.segment} (${POLICY_LABELS[x.policy]})`).join('; ') : '',
      oldAll: oldClean ? oldClean.all : '', newAll: newClean ? newClean.allergens : '',
      tidied: newClean ? [...newClean.tidied.duplicates.map((x) => `repeat: ${x}`), ...newClean.tidied.negations.map((x) => `wording: ${x}`), ...newClean.tidied.comments.map((x) => `comment: ${x}`)].join('; ') : '',
      placeholder: rawNew.placeholder.join('; '),
    });
  }
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'N1' };
  sheet.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: 'top', wrapText: true }; });

  const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-');
  const median = (a) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const summary = out.addWorksheet('Summary');
  summary.columns = [{ width: 46 }, { width: 90 }];
  const lines = [
    ['Menu', path.basename(menuPath)],
    ['Dishes compared', dishes.length],
    ['Old prompt', 'live suggest-dish-ingredients: name only, 50 per call, nut filter only'],
    ['New prompt', `suggest-dish-ingredients-trial (${newSide.promptVersion || 'no version'}): name + category / section / period, 20 per call, nut + spicy + halal + student-seafood filters`],
    ['Ingredients per dish, old: average / median', `${avg(stats.oldCounts)} / ${median(stats.oldCounts)}`],
    ['Ingredients per dish, new: average / median', `${avg(stats.newCounts)} / ${median(stats.newCounts)}`],
    ['Dishes judged regional (new)', `${stats.regional.length} of ${dishes.length}`],
    ['No answer after retry, old', oldSide.missing.length ? oldSide.missing.join(', ') : 'none'],
    ['No answer after retry, new', newSide.missing.length ? newSide.missing.join(', ') : 'none'],
    ['Run time', `${Math.round((Date.now() - started) / 1000)} s`],
    [],
    ['RAW answers (before the app tidies them)', 'old prompt / new prompt'],
    ['  with an ingredient listed twice', `${stats.raw.old.repeated} / ${stats.raw.new.repeated}`],
    ['  naming a forbidden ingredient as "-free" / "-shaped"', `${stats.raw.old.negated} / ${stats.raw.new.negated}`],
    ['  with a placeholder (dough, filling, patties, topping...)', `${stats.raw.old.placeholder} / ${stats.raw.new.placeholder}`],
    ['  placeholders in the new answers', stats.placeholderNew.join('; ') || 'none'],
    [],
    ['Removed by the school rules (new side)', ''],
    ...Object.entries(POLICY_LABELS).map(([k, label]) => [`  ${label}`, (stats.removedByPolicy[k] || []).join('; ') || 'none']),
    [],
    ['Regional dishes (new side)', ''],
    ...stats.regional.map((x) => ['', x]),
  ];
  for (const l of lines) summary.addRow(l);
  summary.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  summary.getColumn(1).font = { bold: true };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await out.xlsx.writeFile(outPath);
  console.log(`\nOld: ${stats.oldCounts.length} answered, ${avg(stats.oldCounts)} ingredients on average (median ${median(stats.oldCounts)})`);
  console.log(`New: ${stats.newCounts.length} answered, ${avg(stats.newCounts)} ingredients on average (median ${median(stats.newCounts)}); ${stats.regional.length} regional`);
  console.log(`Removed by rules (new): ${Object.entries(stats.removedByPolicy).map(([k, v]) => `${POLICY_LABELS[k]} ${v.length}`).join(', ') || 'none'}`);
  console.log(`No answer: old ${oldSide.missing.length}, new ${newSide.missing.length}`);
  console.log(`Raw answers old / new -- repeated ingredient: ${stats.raw.old.repeated} / ${stats.raw.new.repeated}; "-free"/"-shaped" forbidden wording: ${stats.raw.old.negated} / ${stats.raw.new.negated}; placeholder: ${stats.raw.old.placeholder} / ${stats.raw.new.placeholder}`);
  console.log(`Report: ${outPath}`);
})().catch((err) => { console.error(err); process.exit(1); });
