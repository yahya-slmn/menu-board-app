const { supabase, supaFail } = require('./supabaseClient');

// supabase-js's functions.invoke() has no built-in timeout -- a genuinely hung request (a
// deployed function that never returns, a network partition) would otherwise wait forever with
// no ceiling, and the export UI has no other safety net against that (see conversation notes on
// the missing-try/catch bug this was found alongside). 45s is generous for a text-only
// (no-vision) Haiku call even for a large multi-process recipe -- this is a backstop for a
// genuinely stuck request, not a tight budget expected to matter on a normal call.
const TRANSLATE_TIMEOUT_MS = 45_000;

// Calls the translate-recipe Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/translate-recipe) -- same trust boundary as
// lib/recipeExtraction.js's extract-recipe call. `texts` is a flat, order-preserving array of
// strings to translate -- this module has no idea what any given string actually is (a recipe
// field, an ingredient name, a fixed export template label), and neither does the Edge
// Function; building that array and mapping the translated array back onto a recipe/ingredients/
// processes shape is entirely main.js's job (see translateForBookExport/
// translateForExtractorExport there), same split as extractRecipeFromFile/
// extract-recipe-for-extractor already established.
async function translateTexts({ targetLanguage, texts }) {
  const invokePromise = supabase.functions.invoke('translate-recipe', {
    body: { targetLanguage, texts },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Translation timed out after ${TRANSLATE_TIMEOUT_MS / 1000}s`)), TRANSLATE_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('translateTexts', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Translation failed');
  }
  return data.data.texts;
}

module.exports = { translateTexts };
