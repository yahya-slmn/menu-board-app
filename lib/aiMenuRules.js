// ============================================================
// AI Menu Generator review screen: re-checks a draft against the same menu rules the engine
// (lib/generator.js) schedules by, after the chef has swapped or edited dishes. WARN ONLY
// (confirmed with the chef 2026-09-23): nothing here blocks Approve -- empty slots are the one
// thing that does, and that is decided by the caller, not here. Pure: no DB, no AI.
//
// Input picks are ai_menu_draft_picks rows; attrOf(pick) returns the served dish's attributes
// ({ name, protein_code, sauce_type, carb_type, dish_concept, am_snack_style, is_daily_repeating })
// whether the pick is a draft dish or a catalog item, or null for an empty slot.
// ============================================================
const { SECTION_SLOTS } = require('./generator');

const NO_REPEAT_DAYS = 28;
const MEAT = ['CHICKEN', 'BEEF', 'LAMB', 'FISH'];
const AM_SNACK_STYLE_BY_PATTERN = {
  A: { DAYCARE: 'PASTRY', KG_LP: 'PASTRY', MS_UP: 'COLD_KITCHEN' },
  B: { DAYCARE: 'COLD_KITCHEN', KG_LP: 'COLD_KITCHEN', MS_UP: 'PASTRY' },
};
const STYLE_LABEL = { PASTRY: 'Pastry', COLD_KITCHEN: 'Cold Kitchen' };
const SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff' };

function keyOf(p) {
  return p.draft_dish_id ? `d${p.draft_dish_id}` : p.item_id ? `i${p.item_id}` : null;
}

