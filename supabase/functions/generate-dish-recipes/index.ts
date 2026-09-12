// Supabase Edge Function: generate-dish-recipes
//
// Backs the Recipe Generator screen: given a batch of dish names pulled from an uploaded menu
// file (AM Snack/PM Snack/Soup/Appetizer/Main Course dishes only -- filtered by the caller,
// lib/recipeGenerator.js), generates a FULL reference recipe per dish -- name, one or more
// named processes each with ingredients (name/quantity/unit/method), a method, and (optionally,
// only where genuinely applicable) a waste % per process -- at a natural/realistic scale. Waste
// matching against the existing waste_types catalog is a semantic decision handed to the model
// (see buildWasteRule) since this function has no DB access to do string matching itself; main.js
// resolves the model's answer against the real catalog afterward. This is deliberately NOT the
// same call as suggest-dish-ingredients: that
// function returns one short dash-separated ingredient string per dish (a much smaller, more
// frequent ask); this one returns a full nested recipe structure per dish, a categorically
// bigger structured-output request that would otherwise inflate suggest-dish-ingredients'
// latency/token budget for its own, far more common, ingredients-only path.
//
// Batch size is intentionally much smaller than suggest-dish-ingredients' 50 (main.js sends
// ~8 per call) given how much larger a full recipe is than one ingredient string -- see
// lib/generateDishRecipes.js.
//
// 100g standardization happens AFTER this call, not inside the prompt: the model is asked for a
// realistic natural-scale recipe (LLMs are unreliable at hitting an exact numeric total), and
// main.js mathematically normalizes every ingredient quantity to sum to ~100g afterward, using
// the same multiplier = target / sum(quantities) math Recipe Calculator's own "scale to target
// quantity" mode already relies on.
//
// Same index-tagged batch in/out convention as estimate-calories/suggest-dish-ingredients, for
// the same reason (Haiku doesn't reliably preserve exact 1:1 correspondence over a batch of many
// structurally similar items).
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Small on purpose -- a safety ceiling above main.js's own intended batch size (~8), same
// relationship MAX_ITEMS has to suggest-dish-ingredients'/estimate-calories' own usage, just a
// much lower ceiling given how much larger a full recipe's output is than a short string.
const MAX_ITEMS = 15;
const MAX_NAME_LENGTH = 200;

interface DishItem {
  index: number;
  name: string;
  category?: string;
}

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          name: { type: "string" },
          processes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                ingredients: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      quantity: { anyOf: [{ type: "number" }, { type: "null" }] },
                      unit: { anyOf: [{ type: "string" }, { type: "null" }] },
                      method: { anyOf: [{ type: "string" }, { type: "null" }] },
                    },
                    required: ["name", "quantity", "unit", "method"],
                    additionalProperties: false,
                  },
                },
                method_steps: { type: "array", items: { type: "string" } },
                wastes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      percent: { type: "number" },
                      matchedExisting: { type: "boolean" },
                    },
                    required: ["name", "percent", "matchedExisting"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["name", "ingredients", "method_steps", "wastes"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "name", "processes"],
        additionalProperties: false,
      },
    },
  },
  required: ["recipes"],
  additionalProperties: false,
};

// Identical wording to suggest-dish-ingredients/index.ts's own NUT_RESTRICTION -- same policy,
// same reasoning (repeated in both the system prompt and inline, belt-and-suspenders), applied
// here too since a full generated recipe is just as capable of naming a nut or sesame ingredient
// as a suggested ingredient list is. This function has no separate "allergens" field the way
// suggest-dish-ingredients does -- ingredients are the only place a nut/sesame violation could
// surface here, and lib/nutFilter.js's matchNutTerms scans every generated ingredient name as the
// code-level backstop regardless of how well this prompt was followed.
const NUT_RESTRICTION = `CRITICAL DIETARY RESTRICTION -- this school strictly prohibits ALL nuts, sesame, and their derived ingredients, with zero exceptions. Never include any tree nut (almond, cashew, walnut, pistachio, hazelnut, pecan, macadamia, pine nut, brazil nut, chestnut, etc.), peanut, sesame in any form (sesame seeds, sesame oil, tahini/sesame paste, halva, za'atar, benne, gomashio, etc.), or nut/sesame-derived product (nut butter, nut milk, nut oil, marzipan, praline, nutella, nougat, etc.) in ANY generated recipe -- even if the dish traditionally or typically includes one. If a dish's most natural recipe would normally include a nut or sesame product, substitute a safe alternative that fits the dish (e.g. sunflower seed butter instead of peanut butter, or instead of tahini in a dish like hummus; extra olive oil and lemon juice instead of tahini; a plain breadcrumb or herb crust instead of a sesame crust; a sesame-free herb blend -- thyme, sumac, oregano -- instead of za'atar) or simply omit that component -- never include the nut or sesame itself. Treat this with the same seriousness as an allergy-critical instruction, because it is one.`;

