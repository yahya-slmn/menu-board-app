// Supabase Edge Function: generate-dish-recipes
//
// Backs the Recipe Generator screen: given a batch of dish names pulled from an uploaded menu
// file (every dish EXCEPT Bread/Milk/Juice/CEO -- filtered by the caller, lib/recipeGenerator.js),
// generates a FULL reference recipe per dish -- name, one or more named processes each with
// ingredients (name/quantity/unit/method), a method, and (optionally, only where genuinely
// applicable) a waste % per process -- at a natural/realistic scale. Waste matching against the
// existing waste_types catalog is a semantic decision handed to the model (see buildWasteRule)
// since this function has no DB access to do string matching itself; main.js resolves the
// model's answer against the real catalog afterward. This is deliberately NOT the same call as
// suggest-dish-ingredients: that
// function returns one short dash-separated ingredient string per dish (a much smaller, more
// frequent ask); this one returns a full nested recipe structure per dish, a categorically
// bigger structured-output request that would otherwise inflate suggest-dish-ingredients'
// latency/token budget for its own, far more common, ingredients-only path.
//
// Each item also carries "seafoodAllowed" (see SEAFOOD_RESTRICTION below) -- a school-policy
// restriction, section-conditional unlike the universal nut/sesame one, with its own "skipReason"
// escape hatch for a dish that's genuinely, unambiguously seafood-based landing in a section
// where that's not permitted (main.js treats a set skipReason as a deliberate decline, not a
// failure -- it's logged as a warning, never persisted, and never retried).
//
// Batch size is intentionally much smaller than suggest-dish-ingredients' 50 (main.js sends
// ~8 per call) given how much larger a full recipe is than one ingredient string -- see
// lib/generateDishRecipes.js.
//
// Size standardization happens AFTER this call, not inside the prompt: the model is asked for a
// realistic natural-scale recipe (LLMs are unreliable at hitting an exact numeric total), and
// main.js mathematically scales every ingredient afterward so the recipe's NET WEIGHT (each
// process's waste-adjusted total, summed) is exactly 150 g -- see normalizeProcessesToNetWeight in
// lib/recipeGenerator.js -- so the natural sizes here only need to have sensible RATIOS.
//
// Salad dishes: each item carries a "separateDressing" flag (true for any Salad-category dish,
// decided in main.js like seafoodAllowed) -- see SALAD_DRESSING_RULE below.
//
// Same index-tagged batch in/out convention as estimate-calories/suggest-dish-ingredients, for
// the same reason (Haiku doesn't reliably preserve exact 1:1 correspondence over a batch of many
// structurally similar items).
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Small on purpose -- a safety ceiling above main.js's own intended batch size (~8), same
// relationship MAX_ITEMS has to suggest-dish-ingredients'/estimate-calories' own usage, just a
// much lower ceiling given how much larger a full recipe's output is than a short string.
const MAX_ITEMS = 15;
const MAX_NAME_LENGTH = 200;

interface DishItem {
  index: number;
  name: string;
  category?: string;
  // Computed in main.js from the dish's own resolved menu section, never left for this model to
  // infer from a section name string itself -- see SEAFOOD_RESTRICTION below and
  // lib/recipeGenerator.js's isStudentSection/resolveSectionFromSheetName. true only for Staff;
  // every student section (and an unresolvable/unknown section) is false.
  seafoodAllowed: boolean;
  // Computed in main.js from the menu category (any category containing "salad", case-insensitive).
  separateDressing: boolean;
  // Computed in main.js: true only for a Staff lunch "Main Dish" no student dish shares (see ROLE_RULE). The app
  // files that recipe under Main Hot Dish or Starch / Side Vegetables by the "role" returned for it.
  askRole: boolean;
  // Phase E (2026-10-01): the chef's reviewed ingredient list from a Menu Ingredients export, when there is one
  // (main.js reviewedIngredientsOf). See REVIEWED_LIST_RULE. Absent for an older app or a plain menu.
  reviewedIngredients?: string[];
}

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          name: { type: "string" },
          // Set to a short explanation (and leave "processes" empty) ONLY when this dish is
          // genuinely, unambiguously seafood-based and its item carried seafoodAllowed: false --
          // see SEAFOOD_RESTRICTION. null for every normal item, including a shape-named dish
          // (e.g. a fish-shaped sandwich) that correctly generates with no real seafood.
          skipReason: { anyOf: [{ type: "string" }, { type: "null" }] },
          // "main" / "side" for an item with askRole (see ROLE_RULE), null for every other item.
          role: { anyOf: [{ type: "string", enum: ["main", "side"] }, { type: "null" }] },
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
                wastes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      percent: { type: "number" },
                      matchedExisting: { type: "boolean" },
                    },
                    required: ["name", "percent", "matchedExisting"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["name", "ingredients", "method_steps", "wastes"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "name", "skipReason", "role", "processes"],
        additionalProperties: false,
      },
    },
  },
  required: ["recipes"],
  additionalProperties: false,
};

