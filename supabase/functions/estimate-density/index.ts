// Supabase Edge Function: estimate-density
//
// Recipe on Fire's density estimate (g/cm3) for a raw dough or filling, from its ingredients and quantities (and the
// method text, the one place aeration shows up). Same trust boundary as estimate-calories: holds the Anthropic API key
// server-side so it never ships inside the distributed Electron app, only reachable by an authenticated session.
//
// One call estimates several masses at once (every layer of a recipe, or a merged "One dough"), index-tagged like
// estimate-calories so results are matched by index, never by position. Each result is a value, a range and a
// confidence, because an estimate from ingredients alone can't know how long the mix was worked, whipped or rested.
//
// PROMPT_VERSION is returned with every response: the app's shared density cache (phase D2) keys on it, so a revised
// prompt never reuses answers from an old one. Bump it whenever the prompt or schema changes meaning.
//
// Deploy: supabase functions deploy estimate-density --use-api   (Docker bundling hangs here, see CLAUDE.md)
// Requires the ANTHROPIC_API_KEY secret (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";
import { requireUser } from "../_shared/requireUser.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PROMPT_VERSION = 1;

const MAX_ITEMS = 12;           // a recipe's layers, or one merged dough -- far below this in practice
const MAX_INGREDIENTS = 80;
const MAX_NAME_LENGTH = 120;
const MAX_LABEL_LENGTH = 200;
const MAX_METHOD_LENGTH = 3000;
const ROLES = ["dough", "filling", "mixed"];

interface Ingredient { name: string; quantity: number | string | null; unit?: string | null }
interface DensityItem { index: number; label?: string | null; role?: string | null; ingredients: Ingredient[]; method?: string | null }

