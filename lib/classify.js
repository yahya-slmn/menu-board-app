// Auto-suggest category/protein when a staff member types a new item name.
// This mirrors the logic used in the original Excel import (classify.py).

const STARCH_KEYWORDS = ['rice', 'pasta', 'noodle', 'fries', 'spaghetti', 'macaroni', 'vermicelli'];
const VEGETABLE_KEYWORDS = ['vegetable', 'veggies', 'okra', 'eggplant', 'zucchini', 'broccoli',
  'spinach', 'stew', 'sauteed', 'mixed peppers', 'cucumber', 'carrot', 'artichoke', 'corn'];
const PROTEIN_OVERRIDES = { 'shesh tawok': 'CHICKEN', 'meatballs': 'BEEF' };
const PROTEIN_KEYWORDS = [['chicken', 'CHICKEN'], ['beef', 'BEEF'], ['lamb', 'LAMB'], ['lamp', 'LAMB'], ['fish', 'FISH']];

function detectProtein(nameLower) {
  for (const key in PROTEIN_OVERRIDES) {
    if (nameLower.includes(key)) return PROTEIN_OVERRIDES[key];
  }
  if (nameLower.includes('kofta')) {
    if (nameLower.includes('beef')) return 'BEEF';
    if (nameLower.includes('chicken')) return 'CHICKEN';
    return 'BEEF';
  }
  for (const [key, protein] of PROTEIN_KEYWORDS) {
    if (nameLower.includes(key)) return protein;
  }
  return null;
}

function suggestClassification(name, mealPeriod, sectionCode) {
  const n = name.toLowerCase();

  if (n.includes('milk')) return { category: 'MILK', protein: null, isDailyRepeating: true };
  if (n.includes('bun bread')) return { category: 'LUNCH_BREAD', protein: null, isDailyRepeating: true };
  if (n.includes('salad bar')) return { category: 'SALAD_BAR', protein: null, isDailyRepeating: true };
  if (n.includes('fruit bar')) return { category: 'FRUIT_BAR', protein: null, isDailyRepeating: true };
  if (n.startsWith('fruit') && n.includes('selection of seasonal')) {
    return { category: 'FRUIT_BASKET', protein: null, isDailyRepeating: true };
  }

  if (mealPeriod === 'PM_SNACK') return { category: 'PM_SNACK', protein: null, isDailyRepeating: false };
  if (mealPeriod === 'BREAKFAST') return { category: 'AM_SNACK', protein: null, isDailyRepeating: false };

  // Lunch-block heuristics
  if (n.includes('soup')) return { category: 'SOUP_APPETIZER', protein: null, isDailyRepeating: false };
  if (n.includes(' or laban') || n.includes('juice')) return { category: 'JUICE', protein: null, isDailyRepeating: false };

  const protein = detectProtein(n);
  if (protein) return { category: 'LUNCH_MAIN', protein, isDailyRepeating: false };

  if (STARCH_KEYWORDS.some(k => n.includes(k))) return { category: 'LUNCH_STARCH', protein: null, isDailyRepeating: false };
  if (VEGETABLE_KEYWORDS.some(k => n.includes(k))) {
    // Daycare split its vegetable-side slot into its own category (LUNCH_SALAD) --
    // see SECTION_SLOTS.DAYCARE in lib/generator.js. Every other section still uses
    // LUNCH_VEGETABLE.
    const category = sectionCode === 'DAYCARE' ? 'LUNCH_SALAD' : 'LUNCH_VEGETABLE';
    return { category, protein: null, isDailyRepeating: false };
  }

  return { category: null, protein: null, isDailyRepeating: false }; // needs manual selection
}

module.exports = { suggestClassification };
