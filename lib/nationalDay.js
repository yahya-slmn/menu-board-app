// ============================================================
// National Day (AI Menu Generator only, confirmed with the school 2026-09-23): every Tuesday, every
// AI-generated category in every section draws from ONE cuisine, cycling through CUISINES and
// looping back to the start.
//
// Calendar-anchored, so a given Tuesday always maps to the same cuisine no matter when or in how
// many batches menus are generated: Tuesdays since ANCHOR_TUESDAY (entry 0), modulo the list
// length. Tuesdays without school still advance the cycle -- that is inherent to anchoring on the
// calendar rather than on school days (a cuisine can be skipped over a holiday).
// ============================================================
const CUISINES = [
  'Saudi', 'Lebanese', 'Armenian', 'Syrian', 'Turkish', 'Emirati', 'Jordanian', 'Egyptian',
  'Moroccan', 'Greek', 'Italian', 'Indian', 'Japanese', 'American', 'Chinese', 'Mexican',
];
const ANCHOR_TUESDAY = '2026-09-01'; // = CUISINES[0]
const DAY_MS = 86400000;

function utcDay(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isTuesday(dateStr) {
  return new Date(utcDay(dateStr)).getUTCDay() === 2;
}

// The cuisine for a school date, or null when it isn't a Tuesday.
function cuisineForDate(dateStr) {
  if (!isTuesday(dateStr)) return null;
  const weeks = Math.round((utcDay(dateStr) - utcDay(ANCHOR_TUESDAY)) / (7 * DAY_MS));
  const i = ((weeks % CUISINES.length) + CUISINES.length) % CUISINES.length;
  return CUISINES[i];
}

module.exports = { CUISINES, ANCHOR_TUESDAY, cuisineForDate, isTuesday };
