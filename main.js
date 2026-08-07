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
} = require('./lib/referenceData');
const { MenuGenerator, SECTION_SLOTS, eligibleItemsSupabase, schoolDaysFrom } = require('./lib/generator');
const { suggestClassification } = require('./lib/classify');
const { exportSingleMenu, exportCombinedWorkbook, exportBlankTemplateWorkbook, exportRecipes, exportScaledRecipe, sanitizeSheetName } = require('./lib/export');

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

ipcMain.handle('suggest-classification', (e, { name, mealPeriod }) => {
  return suggestClassification(name, mealPeriod);
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

ipcMain.handle('update-item', async (e, { id, name, categoryCode, proteinCode, isDailyRepeating, isActive }) => {
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

ipcMain.handle('add-ingredient', async (e, { name, defaultUnit, category, productCode }) => {
  const { data, error } = await supabase
    .from('ingredients')
    .insert({ product_code: productCode || null, name: name.trim(), default_unit: defaultUnit || null, category: category || null })
    .select('*')
    .single();
  if (error) throw supaFail('add-ingredient', error);
  return data;
});

ipcMain.handle('list-ingredients', async () => {
  const { data, error } = await supabase.from('ingredients').select('*').order('category').order('name');
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

ipcMain.handle('list-recipes', async () => {
  const { data, error } = await supabase
    .from('recipes')
    .select('id, code, name, category, prepared_by, date_created')
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
async function fetchRecipeWithIngredients(id) {
  const { data: recipe, error: recipeErr } = await supabase.from('recipes').select('*').eq('id', id).single();
  if (recipeErr) {
    if (recipeErr.code === 'PGRST116') return null; // no matching row
    throw supaFail('fetchRecipeWithIngredients: load recipe', recipeErr);
  }

  const { data: ingredientRows, error: riErr } = await supabase
    .from('recipe_ingredients')
    .select('id, ingredient_id, quantity, unit, method, sort_order')
    .eq('recipe_id', id)
    .order('sort_order');
  if (riErr) throw supaFail('fetchRecipeWithIngredients: load recipe_ingredients', riErr);

  const ingredientIds = [...new Set(ingredientRows.map(r => r.ingredient_id))];
  let ingredientById = new Map();
  if (ingredientIds.length) {
    const { data: ingredientsData, error: ingErr } = await supabase
      .from('ingredients').select('id, name, default_unit').in('id', ingredientIds);
    if (ingErr) throw supaFail('fetchRecipeWithIngredients: load ingredients', ingErr);
    ingredientById = new Map(ingredientsData.map(i => [i.id, i]));
  }

  const ingredients = ingredientRows.map(ri => ({
    ...ri,
    ingredient_name: ingredientById.get(ri.ingredient_id)?.name,
    default_unit: ingredientById.get(ri.ingredient_id)?.default_unit,
  }));

  return { ...recipe, ingredients };
}

ipcMain.handle('get-recipe', async (e, id) => fetchRecipeWithIngredients(id));

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
    preparation_cooking: payload.preparationCooking || null,
    presentation_serving: payload.presentationServing || null,
    comment: payload.comment || null,
    checked_by: payload.checkedBy || null,
  };

  if (recipeId) {
    const { data: existing, error: getErr } = await supabase.from('recipes').select('code').eq('id', recipeId).single();
    if (getErr) throw supaFail('save-recipe: load existing code', getErr);
    code = existing.code;

    const { error: updErr } = await supabase.from('recipes').update(fields).eq('id', recipeId);
    if (updErr) throw supaFail('save-recipe: update recipes', updErr);

    const { error: delErr } = await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId);
    if (delErr) throw supaFail('save-recipe: clear old recipe_ingredients', delErr);
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

  const ingredientRows = (payload.ingredients || []).map((ing, idx) => ({
    recipe_id: recipeId,
    ingredient_id: ing.ingredientId,
    quantity: ing.quantity ?? null,
    unit: ing.unit || null,
    method: ing.method || null,
    sort_order: idx,
  }));
  if (ingredientRows.length) {
    const { error: insIngErr } = await supabase.from('recipe_ingredients').insert(ingredientRows);
    if (insIngErr) throw supaFail('save-recipe: insert recipe_ingredients', insIngErr);
  }

  return { id: recipeId, code };
});

ipcMain.handle('delete-recipe', async (e, id) => {
  await supabase.from('recipe_ingredients').delete().eq('recipe_id', id);
  const { error } = await supabase.from('recipes').delete().eq('id', id);
  if (error) throw supaFail('delete-recipe', error);
  return { success: true };
});

ipcMain.handle('export-recipes', async (e, { recipeIds, savePath }) => {
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

  await exportRecipes(async (recipeId) => {
    const full = await fetchRecipeWithIngredients(recipeId);
    const { ingredients, ...recipe } = full;
    return { recipe, ingredients };
  }, recipeIds, savePath);
  return { success: true, path: savePath };
});

// Exports a scaled recipe built entirely in the renderer (Recipe Calculator) -- nothing is
// read from or written to the database here, `recipe`/`ingredients` arrive as plain data.
ipcMain.handle('export-scaled-recipe', async (e, { recipe, ingredients, savePath }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Scaled Recipe',
      defaultPath: `${sanitizeSheetName(recipe.name)}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  await exportScaledRecipe(recipe, ingredients, savePath);
  return { success: true, path: savePath };
});

// ---------------------------------------------------------------
// IPC: menu generation (Supabase: generated_menus/menu_days/menu_day_items/menu_slots,
// via lib/generator.js's MenuGenerator -- shared by Generate Menu, Build Menu, History, and
// Export All Sections, all converted together since they share the same no-repeat scoring
// history and the same generated-menu records; see conversation notes on why splitting them
// across two databases would silently degrade duplicate-avoidance and fragment History)
// ---------------------------------------------------------------
ipcMain.handle('generate-menu', async (e, { sectionCode, label, startDate, numWeekdays }) => {
  const gen = new MenuGenerator();
  const { menuId, resultDays } = await gen.generate(sectionCode, label, new Date(startDate), numWeekdays);
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
        tag: section?.name || '—',
        menuIds: [row.id],
      });
    }
  }
  return entries;
});

ipcMain.handle('get-generated-menu-detail', async (e, generatedMenuId) => {
  const { data: days, error: daysErr } = await supabase
    .from('menu_days').select('*').eq('generated_menu_id', generatedMenuId).order('menu_date');
  if (daysErr) throw supaFail('get-generated-menu-detail: load menu_days', daysErr);

  const dayIds = days.map(d => d.id);
  let dayItemRows = [];
  if (dayIds.length) {
    const { data, error } = await supabase
      .from('menu_day_items').select('id, item_id, menu_day_id').in('menu_day_id', dayIds);
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

  const itemsByDay = new Map();
  for (const row of dayItemRows) {
    const item = itemById.get(row.item_id);
    if (!item) continue;
    const cat = getCategoryById(item.category_id);
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

  const dayItemsByDay = new Map();
  for (const row of dayItemRows) {
    const item = itemById.get(row.item_id);
    if (!item) continue;
    const cat = getCategoryById(item.category_id);
    const enriched = {
      item_id: item.id, name: item.name, rc_code: item.rc_code, is_daily_repeating: item.is_daily_repeating,
      category_name: cat?.name, category_code: cat?.code, meal_period_name: cat?.meal_period_name,
      period_order: cat?.meal_period_sort_order ?? 0, cat_order: cat?.sort_order ?? 0,
    };
    if (!dayItemsByDay.has(row.menu_day_id)) dayItemsByDay.set(row.menu_day_id, []);
    dayItemsByDay.get(row.menu_day_id).push(enriched);
  }

  const daysWithItems = days.map(d => ({ ...d, items: dayItemsByDay.get(d.id) || [] }));
  const getPortion = (itemId, ageGroupId) => portionsByItem.get(itemId)?.get(ageGroupId) || null;

  return { menu, section, ageGroups, days: daysWithItems, getPortion };
}

// Assembles the named-range/lookup data lib/export.js's buildListsSheetFromData needs for one
// or more sections: each section's full eligible-item pool is loaded once (not once per
// category) and filtered in memory, mirroring MenuGenerator's pool cache -- keeps this to a
// couple of Supabase requests per section instead of one pair per (section, category).
async function fetchListsSheetData(sectionCodes) {
  const bySection = {};
  const allItemIds = new Set();

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
      const items = pool.filter(it => it.category_id === meta.id).sort((a, b) => a.name.localeCompare(b.name));
      categories[categoryCode] = { items, meta };
      items.forEach(it => allItemIds.add(it.id));
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

  const getPortion = (itemId, ageGroupId) => portionsByItem.get(itemId)?.get(ageGroupId) || null;
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

ipcMain.handle('generate-and-export-all', async (e, { label, startDate, numWeekdays, savePath }) => {
  const sectionOrder = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
  const menuIdsBySection = {};
  const warningsBySection = {};
  // Same batch_id across all 5 sections so History can show/delete this run as one entry.
  const batchId = crypto.randomUUID();

  for (const sectionCode of sectionOrder) {
    const gen = new MenuGenerator();
    const { menuId } = await gen.generate(sectionCode, label, new Date(startDate), numWeekdays, batchId);
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

ipcMain.handle('get-eligible-items', async (e, { sectionCode, categoryCode }) => {
  const section = getSectionByCode(sectionCode);
  const category = getCategoryByCode(categoryCode);
  return eligibleItemsSupabase(section.id, category.id);
});

ipcMain.handle('builder-fill-suggestions', async (e, { sectionCode, startDate, numWeekdays }) => {
  const gen = new MenuGenerator();
  const { resultDays } = await gen.computeMenu(sectionCode, new Date(startDate), numWeekdays);
  return { resultDays, warnings: gen.warnings };
});

// Never passes a batchId -- Build Menu's export saves all 5 sections too, but only Export
// All Sections' batch groups into one History entry; Build Menu's 5 saves stay individual,
// each tagged with its own section name.
ipcMain.handle('save-manual-menu', async (e, { sectionCode, label, startDate, days }) => {
  const gen = new MenuGenerator();
  const menuId = await gen.persistMenu(sectionCode, label, new Date(startDate), days);
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
