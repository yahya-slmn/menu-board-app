#!/usr/bin/env node
// Master Items build (MV2) -- READ-ONLY verification on the live data, after the build. Nothing is written to Supabase.
//   1. every saved ingredient list (menu_items.ingredients_text) is on exactly one dish_variants row: its row is linked to
//      a variant holding that same list, and no other version of that dish holds the same list;
//   2. the links: every linked row's version belongs to a master item of the row's own name; rows linked, by kind (with a
//      list / joining a listed version / of a dish with no list); rows not linked and why; versions no row uses;
//   3. the rest of menu_items: there is no copy from BEFORE the build to compare with (Supabase keeps no row history), so
//      this checks what can be checked -- the frozen list columns still hold exactly the text carried (history rows,
//      source 'variant_migration'), and the row count -- and SAVES A SNAPSHOT of every menu_items column except
//      dish_variant_id, so every later step can be compared byte for byte (--compare <snapshot.json>);
//   4. the final counts: master items, versions, rows linked.
//
//   cd ~/menu-board && node scripts/master-items-verify.js [--compare backups/menu-items-snapshot-<date>.json]
//
// Asks for your login (run it in a normal Terminal window). Writes backups/master-items-verify-<date>.txt and
// backups/menu-items-snapshot-<date-time>.json (a NEW file each run; never overwrites one).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');

