const { supabase, supaFail } = require('./supabaseClient');

// Calls the extract-recipe Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/extract-recipe) -- this app never sees or stores an
// Anthropic key itself, only the already-authenticated Supabase session (supabase-js attaches
// that session's auth header to every functions.invoke() call automatically).
//
// Returns the raw extracted fields (shaped by the Edge Function's RECIPE_SCHEMA) -- mapping
// that onto the Recipe Extractor form's actual field names/types is main.js's job
// (extract-recipe-for-extractor handler), same split as every other IPC handler in this app:
// this module is the network call, main.js is where request/response shaping for the renderer
// happens. `files` is an array of { base64, mimeType } -- one or more photos/pages that may
// together represent a single recipe card (see the Edge Function's buildPrompt), sent as one
// call so the model has full cross-page context instead of extracting each file in isolation.
// Always extracts to English regardless of the source card's language -- a per-extraction
// target-language picker was tried and reverted; translation, if wanted, now happens at
// export time instead (a separate, later concern from extraction itself).
async function extractRecipeFromFile({ files }) {
  const { data, error } = await supabase.functions.invoke('extract-recipe', {
    body: { files },
  });
  if (error) throw supaFail('extractRecipeFromFile', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Recipe extraction failed');
  }
  return data.data;
}

module.exports = { extractRecipeFromFile };
