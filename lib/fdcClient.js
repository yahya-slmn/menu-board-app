const { supabase, supaFail } = require('./supabaseClient');

// Calls the fdc-food Supabase Edge Function, which holds the USDA FoodData Central API key
// server-side (see supabase/functions/fdc-food) -- same trust boundary as estimateCalories.js.
// Plain FDC data only, no AI. A backstop timeout for a stuck request, as in the other callers.
const FDC_TIMEOUT_MS = 30_000;

async function invokeFdc(body, context) {
  const invokePromise = supabase.functions.invoke('fdc-food', { body });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`USDA FoodData Central request timed out after ${FDC_TIMEOUT_MS / 1000}s`)), FDC_TIMEOUT_MS);
  });
  const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
  if (error) throw supaFail(context, error);
  if (!data || !data.success) throw new Error(data?.error || `${context} failed`);
  return data.data;
}

// -> { foods: [{ fdcId, dataType, description, foodCategory, foodCode, nutrients: [{ id, name, unit, value }] }],
//      totalHits, rateLimitRemaining }. `dataTypes` omitted = FNDDS + SR Legacy + Foundation.
async function searchFdc({ query, dataTypes, pageSize = 10 }) {
  return invokeFdc({ action: 'search', query, dataTypes, pageSize }, 'searchFdc');
}

// Full panel + portions for up to 20 foods -> { foods: [...], rateLimitRemaining }.
async function fetchFdcDetails(fdcIds) {
  return invokeFdc({ action: 'details', fdcIds }, 'fetchFdcDetails');
}

module.exports = { searchFdc, fetchFdcDetails };
