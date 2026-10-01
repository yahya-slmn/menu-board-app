#!/usr/bin/env node
// Dish Catalog ingredients lookup (lib/catalogIngredients.js, phase M1), checked on its own (npm test):
//   A. a row matches a catalog dish only by EXACT name within the row's category, case / spacing aside -- never a
//      similar name, never the same name in another category;
//   B. Staff's shared Main Dish / Breakfast copies match the school dish of that name (one school category only);
//   C. two catalog dishes that differ only by case / spacing are 'ambiguous', not a guess;
//   D. rows with no usable category are 'unclear' with a reason; Fruit Bar / Basket / Salad Bar are served as is;
//   E. the per-call summary: a dish name needs no AI call only when every row of it matches a dish with a saved list.
// Pure functions only: no login, no database, no AI.
const { planIngredientLookup } = require('../lib/catalogIngredients');

const failures = [];
let count = 0;
const expect = (got, want, what) => {
  count++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${what}: got ${g}, expected ${w}`);
};

const categories = [
  { code: 'AM_SNACK', name: 'AM Snack' }, { code: 'LUNCH_MAIN', name: 'Lunch Main Course' }, { code: 'LUNCH_STARCH', name: 'Lunch Starch/Side' },
  { code: 'SOUP_APPETIZER', name: 'Soup/Appetizer' }, { code: 'PM_SNACK', name: 'PM Snack' }, { code: 'FRUIT_BASKET', name: 'Fruit Basket' },
  { code: 'STAFF_MAIN', name: 'Main Dish' }, { code: 'STAFF_APPETIZER', name: 'Appetizer' }, { code: 'STAFF_BREAKFAST', name: 'Main Dish' },
];
const catalog = [
  { id: 1, name: 'Chicken Kebab Served with yogurt sauce mint garlic sauce', category_code: 'LUNCH_MAIN', is_active: 1, ingredients_text: 'chicken - yogurt - mint - garlic' },
  { id: 2, name: 'Vermicelli Rice', category_code: 'LUNCH_STARCH', is_active: 1, ingredients_text: null },
  { id: 3, name: 'Lentil Soup', category_code: 'SOUP_APPETIZER', is_active: 0, ingredients_text: 'red lentils - onion' },
  { id: 4, name: 'White rice', category_code: 'LUNCH_STARCH', is_active: 1 },
  { id: 5, name: 'White  Rice', category_code: 'LUNCH_STARCH', is_active: 1 },
  { id: 6, name: 'Cheese Croissant', category_code: 'AM_SNACK', is_active: 1, ingredients_text: 'flour - butter - cheese' },
  { id: 7, name: 'Cheese Croissant', category_code: 'PM_SNACK', is_active: 1 },
  { id: 8, name: 'Grilled Fish', category_code: 'STAFF_MAIN', is_active: 1, ingredients_text: 'fish fillet - lemon' },
];
const school = (sheetName, category, dishName, rowNumber) => ({ sheetName, layout: 'SCHOOL', category, period: 'Lunch', dishName, rowNumber, weekday: 'Sunday', date: '13-09-2026' });
const staff = (period, category, dishName, rowNumber) => ({ sheetName: 'Staff', layout: 'STAFF', category, period, dishName, rowNumber, weekday: 'Sunday', date: '13-09-2026' });

const plan = planIngredientLookup({ catalog, categories, files: [{ fileName: 'Week 4', rows: [
  school('KG - LP', 'Lunch Main Course', 'chicken kebab served with  yogurt sauce mint garlic sauce', 10), // A exact, case + spacing
  school('MS - UP (B-G)', 'Lunch Main Course', 'Chicken Kebab Served with yogurt sauce mint and garlic sauce', 11), // A similar -> new
  school('KG - LP', 'Soup/Appetizer', 'Vermicelli Rice', 12),                     // A right name, wrong category -> new
  school('KG - LP', 'Lunch Starch/Side', 'Vermicelli Rice', 13),                  // A match, nothing saved
  school('Daycare', 'Soup/Appetizer', 'Lentil Soup', 14),                         // A inactive dish still matches
  staff('Lunch', 'Main Dish', 'Vermicelli Rice', 15),                             // B shared copy -> school dish 2
  staff('Breakfast', 'Main Dish', 'Cheese Croissant', 16),                        // B in AM and PM Snack -> ambiguous
  staff('Lunch', 'Main Dish', 'Grilled Fish', 17),                                // Staff's own dish first
  school('KG - LP', 'Lunch Starch/Side', 'WHITE RICE', 18),                       // C two catalog spellings -> ambiguous
  school('KG - LP', 'Mystery Label', 'Something', 19),                            // D unknown label
  school('Week 4 menu', 'Lunch Main Course', 'Chicken Kebab Served with yogurt sauce mint garlic sauce', 20), // D unknown sheet
  school('KG - LP', 'Fruit Basket', 'Fruit (a Selection of Seasonal Fruits)', 21), // D served as is
] }] });
const by = new Map(plan.rows.map((r) => [r.rowNumber, r]));
expect([by.get(10).status, by.get(10).itemId, by.get(10).saved], ['match', 1, true], 'exact name, case and spacing ignored');
expect(by.get(11).status, 'new', 'a similar name ("mint AND garlic") is not a match');
expect(by.get(12).status, 'new', 'the same name in another category is not a match');
expect([by.get(13).status, by.get(13).saved], ['match', false], 'a match with no saved list');
expect([by.get(14).status, by.get(14).inactive], ['match', true], 'an inactive catalog dish still matches (it is the same dish)');
expect([by.get(15).status, by.get(15).itemId, by.get(15).sharedCopy], ['match', 2, true], "Staff's Main Dish copy matches the school dish");
expect([by.get(16).status, by.get(16).candidates.map((c) => c.id)], ['ambiguous', [6, 7]], 'a Staff copy whose name is in two school categories is not guessed');
expect([by.get(17).status, by.get(17).itemId, by.get(17).sharedCopy], ['match', 8, false], "Staff's own dish matches in its own category");
expect([by.get(18).status, by.get(18).candidates.length], ['ambiguous', 2], 'two catalog spellings of one name are ambiguous');
expect([by.get(19).status, /unknown category label "Mystery Label"/.test(by.get(19).reason)], ['unclear', true], 'an unknown label is unclear, with the reason');
expect([by.get(20).status, /doesn't say which section/.test(by.get(20).reason)], ['unclear', true], 'an unknown sheet is unclear, with the reason');
expect(by.get(21).status, 'servedAsIs', 'Fruit Basket is served as is');

// E. calls: names are counted once across the upload (case / spacing aside), served-as-is rows make none.
const s = plan.summary;
expect([s.rows, s.servedAsIs, s.match, s.matchShared, s.matchInactive, s.matchSaved, s.new, s.ambiguous, s.unclear], [12, 1, 5, 1, 1, 3, 2, 2, 2], 'row counts');
// 8 names: chicken kebab (rows 10 + 20 -- 20 unclear), "... mint and garlic", vermicelli (12 new, 13 + 15 match), lentil, croissant, fish,
// white rice, "something". No call needed today: lentil (saved) and fish (saved). If every match were saved: the same two -- vermicelli
// still has its Soup row (new), the kebab its unclear row.
expect(s.calls, { today: 8, savedNow: 2, ifAllSaved: 2 }, 'AI calls: today / saved now / if every match had a list');

if (failures.length) {
  console.log(`FAILED (${failures.length} of ${count}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Dish Catalog ingredients lookup OK (${count} checks).`);
