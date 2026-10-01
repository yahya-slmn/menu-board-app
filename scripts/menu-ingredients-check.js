#!/usr/bin/env node
// Menu Ingredients Generator rules, checked on their own (npm test):
//   A. The shared heat-word list (lib/spicyFilter.js) catches the Middle Eastern chilies added 2026-10-01 -- and not
//      sweet pepper paste, bell or black pepper.
//   B. filterMenuIngredients (lib/menuIngredientFilters.js): nut / sesame, spicy, halal for everyone; seafood only for
//      a dish students eat; every removal reported with its policy; fish / shellfish allergens dropped with the seafood.
//      Plus the v2.1 clean-ups: "<forbidden>-free" wording stripped (not the substitute), repeated ingredients dropped,
//      comments written as ingredients ("... omitted") dropped.
//   C. dishesForSuggestion / toPayloadItem (lib/menuIngredientsRequest.js): one request per dish name, the first
//      row's context, seafood allowed only when no row is a student's; basisText.
//   D. Cross-section sharing (lib/menuIngredientsShare.js planShares, Phase D): a row follows the first row of the same
//      dish (case / spacing ignored) the same DAY in another section or file -- never the same section on another day,
//      never a student row after a Staff / CEO one, and only when both rows' own filtered results are identical.
//      The chef's tuna case: one shared AI answer, KG-LP's row has no tuna and a red note, Staff's keeps its tuna, and
//      neither follows the other, whatever the tab order.
//   E. Served as is (2026-10-01): Fruit Bar / Fruit Basket / Salad Bar rows, in every section, are never sent to the
//      AI and never share -- matched by CATEGORY ("Fruit (a Selection of Seasonal Fruits)" under Fruit Basket), with
//      ONE list shared with the Recipe Generator (whose own exclusions are unchanged).
// Pure functions only: no login, no database, no AI.
const { matchSpicyTerms } = require('../lib/spicyFilter');
const { filterMenuIngredients } = require('../lib/menuIngredientFilters');
const { dishesForSuggestion, toPayloadItem, basisText, cleanSuggestion, rowSeafoodAllowed, isServedAsIsRow } = require('../lib/menuIngredientsRequest');
const { isExcludedCategory, isServedAsIsCategory } = require('../lib/recipeGenerator');
const { planShares, rowKey, sameAsLabels } = require('../lib/menuIngredientsShare');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

// ---- A. heat words ------------------------------------------------------------------------------------------
for (const t of ['Aleppo pepper', 'aleppo chili flakes', 'pul biber', 'Urfa biber', 'isot pepper', 'hot pepper paste', 'hot red pepper paste', 'biber salçası', 'acı biber salçası']) {
  expect(matchSpicyTerms(t).length > 0, true, `spicy "${t}"`);
}
for (const t of ['sweet pepper paste', 'red pepper paste', 'tatlı biber salçası', 'bell pepper', 'black pepper', 'sweet paprika', 'cumin', 'isotonic drink', 'hot chocolate']) {
  expect(matchSpicyTerms(t), [], `not spicy "${t}"`);
}

