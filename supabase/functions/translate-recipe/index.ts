// Supabase Edge Function: translate-recipe
//
// Same trust boundary as extract-recipe: holds the Anthropic API key server-side so it never
// ships inside the distributed Electron app, only ever reachable by an already-authenticated
// session (Supabase's platform-level JWT verification, on by default for deployed functions).
//
// Deliberately shape-agnostic: takes a flat, order-preserving array of strings and returns the
// same array translated, one-to-one, nothing else. The caller (main.js) is the only place that
// knows what any given string actually IS -- a recipe name, an ingredient name, a fixed export
// template label ("RECIPE FOR:", "Total Quantity", ...) -- and is responsible for building that
// flat array and mapping the translated array back onto its own shape afterward. Keeping this
// function generic means there's no second copy of lib/export.js's DEFAULT_LABELS dictionary
// here to drift out of sync by hand, and no per-field special-casing to maintain as new
// exportable fields get added later -- it's just "translate N strings," full stop.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// A single export (recipe fields + template labels + every ingredient/process name and note)
// comfortably stays under this even for a large multi-process recipe -- generous headroom, not
// a tight budget.
const MAX_TEXTS = 300;
const MAX_TEXT_LENGTH = 4000;

const TRANSLATE_SCHEMA = {
  type: "object",
  properties: {
    texts: { type: "array", items: { type: "string" } },
  },
  required: ["texts"],
  additionalProperties: false,
};

function buildPrompt(targetLanguage: string, texts: string[]): string {
  return `Translate each string in the following JSON array to ${targetLanguage}. Return a JSON array of the same length, in the same order, one translation per input string -- do not add, merge, split, reorder, or drop any entries.

Rules:
- An empty string stays an empty string in the output -- don't translate or explain a blank entry, just pass it through unchanged.
- A string that's already just a number, a unit of measurement, or a date, with nothing else in it, should be left unchanged.
- Prioritize accuracy over literalness: use the standard, natural term a native speaker of ${targetLanguage} would actually use, not a generic or overly literal word-for-word translation -- this matters especially for ingredient names, dish names, and cooking/kitchen terminology.
- If a string is genuinely ambiguous or has no single standard equivalent in ${targetLanguage}, translate as best you can and append the original term in parentheses so nothing is lost, e.g. "farmer's cheese (original term)".

Input array (JSON): ${JSON.stringify(texts)}`;
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

  let body: { targetLanguage?: string; texts?: string[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const targetLanguage = (body.targetLanguage || "").trim().slice(0, 60);
  if (!targetLanguage) {
    return ok({ success: false, error: "Missing targetLanguage" });
  }

  const texts = body.texts;
  if (!Array.isArray(texts)) {
    return ok({ success: false, error: "Missing texts array" });
  }
  if (texts.length === 0) {
    return ok({ success: true, data: { texts: [] } });
  }
  if (texts.length > MAX_TEXTS) {
    return ok({ success: false, error: `Too many strings to translate (max ${MAX_TEXTS})` });
  }
  for (const t of texts) {
    if (typeof t !== "string") {
      return ok({ success: false, error: "texts must be an array of strings" });
    }
    if (t.length > MAX_TEXT_LENGTH) {
      return ok({ success: false, error: `A string exceeds ${MAX_TEXT_LENGTH} characters` });
    }
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // No thinking/effort -- Haiku 4.5 doesn't support effort, and this is a single-shot
    // structured translation with no need for extended reasoning. Text-only (no vision), so
    // cheaper/faster than extract-recipe's image calls.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [
        { role: "user", content: buildPrompt(targetLanguage, texts) },
      ],
      output_config: { format: { type: "json_schema", schema: TRANSLATE_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Translation was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: "No output returned" });
    }

    const data = JSON.parse(textBlock.text);
    // Defends the caller's positional unflatten (main.js zips this array back onto specific
    // recipe fields by index) -- a length mismatch here would otherwise silently misfile every
    // translated value onto the wrong field instead of erroring visibly.
    if (!Array.isArray(data.texts) || data.texts.length !== texts.length) {
      return ok({ success: false, error: "Translation output length mismatch" });
    }
    return ok({ success: true, data });
  } catch (err) {
    console.error("[translate-recipe] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