// Shorter version of suggest-dish-ingredients' own DECOMPOSITION_RULE -- a full recipe's
// ingredient list is inherently more decomposed than a bare ingredient-name suggestion (you
// can't write a real method step around "dough" without saying what's in it), but the same
// laziness failure mode is still possible for a named sub-component, so the instruction carries
// over in short form.
const DECOMPOSITION_RULE = `Every ingredient name must be a real base ingredient (flour, sugar, butter, eggs, yeast, milk, salt, oil, etc.) -- never a sub-preparation (dough, batter, filling, sauce, breading, etc.) named as if it were an ingredient itself. If the dish involves a sub-preparation, decompose it into its real base ingredients as separate ingredient rows within the relevant process, the same way a real recipe would.`;

// Same enforcement pattern as NUT_RESTRICTION/DECOMPOSITION_RULE above -- a hard constraint
// stated as its own explicit rule, then referenced again in the closing "Remember" reinforcement
// (see buildPrompt), rather than left as a soft preference buried inside the ingredients bullet.
// This is a real correctness fix, not a style preference: the app's own downstream math
// (normalizeProcessesToGrams' 100g scaling, sumIngredientQuantities/compoundWasteYield's Net
// Weight calc, the Total-Quantity/Net-Weight rescale cascades) all sum ingredient quantities
// directly regardless of unit -- a stray "ml" or "pc" silently corrupts every one of those totals
// exactly like a wrong gram figure would, just less visibly.
const UNITS_RULE = `Every ingredient's quantity MUST be expressed in grams ("g") -- with zero exceptions. This applies to liquids, oils, sauces, melted or liquid ingredients, and count-based items (a whole egg, a garlic clove, a single fruit) just as much as dry/solid ingredients -- there is no "grams genuinely doesn't apply" case. Never use "ml", any other volume unit, or any non-gram unit ("pc", "piece", "cup", "tbsp", "tsp", etc.) anywhere in your output, even for an ingredient that would naturally be measured that way in a real kitchen. Convert to its gram equivalent using standard culinary density/weight knowledge instead (e.g. water/milk/stock ~1g per ml, olive oil ~0.92g per ml, "1 egg" -> ~50g, "1 garlic clove" -> ~5g) -- never report the ingredient in its natural unit.`;

// Waste has no DB access here (this function is Anthropic-only, no Supabase client) -- the
// matching decision is inherently semantic ("Baking Waste" and "Oven Loss" might mean the same
// thing, might not), so it's handed to the model rather than attempted as a string-similarity
// check in main.js. main.js resolves the model's answer against the real catalog afterward
// (exact match first, create only if genuinely new -- see resolveWasteTypeId), so this only ever
// needs to get name/percent right, never a real waste_types id.
function buildWasteRule(existingWasteTypeNames: string[]): string {
  const catalogList = existingWasteTypeNames.length > 0
    ? existingWasteTypeNames.join(", ")
    : "(none yet -- propose new ones as needed)";
  return `Some processes involve a real, measurable loss step (trimming, peeling, baking/roasting shrinkage, straining, reduction, rendering, etc.) -- for a process where that genuinely applies, include a "wastes" entry describing it. For a process with no meaningful loss (most simple mixing/combining/plating/assembly steps), leave "wastes" as an empty array -- do not invent a waste just to fill the field.

For each waste you do include: if it clearly matches one of these EXISTING catalog waste types by name or plain meaning, set "matchedExisting" to true and "name" to that EXACT existing name, copied verbatim from the list below (so it's reused, not duplicated). If nothing in the catalog genuinely fits, set "matchedExisting" to false and propose a new, concise, professional waste-type name (e.g. "Heating Waste", "Cooling Loss", "Straining Loss"). Either way, "percent" is a realistic AVERAGE percentage for that specific kind of loss in a professional kitchen setting, based on general culinary knowledge (e.g. trimming waste on raw vegetables is typically 10-15%, baking/roasting shrinkage 15-25%, peeling loss on root vegetables 20-30%) -- don't default to a generic round number if you know the realistic range is different.

Existing catalog waste types (match against these first): ${catalogList}`;
}

