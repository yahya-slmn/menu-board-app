// Sample data behind the layout tour's stubbed window.api. Shapes follow the real ipcMain handlers in main.js; names
// are long on purpose (they wrap the way real ones do). Unlisted calls get [] (list* / search* / get*s) or null.
// A new screen in the tour that calls something else needs its handler here.
const g = require('../../lib/generator.js');
const SECTIONS = [['DAYCARE','Daycare'],['KG_LP','KG-LP'],['MS_UP','MS-UP'],['STAFF','Staff'],['CEO','CEO']].map(([code,name],i)=>({id:i+1,code,name}));
const catCodes = [...new Set(Object.values(g.SECTION_SLOTS).flatMap(s => s.map(r => r[0])))];
const pretty = c => c.replace(/_/g,' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());
const CATEGORIES = catCodes.map((code,i)=>({id:i+1, code, name: pretty(code)}));
const PROTEINS = ['CHICKEN','BEEF','VEGETARIAN','VEGAN','TURKEY','FISH','LAMB'].map((code,i)=>({id:i+1, code, name: pretty(code)}));
const LONG = ['Slow-roasted herb chicken with saffron rice and toasted vermicelli','Beef kofta with tahini-free yogurt sauce','Grilled halloumi and roasted vegetable wrap','Spinach and cheese fatayer','Mini za\'atar manakish with labneh and cucumber','Pasta','Mujaddara with caramelised onions and fresh salad','Oven-baked turkey ham and cheese croissant','Lentil soup'];
function items(section) {
  const cats = ['Lunch Main','Lunch Starch','Am Snack','Pm Snack','Lunch Salad','Staff Breakfast'];
  const out = []; let id = 1;
  for (const c of cats) for (let i = 0; i < 10; i++) {
    const p = PROTEINS[(i + id) % PROTEINS.length];
    out.push({ id: id++, name: LONG[(i + id) % LONG.length] + (i > 5 ? ' ' + i : ''), category_name: c, category_code: c.toUpperCase().replace(/ /g,'_'),
      calories_per_100g: i % 3 ? 180 + i : null, calories_unverified: i % 4 === 1,
      // MV5b: calories are the version's; some versions are shared, so Edit Item says "shared by N catalog rows".
      variant_id: 500 + i, variant_rows: i % 4 === 0 ? 3 : 1, am_snack_style: i % 2 ? 'COLD_KITCHEN' : 'PASTRY',
      protein_code: p.code, protein_name: p.name, is_daily_repeating: i === 0, snack_rule_blocked: i === 3 && c.includes('Snack'),
      created_by_label: i % 2 ? 'OLD' : 'AI', rc_code: i === 2 ? null : `RC0${i}-0${2770 + i}`, is_active: true,
      // Dish Catalog ingredients (M2): every other dish has an approved list -> the "ING" mark beside its name.
      ...(i % 2 ? {} : { ingredients_text: 'chicken thighs - basmati rice - onion - garlic - tomato paste - seven spices - olive oil - salt', allergens_text: 'none',
        ingredients_updated_at: '2026-10-02T08:00:00.000+00:00', ingredients_updated_by: 'tetiana' }) });
  }
  return out;
}
function pool(code) {
  const out = {};
  for (const [cat] of g.SECTION_SLOTS[code] || []) out[cat] = Array.from({ length: 8 }, (_, i) => ({ id: 1000 + i, name: LONG[i % LONG.length], is_daily_repeating: false, am_snack_style: i % 2 ? 'COLD_KITCHEN' : 'PASTRY', protein_type_id: 1 + (i % 5) }));
  return out;
}
const WASTES = [{ id: 1, name: 'Baking Waste', default_percent: 8.5, sort_order: 1 }, { id: 2, name: 'Trimming Waste', default_percent: 3, sort_order: 2 }];
const ing = (id, name, q) => ({ id, ingredient_id: id, quantity: q, unit: 'g', method: null, sort_order: id, ingredient_name: name, default_unit: 'g' });
const RECIPES = {
  1: { id: 1, code: 'TTY101', name: 'Za\'atar Croissant Dough', category: 'Bakery', portion_weight_grams: 60, quantity_produced: 1000, processes: [
    { id: 11, name: 'Dough', method: 'Mix, proof 1 hour, bake at 180C for 18 minutes in the oven.', sort_order: 1, material_id: null,
      ingredients: [ing(1,'Flour',500), ing(2,'Water',300), ing(3,'Instant yeast',8), ing(4,'Salt',10), ing(5,'Butter',60), ing(6,'Sugar',30)],
      wastes: [{ id: 1, waste_type_id: 1, name: 'Baking Waste', percent: 8.5, sort_order: 1 }] } ] },
  2: { id: 2, code: 'TTY202', name: 'Knafeh Tray (base and cheese layer)', category: 'Dessert', portion_weight_grams: 80, quantity_produced: 2000, processes: [
    { id: 21, name: 'Semolina base', method: 'Press into the tray, bake at 190C for 20 minutes.', sort_order: 1, material_id: null,
      ingredients: [ing(11,'Semolina',600), ing(12,'Butter',250), ing(13,'Sugar',80), ing(14,'Milk',200)],
      wastes: [{ id: 2, waste_type_id: 1, name: 'Baking Waste', percent: 6, sort_order: 1 }, { id: 3, waste_type_id: 2, name: 'Trimming Waste', percent: 3, sort_order: 2 }] },
    { id: 22, name: 'Cheese filling', method: 'Spread over the base.', sort_order: 2, material_id: null,
      ingredients: [ing(15,'Akkawi cheese',700), ing(16,'Mozzarella',300), ing(17,'Cream',100)],
      wastes: [{ id: 4, waste_type_id: 1, name: 'Baking Waste', percent: 4, sort_order: 1 }] } ] },
};
const MATERIALS = [
  { id: 1, code: 'TR-01', name: 'Half sheet tray 45x33', category: 'tray_pan', shape_type: 'rectangular', length_cm: 45, width_cm: 33, height_cm: 3, weight_grams: 3000 },
  { id: 2, code: 'TR-02', name: 'Round cake pan 28', category: 'tray_pan', shape_type: 'round', diameter_cm: 28, height_cm: 5, weight_grams: 1800 },
  { id: 3, code: 'TR-03', name: 'Muffin tray 3x4', category: 'tray_pan', shape_type: 'muffin_tray', length_cm: 35, width_cm: 27, height_cm: 3, cup_rows: 3, cup_columns: 4, cup_diameter_cm: 7, cup_depth_cm: 3, weight_grams: 90 },
  { id: 4, code: 'CU-01', name: 'Round cutter 7cm', category: 'cutter', shape_type: 'round', diameter_cm: 7, height_cm: 3 },
  { id: 5, code: 'CU-02', name: 'Square cutter 6cm', category: 'cutter', shape_type: 'rectangular', length_cm: 6, width_cm: 6, height_cm: 3 },
];
// Recipe Generator lists, shaped as main.js returns them (listGeneratedRecipesWithGroups: the saved group, else a guess from
// the category text). Days deliberately out of order and a Staff "Main Dish" with its group saved, plus one without.
const { categoryGroupOfRecipe } = require('../../lib/recipeCategoryGroups.js');
const withGroup = (r) => { const g = categoryGroupOfRecipe(r); return { ...r, category_group: g.key, category_group_label: g.label, category_group_order: g.order, category_group_saved: !!r.source_category_group }; };
const GEN_MENU = '13_09_2026 week_4.xlsx';
const GEN = [
  ['Monday 05-10-2026', 'Chicken Freekeh with Roasted Vegetables and Yogurt Sauce', 'Lunch Main', 'MAIN'],
  ['Sunday 04-10-2026', 'Cheese Croissant', 'AM Snack', 'AM_SNACK_BREAKFAST'],
  ['Sunday 04-10-2026', 'Turkey Club Sandwich', 'Option 1', 'LUNCH_BOX'],
  ['Sunday 04-10-2026', 'Beef Kofta with Tahini-free Yogurt', 'Main Dish', 'MAIN'],
  ['Sunday 04-10-2026', 'Shakshuka', 'Main Dish', 'BREAKFAST'], // a pre-merge key: must still group as AM Snack / Breakfast
  ['Sunday 04-10-2026', 'Fattoush', 'Lunch Salad', null],
  ['Sunday 04-10-2026', 'Vermicelli Rice', 'Lunch Starch', null],
  ['Sunday 04-10-2026', 'Halloumi Wrap', 'Option 2', 'LUNCH_BOX'],
  ['Sunday 04-10-2026', 'Mini Zaatar-free Herb Manakish', 'AM Snack', 'AM_SNACK_BREAKFAST'],
  ['Sunday 04-10-2026', 'Lentil Soup', 'Soup / Appetizer', null],
  ['Sunday 04-10-2026', 'Date Cake', 'Sweets', 'SWEETS'],
  ['Sunday 04-10-2026', 'Oat Cookies', 'PM Snack', null],
  ['Monday 05-10-2026', 'Spinach Fatayer', 'AM Snack', 'AM_SNACK_BREAKFAST'],
  ['Monday 05-10-2026', 'Grilled Chicken Caesar-style Salad', 'Option 3', 'LUNCH_BOX'],
  // A Staff main made before groups were saved (no group: Other, and the folder offers "Re-group from the original menu...").
  ['Monday 05-10-2026', 'Lentil Curry with Rice Vegan', 'Main Dish', null],
];
const genRow = ([day, name, category, group], i) => withGroup({ id: 500 + i, name, category, source_menu_label: GEN_MENU, source_dish_name: name,
  source_day_label: day, source_category_group: group, created_at: '2026-09-30T10:00:00Z', code: `RG-${String(100 + i).padStart(5, '0')}`, date_created: '2026-09-30' });
const GEN_DRAFTS = GEN.map(genRow);
const GEN_CONFIRMED = GEN.map((r, i) => genRow(r, i + 100));

const LIST = 'chicken thighs - basmati rice - onion - garlic - tomato paste - tomatoes - carrot - dried black lime - kabsa spice - cinnamon stick - cardamom pods - bay leaves - vegetable oil - chicken stock - salt - black pepper - raisins';
const csEntry = (id, name, cat, sections, versions, saved = null) => ({ key: `item:${id}`, itemId: id, name, categoryCode: cat, categoryName: pretty(cat), sections, inactive: false,
  saved, expectedUpdatedAt: saved ? saved.updatedAt : null, versions, preselected: 0, disagree: versions.length > 1, status: saved ? 'changed' : 'new', versionStatus: versions.map(() => (saved ? 'changed' : 'new')) });
const csV = (ingredients, rows, sectionsText, extra = '') => ({ ingredients, allergens: 'gluten - dairy', rows, sections: [], days: [], files: [], sameAsSaved: false, reason: `${rows} row${rows === 1 ? '' : 's'}: ${sectionsText}${extra}` });
const CS_PLAN = { token: 'cs1', warnings: [], hasLists: true, rowsRead: 385, unchangedCount: 12,
  disagree: [
    csEntry(1, 'Oven-baked turkey ham and cheese croissant', 'AM_SNACK', ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF'], [csV('flour - butter - turkey ham - cheese - milk - eggs - sugar - yeast - salt', 6, 'Daycare, KG-LP, MS-UP', ' (most rows)'), csV('flour - butter - turkey ham - cheese - milk - eggs - sugar - yeast - salt - sesame seeds', 2, 'Staff')]),
    csEntry(2, 'Tuna pasta bake with sweet corn', 'LUNCH_MAIN', ['KG_LP', 'STAFF'], [csV('penne - tomato - sweet corn - mozzarella', 1, 'KG-LP', ' (first in the file -- same number of rows)'), csV('penne - tuna - tomato - sweet corn - mozzarella', 1, 'Staff')]),
  ],
  new: Array.from({ length: 14 }, (_, i) => csEntry(10 + i, LONG[i % LONG.length], 'LUNCH_MAIN', ['KG_LP', 'MS_UP'], [csV(LIST, 3, 'KG-LP, MS-UP')])),
  changed: Array.from({ length: 4 }, (_, i) => csEntry(40 + i, LONG[(i + 3) % LONG.length], 'SOUP_APPETIZER', ['DAYCARE'], [csV(LIST, 2, 'Daycare')],
    { ingredients: 'red lentils - onion - cumin - lemon juice - olive oil - salt', allergens: '', updatedAt: '2026-10-01T08:00:00.000+00:00', updatedBy: 'tetiana' })),
  notSaved: { notInCatalog: [{ name: 'Molokhiyya soup', sections: 'KG-LP' }, { name: 'Mozzarella sticks', sections: 'KG-LP' }, { name: 'Corn in the Cup', sections: 'Daycare' }],
    duplicates: [{ name: 'Pumpkin Soup', candidates: [{ id: 695, name: 'Pumpkin Soup' }, { id: 1552, name: 'Pumpkin Soup' }] }], blankDishes: ['Steamed Rice'], blankRows: 3, unclear: 10, servedAsIs: 40 },
};

// Menu Ingredients review after an upload (M3): rows from the Dish Catalog (with a red removal note on a student row),
// AI rows with their regional basis, a "Same as" follower and a served-as-is row -- set straight into the renderer's state.
const miRow = (sheetName, n, category, dishName, ingredients, extra = {}) => ({ fileIndex: 0, sheetName, rowNumber: n, date: '13-09-2026', weekday: 'Sunday', category, dishName,
  ingredients, allergens: 'gluten - dairy', basis: '', removedTerms: [], removedAllergenTerms: [], catalog: null, followsRef: null, servedAsIs: false, ...extra });
const CAT = { itemId: 1, name: 'x', updatedAt: '2026-10-02T08:00:00.000+00:00', updatedBy: 'tetiana' };
const MI_FILES = [{ fileIndex: 0, fileName: 'September week_04.xlsx', success: true, failures: [], rows: [
  miRow('Daycare', 5, 'AM Snack', LONG[7], 'flour - butter - turkey ham - cheese - milk - eggs - sugar - yeast - salt', { catalog: CAT }),
  miRow('Daycare', 6, 'Lunch Main Course', LONG[0], LIST, { basis: 'Regional: Kabsa (Saudi)' }),
  miRow('Daycare', 7, 'Lunch Main Course', 'Tuna Sandwich', 'brown bread - mayonnaise - lettuce', { catalog: CAT, removedTerms: [{ segment: 'tuna', policy: 'seafood' }] }),
  miRow('Daycare', 8, 'Fruit Bar', 'Melon Cubes', '', { allergens: '', servedAsIs: true }),
  miRow('KG - LP', 5, 'AM Snack', LONG[7], 'flour - butter - turkey ham - cheese - milk - eggs - sugar - yeast - salt', { followsRef: { fileIndex: 0, sheetName: 'Daycare', rowNumber: 5 } }),
] }];

// Ingredients master + Name map (U2): real-style purchasing names, and kitchen names with many candidates ("butter", "milk").
const ING_NAMES = ['Salt Fine Grain', 'Salt Rock', 'Salt Citric (Lemon Salt)', 'Spice Pepper Whole Black', 'Oil Olive', 'Olive Oil Mini Jar', 'Butter Kitchen', 'Butter Pastry',
  'Butter Portion', 'Flat Butter Sheet', 'Ghee Butter Base', 'Butter Spray', 'Butter Unsalted Block 10 Kg', 'Butter Garlic Herb Portion', 'Peanut-free Butter Spread',
  'Milk Liquid Full Fat', 'Milk Liquid  Low Fat', 'Milk Liquid Almond', 'Milk Powder', 'Strawberry Milk 180 Ml', 'Beef Short Rib', 'Beef Short-Rib', 'Frozen Corn Sweet', 'Frozen Sweet Corn',
  'Veg Carrot Baby', 'Veg Carrot Big', 'Egg Whole', 'Egg Powder', 'Sugar', 'Water'];
const ING = ING_NAMES.map((name, i) => ({ id: i + 1, name, product_code: i === 4 ? null : `FB-${10234 + i}`, category: ['Dry Store', 'Dairy', 'Veg', 'Meat'][i % 4], default_unit: 'G' }));
const cand = (re) => ING.filter((m) => re.test(m.name)).map((m) => ({ ...m, tier: 1 }));
const NAME_MAP = { totalRows: 9313, resolvedRows: 848, masterCount: 1693, categories: ['Dairy', 'Dry Store', 'Meat', 'Veg'],
  queue: [
    { key: 'salt', rows: 936, examples: ['Chicken Kabsa', 'Lentil Soup with Crispy Bread Croutons', 'Vermicelli Rice'], spellings: [{ name: 'salt', rows: 936 }], candidates: cand(/\bsalt\b/i) },
    { key: 'butter', rows: 367, examples: ['Cheese Croissant', 'Basbousa', 'Date Muffins'], spellings: [{ name: 'butter', rows: 367 }], candidates: cand(/butter/i) },
    { key: 'milk', rows: 164, examples: ['Semolina Pudding with Fresh Pomegranate'], spellings: [{ name: 'milk', rows: 164 }], candidates: cand(/milk/i) },
    { key: 'egg', rows: 232, examples: ['Omelette', 'Cake'], spellings: [{ name: 'eggs', rows: 154 }, { name: 'egg', rows: 78 }], candidates: cand(/egg/i) },
    { key: 'cornstarch', rows: 54, examples: ['Custard'], spellings: [{ name: 'cornstarch', rows: 54 }], candidates: [] },
  ],
  decided: [{ id: 1, name_key: 'olive oil', display_name: 'olive oil', ingredient_id: 5, decision: 'alias', decided_by: 'tetiana', decided_at: '2026-10-03T09:00:00Z', product: ING[4] },
    { id: 2, name_key: 'butter cream', display_name: 'butter cream', ingredient_id: null, decision: 'per_recipe', decided_by: 'tetiana', decided_at: '2026-10-03T09:05:00Z', product: null }] };

// Master Items (MV3): long names, a dish with two versions used by several rows.
const MV = (id, name, rows, list, recipe = null) => ({ id, displayName: name, ingredients: list, allergens: list ? 'gluten - dairy' : '', updatedAt: list ? '2026-10-02T09:00:00Z' : null,
  updatedBy: list ? 'tetiana' : null, source: list ? 'menu_upload' : null, calories: null, recipe, rows });
const MR = (id, name, category, sections) => ({ id, name, category, sections, active: true });
const MASTER_ITEMS = { unlinkedRows: 0, masters: [
  { id: 1, name: 'Macaroni & Cheese', rows: 4, versions: [
    MV(10, 'KG-LP, MS-UP — 2 Oct 2026', [MR(4678, 'Macaroni & Cheese', 'Lunch Starch/Side', ['KG-LP', 'MS-UP']), MR(4717, 'Macaroni & Cheese', 'Lunch Vegetable Side', ['MS-UP'])], 'macaroni - cheddar cheese - milk - butter - flour - salt - black pepper'),
    MV(11, 'Staff, CEO — 2 Oct 2026', [MR(2604, 'Macaroni & Cheese', 'Main Dish', ['Staff']), MR(3301, 'Macaroni & Cheese', 'Lunch Main Dish', ['CEO'])], 'macaroni - cheddar cheese - cream - parmesan - butter - garlic - nutmeg', { id: 3, code: 'TTY-00004', name: 'Macaroni & Cheese (Staff)' })] },
  ...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: LONG[i % LONG.length] + (i > 8 ? ' ' + i : ''), rows: 1 + (i % 3), versions: [
    MV(200 + i, ['KG-LP, MS-UP — 2 Oct 2026', 'Daycare — 3 Oct 2026', 'Staff — 3 Oct 2026'][i % 3], [MR(500 + i, LONG[i % LONG.length], 'Lunch Main Course', ['KG-LP', 'MS-UP'])], i % 2 ? LIST : '')] })),
] };

