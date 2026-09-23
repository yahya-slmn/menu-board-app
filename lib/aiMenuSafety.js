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

function knownRiskOf(name) {
  return KNOWN_RISK_DISHES.filter((k) => k.re.test(name || ''));
}

// dish: { name, description?, key_ingredients: string[], section_codes: string[], protein_code? }.
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
    const what = { seafood: 'seafood (student section)', halal: 'not halal', nut_sesame: 'nut/sesame' }[h.rule];
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

module.exports = { checkDishSafety, safetyScanRecord, KNOWN_RISK_DISHES };
