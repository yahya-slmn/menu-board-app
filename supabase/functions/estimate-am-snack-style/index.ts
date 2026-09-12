// Supabase Edge Function: estimate-am-snack-style
//
// Same trust boundary/shape as estimate-calories: holds the Anthropic API key server-side,
// index-tagged batch in/out for the same reason estimate-calories is (Haiku doesn't reliably
// preserve exact 1:1 correspondence over a batch of many short, structurally similar items -- see
// that function's own header comment for the full reasoning, unchanged here).
//
// Classifies AM Snack items (Daycare/KG-LP/MS-UP only -- see main.js's
// estimate-missing-am-snack-styles) as PASTRY or COLD_KITCHEN, backing the weekly rotation rule
// in lib/generator.js (AM_SNACK_STYLE_BY_PATTERN). Applied directly as the final value, same as
// calories_per_100g -- no review-flag/indicator, confirmed with the chef; manually correctable
// afterward via the Item Catalog form either way.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Caller batches at 50 items per call (main.js) -- this is a safety ceiling above that, not the
// intended batch size, same relationship MAX_ITEMS has to estimate-calories' own usage.
const MAX_ITEMS = 150;
const MAX_NAME_LENGTH = 200;

const VALID_STYLES = ["PASTRY", "COLD_KITCHEN"];

interface ClassifyItem {
  index: number;
  name: string;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          am_snack_style: { type: "string", enum: VALID_STYLES },
        },
        required: ["index", "am_snack_style"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

function buildPrompt(items: ClassifyItem[]): string {
  return `For each AM Snack menu item below (served at a school Daycare/KG-LP/MS-UP morning snack time), classify it as exactly one of two kitchen styles:

- PASTRY: a baked/griddled sweet or bread-based item -- e.g. pancakes, chia pudding, croissant, muffin, waffle, cereal bar, cake.
- COLD_KITCHEN: an assembled savory item -- e.g. sandwiches, omelette, pizza, wraps, cheese/vegetable plates.

Base the classification on the item's name alone, using general knowledge of similar dishes.

Each item carries its own "index" number. Return exactly one classification per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct catalog entries and each needs its own separate classification. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

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

  let body: { items?: ClassifyItem[] };
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
    return ok({ success: false, error: `Too many items to classify (max ${MAX_ITEMS})` });
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
    // explicitly disabled: this is still a single-shot structured classification with no need for
    // extended reasoning, and Sonnet 5 runs ADAPTIVE (on) thinking by default when the param is
    // omitted, unlike Haiku 4.5 where omitting it meant off -- leaving it unset would silently add
    // latency/cost on top of the higher per-token price already accepted for this upgrade.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: buildPrompt(items) },
      ],
      output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Classification was declined" });
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
    // same reconcile-by-index, retry-only-the-gaps approach as estimate-calories.
    return ok({ success: true, data });
  } catch (err) {
    console.error("[estimate-am-snack-style] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
