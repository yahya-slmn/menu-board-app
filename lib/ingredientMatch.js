// ============================================================
// Ingredient name map (unification phase U2, 2026-10-03) -- the pure part. ONE ingredients master list
// (public.ingredients, the company's purchasing list) is what recipes link to; recipes use kitchen names ("olive oil"),
// the master uses purchasing names ("Oil Olive"). A name links ONLY by exact match -- case and spacing aside -- to a
// master name or to a spelling the chef mapped once (ingredient_aliases, migration 20261003110000). Everything else is
// unresolved and goes to her review. Candidates are SUGGESTIONS for that review, never a link: nothing here picks one.
// Used by the Name map tab now, and by U4 (generated recipes -> Recipe Book) and U5 (Extractor) later.
// ============================================================
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Spellings of ONE word, decided together: case, punctuation and singular / plural aside ("egg" / "Eggs" / "egg's").
const singular = (w) => (w.length > 3 && /ies$/.test(w) ? w.slice(0, -3) + 'y' : w.length > 3 && /(ches|shes|sses|xes|oes)$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const words = (s) => nameKey(s).replace(/['’]/g, '').replace(/[^a-z0-9À-ɏ؀-ۿ]+/g, ' ').trim().split(' ').filter(Boolean);
const spellingKey = (s) => words(s).map(singular).join(' ');

// Words that describe a form or state rather than the product, used only to RANK candidates (never to link).
const DESCRIPTORS = new Set(['fresh', 'chopped', 'minced', 'ground', 'dried', 'dry', 'raw', 'frozen', 'whole', 'large', 'small', 'medium', 'sliced',
  'diced', 'grated', 'shredded', 'boneless', 'skinless', 'peeled', 'cooked', 'canned', 'can', 'plain', 'natural', 'organic', 'extra', 'virgin', 'fine',
  'powder', 'powdered', 'crushed', 'unsalted', 'salted', 'low', 'fat', 'full', 'light', 'pure', 'of', 'the', 'and', 'with', 'in', 'veg', 'frt', 'spice']);

// master: [{ id, name, ... }]; aliases: [{ name_key, ingredient_id, decision }]. -> resolve(name):
//   { ingredientId, via: 'exact' } | { ingredientId, via: 'alias' } | { perRecipe: true } | null (unresolved)
function buildResolver({ master, aliases = [] }) {
  const exact = new Map();
  for (const m of master) if (!exact.has(nameKey(m.name))) exact.set(nameKey(m.name), m.id);
  const alias = new Map(aliases.map((a) => [a.name_key, a]));
  return (name) => {
    const k = nameKey(name);
    if (!k) return null;
    if (exact.has(k)) return { ingredientId: exact.get(k), via: 'exact' };
    const a = alias.get(k);
    if (!a) return null;
    return a.decision === 'per_recipe' ? { perRecipe: true } : { ingredientId: a.ingredient_id, via: 'alias' };
  };
}

// Every master product worth showing for a name, best first -- ALL of them returned (the screen shows the first few and
// filters the rest). Tiers: 1 = every word of the name is in the product (singular / plural aside); 2 = every word except
// descriptor words; 3 = at least one non-descriptor word. Within a tier: more shared words first, then shorter names.
function candidatesFor(name, master) {
  const want = words(name).map(singular);
  const core = want.filter((w) => !DESCRIPTORS.has(w));
  if (!want.length) return [];
  const out = [];
  for (const m of master) {
    const have = new Set(words(m.name).map(singular));
    const shared = want.filter((w) => have.has(w)).length;
    const coreShared = core.filter((w) => have.has(w)).length;
    let tier = 0;
    if (shared === want.length) tier = 1;
    else if (core.length && coreShared === core.length) tier = 2;
    else if (coreShared > 0) tier = 3;
    if (tier) out.push({ m, tier, shared, len: words(m.name).length });
  }
  out.sort((a, b) => a.tier - b.tier || b.shared - a.shared || a.len - b.len || a.m.name.localeCompare(b.m.name));
  return out.map(({ m, tier }) => ({ ...m, tier }));
}

// usages: [{ name, recipe }] -- one per ingredient ROW of a recipe (generated / extracted). -> the review queue: one group
// per word (spellingKey), its spellings with their row counts, a few recipe names as examples, sorted most-used first;
// plus the coverage of ALL rows (resolved rows / total).
function buildQueue({ usages, master, aliases = [] }) {
  const resolve = buildResolver({ master, aliases });
  const groups = new Map();
  let resolvedRows = 0;
  for (const u of usages) {
    const k = nameKey(u.name);
    if (!k) continue;
    if (resolve(u.name)) { resolvedRows++; continue; }
    const g = spellingKey(u.name) || k;
    if (!groups.has(g)) groups.set(g, { key: g, rows: 0, spellings: new Map(), examples: [] });
    const grp = groups.get(g);
    grp.rows++;
    if (!grp.spellings.has(k)) grp.spellings.set(k, { name: String(u.name).trim(), rows: 0 });
    grp.spellings.get(k).rows++;
    if (u.recipe && grp.examples.length < 4 && !grp.examples.includes(u.recipe)) grp.examples.push(u.recipe);
  }
  const queue = [...groups.values()]
    .map((g) => ({ key: g.key, rows: g.rows, examples: g.examples, spellings: [...g.spellings.values()].sort((a, b) => b.rows - a.rows) }))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
  const totalRows = usages.filter((u) => nameKey(u.name)).length;
  return { queue, totalRows, resolvedRows, coverage: totalRows ? resolvedRows / totalRows : 1 };
}

// Master rows that are the same product written twice: names equal once punctuation / singular-plural (tier "spelling")
// or word order (tier "order") are set aside. Descriptor differences (Full Fat / Low Fat) are NEVER suggested.
function suggestMerges(master) {
  const bySpelling = new Map();
  const byOrder = new Map();
  for (const m of master) {
    const s = spellingKey(m.name);
    const o = s.split(' ').sort().join(' ');
    if (!bySpelling.has(s)) bySpelling.set(s, []);
    bySpelling.get(s).push(m);
    if (!byOrder.has(o)) byOrder.set(o, []);
    byOrder.get(o).push(m);
  }
  const out = [];
  const seen = new Set();
  const add = (list, why) => {
    if (list.length < 2) return;
    const ids = list.map((m) => m.id).sort((a, b) => a - b).join(',');
    if (seen.has(ids)) return;
    seen.add(ids);
    out.push({ why, items: [...list].sort((a, b) => a.id - b.id) });
  };
  for (const list of bySpelling.values()) add(list, 'spelling');
  for (const list of byOrder.values()) add(list, 'word order');
  return out;
}

module.exports = { nameKey, spellingKey, buildResolver, candidatesFor, buildQueue, suggestMerges };
