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
// recipe (no quantities), since no actual recipe is available for most catalog dishes.
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
        },
        required: ["index", "ingredients"],
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

function buildPrompt(items: DishItem[]): string {
  return `${NUT_RESTRICTION}

For each school/staff cafeteria dish name below, suggest a plausible list of its main ingredients, based on general culinary knowledge of similar dishes (no recipe or quantities are provided or expected).

Format each dish's ingredients as a SINGLE string of ingredient names separated by " - " (space, hyphen, space), all lowercase, no quantities/measurements/units, no "and" before the last item, ordered roughly by prominence (main ingredients first, seasonings/condiments last). Keep each list concise -- roughly 4 to 10 ingredients. Example format: "zucchini - red onions - shallots - olive oil - butter - salt".

Each item carries its own "index" number. Return exactly one entry per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct entries and each needs its own separate suggestion. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

Remember: absolutely no nuts or nut-derived ingredients anywhere in your output, per the restriction stated at the top.

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
