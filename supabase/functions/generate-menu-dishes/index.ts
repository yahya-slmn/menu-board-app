// Supabase Edge Function: generate-menu-dishes
//
// Backs the AI Menu Generator (lib/aiMenuGenerate.js). Same trust boundary as the other
// functions here: it holds the Anthropic API key server-side and has no DB access of its own --
// the caller sends everything the model needs (the category, who it's for, how many dishes of
// which kind, names to avoid, a few catalog names for style) and gets plain dish data back.
//
// One call invents dishes for ONE category of ONE pool (e.g. "KG-LP + MS-UP Lunch Main"). The
// request is split into `groups`, each asking for N dishes with some attributes fixed (e.g. 12
// CHICKEN mains) and optionally one attribute to vary (spread sauce_type across the dishes).
// Each returned dish says which group it answers and carries every attribute the rule engine
// (lib/generator.js) reads, so the menu can be scheduled from these dishes directly.
//
// This is only half the safety story. Every dish that comes back is checked again in code
// (lib/aiMenuSafety.js: nut/sesame and halal for everyone, seafood for student sections) before it is
// stored, and a dish that fails is rejected and reported, never silently kept.
//
// Deploy: `supabase functions deploy generate-menu-dishes --use-api` (the Docker bundling path hangs
// on this machine). Requires the ANTHROPIC_API_KEY secret
// (already set for the other functions).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// The caller asks for at most ~20 dishes per call so one call stays well inside the function's
// wall-clock limit; these are safety ceilings above that.
const MAX_DISHES = 40;
const MAX_GROUPS = 12;
const MAX_LIST = 400;
const MAX_TEXT = 2000;

const SAUCE_TYPES = ["RED", "WHITE", "ASIAN", "GLAZED", "GRAVY", "DRY"];
const CARB_TYPES = ["RICE", "PASTA", "POTATO", "OTHER"];
const DISH_CONCEPTS = ["EGG", "PASTRY", "SANDWICH", "CEREAL_DAIRY", "CHEESE", "OTHER"];
const AM_SNACK_STYLES = ["PASTRY", "COLD_KITCHEN"];
const ATTRS = ["protein_code", "sauce_type", "carb_type", "dish_concept", "am_snack_style"] as const;
type Attr = typeof ATTRS[number];

interface Group {
  count: number;
  // Attributes every dish in this group must have (e.g. { protein_code: "CHICKEN" }).
  fixed?: Partial<Record<Attr, string>>;
  // One attribute to vary evenly across the group, and optionally which values to use.
  spread?: { attr: Attr; values?: string[] };
}

interface RequestBody {
  category: { code: string; label: string; guidance: string };
  audience: string;
  seafoodAllowed: boolean;
  proteinCodes: string[];
  // Attributes the engine needs for this category; the model must not answer NONE for these.
  requiredAttrs: Attr[];
  groups: Group[];
  avoidNames?: string[];
  styleExamples?: string[];
}

