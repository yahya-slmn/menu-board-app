// ============================================================
// Recipe Generator category groups -- how drafts and confirmed recipes are grouped WITHIN a day (the chef's
// request, 2026-09-30: every AM Snack across the sections together, the Lunch Box options together, then the
// mains, and so on). One ordered taxonomy (CATEGORY_GROUPS, serving order) and one pure mapping from what a
// menu row says (its category / item label and meal period) to a group. No DB / network access.
//
// The meal period matters: Staff's "Main Dish" label is used for both Breakfast and Lunch, and a Lunch Box
// row's label is just "Option 1/2/3". The group is therefore worked out at generation time, from the parsed
// row, and saved with the draft (generated_recipes.source_category_group). A recipe saved before that column
// existed only has its category text, so categoryGroupFor({ category }) is the best guess for it, and an
// ambiguous "Main Dish" with no period lands in Other rather than being guessed.
// ============================================================

// AM Snack and Breakfast are ONE group, "Breakfast" (2026-09-30): Staff Breakfast serves the school AM Snacks
// alongside its own breakfast dishes, so splitting them would put one breakfast table under two headings. The labels
// were renamed the same day (Breakfast / Main Hot Dish / Starch / Side Vegetables); the stored keys never change.
const CATEGORY_GROUPS = [
  { key: 'AM_SNACK_BREAKFAST', label: 'Breakfast' },
  { key: 'SOUP_APPETIZER', label: 'Soup / Appetizer' },
  { key: 'SALAD', label: 'Salad' },
  { key: 'MAIN', label: 'Main Hot Dish' },
  { key: 'SIDES', label: 'Starch / Side Vegetables' },
  { key: 'SWEETS', label: 'Sweets' },
  { key: 'LUNCH_BOX', label: 'Lunch Box' },
  { key: 'PM_SNACK', label: 'PM Snack' },
  { key: 'OTHER', label: 'Other' },
];
const GROUP_BY_KEY = new Map(CATEGORY_GROUPS.map((g, order) => [g.key, { ...g, order }]));
// Keys used before AM Snack and Breakfast were merged (a draft saved with one still groups correctly).
const LEGACY_KEYS = { AM_SNACK: 'AM_SNACK_BREAKFAST', BREAKFAST: 'AM_SNACK_BREAKFAST' };

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// row: { category, period? } -- the category / item label cell and the meal-period cell of a parsed menu row
// (lib/menuIngredients.js parseWorkbookDishes), or a saved recipe's category text alone. Returns a group key.
function categoryGroupFor({ category, period } = {}) {
  const c = norm(category);
  const p = norm(period);
  // Staff's Lunch Box rows carry "Option N" (its salad is "Option 3") under the "Lunch Box" period.
  if (p === 'lunch box' || /^option \d+$/.test(c) || /\blunch\s*box\b/.test(c)) return 'LUNCH_BOX';
  if (/\bam\s*snacks?\b/.test(c)) return 'AM_SNACK_BREAKFAST';
  if (/\bpm\s*snacks?\b/.test(c)) return 'PM_SNACK';
  if (/\bbreakfast\b/.test(c)) return 'AM_SNACK_BREAKFAST';
  // Staff's "Main Dish" is Breakfast's or Lunch's, only the period says which.
  if (c === 'main dish') return p === 'breakfast' ? 'AM_SNACK_BREAKFAST' : p === 'lunch' ? 'MAIN' : 'OTHER';
  if (/\bsoups?\b|\bappeti[sz]ers?\b|\bstarters?\b/.test(c)) return 'SOUP_APPETIZER';
  if (/\bsalads?\b/.test(c)) return 'SALAD';
  if (/\bsweets?\b|\bdesserts?\b/.test(c)) return 'SWEETS';
  if (/\bstarch(es)?\b|\bvegetables?\b|\bsides?\b/.test(c)) return 'SIDES';
  if (/\bmains?\b/.test(c)) return 'MAIN';
  return 'OTHER';
}

// { key, label, order } for a stored key; an unknown or missing key is Other.
function categoryGroupInfo(key) {
  return GROUP_BY_KEY.get(LEGACY_KEYS[key] || key) || GROUP_BY_KEY.get('OTHER');
}

