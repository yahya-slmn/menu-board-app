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
// Pure functions only: no login, no database, no AI.
const { matchSpicyTerms } = require('../lib/spicyFilter');
const { filterMenuIngredients } = require('../lib/menuIngredientFilters');
const { dishesForSuggestion, toPayloadItem, basisText } = require('../lib/menuIngredientsRequest');

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
expect(dishes[0], { name: 'Cheese Croissant', category: 'AM Snack', section: 'Daycare', period: 'Breakfast', seafoodAllowed: false }, "a shared dish carries its first row's context");
expect(dishes[1].seafoodAllowed, true, 'adults only (Staff + CEO): seafood allowed');
expect(dishes[2].seafoodAllowed, false, 'also on a student sheet (KG-LP): no seafood');
expect(dishes[3].seafoodAllowed, false, "a sheet whose section can't be told: the safe default, no seafood");
expect(toPayloadItem(dishes[1], 4), { index: 4, name: 'Grilled Salmon', category: 'Main Dish', section: 'Staff', period: 'Lunch', seafoodAllowed: true }, 'the item sent');
expect(basisText({ kind: 'regional', dish: 'Kabsa', cuisine: 'Saudi' }), 'Regional: Kabsa (Saudi)', 'basis regional');
expect(basisText({ kind: 'general', dish: null, cuisine: null }), 'General', 'basis general');
expect(basisText(undefined), '', 'no basis (an older deployment)');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Menu Ingredients rules OK (${count} checks).`);