function buildPrompt(items: DishItem[], existingWasteTypeNames: string[]): string {
  return `${NUT_RESTRICTION}

You are generating a REFERENCE recipe for each school/staff cafeteria dish named below, for a school-nutrition recipe management app. This is a plausible, realistic recipe based on general culinary knowledge (no real recipe card is available) -- a starting point a chef will review and edit, not a precise transcription.

${DECOMPOSITION_RULE}

${UNITS_RULE}

For each dish, generate:
- "name": the dish name (use the given name, cleaned up if needed).
- "processes": one or more named sub-recipes. Use exactly ONE process, named after the dish itself, for a simple dish. Split into multiple named processes (e.g. "Dough", "Filling", "Topping") only when the dish genuinely has distinct components that would be prepared separately in a real kitchen.
- Each process's "ingredients": every real base ingredient it needs, each with a realistic quantity for a normal/standard batch of this dish (NOT scaled to any particular total -- just a natural, realistic recipe). See the units rule above for how quantity/unit must be expressed -- it applies to every ingredient, no exceptions. "method" on an ingredient is a short prep note (e.g. "diced", "melted"), or null if none.
- Each process's "method_steps": one array entry per distinct preparation step, in order.
- Each process's "wastes": see the rule below.

${buildWasteRule(existingWasteTypeNames)}

Each item carries its own "index" number and may carry a "category" (the menu category this dish was listed under, for context on what kind of dish this is -- e.g. a "Soup" category item should be a soup, an "AM Snack" item should be breakfast/snack-appropriate). Return exactly one recipe entry per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct entries and each needs its own separate recipe. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

Remember: absolutely no nuts, sesame, or their derived ingredients anywhere in your output, per the restriction stated at the top. Per the decomposition rule above, never leave a sub-preparation (dough, batter, filling, etc.) as a standalone placeholder ingredient -- always break it down into its real base ingredients as their own rows. And per the units rule above, every single quantity is in grams ("g") only -- never "ml" or any other unit, even for a liquid, oil, sauce, or count-based ingredient.

Items (JSON array): ${JSON.stringify(items)}`;
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
  if (!ANTHROPIC_API_KEY) {
    return ok({ success: false, error: "Server misconfigured: ANTHROPIC_API_KEY not set" });
  }

  let body: { items?: DishItem[]; existingWasteTypeNames?: string[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const items = body.items;
  const existingWasteTypeNames = Array.isArray(body.existingWasteTypeNames)
    ? body.existingWasteTypeNames.filter((n): n is string => typeof n === "string")
    : [];
  if (!Array.isArray(items)) {
    return ok({ success: false, error: "Missing items array" });
  }
  if (items.length === 0) {
    return ok({ success: true, data: { recipes: [] } });
  }
  if (items.length > MAX_ITEMS) {
    return ok({ success: false, error: `Too many items to generate (max ${MAX_ITEMS})` });
  }
  for (const it of items) {
    if (!it || typeof it.index !== "number" || typeof it.name !== "string" || !it.name.trim()) {
      return ok({ success: false, error: "Every item needs a numeric index and a non-empty name" });
    }
    if (it.name.length > MAX_NAME_LENGTH) {
      return ok({ success: false, error: `An item name exceeds ${MAX_NAME_LENGTH} characters` });
    }
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Sonnet 5 (upgraded from Haiku 4.5, chef-approved for the higher per-token cost) -- thinking
    // explicitly disabled for consistency with every other Edge Function here (Sonnet 5 runs
    // ADAPTIVE (on) thinking by default when the param is omitted, unlike Haiku 4.5 where omitting
    // it meant off, and leaving it unset would silently add latency/cost on top of the higher
    // per-token price already accepted). Of all seven AI-calling functions in this app, this is
    // the one most likely to actually benefit from thinking being turned back on -- generating a
    // coherent multi-process recipe (ingredients that need to add up sensibly, method steps that
    // need to match them) is a meaningfully harder task than the single-field
    // classification/extraction the other six do, so it's worth trying `{type:"adaptive"}` here
    // first if recipe quality ever needs a boost. max_tokens stays well above
    // suggest-dish-ingredients' 8192 -- a full recipe (ingredients + method steps) per item is
    // much larger than one short ingredient string, and this batch is already sized down (15
    // ceiling, ~8 intended) specifically to fit within a single response reliably.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "disabled" },
      system: NUT_RESTRICTION,
      messages: [
        { role: "user", content: buildPrompt(items, existingWasteTypeNames) },
      ],
      output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Generation was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: `No output returned (stop_reason: ${response.stop_reason})` });
    }

    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.recipes)) {
      return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    }
    // Deliberately NOT failing the whole batch just because recipes.length !== items.length --
    // same reconcile-by-index, retry-only-the-gaps approach as estimate-calories/
    // suggest-dish-ingredients.
    return ok({ success: true, data });
  } catch (err) {
    console.error("[generate-dish-recipes] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
