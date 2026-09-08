const { supabase, supaFail } = require('./supabaseClient');

// Same missing-built-in-timeout reasoning as lib/estimateCalories.js's own ESTIMATE_TIMEOUT_MS --
// a backstop for a genuinely stuck request, not a tight budget expected to matter on a normal
// call. 45s is generous for a text-only (no-vision) Haiku call even at the full 100-item batch
// size main.js sends.
const CLASSIFY_TIMEOUT_MS = 45_000;

// Calls the estimate-am-snack-style Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/estimate-am-snack-style) -- same trust boundary as
// estimateCalories.js's own call. `items` is a flat, order-preserving array of { name } -- this
// module has no idea which menu_items row any given position corresponds to; building that array
// and mapping the returned classifications back onto specific rows is main.js's job (see
// estimate-missing-am-snack-styles and the auto-classify-on-save path in add-item/update-item).
async function estimateAmSnackStyle({ items }) {
  const invokePromise = supabase.functions.invoke('estimate-am-snack-style', {
    body: { items },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`AM Snack style classification timed out after ${CLASSIFY_TIMEOUT_MS / 1000}s`)), CLASSIFY_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('estimateAmSnackStyle', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'AM Snack style classification failed');
  }
  return data.data.estimates;
}

module.exports = { estimateAmSnackStyle };
