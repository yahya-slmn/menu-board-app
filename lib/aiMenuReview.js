// ============================================================
// AI Menu Generator, Phase 3: everything the review screen does to a DRAFT run. Only the three
// ai_menu_* tables are written; the Dish Catalog and saved menus stay untouched until Approve.
//
// - Shared picks are read-only where they are copies: MS-UP's Lunch Main / Starch (copied from
//   KG-LP), KG-LP's AM / PM Snack (copied from Daycare), and Staff's shared Main (KG-LP's Lunch Main + Starch, MS-UP's Lunch Vegetable) and
//   Breakfast (the school AM Snacks). Changing the SOURCE pick updates every copy (propagationTargets), the same way the
//   engine built them.
// - Every dish a chef writes, edits, or accepts from the AI goes through checkDishSafety again
//   (hard block, no override) and the catalog duplicate check (a match LINKS to the catalog item).
// - Menu rules are re-checked after every change but only warn (lib/aiMenuRules.js).
// ============================================================
const { supabase, supaFail } = require('./supabaseClient');
const { eligibleItemsSupabase, snackStyleFor } = require('./generator');
const { getCategoryByCode, getCategoryById, getSectionByCode, getProteinById, getProteinTypes } = require('./referenceData');
const { findDuplicateMatch, emptyDishIndex, addNameToIndex, normalizeDishName } = require('./recipeGenerator');
const { checkDishSafety, safetyScanRecord } = require('./aiMenuSafety');
const { checkDraftRules } = require('./aiMenuRules');
const { generateMenuDishes } = require('./generateMenuDishes');
const { poolSpecs, normalizeAiDish, buildDishRequest, ATTRS, sample } = require('./aiMenuGenerate');
const { cuisineForDate } = require('./nationalDay');
const { STALE_MS } = require('./aiMenuApprove');
const { snackLunchOnlyHit } = require('./categoryRules');

const EDITABLE_TEXT = ['name', 'description', 'key_ingredients'];
const DISH_COLUMNS = 'id, run_id, name, category_code, section_codes, protein_code, sauce_type, carb_type, dish_concept, am_snack_style, description, key_ingredients, safety_scan, dup_match_item_id, dup_match_type, resolution, edited, resolved_item_id, cuisine';
const ITEM_COLUMNS = 'id, name, category_id, is_active, is_daily_repeating, protein_type_id, sauce_type, carb_type, dish_concept, am_snack_style';
// A run left in 'generating' this long has crashed (a normal run takes a few minutes).
const STALE_GENERATING_MS = 30 * 60 * 1000;

async function fetchAll(buildQuery, context) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw supaFail(context, error);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

const ATTR_LABEL = { protein_code: 'protein type', sauce_type: 'sauce style', carb_type: 'starch type', dish_concept: 'dish type', am_snack_style: 'Pastry / Cold Kitchen style' };

// normalizeAiDish's short error ('no name' / 'missing sauce_type' / 'invalid carb_type X') as a sentence.
function shapeMessage(err) {
  if (err === 'no name') return 'The dish needs a name.';
  const [kind, attr] = err.split(' ');
  if (kind === 'missing') return `Choose a ${ATTR_LABEL[attr] || attr} — the menu rules for this category need it.`;
  return `That ${ATTR_LABEL[attr] || attr} isn't one of the allowed values.`;
}

function poolFor(sectionCode, categoryCode) {
  return poolSpecs().find((p) => p.category === categoryCode && p.sections.includes(sectionCode)) || null;
}

function catalogItemView(it) {
  const p = it.protein_type_id ? getProteinById(it.protein_type_id) : null;
  return {
    id: it.id, name: it.name, category_code: getCategoryById(it.category_id)?.code || null, is_active: !!it.is_active,
    is_daily_repeating: !!it.is_daily_repeating, protein_code: p ? p.code : null,
    sauce_type: it.sauce_type, carb_type: it.carb_type, dish_concept: it.dish_concept, am_snack_style: it.am_snack_style,
  };
}

async function loadRun(runId) {
  const { data, error } = await supabase.from('ai_menu_runs').select('*').eq('id', runId).single();
  if (error) throw supaFail('aiMenuReview: load run', error);
  return data;
}

async function requireDraft(runId) {
  const run = await loadRun(runId);
  if (run.status !== 'draft') throw new Error(`This run is ${run.status}, not a draft — it can no longer be changed.`);
  return run;
}