// Written with the same severity as suggest-dish-ingredients' NUT_RESTRICTION, plus two rules
// this feature needs on top: (1) substitutes are written as plain ingredients -- never "sesame-
// free", "tahini-free", "nut-free", which name the banned thing and would trip the code check;
// (2) a traditional dish that normally contains nuts or sesame may still be offered (the kitchen
// makes these nut/sesame-free as standard), but only with the substitute listed.
const NUT_SESAME_RULE = `CRITICAL DIETARY RESTRICTION -- this school strictly prohibits ALL nuts, sesame, and anything made from them, with zero exceptions. That means every tree nut (almond, cashew, walnut, pistachio, hazelnut, pecan, macadamia, pine nut, brazil nut, chestnut, etc.), peanut, sesame in any form (seeds, oil, tahini, halva, za'atar blends containing sesame, etc.), and nut products (nut butters, nut milks, nut oils, marzipan, praline, nougat, nutella, frangipane, satay). Coconut is allowed.

Traditional dishes that normally contain nuts or sesame (hummus, mutabbal, baba ghanoush, tarator, muhammara, pesto, baklava, dukkah, za'atar) MAY be offered, because this kitchen makes them nut- and sesame-free as standard practice -- but then key_ingredients MUST list the actual substitute ingredients the kitchen uses, e.g. hummus: "chickpeas", "lemon juice", "garlic", "olive oil", "sunflower seed butter"; pesto: "basil", "parmesan", "olive oil", "sunflower seeds"; za'atar: "dried thyme", "sumac", "oregano", "olive oil"; baklava: "filo pastry", "dates", "desiccated coconut", "butter", "syrup".

NEVER WRITE A BANNED WORD, NOT EVEN NEGATED -- this applies equally to all three fields: the dish NAME, the DESCRIPTION and every KEY INGREDIENT. Describe only what IS in the dish. Every dish is already nut- and sesame-free as kitchen standard, so there is nothing to announce: a "-free" label is never needed and never allowed. Any output that contains a nut or sesame word in any form ("walnut-free", "tahini-free", "sesame-free oil", "almond-free", "nut-free", "no nuts", "without tahini", "in place of tahini") is automatically thrown away.

WRONG -> RIGHT (real mistakes; do not repeat them):
- name "Carrot Walnut-Free Spice Muffin" -> "Carrot Spice Muffin"
- name "Roasted Cauliflower Tahini-Free Salad" -> "Roasted Cauliflower Salad with Lemon Yogurt"
- description "a smoky roasted red pepper and walnut-free dip made with sunflower seed butter" -> "a smoky roasted red pepper dip made with sunflower seed butter"
- description "a lemon-tahini-free yogurt drizzle" -> "a lemon yogurt drizzle"
- key ingredient "sesame-free oil" -> "sunflower oil"
- key ingredient "almond-free garnish coconut flakes" -> "coconut flakes"

The one exception is the word "za'atar" in a dish NAME (e.g. "Za'atar Manakish"). Outside the name it is still banned: in the description write "thyme, sumac and oregano" or "the herb topping", and in key_ingredients list "dried thyme", "sumac", "oregano" -- never "za'atar" or "zaatar" in either field.

Before you answer, re-read every name, description and key ingredient you wrote and rewrite any that contains a nut or sesame word or the word "free".`;

// Mirrors lib/halalFilter.js, which checks every dish in code afterwards. Processed meats must name
// their animal because a bare "pepperoni" / "sausage" / "gelatin" is rejected there.
const HALAL_RULE = `HALAL ONLY -- every dish, every audience: no pork or pork products (pork, ham, bacon, lard, pancetta, prosciutto) and no alcohol in any form, including cooking wine, beer, rum, sherry, marsala, mirin, sake, liqueur, or any dish that is traditionally cooked in alcohol (coq au vin, bourguignon).

Processed meats and gelatin must always say what they are made from: write "beef pepperoni", "chicken sausage", "turkey ham", "beef bacon", "halal gelatin" (or use agar) -- never a bare "pepperoni", "sausage", "ham", "hot dog", "gelatin" or "marshmallow". Use vinegar such as apple cider vinegar, never wine vinegar. As with nuts, never mention pork or alcohol at all, not even to say it is absent -- never write "alcohol-free", "non-alcoholic" or "pork-free".`;

function seafoodRule(allowed: boolean): string {
  return allowed
    ? `Fish and seafood are allowed for this audience.`
    : `NO FISH OR SEAFOOD for this audience (a student section): no fish, tuna, salmon, shrimp, prawns, crab, squid, anchovy, fish sauce, Worcestershire sauce or any other seafood, in any dish. Do not even use fish or seafood words for a shape or presentation ("fish-shaped", "crab cake"-style names), and never use the protein code FISH.`;
}

