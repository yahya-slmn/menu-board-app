// Supabase Edge Function: suggest-dish-ingredients
//
// Same trust boundary/shape as estimate-calories and estimate-am-snack-style: holds the
// Anthropic API key server-side, index-tagged batch in/out for the same reason those two are
// (Haiku doesn't reliably preserve exact 1:1 correspondence over a batch of many short,
// structurally similar items -- see estimate-calories' own header comment for the full
// reasoning, unchanged here).
//
// Backs the Menu Ingredients Generator screen: given a batch of dish names (deduplicated by the
// caller -- main.js's parse-and-suggest-menu-ingredients), suggests a plausible ingredient list
// for each as a single dash-separated string (e.g. "zucchini - red onions - shallots - olive
// oil - butter - salt"), a starting point she reviews/edits before exporting -- not a precise
// recipe (no quantities), since no actual recipe is available for most catalog dishes. Also
// returns a per-dish allergens string in the same call (see ALLERGEN_RULE below) -- deliberately
// NOT a separate Edge Function, since the allergens are derived from the ingredients list this
// same call just produced, which is both cheaper (one Anthropic call instead of two per batch)
// and more accurate than guessing allergens from the dish name alone in isolation.
//
// Prompt v2 (2026-10-01, Menu Ingredients -> Recipe Generator pipeline Phase C): each item also carries its menu
// context (category, section, meal period, seafoodAllowed); lists are COMPLETE, not "concise"; a recognised regional
// dish follows its well-established recipe and says so in "basis"; the mild (no chili), halal and per-item seafood
// rules join the nut rule. The app applies all four rules again in code (lib/menuIngredientFilters.js). An item with
// only index + name (an older app build) gets no seafood rule and a general answer, as before.
//
// Deploy: see the project README / deployment notes for the exact `supabase` CLI steps.
// Requires the ANTHROPIC_API_KEY secret to be set (`supabase secrets set ANTHROPIC_API_KEY=...`).

import Anthropic from "npm:@anthropic-ai/sdk";
import { requireUser } from "../_shared/requireUser.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// Caller batches at 50 items per call (main.js) -- this is a safety ceiling above that, not the
// intended batch size, same relationship MAX_ITEMS has to estimate-calories' own usage.
const MAX_ITEMS = 150;
const MAX_NAME_LENGTH = 200;

interface DishItem {
  index: number;
  name: string;
  // Context from the menu row (lib/menuIngredientsRequest.js), all optional: an older app sends name only.
  category?: string;
  section?: string;
  period?: string;
  // false = a dish students eat (no seafood); true = adults only; absent = not said (older app): no seafood rule.
  seafoodAllowed?: boolean;
}

// v2.1 (2026-10-01, after the first trial): each ingredient once; forbidden ingredients never named, not even as
// "-free"; more placeholder words; composite dishes listed fully; the category says what kind of dish it is.
// v2.2 (2026-10-01, confirmed with the chef): a real seafood dish on a student menu is listed with its REAL ingredients
// -- the app's seafood filter removes them with a visible note, so the menu mistake shows -- never with an invented
// substitute protein (the trial turned "Tuna Sandwich" into chickpeas with no warning). Only a fish-SHAPED dish gets
// its real non-seafood ingredients. Same principle as the Recipe Generator, which skips and flags such a dish.
const PROMPT_VERSION = "mi-v2.2-2026-10-01";

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          ingredients: { type: "string" },
          allergens: { type: "string" },
          // See REGIONAL_RULE: what the list is based on.
          basis: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["regional", "general"] },
              dish: { anyOf: [{ type: "string" }, { type: "null" }] },
              cuisine: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["kind", "dish", "cuisine"],
            additionalProperties: false,
          },
        },
        required: ["index", "ingredients", "allergens", "basis"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
};