async function loadCatalogItems(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 300) {
    const { data, error } = await supabase.from('menu_items').select(ITEM_COLUMNS).in('id', unique.slice(i, i + 300));
    if (error) throw supaFail('aiMenuReview: load catalog items', error);
    for (const it of data) out.set(it.id, catalogItemView(it));
  }
  return out;
}

// ---------- read ----------

async function listRuns() {
  // select('*'): works both before and after the Approve migration added its claim columns.
  const { data, error } = await supabase.from('ai_menu_runs').select('*').order('created_at', { ascending: false });
  if (error) throw supaFail('aiMenuReview: list runs', error);
  const now = Date.now();
  return data.map((r) => ({
    ...r,
    warningCount: (r.warnings || []).length,
    warnings: undefined,
    approve_progress: undefined,
    approve_claim: undefined,
    failed: r.status === 'generating' && ((r.warnings || []).some((w) => w.kind === 'error') || now - new Date(r.created_at).getTime() > STALE_GENERATING_MS),
    // An approval whose heartbeat went quiet was interrupted and can be resumed.
    interrupted: r.status === 'approving' && now - new Date(r.approve_claimed_at || 0).getTime() > STALE_MS,
  }));
}

// Everything the review screen draws: the run, its dishes, every pick, the catalog items those
// picks use, and the current rule notes.
async function getRun(runId) {
  const run = await loadRun(runId);
  const [dishes, picks] = await Promise.all([
    fetchAll(() => supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS).eq('run_id', runId).order('id'), 'aiMenuReview: load dishes'),
    fetchAll(() => supabase.from('ai_menu_draft_picks').select('*').eq('run_id', runId).order('id'), 'aiMenuReview: load picks'),
  ]);
  const items = await loadCatalogItems([...picks.map((p) => p.item_id), ...dishes.map((d) => d.dup_match_item_id)]);
  const dishById = new Map(dishes.map((d) => [d.id, d]));
  const attrOf = (p) => (p.draft_dish_id ? dishById.get(p.draft_dish_id) : p.item_id ? items.get(p.item_id) : null) || null;
  const notes = checkDraftRules(picks, attrOf);
  // National Day cuisine per Tuesday of the run, for the day headers.
  const themes = {};
  for (const date of new Set(picks.map((p) => p.menu_date))) { const c = cuisineForDate(date); if (c) themes[date] = c; }
  return {
    run, dishes, picks, themes,
    catalogItems: Object.fromEntries(items),
    notes,
    emptySlots: picks.filter((p) => !p.draft_dish_id && !p.item_id).length,
  };
}

// ---------- replace a pick ----------