// Recipe Generator, "choose which dishes get a recipe": 1,500 distinct dishes over 20 days (four weeks), every category group,
// long names (the longest real one is 152 characters), a third with no reviewed list, some already with a draft / recipe.
const PICK_GROUPS = [['AM_SNACK_BREAKFAST', 'Breakfast', 0], ['SOUP_APPETIZER', 'Soup / Appetizer', 1], ['SALAD', 'Salad', 2], ['MAIN', 'Main Hot Dish', 3],
  ['SIDES', 'Starch / Side Vegetables', 4], ['SWEETS', 'Sweets', 5], ['LUNCH_BOX', 'Lunch Box', 6], ['PM_SNACK', 'PM Snack', 7], ['OTHER', 'Other', 8]];
const PICK_DAYS = Array.from({ length: 20 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 6 + Math.floor(i / 5) * 7 + (i % 5))); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'][i % 5]} ${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-2026`; });
const PICK_DISHES = Array.from({ length: 1500 }, (_, key) => {
  const [group, groupLabel, groupOrder] = PICK_GROUPS[key % PICK_GROUPS.length];
  const name = key % 97 === 0 ? 'Chicken Kebab Served with Saffron Sauce, Zereshk Rice and Tomatoes, a Side of Grilled Vegetables and Garlic Yogurt Dip with Fresh Mint and Sumac Onions'
    : `${LONG[key % LONG.length]}${key % 3 ? '' : ' (Staff)'} ${key}`;
  return { key, name, menuName: name, category: ['AM Snack', 'Soup/Appetizer', 'Lunch SALAD Side', 'Lunch Main Course', 'Lunch Starch/Side', 'Sweets', 'Option 1', 'PM Snack', 'Main Dish'][key % 9],
    dayLabel: PICK_DAYS[Math.floor(key / 75)], group, groupLabel, groupOrder, listCount: key % 3 === 1 ? 0 : 6 + (key % 9),
    existing: key % 11 === 0 ? { status: 'draft', code: null } : key % 17 === 0 ? { status: 'confirmed', code: `RG-0${1000 + key}` } : null };
});

