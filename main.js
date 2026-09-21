const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const JSZip = require('jszip');
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
const recipePdf = require('./lib/recipePdf');
const { translateTexts } = require('./lib/translateRecipe');
const { estimateCalories } = require('./lib/estimateCalories');
const { estimateAmSnackStyle } = require('./lib/estimateAmSnackStyle');
const { suggestDishIngredients } = require('./lib/suggestDishIngredients');
const { filterNutIngredients, matchNutTerms, stripNutTermsFromText } = require('./lib/nutFilter');
const { matchSeafoodTerms } = require('./lib/seafoodFilter');
const {
  loadWorkbookFromBuffer, parseWorkbookDishes, restructureAndAppendIngredients,
  flattenSheetForAI, HIDDEN_SHEET_STATES, stripFormulasToValues,
} = require('./lib/menuIngredients');
const { generateDishRecipes } = require('./lib/generateDishRecipes');
const { generateDishImage } = require('./lib/generateDishImage');
const {
  DOUGH_SHAPE_PHOTOS_BUCKET, createDoughShape, listDoughShapes, deleteDoughShape,
} = require('./lib/doughShapes');
const doughShapePresets = require('./lib/doughShapePresets');
const { extractMenuDishesAI } = require('./lib/extractMenuDishesAI');
const {
  normalizeProcessesToNetWeight, netWeightOfProcesses, REFERENCE_NET_WEIGHT_GRAMS, isSaladCategory, dedupeWithinUpload, resolveSectionFromSheetName, isStudentSection,
} = require('./lib/recipeGenerator');

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
// Every check used to be a single shot at app launch with zero user-visible feedback on
// anything short of a fully-downloaded update (a failed/no-op check just logged to a file
// nobody opens) -- confirmed as the reason a real release was silently missed on one machine
// twice in a row: a transient failure at cold launch (network not up yet) or a quit before the
// launch-time check/download finished would look identical to "nothing happened", and there
// was no later re-check to self-heal it. Two fixes below: a 4-hour periodic re-check (see
// app.whenReady) so a launch-time miss or a mid-session release isn't stuck until the next full
// quit/relaunch, and a manual "Check for Updates..." menu item (buildApplicationMenu) with real
// status feedback for exactly the escape-hatch case where she wants to know NOW rather than
// trust the silent background path.
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

// Set only while a manually-triggered check (the menu item) is in flight -- every event handler
// below branches on it so the automatic launch-time/periodic checks stay exactly as silent as
// before (logged only, no dialogs, no menu-label changes) while a manual check gets full,
// real-time feedback in the menu item's own label plus a terminal dialog. Cleared by
// resetCheckForUpdatesMenuItem, called from every terminal event (not-available/downloaded/error).
let manualCheckInProgress = false;
// Set once buildApplicationMenu() runs; mutating a live MenuItem's .label/.enabled updates the
// menu immediately, no need to rebuild/reassign the whole Menu.
let checkForUpdatesMenuItem = null;

function resetCheckForUpdatesMenuItem() {
  manualCheckInProgress = false;
  if (checkForUpdatesMenuItem) {
    checkForUpdatesMenuItem.label = 'Check for Updates…';
    checkForUpdatesMenuItem.enabled = true;
  }
}

autoUpdater.on('checking-for-update', () => {
  log.info('[auto-updater] checking-for-update event fired');
});

autoUpdater.on('update-available', (info) => {
  log.info(`[auto-updater] update-available: v${info.version} -- downloading in background`);
  if (manualCheckInProgress && checkForUpdatesMenuItem) {
    checkForUpdatesMenuItem.label = `Downloading Update (v${info.version})…`;
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (manualCheckInProgress && checkForUpdatesMenuItem) {
    checkForUpdatesMenuItem.label = `Downloading Update… ${Math.round(progress.percent)}%`;
  }
});

autoUpdater.on('update-not-available', (info) => {
  log.info(`[auto-updater] update-not-available -- current app version is already latest (checked against v${info?.version})`);
  if (manualCheckInProgress) {
    dialog.showMessageBox(mainWindow || loginWindow, {
      type: 'info',
      title: 'No Updates Available',
      message: "You're on the latest version.",
      detail: `Menu Board v${app.getVersion()}`,
    });
  }
  resetCheckForUpdatesMenuItem();
});

autoUpdater.on('update-downloaded', (info) => {
  log.info(`[auto-updater] update-downloaded: v${info.version} -- prompting to restart`);
  resetCheckForUpdatesMenuItem();
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
  if (manualCheckInProgress) {
    dialog.showMessageBox(mainWindow || loginWindow, {
      type: 'error',
      title: 'Update Check Failed',
      message: "Couldn't check for updates.",
      detail: err?.message || 'An unknown error occurred. Check your network connection and try again.',
    });
  }
  resetCheckForUpdatesMenuItem();
});

function checkForUpdates(manual = false) {
  // Unpacked dev runs (npm start) have no app-update.yml -- that file only exists inside a
  // build produced by electron-builder -- so checkForUpdates() would just throw noisily.
  // This means dev-mode testing (npm start) will NEVER produce any auto-update log lines at
  // all, by design -- to see anything here, test the actual packaged/installed .app.
  if (!app.isPackaged) {
    log.info('[auto-updater] skipped: app.isPackaged is false (dev run via npm start)');
    if (manual) {
      dialog.showMessageBox(mainWindow || loginWindow, {
        type: 'info',
        title: 'Check for Updates',
        message: 'Update checks are only available in the installed app.',
        detail: 'This dev build (npm start) has no update feed to check against.',
      });
      resetCheckForUpdatesMenuItem();
    }
    return;
  }
  if (manual) {
    manualCheckInProgress = true;
    if (checkForUpdatesMenuItem) {
      checkForUpdatesMenuItem.enabled = false;
      checkForUpdatesMenuItem.label = 'Checking for Updates…';
    }
  }
  log.info(`[auto-updater] calling checkForUpdates() -- current app version is ${app.getVersion()}`);
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[auto-updater] checkForUpdates() promise rejected:', {
      message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
    });
    // checkForUpdates() rejecting (as opposed to the updater's own 'error' event firing) means
    // the request never got far enough to reach the updater's normal event flow at all -- still
    // needs the same manual-check feedback, since otherwise a manual click could fail this way
    // and just leave the menu item stuck on "Checking for Updates…" forever.
    if (manual) {
      dialog.showMessageBox(mainWindow || loginWindow, {
        type: 'error',
        title: 'Update Check Failed',
        message: "Couldn't check for updates.",
        detail: err?.message || 'An unknown error occurred. Check your network connection and try again.',
      });
      resetCheckForUpdatesMenuItem();
    }
  });
}

// Full macOS menu template -- the app has never called Menu.setApplicationMenu before, so it's
// been running on Electron's built-in default (App/File/Edit/View/Window/Help) this whole time.
// Reproduced here field-for-field via the same `role:` shorthands Electron's own default menu
// uses internally, so every existing behavior/accelerator (Cmd+Q, Cmd+W, Cmd+C/V, DevTools
// toggle, fullscreen, etc.) keeps working exactly as before -- the only actual addition is
// "Check for Updates..." in the app menu, placed right under "About" per standard macOS
// convention (Chrome/Slack/VS Code/Notion all place it there, not under Help).
function buildApplicationMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          id: 'checkForUpdates',
          label: 'Check for Updates…',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // The built Menu's own MenuItem, not the plain template object -- mutating its .label/.enabled
  // is what actually reflects in the live menu (see resetCheckForUpdatesMenuItem/checkForUpdates).
  checkForUpdatesMenuItem = menu.getMenuItemById('checkForUpdates');
}