// Identical wording to suggest-dish-ingredients/index.ts's own NUT_RESTRICTION -- same policy,
// same reasoning (repeated in both the system prompt and inline, belt-and-suspenders), applied
// here too since a full generated recipe is just as capable of naming a nut or sesame ingredient
// as a suggested ingredient list is. This function has no separate "allergens" field the way
// suggest-dish-ingredients does -- ingredients are the only place a nut/sesame violation could
// surface here, and lib/nutFilter.js's matchNutTerms scans every generated ingredient name as the
// code-level backstop regardless of how well this prompt was followed.
const NUT_RESTRICTION = `CRITICAL DIETARY RESTRICTION -- this school strictly prohibits ALL nuts, sesame, and their derived ingredients, with zero exceptions. Never include any tree nut (almond, cashew, walnut, pistachio, hazelnut, pecan, macadamia, pine nut, brazil nut, chestnut, etc.), peanut, sesame in any form (sesame seeds, sesame oil, tahini/sesame paste, halva, za'atar, benne, gomashio, etc.), or nut/sesame-derived product (nut butter, nut milk, nut oil, marzipan, praline, nutella, nougat, etc.) in ANY generated recipe -- even if the dish traditionally or typically includes one. If a dish's most natural recipe would normally include a nut or sesame product, substitute a safe alternative that fits the dish (e.g. sunflower seed butter instead of peanut butter, or instead of tahini in a dish like hummus; extra olive oil and lemon juice instead of tahini; a plain breadcrumb or herb crust instead of a sesame crust; a sesame-free herb blend -- thyme, sumac, oregano -- instead of za'atar) or simply omit that component -- never include the nut or sesame itself. Treat this with the same seriousness as an allergy-critical instruction, because it is one.`;

// UNLIKE the nut restriction above, this is NOT universal -- it is a school POLICY restriction
// (seafood/fish banned for student sections, permitted for Staff), computed per-item as the
// "seafoodAllowed" flag on each item (see the DishItem interface) rather than something this
// model decides from a section name itself -- main.js already resolved that. The genuinely hard
// part is telling apart a dish name that merely describes a SHAPE (a common kid-presentation
// style -- a sandwich or snack cut into a fish/crab shape) from a dish that IS actually seafood-
// based, since only the model has the semantic judgment to tell those apart; the "skipReason"
// escape hatch exists specifically for the one case a code-level filter cannot safely resolve on
// its own -- a genuinely seafood-based dish that shouldn't exist in a student section at all
// (a real menu-planning mistake). Confirmed with the chef: skip and flag that case, don't invent
// a substitute-protein version of it (unlike the nut restriction above, which DOES substitute).
const SEAFOOD_RESTRICTION = `Each item below also carries a "seafoodAllowed" flag -- follow it per item, since a single batch can mix items with different flags:

When "seafoodAllowed" is false (a Misk student section -- Daycare/KG-LP/MS-UP -- where seafood/fish is strictly prohibited by school policy):
- If the dish name merely describes a SHAPE or cutting/presentation style referencing a fish, crab, shrimp, etc. (a common kid-presentation style, e.g. a sandwich or snack CUT INTO a fish or crab shape, with no seafood actually involved) -- generate the recipe NORMALLY with its real ingredients (e.g. a grilled cheese sandwich, a fruit platter) and include ZERO real seafood/fish ingredients. The shape is purely cosmetic, not a preparation instruction -- do not add fish, shrimp, crab, or any other seafood just because the name mentions one.
- If the dish is GENUINELY, unambiguously a seafood-based dish by its own name/concept (e.g. "Grilled Salmon", "Shrimp Scampi", an actual tuna sandwich) -- this is a real menu-planning mistake, since such a dish should never be placed in a student section -- do NOT generate a recipe for it, and do NOT substitute a different protein to force one through anyway. Instead set "skipReason" to a brief explanation (e.g. "Genuinely a seafood dish; not permitted for this student section") and leave "processes" as an empty array.
- If you are genuinely unsure whether a name describes a shape or an actual seafood dish, treat it as the second case above (skip and explain) rather than guessing either way.

When "seafoodAllowed" is true (a Staff dish): seafood/fish is fully permitted. Generate real seafood ingredients normally for a genuinely seafood-based dish, exactly as you would any other protein -- no special handling needed.

For every item you do NOT skip, set "skipReason" to null.`;

