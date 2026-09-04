const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log/main');
const { supabase, supaFail } = require('./lib/supabaseClient');
const {
  loadReferenceData, getSections, getSectionByCode, getSectionById,
  getCategories, getCategoryByCode, getCategoryById,
  getProteinTypes, getProteinByCode, getProteinById,
  getAgeGroups, getAgeGroupsForSection, getAgeGroupByCode, getAgeGroupById,
  getCategoryPortionDefault,
} = require('./lib/referenceData');
const { MenuGenerator, SECTION_SLOTS, eligibleItemsSupabase, sectionItemPoolSupabase, schoolDaysFrom, schoolDayCountBetween } = require('./lib/generator');
const { suggestClassification } = require('./lib/classify');
const {
  exportSingleMenu, exportCombinedWorkbook, exportBlankTemplateWorkbook, exportRecipes, exportScaledRecipe,
  sanitizeSheetName, DEFAULT_LABELS, buildRecipeContentModel,
} = require('./lib/export');
const { extractRecipeFromFile } = require('./lib/recipeExtraction');
const { translateTexts } = require('./lib/translateRecipe');

let mainWindow;
let loginWindow;
let authenticated = false;

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 380,
    height: 480,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------
// Auto-update (electron-updater, checking GitHub Releases on the repo configured in
// package.json's build.publish). Downloads silently in the background; the user is only
// interrupted once the update is fully downloaded and ready to install.
//
// Logging only, added for debugging -- no update/signing behavior changed here. A packaged
// .app has no attached terminal, so console.log/error were never visible in practice; this
// routes everything (electron-log's own internal messages included, via autoUpdater.logger)
// to a file instead. Default location on macOS: ~/Library/Logs/<productName>/main.log, i.e.
// ~/Library/Logs/Menu Board/main.log once packaged (electron-log derives the folder name from
// app.getName(), which electron-builder sets to package.json's build.productName).
// ---------------------------------------------------------------
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';
autoUpdater.logger = log;

autoUpdater.autoDownload = true;

autoUpdater.on('checking-for-update', () => {
  log.info('[auto-updater] checking-for-update event fired');
});

autoUpdater.on('update-available', (info) => {
  log.info(`[auto-updater] update-available: v${info.version} -- downloading in background`);
});

autoUpdater.on('update-not-available', (info) => {
  log.info(`[auto-updater] update-not-available -- current app version is already latest (checked against v${info?.version})`);
});

autoUpdater.on('update-downloaded', (info) => {
  log.info(`[auto-updater] update-downloaded: v${info.version} -- prompting to restart`);
  dialog.showMessageBox(mainWindow || loginWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `Version ${info.version} has been downloaded.`,
    detail: 'Restart Menu Board now to install it, or it will install automatically the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  log.error('[auto-updater] error event:', {
    message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
  });
});

function checkForUpdates() {
  // Unpacked dev runs (npm start) have no app-update.yml -- that file only exists inside a
  // build produced by electron-builder -- so checkForUpdates() would just throw noisily.
  // This means dev-mode testing (npm start) will NEVER produce any auto-update log lines at
  // all, by design -- to see anything here, test the actual packaged/installed .app.
  if (!app.isPackaged) {
    log.info('[auto-updater] skipped: app.isPackaged is false (dev run via npm start)');
    return;
  }
  log.info(`[auto-updater] calling checkForUpdates() -- current app version is ${app.getVersion()}`);
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[auto-updater] checkForUpdates() promise rejected:', {
      message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
    });
  });
}

app.whenReady().then(() => {
  createLoginWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      authenticated ? createWindow() : createLoginWindow();
    }
  });
});

// ---------------------------------------------------------------
// IPC: auth
// ---------------------------------------------------------------
// Login shows a short ID (e.g. "tty01") instead of an email, but Supabase Auth still needs
// one -- so the ID is mapped to a fake internal address under a domain nobody actually owns
// or receives mail at, and that address is all Supabase (and RLS) ever sees. This is purely a
// UI/UX layer on top of the exact same email+password auth as before; nothing about how
// security/RLS works changes. See "Creating new accounts" in the project notes for how to
// create the Supabase Auth user behind a new ID.
const LOGIN_ID_DOMAIN = 'menuboard.local';