app.whenReady().then(() => {
  buildApplicationMenu();
  createLoginWindow();
  checkForUpdates();
  // Closes failure mode #3 from the investigation (leaving the app open across days means the
  // once-at-launch check never fires again) -- re-checks every 4 hours for as long as the app
  // stays open, silently (manual=false), same as the launch-time check.
  setInterval(() => checkForUpdates(), 4 * 60 * 60 * 1000);
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

// Bounded so a stuck request always surfaces *something* instead of leaving the login screen on
// "Signing in..." forever with no explanation -- the actual bug this fixes. 15s is generous for
// a real network round trip but well short of "feels hung".
const SIGN_IN_TIMEOUT_MS = 15000;

// A system clock far enough from real time breaks TLS certificate validation (HTTPS requires
// the client's clock to fall within the cert's validity window) -- a well-known class of issue,
// and opening Date & Time settings force-syncs the clock via NTP and immediately unsticks it,
// which matches this app's reported symptom (login hangs indefinitely, no error) exactly on two
// separate machines. It's the leading theory, not a confirmed diagnosis (there's no machine log
// to inspect), so the message below covers the other realistic cause -- no internet -- too,
// rather than asserting a clock problem outright.
const SIGN_IN_NETWORK_FAILURE_MESSAGE = "Couldn't reach the sign-in server. This is often caused "
  + "by your computer's system clock/date being set incorrectly, which breaks the secure "
  + 'connection -- check Date & Time in System Settings (turn on "Set automatically") and try '
  + 'again. If the clock looks right, check your internet connection instead.';

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

ipcMain.handle('auth-sign-in', async (e, { id, password }) => {
  const email = `${(id || '').trim().toLowerCase()}@${LOGIN_ID_DOMAIN}`;
  let data, error;
  try {
    ({ data, error } = await withTimeout(supabase.auth.signInWithPassword({ email, password }), SIGN_IN_TIMEOUT_MS));
  } catch (timeoutErr) {
    log.warn(`[auth-sign-in] timed out after ${SIGN_IN_TIMEOUT_MS}ms -- likely a stuck TLS handshake (bad system clock) or a dead connection`);
    return { success: false, message: SIGN_IN_NETWORK_FAILURE_MESSAGE };
  }
  if (error) {
    // signInWithPassword never throws -- @supabase/auth-js catches every failure itself and
    // resolves `error` instead, including a fetch()-level failure (TLS handshake included) that
    // never got as far as a real HTTP response. That specific case is tagged status 0 / name
    // 'AuthRetryableFetchError' (see node_modules/@supabase/auth-js's fetch.js/errors.js) --
    // the one reliable signal available to tell "couldn't even reach the server" apart from a
    // genuine rejection from it (wrong password, etc.), whose message is left completely
    // untouched below. auth-js's own wrapping collapses every fetch-level failure (offline, DNS,
    // TLS/certificate) into the same generic "fetch failed" string, so this can't be narrowed
    // down any further than that from here -- hence the message covering both causes.
    if (error.status === 0 || error.name === 'AuthRetryableFetchError') {
      log.warn(`[auth-sign-in] network-level failure reaching Supabase: ${error.message}`);
      return { success: false, message: SIGN_IN_NETWORK_FAILURE_MESSAGE };
    }
    return { success: false, message: error.message };
  }

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
    .select('id, name, is_daily_repeating, is_active, rc_code, category_id, protein_type_id, calories_per_100g, calories_unverified, am_snack_style')
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
        calories_per_100g: mi.calories_per_100g,
        calories_unverified: mi.calories_unverified,
        am_snack_style: mi.am_snack_style,
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

// AM Snack items in Daycare/KG-LP/MS-UP auto-classify (Pastry/Cold Kitchen) on save when the
// chef leaves Style blank -- same "apply the AI classification as the final value immediately,
// no review flag" contract as calories_per_100g's own bulk backfill, just triggered per-item at
// save time instead of in a batch. A manually picked style (explicitStyle truthy) always wins --
// this never overwrites her own choice. Never throws: a failed/unreachable AI call just leaves
// the item unclassified (null) rather than blocking the save, since classification is secondary
// to the item existing at all -- she can still classify it later via the bulk backfill button or
// by editing the item directly.
async function resolveAmSnackStyle(categoryCode, name, explicitStyle) {
  if (categoryCode !== 'AM_SNACK') return null;
  if (explicitStyle) return explicitStyle;
  try {
    const estimates = await estimateAmSnackStyle({ items: [{ index: 0, name }] });
    const match = estimates.find(est => est.index === 0);
    return match?.am_snack_style ?? null;
  } catch (err) {
    console.error('[resolveAmSnackStyle] auto-classify failed:', err.message);
    return null;
  }
}

// menu_items has UNIQUE(name, category_id) in Postgres too -- adding/renaming/re-categorizing
// an item so it collides with another item of the same name already in that category throws
// a unique_violation (Postgres code 23505). Caught here (same pattern as delete-ingredient
// below) and reported back as { success: false, duplicate: true } instead of throwing, since
// the same dish name legitimately recurs across many categories in this catalog and the
// renderer needs to tell the user why the save didn't go through rather than have it silently fail.
ipcMain.handle('add-item', async (e, { name, categoryCode, proteinCode, isDailyRepeating, caloriesPer100g, amSnackStyle, portions, sectionCode }) => {
  const category = getCategoryByCode(categoryCode);
  const protein = proteinCode ? getProteinByCode(proteinCode) : null;
  const resolvedAmSnackStyle = await resolveAmSnackStyle(categoryCode, name, amSnackStyle);

  const { data: inserted, error: insErr } = await supabase
    .from('menu_items')
    .insert({
      name,
      category_id: category.id,
      protein_type_id: protein ? protein.id : null,
      is_daily_repeating: isDailyRepeating ? 1 : 0,
      calories_per_100g: caloriesPer100g ?? null,
      am_snack_style: resolvedAmSnackStyle,
      // Both pre-existing bugs, unrelated to item_portions.quantity retirement -- found while
      // smoke-testing Add Item afterward, neither previously set here:
      // - is_active: violates NOT NULL in Postgres (update-item always sets it; add-item never
      //   did). A new item obviously starts active, matching every eligibility query's
      //   .eq('is_active', 1) filter elsewhere.
      // - created_at: also violates NOT NULL -- despite save-recipe's own comment claiming
      //   menu_items has a DB-side default (unlike recipes), it empirically does not right now.
      //   Set explicitly, same insert-only pattern save-recipe/add-ingredient already use for
      //   tables confirmed to lack one.
      is_active: 1,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insErr) {
    if (insErr.code === '23505') return { success: false, duplicate: true };
    throw supaFail('add-item: insert menu_items', insErr);
  }
  const itemId = inserted.id;

  // item_portions.quantity is retired (see conversation notes -- category_portion_defaults is
  // now the sole source of portion size, no per-item override). A row's mere EXISTENCE still
  // determines section/age-group membership, so `portions` is just the chef-checked list of age
  // group codes now, not a quantity+unit she typed -- `unit` still needs a value (NOT NULL), so
  // each row gets it from that category+section's own default when one's been set, falling back
  // to the same 'n/a' placeholder the no-portions-given safety net below already used.
  const rows = [];
  for (const ageGroupCode of portions) {
    const ag = getAgeGroupByCode(ageGroupCode);
    if (!ag) continue;
    const def = getCategoryPortionDefault(category.id, ag.section_id);
    rows.push({ item_id: itemId, age_group_id: ag.id, unit: def?.unit || 'n/a', price: null });
  }
  // Safety net: if no age groups were checked but we know the section, link the item to
  // that section's age groups anyway so it never silently disappears.
  if (rows.length === 0 && sectionCode) {
    const section = getSectionByCode(sectionCode);
    if (section) {
      const ags = getAgeGroupsForSection(section.id);
      for (const ag of ags) {
        const def = getCategoryPortionDefault(category.id, ag.section_id);
        rows.push({ item_id: itemId, age_group_id: ag.id, unit: def?.unit || 'n/a', price: null });
      }
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
ipcMain.handle('update-item', async (e, { id, name, categoryCode, proteinCode, isDailyRepeating, isActive, caloriesPer100g, amSnackStyle, removeInvalidSectionPortions }) => {
  const category = getCategoryByCode(categoryCode);
  const protein = proteinCode ? getProteinByCode(proteinCode) : null;
  const resolvedAmSnackStyle = await resolveAmSnackStyle(categoryCode, name, amSnackStyle);

  const { error } = await supabase
    .from('menu_items')
    .update({
      name,
      category_id: category.id,
      protein_type_id: protein ? protein.id : null,
      is_daily_repeating: isDailyRepeating ? 1 : 0,
      is_active: isActive ? 1 : 0,
      calories_per_100g: caloriesPer100g ?? null,
      // A manual save through this modal always overwrites every field with its current form
      // value regardless of whether she actually touched it (same as name/category/protein
      // always have) -- so a save here always clears calories_unverified too, on the same
      // "this is the state she's now confirming" logic. If she re-saves without noticing an
      // unverified AI estimate, that's a real limitation (the flag currently only shows in the
      // Dish Catalog list, not inside this modal) -- flagged as a judgment call, not silently
      // decided.
      calories_unverified: false,
      am_snack_style: resolvedAmSnackStyle,
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

// Nutritional Menu Analysis, Phase 1 -- backfills calories_per_100g for every existing item
// that's missing it, scoped to Daycare/KG_LP/MS_UP only (Staff/CEO are adults, explicitly out of
// scope for this whole feature, not just its later analysis screen -- see conversation notes).
// Deliberately reusable, not a one-shot migration script: it only ever touches rows where
// calories_per_100g IS NULL, so re-running it later after new items are added just backfills
// whatever's still missing, same idempotent shape as the rest of this app's catalog tooling.
//
// Estimates in batches of 50 (BATCH_SIZE), sequentially -- not in parallel -- so a slow/rate-
// limited Anthropic call doesn't fan out into many concurrent Edge Function invocations at once,
// and so calorie-estimate-progress events arrive in a sane, readable order for the renderer's
// status line. Each item gets its own value, so a single Supabase call can't set the whole batch
// at once (no established bulk-upsert-with-per-row-values precedent in this codebase to lean on);
// per-item .update() calls within a batch DO run in parallel via Promise.all, since those are
// independent writes with no ordering requirement of their own.
//
// 50, not 100: a live run at 100 came back with a truncated `estimates` array (see
// estimate-calories/index.ts's own max_tokens comment) on every single 100-item batch, while the
// same run's final, smaller 79-item batch succeeded cleanly. Paired with the Edge Function's
// max_tokens bump to 8192, 50 is a conservative margin below the ~79-100 boundary that actually
// failed, not just relying on the token-budget fix alone.
const CALORIE_ESTIMATE_IN_SCOPE_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];
const CALORIE_ESTIMATE_BATCH_SIZE = 50;

// Joins a Dish Catalog item's ROWS (recipe_ingredients/generated_recipe_ingredients/
// extracted_recipe_ingredients) into one compact "name (qty unit), name (qty unit), ..." string
// for the calorie prompt -- `rows` already carries a real ingredient name per entry by the time
// it gets here (each of the three lookup functions below resolves that differently, since Book/
// Extractor store ingredients by catalog FK while Generator stores free text -- see each one's
// own comment).
function formatIngredientDescription(rows) {
  const parts = (rows || [])
    .filter((r) => r.name)
    .map((r) => (r.quantity != null && r.unit ? `${r.name} (${r.quantity}${r.unit})` : r.name));
  return parts.length > 0 ? parts.join(', ') : null;
}

// Recipe Book stores ingredients by ingredient_id (a real ingredients-catalog FK), not free text
// -- resolve names via that catalog after collecting every process's ingredient rows.
async function describeBookRecipeIngredients(recipeId) {
  const { data: procs } = await supabase.from('recipe_processes').select('id').eq('recipe_id', recipeId);
  if (!procs?.length) return null;
  const { data: rows } = await supabase.from('recipe_ingredients')
    .select('ingredient_id, quantity, unit').in('process_id', procs.map((p) => p.id));
  if (!rows?.length) return null;
  const ingredientIds = [...new Set(rows.map((r) => r.ingredient_id).filter(Boolean))];
  if (ingredientIds.length === 0) return null;
  const { data: names } = await supabase.from('ingredients').select('id, name').in('id', ingredientIds);
  const nameById = new Map((names || []).map((n) => [n.id, n.name]));
  return formatIngredientDescription(rows.map((r) => ({ name: nameById.get(r.ingredient_id), quantity: r.quantity, unit: r.unit })));
}

// Recipe Extractor's own separate ingredient catalog (extracted_ingredients, EX-IN- prefixed) --
// same FK-lookup shape as Book above, just its own tables throughout.
async function describeExtractedRecipeIngredients(recipeId) {
  const { data: procs } = await supabase.from('extracted_recipe_processes').select('id').eq('extracted_recipe_id', recipeId);
  if (!procs?.length) return null;
  const { data: rows } = await supabase.from('extracted_recipe_ingredients')
    .select('extracted_ingredient_id, quantity, unit').in('extracted_recipe_process_id', procs.map((p) => p.id));
  if (!rows?.length) return null;
  const ingredientIds = [...new Set(rows.map((r) => r.extracted_ingredient_id).filter(Boolean))];
  if (ingredientIds.length === 0) return null;
  const { data: names } = await supabase.from('extracted_ingredients').select('id, name').in('id', ingredientIds);
  const nameById = new Map((names || []).map((n) => [n.id, n.name]));
  return formatIngredientDescription(rows.map((r) => ({ name: nameById.get(r.extracted_ingredient_id), quantity: r.quantity, unit: r.unit })));
}

// Recipe Generator stores ingredients as free text directly (no catalog FK -- "pure free text,
// forever", see that migration's own comment), so no name-resolution join is needed here.
async function describeGeneratedRecipeIngredients(recipeId) {
  const { data: procs } = await supabase.from('generated_recipe_processes').select('id').eq('generated_recipe_id', recipeId);
  if (!procs?.length) return null;
  const { data: rows } = await supabase.from('generated_recipe_ingredients')
    .select('name, quantity, unit').in('process_id', procs.map((p) => p.id));
  return formatIngredientDescription(rows);
}

// Looks up a real recipe sharing this Dish Catalog item's EXACT name (case-insensitive, via
// ilike with no wildcard) across all three recipe systems -- Book, then Generator, then
// Extractor, first match wins. Deliberately an EXACT match only, never a fuzzy/similarity one:
// unlike Recipe Generator's own dedup matching (where a near-miss just costs one skipped
// generation), feeding a calorie estimate ingredients from a merely similarly-named DIFFERENT
// dish would make the estimate worse, not better -- confirmed with a real example: "Vegetables
// Chips" and "Natural Mixed Vegetables Chips" are different catalog items with very different
// real compositions, not safe to conflate. Returns a compact ingredient description, or null
// when no recipe anywhere shares this exact name -- callers fall back to name/category/protein-
// only estimation in that case, exactly as before this existed. Sequential, short-circuited on
// first match, not batched across a whole estimation run -- this only runs for items that
// currently have no calorie value at all (a backfill, not a hot path), so the extra few queries
// per item are a non-issue at the scale this table actually reaches.
async function findRecipeIngredientsForDishName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const { data: bookMatch } = await supabase.from('recipes').select('id').ilike('name', trimmed).limit(1);
  if (bookMatch?.length) {
    const desc = await describeBookRecipeIngredients(bookMatch[0].id);
    if (desc) return desc;
  }
  const { data: genMatch } = await supabase.from('generated_recipes').select('id').ilike('name', trimmed).limit(1);
  if (genMatch?.length) {
    const desc = await describeGeneratedRecipeIngredients(genMatch[0].id);
    if (desc) return desc;
  }
  const { data: exMatch } = await supabase.from('extracted_recipes').select('id').ilike('name', trimmed).limit(1);
  if (exMatch?.length) {
    const desc = await describeExtractedRecipeIngredients(exMatch[0].id);
    if (desc) return desc;
  }
  return null;
}

// Category names whose real per-100g calorie count should essentially never exceed a rich,
// well-dressed version of a light/plain dish -- an UPPER-bound plausibility check only, not a
// guess at the "correct" value. "Dessert" is deliberately NOT included -- a legitimately rich
// dessert item can genuinely exceed this.
const LIGHT_CALORIE_CATEGORY_NAMES = new Set([
  'Fruit Basket', 'AM Snack', 'Milk', 'Salad Bar', 'Fruit Bar', 'Juice', 'PM Snack',
  'Staff Fruit Basket', 'Staff Juice', 'Staff Breakfast Juice', 'CEO Raw Vegetables',
  'CEO Breakfast Juice', 'CEO Fruits', 'CEO Lunch Juice', 'Salad Option',
  'Lunch Vegetable Side', 'Lunch SALAD Side',
]);
const LIGHT_CALORIE_MAX = 450;

// Protein types that are always real meat/fish -- 'Vegetarian' is deliberately excluded from this
// LOWER-bound check, since a genuinely very-low-calorie vegetarian dish (a clear broth, a plain
// salad) is entirely plausible.
const MEAT_PROTEIN_NAMES = new Set(['Chicken', 'Beef', 'Lamb', 'Fish']);
const MEAT_CALORIE_MIN = 50;

// A basic sanity backstop, not a precision nutrition check -- catches a value that's implausible
// on its face regardless of how it was produced. Confirmed necessary with a real example: "Baked
// Chicken Strips" came back at 20 kcal/100g even with a real matching recipe available (chicken
// breast, flour, egg, panko, oil), while its near-identical catalog siblings ("Baked Chicken
// Strips and Fries", "Oven Baked Chicken Strips with Wedges") sat at 160-180 -- a model can still
// occasionally produce an implausible number even with good context, so this check runs
// regardless of whether ingredient context was available for that item. Returns a short reason
// string when implausible, else null.
function checkCaloriePlausibility({ calories, categoryName, proteinName }) {
  if (proteinName && MEAT_PROTEIN_NAMES.has(proteinName) && calories < MEAT_CALORIE_MIN) {
    return `a ${proteinName} item under ${MEAT_CALORIE_MIN} kcal/100g is implausible`;
  }
  if (categoryName && LIGHT_CALORIE_CATEGORY_NAMES.has(categoryName) && calories > LIGHT_CALORIE_MAX) {
    return `a ${categoryName} item over ${LIGHT_CALORIE_MAX} kcal/100g is implausible`;
  }
  return null;
}

ipcMain.handle('estimate-missing-calories', async (e) => {
  const ageGroupIds = CALORIE_ESTIMATE_IN_SCOPE_SECTIONS
    .map(code => getSectionByCode(code))
    .filter(Boolean)
    .flatMap(section => getAgeGroupsForSection(section.id).map(a => a.id));
  if (ageGroupIds.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  // item_portions rows for three whole sections can comfortably exceed PostgREST's 1000-row
  // default page -- see fetchAllRowsMain's own comment (the same reason get-eligible-swap-items
  // and the Lunch Main pool query below both already page through it).
  const portionRows = await fetchAllRowsMain(() => supabase
    .from('item_portions').select('item_id').in('age_group_id', ageGroupIds))
    .catch(err => { throw supaFail('estimate-missing-calories: load item_portions', err); });
  const itemIds = [...new Set(portionRows.map(r => r.item_id))];
  if (itemIds.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name, category_id, protein_type_id')
    .in('id', itemIds)
    .is('calories_per_100g', null);
  if (itemsErr) throw supaFail('estimate-missing-calories: load menu_items', itemsErr);
  if (items.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  // Looked up ONCE per item, before any batch/retry attempt (not re-queried on a retry) -- a real
  // matching recipe's ingredients when one exists, so the prompt has actual composition to reason
  // from instead of guessing from name/category/protein alone. See
  // findRecipeIngredientsForDishName's own comment for why this is an exact-name match only.
  for (const it of items) {
    it.ingredientsDescription = await findRecipeIngredientsForDishName(it.name);
  }

  // Tags each item with its own positional `index` and reconciles the response by that index
  // rather than by array position/length -- a live run proved Haiku doesn't reliably preserve
  // exact 1:1 correspondence over a batch of many short, structurally similar {name, category,
  // protein} objects (every failure had stop_reason "end_turn", i.e. a normal complete response
  // that just came back with the wrong count -- see estimate-calories/index.ts's own comment).
  // Returns which items in THIS batch got a usable estimate written vs which didn't (a failed
  // Edge Function call puts the whole batch in `missing`; a partial response puts only the actual
  // gaps there), so the caller can retry just the gaps instead of the whole batch. An item whose
  // returned value fails checkCaloriePlausibility is treated the SAME as "missing" -- eligible for
  // the same one retry pass -- but carries its rejected `lastImplausible` value/reason along so a
  // still-implausible result after retry can be reported distinctly rather than silently written.
  async function estimateAndWriteBatch(batch) {
    const payloadItems = batch.map((it, idx) => {
      const cat = getCategoryById(it.category_id);
      const pt = it.protein_type_id ? getProteinById(it.protein_type_id) : null;
      return {
        index: idx, name: it.name, category: cat?.name ?? null, protein: pt?.name ?? null,
        ingredients: it.ingredientsDescription || undefined,
      };
    });

    let estimates;
    try {
      estimates = await estimateCalories({ items: payloadItems });
    } catch (err) {
      return { written: 0, missing: batch, error: err.message };
    }

    const byIndex = new Map(estimates.map(est => [est.index, est.calories_per_100g]));
    const toWrite = [];
    const missing = [];
    batch.forEach((it, idx) => {
      const value = byIndex.get(idx);
      if (value == null || isNaN(value)) { missing.push(it); return; }
      const cat = getCategoryById(it.category_id);
      const pt = it.protein_type_id ? getProteinById(it.protein_type_id) : null;
      const implausibleReason = checkCaloriePlausibility({ calories: value, categoryName: cat?.name, proteinName: pt?.name });
      if (implausibleReason) {
        missing.push({ ...it, lastImplausible: { value, reason: implausibleReason } });
        return;
      }
      toWrite.push({ it, value });
    });

    const writeResults = await Promise.all(toWrite.map(({ it, value }) =>
      supabase.from('menu_items').update({ calories_per_100g: value, calories_unverified: false }).eq('id', it.id)
        .then(({ error }) => ({ ok: !error, it }))
    ));
    writeResults.filter(r => !r.ok).forEach(r => missing.push(r.it));

    return { written: writeResults.filter(r => r.ok).length, missing, error: null };
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  let estimated = 0;
  let flagged = 0;
  const failures = [];
  let stillMissing = [];

  const batches = chunk(items, CALORIE_ESTIMATE_BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    e.sender.send('calorie-estimate-progress', {
      message: `Estimating batch ${b + 1} of ${batches.length} (${batch.length} items)…`, current: b + 1, total: batches.length,
    });
    const result = await estimateAndWriteBatch(batch);
    estimated += result.written;
    if (result.error) failures.push(`Batch ${b + 1} (${batch.length} items): ${result.error}`);
    stillMissing.push(...result.missing);
  }

  // One retry pass over whatever specific items didn't come back the first time (not the whole
  // batch they happened to be in) -- gives every item a second chance before being reported as a
  // real failure, without unboundedly looping if the same items keep failing. No current/total
  // sent here -- the main loop above already reached 100%, and retryBatches.length wasn't known
  // until just now, so restarting the bar's count from a smaller total would read as the bar
  // going backwards; the shared panel just freezes at 100% and updates the message text instead.
  if (stillMissing.length > 0) {
    e.sender.send('calorie-estimate-progress', { message: `Retrying ${stillMissing.length} item(s) that didn't come back the first time…` });
    const retryBatches = chunk(stillMissing, CALORIE_ESTIMATE_BATCH_SIZE);
    const retryMissing = [];
    for (let b = 0; b < retryBatches.length; b++) {
      const batch = retryBatches[b];
      e.sender.send('calorie-estimate-progress', { message: `Retry batch ${b + 1} of ${retryBatches.length} (${batch.length} items)…` });
      const result = await estimateAndWriteBatch(batch);
      estimated += result.written;
      if (result.error) failures.push(`Retry batch ${b + 1} (${batch.length} items): ${result.error}`);
      retryMissing.push(...result.missing);
    }
    if (retryMissing.length > 0) {
      // Split by WHY it's still missing. A generic "no estimate came back at all" (a malformed
      // response, an index that never showed up) still has nothing to write and stays a real
      // failure. An IMPLAUSIBLE value is different -- per the chef's own instruction, this now
      // still gets written (never left blank), just tagged calories_unverified: true so the Dish
      // Catalog can show it's an unconfirmed AI guess rather than a grounded estimate, instead of
      // the two looking identical. One retry already happened before landing here (see
      // checkCaloriePlausibility/estimateAndWriteBatch above) -- this is the value from whichever
      // attempt it came from, written as-is now that a second chance didn't produce a better one.
      const implausible = retryMissing.filter(it => it.lastImplausible);
      const trulyMissing = retryMissing.filter(it => !it.lastImplausible);
      if (implausible.length > 0) {
        const writeResults = await Promise.all(implausible.map((it) =>
          supabase.from('menu_items')
            .update({ calories_per_100g: it.lastImplausible.value, calories_unverified: true })
            .eq('id', it.id)
            .then(({ error }) => ({ ok: !error, it }))
        ));
        const written = writeResults.filter((r) => r.ok);
        const failedWrites = writeResults.filter((r) => !r.ok);
        estimated += written.length;
        flagged += written.length;
        if (failedWrites.length > 0) {
          const names = failedWrites.slice(0, 10).map((r) => r.it.name).join(', ');
          failures.push(`${failedWrites.length} item(s) had an unverified estimate ready but failed to save: ${names}${failedWrites.length > 10 ? '…' : ''}`);
        }
        const details = written.slice(0, 10)
          .map((r) => `"${r.it.name}" (${r.it.lastImplausible.value} kcal/100g -- ${r.it.lastImplausible.reason})`)
          .join('; ');
        failures.push(`${written.length} item(s) got an implausible estimate on both attempts -- written anyway, flagged unverified for review: ${details}${written.length > 10 ? '…' : ''}`);
      }
      if (trulyMissing.length > 0) {
        const names = trulyMissing.slice(0, 10).map(it => it.name).join(', ');
        failures.push(`${trulyMissing.length} item(s) still missing an estimate after retry: ${names}${trulyMissing.length > 10 ? '…' : ''}`);
      }
    }
  }

  e.sender.send('calorie-estimate-progress', { message: `Done -- ${estimated} of ${items.length} items updated (${flagged} flagged unverified).`, current: batches.length, total: batches.length });
  return { success: true, estimated, flagged, totalMissing: items.length, failures };
});

// AM Snack Pastry/Cold-Kitchen weekly rotation, Phase 1 -- backfills am_snack_style for every
// existing AM_SNACK item that's missing it, scoped to Daycare/KG_LP/MS_UP (the only sections the
// AM_SNACK category and the rotation rule apply to -- lib/generator.js's own
// AM_SNACK_ROTATION_SECTIONS). Idempotent, same convention as estimate-missing-calories: only
// ever touches rows where am_snack_style IS NULL, so re-running it later after new items are
// added just backfills whatever's still missing. Batching/retry/progress-event shape mirrors
// estimate-missing-calories exactly -- see that handler's own comments for the full reasoning
// (index-tagged reconciliation, sequential batches, per-item parallel writes within a batch).
const AM_SNACK_STYLE_IN_SCOPE_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];
const AM_SNACK_STYLE_BATCH_SIZE = 50;

ipcMain.handle('estimate-missing-am-snack-styles', async (e) => {
  const ageGroupIds = AM_SNACK_STYLE_IN_SCOPE_SECTIONS
    .map(code => getSectionByCode(code))
    .filter(Boolean)
    .flatMap(section => getAgeGroupsForSection(section.id).map(a => a.id));
  if (ageGroupIds.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  const portionRows = await fetchAllRowsMain(() => supabase
    .from('item_portions').select('item_id').in('age_group_id', ageGroupIds))
    .catch(err => { throw supaFail('estimate-missing-am-snack-styles: load item_portions', err); });
  const itemIds = [...new Set(portionRows.map(r => r.item_id))];
  if (itemIds.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  const amSnackCategory = getCategoryByCode('AM_SNACK');
  const { data: items, error: itemsErr } = await supabase
    .from('menu_items')
    .select('id, name')
    .in('id', itemIds)
    .eq('category_id', amSnackCategory.id)
    .is('am_snack_style', null);
  if (itemsErr) throw supaFail('estimate-missing-am-snack-styles: load menu_items', itemsErr);
  if (items.length === 0) return { success: true, estimated: 0, totalMissing: 0, failures: [] };

  async function classifyAndWriteBatch(batch) {
    const payloadItems = batch.map((it, idx) => ({ index: idx, name: it.name }));

    let estimates;
    try {
      estimates = await estimateAmSnackStyle({ items: payloadItems });
    } catch (err) {
      return { written: 0, missing: batch, error: err.message };
    }

    const byIndex = new Map(estimates.map(est => [est.index, est.am_snack_style]));
    const toWrite = [];
    const missing = [];
    batch.forEach((it, idx) => {
      const value = byIndex.get(idx);
      if (!value) missing.push(it);
      else toWrite.push({ it, value });
    });

    const writeResults = await Promise.all(toWrite.map(({ it, value }) =>
      supabase.from('menu_items').update({ am_snack_style: value }).eq('id', it.id)
        .then(({ error }) => ({ ok: !error, it }))
    ));
    writeResults.filter(r => !r.ok).forEach(r => missing.push(r.it));

    return { written: writeResults.filter(r => r.ok).length, missing, error: null };
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  let estimated = 0;
  const failures = [];
  let stillMissing = [];

  const batches = chunk(items, AM_SNACK_STYLE_BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    e.sender.send('am-snack-style-estimate-progress', {
      message: `Classifying batch ${b + 1} of ${batches.length} (${batch.length} items)…`, current: b + 1, total: batches.length,
    });
    const result = await classifyAndWriteBatch(batch);
    estimated += result.written;
    if (result.error) failures.push(`Batch ${b + 1} (${batch.length} items): ${result.error}`);
    stillMissing.push(...result.missing);
  }

  // Same "freeze at 100%, message-only" reasoning as estimate-missing-calories' own retry pass --
  // see its comment.
  if (stillMissing.length > 0) {
    e.sender.send('am-snack-style-estimate-progress', { message: `Retrying ${stillMissing.length} item(s) that didn't come back the first time…` });
    const retryBatches = chunk(stillMissing, AM_SNACK_STYLE_BATCH_SIZE);
    const retryMissing = [];
    for (let b = 0; b < retryBatches.length; b++) {
      const batch = retryBatches[b];
      e.sender.send('am-snack-style-estimate-progress', { message: `Retry batch ${b + 1} of ${retryBatches.length} (${batch.length} items)…` });
      const result = await classifyAndWriteBatch(batch);
      estimated += result.written;
      if (result.error) failures.push(`Retry batch ${b + 1} (${batch.length} items): ${result.error}`);
      retryMissing.push(...result.missing);
    }
    if (retryMissing.length > 0) {
      const names = retryMissing.slice(0, 10).map(it => it.name).join(', ');
      failures.push(`${retryMissing.length} item(s) still missing a classification after retry: ${names}${retryMissing.length > 10 ? '…' : ''}`);
    }
  }

  e.sender.send('am-snack-style-estimate-progress', { message: `Done -- ${estimated} of ${items.length} items updated.`, current: batches.length, total: batches.length });
  return { success: true, estimated, totalMissing: items.length, failures };
});

// ---------------------------------------------------------------
// IPC: Menu Ingredients Generator -- upload a menu .xlsx this app itself produced (Export All
// Sections/Generate Menu/Build Menu), get back an AI-suggested ingredient list per dish to
// review/edit, then export the annotated file. Purely file in, file out: nothing here reads
// from or writes to Supabase, and the only "persistence" between the two calls below is
// menuIngredientsWorkbook, an in-memory ExcelJS Workbook object that lives only for this running
// session (replaced by the next upload, gone on app restart) -- never a DB row.
// ---------------------------------------------------------------
// Keyed by fileIndex (position within the current upload batch's `files` array) -- each entry is
// { fileName, workbook, dishColumnBySheet }, one per file uploaded together in this batch.
// dishColumnBySheet is the map parseWorkbookDishes returned for THAT file's workbook --
// export-menu-ingredients needs it too (to insert the Ingredients column next to the dish column
// rather than past every other column), but it's computed at parse time, not export time, since
// computing it again here would mean duplicating parseWorkbookDishes' own column-detection logic.
// Replaced wholesale (new Map()) at the start of every parse-and-suggest-menu-ingredients call, in
// lockstep with menuIngredientsToken below, for the same reason a single-file version of this used
// to replace one plain variable.
let menuIngredientsFiles = new Map();
// The uploadToken of whichever parse most recently WON the race to populate menuIngredientsFiles
// above -- generated client-side (renderer.js, one per upload attempt, covering the WHOLE batch of
// files selected together) and threaded through both handlers below. Closes a real bug: this used
// to be one shared global with no identity check at all, so two overlapping calls (a second upload
// fired before the first resolved, or an export racing a fresh upload) could silently clobber each
// other -- whichever parse finished LAST won, regardless of which one's rows were actually on
// screen. Every checkpoint below re-reads this after an await and bails out (cancelled, not an
// error) the moment a newer upload has superseded the one currently running, so a superseded parse
// can never win the export or waste further AI calls once eclipsed. export-menu-ingredients below
// performs the same check before writing.
let menuIngredientsToken = null;
const MENU_INGREDIENTS_BATCH_SIZE = 50;
// Same 45s backstop every AI Edge Function call already has (estimateCalories/
// suggestDishIngredients/translateTexts) -- ExcelJS's own workbook.xlsx.load() had NONE, so a
// pathological file (or a genuinely stuck read) could hang this step forever with zero signal,
// which is exactly what happened: the UI showed "Reading file..." indefinitely since nothing
// ever wrote a later message over that static, panel-creation-time label (see the new
// e.sender.send calls below fixing that half of it).
const MENU_INGREDIENTS_PARSE_TIMEOUT_MS = 45_000;

// Live category display names for Daycare/KG-LP/MS-UP -- lib/menuIngredients.js's School
// vocabulary (used to content-detect the category column, and to break a School-vs-Staff tie
// when both the RC and GM/ML/Weight-Unit marker cells have been deleted from a block) is scored
// against this real list rather than a hardcoded guess, so it can never drift from the actual
// categories table.
// Temporary diagnostic logging for the "hangs on second upload" investigation -- every checkpoint
// in the file-read -> parse -> AI-suggest chain logs here with a timestamp, specifically so a live
// repro shows exactly which line execution actually stopped at, instead of inferring it from code
// review. Remove once the hang is confirmed fixed.
function miLog(msg, extra) {
  const line = `[mi-main ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) log.info(line, extra);
  else log.info(line);
}

function schoolCategoryVocabulary() {
  const codes = new Set();
  for (const sectionCode of ['DAYCARE', 'KG_LP', 'MS_UP']) {
    for (const [catCode] of SECTION_SLOTS[sectionCode]) codes.add(catCode);
  }
  return [...codes].map(code => getCategoryByCode(code)?.name).filter(Boolean);
}

// Extracted so a whole batch of dishes (across every file in the upload) shares the same AI-call
// logic, not scoped to any one file -- has no dependency on which file it's currently running for.
async function suggestBatch(batchNames) {
  const payloadItems = batchNames.map((name, idx) => ({ index: idx, name }));
  let estimates;
  try {
    estimates = await suggestDishIngredients({ items: payloadItems });
  } catch (err) {
    return { written: new Map(), missing: batchNames, error: err.message, removedByName: new Map() };
  }
  const byIndex = new Map(estimates.map(est => [est.index, est]));
  const written = new Map();
  const missing = [];
  // Mandatory nut/sesame-policy safety net (Misk school-wide restriction) -- runs on EVERY
  // suggestion regardless of how well the prompt/system instruction in
  // suggest-dish-ingredients/index.ts was followed, since an LLM instruction is never a hard
  // guarantee on its own. See lib/nutFilter.js for the full blocklist/false-positive reasoning.
  // Applied to BOTH the ingredients string and the allergens string (same reasoning as
  // ALLERGEN_RULE's own comment in index.ts -- "nut"/"sesame" must never surface as a flagged
  // allergen either, even if a stray one slips past the prompt). Never applied to Recipe
  // Extractor (extract-recipe) -- that transcribes a REAL recipe, so stripping a genuine
  // nut/sesame mention there would hide a true ingredient rather than block a fabricated one.
  const removedByName = new Map();
  batchNames.forEach((name, idx) => {
    const est = byIndex.get(idx);
    if (!est) { missing.push(name); return; }
    const ingredientsFilter = filterNutIngredients(est.ingredients);
    const allergensFilter = filterNutIngredients(est.allergens);
    written.set(name, { ingredients: ingredientsFilter.cleaned, allergens: allergensFilter.cleaned });
    if (ingredientsFilter.removed.length || allergensFilter.removed.length) {
      removedByName.set(name, { ingredients: ingredientsFilter.removed, allergens: allergensFilter.removed });
    }
  });
  return { written, missing, error: null, removedByName };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Processes ONE uploaded file end to end: read -> parse -> AI-suggest ingredients/allergens per
// unique dish name -> nut-filter -> annotate every row. Populates menuIngredientsFiles[fileIndex]
// on success, so export-menu-ingredients can find this exact file's in-memory workbook later by
// the same fileIndex the renderer already has. Every progress event is tagged with fileIndex (and
// fileName, for convenience) so the renderer can route it to that file's own progress row --
// mirrors clean-menus-for-sharing's own fileIndex-tagged 'clean-menu-progress' below for the same
// reason: N files uploaded together each need independently visible status. Returns
// { cancelled: true } the moment uploadToken is superseded by a newer upload (checked at the same
// checkpoints the original single-file version of this used to check), so the caller's loop over
// files can stop immediately rather than wasting further AI calls on results nobody will see. A
// file that fails to load/parse does NOT cancel the batch -- it returns success:false for just
// that file so the remaining files still get processed, same "one bad file never blocks the
// others" philosophy as cleanOneMenuFile.
async function processOneMenuIngredientsFile(e, fileIndex, { base64, fileName }, uploadToken) {
  const send = (payload) => e.sender.send('menu-ingredients-progress', { fileIndex, fileName, ...payload });
  miLog(`[file ${fileIndex} "${fileName}"] STARTING`);
  send({ message: 'Reading file…' });
  const buffer = Buffer.from(base64, 'base64');
  let workbook;
  let loadWarnings;
  try {
    ({ workbook, warnings: loadWarnings } = await Promise.race([
      loadWorkbookFromBuffer(buffer),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Reading the file timed out after ${MENU_INGREDIENTS_PARSE_TIMEOUT_MS / 1000}s -- it may be corrupted or unusually large`)),
        MENU_INGREDIENTS_PARSE_TIMEOUT_MS,
      )),
    ]));
  } catch (err) {
    miLog(`[file ${fileIndex} "${fileName}"] workbook.xlsx.load() FAILED/timed out: ${err.message}`);
    const error = `Couldn't read this file as an Excel workbook: ${err.message}`;
    send({ stage: 'error', message: error });
    return { fileIndex, fileName, success: false, error };
  }
  if (uploadToken !== menuIngredientsToken) {
    miLog(`[file ${fileIndex} "${fileName}"] bailing out after load -- superseded by a newer upload`);
    return { cancelled: true };
  }

  send({ message: 'Parsing menu structure…' });
  const { rows, warnings: parseWarnings, dishColumnBySheet } = await parseWorkbookDishes(workbook, schoolCategoryVocabulary());
  miLog(`[file ${fileIndex} "${fileName}"] parseWorkbookDishes() finished -- ${rows.length} row(s), ${parseWarnings.length} warning(s)`);
  if (rows.length === 0) {
    const error = "No recognizable menu rows found in this file. Make sure it's an export from Generate Menu, Build Menu, or Export All Sections.";
    send({ stage: 'error', message: error });
    return { fileIndex, fileName, success: false, error };
  }
  if (uploadToken !== menuIngredientsToken) {
    miLog(`[file ${fileIndex} "${fileName}"] bailing out after parse -- superseded by a newer upload`);
    return { cancelled: true };
  }

  // Dedup dish names (exact trimmed match) so a dish repeating across many days/rows only costs
  // one AI call -- its suggestion is broadcast back to every row sharing that exact name below.
  const uniqueNames = [...new Set(rows.map(r => r.dishName))];
  send({ message: `Found ${rows.length} dish row(s) across ${uniqueNames.length} unique dish(es) -- starting AI suggestions…` });

  const nameToIngredients = new Map();
  const nameToAllergens = new Map();
  const nameToRemovedNutTerms = new Map();
  const nameToRemovedAllergenNutTerms = new Map();
  const failures = [...loadWarnings, ...parseWarnings];
  const batches = chunk(uniqueNames, MENU_INGREDIENTS_BATCH_SIZE);
  miLog(`[file ${fileIndex} "${fileName}"] ${batches.length} batch(es) of up to ${MENU_INGREDIENTS_BATCH_SIZE} dishes each`);
  for (let b = 0; b < batches.length; b++) {
    // Bails out the moment a newer upload has superseded this one, rather than burning further
    // AI batches (and further wall-clock time) on results nobody will ever see.
    if (uploadToken !== menuIngredientsToken) {
      miLog(`[file ${fileIndex} "${fileName}"] bailing out before batch ${b + 1} -- superseded by a newer upload`);
      return { cancelled: true };
    }
    const batch = batches[b];
    send({ message: `Suggesting ingredients: batch ${b + 1} of ${batches.length} (${batch.length} dishes)…`, current: b + 1, total: batches.length });
    const result = await suggestBatch(batch);
    miLog(`[file ${fileIndex} "${fileName}"] batch ${b + 1}/${batches.length} FINISHED -- written=${result.written.size}, missing=${result.missing.length}, error=${result.error || 'none'}`);
    for (const [name, value] of result.written) {
      nameToIngredients.set(name, value.ingredients);
      nameToAllergens.set(name, value.allergens);
    }
    for (const [name, removed] of result.removedByName) {
      if (removed.ingredients.length) nameToRemovedNutTerms.set(name, removed.ingredients);
      if (removed.allergens.length) nameToRemovedAllergenNutTerms.set(name, removed.allergens);
    }
    if (result.error) failures.push(`Batch ${b + 1} (${batch.length} dishes): ${result.error}`);
    if (result.missing.length) {
      // One retry pass, same convention as estimate-missing-calories/estimate-missing-am-snack-
      // styles -- only the specific dishes that didn't come back, not the whole batch again. No
      // current/total here -- see those handlers' own comment on why a retry step stays
      // message-only (freezes the bar at its current position instead of moving it).
      send({ message: `Retrying ${result.missing.length} dish(es) from batch ${b + 1} that didn't come back the first time…` });
      const retry = await suggestBatch(result.missing);
      miLog(`[file ${fileIndex} "${fileName}"] batch ${b + 1}/${batches.length} retry FINISHED -- written=${retry.written.size}, still missing=${retry.missing.length}`);
      for (const [name, value] of retry.written) {
        nameToIngredients.set(name, value.ingredients);
        nameToAllergens.set(name, value.allergens);
      }
      for (const [name, removed] of retry.removedByName) {
        if (removed.ingredients.length) nameToRemovedNutTerms.set(name, removed.ingredients);
        if (removed.allergens.length) nameToRemovedAllergenNutTerms.set(name, removed.allergens);
      }
      if (retry.missing.length) {
        failures.push(`${retry.missing.length} dish(es) still missing a suggestion after retry -- left blank, fill in manually: ${retry.missing.slice(0, 10).join(', ')}${retry.missing.length > 10 ? '…' : ''}`);
      }
    }
  }

  if (uploadToken !== menuIngredientsToken) {
    miLog(`[file ${fileIndex} "${fileName}"] bailing out after all batches -- superseded by a newer upload`);
    return { cancelled: true };
  }

  send({ stage: 'done', message: `Done -- suggested ingredients for ${nameToIngredients.size} of ${uniqueNames.length} unique dishes.`, current: batches.length, total: batches.length });

  // `removedNutTerms` is the flat list of ORIGINAL segment text the nut filter stripped for this
  // exact dish name (e.g. ["toasted walnuts", "peanut butter"]) -- surfaced to the renderer so a
  // chef can see it per-row and manually re-add a specific term if they know their version is
  // actually nut-free, per the school's explicit instruction that this never happen silently.
  // `removedAllergenNutTerms` is the same, but for the allergens column (e.g. a stray "nut" word
  // the model wrote as an allergen despite ALLERGEN_RULE forbidding it).
  const annotatedRows = rows.map(r => ({
    ...r,
    ingredients: nameToIngredients.get(r.dishName) || '',
    allergens: nameToAllergens.get(r.dishName) || '',
    removedNutTerms: (nameToRemovedNutTerms.get(r.dishName) || []).map((x) => x.segment),
    removedAllergenNutTerms: (nameToRemovedAllergenNutTerms.get(r.dishName) || []).map((x) => x.segment),
  }));
  menuIngredientsFiles.set(fileIndex, { fileName, workbook, dishColumnBySheet });
  // The renderer no longer shows `failures` as a banner (see renderMenuIngredientsView in
  // renderer.js -- the yellow warnings box was removed), so this log is now the ONLY place that
  // detail survives. log.warn (not a bare console.log) specifically because electron-log's file
  // transport persists this to ~/Library/Logs/menu-generator/main.log even in a packaged build
  // with no attached terminal -- a bare console.log would vanish the moment the app quits, which
  // defeats "still traceable if a dish's ingredients look wrong later".
  if (failures.length) log.warn(`[menu-ingredients] [file ${fileIndex} "${fileName}"] ${failures.length} warning(s) from this upload:`, failures);
  // Separate from `failures` on purpose -- this is a safety-policy action (Misk's no-nuts rule),
  // not a parsing/AI-availability issue, and unlike `failures` it's ALSO shown per-row in the UI
  // (not silently dropped), so this log exists to make the same information searchable/durable
  // across sessions, not to compensate for the UI hiding it.
  if (nameToRemovedNutTerms.size) {
    const detail = [...nameToRemovedNutTerms.entries()].map(([name, removed]) => ({
      dish: name, removed: removed.map((x) => `${x.segment} (${x.matchedLabels.join(', ')})`),
    }));
    log.warn(`[menu-ingredients] [file ${fileIndex} "${fileName}"] nut-policy filter removed ingredient(s) from ${nameToRemovedNutTerms.size} dish(es):`, detail);
  }
  if (nameToRemovedAllergenNutTerms.size) {
    const detail = [...nameToRemovedAllergenNutTerms.entries()].map(([name, removed]) => ({
      dish: name, removed: removed.map((x) => `${x.segment} (${x.matchedLabels.join(', ')})`),
    }));
    log.warn(`[menu-ingredients] [file ${fileIndex} "${fileName}"] nut-policy filter removed allergen tag(s) from ${nameToRemovedAllergenNutTerms.size} dish(es):`, detail);
  }
  return { fileIndex, fileName, success: true, rows: annotatedRows, failures };
}

// `files` is an array of { base64, fileName }, one per file selected in a single upload action --
// always ALL the files from that one file-picker interaction, whether that's one or many (see
// renderer.js's mi-file-input, which now carries `multiple`). Every file in the batch shares the
// SAME uploadToken (generated client-side, one per upload attempt) -- a second upload started
// before this one finishes supersedes the whole batch, not just one file within it, same
// all-or-nothing replace semantics the single-file version of this handler always had.
ipcMain.handle('parse-and-suggest-menu-ingredients', async (e, { files, uploadToken }) => {
  miLog(`handler ENTERED, uploadToken=${uploadToken}, ${files.length} file(s)`);
  // Claims "current upload" status immediately -- any earlier call still in flight will see its
  // own uploadToken no longer matches at its next checkpoint below and bail out quietly. Replaces
  // the whole in-memory file map wholesale, same reasoning as menuIngredientsToken itself.
  menuIngredientsToken = uploadToken;
  menuIngredientsFiles = new Map();

  const results = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    // Sequential, not Promise.allSettled/concurrent, on purpose -- unlike clean-menus-for-sharing
    // (pure local CPU work), each file here makes real AI calls against the same Anthropic Edge
    // Function, so running N files' worth of batches in parallel would multiply that concurrency
    // uncontrolled. One file's own dish batches were already sequential before this change; this
    // just keeps that same one-call-at-a-time discipline across files too.
    const result = await processOneMenuIngredientsFile(e, fileIndex, files[fileIndex], uploadToken);
    if (result.cancelled) {
      miLog(`bailing out at file ${fileIndex} -- superseded by a newer upload`);
      return { success: false, cancelled: true };
    }
    results.push(result);
  }
  miLog(`handler RETURNING success=true -- ${results.filter(r => r.success).length}/${files.length} file(s) succeeded`);
  return { success: true, files: results, uploadToken };
});

// The exported file is always named after the ORIGINAL uploaded file, not a generic default --
// "13_09_2026 week_4.xlsx" in -> "13_09_2026 week_4_Ingredients.xlsx" out, whether it's the only
// file in this export or one of several.
function ingredientsExportFileName(originalFileName) {
  const base = (originalFileName || 'Menu').replace(/\.xlsx$/i, '');
  return `${base}_Ingredients.xlsx`;
}

// `files` is [{ fileIndex, rows }] -- rows is the SAME flat shape parse-and-suggest-menu-
// ingredients returned for that file, after her review/edits in the renderer -- each entry's
// `ingredients` may differ from what the AI first suggested, or from another row sharing the same
// dish name, since edits are per physical row (sheetName + rowNumber), never per dish name (see
// restructureAndAppendIngredients' own comment). `uploadToken` must match the upload batch that's
// actually currently in memory -- if she somehow triggers an export against a superseded upload
// (e.g. a second upload finished after she loaded the export dialog), this fails loudly instead of
// silently exporting the wrong file's data.
//
// Naming and zip behavior (both per the chef's explicit request): a SINGLE file exports directly
// as its own "<original name>_Ingredients.xlsx" -- no zip involved at all, exactly like every
// other single-file export elsewhere in this app. Only when MULTIPLE files are being exported
// together do they bundle into one zip (same jszip-plus-one-save-dialog pattern
// clean-menus-for-sharing above already established for its own multi-file case) -- Electron's
// save dialog can only target one path per call, so exporting N files without a zip would mean N
// separate native "Save As" prompts in a row, which is worse than one zip prompt.
ipcMain.handle('export-menu-ingredients', async (e, { files, uploadToken }) => {
  miLog(`export handler ENTERED, uploadToken=${uploadToken}, ${files.length} file(s)`);
  if (uploadToken !== menuIngredientsToken) {
    miLog('export bailing out -- stale uploadToken');
    return { success: false, error: "This file's data is no longer current (a newer upload replaced it) -- please upload it again before exporting." };
  }

  const outputs = [];
  for (const { fileIndex, rows } of files) {
    const entry = menuIngredientsFiles.get(fileIndex);
    if (!entry) {
      miLog(`export bailing out -- no in-memory workbook for fileIndex ${fileIndex}`);
      return { success: false, error: "This file's data is no longer current (a newer upload replaced it) -- please upload it again before exporting." };
    }
    miLog(`starting restructureAndAppendIngredients() for file ${fileIndex} "${entry.fileName}"`);
    await restructureAndAppendIngredients(entry.workbook, rows, entry.dishColumnBySheet);
    const buffer = Buffer.from(await entry.workbook.xlsx.writeBuffer());
    outputs.push({ fileName: ingredientsExportFileName(entry.fileName), buffer });
  }

  if (outputs.length === 1) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Menu with Ingredients',
      defaultPath: outputs[0].fileName,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) {
      miLog('save dialog cancelled');
      return { success: false, cancelled: true };
    }
    await fs.writeFile(result.filePath, outputs[0].buffer);
    miLog('export handler RETURNING success=true (single file, direct .xlsx)');
    return { success: true, path: result.filePath, count: 1 };
  }

  const zip = new JSZip();
  const usedNames = new Set();
  for (const { fileName, buffer } of outputs) {
    let zipName = fileName;
    let n = 2;
    const base = fileName.replace(/\.xlsx$/i, '');
    while (usedNames.has(zipName)) zipName = `${base} (${n++}).xlsx`;
    usedNames.add(zipName);
    zip.file(zipName, buffer);
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Menus with Ingredients',
    defaultPath: 'Menus_with_Ingredients.zip',
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) {
    miLog('save dialog cancelled');
    return { success: false, cancelled: true };
  }
  await fs.writeFile(result.filePath, zipBuffer);
  miLog(`export handler RETURNING success=true (${outputs.length} files zipped)`);
  return { success: true, path: result.filePath, count: outputs.length };
});

// ---------------------------------------------------------------
// IPC: Clean Menu for Sharing -- takes one or more already-exported/edited menu files (Generate
// Menu/Build Menu/Export All Sections, possibly with her own manual dropdown edits already made)
// and returns them with every formula flattened to its static value and every dropdown/data-
// validation rule removed. No AI involved, nothing for her to review before it's correct -- see
// stripFormulasToValues' own comment for why flattening a formula changes nothing visible (its
// cached result already IS what was displayed), and dataValidations.model is cleared wholesale
// per sheet (the same worksheet-level store cell.dataValidation itself reads/writes, see
// ExcelJS's own lib/doc/data-validations.js) rather than touched cell-by-cell, so this can never
// miss a rule regardless of how many cells/ranges carry one. Layout-agnostic by construction:
// both operations iterate every sheet/cell unconditionally, with no assumption about column
// position or which of School/Staff/CEO/combined-Export-All-Sections layout produced the file.
//
// Multi-file, one call: each file is processed independently (Promise.allSettled, no
// concurrency cap -- unlike the OpenAI-backed features elsewhere in this app, this is pure local
// CPU work with no external rate limit to respect), so one file with an unexpected structure
// fails on its own without blocking or delaying the others. Progress is reported per file (see
// `clean-menu-progress`, tagged by `fileIndex` matching the input array's own order) so the
// renderer can show independent status per row, not one shared bar. Every file that succeeds
// gets bundled into ONE zip (jszip, already a dependency -- see lib/menuIngredients.js's own
// runaway-data-validation fix) with a single save dialog at the end, rather than a separate
// save-as prompt per file (which would be both slower and awkward given files finish at
// different times) or silently writing into a folder she never chose.
async function cleanOneMenuFile({ base64, fileName }, fileIndex, onProgress) {
  onProgress({ fileIndex, stage: 'reading', message: 'Reading file…' });
  const buffer = Buffer.from(base64, 'base64');
  let workbook, warnings;
  try {
    ({ workbook, warnings } = await loadWorkbookFromBuffer(buffer));
  } catch (err) {
    const message = `Couldn't read this file as an Excel workbook: ${err.message}`;
    onProgress({ fileIndex, stage: 'error', message });
    throw new Error(message);
  }

  onProgress({ fileIndex, stage: 'cleaning', message: 'Stripping formulas and dropdowns…' });
  stripFormulasToValues(workbook);
  for (const sheet of workbook.worksheets) sheet.dataValidations.model = {};

  const outBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  onProgress({ fileIndex, stage: 'done', message: 'Done' });
  return { fileName, buffer: outBuffer, warnings: warnings || [] };
}

ipcMain.handle('clean-menus-for-sharing', async (e, { files }) => {
  const settled = await Promise.allSettled(
    files.map((f, fileIndex) => cleanOneMenuFile(f, fileIndex, (payload) => e.sender.send('clean-menu-progress', payload))),
  );

  const results = settled.map((r, i) => (
    r.status === 'fulfilled'
      ? { fileName: files[i].fileName, success: true }
      : { fileName: files[i].fileName, success: false, error: r.reason?.message || 'Failed' }
  ));
  const succeeded = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);

  if (succeeded.length === 0) {
    return { success: false, error: 'None of these files could be cleaned.', results };
  }

  const zip = new JSZip();
  const usedNames = new Set();
  for (const { fileName, buffer } of succeeded) {
    const baseName = (fileName || 'Menu').replace(/\.xlsx$/i, '');
    let zipName = `${baseName} (Clean).xlsx`;
    let n = 2;
    while (usedNames.has(zipName)) zipName = `${baseName} (Clean) ${n++}.xlsx`;
    usedNames.add(zipName);
    zip.file(zipName, buffer);
  }
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const defaultName = files.length === 1
    ? `${(files[0].fileName || 'Menu').replace(/\.xlsx$/i, '')} (Clean).zip`
    : 'Cleaned Menus.zip';
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Cleaned Menus',
    defaultPath: defaultName,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { success: false, cancelled: true, results };

  await fs.writeFile(saveResult.filePath, zipBuffer);
  return { success: true, path: saveResult.filePath, results };
});

// ---------------------------------------------------------------
// IPC: Recipe Generator -- AI-generates a full 150g-net-weight reference recipe per dish pulled from an
// uploaded menu file, for every dish EXCEPT Bread/Milk/Juice (and the already-established
// ready-made exclusions -- Fruit Basket/Fruit Bar/Salad Bar/Water/Soft Drinks) -- see
// lib/recipeGenerator.js's isExcludedCategory/isReadyMadeItem, matched by category TEXT,
// section-agnostic, per the chef's own instruction. (Reversed from the original 5-category
// include-list, per the chef's own explicit later request -- every OTHER category, e.g. Salads/
// Fruit Baskets/Staff Sweets/CEO items, is newly in scope by default now.) Reuses the SAME parse
// pipeline as Menu Ingredients Generator (lib/menuIngredients.js's
// loadWorkbookFromBuffer/parseWorkbookDishes), but as its own independent upload action, not the
// same upload/trigger -- confirmed with the chef (simpler state; one feature's slowness/failure
// never blocks the other). Every upload generates its OWN complete recipe set -- one recipe per
// eligible dish, every time -- with NO cross-upload duplicate check against what any earlier
// upload already generated (removed per the chef's own explicit request). The only dedup left is
// WITHIN one upload (the same dish repeating across sections/days of THIS file, e.g. "White Rice"
// in Daycare/KG-LP/MS-UP) -- see lib/recipeGenerator.js's dedupeWithinUpload.
//
// Unlike Menu Ingredients Generator (which holds the uploaded workbook in memory until she
// exports it back out), every generated recipe is written straight to generated_recipes as a
// draft row the moment it's generated -- the "must survive app restarts" draft requirement falls
// out of that for free, nothing further needed to "persist" it. A superseded upload (a second
// upload started before the first finished) is still guarded the same way Menu Ingredients
// Generator guards its own race, just to avoid wasting further AI batches/wall-clock time on
// results nobody will see -- not to prevent data loss, since each persisted draft is an
// independent insert, never a shared clobberable object.
// ---------------------------------------------------------------
const RECIPE_GEN_BATCH_SIZE = 8;
let recipeGenToken = null;

// Layout-agnostic fallback for a menu file that isn't one of this app's own exports (see
// lib/menuIngredients.js's flattenSheetForAI and supabase/functions/extract-menu-dishes/index.ts
// for the full reasoning) -- only reached from parse-and-generate-recipes below when
// parseWorkbookDishes' strict marker-based pass finds zero rows. Batches at 50 rows per call
// (same size every other lightweight per-item AI batch in this file uses --
// CALORIE_ESTIMATE_BATCH_SIZE/AM_SNACK_STYLE_BATCH_SIZE/MENU_INGREDIENTS_BATCH_SIZE), chunked
// PER SHEET (never spanning a sheet boundary) so every returned row can be tagged with the right
// sheetName, and run sequentially rather than in parallel, same reasoning as those three -- one
// slow/rate-limited call shouldn't fan out into a burst of concurrent ones. Returns the SAME
// `{ sheetName, rowNumber, date, weekday, category, dishName }` row shape parseWorkbookDishes
// returns, so nothing downstream of the parse step needs to know or care which pass actually
// produced a given row -- EXCEPT date/weekday, which this fallback pass genuinely doesn't
// extract (always null here): the AI extraction prompt (extract-menu-dishes) tracks/carries
// forward a CATEGORY label across rows already, but not a day/date header, so a dish generated
// via this fallback path currently lands with no day label in Drafts (see formatDayLabel/
// dedupeWithinUpload below) -- a known gap, not silently dropped data, for a real school-provided
// file that isn't in this app's own export layout. parse-and-suggest-menu-ingredients never reads
// either field regardless.
const DISH_EXTRACTION_BATCH_SIZE = 50;

async function extractDishesWithAI(workbook, onProgress) {
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const rows = [];
  const warnings = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.name === '_Lists' || HIDDEN_SHEET_STATES.has(sheet.state)) continue;
    const sheetRows = flattenSheetForAI(sheet);
    if (sheetRows.length === 0) continue;

    const batches = chunk(sheetRows, DISH_EXTRACTION_BATCH_SIZE);
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      onProgress(`AI-reading "${sheet.name}" (rows ${batch[0].rowNumber}-${batch[batch.length - 1].rowNumber})…`);
      let dishes;
      try {
        dishes = await extractMenuDishesAI({ rows: batch.map((r) => ({ i: r.rowNumber, c: r.cells })) });
      } catch (err) {
        warnings.push(`${sheet.name} rows ${batch[0].rowNumber}-${batch[batch.length - 1].rowNumber}: AI extraction failed (${err.message}) -- these rows were skipped.`);
        continue;
      }
      for (const d of dishes) {
        rows.push({
          sheetName: sheet.name, rowNumber: d.i, date: null, weekday: null,
          category: d.category || null, dishName: d.name.trim(),
        });
      }
    }
  }
  return { rows, warnings };
}

// A single human-readable display string for Drafts' own day-sub-grouping (requirement 4) --
// `date` is already the fixed "DD-MM-YYYY" string every export/parse in this app uses (see
// lib/menuIngredients.js's DATE_RE / lib/export.js's formatDateDDMMYYYY), `weekday` is whatever
// exact casing appeared in the sheet (e.g. "Monday"). One combined field, not two separate
// columns, since nothing downstream needs to sort or filter by it structurally -- it's read-only
// display text the same way source_menu_label already is. Both come back null from the
// AI-assisted fallback path (see extractDishesWithAI's own comment), so this returns null too in
// that case -- a dish with no day label simply doesn't get a day sub-heading in Drafts, same as
// any other "genuinely unknown" grouping key elsewhere in this file (e.g. source_menu_label's own
// "Unknown source" fallback in renderer.js).
function formatDayLabel(date, weekday) {
  if (weekday && date) return `${weekday} ${date}`;
  return weekday || date || null;
}

// Resolves an AI-proposed waste (name/percent/matchedExisting, from generate-dish-recipes) to a
// real waste_types id -- creating a new catalog row directly when genuinely nothing matches, no
// chef interaction and no scoped-impact modal (there's nothing to reconcile yet: this is the
// FIRST time this waste type exists at all, unlike a later manual edit to an existing row, which
// still goes through the normal onWastePercentUpdateClicked flow in renderer.js exactly as
// before). `wasteTypeCache` is a name(lowercased)->id Map, pre-seeded from the catalog fetched
// once at the start of parse-and-generate-recipes and extended here as new types are created --
// shared across the WHOLE upload (every dish in every batch), not just one call, so two dishes
// independently proposing the same new name (e.g. two things both needing "Heating Waste") don't
// create duplicate catalog rows.
//
// The defensive re-check against the real catalog (regardless of what the model claimed for
// matchedExisting) mirrors save-extracted-recipe's own resolveIngredientId -- "a wrong silent
// merge is worse than an extra click" there means never trusting the model's own judgment as the
// final word when a cheap, authoritative exact-match check is available instead.
async function resolveWasteTypeId({ name, percent }, wasteTypeCache) {
  const trimmed = (name || '').trim();
  const key = trimmed.toLowerCase();
  if (wasteTypeCache.has(key)) return wasteTypeCache.get(key);

  const { data: existing, error: findErr } = await supabase
    .from('waste_types').select('id').ilike('name', trimmed).limit(1);
  if (findErr) throw supaFail('resolveWasteTypeId: match waste_types', findErr);
  if (existing && existing.length > 0) {
    wasteTypeCache.set(key, existing[0].id);
    return existing[0].id;
  }

  const { data: created, error: createErr } = await supabase
    .from('waste_types').insert({ name: trimmed, default_percent: percent }).select('id').single();
  if (createErr) throw supaFail('resolveWasteTypeId: create waste_types', createErr);
  wasteTypeCache.set(key, created.id);
  return created.id;
}

// Strips any nut-policy-violating ingredient row (same mandatory safety net every other
// AI-suggested ingredient list in this app goes through -- see lib/nutFilter.js), normalizes
// every ingredient's quantity so the recipe's NET WEIGHT is REFERENCE_NET_WEIGHT_GRAMS (150 g; the "reference recipe" requirement -- see
// normalizeProcessesToGrams's own comment on why this happens here, mathematically, rather than
// being asked of the model directly), then writes the recipe/processes/ingredients/wastes as one
// new draft row. `sourceMenuLabel`/`dish.name` back this recipe's traceability fields
// (requirement 6); `dish.dayLabel` (see formatDayLabel) backs source_day_label, Drafts' own
// day-sub-grouping within a menu folder -- null when the source parse pass never captured a day
// (always true for the AI-assisted fallback path today). `wasteTypeCache` -- see resolveWasteTypeId
// above. No photo is ever set here --
// a freshly-generated draft always starts with photo_path null; a photo only ever gets attached
// afterward, either by hand or via the review form's manual "Generate Photo" button, both through
// save-generated-recipe (see that handler's own comment on why automatic per-dish generation here
// was tried and reverted).
async function persistGeneratedRecipeDraft({ dish, gen, sourceMenuLabel, wasteTypeCache }) {
  // Seafood backstop is section-conditional (unlike the nut filter, which runs unconditionally
  // on every recipe) -- only ever applied when this dish's own resolved section is a student
  // section (Daycare/KG-LP/MS-UP). Staff (and CEO, though CEO never reaches this function at all)
  // is exempt, so `isStudentSeafoodBanned` is computed once per dish, not per ingredient, and an
  // ingredient row only needs a SEPARATE check when this is true -- see lib/seafoodFilter.js's own
  // header comment for why this gating is what makes an otherwise-blunt keyword match safe here.
  const isStudentSeafoodBanned = isStudentSection(dish.section);
  const processesRaw = (gen.processes && gen.processes.length > 0 ? gen.processes : [{ name: gen.name || dish.name, ingredients: [], method_steps: [], wastes: [] }])
    .map((proc) => ({
      name: proc.name || dish.name,
      method: (proc.method_steps || []).join('\n'),
      ingredients: (proc.ingredients || [])
        .filter((ing) => matchNutTerms(ing.name).length === 0)
        .filter((ing) => !isStudentSeafoodBanned || matchSeafoodTerms(ing.name).length === 0)
        .map((ing) => ({ name: ing.name, quantity: ing.quantity, unit: ing.unit, method: ing.method })),
      wastes: (proc.wastes || []).filter((w) => w.name && w.name.trim()),
    }))
    // A process that lost every ingredient to the nut/seafood filter and has no method either is
    // dead weight -- drop it rather than save an empty process card she'd just have to delete
    // herself.
    .filter((proc) => proc.ingredients.length > 0 || proc.method);

  // Scaled so the recipe-level NET WEIGHT (after each process's own wastes) is REFERENCE_NET_WEIGHT_GRAMS -- the raw total is whatever
  // that takes. Quantity Produced is that Net Weight (blank when nothing had a numeric quantity to scale).
  const normalized = normalizeProcessesToNetWeight(processesRaw, REFERENCE_NET_WEIGHT_GRAMS);
  const producedNet = netWeightOfProcesses(normalized);

  const { data: inserted, error: insErr } = await supabase
    .from('generated_recipes')
    .insert({
      status: 'draft',
      name: gen.name || dish.name,
      category: dish.category || null,
      quantity_produced: producedNet > 0 ? `${producedNet} G` : null,
      date_created: new Date().toISOString().slice(0, 10),
      source_menu_label: sourceMenuLabel,
      source_dish_name: dish.name,
      source_day_label: dish.dayLabel || null,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (insErr) throw supaFail('persistGeneratedRecipeDraft: insert generated_recipes', insErr);
  const recipeId = inserted.id;

  for (let idx = 0; idx < normalized.length; idx++) {
    const proc = normalized[idx];
    const { data: insertedProc, error: procErr } = await supabase
      .from('generated_recipe_processes')
      .insert({ generated_recipe_id: recipeId, name: proc.name, method: proc.method || null, sort_order: idx })
      .select('id')
      .single();
    if (procErr) throw supaFail('persistGeneratedRecipeDraft: insert generated_recipe_processes', procErr);

    const ingredientRows = proc.ingredients.map((ing, i) => ({
      process_id: insertedProc.id,
      name: ing.name,
      quantity: ing.quantity ?? null,
      unit: ing.unit || null,
      method: ing.method || null,
      sort_order: i,
    }));
    if (ingredientRows.length) {
      const { error: ingErr } = await supabase.from('generated_recipe_ingredients').insert(ingredientRows);
      if (ingErr) throw supaFail('persistGeneratedRecipeDraft: insert generated_recipe_ingredients', ingErr);
    }

    const wasteRows = [];
    for (let wIdx = 0; wIdx < proc.wastes.length; wIdx++) {
      const w = proc.wastes[wIdx];
      const pct = parseFloat(w.percent);
      const safePct = isNaN(pct) ? 0 : pct;
      const wasteTypeId = await resolveWasteTypeId({ name: w.name, percent: safePct }, wasteTypeCache);
      wasteRows.push({ process_id: insertedProc.id, waste_type_id: wasteTypeId, percent: safePct, sort_order: wIdx });
    }
    if (wasteRows.length) {
      const { error: wErr } = await supabase.from('generated_recipe_process_wastes').insert(wasteRows);
      if (wErr) throw supaFail('persistGeneratedRecipeDraft: insert generated_recipe_process_wastes', wErr);
    }
  }
  return recipeId;
}

// Shared manual "Generate Photo" button for Recipe Book, Recipe Extractor, AND Recipe Generator's
// own edit forms (not just the automatic batch flow above) -- one handler, since generating a
// photo from a name/category/ingredients/method has nothing recipe-type-specific about it: it
// touches no recipe table at all, just returns base64 image bytes for the renderer to drop into
// whichever photo slot (single pendingPhoto or the gallery's pendingPhotos) that recipe type's
// OWN existing manual-upload code already populates -- the existing Save button then uploads it
// through that recipe type's own existing photo-upload path, completely unchanged. Never touches
// the recipe's actual saved ingredient list either way (see the nut-filter comment below).
//
// `ingredients` here is the RAW list straight from whatever's currently in the form (including
// unsaved edits, per the chef's own request) -- filtered through matchNutTerms before ever
// reaching the image prompt, the exact same check the automatic batch flow applies above. This is
// NOT the same thing as lib/nutFilter.js's own documented scope note that Recipe Book/Extractor's
// SAVED ingredients are deliberately never nut-filtered (those are real, manually-verified
// ingredients -- filtering them would falsely hide a genuine one from the recipe card). Filtering
// only what's sent to this transient, non-persisted image prompt doesn't touch that saved data at
// all -- a real Baklava recipe keeps its real walnuts on the card; the generated photo just isn't
// told to depict them.
ipcMain.handle('generate-recipe-photo', async (e, { dishName, category, ingredients, method }) => {
  const filteredIngredients = (Array.isArray(ingredients) ? ingredients : [])
    .filter((name) => matchNutTerms(name).length === 0)
    .slice(0, 12);
  // dishName ALSO goes through stripNutTermsFromText, not just the ingredient list -- a dish
  // literally named "Walnut Baklava" still leaked a nut-textured result even with "walnuts"
  // correctly removed from ingredients, confirmed by a real test generation (see that helper's
  // own comment). The RECIPE's real saved name is completely untouched by this -- only the copy
  // handed to the image prompt is sanitized.
  return generateDishImage({
    dishName: stripNutTermsFromText(dishName) || dishName, category, ingredients: filteredIngredients, method,
  });
});

// Strips filesystem-invalid characters from a recipe name to make a safe suggested filename --
// deliberately NOT lib/export.js's sanitizeSheetName, which truncates to 31 characters for
// Excel's own sheet-name limit (far too aggressive for a real filename -- "Chicken Piccata With
// Butter Creamy Sauce" would get chopped mid-word). A generous 150-char cap is plenty safe across
// every real filesystem this app runs on.
function sanitizePhotoFilename(name) {
  const cleaned = (name || 'Recipe Photo').replace(/[\\/?*<>|"[\]:]/g, '').trim();
  return (cleaned || 'Recipe Photo').slice(0, 150);
}

// Shared "Save to Computer" download for the photo lightbox (Recipe Book/Extractor/Generator's
// edit forms -- see renderer.js's openPhotoLightbox) -- one handler regardless of which recipe
// type or photo it came from, same "this operation has nothing recipe-type-specific about it"
// reasoning generate-recipe-photo above already established. `base64`/`ext` are parsed straight
// out of the lightbox's own <img> data: URL in the renderer (already-decoded image bytes sitting
// in memory -- manually uploaded or AI-generated, doesn't matter, both end up as the same data:
// URL), so this never re-fetches or re-derives the image, just writes what's already there to
// disk. Same dialog.showSaveDialog + write pattern every Excel export in this app already uses.
ipcMain.handle('save-photo-to-computer', async (e, { base64, ext, suggestedName }) => {
  const extension = ext === 'png' ? 'png' : 'jpg';
  const filterName = extension === 'png' ? 'PNG Image' : 'JPEG Image';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Photo',
    defaultPath: `${sanitizePhotoFilename(suggestedName)}.${extension}`,
    filters: [{ name: filterName, extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };
  await fs.writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return { success: true, path: result.filePath };
});

// Recipe on Fire -> one-page A4 PDF (see lib/recipePdf.js). The renderer sends plain data; nothing is read from or
// written to the database. The save dialog comes first, so cancelling never renders anything.
ipcMain.handle('export-recipe-pdf', async (e, { data, suggestedName } = {}) => {
  if (!data || typeof data !== 'object') throw new Error('export-recipe-pdf: no data');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Recipe on Fire PDF',
    defaultPath: `${recipePdf.safeFileName(suggestedName || data.title)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };
  const { pdf, pages } = await recipePdf.renderFitPdf(data, BrowserWindow);
  await fs.writeFile(result.filePath, pdf);
  return { success: true, path: result.filePath, pages };
});

ipcMain.handle('parse-and-generate-recipes', async (e, { base64, uploadToken, fileName }) => {
  recipeGenToken = uploadToken;

  e.sender.send('recipe-generator-progress', { message: 'Reading file…' });
  const buffer = Buffer.from(base64, 'base64');
  let workbook;
  try {
    ({ workbook } = await Promise.race([
      loadWorkbookFromBuffer(buffer),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Reading the file timed out after ${MENU_INGREDIENTS_PARSE_TIMEOUT_MS / 1000}s -- it may be corrupted or unusually large`)),
        MENU_INGREDIENTS_PARSE_TIMEOUT_MS,
      )),
    ]));
  } catch (err) {
    return { success: false, error: `Couldn't read this file as an Excel workbook: ${err.message}` };
  }
  if (uploadToken !== recipeGenToken) return { success: false, cancelled: true };

  e.sender.send('recipe-generator-progress', { message: 'Parsing menu structure…' });
  let { rows } = await parseWorkbookDishes(workbook, schoolCategoryVocabulary());
  const failures = [];
  // Strict pass found nothing -- this isn't necessarily one of this app's own exports (a
  // real school-provided menu file has none of the RC/"Quantity"/"Weight/Unit" markers
  // parseWorkbookDishes looks for at all). Rather than fail outright, fall back to the
  // AI-assisted, layout-agnostic pass (requirement 2) -- only reached here, so a file that DOES
  // match this app's own layout still takes the fast, free, marker-based path with no AI call.
  if (rows.length === 0) {
    e.sender.send('recipe-generator-progress', { message: "This file doesn't match our own export layout -- reading it with AI instead…" });
    const aiResult = await extractDishesWithAI(workbook, (message) => {
      e.sender.send('recipe-generator-progress', { message });
    });
    if (uploadToken !== recipeGenToken) return { success: false, cancelled: true };
    rows = aiResult.rows;
    failures.push(...aiResult.warnings);
    if (rows.length === 0) {
      return {
        success: false,
        error: "Couldn't find any recognizable dish rows in this file, even with AI-assisted reading. Make sure it's a real menu spreadsheet (dish names alongside day/category labels).",
      };
    }
  }
  if (uploadToken !== recipeGenToken) return { success: false, cancelled: true };

  // Excluded categories (Bread/Milk/Juice), ready-made items (Fruit Basket/Fruit Bar/Salad Bar/
  // Water/Soft Drinks/generic Milk-Juice), and CEO dishes (never generated at all, confirmed with
  // the chef) are filtered out, THEN deduped by dish name -- see lib/recipeGenerator.js's
  // dedupeWithinUpload for the full within-upload dedup reasoning (exact-normalized AND
  // near-duplicate matching, first-occurrence-wins for category/day label, restrictive-wins for
  // section). `section` is resolved from the sheet/tab name (see resolveSectionFromSheetName) --
  // exact for this app's own exports, keyword-matched for a real uploaded file, null when it
  // can't be confidently told; null is later treated as the SAFE (not-Staff) default for the
  // seafood restriction below, never guessed permissive.
  const uniqueDishes = dedupeWithinUpload(
    rows.map((r) => ({
      ...r,
      dayLabel: formatDayLabel(r.date, r.weekday),
      section: resolveSectionFromSheetName(r.sheetName),
    })),
  );

  if (uniqueDishes.length === 0) {
    return { success: false, error: 'No eligible dishes were found in this file (Bread, Milk, and Juice items, and CEO dishes, are intentionally excluded).' };
  }

  // No cross-upload duplicate check (removed per the chef's own explicit request): every upload
  // generates its own complete recipe set, one recipe per eligible dish, regardless of whether a
  // similar-or-identical recipe already exists from an earlier upload. Within-upload dedup (the
  // SAME dish repeating across multiple sections/days of THIS SAME file, e.g. "White Rice" in
  // Daycare/KG-LP/MS-UP) still happened above, in dedupeWithinUpload -- that's a different thing
  // and stays exactly as it was.
  e.sender.send('recipe-generator-progress', { message: `Found ${uniqueDishes.length} eligible dish(es) -- starting AI recipe generation…` });

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  let createdCount = 0;
  let batchCount = 0;
  if (uniqueDishes.length > 0) {
    // Fetched ONCE for the whole upload, not per batch -- the Edge Function has no DB access of
    // its own (see generate-dish-recipes' header comment), so this is how it learns what already
    // exists to match against. wasteTypeCache is pre-seeded from this same fetch and extended by
    // resolveWasteTypeId as new types are created during this run, so it's shared across every
    // dish in every batch (not reset per batch) -- two dishes independently proposing the same new
    // waste name only ever create one new catalog row between them.
    const { data: wasteTypesCatalog, error: wasteTypesErr } = await supabase.from('waste_types').select('id, name');
    if (wasteTypesErr) throw supaFail('parse-and-generate-recipes: load waste_types', wasteTypesErr);
    const existingWasteTypeNames = wasteTypesCatalog.map((w) => w.name);
    const wasteTypeCache = new Map(wasteTypesCatalog.map((w) => [w.name.trim().toLowerCase(), w.id]));

    // seafoodAllowed is computed here in CODE, not left for the model to infer from a section
    // name string -- confirmed with the chef: seafood/fish is banned as an ingredient for the 3
    // student sections (Daycare/KG-LP/MS-UP), allowed for Staff. A dish whose section couldn't be
    // confidently resolved (null -- see resolveSectionFromSheetName) gets the SAFE default here
    // too: `=== 'STAFF'` is false for null/anything else, so "unknown" always means "restricted",
    // never "permitted".
    async function generateBatch(batchDishes) {
      const payloadItems = batchDishes.map((d, idx) => ({
        index: idx, name: d.name, category: d.category || undefined, seafoodAllowed: d.section === 'STAFF',
        // Salad-category dishes get their dressing as its own process -- decided here in code, like seafoodAllowed.
        separateDressing: isSaladCategory(d.category),
      }));
      let recipes;
      try {
        recipes = await generateDishRecipes({ items: payloadItems, existingWasteTypeNames });
      } catch (err) {
        return { created: [], missing: batchDishes, declined: [], error: err.message };
      }
      const byIndex = new Map(recipes.map((r) => [r.index, r]));
      const created = [];
      const missing = [];
      const declined = [];
      for (let idx = 0; idx < batchDishes.length; idx++) {
        const dish = batchDishes[idx];
        const gen = byIndex.get(idx);
        if (!gen) { missing.push(dish); continue; }
        // The model's own escape hatch for a genuinely seafood-based dish concept landing in a
        // student section (a real menu-planning mistake, since policy prohibits it there) -- see
        // generate-dish-recipes' seafoodAllowed/skipReason. Confirmed with the chef: skip and flag
        // this for her review, don't attempt a substitute-protein version (unlike the nut policy,
        // which does substitute) and don't retry it as "missing" either -- the model DID answer,
        // it just correctly declined.
        if (gen.skipReason) { declined.push({ dish, reason: gen.skipReason }); continue; }
        created.push({ dish, gen });
      }
      return { created, missing, declined, error: null };
    }

    const batches = chunk(uniqueDishes, RECIPE_GEN_BATCH_SIZE);
    batchCount = batches.length;
    for (let b = 0; b < batches.length; b++) {
      if (uploadToken !== recipeGenToken) return { success: false, cancelled: true };
      const batch = batches[b];
      e.sender.send('recipe-generator-progress', {
        message: `Generating recipes: batch ${b + 1} of ${batches.length} (${batch.length} dishes)…`, current: b + 1, total: batches.length,
      });
      const result = await generateBatch(batch);
      if (result.error) failures.push(`Batch ${b + 1} (${batch.length} dishes): ${result.error}`);
      let toPersist = result.created;
      let declined = result.declined;
      if (result.missing.length) {
        e.sender.send('recipe-generator-progress', { message: `Retrying ${result.missing.length} dish(es) from batch ${b + 1} that didn't come back the first time…` });
        const retry = await generateBatch(result.missing);
        toPersist = [...toPersist, ...retry.created];
        declined = [...declined, ...retry.declined];
        if (retry.missing.length) {
          failures.push(`${retry.missing.length} dish(es) still missing a recipe after retry -- skipped: ${retry.missing.map((d) => d.name).slice(0, 10).join(', ')}${retry.missing.length > 10 ? '…' : ''}`);
        }
      }
      if (declined.length) {
        log.warn(`[recipe-generator] ${declined.length} dish(es) declined -- likely a seafood dish misfiled into a student section:`,
          declined.map((d) => `"${d.dish.name}": ${d.reason}`));
        failures.push(...declined.map((d) => `"${d.dish.name}" was skipped, not generated: ${d.reason}`));
      }

      // Text-only -- no automatic photo generation in this batch loop. That was tried and
      // reverted: a real image call measured at ~138s each, so generating one per dish here would
      // turn a single upload of 100-300+ dishes into HOURS of extra wall-clock time just for
      // photos, on top of recipe generation's own real cost. A photo is now only ever created via
      // the manual "Generate Photo" button on the review form (renderGeneratedRecipeFormView,
      // same generate-recipe-photo IPC channel Recipe Book/Extractor use) -- she generates one
      // only for the specific recipes she actually wants a photo for.
      for (const { dish, gen } of toPersist) {
        try {
          await persistGeneratedRecipeDraft({ dish, gen, sourceMenuLabel: fileName, wasteTypeCache });
          createdCount++;
        } catch (err) {
          failures.push(`"${dish.name}": ${err.message}`);
        }
      }
    }
  }

  if (uploadToken !== recipeGenToken) return { success: false, cancelled: true };

  e.sender.send('recipe-generator-progress', {
    message: `Done -- generated ${createdCount} of ${uniqueDishes.length} recipe(s).`,
    current: batchCount, total: batchCount,
  });
  if (failures.length) log.warn(`[recipe-generator] ${failures.length} warning(s) from this upload:`, failures);

  return {
    success: true, createdCount, dishCount: uniqueDishes.length, failures,
  };
});