// A Salad dish's dressing is its own process (chef request: "Salad" + "Dressing", the way Ciabatta already splits into a biga and a
// final dough) rather than being lumped in with the leaves and vegetables. The first process keeps the DISH's name (more useful to a
// chef scanning recipes than a generic "Salad"); the second is always named "Dressing". The flag is decided in code from the
// category, so the model never has to guess whether a dish counts as a salad. A salad with no dressing at all stays one process.
const SALAD_DRESSING_RULE = `Each item also carries a "separateDressing" flag -- follow it per item, since a single batch can mix salads and other dishes:

When "separateDressing" is true (the dish is in a Salad category) and the salad has a dressing:
- Generate exactly TWO processes. The FIRST is the salad itself -- every ingredient except the dressing -- and is named exactly after the dish (the dish name as given). The SECOND is named exactly "Dressing" and holds ONLY the dressing's own ingredients (oil, vinegar, lemon juice, yoghurt, herbs, seasoning, etc.) and its own method steps (how to mix it).
- Never put a dressing ingredient in the first process. The first process's method may say to toss or serve with the dressing, but must not describe making it.
- If the dish genuinely has no dressing (for example a plain fruit salad served as is), generate a single process as usual -- do not invent a dressing.

When "separateDressing" is false or absent, ignore this rule: follow the normal process rule (one process for a simple dish) even if the dish happens to include a dressing.`;

// Added 2026-10-01 (Menu Ingredients -> Recipe Generator pipeline, Phase E). The chef reviews each dish's ingredients
// in the Menu Ingredients Generator first; the recipe must then be built on HER list, not a fresh guess. The model may
// only add what the method needs. Her level of detail wins over DECOMPOSITION_RULE ("brown bread" stays one ingredient).
// The app checks in code that every listed ingredient is there (Phase F).
const REVIEWED_LIST_RULE = `Some items carry "reviewedIngredients": the ingredient list a chef has already reviewed for this dish. For such an item:
- Use EVERY ingredient on that list, each with its name exactly as written (same words; you may only change letter case). Never drop one, never rename or reword one, never split one into its parts, never replace one with something else.
- The chef's level of detail wins over the decomposition rule: if the list says "brown bread", "puff pastry" or "tomato sauce", that is ONE ingredient row with that name -- do not break it into flour, yeast, butter or the like.
- You may ADD only what the method truly needs and the list leaves out -- e.g. oil to fry or grease, water the dish keeps (see the water rule), salt for seasoning. Add nothing else.
- The school's restrictions still apply to anything you add.
Items without "reviewedIngredients" follow the normal rules.`;

// Added 2026-09-30 (Recipe Generator category groups). Staff's lunch "Main Dish" row holds both the centre of the plate
// and plain accompaniments (rice, potatoes, vegetables) under one label; the app groups recipes by what the dish IS on
// the plate, so for the Staff mains no student dish shares (askRole, decided in main.js) the model says which. Meat or
// fish in the dish always makes it a main in the app, whatever the role; the role matters for meatless dishes.
const ROLE_RULE = `Each item also carries an "askRole" flag. When "askRole" is true, set "role" to how the dish is served on a plate:
- "side" -- a plain ACCOMPANIMENT built on a starch or a vegetable, served next to a main: plain or seasoned rice (white rice, saffron rice, vermicelli rice), potatoes (mashed, roasted, wedges, fries), plain pasta or noodles with a simple sauce, bulgur or freekeh, steamed / sauteed / roasted / grilled vegetables, green beans, a vegetable gratin served as a side.
- "main" -- the CENTRE of the plate, with or without meat: any meat, poultry or fish dish, and meatless mains such as eggplant parmigiana, mac and cheese, lasagna, a burrito or bowl, a curry with rice, stuffed vegetables, a tofu or lentil dish, moussaka, a vegetable stew eaten as the meal.
If it is genuinely unclear, choose "main". When "askRole" is false or absent, set "role" to null.`;