// ---- B. the school's rules on one suggestion ----------------------------------------------------------------
const student = filterMenuIngredients(
  { ingredients: 'chicken - rice - aleppo pepper - pine nuts - white wine - shrimp - pork - salt', allergens: 'gluten - shellfish - fish - nuts' },
  { seafoodAllowed: false },
);
expect(student.ingredients, 'chicken - rice - salt', 'student dish: what is kept');
expect(student.removed.map((x) => `${x.segment}:${x.policy}`), ['aleppo pepper:spicy', 'pine nuts:nut', 'white wine:halal', 'shrimp:seafood', 'pork:halal'], 'student dish: what is removed, by policy');
expect(student.allergens, 'gluten', 'student dish: allergens');
expect(student.removedAllergens.map((x) => `${x.segment}:${x.policy}`), ['shellfish:seafood', 'fish:seafood', 'nuts:nut'], 'student dish: allergens removed');
const staff = filterMenuIngredients({ ingredients: 'salmon - lemon - chili flakes - dill', allergens: 'fish' }, { seafoodAllowed: true });
expect(staff.ingredients, 'salmon - lemon - dill', 'Staff dish keeps its seafood, loses the chili');
expect(staff.allergens, 'fish', 'Staff dish keeps its fish allergen');
expect(filterMenuIngredients({ ingredients: 'tuna - mayonnaise' }).ingredients, 'mayonnaise', 'no seafoodAllowed given: treated as a student dish');
expect(filterMenuIngredients({ ingredients: '', allergens: '' }), { ingredients: '', allergens: '', removed: [], removedAllergens: [], tidied: { negations: [], duplicates: [], comments: [] } }, 'an empty answer');
// Comments written as ingredients (both seen in the v2.1 trial) are dropped; a replacement keeps the new ingredient.
const commented = filterMenuIngredients({ ingredients: 'ground beef - onion - pine-free pine substitute omitted - chicken breast - sesame seeds omitted - tahini replaced with sunflower seed butter - shredded carrots' }, { seafoodAllowed: false });
expect(commented.ingredients, 'ground beef - onion - chicken breast - sunflower seed butter - shredded carrots', 'comments dropped, replacement kept');
expect(commented.removed, [], 'no red policy note for a comment');
expect(commented.tidied.comments.length, 3, 'comments reported');
// "pine-free herb garnish" (Dawood Basha, final trial): "pine" alone is no forbidden word, "pine nut" is.
expect(filterMenuIngredients({ ingredients: 'ground beef - pine-free herb garnish - pineapple chunks - pine-shaped cookies' }).ingredients, 'ground beef - herb garnish - pineapple chunks - pine-shaped cookies', '"pine-free" wording stripped; pineapple untouched');
// v2.1 clean-ups: a forbidden word named only as absent loses that wording (the substitute stays); repeats go.
const tidy = filterMenuIngredients({ ingredients: 'chicken - Garlic - yogurt - garlic - sesame-free seed garnish (sunflower seeds) - nut-free sunflower butter - gluten-free pasta - alcohol-free vanilla extract - yogurt' }, { seafoodAllowed: false });
expect(tidy.ingredients, 'chicken - Garlic - yogurt - seed garnish (sunflower seeds) - sunflower butter - gluten-free pasta - vanilla extract', 'the trial\'s self-defeating "sesame-free" substitute is kept; repeats dropped; gluten-free untouched');
expect(tidy.removed, [], 'nothing removed once the negated wording is gone');
expect(tidy.tidied.duplicates, ['garlic', 'yogurt'], 'repeats reported');
expect(tidy.tidied.negations, ['sesame-free', 'nut-free', 'alcohol-free'], 'negated wording reported');
expect(filterMenuIngredients({ ingredients: 'sesame seeds - toasted sesame oil' }).ingredients, '', 'a real sesame ingredient is still removed');
expect(filterMenuIngredients({ ingredients: 'chickpeas - fish sauce - worcestershire sauce - cumin' }, { seafoodAllowed: false }).ingredients, 'chickpeas - cumin', 'hidden seafood (fish / Worcestershire sauce) for students');

// ---- C. what is sent per dish -------------------------------------------------------------------------------
const row = (sheetName, period, category, dishName) => ({ sheetName, period, category, dishName, date: '04-10-2026', weekday: 'SUNDAY' });
const dishes = dishesForSuggestion([
  row('Daycare', 'Breakfast', 'AM Snack', 'Cheese Croissant'),
  row('Staff', 'Breakfast', 'Main Dish', 'Cheese Croissant'),
  row('Staff', 'Lunch', 'Main Dish', 'Grilled Salmon'),
  row('CEO', 'Lunch', 'Main Dish', 'Grilled Salmon'),
  row('Staff', 'Lunch', 'Main Dish', 'Tuna Pasta'),
  row('KG - LP', 'Lunch', 'Lunch Main Course', 'Tuna Pasta'),
  row('Week 5 menu', 'Lunch', 'Lunch Main Course', 'Fish Fingers'),
]);
expect(dishes.map((d) => d.name), ['Cheese Croissant', 'Grilled Salmon', 'Tuna Pasta', 'Fish Fingers'], 'one request per dish name, first-seen order');
expect(dishes[0], { key: 'cheese croissant', name: 'Cheese Croissant', category: 'AM Snack', section: 'Daycare', period: 'Breakfast', seafoodAllowed: false }, "a shared dish carries its first row's context");
expect(dishes[1].seafoodAllowed, true, 'adults only (Staff + CEO): seafood allowed');
expect(dishes[2].seafoodAllowed, false, 'also on a student sheet (KG-LP): no seafood');
expect(dishes[3].seafoodAllowed, false, "a sheet whose section can't be told: the safe default, no seafood");
expect(toPayloadItem(dishes[1], 4), { index: 4, name: 'Grilled Salmon', category: 'Main Dish', section: 'Staff', period: 'Lunch', seafoodAllowed: true }, 'the item sent');
expect(basisText({ kind: 'regional', dish: 'Kabsa', cuisine: 'Saudi' }), 'Regional: Kabsa (Saudi)', 'basis regional');
expect(basisText({ kind: 'general', dish: null, cuisine: null }), 'General', 'basis general');
expect(basisText(undefined), '', 'no basis (an older deployment)');