const ATTRIBUTE_GUIDE = `Attributes (fill every one for every dish; answer "NONE" only where it truly doesn't apply and the attribute is not listed as required):
- protein_code: the dish's main protein, one of the given codes. VEGETARIAN means no meat, poultry or fish at all. NONE for a dish with no real protein focus (a plain starch, a vegetable side, a fruit or sweet snack).
- sauce_type: RED (tomato-based), WHITE (cream / cheese / yogurt / bechamel), ASIAN (soy / teriyaki / sweet-chili style), GLAZED (honey / BBQ / sticky glaze), GRAVY (brown gravy / jus / stew liquid), DRY (grilled, roasted, spiced, no real sauce).
- carb_type: RICE, PASTA, POTATO, or OTHER (bulgur, couscous, bread-based, freekeh, corn, etc.).
- dish_concept: EGG (egg is the dish), PASTRY (baked dough item), SANDWICH (sandwich / wrap / roll / toast with filling), CEREAL_DAIRY (oats, granola, cereal, yogurt, pudding, labneh bowls), CHEESE (a cheese-led plate or item), OTHER.
- am_snack_style: PASTRY (a baked / griddled sweet or bread-based item: pancakes, muffin, croissant, waffle, cake, manakish) or COLD_KITCHEN (an assembled savory item: sandwiches, wraps, omelette, pizza slices, cheese or vegetable plates).`;