// Shorter version of suggest-dish-ingredients' own DECOMPOSITION_RULE -- a full recipe's
// ingredient list is inherently more decomposed than a bare ingredient-name suggestion (you
// can't write a real method step around "dough" without saying what's in it), but the same
// laziness failure mode is still possible for a named sub-component, so the instruction carries
// over in short form.
const DECOMPOSITION_RULE = `Every ingredient name must be a real base ingredient (flour, sugar, butter, eggs, yeast, milk, salt, oil, etc.) -- never a sub-preparation (dough, batter, filling, sauce, breading, etc.) named as if it were an ingredient itself. If the dish involves a sub-preparation, decompose it into its real base ingredients as separate ingredient rows within the relevant process, the same way a real recipe would.`;

// Same enforcement pattern as NUT_RESTRICTION/DECOMPOSITION_RULE above -- a hard constraint
// stated as its own explicit rule, then referenced again in the closing "Remember" reinforcement
// (see buildPrompt), rather than left as a soft preference buried inside the ingredients bullet.
// This is a real correctness fix, not a style preference: the app's own downstream math
// (normalizeProcessesToGrams' 100g scaling, sumIngredientQuantities/compoundWasteYield's Net
// Weight calc, the Total-Quantity/Net-Weight rescale cascades) all sum ingredient quantities
// directly regardless of unit -- a stray "ml" or "pc" silently corrupts every one of those totals
// exactly like a wrong gram figure would, just less visibly.
const UNITS_RULE = `Every ingredient's quantity MUST be expressed in grams ("g") -- with zero exceptions. This applies to liquids, oils, sauces, melted or liquid ingredients, and count-based items (a whole egg, a garlic clove, a single fruit) just as much as dry/solid ingredients -- there is no "grams genuinely doesn't apply" case. Never use "ml", any other volume unit, or any non-gram unit ("pc", "piece", "cup", "tbsp", "tsp", etc.) anywhere in your output, even for an ingredient that would naturally be measured that way in a real kitchen. Convert to its gram equivalent using standard culinary density/weight knowledge instead (e.g. water/milk/stock ~1g per ml, olive oil ~0.92g per ml, "1 egg" -> ~50g, "1 garlic clove" -> ~5g) -- never report the ingredient in its natural unit.`;

// Chef-reported failure mode: a plain, unqualified staple name (their concrete example was
// "White Rice" on a school lunch menu) is genuinely ambiguous to a model working from general
// culinary knowledge alone -- "rice" has many popular preparations (fried, pilaf, biryani, ...),
// and nothing in the bare dish name signals which one a school-cafeteria menu actually means.
// Stated as a general rule (not hardcoded to rice alone) since the same ambiguity applies to any
// plain staple name; the item payload has no per-dish section/context field to key off of, so
// this can't be scoped to "only Daycare" the way the chef's own example was framed -- it applies
// uniformly, which is fine since a plain staple name means the same simple thing in any section.
const PLAIN_STAPLE_RULE = `When a dish name is a plain, unqualified staple with no preparation style stated (e.g. "White Rice", "Rice", "Pasta", "Potatoes"), assume the SIMPLEST, most standard preparation -- e.g. "White Rice" means plain white STEAMED (or boiled) rice, not fried rice, rice pilaf, biryani, or any other elaborate preparation. Only generate a fancier preparation when the dish name itself actually says so (e.g. "Fried Rice", "Rice Pilaf", "Biryani").`;

// Added 2026-10-01 (with the move to Opus 5.5). Every row is scaled to the recipe's 150 g Net Weight, so a row for water
// that is poured away (pasta or vegetable boiling water, blanching, a steamer or water bath) inflated the recipe and
// shrank every real ingredient: the trial found it in 36 of 196 recipes, up to 8 kg on pasta. Water the dish keeps
// (absorbed by rice / grains / pulses, a soup, a sauce, a dough or batter) is a real ingredient and stays.
const WATER_RULE = `Water is an ingredient row ONLY for water that stays in the finished dish: water absorbed in cooking (rice, bulgur, freekeh, couscous, oats, lentils and pulses cooked by absorption), the liquid of a soup, stew or sauce, or water in a dough, batter, syrup or drink. Give only the amount that stays in the dish. Never list water that is drained or discarded -- the boiling water for pasta, noodles, potatoes or vegetables, blanching or soaking water, a steamer, or a water bath. Describe that step in the method ("cook the pasta in boiling salted water, drain") without an ingredient row for the water. This applies to items with "reviewedIngredients" too: if the chef's list names water, keep the row, with only the water that stays in the dish.`;

