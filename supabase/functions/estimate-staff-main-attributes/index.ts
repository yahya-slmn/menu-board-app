// Supabase Edge Function: estimate-staff-main-attributes
//
// One-time backfill for the Staff Main catalog (scripts/staff-main-backfill.js), same trust boundary
// and index-tagged batch shape as estimate-am-snack-style: holds the Anthropic API key server-side,
// classifies each dish from its NAME alone, and returns one entry per index.
//
// Two answers per dish, used differently by the caller:
// - carb_type: the dish's starch (RICE / PASTA / POTATO / OTHER, or NONE). Written directly, like
//   the calorie and AM Snack style backfills -- Staff Main's "vegan and vegetarian must differ in
//   starch" rule needs it.
// - diet: VEGAN / VEGETARIAN / MEAT_OR_FISH. NEVER written directly -- vegan is a dietary claim, so
//   the chef confirms each proposal first (confirmed with the chef 2026-09-23).
//
// Deploy: `supabase functions deploy estimate-staff-main-attributes --use-api`.

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MAX_ITEMS = 150;
const MAX_NAME_LENGTH = 200;
const CARB_TYPES = ["RICE", "PASTA", "POTATO", "OTHER", "NONE"];
const DIETS = ["VEGAN", "VEGETARIAN", "MEAT_OR_FISH"];

interface Item {
  index: number;
  name: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          carb_type: { type: "string", enum: CARB_TYPES },
          diet: { type: "string", enum: DIETS },
        },
        required: ["index", "carb_type", "diet"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

function buildPrompt(items: Item[]): string {
  return `For each staff lunch main dish below (a school catering kitchen in Saudi Arabia), classify it from its name, using general knowledge of how the dish is normally made.

carb_type -- the starch that is part of the dish itself:
- RICE (rice, biryani, pilaf, kabsa, mandi, risotto, fried rice)
- PASTA (any pasta or noodles, lasagna, couscous is NOT pasta)
- POTATO (potatoes, sweet potatoes, gratin, wedges)
- OTHER (bulgur, couscous, freekeh, bread-based, tortilla, corn, quinoa, grains)
- NONE (no starch in the dish itself, e.g. a stew, grilled meat, stir-fried vegetables, curry served on its own)

diet:
- VEGAN: no meat, poultry, fish or seafood, and also no dairy (milk, cream, butter, cheese, yogurt, labneh, ghee), no egg and no honey, as the dish is normally made.
- VEGETARIAN: no meat, poultry, fish or seafood, but normally contains dairy, egg or honey.
- MEAT_OR_FISH: contains meat, poultry, fish or seafood.
When a dish is usually made with butter, cream, cheese, yogurt or egg, answer VEGETARIAN, not VEGAN. Only answer VEGAN when the dish is normally free of all animal products.

Each item carries its own "index". Return exactly one entry per item with that SAME index; every index from 0 to ${items.length - 1} must appear exactly once.

Items (JSON array): ${JSON.stringify(items)}`;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ success: false, error: "Method not allowed" });
  if (!ANTHROPIC_API_KEY) return ok({ success: false, error: "Server misconfigured: ANTHROPIC_API_KEY not set" });
  let body: { items?: Item[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }
  const items = body.items;
  if (!Array.isArray(items)) return ok({ success: false, error: "Missing items array" });
  if (items.length === 0) return ok({ success: true, data: { estimates: [] } });
  if (items.length > MAX_ITEMS) return ok({ success: false, error: `Too many items (max ${MAX_ITEMS})` });
  for (const it of items) {
    if (!it || typeof it.index !== "number" || typeof it.name !== "string" || !it.name.trim() || it.name.length > MAX_NAME_LENGTH) {
      return ok({ success: false, error: "Every item needs a numeric index and a non-empty name" });
    }
  }
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Sonnet 5, thinking disabled -- same single-shot classifier setup as estimate-am-snack-style.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: buildPrompt(items) }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    if (response.stop_reason === "refusal") return ok({ success: false, error: "Classification was declined" });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return ok({ success: false, error: "No output returned" });
    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.estimates)) return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    return ok({ success: true, data });
  } catch (err) {
    console.error("[estimate-staff-main-attributes] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
