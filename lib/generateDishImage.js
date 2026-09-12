const { supabase, supaFail } = require('./supabaseClient');

// High-quality image generation genuinely takes longer than a text call -- a real measured call
// for one dish at "high" quality took 138s end to end, so 90s (the first guess) was already
// cutting it close on a normal, successful call, not just a genuinely stuck one. 240s leaves real
// margin above that measured figure -- still a backstop for a stuck request, not a tight budget.
const IMAGE_TIMEOUT_MS = 240_000;

// Calls the generate-dish-image Supabase Edge Function, which holds the OPENAI_API_KEY secret
// server-side -- this app's ONLY OpenAI-backed call, kept in its own dedicated wrapper/Edge
// Function rather than folded into generateDishRecipes.js specifically because it's a different
// provider/account/trust boundary, not just a different prompt. One dish per call (OpenAI's
// Images API has no multi-prompt batch primitive the way Anthropic's structured-output calls do)
// -- main.js parallelizes across a batch of dishes by calling this several times at once
// (Promise.allSettled), not by asking this function to handle more than one dish. Returns
// { b64, ext } for the caller to hand straight to the EXISTING uploadGeneratedRecipePhoto helper
// -- this module never touches Supabase Storage itself.
async function generateDishImage({ dishName, category, ingredients, method }) {
  const invokePromise = supabase.functions.invoke('generate-dish-image', {
    body: { dishName, category, ingredients, method },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Image generation timed out after ${IMAGE_TIMEOUT_MS / 1000}s`)), IMAGE_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('generateDishImage', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Image generation failed');
  }
  return data.data;
}

module.exports = { generateDishImage };
