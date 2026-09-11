// Supabase Edge Function: suggest-dish-ingredients
//
// Same trust boundary/shape as estimate-calories and estimate-am-snack-style: holds the
// Anthropic API key server-side, index-tagged batch in/out for the same reason those two are
// (Haiku doesn't reliably preserve exact 1:1 correspondence over a batch of many short,
// structurally similar items -- see estimate-calories' own header comment for the full
// reasoning, unchanged here).
//
// Backs the Menu Ingredients Generator screen: given a batch of dish names (deduplicated by the
// caller -- main.js's parse-and-suggest-menu-ingredients), suggests a plausible ingredient list
// for each as a single dash-separated string (e.g. "zucchini - red onions - shallots - olive
// oil - butter - salt"), a starting point she reviews/edits before exporting -- not a precise
// recipe (no quantities), since no actual recipe is available for most catalog dishes. Also
// returns a per-dish allergens string in the same call (see ALLERGEN_RULE below) -- deliberately
// NOT a separate Edge Function, since the allergens are derived from the ingredients list this
// same call just produced, which is both cheaper (one Anthropic call instead of two per batch)
// and more accurate than guessing allergens from the dish name alone in isolation.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Caller batches at 50 items per call (main.js) -- this is a safety ceiling above that, not the
// intended batch size, same relationship MAX_ITEMS has to estimate-calories' own usage.
const MAX_ITEMS = 150;
const MAX_NAME_LENGTH = 200;