// ---- D. cross-section sharing -------------------------------------------------------------------------------
expect(dishesForSuggestion([row('Daycare', 'Lunch', 'Lunch Main Course', 'Mashed Potato'), row('KG - LP', 'Lunch', 'Lunch Starch/Side', 'mashed  potato')]).length, 1, 'one request for names differing only by case / spacing');
// Rows as main.js builds them: the shared raw answer, cleaned for each row's own section.
const tunaAnswer = { ingredients: 'tuna - mayonnaise - celery - brown bread', allergens: 'fish - egg - gluten', basis: { kind: 'general', dish: null, cuisine: null } };
const plainAnswer = { ingredients: 'butter - flour - akkawi cheese', allergens: 'gluten - dairy', basis: { kind: 'general', dish: null, cuisine: null } };
let n = 0;
const built = (fileIndex, sheetName, dishName, date, answer) => {
  const r = { fileIndex, sheetName, rowNumber: ++n, date, dishName };
  const c = cleanSuggestion(answer, { seafoodAllowed: rowSeafoodAllowed(r) });
  return { ...r, ingredients: c.ingredients, allergens: c.allergens, removed: c.removed };
};
const D1 = '04-10-2026', D2 = '05-10-2026';
for (const [order, staffFirst] of [['school tab first', false], ['Staff tab first', true]]) {
  n = 0;
  const kg = built(0, 'KG - LP', 'Tuna Sandwich', D1, tunaAnswer);
  const staff = built(0, 'Staff', 'Tuna Sandwich', D1, tunaAnswer);
  const rowsIn = staffFirst ? [staff, kg] : [kg, staff];
  const links = planShares(rowsIn);
  expect(kg.ingredients, 'mayonnaise - celery - brown bread', `${order}: KG-LP Tuna Sandwich shows no tuna`);
  expect(kg.removed.map((x) => `${x.segment}:${x.policy}`), ['tuna:seafood'], `${order}: KG-LP row has its red note`);
  expect(kg.allergens, 'egg - gluten', `${order}: KG-LP allergens without fish`);
  expect(staff.ingredients, 'tuna - mayonnaise - celery - brown bread', `${order}: Staff Tuna Sandwich keeps its tuna`);
  expect(links.has(rowKey(kg)) || links.has(rowKey(staff)), false, `${order}: neither tuna row follows the other`);
}
n = 0;
const dc = built(0, 'Daycare', 'Cheese Croissant', D1, plainAnswer);
const kgSame = built(0, 'KG - LP', 'cheese  croissant', D1, plainAnswer);         // same day, other section, case / space differ
const staffSame = built(0, 'Staff', 'Cheese Croissant', D1, plainAnswer);         // same day: Staff after school, same result
const dcNextDay = built(0, 'Daycare', 'Cheese Croissant', D2, plainAnswer);       // same section, another day
const kgNextDay = built(0, 'KG - LP', 'Cheese Croissant', D2, plainAnswer);       // follows Daycare's NEXT-day row, not day 1's
const sameSheet = built(0, 'Daycare', 'Cheese Croissant', D1, plainAnswer);       // same sheet, same day: no
const otherFile = built(1, 'MS - UP (B-G)', 'Cheese Croissant', D1, plainAnswer); // another file of the upload, same day
const edgeStaff = built(1, 'Staff', 'Fruit Salad', D1, plainAnswer);
const edgeKg = built(1, 'KG - LP', 'Fruit Salad', D1, plainAnswer);              // student row after a Staff one, equal text
const links = planShares([dc, kgSame, staffSame, dcNextDay, kgNextDay, sameSheet, otherFile, edgeStaff, edgeKg]);
const src = (r) => (links.get(rowKey(r)) ? rowKey(links.get(rowKey(r))) : null);
expect(src(kgSame), rowKey(dc), 'KG-LP follows Daycare the same day (case / spacing ignored)');
expect(src(staffSame), rowKey(dc), 'Staff follows the school row when its own result is the same');
expect(src(dcNextDay), null, 'the same section on another day stays its own row');
expect(src(kgNextDay), rowKey(dcNextDay), "another section's next-day row follows that day's source");
expect(src(sameSheet), null, 'the same sheet the same day: no following');
expect(src(otherFile), rowKey(dc), 'a row of another file of the upload follows (same day)');
expect(src(edgeKg), null, 'a student row never follows a Staff / CEO row');
expect(links.has(rowKey(dc)) || links.has(rowKey(edgeStaff)), false, 'a source never follows');

