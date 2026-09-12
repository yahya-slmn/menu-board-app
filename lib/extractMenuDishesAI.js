const { supabase, supaFail } = require('./supabaseClient');

// Same missing-built-in-timeout reasoning as lib/suggestDishIngredients.js's own SUGGEST_TIMEOUT_MS
// -- a backstop for a genuinely stuck request, not a tight budget expected to matter normally.
// Bumped from 45s to 75s when the Edge Function moved from Haiku 4.5 to Sonnet 5 -- Sonnet is
// meaningfully slower per token than Haiku, so the old Haiku-tuned budget left less safety margin
// than intended even at the 50-row batch size main.js sends.
const EXTRACT_TIMEOUT_MS = 75_000;

// Calls the extract-menu-dishes Supabase Edge Function, which holds the Anthropic API key
// server-side -- same trust boundary as suggestDishIngredients.js/generateDishRecipes.js's own
// calls. `rows` is a batch of { i: rowNumber, c: cellText[] } from ONE worksheet (main.js's
// flattenSheetForAI chunked by extractDishesWithAI) -- this module has no idea which sheet any
// given row came from; attaching that back onto the result is main.js's job.
async function extractMenuDishesAI({ rows }) {
  const invokePromise = supabase.functions.invoke('extract-menu-dishes', {
    body: { rows },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Menu dish extraction timed out after ${EXTRACT_TIMEOUT_MS / 1000}s`)), EXTRACT_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('extractMenuDishesAI', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Menu dish extraction failed');
  }
  return data.data.dishes;
}

module.exports = { extractMenuDishesAI };