// Also enforced in the same wording as SYSTEM_PROMPT below (belt-and-suspenders -- a system
// prompt is generally weighted more heavily by the model, but repeating the constraint inline,
// right next to the formatting rules it has to satisfy at the same time, costs nothing and
// guards against exactly the kind of instruction the model might otherwise treat as lower
// priority than the surrounding task description). This is still only half the safety story --
// see lib/nutFilter.js for the mandatory post-processing scan every suggestion goes through
// regardless of how well the model followed this. Sesame/tahini carry the exact same "never
// present" severity as nuts here -- NOT a lesser "flag it as an allergen" treatment, which is why
// ALLERGEN_VOCAB below no longer lists sesame at all (same reasoning nuts were never in that list).
const NUT_RESTRICTION = `CRITICAL DIETARY RESTRICTION -- this school strictly prohibits ALL nuts, sesame, and their derived ingredients, with zero exceptions. Never include any tree nut (almond, cashew, walnut, pistachio, hazelnut, pecan, macadamia, pine nut, brazil nut, chestnut, etc.), peanut, sesame in any form (sesame seeds, sesame oil, tahini/sesame paste, halva, za'atar, benne, gomashio, etc.), or nut/sesame-derived product (nut butter, nut milk, nut oil, marzipan, praline, nutella, nougat, etc.) in ANY suggested ingredient list -- even if the dish traditionally or typically includes one. If a dish's most natural ingredients would normally include a nut or sesame product, substitute a safe alternative that fits the dish (e.g. sunflower seed butter instead of peanut butter, or instead of tahini in a dish like hummus; extra olive oil and lemon juice instead of tahini; a plain breadcrumb or herb crust instead of a sesame crust; a sesame-free herb blend -- thyme, sumac, oregano -- instead of za'atar) or simply omit that component -- never include the nut or sesame itself. Treat this with the same seriousness as an allergy-critical instruction, because it is one.`;