function describeGroup(g: Group, i: number): string {
  const parts: string[] = [`group ${i}: ${g.count} dish(es)`];
  const fixed = Object.entries(g.fixed || {}).filter(([, v]) => v);
  if (fixed.length) parts.push(`every dish must have ${fixed.map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  if (g.spread) {
    parts.push(`vary ${g.spread.attr} evenly across the group${g.spread.values?.length ? ` using ${g.spread.values.join(", ")}` : ""}`);
  }
  return `- ${parts.join("; ")}`;
}

function buildPrompt(b: RequestBody): string {
  const total = b.groups.reduce((n, g) => n + g.count, 0);
  const avoid = (b.avoidNames || []).slice(0, MAX_LIST);
  const examples = (b.styleExamples || []).slice(0, 40);
  return `You are the menu planner for a school catering kitchen in Saudi Arabia (Arabic, Levantine, Gulf and international dishes are all welcome). Invent ${total} NEW dishes for this menu category.

Category: ${b.category.label} (${b.category.code})
What belongs here: ${b.category.guidance}
Who eats it: ${b.audience}

${NUT_SESAME_RULE}

${seafoodRule(b.seafoodAllowed)}

${HALAL_RULE}

Make the dishes genuinely varied -- different cuisines, cooking methods, main ingredients and flavours -- practical for a large kitchen to cook in volume, and appealing to the people above. Each name is a clear, appetising menu name (2 to 8 words, Title Case, English), the way it would be printed on the menu. Two dishes must not be the same dish with a slightly different name.

${ATTRIBUTE_GUIDE}
Required for this category (never NONE): ${b.requiredAttrs.length ? b.requiredAttrs.join(", ") : "none"}.
Allowed protein codes: ${b.proteinCodes.join(", ")}, NONE.

Produce exactly these groups, and set each dish's "group" to its group number:
${b.groups.map(describeGroup).join("\n")}

For every dish also give a one-sentence description and 3 to 10 key_ingredients (plain lowercase ingredient names, the main components first).
${examples.length ? `\nThis kitchen's existing dishes in this category, for naming style only (do not repeat them): ${JSON.stringify(examples)}\n` : ""}${avoid.length ? `\nDo NOT produce any of these names or near-copies of them (already on this menu or served recently): ${JSON.stringify(avoid)}\n` : ""}
Remember: no nuts, no sesame, and no nut or sesame word anywhere -- not in the name, not in the description, not in the key ingredients, not even as "X-free"${b.seafoodAllowed ? "" : "; no fish or seafood"}; halal only (name the meat in every processed meat, no alcohol).`;
}

function outputSchema(proteinCodes: string[]) {
  const withNone = (vals: string[]) => ({ type: "string", enum: [...vals, "NONE"] });
  return {
    type: "object",
    properties: {
      dishes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            group: { type: "integer" },
            name: { type: "string" },
            description: { type: "string" },
            key_ingredients: { type: "array", items: { type: "string" } },
            protein_code: withNone(proteinCodes),
            sauce_type: withNone(SAUCE_TYPES),
            carb_type: withNone(CARB_TYPES),
            dish_concept: withNone(DISH_CONCEPTS),
            am_snack_style: withNone(AM_SNACK_STYLES),
          },
          required: ["group", "name", "description", "key_ingredients", ...ATTRS],
          additionalProperties: false,
        },
      },
    },
    required: ["dishes"],
    additionalProperties: false,
  };
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function validate(b: RequestBody): string | null {
  if (!b || typeof b !== "object") return "Invalid request body";
  if (!b.category || typeof b.category.code !== "string" || typeof b.category.label !== "string") return "Missing category";
  if (typeof b.audience !== "string" || !b.audience.trim()) return "Missing audience";
  if (typeof b.seafoodAllowed !== "boolean") return "Missing seafoodAllowed";
  if (!Array.isArray(b.proteinCodes) || !b.proteinCodes.length || b.proteinCodes.some((c) => typeof c !== "string")) return "Missing proteinCodes";
  if (!Array.isArray(b.requiredAttrs) || b.requiredAttrs.some((a) => !ATTRS.includes(a))) return "Invalid requiredAttrs";
  if (!Array.isArray(b.groups) || !b.groups.length || b.groups.length > MAX_GROUPS) return `Between 1 and ${MAX_GROUPS} groups required`;
  let total = 0;
  for (const g of b.groups) {
    if (!g || !Number.isInteger(g.count) || g.count < 1) return "Every group needs a positive integer count";
    if (g.spread && !ATTRS.includes(g.spread.attr)) return "Invalid spread attribute";
    total += g.count;
  }
  if (total > MAX_DISHES) return `Too many dishes in one call (max ${MAX_DISHES})`;
  for (const list of [b.avoidNames, b.styleExamples]) {
    if (list !== undefined && (!Array.isArray(list) || list.length > MAX_LIST || list.some((s) => typeof s !== "string"))) {
      return "avoidNames / styleExamples must be string arrays";
    }
  }
  if ([b.category.guidance, b.audience].some((s) => typeof s !== "string" || s.length > MAX_TEXT)) return "Text field too long";
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ success: false, error: "Method not allowed" });
  if (!ANTHROPIC_API_KEY) return ok({ success: false, error: "Server misconfigured: ANTHROPIC_API_KEY not set" });

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }
  const invalid = validate(body);
  if (invalid) return ok({ success: false, error: invalid });

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Sonnet 5 with thinking disabled, same as the other Edge Functions here (chef's call: ~50
    // calls per run, so cost wins over Opus). Sonnet 5 runs adaptive thinking when the param is
    // omitted, so "disabled" is set explicitly. 16k max_tokens is ample for the ~20 dishes the
    // caller asks for per call.
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "disabled" },
      system: `${NUT_SESAME_RULE}\n\n${HALAL_RULE}`,
      messages: [{ role: "user", content: buildPrompt(body) }],
      output_config: { format: { type: "json_schema", schema: outputSchema(body.proteinCodes) } },
    });

    if (response.stop_reason === "refusal") return ok({ success: false, error: "Dish generation was declined" });
    if (response.stop_reason === "max_tokens") return ok({ success: false, error: "Dish generation was cut off (output too long)" });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return ok({ success: false, error: "No output returned" });
    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.dishes)) return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    return ok({ success: true, data: { dishes: data.dishes }, usage: response.usage });
  } catch (err) {
    console.error("[generate-menu-dishes] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
