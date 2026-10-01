#!/usr/bin/env node
// Recipe Generator grouping rules, checked on their own (npm test runs this after the round trip):
//   A. What never gets a recipe: Fruit Bar / Fruit Basket / Salad Bar / Beverages rows whatever each row's name,
//      and Staff's drinks row ("Water/soft drink").
//   B. A Staff lunch main no student dish shares -> Main Hot Dish or Starch / Side Vegetables (staffMainGroup):
//      meat or fish in the name (the chef's real dish names, including the ones the old keyword list missed), meat or
//      fish in the ingredients, else the AI's role, else the plain-side-name fallback.
//   C. The re-group planner: old recipes matched back to their menu file, Staff lunch mains decided from their saved
//      ingredients, a recipe not in the file left out.
// Pure functions only: no login, no database, no files.
const { isExcludedCategory, isReadyMadeItem } = require('../lib/recipeGenerator');
const { staffMainGroup, categoryGroupInfo, CATEGORY_GROUPS } = require('../lib/recipeCategoryGroups');
const { planRegroup } = require('../lib/recipeRegroup');

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
let count = 0;
const expect = (got, want, what) => { count++; check(got === want, `${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };

// ---- A. exclusions ------------------------------------------------------------------------------------------
for (const c of ['Fruit Bar', 'Fruit Basket', 'Salad Bar', 'Beverages', 'Lunch Bread', 'Milk', 'Juice']) expect(isExcludedCategory(c), true, `excluded category "${c}"`);
for (const c of ['Lunch SALAD Side', 'Soup/Appetizer', 'AM Snack', 'Main Dish', 'Salad', 'Lunch Starch/Side', 'Option 3']) expect(isExcludedCategory(c), false, `not excluded "${c}"`);
for (const n of ['Water/soft drink', 'Water & Soft Drinks', 'Soft drink / water', 'Water', 'Orange Juice']) expect(isReadyMadeItem(n), true, `ready-made "${n}"`);
for (const n of ['Watermelon Feta Salad', 'Soft Shell Tacos', 'Cantaloupe Cubes']) expect(isReadyMadeItem(n), false, `not ready-made by name "${n}"`);

// ---- B. Staff lunch mains -----------------------------------------------------------------------------------
const group = (name, opts = {}) => staffMainGroup({ name, ...opts }).group;
// Protein in the name -- every one from the chef's September files, incl. those the old keyword list missed.
for (const n of ['Chicken Kebab Served with Saffron Sauce, Zereshk Rice and Tomatoes', 'Beef Marqouk', 'Saleeg with Beef Brisket',
  'Meat Kofta and Waffle Fries', 'Kabsa Chicken Rice', 'Fish Fillet', 'Oven Baked Chicken Sliders', 'Grilled Shrimp Pasta White Sauce',
  'Shrimp with Lemon, Garlic & Herbs', 'Garlic & Lemon Shrimp with Fresh Herbs', 'Kunafah Shrimp', 'Garlic-Lime Shrimp Skewers',
  'Grilled Salmon with Lemon, Garlic & Parsley', 'Swiss Steak', 'Garlic Parmesan Wings', 'Shakria Bel Laham', 'Turkey Ham Wrap',
  'White Rice with Broccoli and Chicken Cubes in Olive Oil']) {
  expect(group(n, { role: 'side' }), 'MAIN', `meat / fish in the name beats the role: "${n}"`);
}
// Meat or fish only in the ingredients (a name with no clue).
expect(group('Borsch', { ingredientNames: ['beetroot', 'beef shin', 'cabbage'] }), 'MAIN', 'Borsch with beef in its ingredients');
expect(group('Stuffed Cabbage with Lemon-Garlic Broth', { ingredientNames: ['cabbage', 'rice', 'minced lamb'], role: 'side' }), 'MAIN', 'stuffed cabbage with minced lamb');
expect(group('Lam with Stick Beans and Peas in Creamy Sauce', { ingredientNames: ['lamb shoulder', 'green beans'] }), 'MAIN', 'a typo name, lamb in the ingredients');
// Meatless: the AI's role decides.
expect(group('Pasta Cheddar Sauce', { ingredientNames: ['pasta', 'cheddar', 'milk'], role: 'main' }), 'MAIN', 'meatless, role main');
expect(group('Eggplant Parmigiana', { ingredientNames: ['eggplant', 'mozzarella'], role: 'main' }), 'MAIN', 'Eggplant Parmigiana, role main');
expect(group('Saffron Tomato Rice', { ingredientNames: ['rice', 'tomato', 'saffron'], role: 'side' }), 'SIDES', 'meatless, role side');
expect(group('Pumpkin & Red Beans', { role: 'main' }), 'MAIN', 'Pumpkin & Red Beans, role main');
// No role (drafts from before it existed): plain starch / vegetable names are sides, everything else a main.
for (const n of ['White Rice', 'White Steamed Rice', 'Steamed Vegetables', 'Roasted Potato Wedges', 'Mashed sweet potato', 'Rice with Fried Onion',
  'Green Beans Provençal', 'Sauteed Vegetables', 'Armenian Bulgur Pilaf', 'Herb- roasted baby potatoes', 'Stir Fry Vegetables',
  'Red Rice with Black Lemon', 'Creamy Cabbage - Coleslaw', 'Grilled mushroom, zucchini onion glazed']) {
  expect(group(n), 'SIDES', `no role, plain side name "${n}"`);
}
for (const n of ['Eggplant Parmigiana', 'Pumpkin Mac & Cheese', 'Vegan Burrito', 'Lentil Curry with Rice Vegan', 'Vegetable Noodles with Tofu',
  'Stuffed Bell Pepper with Rice and Tomato Sauce Vegan', 'Moussaka’a with Chickpeas & Tomato Sauce', 'Cheese Sambosa',
  'Vegan Ratatouille with Fresh Herbs', 'Biryani Rice Vegan', 'Spinach with Chickpeas Tomato Sauce', 'Vegan Burrito Bowl with Mashed Avocado']) {
  expect(group(n), 'MAIN', `no role, a meatless main "${n}"`);
}
expect(categoryGroupInfo('MAIN').label, 'Main Hot Dish', 'MAIN label');
expect(categoryGroupInfo('SIDES').label, 'Starch / Side Vegetables', 'SIDES label');
expect(categoryGroupInfo('AM_SNACK_BREAKFAST').label, 'Breakfast', 'AM_SNACK_BREAKFAST label');
expect(categoryGroupInfo('BREAKFAST').key, 'AM_SNACK_BREAKFAST', 'the pre-merge BREAKFAST key');
expect(CATEGORY_GROUPS[0].key, 'AM_SNACK_BREAKFAST', 'Breakfast is the first group');

// ---- C. re-group planner ------------------------------------------------------------------------------------
// Parsed rows of a menu (lib/menuIngredients.js parseWorkbookDishes shape), one day.
const row = (sheetName, period, category, dishName, n) => ({ sheetName, rowNumber: n, date: '04-10-2026', weekday: 'SUNDAY', category, dishName, layout: sheetName === 'Staff' ? 'STAFF' : 'SCHOOL', period });
const rows = [
  row('KG - LP', 'Breakfast', 'AM Snack', 'Cheese Croissant', 2),
  row('KG - LP', 'Lunch', 'Lunch Main Course', 'Chicken Freekeh', 3),
  row('KG - LP', 'Lunch', 'Lunch Starch/Side', 'Vermicelli Rice', 4),
  row('Daycare', 'Lunch', 'Fruit Bar', 'Melon Cubes', 5),
  row('Staff', 'Breakfast', 'Main Dish', 'Cheese Croissant', 2),
  row('Staff', 'Breakfast', 'Main Dish', 'Shakshuka', 3),
  row('Staff', 'Lunch', 'Main Dish', 'Chicken Freekeh', 4),
  row('Staff', 'Lunch', 'Main Dish', 'Vermicelli Rice', 5),
  row('Staff', 'Lunch', 'Main Dish', 'Steamed Vegetables', 6),
  row('Staff', 'Lunch', 'Main Dish', 'Borsch', 7),
  row('Staff', 'Lunch', 'Main Dish', 'Eggplant Parmigiana', 8),
  row('Staff', 'Lunch Box', 'Option 2', 'Turkey Club Sandwich', 9),
];
const recipes = [
  { id: 1, name: 'Cheese Croissant', source_dish_name: 'Cheese Croissant' },
  { id: 2, name: 'Shakshuka', source_dish_name: 'Shakshuka' },
  { id: 3, name: 'Chicken Freekeh', source_dish_name: 'Chicken Freekeh' },
  { id: 4, name: 'Vermicelli Rice', source_dish_name: 'Vermicelli Rice' },
  { id: 5, name: 'Steamed Vegetables', source_dish_name: 'Steamed Vegetables', ingredientNames: ['broccoli', 'carrots'] },
  { id: 6, name: 'Borsch', source_dish_name: 'Borsch', ingredientNames: ['beetroot', 'beef shin'] },
  { id: 7, name: 'Eggplant Parmigiana', source_dish_name: 'Eggplant Parmigiana', ingredientNames: ['eggplant', 'mozzarella'] },
  { id: 8, name: 'Turkey Club Sandwich', source_dish_name: 'Turkey Club Sandwhich' }, // saved with a typo: near-duplicate match
  { id: 9, name: 'Melon Cubes', source_dish_name: 'Melon Cubes' }, // Fruit Bar: never a recipe any more, not in the plan
  { id: 10, name: 'Mystery Dish', source_dish_name: 'Mystery Dish' }, // not on this menu
];
const plan = planRegroup({ rows, recipes });
const got = Object.fromEntries(plan.assignments.map((a) => [a.id, a.group]));
const want = { 1: 'AM_SNACK_BREAKFAST', 2: 'AM_SNACK_BREAKFAST', 3: 'MAIN', 4: 'SIDES', 5: 'SIDES', 6: 'MAIN', 7: 'MAIN', 8: 'LUNCH_BOX' };
for (const [id, g] of Object.entries(want)) expect(got[id], g, `re-group recipe ${id} (${recipes[id - 1].name})`);
expect(plan.notFound.map((n) => n.id).sort().join(','), '10,9', 're-group: not found in the file');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Recipe groups OK (${count} checks).`);