// The model's laziest failure mode: naming a sub-preparation itself ("dough", "filling", "sauce")
// as if it were an ingredient, instead of decomposing it into what it's actually made of. Broken
// out as its own constant (same reasoning as NUT_RESTRICTION above) with matched before/after
// examples inline -- concrete examples anchor this kind of behavioral instruction far more
// reliably than the abstract rule alone.
//
// Bread specifically is now a BLANKET never-decompose rule, not a "carrier vs. focus" split. An
// earlier version of this rule only carved out the carrier case (sandwich/burger bread), while
// still telling the model to decompose bread when it was framed as the dish's own "preparation
// focus" -- and its own example list for that focus case literally included "a loaf of bread"
// alongside pizza dough and cake. That was still wrong: a standalone bread dish ("Bread with
// Butter", "Toast with Butter", a plain baguette on its own) has no protein/filling to carry, so
// under the old wording it fell into the "focus -> decompose" bucket instead, defeating the whole
// point -- decomposing "toast" into flour/yeast/salt/sugar/milk is exactly as useless to a chef
// reviewing a bread-and-butter dish as it was for a sandwich. Bread is bread regardless of context:
// whether it IS the entire dish, carries a simple topping, or carries a protein/filling, nobody
// bakes it from scratch to serve it, so decomposing it always just produces noise she has to
// delete. The one real distinction that still matters is bread vs. a DIFFERENT baked good made
// from a similar starting point (pizza, pie/tart, cake, muffin, pancake, waffle, crepe, danish,
// croissant) -- those are unaffected by this rule and keep decomposing exactly as before, since
// there the dough/batter itself IS the thing being prepared, not a loaf/baguette/bun eaten as bread.
const DECOMPOSITION_RULE = `Never name a non-bread sub-preparation (batter, crust, breading, filling, glaze, frosting, marinade, etc.) as an ingredient by itself -- always decompose it into the real base ingredients it is made from (flour, sugar, butter, eggs, yeast, milk, salt, oil, etc.), even when it's only part of a larger dish. A sub-preparation name is a placeholder, not an ingredient, and must never appear in your output. Exception: a simple, single-purpose condiment/sauce that is commonly used and sourced as one finished product (ketchup, mustard, soy sauce, mayonnaise, plain tomato/pizza sauce) may still be named as itself -- only decompose a sauce or filling further if it's itself a multi-component preparation specific to this dish (a curry sauce, gravy, or fruit pie filling), the same way "batter" must be decomposed.

BREAD ITSELF (a loaf, baguette, ciabatta, pita, tortilla, toast, bun, roll, samoli, or any other plain bread product) is a permanent exception to the rule above -- it is NEVER decomposed into baking components (flour, yeast, sugar, salt, oil, milk, etc.), in ANY context, no matter how the dish is framed:
- Not when bread IS the entire dish or its main event ("Bread with Butter", "Toast with Butter", a plain baguette served on its own).
- Not when bread carries a simple topping (butter, jam, cheese) with nothing else going on.
- Not when bread is just a carrier alongside a protein or filling (a sandwich, burger, wrap, slider, hot dog).
Always name the specific real bread type as a single, real, editable ingredient instead (e.g. "toast", "baguette", "ciabatta", "brown bread", "burger bun", "pita bread", "samoli", "flour tortilla") -- never its baking components, regardless of which of the three cases above it is.

This bread exception does NOT extend to a batter/dough-based preparation that becomes a DIFFERENT, distinctly-named baked good through real transformation -- pizza, pie/tart, cake, muffins, pancakes, waffles, crepes, danish, and croissant are not "bread" for this purpose, even though they start from a similar ingredient list. For those, the dough/batter itself IS the dish being prepared (not a loaf of bread being eaten as-is), so it keeps decomposing into its real base ingredients exactly like any other sub-preparation. Rule of thumb: if you'd hand someone "a piece of bread" or "a bread roll" to eat as-is or build a sandwich with, never decompose it -- just name the bread type. If it has its own distinct name as a baked good/pastry (pizza, pie, cake, muffin, pancake, waffle, crepe, danish, croissant), decompose its dough/batter as usual.

Example -- WRONG (uses a sub-preparation as a placeholder):
"Pizza" -> "dough - tomato sauce - mozzarella cheese"
Example -- RIGHT (dough IS the preparation here -- pizza is not "bread" for this rule -- so it's decomposed into its real base ingredients; tomato sauce and mozzarella cheese are themselves finished ingredients, not further sub-preparations, so they stay as-is):
"Pizza" -> "all-purpose flour - sugar - salt - butter - milk - yeast - olive oil - tomato sauce - mozzarella cheese"

Example -- WRONG (filling left as a placeholder):
"Apple Pie" -> "pie crust - apple filling"
Example -- RIGHT (a pie is not "bread" either -- both crust and filling are decomposed into real base ingredients):
"Apple Pie" -> "all-purpose flour - butter - salt - apples - sugar - cinnamon - cornstarch - lemon juice"

Example -- WRONG (bread IS the whole dish here, and it's still been decomposed into baking components -- exactly the mistake this rule exists to prevent):
"Toast with Butter" -> "all-purpose flour - yeast - salt - sugar - milk - butter"
Example -- RIGHT (the bread is named as a real, editable ingredient, same as any other standalone bread dish):
"Toast with Butter" -> "toast - butter"

Example -- RIGHT (bread with no topping at all is still just named as itself -- there's nothing else to list):
"Baguette" -> "baguette"

Example -- WRONG (the bread is just a carrier here, not a distinct baked good -- the dish is still "grilled chicken" without it -- so decomposing it into baking components is unwanted noise):
"Grilled Chicken Sandwich" -> "chicken breast - all-purpose flour - yeast - salt - sugar - olive oil - lettuce - tomato - mayonnaise"
Example -- RIGHT (the bread is named as a real, editable ingredient instead):
"Grilled Chicken Sandwich" -> "chicken breast - brown bread - lettuce - tomato - mayonnaise"

Example -- RIGHT (same carrier logic for a burger bun; the patty is the dish's focus, not the bun):
"Beef Burger" -> "ground beef - burger bun - lettuce - tomato - onion - ketchup - mustard"

Example -- RIGHT (a coating/breading is NOT bread, so it still decomposes normally, even though the sandwich's own bread stays as one ingredient right next to it):
"Fried Chicken Sandwich" -> "chicken breast - all-purpose flour - eggs - breadcrumbs - salt - pepper - brown bread - lettuce - mayonnaise"`;

