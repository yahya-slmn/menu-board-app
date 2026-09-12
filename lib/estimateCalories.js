const { supabase, supaFail } = require('./supabaseClient');

// Same missing-built-in-timeout reasoning as lib/translateRecipe.js's own TRANSLATE_TIMEOUT_MS --
// a backstop for a genuinely stuck request, not a tight budget expected to matter on a normal
// call. Bumped from 45s to 75s when the Edge Function moved from Haiku 4.5 to Sonnet 5 -- Sonnet
// is meaningfully slower per token than Haiku, so the old Haiku-tuned budget left less safety
// margin than intended even at the full 100-item batch size main.js sends.
const ESTIMATE_TIMEOUT_MS = 75_000;

// Calls the estimate-calories Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/estimate-calories) -- same trust boundary as
// recipeExtraction.js/translateRecipe.js's own calls. `items` is a flat, order-preserving array
// of { name, category, protein } -- this module has no idea which menu_items row any given
// position corresponds to; building that array and mapping the returned estimates back onto
// specific rows is main.js's job (see the estimate-missing-calories handler there), same split
// translateTexts/extractRecipeFromFile already establish for their own Edge Function calls.
async function estimateCalories({ items }) {
  const invokePromise = supabase.functions.invoke('estimate-calories', {
    body: { items },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Calorie estimation timed out after ${ESTIMATE_TIMEOUT_MS / 1000}s`)), ESTIMATE_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('estimateCalories', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Calorie estimation failed');
  }
  return data.data.estimates;
}

module.exports = { estimateCalories };
