// Pure helpers for the Recipe Generator feature: which menu-row categories qualify for a
// generated recipe, and the 100g-reference normalization math -- no DB/network access, same
// "pure helper, main.js orchestrates" split as lib/nutFilter.js.

// Explicitly section-agnostic (confirmed with the chef): a dish qualifies by what its category
// TEXT means, not which section/sheet it came from. School menus combine Soup and Appetizers
// into one category (e.g. "Soup / Appetizer") -- it just matches both patterns below, still one
// dish, one recipe. Staff/CEO category labels are literal spreadsheet text rather than live DB
// category names (see lib/menuIngredients.js's own comment on this), so keyword matching against
// whatever text actually appears in the category column is the only approach that works
// uniformly across School/Staff/CEO uploads without hardcoding a category code per section.
const CATEGORY_KEYWORD_PATTERNS = [
  { label: 'AM / Breakfast', re: /\bam\b|\bbreakfast\b/i },
  { label: 'PM Snack', re: /\bpm\b/i },
  { label: 'Soup', re: /\bsoup\b/i },
  { label: 'Appetizers', re: /\bappetizer/i },
  { label: 'Main Course', re: /\bmain\b/i },
];

function matchesGeneratorCategory(categoryText) {
  if (!categoryText) return false;
  return CATEGORY_KEYWORD_PATTERNS.some((p) => p.re.test(categoryText));
}

function roundNice(n) {
  return Math.round(n * 100) / 100;
}

function sumProcessQuantities(processes) {
  return (processes || []).reduce((sum, proc) => (
    sum + (proc.ingredients || []).reduce((s, ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return isNaN(q) ? s : s + q;
    }, 0)
  ), 0);
}

// Scales every ingredient's quantity (across every process) so their combined sum lands on
// `targetGrams` (100, per the "100g reference recipe" requirement) -- generation asks the AI for
// a realistic NATURAL-scale recipe on purpose (LLMs are unreliable at hitting an exact numeric
// total), and this reuses the exact same multiplier = target / currentSum math Recipe
// Calculator's own "scale to target quantity" mode already relies on (renderer.js's
// computeMultiplierFromTarget/scaleIngredients) -- proven scaling math, just applied here right
// after generation instead of on demand. A recipe with nothing to sum (every ingredient came
// back quantity-less) is returned untouched -- nothing to scale from.
function normalizeProcessesToGrams(processes, targetGrams) {
  const currentSum = sumProcessQuantities(processes);
  if (!currentSum || currentSum <= 0) return processes;

  const multiplier = targetGrams / currentSum;
  return (processes || []).map((proc) => ({
    ...proc,
    ingredients: (proc.ingredients || []).map((ing) => {
      const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
      return { ...ing, quantity: isNaN(q) ? ing.quantity : roundNice(q * multiplier) };
    }),
  }));
}

module.exports = { matchesGeneratorCategory, normalizeProcessesToGrams, sumProcessQuantities };