// The model's other common failure mode on multi-component dishes: dropping a component the dish
// name itself calls out (most often the protein) while still faithfully listing the rest, e.g.
// "Lamb with Green Beans and Carrots" coming back as just "green beans - carrots - olive oil -
// salt" with the lamb silently missing. Kept as its own constant/example, same reasoning as the
// other two rules above.
const COMPLETENESS_RULE = `Every distinct food component explicitly named in the dish's own name must be represented somewhere in its ingredient list -- do not silently drop one, especially the protein (meat, poultry, fish, egg, legume, etc.) in a dish named "[protein] with [sides]". Check your own output against the dish name before finalizing: if the name says "Lamb with Green Beans and Carrots", the word "lamb" (or a specific lamb cut/cook, e.g. "lamb stew meat") must appear in the ingredients -- not just the green beans and carrots.

Example -- WRONG (the named protein, lamb, is missing entirely):
"Lamb with Green Beans and Carrots" -> "green beans - carrots - olive oil - garlic - salt - pepper"
Example -- RIGHT (every component named in the dish -- lamb, green beans, carrots -- is represented):
"Lamb with Green Beans and Carrots" -> "lamb - green beans - carrots - olive oil - garlic - salt - pepper"`;

// v2: the old prompt asked for "main ingredients", "reasonably concise -- typically 5 to 14", which the chef found
// too simplified. A list a kitchen can cook from names every real component.
const COMPLETE_LIST_RULE = `List the COMPLETE ingredients of the dish -- everything a cook would actually put in it, not just the main components: the main ingredients, every fat or oil, every liquid (water, stock, milk, cream), every aromatic (onion, garlic, ginger), every herb and spice, the seasonings (salt, black pepper), any sauce's own components (per the decomposition rule), and the garnish. There is no upper limit. A dish with more than one component (a marinade and a sauce, a filling and a dough, a stuffed or layered dish, a main with its rice) must list every component's ingredients: such a dish naturally runs to 15-25 ingredients, and a list of 8-10 for it is too short. Name EACH ingredient ONCE, even when two components both use it (garlic in the marinade and in the sauce is "garlic", once). A ready-made spice blend sold and used as one product (seven spices, baharat, kabsa spice, garam masala, curry powder) is ONE ingredient, named as itself. Do not pad the list with things the dish would not contain.`;

