// Supabase Edge Function: generate-dish-image
//
// Backs Recipe Generator's auto-photo feature: given one dish's name, category, and generated
// ingredient list, generates ONE illustrative food photo via OpenAI's Images API (gpt-image-2,
// "high" quality) and returns it as base64 for main.js to upload through the EXISTING
// generated-recipe-photos Storage bucket/uploadGeneratedRecipePhoto helper -- this function never
// touches Supabase Storage itself, it only produces image bytes, same "network call only, main.js
// does the DB/storage work" split every other Edge Function wrapper in this app already follows.
//
// Different trust boundary/provider than every other Edge Function here: this is the ONLY one
// backed by OpenAI rather than Anthropic, holding its own OPENAI_API_KEY secret (separate from
// ANTHROPIC_API_KEY, same "never ships inside the distributed Electron app" reasoning). One image
// per call -- unlike the Anthropic text functions, OpenAI's Images API has no multi-prompt batch
// primitive, so main.js parallelizes across a batch of dishes by firing several of these calls at
// once (Promise.allSettled), not by asking this function to do more than one dish per call.
//
// Failure here is NEVER fatal to the recipe itself -- main.js persists the generated recipe with
// photo_path left null if this call (or the subsequent upload) fails, logged as a warning, exactly
// like every other soft-fail path in that flow (missing-recipe retries, waste-type resolution).
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the OPENAI_API_KEY secret to be set (`supabase secrets set OPENAI_API_KEY=...`).

import OpenAI from "npm:openai";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const MAX_DISH_NAME_LENGTH = 200;
const MAX_INGREDIENTS = 12;
const MAX_INGREDIENT_LENGTH = 100;
const MAX_METHOD_LENGTH = 500;

interface RequestBody {
  dishName?: string;
  category?: string;
  ingredients?: string[];
  method?: string;
}

// Realistic food photography, not stylized illustration -- matches the visual convention of every
// manually-uploaded real photo elsewhere in this app (Recipe Book/Extractor), so an AI-generated
// photo doesn't visually clash with one she uploads herself. Ingredient list is capped and each
// name is a plain noun phrase already (from the just-generated recipe's own ingredient rows), so
// no further cleanup is needed before dropping it into the prompt. The "no nuts/seeds/sesame
// garnish" line is a belt-and-suspenders visual safety net -- the ingredient list feeding this
// prompt is already nut/sesame-free (see lib/nutFilter.js), but an image model can still invent a
// garnish that was never in the text, so this costs nothing and closes that gap too.
//
// `method` is optional (added for Recipe Book/Extractor/Generator's manual "Generate Photo"
// button, which has real method text to offer -- the automatic batch flow in main.js's
// parse-and-generate-recipes passes it too now, for the same free quality improvement) --
// knowing a dish is grilled vs. baked vs. pan-seared changes what it should visually look like
// (browning, sauce plating, etc.), not just its ingredient list. Omitted entirely when absent, not
// a required field -- older callers/requests without it still work unchanged.
function buildPrompt(dishName: string, category: string | undefined, ingredients: string[], method: string | undefined): string {
  const ingredientLine = ingredients.length > 0 ? `Visible components: ${ingredients.join(", ")}.` : "";
  const categoryLine = category ? ` (a ${category} item)` : "";
  const methodLine = method ? ` Preparation method: ${method}.` : "";
  // The caller has already stripped a nut/sesame word out of dishName itself (stripNutTermsFromText
  // in main.js) so e.g. "Walnut Baklava" arrives here as "Baklava" -- but this line stays anyway,
  // stated explicitly rather than just relying on that, because a real test generation showed the
  // model can still default to a traditionally nutty appearance from its own general knowledge of
  // a dish (a plain "Baklava" prompt with no nut ingredients listed still came back with a visibly
  // nut-textured filling) -- the instruction has to actively override that expectation, not just
  // fail to mention nuts.
  return `A high-quality, appetizing food photograph of "${dishName}"${categoryLine}, a school cafeteria dish. Served on a plain white plate, shot at a 45-degree angle on a clean neutral background, natural lighting, realistic food-photography style -- not an illustration, cartoon, or 3D render. ${ingredientLine}${methodLine} No text, no logos, no people. IMPORTANT: this school strictly prohibits nuts, seeds, and sesame in any form -- even if this dish's traditional appearance would normally include one, depict it made and garnished WITHOUT that ingredient entirely (a plain filling/crust/topping instead), never with a nut, seed, sesame, or nut-textured substitute standing in for it.`;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return ok({ success: false, error: "Method not allowed" });
  }
  if (!OPENAI_API_KEY) {
    return ok({ success: false, error: "Server misconfigured: OPENAI_API_KEY not set" });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const dishName = (body.dishName || "").trim();
  if (!dishName) {
    return ok({ success: false, error: "Missing dishName" });
  }
  if (dishName.length > MAX_DISH_NAME_LENGTH) {
    return ok({ success: false, error: `dishName exceeds ${MAX_DISH_NAME_LENGTH} characters` });
  }
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients.slice(0, MAX_INGREDIENTS) : [];
  for (const ing of ingredients) {
    if (typeof ing !== "string" || ing.length > MAX_INGREDIENT_LENGTH) {
      return ok({ success: false, error: `An ingredient name is missing or exceeds ${MAX_INGREDIENT_LENGTH} characters` });
    }
  }
  const method = typeof body.method === "string" ? body.method.trim().slice(0, MAX_METHOD_LENGTH) : undefined;

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await client.images.generate({
      model: "gpt-image-2",
      prompt: buildPrompt(dishName, body.category, ingredients, method),
      size: "1024x1024",
      quality: "high",
      output_format: "png",
      n: 1,
    });

    const image = response.data?.[0];
    if (!image?.b64_json) {
      return ok({ success: false, error: "No image data returned" });
    }
    return ok({ success: true, data: { b64: image.b64_json, ext: "png" } });
  } catch (err) {
    console.error("[generate-dish-image] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
