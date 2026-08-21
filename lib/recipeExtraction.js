const { supabase, supaFail } = require('./supabaseClient');

// Calls the extract-recipe Supabase Edge Function, which holds the Anthropic API key
// server-side (see supabase/functions/extract-recipe) -- this app never sees or stores an
// Anthropic key itself, only the already-authenticated Supabase session (supabase-js attaches
// that session's auth header to every functions.invoke() call automatically).
//
// Returns the raw extracted fields (shaped by the Edge Function's RECIPE_SCHEMA) -- mapping
// that onto the Recipe form's actual field names/types is main.js's job (extract-recipe-from-file
// handler), same split as every other IPC handler in this app: this module is the network call,
// main.js is where request/response shaping for the renderer happens.
async function extractRecipeFromFile({ base64, mimeType }) {
  const { data, error } = await supabase.functions.invoke('extract-recipe', {
    body: { base64, mimeType },
  });
  if (error) throw supaFail('extractRecipeFromFile', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Recipe extraction failed');
  }
  return data.data;
}

module.exports = { extractRecipeFromFile };
