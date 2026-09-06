// Supabase Edge Function: estimate-calories
//
// Same trust boundary as extract-recipe/translate-recipe: holds the Anthropic API key
// server-side so it never ships inside the distributed Electron app, only ever reachable by an
// already-authenticated session (Supabase's platform-level JWT verification, on by default for
// deployed functions).
//
// Index-tagged, NOT positional -- unlike translate-recipe's flat array-in/array-out (safe there
// because every string genuinely needs its own translation), a live run here proved Haiku doesn't
// reliably preserve exact 1:1 correspondence over a batch of ~50-100 short, structurally similar
// {name, category, protein} objects: every failure had stop_reason "end_turn" (a normal, complete
// response, not a max_tokens cutoff) yet came back with anywhere from a few short to a few over
// the requested count -- a real instruction-following gap for this shape of content, not a token
// budget issue. So each input item now carries its own `index`, the output schema requires that
// same index back on every estimate, and gaps/extras are reconciled by index rather than array
// position -- the caller (main.js's estimate-missing-calories handler) gets back whatever
// indices DID come through correctly (partial success, not an all-or-nothing failure) and retries
// only the specific items still missing afterward.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Caller batches at 50 items per call (main.js) -- this is a safety ceiling above that, not the
// intended batch size, same relationship MAX_TEXTS has to translate-recipe's actual usage.
const MAX_ITEMS = 150;
const MAX_NAME_LENGTH = 200;

interface EstimateItem {
  index: number;
  name: string;
  category?: string | null;
  protein?: string | null;
}

const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          calories_per_100g: { type: "number" },
        },
        required: ["index", "calories_per_100g"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

function buildPrompt(items: EstimateItem[]): string {
  return `For each school/staff cafeteria menu item below, estimate a typical calories-per-100g value (kcal per 100 grams of the prepared, as-served dish) for that item. Base the estimate on its name, category, and protein type when given -- use general nutrition knowledge of similar dishes, since no recipe or ingredient list is provided.

Each item carries its own "index" number. Return exactly one estimate object per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct catalog entries and each needs its own separate estimate. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

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

  let body: { items?: EstimateItem[] };
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
    return ok({ success: false, error: `Too many items to estimate (max ${MAX_ITEMS})` });
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
    // structured estimation with no need for extended reasoning. Text-only, so cheaper/faster
    // than extract-recipe's image calls, same as translate-recipe. 8192 is generous headroom for
    // even a full 150-item MAX_ITEMS batch's worth of short `{"index":N,"calories_per_100g":N}`
    // entries -- kept high from an earlier (mistaken) max_tokens-truncation theory; harmless to
    // leave generous even though the real fix turned out to be the index-tagging above.
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [
        { role: "user", content: buildPrompt(items) },
      ],
      output_config: { format: { type: "json_schema", schema: ESTIMATE_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Estimation was declined" });
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
    // that's the expected, common case now (see the file header comment). The caller reconciles
    // by each entry's own `index` and retries only whatever indices are actually missing, so a
    // batch that comes back 48/50 or even 52/50 still yields real, usable, correctly-attributed
    // data instead of being discarded entirely.
    return ok({ success: true, data });
  } catch (err) {
    console.error("[estimate-calories] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
