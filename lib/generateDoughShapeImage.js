const { supabase, supaFail } = require('./supabaseClient');

// Same measured-138s-real-call reasoning as lib/generateDishImage.js's own IMAGE_TIMEOUT_MS --
// this is the SAME OpenAI Images API call shape (one image, "high" quality), just a different
// prompt/Edge Function, so the same timeout budget applies unchanged.
const IMAGE_TIMEOUT_MS = 240_000;

// Calls the generate-dough-shape-image Supabase Edge Function -- one isolated, top-down,
// transparent-background reference photo per call. main.js fires several of these concurrently
// (Promise.allSettled) to build a whole shape's stage x variation set without waiting on each one
// sequentially; this wrapper itself only ever makes one call, same "one dish/one image per call"
// convention generateDishImage.js already follows for the same underlying reason (OpenAI's
// Images API has no multi-prompt batch primitive).
async function generateDoughShapeImage({ shapeName, stage }) {
  const invokePromise = supabase.functions.invoke('generate-dough-shape-image', {
    body: { shapeName, stage },
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Dough shape image generation timed out after ${IMAGE_TIMEOUT_MS / 1000}s`)), IMAGE_TIMEOUT_MS);
  });

  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail('generateDoughShapeImage', error);
  if (!data || !data.success) {
    throw new Error(data?.error || 'Dough shape image generation failed');
  }
  return data.data;
}

module.exports = { generateDoughShapeImage };
