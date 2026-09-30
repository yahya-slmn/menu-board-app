// ============================================================
// Misk school-wide rule: no spicy / heat-forward food. The one list of heat words, shared by every
// feature that checks for it -- moved here unchanged from lib/aiMenuSafety.js (2026-09-30) so the
// Menu Ingredients Generator and Recipe Generator can use the SAME list rather than a second,
// drifting copy. The AI Menu Generator still reaches it through aiMenuSafety.js exactly as before.
//
// Heat-forward words. Whole-word matches, so "chilled" / "spices" / "hot chocolate" never match; the
// one real look-alike that is not heat (buffalo mozzarella) is excluded in its own regex. Aromatic,
// non-heat spice words (cumin, paprika, baharat, cinnamon, black pepper, plain "spices") are allowed.
// ============================================================
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

// Labels of every heat term found in `text` (empty when none) -- the same test aiMenuSafety.js runs.
function matchSpicyTerms(text) {
  if (!text) return [];
  return SPICY_TERMS.filter((t) => t.re.test(text)).map((t) => t.label);
}

module.exports = { SPICY_TERMS, matchSpicyTerms };
