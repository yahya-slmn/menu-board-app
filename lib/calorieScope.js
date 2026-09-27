// ============================================================
// Which dishes the calorie backfill (main.js runCalorieBackfill) estimates, and the AI Menu
// Generator's key ingredients it can use as input. Scope, confirmed with the chef 2026-09-23:
// every Daycare / KG-LP / MS-UP item without a calorie value (as before), PLUS every AI-generated
// item (menu_items.is_ai_generated) in ANY section -- so an AI Staff dish isn't left blank next to
// the AI school dishes from the same run. Hand-entered Staff / CEO items stay out.
// ============================================================
const { supabase, supaFail } = require('./supabaseClient');
const { getSectionByCode, getAgeGroupsForSection } = require('./referenceData');

const SCHOOL_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];

async function fetchAll(buildQuery, context) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw supaFail(context, error);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// Items still without calories: [{ id, name, category_id, protein_type_id, is_ai_generated }].
// `onlyItemIds` limits it to those ids (Approve's post-step for one run's new dishes).
async function loadCalorieCandidates({ onlyItemIds = null } = {}) {
  let ids;
  if (onlyItemIds) {
    ids = [...new Set(onlyItemIds)];
  } else {
    const ageGroupIds = SCHOOL_SECTIONS.map(getSectionByCode).filter(Boolean)
      .flatMap((section) => getAgeGroupsForSection(section.id).map((a) => a.id));
    const portionRows = ageGroupIds.length
      ? await fetchAll(() => supabase.from('item_portions').select('item_id').in('age_group_id', ageGroupIds).order('item_id'), 'calorieScope: load item_portions')
      : [];
    const aiRows = await fetchAll(() => supabase.from('menu_items').select('id').eq('is_ai_generated', true).is('calories_per_100g', null).order('id'),
      'calorieScope: load AI-generated items');
    ids = [...new Set([...portionRows.map((r) => r.item_id), ...aiRows.map((r) => r.id)])];
  }
  const items = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase.from('menu_items')
      .select('id, name, category_id, protein_type_id, is_ai_generated')
      .in('id', ids.slice(i, i + 300)).is('calories_per_100g', null);
    if (error) throw supaFail('calorieScope: load menu_items', error);
    items.push(...data);
  }
  return items;
}

// Map(itemId -> ingredient description) for the AI-generated items among `items`, from the key
// ingredients the AI wrote for each dish (its draft row: ai_menu_draft_dishes.resolved_item_id).
// Labelled as what it is -- names only, no quantities -- since the estimator is told an
// ingredients field is otherwise a real recipe.
async function aiKeyIngredientDescriptions(items) {
  const aiIds = items.filter((it) => it.is_ai_generated).map((it) => it.id);
  const out = new Map();
  for (let i = 0; i < aiIds.length; i += 300) {
    const { data, error } = await supabase.from('ai_menu_draft_dishes')
      .select('resolved_item_id, key_ingredients').in('resolved_item_id', aiIds.slice(i, i + 300));
    if (error) throw supaFail('calorieScope: load AI key ingredients', error);
    for (const r of data) {
      if (r.key_ingredients?.length) out.set(r.resolved_item_id, `Key ingredients (no quantities; from the dish's own description): ${r.key_ingredients.join(', ')}`);
    }
  }
  return out;
}

module.exports = { loadCalorieCandidates, aiKeyIngredientDescriptions, SCHOOL_SECTIONS };
