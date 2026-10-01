// ============================================================
// Menu Ingredients Generator: the school's hard rules, applied in CODE to every AI ingredient suggestion
// (2026-10-01, Phase C) -- the prompt asks for them too, but an instruction is never a guarantee. Each rule
// removes the " - " segments it matches, and every removal is reported per row (segment + policy), never
// silently dropped, so a chef can put a term back when she knows the dish is fine.
//   1. nut / sesame (lib/nutFilter.js)  -- every dish, as before
//   2. spicy / chili (lib/spicyFilter.js, the one list the AI Menu Generator uses too)
//   3. halal (lib/halalFilter.js)       -- no pork, no alcohol
//   4. seafood (lib/seafoodFilter.js)   -- only for a dish served to students (seafoodAllowed false)
// Allergens: nut / sesame words are removed from them too (as before); for a student dish "fish" /
// "shellfish" go as well, since no seafood can be in its ingredients any more.
// Two clean-ups run first (v2.1, 2026-10-01, from the prompt trial):
//   - a forbidden word only NAMED AS ABSENT ("sesame-free seed garnish (sunflower seeds)", "nut-free butter",
//     "without pork") loses just that wording -- the rule above would otherwise remove the whole segment and with it
//     the very substitute the model chose. Only for words the school's rules forbid: "gluten-free pasta" is kept.
//   - an ingredient listed twice (a marinade and a sauce both with garlic) is kept once, ignoring case.
//   - a COMMENT written as if it were an ingredient ("sesame seeds omitted", "pine-free pine substitute omitted") is
//     dropped; "tahini replaced with sunflower seed butter" keeps just the replacement.
// Pure: no AI, no database.
// ============================================================
const { matchNutTerms } = require('./nutFilter');
const { matchSpicyTerms } = require('./spicyFilter');
const { matchHalalTerms } = require('./halalFilter');
const { matchSeafoodTerms } = require('./seafoodFilter');

const POLICY_LABELS = { nut: 'nut policy', spicy: 'no-spicy policy', halal: 'halal policy', seafood: 'no seafood for students' };
const SEAFOOD_ALLERGENS = new Set(['fish', 'shellfish']);

const ALL_MATCHERS = [matchNutTerms, matchSpicyTerms, matchHalalTerms, matchSeafoodTerms];
const isForbidden = (words) => ALL_MATCHERS.some((m) => m(words).length > 0);
// "pine" / "brazil" alone aren't forbidden words, "pine nut" / "brazil nut" are: their "-free" wording is a nut mention.
const NUT_FIRST_WORDS = new Set(['pine', 'brazil']);
// "<x>-free", "<x> free", "free of <x>", "without <x>", "no <x>" where <x> (one or two words) is forbidden.
const NEGATED_RES = [
  /\b([\p{L}']+(?:\s[\p{L}']+)?)\s*-\s*free\b/giu,
  /\b([\p{L}']+)\s+free\b/giu,
  /\b(?:free\s+of|without|no)\s+([\p{L}']+(?:\s[\p{L}']+)?)/giu,
];
// -> { text, stripped: [phrase] }: the segment without its negated forbidden mentions, tidied.
function stripNegatedMentions(segment) {
  let text = segment;
  const stripped = [];
  for (const re of NEGATED_RES) {
    text = text.replace(re, (whole, words) => {
      // Try the two-word capture, then its last word alone ("toasted sesame-free" -> "sesame"). A nut named by a
      // first word that means nothing alone counts too ("pine-free herb garnish": seen in the final trial).
      const last = words.split(/\s+/).pop();
      if (![words, last].some(isForbidden) && !NUT_FIRST_WORDS.has(last.toLowerCase())) return whole;
      stripped.push(whole.trim());
      return ' ';
    });
  }
  text = text.replace(/\(\s*\)/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();
  return { text, stripped };
}

// A comment, not an ingredient -> { text: what to keep ('' = drop it), note } or null when it is a plain ingredient.
const REPLACED_RE = /^(.+?)\s+(?:replaced|substituted|swapped)\s+(?:with|by|for)\s+(.+)$/i;
const COMMENT_RE = /\b(omitted|removed|excluded|left out|not included|no substitute)\b/i;
function commentaryOf(segment) {
  const replaced = segment.match(REPLACED_RE);
  if (replaced) return { text: replaced[2].trim(), note: segment };
  if (COMMENT_RE.test(segment)) return { text: '', note: segment };
  return null;
}

// The same ingredient twice ("garlic" in the marinade and in the sauce): kept once, first place, ignoring case.
function dedupeSegments(segments) {
  const seen = new Set();
  const kept = [];
  const duplicates = [];
  for (const seg of segments) {
    const key = seg.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) { duplicates.push(seg); continue; }
    seen.add(key);
    kept.push(seg);
  }
  return { kept, duplicates };
}

function policiesFor(seafoodAllowed) {
  const list = [['nut', matchNutTerms], ['spicy', matchSpicyTerms], ['halal', matchHalalTerms]];
  if (!seafoodAllowed) list.push(['seafood', matchSeafoodTerms]);
  return list;
}

// Splits on " - ", drops every segment a policy matches (first matching policy named), keeps the order of the rest.
// With { tidy: true } (ingredients): negated forbidden mentions are stripped first and repeats dropped; what was
// tidied is returned as `negations` / `duplicates`.
function filterSegments(text, policies, { tidy = false } = {}) {
  let segments = String(text || '').split(' - ').map((s) => s.trim()).filter(Boolean);
  const negations = [];
  const comments = [];
  let duplicates = [];
  if (tidy) {
    segments = segments.map((seg) => {
      const comment = commentaryOf(seg);
      if (comment) { comments.push(comment.note); seg = comment.text; }
      const { text: t, stripped } = stripNegatedMentions(seg);
      negations.push(...stripped);
      return t;
    }).filter(Boolean);
    ({ kept: segments, duplicates } = dedupeSegments(segments));
  }
  const kept = [];
  const removed = [];
  for (const segment of segments) {
    let hit = null;
    for (const [policy, match] of policies) {
      const terms = match(segment);
      if (terms.length) { hit = { segment, policy, terms }; break; }
    }
    if (hit) removed.push(hit); else kept.push(segment);
  }
  return { cleaned: kept.join(' - '), removed, negations, duplicates, comments };
}

// One dish's suggestion -> { ingredients, allergens, removed: [{ segment, policy, terms }], removedAllergens: [...] }.
function filterMenuIngredients({ ingredients, allergens }, { seafoodAllowed = false } = {}) {
  const ing = filterSegments(ingredients, policiesFor(seafoodAllowed), { tidy: true });
  const allergenPolicies = [['nut', matchNutTerms]];
  if (!seafoodAllowed) allergenPolicies.push(['seafood', (s) => (SEAFOOD_ALLERGENS.has(s.toLowerCase()) ? [s.toLowerCase()] : [])]);
  const all = filterSegments(allergens, allergenPolicies);
  return {
    ingredients: ing.cleaned, allergens: all.cleaned, removed: ing.removed, removedAllergens: all.removed,
    tidied: { negations: ing.negations, duplicates: ing.duplicates, comments: ing.comments },
  };
}

module.exports = { filterMenuIngredients, filterSegments, stripNegatedMentions, dedupeSegments, commentaryOf, POLICY_LABELS };
