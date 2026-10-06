// ============================================================
// Ingredient name map (unification U2) -- the writes, with the database passed in (main.js passes Supabase; the checks
// pass a stand-in). Every decision is the chef's: "same as <product>" (an alias per spelling), "add as new ingredient"
// (a master row marked added_from 'name_review', then its aliases), "decide per recipe", and undo. A spelling is unique
// (ingredient_aliases.name_key), so when two people decide the same name at once the second gets the first one's decision
// back instead of overwriting it. Merging a duplicate master row moves its recipe rows and aliases to the survivor, keeps
// its name as an alias of the survivor, deletes it, and logs it (ingredient_merge_history).
// ============================================================
const { nameKey } = require('./ingredientMatch');

const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// spellings: the names of one queue group. Saves one alias row per spelling (decision 'alias' with ingredientId, or
// 'per_recipe' without). -> { saved: n } | { taken: [{ name_key, ingredient_id, decision, decided_by }] }
async function saveDecision({ db, spellings, ingredientId = null, decision = 'alias', who }) {
  if (decision === 'alias' && !ingredientId) throw new Error('Pick the product this name means.');
  const keys = [...new Set(spellings.map(nameKey).filter(Boolean))];
  const rows = keys.map((k) => ({ name_key: k, display_name: tidy(spellings.find((s) => nameKey(s) === k)), ingredient_id: decision === 'alias' ? ingredientId : null, decision, decided_by: who || null }));
  const { error } = await db.from('ingredient_aliases').insert(rows);
  if (!error) return { saved: rows.length };
  if (error.code !== '23505') throw new Error(error.message || String(error));
  // Someone decided (one of) these spellings first: hand their decision back, write nothing of ours.
  const { data } = await db.from('ingredient_aliases').select('name_key, ingredient_id, decision, decided_by').in('name_key', keys);
  return { taken: data || [] };
}

// A new master row from the review, then the group's spellings as its aliases. -> { ingredient, saved } | { duplicate }
async function addIngredientFromReview({ db, name, category, defaultUnit, spellings, who }) {
  const clean = tidy(name);
  if (!clean) throw new Error('Type the new ingredient\'s name.');
  const { data: same } = await db.from('ingredients').select('id, name').ilike('name', clean);
  if ((same || []).some((m) => nameKey(m.name) === nameKey(clean))) return { duplicate: (same || []).find((m) => nameKey(m.name) === nameKey(clean)) };
  const { data: ingredient, error } = await db.from('ingredients')
    .insert({ name: clean, category: tidy(category) || null, default_unit: tidy(defaultUnit) || 'G', product_code: null, added_from: 'name_review', added_by: who || null, created_at: new Date().toISOString() })
    .select('id, name, category, default_unit, product_code').single();
  if (error) throw new Error(error.message || String(error));
  // The new name itself is an exact match from now on; only the OTHER spellings need an alias.
  const others = spellings.filter((s) => nameKey(s) !== nameKey(clean));
  const r = others.length ? await saveDecision({ db, spellings: others, ingredientId: ingredient.id, who }) : { saved: 0 };
  return { ingredient, saved: r.saved || 0, taken: r.taken };
}

async function undoDecision({ db, aliasIds }) {
  const { error } = await db.from('ingredient_aliases').delete().in('id', aliasIds);
  if (error) throw new Error(error.message || String(error));
  return { removed: aliasIds.length };
}

// What a merge would do -- for the preview. -> { survivor, merged, recipeRows, aliases, codes: { survivor, merged }, codeChoice }
async function planMerge({ db, survivorId, mergedId }) {
  if (survivorId === mergedId) throw new Error('Pick two different ingredients.');
  const { data: both, error } = await db.from('ingredients').select('id, name, product_code, category, default_unit').in('id', [survivorId, mergedId]);
  if (error) throw new Error(error.message || String(error));
  const survivor = (both || []).find((m) => m.id === survivorId);
  const merged = (both || []).find((m) => m.id === mergedId);
  if (!survivor || !merged) throw new Error('One of these ingredients is no longer in Nayyara Ingredients.');
  const { data: rows } = await db.from('recipe_ingredients').select('id').eq('ingredient_id', mergedId);
  const { data: aliases } = await db.from('ingredient_aliases').select('id, name_key').eq('ingredient_id', mergedId);
  const sc = tidy(survivor.product_code), mc = tidy(merged.product_code);
  return { survivor, merged, recipeRows: (rows || []).length, aliases: (aliases || []).length,
    // Two different purchasing codes may be two real purchasing items: she picks which one the survivor keeps.
    codeChoice: !!(sc && mc && sc !== mc) };
}

// keepCode: 'survivor' (default) | 'merged' -- which product code the survivor keeps when both have one.
async function applyMerge({ db, survivorId, mergedId, keepCode = 'survivor', who }) {
  const p = await planMerge({ db, survivorId, mergedId });
  const step = async (label, q) => { const { error } = await q; if (error) throw new Error(`${label}: ${error.message || error}`); };
  await step('move recipe rows', db.from('recipe_ingredients').update({ ingredient_id: survivorId }).eq('ingredient_id', mergedId));
  await step('move aliases', db.from('ingredient_aliases').update({ ingredient_id: survivorId }).eq('ingredient_id', mergedId));
  // The duplicate's own name keeps matching: it becomes a spelling of the survivor (unless it is the same name already).
  const mergedKey = nameKey(p.merged.name);
  if (mergedKey !== nameKey(p.survivor.name)) {
    const { error } = await db.from('ingredient_aliases').insert({ name_key: mergedKey, display_name: tidy(p.merged.name), ingredient_id: survivorId, decision: 'alias', decided_by: who || null });
    if (error && error.code !== '23505') throw new Error(`keep the name: ${error.message || error}`);
  }
  const sc = tidy(p.survivor.product_code), mc = tidy(p.merged.product_code);
  const keptCode = keepCode === 'merged' && mc ? mc : sc || mc || null;
  if (keptCode !== (sc || null)) await step('product code', db.from('ingredients').update({ product_code: keptCode }).eq('id', survivorId));
  await step('delete the duplicate', db.from('ingredients').delete().eq('id', mergedId));
  const { error: hErr } = await db.from('ingredient_merge_history').insert({ survivor_id: survivorId, survivor_name: p.survivor.name, merged_id: mergedId, merged_name: p.merged.name,
    merged_product_code: mc || null, kept_product_code: keptCode, recipe_rows_moved: p.recipeRows, aliases_moved: p.aliases, merged_by: who || null });
  return { recipeRows: p.recipeRows, aliases: p.aliases, keptCode, historyError: hErr ? (hErr.message || String(hErr)) : null };
}

module.exports = { saveDecision, addIngredientFromReview, undoDecision, planMerge, applyMerge };
