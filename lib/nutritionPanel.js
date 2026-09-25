// ============================================================
// The core nutrient panel picked out of a USDA FoodData Central food's nutrient list (the
// fdc-food Edge Function passes FDC's list through as [{ id, name, unit, value }], per 100 g).
// Pure, no DB access. Keys match the planned menu_item_nutrition columns.
//
// Ids are FDC's nutrient ids, never names: "Energy" is also the kJ row (1062). Energy falls back
// from 1008 (kcal) to the Atwater figures 2047 / 2048 that some Foundation foods carry instead.
// A nutrient FDC doesn't list for a food stays null (unknown), never 0.
// ============================================================

const CORE_NUTRIENTS = [
  { key: 'energy_kcal', ids: [1008, 2047, 2048], label: 'Energy', unit: 'kcal' },
  { key: 'protein_g', ids: [1003], label: 'Protein', unit: 'g' },
  { key: 'fat_g', ids: [1004], label: 'Fat', unit: 'g' },
  { key: 'sat_fat_g', ids: [1258], label: 'Saturated fat', unit: 'g' },
  { key: 'trans_fat_g', ids: [1257], label: 'Trans fat', unit: 'g' },
  { key: 'carbs_g', ids: [1005], label: 'Carbohydrate', unit: 'g' },
  { key: 'fiber_g', ids: [1079], label: 'Fiber', unit: 'g' },
  { key: 'sugars_g', ids: [2000], label: 'Sugars', unit: 'g' },
  { key: 'sodium_mg', ids: [1093], label: 'Sodium', unit: 'mg' },
  { key: 'cholesterol_mg', ids: [1253], label: 'Cholesterol', unit: 'mg' },
  { key: 'calcium_mg', ids: [1087], label: 'Calcium', unit: 'mg' },
  { key: 'iron_mg', ids: [1089], label: 'Iron', unit: 'mg' },
  { key: 'potassium_mg', ids: [1092], label: 'Potassium', unit: 'mg' },
  { key: 'vitamin_d_mcg', ids: [1114], label: 'Vitamin D', unit: 'µg' },
];

// { energy_kcal, protein_g, ... } (null where FDC has no value) plus `energy_nutrient_id`, which of
// the three energy figures was used (null when none was).
function extractPanel(nutrients = []) {
  const byId = new Map();
  for (const n of nutrients) {
    if (n && Number.isFinite(n.value) && !byId.has(n.id)) byId.set(n.id, n.value);
  }
  const panel = {};
  for (const { key, ids } of CORE_NUTRIENTS) {
    const id = ids.find((i) => byId.has(i));
    panel[key] = id == null ? null : byId.get(id);
    if (key === 'energy_kcal') panel.energy_nutrient_id = id ?? null;
  }
  return panel;
}

const DATA_TYPE_SHORT = { 'Survey (FNDDS)': 'FNDDS', 'SR Legacy': 'SR Legacy', Foundation: 'Foundation', Branded: 'Branded' };

module.exports = { CORE_NUTRIENTS, extractPanel, DATA_TYPE_SHORT };
