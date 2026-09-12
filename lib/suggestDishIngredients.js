const { supabase, supaFail } = require('./supabaseClient');

// Same missing-built-in-timeout reasoning as lib/estimateCalories.js's own ESTIMATE_TIMEOUT_MS --
// a backstop for a genuinely stuck request, not a tight budget expected to matter on a normal
// call. Bumped from 45s to 75s when the Edge Function moved from Haiku 4.5 to Sonnet 5 -- Sonnet
// is meaningfully slower per token than Haiku, so the old Haiku-tuned budget left less safety
// margin than intended even at the full 100-item batch size main.js sends.
const SUGGEST_TIMEOUT_MS = 75_000;

// Calls the suggest-dish-ingredients Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/suggest-dish-ingredients) -- same trust boundary as
// estimateCalories.js/estimateAmSnackStyle.js's own calls. `items` is a flat, order-preserving
// array of { name } -- this module has no idea which dish/row any given position corresponds to;
// building that array and mapping the returned suggestions back onto specific rows is main.js's
// job (see parse-and-suggest-menu-ingredients).
async function suggestDishIngredients({ items }) {
  const invokePromise = supabase.functions.invoke('suggest-dish-ingredients', {
    body: { items },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Ingredient suggestion timed out after ${SUGGEST_TIMEOUT_MS / 1000}s`)), SUGGEST_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('suggestDishIngredients', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Ingredient suggestion failed');
  }
  return data.data.estimates;
}

module.exports = { suggestDishIngredients };