async function fetchGeneratedRecipeWithProcesses(id) {
  const { data: recipe, error: recipeErr } = await supabase.from('generated_recipes').select('*').eq('id', id).single();
  if (recipeErr) {
    if (recipeErr.code === 'PGRST116') return null;
    throw supaFail('fetchGeneratedRecipeWithProcesses: load generated_recipes', recipeErr);
  }

  const { data: processRows, error: procErr } = await supabase
    .from('generated_recipe_processes')
    .select('id, name, method, sort_order')
    .eq('generated_recipe_id', id)
    .order('sort_order');
  if (procErr) throw supaFail('fetchGeneratedRecipeWithProcesses: load generated_recipe_processes', procErr);

  const processIds = processRows.map((p) => p.id);
  let ingredientRows = [];
  let wasteRows = [];
  if (processIds.length) {
    const { data, error: ingErr } = await supabase
      .from('generated_recipe_ingredients')
      .select('id, process_id, name, quantity, unit, method, sort_order')
      .in('process_id', processIds)
      .order('sort_order');
    if (ingErr) throw supaFail('fetchGeneratedRecipeWithProcesses: load generated_recipe_ingredients', ingErr);
    ingredientRows = data;

    const { data: wasteData, error: wasteErr } = await supabase
      .from('generated_recipe_process_wastes')
      .select('id, process_id, waste_type_id, percent, sort_order')
      .in('process_id', processIds)
      .order('sort_order');
    if (wasteErr) throw supaFail('fetchGeneratedRecipeWithProcesses: load generated_recipe_process_wastes', wasteErr);
    wasteRows = wasteData;
  }

  // Two-step join against waste_types (name only, never embedded via PostgREST) -- same
  // manual-Map convention fetchRecipeWithProcesses uses for its own wastes.
  const wasteTypeIds = [...new Set(wasteRows.map((r) => r.waste_type_id))];
  let wasteTypeById = new Map();
  if (wasteTypeIds.length) {
    const { data: wasteTypesData, error: wtErr } = await supabase
      .from('waste_types').select('id, name').in('id', wasteTypeIds);
    if (wtErr) throw supaFail('fetchGeneratedRecipeWithProcesses: load waste_types', wtErr);
    wasteTypeById = new Map(wasteTypesData.map((w) => [w.id, w]));
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

  const ingredientsByProcess = new Map();
  for (const ri of ingredientRows) {
    // ingredient_id/ingredient_name/default_unit-shaped keys (not a bare `name`) are deliberate
    // -- this object is consumed unmodified by renderer.js's buildProcessFromSaved (Recipe
    // Book/Extractor's own process-shaping function, reused as-is for Calculator's third source
    // -- see RECIPE_NS.generated) and by lib/export.js's buildRecipeContentModel, both of which
    // read ingredient_id/ingredient_name regardless of which table they came from. ingredient_id
    // is always null -- generated_recipe_ingredients has no such column at all (never linked to
    // any ingredient catalog, ever -- see the migration's own header comment).
    const ingredient = {
      id: ri.id,
      ingredient_id: null,
      ingredient_name: ri.name,
      quantity: ri.quantity,
      unit: ri.unit,
      method: ri.method,
      sort_order: ri.sort_order,
    };
    if (!ingredientsByProcess.has(ri.process_id)) ingredientsByProcess.set(ri.process_id, []);
    ingredientsByProcess.get(ri.process_id).push(ingredient);
  }

  const processes = processRows.map((p) => ({
    id: p.id,
    name: p.name,
    method: p.method,
    sort_order: p.sort_order,
    ingredients: ingredientsByProcess.get(p.id) || [],
    wastes: wastesByProcess.get(p.id) || [],
    // No Material/Tray on generated recipes -- real-batch production equipment, meaningless for
    // a 150g reference recipe (confirmed with the chef; deliberately excluded, see the parity
    // migration's own comment). Always present as null, never `undefined`, since
    // buildProcessFromSaved/buildRecipeContentModel read these fields regardless of source table.
    material_id: null,
    material_name: null,
    material_code: null,
    material_fill_weight_grams: null,
  }));

  return { ...recipe, processes };
}

ipcMain.handle('get-generated-recipe', async (e, id) => fetchGeneratedRecipeWithProcesses(id));

ipcMain.handle('preview-generated-recipe', async (e, id) => {
  const full = await fetchGeneratedRecipeWithProcesses(id);
  const { processes, ...recipe } = full;
  return buildRecipeContentModel(recipe, processes);
});

ipcMain.handle('list-generated-recipe-drafts', async () => {
  const { data, error } = await supabase
    .from('generated_recipes')
    .select('id, name, category, source_menu_label, source_dish_name, source_day_label, created_at')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });
  if (error) throw supaFail('list-generated-recipe-drafts', error);
  return data;
});

