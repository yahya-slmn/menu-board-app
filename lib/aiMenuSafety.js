// ============================================================
// AI Menu Generator: the mandatory code-level safety check every AI dish goes through, at generate
// time (lib/aiMenuGenerate.js), on every chef edit and again on Approve. The prompt asks for the
// same things (supabase/functions/generate-menu-dishes), but a prompt is not a guarantee -- this
// is. A dish that fails is rejected and reported with the exact terms that matched; there is no
// override (confirmed with the chef 2026-09-23).
//
// - Nut / sesame: everyone, always. The dish NAME uses matchNutTermsInDishName (za'atar allowed in
//   a name only -- the kitchen makes it with thyme / sumac / oregano); the description and every
//   key ingredient use the full list, so an ingredient that says "za'atar" or "tahini" still blocks.
// - Seafood: only when the dish is available to a student section (Daycare / KG-LP / MS-UP),
//   checked on the name, description and ingredients, plus the FISH protein code itself.
// - Halal: everyone, always (lib/halalFilter.js -- no pork or pork products, no alcohol), on the
//   name, description and every key ingredient.
// - This feature's own exclusions (confirmed with the school 2026-09-23), all sections, all fields:
//   processed meats banned OUTRIGHT (BANNED_MEATS: no "beef"/"halal" qualifier exception -- that is
//   deliberately stricter than lib/halalFilter.js, which other features use and which stays as it
//   is), and no spicy / heat-forward framing (SPICY_TERMS; aromatic, non-heat spice words such as
//   cumin, paprika, baharat, cinnamon, black pepper or plain "spices" are allowed).
// - Chicken and beef are for lunch only: never in AM Snack or PM Snack, whether the protein type
//   says so or the name / description / an ingredient does ("beef bacon", "chicken ham").
//   Turkey, lamb, egg, dairy and vegetarian snacks stay allowed (confirmed 2026-09-24). The same rule
//   (lib/categoryRules.js) also keeps catalog snacks with chicken / beef off every new menu.
// - Category rules (CATEGORY_RULES): Daycare's Lunch Salad is cooked / baked vegetable sticks, never
//   a puree or mash and never raw carrot / celery (toddler choking risk); PM Snack is never manakish
//   (that is AM Snack's); Daycare's PM Snack has no hard pretzels (choking risk).
// - Known-risk dishes (hummus, pesto, baklava...) pass only when their key ingredients list a real
//   substitute; the review screen then shows a code-generated "Made nut/sesame-free (kitchen
//   standard)" label for them (knownRisk below), never AI-written text.
// ============================================================
const { matchNutTerms, matchNutTermsInDishName } = require('./nutFilter');
const { matchSeafoodTerms } = require('./seafoodFilter');
const { matchHalalTerms } = require('./halalFilter');
const { isStudentSection } = require('./recipeGenerator');