// v2: the model guessed generic versions of well-known regional dishes. Asking it to CLASSIFY first, in a field the
// chef sees ("Regional: Kabsa (Saudi)"), keeps "use the real recipe" concrete and checkable.
const REGIONAL_RULE = `First decide what the dish is, and report it in "basis":
- If the name is a recognised REGIONAL dish -- Middle Eastern, Levantine, Gulf, Egyptian, Turkish, Persian, North African, or another clearly named cuisine (kabsa, mandi, maqluba, mujaddara, fattoush, tabbouleh, molokhia, freekeh, shish tawook, kibbeh, koshari, kofta, mansaf, shakshuka...) -- set "basis" to {"kind": "regional", "dish": the dish's usual name, "cuisine": its cuisine (e.g. "Saudi", "Levantine", "Egyptian")}, and list the ingredients of the version most commonly cooked in homes and restaurants of that cuisine, with its standard core ingredients named precisely (e.g. dried black lime / loomi, freekeh, sumac, akkawi cheese, seven spices) -- not a westernised or generic version.
- Otherwise (a general or international dish -- pasta, a sandwich, a roast, a salad with no regional name) set "basis" to {"kind": "general", "dish": null, "cuisine": null} and list a standard version.
The school's rules always win over tradition: drop or substitute anything they forbid (nuts, sesame, chili, pork, alcohol), even when the traditional recipe has it. Seafood follows its own rule below.

Examples:
"Chicken Kabsa" -> basis {"kind": "regional", "dish": "Kabsa", "cuisine": "Saudi"}; ingredients "chicken - basmati rice - onion - tomatoes - tomato paste - garlic - carrot - dried black lime - kabsa spice - cinnamon stick - cardamom pods - bay leaves - vegetable oil - chicken stock - salt - black pepper - raisins" (no chili; no almond or nut garnish).
"Mujaddara" -> basis {"kind": "regional", "dish": "Mujaddara", "cuisine": "Levantine"}; ingredients "brown lentils - long-grain rice - onions - olive oil - cumin - salt - black pepper - water".
"Fattoush" -> basis {"kind": "regional", "dish": "Fattoush", "cuisine": "Levantine"}; ingredients "romaine lettuce - tomatoes - cucumbers - radishes - green onions - parsley - mint - pita bread - sumac - olive oil - lemon juice - garlic - pomegranate molasses - dried mint - salt".
"Maqluba" -> basis {"kind": "regional", "dish": "Maqluba", "cuisine": "Palestinian"}; ingredients "chicken - long-grain rice - eggplant - cauliflower - potatoes - tomatoes - onion - garlic - seven spices - turmeric - cinnamon - vegetable oil - chicken stock - salt - black pepper" (the traditional toasted nut garnish is left out).
"Chicken Alfredo" -> basis {"kind": "general", "dish": null, "cuisine": null}; ingredients "fettuccine - chicken breast - butter - garlic - heavy cream - parmesan cheese - milk - olive oil - parsley - salt - black pepper".`;

// v2.1: the first trial wrote "sesame-free seed garnish (sunflower seeds)" and "pine-free breadcrumb topping" -- the
// app's filters then remove the whole substitute (the word "sesame" is in it). Never naming them avoids that.
const FORBIDDEN_WORDING_RULE = `Never write the name of a forbidden ingredient at all -- not even to say it is absent or replaced: no "sesame-free", "nut-free", "pine-free", "pine-shaped", "tahini-free", "alcohol-free", "pork-free", "chili-free", "without nuts". Just name the safe ingredient you use instead ("sunflower seeds", "breadcrumbs", "sunflower seed butter").`;

// Same wording as generate-menu-dishes' MILD_RULE (the school-wide no-spicy rule), plus the Middle Eastern chilies
// lib/spicyFilter.js added 2026-10-01.
const MILD_RULE = `MILD FOOD ONLY -- no spicy or hot food for anyone, adults included. Never use chili in any form (fresh, flakes, powder, sweet chili sauce), Aleppo pepper, pul biber, urfa biber (isot), hot pepper paste (biber salcasi), jalapeno, habanero, cayenne, chipotle, sriracha, harissa, gochujang, sambal, shatta, zhug, peri-peri, buffalo sauce, cajun or jerk seasoning, crushed red pepper, hot sauce, hot paprika, vindaloo or madras curry. Warm, aromatic, non-hot seasonings are welcome: cumin, coriander, sweet or smoked paprika, cinnamon, cardamom, baharat, seven spices, black pepper.`;

// Same as generate-menu-dishes' HALAL_RULE (first paragraph).
const HALAL_RULE = `HALAL ONLY -- every dish: no pork or pork products (pork, ham, bacon, lard, pancetta, prosciutto) and no alcohol in any form, including cooking wine, beer, rum, sherry, marsala, mirin, sake or liqueur. Use vinegar such as apple cider vinegar, never wine vinegar; gelatin must be halal gelatin (or agar). Never mention pork or alcohol at all, not even to say it is absent.`;

