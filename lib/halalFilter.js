// ============================================================
// Halal policy (confirmed with the school 2026-09-23): no pork or pork products and no alcohol in
// any form, for EVERY section (unlike seafood, which is student-only). Same two layers as
// nutFilter.js: the AI Menu Generator's prompt says it, and this list is the mandatory code check
// behind it (lib/aiMenuSafety.js). A dish that matches is rejected outright and reported, never
// cleaned up.
//
// Same discipline as NUT_TERMS: whole-word matching ("hamburger", "hammour", "kale", "ginger",
// "rump" never match), and the false-positive-is-cheaper rule for ambiguous items. Two kinds of
// exception, both written into the regex so the reason is visible next to the term:
//   - Processed meats sold in halal form here ("turkey ham", "beef pepperoni", "chicken sausage",
//     "halal gelatin") pass ONLY when the animal (or "halal") is named right before the word. A bare
//     "pepperoni" or "sausage" is where pork hides, so it blocks; the prompt tells the AI to always
//     name the meat.
//   - Soft drinks and vinegar that merely share a word: "root beer", "ginger beer", "ginger ale",
//     "cider vinegar", "bourbon vanilla".
// ============================================================
const HALAL_MEAT = '(?:beef|chicken|turkey|veal|lamb|mutton|halal)';
const halalPrefixed = (word) => new RegExp(`(?<!\\b${HALAL_MEAT}[\\s-])\\b${word}\\b`, 'i');

const HALAL_TERMS = [
  // -- pork and pork products --
  { label: 'pork', re: /\bpork\b/i },
  { label: 'pig', re: /\bpig(s|let|lets)?\b/i },
  { label: 'swine', re: /\bswine\b/i },
  { label: 'boar', re: /\bboar\b/i },
  { label: 'lard', re: /\blard\b/i },
  { label: 'bacon', re: halalPrefixed('bacon') },
  { label: 'ham', re: halalPrefixed('hams?') },
  { label: 'pancetta', re: /\bpancetta\b/i },
  { label: 'prosciutto', re: /\bprosciutto\b/i },
  { label: 'guanciale', re: /\bguanciale\b/i },
  { label: 'chorizo', re: halalPrefixed('chorizos?') },
  { label: 'salami', re: halalPrefixed('salamis?') },
  { label: 'pepperoni', re: halalPrefixed('pepperonis?') },
  { label: 'sausage', re: halalPrefixed('sausages?') },
  { label: 'hot dog', re: halalPrefixed('hot\\s*dogs?') },
  { label: 'frankfurter', re: halalPrefixed('frankfurters?') },
  { label: 'gelatin', re: halalPrefixed('gelatine?s?') },
  { label: 'marshmallow', re: halalPrefixed('marshmallows?') },
  // -- alcohol --
  { label: 'alcohol', re: /\balcohol(ic)?\b/i },
  { label: 'wine', re: /\bwines?\b/i },
  { label: 'beer', re: /(?<!\b(?:root|ginger)\s)\bbeers?\b/i },
  { label: 'ale', re: /(?<!\bginger\s)\bales?\b/i },
  { label: 'cider', re: /\bciders?\b(?!\s*vinegar)/i },
  { label: 'rum', re: /\brum\b/i },
  { label: 'brandy', re: /\bbrandy\b/i },
  { label: 'cognac', re: /\bcognac\b/i },
  { label: 'whisky', re: /\bwhiske?y\b/i },
  { label: 'bourbon', re: /\bbourbon\b(?!\s*vanilla)/i },
  { label: 'vodka', re: /\bvodka\b/i },
  { label: 'gin', re: /\bgin\b/i },
  { label: 'tequila', re: /\btequila\b/i },
  { label: 'liqueur', re: /\bliqueurs?\b/i },
  { label: 'sherry', re: /\bsherry\b/i },
  { label: 'marsala', re: /\bmarsala\b/i },
  { label: 'champagne', re: /\bchampagne\b/i },
  { label: 'prosecco', re: /\bprosecco\b/i },
  { label: 'sake', re: /\bsake\b/i },
  { label: 'mirin', re: /\bmirin\b/i },
  { label: 'kirsch', re: /\bkirsch\b/i },
  { label: 'coq au vin', re: /\bcoq\s+au\s+vin\b/i },
  { label: 'bourguignon', re: /\bbourguignon(ne)?\b/i },
];

// Same shape as matchNutTerms / matchSeafoodTerms: the matched labels, or [] when clean.
function matchHalalTerms(text) {
  if (!text) return [];
  return HALAL_TERMS.filter((t) => t.re.test(text)).map((t) => t.label);
}

module.exports = { matchHalalTerms, HALAL_TERMS };
