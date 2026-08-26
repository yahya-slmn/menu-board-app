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

// Mapped 1:1 to the Recipe Extractor form's fields -- deliberately excludes "yield"/"net
// weight": that field is computed live in the app from ingredient quantities + waste_percent
// (see updateYieldCalculation in renderer.js), so asking the model for it would just be
// discarded. Ingredients and method are nested under `processes` rather than flat, since one
// card can describe multiple named sub-recipes (e.g. a base, a filling, a topping) that each
// need their own ingredient list and method -- see extracted_recipe_processes.
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
        },
        required: ["name", "ingredients", "method_steps"],
        additionalProperties: false,
      },
    },
    presentation_serving_steps: { type: "array", items: { type: "string" } },
  },
  required: [
    "name", "quantity_produced", "prepared_by", "category", "country_origin",
    "date_created", "waste_percent", "comment", "processes",
    "presentation_serving_steps",
  ],
  additionalProperties: false,
};

const PROMPT = `You are extracting structured data from a photo or scan of an old kitchen recipe card, for a school-nutrition recipe management app. Read it carefully and extract every field you can find. If a field isn't present on the card or you can't read it confidently, use null (or an empty array for lists) -- never guess or invent a value. Extract ingredient quantities as plain numbers only, with the unit in a separate field.

The images/pages above may all be part of the SAME single recipe card -- for example, the front and back of one card, or consecutive pages of a longer recipe. Treat them as one combined source and extract exactly ONE recipe from all of them together, never one recipe per image/page.

The card describes one or more named processes (sub-recipes/components), each with its own ingredients and method -- extract each into its own entry in "processes". If the card describes multiple distinct components (e.g. a base, a filling, a topping, a sauce) -- whether they appear on the same page or split across different pages/photos -- use the card's own name for each one (e.g. "Vanilla Base", "Caramelized Sugar Top"). If the card is a single undivided recipe with no named components, return exactly one process, named after the dish itself. A process may have an empty "ingredients" array if it's method-only (e.g. a finishing/garnish step with no listed ingredients of its own).

Split each process's method into one array entry per distinct step or line, in the order they appear; if that process's instructions are one unbroken paragraph with no clear steps, return that whole paragraph as a single array entry. presentation_serving_steps is for the finished, plated dish as a whole (not any one process) -- split the same way.

Do not extract or estimate a "yield" or "net weight" value -- this app calculates that automatically.`;

// Mirrors the caps enforced client-side (renderer.js's import-recipe-input handler) --
// enforced independently here too, since this endpoint is the one that actually pays for and
// rate-limits against the Anthropic API and shouldn't rely solely on the client behaving.
const MAX_FILES = 10;

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

  let body: { files?: { base64?: string; mimeType?: string; name?: string }[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const files = body.files;
  if (!files || files.length === 0) {
    return ok({ success: false, error: "No files provided" });
  }
  if (files.length > MAX_FILES) {
    return ok({ success: false, error: `Too many files (max ${MAX_FILES})` });
  }
  for (const f of files) {
    if (!f.base64 || !f.mimeType) {
      return ok({ success: false, error: "Missing base64 or mimeType on one or more files" });
    }
  }

  // One text label + one file block per upload -- Anthropic's own multi-image guidance
  // recommends labeling each ("Image 1:", "Image 2:", ...) so the model can address them
  // individually; here it also anchors the "these may be the same card" instruction in PROMPT.
  // The original filename rides along in the label (not used by the model for anything) purely
  // so a misordered/miscombined extraction can be traced back to which uploaded file produced
  // which content, without needing to re-run the upload to find out.
  const fileBlocks: Record<string, unknown>[] = [];
  files.forEach((f, i) => {
    fileBlocks.push({ type: "text", text: `Photo ${i + 1} of ${files.length} (${f.name || "file"}):` });
    const isPdf = f.mimeType === "application/pdf";
    fileBlocks.push(
      isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.base64 } }
        : { type: "image", source: { type: "base64", media_type: f.mimeType, data: f.base64 } },
    );
  });

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // No thinking/effort -- Haiku 4.5 doesn't support effort, and this is a single-shot
    // structured extraction with no need for extended reasoning.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      // deno-lint-ignore no-explicit-any
      messages: [
        { role: "user", content: [...fileBlocks, { type: "text", text: PROMPT }] },
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