// ---- E. the export's "Same as" column (who a still-following row follows) ------------------------------------------
const lab = sameAsLabels([
  { fileIndex: 0, fileName: 'Week A.xlsx', rows: [
    { sheetName: 'Daycare', rowNumber: 2, dishName: 'Cheese Croissant', followsRef: null },
    { sheetName: 'KG - LP', rowNumber: 2, dishName: 'Cheese Croissant', followsRef: { fileIndex: 0, sheetName: 'Daycare', rowNumber: 2 } },
    { sheetName: 'Staff', rowNumber: 3, dishName: 'Cheese Croissant', followsRef: { fileIndex: 0, sheetName: 'Daycare', rowNumber: 2 }, unlinked: true },
  ] },
  { fileIndex: 1, fileName: 'Week A copy.xlsx', rows: [
    { sheetName: 'MS - UP (B-G)', rowNumber: 2, dishName: 'Cheese Croissant', followsRef: { fileIndex: 0, sheetName: 'Daycare', rowNumber: 2 } },
  ] },
]);
expect(lab.get('0|KG - LP|2'), "Daycare's Cheese Croissant", 'a following row names its source');
expect(lab.has('0|Staff|3'), false, 'a row edited for its own section gets no "Same as"');
expect(lab.has('0|Daycare|2'), false, 'a source gets no "Same as"');
expect(lab.get('1|MS - UP (B-G)|2'), "Daycare's Cheese Croissant (Week A.xlsx)", 'a source in another file is named with its file');

// ---- E. served as is ----------------------------------------------------------------------------------------
const servedRows = [
  { sheetName: 'KG - LP', category: 'Fruit Basket', period: 'Breakfast', dishName: 'Fruit (a Selection of Seasonal Fruits)' },
  { sheetName: 'MS - UP (B-G)', category: 'Fruit Basket', period: 'Breakfast', dishName: 'Fruit (a Choice of Fresh Fruit)' },
  { sheetName: 'KG - LP', category: 'Salad Bar', period: 'Lunch', dishName: 'Salad Bar' },
  { sheetName: 'Daycare', category: 'Fruit Bar', period: 'Lunch', dishName: 'Melon Cubes' },
  { sheetName: 'Staff', category: 'Fruit Basket', period: 'Lunch', dishName: 'Cut Fruits (Pineapple, Watermelon, Sweet Melon)' },
  { sheetName: 'CEO', category: 'Fruits', period: 'Lunch', dishName: 'Papaya Slice' },
  { sheetName: 'Daycare', category: 'PM Snack', period: 'PM Snack', dishName: 'Fruits Salad' },
  { sheetName: 'Staff', category: 'Sweets', period: 'Lunch', dishName: 'Fruit Cake' },
];
expect(dishesForSuggestion(servedRows).map((d) => d.name), ['Papaya Slice', 'Fruits Salad', 'Fruit Cake'],
  'Fruit Basket / Salad Bar / Fruit Bar rows (any section, any wording) are not sent; CEO Fruits, a fruit salad and a fruit cake are');
expect(servedRows.map(isServedAsIsRow), [true, true, true, true, true, false, false, false], 'served as is, by category');
expect(dishesForSuggestion([{ sheetName: 'Daycare', category: 'Fruit Bar', dishName: 'Melon Cubes' }, { sheetName: 'Daycare', category: 'PM Snack', dishName: 'melon  cubes' }]).map((d) => d.category),
  ['PM Snack'], 'the same name under a real category is still sent, with that row\'s context');
const servedShares = planShares([
  { fileIndex: 0, sheetName: 'KG - LP', rowNumber: 5, date: '13-09-2026', dishName: 'Fruit (a Selection of Seasonal Fruits)', ingredients: '', allergens: '', servedAsIs: true },
  { fileIndex: 0, sheetName: 'MS - UP (B-G)', rowNumber: 5, date: '13-09-2026', dishName: 'Fruit (a Selection of Seasonal Fruits)', ingredients: '', allergens: '', servedAsIs: true },
]);
expect(servedShares.size, 0, 'two blank served-as-is rows the same day never show "Same as"');
expect(['Bread', 'Milk', 'Juice', 'Beverages', 'Fruit Bar', 'Fruit Basket', 'Salad Bar', 'Lunch Main Course'].map(isExcludedCategory),
  [true, true, true, true, true, true, true, false], 'the Recipe Generator\'s exclusions are unchanged');
expect(['Bread', 'Milk', 'Juice', 'Beverages', 'Fruit Bar', 'Fruit Basket', 'Salad Bar', 'Fruits'].map(isServedAsIsCategory),
  [false, false, false, false, true, true, true, false], 'only the three served-as-is categories are shared with Menu Ingredients');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Menu Ingredients rules OK (${count} checks).`);
