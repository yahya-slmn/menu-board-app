#!/usr/bin/env node
// Where every dish of real menu files lands in the Recipe Generator's category groups -- for reviewing the rules on
// the chef's own menus before they go live.
//
//   node scripts/recipe-groups-scan.js "~/Downloads/September week_01.xlsx" ... [--out report.txt]
//
// For each file, the same steps as an upload (parse -> section + group per row -> dedupeWithinUpload), then:
//   - how many recipes land in Other: for drafts made before groups were saved (a guess from the category text), for
//     a new upload, and for old drafts after "Re-group from the original menu..." (lib/recipeRegroup.js);
//   - every Staff "Main Dish" (Breakfast and Lunch), deduplicated, with its group and why. A Staff lunch main no
//     student dish shares is decided at generation by meat / fish, else the AI's main-or-side role; the scan has no
//     AI, so it shows the meat decision, or for a meatless dish "AI role decides" plus the no-role fallback (what
//     Re-group gives an old draft).
// Read-only: no login, no database, no AI; it writes only the --out file when given one.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadWorkbookFromBuffer, parseWorkbookDishes } = require('../lib/menuIngredients');
const { dedupeWithinUpload, resolveSectionFromSheetName, emptyDishIndex, addNameToIndex, findDuplicateMatch, isExcludedCategory, isReadyMadeItem } = require('../lib/recipeGenerator');
const { categoryGroupFor, categoryGroupInfo, categoryGroupOfRecipe, staffMainGroup, hasMeatOrFish } = require('../lib/recipeCategoryGroups');
const { planRegroup } = require('../lib/recipeRegroup');

// The school category names the parser needs (normally read from the database): as the chef's menus print them.
const SCHOOL_VOCAB = ['AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch SALAD Side', 'Fruit Bar', 'Soup/Appetizer', 'Juice',
  'PM Snack', 'Fruit Basket', 'Lunch Starch/Side', 'Salad Bar', 'Lunch Vegetable Side'];

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args[outAt + 1] : null;
const files = args.filter((a, i) => a !== '--out' && i !== outAt + 1).map((f) => f.replace(/^~(?=$|\/)/, os.homedir()));
if (!files.length) { console.error('Usage: node scripts/recipe-groups-scan.js <menu.xlsx> ... [--out report.txt]'); process.exit(2); }

const lines = [];
const say = (s = '') => lines.push(s);
const label = (key) => categoryGroupInfo(key).label;

(async () => {
  const totals = { recipes: 0, otherOld: 0, otherNew: 0, otherRegrouped: 0 };
  for (const file of files) {
    const { workbook } = await loadWorkbookFromBuffer(fs.readFileSync(file));
    const { rows } = await parseWorkbookDishes(workbook, SCHOOL_VOCAB);
    const meta = rows.map((r) => ({ ...r, section: resolveSectionFromSheetName(r.sheetName), categoryGroup: categoryGroupFor({ category: r.category, period: r.period }) }));
    const dishes = dedupeWithinUpload(meta);
    // A new upload: a Staff lunch main no student shares is decided after generation; the scan uses the no-role fallback.
    const newGroup = (d) => (d.staffMainRole ? staffMainGroup({ name: d.name }).group : d.categoryGroup);
    const otherOld = dishes.filter((d) => categoryGroupOfRecipe({ category: d.category }).key === 'OTHER');
    const otherNew = dishes.filter((d) => newGroup(d) === 'OTHER');
    const regroup = planRegroup({ rows, recipes: dishes.map((d, i) => ({ id: i, name: d.name, source_dish_name: d.name, ingredientNames: [] })) });
    const regrouped = new Map(regroup.assignments.map((a) => [a.id, a.group]));
    const otherRegrouped = dishes.filter((d, i) => (regrouped.get(i) || categoryGroupOfRecipe({ category: d.category }).key) === 'OTHER');
    totals.recipes += dishes.length; totals.otherOld += otherOld.length; totals.otherNew += otherNew.length; totals.otherRegrouped += otherRegrouped.length;

    say(`=== ${path.basename(file)} -- ${dishes.length} recipes`);
    say(`    Other: ${otherOld.length} for drafts made before groups were saved, ${otherNew.length} for a new upload, ${otherRegrouped.length} after Re-group`);
    for (const d of otherNew) say(`      still Other (new upload): ${d.section} "${d.category}" ${d.name}`);

    // Every Staff "Main Dish" row, once per dish, with where its recipe lands.
    const staffRows = meta.filter((r) => r.section === 'STAFF' && /^main\s*dish$/i.test(String(r.category).trim()));
    const byName = new Map(dishes.map((d) => [d.name.toLowerCase().replace(/\s+/g, ' ').trim(), d]));
    const index = emptyDishIndex();
    dishes.forEach((d) => addNameToIndex(index, d.name));
    const seen = new Set();
    const table = { Breakfast: [], Lunch: [] };
    for (const r of staffRows) {
      const key = `${r.period}|${r.dishName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const exact = byName.get(r.dishName.toLowerCase().replace(/\s+/g, ' ').trim());
      const match = exact ? null : findDuplicateMatch(r.dishName, index);
      const d = exact || (match && byName.get(match.matchedName.toLowerCase().replace(/\s+/g, ' ').trim()));
      let where;
      if (!d) where = isExcludedCategory(r.category) || isReadyMadeItem(r.dishName) ? 'not a recipe (served as is)' : 'not a recipe';
      else if (!exact) where = `${label(d.staffMainRole ? staffMainGroup({ name: d.name }).group : d.categoryGroup)}  <- same dish as "${d.name}" (${d.section} "${d.category}")`;
      else if (d.section !== 'STAFF') where = `${label(d.categoryGroup)}  <- shared: ${d.section} "${d.category}"`;
      else if (d.staffMainRole) {
        where = hasMeatOrFish(d.name)
          ? `${label('MAIN')}  <- meat / fish in the name`
          : `AI role decides (no-role fallback: ${label(staffMainGroup({ name: d.name }).group)})`;
      } else where = `${label(d.categoryGroup)}  <- ${d.category === r.category ? 'Staff own' : `first seen as Staff "${d.category}"`}`;
      (table[r.period] || (table[r.period] = [])).push(`${r.dishName.padEnd(58)} ${where}`);
    }
    for (const period of Object.keys(table)) {
      if (!table[period].length) continue;
      say(`    Staff ${period} "Main Dish" (${table[period].length}):`);
      for (const l of table[period].sort()) say(`      ${l}`);
    }
    say();
  }
  say(`TOTAL ${totals.recipes} recipes. Other: ${totals.otherOld} before groups were saved -> ${totals.otherNew} for a new upload, ${totals.otherRegrouped} after Re-group.`);
  const text = lines.join('\n');
  if (outFile) { fs.writeFileSync(outFile, text + '\n'); console.log(`Report written to ${outFile}`); }
  console.log(text);
})().catch((err) => { console.error(err); process.exit(1); });
