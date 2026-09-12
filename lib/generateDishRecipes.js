const { supabase, supaFail } = require('./supabaseClient');

// Longer than suggestDishIngredients' own 75s backstop -- a full recipe (nested processes,
// ingredients, method steps) per dish is a much bigger generation than one short ingredient
// string, and generate-dish-recipes' own batch size is sized down specifically to still fit
// comfortably within this window (see that function's header comment). Bumped from 90s to 120s
// when the Edge Function moved from Haiku 4.5 to Sonnet 5 -- Sonnet is meaningfully slower per
// token than Haiku, so the old Haiku-tuned budget left less safety margin than intended for the
// largest/slowest generation call in this app.
const GENERATE_TIMEOUT_MS = 120_000;

// Calls the generate-dish-recipes Supabase Edge Function, which holds the Anthropic API key
// server-side -- same trust boundary as suggestDishIngredients.js/estimateCalories.js's own
// calls. `items` is a flat array of { index, name, category } -- see lib/recipeGenerator.js for
// how the caller (main.js's parse-and-generate-recipes) builds it from a parsed menu upload.
// `existingWasteTypeNames` is the current waste_types catalog's names -- the Edge Function has
// no DB access of its own, so it can't look the catalog up itself; main.js passes it through so
// the model can match against it (or propose a new one) semantically. See that function's own
// header comment.
async function generateDishRecipes({ items, existingWasteTypeNames }) {
  const invokePromise = supabase.functions.invoke('generate-dish-recipes', {
    body: { items, existingWasteTypeNames },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Recipe generation timed out after ${GENERATE_TIMEOUT_MS / 1000}s`)), GENERATE_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('generateDishRecipes', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Recipe generation failed');
  }
  return data.data.recipes;
}

module.exports = { generateDishRecipes };