// Per item, like generate-dish-recipes' seafoodAllowed: only an item that says false is restricted.
const SEAFOOD_RULE = `An item may carry "seafoodAllowed". When it is false (a dish students eat):
- A dish that only has a fish or seafood SHAPE or name for fun (a fish-shaped sandwich, "crab" cut-outs, a fish-shaped pancake) contains no seafood: give its real, non-seafood ingredients.
- A dish that IS a seafood dish (tuna sandwich, shrimp pasta, grilled salmon, fish fingers) is a menu-planning mistake for a student menu. Do NOT turn it into a different dish: never replace the fish or seafood with another protein (no chicken, chickpeas, tofu or anything else in its place). List its real ingredients exactly as you would for adults, seafood included -- the app removes the seafood itself and shows the chef a warning, so the mistake is seen and fixed on the menu.
When "seafoodAllowed" is true, or absent, there is no seafood restriction: list the dish's real ingredients.`;

// v2: the dish's place on the menu tells the model what kind of dish it is ("Pumpkin & Red Beans" as a lunch main
// vs a side; "Cheese Croissant" as a breakfast item).
const CONTEXT_RULE = `Each item may also carry where it is served: "category" (the menu category or item label, e.g. "Lunch Main Course", "AM Snack", "Main Dish", "Option 1"), "section" (who eats it: Daycare = toddlers, KG-LP and MS-UP = school children, Staff and CEO = adults) and "period" (Breakfast, Lunch, Lunch Box). Use them to understand what kind of dish this is and how it is served -- not as ingredients. The category settles an ambiguous name: under a Soup category, "Oats Soup" is a soup (a savoury broth with oats), not porridge; under a Lunch Main, a dish is a full main course.`;

// Allergens are derived from the SAME decomposed ingredient list buildPrompt() asks for above
// (that's why this is one call, not a separate Edge Function -- see index.ts's header comment)
// rather than guessed independently from the dish name, which is both cheaper and more accurate:
// the model already knows, in this same turn, that it just wrote "all-purpose flour" and
// "mozzarella cheese" into the ingredients string, so reading gluten/dairy back off of that is a
// much more grounded inference than a second blind guess would be. Closed vocabulary (not
// freeform) so the output stays consistent and filterable across dishes -- the FDA "big 9" minus
// the two nut categories AND sesame, all three of which NUT_RESTRICTION already forbids as
// ingredients and which must ALSO never appear here as a flagged allergen (a dish can't
// truthfully claim to contain a nut or sesame that was never allowed into its ingredient list in
// the first place). Sesame IS technically one of the FDA's "big 9" allergens and would normally
// belong in this vocabulary the same way gluten/dairy/soy do -- it's deliberately excluded here
// because this school's policy treats it like a nut (never present at all), not like a
// still-permitted allergen that just needs flagging.
const ALLERGEN_VOCAB = ["egg", "gluten", "dairy", "soy", "shellfish", "fish"];
const ALLERGEN_RULE = `For each dish, also identify which common allergens it contains, based ONLY on the ingredients you actually listed for it (e.g. "all-purpose flour" -> gluten, "milk"/"butter"/"mozzarella cheese" -> dairy, "egg" -> egg, "soy sauce" -> soy). Choose ONLY from this fixed list, using these exact lowercase words: ${ALLERGEN_VOCAB.join(", ")}. Format as a SINGLE string of the applicable allergen words (from that list only) separated by " - ", ordered in the same order as the list above, e.g. "gluten - dairy - egg" for a dish containing flour, butter, and egg. If none of these allergens apply, return an empty string. Do not invent allergen categories outside this list, and do not explain your reasoning -- just the dash-separated word list.

CRITICAL: nuts, peanuts, and sesame are NEVER a valid entry here, under any circumstance -- they are not even in the list above. Never write "nut", "nuts", "tree nut", "peanut", "sesame", "tahini", or any variant as an allergen, even if you think the dish traditionally contains one; per the restriction at the top of this prompt, a nut or sesame product should never have been in the ingredients list to begin with, so there is nothing to flag.

Example (matches the Pizza example above):
"Pizza" ingredients "all-purpose flour - sugar - salt - butter - milk - yeast - olive oil - tomato sauce - mozzarella cheese" -> allergens "gluten - dairy"`;