// `substitute` must match at least one key ingredient: the ingredient that replaces the nut/sesame
// component is what makes the dish safe, so it has to be written down.
const KNOWN_RISK_DISHES = [
  { label: 'hummus', re: /\bhumm?[ou]s\b/i, substitute: /sunflower|yogh?urt|labneh|olive oil|lemon/i },
  { label: 'mutabbal', re: /\bmut[ae]bb?al\b|\bmoutabal\b/i, substitute: /sunflower|yogh?urt|labneh|olive oil|lemon/i },
  { label: 'baba ghanoush', re: /\bbaba\s*gh?an[ou]{1,2}sh\b|\bbaba\s*ganoush\b/i, substitute: /sunflower|yogh?urt|labneh|olive oil|lemon/i },
  { label: 'tarator', re: /\btarator\b/i, substitute: /sunflower|yogh?urt|labneh|olive oil|lemon|garlic/i },
  { label: 'muhammara', re: /\bmuhamm?ara\b/i, substitute: /breadcrumb|sunflower|pumpkin seed|oat|roasted (red )?pepper/i },
  { label: 'pesto', re: /\bpesto\b/i, substitute: /sunflower|pumpkin seed|breadcrumb|parmesan|olive oil/i },
  { label: 'baklava', re: /\bbaklawa\b|\bbaklava\b/i, substitute: /\bdates?\b|coconut|\boats?\b|semolina|raisin|cornflake/i },
  { label: 'dukkah', re: /\bdukk?ah\b|\bduqqa\b/i, substitute: /sunflower|pumpkin seed|chickpea|coriander|cumin/i },
  { label: "za'atar", re: /\bza'?atar\b/i, substitute: /thyme|sumac|oregano/i },
];

// Outright bans for this feature, whatever meat or "halal" is named in front of them.
const BANNED_MEATS = [
  { label: 'pepperoni', re: /\bpepperonis?\b/i },
  { label: 'sausage', re: /\bsausages?\b/i },
  { label: 'hot dog', re: /\bhot[\s-]*dogs?\b/i },
  { label: 'frankfurter', re: /\bfrankfurters?\b/i },
  { label: 'wiener', re: /\bwieners?\b/i },
  { label: 'salami', re: /\bsalamis?\b/i },
  { label: 'chorizo', re: /\bchorizos?\b/i },
];

// Heat-forward words. Whole-word matches, so "chilled" / "spices" / "hot chocolate" never match; the
// one real look-alike that is not heat (buffalo mozzarella) is excluded in its own regex.
const SPICY_TERMS = [
  { label: 'spicy', re: /\bspic(y|ier|iest|iness)\b/i },
  { label: 'spiced', re: /\bspiced\b/i },
  { label: 'spice rub', re: /\bspice[\s-]*rub(bed)?\b/i },
  { label: 'fiery', re: /\bfiery\b/i },
  { label: 'hot (heat)', re: /\bhot\s+(sauces?|wings?|honey|peppers?|chil(i|li|e)s?|paprika|curr(y|ies)|salsa|mustard)\b/i },
  { label: 'chili', re: /\bchil(i|li|e)s?\b/i },
  { label: 'jalapeño', re: /\bjalape(n|ñ)os?\b/i },
  { label: 'habanero', re: /\bhabaneros?\b/i },
  { label: 'cayenne', re: /\bcayenne\b/i },
  { label: 'chipotle', re: /\bchipotles?\b/i },
  { label: 'sriracha', re: /\bsriracha\b/i },
  { label: 'harissa', re: /\bharissa\b/i },
  { label: 'gochujang', re: /\bgochujang\b/i },
  { label: 'sambal', re: /\bsambal\b/i },
  { label: 'shatta', re: /\bshatta\b/i },
  { label: 'zhug', re: /\b(zhug|zhoug|schug|skhug)\b/i },
  { label: 'peri-peri', re: /\b(peri[\s-]*peri|piri[\s-]*piri)\b/i },
  { label: 'buffalo', re: /\bbuffalo\b(?!\s*mozzarella)/i },
  { label: 'cajun', re: /\bcajun\b/i },
  { label: 'jerk', re: /\bjerk\b/i },
  { label: 'red pepper flakes', re: /\bcrushed\s+red\s+peppers?\b|\bred\s+pepper\s+flakes\b|\bpepper\s+flakes\b/i },
  { label: 'vindaloo', re: /\bvindaloo\b/i },
  { label: 'madras', re: /\bmadras\b/i },
];

// Chicken / beef in a snack: one definition for every dish in the app (lib/categoryRules.js).
const { LUNCH_ONLY_PROTEINS, LUNCH_ONLY_WORDS, SNACK_LUNCH_ONLY_WHY } = require('./categoryRules');

const COOKED = /\b(steamed|baked|roasted|cooked|boiled|blanched|grilled|poached|braised|oven)\b/i;
const MANAKISH = /\b(manakish|manaqish|manakeesh|manaeesh|man'?oushe?h?|mana'?eesh|mnaish|mana'?ish)\b/i;

// [{ applies(dish), check(texts) -> [hit] }] -- texts: { name, description, ingredients[] }.
const CATEGORY_RULES = [
  {
    applies: (d) => d.category_code === 'LUNCH_SALAD',
    check: ({ name, description, ingredients }) => {
      const hits = [];
      for (const [field, text] of [['name', name], ['description', description]]) {
        const m = text.match(/\b(pur(e|é)e[sd]?|mash(ed|es)?|smooth|blended)\b/i);
        if (m) hits.push({ rule: 'category', field, text, terms: [m[0].toLowerCase()], why: 'Daycare Lunch Salad must be vegetable sticks or fingers, not a puree or mash' });
      }
      const all = [name, description, ...ingredients];
      const raw = all.find((t) => /\braw\s+(carrots?|celery)\b/i.test(t));
      if (raw) hits.push({ rule: 'category', field: 'key_ingredients', text: raw, terms: ['raw carrot/celery'], why: 'no raw carrot or celery for toddlers (choking risk) — steam or bake them' });
      else if (all.some((t) => /\b(carrots?|celery)\b/i.test(t)) && !COOKED.test(`${name} ${description} ${ingredients.join(' ')}`)) {
        hits.push({ rule: 'category', field: 'description', text: 'carrot / celery', terms: ['uncooked carrot/celery'], why: 'carrot or celery for toddlers must be steamed or baked — say so in the name or description' });
      }
      return hits;
    },
  },
  {
    applies: (d) => d.category_code === 'AM_SNACK' || d.category_code === 'PM_SNACK',
    check: ({ name, description, ingredients, dish }) => {
      const hits = [];
      const why = SNACK_LUNCH_ONLY_WHY;
      if (LUNCH_ONLY_PROTEINS.includes(dish.protein_code)) hits.push({ rule: 'category', field: 'protein_code', text: dish.protein_code, terms: [dish.protein_code.toLowerCase()], why });
      for (const [field, text] of [['name', name], ['description', description], ...ingredients.map((i) => ['key_ingredients', i])]) {
        const m = text.match(LUNCH_ONLY_WORDS);
        if (m) hits.push({ rule: 'category', field, text, terms: [m[0].toLowerCase()], why });
      }
      return hits;
    },
  },
  {
    applies: (d) => d.category_code === 'PM_SNACK',
    check: ({ name, description, ingredients }) => {
      const hits = [];
      for (const [field, text] of [['name', name], ['description', description], ...ingredients.map((i) => ['key_ingredients', i])]) {
        const m = text.match(MANAKISH);
        if (m) hits.push({ rule: 'category', field, text, terms: [m[0].toLowerCase()], why: 'manakish is for AM Snack only, never PM Snack' });
      }
      return hits;
    },
  },
  {
    applies: (d) => d.category_code === 'PM_SNACK' && (d.section_codes || []).includes('DAYCARE'),
    check: ({ name, description, ingredients }) => {
      const all = [name, description, ...ingredients].join(' ');
      if (/\bpretzels?\b/i.test(all) && !/\bsoft\b/i.test(all)) {
        return [{ rule: 'category', field: 'name', text: name, terms: ['pretzel'], why: 'Daycare PM Snack must be soft — only soft pretzel bites, no hard pretzels (choking risk)' }];
      }
      return [];
    },
  },
];

function matchTerms(list, text) {
  if (!text) return [];
  return list.filter((t) => t.re.test(text)).map((t) => t.label);
}

function knownRiskOf(name) {
  return KNOWN_RISK_DISHES.filter((k) => k.re.test(name || ''));
}

// dish: { name, description?, key_ingredients: string[], section_codes: string[], category_code, protein_code? }.
// category_code is required for the category rules; every caller passes it.
// Returns { ok, hits: [{ field, text, terms, rule }], knownRisk: [labels], reason } -- `hits` is
// every match found (not just the first), so the chef sees the full picture in one go.
function checkDishSafety(dish) {
  const hits = [];
  const name = (dish.name || '').trim();
  const description = (dish.description || '').trim();
  const ingredients = (dish.key_ingredients || []).map((s) => String(s || '').trim()).filter(Boolean);
  const student = (dish.section_codes || []).some(isStudentSection);

  const nameNut = matchNutTermsInDishName(name);
  if (nameNut.length) hits.push({ rule: 'nut_sesame', field: 'name', text: name, terms: nameNut });
  const descNut = matchNutTerms(description);
  if (descNut.length) hits.push({ rule: 'nut_sesame', field: 'description', text: description, terms: descNut });
  for (const ing of ingredients) {
    const t = matchNutTerms(ing);
    if (t.length) hits.push({ rule: 'nut_sesame', field: 'key_ingredients', text: ing, terms: t });
  }

  for (const [field, text] of [['name', name], ['description', description], ...ingredients.map((i) => ['key_ingredients', i])]) {
    const t = matchHalalTerms(text);
    if (t.length) hits.push({ rule: 'halal', field, text, terms: t });
  }

  const allFields = [['name', name], ['description', description], ...ingredients.map((i) => ['key_ingredients', i])];
  for (const [field, text] of allFields) {
    const meat = matchTerms(BANNED_MEATS, text);
    if (meat.length) hits.push({ rule: 'banned_meat', field, text, terms: meat });
    const hot = matchTerms(SPICY_TERMS, text);
    if (hot.length) hits.push({ rule: 'spicy', field, text, terms: hot });
  }
  for (const r of CATEGORY_RULES) {
    if (r.applies(dish)) hits.push(...r.check({ name, description, ingredients, dish }));
  }

  if (student) {
    for (const [field, text] of [['name', name], ['description', description], ...ingredients.map((i) => ['key_ingredients', i])]) {
      const t = matchSeafoodTerms(text);
      if (t.length) hits.push({ rule: 'seafood', field, text, terms: t });
    }
    if (dish.protein_code === 'FISH') hits.push({ rule: 'seafood', field: 'protein_code', text: 'FISH', terms: ['fish (protein type)'] });
  }

  if (!ingredients.length) hits.push({ rule: 'ingredients_required', field: 'key_ingredients', text: '', terms: [] });

  const knownRisk = knownRiskOf(name);
  for (const k of knownRisk) {
    if (!ingredients.some((ing) => k.substitute.test(ing))) {
      hits.push({ rule: 'substitute_required', field: 'key_ingredients', text: k.label, terms: [k.label] });
    }
  }

  return {
    ok: hits.length === 0,
    hits,
    knownRisk: knownRisk.map((k) => k.label),
    reason: hits.length ? describeHits(hits) : null,
  };
}

function describeHits(hits) {
  return hits.map((h) => {
    if (h.rule === 'ingredients_required') return 'no key ingredients listed';
    if (h.rule === 'substitute_required') return `${h.text} must list its nut/sesame-free substitute in the key ingredients`;
    if (h.rule === 'category') return `${h.why} ("${h.text}")`;
    const what = { seafood: 'seafood (student section)', halal: 'not halal', nut_sesame: 'nut/sesame', banned_meat: 'not served (processed meat)', spicy: 'no spicy dishes' }[h.rule];
    return `${what} in ${h.field.replace('_', ' ')} "${h.text}": ${h.terms.join(', ')}`;
  }).join('; ');
}

// What gets stored in ai_menu_draft_dishes.safety_scan for a dish that passed: enough to show, and
// later re-verify, what was checked against what.
function safetyScanRecord(dish, result) {
  return {
    checked_at: new Date().toISOString(),
    name: dish.name,
    key_ingredients: dish.key_ingredients,
    seafood_checked: (dish.section_codes || []).some(isStudentSection),
    known_risk: result.knownRisk,
    ok: result.ok,
  };
}

module.exports = { checkDishSafety, safetyScanRecord, KNOWN_RISK_DISHES, BANNED_MEATS, SPICY_TERMS };
