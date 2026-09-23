const { supabase, supaFail } = require('./supabaseClient');

// Backstop for a genuinely stuck request, same reason as the other Edge Function wrappers (supabase-
// js's functions.invoke() has no timeout of its own). generate-menu-dishes runs Sonnet 5 with
// thinking off and is asked for at most ~20 dishes per call (lib/aiMenuGenerate.js) -- the same
// budget as generateDishRecipes.js, the other large Sonnet generation in this app.
const GENERATE_TIMEOUT_MS = 120_000;

// Calls the generate-menu-dishes Edge Function (holds the Anthropic API key server-side). `request`
// is the function's RequestBody as-is -- see supabase/functions/generate-menu-dishes/index.ts.
// Returns the raw dish objects; checking them (shape, safety, duplicates) is the caller's job.
async function generateMenuDishes(request) {
  let timer;
  const invokePromise = supabase.functions.invoke('generate-menu-dishes', { body: request });
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Dish generation timed out after ${GENERATE_TIMEOUT_MS / 1000}s`)), GENERATE_TIMEOUT_MS);
  });
  try {
    const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
    if (error) throw supaFail('generateMenuDishes', error);
    if (!data || !data.success) throw new Error(data?.error || 'Dish generation failed');
    return data.data.dishes;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateMenuDishes };
