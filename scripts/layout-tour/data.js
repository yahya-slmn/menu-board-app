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
      calories_per_100g: i % 3 ? 180 + i : null, calories_unverified: i % 4 === 1, am_snack_style: i % 2 ? 'COLD_KITCHEN' : 'PASTRY',
      protein_code: p.code, protein_name: p.name, is_daily_repeating: i === 0, snack_rule_blocked: i === 3 && c.includes('Snack'),
      created_by_label: i % 2 ? 'OLD' : 'AI', rc_code: i === 2 ? null : `RC0${i}-0${2770 + i}`, is_active: true });
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
const { categoryGroupOfRecipe, lookAlikes } = require('../../lib/recipeCategoryGroups.js');
const withGroup = (r) => { const g = categoryGroupOfRecipe(r); return { ...r, category_group: g.key, category_group_label: g.label, category_group_order: g.order, category_group_saved: !!r.source_category_group }; };
// looks_like within one menu and group, as main.js listGeneratedRecipesWithGroups adds it.
function withLookAlikes(rows) {
  const buckets = new Map();
  for (const r of rows) { const k = `${r.source_menu_label}|${r.category_group}`; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(r); }
  for (const list of buckets.values()) { const a = lookAlikes(list.map((r) => r.name)); for (const r of list) r.looks_like = a.get(r.name) || []; }
  return rows;
}
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
  // A shared dish worded two ways (two recipes; each shows "Looks like: ..."), and a Staff main made before groups were
  // saved (no group: Other, and the folder offers "Re-group from the original menu...").
  ['Monday 05-10-2026', 'Pizza Margarita dino', 'AM Snack', 'AM_SNACK_BREAKFAST'],
  ['Monday 05-10-2026', 'Pizza Margarita', 'Main Dish', 'AM_SNACK_BREAKFAST'],
  ['Monday 05-10-2026', 'Lentil Curry with Rice Vegan', 'Main Dish', null],
];
const genRow = ([day, name, category, group], i) => withGroup({ id: 500 + i, name, category, source_menu_label: GEN_MENU, source_dish_name: name,
  source_day_label: day, source_category_group: group, created_at: '2026-09-30T10:00:00Z', code: `RG-${String(100 + i).padStart(5, '0')}`, date_created: '2026-09-30' });
const GEN_DRAFTS = withLookAlikes(GEN.map(genRow));
const GEN_CONFIRMED = withLookAlikes(GEN.map((r, i) => genRow(r, i + 100)));

const handlers = {
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
};
module.exports = { handlers };