// Every pick that must change together with `pick`: itself plus its shared copies.
function propagationTargets(pick, picks) {
  const same = (p) => p.draft_dish_id === pick.draft_dish_id && p.item_id === pick.item_id;
  const targets = [pick];
  const onDay = picks.filter((p) => p.menu_date === pick.menu_date);
  if (pick.section_code === 'KG_LP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(pick.category_code)) {
    targets.push(...onDay.filter((p) => p.section_code === 'MS_UP' && p.category_code === pick.category_code
      && p.slot_index === pick.slot_index && p.source_section_code === 'KG_LP'));
  }
  // Daycare's AM / PM Snack is KG-LP's too (shared, 2026-09-24).
  if (pick.section_code === 'DAYCARE' && ['AM_SNACK', 'PM_SNACK'].includes(pick.category_code)) {
    targets.push(...onDay.filter((p) => p.section_code === 'KG_LP' && p.category_code === pick.category_code
      && p.slot_index === pick.slot_index && p.source_section_code === 'DAYCARE'));
  }
  const hasValue = pick.draft_dish_id || pick.item_id;
  // Staff Main carries KG-LP's Lunch Main + Starch and MS-UP's Lunch Vegetable (lib/generator.js).
  const feedsStaffMain = (pick.section_code === 'KG_LP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(pick.category_code))
    || (pick.section_code === 'MS_UP' && pick.category_code === 'LUNCH_VEGETABLE');
  if (hasValue && feedsStaffMain) {
    targets.push(...onDay.filter((p) => p.section_code === 'STAFF' && p.category_code === 'STAFF_MAIN' && p.source_section_code === pick.section_code && same(p)));
  }
  if (hasValue && pick.category_code === 'AM_SNACK' && ['DAYCARE', 'KG_LP', 'MS_UP'].includes(pick.section_code)) {
    targets.push(...onDay.filter((p) => p.section_code === 'STAFF' && p.category_code === 'STAFF_BREAKFAST' && p.source_section_code === pick.section_code && same(p)));
  }
  return targets;
}

async function loadPickContext(runId, pickId) {
  const picks = await fetchAll(() => supabase.from('ai_menu_draft_picks').select('*').eq('run_id', runId).order('id'), 'aiMenuReview: load picks');
  const pick = picks.find((p) => p.id === pickId);
  if (!pick) throw new Error('That menu slot no longer exists — reload the run.');
  if (pick.source_section_code) {
    throw new Error(`This dish is shared from ${pick.source_section_code.replace('_', '-')} — change it there and it updates here too.`);
  }
  const targets = propagationTargets(pick, picks);
  return { picks, pick, targets, sections: [...new Set(targets.map((t) => t.section_code))] };
}

// Options for the replace picker: this run's unused AI dishes for the slot, and the catalog.
async function listReplacementOptions({ runId, pickId }) {
  await requireDraft(runId);
  const { picks, pick } = await loadPickContext(runId, pickId);
  const dishes = await fetchAll(() => supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS)
    .eq('run_id', runId).eq('category_code', pick.category_code).order('name'), 'aiMenuReview: load dishes');
  const usedHere = new Set(picks.filter((p) => p.section_code === pick.section_code && p.draft_dish_id).map((p) => p.draft_dish_id));
  // On a National Day Tuesday, that cuisine's dishes first, then regular ones; other cuisines' last.
  const cuisine = cuisineForDate(pick.menu_date);
  // A snack cell's style today (Pastry / Cold Kitchen rotation): that style's dishes first.
  const runDates = [...new Set(picks.map((p) => p.menu_date))].sort();
  const style = snackStyleFor(runDates.indexOf(pick.menu_date) + 1, pick.category_code, pick.section_code);
  const styleRank = (d) => (style && d.am_snack_style !== style ? 1 : 0);
  const rank = (d) => (cuisine ? (d.cuisine === cuisine ? 0 : d.cuisine ? 2 : 1) : (d.cuisine ? 2 : 0));
  const unused = dishes.filter((d) => d.section_codes.includes(pick.section_code) && !usedHere.has(d.id))
    .sort((a, b) => styleRank(a) - styleRank(b) || rank(a) - rank(b) || a.name.localeCompare(b.name));

  const category = getCategoryByCode(pick.category_code);
  let catalog = await eligibleItemsSupabase(getSectionByCode(pick.section_code).id, category.id);
  // KG-LP's coupled Lunch Main / Starch is served to MS-UP too, Daycare's AM / PM Snack to KG-LP:
  // offer only items both sections can have.
  const partnerCode = (pick.section_code === 'KG_LP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(pick.category_code)) ? 'MS_UP'
    : (pick.section_code === 'DAYCARE' && ['AM_SNACK', 'PM_SNACK'].includes(pick.category_code)) ? 'KG_LP' : null;
  if (partnerCode) {
    const partner = new Set((await eligibleItemsSupabase(getSectionByCode(partnerCode).id, category.id)).map((i) => i.id));
    catalog = catalog.filter((i) => partner.has(i.id));
  }
  // Never a chicken / beef catalog snack (lib/categoryRules.js).
  catalog = catalog.filter((i) => !snackLunchOnlyHit(pick.category_code, i.protein_type_id ? getProteinById(i.protein_type_id)?.code : null, [['name', i.name]]));
  if (style) catalog.sort((a, b) => (a.am_snack_style === style ? 0 : 1) - (b.am_snack_style === style ? 0 : 1) || a.name.localeCompare(b.name));
  const usedItems = new Set(picks.filter((p) => p.section_code === pick.section_code && p.item_id).map((p) => p.item_id));
  return {
    cuisine,
    unusedDishes: unused,
    catalogItems: catalog.map((it) => ({ ...catalogItemView(it), usedInThisSection: usedItems.has(it.id) })),
  };
}

// A dish the chef wrote (or accepted from "Ask AI") for a slot: checked, then stored in the run.
// Returns { dish } or { blocked: { reason, hits } }.
async function createChefDish(runId, categoryCode, sections, fields, origin, cuisine = null) {
  const pool = poolFor(sections[0], categoryCode);
  const proteinCodes = getProteinTypes().map((p) => p.code);
  // Safety first, on exactly what was typed, so a nut / seafood / halal hit is never hidden behind
  // a missing dropdown; both are reported together.
  const { dish, error } = normalizeAiDish(fields, pool || { category: categoryCode }, proteinCodes);
  const typed = dish || { name: String(fields.name || ''), description: fields.description, key_ingredients: fields.key_ingredients || [], protein_code: fields.protein_code };
  const safety = checkDishSafety({ ...typed, category_code: categoryCode, section_codes: sections });
  if (!safety.ok || error) {
    return { blocked: { reason: [safety.ok ? null : safety.reason, error ? shapeMessage(error) : null].filter(Boolean).join('. Also: '), hits: safety.hits } };
  }

  const dup = await catalogDuplicate(categoryCode, dish.name);
  if (dup && !dup.item.is_active) return { blocked: { reason: `"${dish.name}" matches the retired catalog dish "${dup.item.name}" — reactivate it in the Dish Catalog or choose another name.`, hits: [] } };

  // Already a dish in this run with that name? Reuse it rather than a second copy.
  const name = dup ? dup.item.name : dish.name;
  const existing = await findRunDish(runId, categoryCode, name);
  if (existing) {
    const union = [...new Set([...existing.section_codes, ...sections])];
    const again = checkDishSafety({ ...existing, section_codes: union });
    if (!again.ok) return { blocked: { reason: again.reason, hits: again.hits } };
    return { dish: existing, reused: true };
  }

  const record = {
    run_id: runId, name, category_code: categoryCode, section_codes: sections,
    description: dish.description, key_ingredients: dish.key_ingredients,
    resolution: dup ? 'link' : 'new', dup_match_item_id: dup ? dup.item.id : null, dup_match_type: dup ? dup.matchType : null,
    edited: true,
    cuisine,
  };
  for (const attr of ATTRS) record[attr] = (dup && attrFromCatalog(dup.item, attr)) || dish[attr];
  record.safety_scan = { ...safetyScanRecord(record, safety), origin, ai_name: dish.name };
  const { data, error: insErr } = await supabase.from('ai_menu_draft_dishes').insert(record).select(DISH_COLUMNS).single();
  if (insErr) throw supaFail('aiMenuReview: create dish', insErr);
  return { dish: data, linked: !!dup };
}

function attrFromCatalog(item, attr) {
  if (attr === 'protein_code') return item.protein_type_id ? getProteinById(item.protein_type_id)?.code : null;
  return item[attr];
}

async function catalogDuplicate(categoryCode, name) {
  const category = getCategoryByCode(categoryCode);
  const rows = await fetchAll(() => supabase.from('menu_items').select(ITEM_COLUMNS).eq('category_id', category.id).order('id'), 'aiMenuReview: load catalog category');
  const index = emptyDishIndex();
  const byNorm = new Map();
  for (const r of rows) {
    addNameToIndex(index, r.name);
    const k = normalizeDishName(r.name);
    if (!byNorm.has(k) || (r.is_active && !byNorm.get(k).is_active)) byNorm.set(k, r);
  }
  const m = findDuplicateMatch(name, index);
  return m ? { item: byNorm.get(normalizeDishName(m.matchedName)), matchType: m.matchType } : null;
}

async function findRunDish(runId, categoryCode, name, exceptId = null) {
  const { data, error } = await supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS).eq('run_id', runId).eq('category_code', categoryCode);
  if (error) throw supaFail('aiMenuReview: load run dishes', error);
  const index = emptyDishIndex();
  const byNorm = new Map();
  for (const d of data) {
    if (d.id === exceptId) continue;
    addNameToIndex(index, d.name);
    byNorm.set(normalizeDishName(d.name), d);
  }
  const m = findDuplicateMatch(name, index);
  return m ? byNorm.get(normalizeDishName(m.matchedName)) : null;
}