ipcMain.handle('auth-sign-in', async (e, { id, password }) => {
  const email = `${(id || '').trim().toLowerCase()}@${LOGIN_ID_DOMAIN}`;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { success: false, message: error.message };

  // sections/categories/protein_types/age_groups/meal_periods are read constantly and
  // synchronously throughout the app; RLS blocks anonymous reads of them (same as every
  // other table), so this can only run after sign-in succeeds -- and must complete before
  // createWindow() so the main renderer's first get-sections/get-categories calls hit a warm
  // cache instead of an empty one.
  await loadReferenceData();

  authenticated = true;
  if (loginWindow) { loginWindow.close(); loginWindow = null; }
  createWindow();
  return { success: true, id: (id || '').trim().toLowerCase() };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------
// IPC: reference data (in-memory cache, see lib/referenceData.js)
// ---------------------------------------------------------------
ipcMain.handle('get-sections', () => {
  return getSections();
});

ipcMain.handle('get-age-groups', (e, sectionCode) => {
  const section = getSectionByCode(sectionCode);
  return getAgeGroupsForSection(section.id);
});

ipcMain.handle('get-categories', () => {
  return getCategories();
});

// Categories aren't tagged with a section directly -- codes like STAFF_MAIN/CEO_SALAD are
// section-specific by convention, but Daycare/KG_LP/MS_UP share a generic set (LUNCH_MAIN,
// JUICE, etc). "Belongs to this section" is therefore derived, not stored: the union of
// (a) categories that section's menu_slots actually require, and (b) categories any of its
// existing items already use -- (b) covers catalog-only categories (e.g. DESSERT, SALAD_OPTION)
// that aren't part of the generator's daily slot spec yet. This keeps the Item Catalog's
// category dropdown from leaking Staff/CEO categories into school sections or vice versa.
// menu_slots is queried live from Supabase (not cached) since Build Menu/Generate Menu can
// write new rows to it at runtime, unlike the other reference tables in lib/referenceData.js.
ipcMain.handle('get-categories-for-section', async (e, sectionCode) => {
  const section = getSectionByCode(sectionCode);

  const { data: slotRows, error: slotErr } = await supabase
    .from('menu_slots').select('category_id').eq('section_id', section.id);
  if (slotErr) throw supaFail('get-categories-for-section: load menu_slots', slotErr);
  const slotCategoryIds = slotRows.map(r => r.category_id);

  const ageGroupIds = getAgeGroupsForSection(section.id).map(a => a.id);
  let usedCategoryIds = [];
  if (ageGroupIds.length) {
    const { data: portionRows, error: portErr } = await supabase
      .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
    if (portErr) throw supaFail('get-categories-for-section: load item_portions', portErr);
    const itemIds = [...new Set(portionRows.map(r => r.item_id))];
    if (itemIds.length) {
      const { data: items, error: itemsErr } = await supabase
        .from('menu_items').select('category_id').in('id', itemIds);
      if (itemsErr) throw supaFail('get-categories-for-section: load menu_items', itemsErr);
      usedCategoryIds = items.map(i => i.category_id);
    }
  }

  const categoryIds = new Set([...slotCategoryIds, ...usedCategoryIds]);
  // getCategories() is already sorted by (meal_period.sort_order, category.sort_order);
  // filtering preserves that order, matching the old SQL's ORDER BY.
  return getCategories().filter(c => categoryIds.has(c.id));
});

ipcMain.handle('get-protein-types', () => {
  return getProteinTypes();
});

// Refresh button (top-right of the renderer) -- get-sections/get-categories/get-protein-types
// above are plain synchronous reads of lib/referenceData.js's in-memory cache, populated once
// at login and never invalidated on its own. This actually re-runs loadReferenceData() against
// Supabase, then returns the fresh cache in one round trip so the renderer doesn't need three
// separate follow-up calls.
ipcMain.handle('refresh-reference-data', async () => {
  await loadReferenceData();
  return { sections: getSections(), categories: getCategories(), proteinTypes: getProteinTypes() };
});

// ---------------------------------------------------------------
// IPC: item management (menu_items / item_portions -- Supabase)
// ---------------------------------------------------------------
ipcMain.handle('get-items', async (e, sectionCode) => {
  const section = getSectionByCode(sectionCode);
  const ageGroupIds = getAgeGroupsForSection(section.id).map(a => a.id);
  if (ageGroupIds.length === 0) return [];

  const { data: portionRows, error: portErr } = await supabase
    .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
  if (portErr) throw supaFail('get-items: load item_portions', portErr);
  const itemIds = [...new Set(portionRows.map(r => r.item_id))];
  if (itemIds.length === 0) return [];

  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name, is_daily_repeating, is_active, rc_code, category_id, protein_type_id')
    .in('id', itemIds);
  if (itemsErr) throw supaFail('get-items: load menu_items', itemsErr);

  return items
    .map(mi => {
      const cat = getCategoryById(mi.category_id);
      const pt = mi.protein_type_id ? getProteinById(mi.protein_type_id) : null;
      return {
        id: mi.id,
        name: mi.name,
        is_daily_repeating: mi.is_daily_repeating,
        is_active: mi.is_active,
        rc_code: mi.rc_code,
        category_code: cat?.code,
        category_name: cat?.name,
        protein_code: pt?.code ?? null,
        protein_name: pt?.name ?? null,
        _mpSort: cat?.meal_period_sort_order ?? 0,
        _cSort: cat?.sort_order ?? 0,
      };
    })
    .sort((a, b) => a._mpSort - b._mpSort || a._cSort - b._cSort || a.name.localeCompare(b.name))
    .map(({ _mpSort, _cSort, ...rest }) => rest);
});

ipcMain.handle('get-item-portions', async (e, itemId) => {
  const { data, error } = await supabase.from('item_portions').select('*').eq('item_id', itemId);
  if (error) throw supaFail('get-item-portions', error);
  const agById = new Map(getAgeGroups().map(a => [a.id, a]));
  return data.map(ip => ({
    ...ip,
    age_group_code: agById.get(ip.age_group_id)?.code,
    age_group_name: agById.get(ip.age_group_id)?.name,
  }));
});

ipcMain.handle('suggest-classification', (e, { name, mealPeriod, sectionCode }) => {
  return suggestClassification(name, mealPeriod, sectionCode);
});

// menu_items has UNIQUE(name, category_id) in Postgres too -- adding/renaming/re-categorizing
// an item so it collides with another item of the same name already in that category throws
// a unique_violation (Postgres code 23505). Caught here (same pattern as delete-ingredient
// below) and reported back as { success: false, duplicate: true } instead of throwing, since
// the same dish name legitimately recurs across many categories in this catalog and the
// renderer needs to tell the user why the save didn't go through rather than have it silently fail.
ipcMain.handle('add-item', async (e, { name, categoryCode, proteinCode, isDailyRepeating, portions, sectionCode }) => {
  const category = getCategoryByCode(categoryCode);
  const protein = proteinCode ? getProteinByCode(proteinCode) : null;

  const { data: inserted, error: insErr } = await supabase
    .from('menu_items')
    .insert({
      name,
      category_id: category.id,
      protein_type_id: protein ? protein.id : null,
      is_daily_repeating: isDailyRepeating ? 1 : 0,
    })
    .select('id')
    .single();

  if (insErr) {
    if (insErr.code === '23505') return { success: false, duplicate: true };
    throw supaFail('add-item: insert menu_items', insErr);
  }
  const itemId = inserted.id;

  const rows = [];
  for (const p of portions) {
    const ag = getAgeGroupByCode(p.ageGroupCode);
    if (ag) rows.push({ item_id: itemId, age_group_id: ag.id, unit: p.unit, quantity: p.quantity, price: p.price ?? null });
  }
  // Safety net: if no portions were provided but we know the section, link the item to
  // that section's age groups with a zero placeholder so it never silently disappears.
  if (rows.length === 0 && sectionCode) {
    const section = getSectionByCode(sectionCode);
    if (section) {
      const ags = getAgeGroupsForSection(section.id);
      for (const ag of ags) rows.push({ item_id: itemId, age_group_id: ag.id, unit: 'n/a', quantity: 0, price: null });
    }
  }
  if (rows.length) {
    const { error: portErr } = await supabase.from('item_portions').insert(rows);
    if (portErr) {
      // Supabase has no cross-table transaction here -- compensate manually so a failed
      // portion insert doesn't leave a portion-less item behind.
      await supabase.from('menu_items').delete().eq('id', itemId);
      throw supaFail('add-item: insert item_portions', portErr);
    }
  }
  return { success: true, itemId };
});

// Which sections' SECTION_SLOTS actually list this category code -- the same "does this
// category belong here" definition the category-leak audit used, kept in one place so both
// stay in sync.
function sectionCodesForCategory(categoryCode) {
  return Object.keys(SECTION_SLOTS).filter(sectionCode =>
    SECTION_SLOTS[sectionCode].some(([catCode]) => catCode === categoryCode)
  );
}

// Read-only: called from the Edit Item form only when the category dropdown actually changed.
// The form only ever shows/edits item_portions for the section currently being viewed
// (getAgeGroups(state.currentSection) in renderer.js), so it has no visibility into whether
// this item also has portions in OTHER sections -- this is what gives it that visibility
// before the save happens, instead of after, silently (the update-item bug that produced the
// cross-section leaks cleaned up earlier).
ipcMain.handle('check-category-change-impact', async (e, { itemId, newCategoryCode }) => {
  const { data: portionRows, error } = await supabase
    .from('item_portions').select('age_group_id').eq('item_id', itemId);
  if (error) throw supaFail('check-category-change-impact: load item_portions', error);
  if (portionRows.length === 0) return { invalidSections: [] };

  const ageGroupIds = [...new Set(portionRows.map(r => r.age_group_id))];
  const ageGroups = ageGroupIds.map(id => getAgeGroupById(id)).filter(Boolean);
  const sectionIdsWithPortions = [...new Set(ageGroups.map(a => a.section_id))];

  const validSectionCodes = new Set(sectionCodesForCategory(newCategoryCode));

  const invalidSections = sectionIdsWithPortions
    .map(sid => getSectionById(sid))
    .filter(s => s && !validSectionCodes.has(s.code))
    .map(s => ({
      sectionCode: s.code,
      sectionName: s.name,
      portionCount: ageGroups.filter(a => a.section_id === s.id).length,
    }));

  return { invalidSections };
});

// removeInvalidSectionPortions: set only after the renderer has shown the chef exactly which
// sections/how-many rows would go stale (via check-category-change-impact above) and she's
// explicitly confirmed -- never inferred or defaulted true, so a category save never deletes
// portion data the chef hasn't seen and approved in the moment.
ipcMain.handle('update-item', async (e, { id, name, categoryCode, proteinCode, isDailyRepeating, isActive, removeInvalidSectionPortions }) => {
  const category = getCategoryByCode(categoryCode);
  const protein = proteinCode ? getProteinByCode(proteinCode) : null;

  const { error } = await supabase
    .from('menu_items')
    .update({
      name,
      category_id: category.id,
      protein_type_id: protein ? protein.id : null,
      is_daily_repeating: isDailyRepeating ? 1 : 0,
      is_active: isActive ? 1 : 0,
    })
    .eq('id', id);

  if (error) {
    if (error.code === '23505') return { success: false, duplicate: true };
    throw supaFail('update-item', error);
  }

  if (removeInvalidSectionPortions) {
    const validSectionCodes = new Set(sectionCodesForCategory(categoryCode));
    const { data: portionRows, error: pErr } = await supabase
      .from('item_portions').select('id, age_group_id').eq('item_id', id);
    if (pErr) throw supaFail('update-item: load item_portions for cleanup', pErr);

    const idsToDelete = portionRows
      .filter(p => {
        const ag = getAgeGroupById(p.age_group_id);
        const section = ag ? getSectionById(ag.section_id) : null;
        return section && !validSectionCodes.has(section.code);
      })
      .map(p => p.id);

    if (idsToDelete.length) {
      const { error: delErr } = await supabase.from('item_portions').delete().in('id', idsToDelete);
      if (delErr) throw supaFail('update-item: cleanup invalid-section portions', delErr);
    }
  }

  return { success: true };
});

// menu_day_items.item_id -> menu_items.id is ON DELETE RESTRICT (added directly in Supabase),
// so deleting an item still referenced by a generated menu throws a foreign_key_violation
// (Postgres code 23503) -- caught here and reported back with a count of how many distinct
// generated menus reference it, same pattern as delete-ingredient above. item_portions is still
// deleted explicitly first even though it's now ON DELETE CASCADE, since that's harmless and
// keeps this correct regardless of how the FK ends up defined.
ipcMain.handle('delete-item', async (e, itemId) => {
  await supabase.from('item_portions').delete().eq('item_id', itemId);
  const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
  if (error) {
    if (error.code === '23503') {
      const { data: dayItemRows, error: diErr } = await supabase
        .from('menu_day_items').select('menu_day_id').eq('item_id', itemId);
      if (diErr) throw supaFail('delete-item: count usage (menu_day_items)', diErr);
      const dayIds = [...new Set(dayItemRows.map(r => r.menu_day_id))];

      let menuCount = 0;
      if (dayIds.length) {
        const { data: dayRows, error: dErr } = await supabase
          .from('menu_days').select('generated_menu_id').in('id', dayIds);
        if (dErr) throw supaFail('delete-item: count usage (menu_days)', dErr);
        menuCount = new Set(dayRows.map(r => r.generated_menu_id)).size;
      }
      return { success: false, inUse: true, menuCount };
    }
    throw supaFail('delete-item', error);
  }
  return { success: true };
});

ipcMain.handle('update-item-rc', async (e, { id, rcCode }) => {
  const { error } = await supabase.from('menu_items').update({ rc_code: rcCode || null }).eq('id', id);
  if (error) throw supaFail('update-item-rc', error);
  return { success: true };
});

// ---------------------------------------------------------------
// IPC: ingredients & recipes (Supabase)
// ---------------------------------------------------------------
ipcMain.handle('search-ingredients', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('ingredients').select('*').ilike('name', `%${q}%`).order('name').limit(25);
  if (error) throw supaFail('search-ingredients', error);
  return data;
});

// created_at has no DB-side default on Supabase's ingredients table (confirmed via
// pg_constraint -- the only constraint on this table is the primary key on id), despite the
// old SQLite schema's DEFAULT (datetime('now')) not carrying over in the migration -- same
// gap as recipes, see save-recipe's insert. Set explicitly here, insert-only.
ipcMain.handle('add-ingredient', async (e, { name, defaultUnit, category, productCode }) => {
  const { data, error } = await supabase
    .from('ingredients')
    .insert({ product_code: productCode || null, name: name.trim(), default_unit: defaultUnit || null, category: category || null, created_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw supaFail('add-ingredient', error);
  return data;
});

ipcMain.handle('update-ingredient', async (e, { id, name, defaultUnit, category, productCode }) => {
  const { error } = await supabase
    .from('ingredients')
    .update({ product_code: productCode || null, name: name.trim(), default_unit: defaultUnit || null, category: category || null })
    .eq('id', id);
  if (error) throw supaFail('update-ingredient', error);
  return { success: true };
});

ipcMain.handle('list-ingredients', async () => {
  // Explicit limit, well above the current ~1000 rows -- PostgREST silently caps unlimited
  // queries at its own default max-rows (1000), which was quietly truncating this list with
  // no error at all. Bump this again if the ingredient count ever approaches it.
  const { data, error } = await supabase.from('ingredients').select('*').order('category').order('name').limit(5000);
  if (error) throw supaFail('list-ingredients', error);
  return data;
});

// recipe_ingredients.ingredient_id has no ON DELETE CASCADE (unlike recipe_ingredients.recipe_id),
// so deleting an ingredient still referenced by a saved recipe throws a foreign_key_violation
// (Postgres code 23503) -- caught here and reported back rather than left to crash the
// renderer's IPC call.
ipcMain.handle('delete-ingredient', async (e, id) => {
  const { error } = await supabase.from('ingredients').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') return { success: false, inUse: true };
    throw supaFail('delete-ingredient', error);
  }
  return { success: true };
});

// Waste Types: a small, chef-managed global catalog (name + default %) shared by Recipe Book
// and Recipe Extractor process cards alike -- unlike ingredients, a waste type carries no
// extraction provenance, so there's no separate extracted_* table for it (see conversation
// notes on the composable process-waste feature).
ipcMain.handle('list-waste-types', async () => {
  const { data, error } = await supabase.from('waste_types').select('*').order('sort_order');
  if (error) throw supaFail('list-waste-types', error);
  return data;
});

ipcMain.handle('add-waste-type', async (e, { name, defaultPercent }) => {
  const { data, error } = await supabase
    .from('waste_types')
    .insert({ name: name.trim(), default_percent: defaultPercent })
    .select('*')
    .single();
  if (error) throw supaFail('add-waste-type', error);
  return data;
});

// cascadeToExisting mirrors update-item's removeInvalidSectionPortions flag -- never inferred or
// defaulted true, only set after the renderer has shown the chef an explicit scoped-impact
// choice and she's picked the option that reaches beyond the catalog default. When set, every
// recipe_process_wastes/extracted_recipe_process_wastes row already snapshotting this waste type
// is overwritten to the new percent too, not just waste_types.default_percent. Sequential
// awaited calls, not a transaction -- same accepted tradeoff persistMenu() documents elsewhere in
// this app; a failure partway through leaves a recoverable, visible inconsistency rather than a
// silent one, since supaFail surfaces it immediately.
ipcMain.handle('update-waste-type', async (e, { id, name, defaultPercent, cascadeToExisting }) => {
  const { error } = await supabase
    .from('waste_types')
    .update({ name: name.trim(), default_percent: defaultPercent })
    .eq('id', id);
  if (error) throw supaFail('update-waste-type', error);

  if (cascadeToExisting) {
    const { error: rErr } = await supabase.from('recipe_process_wastes').update({ percent: defaultPercent }).eq('waste_type_id', id);
    if (rErr) throw supaFail('update-waste-type: cascade recipe_process_wastes', rErr);
    const { error: eErr } = await supabase.from('extracted_recipe_process_wastes').update({ percent: defaultPercent }).eq('waste_type_id', id);
    if (eErr) throw supaFail('update-waste-type: cascade extracted_recipe_process_wastes', eErr);
  }

  return { success: true };
});

// recipe_process_wastes/extracted_recipe_process_wastes.waste_type_id is ON DELETE RESTRICT
// (not CASCADE) -- a waste type still applied to any process can't be deleted out from under
// that process's saved percentage, same 23503-catching convention as delete-ingredient above.
ipcMain.handle('delete-waste-type', async (e, id) => {
  const { error } = await supabase.from('waste_types').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') return { success: false, inUse: true };
    throw supaFail('delete-waste-type', error);
  }
  return { success: true };
});

// ============================================================
// Materials / Trays -- a chef-managed catalog of baking equipment (trays, molds, pans), each
// with an auto-generated MS-##### code (mirrors nextRecipeCode below), a parametric shape +
// dimensions (rendered as a live 3D preview in the renderer -- nothing 3D-related is stored
// here, just the raw numbers the renderer builds a THREE.js geometry from), an optional single
// photo (same pattern as Recipe Book's photo_path below), and a chef-defined "weight" (the
// practical product weight this material typically holds -- e.g. how much batter/dough a given
// tray takes in practice, not a rigid physical capacity, so it's plain editable input, never
// computed from the dimensions). Catalog-only for now -- nothing else in the schema references
// materials yet; linking a material to a recipe is a separate later phase.
// ============================================================

async function nextMaterialCode() {
  const { data, error } = await supabase.from('materials').select('code').like('code', 'MS-%');
  if (error) throw supaFail('nextMaterialCode', error);
  let max = 0;
  for (const row of data) {
    const n = parseInt(row.code.slice(3), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `MS-${String(max + 1).padStart(5, '0')}`;
}

// Same private-bucket, session-authenticated, single-photo pattern as RECIPE_PHOTOS_BUCKET above.
const MATERIAL_PHOTOS_BUCKET = 'material-photos';

async function uploadMaterialPhoto(base64, ext) {
  const path = `${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage.from(MATERIAL_PHOTOS_BUCKET).upload(path, buffer, { contentType });
  if (error) throw supaFail('uploadMaterialPhoto', error);
  return path;
}

async function deleteMaterialPhoto(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(MATERIAL_PHOTOS_BUCKET).remove([path]);
  if (error) console.error('[supabase] deleteMaterialPhoto failed (non-fatal):', error.message);
}

ipcMain.handle('get-material-photo', async (e, photoPath) => {
  if (!photoPath) return null;
  const { data, error } = await supabase.storage.from(MATERIAL_PHOTOS_BUCKET).download(photoPath);
  if (error) throw supaFail('get-material-photo', error);
  const buffer = Buffer.from(await data.arrayBuffer());
  const ext = photoPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('list-materials', async () => {
  const { data, error } = await supabase.from('materials').select('*').order('name');
  if (error) throw supaFail('list-materials', error);
  return data;
});

ipcMain.handle('search-materials', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('materials')
    .select('id, code, name, shape_type')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(25);
  if (error) throw supaFail('search-materials', error);
  return data;
});

ipcMain.handle('get-material', async (e, id) => {
  const { data, error } = await supabase.from('materials').select('*').eq('id', id).single();
  if (error) throw supaFail('get-material', error);
  return data;
});

ipcMain.handle('save-material', async (e, payload) => {
  const fields = {
    name: payload.name,
    shape_type: payload.shapeType,
    diameter_cm: payload.diameterCm ?? null,
    length_cm: payload.lengthCm ?? null,
    width_cm: payload.widthCm ?? null,
    height_cm: payload.heightCm ?? null,
    cup_diameter_cm: payload.cupDiameterCm ?? null,
    cup_depth_cm: payload.cupDepthCm ?? null,
    cup_rows: payload.cupRows ?? null,
    cup_columns: payload.cupColumns ?? null,
    weight_grams: payload.weightGrams ?? null,
  };

  // photo_path is only ever touched when she actually picked a new file or hit "Remove Photo" --
  // omitted from `fields` entirely otherwise, same convention save-recipe uses.
  if (payload.photoBase64) {
    fields.photo_path = await uploadMaterialPhoto(payload.photoBase64, payload.photoExt);
  } else if (payload.removePhoto) {
    fields.photo_path = null;
  }

  let materialId = payload.id;
  if (materialId) {
    const MATERIAL_GONE_MESSAGE = 'This material was deleted or changed elsewhere. Please refresh the Materials catalog and try again.';
    const { data: existing, error: getErr } = await supabase.from('materials').select('photo_path').eq('id', materialId).maybeSingle();
    if (getErr) throw supaFail('save-material: load existing', getErr);
    if (!existing) throw new Error(MATERIAL_GONE_MESSAGE);

    const { data: updated, error: updErr } = await supabase.from('materials').update(fields).eq('id', materialId).select('id');
    if (updErr) throw supaFail('save-material: update materials', updErr);
    if (!updated || updated.length === 0) throw new Error(MATERIAL_GONE_MESSAGE);

    if ((payload.photoBase64 || payload.removePhoto) && existing.photo_path) {
      await deleteMaterialPhoto(existing.photo_path);
    }
  } else {
    const code = await nextMaterialCode();
    const { data: inserted, error: insErr } = await supabase.from('materials').insert({ code, ...fields }).select('id').single();
    if (insErr) throw supaFail('save-material: insert materials', insErr);
    materialId = inserted.id;
  }

  return { id: materialId };
});

// materials has no FK dependents yet (catalog-only phase), so the 23503 catch here is purely
// defensive/future-proofing for whenever a later phase links a material to a recipe -- same
// convention as delete-waste-type/delete-ingredient above.
ipcMain.handle('delete-material', async (e, id) => {
  const { data: existing } = await supabase.from('materials').select('photo_path').eq('id', id).single();
  const { error } = await supabase.from('materials').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') return { success: false, inUse: true };
    throw supaFail('delete-material', error);
  }
  if (existing?.photo_path) await deleteMaterialPhoto(existing.photo_path);
  return { success: true };
});

ipcMain.handle('list-recipes', async () => {
  const { data, error } = await supabase
    .from('recipes')
    .select('id, code, name, category, prepared_by, date_created, quantity_produced')
    .order('id', { ascending: false });
  if (error) throw supaFail('list-recipes', error);
  return data;
});

ipcMain.handle('search-recipes', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('recipes')
    .select('id, code, name, category, quantity_produced')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(25);
  if (error) throw supaFail('search-recipes', error);
  return data;
});

// Shared by Recipe Book (edit form) and Recipe Calculator (scale-and-export) -- both now read
// the same Supabase recipe, so there's no need for the calculator to have its own copy of this.
// Mirrors fetchExtractedRecipeWithIngredients exactly (recipes/recipe_processes/
// recipe_ingredients/ingredients instead of extracted_recipes/extracted_recipe_processes/
// extracted_recipe_ingredients/extracted_ingredients) -- see the multi-process migration
// conversation notes for why Recipe Book's data is process-shaped now too.
async function fetchRecipeWithProcesses(id) {
  const { data: recipe, error: recipeErr } = await supabase.from('recipes').select('*').eq('id', id).single();
  if (recipeErr) {
    if (recipeErr.code === 'PGRST116') return null; // no matching row
    throw supaFail('fetchRecipeWithProcesses: load recipe', recipeErr);
  }

  const { data: processRows, error: procErr } = await supabase
    .from('recipe_processes')
    .select('id, name, method, sort_order, material_id, material_fill_weight_grams')
    .eq('recipe_id', id)
    .order('sort_order');
  if (procErr) throw supaFail('fetchRecipeWithProcesses: load recipe_processes', procErr);

  const processIds = processRows.map(p => p.id);
  let ingredientRows = [];
  let wasteRows = [];
  if (processIds.length) {
    const { data, error: riErr } = await supabase
      .from('recipe_ingredients')
      .select('id, ingredient_id, process_id, quantity, unit, method, sort_order')
      .in('process_id', processIds)
      .order('sort_order');
    if (riErr) throw supaFail('fetchRecipeWithProcesses: load recipe_ingredients', riErr);
    ingredientRows = data;

    const { data: wasteData, error: wasteErr } = await supabase
      .from('recipe_process_wastes')
      .select('id, process_id, waste_type_id, percent, sort_order')
      .in('process_id', processIds)
      .order('sort_order');
    if (wasteErr) throw supaFail('fetchRecipeWithProcesses: load recipe_process_wastes', wasteErr);
    wasteRows = wasteData;
  }

  const ingredientIds = [...new Set(ingredientRows.map(r => r.ingredient_id))];
  let ingredientById = new Map();
  if (ingredientIds.length) {
    const { data: ingredientsData, error: ingErr } = await supabase
      .from('ingredients').select('id, name, default_unit').in('id', ingredientIds);
    if (ingErr) throw supaFail('fetchRecipeWithProcesses: load ingredients', ingErr);
    ingredientById = new Map(ingredientsData.map(i => [i.id, i]));
  }

  // Two-step join against waste_types (name only, never embedded via PostgREST) -- same
  // manual-Map convention ingredientById above uses, not a relationship this file relies on
  // Supabase to resolve for it.
  const wasteTypeIds = [...new Set(wasteRows.map(r => r.waste_type_id))];
  let wasteTypeById = new Map();
  if (wasteTypeIds.length) {
    const { data: wasteTypesData, error: wtErr } = await supabase
      .from('waste_types').select('id, name').in('id', wasteTypeIds);
    if (wtErr) throw supaFail('fetchRecipeWithProcesses: load waste_types', wtErr);
    wasteTypeById = new Map(wasteTypesData.map(w => [w.id, w]));
  }

  const ingredientsByProcess = new Map();
  for (const ri of ingredientRows) {
    const ingredient = {
      id: ri.id,
      ingredient_id: ri.ingredient_id,
      quantity: ri.quantity,
      unit: ri.unit,
      method: ri.method,
      sort_order: ri.sort_order,
      ingredient_name: ingredientById.get(ri.ingredient_id)?.name,
      default_unit: ingredientById.get(ri.ingredient_id)?.default_unit,
    };
    if (!ingredientsByProcess.has(ri.process_id)) ingredientsByProcess.set(ri.process_id, []);
    ingredientsByProcess.get(ri.process_id).push(ingredient);
  }

  const wastesByProcess = new Map();
  for (const rw of wasteRows) {
    const waste = {
      id: rw.id,
      waste_type_id: rw.waste_type_id,
      name: wasteTypeById.get(rw.waste_type_id)?.name,
      percent: rw.percent,
      sort_order: rw.sort_order,
    };
    if (!wastesByProcess.has(rw.process_id)) wastesByProcess.set(rw.process_id, []);
    wastesByProcess.get(rw.process_id).push(waste);
  }

  // Same manual-Map join convention as ingredientById/wasteTypeById above -- material_id is a
  // plain FK column on recipe_processes (see Phase C design notes: 1:1 per process, not a
  // junction table), so this is just resolving it to a display name/code, not a real relationship
  // this file leans on Supabase to embed.
  const materialIds = [...new Set(processRows.map(p => p.material_id).filter(id => id != null))];
  let materialById = new Map();
  if (materialIds.length) {
    const { data: materialsData, error: matErr } = await supabase
      .from('materials').select('id, code, name').in('id', materialIds);
    if (matErr) throw supaFail('fetchRecipeWithProcesses: load materials', matErr);
    materialById = new Map(materialsData.map(m => [m.id, m]));
  }

  const processes = processRows.map(p => ({
    id: p.id,
    name: p.name,
    method: p.method,
    sort_order: p.sort_order,
    ingredients: ingredientsByProcess.get(p.id) || [],
    wastes: wastesByProcess.get(p.id) || [],
    material_id: p.material_id,
    material_name: materialById.get(p.material_id)?.name,
    material_code: materialById.get(p.material_id)?.code,
    material_fill_weight_grams: p.material_fill_weight_grams,
  }));

  return { ...recipe, processes };
}

ipcMain.handle('get-recipe', async (e, id) => fetchRecipeWithProcesses(id));

// In-app export preview ("eye" icon on the Recipe Book list row) -- builds the exact same
// content model buildRecipeSheet itself builds internally (see lib/export.js), but returns it
// as plain JSON instead of writing to a worksheet, so the renderer can render it as HTML/CSS.
// Deliberately never translates and never reads DEFAULT_LABELS overrides -- the preview always
// shows this recipe's original saved English content, regardless of the list screen's own
// export-language picker (translation only happens on an actual export).
ipcMain.handle('preview-recipe', async (e, id) => {
  const full = await fetchRecipeWithProcesses(id);
  const { processes, ...recipe } = full;
  return buildRecipeContentModel(recipe, processes);
});

// Finds the highest existing TTY-##### number and increments it client-side. Unlike the old
// synchronous SQLite transaction, this isn't race-proof against two simultaneous saves -- an
// acceptable tradeoff for a single-user desktop tool without a Postgres sequence/RPC backing it.
async function nextRecipeCode() {
  const { data, error } = await supabase.from('recipes').select('code').like('code', 'TTY-%');
  if (error) throw supaFail('nextRecipeCode', error);
  let max = 0;
  for (const row of data) {
    const n = parseInt(row.code.slice(4), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `TTY-${String(max + 1).padStart(5, '0')}`;
}

// Recipe photos live in a private Supabase Storage bucket (not a DB table) -- photo_path on
// recipes stores just the object path (a fresh UUID per upload, decoupled from the recipe's
// own code/id so a brand-new recipe's photo can be uploaded before the recipe row itself
// exists yet). Every access goes through the app's authenticated session, matching the rest
// of the app's tables -- there's no public URL to leak.
const RECIPE_PHOTOS_BUCKET = 'recipe-photos';

async function uploadRecipePhoto(base64, ext) {
  const path = `${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).upload(path, buffer, { contentType });
  if (error) throw supaFail('uploadRecipePhoto', error);
  return path;
}

async function deleteRecipePhoto(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).remove([path]);
  if (error) console.error('[supabase] deleteRecipePhoto failed (non-fatal):', error.message);
}

ipcMain.handle('get-recipe-photo', async (e, photoPath) => {
  if (!photoPath) return null;
  const { data, error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).download(photoPath);
  if (error) throw supaFail('get-recipe-photo', error);
  const buffer = Buffer.from(await data.arrayBuffer());
  const ext = photoPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

// Mirrors save-extracted-recipe's process/ingredient structure exactly, with two deliberate
// differences: (1) Recipe Book still requires every ingredient row to already carry a real
// ingredientId (validated client-side in saveProcessRecipeForm before this is ever called, same
// as before the multi-process migration) rather than auto-resolving/creating by name -- so
// there's no resolveIngredientId helper here; (2) photo handling stays single photo_path on the
// recipe row itself (uploadRecipePhoto/deleteRecipePhoto), not a photos gallery table.
ipcMain.handle('save-recipe', async (e, payload) => {
  let recipeId = payload.id;
  let code;
  const fields = {
    name: payload.name,
    quantity_produced: payload.quantityProduced || null,
    prepared_by: payload.preparedBy || null,
    category: payload.category || null,
    country_origin: payload.countryOrigin || null,
    yield_notes: payload.yieldNotes || null,
    date_created: payload.dateCreated || null,
    presentation_serving: payload.presentationServing || null,
    comment: payload.comment || null,
    checked_by: payload.checkedBy || null,
    // Grams per portion/piece of the finished product -- optional, numeric (not free text like
    // the rest of this object), already parsed client-side or null; ?? rather than || so a
    // genuine 0 isn't silently coerced to null.
    portion_weight_grams: payload.portionWeightGrams ?? null,
  };

  // photo_path is only ever touched when the chef actually picked a new file or hit "Remove
  // Photo" -- omitted from `fields` entirely otherwise, so an unrelated edit (e.g. fixing a
  // typo in Comment) never disturbs an already-uploaded photo.
  if (payload.photoBase64) {
    fields.photo_path = await uploadRecipePhoto(payload.photoBase64, payload.photoExt);
  } else if (payload.removePhoto) {
    fields.photo_path = null;
  }

  if (recipeId) {
    // maybeSingle(), not single() -- the chef's form can sit open for a while, and someone
    // else (e.g. the owner cleaning up the Recipe Book) can delete this exact row out from
    // under them in the meantime. That's a real "someone else changed this" case, not a
    // PostgREST/JSON-coercion error, so it gets its own message instead of a raw PGRST116.
    const RECIPE_GONE_MESSAGE = 'This recipe was deleted or changed elsewhere. Please refresh the Recipe Book and try again.';
    const { data: existing, error: getErr } = await supabase.from('recipes').select('code, photo_path').eq('id', recipeId).maybeSingle();
    if (getErr) throw supaFail('save-recipe: load existing code', getErr);
    if (!existing) throw new Error(RECIPE_GONE_MESSAGE);
    code = existing.code;

    // .select('id') so a delete landing in the narrow window between the check above and
    // this update is still caught -- Postgrest reports success with zero rows affected rather
    // than an error, which would otherwise look like a successful save that silently did nothing.
    const { data: updated, error: updErr } = await supabase.from('recipes').update(fields).eq('id', recipeId).select('id');
    if (updErr) throw supaFail('save-recipe: update recipes', updErr);
    if (!updated || updated.length === 0) throw new Error(RECIPE_GONE_MESSAGE);

    // Clean up the old Storage object once the new one is safely committed -- replacing or
    // removing a photo shouldn't leave the previous upload orphaned in the bucket forever.
    if ((payload.photoBase64 || payload.removePhoto) && existing.photo_path) {
      await deleteRecipePhoto(existing.photo_path);
    }

    // Deleting the processes cascades to their ingredients (process_id ON DELETE CASCADE) -- no
    // separate recipe_ingredients delete needed.
    const { error: delErr } = await supabase.from('recipe_processes').delete().eq('recipe_id', recipeId);
    if (delErr) throw supaFail('save-recipe: clear old recipe_processes', delErr);
  } else {
    code = await nextRecipeCode();
    // created_at has no DB-side default on Supabase's recipes table (unlike menu_items/
    // ingredients, which do -- add-item and add-ingredient don't need to set it), so it's
    // set explicitly here, insert-only, so editing a recipe later never resets it.
    const { data: inserted, error: insErr } = await supabase
      .from('recipes').insert({ code, ...fields, created_at: new Date().toISOString() }).select('id').single();
    if (insErr) throw supaFail('save-recipe: insert recipes', insErr);
    recipeId = inserted.id;
  }

  // Processes are inserted one at a time (not batched) so each row's returned id is
  // unambiguously matched back to its own payload entry before that process's ingredients are
  // built -- a batch insert's row order isn't worth relying on here, where a mismatch would
  // silently misfile ingredients under the wrong process.
  const rawProcesses = payload.processes || [];
  const insertedProcessIds = [];
  for (let idx = 0; idx < rawProcesses.length; idx++) {
    const proc = rawProcesses[idx];
    const { data: insertedProc, error: procInsErr } = await supabase
      .from('recipe_processes')
      .insert({
        recipe_id: recipeId,
        name: (proc.name || '').trim() || `Process ${idx + 1}`,
        method: proc.method || null,
        sort_order: idx,
        material_id: proc.materialId || null,
        material_fill_weight_grams: proc.materialFillWeightGrams ?? null,
      })
      .select('id')
      .single();
    if (procInsErr) throw supaFail('save-recipe: insert recipe_processes', procInsErr);
    insertedProcessIds.push(insertedProc.id);
  }

  const ingredientRows = [];
  const wasteRows = [];
  for (let pIdx = 0; pIdx < rawProcesses.length; pIdx++) {
    const procIngredients = rawProcesses[pIdx].ingredients || [];
    for (let idx = 0; idx < procIngredients.length; idx++) {
      const ing = procIngredients[idx];
      if (!ing.ingredientId) continue; // saveProcessRecipeForm already blocked save on this
      ingredientRows.push({
        process_id: insertedProcessIds[pIdx],
        ingredient_id: ing.ingredientId,
        quantity: ing.quantity ?? null,
        unit: ing.unit || null,
        method: ing.method || null,
        sort_order: idx,
      });
    }
    const procWastes = rawProcesses[pIdx].wastes || [];
    for (let idx = 0; idx < procWastes.length; idx++) {
      const w = procWastes[idx];
      if (!w.wasteTypeId) continue;
      wasteRows.push({
        process_id: insertedProcessIds[pIdx],
        waste_type_id: w.wasteTypeId,
        percent: w.percent ?? 0,
        sort_order: idx,
      });
    }
  }
  if (ingredientRows.length) {
    const { error: insIngErr } = await supabase.from('recipe_ingredients').insert(ingredientRows);
    if (insIngErr) throw supaFail('save-recipe: insert recipe_ingredients', insIngErr);
  }
  if (wasteRows.length) {
    const { error: insWasteErr } = await supabase.from('recipe_process_wastes').insert(wasteRows);
    if (insWasteErr) throw supaFail('save-recipe: insert recipe_process_wastes', insWasteErr);
  }

  return { id: recipeId, code };
});

ipcMain.handle('delete-recipe', async (e, id) => {
  const { data: existing } = await supabase.from('recipes').select('photo_path').eq('id', id).single();
  // Cascades to recipe_ingredients via process_id ON DELETE CASCADE.
  await supabase.from('recipe_processes').delete().eq('recipe_id', id);
  const { error } = await supabase.from('recipes').delete().eq('id', id);
  if (error) throw supaFail('delete-recipe', error);
  if (existing?.photo_path) await deleteRecipePhoto(existing.photo_path);
  return { success: true };
});

// ---------------------------------------------------------------
// Export-time translation (Recipe Book + Recipe Extractor)
//
// Shared by all 4 export IPC handlers below -- one function, since Recipe Book's recipes are
// process-shaped now too (see conversation notes on the multi-process migration), there's no
// longer a flat-ingredients variant of this to keep separate. Fast path: targetLanguage
// 'English' (or unset) skips translate-recipe entirely and returns the recipe/processes exactly
// as passed in, with DEFAULT_LABELS -- content is always English now (extraction dropped its own
// language picker, see conversation notes), so this is the overwhelmingly common case and adds
// zero latency/cost to it. Only prepared_by/checked_by (a person's name) and quantity_produced
// (usually just a number + an already-cross-language catering abbreviation like "PAX") are
// deliberately left out of the translated fields below -- everything else free-text goes
// through translate-recipe. One translate-recipe call per recipe, even inside a batch export
// (export-recipes/export-extracted-recipes loop several recipeIds) -- simpler and safer than
// combining many recipes into one giant call, at the cost of re-translating the same ~24 fixed
// labels once per recipe rather than once per batch; not worth the added complexity to avoid.
const LABEL_KEYS = Object.keys(DEFAULT_LABELS);

function labelsFromTranslatedTexts(translated) {
  const labels = {};
  LABEL_KEYS.forEach((k, i) => { labels[k] = translated[i]; });
  return labels;
}

async function translateForRecipeExport(targetLanguage, recipe, processes) {
  if (!targetLanguage || targetLanguage === 'English') {
    return { recipe, processes, labels: DEFAULT_LABELS, targetLanguage };
  }
  const texts = [
    ...LABEL_KEYS.map(k => DEFAULT_LABELS[k]),
    recipe.name || '', recipe.category || '', recipe.country_origin || '',
    recipe.comment || '', recipe.presentation_serving || '',
    ...processes.flatMap(proc => [
      proc.name || '', proc.method || '',
      ...(proc.ingredients || []).flatMap(ing => [ing.ingredient_name || '', ing.method || '']),
      // Waste type names are chef-entered catalog labels (e.g. "Baking Waste"), same kind of
      // free text as a process/ingredient name -- translated the same way, not treated as a
      // fixed template label.
      ...(proc.wastes || []).map(w => w.name || ''),
    ]),
  ];
  const translated = await translateTexts({ targetLanguage, texts });

  const labels = labelsFromTranslatedTexts(translated);
  let idx = LABEL_KEYS.length;
  const translatedRecipe = {
    ...recipe,
    name: translated[idx++], category: translated[idx++], country_origin: translated[idx++],
    comment: translated[idx++], presentation_serving: translated[idx++],
  };
  const translatedProcesses = processes.map(proc => ({
    ...proc,
    name: translated[idx++], method: translated[idx++],
    ingredients: (proc.ingredients || []).map(ing => ({
      ...ing, ingredient_name: translated[idx++], method: translated[idx++],
    })),
    wastes: (proc.wastes || []).map(w => ({ ...w, name: translated[idx++] })),
  }));
  return { recipe: translatedRecipe, processes: translatedProcesses, labels, targetLanguage };
}

ipcMain.handle('export-recipes', async (e, { recipeIds, savePath, targetLanguage }) => {
  if (!recipeIds || recipeIds.length === 0) return { success: false };

  if (!savePath) {
    let defaultPath = 'Recipes_Export.xlsx';
    if (recipeIds.length === 1) {
      const { data, error } = await supabase.from('recipes').select('name').eq('id', recipeIds[0]).single();
      if (error) throw supaFail('export-recipes: load recipe name', error);
      defaultPath = `${sanitizeSheetName(data.name)}.xlsx`;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Recipes',
      defaultPath,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  let doneCount = 0;
  await exportRecipes(async (recipeId) => {
    const full = await fetchRecipeWithProcesses(recipeId);
    const { processes, ...recipe } = full;
    // lib/export.js stays DB/Storage-agnostic (per its own comment on exportRecipes) -- the
    // actual image bytes are fetched here and attached as a `photos` array (0 or 1 entries --
    // Recipe Book stays single-photo) onto the plain recipe object buildRecipeSheet expects,
    // same shape Recipe Extractor's photos array already uses. No photo_path just means an
    // empty array, same as no photos at all -- buildRecipeSheet leaves its placeholder box alone.
    recipe.photos = [];
    if (recipe.photo_path) {
      const { data, error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).download(recipe.photo_path);
      if (error) throw supaFail('export-recipes: download photo', error);
      const buffer = Buffer.from(await data.arrayBuffer());
      const ext = recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg';
      recipe.photos = [{ buffer, ext }];
    }
    doneCount++;
    if (targetLanguage && targetLanguage !== 'English') {
      e.sender.send('export-progress', recipeIds.length > 1
        ? `Translating recipe ${doneCount} of ${recipeIds.length}…` : 'Translating recipe…');
    }
    const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
    return { ...translated, codeLabelKey: 'ttyCode' };
  }, recipeIds, savePath, (message) => e.sender.send('export-progress', message));
  return { success: true, path: savePath };
});

// Exports a scaled recipe built entirely in the renderer (Recipe Calculator) -- the recipe
// row itself and its scaling are never read from or written to the database here, `recipe`/
// `processes` arrive as plain data (already carrying photo_path through from the original
// recipe row via the Calculator's spread in renderScaledRecipeResult). The photo bytes still
// have to be fetched from Storage here, same as export-recipes above, since buildRecipeSheet
// only knows how to embed an in-memory photos array, not a storage path.
ipcMain.handle('export-scaled-recipe', async (e, { recipe, processes, savePath, targetLanguage }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Scaled Recipe',
      defaultPath: `${sanitizeSheetName(recipe.name)}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  recipe.photos = [];
  if (recipe.photo_path) {
    const { data, error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).download(recipe.photo_path);
    if (error) throw supaFail('export-scaled-recipe: download photo', error);
    const buffer = Buffer.from(await data.arrayBuffer());
    const ext = recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg';
    recipe.photos = [{ buffer, ext }];
  }

  if (targetLanguage && targetLanguage !== 'English') e.sender.send('export-progress', 'Translating recipe…');
  const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
  await exportScaledRecipe(translated.recipe, translated.processes, savePath, {
    ...translated, codeLabelKey: 'ttyCode', onProgress: (message) => e.sender.send('export-progress', message),
  });
  return { success: true, path: savePath };
});

// ---------------------------------------------------------------
// IPC: extracted ingredients & recipes (Recipe Extractor, Supabase)
//
// Fully separate from ingredients/recipes/recipe_ingredients above -- extracted_ingredients/
// extracted_recipes/extracted_recipe_ingredients are their own tables with no FK relationship
// to the originals (EX-IN-/EX- codes instead of FB-/TTY-), so reviewing an extracted card never
// touches or pollutes the canonical Recipe Book data. This section replaces the old
// "Import Recipe from File" flow that used to write straight into Recipe Book's own tables.
// ---------------------------------------------------------------

// Mirrors nextExtractedRecipeCode below, 'EX-IN-' prefix (own counter, distinct from EX- recipe
// codes), 6-digit padding -- product_code used to be free-typed (almost never actually filled
// in) and is now fully system-managed instead, same as recipe codes always have been.
async function nextExtractedIngredientCode() {
  const { data, error } = await supabase.from('extracted_ingredients').select('product_code').like('product_code', 'EX-IN-%');
  if (error) throw supaFail('nextExtractedIngredientCode', error);
  let max = 0;
  for (const row of data) {
    const n = parseInt(row.product_code.slice(6), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `EX-IN-${String(max + 1).padStart(6, '0')}`;
}

ipcMain.handle('search-extracted-ingredients', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('extracted_ingredients').select('*').ilike('name', `%${q}%`).order('name').limit(25);
  if (error) throw supaFail('search-extracted-ingredients', error);
  return data;
});

ipcMain.handle('add-extracted-ingredient', async (e, { name, defaultUnit }) => {
  const productCode = await nextExtractedIngredientCode();
  const { data, error } = await supabase
    .from('extracted_ingredients')
    .insert({ product_code: productCode, name: name.trim(), default_unit: defaultUnit || null })
    .select('*')
    .single();
  if (error) throw supaFail('add-extracted-ingredient', error);
  return data;
});

ipcMain.handle('list-extracted-ingredients', async () => {
  // Mirrors list-ingredients -- same PostgREST default-limit gotcha applies.
  const { data, error } = await supabase.from('extracted_ingredients').select('*').order('name').limit(5000);
  if (error) throw supaFail('list-extracted-ingredients', error);
  return data;
});

ipcMain.handle('update-extracted-ingredient', async (e, { id, name, defaultUnit }) => {
  const { error } = await supabase
    .from('extracted_ingredients')
    .update({ name: name.trim(), default_unit: defaultUnit || null })
    .eq('id', id);
  if (error) throw supaFail('update-extracted-ingredient', error);
  return { success: true };
});

// extracted_recipe_ingredients.extracted_ingredient_id has no ON DELETE CASCADE, mirroring
// delete-ingredient's FK-violation handling above.
ipcMain.handle('delete-extracted-ingredient', async (e, id) => {
  const { error } = await supabase.from('extracted_ingredients').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') return { success: false, inUse: true };
    throw supaFail('delete-extracted-ingredient', error);
  }
  return { success: true };
});

ipcMain.handle('list-extracted-recipes', async () => {
  const { data, error } = await supabase
    .from('extracted_recipes')
    .select('id, code, name, category, prepared_by, date_created, quantity_produced')
    .order('id', { ascending: false });
  if (error) throw supaFail('list-extracted-recipes', error);
  return data;
});

// Mirrors search-recipes -- powers Recipe Calculator's autocomplete when "Recipe Extractor" is
// the selected source.
ipcMain.handle('search-extracted-recipes', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('extracted_recipes')
    .select('id, code, name, category, quantity_produced')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(25);
  if (error) throw supaFail('search-extracted-recipes', error);
  return data;
});

// Mirrors fetchRecipeWithProcesses above, against the extracted_* tables.
async function fetchExtractedRecipeWithIngredients(id) {
  const { data: recipe, error: recipeErr } = await supabase.from('extracted_recipes').select('*').eq('id', id).single();
  if (recipeErr) {
    if (recipeErr.code === 'PGRST116') return null; // no matching row
    throw supaFail('fetchExtractedRecipeWithIngredients: load recipe', recipeErr);
  }

  const { data: processRows, error: procErr } = await supabase
    .from('extracted_recipe_processes')
    .select('id, name, method, sort_order, material_id, material_fill_weight_grams')
    .eq('extracted_recipe_id', id)
    .order('sort_order');
  if (procErr) throw supaFail('fetchExtractedRecipeWithIngredients: load extracted_recipe_processes', procErr);

  const processIds = processRows.map(p => p.id);
  let ingredientRows = [];
  let wasteRows = [];
  if (processIds.length) {
    const { data, error: riErr } = await supabase
      .from('extracted_recipe_ingredients')
      .select('id, extracted_ingredient_id, extracted_recipe_process_id, quantity, unit, method, sort_order')
      .in('extracted_recipe_process_id', processIds)
      .order('sort_order');
    if (riErr) throw supaFail('fetchExtractedRecipeWithIngredients: load extracted_recipe_ingredients', riErr);
    ingredientRows = data;

    const { data: wasteData, error: wasteErr } = await supabase
      .from('extracted_recipe_process_wastes')
      .select('id, process_id, waste_type_id, percent, sort_order')
      .in('process_id', processIds)
      .order('sort_order');
    if (wasteErr) throw supaFail('fetchExtractedRecipeWithIngredients: load extracted_recipe_process_wastes', wasteErr);
    wasteRows = wasteData;
  }

  const ingredientIds = [...new Set(ingredientRows.map(r => r.extracted_ingredient_id))];
  let ingredientById = new Map();
  if (ingredientIds.length) {
    const { data: ingredientsData, error: ingErr } = await supabase
      .from('extracted_ingredients').select('id, name, default_unit').in('id', ingredientIds);
    if (ingErr) throw supaFail('fetchExtractedRecipeWithIngredients: load extracted_ingredients', ingErr);
    ingredientById = new Map(ingredientsData.map(i => [i.id, i]));
  }

  const wasteTypeIds = [...new Set(wasteRows.map(r => r.waste_type_id))];
  let wasteTypeById = new Map();
  if (wasteTypeIds.length) {
    const { data: wasteTypesData, error: wtErr } = await supabase
      .from('waste_types').select('id, name').in('id', wasteTypeIds);
    if (wtErr) throw supaFail('fetchExtractedRecipeWithIngredients: load waste_types', wtErr);
    wasteTypeById = new Map(wasteTypesData.map(w => [w.id, w]));
  }

  const ingredientsByProcess = new Map();
  for (const ri of ingredientRows) {
    const ingredient = {
      id: ri.id,
      ingredient_id: ri.extracted_ingredient_id,
      quantity: ri.quantity,
      unit: ri.unit,
      method: ri.method,
      sort_order: ri.sort_order,
      ingredient_name: ingredientById.get(ri.extracted_ingredient_id)?.name,
      default_unit: ingredientById.get(ri.extracted_ingredient_id)?.default_unit,
    };
    if (!ingredientsByProcess.has(ri.extracted_recipe_process_id)) ingredientsByProcess.set(ri.extracted_recipe_process_id, []);
    ingredientsByProcess.get(ri.extracted_recipe_process_id).push(ingredient);
  }

  const wastesByProcess = new Map();
  for (const rw of wasteRows) {
    const waste = {
      id: rw.id,
      waste_type_id: rw.waste_type_id,
      name: wasteTypeById.get(rw.waste_type_id)?.name,
      percent: rw.percent,
      sort_order: rw.sort_order,
    };
    if (!wastesByProcess.has(rw.process_id)) wastesByProcess.set(rw.process_id, []);
    wastesByProcess.get(rw.process_id).push(waste);
  }

  const materialIds = [...new Set(processRows.map(p => p.material_id).filter(id => id != null))];
  let materialById = new Map();
  if (materialIds.length) {
    const { data: materialsData, error: matErr } = await supabase
      .from('materials').select('id, code, name').in('id', materialIds);
    if (matErr) throw supaFail('fetchExtractedRecipeWithIngredients: load materials', matErr);
    materialById = new Map(materialsData.map(m => [m.id, m]));
  }

  const processes = processRows.map(p => ({
    id: p.id,
    name: p.name,
    method: p.method,
    sort_order: p.sort_order,
    ingredients: ingredientsByProcess.get(p.id) || [],
    wastes: wastesByProcess.get(p.id) || [],
    material_id: p.material_id,
    material_name: materialById.get(p.material_id)?.name,
    material_code: materialById.get(p.material_id)?.code,
    material_fill_weight_grams: p.material_fill_weight_grams,
  }));

  const { data: photoRows, error: photoErr } = await supabase
    .from('extracted_recipe_photos')
    .select('id, photo_path, sort_order')
    .eq('extracted_recipe_id', id)
    .order('sort_order');
  if (photoErr) throw supaFail('fetchExtractedRecipeWithIngredients: load extracted_recipe_photos', photoErr);

  return { ...recipe, processes, photos: photoRows };
}

ipcMain.handle('get-extracted-recipe', async (e, id) => fetchExtractedRecipeWithIngredients(id));

// Recipe Extractor's counterpart to preview-recipe above -- see its comment.
ipcMain.handle('preview-extracted-recipe', async (e, id) => {
  const full = await fetchExtractedRecipeWithIngredients(id);
  const { processes, photos, ...recipe } = full;
  return buildRecipeContentModel({ ...recipe, photos }, processes);
});

// Mirrors nextRecipeCode above, 'EX-' prefix, own table -- independent counter from TTY-.
async function nextExtractedRecipeCode() {
  const { data, error } = await supabase.from('extracted_recipes').select('code').like('code', 'EX-%');
  if (error) throw supaFail('nextExtractedRecipeCode', error);
  let max = 0;
  for (const row of data) {
    const n = parseInt(row.code.slice(3), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `EX-${String(max + 1).padStart(5, '0')}`;
}

// Own private Storage bucket, decoupled from recipe-photos -- same access pattern (private,
// authenticated-only, fresh UUID path per upload).
const EXTRACTED_RECIPE_PHOTOS_BUCKET = 'extracted-recipe-photos';

async function uploadExtractedRecipePhoto(base64, ext) {
  const path = `${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage.from(EXTRACTED_RECIPE_PHOTOS_BUCKET).upload(path, buffer, { contentType });
  if (error) throw supaFail('uploadExtractedRecipePhoto', error);
  return path;
}

async function deleteExtractedRecipePhoto(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(EXTRACTED_RECIPE_PHOTOS_BUCKET).remove([path]);
  if (error) console.error('[supabase] deleteExtractedRecipePhoto failed (non-fatal):', error.message);
}

async function extractedRecipePhotoDataUrl(photoPath) {
  const { data, error } = await supabase.storage.from(EXTRACTED_RECIPE_PHOTOS_BUCKET).download(photoPath);
  if (error) throw supaFail('extractedRecipePhotoDataUrl', error);
  const buffer = Buffer.from(await data.arrayBuffer());
  const ext = photoPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// Downloads every photo's bytes (in gallery order) for embedding into an export workbook --
// shared by export-extracted-recipes (batch export) and export-scaled-extracted-recipe (Recipe
// Calculator), both of which need the full set, not just the first, so
// buildRecipePhotosSheet can be built when there are 2+.
async function downloadExtractedRecipePhotos(photoRows) {
  const photos = [];
  for (const p of photoRows || []) {
    const { data, error } = await supabase.storage.from(EXTRACTED_RECIPE_PHOTOS_BUCKET).download(p.photo_path);
    if (error) throw supaFail('downloadExtractedRecipePhotos', error);
    photos.push({
      buffer: Buffer.from(await data.arrayBuffer()),
      ext: p.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg',
    });
  }
  return photos;
}

// Batched (plural) rather than one call per photo -- the gallery can hold up to 10 existing
// photos to preview on a single form open, and 10 sequential IPC/Storage round trips would be
// the same N+1 pattern already flagged elsewhere in this app (see conversation notes on Build
// Menu). Order of the returned array matches the order of photoPaths.
ipcMain.handle('get-extracted-recipe-photos', async (e, photoPaths) => {
  if (!photoPaths || photoPaths.length === 0) return [];
  return Promise.all(photoPaths.map(extractedRecipePhotoDataUrl));
});

ipcMain.handle('save-extracted-recipe', async (e, payload) => {
  const rawPhotos = payload.photos || [];
  if (rawPhotos.length > 10) throw new Error('A recipe can have at most 10 photos.');

  let recipeId = payload.id;
  let code;
  const fields = {
    name: payload.name,
    quantity_produced: payload.quantityProduced || null,
    prepared_by: payload.preparedBy || null,
    category: payload.category || null,
    country_origin: payload.countryOrigin || null,
    yield_notes: payload.yieldNotes || null,
    date_created: payload.dateCreated || null,
    presentation_serving: payload.presentationServing || null,
    comment: payload.comment || null,
    checked_by: payload.checkedBy || null,
    // Grams per portion/piece of the finished product -- optional, numeric (not free text like
    // the rest of this object), already parsed client-side or null; ?? rather than || so a
    // genuine 0 isn't silently coerced to null.
    portion_weight_grams: payload.portionWeightGrams ?? null,
  };

  if (recipeId) {
    const RECIPE_GONE_MESSAGE = 'This recipe was deleted or changed elsewhere. Please refresh the Recipe Extractor and try again.';
    const { data: existing, error: getErr } = await supabase.from('extracted_recipes').select('code').eq('id', recipeId).maybeSingle();
    if (getErr) throw supaFail('save-extracted-recipe: load existing code', getErr);
    if (!existing) throw new Error(RECIPE_GONE_MESSAGE);
    code = existing.code;

    const { data: updated, error: updErr } = await supabase.from('extracted_recipes').update(fields).eq('id', recipeId).select('id');
    if (updErr) throw supaFail('save-extracted-recipe: update extracted_recipes', updErr);
    if (!updated || updated.length === 0) throw new Error(RECIPE_GONE_MESSAGE);

    // Deleting the processes cascades to their ingredients (extracted_recipe_process_id ON
    // DELETE CASCADE) -- no separate extracted_recipe_ingredients delete needed.
    const { error: delErr } = await supabase.from('extracted_recipe_processes').delete().eq('extracted_recipe_id', recipeId);
    if (delErr) throw supaFail('save-extracted-recipe: clear old extracted_recipe_processes', delErr);
  } else {
    code = await nextExtractedRecipeCode();
    const { data: inserted, error: insErr } = await supabase
      .from('extracted_recipes').insert({ code, ...fields }).select('id').single();
    if (insErr) throw supaFail('save-extracted-recipe: insert extracted_recipes', insErr);
    recipeId = inserted.id;
  }

  // Recipe Extractor doesn't force the chef to manually confirm every ingredient the way
  // Recipe Book does -- any row that isn't already linked (typed by hand, or an extraction
  // result that didn't get an exact match) is resolved here instead: same case-insensitive
  // EXACT-match lookup extract-recipe-for-extractor uses, reusing an existing EX-IN- row if one
  // matches or creating a new one otherwise. Resolved once per unique name across every
  // process (not just within one) so the same new name repeated in two processes -- e.g.
  // "Sugar" in both a base and a topping -- doesn't create two duplicate rows.
  const resolvedIdByName = new Map();
  async function resolveIngredientId(name) {
    const key = name.toLowerCase();
    if (resolvedIdByName.has(key)) return resolvedIdByName.get(key);
    const { data: existing, error: findErr } = await supabase
      .from('extracted_ingredients').select('id').ilike('name', name).limit(1);
    if (findErr) throw supaFail('save-extracted-recipe: match extracted_ingredients', findErr);
    let id;
    if (existing && existing.length > 0) {
      id = existing[0].id;
    } else {
      // 'G' matches the default used when adding a new ingredient inline from the autocomplete.
      const productCode = await nextExtractedIngredientCode();
      const { data: created, error: createErr } = await supabase
        .from('extracted_ingredients').insert({ product_code: productCode, name, default_unit: 'G' }).select('id').single();
      if (createErr) throw supaFail('save-extracted-recipe: create extracted_ingredients', createErr);
      id = created.id;
    }
    resolvedIdByName.set(key, id);
    return id;
  }

  // Processes are inserted one at a time (not batched) so each row's returned id is
  // unambiguously matched back to its own payload entry before that process's ingredients are
  // built -- a batch insert's row order isn't worth relying on here, where a mismatch would
  // silently misfile ingredients under the wrong process.
  const rawProcesses = payload.processes || [];
  const insertedProcessIds = [];
  for (let idx = 0; idx < rawProcesses.length; idx++) {
    const proc = rawProcesses[idx];
    const { data: insertedProc, error: procInsErr } = await supabase
      .from('extracted_recipe_processes')
      .insert({
        extracted_recipe_id: recipeId,
        name: (proc.name || '').trim() || `Process ${idx + 1}`,
        method: proc.method || null,
        sort_order: idx,
        material_id: proc.materialId || null,
        material_fill_weight_grams: proc.materialFillWeightGrams ?? null,
      })
      .select('id')
      .single();
    if (procInsErr) throw supaFail('save-extracted-recipe: insert extracted_recipe_processes', procInsErr);
    insertedProcessIds.push(insertedProc.id);
  }

  const ingredientRows = [];
  const wasteRows = [];
  for (let pIdx = 0; pIdx < rawProcesses.length; pIdx++) {
    const procIngredients = rawProcesses[pIdx].ingredients || [];
    for (let idx = 0; idx < procIngredients.length; idx++) {
      const ing = procIngredients[idx];
      const name = (ing.name || '').trim();
      if (!ing.ingredientId && !name) continue;
      const ingredientId = ing.ingredientId || await resolveIngredientId(name);
      ingredientRows.push({
        extracted_recipe_process_id: insertedProcessIds[pIdx],
        extracted_ingredient_id: ingredientId,
        quantity: ing.quantity ?? null,
        unit: ing.unit || null,
        method: ing.method || null,
        sort_order: idx,
      });
    }
    const procWastes = rawProcesses[pIdx].wastes || [];
    for (let idx = 0; idx < procWastes.length; idx++) {
      const w = procWastes[idx];
      if (!w.wasteTypeId) continue;
      wasteRows.push({
        process_id: insertedProcessIds[pIdx],
        waste_type_id: w.wasteTypeId,
        percent: w.percent ?? 0,
        sort_order: idx,
      });
    }
  }
  if (ingredientRows.length) {
    const { error: insIngErr } = await supabase.from('extracted_recipe_ingredients').insert(ingredientRows);
    if (insIngErr) throw supaFail('save-extracted-recipe: insert extracted_recipe_ingredients', insIngErr);
  }
  if (wasteRows.length) {
    const { error: insWasteErr } = await supabase.from('extracted_recipe_process_wastes').insert(wasteRows);
    if (insWasteErr) throw supaFail('save-extracted-recipe: insert extracted_recipe_process_wastes', insWasteErr);
  }

  // Photos: same clear-and-reinsert convention as processes above, except each row also has a
  // Storage object behind it -- an existing path missing from the new payload (the chef removed
  // that thumbnail) gets purged from Storage too, not just dropped from the DB. Each payload
  // entry is either { existingPhotoPath } (kept, no re-upload) or { photoBase64, photoExt } (a
  // freshly added photo, uploaded here).
  const { data: oldPhotoRows, error: oldPhotoErr } = await supabase
    .from('extracted_recipe_photos').select('photo_path').eq('extracted_recipe_id', recipeId);
  if (oldPhotoErr) throw supaFail('save-extracted-recipe: load existing extracted_recipe_photos', oldPhotoErr);

  const keptPaths = new Set(rawPhotos.filter(p => p.existingPhotoPath).map(p => p.existingPhotoPath));
  for (const old of oldPhotoRows || []) {
    if (!keptPaths.has(old.photo_path)) await deleteExtractedRecipePhoto(old.photo_path);
  }

  const { error: delPhotoErr } = await supabase.from('extracted_recipe_photos').delete().eq('extracted_recipe_id', recipeId);
  if (delPhotoErr) throw supaFail('save-extracted-recipe: clear old extracted_recipe_photos', delPhotoErr);

  const newPhotoRows = [];
  for (let idx = 0; idx < rawPhotos.length; idx++) {
    const p = rawPhotos[idx];
    const photoPath = p.existingPhotoPath || await uploadExtractedRecipePhoto(p.photoBase64, p.photoExt);
    newPhotoRows.push({ extracted_recipe_id: recipeId, photo_path: photoPath, sort_order: idx });
  }
  if (newPhotoRows.length) {
    const { error: insPhotoErr } = await supabase.from('extracted_recipe_photos').insert(newPhotoRows);
    if (insPhotoErr) throw supaFail('save-extracted-recipe: insert extracted_recipe_photos', insPhotoErr);
  }

  return { id: recipeId, code };
});

ipcMain.handle('delete-extracted-recipe', async (e, id) => {
  // Fetched before the recipe row is deleted -- extracted_recipe_photos rows cascade away with
  // it (ON DELETE CASCADE), but the Storage objects behind them don't, so their paths need to
  // be known up front to clean those up afterward.
  const { data: photoRows } = await supabase.from('extracted_recipe_photos').select('photo_path').eq('extracted_recipe_id', id);
  // Cascades to extracted_recipe_ingredients via extracted_recipe_process_id ON DELETE CASCADE.
  await supabase.from('extracted_recipe_processes').delete().eq('extracted_recipe_id', id);
  const { error } = await supabase.from('extracted_recipes').delete().eq('id', id);
  if (error) throw supaFail('delete-extracted-recipe', error);
  for (const p of photoRows || []) await deleteExtractedRecipePhoto(p.photo_path);
  return { success: true };
});

ipcMain.handle('export-extracted-recipes', async (e, { recipeIds, savePath, targetLanguage }) => {
  if (!recipeIds || recipeIds.length === 0) return { success: false };

  if (!savePath) {
    let defaultPath = 'Extracted_Recipes_Export.xlsx';
    if (recipeIds.length === 1) {
      const { data, error } = await supabase.from('extracted_recipes').select('name').eq('id', recipeIds[0]).single();
      if (error) throw supaFail('export-extracted-recipes: load recipe name', error);
      defaultPath = `${sanitizeSheetName(data.name)}.xlsx`;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Extracted Recipes',
      defaultPath,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  // buildRecipeSheet renders each process as its own labeled section (name heading + its own
  // ingredient table + its own Method block), not a merged flat list -- shared with Recipe
  // Book's own export-recipes handler above (see lib/export.js's own comment on exportRecipes).
  let extractorDoneCount = 0;
  await exportRecipes(async (recipeId) => {
    const full = await fetchExtractedRecipeWithIngredients(recipeId);
    const { processes, photos, ...recipe } = full;
    recipe.photos = await downloadExtractedRecipePhotos(photos);
    extractorDoneCount++;
    if (targetLanguage && targetLanguage !== 'English') {
      e.sender.send('export-progress', recipeIds.length > 1
        ? `Translating recipe ${extractorDoneCount} of ${recipeIds.length}…` : 'Translating recipe…');
    }
    const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
    return { ...translated, codeLabelKey: 'exCode' };
  }, recipeIds, savePath, (message) => e.sender.send('export-progress', message));
  return { success: true, path: savePath };
});

// Recipe Calculator's EX- counterpart to export-scaled-recipe above -- `recipe`/`processes`
// arrive already scaled (Recipe Calculator's own multiplier math, reused unchanged from Book's
// path), nothing here recomputes quantities. `recipeId` is only used to look up this recipe's
// *original, unscaled* photos fresh from extracted_recipe_photos -- photos aren't a quantity, so
// there's nothing to scale, same as export-scaled-recipe never scaling recipe.photo_path either.
ipcMain.handle('export-scaled-extracted-recipe', async (e, { recipeId, recipe, processes, savePath, targetLanguage }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Scaled Recipe',
      defaultPath: `${sanitizeSheetName(recipe.name)}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  const { data: photoRows, error: photoErr } = await supabase
    .from('extracted_recipe_photos').select('photo_path').eq('extracted_recipe_id', recipeId).order('sort_order');
  if (photoErr) throw supaFail('export-scaled-extracted-recipe: load extracted_recipe_photos', photoErr);
  recipe.photos = await downloadExtractedRecipePhotos(photoRows);

  if (targetLanguage && targetLanguage !== 'English') e.sender.send('export-progress', 'Translating recipe…');
  const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
  await exportScaledRecipe(translated.recipe, translated.processes, savePath, {
    ...translated, codeLabelKey: 'exCode', onProgress: (message) => e.sender.send('export-progress', message),
  });
  return { success: true, path: savePath };
});

// "Upload Recipe" on the Recipe Extractor screen -- never throws across IPC (a failed/declined
// extraction must never block filling the form in manually), so every outcome comes back as a
// plain { success, ... } result. On success, maps the model's raw extracted fields onto the
// shape renderRecipeFormView seeds a form from (see state.extractor.importedRecipe in
// renderer.js): one or more named processes, each carrying its own ingredients + method. Each
// extracted ingredient name (across every process) is checked against extracted_ingredients for
// a case-insensitive EXACT match (not fuzzy -- a wrong silent merge is worse than an extra
// click) and pre-linked via ingredientId when found; anything short of exact is left null and
// gets auto-resolved/created on save instead (see save-extracted-recipe).
// Mirrors the caps enforced client-side (renderer.js) and independently in the Edge Function --
// checked again here too, since this handler is a boundary a bug in either of those two places
// shouldn't be able to bypass.
const MAX_EXTRACT_FILES = 10;
const MAX_EXTRACT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACT_TOTAL_BYTES = 20 * 1024 * 1024;

ipcMain.handle('extract-recipe-for-extractor', async (e, { files }) => {
  if (!files || files.length === 0) return { success: false, error: 'No files provided' };
  if (files.length > MAX_EXTRACT_FILES) return { success: false, error: `Too many files (max ${MAX_EXTRACT_FILES})` };
  let totalBytes = 0;
  for (const f of files) {
    const bytes = Buffer.from(f.base64 || '', 'base64').length;
    if (bytes > MAX_EXTRACT_FILE_BYTES) return { success: false, error: `A file is larger than ${MAX_EXTRACT_FILE_BYTES / 1024 / 1024}MB` };
    totalBytes += bytes;
  }
  if (totalBytes > MAX_EXTRACT_TOTAL_BYTES) return { success: false, error: `Combined file size exceeds ${MAX_EXTRACT_TOTAL_BYTES / 1024 / 1024}MB` };

  try {
    const extracted = await extractRecipeFromFile({ files });
    const extractedProcesses = extracted.processes || [];

    const ingredientIdByName = new Map();
    const namesToMatch = [...new Set(
      extractedProcesses.flatMap(p => (p.ingredients || []).map(ing => (ing.name || '').trim())).filter(Boolean)
    )];
    for (const name of namesToMatch) {
      const { data, error } = await supabase
        .from('extracted_ingredients').select('id, name').ilike('name', name).limit(1);
      if (error) throw supaFail('extract-recipe-for-extractor: match extracted_ingredients', error);
      if (data && data.length > 0) ingredientIdByName.set(name.toLowerCase(), data[0].id);
    }

    const recipe = {
      name: extracted.name || '',
      quantity_produced: extracted.quantity_produced || '',
      prepared_by: extracted.prepared_by || '',
      category: extracted.category || '',
      country_origin: extracted.country_origin || '',
      date_created: extracted.date_created || '',
      comment: extracted.comment || '',
      presentation_serving: (extracted.presentation_serving_steps || []).join('\n'),
      processes: extractedProcesses.map(proc => ({
        name: proc.name || '',
        method: (proc.method_steps || []).join('\n'),
        ingredients: (proc.ingredients || []).map(ing => {
          const name = (ing.name || '').trim();
          return {
            ingredientId: ingredientIdByName.get(name.toLowerCase()) || null,
            name,
            quantity: ing.quantity,
            unit: ing.unit || '',
            method: ing.method || '',
          };
        }),
      })),
    };
    return { success: true, recipe };
  } catch (err) {
    console.error('[extract-recipe-for-extractor] failed:', err);
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------
// IPC: menu generation (Supabase: generated_menus/menu_days/menu_day_items/menu_slots,
// via lib/generator.js's MenuGenerator -- shared by Generate Menu, Build Menu, History, and
// Export All Sections, all converted together since they share the same no-repeat scoring
// history and the same generated-menu records; see conversation notes on why splitting them
// across two databases would silently degrade duplicate-avoidance and fragment History)
// ---------------------------------------------------------------
ipcMain.handle('generate-menu', async (e, { sectionCode, label, startDate, numWeekdays, createdBy }) => {
  const gen = new MenuGenerator();
  const { menuId, resultDays } = await gen.generate(sectionCode, label, new Date(startDate), numWeekdays, null, createdBy);
  return { menuId, resultDays, warnings: gen.warnings };
});

ipcMain.handle('get-latest-generated-menu', async (e, sectionCode) => {
  const section = getSectionByCode(sectionCode);
  if (!section) return null;
  const { data, error } = await supabase
    .from('generated_menus').select('*').eq('section_id', section.id)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw supaFail('get-latest-generated-menu', error);
  return data[0] || null;
});

// History is unified (not filtered by section) -- rows sharing a batch_id (set by
// generate-and-export-all / Build Menu's export, both of which save all 5 sections in one
// user action) collapse into a single "All Sections" entry. menuIds always lists every real
// generated_menus.id an entry represents, so the renderer can expand a selection back to raw
// ids for delete-generated-menus (unchanged -- it just deletes whatever ids it's given)
// without this handler needing any batch-aware delete logic of its own.
ipcMain.handle('list-generated-menus', async () => {
  const { data, error } = await supabase
    .from('generated_menus').select('*').order('created_at', { ascending: false });
  if (error) throw supaFail('list-generated-menus', error);

  const entries = [];
  const seenBatches = new Set();
  for (const row of data) {
    if (row.batch_id) {
      if (seenBatches.has(row.batch_id)) continue;
      seenBatches.add(row.batch_id);
      const batchRows = data.filter(r => r.batch_id === row.batch_id);
      // menuIdsBySection lets the renderer call export-all-sections-to-excel directly on a
      // batch entry (same handler Export All Sections/Build Menu's own export already use)
      // without needing a combined detail view to drive it from.
      const menuIdsBySection = {};
      for (const r of batchRows) {
        const code = getSectionById(r.section_id)?.code;
        if (code) menuIdsBySection[code] = r.id;
      }
      entries.push({
        id: String(row.batch_id),
        isBatch: true,
        label: row.label,
        start_date: row.start_date,
        status: row.status,
        created_by: row.created_by,
        tag: 'all_sections',
        menuIds: batchRows.map(r => r.id),
        menuIdsBySection,
      });
    } else {
      const section = getSectionById(row.section_id);
      entries.push({
        id: String(row.id),
        isBatch: false,
        label: row.label,
        start_date: row.start_date,
        status: row.status,
        created_by: row.created_by,
        tag: section?.name || '—',
        menuIds: [row.id],
      });
    }
  }
  return entries;
});

ipcMain.handle('get-generated-menu-detail', async (e, generatedMenuId) => {
  const { data: menu, error: menuErr } = await supabase
    .from('generated_menus').select('section_id').eq('id', generatedMenuId).single();
  if (menuErr) throw supaFail('get-generated-menu-detail: load generated_menus', menuErr);

  const { data: days, error: daysErr } = await supabase
    .from('menu_days').select('*').eq('generated_menu_id', generatedMenuId).order('menu_date');
  if (daysErr) throw supaFail('get-generated-menu-detail: load menu_days', daysErr);

  const dayIds = days.map(d => d.id);
  let dayItemRows = [];
  if (dayIds.length) {
    const { data, error } = await supabase
      .from('menu_day_items').select('id, item_id, menu_day_id, slot_id').in('menu_day_id', dayIds);
    if (error) throw supaFail('get-generated-menu-detail: load menu_day_items', error);
    dayItemRows = data;
  }

  const itemIds = [...new Set(dayItemRows.map(r => r.item_id))];
  let itemById = new Map();
  if (itemIds.length) {
    const { data: items, error: itemsErr } = await supabase
      .from('menu_items').select('id, name, category_id').in('id', itemIds);
    if (itemsErr) throw supaFail('get-generated-menu-detail: load menu_items', itemsErr);
    itemById = new Map(items.map(i => [i.id, i]));
  }

  // Category for display MUST come from the slot the item was actually placed into for this
  // menu, not the item's own catalog category_id -- see the matching note in
  // fetchGeneratedMenuExportData for why (forced cross-category picks like Staff Main Dish's
  // shared KG-LP/MS-UP Lunch Main items would otherwise resolve to the wrong category code).
  const { data: slotRows, error: slotErr } = await supabase
    .from('menu_slots').select('id, category_id').eq('section_id', menu.section_id);
  if (slotErr) throw supaFail('get-generated-menu-detail: load menu_slots', slotErr);
  const slotCategoryById = new Map(slotRows.map(s => [s.id, s.category_id]));

  const itemsByDay = new Map();
  for (const row of dayItemRows) {
    const item = itemById.get(row.item_id);
    if (!item) continue;
    const catId = slotCategoryById.get(row.slot_id) ?? item.category_id;
    const cat = getCategoryById(catId);
    const enriched = {
      menu_day_item_id: row.id, item_id: row.item_id, name: item.name,
      category_code: cat?.code, category_name: cat?.name, _sort: cat?.sort_order ?? 0,
    };
    if (!itemsByDay.has(row.menu_day_id)) itemsByDay.set(row.menu_day_id, []);
    itemsByDay.get(row.menu_day_id).push(enriched);
  }

  return days.map(d => ({
    ...d,
    items: (itemsByDay.get(d.id) || [])
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, ...rest }) => rest),
  }));
});

ipcMain.handle('delete-generated-menus', async (e, menuIds) => {
  // Delete children explicitly rather than relying on an ON DELETE CASCADE existing on the
  // Supabase side -- same reasoning as delete-item/delete-recipe in earlier stages.
  const { data: days, error: daysErr } = await supabase
    .from('menu_days').select('id').in('generated_menu_id', menuIds);
  if (daysErr) throw supaFail('delete-generated-menus: load menu_days', daysErr);
  const dayIds = days.map(d => d.id);
  if (dayIds.length) {
    const { error } = await supabase.from('menu_day_items').delete().in('menu_day_id', dayIds);
    if (error) throw supaFail('delete-generated-menus: delete menu_day_items', error);
  }
  const { error: daysDelErr } = await supabase.from('menu_days').delete().in('generated_menu_id', menuIds);
  if (daysDelErr) throw supaFail('delete-generated-menus: delete menu_days', daysDelErr);
  const { error: menusDelErr } = await supabase.from('generated_menus').delete().in('id', menuIds);
  if (menusDelErr) throw supaFail('delete-generated-menus: delete generated_menus', menusDelErr);
  return { success: true };
});

// Not currently wired into any renderer view (no swap UI exists yet), but converted for
// consistency since it operates on the same now-Supabase menu_day_items/menu_items tables.
ipcMain.handle('swap-menu-item', async (e, { menuDayItemId, newItemId }) => {
  const { error } = await supabase
    .from('menu_day_items').update({ item_id: newItemId, is_manual_override: 1 }).eq('id', menuDayItemId);
  if (error) throw supaFail('swap-menu-item', error);
  return { success: true };
});

ipcMain.handle('get-eligible-swap-items', async (e, { sectionCode, categoryCode }) => {
  const section = getSectionByCode(sectionCode);
  const category = getCategoryByCode(categoryCode);
  const items = await eligibleItemsSupabase(section.id, category.id);
  return items.map(it => ({ id: it.id, name: it.name })).sort((a, b) => a.name.localeCompare(b.name));
});

// PostgREST caps a single response at 1000 rows by default; this pages through .range() until
// a page comes back short, mirroring lib/generator.js's fetchAllRows (not shared/exported from
// there, since these two modules otherwise have no runtime dependency on each other).
// buildQuery() must return a *fresh* query builder each call.
async function fetchAllRowsMain(buildQuery) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ---------------------------------------------------------------
// IPC: export to Excel
// ---------------------------------------------------------------
// Assembles everything lib/export.js's buildSchoolSheet/buildStaffSheet/buildCeoSheet need
// for one generated menu: Supabase's generated_menus/menu_days/menu_day_items/menu_items/
// item_portions, pre-joined with the cached sections/age_groups/categories/meal_periods
// reference data from lib/referenceData.js.
async function fetchGeneratedMenuExportData(generatedMenuId) {
  const { data: menu, error: menuErr } = await supabase
    .from('generated_menus').select('*').eq('id', generatedMenuId).single();
  if (menuErr) throw supaFail('fetchGeneratedMenuExportData: load generated_menus', menuErr);

  const section = getSectionById(menu.section_id);
  const ageGroups = getAgeGroupsForSection(section.id);

  const { data: days, error: daysErr } = await supabase
    .from('menu_days').select('*').eq('generated_menu_id', generatedMenuId).order('menu_date');
  if (daysErr) throw supaFail('fetchGeneratedMenuExportData: load menu_days', daysErr);

  const dayIds = days.map(d => d.id);
  let dayItemRows = [];
  if (dayIds.length) {
    const { data, error } = await supabase.from('menu_day_items').select('*').in('menu_day_id', dayIds);
    if (error) throw supaFail('fetchGeneratedMenuExportData: load menu_day_items', error);
    dayItemRows = data;
  }

  const itemIds = [...new Set(dayItemRows.map(r => r.item_id))];
  const itemById = new Map();
  const portionsByItem = new Map(); // item_id -> Map(age_group_id -> {unit, quantity})
  if (itemIds.length) {
    const { data: items, error: itemsErr } = await supabase
      .from('menu_items').select('id, name, rc_code, is_daily_repeating, category_id').in('id', itemIds);
    if (itemsErr) throw supaFail('fetchGeneratedMenuExportData: load menu_items', itemsErr);
    items.forEach(i => itemById.set(i.id, i));

    const { data: portions, error: portErr } = await supabase
      .from('item_portions').select('item_id, age_group_id, unit, quantity').in('item_id', itemIds);
    if (portErr) throw supaFail('fetchGeneratedMenuExportData: load item_portions', portErr);
    for (const p of portions) {
      if (!portionsByItem.has(p.item_id)) portionsByItem.set(p.item_id, new Map());
      portionsByItem.get(p.item_id).set(p.age_group_id, { unit: p.unit, quantity: p.quantity });
    }
  }

  // Category for display MUST come from the slot the item was actually placed into for this
  // menu (menu_day_items.slot_id -> menu_slots.category_id), not the item's own catalog
  // category_id -- an item forced in from a different category (e.g. Staff Main Dish
  // including that day's KG-LP/MS-UP Lunch Main picks, which are tagged LUNCH_MAIN in the
  // catalog) would otherwise resolve to a category code the section's sheet builder never
  // matches, silently dropping it from the export.
  const { data: slotRows, error: slotErr } = await supabase
    .from('menu_slots').select('id, category_id').eq('section_id', section.id);
  if (slotErr) throw supaFail('fetchGeneratedMenuExportData: load menu_slots', slotErr);
  const slotCategoryById = new Map(slotRows.map(s => [s.id, s.category_id]));

  const dayItemsByDay = new Map();
  const displayCategoryByItem = new Map(); // item_id -> category_id actually used for this menu
  for (const row of dayItemRows) {
    const item = itemById.get(row.item_id);
    if (!item) continue;
    const catId = slotCategoryById.get(row.slot_id) ?? item.category_id;
    const cat = getCategoryById(catId);
    displayCategoryByItem.set(item.id, catId);
    const enriched = {
      item_id: item.id, name: item.name, rc_code: item.rc_code, is_daily_repeating: item.is_daily_repeating,
      category_name: cat?.name, category_code: cat?.code, meal_period_name: cat?.meal_period_name,
      period_order: cat?.meal_period_sort_order ?? 0, cat_order: cat?.sort_order ?? 0,
    };
    if (!dayItemsByDay.has(row.menu_day_id)) dayItemsByDay.set(row.menu_day_id, []);
    dayItemsByDay.get(row.menu_day_id).push(enriched);
  }

  const daysWithItems = days.map(d => ({ ...d, items: dayItemsByDay.get(d.id) || [] }));
  // item_portions.quantity is now an optional per-item override (most rows are still 0/unset
  // from before this category-default redesign); the category+section default from
  // lib/referenceData.js is the primary source, keyed off the same slot-resolved category
  // used for display above -- not the item's raw catalog category_id -- so a forced
  // cross-category pick (e.g. Staff Main Dish's shared Lunch Main items) still gets Staff
  // Main's portion size, not Lunch Main's.
  const getPortion = (itemId, ageGroupId) => {
    const override = portionsByItem.get(itemId)?.get(ageGroupId);
    if (override && override.quantity) return override;
    const catId = displayCategoryByItem.get(itemId);
    const sectionId = getAgeGroupById(ageGroupId)?.section_id;
    if (catId == null || sectionId == null) return override || null;
    return getCategoryPortionDefault(catId, sectionId) || override || null;
  };

  return { menu, section, ageGroups, days: daysWithItems, getPortion };
}

// Assembles the named-range/lookup data lib/export.js's buildListsSheetFromData needs for one
// or more sections: each section's full eligible-item pool is loaded once (not once per
// category) and filtered in memory, mirroring MenuGenerator's pool cache -- keeps this to a
// couple of Supabase requests per section instead of one pair per (section, category).
async function fetchListsSheetData(sectionCodes) {
  const bySection = {};
  const allItemIds = new Set();
  const categoryByItem = new Map(); // item_id -> category_id, from the pool grouping below

  for (const sectionCode of sectionCodes) {
    const sectionId = getSectionByCode(sectionCode).id;
    const ageGroups = getAgeGroupsForSection(sectionId);
    const ageGroupIds = ageGroups.map(a => a.id);

    let pool = [];
    if (ageGroupIds.length) {
      const { data: portionRows, error: portErr } = await supabase
        .from('item_portions').select('item_id').in('age_group_id', ageGroupIds);
      if (portErr) throw supaFail('fetchListsSheetData: load item_portions', portErr);
      const itemIds = [...new Set(portionRows.map(r => r.item_id))];
      if (itemIds.length) {
        const { data: items, error: itemsErr } = await supabase
          .from('menu_items')
          .select('id, name, rc_code, is_daily_repeating, category_id')
          .eq('is_active', 1)
          .in('id', itemIds);
        if (itemsErr) throw supaFail('fetchListsSheetData: load menu_items', itemsErr);
        pool = items;
      }
    }

    const categories = {};
    for (const [categoryCode] of SECTION_SLOTS[sectionCode]) {
      if (categories[categoryCode]) continue;
      // meta (name/sort_order/meal period) is only needed by the Blank Menu template's
      // buildSlotSpecsFromData, but it's cheap cached reference data, so it's always attached.
      const meta = getCategoryByCode(categoryCode);
      let items = pool.filter(it => it.category_id === meta.id);

      // Staff's Main Dish slot force-includes that day's shared KG-LP/MS-UP/Daycare Lunch
      // Main picks verbatim (see lib/generator.js's STAFF_MAIN_SOURCE_SECTIONS/
      // STAFF_MAIN_DAYCARE_SOURCE_SECTION) -- those items are catalogued as LUNCH_MAIN, not
      // STAFF_MAIN, so the plain category_id filter above never finds them. Without this,
      // they'd never enter STAFF's STAFF_MAIN bucket, so List_STAFF_STAFF_MAIN/
      // Lookup_STAFF_STAFF_MAIN wouldn't contain them either -- the exported sheet's live
      // INDEX/MATCH lookup formula would return blank via IFERROR no matter what
      // item_portions data exists, since MATCH can't find a name that was never in the list.
      if (sectionCode === 'STAFF' && categoryCode === 'STAFF_MAIN') {
        const lunchMainCat = getCategoryByCode('LUNCH_MAIN');
        // Filter to the LUNCH_MAIN catalog FIRST (bounded, one category) rather than starting
        // from item_portions filtered only by age_group_id -- that pulls in every portion row
        // across KG-LP/MS-UP/Daycare's ENTIRE catalogs (LUNCH_MAIN alone is 700+ rows just for
        // MS-UP), silently blowing past PostgREST's 1000-row cap with no .range() pagination,
        // which is exactly what caused "Korean Fried Chicken" and "Chicken Emansei..." to drop
        // out of an earlier version of this fix despite meeting every eligibility criterion.
        const lunchMainItems = await fetchAllRowsMain(() => supabase
          .from('menu_items').select('id, name, rc_code, is_daily_repeating, category_id')
          .eq('is_active', 1).eq('category_id', lunchMainCat.id));

        if (lunchMainItems.length) {
          const sourceAgeGroupIds = ['KG_LP', 'MS_UP', 'DAYCARE']
            .flatMap(code => getAgeGroupsForSection(getSectionByCode(code).id)).map(a => a.id);
          const chunkSize = 300;
          const eligibleIds = new Set();
          const lunchMainItemIds = lunchMainItems.map(i => i.id);
          for (let i = 0; i < lunchMainItemIds.length; i += chunkSize) {
            const chunk = lunchMainItemIds.slice(i, i + chunkSize);
            const rows = await fetchAllRowsMain(() => supabase
              .from('item_portions').select('item_id').in('item_id', chunk).in('age_group_id', sourceAgeGroupIds));
            rows.forEach(r => eligibleIds.add(r.item_id));
          }
          const existingIds = new Set(items.map(i => i.id));
          items = items.concat(lunchMainItems.filter(i => eligibleIds.has(i.id) && !existingIds.has(i.id)));
        }
      }

      items = items.sort((a, b) => a.name.localeCompare(b.name));
      categories[categoryCode] = { items, meta };
      // categoryByItem is keyed by section too (not just item id): the whole point of the
      // block above is that the same item can legitimately sit under a DIFFERENT category
      // bucket for Staff (STAFF_MAIN) than it does for its home section (LUNCH_MAIN for
      // KG-LP/MS-UP/Daycare) -- meta.id (this bucket's category), not it.category_id (the
      // item's own catalog category), is what the quantity default must key off here.
      items.forEach(it => { allItemIds.add(it.id); categoryByItem.set(`${sectionId}:${it.id}`, meta.id); });
    }
    bySection[sectionCode] = { ageGroups, categories };
  }

  const portionsByItem = new Map();
  if (allItemIds.size) {
    const { data: portions, error } = await supabase
      .from('item_portions').select('item_id, age_group_id, unit, quantity').in('item_id', [...allItemIds]);
    if (error) throw supaFail('fetchListsSheetData: load item_portions (lists)', error);
    for (const p of portions) {
      if (!portionsByItem.has(p.item_id)) portionsByItem.set(p.item_id, new Map());
      portionsByItem.get(p.item_id).set(p.age_group_id, { unit: p.unit, quantity: p.quantity });
    }
  }

  // Same override-then-category-default logic as fetchGeneratedMenuExportData's getPortion --
  // see the comment there for why quantity is now primarily a category+section lookup.
  const getPortion = (itemId, ageGroupId) => {
    const override = portionsByItem.get(itemId)?.get(ageGroupId);
    if (override && override.quantity) return override;
    const sectionId = getAgeGroupById(ageGroupId)?.section_id;
    const catId = sectionId != null ? categoryByItem.get(`${sectionId}:${itemId}`) : undefined;
    if (catId == null || sectionId == null) return override || null;
    return getCategoryPortionDefault(catId, sectionId) || override || null;
  };
  return { bySection, getPortion };
}

ipcMain.handle('export-menu-to-excel', async (e, { generatedMenuId, savePath }) => {
  if (!savePath) {
    const { data: menu, error } = await supabase.from('generated_menus').select('label').eq('id', generatedMenuId).single();
    if (error) throw supaFail('export-menu-to-excel: load label', error);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Menu',
      defaultPath: `${menu.label.replace(/\s+/g, '_')}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  await exportSingleMenu(fetchGeneratedMenuExportData, fetchListsSheetData, generatedMenuId, savePath);
  return { success: true, path: savePath };
});

ipcMain.handle('generate-and-export-all', async (e, { label, startDate, numWeekdays, savePath, createdBy }) => {
  const sectionOrder = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
  const menuIdsBySection = {};
  const warningsBySection = {};
  // Same batch_id across all 5 sections so History can show/delete this run as one entry.
  const batchId = crypto.randomUUID();

  for (const sectionCode of sectionOrder) {
    const gen = new MenuGenerator();
    const { menuId } = await gen.generate(sectionCode, label, new Date(startDate), numWeekdays, batchId, createdBy);
    menuIdsBySection[sectionCode] = menuId;
    warningsBySection[sectionCode] = gen.warnings;
  }

  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Combined Menu Workbook',
      defaultPath: `${label.replace(/\s+/g, '_')}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  await exportCombinedWorkbook(fetchGeneratedMenuExportData, fetchListsSheetData, menuIdsBySection, savePath);
  return { success: true, path: savePath, warningsBySection };
});

ipcMain.handle('export-all-sections-to-excel', async (e, { menuIdsBySection, savePath }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Combined Menu Workbook',
      defaultPath: 'All_Sections_Menu.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }
  await exportCombinedWorkbook(fetchGeneratedMenuExportData, fetchListsSheetData, menuIdsBySection, savePath);
  return { success: true, path: savePath };
});

// ---------------------------------------------------------------
// IPC: manual menu builder
// ---------------------------------------------------------------
ipcMain.handle('get-section-slots', (e, sectionCode) => {
  return (SECTION_SLOTS[sectionCode] || []).map(([categoryCode, count]) => ({ categoryCode, count }));
});

ipcMain.handle('get-school-days', (e, { startDate, numWeekdays }) => {
  return schoolDaysFrom(new Date(startDate), numWeekdays);
});

ipcMain.handle('get-school-day-count', (e, { startDate, endDate }) => {
  return schoolDayCountBetween(new Date(startDate), new Date(endDate));
});

// Build Menu's per-section item pool, grouped by category code -- one call per section (2
// Supabase queries via sectionItemPoolSupabase) instead of the old get-eligible-items, which
// fired one call (2 queries) per section*category slot -- ~94 round trips down to ~10 across
// all 5 sections. Same columns/is_active filter/per-category sort as eligibleItemsSupabase
// (still used as-is by get-eligible-swap-items below, a single-slot lookup where the old
// per-category query shape is still the right one), so results are identical either way.
ipcMain.handle('get-section-item-pool', async (e, sectionCode) => {
  const section = getSectionByCode(sectionCode);
  const items = await sectionItemPoolSupabase(section.id);
  const byCategory = {};
  for (const item of items) {
    const code = getCategoryById(item.category_id)?.code;
    if (!code) continue;
    (byCategory[code] = byCategory[code] || []).push(item);
  }
  for (const code of Object.keys(byCategory)) {
    byCategory[code].sort((a, b) => a.name.localeCompare(b.name));
  }
  return byCategory;
});

ipcMain.handle('builder-fill-suggestions', async (e, { sectionCode, startDate, numWeekdays }) => {
  const gen = new MenuGenerator();
  const { resultDays } = await gen.computeMenu(sectionCode, new Date(startDate), numWeekdays);
  return { resultDays, warnings: gen.warnings };
});

// Never passes a batchId -- Build Menu's export saves all 5 sections too, but only Export
// All Sections' batch groups into one History entry; Build Menu's 5 saves stay individual,
// each tagged with its own section name.
ipcMain.handle('save-manual-menu', async (e, { sectionCode, label, startDate, days, createdBy }) => {
  const gen = new MenuGenerator();
  const menuId = await gen.persistMenu(sectionCode, label, new Date(startDate), days, null, createdBy);
  return { menuId };
});

ipcMain.handle('export-blank-template', async (e, { startDate, numWeekdays, savePath }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Blank Menu Template',
      defaultPath: 'Blank_Menu_Template.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }
  await exportBlankTemplateWorkbook(fetchListsSheetData, new Date(startDate), numWeekdays, savePath);
  return { success: true, path: savePath };
});