// A recipe row from the database: its saved group when it has one, else the best guess from its category text.
function categoryGroupOfRecipe(recipe) {
  const saved = recipe && recipe.source_category_group;
  const known = GROUP_BY_KEY.has(saved) || saved in LEGACY_KEYS;
  return categoryGroupInfo(known ? saved : categoryGroupFor({ category: recipe && recipe.category }));
}

// ------------------------------------------------------------------
// Staff lunch mains that no student dish claims (dedupeWithinUpload marks them staffMainRole): Main Hot Dish or
// Starch / Side Vegetables by the dish's ROLE on the plate, not by whether it has meat (confirmed 2026-09-30:
// Eggplant Parmigiana or a lentil curry is a main; plain rice or steamed vegetables is a side). In order:
//   1. meat or fish in the name, or in the recipe's ingredients -> Main Hot Dish (turkey is meat, seafood is fish);
//   2. the AI's role from the recipe-generation call ("main" / "side", generate-dish-recipes) when there is one;
//   3. no role (a draft generated before the role existed, re-grouped): a plain starch / vegetable name -> Starch /
//      Side Vegetables, anything else -> Main Hot Dish.
// Returns { group: 'MAIN' | 'SIDES', basis } -- basis says which step decided, for reports.
const { detectProtein } = require('./classify');
const { matchSeafoodTerms } = require('./seafoodFilter');
// Meat words detectProtein doesn't know (it knows turkey / chicken / beef / lamb / fish, shesh tawok, meatballs, kofta).
const EXTRA_MEAT_RE = /\b(steaks?|wings?|meat|laham|lahm|lahmeh|minced?|mince|ribs?|brisket|veal|mutton|shawarma|bacon|ham)\b/i;
function hasMeatOrFish(text) {
  const t = String(text || '');
  return !!(detectProtein(t.toLowerCase()) || matchSeafoodTerms(t).length || EXTRA_MEAT_RE.test(t));
}
// A plain accompaniment: built on a starch or a vegetable, with nothing that makes it the centre of the plate.
const SIDE_BASE_RE = /\b(rice|potato(es)?|fries|wedges|mash(ed)?|pur[eé]e|pasta|noodles?|spaghetti|penne|macaroni|vermicelli|bulgh?ur|burghul|freekeh|couscous|quinoa|vegetables?|veggies|green beans|beans|broccoli|cauliflower|carrots?|peas|corn|spinach|cabbage|zucchini|courgettes?|mushrooms?|okra|bamia|eggplant|aubergine|pumpkin|squash|coleslaw)\b/i;
const MAIN_MARKER_RE = /\b(stuffed|parmigiana|lasagn[ae]|burritos?|bowl|curry|mac\s*(&|and|n)\s*cheese|moussaka|sambosa|samosa|pies?|pizza|sandwich|wraps?|quiche|omelett?e|fritters?|casserole|tofu|lentils?|chickpeas?|falafel|ratatouille|biryani|kabsa|maqlub[ae]|mujaddara|koshari|gratin|tagine|stew|shakshuka)\b/i;
function isPlainSideName(name) {
  const n = String(name || '');
  return SIDE_BASE_RE.test(n) && !MAIN_MARKER_RE.test(n);
}
function staffMainGroup({ name, ingredientNames = [], role = null } = {}) {
  if (hasMeatOrFish(name)) return { group: 'MAIN', basis: 'meat or fish in the name' };
  if (ingredientNames.some(hasMeatOrFish)) return { group: 'MAIN', basis: 'meat or fish in the ingredients' };
  if (role === 'side') return { group: 'SIDES', basis: 'AI role: side' };
  if (role === 'main') return { group: 'MAIN', basis: 'AI role: main' };
  return isPlainSideName(name)
    ? { group: 'SIDES', basis: 'no role: plain starch / vegetable name' }
    : { group: 'MAIN', basis: 'no role: not a plain side name' };
}

module.exports = {
  CATEGORY_GROUPS, categoryGroupFor, categoryGroupInfo, categoryGroupOfRecipe,
  hasMeatOrFish, isPlainSideName, staffMainGroup,
};