interface DishItem {
  index: number;
  name: string;
}

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          ingredients: { type: "string" },
          allergens: { type: "string" },
        },
        required: ["index", "ingredients", "allergens"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

// Also enforced in the same wording as SYSTEM_PROMPT below (belt-and-suspenders -- a system
// prompt is generally weighted more heavily by the model, but repeating the constraint inline,
// right next to the formatting rules it has to satisfy at the same time, costs nothing and
// guards against exactly the kind of instruction the model might otherwise treat as lower
// priority than the surrounding task description). This is still only half the safety story --
// see lib/nutFilter.js for the mandatory post-processing scan every suggestion goes through
// regardless of how well the model followed this.
const NUT_RESTRICTION = `CRITICAL DIETARY RESTRICTION -- this school strictly prohibits ALL nuts and nut-derived ingredients, with zero exceptions. Never include any tree nut (almond, cashew, walnut, pistachio, hazelnut, pecan, macadamia, pine nut, brazil nut, chestnut, etc.), peanut, or nut-derived product (nut butter, nut milk, nut oil, marzipan, praline, nutella, nougat, etc.) in ANY suggested ingredient list -- even if the dish traditionally or typically includes one. If a dish's most natural ingredients would normally include a nut, substitute a safe non-nut alternative that fits the dish (e.g. sunflower seed butter instead of peanut butter) or simply omit that component -- never include the nut itself. Treat this with the same seriousness as an allergy-critical instruction, because it is one.`;

// The model's laziest failure mode: naming a sub-preparation itself ("dough", "filling", "sauce")
// as if it were an ingredient, instead of decomposing it into what it's actually made of. Broken
// out as its own constant (same reasoning as NUT_RESTRICTION above) with two matched before/after
// examples inline -- concrete examples anchor this kind of behavioral instruction far more
// reliably than the abstract rule alone.
const DECOMPOSITION_RULE = `Never name a sub-preparation (dough, batter, crust, bread, bun, roll, breading, filling, glaze, frosting, marinade, etc.) as an ingredient by itself -- always decompose it into the real base ingredients it is made from (flour, sugar, butter, eggs, yeast, milk, salt, oil, etc.), even when that sub-preparation is only part of a larger dish (e.g. the bun in a burger, the bread in a sandwich). A sub-preparation name is a placeholder, not an ingredient, and must never appear in your output. Exception: a simple, single-purpose condiment/sauce that is commonly used and sourced as one finished product (ketchup, mustard, soy sauce, mayonnaise, plain tomato/pizza sauce) may still be named as itself -- only decompose a sauce or filling further if it's itself a multi-component preparation specific to this dish (a curry sauce, gravy, or fruit pie filling), the same way "dough" must be decomposed.

Example -- WRONG (uses a sub-preparation as a placeholder):
"Pizza" -> "dough - tomato sauce - mozzarella cheese"
Example -- RIGHT (the dough is decomposed into its real base ingredients; tomato sauce and mozzarella cheese are themselves finished ingredients, not further sub-preparations, so they stay as-is):
"Pizza" -> "all-purpose flour - sugar - salt - butter - milk - yeast - olive oil - tomato sauce - mozzarella cheese"

Example -- WRONG (filling left as a placeholder):
"Apple Pie" -> "pie crust - apple filling"
Example -- RIGHT (both crust and filling are decomposed into real base ingredients):
"Apple Pie" -> "all-purpose flour - butter - salt - apples - sugar - cinnamon - cornstarch - lemon juice"

Example -- WRONG (bread left as a placeholder even though it's just one part of the dish):
"Grilled Chicken Sandwich" -> "chicken breast - bread - lettuce - tomato - mayonnaise"
Example -- RIGHT (the bread is decomposed into its real base ingredients too, same as the dough/crust cases above):
"Grilled Chicken Sandwich" -> "chicken breast - all-purpose flour - yeast - salt - sugar - olive oil - lettuce - tomato - mayonnaise"`;

// Allergens are derived from the SAME decomposed ingredient list buildPrompt() asks for above
// (that's why this is one call, not a separate Edge Function -- see index.ts's header comment)
// rather than guessed independently from the dish name, which is both cheaper and more accurate:
// the model already knows, in this same turn, that it just wrote "all-purpose flour" and
// "mozzarella cheese" into the ingredients string, so reading gluten/dairy back off of that is a
// much more grounded inference than a second blind guess would be. Closed vocabulary (not
// freeform) so the output stays consistent and filterable across dishes -- the FDA "big 9" minus
// the two nut categories, which NUT_RESTRICTION already forbids as ingredients and which must
// ALSO never appear here as a flagged allergen (a dish can't truthfully claim to contain a nut
// that was never allowed into its ingredient list in the first place).
const ALLERGEN_VOCAB = ["egg", "gluten", "dairy", "soy", "shellfish", "fish", "sesame"];
const ALLERGEN_RULE = `For each dish, also identify which common allergens it contains, based ONLY on the ingredients you actually listed for it (e.g. "all-purpose flour" -> gluten, "milk"/"butter"/"mozzarella cheese" -> dairy, "egg" -> egg, "soy sauce" -> soy). Choose ONLY from this fixed list, using these exact lowercase words: ${ALLERGEN_VOCAB.join(", ")}. Format as a SINGLE string of the applicable allergen words (from that list only) separated by " - ", ordered in the same order as the list above, e.g. "gluten - dairy - egg" for a dish containing flour, butter, and egg. If none of these allergens apply, return an empty string. Do not invent allergen categories outside this list, and do not explain your reasoning -- just the dash-separated word list.

CRITICAL: nuts and peanuts are NEVER a valid entry here, under any circumstance -- they are not even in the list above. Never write "nut", "nuts", "tree nut", "peanut", or any variant as an allergen, even if you think the dish traditionally contains one; per the restriction at the top of this prompt, a nut should never have been in the ingredients list to begin with, so there is nothing to flag.

Example (matches the Pizza example above):
"Pizza" ingredients "all-purpose flour - sugar - salt - butter - milk - yeast - olive oil - tomato sauce - mozzarella cheese" -> allergens "gluten - dairy"`;

function buildPrompt(items: DishItem[]): string {
  return `${NUT_RESTRICTION}

For each school/staff cafeteria dish name below, suggest a plausible list of its main ingredients, based on general culinary knowledge of similar dishes (no recipe or quantities are provided or expected).

${DECOMPOSITION_RULE}

Format each dish's ingredients as a SINGLE string of ingredient names separated by " - " (space, hyphen, space), all lowercase, no quantities/measurements/units, no "and" before the last item, ordered roughly by prominence (main ingredients first, seasonings/condiments last). Keep each list reasonably concise -- typically 5 to 14 ingredients; a composite dish whose base preparation (dough, batter, filling) has been decomposed per the rule above will naturally run longer than a simple dish, and that's expected. Example format: "zucchini - red onions - shallots - olive oil - butter - salt".

${ALLERGEN_RULE}

Each item carries its own "index" number. Return exactly one entry per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct entries and each needs its own separate suggestion. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

Remember: absolutely no nuts or nut-derived ingredients anywhere in your output -- neither in the ingredients list nor as an allergen -- per the restriction stated at the top. And per the decomposition rule above, never leave a sub-preparation (dough, batter, filling, etc.) as a standalone placeholder ingredient -- always break it down into its real base ingredients.

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

  let body: { items?: DishItem[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const items = body.items;
  if (!Array.isArray(items)) {
    return ok({ success: false, error: "Missing items array" });
  }
  if (items.length === 0) {
    return ok({ success: true, data: { estimates: [] } });
  }
  if (items.length > MAX_ITEMS) {
    return ok({ success: false, error: `Too many items to suggest (max ${MAX_ITEMS})` });
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
    // No thinking/effort -- Haiku 4.5 doesn't support effort, and this is a single-shot
    // structured suggestion with no need for extended reasoning. Text-only, so cheaper/faster
    // than extract-recipe's image calls, same as estimate-calories/estimate-am-snack-style.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      // A system prompt (unique to this function -- no other Edge Function here uses one) is
      // weighted more heavily by the model than the same instruction inline in the user message,
      // which is exactly what a hard safety constraint like this needs. Repeated inline in
      // buildPrompt() too, right next to the formatting rules -- see NUT_RESTRICTION's own
      // comment for why both places carry it.
      system: NUT_RESTRICTION,
      messages: [
        { role: "user", content: buildPrompt(items) },
      ],
      output_config: { format: { type: "json_schema", schema: SUGGEST_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Suggestion was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: "No output returned" });
    }

    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.estimates)) {
      return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    }
    // Deliberately NOT failing the whole batch just because estimates.length !== items.length --
    // same reconcile-by-index, retry-only-the-gaps approach as estimate-calories/
    // estimate-am-snack-style.
    return ok({ success: true, data });
  } catch (err) {
    console.error("[suggest-dish-ingredients] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
