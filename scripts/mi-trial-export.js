#!/usr/bin/env node
// A Menu Ingredients export made the way the app makes it, from a real menu, with the prompt deployed as the TRIAL
// function -- the input the Recipe Generator trial needs (scripts/rg-prompt-trial.js): a genuinely "reviewed" file
// from the new pipeline instead of an old export of unknown history.
//
//   node scripts/mi-trial-export.js "~/Downloads/tetiana/September week_04.xlsx" --out backups/mi-v22-export.xlsx [--edits]
//
// Steps, as main.js parse-and-suggest-menu-ingredients + export-menu-ingredients: parse -> one AI call per dish name
// (suggest-dish-ingredients-trial) -> each row cleaned for its own section -> planShares (followers take the source's
// text) -> restructureAndAppendIngredients. With --edits it then applies a few chef-style edits (printed, and listed in
// the file's "_TrialEdits" sheet, which the parsers skip): an "Edit for this section" on a Staff copy, a sandwich's bread
// kept as one ingredient, an ingredient removed, one added. Read-only on the app's data; costs one AI run over the menu.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWorkbookFromBuffer, parseWorkbookDishes, restructureAndAppendIngredients } = require('../lib/menuIngredients');
const { dishesForSuggestion, toPayloadItem, cleanSuggestion, rowSeafoodAllowed } = require('../lib/menuIngredientsRequest');
const { planShares, shareName, rowKey } = require('../lib/menuIngredientsShare');

const SCHOOL_VOCAB = ['AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch SALAD Side', 'Fruit Bar', 'Soup/Appetizer', 'Juice',
  'PM Snack', 'Fruit Basket', 'Lunch Starch/Side', 'Salad Bar', 'Lunch Vegetable Side'];
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const withEdits = args.includes('--edits');
const menuPath = (args.find((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1)) || '').replace(/^~(?=$|\/)/, os.homedir());
const outPath = outAt >= 0 ? args[outAt + 1] : null;
if (!menuPath || !outPath) { console.error('Usage: node scripts/mi-trial-export.js <menu.xlsx> --out <file.xlsx> [--edits]'); process.exit(2); }

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supabaseClient.js'), 'utf8');
const SUPABASE_URL = clientSrc.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const ANON_KEY = (clientSrc.match(/['"](eyJ[A-Za-z0-9._-]+|sb_publishable_[A-Za-z0-9_-]+)['"]/) || [])[1];
async function suggest(items) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/suggest-dish-ingredients-trial`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ items }), signal: AbortSignal.timeout(150_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data.estimates;
}

(async () => {
  const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(menuPath));
  const { rows, dishColumnBySheet } = await parseWorkbookDishes(workbook, SCHOOL_VOCAB);
  const dishes = dishesForSuggestion(rows);
  const answers = new Map();
  for (let pass = 0; pass < 2; pass++) { // one retry for what didn't come back
    const todo = dishes.filter((d) => !answers.has(d.key));
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20);
      console.log(`  suggesting ${i + 1}-${i + batch.length} of ${todo.length}${pass ? ' (retry)' : ''}`);
      try {
        const est = await suggest(batch.map((d, k) => toPayloadItem(d, k)));
        for (const e of est) if (batch[e.index]) answers.set(batch[e.index].key, e);
      } catch (err) { console.log(`  a batch failed: ${err.message}`); }
    }
  }
  const annotated = rows.map((r) => {
    const est = answers.get(shareName(r.dishName));
    const c = est ? cleanSuggestion(est, { seafoodAllowed: rowSeafoodAllowed(r) }) : null;
    return { ...r, fileIndex: 0, ingredients: c ? c.ingredients : '', allergens: c ? c.allergens : '' };
  });
  const links = planShares(annotated);
  for (const r of annotated) { const s = links.get(rowKey(r)); if (s) { r.ingredients = s.ingredients; r.allergens = s.allergens; r.followsSheet = s.sheetName; } }

  const edits = [];
  if (withEdits) {
    const edit = (r, kind, ingredients) => { edits.push({ sheet: r.sheetName, day: `${r.weekday} ${r.date}`, dish: r.dishName, kind, before: r.ingredients, after: ingredients }); r.ingredients = ingredients; };
    const list = (r) => r.ingredients.split(' - ').filter(Boolean);
    // 1. "Edit for this section" on a Staff copy of a school dish: her Staff version differs.
    const staffCopy = annotated.find((r) => r.sheetName === 'Staff' && r.followsSheet && list(r).length >= 4);
    if (staffCopy) edit(staffCopy, 'Edit for this section (Staff copy): swapped an ingredient, added one', [...list(staffCopy).slice(0, -1), 'fresh thyme', 'lemon zest'].join(' - '));
    // 2. A sandwich: the bread as ONE ingredient, at her level of detail.
    const sandwich = annotated.find((r) => /sandwich|wrap|toast/i.test(r.dishName) && !r.followsSheet && r !== staffCopy);
    if (sandwich) edit(sandwich, 'bread kept as one ingredient', ['brown bread', ...list(sandwich).filter((x) => !/flour|yeast|bread|tortilla|bun/i.test(x))].join(' - '));
    // 3. An ingredient removed from a hot main.
    const main = annotated.find((r) => /Lunch Main Course/.test(r.category) && !r.followsSheet && list(r).length >= 8 && ![staffCopy, sandwich].includes(r));
    if (main) edit(main, 'removed an ingredient', list(main).filter((_, i) => i !== 2).join(' - '));
    // 4. An ingredient added to a salad.
    const salad = annotated.find((r) => /salad/i.test(r.category) && !r.followsSheet && ![staffCopy, sandwich, main].includes(r));
    if (salad) edit(salad, 'added an ingredient', [...list(salad), 'sumac'].join(' - '));
    for (const e of edits) console.log(`  edit: [${e.sheet} ${e.day}] ${e.dish} -- ${e.kind}\n        before: ${e.before}\n        after:  ${e.after}`);
  }

  await restructureAndAppendIngredients(workbook, annotated, dishColumnBySheet);
  if (edits.length) {
    const ws = workbook.addWorksheet('_TrialEdits', { state: 'hidden' });
    ws.addRow(['Sheet', 'Day', 'Dish', 'Edit', 'Before', 'After']);
    for (const e of edits) ws.addRow([e.sheet, e.day, e.dish, e.kind, e.before, e.after]);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(await workbook.xlsx.writeBuffer()));
  console.log(`\n${rows.length} rows, ${dishes.length} dishes (${answers.size} answered), ${links.size} following rows, ${edits.length} edits -> ${outPath}`);
})().catch((err) => { console.error(err); process.exit(1); });