const args = process.argv.slice(2);
const cmpAt = args.indexOf('--compare');
const comparePath = cmpAt >= 0 ? args[cmpAt + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(__dirname, '..', 'backups', `master-items-verify-${stamp.slice(0, 10)}.txt`);
const snapPath = path.join(__dirname, '..', 'backups', `menu-items-snapshot-${stamp}.json`);
const key = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const listKey = (t, a) => `${String(t ?? '').split(' - ').map(key).filter(Boolean).sort().join('|')}||${String(a ?? '').split(' - ').map(key).filter(Boolean).sort().join('|')}`;
const has = (t) => key(t) !== '';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}
function loginDomain() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  return src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/)[1];
}
async function fetchAll(table, cols, filter) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(cols).order('id').range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const items = await fetchAll('menu_items', '*');
  if (!items.length) throw new Error('The catalog came back empty -- is the login right?');
  const masters = await fetchAll('master_items', 'id, name, name_key');
  const variants = await fetchAll('dish_variants', 'id, master_item_id, ingredients_text, allergens_text, ingredients_updated_by, ingredients_updated_at');
  const hist = await fetchAll('menu_item_ingredient_history', 'id, item_id, dish_variant_id, new_ingredients, source', (q) => q.eq('source', 'variant_migration'));
  const masterById = new Map(masters.map((m) => [m.id, m]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const usersOf = new Map();
  for (const it of items) if (it.dish_variant_id != null) { if (!usersOf.has(it.dish_variant_id)) usersOf.set(it.dish_variant_id, []); usersOf.get(it.dish_variant_id).push(it); }
  const problems = [];
  const P = (msg) => problems.push(msg);

  // ---- 1. every saved list on exactly one version
  const saved = items.filter((it) => has(it.ingredients_text));
  let onItsVersion = 0;
  const savedUnlinked = [];
  for (const it of saved) {
    const v = it.dish_variant_id != null ? variantById.get(it.dish_variant_id) : null;
    if (!v) { savedUnlinked.push(it); continue; }
    if (listKey(v.ingredients_text, v.allergens_text) !== listKey(it.ingredients_text, it.allergens_text)) { P(`#${it.id} ${it.name}: its version #${v.id} holds a different list`); continue; }
    const twins = variants.filter((x) => x.master_item_id === v.master_item_id && x.id !== v.id && listKey(x.ingredients_text, x.allergens_text) === listKey(it.ingredients_text, it.allergens_text));
    if (twins.length) { P(`#${it.id} ${it.name}: the same list is on ${twins.length + 1} versions of this dish`); continue; }
    onItsVersion++;
  }
  for (const it of savedUnlinked) P(`#${it.id} ${it.name}: has a saved list but is not linked to a version`);

  // ---- 2. links
  const linked = items.filter((it) => it.dish_variant_id != null);
  let wrongMaster = 0, missingVariant = 0;
  for (const it of linked) {
    const v = variantById.get(it.dish_variant_id);
    if (!v) { missingVariant++; P(`#${it.id} ${it.name}: linked to version #${it.dish_variant_id}, which does not exist`); continue; }
    const m = masterById.get(v.master_item_id);
    if (!m || m.name_key !== key(it.name)) { wrongMaster++; P(`#${it.id} ${it.name}: its version belongs to "${m ? m.name : '?'}"`); }
  }
  const linkedWithList = linked.filter((it) => has(it.ingredients_text)).length;
  const joining = linked.filter((it) => !has(it.ingredients_text) && has(variantById.get(it.dish_variant_id)?.ingredients_text)).length;
  const emptyKind = linked.filter((it) => !has(it.ingredients_text) && !has(variantById.get(it.dish_variant_id)?.ingredients_text)).length;
  const unlinked = items.filter((it) => it.dish_variant_id == null);
  const versionsOfName = new Map();
  for (const v of variants) { const k = masterById.get(v.master_item_id)?.name_key; versionsOfName.set(k, (versionsOfName.get(k) || 0) + 1); }
  const toPick = unlinked.filter((it) => !has(it.ingredients_text) && (versionsOfName.get(key(it.name)) || 0) > 1);
  const notTicked = unlinked.filter((it) => !has(it.ingredients_text) && (versionsOfName.get(key(it.name)) || 0) === 1);
  const noMaster = unlinked.filter((it) => !versionsOfName.has(key(it.name)));
  const unused = variants.filter((v) => !usersOf.has(v.id));
  const dupMasters = masters.length - new Set(masters.map((m) => m.name_key)).size;
  if (dupMasters) P(`${dupMasters} master items share a name`);

  // ---- 3. what can be checked of the rest, and the snapshot
  const histByVariant = new Map(hist.map((h) => [h.dish_variant_id, h]));
  let histMatches = 0, histDiffers = 0;
  for (const v of variants.filter((x) => has(x.ingredients_text))) {
    const h = histByVariant.get(v.id);
    if (!h) { P(`version #${v.id}: no 'variant_migration' history row`); continue; }
    const src = items.find((it) => it.id === h.item_id);
    if (src && src.ingredients_text === h.new_ingredients && v.ingredients_text === h.new_ingredients) histMatches++;
    else { histDiffers++; P(`version #${v.id}: the list carried from row #${h.item_id} no longer matches that row's frozen list or the version`); }
  }
  const snapshot = items.map(({ dish_variant_id, ...rest }) => rest).sort((a, b) => a.id - b.id);
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify(snapshot));
  let compareLine = '';
  if (comparePath) {
    const old = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    const oldById = new Map(old.map((r) => [r.id, r]));
    const changed = snapshot.filter((r) => oldById.has(r.id) && JSON.stringify(r) !== JSON.stringify(oldById.get(r.id)));
    const added = snapshot.filter((r) => !oldById.has(r.id)).length;
    const removed = old.filter((r) => !snapshot.some((x) => x.id === r.id)).length;
    compareLine = `Compared with ${path.basename(comparePath)} (dish_variant_id left out): ${changed.length} row(s) changed, ${added} added, ${removed} removed` +
      (changed.length ? ` -- e.g. ${changed.slice(0, 5).map((r) => `#${r.id}: ${Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(oldById.get(r.id)[k])).join(', ')}`).join('; ')}` : '');
    if (changed.length || removed) P(compareLine);
  }

  const L = [`Master Items build -- read-only verification, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
    '1. SAVED LISTS',
    `   rows with a saved list: ${saved.length}; on exactly one version holding that same list: ${onItsVersion}; not linked: ${savedUnlinked.length}`,
    `   versions holding a list: ${variants.filter((v) => has(v.ingredients_text)).length} (rows with an identical list share one)`,
    '2. LINKS',
    `   rows linked: ${linked.length} of ${items.length} -- with their own list ${linkedWithList}, joining a listed version ${joining}, of a dish with no list ${emptyKind}`,
    `   linked to a version of another dish's name: ${wrongMaster}; to a missing version: ${missingVariant}`,
    `   not linked: ${unlinked.length} -- left to pick a version (dish has 2+): ${toPick.length}; would have joined the only version (box unticked): ${notTicked.length}; no master item: ${noMaster.length}`,
    `   versions no row uses: ${unused.length}`,
    '3. THE REST OF menu_items',
    '   No copy from before the build exists (Supabase keeps no row history), so a byte-for-byte before/after diff is not possible for this build.',
    `   Carried lists still identical to their source rows' frozen list column and to the version: ${histMatches}; differing: ${histDiffers}`,
    `   Rows in the catalog: ${items.length} (U0 measured 3499 on 2026-10-02)`,
    `   Snapshot of every menu_items column except dish_variant_id saved: ${path.basename(snapPath)} -- every later step can be compared byte for byte with --compare`,
    ...(compareLine ? [`   ${compareLine}`] : []),
    '4. COUNTS',
    `   master items: ${masters.length}; dish versions: ${variants.length}; menu_items rows linked: ${linked.length}`,
    '', problems.length ? `PROBLEMS (${problems.length}):` : 'PASS: every saved list is on exactly one version of its own dish, every link points at its own dish, nothing missing.',
    ...problems.slice(0, 60).map((p) => `   ${p}`)];
  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log(L.join('\n'));
  console.log(`\nReport: ${outPath}`);
  process.exit(problems.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
