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
const { handlers, MI_FILES, MI_WEEK, MI_MONTH } = require('./data.js');

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
  ['Dish Catalog: remove old codes (preview)', 'app', `document.getElementById('item-search').value = ''; document.getElementById('item-search').dispatchEvent(new Event('input')); await t.sleep(300);
    document.getElementById('code-removal-btn').click(); await t.until(() => document.getElementById('crm-apply'));`],
  ['Dish Catalog: build master items (preview)', 'app', `document.getElementById('crm-cancel').click(); await t.sleep(300);
    document.getElementById('master-build-btn').click(); await t.until(() => document.getElementById('mib-apply')); document.querySelector('.mib-modal details').open = true; await t.sleep(200);`],
  ['Dish Catalog: link rows without a version (preview)', 'app', `document.getElementById('mib-cancel').click(); await t.sleep(300);
    document.getElementById('link-rows-btn').click(); await t.until(() => document.getElementById('lr-apply')); document.querySelector('#lr-body details').open = true; await t.sleep(200);`],
  ['Edit Item (with ingredients)', 'app', `document.getElementById('lr-cancel').click(); await t.sleep(300); document.getElementById('item-search').value = ''; document.getElementById('item-search').dispatchEvent(new Event('input')); await t.sleep(300);
    document.querySelector('[data-edit]').click(); await t.until(() => document.getElementById('m-ingredients'));`],
  ['Menu Ingredients: review (catalog rows)', 'app', `document.getElementById('m-cancel').click(); await t.sleep(300);
    document.querySelector('[data-view=menuIngredients]').click(); await t.sleep(600);
    state.menuIngredients.files = ${JSON.stringify(MI_FILES)}; state.menuIngredients.uploadToken = 'tour';
    renderMenuIngredientsView(document.getElementById('main')); await t.until(() => document.querySelector('.mi-mark-catalog'));`],
  ['Menu Ingredients: save lists (preview)', 'app', `await t.click('Save approved lists');
    state.catalogIngredientsSave.files = [{ name: 'September week_04_Ingredients.xlsx', base64: '' }]; renderCatalogIngredientsSaveView(document.getElementById('main'));
    await t.click('Read files'); await t.until(() => document.getElementById('cs-apply'));`],
  ['Menu Ingredients: save lists (result)', 'app', `document.getElementById('cs-apply').click(); await t.until(() => document.getElementById('cs-done'));`],
  ['Menu Ingredients: History tab', 'app', `state.catalogIngredientsSave.open = false; state.menuIngredients.tab = 'history';
    document.querySelector('[data-view=menuIngredients]').click(); await t.until(() => document.querySelector('.mi-history-table'));`],
  ['Menu Ingredients: opened entry, unsaved changes', 'app', `document.querySelector('.mi-history-table [data-open]').click(); await t.until(() => document.querySelector('.mi-ing-cell'));
    [...document.querySelectorAll('.mi-ing-cell')].find(c => !c.classList.contains('mi-following')).click();
    const ta = (await t.until(() => document.getElementById('mi-pop'))).querySelector('textarea'); ta.value += ' - fresh basil'; ta.dispatchEvent(new Event('input'));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await t.until(() => document.getElementById('mi-strip-save'));`],
  ['Menu Ingredients: someone else saved first', 'app', `state.menuIngredients.history.conflict = { by: 'tetiana', at: '2026-10-06T12:05:00.000Z' }; miRenderHistoryBar();
    await t.until(() => document.getElementById('mi-hist-as-new'));`],
  ['Menu Ingredients grid: Daycare', 'app', `state.menuIngredients = { files: ${JSON.stringify(MI_WEEK)}, uploadToken: 'tour-grid', tab: 'generator', opened: null, history: miFreshHistory('saved') };
    Object.assign(state.menuIngredients.history, { runId: 7, version: 1 });
    renderMenuIngredientsView(document.getElementById('main')); await t.until(() => document.querySelector('.mi-grid'));
    const sc = document.getElementById('mi-scroll'); sc.scrollTop = document.getElementById('mi-review').offsetTop - 8;
    const h = {};
    for (const s of ['Daycare', 'KG - LP', 'MS - UP (B-G)', 'CEO', 'Daycare']) { document.querySelector('[data-mi-sheet="' + s + '"]').click(); h[s] = Math.round(document.querySelector('.mi-day').offsetHeight); }
    sc.scrollTop = document.getElementById('mi-review').offsetTop - 8;
    window.__tourNote = 'one day: ' + Object.entries(h).map(([k, v]) => k + ' ' + v + 'px').join(', ') + ' -- scroll area ' + sc.clientHeight + 'px';`],
  ['Menu Ingredients grid: Staff (32-row day)', 'app', `document.querySelector('[data-mi-sheet="Staff"]').click(); await t.until(() => document.querySelectorAll('.mi-grid tbody tr').length >= 160);
    const sc = document.getElementById('mi-scroll'); const day = document.querySelector('.mi-day');
    window.__tourNote = 'one Staff day is ' + Math.round(day.offsetHeight) + 'px tall in a ' + sc.clientHeight + 'px scroll area (scrolls, as agreed)';`],
  ['Menu Ingredients: expanded cell (keyboard, no movement)', 'app', `document.querySelector('[data-mi-sheet="KG - LP"]').click(); await t.until(() => document.querySelector('.mi-grid'));
    const sc = document.getElementById('mi-scroll'); sc.scrollTop = document.getElementById('mi-review').offsetTop - 8;
    const boxes = () => [...document.querySelectorAll('.mi-grid')].map(x => { const b = x.getBoundingClientRect(); return [b.top, b.left, b.width, b.height].map(Math.round).join(','); }).join('|');
    const before = boxes();
    const cell = document.querySelectorAll('.mi-ing-cell')[4]; cell.focus();
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const pop = await t.until(() => document.getElementById('mi-pop'));
    if (boxes() !== before) throw new Error('the grid moved when the cell opened');
    const pr = pop.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    if (Math.abs(pr.top - cr.top) > 1 || Math.abs(pr.left - cr.left) > 1) throw new Error('the popover is not over its cell');
    const ta = pop.querySelector('textarea'); const row = miCtx.byKey.get(cell.dataset.key);
    ta.value = ta.value + ' - fresh basil'; ta.dispatchEvent(new Event('input'));
    if (!row.ingredients.endsWith(' - fresh basil')) throw new Error('the edit did not reach the row');
    if (boxes() !== before) throw new Error('the grid moved while editing');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (document.getElementById('mi-pop')) throw new Error('Esc did not close it');
    if (document.activeElement !== cell) throw new Error('focus did not come back to the cell');
    if (!cell.textContent.includes('fresh basil')) throw new Error('the edit is not in the closed cell');
    if (!document.getElementById('mi-strip-save')) throw new Error('no Save changes in the docked strip after an edit');
    const beforeNext = boxes(); // the edit made that row's text longer: opening the next cell is compared with this
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    (await t.until(() => document.getElementById('mi-pop'))).querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const next = document.querySelectorAll('.mi-ing-cell')[5];
    await t.until(() => miPop && miPop.cell === next && document.activeElement === document.querySelector('#mi-pop textarea'));
    if (document.querySelectorAll('.mi-pop').length !== 1) throw new Error('more than one cell open');
    if (boxes() !== beforeNext) throw new Error('the grid moved with the next cell open');
    window.__tourNote = 'no movement: every day table identical before / during; Enter opens, the edit reaches the row and stays after Esc, focus returns, Tab opens the next dish, one popover at a time';`],
  ['Menu Ingredients: expanded cell, last row at the edge', 'app', `document.querySelector('[data-mi-sheet="Staff"]').click(); await t.until(() => document.querySelectorAll('.mi-grid tbody tr').length >= 160);
    const sc = document.getElementById('mi-scroll'); sc.scrollTop = sc.scrollHeight; await t.sleep(150);
    const boxes = () => [...document.querySelectorAll('.mi-grid')].map(x => { const b = x.getBoundingClientRect(); return [b.top, b.left, b.width, b.height].map(Math.round).join(','); }).join('|');
    const before = boxes();
    const cells = [...document.querySelectorAll('.mi-ing-cell')]; const cell = cells[cells.length - 1];
    cell.click(); const pop = await t.until(() => document.getElementById('mi-pop'));
    if (boxes() !== before) throw new Error('the grid moved when the cell opened');
    const pr = pop.getBoundingClientRect(), sr = sc.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    const visRight = sr.left + sc.clientWidth, visBottom = sr.top + sc.clientHeight;
    if (pr.right > visRight + 0.5) throw new Error('the popover runs ' + Math.round(pr.right - visRight) + 'px under the scrollbar / off the right');
    if (pr.bottom > visBottom + 0.5) throw new Error('the popover runs ' + Math.round(pr.bottom - visBottom) + 'px below the visible area');
    if (pr.left > cr.left + 1 || pr.right < cr.right - 1) throw new Error('the popover does not cover its cell');
    window.__tourNote = 'last row of the last Staff day: popover ' + Math.round(pr.width) + 'px wide, ' + Math.round(visRight - pr.right) + 'px inside the visible edge (scrollbar ' + (sc.offsetWidth - sc.clientWidth) + 'px), ' + Math.round(visBottom - pr.bottom) + 'px above the bottom; grid unchanged';`],
  ['Menu Ingredients grid: 1,540 rows in 4 files', 'app', `const main = document.getElementById('main');
    const t0 = performance.now();
    state.menuIngredients = { files: ${JSON.stringify(MI_MONTH)}, uploadToken: 'tour-month', tab: 'generator', opened: null, history: miFreshHistory('saved'), activeSheet: 'Staff' };
    renderMenuIngredientsView(main);
    const t1 = performance.now();
    const rows = document.querySelectorAll('.mi-grid tbody tr').length, inputs = document.querySelectorAll('#mi-review input, #mi-review textarea').length, els = document.getElementById('mi-review').querySelectorAll('*').length;
    const t2 = performance.now(); document.querySelector('[data-mi-sheet="Daycare"]').click(); const t3 = performance.now();
    document.querySelector('[data-mi-sheet="Staff"]').click();
    window.__tourNote = '1,540 rows: Staff tab (largest) draws ' + rows + ' rows, ' + inputs + ' inputs, ' + els + ' elements in ' + Math.round(t1 - t0) + ' ms; switching to Daycare ' + Math.round(t3 - t2) + ' ms (the old screen drew all 1,540 rows: 3,080 inputs)';`],
  ['Ingredients: master list (merge suggestions)', 'app', `document.querySelector('[data-view=ingredients]').click(); await t.until(() => document.querySelector('.ingredients-table'));
    await t.until(() => document.querySelector('.nm-merges')); document.querySelector('.nm-merges').open = true; await t.sleep(300);`],
  ['Ingredients: merge dialog', 'app', `document.querySelector('[data-sugg="0"]').click(); await t.until(() => document.querySelector('#nmm-apply:not([disabled])'));`],
  ['Ingredients: name map', 'app', `document.getElementById('nmm-cancel').click(); await t.sleep(300); document.querySelector('[data-ing-tab=names]').click();
    await t.until(() => document.querySelector('.nm-card')); document.querySelector('.nm-card input[type=radio]').click(); await t.sleep(200);`],
  ['Ingredients: name map, all butter products + search', 'app', `const c = document.querySelectorAll('.nm-card')[1]; c.querySelector('.nm-showall')?.click();
    const sInput = document.querySelectorAll('.nm-search')[4]; sInput.value = 'corn'; sInput.dispatchEvent(new Event('input')); await t.sleep(700); c.scrollIntoView();`],
  ['Ingredients: name map, decided', 'app', `document.querySelector('[data-nm-view=done]').click(); await t.until(() => document.querySelector('.nm-decided-table'));`],
  ['Master Items: list', 'app', `document.querySelector('[data-view=masterItems]').click(); await t.until(() => document.querySelector('.master-items-table'));`],
  ['Master Items: ingredients popup', 'app', `document.querySelector('[data-ing="100"]').click(); await t.until(() => document.querySelector('.mi2-modal textarea'));`],
  ['Master Items: edit window (2 versions)', 'app', `document.querySelector('.mi2-modal [data-x]').click(); await t.sleep(300);
    document.querySelector('[data-open="1"]').click(); await t.until(() => document.querySelector('.mi2-edit'));`],
  ['Generate / One Section', 'app', `document.querySelector('.mi2-edit [data-x]')?.click(); await t.sleep(200); localStorage.setItem('menuPlannerMode', JSON.stringify({ mode: 'generate', scope: 'one' })); document.querySelector('[data-view=menuPlanner]').click(); await t.sleep(800);`],
  ['Generate / All Sections', 'app', `await t.click('All Sections');`],
  ['Build Menu (before grids)', 'app', `await t.click('Build');`],
  ...SECTION_TABS.map(([label, code], i) => ['Build Menu grid ' + label, 'app', i === 0 ? `
    document.getElementById('bm-label').value = 'Layout tour';
    document.getElementById('bm-start').value = '2026-10-04'; document.getElementById('bm-end').value = '2026-10-08';
    await t.click('Build Grids'); await t.until(() => document.querySelector('[data-builder-section]')); await t.sleep(600);`
    : `document.querySelector('[data-builder-section="${code}"]').click(); await t.sleep(500);`]),
  ['Recipe Generator: drafts, every folder ticked', 'app', `document.querySelector('[data-view=recipeGenerator]').click(); await t.sleep(800);
    (await t.until(() => document.querySelector('[data-rg-tab=drafts]'))).click(); await t.until(() => document.getElementById('rg-folders-all'));
    document.getElementById('rg-folders-all').click(); await t.sleep(200);`],
  ['Recipe Generator: delete confirmation', 'app', `document.getElementById('rg-folders-delete-btn').click(); await t.until(() => document.getElementById('rgd-apply'));
    document.querySelector('.rgd-folders details').open = true; await t.sleep(200);`],
  ['Recipe Generator: draft folder', 'app', `document.getElementById('rgd-cancel').click(); await t.sleep(300); document.querySelector('[data-view=recipeGenerator]').click(); await t.sleep(800);
    (await t.until(() => document.querySelector('[data-rg-tab=drafts]'))).click(); await t.sleep(600);
    (await t.until(() => document.querySelector('[data-rg-open-folder="0"]'))).click(); await t.until(() => document.querySelector('.rg-drafts-table'));`],
  ['Recipe Generator: Recipe Generated', 'app', `document.querySelector('[data-rg-tab=generated]').click(); await t.until(() => document.querySelector('.rg-generated-table'));`],
  ['Recipe Generator: choose dishes (1,500 rows)', 'app', `const r = await window.api.prepareRecipeGeneration({});
    state.generatedRecipes.uploadToken = 'tour';
    state.generatedRecipes.pick = { uploadToken: 'tour', fileName: r.fileName, dishes: r.dishes, estimate: r.estimate, ticked: new Set([0, 1, 2, 9, 40, 97]), query: '', readWarnings: 0 };
    renderView(); await t.until(() => document.querySelector('.rg-pick-table'));
    document.querySelector('[data-sel="grp"][data-val="3"][data-on="1"]').click(); await t.sleep(200);`],
  ['Recipe Generator: choose dishes, searched and scrolled', 'app', `const q = document.getElementById('rg-pick-search'); q.value = 'kebab'; q.dispatchEvent(new Event('input')); await t.sleep(400);
    document.querySelector('[data-sel="all"][data-on="1"]').click(); await t.sleep(200); document.getElementById('main').scrollTo({ top: 1400, behavior: 'instant' }); await t.sleep(300);`],
  ['Recipe Generator: result summary', 'app', `document.getElementById('main').scrollTo({ top: 0, behavior: 'instant' });
    const g = state.generatedRecipes; const p = g.pick; g.pick = null;
    g.lastResult = { fileName: p.fileName, created: 22, ticked: 24, failures: ['"Grilled Salmon" was skipped, not generated: Genuinely a seafood dish; not permitted for this student section'],
      skipped: p.dishes.filter(d => !p.ticked.has(d.key)).map(d => d.name) };
    g.reviewNotice = { fileName: p.fileName, unreviewed: 8, total: 24 };
    renderView(); await t.until(() => document.querySelector('.rg-result'));
    document.querySelectorAll('.rg-result details').forEach(d => { d.open = true; }); await t.sleep(200);`],
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
