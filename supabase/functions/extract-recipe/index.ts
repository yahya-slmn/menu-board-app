// Supabase Edge Function: extract-recipe
//
// Holds the Anthropic API key server-side so it never ships inside the distributed Electron
// app. Called only from the app's main process (lib/recipeExtraction.js) via the already
// -authenticated supabase-js client -- Supabase's platform-level JWT verification (on by
// default for deployed functions) rejects any request without a valid session before this
// code ever runs, so this handler only ever sees calls from a signed-in user, the same trust
// boundary every RLS-protected table already relies on.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Mapped 1:1 to the Recipe form's fields -- deliberately excludes "yield"/"net weight": that
// field is computed live in the app from ingredient quantities + waste_percent (see
// updateYieldCalculation in renderer.js), so asking the model for it would just be discarded.
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { anyOf: [{ type: "string" }, { type: "null" }] },
    quantity_produced: { anyOf: [{ type: "string" }, { type: "null" }] },
    prepared_by: { anyOf: [{ type: "string" }, { type: "null" }] },
    category: { anyOf: [{ type: "string" }, { type: "null" }] },
    country_origin: { anyOf: [{ type: "string" }, { type: "null" }] },
    date_created: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
    waste_percent: { anyOf: [{ type: "number" }, { type: "null" }] },
    comment: { anyOf: [{ type: "string" }, { type: "null" }] },
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
    preparation_cooking_steps: { type: "array", items: { type: "string" } },
    presentation_serving_steps: { type: "array", items: { type: "string" } },
  },
  required: [
    "name", "quantity_produced", "prepared_by", "category", "country_origin",
    "date_created", "waste_percent", "comment", "ingredients",
    "preparation_cooking_steps", "presentation_serving_steps",
  ],
  additionalProperties: false,
};

const PROMPT = `You are extracting structured data from a photo or scan of an old kitchen recipe card, for a school-nutrition recipe management app. Read it carefully and extract every field you can find. If a field isn't present on the card or you can't read it confidently, use null (or an empty array for lists) -- never guess or invent a value. Extract ingredient quantities as plain numbers only, with the unit in a separate field. Split preparation and presentation instructions into one array entry per distinct step or line, in the order they appear; if the card has them as one unbroken paragraph with no clear steps, return that whole paragraph as a single array entry. Do not extract or estimate a "yield" or "net weight" value -- this app calculates that automatically.`;

// Every response is HTTP 200 with a {success, ...} JSON body, including failure cases -- the
// caller (lib/recipeExtraction.js) only ever talks to this one shape, so it never has to
// special-case supabase-js's HTTP-error-vs-body-error handling on top of Anthropic's own
// failure modes (refusal, malformed output, network error).
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

  let body: { base64?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const { base64, mimeType } = body;
  if (!base64 || !mimeType) {
    return ok({ success: false, error: "Missing base64 or mimeType" });
  }

  const isPdf = mimeType === "application/pdf";
  const fileBlock: Record<string, unknown> = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // No thinking/effort -- Haiku 4.5 doesn't support effort, and this is a single-shot
    // structured extraction with no need for extended reasoning.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      // deno-lint-ignore no-explicit-any
      messages: [
        { role: "user", content: [fileBlock, { type: "text", text: PROMPT }] },
      ] as any,
      output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Extraction was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: "No output returned" });
    }

    const data = JSON.parse(textBlock.text);
    return ok({ success: true, data });
  } catch (err) {
    console.error("[extract-recipe] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