// Menu Ingredients review grid: one realistic week (the real week-4 counts -- Daycare 9, KG-LP 13, MS-UP 14, Staff 32, CEO 9
// rows a day), and four of them as one 1,540-row upload. "Same as" rows, served-as-is rows, removed terms, catalog rows, and
// ingredient lists from short to the real longest (244 characters).
const MI_SECTIONS = [
  ['Daycare', ['AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch SALAD Side', 'Soup/Appetizer', 'Juice', 'Fruit Bar', 'PM Snack']],
  ['KG - LP', ['Fruit Basket', 'AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch Main Course', 'Lunch Starch/Side', 'Lunch Starch/Side', 'Salad Bar', 'Fruit Bar', 'Soup/Appetizer', 'Juice', 'PM Snack']],
  ['MS - UP (B-G)', ['Fruit Basket', 'AM Snack', 'Milk', 'Lunch Bread', 'Lunch Main Course', 'Lunch Main Course', 'Lunch Vegetable Side', 'Lunch Starch/Side', 'Lunch Starch/Side', 'Salad Bar', 'Fruit Bar', 'Soup/Appetizer', 'Juice', 'PM Snack']],
  ['Staff', [...Array(6).fill('Main Dish'), 'Juice', 'Juice', 'Appetizer', 'Appetizer', 'Salad', 'Salad', 'Salad', ...Array(7).fill('Main Dish'), 'Sweets', 'Sweets', 'Bread', 'Bread', 'Beverages', 'Beverages', 'Beverages', 'Option 1', 'Option 1', 'Option 2', 'Option 2', 'Option 3']],
  ['CEO', ['Main Dish', 'Juice', 'Yogurt', 'Main Dish', 'Salad', 'Juice', 'Snack', 'Bread', 'Snack']],
];
const MI_WORDS = ['chicken thighs', 'basmati rice', 'onion', 'garlic', 'tomato paste', 'seven spices', 'olive oil', 'salt', 'black pepper', 'cumin', 'carrot', 'zucchini', 'lemon juice', 'parsley', 'butter', 'full-fat milk', 'all-purpose flour', 'eggs', 'mozzarella cheese', 'canned crushed tomatoes', 'cinnamon', 'bay leaf', 'vegetable stock', 'cardamom', 'dried lime'];
function miWeek(fileIndex, weekStart) {
  const rows = [];
  MI_SECTIONS.forEach(([sheetName, cats], si) => {
    for (let d = 0; d < 5; d++) {
      const date = `${String(weekStart + d).padStart(2, '0')}-10-2026`;
      const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'][d];
      cats.forEach((category, k) => {
        const n = rows.length;
        const served = /fruit bar|fruit basket|salad bar/i.test(category);
        const len = 3 + ((n * 7) % 18);
        rows.push({ sheetName, rowNumber: 4 + d * 40 + k, date, weekday, category, dishName: `${LONG[(n + si) % LONG.length]}${k % 4 === 0 ? '' : ` ${k}`}`,
          layout: si < 3 ? 'school' : si === 3 ? 'staff' : 'ceo', period: /AM Snack|Milk|Juice|Yogurt/.test(category) || (si === 3 && k < 8) ? 'Breakfast' : 'Lunch',
          fileIndex, servedAsIs: served, ingredients: served ? '' : Array.from({ length: len }, (_, j) => MI_WORDS[(n + j * 3) % MI_WORDS.length]).join(' - '),
          allergens: served ? '' : ['gluten - dairy', 'dairy', 'egg - gluten', ''][n % 4], basis: n % 4 === 0 ? 'Regional: Kabsa (Saudi)' : 'General',
          removedTerms: !served && n % 7 === 0 ? [{ segment: 'pine nuts', policy: 'nut' }, { segment: 'chili flakes', policy: 'spicy' }] : [], removedAllergenTerms: [],
          catalog: !served && n % 5 === 0 ? { itemId: n, name: 'x', updatedAt: '2026-10-02T08:00:00.000Z', updatedBy: 'tetiana' } : null, followsRef: null, unlinked: false });
      });
    }
  });
  // KG-LP's AM Snack follows Daycare's (same day); Staff's first two lunch mains follow KG-LP's mains.
  const at = (sheet, date, cat, nth = 0) => rows.filter((r) => r.sheetName === sheet && r.date === date && r.category === cat)[nth];
  for (const r of rows) {
    const src = r.sheetName === 'KG - LP' && r.category === 'AM Snack' ? at('Daycare', r.date, 'AM Snack') : null;
    if (src) { Object.assign(r, { dishName: src.dishName, ingredients: src.ingredients, allergens: src.allergens, followsRef: { fileIndex, sheetName: src.sheetName, rowNumber: src.rowNumber } }); }
  }
  for (const r of rows.filter((x) => x.sheetName === 'Staff')) {
    const i = rows.filter((x) => x.sheetName === 'Staff' && x.date === r.date && x.category === 'Main Dish').indexOf(r) - 6;
    const src = i === 0 || i === 1 ? at('KG - LP', r.date, 'Lunch Main Course', i) : null;
    if (src) Object.assign(r, { dishName: src.dishName, ingredients: src.ingredients, allergens: src.allergens, followsRef: { fileIndex, sheetName: src.sheetName, rowNumber: src.rowNumber }, unlinked: i === 1 && r.date.startsWith('05') });
  }
  return { fileIndex, fileName: `October week_0${fileIndex + 1}.xlsx`, success: true, failures: [], rows };
}
const MI_WEEK = [miWeek(0, 4)];
const MI_MONTH = [0, 1, 2, 3].map((i) => miWeek(i, 4 + i * 7));