function buildPrompt(items: DishItem[]): string {
  return `${NUT_RESTRICTION}

${MILD_RULE}

${HALAL_RULE}

${FORBIDDEN_WORDING_RULE}

For each school / staff cafeteria dish below, give its ingredients, based on general culinary knowledge of the dish (no recipe or quantities are provided or expected).

${CONTEXT_RULE}

${SEAFOOD_RULE}

${REGIONAL_RULE}

${COMPLETE_LIST_RULE}

${DECOMPOSITION_RULE}

${COMPLETENESS_RULE}

Format each dish's ingredients as a SINGLE string of ingredient names separated by " - " (space, hyphen, space), all lowercase, no quantities/measurements/units, no "and" before the last item, ordered roughly by prominence (main ingredients first, seasonings/garnish last).

${ALLERGEN_RULE}

Each item carries its own "index" number. Return exactly one entry per item, each carrying that SAME index number back -- even if two items have identical or very similar names, they are distinct entries and each needs its own separate suggestion. Every index from 0 to ${items.length - 1} must appear exactly once in your output; do not merge, skip, duplicate, or invent entries.

Remember: no nuts, sesame or their derivatives anywhere (neither as an ingredient nor as an allergen), and never their names, not even as "-free"; nothing spicy or hot; nothing that is not halal. Where "seafoodAllowed" is false, a fish-SHAPED dish has no seafood, and a real seafood dish keeps its real ingredients -- never a substitute protein. Never leave a sub-preparation as a placeholder ingredient -- "dough", "flatbread dough", "batter", "breading", "filling", "patties", "topping", "marinade", "sauce" for a sauce made in the dish -- break it down into what it is made of, and never decompose bread itself. Each ingredient once. Every component named in the dish's title, protein included, must appear. List the COMPLETE ingredients, and set "basis" for every item.

Items (JSON array): ${JSON.stringify(items)}`;
}

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Signed-in users only, before anything else (see _shared/requireUser.ts).
  const denied = await requireUser(req);
  if (denied) return denied;
  if (req.method !== "POST") {
    return ok({ success: false, error: "Method not allowed" });
  }
  if (!ANTHROPIC_API_KEY) {
    return ok({ success: false, error: "Server misconfigured: ANTHROPIC_API_KEY not set" });
  }

  let body: { items?: DishItem[] };
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
    return ok({ success: false, error: `Too many items to suggest (max ${MAX_ITEMS})` });
  }
  for (const it of items) {
    for (const key of ["category", "section", "period"] as const) {
      if (it && it[key] != null && (typeof it[key] !== "string" || it[key]!.length > MAX_NAME_LENGTH)) {
        return ok({ success: false, error: `An item's ${key} must be a short string` });
      }
    }
    if (it && it.seafoodAllowed != null && typeof it.seafoodAllowed !== "boolean") {
      return ok({ success: false, error: "An item's seafoodAllowed must be true or false" });
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
      // A system prompt (unique to this function -- no other Edge Function here uses one) is
      // weighted more heavily by the model than the same instruction inline in the user message,
      // which is exactly what a hard safety constraint like this needs. Repeated inline in
      // buildPrompt() too, right next to the formatting rules -- see NUT_RESTRICTION's own
      // comment for why both places carry it.
      system: `${NUT_RESTRICTION}\n\n${MILD_RULE}\n\n${HALAL_RULE}\n\n${FORBIDDEN_WORDING_RULE}`,
      messages: [
        { role: "user", content: buildPrompt(items) },
      ],
      output_config: { format: { type: "json_schema", schema: SUGGEST_SCHEMA }, effort: "high" },
    }).finalMessage();

    if (response.stop_reason === "refusal") {
      return ok({ success: false, error: "Suggestion was declined" });
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
    // same reconcile-by-index, retry-only-the-gaps approach as estimate-calories/
    // estimate-am-snack-style.
    return ok({ success: true, data: { ...data, prompt_version: PROMPT_VERSION } });
  } catch (err) {
    console.error("[suggest-dish-ingredients] failed:", err);
    return ok({ success: false, error: String((err as Error)?.message || err) });
  }
});