// RECIPE_NS.generated.api.list/search -- confirmed only, always. Drafts aren't scaling/export
// ready (see Recipe Calculator's third-source integration), so they're deliberately invisible
// to both the "Recipe Generated" list screen and Calculator's recipe picker; list-generated-
// recipe-drafts above is the only way to see a draft, via its own Drafts tab.
// source_menu_label is set once at draft creation (persistGeneratedRecipeDraft) and never
// touched by save-generated-recipe's own update, so it survives unchanged through confirm --
// selected here so the renderer can group this list by source menu (renderGeneratedConfirmedList/
// groupRecipesBySourceMenu) instead of the calendar-month grouping Recipe Book/Extractor's own
// list uses; no schema change needed, this column already existed on every row.
ipcMain.handle('list-generated-recipes', async () => {
  const { data, error } = await supabase
    .from('generated_recipes')
    .select('id, code, name, category, prepared_by, date_created, quantity_produced, source_menu_label')
    .eq('status', 'confirmed')
    .order('id', { ascending: false });
  if (error) throw supaFail('list-generated-recipes', error);
  return data;
});

ipcMain.handle('search-generated-recipes', async (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('generated_recipes')
    .select('id, code, name, category, quantity_produced')
    .eq('status', 'confirmed')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(25);
  if (error) throw supaFail('search-generated-recipes', error);
  return data;
});