const handlers = {
  prepareRecipeGeneration: () => ({ success: true, fileName: 'September week_01-04_Ingredients.xlsx', failures: [], dishes: PICK_DISHES, estimate: { secondsPerBatch: 65, batchSize: 8 } }),
  // Menu Ingredients history: 12 entries -- a 4-file upload, long names, one incomplete, edited ones.
  miHistoryList: () => ({ runs: Array.from({ length: 12 }, (_, i) => ({ id: 40 - i, created_at: `2026-10-0${6 - (i % 5)}T0${8 + (i % 2)}:15:00.000Z`, created_by: ['tetiana', 'hana', 'yahya'][i % 3],
    file_names: i === 0 ? ['September week_01.xlsx', 'September week_02.xlsx', 'September week_03.xlsx', 'September week_04.xlsx']
      : [i === 3 ? 'Ramadan special menu with the extended Staff lunch options and the CEO breakfast rotation (final, revised).xlsx' : `October week_0${(i % 4) + 1}.xlsx`],
    row_count: i === 0 ? 1540 : 385, failed_files: i === 5 ? [{ fileName: 'old layout.xlsx', error: 'No recognizable menu rows' }] : null,
    complete: i !== 7, version: i % 4 === 1 ? 3 : 1, updated_at: '2026-10-06T11:40:00.000Z', updated_by: 'hana' })) }),
  miHistoryOpen: () => ({ uploadToken: 'tour-history', files: MI_FILES, meta: { id: 39, file_names: ['October week_02.xlsx'], created_at: '2026-10-05T09:15:00.000Z', created_by: 'hana', version: 3, complete: true } }),
  listGeneratedRecipeDrafts: () => GEN_DRAFTS, listGeneratedRecipes: () => GEN_CONFIRMED,
  // "Re-group from the original menu...": a canned preview (main.js builds it from the picked file) and its apply.
  previewRegroupGeneratedRecipes: ({ fileName } = {}) => ({ success: true, token: 't1', total: 6, willGroup: 5, notFound: ['Mystery Dish'],
    byGroup: [{ key: 'AM_SNACK_BREAKFAST', label: 'Breakfast', order: 0, count: 1 }, { key: 'MAIN', label: 'Main Hot Dish', order: 3, count: 2 },
      { key: 'SIDES', label: 'Starch / Side Vegetables', order: 4, count: 2 }], fileNameDiffers: fileName !== GEN_MENU }),
  applyRegroupGeneratedRecipes: () => ({ success: true, updated: 5 }),
  getSections: () => SECTIONS, getCategories: () => CATEGORIES, getProteinTypes: () => PROTEINS,
  getCategoriesForSection: () => CATEGORIES,
  getItems: () => items(), listCreatedByLabels: () => ['AI', 'OLD'], listRecipePeople: () => [],
  getSchoolDayCount: ({ startDate, endDate }) => g.schoolDayCountBetween(new Date(startDate), new Date(endDate)),
  getSchoolDays: ({ startDate, numWeekdays }) => g.schoolDaysFrom(new Date(startDate), numWeekdays),
  getSectionSlots: (code) => (g.SECTION_SLOTS[code] || []).map(([categoryCode, count, o]) => ({ categoryCode, count, fixedDaily: !!(o && o.fixedDaily) })),
  getSectionItemPool: (code) => pool(code),
  listRecipes: () => Object.values(RECIPES).map(({ processes, ...r }) => r),
  searchRecipes: (q) => Object.values(RECIPES).filter(r => r.name.toLowerCase().includes(String(q).toLowerCase())).map(({ processes, ...r }) => r),
  getRecipe: (id) => RECIPES[id], listMaterials: () => MATERIALS, getMaterial: (id) => MATERIALS.find(m => m.id == id),
  listWasteTypes: () => WASTES, listDoughShapePresets: () => ({ available: false }),
  // Menu Ingredients -> Save approved lists to the Dish Catalog: a canned preview with every group, long lists included.
  catalogIngredientsAvailable: () => true,
  listIngredients: () => ING, searchIngredients: (q) => ING.filter((m) => m.name.toLowerCase().includes(String(q).toLowerCase())).slice(0, 25),
  nameMapLoad: () => NAME_MAP,
  // The list (summaries) and, on open, the dish's detail -- as main.js returns them.
  // Recipe Generator bulk delete: the plan the confirmation shows (folders, dishes, a Master Item sharing a name).
  planGeneratedRecipeDelete: ({ ids }) => {
    const rs = GEN_DRAFTS.filter((d) => ids.includes(d.id));
    return { token: 'rgd', total: rs.length, drafts: rs.length, confirmed: 0, codes: [], missing: 0, codeTableReady: true, sharingAMasterItem: 2, dependentRows: { processes: rs.length + 3, ingredients: rs.length * 9 },
      folders: [{ folder: GEN_MENU, drafts: rs.length, confirmed: 0, recipes: rs.map((d, i) => ({ id: d.id, name: d.name, code: null, status: 'draft', dish: d.name,
        master: i < 2 ? { name: d.name, versions: 2, versionsWithList: 1 } : null })) }] };
  },
  listMasterItems: () => ({ masters: MASTER_ITEMS.masters.map((m) => ({ id: m.id, name: m.name, codes: m.versions.filter((v) => v.recipe).map((v) => v.recipe.code),
    createdBy: m.id === 1 ? ['AI', 'OLD'] : [['OLD'], ['AI'], ['Tetiana']][m.id % 3], versions: m.versions.map((v) => ({ id: v.id, hasList: !!v.ingredients })) })) }),
  masterItemDetail: (id) => MASTER_ITEMS.masters.find((m) => m.id === id),
  previewMasterItemsBuild: () => ({ token: 'mb1', conflicts: 0,
    summary: { mastersToCreate: 2987, variantsToCreate: 3011, listsToCarry: 198, listRowsToLink: 202, joiningRows: 141, plainRowsToLink: 3105, rowsToPick: 9, savedListsInCatalog: 202 },
    lists: Array.from({ length: 198 }, (_, i) => ({ dish: LONG[i % LONG.length], variant: 'KG-LP, MS-UP — 2 Oct 2026', from: [`#${100 + i} Lunch Main Course [KG-LP, MS-UP]`], joining: i % 3 ? [] : [`#${900 + i} Main Dish [Staff]`], ingredients: LIST })),
    toPick: [{ dish: 'Macaroni & Cheese', variants: 2, rows: ['#4717 Main Dish [CEO]'] }] }),
  // Dish Catalog -> Link rows without a version (MV6): one row of each kind, plus a long list to scroll.
  previewLinkUnlinkedRows: () => ({ token: 'lr1', rows: [
    ...Array.from({ length: 14 }, (_, i) => ({ id: 3500 + i, name: LONG[i % LONG.length], outcome: 'joined', where: 'Main Dish [Staff]' })),
    { id: 3520, name: 'Macaroni & Cheese', outcome: 'new-version', where: 'Main Dish [CEO]' },
    { id: 3521, name: 'Shakshuka with za\'atar', outcome: 'new-dish', where: 'AM Snack [Daycare, KG-LP]' }] }),
  ingredientMergeSuggestions: () => ({ suggestions: [{ why: 'spelling', items: [ING[20], ING[21]] }, { why: 'word order', items: [ING[22], ING[23]] }] }),
  previewIngredientMerge: ({ survivorId, mergedId }) => ({ survivor: ING.find((m) => m.id === survivorId), merged: ING.find((m) => m.id === mergedId), recipeRows: 2, aliases: 1, codeChoice: true }),
  // Dish Catalog -> Remove old codes (U1): the real proportions from the U0 measurement.
  previewCodeRemoval: () => ({ token: 'cr1', total: 2107, historyReady: true,
    codes: { count: 493, examples: [{ name: LONG[0], code: 'RC-00237' }, { name: LONG[1], code: 'RC01-02288' }, { name: LONG[2], code: 'RC02-02771' }] },
    placeholder: { count: 1614, examples: [{ name: LONG[3], code: 'NEW' }, { name: LONG[4], code: 'NEW' }, { name: LONG[5], code: 'NEW' }] },
    other: { count: 0, examples: [] } }),
  previewCatalogIngredientsSave: () => CS_PLAN,
  applyCatalogIngredientsSave: () => ({ saved: Array.from({ length: 41 }, (_, i) => ({ itemId: i, name: 'x' })), failed: [{ itemId: 9, name: 'Lentil Soup', error: 'network error' }],
    conflicts: [{ itemId: 7, name: 'Slow-roasted herb chicken with saffron rice and toasted vermicelli', by: 'chef2', at: '2026-10-02T09:30:00.000+00:00' }], historyError: null }),
};
module.exports = { handlers, MI_FILES, MI_WEEK, MI_MONTH };
