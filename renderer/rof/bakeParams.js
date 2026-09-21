// Best-effort reading of an oven temperature and a bake time out of a recipe's method text. The text is free-form
// (English, Arabic, or a mix), so this only suggests: the Bake panel pre-fills what it finds and the chef confirms.
// Pure, no DOM. A wrong guess is worse than no guess, so anything ambiguous returns null for that field.

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const normalize = (s) => String(s || '')
  .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d])
  .replace(/[–—‒−]/g, '-')
  .replace(/[º˚]/g, '°')
  .replace(/٫/g, '.');

// Words that say "this sentence is about the oven" (English and Arabic), so a rest / proof time is not read as a bake time.
const OVEN_WORDS = /\b(bake|baked|baking|oven|preheat|pre-heat|roast|until golden)\b|فرن|اخبز|خبز|سخن|حمص|تحمير/i;

const UNIT_C = /(?:°\s*c\b|°c\b|\bcelsius\b|\bcentigrade\b|مئوية|°\s*م\b)/i;
const UNIT_F = /(?:°\s*f\b|°f\b|\bfahrenheit\b|فهرنهايت)/i;

// Sentences (or lines) of the method; the oven ones come first.
function chunks(text) {
  return normalize(text).split(/[\n\r]+|(?<=[.!?؟؛;])\s+/).map(s => s.trim()).filter(Boolean);
}

function readTemperature(chunk) {
  // 180°C, 180 °C, 180 C, 180 degrees C, 180 degrees Celsius, 350°F, 180° (unit unstated)
  const re = /(\d{2,3})(?:\.\d+)?\s*(?:°|degrees?|deg\.?|درجة)?\s*(c|f|celsius|fahrenheit|centigrade|مئوية|فهرنهايت)?(?![a-z\d])/gi;
  let m;
  while ((m = re.exec(chunk))) {
    const value = Number(m[1]);
    const after = chunk.slice(m.index, m.index + m[0].length + 14);
    const hasDegree = /°|degrees?|deg\b|درجة/i.test(m[0]);
    let unit = null;
    const u = (m[2] || '').toLowerCase();
    if (u === 'c' || u === 'celsius' || u === 'centigrade' || u === 'مئوية') unit = 'C';
    else if (u === 'f' || u === 'fahrenheit' || u === 'فهرنهايت') unit = 'F';
    else if (UNIT_C.test(after)) unit = 'C';
    else if (UNIT_F.test(after)) unit = 'F';
    if (!unit) {
      // "180°" with no letter after it: only a degree sign or the word "degrees" makes it a temperature.
      if (!hasDegree) continue;
      unit = value > 260 ? 'F' : 'C';
      if (!(value >= 80 && value <= 300) && !(value >= 175 && value <= 575)) continue;
      return { value: String(value), unit, guessedUnit: true };
    }
    if (unit === 'C' && (value < 80 || value > 300)) continue;
    if (unit === 'F' && (value < 175 || value > 575)) continue;
    return { value: String(value), unit, guessedUnit: false };
  }
  return null;
}

function readTime(chunk) {
  const range = /(\d{1,3}(?:\.\d+)?)\s*(?:-|to|الى|إلى)\s*(\d{1,3}(?:\.\d+)?)\s*(min(?:ute)?s?\b|mins?\b|دقيقة|دقائق|د\b|hours?\b|hrs?\b|h\b|ساعة|ساعات)/i;
  const single = /(\d{1,3}(?:\.\d+)?)\s*(min(?:ute)?s?\b|mins?\b|دقيقة|دقائق|د\b|hours?\b|hrs?\b|h\b|ساعة|ساعات)/i;
  const isHours = (u) => /^(h|hr|hrs|hour|hours|ساعة|ساعات)/i.test(u);
  const num = (n, hrs) => String(Math.round(n * (hrs ? 60 : 1) * 10) / 10);   // always minutes
  let m = chunk.match(range);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), hrs = isHours(m[3]);
    if (a <= 0 || b <= a) return null;
    return { value: `${num(a, hrs)}–${num(b, hrs)}`, unit: 'min' };
  }
  m = chunk.match(single);
  if (m) {
    const a = Number(m[1]);
    if (a <= 0) return null;
    return { value: num(a, isHours(m[2])), unit: 'min' };
  }
  return null;
}

// -> { temp: { value, unit: 'C'|'F', guessedUnit }|null, time: { value, unit: 'min' }|null, snippet }   (time is always in minutes; hours are converted)
// `snippet` is the sentence the suggestion came from, so the panel can show the chef what it read.
export function parseBakeParams(text) {
  const all = chunks(text);
  const oven = all.filter(c => OVEN_WORDS.test(c));
  let temp = null, time = null;
  const used = [];
  const use = (c) => { if (!used.includes(c)) used.push(c); };
  for (const c of oven) {
    if (!temp) { const t = readTemperature(c); if (t) { temp = t; use(c); } }
    if (!time) { const t = readTime(c); if (t) { time = t; use(c); } }
    if (temp && time) break;
  }
  // A sentence that only has a temperature ("Preheat to 180°C.") may sit next to the sentence that has the time
  // ("Bake for 20 minutes."): the loop above already reads across oven sentences. A temperature written with a
  // clear unit but without an oven word nearby is still accepted; a time without one never is (a rest or proof time).
  if (!temp) for (const c of all) { const t = readTemperature(c); if (t && !t.guessedUnit) { temp = t; use(c); break; } }
  const snippet = used.join(' ');
  return { temp, time, snippet: snippet.length > 160 ? snippet.slice(0, 157) + '…' : snippet };
}

// "20–25" + "min" -> "20–25 min"
export const formatBakeTime = (value, unit = 'min') => (value ? `${value} ${unit}` : '');
export const formatBakeTemp = (value, unit = 'C') => (value ? `${value} °${unit}` : '');
