// Supabase Edge Function: extract-menu-dishes
//
// Same trust boundary as suggest-dish-ingredients/estimate-calories: holds the Anthropic API key
// server-side, index-tagged batch in/out for the same reason those two are (see estimate-calories'
// own header comment -- Haiku doesn't reliably preserve exact 1:1 correspondence over a batch of
// many short, structurally similar items).
//
// Backs Recipe Generator's LAYOUT-AGNOSTIC fallback (main.js's parse-and-generate-recipes,
// extractDishesWithAI): when lib/menuIngredients.js's strict, marker-based parser
// (parseWorkbookDishes) finds zero rows -- because the uploaded file is a real school-provided
// menu spreadsheet, not this app's own Generate Menu/Build Menu/Export All Sections export, so it
// has none of the RC/"Quantity"/"Weight/Unit" column markers that parser looks for -- the caller
// falls back to asking the model to read the raw grid directly instead of failing outright.
//
// Input is a BATCH OF ROWS from one worksheet, each row already flattened to its non-blank cell
// text values in original left-to-right column order (main.js's flattenSheetForAI, via
// lib/menuIngredients.js's own cellText -- no column position is assumed on either side of this
// call). A batch, not one row at a time, on purpose: real menu files typically restate a day's
// weekday and column headers only once per day-block and repeat a meal-period/category label only
// intermittently (sometimes once per row, sometimes once per block) -- so the model needs several
// consecutive rows in view together to tell a genuine dish row from a header/label/quantity row
// and to carry a category label forward onto the dish rows that don't repeat it themselves.
//
// Output is NOT one entry per input row -- only rows the model judged to be an actual food/dish
// item are returned at all (day headers, pure category-label rows, quantity/unit-only cells, and
// blank/spacer rows are simply omitted, not flagged false). Each entry carries back the exact
// row index it came from ("i"), so main.js can attach the real sheet name/row number without the
// model ever needing to invent or preserve that itself.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Caller batches at 50 rows per call (main.js's DISH_EXTRACTION_BATCH_SIZE) -- this is a safety
// ceiling above that, not the intended batch size, same relationship MAX_ITEMS has to every other
// batched Edge Function's own usage here.
const MAX_ROWS = 150;
const MAX_CELLS_PER_ROW = 30;
const MAX_CELL_LENGTH = 300;

interface SheetRow {
  i: number;
  c: string[];
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    dishes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          name: { type: "string" },
          category: { type: "string" },
        },
        required: ["i", "name", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["dishes"],
  additionalProperties: false,
};