const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          density_g_cm3: { type: "number" },
          low: { type: "number" },
          high: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          basis: { type: "string" },
        },
        required: ["index", "density_g_cm3", "low", "high", "confidence", "basis"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

function buildPrompt(items: DensityItem[]): string {
  return `You estimate the DENSITY (grams per cubic centimetre, g/cm3) of raw bakery and kitchen mixtures for a professional kitchen. Each item below is one mass that goes into a baking tray: a dough, a filling, or several processes mixed into one dough. The kitchen uses the number to work out how thick a layer comes out, or how many grams fill a tray to a height.

WHAT TO ESTIMATE
- The density of the mass AS IT GOES INTO THE TRAY: mixed, kneaded, laminated, whipped or folded as the method says, BEFORE any proofing or baking. Not the baked product.

HOW TO REASON
1. Read each ingredient and its quantity. Quantities are grams unless the unit says otherwise (ML is millilitres; PC / pieces means whole items: estimate a typical weight, e.g. an egg about 50-55 g). Ignore ingredients with no quantity when estimating proportions, and lower the confidence if they look significant.
2. Use each ingredient's density AS IT EXISTS INSIDE THE MIX, not its loose bulk density in a bag: flour inside a hydrated dough behaves near its particle density (about 1.45), not the 0.5-0.6 of loose flour; sugar and salt dissolve; water 1.0; milk about 1.03; vegetable oil about 0.92; butter about 0.91; eggs about 1.03; soft and fresh cheeses about 1.0-1.1; hard grated cheese packed into a mix about 1.1; chopped cooked vegetables about 0.9-1.05 once bound in a mix (loose leaves and chunks trap air until they are bound).
3. Combine the solids and liquids by volume (1 / density = sum of mass fraction / ingredient density), then CORRECT FOR AIR from what the method and the ingredients tell you. Typical results for orientation: kneaded yeast or plain doughs about 1.05-1.2 before proofing; laminated (puff, croissant) doughs about 1.1-1.2; shortcrust about 1.2-1.3; cake and muffin batters about 0.85-1.05; pourable savoury fillings (egg, cheese, cream) about 1.0-1.1; chunky vegetable fillings about 0.85-1.0; whipped cream about 0.3-0.5; whipped fillings and mousses about 0.4-0.8; meringue about 0.1-0.3.
4. The method is the only evidence of aeration. "Whip", "whisk until stiff", "fold in", "cream the butter and sugar" mean trapped air; a mixture with no such step is dense. When the method says nothing, use the typical preparation for that kind of mass and lower the confidence.

BE HONEST ABOUT THE LIMITS
- An estimate from ingredients and quantities alone cannot know how long the mix was worked, how far it was whipped, its temperature, or its resting time. Give a realistic RANGE (low, high) that covers normal kitchen variation, with density_g_cm3 inside it.
- confidence: "high" only for simple, well-understood masses with clear quantities; "medium" for typical doughs and fillings; "low" when aeration is uncertain, quantities are missing or unusual, or ingredients are ambiguous.
- basis: ONE short plain sentence naming what decided the number (for example "Mostly egg and cheese; nothing in the method is whipped."). No numbers other than the ones already in the output; no advice.
- Use only the ingredients listed. Do not invent ingredients or steps.

OUTPUT
- Each item carries an "index". Return exactly one estimate per item with that SAME index; every index from 0 to ${items.length - 1} exactly once.
- density_g_cm3, low and high in g/cm3, between 0.1 and 1.6, with low <= density_g_cm3 <= high.

Items (JSON array): ${JSON.stringify(items)}`;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  // Signed-in users only, before anything else (see _shared/requireUser.ts).
  const denied = await requireUser(req);
  if (denied) return denied;
  if (req.method !== "POST") return ok({ success: false, error: "Method not allowed" });
  if (!ANTHROPIC_API_KEY) return ok({ success: false, error: "Server misconfigured: ANTHROPIC_API_KEY not set" });

  let body: { items?: DensityItem[] };
  try { body = await req.json(); } catch { return ok({ success: false, error: "Invalid request body" }); }

  const items = body.items;
  if (!Array.isArray(items)) return ok({ success: false, error: "Missing items array" });
  if (items.length === 0) return ok({ success: true, data: { estimates: [], prompt_version: PROMPT_VERSION } });
  if (items.length > MAX_ITEMS) return ok({ success: false, error: `Too many items to estimate (max ${MAX_ITEMS})` });
  for (const it of items) {
    if (!it || typeof it.index !== "number" || !Array.isArray(it.ingredients) || it.ingredients.length === 0) {
      return ok({ success: false, error: "Every item needs a numeric index and at least one ingredient" });
    }
    if (it.ingredients.length > MAX_INGREDIENTS) return ok({ success: false, error: `An item has more than ${MAX_INGREDIENTS} ingredients` });
    if (it.label != null && (typeof it.label !== "string" || it.label.length > MAX_LABEL_LENGTH)) return ok({ success: false, error: "An item's label is too long" });
    if (it.role != null && !ROLES.includes(String(it.role))) return ok({ success: false, error: "An item's role must be dough, filling or mixed" });
    if (it.method != null && (typeof it.method !== "string" || it.method.length > MAX_METHOD_LENGTH)) return ok({ success: false, error: `An item's method exceeds ${MAX_METHOD_LENGTH} characters` });
    for (const ing of it.ingredients) {
      if (!ing || typeof ing.name !== "string" || !ing.name.trim() || ing.name.length > MAX_NAME_LENGTH) {
        return ok({ success: false, error: "Every ingredient needs a name (at most 120 characters)" });
      }
    }
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Sonnet 5, thinking disabled -- a single-shot structured estimate, same settings as estimate-calories.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: buildPrompt(items) }],
      output_config: { format: { type: "json_schema", schema: ESTIMATE_SCHEMA } },
    });
    if (response.stop_reason === "refusal") return ok({ success: false, error: "Estimation was declined" });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return ok({ success: false, error: "No output returned" });
    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.estimates)) return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    // Matched by index by the caller (lib/estimateDensity.js), which also clamps and re-orders every range.
    return ok({ success: true, data: { estimates: data.estimates, prompt_version: PROMPT_VERSION } });
  } catch (err) {
    console.error("[estimate-density] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