// Mirrors nextRecipeCode/nextExtractedRecipeCode above, 'RG-' prefix, own table -- independent
// counter, same "find the highest existing number and increment client-side" tradeoff those two
// already accept (not race-proof against two simultaneous confirms, fine for a single-chef-team
// desktop tool).
async function nextGeneratedRecipeCode() {
  const { data, error } = await supabase.from('generated_recipes').select('code').like('code', 'RG-%');
  if (error) throw supaFail('nextGeneratedRecipeCode', error);
  let max = 0;
  for (const row of data) {
    const n = parseInt(row.code.slice(3), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return `RG-${String(max + 1).padStart(5, '0')}`;
}

// Single-photo model (mirrors RECIPE_PHOTOS_BUCKET/uploadRecipePhoto/deleteRecipePhoto exactly)
// -- a generated recipe is a speculative, AI-written reference, not something extracted from a
// real photographed card, so Book's single "here's an illustrative photo" model fits, not
// Extractor's multi-page-scan gallery (which exists specifically to capture several photos of
// one physical source document -- there's no such document here). Private bucket, same
// authenticated-only access as every other table/bucket in this app.
const GENERATED_RECIPE_PHOTOS_BUCKET = 'generated-recipe-photos';

async function uploadGeneratedRecipePhoto(base64, ext) {
  const path = `${crypto.randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage.from(GENERATED_RECIPE_PHOTOS_BUCKET).upload(path, buffer, { contentType });
  if (error) throw supaFail('uploadGeneratedRecipePhoto', error);
  return path;
}

async function deleteGeneratedRecipePhoto(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(GENERATED_RECIPE_PHOTOS_BUCKET).remove([path]);
  if (error) console.error('[supabase] deleteGeneratedRecipePhoto failed (non-fatal):', error.message);
}

ipcMain.handle('get-generated-recipe-photo', async (e, photoPath) => {
  if (!photoPath) return null;
  const { data, error } = await supabase.storage.from(GENERATED_RECIPE_PHOTOS_BUCKET).download(photoPath);
  if (error) throw supaFail('get-generated-recipe-photo', error);
  const buffer = Buffer.from(await data.arrayBuffer());
  const ext = photoPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

// Saves edits to an existing draft or confirmed generated recipe -- never creates one (generated
// recipes only ever come from AI generation, see parse-and-generate-recipes). `payload.confirm:
// true` additionally assigns the RG- code and flips draft -> confirmed in this SAME save, so
// reviewing-and-confirming a draft is one click, not "Save Draft" then a separate confirm step --
// a no-op on an already-confirmed recipe (code/status never move backward). Ingredient rows carry
// no ingredientId at all (never validated/required, unlike save-recipe) and are never
// resolved/created against any ingredient catalog (unlike save-extracted-recipe) -- pure free
// text, forever, per the migration's own header comment.
ipcMain.handle('save-generated-recipe', async (e, payload) => {
  const recipeId = payload.id;
  if (!recipeId) throw new Error('save-generated-recipe requires an existing draft id -- generated recipes are only ever created by AI generation, never manually.');

  const RECIPE_GONE_MESSAGE = 'This recipe was deleted or changed elsewhere. Please refresh Recipe Generator and try again.';
  const { data: existing, error: getErr } = await supabase.from('generated_recipes').select('code, status, photo_path').eq('id', recipeId).maybeSingle();
  if (getErr) throw supaFail('save-generated-recipe: load existing', getErr);
  if (!existing) throw new Error(RECIPE_GONE_MESSAGE);

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
    portion_weight_grams: payload.portionWeightGrams ?? null,
  };

  // photo_path is only ever touched when she actually picked a new file or hit "Remove Photo" --
  // omitted from `fields` entirely otherwise, same convention save-recipe uses, so an unrelated
  // edit never disturbs an already-uploaded photo.
  if (payload.photoBase64) {
    fields.photo_path = await uploadGeneratedRecipePhoto(payload.photoBase64, payload.photoExt);
  } else if (payload.removePhoto) {
    fields.photo_path = null;
  }

  let code = existing.code;
  let status = existing.status;
  if (payload.confirm && existing.status === 'draft') {
    code = await nextGeneratedRecipeCode();
    status = 'confirmed';
    fields.code = code;
    fields.status = status;
    fields.confirmed_at = new Date().toISOString();
  }

  const { data: updated, error: updErr } = await supabase.from('generated_recipes').update(fields).eq('id', recipeId).select('id');
  if (updErr) throw supaFail('save-generated-recipe: update generated_recipes', updErr);
  if (!updated || updated.length === 0) throw new Error(RECIPE_GONE_MESSAGE);

  // Clean up the old Storage object once the new one is safely committed -- same convention as
  // save-recipe, so replacing or removing a photo never leaves the previous upload orphaned.
  if ((payload.photoBase64 || payload.removePhoto) && existing.photo_path) {
    await deleteGeneratedRecipePhoto(existing.photo_path);
  }

  // Deleting the processes cascades to their ingredients AND wastes (process_id ON DELETE
  // CASCADE on both generated_recipe_ingredients and generated_recipe_process_wastes) -- no
  // separate delete needed for either, same convention as save-recipe/save-extracted-recipe.
  const { error: delErr } = await supabase.from('generated_recipe_processes').delete().eq('generated_recipe_id', recipeId);
  if (delErr) throw supaFail('save-generated-recipe: clear old generated_recipe_processes', delErr);

  const rawProcesses = payload.processes || [];
  const insertedProcessIds = [];
  for (let idx = 0; idx < rawProcesses.length; idx++) {
    const proc = rawProcesses[idx];
    const { data: insertedProc, error: procInsErr } = await supabase
      .from('generated_recipe_processes')
      .insert({
        generated_recipe_id: recipeId,
        name: (proc.name || '').trim() || `Process ${idx + 1}`,
        method: proc.method || null,
        sort_order: idx,
      })
      .select('id')
      .single();
    if (procInsErr) throw supaFail('save-generated-recipe: insert generated_recipe_processes', procInsErr);
    insertedProcessIds.push(insertedProc.id);
  }

  const ingredientRows = [];
  for (let pIdx = 0; pIdx < rawProcesses.length; pIdx++) {
    const procIngredients = rawProcesses[pIdx].ingredients || [];
    for (let idx = 0; idx < procIngredients.length; idx++) {
      const ing = procIngredients[idx];
      if (!ing.name || !ing.name.trim()) continue;
      ingredientRows.push({
        process_id: insertedProcessIds[pIdx],
        name: ing.name.trim(),
        quantity: ing.quantity ?? null,
        unit: ing.unit || null,
        method: ing.method || null,
        sort_order: idx,
      });
    }
  }
  if (ingredientRows.length) {
    const { error: insIngErr } = await supabase.from('generated_recipe_ingredients').insert(ingredientRows);
    if (insIngErr) throw supaFail('save-generated-recipe: insert generated_recipe_ingredients', insIngErr);
  }

  const wasteRows = [];
  for (let pIdx = 0; pIdx < rawProcesses.length; pIdx++) {
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
  if (wasteRows.length) {
    const { error: insWasteErr } = await supabase.from('generated_recipe_process_wastes').insert(wasteRows);
    if (insWasteErr) throw supaFail('save-generated-recipe: insert generated_recipe_process_wastes', insWasteErr);
  }

  return { id: recipeId, code, status };
});

ipcMain.handle('delete-generated-recipe', async (e, id) => {
  const { data: existing } = await supabase.from('generated_recipes').select('photo_path').eq('id', id).single();
  // Cascades to generated_recipe_ingredients AND generated_recipe_process_wastes via process_id
  // ON DELETE CASCADE.
  await supabase.from('generated_recipe_processes').delete().eq('generated_recipe_id', id);
  const { error } = await supabase.from('generated_recipes').delete().eq('id', id);
  if (error) throw supaFail('delete-generated-recipe', error);
  if (existing?.photo_path) await deleteGeneratedRecipePhoto(existing.photo_path);
  return { success: true };
});

ipcMain.handle('export-generated-recipes', async (e, { recipeIds, savePath, targetLanguage }) => {
  if (!recipeIds || recipeIds.length === 0) return { success: false };

  if (!savePath) {
    let defaultPath = 'Generated_Recipes_Export.xlsx';
    if (recipeIds.length === 1) {
      const { data, error } = await supabase.from('generated_recipes').select('name').eq('id', recipeIds[0]).single();
      if (error) throw supaFail('export-generated-recipes: load recipe name', error);
      defaultPath = `${sanitizeSheetName(data.name)}.xlsx`;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Generated Recipes',
      defaultPath,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  let doneCount = 0;
  await exportRecipes(async (recipeId) => {
    const full = await fetchGeneratedRecipeWithProcesses(recipeId);
    const { processes, ...recipe } = full;
    // Single-photo model, same as export-recipes' own handling -- 0 or 1 entries.
    recipe.photos = [];
    if (recipe.photo_path) {
      const { data, error } = await supabase.storage.from(GENERATED_RECIPE_PHOTOS_BUCKET).download(recipe.photo_path);
      if (error) throw supaFail('export-generated-recipes: download photo', error);
      const buffer = Buffer.from(await data.arrayBuffer());
      const ext = recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg';
      recipe.photos = [{ buffer, ext }];
    }
    doneCount++;
    if (targetLanguage && targetLanguage !== 'English') {
      e.sender.send('export-progress', recipeIds.length > 1
        ? { message: `Translating recipe ${doneCount} of ${recipeIds.length}…`, current: doneCount, total: recipeIds.length }
        : { message: 'Translating recipe…' });
    }
    const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
    return { ...translated, codeLabelKey: 'rgCode' };
  }, recipeIds, savePath, (message) => e.sender.send('export-progress', { message }));
  return { success: true, path: savePath };
});

// Recipe Calculator's RG- counterpart to export-scaled-recipe -- same single-photo
// photoOverride-wins-over-Storage-lookup handling, mirrored exactly.
ipcMain.handle('export-scaled-generated-recipe', async (e, { recipe, processes, savePath, targetLanguage, includeOriginalQty }) => {
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
  if (Object.prototype.hasOwnProperty.call(recipe, 'photoOverride')) {
    if (recipe.photoOverride) {
      recipe.photos = [{ buffer: Buffer.from(recipe.photoOverride.base64, 'base64'), ext: recipe.photoOverride.ext }];
    }
  } else if (recipe.photo_path) {
    const { data, error } = await supabase.storage.from(GENERATED_RECIPE_PHOTOS_BUCKET).download(recipe.photo_path);
    if (error) throw supaFail('export-scaled-generated-recipe: download photo', error);
    const buffer = Buffer.from(await data.arrayBuffer());
    const ext = recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg';
    recipe.photos = [{ buffer, ext }];
  }
  delete recipe.photoOverride;

  if (targetLanguage && targetLanguage !== 'English') e.sender.send('export-progress', { message: 'Translating recipe…' });
  const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
  await exportScaledRecipe(translated.recipe, translated.processes, savePath, {
    ...translated, codeLabelKey: 'rgCode', includeOriginalQty, onProgress: (message) => e.sender.send('export-progress', { message }),
  });
  return { success: true, path: savePath };
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
// Suggestions for the "Prepared By" / "Checked By" boxes (Recipe Book, Recipe Extractor, Recipe Generator, Calculator): every
// distinct name already used on any recipe (all three recipe tables, both columns), plus the names that should always be offered
// even before they have a recipe of their own (STANDING_RECIPE_PEOPLE). Names differing only in case or spacing are one entry, shown
// as first seen. The boxes stay free text -- this only feeds their suggestion list. Read in pages because PostgREST caps a single
// response at 1000 rows.
const STANDING_RECIPE_PEOPLE = ['Tetiana'];
ipcMain.handle('list-recipe-people', async () => {
  const seen = new Map(); // lowercased, single-spaced name -> display name
  const add = (raw) => {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  };
  STANDING_RECIPE_PEOPLE.forEach(add);
  for (const table of ['recipes', 'extracted_recipes', 'generated_recipes']) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select('prepared_by, checked_by').range(from, from + 999);
      if (error) throw supaFail(`list-recipe-people: ${table}`, error);
      (data || []).forEach((r) => { add(r.prepared_by); add(r.checked_by); });
      if (!data || data.length < 1000) break;
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
});

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
// recipe_process_wastes/extracted_recipe_process_wastes/generated_recipe_process_wastes row
// already snapshotting this waste type is overwritten to the new percent too, not just
// waste_types.default_percent -- generated_recipe_process_wastes added alongside Recipe
// Generator's own waste generation (an AI-created waste type is just a normal waste_types row
// the instant it exists, so it must cascade exactly like any chef-created one; this handler
// simply hadn't been updated for the third table when it was introduced). Sequential awaited
// calls, not a transaction -- same accepted tradeoff persistMenu() documents elsewhere in this
// app; a failure partway through leaves a recoverable, visible inconsistency rather than a
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
    const { error: gErr } = await supabase.from('generated_recipe_process_wastes').update({ percent: defaultPercent }).eq('waste_type_id', id);
    if (gErr) throw supaFail('update-waste-type: cascade generated_recipe_process_wastes', gErr);
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
    category: payload.category ?? null,
    shape_type: payload.shapeType,
    diameter_cm: payload.diameterCm ?? null,
    length_cm: payload.lengthCm ?? null,
    width_cm: payload.widthCm ?? null,
    height_cm: payload.heightCm ?? null,
    base_cm: payload.baseCm ?? null,
    tri_height_cm: payload.triHeightCm ?? null,
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

// ============================================================
// Dough Shapes -- a small, chef-managed catalog of REAL, AI-generated reference photos (round
// ball, baguette, mini baguette, ciabatta, more later), replacing the 3D parametric dough render
// the chef explicitly rejected as too game-like. All the real logic lives in lib/doughShapes.js
// (generation/upload/DB, all-or-nothing per shape) -- these handlers are thin IPC wrappers around
// it, same "pure helper, main.js orchestrates" split as lib/recipeGenerator.js. Recipe on Fire's
// dough-placement step (Phase C) is what actually consumes this catalog now.
// ============================================================

// Race-guard against a second "Generate" click before the first shape's 9-image batch finishes --
// same convention as recipeGenToken/menuIngredientsToken elsewhere in this file (avoid wasting
// further real-money OpenAI calls on a generation nobody will see, not to prevent data loss).
let doughShapeGenToken = null;

ipcMain.handle('get-dough-shape-photo', async (e, photoPath) => {
  if (!photoPath) return null;
  const { data, error } = await supabase.storage.from(DOUGH_SHAPE_PHOTOS_BUCKET).download(photoPath);
  if (error) throw supaFail('get-dough-shape-photo', error);
  const buffer = Buffer.from(await data.arrayBuffer());
  const ext = photoPath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('list-dough-shapes', async () => listDoughShapes());

// Chef-configurable shape presets for Recipe on Fire's Shape & Place (lib/doughShapePresets.js).
// `list` answers { available: false } instead of throwing while the migration hasn't been applied, so
// the renderer can fall back to its built-in presets. "Delete" archives (see the lib for why).
ipcMain.handle('list-dough-shape-presets', async () => doughShapePresets.listPresets());
ipcMain.handle('save-dough-shape-preset', async (e, input) => doughShapePresets.savePreset(input));
ipcMain.handle('delete-dough-shape-preset', async (e, id) => doughShapePresets.deletePreset(id));

ipcMain.handle('create-dough-shape', async (e, { name, unitWeightGrams, sizeCm }) => {
  const genToken = crypto.randomUUID();
  doughShapeGenToken = genToken;
  return createDoughShape({
    name, unitWeightGrams, sizeCm,
    onProgress: (payload) => e.sender.send('dough-shape-generate-progress', payload),
    isCancelled: () => doughShapeGenToken !== genToken,
  });
});

ipcMain.handle('delete-dough-shape', async (e, id) => deleteDoughShape(id));

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
    // created_at has no DB-side default on Supabase's recipes table (ingredients confirmed the
    // same, see add-ingredient; menu_items too, see add-item's own comment -- this claimed
    // menu_items had one, which turned out to be wrong), so it's set explicitly here,
    // insert-only, so editing a recipe later never resets it.
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
      // current/total only for a real multi-recipe batch -- a single recipe has no sub-steps to
      // count (one atomic translate-recipe call), so it stays message-only/indeterminate.
      e.sender.send('export-progress', recipeIds.length > 1
        ? { message: `Translating recipe ${doneCount} of ${recipeIds.length}…`, current: doneCount, total: recipeIds.length }
        : { message: 'Translating recipe…' });
    }
    const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
    return { ...translated, codeLabelKey: 'ttyCode' };
  }, recipeIds, savePath, (message) => e.sender.send('export-progress', { message }));
  return { success: true, path: savePath };
});

// Exports a scaled recipe built entirely in the renderer (Recipe Calculator) -- the recipe
// row itself and its scaling are never read from or written to the database here, `recipe`/
// `processes` arrive as plain data (already carrying photo_path through from the original
// recipe row via the Calculator's spread in renderScaledRecipeResult). The photo bytes still
// have to be fetched from Storage here, same as export-recipes above, since buildRecipeSheet
// only knows how to embed an in-memory photos array, not a storage path -- unless the Calculator
// edited the photo for this export (photoOverride), in which case those bytes came straight from
// the renderer and Storage is never touched at all. Either way, nothing here ever writes back to
// Storage or the recipe row -- purely local to this one export.
ipcMain.handle('export-scaled-recipe', async (e, { recipe, processes, savePath, targetLanguage, includeOriginalQty }) => {
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
  if (Object.prototype.hasOwnProperty.call(recipe, 'photoOverride')) {
    if (recipe.photoOverride) {
      recipe.photos = [{ buffer: Buffer.from(recipe.photoOverride.base64, 'base64'), ext: recipe.photoOverride.ext }];
    }
  } else if (recipe.photo_path) {
    const { data, error } = await supabase.storage.from(RECIPE_PHOTOS_BUCKET).download(recipe.photo_path);
    if (error) throw supaFail('export-scaled-recipe: download photo', error);
    const buffer = Buffer.from(await data.arrayBuffer());
    const ext = recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg';
    recipe.photos = [{ buffer, ext }];
  }
  delete recipe.photoOverride;

  if (targetLanguage && targetLanguage !== 'English') e.sender.send('export-progress', { message: 'Translating recipe…' });
  const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
  await exportScaledRecipe(translated.recipe, translated.processes, savePath, {
    ...translated, codeLabelKey: 'ttyCode', includeOriginalQty, onProgress: (message) => e.sender.send('export-progress', { message }),
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
        ? { message: `Translating recipe ${extractorDoneCount} of ${recipeIds.length}…`, current: extractorDoneCount, total: recipeIds.length }
        : { message: 'Translating recipe…' });
    }
    const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
    return { ...translated, codeLabelKey: 'exCode' };
  }, recipeIds, savePath, (message) => e.sender.send('export-progress', { message }));
  return { success: true, path: savePath };
});

// Recipe Calculator's EX- counterpart to export-scaled-recipe above -- `recipe`/`processes`
// arrive already scaled (Recipe Calculator's own multiplier math, reused unchanged from Book's
// path), nothing here recomputes quantities. `recipeId` is only used to look up this recipe's
// *original, unscaled* photos fresh from extracted_recipe_photos -- photos aren't a quantity, so
// there's nothing to scale, same as export-scaled-recipe never scaling recipe.photo_path either.
// A photosOverride (the Calculator's own gallery edit, if any) always wins over that DB lookup --
// its bytes come straight from the renderer (already downloaded once to build the on-screen
// gallery), so extracted_recipe_photos is never even queried in that case, and nothing here ever
// writes back to it or to Storage.
ipcMain.handle('export-scaled-extracted-recipe', async (e, { recipeId, recipe, processes, savePath, targetLanguage, includeOriginalQty }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Scaled Recipe',
      defaultPath: `${sanitizeSheetName(recipe.name)}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    savePath = result.filePath;
  }

  if (Object.prototype.hasOwnProperty.call(recipe, 'photosOverride')) {
    recipe.photos = (recipe.photosOverride || []).map(p => ({ buffer: Buffer.from(p.base64, 'base64'), ext: p.ext }));
  } else {
    const { data: photoRows, error: photoErr } = await supabase
      .from('extracted_recipe_photos').select('photo_path').eq('extracted_recipe_id', recipeId).order('sort_order');
    if (photoErr) throw supaFail('export-scaled-extracted-recipe: load extracted_recipe_photos', photoErr);
    recipe.photos = await downloadExtractedRecipePhotos(photoRows);
  }
  delete recipe.photosOverride;

  if (targetLanguage && targetLanguage !== 'English') e.sender.send('export-progress', { message: 'Translating recipe…' });
  const translated = await translateForRecipeExport(targetLanguage, recipe, processes);
  await exportScaledRecipe(translated.recipe, translated.processes, savePath, {
    ...translated, codeLabelKey: 'exCode', includeOriginalQty, onProgress: (message) => e.sender.send('export-progress', { message }),
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
  if (itemIds.length) {
    const { data: items, error: itemsErr } = await supabase
      .from('menu_items').select('id, name, rc_code, is_daily_repeating, category_id').in('id', itemIds);
    if (itemsErr) throw supaFail('fetchGeneratedMenuExportData: load menu_items', itemsErr);
    items.forEach(i => itemById.set(i.id, i));
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
  // item_portions.quantity is retired -- category_portion_defaults (lib/referenceData.js) is now
  // the ONLY source of portion size, no per-item override/exception path. Keyed off the same
  // slot-resolved category used for display above -- not the item's raw catalog category_id --
  // so a forced cross-category pick (e.g. Staff Main Dish's shared Lunch Main items) still gets
  // Staff Main's portion size, not Lunch Main's.
  const getPortion = (itemId, ageGroupId) => {
    const catId = displayCategoryByItem.get(itemId);
    const sectionId = getAgeGroupById(ageGroupId)?.section_id;
    if (catId == null || sectionId == null) return null;
    return getCategoryPortionDefault(catId, sectionId);
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

  // item_portions.quantity is retired -- same pure category+section lookup as
  // fetchGeneratedMenuExportData's getPortion, no per-item override/exception path. Note the
  // FIRST item_portions query above (building `pool`/allItemIds via section membership) is
  // untouched -- that's row-existence-only and still determines which items belong to which
  // sections; only the second, now-removed quantity/unit fetch this comment used to sit above is
  // gone.
  const getPortion = (itemId, ageGroupId) => {
    const sectionId = getAgeGroupById(ageGroupId)?.section_id;
    const catId = sectionId != null ? categoryByItem.get(`${sectionId}:${itemId}`) : undefined;
    if (catId == null || sectionId == null) return null;
    return getCategoryPortionDefault(catId, sectionId);
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

// `label` is the Workbook Name she typed in on whichever screen triggered this (Build Menu's own
// export button, or History's re-export of a saved batch, both of which combine all 5 sections
// into one workbook the same way generate-and-export-all's own Export All Sections view does) --
// falls back to the old fixed name only when a caller genuinely has none to offer.
ipcMain.handle('export-all-sections-to-excel', async (e, { menuIdsBySection, savePath, label }) => {
  if (!savePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Combined Menu Workbook',
      defaultPath: label ? `${label.replace(/\s+/g, '_')}.xlsx` : 'All_Sections_Menu.xlsx',
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