function buildPrompt(rows: SheetRow[]): string {
  return `You are reading a batch of rows from a REAL, messy school/staff cafeteria menu spreadsheet -- not a clean template. Column order, header wording, and structure vary file to file and are NOT known in advance. Each row below is given as its row number and the list of its own non-blank cell values, in their original left-to-right order (blank cells have already been removed, so a row with 4 values might have started as columns A, C, D, G -- don't assume fixed column positions).

A row in a file like this is one of:
- A day/week header row (a weekday name like "Monday" or "Sunday", sometimes a date, often paired with generic column-header words like "GM/ML", "Quantity", "Unit", "Weight Requirement", or a repeated per-group headcount string like "MSG B=118 L=100 P=118").
- A meal-period or category LABEL row/cell with no specific food attached to it (e.g. just the word "Lunch", "Breakfast", "AM Snack", "PM Snack" repeated down a column as a label, not naming a dish) -- but the SAME label text sitting in a column right next to an actual dish name, on a row that also has a real food item, is context for that dish, not a reason to skip the row.
- A quantity/unit/headcount cell on its own (numbers, "150 g", "120gm", "5 option", "200ml", "KG", "Pieces", "basket") -- never a dish name by itself.
- A blank/spacer row.
- A genuine DISH/FOOD ITEM row -- names one specific food or drink (e.g. "Chicken Piccata With Butter Creamy Sauce", "Mashed potato", "Whit Rice", "Danish with cinnamon and apple", "Fresh Full Fat Milk"). This is what you're looking for. A dish name may have a leading item number in the same or an adjacent cell ("6", "Whit Rice") -- if so, return just the dish name text itself, not the number.

For EVERY row that is a genuine dish/food item row, return one entry with:
- "i": that row's number, copied exactly from the input.
- "name": the dish/food name text, cleaned of a leading item number and stray surrounding whitespace, otherwise written exactly as it appears (don't rephrase, translate, correct spelling, or shorten it).
- "category": your best guess at the meal category/period this dish belongs to (e.g. "Breakfast", "AM Snack", "Lunch", "Lunch Buffet", "PM Snack", "Snack", "Dinner", "Appetizer", "Main Course", "Salad", "Soup", "Bread", "Sweets", "Fruit Basket", "Milk", "Juice", "Water") -- prefer copying the actual label text you can see either elsewhere in this SAME row or on the most recent label-only row above it in this same batch, over inventing your own wording. Use an empty string "" only if truly nothing in this batch indicates a category for that row.

Two important rules for picking WHICH label to copy, since a row can carry more than one:
1. When a row carries BOTH a broad meal-period label (e.g. "Breakfast", "Lunch") AND a more specific sub-category in another cell of that SAME row (e.g. "Juices", "Salad", "Milk"), always prefer the MORE SPECIFIC one -- e.g. a row reading period "Breakfast" + sub-category "Juices" + dish "Pina Colada" should get category "Juices", not "Breakfast".
2. When a row has NO specific sub-category cell at all (only a broad period label like "AM Snack" applies, exactly the same label a genuine snack dish elsewhere in that block also carries) but the dish name itself is unambiguously just a plain milk, juice, water, or whole/mixed-fruit item with no preparation involved (e.g. "Plain Fresh Milk Full Fat", "Fresh Full Fat Milk", "lemonade Juice OR Laban", "Fruit (a selection of seasonal fruits)"), output the item's own specific type instead of the surrounding period label -- "Milk" for a plain milk item, "Juice" for a juice/yogurt-drink choice, "Fruit Basket" for a whole/mixed fruit selection -- even though that exact word never appears in the sheet for that row. This distinction matters downstream: a broad period label like "AM Snack" can include both a real snack dish AND a plain drink/fruit item side by side, and only the specific type lets them be told apart.

Do NOT return an entry for a day/week header row, a pure label row with no food attached, a quantity/unit-only value, or a blank row. Every "i" you return must be a row number that was actually present in the input, and you may return zero entries if this entire batch happens to contain no dish rows (e.g. it's all header/label rows).

Rows (JSON array, each {i, c}): ${JSON.stringify(rows)}`;
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

  let body: { rows?: SheetRow[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  const rows = body.rows;
  if (!Array.isArray(rows)) {
    return ok({ success: false, error: "Missing rows array" });
  }
  if (rows.length === 0) {
    return ok({ success: true, data: { dishes: [] } });
  }
  if (rows.length > MAX_ROWS) {
    return ok({ success: false, error: `Too many rows to extract (max ${MAX_ROWS})` });
  }
  for (const r of rows) {
    if (!r || typeof r.i !== "number" || !Array.isArray(r.c)) {
      return ok({ success: false, error: "Every row needs a numeric i and a cells array" });
    }
    if (r.c.length > MAX_CELLS_PER_ROW) {
      return ok({ success: false, error: `A row exceeds ${MAX_CELLS_PER_ROW} cells` });
    }
    for (const cell of r.c) {
      if (typeof cell !== "string" || cell.length > MAX_CELL_LENGTH) {
        return ok({ success: false, error: `A cell value is missing or exceeds ${MAX_CELL_LENGTH} characters` });
      }
    }
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Sonnet 5 (upgraded from Haiku 4.5, chef-approved for the higher per-token cost) -- thinking
    // explicitly disabled: this is still a single-shot structured extraction with no need for
    // extended reasoning, and Sonnet 5 runs ADAPTIVE (on) thinking by default when the param is
    // omitted, unlike Haiku 4.5 where omitting it meant off -- leaving it unset would silently add
    // latency/cost on top of the higher per-token price already accepted for this upgrade.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: buildPrompt(rows) },
      ],
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Extraction was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: "No output returned" });
    }

    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.dishes)) {
      return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    }
    // Defensive re-check against the real input row numbers -- never trust the model to have only
    // echoed "i" values it was actually given (same "don't trust the model as the final word"
    // posture main.js's own resolveWasteTypeId/resolveIngredientId take elsewhere).
    const validRowNumbers = new Set(rows.map((r) => r.i));
    const dishes = data.dishes.filter((d: { i: number; name: string }) =>
      validRowNumbers.has(d?.i) && typeof d?.name === "string" && d.name.trim().length > 0);
    return ok({ success: true, data: { dishes } });
  } catch (err) {
    console.error("[extract-menu-dishes] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