// replacement: { draftDishId } | { itemId } | { newDish: { name, description, key_ingredients, ...attrs }, origin }
async function replacePick({ runId, pickId, replacement }) {
  await requireDraft(runId);
  const { pick, targets, sections } = await loadPickContext(runId, pickId);

  let draftDishId = null;
  let itemId = null;
  let result = {};
  if (replacement.newDish) {
    // An AI suggestion made for a National Day Tuesday keeps that cuisine; a chef-written dish is
    // untagged (the rule check then says if a Tuesday slot isn't themed).
    const cuisine = replacement.origin === 'ai_suggest' ? cuisineForDate(pick.menu_date) : null;
    const created = await createChefDish(runId, pick.category_code, sections, replacement.newDish, replacement.origin || 'chef', cuisine);
    if (created.blocked) return { ok: false, blocked: created.blocked };
    draftDishId = created.dish.id;
    result = { linked: created.linked, reused: created.reused, dish: created.dish };
  } else if (replacement.draftDishId) {
    const { data: dish, error } = await supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS).eq('id', replacement.draftDishId).eq('run_id', runId).single();
    if (error) throw supaFail('aiMenuReview: load dish', error);
    if (dish.category_code !== pick.category_code) throw new Error('That dish is for a different category.');
    const union = [...new Set([...dish.section_codes, ...sections])];
    const safety = checkDishSafety({ ...dish, section_codes: union });
    if (!safety.ok) return { ok: false, blocked: { reason: safety.reason, hits: safety.hits } };
    if (union.length !== dish.section_codes.length) {
      const { error: upErr } = await supabase.from('ai_menu_draft_dishes').update({ section_codes: union }).eq('id', dish.id);
      if (upErr) throw supaFail('aiMenuReview: update dish sections', upErr);
    }
    draftDishId = dish.id;
  } else if (replacement.itemId) {
    const { data: item, error } = await supabase.from('menu_items').select(ITEM_COLUMNS).eq('id', replacement.itemId).single();
    if (error) throw supaFail('aiMenuReview: load catalog item', error);
    if (item.category_id !== getCategoryByCode(pick.category_code).id) throw new Error('That catalog dish is in a different category.');
    if (!item.is_active) throw new Error('That catalog dish is retired.');
    itemId = item.id;
  } else {
    throw new Error('Nothing to replace the dish with.');
  }

  // A newly used draft dish must list every section it is now served in (copies included).
  if (draftDishId && !replacement.draftDishId) {
    const d = result.dish;
    const union = [...new Set([...d.section_codes, ...sections])];
    if (union.length !== d.section_codes.length) {
      const { error: upErr } = await supabase.from('ai_menu_draft_dishes').update({ section_codes: union }).eq('id', d.id);
      if (upErr) throw supaFail('aiMenuReview: update dish sections', upErr);
    }
  }

  const { error: pickErr } = await supabase.from('ai_menu_draft_picks')
    .update({ draft_dish_id: draftDishId, item_id: itemId })
    .in('id', targets.map((t) => t.id));
  if (pickErr) throw supaFail('aiMenuReview: update picks', pickErr);
  return { ok: true, updatedPicks: targets.length, ...result };
}

