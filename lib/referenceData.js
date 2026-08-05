const { supabase, supaFail } = require('./supabaseClient');

// sections/categories/protein_types/age_groups/meal_periods are small, effectively-static
// lookup tables read constantly and synchronously throughout the app -- every dropdown, every
// nav render, and (via MenuGenerator's _categoryId/_sectionId/_proteinId) potentially thousands
// of times during a single menu generation run. Querying Supabase on every one of those would
// be both slow (network round trip) and unnecessary, so this module loads all five once into
// an in-memory cache and serves everything else out of plain JS arrays/Maps afterward.
//
// Must be loaded AFTER a successful login, not at app startup: RLS blocks anonymous reads of
// every table in this project (discovered back in the Item Catalog migration), so calling
// loadReferenceData() before auth-sign-in succeeds would just cache five empty arrays.
let cache = null;

async function loadReferenceData() {
  const [
    { data: sections, error: sErr },
    { data: categories, error: cErr },
    { data: proteinTypes, error: pErr },
    { data: ageGroups, error: aErr },
    { data: mealPeriods, error: mErr },
  ] = await Promise.all([
    supabase.from('sections').select('*').order('id'),
    supabase.from('categories').select('*'),
    supabase.from('protein_types').select('*').order('id'),
    supabase.from('age_groups').select('*').order('id'),
    supabase.from('meal_periods').select('*').order('sort_order'),
  ]);
  if (sErr) throw supaFail('loadReferenceData: sections', sErr);
  if (cErr) throw supaFail('loadReferenceData: categories', cErr);
  if (pErr) throw supaFail('loadReferenceData: protein_types', pErr);
  if (aErr) throw supaFail('loadReferenceData: age_groups', aErr);
  if (mErr) throw supaFail('loadReferenceData: meal_periods', mErr);

  const mealPeriodById = new Map(mealPeriods.map(mp => [mp.id, mp]));
  // Enriched + pre-sorted once here so getCategories()/getCategoryByCode() callers get the
  // same (meal_period.sort_order, category.sort_order) shape/order the old SQL JOINs produced.
  const categoriesEnriched = categories
    .map(c => {
      const mp = mealPeriodById.get(c.meal_period_id);
      return {
        ...c,
        meal_period_code: mp?.code,
        meal_period_name: mp?.name,
        meal_period_sort_order: mp?.sort_order ?? 0,
      };
    })
    .sort((a, b) => (a.meal_period_sort_order - b.meal_period_sort_order) || (a.sort_order - b.sort_order));

  cache = { sections, categories: categoriesEnriched, proteinTypes, ageGroups, mealPeriods };
}

function data() {
  if (!cache) throw new Error('Reference data not loaded -- loadReferenceData() must complete before this is called (see auth-sign-in in main.js).');
  return cache;
}

// --- sections ---
function getSections() { return data().sections; }
function getSectionByCode(code) { return data().sections.find(s => s.code === code) || null; }
function getSectionById(id) { return data().sections.find(s => s.id === id) || null; }

// --- categories (each row already carries meal_period_code/meal_period_name/meal_period_sort_order) ---
function getCategories() { return data().categories; }
function getCategoryByCode(code) { return data().categories.find(c => c.code === code) || null; }
function getCategoryById(id) { return data().categories.find(c => c.id === id) || null; }

// --- protein types ---
function getProteinTypes() { return data().proteinTypes; }
function getProteinByCode(code) { return data().proteinTypes.find(p => p.code === code) || null; }
function getProteinById(id) { return data().proteinTypes.find(p => p.id === id) || null; }

// --- age groups ---
function getAgeGroups() { return data().ageGroups; }
function getAgeGroupsForSection(sectionId) { return data().ageGroups.filter(a => a.section_id === sectionId); }
function getAgeGroupByCode(code) { return data().ageGroups.find(a => a.code === code) || null; }
function getAgeGroupById(id) { return data().ageGroups.find(a => a.id === id) || null; }

module.exports = {
  loadReferenceData,
  getSections, getSectionByCode, getSectionById,
  getCategories, getCategoryByCode, getCategoryById,
  getProteinTypes, getProteinByCode, getProteinById,
  getAgeGroups, getAgeGroupsForSection, getAgeGroupByCode, getAgeGroupById,
};
