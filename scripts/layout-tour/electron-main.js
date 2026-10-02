// One layout tour in ONE window (run it through run.js, which starts one Electron process per configuration: a second
// window in the same process can't start a renderer in some sandboxes). Loads the real renderer/index.html with a
// stubbed window.api (preload.js + data.js: no login, no Supabase, nothing written), walks the screens in STEPS and
// prints one line: "TOUR_RESULT <json>" with each step's measurements. Screenshots go to TOUR_SHOTS.
//
// Env: TOUR_CONFIG = mac | win, TOUR_SHOTS = a directory, TOUR_CSS = extra CSS injected last (for a control run,
// e.g. putting an old rule back to prove the tour catches it).
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { handlers, MI_FILES } = require('./data.js');

// Content sizes (useContentSize): mac = the default 1280 x 820 window minus the 28px title bar; win = that window's
// likely content on Windows 10/11 at 100% (about 8px of frame each side; title bar + menu bar + bottom frame about
// 59px) -- an estimate, not measured on a real machine. The classic scrollbar is Windows' 17px one, forced on every
// scroll container; macOS overlay scrollbars take no width.
const CONFIGS = {
  mac: { w: 1280, h: 792, css: '' },
  win: { w: 1264, h: 761, css: '::-webkit-scrollbar{width:17px;height:17px;background:#f0f0f0}::-webkit-scrollbar-thumb{background:#c1c1c1}' },
};
const CFG = CONFIGS[process.env.TOUR_CONFIG];
if (!CFG) { console.error(`TOUR_CONFIG must be one of ${Object.keys(CONFIGS).join(', ')}`); process.exit(2); }
const SHOTS = process.env.TOUR_SHOTS;
const EXTRA_CSS = process.env.TOUR_CSS || '';
const RENDERER = path.join(__dirname, '..', '..', 'renderer', 'index.html');

// Chromium pauses rAF / timers for a window nobody sees; the bake would "freeze" and a step would time out.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

ipcMain.handle('stub', (e, name, args) => {
  if (handlers[name]) return handlers[name](...args);
  if (/^(list|search)/.test(name) || /^get.*s$/.test(name)) return [];
  return null;
});

// [label, group, script run in the page (t = page-helpers)]. group 'rof' = Recipe on Fire, which must also fit
// vertically at the Mac size (CLAUDE.md: no scrolling to reach anything on that screen).
const pickRecipe = (id, q) => `
  document.querySelector('[data-view=history]').click(); await t.sleep(500);
  document.querySelector('[data-view=recipeOnFire]').click(); await t.sleep(800);
  const n = document.getElementById('rof-recipe-name'); n.focus(); n.value = '${q}'; n.dispatchEvent(new Event('input'));
  const item = await t.until(() => document.querySelector('#rof-recipe-list [data-pick="${id}"]'));
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await t.sleep(700);
  document.querySelectorAll('#rof-process-checks input[type=checkbox]').forEach(c => { if (!c.checked) c.click(); });
  await t.until(() => document.getElementById('rof-material-select')); await t.sleep(600);`;
const pickTray = (id) => `const s = document.getElementById('rof-material-select'); s.value = '${id}'; s.dispatchEvent(new Event('change')); await t.sleep(1200);`;
const actionBtn = (re) => `[...document.querySelectorAll('.rof-actions button')].reverse().find(b => b.offsetParent && !b.disabled && ${re}.test(b.textContent))`;
const SECTION_TABS = [['Daycare', 'DAYCARE'], ['KG-LP', 'KG_LP'], ['MS-UP', 'MS_UP'], ['Staff', 'STAFF'], ['CEO', 'CEO']];