// ---------- edit a dish ----------

// fields: any of name / description / key_ingredients / protein_code / sauce_type / carb_type /
// dish_concept / am_snack_style. Returns { ok, dish, linked?, unlinked? } or { ok: false, blocked }.
async function updateDish({ runId, dishId, fields }) {
  await requireDraft(runId);
  const { data: current, error } = await supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS).eq('id', dishId).eq('run_id', runId).single();
  if (error) throw supaFail('aiMenuReview: load dish', error);

  const merged = { ...current };
  for (const k of [...EDITABLE_TEXT, ...ATTRS]) if (k in fields) merged[k] = fields[k];
  const pool = poolFor(current.section_codes[0], current.category_code);
  const proteinCodes = getProteinTypes().map((p) => p.code);
  const raw = { ...merged };
  for (const a of ATTRS) if (!raw[a]) raw[a] = 'NONE';
  const { dish, error: shapeErr } = normalizeAiDish(raw, pool || { category: current.category_code }, proteinCodes);
  const typed = dish || { ...merged, key_ingredients: merged.key_ingredients || [] };
  const safety = checkDishSafety({ ...typed, category_code: current.category_code, section_codes: current.section_codes });
  if (!safety.ok || shapeErr) {
    return { ok: false, blocked: { reason: [safety.ok ? null : safety.reason, shapeErr ? shapeMessage(shapeErr) : null].filter(Boolean).join('. Also: '), hits: safety.hits } };
  }

  const patch = { description: dish.description, key_ingredients: dish.key_ingredients, edited: true };
  for (const a of ATTRS) patch[a] = dish[a];
  let linked = false;
  let unlinked = false;
  if (normalizeDishName(dish.name) !== normalizeDishName(current.name)) {
    const other = await findRunDish(runId, current.category_code, dish.name, current.id);
    if (other) return { ok: false, blocked: { reason: `This run already has "${other.name}" in this category — pick that dish in the slot instead.`, hits: [] } };
    const dup = await catalogDuplicate(current.category_code, dish.name);
    if (dup && !dup.item.is_active) return { ok: false, blocked: { reason: `"${dish.name}" matches the retired catalog dish "${dup.item.name}" — reactivate it in the Dish Catalog or choose another name.`, hits: [] } };
    if (dup) {
      Object.assign(patch, { name: dup.item.name, resolution: 'link', dup_match_item_id: dup.item.id, dup_match_type: dup.matchType });
      linked = true;
    } else {
      Object.assign(patch, { name: dish.name, resolution: 'new', dup_match_item_id: null, dup_match_type: null });
      unlinked = current.resolution === 'link';
    }
  }
  patch.safety_scan = { ...safetyScanRecord({ ...current, ...patch }, safety), origin: 'chef_edit', ai_name: current.safety_scan?.ai_name };

  const { data: saved, error: upErr } = await supabase.from('ai_menu_draft_dishes').update(patch).eq('id', dishId).select(DISH_COLUMNS).single();
  if (upErr) {
    if (upErr.code === '23505') return { ok: false, blocked: { reason: 'Another dish in this run already has that name in this category.', hits: [] } };
    throw supaFail('aiMenuReview: update dish', upErr);
  }
  return { ok: true, dish: saved, linked, unlinked };
}

