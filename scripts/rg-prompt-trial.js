#!/usr/bin/env node
// Recipe Generator prompt trial (Phase E): does the recipe keep the chef's reviewed ingredient list? The LIVE
// generate-dish-recipes (today: it never sees the list) against the one deployed as generate-dish-recipes-trial (the
// list is sent and REVIEWED_LIST_RULE applies), on a sample of dishes from a real Menu Ingredients export.
//
//   node scripts/rg-prompt-trial.js backups/mi-v22-export-week04.xlsx [--sample 30] [--out backups/rg-prompt-trial.xlsx]
//
// The dishes go through the same parse -> dedupe (name + reviewed list) as an upload. The sample always holds the
// file's chef edits (its hidden "_TrialEdits" sheet, from scripts/mi-trial-export.js --edits) and every dish with two
// list versions, then the rest spread over the category groups. Per dish, measured in code: each reviewed ingredient
// kept VERBATIM (case aside), CHANGED (only a partial match -- reworded / split), or MISSING; and what the AI ADDED.
// Read-only: nothing is saved to the database. Costs two AI runs over the sample.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadWorkbookFromBuffer, parseWorkbookDishes } = require('../lib/menuIngredients');
const { dedupeWithinUpload, resolveSectionFromSheetName, reviewedIngredientsOf, isSaladCategory } = require('../lib/recipeGenerator');
const { categoryGroupFor, categoryGroupInfo } = require('../lib/recipeCategoryGroups');

const SCHOOL_VOCAB = ['AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch SALAD Side', 'Fruit Bar', 'Soup/Appetizer', 'Juice',
  'PM Snack', 'Fruit Basket', 'Lunch Starch/Side', 'Salad Bar', 'Lunch Vegetable Side'];
const WASTE_TYPES = ['Baking Waste', 'Trimming Waste', 'Peeling Waste', 'Cooking Loss'];
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const filePath = (args.find((a, i) => !a.startsWith('--') && !['--sample', '--out'].includes(args[i - 1])) || '').replace(/^~(?=$|\/)/, os.homedir());
const sampleSize = Number(opt('--sample') || 30);
const outPath = opt('--out') || path.join(__dirname, '..', 'backups', `rg-prompt-trial-${new Date().toISOString().slice(0, 10)}.xlsx`);
if (!filePath) { console.error('Usage: node scripts/rg-prompt-trial.js <menu-with-ingredients.xlsx> [--sample 30] [--out report.xlsx]'); process.exit(2); }

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supabaseClient.js'), 'utf8');
const SUPABASE_URL = clientSrc.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const { signIn, functionHeaders } = require('./script-auth'); // functions need a signed-in session (2026-10-06)
async function generate(slug, items) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
    method: 'POST', headers: await functionHeaders(),
    body: JSON.stringify({ items, existingWasteTypeNames: WASTE_TYPES }), signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data.recipes;
}
async function runSide(label, slug, dishes, withList) {
  const out = new Map();
  for (let pass = 0; pass < 2; pass++) {
    const todo = dishes.filter((d) => !out.has(d));
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      console.log(`  ${label}: ${i + 1}-${i + batch.length} of ${todo.length}${pass ? ' (retry)' : ''}`);
      const items = batch.map((d, k) => ({
        index: k, name: d.name, category: d.category || undefined, seafoodAllowed: d.section === 'STAFF',
        separateDressing: isSaladCategory(d.category), askRole: !!d.staffMainRole,
        ...(withList && d.reviewedIngredients ? { reviewedIngredients: d.reviewedIngredients } : {}),
      }));
      try {
        const recipes = await generate(slug, items);
        for (const r of recipes) if (batch[r.index]) out.set(batch[r.index], r);
      } catch (err) { console.log(`  ${label}: a batch failed (${err.message})`); }
    }
  }
  return out;
}