const STEPS = [
  ['Dish Catalog (60 rows)', 'app', `await t.until(() => document.querySelector('.dish-catalog-table'));`],
  ['Dish Catalog (search -> 2 rows)', 'app', `const s = document.getElementById('item-search'); s.value = 'Lentil'; s.dispatchEvent(new Event('input')); await t.sleep(500);`],
  ['Edit Item (with ingredients)', 'app', `document.getElementById('item-search').value = ''; document.getElementById('item-search').dispatchEvent(new Event('input')); await t.sleep(300);
    document.querySelector('[data-edit]').click(); await t.until(() => document.getElementById('m-ingredients'));`],
  ['Menu Ingredients: review (catalog rows)', 'app', `document.getElementById('m-cancel').click(); await t.sleep(300);
    document.querySelector('[data-view=menuIngredients]').click(); await t.sleep(600);
    state.menuIngredients.files = ${JSON.stringify(MI_FILES)}; state.menuIngredients.uploadToken = 'tour';
    renderMenuIngredientsView(document.getElementById('main')); await t.until(() => document.querySelector('.mi-from-catalog'));`],
  ['Menu Ingredients: save lists (preview)', 'app', `await t.click('Save approved lists');
    state.catalogIngredientsSave.files = [{ name: 'September week_04_Ingredients.xlsx', base64: '' }]; renderCatalogIngredientsSaveView(document.getElementById('main'));
    await t.click('Read files'); await t.until(() => document.getElementById('cs-apply'));`],
  ['Menu Ingredients: save lists (result)', 'app', `document.getElementById('cs-apply').click(); await t.until(() => document.getElementById('cs-done'));`],
  ['Generate / One Section', 'app', `localStorage.setItem('menuPlannerMode', JSON.stringify({ mode: 'generate', scope: 'one' })); document.querySelector('[data-view=menuPlanner]').click(); await t.sleep(800);`],
  ['Generate / All Sections', 'app', `await t.click('All Sections');`],
  ['Build Menu (before grids)', 'app', `await t.click('Build');`],
  ...SECTION_TABS.map(([label, code], i) => ['Build Menu grid ' + label, 'app', i === 0 ? `
    document.getElementById('bm-label').value = 'Layout tour';
    document.getElementById('bm-start').value = '2026-10-04'; document.getElementById('bm-end').value = '2026-10-08';
    await t.click('Build Grids'); await t.until(() => document.querySelector('[data-builder-section]')); await t.sleep(600);`
    : `document.querySelector('[data-builder-section="${code}"]').click(); await t.sleep(500);`]),
  ['Recipe Generator: draft folder', 'app', `document.querySelector('[data-view=recipeGenerator]').click(); await t.sleep(800);
    (await t.until(() => document.querySelector('[data-rg-tab=drafts]'))).click(); await t.sleep(600);
    (await t.until(() => document.querySelector('[data-rg-open-folder="0"]'))).click(); await t.until(() => document.querySelector('.rg-drafts-table'));`],
  ['Recipe Generator: Recipe Generated', 'app', `document.querySelector('[data-rg-tab=generated]').click(); await t.until(() => document.querySelector('.rg-generated-table'));`],
  ['RoF Setup (empty)', 'rof', `document.querySelector('[data-view=recipeOnFire]').click(); await t.sleep(900);`],
  ['RoF Setup, one process + tray', 'rof', pickRecipe(1, 'Croissant') + pickTray(1)],
  ['RoF Shape & Place: Place', 'rof', `await t.click('Continue'); await t.sleep(1500);`],
  ['RoF Shape & Place: Bake', 'rof', `await t.click('Auto-arrange').catch(() => {}); await t.sleep(600); ${actionBtn('/Bake/')}.click(); await t.sleep(1500);`],
  ['RoF Sheet & Trim: Setup', 'rof', pickRecipe(1, 'Croissant') + pickTray(1) + `document.querySelector('[data-rof-mode=sheet]').click(); await t.sleep(700);`],
  ['RoF Sheet & Trim: Bake', 'rof', `await t.click('Continue'); await t.sleep(1500);`],
  ['RoF Sheet & Trim: Trim', 'rof', `await t.click('Start baking'); await t.sleep(800); await t.click('Skip').catch(() => {});
    await t.until(() => ${actionBtn('/Trim/')}, 20000); ${actionBtn('/Trim/')}.click(); await t.sleep(1800);`],
  ['RoF Layers: Setup', 'rof', pickRecipe(2, 'Knafeh') + pickTray(1) + `(await t.until(() => document.querySelector('[data-rof-layout=layers]'))).click(); await t.sleep(900);`],
  ['RoF Layers: Batch', 'rof', `await t.click('From a portion target'); await t.sleep(1200);`],
  ['RoF One dough (2 processes): Setup', 'rof', pickRecipe(2, 'Knafeh') + pickTray(1) + `const l = document.querySelector('[data-rof-layout=mixed]'); if (l) l.click(); await t.sleep(900);`],
];

// A hung step (a button that never appears) must not hang the tour.
setTimeout(() => { console.error('layout tour: timed out after 4 minutes'); app.exit(3); }, 240000).unref();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: CFG.w, height: CFG.h,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const consoleErrors = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 3) consoleErrors.push(msg.slice(0, 300)); });
  win.webContents.on('dom-ready', () => {
    const css = CFG.css + EXTRA_CSS;
    if (css) win.webContents.insertCSS(css);
    win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'page-helpers.js'), 'utf8'));
  });
  await win.loadFile(RENDERER);
  const js = (s) => win.webContents.executeJavaScript(`(async () => { const t = window.__t; ${s} })()`);
  const results = [];
  for (const [label, group, script] of STEPS) {
    try {
      await js(script);
      await js('await t.sleep(500);');
      const m = await js('return t.metrics();');
      results.push({ label, group, ...m });
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${process.env.TOUR_CONFIG}-${label.replace(/[^a-z0-9]+/gi, '_')}.png`), (await win.webContents.capturePage()).toPNG());
    } catch (e) {
      results.push({ label, group, error: String(e.message).slice(0, 300) });
    }
  }
  console.log('TOUR_RESULT ' + JSON.stringify({ config: process.env.TOUR_CONFIG, width: CFG.w, height: CFG.h, results, consoleErrors }));
  app.quit();
});