// Returns [{ section, date, category, message }] sorted by section, date.
function checkDraftRules(picks, attrOf) {
  const notes = [];
  const note = (section, date, category, message) => notes.push({ section, date, category, message });

  const bySectionDate = new Map();
  for (const p of picks) {
    const k = `${p.section_code}|${p.menu_date}`;
    if (!bySectionDate.has(k)) bySectionDate.set(k, []);
    bySectionDate.get(k).push(p);
  }
  const dayPicks = (section, date, category) => (bySectionDate.get(`${section}|${date}`) || [])
    .filter((p) => !category || p.category_code === category)
    .sort((a, b) => a.slot_index - b.slot_index);
  const dates = [...new Set(picks.map((p) => p.menu_date))].sort();

  for (const section of ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF']) {
    dates.forEach((date, dayIndex) => {
      const all = dayPicks(section, date);
      if (!all.length) return;

      for (const [category] of SECTION_SLOTS[section]) {
        const empty = all.filter((p) => p.category_code === category && !keyOf(p)).length;
        if (empty) note(section, date, category, `${empty} empty slot${empty > 1 ? 's' : ''} — Approve needs every slot filled`);
      }

      const attrs = (category) => dayPicks(section, date, category).map((p) => ({ p, a: attrOf(p) })).filter((x) => x.a);
      const distinct = (category, attr, label) => {
        const seen = new Map();
        for (const { a } of attrs(category)) {
          if (!a[attr]) continue;
          if (seen.has(a[attr])) note(section, date, category, `"${seen.get(a[attr])}" and "${a.name}" have the same ${label} (${a[attr]})`);
          else seen.set(a[attr], a.name);
        }
      };

      if (section === 'KG_LP' || section === 'MS_UP') {
        const proteins = attrs('LUNCH_MAIN').map((x) => x.a.protein_code || 'none').sort();
        if (proteins.length === 2 && proteins.join() !== 'BEEF,CHICKEN') {
          note(section, date, 'LUNCH_MAIN', `Lunch Main should be one chicken and one beef dish (now: ${proteins.join(' + ').toLowerCase()})`);
        }
        distinct('LUNCH_MAIN', 'sauce_type', 'sauce style');
        distinct('LUNCH_STARCH', 'carb_type', 'starch type');
        if (section === 'MS_UP') {
          for (const category of ['LUNCH_MAIN', 'LUNCH_STARCH']) {
            const mine = dayPicks('MS_UP', date, category).map(keyOf).sort().join();
            const theirs = dayPicks('KG_LP', date, category).map(keyOf).sort().join();
            if (mine !== theirs) note(section, date, category, `should be identical to KG-LP's ${category === 'LUNCH_MAIN' ? 'Lunch Main' : 'Lunch Starch'}`);
          }
        }
      }

      if (section !== 'STAFF') {
        const pattern = (dayIndex + 1) % 2 === 1 ? 'A' : 'B';
        const want = AM_SNACK_STYLE_BY_PATTERN[pattern][section];
        for (const { a } of attrs('AM_SNACK')) {
          if (a.am_snack_style && a.am_snack_style !== want) {
            note(section, date, 'AM_SNACK', `AM Snack should be ${STYLE_LABEL[want]} today (Pastry / Cold Kitchen rotation); "${a.name}" is ${STYLE_LABEL[a.am_snack_style]}`);
          }
        }
      }

      if (section === 'STAFF') {
        const bf = attrs('STAFF_BREAKFAST');
        if (bf.length && !bf.some((x) => x.a.protein_code === 'VEGETARIAN')) note(section, date, 'STAFF_BREAKFAST', 'Staff Breakfast has no vegetarian dish');
        // Staff's own breakfast dishes must each have a different concept from every other one;
        // two SHARED school AM Snacks may coincide (the engine allows that).
        const used = new Map();
        for (const { p, a } of bf.filter((x) => x.p.source_section_code)) if (a.dish_concept) used.set(a.dish_concept, a.name);
        for (const { a } of bf.filter((x) => !x.p.source_section_code)) {
          if (!a.dish_concept) continue;
          if (used.has(a.dish_concept)) note(section, date, 'STAFF_BREAKFAST', `"${used.get(a.dish_concept)}" and "${a.name}" have the same breakfast type (${a.dish_concept})`);
          else used.set(a.dish_concept, a.name);
        }
        const main = attrs('STAFF_MAIN');
        if (main.length && !main.some((x) => x.a.protein_code === 'VEGETARIAN')) note(section, date, 'STAFF_MAIN', 'Staff Main has no vegetarian dish');
        const box = attrs('STAFF_LUNCHBOX').map((x) => x.a.protein_code);
        if (box.length === 2 && !(box.includes('VEGETARIAN') && box.some((c) => MEAT.includes(c)))) {
          note(section, date, 'STAFF_LUNCHBOX', 'Lunch Box should be one meat or fish dish and one vegetarian dish');
        }
        // The shared dishes Staff must carry.
        const staffMain = new Set(dayPicks('STAFF', date, 'STAFF_MAIN').map(keyOf));
        for (const src of ['KG_LP', 'DAYCARE']) {
          for (const p of dayPicks(src, date, 'LUNCH_MAIN')) {
            if (keyOf(p) && !staffMain.has(keyOf(p))) note(section, date, 'STAFF_MAIN', `Staff Main is missing ${SECTION_LABEL[src]}'s Lunch Main "${attrOf(p)?.name}"`);
          }
        }
        const staffBf = new Set(dayPicks('STAFF', date, 'STAFF_BREAKFAST').map(keyOf));
        for (const src of ['DAYCARE', 'KG_LP', 'MS_UP']) {
          for (const p of dayPicks(src, date, 'AM_SNACK')) {
            if (keyOf(p) && !staffBf.has(keyOf(p))) note(section, date, 'STAFF_BREAKFAST', `Staff Breakfast is missing ${SECTION_LABEL[src]}'s AM Snack "${attrOf(p)?.name}"`);
          }
        }
      }
    });

    // Repeats inside the run, per section (served history before the run was already checked at
    // generation time). Daily-repeating catalog items (milk, bread) are meant to repeat.
    const lastSeen = new Map();
    for (const date of dates) {
      for (const p of dayPicks(section, date)) {
        const k = keyOf(p);
        const a = k && attrOf(p);
        if (!a || a.is_daily_repeating) continue;
        const prev = lastSeen.get(k);
        if (prev && prev !== date) {
          const gap = Math.round((new Date(date) - new Date(prev)) / 86400000);
          if (gap < NO_REPEAT_DAYS) note(section, date, p.category_code, `"${a.name}" is served again after only ${gap} days (rule: ${NO_REPEAT_DAYS})`);
        }
        lastSeen.set(k, date);
      }
    }
  }

  // The same dish twice on one day (the repeat check above only compares different dates).
  for (const [k, list] of bySectionDate) {
    const seen = new Map();
    for (const p of list) {
      const key = keyOf(p);
      if (!key) continue;
      const a = attrOf(p);
      if (seen.has(key) && !a?.is_daily_repeating) {
        const [section, date] = k.split('|');
        note(section, date, p.category_code, `"${a?.name}" appears twice on the same day`);
      }
      seen.set(key, true);
    }
  }

  const order = { DAYCARE: 0, KG_LP: 1, MS_UP: 2, STAFF: 3 };
  return notes.sort((a, b) => (order[a.section] - order[b.section]) || a.date.localeCompare(b.date));
}

module.exports = { checkDraftRules };
