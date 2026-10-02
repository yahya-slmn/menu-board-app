// ============================================================
// Master Items + Dish Variants -- the pure migration planner (2026-10-03, design stage; nothing writes with it yet).
// One MASTER ITEM per truly distinct dish (one per exact name, case / spacing aside -- the matching rule used everywhere).
// Under it, one or more DISH VARIANTS: the versions of that dish that really differ (MS-UP's Macaroni & Cheese vs
// Staff's). Each Dish Catalog row (menu_items) USES one variant -- that is the only link (menu_items.dish_variant_id);
// which sections and categories a row serves is untouched (the engine's data). The saved, approved ingredient lists
// (menu_items.ingredients_text, M2) move onto variants:
//   - rows of one name with the SAME list (case / spacing / order aside) share one variant -- one list, no copies;
//   - rows with DIFFERENT lists get one variant per list -- nothing is merged or dropped;
//   - rows WITHOUT a list: join the variant when the name has exactly one; with two or more variants they are left
//     for the chef to pick (never guessed); a name with no lists at all gets one empty variant for all its rows.
// Every saved list lands on exactly one variant, with its text, allergens, who / when / source kept.
// ============================================================
const key = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const listKey = (text, allergens) => `${String(text ?? '').split(' - ').map(key).filter(Boolean).sort().join('|')}||${String(allergens ?? '').split(' - ').map(key).filter(Boolean).sort().join('|')}`;
const hasList = (r) => key(r.ingredients_text) !== '';
const SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff', CEO: 'CEO' };
const SECTION_ORDER = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];

// rows: [{ id, name, category_name, sections: [code], is_active, ingredients_text, allergens_text, ingredients_updated_at,
// ingredients_updated_by, ingredients_source }] -- every Dish Catalog row.
// -> { masters: [{ key, name, variants: [{ label, list, rowIds }], unassigned: [rowId] }], stats }
function planMasterItems(rows) {
  const byName = new Map();
  for (const r of rows) {
    const k = key(r.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const where = (rs) => {
    const secs = SECTION_ORDER.filter((s) => rs.some((r) => (r.sections || []).includes(s)));
    const cats = [...new Set(rs.map((r) => r.category_name).filter(Boolean))];
    return `${secs.map((s) => SECTION_LABEL[s]).join(', ') || 'no section'} · ${cats.join(', ')}`;
  };
  const masters = [];
  for (const [k, rs] of byName) {
    const sorted = [...rs].sort((a, b) => a.id - b.id);
    const withList = sorted.filter(hasList);
    const groups = new Map();
    for (const r of withList) {
      const lk = listKey(r.ingredients_text, r.allergens_text);
      if (!groups.has(lk)) groups.set(lk, []);
      groups.get(lk).push(r);
    }
    const variants = [...groups.values()].map((g) => {
      // The list carried over: the most recently saved of the identical ones (same content; its who / when kept).
      const src = [...g].sort((a, b) => String(b.ingredients_updated_at || '').localeCompare(String(a.ingredients_updated_at || '')))[0];
      return { label: where(g), date: src.ingredients_updated_at || null, list: { ingredients: src.ingredients_text, allergens: src.allergens_text || null, updatedAt: src.ingredients_updated_at || null,
        updatedBy: src.ingredients_updated_by || null, source: src.ingredients_source || null, fromRowIds: g.map((r) => r.id) }, rowIds: g.map((r) => r.id) };
    });
    const without = sorted.filter((r) => !hasList(r));
    let unassigned = [];
    if (!variants.length) variants.push({ label: where(sorted), date: null, list: null, rowIds: sorted.map((r) => r.id) });
    else if (variants.length === 1) {
      variants[0].rowIds.push(...without.map((r) => r.id));
      variants[0].label = where(sorted.filter((r) => variants[0].rowIds.includes(r.id))); // every row using it
    } else unassigned = without.map((r) => r.id);
    masters.push({ key: k, name: sorted[0].name, rowCount: sorted.length, variants, unassigned });
  }
  // Each variant's sections: those of every catalog row using it (what its display name shows).
  const byIdAll = new Map(rows.map((r) => [r.id, r]));
  for (const m of masters) for (const v of m.variants) v.sections = SECTION_ORDER.filter((sec) => v.rowIds.some((rid) => (byIdAll.get(rid)?.sections || []).includes(sec)));
  masters.sort((a, b) => a.name.localeCompare(b.name));
  const lists = rows.filter(hasList).length;
  const carried = masters.reduce((n, m) => n + m.variants.reduce((x, v) => x + (v.list ? v.list.fromRowIds.length : 0), 0), 0);
  return {
    masters,
    stats: {
      rows: rows.length, masters: masters.length,
      variants: masters.reduce((n, m) => n + m.variants.length, 0),
      mastersWithSeveralVariants: masters.filter((m) => m.variants.length > 1).length,
      listsSaved: lists, listsCarried: carried,
      variantsWithList: masters.reduce((n, m) => n + m.variants.filter((v) => v.list).length, 0),
      rowsJoiningAListedVariant: masters.reduce((n, m) => n + (m.variants.length === 1 && m.variants[0].list ? m.variants[0].rowIds.length - m.variants[0].list.fromRowIds.length : 0), 0),
      rowsToPick: masters.reduce((n, m) => n + m.unassigned.length, 0),
    },
  };
}

// A variant's display name (the chef's rule, 2026-10-03): "<section name(s)> — <date>" until a recipe is linked, then the
// recipe's own name. date: when its list was saved, else when the variant was created.
function variantDisplayName({ sections = [], date = null, createdAt = null, recipeName = null }) {
  if (recipeName && String(recipeName).trim()) return String(recipeName).trim();
  const secs = SECTION_ORDER.filter((s) => sections.includes(s)).map((s) => SECTION_LABEL[s]).join(', ') || 'No section';
  const d = date || createdAt;
  const when = d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'no date';
  return `${secs} — ${when}`;
}

module.exports = { planMasterItems, variantDisplayName, listKey };
