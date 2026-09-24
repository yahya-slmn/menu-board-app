// ============================================================
// Dish Catalog "Created By" (menu_items.created_by_label, 20260924140000_menu_items_created_by_label.sql):
// free-text attribution -- "AI", "OLD" (existed before the column was added), a chef's name. It is
// NOT provenance: is_ai_generated / ai_menu_run_id say what the AI Menu Generator made, and nothing
// here ever reads or changes them.
// ============================================================
const { supabase, supaFail } = require('./supabaseClient');

const tidy = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ');

// Trimmed and single-spaced; blank -> null. A value matching one already in use apart from capitals
// ("tetiana" when "Tetiana" exists) takes that spelling, so one person isn't filed under several; a
// genuinely different spelling ("Tatiana") is kept as typed. excludeItemId: the item being edited, so
// fixing the capitals of a label only that item uses isn't undone by matching itself.
async function normalizeCreatedByLabel(raw, excludeItemId = null) {
  const label = tidy(raw);
  if (!label) return null;
  const pattern = label.replace(/[\\%_]/g, (c) => `\\${c}`);
  let q = supabase.from('menu_items').select('created_by_label').ilike('created_by_label', pattern);
  if (excludeItemId != null) q = q.neq('id', excludeItemId);
  const { data, error } = await q.order('id').limit(1);
  if (error) throw supaFail('normalizeCreatedByLabel', error);
  return data && data.length ? data[0].created_by_label : label;
}

// Suggestions for the Created By boxes: every label on a catalog item plus `extraNames` (the recipe
// people, Tetiana included), one entry per name regardless of case, sorted. Suggestions only -- the
// boxes stay free text.
async function listCreatedByLabels(extraNames = []) {
  const seen = new Map();
  const add = (raw) => { const n = tidy(raw); if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n); };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('menu_items').select('id, created_by_label').order('id').range(from, from + 999);
    if (error) throw supaFail('listCreatedByLabels', error);
    (data || []).forEach((r) => add(r.created_by_label));
    if (!data || data.length < 1000) break;
  }
  extraNames.forEach(add);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

module.exports = { normalizeCreatedByLabel, listCreatedByLabels };