// ---------- ask the AI for a replacement ----------

// Three candidates for one slot, keeping the attributes that slot's rules need (e.g. a chicken
// main stays chicken). Nothing is saved: the chef picks one, and replacePick re-checks it.
async function suggestForPick({ runId, pickId }) {
  await requireDraft(runId);
  const { picks, pick, sections } = await loadPickContext(runId, pickId);
  const pool = poolFor(pick.section_code, pick.category_code);
  if (!pool) throw new Error('The AI only suggests dishes for its own categories; pick this one from the catalog.');

  const dishes = await fetchAll(() => supabase.from('ai_menu_draft_dishes').select(DISH_COLUMNS).eq('run_id', runId).eq('category_code', pick.category_code).order('id'), 'aiMenuReview: load dishes');
  const current = pick.draft_dish_id ? dishes.find((d) => d.id === pick.draft_dish_id) : (pick.item_id ? (await loadCatalogItems([pick.item_id])).get(pick.item_id) : null);
  const fixed = {};
  for (const a of pool.ruleAttrs) if (current && current[a]) fixed[a] = current[a];

  const proteinCodes = getProteinTypes().map((p) => p.code);
  const catalogRows = await fetchAll(() => supabase.from('menu_items').select('name, is_active').eq('category_id', getCategoryByCode(pick.category_code).id).order('id'), 'aiMenuReview: load catalog names');
  const cuisine = cuisineForDate(pick.menu_date);
  const request = buildDishRequest({ ...pool, sections }, [{ count: 3, ...(cuisine ? { cuisine } : {}), ...(Object.keys(fixed).length ? { fixed } : {}) }], proteinCodes,
    dishes.map((d) => d.name), sample(catalogRows.filter((r) => r.is_active).map((r) => r.name), 25));
  const raws = await generateMenuDishes(request);

  const candidates = [];
  const rejected = [];
  for (const raw of raws) {
    const { dish, error } = normalizeAiDish(raw, pool, proteinCodes);
    if (error) continue;
    const safety = checkDishSafety({ ...dish, category_code: pick.category_code, section_codes: sections });
    if (!safety.ok) { rejected.push({ name: dish.name, reason: safety.reason }); continue; }
    const dup = await catalogDuplicate(pick.category_code, dish.name);
    if (dup && !dup.item.is_active) continue;
    candidates.push({ ...dish, knownRisk: safety.knownRisk, linkedTo: dup ? dup.item.name : null });
  }
  return { candidates, rejected, keptAttributes: fixed, cuisine };
}

// ---------- discard ----------

async function discardRun(runId) {
  const { data, error } = await supabase.from('ai_menu_runs').update({ status: 'discarded' })
    .eq('id', runId).in('status', ['draft', 'generating']).select('id');
  if (error) throw supaFail('aiMenuReview: discard run', error);
  if (!data.length) throw new Error('This run can no longer be discarded (it was approved or already discarded).');
  return { ok: true };
}

module.exports = { listRuns, getRun, listReplacementOptions, replacePick, updateDish, suggestForPick, discardRun, propagationTargets };