// Waste has no DB access here (this function is Anthropic-only, no Supabase client) -- the
// matching decision is inherently semantic ("Baking Waste" and "Oven Loss" might mean the same
// thing, might not), so it's handed to the model rather than attempted as a string-similarity
// check in main.js. main.js resolves the model's answer against the real catalog afterward
// (exact match first, create only if genuinely new -- see resolveWasteTypeId), so this only ever
// needs to get name/percent right, never a real waste_types id.
function buildWasteRule(existingWasteTypeNames: string[]): string {
  const catalogList = existingWasteTypeNames.length > 0
    ? existingWasteTypeNames.join(", ")
    : "(none yet -- propose new ones as needed)";
  return `Some processes involve a real, measurable loss step (trimming, peeling, baking/roasting shrinkage, straining, reduction, rendering, etc.) -- for a process where that genuinely applies, include a "wastes" entry describing it. For a process with no meaningful loss (most simple mixing/combining/plating/assembly steps), leave "wastes" as an empty array -- do not invent a waste just to fill the field.

For each waste you do include: if it clearly matches one of these EXISTING catalog waste types by name or plain meaning, set "matchedExisting" to true and "name" to that EXACT existing name, copied verbatim from the list below (so it's reused, not duplicated). If nothing in the catalog genuinely fits, set "matchedExisting" to false and propose a new, concise, professional waste-type name (e.g. "Heating Waste", "Cooling Loss", "Straining Loss"). Either way, "percent" is a realistic AVERAGE percentage for that specific kind of loss in a professional kitchen setting, based on general culinary knowledge (e.g. trimming waste on raw vegetables is typically 10-15%, baking/roasting shrinkage 15-25%, peeling loss on root vegetables 20-30%) -- don't default to a generic round number if you know the realistic range is different.

Existing catalog waste types (match against these first): ${catalogList}`;
}

