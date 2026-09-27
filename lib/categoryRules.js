// ============================================================
// Structural category rules that hold for EVERY dish, whoever made it (catalog, chef or AI).
//
// Chicken and beef are lunch only: never in AM Snack or PM Snack, whether the protein type says so
// or the words do ("beef bacon", "chicken ham"). Whole words only, so "chickpea" and "beefsteak
// tomato" are fine. Turkey, lamb, egg, dairy and vegetarian snacks stay allowed (confirmed
// 2026-09-24). Staff Breakfast is a different meal and is not covered (its two shared school AM
// Snacks inherit the rule).
//
// Applied (2026-09-24, the chef's explicit exception to "new rules apply forward only", since this is
// about the category, not about AI content): the AI safety check (lib/aiMenuSafety.js), the engine's
// catalog pools and copied / shared picks (lib/generator.js), Build Menu's dropdowns
// (get-section-item-pool in main.js) and the AI review screen's catalog replace list
// (lib/aiMenuReview.js). Saved menus in History are never changed or flagged; offending catalog
// dishes stay in the catalog (tagged in the Dish Catalog) until a chef renames, recategorises or
// deactivates them -- scripts/snack-chicken-beef-list.js lists them.
//
// Pure: no DB. Mirrored in renderer/renderer.js (SNACK_LUNCH_ONLY_*) for the Add / Edit Item warning.
// ============================================================
const SNACK_CATEGORIES = ['AM_SNACK', 'PM_SNACK'];
const LUNCH_ONLY_PROTEINS = ['CHICKEN', 'BEEF'];
const LUNCH_ONLY_WORDS = /\b(chicken|beef)\b/i;
const SNACK_LUNCH_ONLY_WHY = 'chicken and beef are served at lunch only — never in AM or PM Snack (turkey, egg, dairy and vegetarian snacks are fine)';

// { field, term } for the first thing that puts a dish outside its snack category, or null. `texts`
// are [field, text] pairs (a catalog item only has its name; an AI dish also has description and
// key ingredients).
function snackLunchOnlyHit(categoryCode, proteinCode, texts) {
  if (!SNACK_CATEGORIES.includes(categoryCode)) return null;
  if (proteinCode && LUNCH_ONLY_PROTEINS.includes(proteinCode)) return { field: 'protein_code', text: proteinCode, term: proteinCode.toLowerCase() };
  for (const [field, text] of texts) {
    const m = text && String(text).match(LUNCH_ONLY_WORDS);
    if (m) return { field, text, term: m[0].toLowerCase() };
  }
  return null;
}

module.exports = { SNACK_CATEGORIES, LUNCH_ONLY_PROTEINS, LUNCH_ONLY_WORDS, SNACK_LUNCH_ONLY_WHY, snackLunchOnlyHit };