const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const namesOf = (recipe) => (recipe && recipe.processes ? recipe.processes.flatMap((p) => p.ingredients.map((i) => i.name)) : []);
// reviewed list vs a recipe's ingredient names -> { kept, changed: [[reviewed, recipe name]], missing, added }
function adherence(reviewed, names) {
  const pool = names.map((n) => ({ n, k: key(n), used: false }));
  const kept = [], changed = [], missing = [];
  for (const r of reviewed) {
    const exact = pool.find((p) => !p.used && p.k === key(r));
    if (exact) { exact.used = true; kept.push(r); continue; }
    const partial = pool.find((p) => !p.used && (p.k.includes(key(r)) || key(r).includes(p.k)));
    if (partial) { partial.used = true; changed.push([r, partial.n]); continue; }
    missing.push(r);
  }
  // Left over: a reviewed ingredient used again in another step (milk in the dough AND the custard) is a REPEAT, not
  // an addition; only a name that is not on the list at all is something the AI added.
  const onList = new Set(reviewed.map(key));
  const rest = pool.filter((p) => !p.used);
  return { kept, changed, missing, repeated: rest.filter((p) => onList.has(p.k)).map((p) => p.n), added: rest.filter((p) => !onList.has(p.k)).map((p) => p.n) };
}

(async () => {
  await signIn();
  const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(filePath));
  const { rows } = await parseWorkbookDishes(workbook, SCHOOL_VOCAB);
  const meta = rows.map((r) => ({ ...r, dayLabel: `${r.weekday} ${r.date}`, section: resolveSectionFromSheetName(r.sheetName),
    categoryGroup: categoryGroupFor({ category: r.category, period: r.period }), reviewedIngredients: reviewedIngredientsOf(r.ingredientsText) }));
  const dishes = dedupeWithinUpload(meta).filter((d) => d.reviewedIngredients);
  const editSheet = workbook.getWorksheet('_TrialEdits');
  const edits = [];
  if (editSheet) editSheet.eachRow((row, i) => { if (i > 1) edits.push({ sheet: row.getCell(1).value, dish: row.getCell(3).value, kind: row.getCell(4).value }); });

  // The sample: the chef's edits, every multi-version dish, then round-robin over the groups.
  const picked = [];
  const add = (d) => { if (d && !picked.includes(d) && picked.length < sampleSize) picked.push(d); };
  for (const e of edits) add(dishes.find((d) => key(d.name) === key(e.dish) && (e.sheet !== 'Staff' || d.section === 'STAFF' || d.recipeName)));
  for (const d of dishes.filter((x) => x.recipeName)) { add(d); add(dishes.find((x) => key(x.name) === key(d.name) && !x.recipeName)); }
  const byGroup = new Map();
  for (const d of dishes) { if (!byGroup.has(d.categoryGroup)) byGroup.set(d.categoryGroup, []); byGroup.get(d.categoryGroup).push(d); }
  while (picked.length < Math.min(sampleSize, dishes.length)) {
    let moved = false;
    for (const list of byGroup.values()) { const d = list.find((x) => !picked.includes(x)); if (d) { add(d); moved = true; } }
    if (!moved) break;
  }
  console.log(`${path.basename(filePath)}: ${dishes.length} dishes with a reviewed list; sample ${picked.length} (${edits.length} chef edits)`);

  const started = Date.now();
  const [oldSide, newSide] = await Promise.all([
    runSide('LIVE', 'generate-dish-recipes', picked, false),
    runSide('TRIAL', 'generate-dish-recipes-trial', picked, true),
  ]);

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet('Comparison', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Dish (recipe name)', key: 'dish', width: 30 }, { header: 'Section', key: 'section', width: 9 },
    { header: 'Group', key: 'group', width: 16 }, { header: 'Chef edit', key: 'edit', width: 22 },
    { header: 'Reviewed list (from the file)', key: 'reviewed', width: 46 },
    { header: 'NEW: kept verbatim', key: 'nk', width: 9 }, { header: 'NEW: changed', key: 'nc', width: 28 }, { header: 'NEW: missing', key: 'nm', width: 24 },
    { header: 'NEW: added by the AI (not on the list)', key: 'na', width: 30 },
    { header: 'NEW: list ingredients used again in another step', key: 'nr', width: 24 }, { header: 'NEW recipe ingredients', key: 'newIng', width: 50 },
    { header: 'TODAY: reviewed ingredients it happens to use', key: 'ok', width: 12 }, { header: 'TODAY recipe ingredients', key: 'oldIng', width: 50 },
  ];
  const tot = { reviewed: 0, kept: 0, changed: 0, missing: 0, added: 0, oldKept: 0, dishes: 0, perfect: 0, noAnswerNew: 0, noAnswerOld: 0, skipped: [] };
  const issues = [];
  for (const d of picked) {
    const o = oldSide.get(d), n = newSide.get(d);
    if (!n) tot.noAnswerNew++;
    if (!o) tot.noAnswerOld++;
    if (n && n.skipReason) tot.skipped.push(`${d.name}: ${n.skipReason}`);
    const a = adherence(d.reviewedIngredients, namesOf(n));
    const ao = adherence(d.reviewedIngredients, namesOf(o));
    if (n && !n.skipReason) {
      tot.dishes++; tot.reviewed += d.reviewedIngredients.length; tot.kept += a.kept.length; tot.changed += a.changed.length;
      tot.missing += a.missing.length; tot.added += a.added.length; tot.oldKept += ao.kept.length;
      if (!a.changed.length && !a.missing.length) tot.perfect++;
      if (a.changed.length || a.missing.length) issues.push(`${d.recipeName || d.name}: ${[...a.changed.map(([r, x]) => `"${r}" -> "${x}"`), ...a.missing.map((m) => `missing "${m}"`)].join('; ')}`);
    }
    const edit = edits.find((e) => key(e.dish) === key(d.name) && (e.sheet !== 'Staff' || d.section === 'STAFF'));
    ws.addRow({
      dish: d.recipeName || d.name, section: d.section, group: categoryGroupInfo(d.categoryGroup).label, edit: edit ? edit.kind : '',
      reviewed: d.reviewedIngredients.join(' - '),
      nk: n ? `${a.kept.length}/${d.reviewedIngredients.length}` : '(no answer)', nc: a.changed.map(([r, x]) => `${r} -> ${x}`).join('; '),
      nm: a.missing.join('; '), na: a.added.join('; '), nr: a.repeated.join('; '), newIng: namesOf(n).join(' - ') || (n && n.skipReason ? `skipped: ${n.skipReason}` : ''),
      ok: o ? `${ao.kept.length}/${d.reviewedIngredients.length}` : '(no answer)', oldIng: namesOf(o).join(' - '),
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: 'top', wrapText: true }; });
  const pct = (x, y) => (y ? `${Math.round((100 * x) / y)}%` : '-');
  const sum = out.addWorksheet('Summary');
  sum.columns = [{ width: 52 }, { width: 100 }];
  for (const l of [
    ['File', path.basename(filePath)], ['Dishes in the sample', `${picked.length} (of ${dishes.length} with a reviewed list)`],
    ['Reviewed ingredients in the sample', tot.reviewed],
    ['NEW prompt: kept verbatim', `${tot.kept} (${pct(tot.kept, tot.reviewed)})`],
    ['NEW prompt: changed (reworded / split)', `${tot.changed} (${pct(tot.changed, tot.reviewed)})`],
    ['NEW prompt: missing', `${tot.missing} (${pct(tot.missing, tot.reviewed)})`],
    ['NEW prompt: dishes keeping their whole list', `${tot.perfect} of ${tot.dishes}`],
    ['NEW prompt: ingredients the AI added', `${tot.added} (${(tot.added / Math.max(1, tot.dishes)).toFixed(1)} per dish)`],
    ['TODAY (live): reviewed ingredients it happens to use verbatim', `${tot.oldKept} (${pct(tot.oldKept, tot.reviewed)})`],
    ['No answer after retry: today / new', `${tot.noAnswerOld} / ${tot.noAnswerNew}`],
    ['Skipped by the seafood rule (new)', tot.skipped.join('; ') || 'none'],
    ['Run time', `${Math.round((Date.now() - started) / 1000)} s`],
    [], ['Every changed / missing reviewed ingredient (new)', ''], ...issues.map((x) => ['', x]),
    [], ['Chef edits in the file', ''], ...edits.map((e) => ['', `${e.sheet}: ${e.dish} -- ${e.kind}`]),
  ]) sum.addRow(l);
  sum.getColumn(1).font = { bold: true };
  sum.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await out.xlsx.writeFile(outPath);
  console.log(`\nNEW: kept ${tot.kept}/${tot.reviewed} verbatim (${pct(tot.kept, tot.reviewed)}), changed ${tot.changed}, missing ${tot.missing}; ${tot.perfect}/${tot.dishes} dishes whole; ${tot.added} added`);
  console.log(`TODAY: ${tot.oldKept}/${tot.reviewed} of the reviewed ingredients used verbatim (${pct(tot.oldKept, tot.reviewed)})`);
  if (issues.length) console.log('Changed / missing (new):\n  ' + issues.join('\n  '));
  console.log(`Report: ${outPath}`);
})().catch((err) => { console.error(err); process.exit(1); });