function buildPrompt(items: DishItem[], existingWasteTypeNames: string[]): string {
  return `${NUT_RESTRICTION}

You are generating a REFERENCE recipe for each school/staff cafeteria dish named below, for a school-nutrition recipe management app. This is a plausible, realistic recipe based on general culinary knowledge (no real recipe card is available) -- a starting point a chef will review and edit, not a precise transcription.

${DECOMPOSITION_RULE}

${UNITS_RULE}

${PLAIN_STAPLE_RULE}

${WATER_RULE}

${SEAFOOD_RESTRICTION}

${SALAD_DRESSING_RULE}

${ROLE_RULE}

${REVIEWED_LIST_RULE}

For each dish, generate:
- "name": the dish name (use the given name, cleaned up if needed).
- "skipReason": see the seafood restriction above -- null unless you are genuinely declining this specific item.
- "role": see the role rule above -- "main" or "side" only for an item with "askRole" true, otherwise null.
- For an item with "reviewedIngredients": every listed ingredient appears, name unchanged (see the reviewed-list rule above); you only add what the method needs.
- "processes": one or more named sub-recipes. Use exactly ONE process, named after the dish itself, for a simple dish (except a dish flagged "separateDressing", which follows the salad rule above). Split into multiple named processes (e.g. "Dough", "Filling", "Topping") only when the dish genuinely has distinct components that would be prepared separately in a real kitchen. Empty array only when "skipReason" is set.
- Each process's "ingredients": every real base ingredient it needs, each with a realistic quantity for a normal/standard batch of this dish (NOT scaled to any particular total -- just a natural, realistic recipe). See the units rule above for how quantity/unit must be expressed -- it applies to every ingredient, no exceptions. "method" on an ingredient is a short prep note (e.g. "diced", "melted"), or null if none.
- Each process's "method_steps": one array entry per distinct preparation step, in order.
- Each process's "wastes": see the rule below.

${buildWasteRule(existingWasteTypeNames)}

Each item carries its own "index" number, may carry a "category" (the menu category this dish was listed under, for context on what kind of dish this is -- e.g. a "Soup" category item should be a soup, an "AM Snack" item should be breakfast/snack-appropriate), and always carries "seafoodAllowed" (see the seafood restriction above -- apply it per item, since one batch can mix items with different flags). Return exactly one recipe entry per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct entries and each needs its own separate recipe. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries -- a genuinely declined item (per the seafood restriction) still needs its own entry, just with "skipReason" set and "processes" empty, not omitted.

Remember: absolutely no nuts, sesame, or their derived ingredients anywhere in your output, per the restriction stated at the top. Per the decomposition rule above, never leave a sub-preparation (dough, batter, filling, etc.) as a standalone placeholder ingredient -- always break it down into its real base ingredients as their own rows. And per the units rule above, every single quantity is in grams ("g") only -- never "ml" or any other unit, even for a liquid, oil, sauce, or count-based ingredient. And per the plain-staple rule above, a bare staple name with no preparation stated means its SIMPLEST standard form (plain "White Rice" is steamed rice, not fried rice or pilaf) -- never assume a fancier preparation the name itself didn't ask for. And per the seafood restriction above, a fish/crab/shrimp-SHAPED dish for a student section still gets zero real seafood ingredients, while a genuinely seafood-based dish for a student section gets skipped entirely, never substituted.

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

  let body: { items?: DishItem[]; existingWasteTypeNames?: string[] };
  try {
    body = await req.json();
  } catch {
    return ok({ success: false, error: "Invalid request body" });
  }

  // Coerced rather than validated-and-rejected: a missing/malformed seafoodAllowed should fail
  // SAFE (treated as false, the restricted default), never fail the whole batch outright, same
  // "unknown means restricted, never permitted" principle main.js's own resolveSectionFromSheetName
  // caller already applies before this ever gets sent.
  const items = Array.isArray(body.items)
    ? body.items.map((it) => ({ ...it, seafoodAllowed: it?.seafoodAllowed === true, separateDressing: it?.separateDressing === true, askRole: it?.askRole === true }))
    : body.items;
  const existingWasteTypeNames = Array.isArray(body.existingWasteTypeNames)
    ? body.existingWasteTypeNames.filter((n): n is string => typeof n === "string")
    : [];
  if (!Array.isArray(items)) {
    return ok({ success: false, error: "Missing items array" });
  }
  if (items.length === 0) {
    return ok({ success: true, data: { recipes: [] } });
  }
  if (items.length > MAX_ITEMS) {
    return ok({ success: false, error: `Too many items to generate (max ${MAX_ITEMS})` });
  }
  for (const it of items) {
    if (it && it.reviewedIngredients != null) {
      const list = it.reviewedIngredients;
      if (!Array.isArray(list) || list.length > 60 || list.some((x) => typeof x !== "string" || !x.trim() || x.length > MAX_NAME_LENGTH)) {
        return ok({ success: false, error: "An item's reviewedIngredients must be a list of up to 60 short ingredient names" });
      }
    }
    if (!it || typeof it.index !== "number" || typeof it.name !== "string" || !it.name.trim()) {
      return ok({ success: false, error: "Every item needs a numeric index and a non-empty name" });
    }
    if (it.name.length > MAX_NAME_LENGTH) {
      return ok({ success: false, error: `An item name exceeds ${MAX_NAME_LENGTH} characters` });
    }
  }

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    // Claude Opus 5.5 with thinking (2026-10-01, the chef's choice: best results, cost no concern). Trialled against
    // Sonnet 5 (thinking off) on September week_04 with the same prompt and payload: more complete and more specific
    // answers (regional dishes, ambiguous names read right) and, for recipes, no false seafood skips (Sonnet skipped a
    // Staff "Fish Fillet" as a student dish). About 3x the cost and 2-3x slower per batch (ingredients: 36 s average,
    // 47 s slowest per 20; recipes: 50 s / 69 s per 8) -- the app's timeouts were raised to match. Opus 5.5 can't turn
    // thinking off, so `thinking` is omitted (adaptive); effort is the control, set to "high" as trialled (its default is
    // "medium"). Streamed, because a 64000-token ceiling (thinking counts toward it) is above what the SDK allows without
    // streaming; finalMessage() gives the same Message a create() call would.
    const response = await client.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      system: NUT_RESTRICTION,
      messages: [
        { role: "user", content: buildPrompt(items, existingWasteTypeNames) },
      ],
      output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA }, effort: "high" },
    }).finalMessage();

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Generation was declined" });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return ok({ success: false, error: `No output returned (stop_reason: ${response.stop_reason})` });
    }

    const data = JSON.parse(textBlock.text);
    if (!Array.isArray(data.recipes)) {
      return ok({ success: false, error: `Malformed output (stop_reason: ${response.stop_reason})` });
    }
    // Deliberately NOT failing the whole batch just because recipes.length !== items.length --
    // same reconcile-by-index, retry-only-the-gaps approach as estimate-calories/
    // suggest-dish-ingredients.
    return ok({ success: true, data });
  } catch (err) {
    console.error("[generate-dish-recipes] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
