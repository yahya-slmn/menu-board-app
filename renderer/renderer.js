const state = {
  sections: [],
  currentSection: null,
  currentView: 'items',
  // Whether Dish Catalog's own section sub-list is expanded -- toggled by clicking "Dish
  // Catalog" while it's already the active view. Only ever shown while currentView === 'items'.
  itemCatalogExpanded: true,
  // Whether the "Menu" nav group (Generate/Build/Export All) is expanded -- same toggle
  // pattern as itemCatalogExpanded, just gated on any of MENU_GROUP_VIEWS instead of 'items'.
  menuGroupExpanded: true,
  // Menu Planner (2026-09-25): Generate Menu / Build Menu / Export All Sections behind one nav entry.
  // mode 'generate' | 'build'; scope (Generate only) 'one' = Generate Menu, 'all' = Export All Sections.
  // busy: a generation run is in flight -- the switches stay disabled until it finishes.
  // fields: the Generate form's name / created by / dates, shared by both scopes for the session.
  menuPlanner: { mode: 'generate', scope: 'one', busy: false, restored: false, fields: { label: '', createdBy: '', start: '', end: '' },
    // Created By mix: session only, never saved (see renderMixPanel). values: { label: percent }.
    mix: { values: {}, open: false, check: null, checkKey: '', scope: null } },
  categories: [],
  proteinTypes: [],
  currentGeneratedMenuId: null,
  builder: { label: '', createdBy: '', startDate: '', endDate: '', numWeekdays: 20, activeSection: null, days: [], sections: {} },
  // Menu Ingredients Generator -- purely in-memory, nothing here is ever saved to Supabase.
  // `files` is one entry per file selected in the last upload action (whether that was one file
  // or several at once -- mi-file-input carries `multiple`): { fileIndex, fileName, rows, failures,
  // error }, where `rows` is the flat { sheetName, rowNumber, date, weekday, category, dishName,
  // ingredients, allergens } list parse-and-suggest-menu-ingredients returned for THAT file (empty
  // + `error` set if that one file failed to parse -- the rest of the batch still succeeds
  // independently, see main.js's processOneMenuIngredientsFile). Kept here (not a local variable in
  // renderMenuIngredientsView) so navigating away and back doesn't lose an in-progress review.
  // `uploadToken` identifies which upload batch these files belong to -- generated fresh per
  // upload attempt and echoed back by main.js once its parse actually wins the race to be
  // "current"; a later export sends it back so main.js can refuse to export against a superseded
  // upload's in-memory workbooks (see main.js's own comment on menuIngredientsToken).
  menuIngredients: { files: [], uploadToken: null },
  // Dish Catalog -> "Import dishes from menus" (renderCatalogImportView): shown in place of the catalog
  // while open. files: [{ name, base64 }] kept so a section pick can re-read them; sel: key -> the
  // chef's tick / name / category / protein per row; overrides: 'file::sheet' -> section code.
  catalogImport: { open: false, files: [], plan: null, sel: {}, overrides: {}, createdBy: 'Tetiana', result: null, busy: false },
  // Recipe Book and Recipe Extractor now share this exact shape (both are process-shaped since
  // the Recipe Book multi-process migration -- see conversation notes) -- processes instead of a
  // flat ingredientRows/prep pair, since a recipe can describe several named sub-recipes (e.g.
  // "Vanilla Base", "Caramelized Sugar Top"), each with its own ingredients + method. The one
  // remaining structural difference is the photo model (RECIPE_NS.*.photoModel): Recipe Book
  // stays single-photo (pendingPhoto/removePhoto), Recipe Extractor keeps its up-to-10 gallery
  // (existingPhotos/pendingPhotos) -- see resetRecipeFormState, which initializes whichever pair
  // applies.
  recipes: {
    view: 'list', formId: null, processes: [], pendingPhoto: null, removePhoto: false,
    presentationMode: null, presentationText: '', presentationItems: [],
    importedRecipe: null,
  },
  extractor: {
    // Photo gallery (up to 10) is structurally different from Recipe Book's single pendingPhoto/
    // removePhoto pair -- existingPhotos is a live, prunable array of already-saved photos
    // ({ id, photo_path, sort_order } plus a resolved dataUrl for the thumbnail), pendingPhotos
    // is freshly added ones not yet uploaded ({ localId, dataUrl, base64, ext }). Removing either
    // just splices the array, same convention as processes.
    view: 'list', formId: null, existingPhotos: [], pendingPhotos: [],
    processes: [],
    presentationMode: null, presentationText: '', presentationItems: [],
    // Set by "Upload Recipe" just before opening a fresh New Recipe form; consumed (and
    // cleared) the moment renderRecipeFormView reads it -- see its non-editing branch.
    importedRecipe: null,
  },
  // Recipe Generator -- shares the same view/formId/processes drill-down shape as recipes/
  // extractor above (reused via RECIPE_NS.generated + openNewRecipeForm/openEditRecipeForm/
  // resetRecipeFormState, all unmodified), even though its own form (renderGeneratedRecipeFormView)
  // is a bespoke, simpler renderer -- pendingPhoto/removePhoto/presentationMode/Text/Items are
  // reset by that shared machinery but never read by the bespoke form (no photo/presentation UI
  // there at all), which is harmless unused state, not a bug. `activeTab` is Recipe Generator-only
  // (Drafts vs the confirmed "Recipe Generated" list) -- independent of view/formId, since both
  // tabs drill into the same form when a row is opened. `fileName`/`uploadToken` track the most
  // recent "Upload Menu File" attempt on the Drafts tab, same race-guard convention as
  // state.menuIngredients.uploadToken.
  generatedRecipes: {
    view: 'list', formId: null, processes: [], pendingPhoto: null, removePhoto: false,
    presentationMode: null, presentationText: '', presentationItems: [],
    importedRecipe: null,
    activeTab: 'drafts', fileName: '', uploadToken: null,
    // Drafts are grouped into per-menu "folders" by source_menu_label (see
    // renderGeneratedDraftsList) -- null shows the folder list, a label string shows just that
    // menu's own drafts. Persists across tab switches the same way activeTab does, so leaving and
    // returning to Drafts keeps her place; reset to null on a fresh upload so a new generation
    // run always lands on the folder list rather than some other menu's folder she had open.
    draftFolder: null,
    // The category chosen in a folder's own drafts table ('' = all). Kept while she reviews or deletes drafts (the screen
    // re-renders after each), cleared when she goes back to the folder list.
    draftCategory: '',
    // Where the page was scrolled when a draft was opened for Review (or deleted), so coming back to the list -- after Save Draft,
    // Confirm & Save, Back or Delete -- puts her at the same spot instead of the top. Consumed once by renderRecipeGeneratorTabs.
    returnScroll: null,
  },
  // Materials/Trays catalog -- same list<->form drill-down shape as recipes/extractor above
  // (view/formId), single-photo model like Recipe Book (pendingPhoto/removePhoto). shapeType and
  // the dimension fields aren't persisted here separately from the form's own inputs -- they're
  // read directly off the form DOM at save time, same convention every other simple text field
  // in the recipe form already uses (see renderMaterialFormView) -- this object only needs to
  // exist at all for view/formId/pendingPhoto/removePhoto, the same three things every other
  // list<->form screen's own state slice needs.
  materials: { view: 'list', formId: null, pendingPhoto: null, removePhoto: false },
  // AI Menu Generator (renderAiMenuView): the run list + generate form, or one run under review.
  // `generating`/`progress` survive leaving the screen, since generation keeps running in main.js.
  aiMenu: {
    view: 'list', runId: null, tab: 'DAYCARE', data: null, generating: false, progress: '',
    form: { label: '', createdBy: '', startDate: '', endDate: '' },
    dishFilter: { q: '', cat: '', servedOnly: true },
  },
};

// Recipe Book and Recipe Extractor are two fully separate tables (see CLAUDE.md-equivalent
// conversation notes: extracted_recipes/extracted_ingredients have no FK relationship to
// recipes/ingredients, and the ingredient catalogs -- product_code prefixes FB-/TTY- vs
// EX-IN-/EX- -- stay deliberately separate too) sharing ONE set of screens/forms/export code,
// parameterized entirely through this RECIPE_NS config -- same pattern renderRecipeListView
// already proved for the list screen, now extended to the form (renderRecipeFormView),
// preview, and Recipe Calculator. What's left genuinely different between the two, all
// expressed as plain RECIPE_NS fields rather than forked code: which Supabase tables `api.*`
// reads/writes, whether an ingredient row must already be linked before saving
// (requireIngredientLink), whether photos are a single upload or a gallery (photoModel), and
// the TTY/EX code prefix (codeLabel).
const RECIPE_NS = {
  book: {
    stateKey: 'recipes',
    title: 'Recipe Book',
    subtitle: 'Company recipe cards',
    codeLabel: 'TTY',
    searchLabel: 'Search by name or TTY code',
    backLabel: '← Back to Recipe Book',
    newRecipeHint: 'Click "+ New Recipe" to create the first one.',
    allowManualNew: true,
    requireIngredientLink: true,
    photoModel: 'single',
    openNew: () => openNewRecipeForm(RECIPE_NS.book),
    openEdit: (id) => openEditRecipeForm(RECIPE_NS.book, id),
    api: {
      list: () => window.api.listRecipes(),
      search: (q) => window.api.searchRecipes(q),
      get: (id) => window.api.getRecipe(id),
      save: (payload) => window.api.saveRecipe(payload),
      del: (id) => window.api.deleteRecipe(id),
      getPhoto: (path) => window.api.getRecipePhoto(path),
      preview: (id) => window.api.previewRecipe(id),
      exportSelected: (recipeIds, targetLanguage) => window.api.exportRecipes({ recipeIds, targetLanguage }),
      exportScaled: (payload) => window.api.exportScaledRecipe(payload),
      searchIngredients: (q) => window.api.searchIngredients(q),
      addIngredient: (payload) => window.api.addIngredient(payload),
    },
  },
  extractor: {
    stateKey: 'extractor',
    title: 'Recipe Extractor',
    subtitle: 'Extracted recipe cards',
    codeLabel: 'EX',
    searchLabel: 'Search by name or EX code',
    backLabel: '← Back to Recipe Extractor',
    newRecipeHint: 'Click "Upload Recipe" to create the first one.',
    // Extraction-only: no blank/manual "+ New Recipe" entry point here -- Recipe Book already
    // covers hand-typed recipes, and mixing the two would blur why an EX- recipe exists.
    allowManualNew: false,
    photoModel: 'gallery',
    extract: (payload) => window.api.extractRecipeForExtractor(payload),
    openNew: () => openNewRecipeForm(RECIPE_NS.extractor),
    openEdit: (id) => openEditRecipeForm(RECIPE_NS.extractor, id),
    api: {
      list: () => window.api.listExtractedRecipes(),
      search: (q) => window.api.searchExtractedRecipes(q),
      get: (id) => window.api.getExtractedRecipe(id),
      save: (payload) => window.api.saveExtractedRecipe(payload),
      del: (id) => window.api.deleteExtractedRecipe(id),
      getPhotos: (paths) => window.api.getExtractedRecipePhotos(paths),
      preview: (id) => window.api.previewExtractedRecipe(id),
      exportSelected: (recipeIds, targetLanguage) => window.api.exportExtractedRecipes({ recipeIds, targetLanguage }),
      exportScaled: (payload) => window.api.exportScaledExtractedRecipe(payload),
      searchIngredients: (q) => window.api.searchExtractedIngredients(q),
      addIngredient: (payload) => window.api.addExtractedIngredient(payload),
    },
  },
  // Recipe Generator's third namespace -- AI-generated ~150g reference recipes, always free-text
  // ingredients (no searchIngredients/addIngredient at all: its own bespoke form,
  // renderGeneratedRecipeFormView, never wires an ingredient-name autocomplete, unlike Book/
  // Extractor's shared renderRecipeFormView). No allowManualNew/extract entry point either --
  // generated_recipes rows only ever come from parse-and-generate-recipes (Recipe Generator's own
  // "Upload Menu File" flow, see renderRecipeGeneratorView), never a blank form or a single-file
  // extraction. openNew/openEdit are still defined, for structural parity with book/extractor and
  // in case shared code ever calls them, but only openEdit is ever actually reached (from the
  // Drafts/Generated tabs' own row actions) -- see renderRecipeGeneratorView's dispatch, which
  // routes state.generatedRecipes.view==='form' to the bespoke form, not renderRecipeFormView.
  generated: {
    stateKey: 'generatedRecipes',
    title: 'Recipe Generator',
    subtitle: 'AI-generated reference recipes, 150g net weight, from an uploaded menu',
    codeLabel: 'RG',
    searchLabel: 'Search by name or RG code',
    backLabel: '← Back to Recipe Generator',
    newRecipeHint: '',
    allowManualNew: false,
    photoModel: 'single',
    openNew: () => openNewRecipeForm(RECIPE_NS.generated),
    openEdit: (id) => openEditRecipeForm(RECIPE_NS.generated, id),
    api: {
      // list/search are CONFIRMED-only, always (see main.js's own comment on list-generated-
      // recipes) -- drafts are reached only via the Drafts tab's own listGeneratedRecipeDrafts
      // call, never through this namespace's list/search.
      list: () => window.api.listGeneratedRecipes(),
      search: (q) => window.api.searchGeneratedRecipes(q),
      get: (id) => window.api.getGeneratedRecipe(id),
      save: (payload) => window.api.saveGeneratedRecipe(payload),
      del: (id) => window.api.deleteGeneratedRecipe(id),
      // Single-photo model, like Book -- a generated recipe is a speculative, AI-written
      // reference, not something extracted from a real photographed card, so an optional single
      // illustrative photo fits (Extractor's multi-page-scan gallery model doesn't apply -- no
      // physical source document exists here).
      getPhoto: (path) => window.api.getGeneratedRecipePhoto(path),
      preview: (id) => window.api.previewGeneratedRecipe(id),
      exportSelected: (recipeIds, targetLanguage) => window.api.exportGeneratedRecipes({ recipeIds, targetLanguage }),
      exportScaled: (payload) => window.api.exportScaledGeneratedRecipe(payload),
    },
  },
};

// Icons for the Recipe Book/Extractor list rows' "preview export" button -- inline SVGs
// (Feather icons' eye/eye-off glyphs) rather than emoji, since no icon font/library exists in
// this app and an emoji eye doesn't render a slash reliably across platforms. stroke="currentColor"
// so both inherit .icon-btn's own color/hover-color rules with no extra CSS needed. The button
// shows EYE_OFF (hidden/closed) by default and on row hover; while ITS OWN preview modal is open
// it swaps to plain EYE (this recipe is actively being viewed), then back to EYE_OFF on close --
// see openRecipePreviewModal.
const EYE_OFF_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
const EYE_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

// Recipe Extractor's "Upload Recipe" multi-file caps -- mirrored independently in main.js's
// extract-recipe-for-extractor handler and the extract-recipe Edge Function, since this is
// only the first (fastest, most specific) of three checks, not the only one.
const MAX_EXTRACT_FILES = 10;
const MAX_EXTRACT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACT_TOTAL_BYTES = 20 * 1024 * 1024;

// Curated common-language list for the export-time language pickers (Recipe Book/Extractor
// "Export Selected", and both Calculators' "Export") -- balances reliability (typed exactly as
// the translate-recipe Edge Function expects) against flexibility (an "Other" free-text
// fallback covers anything not listed). English stays first/default -- choosing nothing exports
// exactly as before this existed (the fast path in main.js's translateForRecipeExport skips
// translate-recipe entirely for 'English'). Not the same list
// as extraction ever had -- that per-extraction language picker was tried and reverted;
// translation only ever happens at export time now, not extraction time.
const EXPORT_LANGUAGES = [
  'English', 'Arabic', 'French', 'Spanish', 'Portuguese', 'Italian', 'German', 'Turkish',
  'Ukrainian', 'Russian', 'Polish', 'Tagalog', 'Hindi', 'Urdu', 'Persian (Farsi)', 'Hebrew',
  'Chinese', 'Vietnamese', 'Thai', 'Korean', 'Japanese',
];

// Shared by all 4 export entry points (Recipe Book/Extractor "Export Selected", both
// Calculators' "Export") -- same curated-select-plus-"Other" widget at each, distinguished only
// by a DOM id prefix so the 4 instances never collide when more than one could theoretically be
// present. wireExportLanguagePicker/getSelectedExportLanguage are the JS-side counterpart, kept
// as separate functions (not bundled into the HTML string) since each call site already has its
// own click handler to read the selection from.
function exportLanguagePickerHtml(idPrefix) {
  return `
    <label for="${idPrefix}-export-language" style="font-size:12.5px; color:var(--neutral); white-space:nowrap;">Export in</label>
    <select id="${idPrefix}-export-language" class="builder-select" style="width:auto; max-width:160px;">
      ${EXPORT_LANGUAGES.map(l => `<option value="${l}">${l}</option>`).join('')}
      <option value="__other__">Other…</option>
    </select>
    <input id="${idPrefix}-export-language-other" style="display:none; max-width:140px; padding:5px 6px; border:1px solid var(--line); border-radius:6px; font-family:inherit; font-size:12.5px;" />
  `;
}

function wireExportLanguagePicker(idPrefix) {
  const select = document.getElementById(`${idPrefix}-export-language`);
  const other = document.getElementById(`${idPrefix}-export-language-other`);
  select.addEventListener('change', () => {
    const isOther = select.value === '__other__';
    other.style.display = isOther ? '' : 'none';
    if (isOther) other.focus();
  });
}

// Falls back to English if "Other" is picked but left blank -- matches translate-recipe's own
// fast-path check, so an incomplete pick here never blocks the export.
function getSelectedExportLanguage(idPrefix) {
  const select = document.getElementById(`${idPrefix}-export-language`);
  const other = document.getElementById(`${idPrefix}-export-language-other`);
  if (select.value === '__other__') return other.value.trim() || 'English';
  return select.value;
}

// ============================================================
// SHARED PROGRESS PANEL -- one visual component for every AI-Edge-Function-calling flow (Recipe
// Extractor upload, Export Selected x2, Calculator export x2, Menu Ingredients Generator, and
// the calorie/AM-Snack-Style bulk backfills whenever they get a UI trigger again), so none of
// them hand-roll their own status text/spinner. Two modes, decided per-flow by whether real
// batch-count data actually exists -- never faked:
//   - determinate: the first update() call that supplies a real {current, total} flips into this
//     mode permanently for the panel's lifetime (even if a LATER update omits total, e.g. a
//     translate loop's final "Building Excel file..." step -- the bar freezes at its last real
//     percentage instead of reverting to an indeterminate slide, which would read as a step
//     backwards). ETA is elapsed-time-so-far / units-done-so-far x units-remaining -- literally
//     "average time per unit so far", extrapolated -- shown as "Estimating..." before the first
//     unit completes, since there's no data yet to extrapolate from.
//   - indeterminate: no flow ever supplies a total (a single atomic API call -- recipe
//     extraction, a one-recipe export -- has no sub-steps to count at all) -- sliding CSS
//     animation, elapsed time only, deliberately no ETA line (a perpetual "Estimating..." with no
//     path to resolving would read as broken, not honest).
// A 1s ticker keeps the elapsed/remaining figures counting live between update() calls, not just
// jumping when a new batch-progress event arrives.
// ============================================================
function createProgressPanel(container, { label } = {}) {
  const startTime = Date.now();
  let mode = 'indeterminate';
  let current = 0, total = 0, avgMsPerUnit = null, lastUpdateTime = startTime;

  container.innerHTML = `
    <div class="progress-panel">
      <div class="progress-panel-row">
        <span class="progress-panel-spinner"></span>
        <span class="progress-panel-message">${label || 'Working…'}</span>
        <span class="progress-panel-meta"></span>
      </div>
      <div class="progress-panel-track"><div class="progress-panel-fill indeterminate"></div></div>
    </div>
  `;
  const messageEl = container.querySelector('.progress-panel-message');
  const metaEl = container.querySelector('.progress-panel-meta');
  const fillEl = container.querySelector('.progress-panel-fill');

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function render() {
    const elapsed = Date.now() - startTime;
    if (mode === 'determinate') {
      const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
      let etaText;
      if (current >= total) {
        etaText = 'Done';
      } else if (avgMsPerUnit == null) {
        etaText = 'Estimating…';
      } else {
        const sinceUpdate = Date.now() - lastUpdateTime;
        const remaining = Math.max(0, avgMsPerUnit * (total - current) - sinceUpdate);
        etaText = `~${formatDuration(remaining)} left`;
      }
      metaEl.textContent = `${percent}% · ${current}/${total} · Elapsed ${formatDuration(elapsed)} · ${etaText}`;
    } else {
      metaEl.textContent = `Elapsed ${formatDuration(elapsed)}`;
    }
  }

  const tick = setInterval(render, 1000);
  render();

  // { message, current, total } -- current/total omitted entirely (not just falsy) means this
  // particular step has no count of its own (see the mode-freeze comment above); once the panel
  // is in determinate mode, an update with only `message` just updates the text and leaves the
  // bar/ETA exactly where they were.
  function update({ message, current: c, total: t } = {}) {
    if (message != null) messageEl.textContent = message;
    if (typeof t === 'number' && t > 0 && typeof c === 'number') {
      if (mode !== 'determinate') {
        mode = 'determinate';
        fillEl.classList.remove('indeterminate');
        fillEl.classList.add('determinate');
      }
      current = c;
      total = t;
      lastUpdateTime = Date.now();
      if (current >= 1) avgMsPerUnit = (lastUpdateTime - startTime) / current;
      fillEl.style.width = `${Math.min(100, Math.round((current / total) * 100))}%`;
    }
    render();
  }

  function done(message) {
    if (mode === 'determinate') {
      current = total;
      fillEl.style.width = '100%';
    }
    clearInterval(tick);
    if (message != null) messageEl.textContent = message;
    metaEl.textContent = `Done in ${formatDuration(Date.now() - startTime)}`;
  }

  function destroy() {
    clearInterval(tick);
    container.innerHTML = '';
  }

  return { update, done, destroy };
}

// Protein code -> chip color class. A code with no entry (a protein type added later) gets the
// outlined .protein-other chip: a bare .chip is white text on no background, i.e. invisible.
const PROTEIN_COLOR = { CHICKEN: 'chicken', BEEF: 'beef', LAMB: 'lamb', TURKEY: 'turkey', FISH: 'fish', VEGETARIAN: 'vegetarian', VEGAN: 'vegan' };
function proteinChip(code, label) {
  return code ? `<span class="chip ${PROTEIN_COLOR[code] || 'protein-other'}">${aiEsc(label || code)}</span>` : '';
}
// AM_SNACK_STYLE_OPTIONS (defined below) already carries the display name for each style code --
// this just maps that same code to its own chip color class, same pattern as PROTEIN_COLOR does
// for protein codes. Pastry gets a warm rose (bakery), Cold Kitchen a cool teal ("cold") --
// distinct from every existing chip color (chicken/beef/lamb/daily).
const AM_SNACK_STYLE_COLOR = { PASTRY: 'pastry', COLD_KITCHEN: 'cold-kitchen' };

// Categories where Protein Type is meaningful, confirmed against real item_portions/
// protein_type_id usage (not just categories literally named "Main") -- LUNCH_MAIN and
// STAFF_MAIN are the obvious ones; STAFF_BREAKFAST and STAFF_LUNCHBOX are structurally
// required by lib/generator.js's SECTION_SLOTS composition rules (1 vegetarian among Staff's
// 6 breakfast picks; 1 meat protein + 1 vegetarian for the lunchbox); STAFF_LUNCHBOX_SALAD
// isn't generator-enforced but is 100% consistently tagged in the existing catalog.
// CEO_LUNCH_MAIN added 2026-09-25 (CEO v2: its export row pair reads "Main Dish" / "Protein"); it
// had 0% protein tagging before, so existing CEO mains start blank -- set them in Edit Item.
// AM_SNACK / PM_SNACK added 2026-09-24: the AI Menu Generator already writes a protein onto snack
// dishes, and a locked field wiped it on every save; the chef sets the real one (Turkey, Vegetarian,
// ...). What a snack may NOT be is unchanged (lib/categoryRules.js: chicken / beef by protein type or
// name keeps it off new menus; the form warns).
const PROTEIN_ELIGIBLE_CATEGORIES = new Set([
  'LUNCH_MAIN', 'STAFF_MAIN', 'STAFF_BREAKFAST', 'STAFF_LUNCHBOX', 'STAFF_LUNCHBOX_SALAD',
  'AM_SNACK', 'PM_SNACK', 'CEO_LUNCH_MAIN',
]);

// AM_SNACK only -- backs lib/generator.js's Pastry/Cold-Kitchen weekly rotation
// (AM_SNACK_STYLE_BY_PATTERN), scoped to Daycare/KG-LP/MS-UP the same way AM_SNACK itself only
// ever appears in those three sections' own category lists (SECTION_SLOTS never lists it for
// Staff/CEO), so no separate section check is needed here.
// Categories with a Pastry / Cold Kitchen style (menu_items.am_snack_style) -- PM Snack and Staff Breakfast
// since 2026-09-24; mirrors STYLED_CATEGORIES in main.js.
const STYLE_ELIGIBLE_CATEGORIES = new Set(['AM_SNACK', 'PM_SNACK', 'STAFF_BREAKFAST']);
// Chicken / beef are lunch only, never AM or PM Snack -- mirrors lib/categoryRules.js (the engine,
// Build Menu and the AI review screen enforce it; the Add / Edit Item form only warns).
const SNACK_LUNCH_ONLY_CATEGORIES = new Set(['AM_SNACK', 'PM_SNACK']);
const SNACK_LUNCH_ONLY_PROTEINS = new Set(['CHICKEN', 'BEEF']);
const SNACK_LUNCH_ONLY_WORDS = /\b(chicken|beef)\b/i;
const AM_SNACK_STYLE_OPTIONS = [
  { code: 'PASTRY', name: 'Pastry' },
  { code: 'COLD_KITCHEN', name: 'Cold Kitchen' },
];

async function init() {
  state.sections = await window.api.getSections();
  state.categories = await window.api.getCategories();
  state.proteinTypes = await window.api.getProteinTypes();
  state.currentSection = state.sections[0].code;

  wireSidebarToggle();
  renderSectionNav();
  wireNav();
  wireRefreshButton();
  wireSoundToggleButton();
  renderView();
}

// Small transient notification, used when Refresh can't safely force a re-render (see
// isSafeToForceRerender below) -- lets the chef know the cache updated without implying
// the current screen changed.
function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 250);
  }, 2500);
}

// Whether it's safe to blow away #main's current content and re-render the active view.
// Every view in SAFE_VIEWS re-fetches its own primary data live on every render already (see
// renderItemsView/renderHistoryView/renderRecipeListView/renderIngredientsView/
// renderExtractedIngredientsView, and Menu Planner's Generate modes), so replacing them just shows the same screen with
// fresher data underneath. Menu Planner's Build mode (state.builder.sections[...].selections) and an
// in-progress Recipe/Extractor form (state.recipes/extractor.ingredientRows) hold real unsaved work that a
// re-render would silently discard, and an open Add/Edit modal (Item/Ingredient, appended to
// document.body) was populated from data fetched at modal-open time -- none of these should
// ever be touched by a background refresh.
const SAFE_REFRESH_VIEWS = ['items', 'history', 'recipes', 'extractor', 'recipeGenerator', 'ingredients', 'extractedIngredients', 'menuPlanner'];
function isSafeToForceRerender() {
  if (document.querySelector('.modal-overlay')) return false;
  // Menu Planner: Build mode holds the unsaved grid; a Generate run in flight must finish first.
  if (state.currentView === 'menuPlanner' && (state.menuPlanner.mode === 'build' || state.menuPlanner.busy)) return false;
  if (state.currentView === 'recipes' && state.recipes.view === 'form') return false;
  if (state.currentView === 'extractor' && state.extractor.view === 'form') return false;
  if (state.currentView === 'recipeGenerator' && state.generatedRecipes.view === 'form') return false;
  return SAFE_REFRESH_VIEWS.includes(state.currentView);
}

function wireRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.classList.add('spinning');
    const label = btn.querySelector('.refresh-label');
    const originalText = label.textContent;
    label.textContent = 'Refreshing…';
    try {
      const fresh = await window.api.refreshReferenceData();
      state.sections = fresh.sections;
      state.categories = fresh.categories;
      state.proteinTypes = fresh.proteinTypes;

      if (isSafeToForceRerender()) {
        renderSectionNav();
        renderView();
        showToast('Refreshed.');
      } else {
        renderSectionNav();
        showToast('Reference data updated.');
      }
    } catch (err) {
      showToast(`Refresh failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
      label.textContent = originalText;
    }
  });
}

// ---- Procedurally-synthesized sound effects (Web Audio API) -----------------------------------
// This app's first audio of any kind -- deliberately no sample files at all (not even CC0/
// royalty-free ones): every effect below is generated in-code from oscillators and filtered
// noise, so there's no third-party licensing to source, vet, or bundle, consistent with this
// app's no-bundler/minimal-deps approach. Kept as one small app-level module (not scoped to
// Recipe on Fire specifically) since a future feature could reuse the same AudioContext/mute
// state. Mute is a personal device preference (localStorage), not synced via Supabase -- unlike
// everything else in this app, there's no reason sound-on/off should follow a chef between
// devices or be visible to other chefs.
const SOUND_MUTE_STORAGE_KEY = 'menuBoardSoundMuted';
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function isSoundMuted() {
  try { return localStorage.getItem(SOUND_MUTE_STORAGE_KEY) === '1'; } catch { return false; }
}
function setSoundMuted(muted) {
  try { localStorage.setItem(SOUND_MUTE_STORAGE_KEY, muted ? '1' : '0'); } catch { /* private window etc -- just doesn't persist */ }
}

function wireSoundToggleButton() {
  const btn = document.getElementById('sound-toggle-btn');
  const icon = document.getElementById('sound-toggle-icon');
  const refresh = () => { icon.textContent = isSoundMuted() ? '🔇' : '🔊'; };
  refresh();
  btn.addEventListener('click', () => {
    setSoundMuted(!isSoundMuted());
    refresh();
  });
}

// Shared filtered-noise basis for the whoosh/sizzle/slice effects below -- plain white noise
// through a BiquadFilter reads convincingly as fire/cutting texture without needing any sample.
function makeNoiseBuffer(ctx, durationSec) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.round(ctx.sampleRate * durationSec)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Ignite/whoosh burst -- filtered noise sweeping high->low plus a quick pitch-down oscillator,
// played once on Recipe on Fire's "Bake ->" click (see startBaking).
function playIgniteSound() {
  if (isSoundMuted()) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 0.6);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(1800, now);
  noiseFilter.frequency.exponentialRampToValueAtTime(300, now + 0.5);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.linearRampToValueAtTime(0.5, now + 0.05);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
  noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.6);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.4);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.3, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  osc.connect(oscGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.42);
}

// Short slice/cut transient -- a sharp high-pass noise burst, played once per cutter placement
// click on Recipe on Fire's Cut step (see onTrayPointerDown).
// Shape & Place sounds -- same synthesized approach as the effects above (no sample files).
function tone(freqFrom, freqTo, dur, gain, type = 'sine') {
  const ctx = getAudioCtx(), now = ctx.currentTime;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 20), now + dur);
  g.gain.setValueAtTime(gain, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(now); osc.stop(now + dur + 0.02);
}
function softNoise(dur, gain, cutoff) {
  const ctx = getAudioCtx(), now = ctx.currentTime;
  const src = ctx.createBufferSource(); src.buffer = makeNoiseBuffer(ctx, dur);
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(now);
}
// Oven ambience while baking: a low hum plus random little crackles. Returns { stop() }.
function startBakeAmbience() {
  if (isSoundMuted()) return { stop() {} };
  const ctx = getAudioCtx(), now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.5, now + 0.6);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
  const oscs = [55, 82.5].map((f, i) => {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f + i * 0.4;
    const g = ctx.createGain(); g.gain.value = 0.022;
    o.connect(g).connect(lp); o.start(now);
    return o;
  });
  lp.connect(master).connect(ctx.destination);
  let alive = true;
  (function crackle() {
    if (!alive) return;
    if (!isSoundMuted()) softNoise(0.02 + Math.random() * 0.04, 0.03 + Math.random() * 0.05, 2500 + Math.random() * 3000);
    setTimeout(crackle, 90 + Math.random() * 320);
  })();
  return {
    stop() {
      if (!alive) return;
      alive = false;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      oscs.forEach(o => o.stop(t + 0.5));
    },
  };
}
// The "done" bell.
function playDingSound() {
  if (isSoundMuted()) return;
  tone(1320, 1300, 0.9, 0.09); tone(1980, 1960, 0.6, 0.04); tone(2640, 2620, 0.35, 0.02);
}
function playPickupSound() { if (isSoundMuted()) return; tone(360, 560, 0.07, 0.05); }
function playPlaceSound() { if (isSoundMuted()) return; tone(150, 70, 0.11, 0.16); softNoise(0.07, 0.07, 900); }
function playRefuseSound() { if (isSoundMuted()) return; tone(230, 150, 0.14, 0.05, 'triangle'); }
function playArrangeSound() { if (isSoundMuted()) return; [0, 70, 140, 210].forEach((ms, i) => setTimeout(() => { tone(170 - i * 8, 80, 0.09, 0.09); softNoise(0.05, 0.04, 800); }, ms)); }

function playSliceSound() {
  if (isSoundMuted()) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 0.2);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 3500;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + 0.2);
}

function renderSectionNav() {
  const el = document.getElementById('section-nav');
  el.innerHTML = state.sections.map(s => `
    <button class="nav-btn ${s.code === state.currentSection ? 'active' : ''}" data-section="${s.code}">${s.name}</button>
  `).join('');
  el.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentSection = btn.dataset.section;
      if (state.currentView !== 'items') {
        resetDrilldownScreens();
        state.currentView = 'items';
        state.itemCatalogExpanded = true;
      }
      renderSectionNav();
      renderView();
    });
  });
}

// The screens grouped under the "Menu" nav parent (see index.html's #menu-sublist). Generate Menu,
// Build Menu and Export All Sections are modes of Menu Planner, not views of their own.
const MENU_GROUP_VIEWS = ['menuPlanner', 'aiMenu', 'menuIngredients', 'cleanMenu'];

function wireNav() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      // Collapsed rail: Dish Catalog's sections live in a flyout beside the rail rather than an
      // inline sub-list -- clicking the icon just opens/closes that flyout (see wireSidebarToggle).
      if (btn.dataset.view === 'items' && isSidebarCollapsed()) {
        toggleRailFlyout(btn, document.getElementById('section-nav'));
        return;
      }
      // Clicking Dish Catalog while it's already open toggles its own section sub-list
      // open/closed, like a normal collapsible nav section; clicking it from anywhere else
      // always opens it expanded. Picking a different nav item just switches views -- the
      // sub-list belongs only to Dish Catalog and is hidden for every other view regardless
      // of this flag (see updateItemCatalogExpansion).
      if (btn.dataset.view === 'items' && state.currentView === 'items') {
        state.itemCatalogExpanded = !state.itemCatalogExpanded;
      } else if (btn.dataset.view === 'items') {
        state.itemCatalogExpanded = true;
      }
      if (btn.dataset.view !== state.currentView) resetDrilldownScreens();
      state.currentView = btn.dataset.view;
      renderView();
    });
  });

  // "Menu" parent button has no data-view/screen of its own -- it just expands/collapses its
  // sub-list, landing on the first child (Menu Planner, in its last-used mode) the first time you
  // enter the group, same interaction as Dish Catalog above.
  document.getElementById('menu-parent-btn').addEventListener('click', () => {
    if (isSidebarCollapsed()) {
      toggleRailFlyout(document.getElementById('menu-parent-btn'), document.getElementById('menu-sublist'));
      return;
    }
    if (MENU_GROUP_VIEWS.includes(state.currentView)) {
      state.menuGroupExpanded = !state.menuGroupExpanded;
    } else {
      resetDrilldownScreens();
      state.menuGroupExpanded = true;
      state.currentView = 'menuPlanner';
    }
    renderView();
  });
}

// ---- Collapsible sidebar. Collapsed state is a personal, per-device preference (like the sound
// mute above), so it lives in localStorage, not Supabase -- and survives view changes/restarts.
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'menuBoard.sidebarCollapsed';

function isSidebarCollapsed() {
  return document.getElementById('app').classList.contains('sidebar-collapsed');
}

function closeRailFlyout() {
  document.querySelectorAll('.section-sublist.flyout-open').forEach(el => el.classList.remove('flyout-open'));
}

// The rail has no room for text sub-lists, so a group's children (Dish Catalog's sections, the
// Menu screens) open as a fixed-position panel next to the group's icon. Fixed (not absolute)
// because .sidebar scrolls (overflow-y:auto), which would clip an absolutely-positioned flyout.
function toggleRailFlyout(parentBtn, sublistEl) {
  const wasOpen = sublistEl.classList.contains('flyout-open');
  closeRailFlyout();
  if (wasOpen) return;
  const rect = parentBtn.getBoundingClientRect();
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - sublistEl.scrollHeight - 24));
  sublistEl.style.setProperty('--flyout-top', `${top}px`);
  sublistEl.classList.add('flyout-open');
}

function applySidebarState(collapsed) {
  const app = document.getElementById('app');
  app.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = document.getElementById('sidebar-toggle');
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  // Icon-only buttons need a name on hover; the visible label is hidden in the rail.
  document.querySelectorAll('.sidebar > .nav-btn').forEach(btn => {
    const name = btn.querySelector('.nav-label')?.textContent.trim();
    if (collapsed && name) btn.setAttribute('title', name);
    else btn.removeAttribute('title');
  });
  closeRailFlyout();
}

function wireSidebarToggle() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'; } catch { /* no storage -- start expanded */ }
  applySidebarState(collapsed);

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const next = !isSidebarCollapsed();
    applySidebarState(next);
    try { localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? '1' : '0'); } catch { /* just doesn't persist */ }
    // Recipe on Fire's 3D view sizes its canvas from window 'resize' -- fire one once the width
    // transition settles so it picks up the new main-area width.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
  });

  // Capture phase, so this runs before a sub-list button's own handler re-renders (and detaches)
  // it. Any click inside the sidebar closes an open flyout -- picking a flyout item, or going to
  // another rail icon -- except on the two group icons themselves, whose own handlers toggle it.
  document.querySelector('.sidebar').addEventListener('click', (e) => {
    if (!e.target.closest('#menu-parent-btn, .nav-btn[data-view="items"]')) closeRailFlyout();
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar')) closeRailFlyout();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRailFlyout(); });
}

function updateActiveViewButtons() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.currentView);
    if (btn.dataset.view === state.currentView) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.getElementById('menu-parent-btn').classList.toggle('active', MENU_GROUP_VIEWS.includes(state.currentView));
}

function updateItemCatalogExpansion() {
  const expanded = state.currentView === 'items' && state.itemCatalogExpanded;
  document.getElementById('section-nav').style.display = expanded ? 'block' : 'none';
  document.querySelector('[data-view="items"]').setAttribute('aria-expanded', String(expanded));
  const caret = document.getElementById('items-caret');
  if (caret) caret.textContent = expanded ? '▾' : '▸';

  const menuExpanded = MENU_GROUP_VIEWS.includes(state.currentView) && state.menuGroupExpanded;
  document.getElementById('menu-sublist').style.display = menuExpanded ? 'block' : 'none';
  document.getElementById('menu-parent-btn').setAttribute('aria-expanded', String(menuExpanded));
  const menuCaret = document.getElementById('menu-caret');
  if (menuCaret) menuCaret.textContent = menuExpanded ? '▾' : '▸';
}

async function renderView() {
  // The Recipe on Fire game owns a WebGL context; tear down any from the screen being replaced.
  if (window.RofGame) window.RofGame.disposeAll();
  updateActiveViewButtons();
  updateItemCatalogExpansion();
  const main = document.getElementById('main');
  main.dataset.view = state.currentView;
  if (state.currentView === 'menuPlanner') restoreMenuPlannerMode(state.menuPlanner); // before the layout below
  main.classList.toggle('build-mode', state.currentView === 'menuPlanner' && state.menuPlanner.mode === 'build');
  try {
  if (state.currentView === 'items') return await renderItemsView(main);
  if (state.currentView === 'menuPlanner') return await renderMenuPlannerView(main);
  if (state.currentView === 'aiMenu') return await renderAiMenuView(main);
  if (state.currentView === 'history') return await renderHistoryView(main);
  if (state.currentView === 'menuIngredients') return await renderMenuIngredientsView(main);
  if (state.currentView === 'cleanMenu') return await renderCleanMenuView(main);
  if (state.currentView === 'recipes') return await renderRecipesView(main);
  if (state.currentView === 'extractor') return await renderExtractorView(main);
  if (state.currentView === 'recipeGenerator') return await renderRecipeGeneratorView(main);
  if (state.currentView === 'calculator') return await renderCalculatorView(main);
  if (state.currentView === 'recipeOnFire') return await renderRecipeOnFireView(main);
  if (state.currentView === 'ingredients') return await renderIngredientsView(main);
  if (state.currentView === 'extractedIngredients') return await renderExtractedIngredientsView(main);
  if (state.currentView === 'materials') return await renderMaterialsView(main);
  } catch (error) { showViewError(error); }
}

function showViewError(error) {
  const main = document.getElementById('main');
  main.classList.remove('build-mode');
  main.innerHTML = `<div class="empty-state view-error" role="alert"><div class="display">Couldn’t load this view</div><p></p><button class="secondary" id="retry-view">Try again</button></div>`;
  main.querySelector('p').textContent = error?.message || 'Check your connection and try again.';
  main.querySelector('#retry-view').addEventListener('click', () => state.currentSection ? renderView() : init().catch(showViewError));
}

function currentSectionName() {
  return state.sections.find(s => s.code === state.currentSection)?.name || '';
}

// ============================================================
// ITEM CATALOG VIEW
// ============================================================
async function renderItemsView(main) {
  if (state.catalogImport.open) return renderCatalogImportView(main);
  const [items, proteinTypes] = await Promise.all([
    window.api.getItems(state.currentSection),
    window.api.getProteinTypes(),
  ]);
  fillCreatedByList();

  // Category options: distinct category_name values actually present in this section's items,
  // in the order they already appear (get-items pre-sorts by meal-period/category order) --
  // guarantees the dropdown exactly matches what's grouped in the table below, with no category
  // ever offered that would filter down to zero results.
  const categoryNames = [...new Set(items.map(it => it.category_name))];

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Dish Catalog</h1><span class="section-pill">${currentSectionName()}</span></div>
      <div class="action-toolbar">
        <button class="secondary" id="estimate-styles-btn" title="Tags every AM Snack / PM Snack (Daycare, KG-LP, MS-UP) and Staff Breakfast dish without a style as Pastry or Cold Kitchen. Only fills empty values; correct any of them in Edit Item.">Estimate missing styles</button>
        <button class="secondary" id="estimate-calories-btn" title="Estimates calories for every Daycare / KG-LP / MS-UP dish without a value, and every AI-generated dish in any section. Only fills empty values.">Estimate missing calories</button>
        <button class="secondary" id="catalog-import-btn" title="Reads menu Excel files exported from this app and edited by hand, and lists every dish the catalog doesn't have yet. Nothing is added until you tick and confirm.">Import dishes from menus…</button>
        <button class="primary" id="add-item-btn">+ Add Item</button>
      </div>
    </div>
    <div class="calorie-review-bar">
      <span>One-time calorie review (Daycare, KG-LP and MS-UP, whichever tab is open):</span>
      <button class="secondary small" id="calorie-review-export-btn" title="An Excel file of every active Daycare, KG-LP and MS-UP dish with its current calories, for a researcher to fill in real values.">Export calories for review</button>
      <button class="secondary small" id="calorie-review-import-btn" title="Upload the reviewed file: shows what will change first, then writes only the filled-in Reviewed values.">Import reviewed calories</button>
      <input type="file" id="calorie-review-file" accept=".xlsx" hidden />
    </div>
    <div id="calorie-estimate-status" class="ai-progress" role="status" aria-live="polite"></div>
    <div class="search-bar">
      <label for="item-search">Search by name</label>
      <input id="item-search" type="search" />
      <select id="item-category-filter">
        <option value="">All Categories</option>
        ${categoryNames.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <select id="item-source-filter" aria-label="Created By">${createdByFilterOptions(items)}</select>
      <select id="item-protein-filter" hidden>
        <option value="">All Proteins</option>
        ${proteinTypes.map(p => `<option value="${p.code}">${p.name}</option>`).join('')}
      </select>
    </div>
    <div id="items-content"><div class="loading-state" role="status">Loading…</div></div>
  `;
  document.getElementById('add-item-btn').addEventListener('click', () => openItemModal());
  document.getElementById('catalog-import-btn').addEventListener('click', () => {
    Object.assign(state.catalogImport, { open: true, plan: null, result: null, sel: {}, overrides: {} });
    renderItemsView(main);
  });
  document.getElementById('estimate-styles-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('calorie-estimate-status');
    btn.disabled = true;
    const unsubscribe = window.api.onAmSnackStyleEstimateProgress(({ message }) => { statusEl.textContent = message; });
    try {
      const r = await window.api.estimateMissingAmSnackStyles();
      unsubscribe();
      showToast(r.totalMissing ? `Style set for ${r.estimated} of ${r.totalMissing} dish(es).` : 'Every AM Snack, PM Snack and Staff Breakfast dish already has a style.');
      await renderItemsView(main);
      if ((r.failures || []).length) document.getElementById('calorie-estimate-status').textContent = `Notes: ${r.failures.slice(0, 3).join(' | ')}`;
    } catch (err) {
      unsubscribe();
      statusEl.textContent = `Style estimate failed: ${err.message}`;
      btn.disabled = false;
    }
  });
  document.getElementById('calorie-review-export-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await window.api.exportCalorieReview();
      if (r.success) showToast(`Exported ${r.count} dish(es) to ${r.path}`);
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally { btn.disabled = false; }
  });
  const reviewFile = document.getElementById('calorie-review-file');
  document.getElementById('calorie-review-import-btn').addEventListener('click', () => { reviewFile.value = ''; reviewFile.click(); });
  reviewFile.addEventListener('change', async () => {
    const file = reviewFile.files[0];
    if (!file) return;
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const plan = await window.api.previewCalorieImport({ base64 });
      openCalorieImportPreview(plan, file.name, () => renderItemsView(main));
    } catch (err) {
      alert(`Couldn't read that file: ${err.message}`);
    }
  });
  document.getElementById('estimate-calories-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('calorie-estimate-status');
    btn.disabled = true;
    const unsubscribe = window.api.onCalorieEstimateProgress(({ message }) => { statusEl.textContent = message; });
    try {
      const r = await window.api.estimateMissingCalories();
      const problems = (r.failures || []).length ? ` Notes: ${r.failures.slice(0, 3).join(' | ')}` : '';
      showToast(r.totalMissing ? `Calories estimated for ${r.estimated} of ${r.totalMissing} dish(es)${r.flagged ? ` (${r.flagged} flagged unverified)` : ''}.` : 'Every dish in scope already has calories.');
      unsubscribe();
      await renderItemsView(main);
      if (problems) document.getElementById('calorie-estimate-status').textContent = problems.trim();
    } catch (err) {
      unsubscribe();
      statusEl.textContent = `Calorie estimate failed: ${err.message}`;
      btn.disabled = false;
    }
  });

  const searchInput = document.getElementById('item-search');
  const categoryFilter = document.getElementById('item-category-filter');
  const proteinFilter = document.getElementById('item-protein-filter');
  const sourceFilter = document.getElementById('item-source-filter');
  const content = document.getElementById('items-content');

  if (items.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No items yet</div>Add the first item for ${currentSectionName()}.</div>`;
    return;
  }

  // Protein filter only makes sense once a specific category is selected -- and only when that
  // category actually has protein-typed items (checked against real data, not a hardcoded
  // category name/list, since protein tagging shows up well beyond "Lunch Main Course": Staff
  // Salad, CEO Lunch Main, AM Snack, etc. all have some protein-tagged items in practice).
  categoryFilter.addEventListener('change', () => {
    const cat = categoryFilter.value;
    const hasProteinItems = cat && items.some(it => it.category_name === cat && it.protein_code);
    proteinFilter.hidden = !hasProteinItems;
    proteinFilter.value = '';
    renderFiltered();
  });
  proteinFilter.addEventListener('change', renderFiltered);
  sourceFilter.addEventListener('change', renderFiltered);

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value;
    const protein = proteinFilter.hidden ? '' : proteinFilter.value;
    const source = sourceFilter.value;
    const filtered = items.filter(it =>
      (!query || it.name.toLowerCase().includes(query)) &&
      (!cat || it.category_name === cat) &&
      (!protein || it.protein_code === protein) &&
      createdByFilterMatch(it, source)
    );

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No items match the current filters.</div>`;
      return;
    }

    // One shared table for every category (not a table-per-category), with the category
    // column merged via rowspan -- keeps Style/Protein/Menu use/Code in the same horizontal position for every
    // row regardless of which category it belongs to, instead of each category's table
    // auto-sizing its own column widths independently.
    //
    // Group by category first (Map preserves first-seen order, i.e. the query's
    // meal-period/category sort order) so each category renders exactly once with every
    // one of its items underneath, regardless of whether same-category rows happen to be
    // contiguous in `filtered`.
    const byCategory = new Map();
    for (const it of filtered) {
      if (!byCategory.has(it.category_name)) byCategory.set(it.category_name, []);
      byCategory.get(it.category_name).push(it);
    }

    const bodyRows = [];
    for (const [catName, list] of byCategory) {
      list.forEach((it, idx) => {
        bodyRows.push(`
          <tr>
            ${idx === 0 ? `<td class="cat-cell" rowspan="${list.length}">${catName}</td>` : ''}
            <td>${it.name}</td>
            <td>
              ${it.calories_per_100g != null ? it.calories_per_100g : '—'}
              ${it.calories_unverified ? `<span class="chip unverified" title="AI estimate -- flagged as implausible for this item's category/protein, no real recipe was available to ground it. Worth a manual check, or add a real recipe so re-estimating can use its actual ingredients.">unverified</span>` : ''}
            </td>
            <td>${it.am_snack_style ? `<span class="chip ${AM_SNACK_STYLE_COLOR[it.am_snack_style] || ''}">${AM_SNACK_STYLE_OPTIONS.find(s => s.code === it.am_snack_style)?.name || it.am_snack_style}</span>` : ''}</td>
            <td>${proteinChip(it.protein_code, it.protein_name)}</td>
            <td class="menu-use-cell">
              ${it.is_daily_repeating ? `<span class="chip daily">Daily</span>` : ''}
              ${it.snack_rule_blocked ? `<span class="chip unverified" title="Chicken and beef are served at lunch only, so this snack is never put on a new menu. Rename it (e.g. a turkey version), move it to another category, or deactivate it. Menus already in History are unchanged.">Not served: chicken/<wbr>beef in a snack</span>` : ''}
            </td>
            <td class="created-by-cell" data-created-by="${it.id}">${it.created_by_label ? aiEsc(it.created_by_label) : '<span class="list-empty">—</span>'}</td>
            <td class="code-cell" data-code="${it.id}"${it.rc_code ? ` title="${aiEsc(it.rc_code)}"` : ''}>${it.rc_code ? aiEsc(it.rc_code) : '<span class="code-missing">NEW</span>'}</td>
            <td style="text-align:right">
              <button class="icon-btn" data-edit="${it.id}">Edit</button>
              <button class="icon-btn danger" data-delete="${it.id}">Delete</button>
            </td>
          </tr>
        `);
      });
    }

    content.innerHTML = `
      <div class="table-scroll"><table class="items-table dish-catalog-table">
        <thead><tr><th>Category</th><th>Name</th><th>Calories (100g)</th><th>Style</th><th>Protein</th><th>Menu use</th><th>Created By</th><th>Code</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table></div>
    `;

    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openItemModal(filtered.find(i => i.id == btn.dataset.edit)));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this item? This cannot be undone.')) return;
        try {
          const result = await window.api.deleteItem(btn.dataset.delete);
          if (!result.success) {
            if (result.inUse) {
              alert(`This item is used in ${result.menuCount} generated menu${result.menuCount === 1 ? '' : 's'} and can't be deleted.`);
            } else {
              alert('Delete failed.');
            }
            return;
          }
          renderItemsView(main);
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      });
    });
  }

  searchInput.addEventListener('input', renderFiltered);
  renderFiltered();
}

// The one-time calorie import's preview (main.js preview-calorie-import): what will change, what stays,
// what is skipped and why. Nothing is written until Confirm, and then only this plan (by its token).
// ============================================================
// Dish Catalog -> "Import dishes from menus" (main.js preview-catalog-import / apply-catalog-import,
// lib/catalogImport.js). Reads chef-edited menu exports, lists what the catalog lacks, and adds ONLY the
// ticked rows: new dishes (ticked), "looks like an existing dish" (not ticked -- the 0.80 name match
// also flags some different dishes, so each sits beside its catalog match), and dishes already in the
// catalog but not on a section's menu (not ticked). Shown in place of the Dish Catalog while open.
// ============================================================
const CI_SCHOOL_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP'];

function ciSectionName(code) {
  return state.sections.find(s => s.code === code)?.name || code;
}

// "SUNDAY 28-09-2026" -> "Sun 28-09"; "Sunday" (no date) -> "Sun".
function ciShortDay(day) {
  const [weekday, date] = String(day).split(' ');
  const wd = weekday ? weekday[0].toUpperCase() + weekday.slice(1, 3).toLowerCase() : '';
  return date ? `${wd} ${date.slice(0, 5)}` : wd;
}

// File names without the words every file shares ("September week_01" .. -> "week_01").
function ciFileLabeler(plan) {
  const names = [...new Set([...plan.newDishes, ...plan.similar, ...plan.notInSection].flatMap(e => Object.keys(e.files)))];
  const words = names.map(n => n.split(' '));
  let common = 0;
  while (names.length > 1 && words.every(w => w.length > common + 1 && w[common] === words[0][common])) common++;
  return (name) => name.split(' ').slice(common).join(' ') || name;
}

function ciFilesText(entry, label) {
  return Object.entries(entry.files).map(([f, days]) => `${label(f)}${days.length ? `: ${days.map(ciShortDay).join(', ')}` : ''}`).join(' · ');
}

// Fresh selections for a new plan: new dishes ticked, the other two groups not.
function ciInitSelections(plan) {
  const sel = {};
  for (const e of plan.newDishes) sel[e.key] = { include: true, name: e.name, categoryCode: e.categoryCode, proteinCode: e.proteinCode || '' };
  for (const e of plan.similar) sel[e.key] = { include: false, name: e.name, categoryCode: e.categoryCode, proteinCode: e.proteinCode || '' };
  for (const e of plan.notInSection) sel[e.key] = { include: false };
  return sel;
}

async function ciReadFiles(fileList) {
  return Promise.all([...fileList].map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, base64: reader.result.split(',')[1] });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  })));
}

async function renderCatalogImportView(main) {
  const ci = state.catalogImport;
  fillCreatedByList();
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Import dishes from menus</h1><span class="page-description">Menu Excel files exported from this app and edited by hand: every dish the Dish Catalog doesn't have yet, for you to review before anything is added.</span></div>
      <div class="action-toolbar"><button class="secondary" id="ci-back">← Dish Catalog</button></div>
    </div>
    <div class="ci-panel ci-controls">
      <label class="ci-field">Menu files
        <input type="file" id="ci-files" accept=".xlsx" multiple />
      </label>
      <label class="ci-field">Created By
        <input type="text" id="ci-created-by" list="created-by-list" value="${aiEsc(ci.createdBy)}" autocomplete="off" />
      </label>
      <button class="primary" id="ci-read" ${ci.files.length ? '' : 'disabled'}>Read files</button>
      <span class="ci-chosen">${ci.files.length ? `${ci.files.length} file(s): ${ci.files.map(f => aiEsc(f.name)).join(', ')}` : 'No files chosen'}</span>
    </div>
    <div id="ci-status" class="ai-progress" role="status" aria-live="polite"></div>
    <div id="ci-body"></div>
  `;
  document.getElementById('ci-back').addEventListener('click', () => {
    Object.assign(state.catalogImport, { open: false, plan: null, result: null, files: [], sel: {}, overrides: {} });
    renderItemsView(main);
  });
  document.getElementById('ci-created-by').addEventListener('input', (e) => { ci.createdBy = e.target.value; ciUpdateFooter(); });
  document.getElementById('ci-files').addEventListener('change', async (e) => {
    try {
      ci.files = await ciReadFiles(e.target.files);
      Object.assign(ci, { plan: null, result: null, sel: {}, overrides: {} });
      renderCatalogImportView(main);
    } catch (err) { alert(`Couldn't read those files: ${err.message}`); }
  });
  document.getElementById('ci-read').addEventListener('click', () => ciPreview(main));
  if (ci.result) ciRenderResult(main);
  else if (ci.plan) ciRenderPlan(main);
}

async function ciPreview(main) {
  const ci = state.catalogImport;
  const status = document.getElementById('ci-status');
  const btn = document.getElementById('ci-read');
  btn.disabled = true;
  status.textContent = 'Reading the files and the Dish Catalog…';
  try {
    ci.plan = await window.api.previewCatalogImport({ files: ci.files, sectionOverrides: ci.overrides });
    ci.sel = ciInitSelections(ci.plan);
    status.textContent = '';
    ciRenderPlan(main);
  } catch (err) {
    status.textContent = `Couldn't read the files: ${err.message}`;
  } finally { btn.disabled = false; }
}

function ciEntryRow(e, kind, label) {
  const sel = state.catalogImport.sel[e.key];
  const categorySelect = `<select class="ci-cat" aria-label="Category for ${aiEsc(e.name)}">${e.categoryOptions.map(c => `<option value="${c.code}" ${c.code === sel.categoryCode ? 'selected' : ''}>${aiEsc(c.name)}</option>`).join('')}</select>`;
  const proteinSelect = `<select class="ci-protein" aria-label="Protein for ${aiEsc(e.name)}" ${PROTEIN_ELIGIBLE_CATEGORIES.has(sel.categoryCode) ? '' : 'hidden'}>
      <option value="">— protein —</option>${state.proteinTypes.map(p => `<option value="${p.code}" ${p.code === sel.proteinCode ? 'selected' : ''}>${aiEsc(p.name)}</option>`).join('')}</select>`;
  const notes = [
    e.variants?.length ? `<span class="ci-note">Also spelled: ${e.variants.map(aiEsc).join(' / ')}</span>` : '',
    e.alsoListedAs?.length ? `<span class="ci-note ci-note-warn">Also listed as ${e.alsoListedAs.map(aiEsc).join(', ')}: the menus used it in both rows. Untick one unless both are wanted.</span>` : '',
    kind === 'similar' ? `<span class="ci-note">≈ <strong>${aiEsc(e.matchedName)}</strong> in the catalog (${e.matchedCategories.map(aiEsc).join(', ')})</span>` : '',
    e.snackWarning ? `<span class="chip unverified" title="Chicken and beef are served at lunch only: this snack would never be put on a new menu.">Not served: chicken/<wbr>beef in a snack</span>` : '',
  ].join('');
  return `
    <tr data-key="${aiEsc(e.key)}" class="${sel.include ? '' : 'ci-off'}">
      <td><input type="checkbox" class="ci-include" ${sel.include ? 'checked' : ''} aria-label="Add ${aiEsc(e.name)}" /></td>
      <td><input type="text" class="ci-name" value="${aiEsc(sel.name)}" aria-label="Name" />${notes}</td>
      <td>${categorySelect}${proteinSelect}</td>
      <td>${e.sections.map(s => `<span class="chip daily">${aiEsc(ciSectionName(s))}</span>`).join(' ')}</td>
      <td class="ci-files">${aiEsc(ciFilesText(e, label))}</td>
    </tr>`;
}

function ciNotInSectionRow(e, label) {
  const sel = state.catalogImport.sel[e.key];
  const action = e.kind === 'addSection'
    ? `Add <strong>${aiEsc(ciSectionName(e.section))}</strong> to this ${aiEsc(e.categoryName)} dish (now in ${e.inSections.map(s => aiEsc(ciSectionName(s))).join(', ') || 'no section'})${e.isActive ? '' : ' — it is inactive'}`
    : `Add as a <strong>${aiEsc(e.categoryName)}</strong> dish for ${aiEsc(ciSectionName(e.section))} (the catalog has it as ${e.existingCategories.map(aiEsc).join(', ')})`;
  return `
    <tr data-key="${aiEsc(e.key)}" class="${sel.include ? '' : 'ci-off'}">
      <td><input type="checkbox" class="ci-include" ${sel.include ? 'checked' : ''} aria-label="${aiEsc(e.name)}" /></td>
      <td>${aiEsc(e.name)}</td>
      <td colspan="2">${action}</td>
      <td class="ci-files">${aiEsc(ciFilesText(e, label))}</td>
    </tr>`;
}

// Rows grouped by first section, then category (the plan is already sorted that way).
function ciGroupedRows(list, rowFn) {
  let html = '', section = null, category = null;
  for (const e of list) {
    const sec = e.sections?.[0] ?? e.section;
    if (sec !== section) { html += `<tr class="ci-section-row"><th colspan="5">${aiEsc(ciSectionName(sec))}</th></tr>`; section = sec; category = null; }
    if (e.categoryCode !== category) { html += `<tr class="ci-category-row"><th colspan="5">${aiEsc(e.categoryName)}</th></tr>`; category = e.categoryCode; }
    html += rowFn(e);
  }
  return html;
}

function ciTable(id, list, rowFn, heads) {
  return `<div class="cr-scroll"><table class="cr-table ci-table" id="${id}">
    <thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${ciGroupedRows(list, rowFn)}</tbody></table></div>`;
}

function ciRenderPlan(main) {
  const ci = state.catalogImport;
  const plan = ci.plan;
  const label = ciFileLabeler(plan);
  const body = document.getElementById('ci-body');
  const heads = ['Add', 'Dish', 'Category', 'Sections', 'Seen in'];
  const skippedReasons = {};
  for (const s of plan.skipped) skippedReasons[s.reason] = (skippedReasons[s.reason] || 0) + 1;
  body.innerHTML = `
    <p class="ci-summary">${ci.files.length} file(s) · ${plan.rowsRead} dish rows ·
      <button class="ci-jump" data-jump="ci-h-new"><strong>${plan.newDishes.length} new</strong></button> ·
      <button class="ci-jump" data-jump="ci-h-similar">${plan.similar.length} look like an existing dish</button> ·
      <button class="ci-jump" data-jump="ci-h-notin">${plan.notInSection.length} in the catalog but not on a section's menu</button> ·
      ${plan.alreadyInCount} already in the catalog (${plan.catalogSize} catalog dishes checked)</p>
    ${plan.unresolvedSheets.length ? `<div class="ci-panel ci-unresolved"><strong>Which section is each of these tabs?</strong> Their names don't say, so their dishes are left out until you choose.
      ${plan.unresolvedSheets.map(u => { const key = `${u.fileName}::${u.sheetName}`; return `<label class="ci-field">${aiEsc(label(u.fileName))} — tab “${aiEsc(u.sheetName)}”
        <select class="ci-override" data-key="${aiEsc(key)}"><option value="">Choose…</option>${CI_SCHOOL_SECTIONS.map(c => `<option value="${c}" ${ci.overrides[key] === c ? 'selected' : ''}>${aiEsc(ciSectionName(c))}</option>`).join('')}</select></label>`; }).join('')}</div>` : ''}
    ${plan.warnings.length || plan.skipped.length ? `<details class="ci-details"><summary>Notes from reading the files (${plan.warnings.length + Object.keys(skippedReasons).length})</summary><ul>
      ${Object.entries(skippedReasons).map(([r, n]) => `<li>Skipped ${n} row(s): ${aiEsc(r)}</li>`).join('')}
      ${plan.warnings.map(w => `<li>${aiEsc(w)}</li>`).join('')}</ul></details>` : ''}

    <h2 class="ci-h2" id="ci-h-new">New dishes (${plan.newDishes.length})
      <span class="ci-bulk"><button class="secondary small" data-bulk="ci-new" data-on="1">Select all</button><button class="secondary small" data-bulk="ci-new" data-on="0">Select none</button></span></h2>
    ${plan.newDishes.length ? ciTable('ci-new', plan.newDishes, e => ciEntryRow(e, 'new', label), heads) : '<p class="ci-empty">None: every dish in these files is already in the catalog or listed below.</p>'}

    <h2 class="ci-h2" id="ci-h-similar">Look like an existing dish (${plan.similar.length}) <button class="ci-jump ci-top" data-jump="ci-body">Back to top</button></h2>
    <p class="ci-hint">Named almost like a dish already in the catalog. Often the same dish typed differently (then leave it unticked), but sometimes a different dish with a similar name: tick those to add them.</p>
    ${plan.similar.length ? ciTable('ci-similar', plan.similar, e => ciEntryRow(e, 'similar', label), heads) : '<p class="ci-empty">None.</p>'}

    <h2 class="ci-h2" id="ci-h-notin">In the catalog, not on this section's menu (${plan.notInSection.length}) <button class="ci-jump ci-top" data-jump="ci-body">Back to top</button></h2>
    <p class="ci-hint">The dish exists, but a menu used it in a section it isn't listed for. Tick to make it available there.</p>
    ${plan.notInSection.length ? ciTable('ci-notin', plan.notInSection, e => ciNotInSectionRow(e, label), ['Add', 'Dish', 'What happens', '', 'Seen in']) : '<p class="ci-empty">None.</p>'}

    <div class="ci-footer"><span id="ci-count"></span><button class="primary" id="ci-apply"></button></div>
  `;

  body.querySelectorAll('.ci-jump').forEach(btn => btn.addEventListener('click', () => document.getElementById(btn.dataset.jump).scrollIntoView({ block: 'start', behavior: 'smooth' })));
  body.querySelectorAll('.ci-override').forEach(selEl => selEl.addEventListener('change', () => {
    if (selEl.value) ci.overrides[selEl.dataset.key] = selEl.value; else delete ci.overrides[selEl.dataset.key];
    ciPreview(main);
  }));
  body.querySelectorAll('[data-bulk]').forEach(btn => btn.addEventListener('click', () => {
    const on = btn.dataset.on === '1';
    document.querySelectorAll(`#${btn.dataset.bulk} tr[data-key]`).forEach(tr => {
      ci.sel[tr.dataset.key].include = on;
      tr.querySelector('.ci-include').checked = on;
      tr.classList.toggle('ci-off', !on);
    });
    ciUpdateFooter();
  }));
  body.querySelectorAll('tr[data-key]').forEach(tr => {
    const sel = ci.sel[tr.dataset.key];
    tr.querySelector('.ci-include').addEventListener('change', (e) => { sel.include = e.target.checked; tr.classList.toggle('ci-off', !sel.include); ciUpdateFooter(); });
    tr.querySelector('.ci-name')?.addEventListener('input', (e) => { sel.name = e.target.value; });
    const proteinEl = tr.querySelector('.ci-protein');
    proteinEl?.addEventListener('change', (e) => { sel.proteinCode = e.target.value; });
    tr.querySelector('.ci-cat')?.addEventListener('change', (e) => {
      sel.categoryCode = e.target.value;
      proteinEl.hidden = !PROTEIN_ELIGIBLE_CATEGORIES.has(sel.categoryCode);
    });
  });
  document.getElementById('ci-apply').addEventListener('click', () => ciApply(main));
  ciUpdateFooter();
}

function ciSelectedKeys() {
  const ci = state.catalogImport;
  if (!ci.plan) return [];
  return [...ci.plan.newDishes, ...ci.plan.similar, ...ci.plan.notInSection].filter(e => ci.sel[e.key]?.include).map(e => e.key);
}

function ciUpdateFooter() {
  const ci = state.catalogImport;
  const btn = document.getElementById('ci-apply');
  if (!btn || !ci.plan) return;
  const keys = ciSelectedKeys();
  const who = ci.createdBy.trim();
  document.getElementById('ci-count').textContent = `${keys.length} selected`;
  btn.textContent = keys.length ? `Add ${keys.length} to the Dish Catalog${who ? ` as “${who}”` : ''}` : 'Nothing selected';
  btn.disabled = !keys.length || ci.busy;
}

async function ciApply(main) {
  const ci = state.catalogImport;
  const keys = ciSelectedKeys();
  const blank = keys.filter(k => ci.sel[k].name !== undefined && !String(ci.sel[k].name).trim());
  if (blank.length) { alert('A ticked dish has an empty name. Type one or untick it.'); return; }
  if (!ci.createdBy.trim() && !confirm('Created By is empty, so these dishes will have no Created By. Add them anyway?')) return;
  const picks = keys.map(key => {
    const s = ci.sel[key];
    if (s.name === undefined) return { key };
    return { key, name: s.name, categoryCode: s.categoryCode, proteinCode: PROTEIN_ELIGIBLE_CATEGORIES.has(s.categoryCode) ? (s.proteinCode || null) : null };
  });
  ci.busy = true;
  ciUpdateFooter();
  const status = document.getElementById('ci-status');
  status.textContent = `Adding ${picks.length} to the Dish Catalog…`;
  try {
    ci.result = await window.api.applyCatalogImport({ token: ci.plan.token, createdBy: ci.createdBy, picks });
    ci.plan = null;
    status.textContent = '';
    renderCatalogImportView(main);
  } catch (err) {
    status.textContent = `Couldn't add them: ${err.message}`;
  } finally {
    ci.busy = false;
    ciUpdateFooter();
  }
}

function ciRenderResult(main) {
  const r = state.catalogImport.result;
  const styled = r.created.filter(c => STYLE_ELIGIBLE_CATEGORIES.has(c.categoryCode)).length;
  document.getElementById('ci-body').innerHTML = `
    <div class="ci-panel ci-result">
      <h2 class="ci-h2">Done</h2>
      <ul>
        <li><strong>${r.created.length}</strong> dish(es) added to the Dish Catalog${r.createdByLabel ? ` as “${aiEsc(r.createdByLabel)}”` : ''}.</li>
        ${r.sectionsAdded.length ? `<li><strong>${r.sectionsAdded.length}</strong> existing dish(es) made available in another section.</li>` : ''}
        ${r.failed.length ? `<li class="ci-failed">${r.failed.length} not added:<ul>${r.failed.map(f => `<li>${aiEsc(f.name)}: ${aiEsc(f.reason)}</li>`).join('')}</ul></li>` : ''}
      </ul>
      <p class="ci-hint">New dishes have no code, calories or Pastry / Cold Kitchen style yet, the same as a dish added with + Add Item.
        ${styled ? `${styled} of them are snacks or Staff Breakfast dishes, which only enter the daily style rotation once they have a style.` : ''}</p>
      <div class="ci-result-actions">
        ${styled ? '<button class="secondary" id="ci-styles">Estimate missing styles</button>' : ''}
        <button class="primary" id="ci-done">Back to the Dish Catalog</button>
      </div>
      <div id="ci-styles-status" class="ai-progress" role="status" aria-live="polite"></div>
    </div>`;
  document.getElementById('ci-done').addEventListener('click', () => document.getElementById('ci-back').click());
  document.getElementById('ci-styles')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('ci-styles-status');
    btn.disabled = true;
    const unsubscribe = window.api.onAmSnackStyleEstimateProgress(({ message }) => { statusEl.textContent = message; });
    try {
      await window.api.estimateMissingAmSnackStyles();
      statusEl.textContent = 'Styles estimated. Check or correct any of them in Edit Item.';
    } catch (err) {
      statusEl.textContent = `Style estimate failed: ${err.message}`;
      btn.disabled = false;
    } finally { unsubscribe(); }
  });
}

function openCalorieImportPreview(plan, fileName, onDone) {
  const fmt = (v) => (v == null ? '—' : v);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-labelledby="cr-title" style="max-width:760px;">
      <h2 id="cr-title">Import reviewed calories</h2>
      <p style="margin-top:-6px; color:var(--neutral);">${aiEsc(fileName)} — ${plan.rows} row(s) read.</p>
      <ul class="cr-summary">
        <li><strong>${plan.updates.length}</strong> dish(es) will be updated</li>
        <li><strong>${plan.unchanged}</strong> already have that value (no change)</li>
        <li><strong>${plan.blank}</strong> row(s) with no Reviewed value (no change)</li>
        <li><strong>${plan.skipped.length}</strong> row(s) skipped${plan.skipped.length ? ' (listed below)' : ''}</li>
      </ul>
      ${plan.updates.length ? `
        <div class="cr-scroll" style="max-height:260px;"><table class="cr-table">
          <thead><tr><th>Dish</th><th>Now</th><th>New</th></tr></thead>
          <tbody>${plan.updates.map(u => `<tr><td>${aiEsc(u.name)}</td><td>${fmt(u.from)}${u.fromFlagged ? ' <span class="chip unverified">flagged</span>' : ''}</td><td><strong>${u.to}</strong></td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      ${plan.skipped.length ? `
        <h3 style="margin:14px 0 6px; font-size:14px;">Skipped</h3>
        <div class="cr-scroll" style="max-height:180px;"><table class="cr-table">
          <thead><tr><th>Row</th><th>Dish</th><th>Why</th></tr></thead>
          <tbody>${plan.skipped.map(k => `<tr><td>${k.rowNumber}</td><td>${aiEsc(k.name || '')}</td><td>${aiEsc(k.reason)}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      <div class="actions">
        <button class="secondary" id="cr-cancel">Cancel</button>
        <button class="primary" id="cr-confirm" ${plan.updates.length ? '' : 'disabled'}>Update ${plan.updates.length} dish(es)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#cr-cancel').addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.querySelector('#cr-confirm').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await window.api.applyCalorieImport({ token: plan.token });
      close();
      showToast(r.failed.length ? `Updated ${r.written} dish(es); ${r.failed.length} failed: ${r.failed.slice(0, 3).map(f => f.name).join(', ')}` : `Updated calories for ${r.written} dish(es).`);
      onDone();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
      e.currentTarget.disabled = false;
    }
  });
  overlay.querySelector('#cr-cancel').focus();
}

// Dish Catalog "Created By" (menu_items.created_by_label): free text with suggestions -- every label already
// used plus the recipe people (list-created-by-labels in main.js). One <datalist> in <body>, refreshed when
// the catalog or the item form opens and after an inline edit. A failed lookup just leaves no suggestions.
async function fillCreatedByList() {
  let list = document.getElementById('created-by-list');
  if (!list) { list = document.createElement('datalist'); list.id = 'created-by-list'; document.body.appendChild(list); }
  let names;
  try { names = await window.api.listCreatedByLabels(); } catch { names = []; }
  list.textContent = '';
  for (const name of names) { const o = document.createElement('option'); o.value = name; list.appendChild(o); }
}

// The Created By filter: All / one entry per Created By value in use in this section (AI, OLD, a chef's
// name; case-insensitive) / Not set. (The flag-based "AI-generated" entry was dropped 2026-09-24: Created
// By owns provenance in the Dish Catalog; is_ai_generated still drives calorie estimation.)
function createdByFilterOptions(items) {
  const labels = new Map();
  for (const it of items) {
    const l = (it.created_by_label || '').trim();
    if (l && !labels.has(l.toLowerCase())) labels.set(l.toLowerCase(), l);
  }
  const sorted = [...labels.values()].sort((a, b) => a.localeCompare(b));
  return [
    `<option value="">Created by: all</option>`,
    ...sorted.map(l => `<option value="label:${aiEsc(l.toLowerCase())}">Created by: ${aiEsc(l)}</option>`),
    items.some(it => !(it.created_by_label || '').trim()) ? `<option value="none">Created by: not set</option>` : '',
  ].join('');
}

function createdByFilterMatch(it, value) {
  if (!value) return true;
  const label = (it.created_by_label || '').trim().toLowerCase();
  if (value === 'none') return !label;
  return label === value.slice('label:'.length);
}

async function openItemModal(existingItem) {
  const ageGroups = await window.api.getAgeGroups(state.currentSection);
  const sectionCategories = await window.api.getCategoriesForSection(state.currentSection);
  const isEdit = !!existingItem;
  const portions = isEdit ? await window.api.getItemPortions(existingItem.id) : [];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${isEdit ? 'Edit Item' : 'Add Item'}</h2>
      <div class="field">
        <label>Item name</label>
        <input id="m-name" value="${isEdit ? existingItem.name : ''}" />
        <div class="field-warning" id="m-snack-rule-warning" role="status" style="display:none;"></div>
      </div>
      <div class="field-row" style="display:flex; gap:14px;">
        <div class="field" style="max-width:280px; flex:1;">
          <label for="m-created-by">Created By</label>
          <input id="m-created-by" list="created-by-list" value="${isEdit ? aiEsc(existingItem.created_by_label || '') : ''}" placeholder="e.g. Tetiana" />
        </div>
        <div class="field" style="max-width:200px; flex:1;">
          <label for="m-code">Code</label>
          <input id="m-code" value="${isEdit ? aiEsc(existingItem.rc_code || '') : ''}" placeholder="e.g. RC or RG code" />
        </div>
      </div>
      <div class="field">
        <label>Meal period</label>
        <select id="m-period">
          <option value="BREAKFAST">Breakfast</option>
          <option value="LUNCH">Lunch</option>
          <option value="PM_SNACK">PM Snack</option>
        </select>
      </div>
      <div class="field">
        <label>Category</label>
        <select id="m-category"></select>
        <div class="field-warning" id="m-category-warning" style="display:none;">
          This item's saved category doesn't belong to the selected meal period — pick a category to continue.
        </div>
      </div>
      <div class="field">
        <label>Protein type (mains, snacks, Staff breakfast and lunch box)</label>
        <select id="m-protein">
          <option value="">— none —</option>
          ${state.proteinTypes.map(p => `<option value="${p.code}" ${isEdit && existingItem.protein_code === p.code ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label><input type="checkbox" id="m-daily" ${isEdit && existingItem.is_daily_repeating ? 'checked' : ''} /> Repeats every day automatically</label>
      </div>
      <div class="field" style="max-width:220px;">
        <label>Calories per 100g</label>
        <input id="m-calories" type="number" min="0" step="1" value="${isEdit && existingItem.calories_per_100g != null ? existingItem.calories_per_100g : ''}" />
      </div>
      <div class="field" style="max-width:320px;">
        <label>Style (AM Snack, PM Snack, Staff Breakfast)</label>
        <select id="m-am-snack-style">
          <option value="">— auto-classify with AI —</option>
          ${AM_SNACK_STYLE_OPTIONS.map(s => `<option value="${s.code}" ${isEdit && existingItem.am_snack_style === s.code ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Applies to age groups</label>
        <!-- Portion SIZE is no longer set here -- category_portion_defaults (Item Catalog's
             category defaults) is the only source of that now, no per-item override. This grid
             is purely which age groups get an item_portions row at all (section membership),
             same as before but a checkbox instead of a quantity/unit she used to type.
             Disabled on Edit -- editing an existing item's age-group membership was already a
             no-op before this change (parsed but never sent to update-item), so this just makes
             that honestly read-only instead of looking editable when it silently wasn't. -->
        <div class="portion-grid">
          ${ageGroups.map(ag => {
            const existing = portions.find(p => p.age_group_code === ag.code);
            return `<label class="portion-cell"><input type="checkbox" data-ag="${ag.code}" ${existing ? 'checked' : ''} ${isEdit ? 'disabled' : ''} /> ${ag.name}</label>`;
          }).join('')}
        </div>
      </div>
      <div class="actions">
        <button class="secondary" id="m-cancel">Cancel</button>
        <button class="primary" id="m-save">${isEdit ? 'Save Changes' : 'Add Item'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  fillCreatedByList();

  const nameInput = overlay.querySelector('#m-name');
  const periodSelect = overlay.querySelector('#m-period');
  const categorySelect = overlay.querySelector('#m-category');
  const categoryWarning = overlay.querySelector('#m-category-warning');
  const proteinSelect = overlay.querySelector('#m-protein');
  const dailyCheckbox = overlay.querySelector('#m-daily');
  const styleSelect = overlay.querySelector('#m-am-snack-style');
  const saveBtn = overlay.querySelector('#m-save');

  if (isEdit) {
    const cat = state.categories.find(c => c.code === existingItem.category_code);
    if (cat) periodSelect.value = cat.meal_period_code;
  }

  // Rule 1-3: Category only ever lists categories tagged with the currently-selected Meal
  // Period (categories already carry meal_period_code, enriched once in lib/referenceData.js).
  // desiredValue lets a caller ask "try to keep/select this specific category" -- used both for
  // the initial edit-open (the item's own category, always valid since Meal Period itself was
  // just derived FROM that category above) and for a manual Meal Period change afterward (the
  // category picked under the OLD period, which may no longer belong to the new one). When it
  // doesn't, rather than silently falling back to whatever's first in the new list (which would
  // silently reassign the item's category out from under the chef), show an inline warning and
  // require an explicit re-pick before Save is allowed again.
  function refreshCategoryOptions(desiredValue) {
    const period = periodSelect.value;
    const filtered = sectionCategories.filter(c => c.meal_period_code === period);
    const target = desiredValue !== undefined ? desiredValue : categorySelect.value;
    const stillValid = filtered.some(c => c.code === target);

    if (target && !stillValid) {
      categorySelect.innerHTML = [
        `<option value="">— choose a category —</option>`,
        ...filtered.map(c => `<option value="${c.code}">${c.name}</option>`),
      ].join('');
      categoryWarning.style.display = 'block';
    } else {
      categorySelect.innerHTML = filtered
        .map(c => `<option value="${c.code}" ${c.code === target ? 'selected' : ''}>${c.name}</option>`).join('');
      categoryWarning.style.display = 'none';
    }
    saveBtn.disabled = !categorySelect.value;
    refreshProteinAvailability();
    refreshStyleAvailability();
  }

  // Rule 4: Protein Type only selectable for main-dish-type categories -- confirmed against
  // real item_portions/protein_type_id usage data, not just categories literally named "Main".
  function refreshProteinAvailability() {
    const eligible = PROTEIN_ELIGIBLE_CATEGORIES.has(categorySelect.value);
    proteinSelect.disabled = !eligible;
    if (!eligible) proteinSelect.value = '';
  }

  // Style (Pastry/Cold Kitchen) only selectable for AM Snack -- same disabled-when-not-eligible
  // pattern as Protein Type above.
  function refreshStyleAvailability() {
    const eligible = STYLE_ELIGIBLE_CATEGORIES.has(categorySelect.value);
    styleSelect.disabled = !eligible;
    if (!eligible) styleSelect.value = '';
  }

  // Non-blocking: a chicken / beef AM or PM Snack can still be saved (e.g. to rename it later), but it
  // is never put on a new menu.
  const snackRuleWarning = overlay.querySelector('#m-snack-rule-warning');
  function refreshSnackRuleWarning() {
    const cat = categorySelect.value;
    const m = nameInput.value.match(SNACK_LUNCH_ONLY_WORDS);
    const byProtein = SNACK_LUNCH_ONLY_PROTEINS.has(proteinSelect.value);
    const show = SNACK_LUNCH_ONLY_CATEGORIES.has(cat) && (m || byProtein);
    snackRuleWarning.style.display = show ? 'block' : 'none';
    if (show) {
      snackRuleWarning.textContent = `Chicken and beef are served at lunch only: ${m ? `"${m[0]}" in the name` : 'its protein type'} keeps this snack off every new menu. You can still save it — rename it (e.g. a turkey version) or choose another category to have it served.`;
    }
  }
  nameInput.addEventListener('input', refreshSnackRuleWarning);
  proteinSelect.addEventListener('change', refreshSnackRuleWarning);
  categorySelect.addEventListener('change', refreshSnackRuleWarning);

  periodSelect.addEventListener('change', () => { refreshCategoryOptions(); refreshSnackRuleWarning(); });
  categorySelect.addEventListener('change', () => {
    categoryWarning.style.display = 'none';
    saveBtn.disabled = !categorySelect.value;
    refreshProteinAvailability();
    refreshStyleAvailability();
  });

  refreshCategoryOptions(isEdit ? existingItem.category_code : undefined);
  refreshSnackRuleWarning();

  nameInput.addEventListener('blur', async () => {
    if (isEdit || !nameInput.value.trim()) return;
    const suggestion = await window.api.suggestClassification({ name: nameInput.value, mealPeriod: periodSelect.value, sectionCode: state.currentSection });
    if (suggestion.category) {
      categorySelect.value = suggestion.category;
      categoryWarning.style.display = 'none';
      saveBtn.disabled = !categorySelect.value;
      refreshProteinAvailability();
      refreshStyleAvailability();
    }
    if (suggestion.protein && !proteinSelect.disabled) proteinSelect.value = suggestion.protein;
    dailyCheckbox.checked = suggestion.isDailyRepeating;
    refreshSnackRuleWarning();
  });

  overlay.querySelector('#m-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#m-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return alert('Please enter an item name.');

    const caloriesRaw = overlay.querySelector('#m-calories').value.trim();
    const caloriesPer100g = caloriesRaw === '' ? null : parseFloat(caloriesRaw);
    // Blank means "auto-classify with AI" -- resolveAmSnackStyle (main.js) only actually calls
    // the AI when this comes through null/empty AND the category is AM_SNACK; a manually picked
    // value here always wins over that.
    const amSnackStyle = styleSelect.value || null;

    // No quantity/unit to parse anymore -- just which age groups she checked (see the portion
    // grid's own comment above for why: category_portion_defaults is now the sole portion-size
    // source, this is purely section/age-group membership).
    const checkedAgeGroupCodes = [...overlay.querySelectorAll('[data-ag]')]
      .filter(inp => inp.checked)
      .map(inp => inp.dataset.ag);

    if (!isEdit && checkedAgeGroupCodes.length === 0) {
      return alert('Please select at least one age group, otherwise the item can\'t be linked to this section and won\'t appear.');
    }

    // This form only ever shows/edits portions for the current section -- if this item also
    // has portion rows in other sections (not visible here), changing its category could leave
    // those other sections' rows pointing at a category that no longer belongs there. Surface
    // that before saving, since silently allowing it is exactly the bug that produced the
    // cross-section catalog leaks cleaned up earlier; never delete anything without her seeing
    // it named explicitly first.
    let removeInvalidSectionPortions = false;
    if (isEdit && categorySelect.value !== existingItem.category_code) {
      const { invalidSections } = await window.api.checkCategoryChangeImpact({
        itemId: existingItem.id, newCategoryCode: categorySelect.value,
      });
      if (invalidSections.length > 0) {
        const sectionList = invalidSections
          .map(s => `${s.sectionName} (${s.portionCount} portion row${s.portionCount > 1 ? 's' : ''})`)
          .join(', ');
        const proceed = confirm(
          `This item also has portion data in: ${sectionList}. Those sections aren't shown in ` +
          `this form and won't match the new category.\n\nClick OK to also remove those now-stale ` +
          `portion rows, or Cancel to leave the category unchanged.`
        );
        if (!proceed) return;
        removeInvalidSectionPortions = true;
      }
    }

    const result = isEdit
      ? await window.api.updateItem({
          id: existingItem.id, name,
          categoryCode: categorySelect.value,
          proteinCode: proteinSelect.value || null,
          isDailyRepeating: dailyCheckbox.checked,
          isActive: true,
          caloriesPer100g,
          amSnackStyle,
          removeInvalidSectionPortions,
          createdByLabel: overlay.querySelector('#m-created-by').value,
          rcCode: overlay.querySelector('#m-code').value,
        })
      : await window.api.addItem({
          name, categoryCode: categorySelect.value,
          proteinCode: proteinSelect.value || null,
          isDailyRepeating: dailyCheckbox.checked,
          caloriesPer100g,
          amSnackStyle,
          portions: checkedAgeGroupCodes,
          sectionCode: state.currentSection,
          createdByLabel: overlay.querySelector('#m-created-by').value,
          rcCode: overlay.querySelector('#m-code').value,
        });

    // menu_items has UNIQUE(name, category_id) -- the same dish name legitimately recurs across
    // many categories in this catalog, so a collision is a real, expected case, not a crash.
    // Keep the dialog open so the chef can rename the item or pick a different category.
    if (result && result.duplicate) {
      return alert(`An item named "${name}" already exists in that category. Please rename it or choose a different category.`);
    }

    overlay.remove();
    renderView();
  });
}

// ============================================================
// GENERATE VIEW
// ============================================================
// Section selection here is entirely self-contained (the "g-section" <select> below) --
// deliberately NOT wired to state.currentSection or the Dish Catalog sidebar list. The two
// features used to share that one piece of state, which made whichever nav button was
// clicked last silently change what the other view meant by "section"; owning it locally
// removes that coupling entirely.
// ============================================================
// MENU PLANNER (2026-09-25) -- one nav entry for Generate Menu, Build Menu and Export All Sections.
// A thin shell: two switches on top, and below them the three screens' OWN, unchanged render
// functions draw into #planner-body (display: contents, so Build Menu's scroll area and docked tab
// strip still lay out as direct children of #main, exactly as before). Generate + One Section =
// renderGenerateView, Generate + All Sections = renderExportAllView, Build = renderBuildMenuView.
// Nothing here touches generation: every screen keeps calling the same IPC. Build Menu's grid
// lives in state.builder, so switching modes never loses it.
// ============================================================
// The last mode used is remembered on this computer (a convenience only: any storage failure just
// means the default, Generate + One Section).
const MENU_PLANNER_MODE_KEY = 'menuPlannerMode';
function restoreMenuPlannerMode(mp) {
  if (mp.restored) return;
  mp.restored = true;
  try {
    const saved = JSON.parse(localStorage.getItem(MENU_PLANNER_MODE_KEY) || 'null');
    if (saved && ['generate', 'build'].includes(saved.mode)) mp.mode = saved.mode;
    if (saved && ['one', 'all'].includes(saved.scope)) mp.scope = saved.scope;
  } catch { /* keep the default */ }
}
function saveMenuPlannerMode(mp) {
  try { localStorage.setItem(MENU_PLANNER_MODE_KEY, JSON.stringify({ mode: mp.mode, scope: mp.scope })); } catch { /* not critical */ }
}

// Generate + One Section and Generate + All Sections ask for the same four things: carry them across
// the switch (session only). Fills the screen's own inputs after it has rendered and records edits;
// the date change event lets the screen's own date-range wiring update its "N school days" hint.
const MENU_PLANNER_FIELD_IDS = {
  one: { label: 'g-label', createdBy: 'g-created-by', start: 'g-start', end: 'g-end' },
  all: { label: 'ea-label', createdBy: 'ea-created-by', start: 'ea-start', end: 'ea-end' },
};
function wireMenuPlannerFields(mp) {
  const ids = MENU_PLANNER_FIELD_IDS[mp.scope];
  for (const key of ['label', 'createdBy', 'start', 'end']) {
    const el = document.getElementById(ids[key]);
    if (!el) continue;
    if (mp.fields[key] && !el.value) {
      el.value = mp.fields[key];
      if (key === 'start' || key === 'end') el.dispatchEvent(new Event('change'));
    }
    const record = () => { mp.fields[key] = el.value; };
    el.addEventListener('input', record);
    el.addEventListener('change', record);
  }
}

function renderMenuPlannerView(main) {
  const mp = state.menuPlanner;
  restoreMenuPlannerMode(mp);
  const seg = (group, value, label, current) =>
    `<button type="button" class="planner-seg-btn ${current === value ? 'active' : ''}" data-planner-${group}="${value}" aria-pressed="${current === value}">${label}</button>`;
  main.innerHTML = `
    <div class="planner-switch ${mp.mode === 'build' ? 'in-build' : ''}">
      <div class="planner-seg" role="group" aria-label="Menu Planner mode">
        ${seg('mode', 'generate', 'Generate Menu', mp.mode)}${seg('mode', 'build', 'Build Menu', mp.mode)}
      </div>
      ${mp.mode === 'generate' ? `
      <div class="planner-seg" role="group" aria-label="Sections">
        ${seg('scope', 'all', 'All Sections', mp.scope)}${seg('scope', 'one', 'One Section', mp.scope)}
      </div>` : ''}
    </div>
    <div id="planner-body"></div>
  `;
  main.querySelectorAll('[data-planner-mode], [data-planner-scope]').forEach(btn => {
    btn.disabled = mp.busy;
    btn.addEventListener('click', () => {
      if (mp.busy) return;
      if (btn.dataset.plannerMode) mp.mode = btn.dataset.plannerMode;
      if (btn.dataset.plannerScope) mp.scope = btn.dataset.plannerScope;
      saveMenuPlannerMode(mp);
      renderView();
    });
  });
  const body = document.getElementById('planner-body');
  if (mp.mode === 'build') return renderBuildMenuView(body);
  const rendered = mp.scope === 'all' ? renderExportAllView(body) : renderGenerateView(body);
  return Promise.resolve(rendered).then((r) => { wireMenuPlannerFields(mp); return r; });
}

// ============================================================
// Created By mix (2026-09-25): Generate + One Section / All Sections only. Target percentages per
// Created By value, a BEST-EFFORT bias the engine applies per section + category (lib/createdByMix.js):
// every rule still wins, and a thin pool just lands short, reported. Off by default (no value above 0);
// kept for the session in state.menuPlanner.mix, never saved, and always visible while on (the Generate
// button reads "... with Created By mix").
// ============================================================
const MIX_SECTION_ORDER = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF', 'CEO'];
const MIX_SHORT_POINTS = 10; // lib/createdByMix.js SHORT_POINTS
const mixLabelText = (l) => (l ? l : 'Not set');

function mixValues() { return state.menuPlanner.mix.values; }
function mixTotal() { return Object.values(mixValues()).reduce((n, v) => n + (Number(v) || 0), 0); }
function mixActive() { return Object.values(mixValues()).some(v => Number(v) > 0); }
// { label: percent } for the engine, or null when off.
function mixPayload() {
  if (!mixActive()) return null;
  return Object.fromEntries(Object.entries(mixValues()).filter(([, v]) => Number(v) > 0).map(([l, v]) => [l, Number(v)]));
}
function mixSummaryText() {
  if (!mixActive()) return 'Off: picks as usual';
  return Object.entries(mixValues()).filter(([, v]) => Number(v) > 0).sort((a, b) => b[1] - a[1])
    .map(([l, v]) => `${mixLabelText(l)} ${v}%`).join(' · ');
}
// lib/createdByMix.js shareCeiling, mirrored (this is a classic script): the most a value could reach
// from its dish count alone, each dish at most once per 28 calendar days of the run.
function mixShareCeiling(dishes, picks, numWeekdays) {
  if (!picks) return 100;
  const uses = Math.max(1, Math.ceil((numWeekdays * 7) / 5 / 28));
  return Math.min(100, Math.floor((100 * dishes * uses) / picks));
}

// host: where the panel goes. getScope(): { sectionCodes, numWeekdays, allSections, exactDays }.
// onChange(): called whenever the mix changes, so the screen can relabel / disable its Generate button.
// The mix panel's scope from a screen's own date fields (20 school days until dates are chosen).
async function mixScope(startId, endId, sectionCodes, allSections) {
  const startDate = document.getElementById(startId)?.value;
  const endDate = document.getElementById(endId)?.value;
  let numWeekdays = 20, exactDays = false;
  if (startDate && endDate && endDate >= startDate) {
    const n = await window.api.getSchoolDayCount({ startDate, endDate });
    if (n > 0) { numWeekdays = n; exactDays = true; }
  }
  return { sectionCodes, numWeekdays, allSections, exactDays };
}

function renderMixPanel(host, getScope, onChange) {
  const mix = state.menuPlanner.mix;
  host.innerHTML = `
    <details class="mix-panel" ${mix.open ? 'open' : ''}>
      <summary><span class="mix-title">Created By mix</span> <span class="mix-optional">(optional)</span> <span class="mix-summary" id="mix-summary"></span></summary>
      <div class="mix-body">
        <p class="mix-hint">Nudges each category's picks toward these shares of Created By. Every menu rule still comes first, so a category
          without enough of a value's dishes lands short (listed below before you generate, and in a report after). Off when everything is 0.</p>
        <div id="mix-values" class="mix-values">Loading the dishes in scope…</div>
        <div class="mix-total-row"><span id="mix-total"></span><button type="button" class="secondary small" id="mix-off">Turn off</button></div>
        <div id="mix-check"></div>
      </div>
    </details>`;
  const details = host.querySelector('.mix-panel');
  details.addEventListener('toggle', () => { mix.open = details.open; if (details.open) mixRefresh(); });
  host.querySelector('#mix-off').addEventListener('click', () => { mix.values = {}; mixRender(); onChange(); });

  async function mixRefresh() {
    const scope = await getScope();
    const key = `${scope.sectionCodes.join(',')}|${scope.numWeekdays}|${scope.allSections}|${scope.exactDays}`;
    mix.scope = scope;
    if (mix.check && mix.checkKey === key) return mixRender();
    mix.checkKey = key;
    host.querySelector('#mix-values').textContent = 'Loading the dishes in scope…';
    try {
      const check = await window.api.createdByMixPools(scope);
      if (mix.checkKey !== key) return; // a newer scope was asked for meanwhile
      mix.check = check;
    } catch (err) {
      host.querySelector('#mix-values').textContent = `Couldn't load the dishes: ${err.message}`;
      return;
    }
    mixRender();
  }

  function mixRender() {
    host.querySelector('#mix-summary').textContent = mixSummaryText();
    const total = mixTotal();
    host.querySelector('#mix-total').innerHTML = !mixActive() ? 'Off'
      : total === 100 ? 'Total 100% ✓' : `<span class="mix-bad">Total ${total}%: must be 100%</span>`;
    const check = mix.check;
    if (!check) return;
    const choiceRows = check.rows.filter(r => r.picks > 0);
    const dishes = (label) => choiceRows.reduce((n, r) => n + (r.byLabel[label] || 0), 0);
    const labels = [...check.labels, ''];
    for (const l of Object.keys(mix.values)) if (!labels.includes(l)) labels.push(l);
    const valuesEl = host.querySelector('#mix-values');
    valuesEl.innerHTML = labels.map(l => `
      <label class="mix-value">
        <span class="mix-value-name">${aiEsc(mixLabelText(l))}</span>
        <input type="number" min="0" max="100" step="5" data-label="${aiEsc(l)}" value="${Number(mix.values[l]) || 0}" aria-label="${aiEsc(mixLabelText(l))} percent" />
        <span class="mix-pct">%</span>
        <span class="mix-count">${dishes(l)} dish${dishes(l) === 1 ? '' : 'es'} in scope</span>
      </label>`).join('');
    valuesEl.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, Math.round(Number(inp.value) || 0)));
      if (v) mix.values[inp.dataset.label] = v; else delete mix.values[inp.dataset.label];
      host.querySelector('#mix-summary').textContent = mixSummaryText();
      const t = mixTotal();
      host.querySelector('#mix-total').innerHTML = !mixActive() ? 'Off' : t === 100 ? 'Total 100% ✓' : `<span class="mix-bad">Total ${t}%: must be 100%</span>`;
      renderCheck();
      onChange();
    }));
    renderCheck();
  }

  function renderCheck() {
    const check = mix.check;
    const scope = mix.scope;
    const el = host.querySelector('#mix-check');
    if (!check || !scope) return;
    const targets = Object.entries(mix.values).filter(([, v]) => Number(v) > 0);
    const secName = (c) => state.sections.find(s => s.code === c)?.name || c;
    const shortfalls = [];
    for (const r of check.rows) {
      if (!r.picks) continue;
      for (const [l, t] of targets) {
        const n = r.byLabel[l] || 0;
        const ceiling = mixShareCeiling(n, r.picks, scope.numWeekdays);
        if (ceiling < t - MIX_SHORT_POINTS) shortfalls.push({ r, l, n, t, ceiling });
      }
    }
    const shownLabels = targets.length ? targets.map(([l]) => l) : [...check.labels, ''];
    const note = (r) => r.fixedDaily ? 'Fixed daily dish: not affected'
      : r.follows ? `Follows ${secName(r.follows)}'s pick` : r.sharedWith ? `Shared with ${secName(r.sharedWith)}: dishes both have` : '';
    el.innerHTML = `
      <h4 class="mix-h4">${targets.length ? (shortfalls.length ? `Can't reach this mix in ${new Set(shortfalls.map(s => s.r)).size} categor${new Set(shortfalls.map(s => s.r)).size === 1 ? 'y' : 'ies'}` : 'Every category has enough dishes for this mix') : 'Dishes per category'}
        <span class="mix-h4-note">${scope.exactDays ? `${scope.numWeekdays} school days` : `${scope.numWeekdays} school days (choose dates for an exact check)`}</span></h4>
      ${shortfalls.length ? `<ul class="mix-shortfalls">${shortfalls.map(s => `<li><strong>${aiEsc(secName(s.r.section))} · ${aiEsc(s.r.categoryName)}</strong>: ${aiEsc(mixLabelText(s.l))} has ${s.n === 0 ? 'no dishes' : `only ${s.n} dish${s.n === 1 ? '' : 'es'}`} for ${s.r.picks} picks, so at most ~${s.ceiling}% (asked ${s.t}%)</li>`).join('')}</ul>` : ''}
      <details class="mix-all" ${targets.length ? '' : 'open'}><summary>All categories</summary>
        <div class="cr-scroll"><table class="cr-table mix-table">
          <thead><tr><th>Section</th><th>Category</th><th>Choices</th>${shownLabels.map(l => `<th>${aiEsc(mixLabelText(l))}</th>`).join('')}<th></th></tr></thead>
          <tbody>${check.rows.map(r => `<tr class="${shortfalls.some(s => s.r === r) ? 'mix-short' : ''}">
            <td>${aiEsc(secName(r.section))}</td><td>${aiEsc(r.categoryName)}</td><td>${r.picks || '—'}</td>
            ${shownLabels.map(l => { const n = r.byLabel[l] || 0; return `<td class="${r.picks && n <= 1 ? 'mix-thin' : ''}">${r.picks ? n : ''}</td>`; }).join('')}
            <td class="mix-note">${aiEsc(note(r))}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>`;
  }

  host.refreshMix = () => { if (mix.open) mixRefresh(); };
  mixRender();
  if (mix.open) mixRefresh();
}

// After generating: target vs achieved per category. reportBySection: { SECTION: rows | null }.
function mixReportHtml(reportBySection) {
  const sections = MIX_SECTION_ORDER.filter(s => reportBySection && reportBySection[s]);
  if (!sections.length) return '';
  const secName = (c) => state.sections.find(s => s.code === c)?.name || c;
  const all = sections.flatMap(s => reportBySection[s]);
  const shortCount = all.filter(r => r.short).length;
  return `
    <details class="mix-report" open>
      <summary>Created By mix: how it landed <span class="mix-h4-note">${shortCount ? `${shortCount} categor${shortCount === 1 ? 'y' : 'ies'} short of the mix` : 'every category reached it'}</span></summary>
      ${sections.map(s => `
        <h4 class="mix-h4">${aiEsc(secName(s))}</h4>
        <div class="cr-scroll"><table class="cr-table mix-table">
          <thead><tr><th>Category</th><th>Choices</th><th>Target → achieved</th><th>Why short</th></tr></thead>
          <tbody>${reportBySection[s].map(r => `<tr class="${r.short ? 'mix-short' : ''}">
            <td>${aiEsc(r.categoryName)}</td><td>${r.picks}</td>
            <td>${r.rows.filter(x => x.target || x.achieved).map(x => `<span class="mix-cell">${aiEsc(mixLabelText(x.label))} ${x.target}% → <strong>${x.achieved}%</strong></span>`).join(' ')}</td>
            <td class="mix-note">${r.rows.filter(x => x.note).map(x => `${aiEsc(mixLabelText(x.label))}: ${aiEsc(x.note)}`).join('; ')}</td></tr>`).join('')}</tbody>
        </table></div>`).join('')}
    </details>`;
}

// A Generate / Export All run is in flight: lock the Menu Planner switches until it finishes.
function setMenuPlannerBusy(busy) {
  state.menuPlanner.busy = busy;
  document.querySelectorAll('[data-planner-mode], [data-planner-scope]').forEach(b => { b.disabled = busy; });
}

function renderGenerateView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Generate Menu</h1><span class="section-pill" id="g-section-pill">${state.sections[0].name}</span></div>
    </div>
    <div class="generate-controls">
      <div class="field">
        <label>Section</label>
        <select id="g-section">
          ${state.sections.map(s => `<option value="${s.code}">${s.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Workbook name</label>
        <input id="g-label" />
      </div>
      <div class="field">
        <label>Created by</label>
        <input id="g-created-by" />
      </div>
      <div class="field">
        <label>Start date</label>
        <input id="g-start" type="date" />
      </div>
      <div class="field">
        <label>End date</label>
        <input id="g-end" type="date" />
      </div>
      <button class="primary" id="g-generate">Generate Menu</button>
    </div>
    <div id="g-day-count" class="day-count-hint" style="margin:-10px 0 14px;"></div>
    <div id="g-mix"></div>
    <div id="g-result"></div>
  `;

  const sectionSelect = document.getElementById('g-section');
  const sectionPill = document.getElementById('g-section-pill');
  sectionSelect.addEventListener('change', () => {
    sectionPill.textContent = state.sections.find(s => s.code === sectionSelect.value)?.name || '';
  });

  wireDateRangeFields('g-start', 'g-end', 'g-day-count');

  const genBtn = document.getElementById('g-generate');
  const updateGenBtn = () => { genBtn.textContent = mixActive() ? 'Generate with Created By mix' : 'Generate Menu'; };
  const mixHost = document.getElementById('g-mix');
  renderMixPanel(mixHost, () => mixScope('g-start', 'g-end', [sectionSelect.value], false), updateGenBtn);
  updateGenBtn();
  for (const id of ['g-section', 'g-start', 'g-end']) document.getElementById(id).addEventListener('change', () => mixHost.refreshMix());

  genBtn.addEventListener('click', async () => {
    const label = document.getElementById('g-label').value.trim() || 'Untitled Menu';
    const createdBy = document.getElementById('g-created-by').value.trim() || null;
    const startDate = document.getElementById('g-start').value;
    const endDate = document.getElementById('g-end').value;
    if (!startDate || !endDate) return alert('Please choose a start and end date.');
    if (endDate < startDate) return alert('End date must be on or after the start date.');

    const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
    if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');
    if (mixActive() && mixTotal() !== 100) return alert(`The Created By mix adds up to ${mixTotal()}%. Make it 100%, or turn it off.`);

    const resultEl = document.getElementById('g-result');
    resultEl.innerHTML = 'Generating…';
    let menuId, resultDays, warnings, mixReport;
    const sectionCode = sectionSelect.value;
    setMenuPlannerBusy(true);
    try {
      ({ menuId, resultDays, warnings, mixReport } = await window.api.generateMenu({
        sectionCode, label, startDate, numWeekdays, createdBy, createdByMix: mixPayload(),
      }));
    } finally { setMenuPlannerBusy(false); }
    state.currentGeneratedMenuId = menuId;
    renderMenuResult(resultEl, menuId, resultDays, warnings, createdBy);
    if (mixReport) resultEl.insertAdjacentHTML('afterbegin', mixReportHtml({ [sectionCode]: mixReport }));
  });
}

// Shared by Generate Menu/Build Menu/Export All Sections' Start date + End date field pairs.
// Keeps End date's native `min` in sync with Start date, so the date picker itself won't offer
// an earlier date, and live-updates a small "N school days" hint. The hint lives as a sibling
// of .generate-controls (not inside the End date .field) specifically so it doesn't add a third
// row to only one of the two fields -- .generate-controls uses align-items: end, so an uneven
// field height there is what was throwing off the Start/End input alignment.
function wireDateRangeFields(startId, endId, hintId) {
  const startEl = document.getElementById(startId);
  const endEl = document.getElementById(endId);

  function syncMin() {
    if (startEl.value) endEl.min = startEl.value;
    else endEl.removeAttribute('min');
  }

  syncMin();
  updateSchoolDayCountHint(startId, endId, hintId);

  startEl.addEventListener('change', () => {
    syncMin();
    updateSchoolDayCountHint(startId, endId, hintId);
  });
  endEl.addEventListener('change', () => updateSchoolDayCountHint(startId, endId, hintId));
}

async function updateSchoolDayCountHint(startId, endId, hintId) {
  const startDate = document.getElementById(startId).value;
  const endDate = document.getElementById(endId).value;
  const hintEl = document.getElementById(hintId);
  if (!startDate || !endDate) { hintEl.textContent = ''; return; }
  if (endDate < startDate) { hintEl.textContent = 'End date is before start date.'; return; }
  const count = await window.api.getSchoolDayCount({ startDate, endDate });
  hintEl.textContent = `${count} school day${count === 1 ? '' : 's'}`;
}

function renderMenuResult(container, menuId, days, warnings, createdBy) {
  container.innerHTML = `
    ${warnings && warnings.length ? `
      <div class="warning-banner">
        ⚠ ${warnings.length} item(s) had to repeat sooner than 4 weeks — the item catalog doesn't yet have
        enough variety for a full no-repeat cycle. Add more dishes in the Dish Catalog to fix this over time.
      </div>` : ''}
    <div style="margin-bottom:14px; display:flex; align-items:center; gap:14px;">
      <button class="secondary" id="export-btn">Export to Excel</button>
      <span style="color:var(--neutral); font-size:12.5px;">Created by: ${createdBy || '—'}</span>
    </div>
    <div id="days-container"></div>
  `;
  document.getElementById('export-btn').addEventListener('click', async () => {
    const result = await window.api.exportMenuToExcel({ generatedMenuId: menuId });
    if (result.success) alert(`Exported to ${result.path}`);
  });

  const daysContainer = document.getElementById('days-container');
  daysContainer.innerHTML = days.map((day, dayIdx) => `
    <div class="day-card">
      <div class="day-head"><span>${day.weekday}</span><span class="date">${day.date}</span></div>
      <div class="day-items">
        ${day.items.map((it, itemIdx) => `
          <div class="day-item">
            <span class="cat-label">${it.category.replace(/_/g, ' ')}</span>
            <span class="item-name">${it.name}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// ============================================================
// HISTORY VIEW
// ============================================================
// Unified across all sections (not filtered by the section nav) -- a bulk export (Export All
// Sections, or Build Menu's "Export") saves 5 separate generated_menus rows sharing a
// batch_id, and main.js's list-generated-menus collapses those into one entry tagged "All
// Sections" here, with `menuIds` listing every real row it represents. Deleting that one entry
// expands back to all 5 real ids before calling deleteGeneratedMenus, which is otherwise
// unaware batches exist at all. Batch entries aren't clickable for the day-by-day detail view,
// since there's no single coherent "one section's items" to show for 5 sections at once.
async function renderHistoryView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>History</h1><span class="page-description">Every generated menu, all sections</span></div>
    </div>
    <div id="history-list"></div>
    <div id="history-detail"></div>
  `;
  const menus = await window.api.listGeneratedMenus();
  const listEl = document.getElementById('history-list');
  if (menus.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="display">No menus generated yet</div>Head to "Generate Menu" to create one.</div>`;
    return;
  }
  const selected = new Set();

  listEl.innerHTML = `
    <div class="history-toolbar">
      <label><input type="checkbox" id="history-select-all" /> Select All</label>
      <button class="secondary" id="history-delete-btn" disabled>Delete Selected</button>
    </div>
    <div class="table-scroll"><table class="history-table">
      <thead><tr><th></th><th>Name</th><th>Created By</th><th>Date</th><th>Section</th><th>Export</th></tr></thead>
      <tbody>
        ${menus.map(m => `
          <tr data-id="${m.id}" ${m.isBatch ? 'title="Bundled export across all sections — no combined detail view, but exportable and deletable as one"' : ''}>
            <td><input type="checkbox" class="history-row-check" data-select="${m.id}" /></td>
            <td><strong>${m.label}</strong></td>
            <td>${m.created_by || '—'}</td>
            <td>${m.start_date}</td>
            <td>${m.isBatch ? 'All Sections' : m.tag}</td>
            <td><button class="icon-btn history-export-btn" data-export="${m.id}">Export</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table></div>
  `;

  const selectAllEl = document.getElementById('history-select-all');
  const deleteBtn = document.getElementById('history-delete-btn');

  function updateDeleteBtn() {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size > 0 ? `Delete Selected (${selected.size})` : 'Delete Selected';
  }

  listEl.querySelectorAll('.history-row-check').forEach(cb => {
    // Stop the click from bubbling to the <tr>'s own listener below, which opens the detail view.
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const id = cb.dataset.select;
      if (cb.checked) selected.add(id); else selected.delete(id);
      selectAllEl.checked = selected.size === menus.length;
      updateDeleteBtn();
    });
  });

  // Batch ("all_sections") entries have no combined detail view to export from, so this button
  // is their only export path; single-section entries also get one here as a shortcut, on top
  // of the "Export to Excel" button already inside their detail view (renderMenuResult).
  listEl.querySelectorAll('.history-export-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't also trigger the row's own click-to-view handler below
      const entry = menus.find(m => m.id === btn.dataset.export);
      if (!entry) return;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Exporting…';
      try {
        const result = entry.isBatch
          ? await window.api.exportAllSectionsToExcel({ menuIdsBySection: entry.menuIdsBySection, label: entry.label })
          : await window.api.exportMenuToExcel({ generatedMenuId: entry.menuIds[0] });
        if (result.success) alert(`Exported to ${result.path}`);
        else if (!result.cancelled) alert('Export failed.');
      } catch (err) {
        alert(`Export failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  selectAllEl.addEventListener('change', () => {
    listEl.querySelectorAll('.history-row-check').forEach(cb => {
      cb.checked = selectAllEl.checked;
      const id = cb.dataset.select;
      if (selectAllEl.checked) selected.add(id); else selected.delete(id);
    });
    updateDeleteBtn();
  });

  deleteBtn.addEventListener('click', async () => {
    const count = selected.size;
    if (!confirm(`Delete ${count} selected menu${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    deleteBtn.disabled = true;
    // Expand any selected batch entries back to every real generated_menus.id they represent --
    // deleteGeneratedMenus itself has no concept of batches, it just deletes whatever ids it's given.
    const idsToDelete = [...selected].flatMap(id => {
      const entry = menus.find(m => m.id === id);
      return entry ? entry.menuIds : [id];
    });
    await window.api.deleteGeneratedMenus(idsToDelete);
    renderHistoryView(main);
  });

  listEl.querySelectorAll('[data-id]').forEach(tr => {
    const entry = menus.find(m => m.id === tr.dataset.id);
    if (!entry || entry.isBatch) return; // no combined detail view across 5 sections
    tr.addEventListener('click', async () => {
      const days = await window.api.getGeneratedMenuDetail(entry.menuIds[0]);
      const formattedDays = days.map(d => ({
        date: d.menu_date, weekday: d.day_of_week,
        items: d.items.map(it => ({ category: it.category_code, name: it.name })),
      }));
      state.currentGeneratedMenuId = entry.menuIds[0];
      renderMenuResult(document.getElementById('history-detail'), entry.menuIds[0], formattedDays, [], entry.created_by);
    });
  });
}

// ============================================================
// BUILD MENU VIEW (manual builder)
// ============================================================
function builderSelectionKey(date, categoryCode, idx) {
  return `${date}|${categoryCode}|${idx}`;
}

// Daycare and KG-LP serve ONE shared AM Snack and ONE shared PM Snack a day (lib/generator.js
// SECTION_COUPLINGS, 2026-09-24): chosen on the Daycare tab, KG-LP's cells follow read-only.
const BUILDER_SHARED_SNACKS = { source: 'DAYCARE', copy: 'KG_LP', categories: ['AM_SNACK', 'PM_SNACK'] };
// Pastry / Cold Kitchen for a snack cell on the grid's dayIndex-th school day (1-based); mirrors
// SNACK_STYLE_BY_PATTERN / snackStyleFor in lib/generator.js (Pattern A on day 1 of the range).
const BUILDER_SNACK_STYLE = {
  A: { AM_SNACK: { DAYCARE: 'PASTRY', KG_LP: 'PASTRY', MS_UP: 'COLD_KITCHEN' }, PM_SNACK: { DAYCARE: 'COLD_KITCHEN', KG_LP: 'COLD_KITCHEN', MS_UP: 'PASTRY' } },
  B: { AM_SNACK: { DAYCARE: 'COLD_KITCHEN', KG_LP: 'COLD_KITCHEN', MS_UP: 'PASTRY' }, PM_SNACK: { DAYCARE: 'PASTRY', KG_LP: 'PASTRY', MS_UP: 'COLD_KITCHEN' } },
};
const BUILDER_STYLE_LABEL = { PASTRY: 'Pastry', COLD_KITCHEN: 'Cold Kitchen' };
function builderSnackStyle(dayIndex, categoryCode, sectionCode) {
  return BUILDER_SNACK_STYLE[dayIndex % 2 === 1 ? 'A' : 'B'][categoryCode]?.[sectionCode] || null;
}

// Copies Daycare's snack choices into KG-LP's (hidden, read-only) selections. Run after any change
// that can touch them, and before the completeness count and the export.
function syncBuilderSharedSnacks() {
  const src = state.builder.sections[BUILDER_SHARED_SNACKS.source];
  const dst = state.builder.sections[BUILDER_SHARED_SNACKS.copy];
  if (!src || !dst) return;
  for (const day of state.builder.days) {
    for (const cat of BUILDER_SHARED_SNACKS.categories) {
      const key = builderSelectionKey(day.date, cat, 0);
      if (key in dst.selections) dst.selections[key] = src.selections[key] || '';
    }
  }
}

// The style note under a snack cell: nothing when the dish matches today's style, otherwise
// "breaks today's rotation" (allowed -- Build Menu is the manual override screen; Auto-Fill keeps it).
function builderStyleNoteHtml(item, requiredStyle) {
  if (!requiredStyle || !item) return '';
  if (item.am_snack_style === requiredStyle) return '';
  const what = item.am_snack_style ? BUILDER_STYLE_LABEL[item.am_snack_style] : 'No style set';
  return `<div class="builder-style-note">${what} — breaks today's rotation (${BUILDER_STYLE_LABEL[requiredStyle]} today)</div>`;
}

function renderBuildMenuView(main) {
  if (!state.builder.activeSection) state.builder.activeSection = state.sections[0].code;

  main.innerHTML = `
    <div class="build-scroll">
      <div class="topbar">
        <div><h1>Build Menu</h1><span class="page-description">Pick every dish yourself</span></div>
      </div>
      <div class="generate-controls">
        <div class="field">
          <label>Workbook name</label>
          <input id="bm-label" value="${state.builder.label}" />
        </div>
        <div class="field">
          <label>Created by</label>
          <input id="bm-created-by" value="${state.builder.createdBy}" />
        </div>
        <div class="field">
          <label>Start date</label>
          <input id="bm-start" type="date" value="${state.builder.startDate}" />
        </div>
        <div class="field">
          <label>End date</label>
          <input id="bm-end" type="date" value="${state.builder.endDate}" />
        </div>
        <button class="secondary" id="bm-build-btn">Build Grids</button>
        <button class="secondary" id="bm-template-btn">Export Blank Template</button>
        <button class="primary" id="bm-export-btn" disabled>Export</button>
      </div>
      <div id="bm-day-count" class="day-count-hint" style="margin:-10px 0 14px;"></div>
      <div id="bm-status" style="color:var(--neutral); font-size:12.5px; margin-bottom:14px;"></div>
      <div id="bm-grid"></div>
    </div>
    <div id="bm-tabs" class="builder-tabs"></div>
  `;

  document.getElementById('bm-build-btn').addEventListener('click', buildAllBuilderGrids);
  document.getElementById('bm-template-btn').addEventListener('click', exportBuilderBlankTemplate);
  document.getElementById('bm-export-btn').addEventListener('click', exportBuilderMenu);
  wireDateRangeFields('bm-start', 'bm-end', 'bm-day-count');

  renderBuilderTabs();
  renderBuilderGrid();
  updateBuilderCompleteness();
}

function renderBuilderTabs() {
  const el = document.getElementById('bm-tabs');
  el.innerHTML = state.sections.map(s => `
    <button class="nav-btn ${s.code === state.builder.activeSection ? 'active' : ''}" data-builder-section="${s.code}">${s.name}</button>
  `).join('');
  el.querySelectorAll('[data-builder-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.builder.activeSection = btn.dataset.builderSection;
      renderBuilderTabs();
      renderBuilderGrid();
    });
  });
}

async function buildAllBuilderGrids() {
  const label = document.getElementById('bm-label').value.trim();
  const createdBy = document.getElementById('bm-created-by').value.trim();
  const startDate = document.getElementById('bm-start').value;
  const endDate = document.getElementById('bm-end').value;
  if (!startDate || !endDate) return alert('Please choose a start and end date.');
  if (endDate < startDate) return alert('End date must be on or after the start date.');
  if (!label) return alert('Please enter a label.');

  const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
  if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');

  state.builder.label = label;
  state.builder.createdBy = createdBy;
  state.builder.startDate = startDate;
  state.builder.endDate = endDate;
  state.builder.numWeekdays = numWeekdays;

  const statusEl = document.getElementById('bm-status');
  statusEl.textContent = 'Building grids for all 5 sections…';

  state.builder.days = await window.api.getSchoolDays({ startDate, numWeekdays });

  await Promise.all(state.sections.map(async (section) => {
    // One call per section (2 Supabase queries via getSectionItemPool, grouped by category
    // server-side) instead of one call per section*category slot -- see get-section-item-pool
    // in main.js for the full round-trip-count rationale.
    const [slotDefs, itemsByCategory] = await Promise.all([
      window.api.getSectionSlots(section.code),
      window.api.getSectionItemPool(section.code),
    ]);
    const slots = slotDefs.map(({ categoryCode, count, fixedDaily }) => {
      const items = itemsByCategory[categoryCode] || [];
      const dailyItems = items.filter(i => i.is_daily_repeating).slice(0, count);
      // fixedDaily (Staff's three beverages): the category's daily item or nothing -- never a free
      // choice, same as the engine (MenuGenerator._pickItems).
      return { categoryCode, count, fixedDaily, isDaily: dailyItems.length > 0, dailyItems, eligibleItems: items };
    });

    const selections = {};
    for (const slot of slots) {
      if (slot.isDaily || slot.fixedDaily) continue;
      for (const day of state.builder.days) {
        for (let idx = 0; idx < slot.count; idx++) {
          selections[builderSelectionKey(day.date, slot.categoryCode, idx)] = '';
        }
      }
    }
    state.builder.sections[section.code] = { slots, selections };
  }));

  // The shared Daycare / KG-LP snacks: Daycare's dropdown offers only dishes both catalogs have
  // (the engine's shared pool); KG-LP's cells follow Daycare's pick.
  for (const cat of BUILDER_SHARED_SNACKS.categories) {
    const src = state.builder.sections[BUILDER_SHARED_SNACKS.source]?.slots.find(sl => sl.categoryCode === cat);
    const dst = state.builder.sections[BUILDER_SHARED_SNACKS.copy]?.slots.find(sl => sl.categoryCode === cat);
    if (!src || !dst) continue;
    const inCopy = new Set(dst.eligibleItems.map(it => it.id));
    src.eligibleItems = src.eligibleItems.filter(it => inCopy.has(it.id));
    dst.sharedFrom = BUILDER_SHARED_SNACKS.source;
  }

  // Staff's Main Dish carries the school's shared dishes (KG-LP/MS-UP Lunch Main and Starch, MS-UP's
  // Lunch Vegetable -- see STAFF_MAIN_SOURCE_SECTIONS in lib/generator.js), which live in those
  // categories, not STAFF_MAIN -- offer them in Staff Main's dropdowns too, grouped by where they
  // come from.
  const staffMain = state.builder.sections.STAFF?.slots.find(sl => sl.categoryCode === 'STAFF_MAIN');
  if (staffMain) {
    const sharedFrom = [['KG_LP', 'LUNCH_MAIN', 'Shared: Lunch Main'], ['KG_LP', 'LUNCH_STARCH', 'Shared: Lunch Starch'], ['MS_UP', 'LUNCH_VEGETABLE', 'Shared: MS-UP Lunch Vegetable']];
    const have = new Set(staffMain.eligibleItems.map(it => it.id));
    for (const [sec, cat, group] of sharedFrom) {
      const slot = state.builder.sections[sec]?.slots.find(sl => sl.categoryCode === cat);
      for (const it of slot?.eligibleItems || []) {
        if (have.has(it.id)) continue;
        have.add(it.id);
        staffMain.eligibleItems.push({ ...it, group });
      }
    }
  }

  renderBuilderGrid();
  updateBuilderCompleteness();
  statusEl.textContent = 'Grids built for all 5 sections.';
}

function renderBuilderGrid() {
  const container = document.getElementById('bm-grid');
  const code = state.builder.activeSection;
  const section = state.builder.sections[code];

  if (!section) {
    container.innerHTML = `<div class="empty-state">Set a date range above and click "Build Grids" to start.</div>`;
    return;
  }

  const catName = {};
  state.categories.forEach(c => { catName[c.code] = c.name; });

  container.innerHTML = `
    <div style="margin-bottom:14px;">
      <button class="primary" id="bm-fill-btn">Auto-Fill This Section</button>
    </div>
    <div id="bm-days-container"></div>
  `;
  document.getElementById('bm-fill-btn').addEventListener('click', () => fillBuilderSuggestions(code));

  const daysContainer = document.getElementById('bm-days-container');
  daysContainer.innerHTML = state.builder.days.map(day => renderBuilderDayTable(code, day, section, catName)).join('');

  daysContainer.querySelectorAll('select[data-key]').forEach(sel => {
    sel.addEventListener('change', () => {
      state.builder.sections[code].selections[sel.dataset.key] = sel.value;
      if (code === BUILDER_SHARED_SNACKS.source) syncBuilderSharedSnacks();
      // Refresh this cell's "breaks today's rotation" note in place.
      const note = sel.parentElement.querySelector('.builder-style-note-slot');
      if (note) {
        const slot = section.slots.find(sl => sl.categoryCode === sel.dataset.cat);
        const item = slot?.eligibleItems.find(it => String(it.id) === sel.value);
        note.innerHTML = sel.value ? builderStyleNoteHtml(item, sel.dataset.style || null) : '';
      }
      updateBuilderCompleteness();
    });
  });
}

// A slot's <option>s; items tagged with a `group` (Staff Main's shared school dishes) go under
// their own <optgroup> after the slot's own category. requiredStyle (snack cells): today's style
// first, then the other style, labelled as breaking the rotation, then dishes without a style.
function builderOptionsHtml(items, current, requiredStyle = null) {
  const opt = it => `<option value="${it.id}" ${String(it.id) === current ? 'selected' : ''}>${it.name}</option>`;
  if (requiredStyle) {
    const other = requiredStyle === 'PASTRY' ? 'COLD_KITCHEN' : 'PASTRY';
    const groupHtml = (label, list) => (list.length ? `<optgroup label="${label}">${list.map(opt).join('')}</optgroup>` : '');
    return groupHtml(`${BUILDER_STYLE_LABEL[requiredStyle]} — today's style`, items.filter(it => it.am_snack_style === requiredStyle))
      + groupHtml(`${BUILDER_STYLE_LABEL[other]} — breaks today's rotation`, items.filter(it => it.am_snack_style === other))
      + groupHtml('No style set', items.filter(it => !BUILDER_STYLE_LABEL[it.am_snack_style]));
  }
  const own = items.filter(it => !it.group);
  const groups = [...new Set(items.filter(it => it.group).map(it => it.group))];
  if (!groups.length) return own.map(opt).join('');
  return `<optgroup label="Staff Main">${own.map(opt).join('')}</optgroup>`
    + groups.map(g => `<optgroup label="${g}">${items.filter(it => it.group === g).map(opt).join('')}</optgroup>`).join('');
}

// Renders one day as a vertical table (category column on the left, item rows stacked
// top-to-bottom underneath), matching the row-per-item layout of the Excel blank menu
// template (see buildSchoolTemplateSheet in lib/export.js) instead of a horizontal card grid.
function renderBuilderDayTable(code, day, section, catName) {
  const rows = [];
  const dayIndex = state.builder.days.findIndex(d => d.date === day.date) + 1;
  section.slots.forEach(slot => {
    const label = catName[slot.categoryCode] || slot.categoryCode.replace(/_/g, ' ');
    const requiredStyle = builderSnackStyle(dayIndex, slot.categoryCode, code);
    if (slot.sharedFrom) {
      // KG-LP's AM / PM Snack: Daycare's dish, read-only here.
      const src = state.builder.sections[slot.sharedFrom];
      const srcSlot = src?.slots.find(sl => sl.categoryCode === slot.categoryCode);
      const id = src?.selections[builderSelectionKey(day.date, slot.categoryCode, 0)] || '';
      const item = srcSlot?.eligibleItems.find(it => String(it.id) === id);
      rows.push({
        label,
        cellHtml: item
          ? `<span class="item-name">${item.name}</span> <span class="ai-shared" title="Shared dish: choose it on the Daycare tab and it updates here.">from Daycare</span>${builderStyleNoteHtml(item, requiredStyle)}`
          : `<span class="ai-shared">Shared with Daycare — choose it on the Daycare tab</span>`,
      });
    } else if (slot.isDaily) {
      slot.dailyItems.forEach(it => {
        rows.push({ label, cellHtml: `<span class="item-name">${it.name}</span>` });
      });
    } else if (slot.fixedDaily) {
      rows.push({ label, cellHtml: `<span class="field-warning">No fixed dish set — add one in the Dish Catalog with "Repeats every day automatically" ticked.</span>` });
    } else {
      for (let idx = 0; idx < slot.count; idx++) {
        const key = builderSelectionKey(day.date, slot.categoryCode, idx);
        const current = state.builder.sections[code].selections[key] || '';
        const item = requiredStyle && current ? slot.eligibleItems.find(it => String(it.id) === current) : null;
        rows.push({
          label,
          cellHtml: `
            <select class="builder-select" data-key="${key}" data-cat="${slot.categoryCode}" ${requiredStyle ? `data-style="${requiredStyle}" title="${BUILDER_STYLE_LABEL[requiredStyle]} today (Pastry / Cold Kitchen rotation)"` : ''}>
              <option value="">— choose —</option>
              ${builderOptionsHtml(slot.eligibleItems, current, requiredStyle)}
            </select>${requiredStyle ? `<div class="builder-style-note-slot">${builderStyleNoteHtml(item, requiredStyle)}</div>` : ''}`,
        });
      }
    }
  });

  const bodyRows = [];
  for (let i = 0; i < rows.length; i++) {
    const isFirstOfGroup = i === 0 || rows[i].label !== rows[i - 1].label;
    let span = 1;
    if (isFirstOfGroup) {
      while (rows[i + span] && rows[i + span].label === rows[i].label) span++;
    }
    bodyRows.push(`
      <tr>
        ${isFirstOfGroup ? `<td class="cat-cell" rowspan="${span}">${rows[i].label}</td>` : ''}
        <td class="item-cell">${rows[i].cellHtml}</td>
      </tr>
    `);
  }

  return `
    <div class="day-table-wrap">
      <table class="day-table">
        <thead><tr><th colspan="2"><span>${day.weekday}</span><span class="date">${day.date}</span></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
    </div>
  `;
}

async function fillBuilderSuggestions(code) {
  const { label, startDate, numWeekdays } = state.builder;
  const statusEl = document.getElementById('bm-status');
  statusEl.textContent = `Auto-filling ${currentBuilderSectionName(code)}…`;

  // The other sections' picks in this grid (not saved anywhere yet) stand in for their saved menus, so
  // Auto-Fill copies the shared dishes from here: KG-LP's snacks from Daycare, MS-UP's lunch from
  // KG-LP (or the reverse), Staff's shares from the school tabs.
  syncBuilderSharedSnacks();
  const gridPicks = {};
  for (const [sec, { slots, selections }] of Object.entries(state.builder.sections)) {
    if (sec === code) continue;
    const byDate = {};
    for (const day of state.builder.days) {
      for (const slot of slots) {
        // KG-LP's snack cells only mirror Daycare's: never feed them back when filling Daycare.
        if (code === BUILDER_SHARED_SNACKS.source && sec === BUILDER_SHARED_SNACKS.copy && BUILDER_SHARED_SNACKS.categories.includes(slot.categoryCode)) continue;
        const chosen = slot.isDaily ? slot.dailyItems.map(it => it.id)
          : Array.from({ length: slot.count }, (_, idx) => selections[builderSelectionKey(day.date, slot.categoryCode, idx)]).filter(Boolean).map(Number);
        if (chosen.length) ((byDate[day.date] = byDate[day.date] || {})[slot.categoryCode] = chosen);
      }
    }
    if (Object.keys(byDate).length) gridPicks[sec] = byDate;
  }
  const { resultDays, warnings } = await window.api.builderFillSuggestions({ sectionCode: code, startDate, numWeekdays, gridPicks });
  const section = state.builder.sections[code];

  for (const day of resultDays) {
    const byCategory = {};
    for (const item of day.items) {
      byCategory[item.category] = byCategory[item.category] || [];
      byCategory[item.category].push(item);
    }
    for (const catCode in byCategory) {
      // A suggestion can come from outside this slot's own eligible-items pool (e.g. Staff
      // Main Dish forcing in that day's KG-LP/MS-UP Lunch Main picks, which are tagged
      // LUNCH_MAIN, not STAFF_MAIN). Without an <option> for it, the <select> silently falls
      // back to the blank placeholder even though the real selection is set underneath --
      // so patch the slot's eligibleItems list with a synthetic entry for anything missing.
      const slot = section.slots.find(s => s.categoryCode === catCode);
      byCategory[catCode].forEach((item, idx) => {
        const key = builderSelectionKey(day.date, catCode, idx);
        if (key in section.selections) section.selections[key] = String(item.id);
        if (slot && !slot.eligibleItems.find(it => it.id === item.id)) {
          slot.eligibleItems.push({ id: item.id, name: item.name, am_snack_style: item.am_snack_style ?? null });
        }
      });
    }
  }
  syncBuilderSharedSnacks();

  renderBuilderGrid();
  updateBuilderCompleteness();
  statusEl.textContent = warnings.length
    ? `Auto-filled ${currentBuilderSectionName(code)} — ${warnings.length} repeat-rule warning(s) (pool too small for full 4-week variety).`
    : `Auto-filled ${currentBuilderSectionName(code)}.`;
}

function currentBuilderSectionName(code) {
  return state.sections.find(s => s.code === code)?.name || code;
}

function updateBuilderCompleteness() {
  const btn = document.getElementById('bm-export-btn');
  const statusEl = document.getElementById('bm-status');
  if (!btn) return;

  syncBuilderSharedSnacks();
  const allCodes = state.sections.map(s => s.code);
  const builtCodes = Object.keys(state.builder.sections);
  const missing = allCodes.filter(c => !builtCodes.includes(c));

  let emptyCount = 0;
  for (const code of builtCodes) {
    emptyCount += Object.values(state.builder.sections[code].selections).filter(v => !v).length;
  }

  btn.disabled = missing.length > 0 || emptyCount > 0;

  if (missing.length > 0) {
    statusEl.textContent = `Not built yet: ${missing.map(currentBuilderSectionName).join(', ')}. Click "Build Grids" first.`;
  } else if (emptyCount > 0) {
    statusEl.textContent = `${emptyCount} slot(s) still empty across all sections — fill them in, or use "Auto-Fill This Section" on each tab.`;
  } else {
    statusEl.textContent = 'All sections complete — ready to export.';
  }
}

async function exportBuilderMenu() {
  syncBuilderSharedSnacks();
  const { label, createdBy, startDate, days, sections } = state.builder;
  const statusEl = document.getElementById('bm-status');
  document.getElementById('bm-export-btn').disabled = true;
  statusEl.textContent = 'Saving and exporting…';

  // Build Menu's export saves all 5 sections too, but intentionally never sets a batch_id --
  // only Export All Sections' batch groups into one History entry (see save-manual-menu note
  // in main.js); these 5 saves stay individual, each tagged with its own section name.
  const menuIdsBySection = {};
  for (const code of Object.keys(sections)) {
    const { slots, selections } = sections[code];
    const payloadDays = days.map(day => {
      const items = [];
      for (const slot of slots) {
        if (slot.isDaily) {
          slot.dailyItems.forEach(it => items.push({ category: slot.categoryCode, id: it.id }));
        } else {
          for (let idx = 0; idx < slot.count; idx++) {
            const val = selections[builderSelectionKey(day.date, slot.categoryCode, idx)];
            if (val) items.push({ category: slot.categoryCode, id: parseInt(val, 10) });
          }
        }
      }
      return { date: day.date, weekday: day.weekday, items };
    });
    const { menuId } = await window.api.saveManualMenu({ sectionCode: code, label, createdBy: createdBy || null, startDate, days: payloadDays });
    menuIdsBySection[code] = menuId;
  }

  const result = await window.api.exportAllSectionsToExcel({ menuIdsBySection, label });
  if (result.success) {
    statusEl.textContent = `Exported to ${result.path}`;
  } else if (!result.cancelled) {
    statusEl.textContent = 'Export failed.';
  }
  updateBuilderCompleteness();
}

async function exportBuilderBlankTemplate() {
  const startDate = document.getElementById('bm-start').value;
  const endDate = document.getElementById('bm-end').value;
  if (!startDate || !endDate) return alert('Please choose a start and end date.');
  if (endDate < startDate) return alert('End date must be on or after the start date.');

  const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
  if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');

  const statusEl = document.getElementById('bm-status');
  statusEl.textContent = 'Exporting blank template…';
  const result = await window.api.exportBlankTemplate({ startDate, numWeekdays });
  if (result.success) statusEl.textContent = `Blank template exported to ${result.path}`;
  else if (!result.cancelled) statusEl.textContent = 'Template export failed.';
}

// ============================================================
// AI MENU GENERATOR VIEW
// The AI invents dishes for a date range, the normal menu rules schedule them into a DRAFT
// (main.js ai-menu-generate), and the chef reviews it here before anything reaches the Dish
// Catalog or History. Every change goes through main.js, which re-runs the nut/sesame, seafood and
// halal check (a hit blocks the change, no override) and the catalog duplicate check; menu rules
// are re-checked after each change but only warn. Shared dishes (MS-UP's Lunch Main / Starch,
// KG-LP's AM / PM Snack from Daycare, Staff's shared Main and Breakfast) are read-only copies:
// change the source and they follow.
// ============================================================
const AI_SECTIONS = ['DAYCARE', 'KG_LP', 'MS_UP', 'STAFF'];
const AI_SECTION_LABEL = { DAYCARE: 'Daycare', KG_LP: 'KG-LP', MS_UP: 'MS-UP', STAFF: 'Staff' };
// Mirrors AI_CATEGORIES in lib/aiMenu.js (the categories whose dishes the AI invents).
const AI_MENU_CATEGORIES = {
  DAYCARE: ['AM_SNACK', 'LUNCH_MAIN', 'LUNCH_SALAD', 'SOUP_APPETIZER', 'PM_SNACK'],
  KG_LP: ['AM_SNACK', 'LUNCH_MAIN', 'LUNCH_STARCH', 'SOUP_APPETIZER', 'PM_SNACK'],
  MS_UP: ['AM_SNACK', 'LUNCH_MAIN', 'LUNCH_VEGETABLE', 'LUNCH_STARCH', 'SOUP_APPETIZER', 'PM_SNACK'],
  STAFF: ['STAFF_BREAKFAST', 'STAFF_APPETIZER', 'STAFF_MAIN', 'STAFF_SWEETS', 'STAFF_LUNCHBOX'],
};
const AI_ATTR_OPTIONS = {
  sauce_type: [['RED', 'Red (tomato)'], ['WHITE', 'White (cream / cheese / yogurt)'], ['ASIAN', 'Asian (soy / teriyaki)'], ['GLAZED', 'Glazed (honey / BBQ)'], ['GRAVY', 'Gravy / stew'], ['DRY', 'Dry (grilled / roasted)']],
  carb_type: [['RICE', 'Rice'], ['PASTA', 'Pasta'], ['POTATO', 'Potato'], ['OTHER', 'Other grain / bread']],
  dish_concept: [['EGG', 'Egg'], ['PASTRY', 'Pastry'], ['SANDWICH', 'Sandwich / wrap'], ['CEREAL_DAIRY', 'Cereal / dairy'], ['CHEESE', 'Cheese'], ['OTHER', 'Other']],
  am_snack_style: [['PASTRY', 'Pastry'], ['COLD_KITCHEN', 'Cold Kitchen']],
};
const AI_ATTR_LABEL = { protein_code: 'Protein', sauce_type: 'Sauce style', carb_type: 'Starch type', dish_concept: 'Dish type', am_snack_style: 'Pastry / Cold Kitchen' };
// Which attributes each category's rules read (required ones are marked *); mirrors REQUIRED_ATTRS
// in lib/aiMenuGenerate.js.
const AI_CATEGORY_ATTRS = {
  AM_SNACK: { required: ['am_snack_style', 'dish_concept'], optional: ['protein_code'] },
  LUNCH_MAIN: { required: ['protein_code', 'sauce_type'], optional: [] },
  LUNCH_STARCH: { required: ['carb_type'], optional: [] },
  PM_SNACK: { required: ['am_snack_style'], optional: [] },
  STAFF_BREAKFAST: { required: ['dish_concept', 'am_snack_style'], optional: ['protein_code'] },
  STAFF_MAIN: { required: ['protein_code', 'carb_type'], optional: [] },
  STAFF_LUNCHBOX: { required: ['protein_code'], optional: [] },
};
const AI_RUN_STATUS = {
  generating: ['Generating…', 'daily'], draft: ['Needs review', 'unverified'], approving: ['Approving…', 'daily'],
  approved: ['Approved', 'chicken'], discarded: ['Discarded', 'daily'],
};

function aiEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function aiCategoryName(code) {
  return state.categories.find(c => c.code === code)?.name || code.replace(/_/g, ' ');
}

// Daycare's Lunch Main is one combined dish, so it also needs its starch type (mirrors the Daycare
// pool's requiredAttrs in lib/aiMenuGenerate.js).
function aiAttrsFor(category, sections = []) {
  const base = AI_CATEGORY_ATTRS[category] || { required: [], optional: ['protein_code'] };
  if (category === 'LUNCH_MAIN' && sections.includes('DAYCARE')) return { required: [...base.required, 'carb_type'], optional: base.optional };
  return base;
}

function renderAiMenuView(main) {
  return state.aiMenu.view === 'run' ? renderAiMenuRunView(main) : renderAiMenuListView(main);
}

// ---------- list + generate ----------

async function renderAiMenuListView(main) {
  main.classList.remove('build-mode');
  const f = state.aiMenu.form;
  main.innerHTML = `
    <div class="topbar">
      <div><h1>AI Menu Generator</h1><span class="page-description">The AI invents new dishes for the date range and the usual menu rules schedule them. Nothing reaches the Dish Catalog or History until you review and approve it.</span></div>
    </div>
    <div class="generate-controls">
      <div class="field"><label for="ai-label">Name</label><input id="ai-label" value="${aiEsc(f.label)}" placeholder="e.g. October AI menu" /></div>
      <div class="field"><label for="ai-created-by">Created by</label><input id="ai-created-by" value="${aiEsc(f.createdBy)}" /></div>
      <div class="field"><label for="ai-start">Start date</label><input id="ai-start" type="date" value="${aiEsc(f.startDate)}" /></div>
      <div class="field"><label for="ai-end">End date</label><input id="ai-end" type="date" value="${aiEsc(f.endDate)}" /></div>
      <button class="primary" id="ai-generate-btn" ${state.aiMenu.generating ? 'disabled' : ''}>${state.aiMenu.generating ? 'Generating…' : 'Generate AI Menu'}</button>
    </div>
    <div id="ai-day-count" class="day-count-hint" style="margin:-10px 0 10px;"></div>
    <div id="ai-progress" class="ai-progress" role="status" aria-live="polite">${aiEsc(state.aiMenu.progress)}</div>
    <h2 class="ai-subhead">Runs</h2>
    <div id="ai-runs"><div class="empty-state">Loading…</div></div>
  `;
  wireDateRangeFields('ai-start', 'ai-end', 'ai-day-count');
  for (const [id, key] of [['ai-label', 'label'], ['ai-created-by', 'createdBy'], ['ai-start', 'startDate'], ['ai-end', 'endDate']]) {
    document.getElementById(id).addEventListener('input', (e) => { state.aiMenu.form[key] = e.target.value; });
    document.getElementById(id).addEventListener('change', (e) => { state.aiMenu.form[key] = e.target.value; });
  }
  document.getElementById('ai-generate-btn').addEventListener('click', startAiMenuGeneration);

  const runs = await window.api.aiMenuListRuns();
  const el = document.getElementById('ai-runs');
  if (!el) return;
  if (!runs.length) {
    el.innerHTML = `<div class="empty-state"><div class="display">No AI menus yet</div>Choose a date range above and click "Generate AI Menu".</div>`;
    return;
  }
  el.innerHTML = `
    <div class="table-scroll"><table class="history-table ai-runs-table">
      <thead><tr><th>Name</th><th>Dates</th><th>School days</th><th>Status</th><th>Created by</th><th>Created</th><th></th></tr></thead>
      <tbody>${runs.map(r => {
        const [label, tone] = r.failed ? ['Failed', 'beef'] : r.interrupted ? ['Approval interrupted', 'beef'] : (AI_RUN_STATUS[r.status] || [r.status, 'daily']);
        const openable = ['draft', 'approved', 'approving', 'discarded'].includes(r.status);
        return `<tr data-run="${r.id}" class="${openable ? '' : 'ai-run-disabled'}">
          <td><strong>${aiEsc(r.label)}</strong></td>
          <td>${r.start_date} → ${r.end_date}</td>
          <td>${r.num_weekdays}</td>
          <td><span class="chip ${tone}">${label}</span></td>
          <td>${aiEsc(r.created_by || '—')}</td>
          <td>${r.created_at && !isNaN(new Date(r.created_at)) ? new Date(r.created_at).toLocaleString() : '—'}</td>
          <td>${r.failed || r.status === 'draft' ? `<button class="icon-btn danger" data-discard="${r.id}">Discard</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  el.querySelectorAll('tr[data-run]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-discard]') || tr.classList.contains('ai-run-disabled')) return;
      openAiMenuRun(Number(tr.dataset.run));
    });
  });
  el.querySelectorAll('[data-discard]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Discard this AI menu? Its draft dishes and picks stay in the database but it can no longer be edited or approved.')) return;
      try { await window.api.aiMenuDiscardRun(Number(btn.dataset.discard)); } catch (err) { alert(err.message); }
      renderView();
    });
  });
}

async function startAiMenuGeneration() {
  const f = state.aiMenu.form;
  if (!f.startDate || !f.endDate) return alert('Please choose a start and end date.');
  if (f.endDate < f.startDate) return alert('End date must be on or after the start date.');
  const numWeekdays = await window.api.getSchoolDayCount({ startDate: f.startDate, endDate: f.endDate });
  if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');

  state.aiMenu.generating = true;
  state.aiMenu.progress = 'Starting…';
  const setProgress = (message) => {
    state.aiMenu.progress = message;
    const el = document.getElementById('ai-progress');
    if (el) el.textContent = message;
  };
  const btn = document.getElementById('ai-generate-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  const unsubscribe = window.api.onAiMenuProgress(({ message }) => setProgress(message));
  try {
    const result = await window.api.aiMenuGenerate({
      label: f.label.trim(), startDate: f.startDate, endDate: f.endDate, createdBy: f.createdBy.trim() || null,
    });
    state.aiMenu.generating = false;
    state.aiMenu.progress = '';
    showToast(`AI menu ready: ${result.stats.dishes} dishes, ${result.warningCount} note(s) to review.`);
    if (state.currentView === 'aiMenu') openAiMenuRun(result.runId);
  } catch (err) {
    state.aiMenu.generating = false;
    setProgress(`Generation failed: ${err.message}`);
    if (state.currentView === 'aiMenu' && state.aiMenu.view === 'list') renderView();
  } finally {
    unsubscribe();
  }
}

function openAiMenuRun(runId) {
  state.aiMenu.view = 'run';
  state.aiMenu.runId = runId;
  state.aiMenu.data = null;
  if (!AI_SECTIONS.includes(state.aiMenu.tab) && !['dishes', 'warnings'].includes(state.aiMenu.tab)) state.aiMenu.tab = 'DAYCARE';
  renderView();
}

// ---------- one run ----------

async function reloadAiMenuRun({ keepScroll = true } = {}) {
  const scroller = document.querySelector('.build-scroll');
  const top = keepScroll && scroller ? scroller.scrollTop : 0;
  state.aiMenu.data = await window.api.aiMenuGetRun(state.aiMenu.runId);
  renderAiMenuRunContent();
  const again = document.querySelector('.build-scroll');
  if (again) again.scrollTop = top;
}

async function renderAiMenuRunView(main) {
  main.classList.add('build-mode');
  main.innerHTML = `
    <div class="build-scroll" id="ai-run-scroll"><div class="empty-state">Loading…</div></div>
    <div id="ai-run-tabs" class="builder-tabs" role="tablist" aria-label="AI menu sections"></div>`;
  state.aiMenu.data = await window.api.aiMenuGetRun(state.aiMenu.runId);
  renderAiMenuRunContent();
}

function aiDishFor(pick) {
  const d = state.aiMenu.data;
  if (pick.draft_dish_id) return { kind: 'draft', dish: d.dishes.find(x => x.id === pick.draft_dish_id) };
  if (pick.item_id) return { kind: 'catalog', item: d.catalogItems[pick.item_id] };
  return { kind: 'empty' };
}

function aiIsEditable() {
  return state.aiMenu.data?.run.status === 'draft';
}

function renderAiMenuRunContent() {
  const d = state.aiMenu.data;
  const scroll = document.getElementById('ai-run-scroll');
  const tabsEl = document.getElementById('ai-run-tabs');
  if (!scroll || !d) return;
  const { run } = d;
  const [statusLabel, statusTone] = AI_RUN_STATUS[run.status] || [run.status, 'daily'];
  const served = new Set(d.picks.filter(p => p.draft_dish_id).map(p => p.draft_dish_id));
  const newCount = d.dishes.filter(x => served.has(x.id) && x.resolution === 'new').length;
  const linkedCount = d.dishes.filter(x => served.has(x.id) && x.resolution === 'link').length;
  const approveBlockers = [];
  if (d.emptySlots) approveBlockers.push(`${d.emptySlots} empty slot(s)`);
  const sections = run.approve_progress?.sections || {};
  let actionBtn = '';
  if (run.status === 'draft') {
    actionBtn = `<button class="primary" id="ai-approve" ${approveBlockers.length ? 'disabled' : ''} title="${aiEsc(approveBlockers.length ? `Blocked: ${approveBlockers.join(', ')}` : 'Save this menu for real: new dishes join the Dish Catalog, and all five menus go to History')}">Approve</button>`;
  } else if (run.status === 'approving') {
    actionBtn = `<button class="primary" id="ai-resume" title="Finishes an approval that was interrupted part-way (nothing is done twice)">Resume approval</button>`;
  } else if (run.status === 'approved' && Object.keys(sections).length) {
    actionBtn = `<button class="primary" id="ai-export">Export workbook</button>`;
  }

  scroll.innerHTML = `
    <div class="topbar">
      <div>
        <button class="link-btn" id="ai-back">← All AI menus</button>
        <h1>${aiEsc(run.label)}</h1>
        <span class="page-description">${run.start_date} → ${run.end_date} · ${run.num_weekdays} school days · <span class="chip ${statusTone}">${statusLabel}</span></span>
      </div>
      <div class="action-toolbar">
        ${aiIsEditable() ? '<button class="secondary" id="ai-discard">Discard</button>' : ''}
        ${actionBtn}
      </div>
    </div>
    ${run.status === 'approved' ? `<div class="ai-approved-banner">Approved${run.approved_by ? ` by ${aiEsc(run.approved_by)}` : ''}${run.approved_at ? ` on ${aiEsc(new Date(run.approved_at).toLocaleString())}` : ''}. Its dishes are in the Dish Catalog (tagged AI-generated) and all five menus are in History as one "All Sections" entry.
      <div class="ai-calorie-status">${aiCalorieStatusHtml(run.approve_progress?.calories)}</div></div>` : ''}
    ${run.status === 'approving' ? `<div class="warning-banner">This menu is being approved${run.approved_by ? ` by ${aiEsc(run.approved_by)}` : ''}. If that was interrupted, "Resume approval" finishes it from where it stopped.</div>` : ''}
    <div class="ai-summary">
      <span><strong>${newCount}</strong> new AI dishes</span>
      <span><strong>${linkedCount}</strong> linked to existing catalog dishes</span>
      <span class="${d.emptySlots ? 'ai-bad' : ''}"><strong>${d.emptySlots}</strong> empty slots</span>
      <button class="link-btn" data-go-tab="warnings"><strong>${d.notes.length}</strong> rule note(s) · <strong>${(run.warnings || []).length}</strong> generation note(s)</button>
      <span class="ai-summary-hint">CEO isn't part of the AI menu — it is generated the usual way when you approve.</span>
    </div>
    <div id="ai-tab-content"></div>`;

  tabsEl.innerHTML = [
    ...AI_SECTIONS.map(s => [s, AI_SECTION_LABEL[s]]),
    ['dishes', 'All dishes'],
    ['warnings', `Notes (${d.notes.length + (run.warnings || []).length})`],
  ].map(([key, label]) => `<button class="nav-btn ${state.aiMenu.tab === key ? 'active' : ''}" role="tab" aria-selected="${state.aiMenu.tab === key}" data-ai-tab="${key}">${aiEsc(label)}</button>`).join('');

  const go = (tab) => { state.aiMenu.tab = tab; renderAiMenuRunContent(); document.getElementById('ai-run-scroll').scrollTop = 0; };
  tabsEl.querySelectorAll('[data-ai-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.aiTab)));
  scroll.querySelectorAll('[data-go-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.goTab)));
  document.getElementById('ai-back').addEventListener('click', () => { state.aiMenu.view = 'list'; state.aiMenu.data = null; renderView(); });
  document.getElementById('ai-approve')?.addEventListener('click', () => openAiApproveModal(false));
  document.getElementById('ai-calories-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Estimating calories…';
    try { await window.api.aiMenuEstimateCalories({ runId: run.id }); } catch (err) { alert(err.message); }
    reloadAiMenuRun();
  });
  aiScheduleCaloriePoll(run);
  document.getElementById('ai-resume')?.addEventListener('click', () => openAiApproveModal(true));
  document.getElementById('ai-export')?.addEventListener('click', () => aiExportApproved(run));
  document.getElementById('ai-discard')?.addEventListener('click', async () => {
    if (!confirm('Discard this AI menu? It can no longer be edited or approved.')) return;
    try { await window.api.aiMenuDiscardRun(run.id); } catch (err) { return alert(err.message); }
    state.aiMenu.view = 'list'; renderView();
  });

  const content = document.getElementById('ai-tab-content');
  if (state.aiMenu.tab === 'dishes') renderAiDishesTab(content);
  else if (state.aiMenu.tab === 'warnings') renderAiNotesTab(content);
  else renderAiSectionTab(content, state.aiMenu.tab);
}

function aiDishBadges(dish) {
  const out = [];
  if (dish.resolution === 'link') out.push('<span class="chip daily" title="The same dish already exists in the Dish Catalog; that dish is used.">In catalog</span>');
  else out.push('<span class="chip ai-new">New</span>');
  if ((dish.safety_scan?.known_risk || []).length) out.push('<span class="chip ai-risk" title="A dish that is traditionally made with nuts or sesame; this kitchen makes it without them.">Made nut/sesame-free (kitchen standard)</span>');
  if (dish.edited) out.push('<span class="chip ai-edited">Edited</span>');
  if (dish.cuisine) out.push(`<span class="chip ai-cuisine" title="Made for National Day">${aiEsc(dish.cuisine)}</span>`);
  return out.join(' ');
}

function aiAttrChips(a) {
  if (!a) return '';
  const out = [];
  const pc = (a.protein_code || '').toLowerCase();
  if (pc) out.push(proteinChip(a.protein_code, pc === 'vegetarian' ? 'VEG' : a.protein_code));
  if (a.am_snack_style) out.push(`<span class="chip ${a.am_snack_style === 'PASTRY' ? 'pastry' : 'cold-kitchen'}">${a.am_snack_style === 'PASTRY' ? 'Pastry' : 'Cold Kitchen'}</span>`);
  return out.join(' ');
}

function renderAiSectionTab(container, section) {
  const d = state.aiMenu.data;
  const days = [...new Map(d.picks.filter(p => p.section_code === section).map(p => [p.menu_date, p.weekday])).entries()].sort();
  const notesByDate = new Map();
  for (const n of d.notes.filter(n => n.section === section)) {
    if (!notesByDate.has(n.date)) notesByDate.set(n.date, []);
    notesByDate.get(n.date).push(n);
  }
  const editable = aiIsEditable();

  container.innerHTML = days.map(([date, weekday]) => {
    const picks = d.picks.filter(p => p.section_code === section && p.menu_date === date);
    // Same row order as SECTION_SLOTS (the order the picks were saved in).
    const order = [...new Set(picks.map(p => p.category_code))];
    const rows = [];
    for (const cat of order) {
      picks.filter(p => p.category_code === cat).sort((a, b) => a.slot_index - b.slot_index).forEach(p => rows.push({ cat, p }));
    }
    const body = rows.map((r, i) => {
      const first = i === 0 || rows[i - 1].cat !== r.cat;
      const span = first ? rows.filter(x => x.cat === r.cat).length : 0;
      const info = aiDishFor(r.p);
      const aiCat = AI_MENU_CATEGORIES[section].includes(r.cat) || !!r.p.source_section_code;
      let cell;
      if (info.kind === 'empty') {
        cell = `<span class="ai-empty">Empty — choose a dish</span>`;
      } else if (info.kind === 'draft' && info.dish) {
        cell = `<span class="item-name">${aiEsc(info.dish.name)}</span> ${aiAttrChips(info.dish)} ${aiDishBadges(info.dish)}`;
      } else {
        cell = `<span class="item-name">${aiEsc(info.item?.name || 'Unknown catalog dish')}</span> ${aiCat ? aiAttrChips(info.item) + ' <span class="chip daily">Catalog</span>' : ''}`;
      }
      let actions = '';
      if (r.p.source_section_code) {
        actions = `<span class="ai-shared" title="Shared dish: change it in ${AI_SECTION_LABEL[r.p.source_section_code]} and it updates here.">from ${AI_SECTION_LABEL[r.p.source_section_code]}</span>`;
      } else if (editable) {
        actions = `<button class="icon-btn" data-replace="${r.p.id}">${info.kind === 'empty' ? 'Choose' : 'Replace'}</button>`
          + (info.kind === 'draft' && info.dish ? ` <button class="icon-btn" data-edit-dish="${info.dish.id}">Edit</button>` : '');
      }
      return `<tr>${first ? `<td class="cat-cell" rowspan="${span}">${aiEsc(aiCategoryName(r.cat))}</td>` : ''}
        <td class="item-cell"><div class="ai-cell"><div>${cell}</div><div class="ai-cell-actions">${actions}</div></div></td></tr>`;
    }).join('');
    const dayNotes = notesByDate.get(date) || [];
    return `<div class="day-table-wrap">
      <table class="day-table">
        <thead><tr><th colspan="2"><span>${weekday}</span><span class="date">${date}</span>${d.themes?.[date] ? `<span class="ai-national-day">National Day · ${aiEsc(d.themes[date])}</span>` : ''}${dayNotes.length ? `<span class="ai-note-count">${dayNotes.length} note${dayNotes.length > 1 ? 's' : ''}</span>` : ''}</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${dayNotes.length ? `<ul class="ai-day-notes">${dayNotes.map(n => `<li>${aiEsc(aiCategoryName(n.category))}: ${aiEsc(n.message)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('') || '<div class="empty-state">No days in this section.</div>';

  container.querySelectorAll('[data-replace]').forEach(b => b.addEventListener('click', () => {
    openAiReplaceModal(d.picks.find(p => p.id === Number(b.dataset.replace)));
  }));
  container.querySelectorAll('[data-edit-dish]').forEach(b => b.addEventListener('click', () => {
    openAiDishModal(d.dishes.find(x => x.id === Number(b.dataset.editDish)));
  }));
}

function renderAiDishesTab(container) {
  const d = state.aiMenu.data;
  const servedCount = new Map();
  for (const p of d.picks) if (p.draft_dish_id) servedCount.set(p.draft_dish_id, (servedCount.get(p.draft_dish_id) || 0) + 1);
  const cats = [...new Set(d.dishes.map(x => x.category_code))];
  const filter = state.aiMenu.dishFilter;
  container.innerHTML = `
    <div class="ai-dish-toolbar">
      <input id="ai-dish-search" type="search" placeholder="Search dishes or ingredients" value="${aiEsc(filter.q)}" aria-label="Search dishes" />
      <select id="ai-dish-cat" aria-label="Category"><option value="">All categories</option>${cats.map(c => `<option value="${c}" ${filter.cat === c ? 'selected' : ''}>${aiEsc(aiCategoryName(c))}</option>`).join('')}</select>
      <label><input type="checkbox" id="ai-dish-served" ${filter.servedOnly ? 'checked' : ''} /> Only dishes on the menu</label>
    </div>
    <div class="table-scroll"><table class="history-table ai-dish-table">
      <thead><tr><th>Dish</th><th>Category</th><th>Sections</th><th>Served</th><th>Key ingredients</th><th></th></tr></thead>
      <tbody id="ai-dish-rows"></tbody>
    </table></div>`;

  const draw = () => {
    const q = filter.q.trim().toLowerCase();
    const rows = d.dishes.filter(x => (!filter.cat || x.category_code === filter.cat)
      && (!filter.servedOnly || servedCount.get(x.id))
      && (!q || x.name.toLowerCase().includes(q) || x.key_ingredients.join(' ').toLowerCase().includes(q)));
    document.getElementById('ai-dish-rows').innerHTML = rows.map(x => `
      <tr class="${servedCount.get(x.id) ? '' : 'ai-unserved'}">
        <td><strong>${aiEsc(x.name)}</strong><div>${aiAttrChips(x)} ${aiDishBadges(x)}</div></td>
        <td>${aiEsc(aiCategoryName(x.category_code))}</td>
        <td>${x.section_codes.map(s => AI_SECTION_LABEL[s] || s).join(', ')}</td>
        <td>${servedCount.get(x.id) || '<span class="ai-muted">not on the menu</span>'}</td>
        <td class="ai-ingredients">${aiEsc(x.key_ingredients.join(', '))}</td>
        <td>${aiIsEditable() ? `<button class="icon-btn" data-edit-dish="${x.id}">Edit</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="ai-muted">No dishes match.</td></tr>';
    document.querySelectorAll('#ai-dish-rows [data-edit-dish]').forEach(b => b.addEventListener('click', () => {
      openAiDishModal(d.dishes.find(x => x.id === Number(b.dataset.editDish)));
    }));
  };
  document.getElementById('ai-dish-search').addEventListener('input', (e) => { filter.q = e.target.value; draw(); });
  document.getElementById('ai-dish-cat').addEventListener('change', (e) => { filter.cat = e.target.value; draw(); });
  document.getElementById('ai-dish-served').addEventListener('change', (e) => { filter.servedOnly = e.target.checked; draw(); });
  draw();
}

function renderAiNotesTab(container) {
  const d = state.aiMenu.data;
  const gen = d.run.warnings || [];
  const safety = gen.filter(w => w.kind === 'safety');
  const other = gen.filter(w => w.kind !== 'safety');
  const bySection = AI_SECTIONS.map(s => [s, d.notes.filter(n => n.section === s)]).filter(([, list]) => list.length);
  container.innerHTML = `
    <h2 class="ai-subhead">Menu rules (${d.notes.length})</h2>
    <p class="ai-muted">Re-checked after every change. These are warnings — the menu can still be approved.</p>
    ${bySection.length ? bySection.map(([s, list]) => `
      <h3 class="ai-subsubhead">${AI_SECTION_LABEL[s]}</h3>
      <ul class="ai-note-list">${list.map(n => `<li><span class="ai-note-date">${n.date}</span> ${aiEsc(aiCategoryName(n.category))}: ${aiEsc(n.message)}</li>`).join('')}</ul>`).join('')
      : '<div class="empty-state">Every day follows the menu rules.</div>'}
    <h2 class="ai-subhead">Rejected by the safety check at generation (${safety.length})</h2>
    <p class="ai-muted">These AI dishes were never added to the menu: they matched the nut / sesame, seafood (student sections) or halal check.</p>
    ${safety.length ? `<ul class="ai-note-list">${safety.map(w => `<li><strong>${aiEsc(w.name)}</strong> (${aiEsc(aiCategoryName(w.category))}, ${(w.sections || []).map(s => AI_SECTION_LABEL[s] || s).join(' + ')}): ${aiEsc(w.reason)}</li>`).join('')}</ul>` : '<div class="empty-state">None.</div>'}
    <h2 class="ai-subhead">Other generation notes (${other.length})</h2>
    ${other.length ? `<ul class="ai-note-list">${other.map(w => `<li>${aiEsc(w.message || (w.kind === 'duplicate_retired' ? `"${w.name}" matched the retired catalog dish "${w.matched_name}" and was dropped` : w.name || w.kind))}</li>`).join('')}</ul>` : '<div class="empty-state">None.</div>'}`;
}

// ---------- modals ----------

function aiOpenModal(html, { wide = false } = {}) {
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ai-modal ${wide ? 'ai-modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); previousFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal').setAttribute('aria-labelledby', 'ai-modal-title');
  setTimeout(() => overlay.querySelector('input, select, textarea, button')?.focus(), 0);
  return { overlay, close };
}

// The message box lives in the modal's pinned action bar, so it is always on screen.
function aiShowBlocked(el, blocked) {
  el.innerHTML = aiBlockedHtml(blocked);
}

function aiBlockedHtml(blocked) {
  return `<div class="ai-blocked" role="alert"><strong>Not saved.</strong> ${aiEsc(blocked.reason)}</div>`;
}

function aiAttrFields(category, values, prefix, sections) {
  const { required, optional } = aiAttrsFor(category, sections);
  return [...required, ...optional].map(attr => {
    const opts = attr === 'protein_code'
      ? state.proteinTypes.map(p => [p.code, p.name])
      : AI_ATTR_OPTIONS[attr];
    const req = required.includes(attr);
    return `<div class="field"><label for="${prefix}-${attr}">${AI_ATTR_LABEL[attr]}${req ? ' *' : ''}</label>
      <select id="${prefix}-${attr}" data-attr="${attr}">
        <option value="">${req ? '— choose —' : '— none —'}</option>
        ${opts.map(([code, name]) => `<option value="${code}" ${values?.[attr] === code ? 'selected' : ''}>${aiEsc(name)}</option>`).join('')}
      </select></div>`;
  }).join('');
}

function aiReadDishForm(root) {
  const fields = {
    name: root.querySelector('[data-f="name"]').value.trim(),
    description: root.querySelector('[data-f="description"]').value.trim(),
    key_ingredients: root.querySelector('[data-f="key_ingredients"]').value.split(/\n|,/).map(s => s.trim()).filter(Boolean),
  };
  root.querySelectorAll('select[data-attr]').forEach(sel => { fields[sel.dataset.attr] = sel.value || null; });
  return fields;
}

function aiDishFormHtml(category, dish, prefix, sections = dish?.section_codes || []) {
  return `
    <div class="field"><label for="${prefix}-name">Dish name *</label><input id="${prefix}-name" data-f="name" value="${aiEsc(dish?.name || '')}" /></div>
    <div class="field"><label for="${prefix}-desc">Description</label><textarea id="${prefix}-desc" data-f="description" rows="2">${aiEsc(dish?.description || '')}</textarea></div>
    <div class="field"><label for="${prefix}-ing">Key ingredients * (one per line)</label><textarea id="${prefix}-ing" data-f="key_ingredients" rows="4">${aiEsc((dish?.key_ingredients || []).join('\n'))}</textarea></div>
    <div class="ai-attr-grid">${aiAttrFields(category, dish, prefix, sections)}</div>`;
}

function openAiDishModal(dish) {
  if (!dish) return;
  const d = state.aiMenu.data;
  const servedIn = d.picks.filter(p => p.draft_dish_id === dish.id);
  const linkedItem = dish.dup_match_item_id ? d.catalogItems[dish.dup_match_item_id] : null;
  const { overlay, close } = aiOpenModal(`
    <h2 id="ai-modal-title">Edit dish</h2>
    <p class="ai-muted">${aiEsc(aiCategoryName(dish.category_code))} · served ${servedIn.length} time(s) · ${dish.section_codes.map(s => AI_SECTION_LABEL[s] || s).join(', ')}. Changes apply everywhere this dish is served.</p>
    ${dish.resolution === 'link' ? `<div class="warning-banner">This is the existing catalog dish "${aiEsc(linkedItem?.name || dish.name)}" — the catalog version is served as it is. Rename it to make it a new dish instead.</div>` : ''}
    <div id="ai-dish-form">${aiDishFormHtml(dish.category_code, dish, 'ai-ed')}</div>
    <div class="actions"><div id="ai-dish-error" class="ai-action-msg"></div><button class="secondary" id="ai-ed-cancel">Cancel</button><button class="primary" id="ai-ed-save">Save</button></div>`);
  overlay.querySelector('#ai-ed-cancel').addEventListener('click', close);
  overlay.querySelector('#ai-ed-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#ai-ed-save');
    btn.disabled = true;
    try {
      const res = await window.api.aiMenuUpdateDish({ runId: state.aiMenu.runId, dishId: dish.id, fields: aiReadDishForm(overlay.querySelector('#ai-dish-form')) });
      if (!res.ok) { aiShowBlocked(overlay.querySelector('#ai-dish-error'), res.blocked); btn.disabled = false; return; }
      close();
      showToast(res.linked ? `Saved — "${res.dish.name}" is already in the Dish Catalog, so that dish is used.` : res.unlinked ? 'Saved as a new dish (no longer the catalog dish).' : 'Dish saved.');
      await reloadAiMenuRun();
    } catch (err) {
      aiShowBlocked(overlay.querySelector('#ai-dish-error'), { reason: err.message });
      btn.disabled = false;
    }
  });
}

// The post-Approve calorie step's status (approve_progress.calories), written by main.js.
function aiCalorieStatusHtml(c) {
  const btn = (label) => `<button class="link-btn" id="ai-calories-btn">${label}</button>`;
  if (!c) return `Calories: not estimated yet for this run's new dishes. ${btn('Estimate calories')}`;
  if (c.status === 'running') return 'Estimating calories for this run\u2019s new dishes in the background…';
  if (c.status === 'failed') return `Calorie estimate failed: ${aiEsc(c.error || 'unknown error')}. The approval is unaffected. ${btn('Try again')}`;
  const extra = [c.flagged ? `${c.flagged} flagged unverified` : '', c.stillMissing ? `${c.stillMissing} still without a value` : ''].filter(Boolean).join(', ');
  return `${c.estimated} of ${c.dishes} new dish(es) have calories${extra ? ` (${extra})` : ''}.${c.stillMissing ? ` ${btn('Try the rest again')}` : ''}`;
}

// While the background calorie step runs, re-check every few seconds (only while this run is on screen).
let aiCaloriePollTimer = null;
function aiScheduleCaloriePoll(run) {
  clearTimeout(aiCaloriePollTimer);
  if (run.status !== 'approved' || run.approve_progress?.calories?.status !== 'running') return;
  aiCaloriePollTimer = setTimeout(() => {
    if (state.currentView === 'aiMenu' && state.aiMenu.view === 'run' && state.aiMenu.runId === run.id) reloadAiMenuRun();
  }, 5000);
}

async function aiExportApproved(run) {
  try {
    const res = await window.api.exportAllSectionsToExcel({ menuIdsBySection: run.approve_progress?.sections || {}, label: run.label });
    if (res?.success) showToast(`Exported to ${res.path}`);
  } catch (err) { alert(err.message); }
}

// The permanent step: confirm what will happen, run it with progress, then show the outcome.
function openAiApproveModal(resume) {
  const d = state.aiMenu.data;
  const servedIds = new Set(d.picks.filter(p => p.draft_dish_id).map(p => p.draft_dish_id));
  const served = d.dishes.filter(x => servedIds.has(x.id));
  const toCreate = served.filter(x => x.resolution === 'new' && !x.resolved_item_id).length;
  const toLink = served.filter(x => x.resolution === 'link' && !x.resolved_item_id).length;
  const { overlay, close } = aiOpenModal(`
    <h2 id="ai-modal-title">${resume ? 'Resume approval' : 'Approve this menu'}</h2>
    <div id="ai-approve-body">
      <p>${resume ? 'This finishes an approval that stopped part-way. Steps already done are skipped, so nothing is created or saved twice.' : 'This makes the menu permanent:'}</p>
      <ul class="ai-note-list">
        <li><strong>${toCreate}</strong> new dish${toCreate === 1 ? '' : 'es'} added to the Dish Catalog, tagged AI-generated</li>
        <li><strong>${toLink}</strong> dish${toLink === 1 ? '' : 'es'} use${toLink === 1 ? 's' : ''} the existing catalog dish of the same name</li>
        <li>Daycare, KG-LP, MS-UP and Staff saved to History as one "All Sections" entry, with CEO generated now by the usual engine</li>
      </ul>
      <p class="ai-muted">Every dish is safety-checked again first; anything that fails stops the approval before anything is saved.${d.notes.length ? ` ${d.notes.length} menu rule note(s) remain — they don't block approval.` : ''}</p>
      ${resume ? '' : '<label class="ai-confirm"><input type="checkbox" id="ai-approve-ok" /> I have reviewed this menu and want to save it permanently</label>'}
      <div id="ai-approve-progress" class="ai-progress" role="status" aria-live="polite"></div>
    </div>
    <div class="actions"><div id="ai-approve-error" class="ai-action-msg"></div><button class="secondary" id="ai-ap-cancel">Cancel</button><button class="primary" id="ai-ap-go" ${resume ? '' : 'disabled'}>${resume ? 'Resume' : 'Approve'}</button></div>`);
  const go = overlay.querySelector('#ai-ap-go');
  const cancel = overlay.querySelector('#ai-ap-cancel');
  cancel.addEventListener('click', close);
  overlay.querySelector('#ai-approve-ok')?.addEventListener('change', (e) => { go.disabled = !e.target.checked; });
  go.addEventListener('click', async () => {
    go.disabled = true; cancel.disabled = true;
    const progressEl = overlay.querySelector('#ai-approve-progress');
    const unsubscribe = window.api.onAiMenuProgress(({ message }) => { progressEl.textContent = message; });
    try {
      const res = await window.api.aiMenuApprove({ runId: state.aiMenu.runId });
      const body = overlay.querySelector('#ai-approve-body');
      if (res.ok) {
        body.innerHTML = `<p><strong>Approved.</strong> ${res.created ?? 0} new dish(es) added to the Dish Catalog, ${res.linked ?? 0} linked to existing ones${res.portionsAdded ? `, ${res.portionsAdded} section portion(s) added` : ''}. All five menus are in History.</p>
          <p class="ai-muted">Calories for the new dishes are being estimated in the background now; the approved run shows when they're done.</p>
          ${(res.ceoWarnings || []).length ? `<p class="ai-muted">CEO menu notes: ${res.ceoWarnings.map(aiEsc).join('; ')}</p>` : ''}`;
        overlay.querySelector('.actions').innerHTML = `<button class="secondary" id="ai-ap-close">Close</button><button class="primary" id="ai-ap-export">Export workbook</button>`;
        overlay.querySelector('#ai-ap-close').addEventListener('click', () => { close(); reloadAiMenuRun(); });
        overlay.querySelector('#ai-ap-export').addEventListener('click', async () => {
          await aiExportApproved({ label: d.run.label, approve_progress: { sections: res.menuIdsBySection } });
        });
      } else {
        const b = res.blocked;
        body.innerHTML = `<p><strong>Not approved${res.handedBack ? ' — the menu is a draft again' : ''}.</strong> Nothing permanent was written. Fix these first:</p>
          <ul class="ai-note-list">
            ${b.emptySlots ? `<li>${b.emptySlots} empty slot(s)</li>` : ''}
            ${b.safety.map(x => `<li><strong>${aiEsc(x.name)}</strong> (${aiEsc(aiCategoryName(x.category))}): ${aiEsc(x.reason)}</li>`).join('')}
            ${b.retired.map(x => `<li><strong>${aiEsc(x.name)}</strong> now matches the retired catalog dish "${aiEsc(x.matched)}" — rename it or reactivate that dish</li>`).join('')}
          </ul>`;
        overlay.querySelector('.actions').innerHTML = `<button class="primary" id="ai-ap-close">Close</button>`;
        overlay.querySelector('#ai-ap-close').addEventListener('click', () => { close(); reloadAiMenuRun(); });
      }
    } catch (err) {
      aiShowBlocked(overlay.querySelector('#ai-approve-error'), { reason: `${err.message} If it stopped part-way, "Resume approval" finishes it.` });
      cancel.disabled = false;
      cancel.textContent = 'Close';
      cancel.onclick = () => { close(); reloadAiMenuRun(); };
    } finally {
      unsubscribe();
    }
  });
}

function aiPropagationNote(pick) {
  if (pick.section_code === 'KG_LP' && ['LUNCH_MAIN', 'LUNCH_STARCH'].includes(pick.category_code)) {
    return `Also changes MS-UP (identical ${pick.category_code === 'LUNCH_MAIN' ? 'Lunch Main' : 'Lunch Starch'}) and Staff Main.`;
  }
  if (pick.section_code === 'MS_UP' && pick.category_code === 'LUNCH_VEGETABLE') return 'Also changes Staff Main (it carries MS-UP’s Lunch Vegetable).';
  if (pick.category_code === 'AM_SNACK') return 'Also changes Staff Breakfast (it carries every school AM Snack).';
  return '';
}

async function openAiReplaceModal(pick) {
  if (!pick) return;
  const info = aiDishFor(pick);
  const currentName = info.kind === 'draft' ? info.dish?.name : info.kind === 'catalog' ? info.item?.name : null;
  const isAiCategory = AI_MENU_CATEGORIES[pick.section_code].includes(pick.category_code);
  // Categories the AI doesn't handle (Milk, Fruit Bar, Staff Salad...) stay catalog-only.
  const tabs = isAiCategory
    ? [['unused', 'Unused AI dishes'], ['catalog', 'Dish Catalog'], ['ask', 'Ask AI'], ['write', 'Write a new dish']]
    : [['catalog', 'Dish Catalog']];
  const { overlay, close } = aiOpenModal(`
    <h2 id="ai-modal-title">${currentName ? 'Replace dish' : 'Choose a dish'}</h2>
    <p class="ai-muted">${AI_SECTION_LABEL[pick.section_code]} · ${aiEsc(aiCategoryName(pick.category_code))} · ${pick.weekday} ${pick.menu_date}${currentName ? ` · now: <strong>${aiEsc(currentName)}</strong>` : ''}</p>
    ${aiPropagationNote(pick) ? `<p class="ai-muted">${aiPropagationNote(pick)}</p>` : ''}
    <div class="mode-toggle" role="tablist" style="margin-bottom:14px;">${tabs.map(([k, l], i) => `<button type="button" role="tab" class="mode-toggle-btn ${i === 0 ? 'active' : ''}" data-rtab="${k}">${l}</button>`).join('')}</div>
    <div id="ai-replace-body"><div class="empty-state">Loading…</div></div>
    <div class="actions"><div id="ai-replace-error" class="ai-action-msg"></div><button class="secondary" id="ai-rep-cancel">Cancel</button><button class="primary" id="ai-rep-primary" hidden>Use this dish</button></div>`, { wide: true });
  overlay.querySelector('#ai-rep-cancel').addEventListener('click', close);
  const body = overlay.querySelector('#ai-replace-body');
  const errorEl = overlay.querySelector('#ai-replace-error');

  let options = null;
  try {
    options = await window.api.aiMenuReplacementOptions({ runId: state.aiMenu.runId, pickId: pick.id });
  } catch (err) {
    body.innerHTML = aiBlockedHtml({ reason: err.message });
    return;
  }

  const apply = async (replacement, btn) => {
    errorEl.innerHTML = '';
    if (btn) btn.disabled = true;
    try {
      const res = await window.api.aiMenuReplacePick({ runId: state.aiMenu.runId, pickId: pick.id, replacement });
      if (!res.ok) { aiShowBlocked(errorEl, res.blocked); if (btn) btn.disabled = false; return; }
      close();
      showToast(res.linked ? 'That dish is already in the Dish Catalog — the catalog dish is used.' : res.reused ? 'That dish was already in this menu — it is used here too.' : `Replaced${res.updatedPicks > 1 ? ` (${res.updatedPicks} places, shared copies included)` : ''}.`);
      await reloadAiMenuRun();
    } catch (err) {
      aiShowBlocked(errorEl, { reason: err.message });
      if (btn) btn.disabled = false;
    }
  };

  const listHtml = (rows, kind) => `
    <input type="search" class="ai-rep-search" placeholder="Search" aria-label="Search" />
    <ul class="ai-option-list">${rows.map(r => `
      <li data-q="${aiEsc(`${r.name} ${(r.key_ingredients || []).join(' ')}`.toLowerCase())}">
        <div><strong>${aiEsc(r.name)}</strong> ${aiAttrChips(r)} ${kind === 'unused' ? aiDishBadges(r) : ''}${r.usedInThisSection ? ' <span class="ai-muted">already on this menu</span>' : ''}
          ${r.key_ingredients ? `<div class="ai-ingredients">${aiEsc(r.key_ingredients.join(', '))}</div>` : ''}</div>
        <button class="icon-btn" data-use="${r.id}">Use</button>
      </li>`).join('') || '<li class="ai-muted">Nothing to choose from here.</li>'}</ul>`;
  const wireList = (kind) => {
    body.querySelector('.ai-rep-search')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      body.querySelectorAll('.ai-option-list li[data-q]').forEach(li => { li.hidden = q && !li.dataset.q.includes(q); });
    });
    body.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
      apply(kind === 'unused' ? { draftDishId: Number(b.dataset.use) } : { itemId: Number(b.dataset.use) }, b);
    }));
  };

  // The pinned action bar's primary button is only used by "Write a new dish" (lists use per-row buttons).
  const primary = overlay.querySelector('#ai-rep-primary');
  const show = async (tab) => {
    errorEl.innerHTML = '';
    primary.hidden = true;
    primary.onclick = null;
    overlay.querySelectorAll('[data-rtab]').forEach(b => b.classList.toggle('active', b.dataset.rtab === tab));
    if (tab === 'unused') {
      body.innerHTML = `<p class="ai-muted">Dishes the AI made for this menu that aren't served in ${AI_SECTION_LABEL[pick.section_code]} yet. Already safety-checked.${options.cuisine ? ` National Day (${aiEsc(options.cuisine)}) dishes are listed first.` : ''}</p>${listHtml(options.unusedDishes, 'unused')}`;
      wireList('unused');
    } else if (tab === 'catalog') {
      body.innerHTML = `<p class="ai-muted">Active Dish Catalog dishes in this category that are set up for ${AI_SECTION_LABEL[pick.section_code]}.</p>${listHtml(options.catalogItems, 'catalog')}`;
      wireList('catalog');
    } else if (tab === 'ask') {
      body.innerHTML = `<p class="ai-muted">The AI suggests three new dishes for this slot, keeping what the menu rules need here (e.g. a chicken main stays chicken)${options.cuisine ? `, all ${aiEsc(options.cuisine)} for National Day` : ''}. Each one is safety-checked before you see it.</p>
        <button class="primary" id="ai-ask-btn">Suggest 3 dishes</button><div id="ai-ask-results" aria-live="polite"></div>`;
      body.querySelector('#ai-ask-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const out = body.querySelector('#ai-ask-results');
        btn.disabled = true; btn.textContent = 'Asking the AI…';
        try {
          const res = await window.api.aiMenuSuggest({ runId: state.aiMenu.runId, pickId: pick.id });
          out.innerHTML = `<ul class="ai-option-list">${res.candidates.map((c, i) => `
            <li><div><strong>${aiEsc(c.name)}</strong> ${aiAttrChips(c)}${c.knownRisk?.length ? ' <span class="chip ai-risk">Made nut/sesame-free (kitchen standard)</span>' : ''}${c.linkedTo ? ` <span class="chip daily">In catalog as "${aiEsc(c.linkedTo)}"</span>` : ''}
              ${c.description ? `<div>${aiEsc(c.description)}</div>` : ''}<div class="ai-ingredients">${aiEsc(c.key_ingredients.join(', '))}</div></div>
              <button class="icon-btn" data-cand="${i}">Use</button></li>`).join('') || '<li class="ai-muted">No usable suggestions came back — try again.</li>'}</ul>
            ${res.rejected.length ? `<p class="ai-muted">${res.rejected.length} suggestion(s) failed the safety check and were dropped: ${res.rejected.map(r => aiEsc(`${r.name} (${r.reason})`)).join('; ')}</p>` : ''}`;
          out.querySelectorAll('[data-cand]').forEach(b => b.addEventListener('click', () => {
            apply({ newDish: res.candidates[Number(b.dataset.cand)], origin: 'ai_suggest' }, b);
          }));
          btn.textContent = 'Suggest 3 more';
        } catch (err) {
          out.innerHTML = aiBlockedHtml({ reason: err.message });
          btn.textContent = 'Try again';
        }
        btn.disabled = false;
      });
    } else if (tab === 'write') {
      body.innerHTML = `<p class="ai-muted">Your own dish. It goes through the same nut / sesame, seafood and halal check (a hit blocks it), and if the Dish Catalog already has it, the catalog dish is used.</p>
        <div id="ai-write-form">${aiDishFormHtml(pick.category_code, null, 'ai-wr', [pick.section_code])}</div>`;
      primary.hidden = false;
      primary.onclick = () => apply({ newDish: aiReadDishForm(body.querySelector('#ai-write-form')), origin: 'chef' }, primary);
    }
  };
  overlay.querySelectorAll('[data-rtab]').forEach(b => b.addEventListener('click', () => show(b.dataset.rtab)));
  show(tabs[0][0]);
}

// ============================================================
// EXPORT ALL SECTIONS VIEW
// ============================================================
async function renderExportAllView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Export All Sections</h1><span class="page-description">One click, one workbook</span></div>
    </div>
    <p style="color:var(--neutral); max-width:640px; margin-bottom:20px;">
      Export all sections together.
    </p>
    <div class="generate-controls">
      <div class="field">
        <label>Workbook name</label>
        <input id="ea-label" />
      </div>
      <div class="field">
        <label>Created by</label>
        <input id="ea-created-by" />
      </div>
      <div class="field">
        <label>Start date</label>
        <input id="ea-start" type="date" />
      </div>
      <div class="field">
        <label>End date</label>
        <input id="ea-end" type="date" />
      </div>
      <button class="primary" id="ea-generate-btn">Generate &amp; Export All Sections</button>
    </div>
    <div id="ea-day-count" class="day-count-hint" style="margin:-10px 0 14px;"></div>
    <div id="ea-mix"></div>
    <div id="ea-result" style="margin-top:16px;"></div>
  `;

  wireDateRangeFields('ea-start', 'ea-end', 'ea-day-count');

  const eaBtn = document.getElementById('ea-generate-btn');
  const updateEaBtn = () => { eaBtn.textContent = mixActive() ? 'Generate & Export All Sections with Created By mix' : 'Generate & Export All Sections'; };
  const eaMixHost = document.getElementById('ea-mix');
  renderMixPanel(eaMixHost, () => mixScope('ea-start', 'ea-end', MIX_SECTION_ORDER, true), updateEaBtn);
  updateEaBtn();
  for (const id of ['ea-start', 'ea-end']) document.getElementById(id).addEventListener('change', () => eaMixHost.refreshMix());

  eaBtn.addEventListener('click', async () => {
    const label = document.getElementById('ea-label').value.trim() || 'Untitled Menu';
    const createdBy = document.getElementById('ea-created-by').value.trim() || null;
    const startDate = document.getElementById('ea-start').value;
    const endDate = document.getElementById('ea-end').value;
    if (!startDate || !endDate) return alert('Please choose a start and end date.');
    if (endDate < startDate) return alert('End date must be on or after the start date.');

    const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
    if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');
    if (mixActive() && mixTotal() !== 100) return alert(`The Created By mix adds up to ${mixTotal()}%. Make it 100%, or turn it off.`);

    const resultEl = document.getElementById('ea-result');
    resultEl.textContent = 'Generating all 5 sections and exporting…';

    let result;
    setMenuPlannerBusy(true);
    try {
      result = await window.api.generateAndExportAll({ label, startDate, numWeekdays, createdBy, createdByMix: mixPayload() });
    } finally { setMenuPlannerBusy(false); }

    if (!result.success) {
      resultEl.textContent = result.cancelled ? '' : 'Export failed.';
      return;
    }

    const totalWarnings = Object.values(result.warningsBySection || {})
      .reduce((sum, w) => sum + w.length, 0);

    resultEl.innerHTML = `
      <div style="margin-bottom:10px; color:var(--sage-dark); font-weight:600;">
        Exported to ${result.path}
      </div>
      ${totalWarnings > 0 ? `
        <div class="warning-banner">
          ⚠ ${totalWarnings} item(s) across all sections had to repeat sooner than 4 weeks
          -- add more items to those categories in the Dish Catalog to improve variety over time.
        </div>` : `
        <div style="color:var(--neutral); font-size:13px;">
          No repeat warnings -- every section had enough variety for the full period.
        </div>`}
      ${mixReportHtml(result.mixReportBySection)}
    `;
  });
}

// ============================================================
// MENU INGREDIENTS GENERATOR -- upload a menu .xlsx this app itself produced, review/edit an
// AI-suggested ingredient list per dish, export the annotated file. Purely one-shot: nothing
// here is ever saved to Supabase (see state.menuIngredients' own comment and main.js's
// parse-and-suggest-menu-ingredients/export-menu-ingredients handlers).
// ============================================================
function renderMenuIngredientsView(main) {
  const mi = state.menuIngredients;
  const hasUpload = mi.files.length > 0;
  const exportableFiles = mi.files.filter(f => f.rows && f.rows.length);
  const totalRows = exportableFiles.reduce((sum, f) => sum + f.rows.length, 0);

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Menu Ingredients Generator</h1><span class="page-description">Upload a menu, review AI-suggested ingredients, export -- nothing is saved</span></div>
    </div>
    <div class="generate-controls" style="align-items:center;">
      <button class="primary" id="mi-upload-btn">${hasUpload ? 'Upload Different File(s)' : 'Upload Menu File(s)'}</button>
      <input type="file" id="mi-file-input" accept=".xlsx" multiple hidden />
      ${exportableFiles.length ? `<button class="secondary" id="mi-export-btn">Export to Excel</button>` : ''}
      <span id="mi-export-status" style="color:var(--neutral); font-size:12.5px;"></span>
    </div>
    <div id="mi-progress-wrap"></div>
    ${hasUpload ? `<div style="color:var(--sage-dark); font-size:12.5px; margin:-10px 0 14px;">${totalRows} dish row(s) parsed across ${exportableFiles.length} of ${mi.files.length} file(s)</div>` : ''}
    <div id="mi-review"></div>
  `;
  // Per-file `failures` (layout-inference notes, and any dish the AI genuinely couldn't suggest
  // anything for) is intentionally not rendered here anymore -- it's still returned from
  // parse-and-suggest-menu-ingredients and logged there (main.js, log.warn), just not shown as
  // a yellow box in this view. A dish the AI failed on still appears below as a normal row with
  // an empty Ingredients input -- category and dish name are still populated, so a genuinely
  // blank one stays visually obvious as a gap in an otherwise-filled column, just without the
  // explanatory text. A file that failed to parse AT ALL (its own `.error`) DOES still get a
  // visible marker -- see renderMenuIngredientsFiles below -- since that's not a per-row gap, it's
  // the entire file missing from the export.

  document.getElementById('mi-upload-btn').addEventListener('click', () => {
    document.getElementById('mi-file-input').click();
  });

  document.getElementById('mi-file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    // Temporary diagnostic logging for the "hangs on second upload" investigation -- mirrors
    // main.js's own miLog calls so a live repro shows definitively whether the renderer or the
    // main process is the one that actually stops making progress. Remove once confirmed fixed.
    const miLog = (msg) => console.log(`[mi-renderer ${new Date().toISOString()}] ${msg}`);
    miLog(`${files.length} file(s) selected: ${files.map(f => `"${f.name}" (${f.size}b)`).join(', ')}`);

    // Disabled for the whole batch -- previously clickable the entire time, so a chef who saw no
    // movement (nothing updated the "Reading file..." label during parsing -- see the
    // e.sender.send calls in main.js fixing that) could click Upload again mid-parse, kicking off
    // a second concurrent batch. Both would eventually race to populate the same shared in-memory
    // file map, and whichever finished LAST silently won regardless of which one's rows were on
    // screen -- root cause of the earlier stale-export bug. uploadToken (below) closes that race
    // even if this ever gets bypassed some other way; this disable just prevents the easy trigger.
    const uploadBtn = document.getElementById('mi-upload-btn');
    uploadBtn.disabled = true;

    // Clear the previous upload's review table(s) (if any) before this one starts, rather than
    // waiting for a successful parse to replace it -- a large prior table (potentially thousands
    // of rows, each with its own input) otherwise sits fully live in the DOM for the entire
    // duration of this new upload's file-read/parse/AI-suggest work, and a renderer window
    // carrying that much retained DOM can feel unresponsive everywhere, not just in this view --
    // easy to mistake for the whole app being frozen.
    document.getElementById('mi-review').innerHTML = '';
    miLog('old review table(s) cleared, upload button disabled');

    const uploadToken = crypto.randomUUID();
    miLog(`uploadToken generated: ${uploadToken}`);
    const progressWrap = document.getElementById('mi-progress-wrap');
    // One progress row per file (same spinner/message pattern Clean Menu for Sharing already uses
    // for its own multi-file upload -- see renderCleanMenuView), since each file's parse/AI-suggest
    // status here is genuinely independent, not a single shared percentage.
    progressWrap.innerHTML = `
      <div class="progress-panel">
        ${files.map((f, i) => `
          <div class="progress-panel-row" data-file-row="${i}">
            <span class="progress-panel-spinner" data-file-icon style="display:inline-block; width:14px;"></span>
            <span class="progress-panel-message">${f.name}</span>
            <span class="progress-panel-meta" data-file-status>Queued…</span>
          </div>
        `).join('')}
      </div>
    `;
    function setRowStatus(fileIndex, stage, message) {
      const row = progressWrap.querySelector(`[data-file-row="${fileIndex}"]`);
      if (!row) return;
      const statusEl = row.querySelector('[data-file-status]');
      const iconEl = row.querySelector('[data-file-icon]');
      if (statusEl && message != null) statusEl.textContent = message;
      if (iconEl && (stage === 'done' || stage === 'error')) {
        iconEl.className = '';
        iconEl.style.cssText = 'display:inline-block; width:14px; text-align:center; font-weight:600;';
        iconEl.textContent = stage === 'done' ? '✓' : '✕';
        iconEl.style.color = stage === 'done' ? 'var(--sage-dark)' : 'var(--danger, #c0392b)';
      }
    }
    const unsubscribe = window.api.onMenuIngredientsProgress(({ fileIndex, stage, message, current, total }) => {
      miLog(`progress event received from main: file ${fileIndex} -- ${message}`);
      const meta = typeof total === 'number' && total > 0 ? ` (${current}/${total})` : '';
      setRowStatus(fileIndex, stage, `${message}${meta}`);
    });
    try {
      miLog('reading all files as base64…');
      const filesPayload = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ fileName: file.name, base64: reader.result.split(',')[1] });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));
      miLog(`all files read -- invoking parseAndSuggestMenuIngredients with ${filesPayload.length} file(s)`);
      const result = await window.api.parseAndSuggestMenuIngredients({ files: filesPayload, uploadToken });
      miLog(`parseAndSuggestMenuIngredients invoke RESOLVED -- success=${result.success}, cancelled=${!!result.cancelled}`);
      if (!result.success) {
        if (!result.cancelled) alert(`Couldn't process these file(s): ${result.error}`);
        return;
      }
      // Reconciles every row against the final per-file results, same reasoning as Clean Menu for
      // Sharing's own post-loop reconcile -- guaranteed to reflect the true final state even if a
      // progress event was somehow missed.
      result.files.forEach((f) => setRowStatus(f.fileIndex, f.success ? 'done' : 'error', f.success ? 'Done' : f.error));
      state.menuIngredients = { files: result.files, uploadToken };
      renderMenuIngredientsView(main);
      miLog('view re-rendered with new files');
    } catch (err) {
      miLog(`caught error: ${err.message}`);
      alert(`Couldn't process these file(s): ${err.message}`);
    } finally {
      // Unconditional, regardless of which branch above ran -- renderMenuIngredientsView(main)
      // on the success path replaces this whole view's innerHTML, so there's nothing stateful
      // left to unwind there; on a failure path the progress rows just stay as their last status.
      unsubscribe();
      if (document.body.contains(uploadBtn)) uploadBtn.disabled = false;
      miLog('finally block done');
    }
  });

  if (hasUpload) {
    renderMenuIngredientsFiles(document.getElementById('mi-review'), mi.files);

    if (exportableFiles.length) {
      document.getElementById('mi-export-btn').addEventListener('click', async () => {
        const miLog = (msg) => console.log(`[mi-renderer ${new Date().toISOString()}] ${msg}`);
        const btn = document.getElementById('mi-export-btn');
        const statusEl = document.getElementById('mi-export-status');
        btn.disabled = true;
        statusEl.textContent = 'Exporting…';
        const exportPayload = exportableFiles.map(f => ({ fileIndex: f.fileIndex, rows: f.rows }));
        miLog(`export clicked -- invoking exportMenuIngredients for ${exportPayload.length} file(s), uploadToken=${mi.uploadToken}`);
        try {
          const result = await window.api.exportMenuIngredients({ files: exportPayload, uploadToken: mi.uploadToken });
          miLog(`exportMenuIngredients invoke RESOLVED -- success=${result.success}, cancelled=${!!result.cancelled}`);
          if (result.success) {
            statusEl.textContent = result.count > 1
              ? `Exported ${result.count} files to ${result.path}`
              : `Exported to ${result.path}`;
          } else if (!result.cancelled) {
            statusEl.textContent = `Export failed: ${result.error || 'unknown error'}`;
          } else {
            statusEl.textContent = '';
          }
        } catch (err) {
          statusEl.textContent = `Export failed: ${err.message}`;
        } finally {
          btn.disabled = false;
        }
      });
    }
  } else {
    // Pre-upload empty state -- otherwise this screen is just bare space until a file's
    // uploaded and processed. Mirrors .empty-state's usual centered heading+sentence
    // convention (see e.g. Recipe Book's "No recipes yet"), extended with a 3-step visual
    // guide. Purely explanatory -- the one upload entry point is the top-bar mi-upload-btn.
    document.getElementById('mi-review').innerHTML = `
      <div class="empty-state mi-empty-state">
        <div class="display">Upload a menu to get started</div>
        <div class="mi-steps">
          <div class="mi-step">
            <div class="mi-step-num">1</div>
            <div class="mi-step-title">Upload menu file(s)</div>
            <div class="mi-step-desc">One or more exports from Generate Menu, Build Menu, or Export All Sections</div>
          </div>
          <div class="mi-step">
            <div class="mi-step-num">2</div>
            <div class="mi-step-title">AI suggests ingredients &amp; allergens</div>
            <div class="mi-step-desc">Each dish gets a real base-ingredient breakdown and allergen tags</div>
          </div>
          <div class="mi-step">
            <div class="mi-step-num">3</div>
            <div class="mi-step-title">Review, edit, export</div>
            <div class="mi-step-desc">Adjust anything, then export. One file exports directly; several bundle into one zip</div>
          </div>
        </div>
      </div>
    `;
  }
}

// Wraps the existing per-file renderMenuIngredientsReview (unchanged below -- it already only
// needs a container + a rows array, so it works as-is per file) in a heading per uploaded file, so
// N files uploaded together each get their own clearly-labeled review table rather than one
// table with no indication of which file a row came from. A file that failed to parse entirely
// (f.error set, f.rows empty) shows its error inline instead of an empty table.
function renderMenuIngredientsFiles(container, files) {
  const multi = files.length > 1;
  container.innerHTML = files.map((f, i) => `
    <div class="mi-file-block" style="margin-bottom:28px;">
      ${multi ? `
        <div style="font-weight:700; font-size:15px; margin-bottom:8px; padding-bottom:6px; border-bottom:2px solid var(--line);">
          ${f.fileName}
          ${f.rows && f.rows.length ? '' : `<span style="font-weight:400; font-size:12.5px; color:var(--danger, #c0392b); margin-left:8px;">${(f.error || 'No rows found').replace(/</g, '&lt;')}</span>`}
        </div>
      ` : ''}
      <div id="mi-file-review-${i}"></div>
    </div>
  `).join('');
  files.forEach((f, i) => {
    if (f.rows && f.rows.length) renderMenuIngredientsReview(document.getElementById(`mi-file-review-${i}`), f.rows);
    else if (!multi) {
      document.getElementById(`mi-file-review-${i}`).innerHTML = `<div style="color:var(--danger, #c0392b); font-size:13px;">${(f.error || 'No rows found').replace(/</g, '&lt;')}</div>`;
    }
  });
}

// Groups the flat rows list by sheet (section) then by date, preserving the source file's own
// row order (both Maps fill in first-seen order, which is already sheet-by-sheet/row-by-row scan
// order from lib/menuIngredients.js -- no re-sorting needed to match "the source file's own
// structure"). Each ingredients/allergens <input> mutates its own row object's `ingredients`/
// `allergens` field in place on input (see the delegated listener below) -- since
// exportMenuIngredients is later called with this exact same rows array/objects.
function renderMenuIngredientsReview(container, rows) {
  const bySheet = new Map();
  for (const row of rows) {
    if (!bySheet.has(row.sheetName)) bySheet.set(row.sheetName, new Map());
    const byDate = bySheet.get(row.sheetName);
    const dateKey = `${row.date}__${row.weekday}`;
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(row);
  }

  container.innerHTML = [...bySheet.entries()].map(([sheetName, byDate]) => `
    <div class="day-card" style="margin-bottom:18px;">
      <div class="day-head"><span>${sheetName}</span></div>
      <div style="padding:12px 18px;">
        ${[...byDate.entries()].map(([dateKey, dayRows]) => {
          const [date, weekday] = dateKey.split('__');
          return `
            <div style="margin-bottom:16px;">
              <div style="font-weight:600; color:var(--sage-dark); margin-bottom:6px;">${weekday.toUpperCase()} &middot; ${date}</div>
              <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
                <thead>
                  <tr>
                    <th style="width:160px; text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-size:11px; color:var(--neutral); text-transform:uppercase; letter-spacing:0.04em;">Category</th>
                    <th style="width:260px; text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-size:11px; color:var(--neutral); text-transform:uppercase; letter-spacing:0.04em;">Dish</th>
                    <th style="text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-size:11px; color:var(--neutral); text-transform:uppercase; letter-spacing:0.04em;">Ingredients</th>
                    <th style="width:220px; text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-size:11px; color:var(--neutral); text-transform:uppercase; letter-spacing:0.04em;">Allergens</th>
                  </tr>
                </thead>
                <tbody>
                  ${dayRows.map(row => `
                    <tr>
                      <td style="padding:6px 8px; border-bottom:1px solid var(--line);">${row.category || ''}</td>
                      <td style="padding:6px 8px; border-bottom:1px solid var(--line);">${row.dishName}</td>
                      <td style="padding:6px 8px; border-bottom:1px solid var(--line);">
                        <input class="mi-ingredients-input" data-sheet="${sheetName}" data-row="${row.rowNumber}" value="${(row.ingredients || '').replace(/"/g, '&quot;')}" style="width:100%; padding:5px 7px; border:1px solid var(--line); border-radius:6px; font-family:inherit; font-size:13px;" />
                        ${row.removedNutTerms && row.removedNutTerms.length ? `
                          <div style="margin-top:4px; font-size:11.5px; color:var(--danger);">
                            ⚠ removed (nut policy): ${row.removedNutTerms.map(t => t.replace(/</g, '&lt;')).join(', ')} -- edit the box above to add back if you know this dish is nut-free
                          </div>` : ''}
                      </td>
                      <td style="padding:6px 8px; border-bottom:1px solid var(--line);">
                        <input class="mi-allergens-input" data-sheet="${sheetName}" data-row="${row.rowNumber}" value="${(row.allergens || '').replace(/"/g, '&quot;')}" style="width:100%; padding:5px 7px; border:1px solid var(--line); border-radius:6px; font-family:inherit; font-size:13px;" />
                        ${row.removedAllergenNutTerms && row.removedAllergenNutTerms.length ? `
                          <div style="margin-top:4px; font-size:11.5px; color:var(--danger);">
                            ⚠ removed (nut policy): ${row.removedAllergenNutTerms.map(t => t.replace(/</g, '&lt;')).join(', ')} -- edit the box above to add back if you know this dish is nut-free
                          </div>` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  // One delegated listener on the container instead of one per <input> -- at the scale a large
  // menu file produces (thousands of rows), attaching a listener per row was itself a meaningful
  // chunk of the retained-DOM weight this view can build up across uploads (see the comment above
  // the innerHTML clear in renderMenuIngredientsView). A single listener that checks e.target
  // scales to any row count at effectively zero added cost per row. Handles both the ingredients
  // and allergens inputs the same way, keyed off which class actually fired.
  container.addEventListener('input', (e) => {
    const isIngredients = e.target.classList.contains('mi-ingredients-input');
    const isAllergens = e.target.classList.contains('mi-allergens-input');
    if (!isIngredients && !isAllergens) return;
    const sheetName = e.target.dataset.sheet;
    const rowNumber = parseInt(e.target.dataset.row, 10);
    const row = rows.find(r => r.sheetName === sheetName && r.rowNumber === rowNumber);
    if (!row) return;
    if (isIngredients) row.ingredients = e.target.value;
    else row.allergens = e.target.value;
  });
}

// ============================================================
// CLEAN MENU FOR SHARING -- upload one or more already-exported/edited menu files, get back clean
// copies with every formula flattened to a static value and every dropdown removed. No review
// step (pure deterministic file manipulation, no AI) -- see main.js's clean-menus-for-sharing
// handler for what actually changes (nothing but those two things) and for how multiple files are
// processed independently (one failing never blocks or delays the others) and bundled into one
// zip. Each uploaded file gets its OWN progress row here -- same spinner/message CSS every other
// progress panel in this app already uses (.progress-panel-row/-spinner/-message), just N rows
// instead of one shared bar, since each file's status is genuinely independent.
// ============================================================
function renderCleanMenuView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Clean Menu for Sharing</h1><span class="page-description">Upload one or more exported menu files, get back clean copies -- formulas flattened to values, dropdowns removed, nothing else changes</span></div>
    </div>
    <div class="generate-controls" style="align-items:center;">
      <button class="primary" id="cm-upload-btn">Upload Menu File(s)</button>
      <input type="file" id="cm-file-input" accept=".xlsx" multiple hidden />
    </div>
    <div id="cm-file-list" style="margin-top:14px;"></div>
    <div id="cm-summary" style="margin-top:10px; font-size:13px;"></div>
  `;

  document.getElementById('cm-upload-btn').addEventListener('click', () => {
    document.getElementById('cm-file-input').click();
  });

  document.getElementById('cm-file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;

    const uploadBtn = document.getElementById('cm-upload-btn');
    uploadBtn.disabled = true;
    const listEl = document.getElementById('cm-file-list');
    const summaryEl = document.getElementById('cm-summary');
    summaryEl.textContent = '';

    listEl.innerHTML = `
      <div class="progress-panel">
        ${files.map((f, i) => `
          <div class="progress-panel-row" data-file-row="${i}">
            <span class="progress-panel-spinner" data-file-icon style="display:inline-block; width:14px;"></span>
            <span class="progress-panel-message">${f.name}</span>
            <span class="progress-panel-meta" data-file-status>Queued…</span>
          </div>
        `).join('')}
      </div>
    `;

    function setRowStatus(fileIndex, stage, message) {
      const row = listEl.querySelector(`[data-file-row="${fileIndex}"]`);
      if (!row) return;
      const statusEl = row.querySelector('[data-file-status]');
      const iconEl = row.querySelector('[data-file-icon]');
      if (statusEl && message != null) statusEl.textContent = message;
      if (iconEl && (stage === 'done' || stage === 'error')) {
        // Swap the spinning circle for a static glyph -- className reset drops the spinner's
        // border/animation entirely, same fixed 14px width kept so the row doesn't jump.
        iconEl.className = '';
        iconEl.style.cssText = 'display:inline-block; width:14px; text-align:center; font-weight:600;';
        iconEl.textContent = stage === 'done' ? '✓' : '✕';
        iconEl.style.color = stage === 'done' ? 'var(--sage-dark)' : 'var(--danger, #c0392b)';
      }
    }

    const unsubscribe = window.api.onCleanMenuProgress(({ fileIndex, stage, message }) => {
      setRowStatus(fileIndex, stage, message);
    });

    try {
      const filesPayload = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ fileName: file.name, base64: reader.result.split(',')[1] });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })));

      const result = await window.api.cleanMenusForSharing({ files: filesPayload });

      // Reconciles every row against the final per-file results regardless of what progress
      // events already showed -- a file failing inside cleanOneMenuFile already emits its own
      // 'error' progress event (so this is mostly a no-op double-check), but this is the one
      // place guaranteed to reflect the true final state even if an event was somehow missed.
      (result.results || []).forEach((r, i) => {
        setRowStatus(i, r.success ? 'done' : 'error', r.success ? 'Done' : r.error);
      });

      const successCount = (result.results || []).filter((r) => r.success).length;
      const totalCount = (result.results || []).length;
      if (result.success) {
        summaryEl.innerHTML = `<span style="color:var(--sage-dark);">${successCount} of ${totalCount} file(s) cleaned successfully. Saved to "${result.path}".</span>`;
      } else if (result.cancelled) {
        summaryEl.innerHTML = `<span style="color:var(--neutral);">${successCount} of ${totalCount} file(s) cleaned successfully, but the save was cancelled.</span>`;
      } else {
        summaryEl.innerHTML = `<span style="color:var(--danger, #c0392b);">${result.error}</span>`;
      }
    } catch (err) {
      summaryEl.innerHTML = `<span style="color:var(--danger, #c0392b);">Couldn't clean these files: ${err.message}</span>`;
    } finally {
      unsubscribe();
      uploadBtn.disabled = false;
    }
  });
}

// ============================================================
// RECIPE BOOK
// ============================================================
function renderRecipesView(main) {
  const ns = RECIPE_NS.book;
  if (state[ns.stateKey].view === 'form') return renderRecipeFormView(main, ns);
  return renderRecipeListView(main, ns);
}

function renderExtractorView(main) {
  const ns = RECIPE_NS.extractor;
  if (state[ns.stateKey].view === 'form') return renderRecipeFormView(main, ns);
  return renderRecipeListView(main, ns);
}

// Shared by both namespaces -- clears every piece of in-progress form state so the next
// renderRecipeFormView() call re-initializes it fresh from whichever recipe (or blank slate)
// it's opening. Photo fields are the one namespace-dependent piece (ns.photoModel): Recipe Book
// resets its single pendingPhoto/removePhoto pair, Recipe Extractor its existingPhotos/
// pendingPhotos gallery arrays.
function resetRecipeFormState(ns) {
  const s = state[ns.stateKey];
  s.processes = [];
  s.presentationMode = null;
  s.presentationText = '';
  s.presentationItems = [];
  if (ns.photoModel === 'gallery') {
    s.existingPhotos = [];
    s.pendingPhotos = [];
  } else {
    s.pendingPhoto = null;
    s.removePhoto = false;
  }
}

// Recipe Book, Recipe Extractor, and Materials are the only screens with a persistent list<->form
// sub-state (state.recipes.view/state.extractor.view/state.materials.view) -- every other screen
// re-renders fresh from fetched data on each visit, so there's nothing to reset there. Called by
// wireNav whenever she actually navigates to a DIFFERENT top-level view (never when re-clicking
// the one she's already on), so an open form never silently resumes just because she clicked away
// and back -- same "leave without saving discards it" behavior every other unsaved-edit screen in
// this app already has, no separate warning. Loops over RECIPE_NS generically so a future fourth
// screen with this same list/form pattern (built the RECIPE_NS way) is covered automatically;
// Materials is reset separately below since it isn't RECIPE_NS-shaped (no ns.stateKey/api
// namespace object -- just one plain catalog, like Ingredients).
function resetDrilldownScreens() {
  Object.values(RECIPE_NS).forEach(ns => {
    state[ns.stateKey].view = 'list';
    state[ns.stateKey].formId = null;
    resetRecipeFormState(ns);
  });
  state.aiMenu.view = 'list';
  state.aiMenu.data = null;
  state.materials.view = 'list';
  state.materials.formId = null;
  state.materials.pendingPhoto = null;
  state.materials.removePhoto = false;
}

function openNewRecipeForm(ns) {
  state[ns.stateKey].view = 'form';
  state[ns.stateKey].formId = null;
  resetRecipeFormState(ns);
  renderView();
}

function openEditRecipeForm(ns, id) {
  state[ns.stateKey].view = 'form';
  state[ns.stateKey].formId = id;
  resetRecipeFormState(ns);
  renderView();
}

// Groups recipes by the recipe card's own "Date" field (date_created, a YYYY-MM-DD string
// from the date input -- NOT the created_at audit timestamp). Parsed by hand rather than via
// `new Date(dateStr)` because parsing a date-only ISO string that way reads it as UTC
// midnight, which rolls back a day (and a month, at month boundaries) in negative-UTC zones.
function recipeMonthGroup(dateStr) {
  const m = (dateStr || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const [, year, month] = m;
  const key = `${year}-${month}`;
  const label = new Date(Number(year), Number(month) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { key, label };
}

// Newest month first; recipes with no/invalid date always land in an "Undated" group at the end.
function groupRecipesByMonth(list) {
  const groups = new Map();
  const undated = [];
  for (const r of list) {
    const g = recipeMonthGroup(r.date_created);
    if (!g) { undated.push(r); continue; }
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: g.label, recipes: [] });
    groups.get(g.key).recipes.push(r);
  }
  const sorted = [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
  if (undated.length > 0) sorted.push({ key: 'undated', label: 'Undated', recipes: undated });
  return sorted;
}

// Recipe Generator-only counterpart to groupRecipesByMonth above -- same {key, label, recipes}
// shape (so renderGeneratedConfirmedList's rendering/select-all/Export-Selected markup, copied
// from Recipe Book/Extractor's own month-grouped template, works completely unchanged), just
// grouped by source_menu_label instead of calendar month. A calendar month means little for
// Recipe Generator's own recipes -- they're always produced in one batch per menu upload, so the
// upload they came from is the far more useful grouping dimension here; Book/Extractor keep
// month-grouping since recipes there accumulate by hand over time instead. Re-uploading and
// confirming from an identically-named file lands in the same group -- a pure string match on
// whatever's already in source_menu_label, no separate persisted "folder" entity, same "reuse the
// value as-is" convention the Drafts tab's own folder view already established. No explicit sort
// (unlike groupRecipesByMonth's own key-string sort) -- `recipes` arrives already newest-first
// (list-generated-recipes orders by id desc), and a plain Map preserves that same first-seen
// order per group, so the group containing the most recently confirmed recipe naturally sorts
// first.
function groupRecipesBySourceMenu(list) {
  const groups = new Map();
  for (const r of list) {
    const key = r.source_menu_label || 'Unknown source';
    if (!groups.has(key)) groups.set(key, { key, label: key, recipes: [] });
    groups.get(key).recipes.push(r);
  }
  return [...groups.values()];
}

async function renderRecipeListView(main, ns) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>${ns.title}</h1><span class="page-description">${ns.subtitle}</span></div>
      <div class="action-toolbar">
        ${ns.stateKey === RECIPE_NS.book.stateKey ? '<button class="secondary" id="waste-types-btn">Waste Types</button>' : ''}
        ${ns.extract ? '<button class="secondary" id="import-recipe-btn">Upload Recipe</button>' : ''}
        ${ns.allowManualNew ? '<button class="primary" id="new-recipe-btn">+ New Recipe</button>' : ''}
      </div>
    </div>
    ${ns.extract ? '<input type="file" id="import-recipe-input" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" multiple hidden />' : ''}
    ${ns.extract ? '<div id="extract-progress-wrap"></div>' : ''}
    <div class="search-bar">
      <label for="recipe-search">${ns.searchLabel}</label>
      <input id="recipe-search" type="search" />
    </div>
    <div class="action-toolbar">
      <button class="secondary" id="export-selected-btn" disabled>Export Selected</button>
      ${exportLanguagePickerHtml('list')}
      <button class="secondary" id="delete-selected-btn" disabled>Delete Selected</button>
    </div>
    <div id="export-selected-progress-wrap"></div>
    <div id="recipes-content"><div class="loading-state" role="status">Loading…</div></div>
  `;
  wireExportLanguagePicker('list');
  // Waste Types catalog is global (shared by Book and Extractor process cards alike), but its
  // one management entry point lives only on Recipe Book's screen -- see conversation notes on
  // the composable process-waste feature.
  if (ns.stateKey === RECIPE_NS.book.stateKey) {
    document.getElementById('waste-types-btn').addEventListener('click', () => openWasteTypesModal());
  }
  if (ns.allowManualNew) {
    document.getElementById('new-recipe-btn').addEventListener('click', () => ns.openNew());
  }

  if (ns.extract) {
    const importBtn = document.getElementById('import-recipe-btn');
    const importInput = document.getElementById('import-recipe-input');
    const progressWrap = document.getElementById('extract-progress-wrap');

    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = ''; // always reset so picking the same file(s) twice still fires 'change'
      if (files.length === 0) return;

      // Caps mirrored independently in main.js's extract-recipe-for-extractor handler and the
      // extract-recipe Edge Function -- checked here first purely so a chef picking way too
      // many/too-large files gets an immediate, specific message instead of a round trip.
      if (files.length > MAX_EXTRACT_FILES) {
        alert(`Please select at most ${MAX_EXTRACT_FILES} files at once.`);
        return;
      }
      const oversized = files.find(f => f.size > MAX_EXTRACT_FILE_BYTES);
      if (oversized) {
        alert(`"${oversized.name}" is larger than ${MAX_EXTRACT_FILE_BYTES / 1024 / 1024}MB. Please choose smaller files.`);
        return;
      }
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_EXTRACT_TOTAL_BYTES) {
        alert(`Combined file size exceeds ${MAX_EXTRACT_TOTAL_BYTES / 1024 / 1024}MB. Please select fewer or smaller files.`);
        return;
      }

      importBtn.disabled = true;
      importBtn.textContent = 'Extracting recipe…';
      // Indeterminate mode (see createProgressPanel) -- the extraction call is a single-shot
      // Anthropic API round trip through the Edge Function, with no real progress fraction to
      // report (no update() call below ever supplies current/total), so this is deliberately a
      // sliding bar + elapsed time only, not a fake percentage.
      const fileWord = files.length === 1 ? 'photo' : 'photos';
      const panel = createProgressPanel(progressWrap, { label: `Extracting recipe from ${files.length} ${fileWord}… this can take a few seconds.` });
      try {
        // All files are sent together in one extraction call (not one call per file merged
        // after) so the model has full cross-page context -- required for e.g. correctly
        // combining a "Vanilla Base" on one photo and a "Caramelized Sugar Top" on another into
        // one recipe's processes, instead of risking duplicate/conflicting detection.
        const filePayloads = await Promise.all(files.map(file => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ base64: reader.result.split(',')[1], mimeType: file.type, name: file.name });
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        })));
        const result = await ns.extract({ files: filePayloads });
        if (!result.success) {
          alert(`Couldn't extract this upload: ${result.error || 'unknown error'}. Opening a blank recipe instead — you can fill it in manually.`);
          ns.openNew();
          return;
        }
        // ns.openNew() resets and re-renders the form synchronously, so importedRecipe must be
        // set first -- the form reads it on its very first (synchronous) pass through the
        // non-editing branch, before this function would get a chance to set it afterward.
        state[ns.stateKey].importedRecipe = result.recipe;
        ns.openNew();
      } catch (err) {
        alert(`Couldn't extract this file: ${err.message}. Opening a blank recipe instead — you can fill it in manually.`);
        ns.openNew();
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = 'Upload Recipe';
        panel.destroy();
      }
    });
  }

  const recipes = await ns.api.list();
  const searchInput = document.getElementById('recipe-search');
  const content = document.getElementById('recipes-content');
  const exportBtn = document.getElementById('export-selected-btn');
  const deleteSelectedBtn = document.getElementById('delete-selected-btn');
  const selected = new Set();

  if (recipes.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No recipes yet</div>${ns.newRecipeHint}</div>`;
    return;
  }

  function updateExportBtn() {
    exportBtn.disabled = selected.size === 0;
    exportBtn.textContent = selected.size > 0 ? `Export Selected (${selected.size})` : 'Export Selected';
    deleteSelectedBtn.disabled = selected.size === 0;
    deleteSelectedBtn.textContent = selected.size > 0 ? `Delete Selected (${selected.size})` : 'Delete Selected';
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query
      ? recipes.filter(r => r.name.toLowerCase().includes(query) || r.code.toLowerCase().includes(query))
      : recipes;

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No recipes match "${searchInput.value}".</div>`;
      return;
    }

    const groups = groupRecipesByMonth(filtered);

    content.innerHTML = groups.map(group => `
      <div class="recipe-month-group">
        <div class="recipe-month-head">
          <label>
            <input type="checkbox" class="month-select-all" data-month="${group.key}" />
            <strong>${group.label}</strong>
            <span style="color:var(--neutral); font-weight:400;">(${group.recipes.length})</span>
          </label>
        </div>
        <div class="table-scroll"><table class="recipes-table">
          <thead><tr><th></th><th>Code</th><th>Name</th><th>Category</th><th>Prepared By</th><th>Date</th><th></th></tr></thead>
          <tbody>
            ${group.recipes.map(r => `
              <tr>
                <td><input type="checkbox" class="recipe-row-check" data-select="${r.id}" data-month="${group.key}" ${selected.has(r.id) ? 'checked' : ''} /></td>
                <td>${r.code}</td>
                <td>${r.name}</td>
                <td>${r.category || '–'}</td>
                <td>${r.prepared_by || '–'}</td>
                <td>${r.date_created || '–'}</td>
                <td style="text-align:right">
                  <button class="icon-btn" data-preview="${r.id}" title="Preview export" aria-label="Preview export">${EYE_OFF_ICON_SVG}</button>
                  <button class="icon-btn" data-edit="${r.id}">Edit</button>
                  <button class="icon-btn danger" data-delete="${r.id}">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table></div>
      </div>
    `).join('');

    function updateMonthCheckboxStates() {
      content.querySelectorAll('.month-select-all').forEach(monthCb => {
        const monthKey = monthCb.dataset.month;
        const rowCbs = [...content.querySelectorAll('.recipe-row-check')].filter(cb => cb.dataset.month === monthKey);
        monthCb.checked = rowCbs.length > 0 && rowCbs.every(cb => cb.checked);
      });
    }

    content.querySelectorAll('.recipe-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.select, 10);
        if (cb.checked) selected.add(id); else selected.delete(id);
        updateMonthCheckboxStates();
        updateExportBtn();
      });
    });
    content.querySelectorAll('.month-select-all').forEach(monthCb => {
      monthCb.addEventListener('change', () => {
        const monthKey = monthCb.dataset.month;
        content.querySelectorAll('.recipe-row-check').forEach(cb => {
          if (cb.dataset.month !== monthKey) return;
          cb.checked = monthCb.checked;
          const id = parseInt(cb.dataset.select, 10);
          if (monthCb.checked) selected.add(id); else selected.delete(id);
        });
        updateExportBtn();
      });
    });
    updateMonthCheckboxStates();

    content.querySelectorAll('[data-preview]').forEach(btn => {
      btn.addEventListener('click', () => openRecipePreviewModal(ns, parseInt(btn.dataset.preview, 10), btn));
    });
    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => ns.openEdit(parseInt(btn.dataset.edit, 10)));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const recipe = recipes.find(r => r.id === id);
        if (!confirm(`Delete "${recipe.name}" (${recipe.code})? This cannot be undone.`)) return;
        await ns.api.del(id);
        renderRecipeListView(main, ns);
      });
    });
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    const progressWrap = document.getElementById('export-selected-progress-wrap');
    const panel = createProgressPanel(progressWrap, { label: 'Exporting…' });
    // Bug found in production: this had no try/catch at all -- when the underlying IPC call
    // rejected (e.g. a translation failure), the exception escaped this handler uncaught and
    // every line below (resetting the button) never ran, leaving it stuck on "Exporting…"
    // forever with no visible error. Looked like an infinite hang; was actually a fast failure
    // with nothing to surface it. See conversation notes.
    const unsubscribe = window.api.onExportProgress((payload) => panel.update(payload));
    try {
      const result = await ns.api.exportSelected([...selected], getSelectedExportLanguage('list'));
      panel.destroy();
      if (result.success) alert(`Exported to ${result.path}`);
      else if (!result.cancelled) alert('Export failed.');
    } catch (err) {
      panel.destroy();
      alert(`Export failed: ${err.message}`);
    } finally {
      unsubscribe();
      updateExportBtn();
    }
  });

  deleteSelectedBtn.addEventListener('click', async () => {
    const count = selected.size;
    if (!confirm(`Delete ${count} selected recipe${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    deleteSelectedBtn.disabled = true;
    deleteSelectedBtn.textContent = 'Deleting…';
    try {
      for (const id of selected) await ns.api.del(id);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
    renderRecipeListView(main, ns);
  });

  searchInput.addEventListener('input', renderFiltered);
  updateExportBtn();
  renderFiltered();
}

// ============================================================
// In-app export preview ("eye" icon on a Recipe Book/Extractor list row) -- an HTML/CSS
// approximation of that recipe's Excel export, built from the SAME content model buildRecipeSheet
// itself builds internally (see buildRecipeContentModel in lib/export.js, returned as plain
// JSON by the preview-recipe/preview-extracted-recipe IPC handlers) -- so numbering, totals, and
// labels here can never drift from what the real export produces. Deliberately never translates:
// this always shows the recipe's original saved English content regardless of the list screen's
// own export-language picker (translation only happens on an actual export). No .xlsx file is
// written or opened -- this is a pure in-app view.
function renderPreviewLinesBlock(field) {
  if (!field || field.lines.length === 0) return '<div class="preview-empty-note">—</div>';
  if (!field.numbered) return `<p class="preview-text-block">${field.lines[0]}</p>`;
  return `<ol class="preview-numbered-list">${field.lines.map(l => `<li>${l}</li>`).join('')}</ol>`;
}

function renderPreviewIngredientsTable(labels, ingredients, totalQuantity, showTotal, noteLabel) {
  return `
    <table class="preview-table">
      <thead><tr><th>${labels.ingredientsHeader}</th><th>${labels.quantityHeader}</th><th>${labels.unitHeader}</th><th>${noteLabel}</th></tr></thead>
      <tbody>
        ${ingredients.length ? ingredients.map(ing => `
          <tr><td>${ing.name}</td><td>${formatIngredientQty(ing.quantity)}</td><td>${ing.unit}</td><td>${ing.method}</td></tr>
        `).join('') : `<tr><td colspan="4" class="preview-empty-note">${labels.noIngredientsPlaceholder}</td></tr>`}
        ${showTotal ? `<tr class="preview-total-row"><td>${labels.totalQuantity}</td><td>${totalQuantity}</td><td></td><td></td></tr>` : ''}
      </tbody>
    </table>
  `;
}

// Photo (square box, object-fit:cover approximates Task 1's real crop-to-fill) + Presentation,
// side by side -- mirrors buildRecipeSheet's own A:B / C:D layout.
function renderPreviewPhotoBlock(labels, dataUrl, presentationField) {
  return `
    <div class="preview-photo-row">
      <div class="preview-photo-box">${dataUrl ? `<img src="${dataUrl}" alt="" />` : `<span>${labels.photoPlaceholder}</span>`}</div>
      <div class="preview-presentation">
        <div class="preview-section-label">${labels.presentationDecorationServing}</div>
        ${renderPreviewLinesBlock(presentationField)}
      </div>
    </div>
  `;
}

function renderPreviewCommentRow(labels, model) {
  return `
    <div class="preview-fields-grid preview-fields-grid-2col">
      <div class="preview-field"><span class="preview-field-label">${labels.comment}</span><div>${model.comment}</div></div>
      <div class="preview-field"><span class="preview-field-label">${labels.checkedBy}</span><div>${model.checkedBy}</div></div>
    </div>
  `;
}

// Shared by Recipe Book and Recipe Extractor -- both build process-shaped models now (see
// buildRecipeContentModel in lib/export.js), so there's no longer a separate flat-ingredients
// preview body. Recipe Book's `photoDataUrls` is always 0-1 entries (single-photo model), so it
// only ever hits the inline (hasSeparatePhotoSheet === false) branch below -- no special-casing
// needed for it.
function renderRecipePreviewBody(ns, model, photoDataUrls) {
  const { labels, header } = model;
  // Mirrors buildRecipeSheet/buildRecipePhotosSheet's own branch: 0-1 photos
  // show the Photo cell inline beside Presentation; 2+ move to a separate "Photos" page with
  // Presentation shown above the grid instead -- see hasSeparatePhotoSheet's own comment.
  const photoBlock = model.hasSeparatePhotoSheet
    ? `
      <div class="preview-photos-divider">Photos (${model.photoCount}) — separate sheet in the real export</div>
      <div class="preview-section">
        <div class="preview-section-label">${labels.presentationDecorationServing}</div>
        ${renderPreviewLinesBlock(model.presentation)}
      </div>
      <div class="preview-photo-grid">
        ${photoDataUrls.map(src => `<div class="preview-photo-box preview-photo-tile">${src ? `<img src="${src}" alt="" />` : ''}</div>`).join('')}
      </div>
    `
    : renderPreviewPhotoBlock(labels, photoDataUrls[0] || null, model.presentation);

  return `
    <div class="preview-title-row">
      <div class="preview-title">${header.name}</div>
      <div class="preview-code">${ns.codeLabel}: ${header.code}</div>
    </div>
    <div class="preview-fields-grid">
      <div class="preview-field"><span class="preview-field-label">${labels.quantityProduced}</span><span>${header.quantityProduced}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.portionWeight}</span><span>${header.portionWeight}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.preparedBy}</span><span>${header.preparedBy}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.category}</span><span>${header.category}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.countryOrigin}</span><span>${header.countryOrigin}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.netWeight}</span><span class="preview-field-strong">${header.netWeight}</span></div>
      ${header.portionsProduced !== '' ? `<div class="preview-field"><span class="preview-field-label">${labels.portionsProduced}</span><span class="preview-field-strong">${header.portionsProduced}</span></div>` : ''}
    </div>
    ${model.processes.map(proc => `
      <div class="preview-process-card">
        <div class="preview-section-label">${proc.name}</div>
        ${proc.ingredients.length ? `
          ${renderPreviewIngredientsTable(labels, proc.ingredients, proc.totalQuantity, false, labels.noteColumnHeader)}
          <div class="preview-fields-grid preview-fields-grid-inline">
            <div class="preview-field"><span class="preview-field-label">${labels.totalQuantity}</span><span class="preview-field-strong">${proc.totalQuantity}</span></div>
            ${(proc.wastes || []).map(w => `<div class="preview-field"><span class="preview-field-label">${w.name}</span><span>${w.percent}% <span class="preview-waste-reduced">${w.reduced}</span> → ${w.after}</span></div>`).join('')}
            <div class="preview-field"><span class="preview-field-label">${labels.netWeight}</span><span class="preview-field-strong">${proc.netWeight}</span></div>
            ${proc.materialName ? `<div class="preview-field"><span class="preview-field-label">${labels.materialLabel}</span><span>${proc.materialName}</span></div>` : ''}
            ${proc.traysNeeded !== '' ? `<div class="preview-field"><span class="preview-field-label">${labels.traysNeeded}</span><span class="preview-field-strong">${proc.traysNeeded}</span></div>` : ''}
          </div>
        ` : ''}
        ${proc.method.lines.length ? `
          <div class="preview-section-sublabel">${labels.methodLabel}</div>
          ${renderPreviewLinesBlock(proc.method)}
        ` : ''}
      </div>
    `).join('')}
    <div class="preview-total-row-standalone">${labels.totalQuantity}: ${model.totalQuantity}</div>
    ${photoBlock}
    ${renderPreviewCommentRow(labels, model)}
  `;
}

async function openRecipePreviewModal(ns, id, triggerBtn) {
  // Row icon is always visible, but reflects preview state: eye-off (closed) flips to a plain
  // eye the moment this recipe's preview opens -- it's actively being viewed -- and back to
  // eye-off once the modal closes, whether by "Close", clicking the backdrop, or a load failure
  // below aborting before the modal shows.
  if (triggerBtn) triggerBtn.innerHTML = EYE_ICON_SVG;
  const revertIcon = () => {
    if (triggerBtn) triggerBtn.innerHTML = EYE_OFF_ICON_SVG;
  };

  let model, recipe, photoDataUrls = [];
  try {
    [model, recipe] = await Promise.all([ns.api.preview(id), ns.api.get(id)]);
    // Photo bytes never go through preview-recipe/preview-extracted-recipe -- the form view
    // already fetches these same data URLs from Storage via getPhoto/getPhotos, so the preview
    // just reuses that path directly instead of round-tripping image bytes through a new
    // endpoint. Recipe Book's single photo_path becomes a 0-or-1-length array here, matching
    // buildRecipeContentModel's own photos.length <= 1 / >= 2 branching exactly.
    if (ns.photoModel === 'gallery') {
      const paths = (recipe.photos || []).map(p => p.photo_path);
      if (paths.length > 0) photoDataUrls = await ns.api.getPhotos(paths);
    } else if (recipe.photo_path) {
      photoDataUrls = [await ns.api.getPhoto(recipe.photo_path)];
    }
  } catch (err) {
    revertIcon();
    alert(`Couldn't load preview: ${err.message}`);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal preview-modal">
      <div class="preview-modal-head">
        <h2>Export Preview</h2>
        <button class="secondary" id="pv-close">Close</button>
      </div>
      ${renderRecipePreviewBody(ns, model, photoDataUrls)}
    </div>
  `;
  document.body.appendChild(overlay);
  const closePreview = () => { overlay.remove(); revertIcon(); };
  overlay.querySelector('#pv-close').addEventListener('click', closePreview);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
}

let _recipeRowLocalIdCounter = 0;
function makeEmptyIngredientRow() {
  return { localId: ++_recipeRowLocalIdCounter, ingredientId: null, name: '', quantity: '', unit: '', method: '' };
}

// Compounds a base quantity through a sequence of waste percentages sequentially, not summed --
// Qty x (1-w1%) x (1-w2%) x ... -- confirmed with the chef; mathematically order-independent
// (multiplication commutes), so a wastes array's own order only matters for display. Shared by
// updateProcessNetWeight (the recipe form, live) and the Recipe Calculator's own live recompute
// (renderScaledRecipeResult) -- one formula, not two copies of the same math.
function compoundWasteYield(baseQty, wastes) {
  return roundNice((wastes || []).reduce((acc, w) => {
    const raw = parseFloat(w.percent);
    const pct = isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 100);
    return acc * (1 - pct / 100);
  }, baseQty));
}

// Per-waste display breakdown: how much THIS waste removed (against the running total right
// before it, never the original Total Quantity) and what's left running into the next one --
// shared by the recipe form's Wastes Applied rows (renderProcessWastes) and the Calculator's own
// (renderCalcProcessWastes). Each row's `after` is computed via compoundWasteYield(baseQty,
// wastes.slice(0, i+1)) -- i.e. fresh from the raw, unrounded baseQty every time, rounding only
// once per call, exactly like compoundWasteYield's own single call for the real Net Weight --
// rather than chaining through previously-ROUNDED `after` values. Chaining rounded intermediates
// instead can drift from the real Net Weight by a hundredth of a gram once there are 3+ wastes
// (confirmed: 100g through two 33.333% wastes rounds to 44.45g chained vs. the correct 44.44g),
// which would silently disagree with the Net Weight box sitting right below these rows. Because
// of this, the LAST row's `after` is always bit-for-bit the same number compoundWasteYield(baseQty,
// wastes) itself produces -- never a separately-derived figure that could drift out of sync.
function computeWasteWaterfall(baseQty, wastes) {
  const list = wastes || [];
  const rows = [];
  let before = roundNice(baseQty);
  for (let i = 0; i < list.length; i++) {
    const after = compoundWasteYield(baseQty, list.slice(0, i + 1));
    rows.push({ before, after, reduced: roundNice(before - after) });
    before = after;
  }
  return rows;
}

// Updates just the two computed spans inside each already-rendered waste row (reduced amount +
// running total) without touching the percent <input> itself -- lets this run on every Total/Net
// Weight recompute (including a keystroke in a waste's own % field, via updateProcessNetWeight/
// refreshProcessCalc below) without stealing focus mid-edit. renderProcessWastes/
// renderCalcProcessWastes only rebuild the whole row list on add/remove, where a fresh render (and
// therefore losing focus) is already expected. `idPrefix` is 'ew' for the recipe form's own row
// ids or 'calc' for the Calculator's, matching each one's existing id scheme for the percent input.
function refreshProcessWasteWaterfallDisplay(proc, baseQty, idPrefix) {
  const waterfall = computeWasteWaterfall(baseQty, proc.wastes);
  proc.wastes.forEach((w, i) => {
    const row = waterfall[i];
    const reducedEl = document.getElementById(`${idPrefix}-waste-reduced-${proc.localId}-${w.localId}`);
    const runningEl = document.getElementById(`${idPrefix}-waste-running-${proc.localId}-${w.localId}`);
    if (reducedEl) reducedEl.textContent = row.reduced > 0 ? `−${row.reduced} G` : '0 G';
    if (runningEl) runningEl.textContent = `→ ${row.after} G`;
  });
}

// Same reduction as compoundWasteYield above (baseQty=1 gives exactly the compounded retention
// fraction, Net Weight / Total Quantity), deliberately NOT reusing compoundWasteYield itself --
// that function's own roundNice at the end is fine for a DISPLAYED weight but would inject up to
// ~0.5% error here, where the result is about to be used as a divisor (see
// computeTargetTotalQuantityFromNetWeight below).
function processRetentionFactor(wastes) {
  return (wastes || []).reduce((acc, w) => {
    const raw = parseFloat(w.percent);
    const pct = isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 100);
    return acc * (1 - pct / 100);
  }, 1);
}

// Net Weight editing (Book/Extractor/Generator, both levels) back-solves the Total Quantity that
// would produce a given target Net Weight through EXISTING waste percentages held fixed, then
// hands that number to the exact same computeMultiplierFromTarget/scaleIngredients cascade
// Total Quantity editing already uses -- this is the only new math, everything downstream of it
// is reused unmodified. `retentionFactor` is either one process's own processRetentionFactor(
// proc.wastes) (Level 1) or the CURRENT implied aggregate ratio combinedNetWeight/
// combinedTotalQuantity (Level 2) -- see each call site.
//
// Blocks (rather than silently producing an absurd or infinite number) once the retention
// factor is at or near zero -- MIN_RETENTION_FACTOR (99.9%+ combined waste) is a floor below
// which a back-solved Total Quantity is so large it almost certainly signals a waste-%
// data-entry mistake rather than a legitimate target; a caller should fix the waste % first, not
// receive a number that technically satisfies the math but not any real kitchen scenario.
const MIN_RETENTION_FACTOR = 0.001;
function computeTargetTotalQuantityFromNetWeight(retentionFactor, targetNetWeightText) {
  const target = parseFloat(targetNetWeightText);
  if (!target || target <= 0) {
    return { error: 'Please enter a target Net Weight greater than 0, e.g. 2000.' };
  }
  if (!retentionFactor || retentionFactor < MIN_RETENTION_FACTOR) {
    return { error: `Combined waste is too high (≥${roundNice((1 - MIN_RETENTION_FACTOR) * 100)}%) to compute a Total Quantity from a Net Weight target -- adjust the waste percentages first.` };
  }
  return { targetTotalQuantity: target / retentionFactor };
}

// Each process's own Wastes Applied/Net Weight -- reads/writes that one process card's own
// elements (ep-total-<id>/ep-yield-<id>). Returns the computed net weight (a Number) so callers
// summing across every process don't need to re-read the DOM afterward. Shared by Recipe Book
// and Recipe Extractor (both process-shaped since the multi-process migration). Reads proc.wastes
// directly (kept live by each waste row's own 'input' listener, see renderProcessWastes) rather
// than re-querying every input here.
function updateProcessNetWeight(proc) {
  const totalEl = document.getElementById(`ep-total-${proc.localId}`);
  const yieldEl = document.getElementById(`ep-yield-${proc.localId}`);
  if (!totalEl || !yieldEl) return 0;

  const totalQty = sumIngredientQuantities(proc.ingredientRows);
  // Never overwrite while she's actively typing a new value into this exact field -- a
  // per-process rescale (see wireProcessTotalQuantityRescale) fires on 'change' once she moves
  // away/hits Enter, not per-keystroke; this guard just stops the live recompute-on-any-edit
  // path (every OTHER change anywhere on the form calls this) from fighting her mid-edit. The
  // actual Net Weight computation below always uses the real ingredient-derived totalQty
  // regardless of what's currently displayed here.
  if (document.activeElement !== totalEl) totalEl.value = `${roundNice(totalQty)} G`;

  const netWeight = compoundWasteYield(totalQty, proc.wastes);
  // Same guard as totalEl above -- Net Weight is now also editable (see
  // wireProcessNetWeightRescale), and must not fight her mid-edit either.
  if (document.activeElement !== yieldEl) yieldEl.value = `${netWeight} G`;

  // Keeps every waste row's own reduced-amount/running-total spans in lockstep with this exact
  // totalQty/netWeight recompute -- covers every path that leads here (ingredient edits, Total
  // Quantity/Net Weight rescale, and a waste's own % edit, since that also funnels through here
  // via onChange -- see renderProcessWastes), so there's exactly one place this ever goes stale.
  refreshProcessWasteWaterfallDisplay(proc, totalQty, 'ew');

  // Trays Needed -- how many of this process's linked material (tray/pan/mold) are required to
  // hold its full Net Weight, rounded UP (a partially-filled tray still counts as one you need to
  // prepare). Blank/omitted (not "0" or a placeholder) whenever no material is linked or its fill
  // weight isn't set yet, same convention every other optional computed field in this app uses.
  const traysEl = document.getElementById(`ep-trays-${proc.localId}`);
  if (traysEl) {
    const fill = parseFloat(proc.materialFillWeightGrams);
    traysEl.textContent = (proc.materialId && !isNaN(fill) && fill > 0)
      ? String(Math.ceil(netWeight / fill))
      : '–';
  }

  return netWeight;
}

// Recomputes every process's own Total Quantity/Net Weight (via updateProcessNetWeight above)
// and writes the recipe-level Net Weight (rf-yield) as their plain sum -- no recipe-level waste
// is applied on top, matching how neither recipes nor extracted_recipes has its own waste field
// any more (waste lives per-process only, since the multi-process migration). Also drives the
// recipe-level Portions Produced box off that same combined sum -- floored, not rounded or
// ceiling'd, since it answers "how many whole portions does this actually cut into" (any leftover
// under one portion's weight isn't a portion; unlike Trays Needed, there's no reason to round up
// a *capacity requirement* here).
function updateNetWeightSum(ns) {
  const s = state[ns.stateKey];
  const yieldEl = document.getElementById('rf-yield');
  if (!yieldEl) return;
  const sum = s.processes.reduce((acc, proc) => acc + updateProcessNetWeight(proc), 0);
  const roundedSum = roundNice(sum);
  // Same guard as updateProcessNetWeight's own -- rf-yield is now also editable (see
  // wireRecipeNetWeightRescale).
  if (document.activeElement !== yieldEl) yieldEl.value = `${roundedSum} G`;

  // Recipe-level Total Quantity (rf-total-qty) -- the combined PRE-waste sum across every
  // process, editable (see wireRecipeTotalQuantityRescale); re-summed here every time any
  // ingredient/process changes, same "flows up, never touches siblings" direction #2 already
  // established for Recipe Generator's drafts. Guarded against her own in-progress edit the same
  // way updateProcessNetWeight guards its own per-process field.
  const totalQtyEl = document.getElementById('rf-total-qty');
  if (totalQtyEl && document.activeElement !== totalQtyEl) {
    const combinedTotal = s.processes.reduce((acc, proc) => acc + sumIngredientQuantities(proc.ingredientRows), 0);
    totalQtyEl.value = roundNice(combinedTotal);
  }

  const portionsEl = document.getElementById('rf-portions-produced');
  if (portionsEl) {
    const portionWeightInput = document.getElementById('rf-portion-weight');
    const pw = portionWeightInput ? parseFloat(portionWeightInput.value) : NaN;
    portionsEl.textContent = (!isNaN(pw) && pw > 0) ? String(Math.floor(roundedSum / pw)) : '–';
  }
}

// ------------------------------------------------------------------
// Presentation Text-vs-List toggle (recipe-level) and Method (per-process, see
// makeProcessMethodCfg) both use this same mechanism.
//
// The field is a plain TEXT column in the DB -- list items are just newline-joined text, same
// convention the Excel export already uses. Mode isn't persisted as a flag; it's inferred on
// load (initTextListField): more than one non-empty line after split-by-newline opens in List
// mode, otherwise Text mode. Toggling between modes is non-destructive in both directions (split
// on \n / join with \n), so a wrong guess costs one click, never data.
// ------------------------------------------------------------------
const TEXT_LIST_FIELDS = {
  presentation: {
    modeKey: 'presentationMode', textKey: 'presentationText', itemsKey: 'presentationItems',
    textareaId: 'rf-presentation', mountId: 'rf-presentation-field', rows: 4,
  },
  // Same modeKey/textKey/itemsKey as `presentation` above (the field it edits is conceptually
  // identical) -- just pointed at different DOM ids, since the Calculator's own Presentation
  // mount lives in a different view than the recipe form's. Read/written against the Calculator's
  // own fetched recipe object (never the form's), so there's no risk of the two colliding despite
  // sharing state-key names.
  calcPresentation: {
    modeKey: 'presentationMode', textKey: 'presentationText', itemsKey: 'presentationItems',
    textareaId: 'calc-presentation', mountId: 'calc-presentation-field', rows: 4,
  },
  // Same pattern as calcPresentation above -- Recipe Generator's bespoke form
  // (renderGeneratedRecipeFormView) is its own view with its own DOM ids, read/written against
  // state.generatedRecipes (already carries presentationMode/Text/Items, unused until this field
  // existed).
  generatedPresentation: {
    modeKey: 'presentationMode', textKey: 'presentationText', itemsKey: 'presentationItems',
    textareaId: 'rg-presentation', mountId: 'rg-presentation-field', rows: 4,
  },
};

// Takes the object to read/write directly (`target`) and a field config (`cfg`) rather than a
// namespace+key lookup -- both namespaces call this against state[ns.stateKey] with
// TEXT_LIST_FIELDS.presentation (recipe-level) AND against each process object individually (a
// per-process cfg from makeProcessMethodCfg, below) -- same toggle/Enter-to-insert/remove
// behavior either way, just pointed at a different object.
function initTextListField(target, cfg, rawValue) {
  if (target[cfg.modeKey] != null) return; // already initialized this form session
  const raw = rawValue || '';
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  target[cfg.modeKey] = lines.length > 1 ? 'list' : 'paragraph';
  target[cfg.textKey] = raw;
  target[cfg.itemsKey] = (lines.length ? lines : ['']).map(v => ({ localId: ++_recipeRowLocalIdCounter, value: v }));
}

// Renders the Text/List toggle plus whichever editor is active, and rewires its listeners --
// a full rebuild on every change, same approach as renderProcessIngredientRows.
function renderTextListFieldBody(target, cfg) {
  const mount = document.getElementById(cfg.mountId);
  if (!mount) return;
  const mode = target[cfg.modeKey];
  const items = target[cfg.itemsKey];

  mount.innerHTML = `
    <div class="mode-toggle">
      <button type="button" class="mode-toggle-btn ${mode === 'paragraph' ? 'active' : ''}" data-mode="paragraph">Text</button>
      <button type="button" class="mode-toggle-btn ${mode === 'list' ? 'active' : ''}" data-mode="list">List</button>
    </div>
    ${mode === 'paragraph' ? `
      <textarea id="${cfg.textareaId}" rows="${cfg.rows}" ${cfg.dirAuto ? 'dir="auto"' : ''}>${target[cfg.textKey] || ''}</textarea>
    ` : `
      <div class="text-list">
        ${items.map((item, idx) => `
          <div class="text-list-row" data-item="${item.localId}">
            <span class="text-list-drag-handle" data-drag-handle="${item.localId}" draggable="true" title="Drag to reorder">⠿</span>
            <span class="text-list-index">${idx + 1}.</span>
            <input class="text-list-input" value="${item.value}" ${cfg.dirAuto ? 'dir="auto"' : ''} />
            <button type="button" class="icon-btn danger" data-remove="${item.localId}" ${items.length <= 1 ? 'disabled' : ''}>✕</button>
          </div>
        `).join('')}
      </div>
    `}
  `;

  mount.querySelectorAll('.mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode;
      if (newMode === mode) return;
      if (newMode === 'list') {
        const raw = document.getElementById(cfg.textareaId)?.value ?? target[cfg.textKey] ?? '';
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        target[cfg.itemsKey] = (lines.length ? lines : ['']).map(v => ({ localId: ++_recipeRowLocalIdCounter, value: v }));
      } else {
        target[cfg.textKey] = target[cfg.itemsKey].map(it => it.value.trim()).filter(Boolean).join('\n');
      }
      target[cfg.modeKey] = newMode;
      renderTextListFieldBody(target, cfg);
    });
  });

  if (mode === 'paragraph') {
    const textarea = document.getElementById(cfg.textareaId);
    textarea.addEventListener('input', () => { target[cfg.textKey] = textarea.value; });
    return;
  }

  mount.querySelectorAll('.text-list-input').forEach((inputEl, idx) => {
    const item = items[idx];
    inputEl.addEventListener('input', () => { item.value = inputEl.value; });
    // Enter inserts a new empty item right after this one and focuses it -- works whether
    // she's appending at the end or inserting a step in the middle.
    inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const i = items.findIndex(it => it.localId === item.localId);
      const newItem = { localId: ++_recipeRowLocalIdCounter, value: '' };
      items.splice(i + 1, 0, newItem);
      renderTextListFieldBody(target, cfg);
      mount.querySelector(`[data-item="${newItem.localId}"] .text-list-input`)?.focus();
    });
  });

  mount.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.remove, 10);
      target[cfg.itemsKey] = items.filter(it => it.localId !== id);
      if (target[cfg.itemsKey].length === 0) target[cfg.itemsKey].push({ localId: ++_recipeRowLocalIdCounter, value: '' });
      renderTextListFieldBody(target, cfg);
    });
  });

  wireTextListRowDrag(target, cfg, mount.querySelector('.text-list'), () => renderTextListFieldBody(target, cfg));
}

// Drag-and-drop reordering for List-mode rows, same mechanism as wireProcessIngredientRowDrag
// (ingredient rows) -- draggable="true" lives only on the ⠿ handle, never the row or the input,
// so dragging never fights with editing the item's text.
function wireTextListRowDrag(target, cfg, containerEl, rerender) {
  if (!containerEl) return;
  let draggedId = null;

  containerEl.querySelectorAll('[data-drag-handle]').forEach(handle => {
    handle.addEventListener('dragstart', (e) => {
      draggedId = parseInt(handle.dataset.dragHandle, 10);
      const row = handle.closest('.text-list-row');
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedId));
      e.dataTransfer.setDragImage(row, 20, row.offsetHeight / 2);
    });
    handle.addEventListener('dragend', () => {
      containerEl.querySelectorAll('.text-list-row').forEach(r => r.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
      draggedId = null;
    });
  });

  containerEl.querySelectorAll('.text-list-row').forEach(row => {
    row.addEventListener('dragover', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = parseInt(row.dataset.item, 10);
      containerEl.querySelectorAll('.text-list-row').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      if (targetId === draggedId) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      row.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });

    row.addEventListener('drop', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      const targetId = parseInt(row.dataset.item, 10);
      const items = target[cfg.itemsKey];
      const fromIdx = items.findIndex(it => it.localId === draggedId);
      let toIdx = items.findIndex(it => it.localId === targetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const [moved] = items.splice(fromIdx, 1);
      if (!before) toIdx += 1;
      if (fromIdx < toIdx) toIdx -= 1;
      items.splice(toIdx, 0, moved);
      draggedId = null;
      rerender();
    });
  });
}

// Final saved value for either mode: paragraph text trimmed as-is, or list items trimmed and
// filtered of blanks (drops the trailing empty item from a last Enter press) and \n-joined --
// the same "one idea per line" text shape the Excel export already expects.
function collectTextListFieldValue(target, cfg) {
  if (target[cfg.modeKey] === 'paragraph') {
    const el = document.getElementById(cfg.textareaId);
    return (el ? el.value : target[cfg.textKey] || '').trim();
  }
  return target[cfg.itemsKey].map(it => it.value.trim()).filter(Boolean).join('\n');
}

// Anti-typo autocomplete: matches what's typed against this namespace's own ingredient table
// (ingredients for Recipe Book, extracted_ingredients for Recipe Extractor -- never cross-
// matched) so the same ingredient is always linked (and spelled) identically across every
// recipe in that table. This same mechanism is the ingredient-dedupe logic for Recipe
// Extractor: an exact (case-insensitive) name match suppresses "+ Add as new", steering the
// chef to reuse the existing IN- row instead of creating a near-duplicate.
let _ingredientAcDebounce = null;

function wireIngredientAutocomplete(ns, inputEl, listEl, unitInput, row) {
  inputEl.addEventListener('input', () => {
    row.name = inputEl.value;
    row.ingredientId = null; // typing invalidates the previous link until something is picked again
    const query = inputEl.value.trim();
    clearTimeout(_ingredientAcDebounce);
    if (!query) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    _ingredientAcDebounce = setTimeout(async () => {
      const matches = await ns.api.searchIngredients(query);
      renderAutocompleteList(ns, listEl, matches, query, inputEl, unitInput, row);
    }, 150);
  });

  // Delay hiding on blur so a mousedown on a dropdown item (below) has a chance to fire first.
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { listEl.hidden = true; }, 150);
  });
  inputEl.addEventListener('focus', () => {
    if (listEl.innerHTML) listEl.hidden = false;
  });
}

function renderAutocompleteList(ns, listEl, matches, query, inputEl, unitInput, row) {
  const exact = matches.find(m => m.name.toLowerCase() === query.toLowerCase());
  listEl.innerHTML = `
    ${matches.map(m => `
      <div class="autocomplete-item" data-pick="${m.id}">
        <span>${m.name}</span>
        <span class="autocomplete-meta">${[m.category, m.default_unit].filter(Boolean).join(' · ')}</span>
      </div>
    `).join('')}
    ${!exact ? `<div class="autocomplete-item autocomplete-add" data-add="1">+ Add "${query}" as new ingredient</div>` : ''}
  `;
  listEl.hidden = false;

  listEl.querySelectorAll('[data-pick]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the input from blurring/hiding the list before the click lands
      const match = matches.find(m => m.id === parseInt(el.dataset.pick, 10));
      selectIngredientForRow(match, inputEl, unitInput, row, listEl);
    });
  });
  const addEl = listEl.querySelector('[data-add]');
  if (addEl) {
    addEl.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      try {
        // 'G' is the standard default unit for new ingredients -- product code is deliberately
        // left blank here (not everyone has one on hand mid-recipe); it's editable later.
        const created = await ns.api.addIngredient({ name: query, defaultUnit: 'G' });
        selectIngredientForRow(created, inputEl, unitInput, row, listEl);
      } catch (err) {
        alert(`Couldn't add "${query}" as a new ingredient: ${err.message}`);
      }
    });
  }
}

function selectIngredientForRow(ingredient, inputEl, unitInput, row, listEl) {
  row.ingredientId = ingredient.id;
  row.name = ingredient.name;
  inputEl.value = ingredient.name;
  if (!unitInput.value.trim() && ingredient.default_unit) {
    unitInput.value = ingredient.default_unit;
    row.unit = ingredient.default_unit;
  }
  listEl.hidden = true;
  listEl.innerHTML = '';
}

// Shared by "Back to Recipe Book"/"Back to Recipe Extractor" and a successful save -- both
// exit the form the same way.
function goBackToRecipeList(ns) {
  state[ns.stateKey].view = 'list';
  state[ns.stateKey].formId = null;
  resetRecipeFormState(ns);
  renderView();
}

// ============================================================
// RECIPE FORM -- shared by Recipe Book and Recipe Extractor (see RECIPE_NS's own comment): one
// or more named processes (e.g. "Vanilla Base", "Caramelized Sugar Top"), each with its own
// ingredient table and method, under shared recipe-level fields. The ingredient-row-level pieces
// (wireIngredientAutocomplete/renderAutocompleteList, the Text/List toggle) are reused as-is.
// ============================================================

// Per-process Text/List config for the Method field -- same TEXT_LIST_FIELDS mechanism as
// Book's prep/presentation, just pointed at one process object with DOM ids unique to it (since
// several process cards' Method fields are mounted on the page at once).
function makeProcessMethodCfg(process) {
  return {
    modeKey: 'methodMode', textKey: 'methodText', itemsKey: 'methodItems',
    textareaId: `ep-method-${process.localId}`, mountId: `ep-method-field-${process.localId}`,
    rows: 5,
    // Extraction can now translate into any chosen language, including RTL ones -- dir="auto"
    // detects direction live from each field's own content (no need to know what language was
    // picked at extraction time), so this costs nothing for LTR text and fixes alignment/cursor
    // behavior for RTL. Extractor-only: never set on TEXT_LIST_FIELDS.presentation itself, since
    // Recipe Book's form reuses that same object and shouldn't change.
    dirAuto: true,
  };
}

function makeEmptyProcess() {
  const proc = {
    localId: ++_recipeRowLocalIdCounter,
    id: null,
    name: '',
    ingredientRows: [makeEmptyIngredientRow()],
    wastes: [],
    materialId: null,
    materialFillWeightGrams: null,
    methodMode: null, methodText: '', methodItems: [],
  };
  initTextListField(proc, makeProcessMethodCfg(proc), '');
  return proc;
}

// From a saved extracted_recipe_processes row (fetchExtractedRecipeWithIngredients's shape).
function buildProcessFromSaved(proc) {
  const built = {
    localId: ++_recipeRowLocalIdCounter,
    id: proc.id,
    name: proc.name || '',
    ingredientRows: (proc.ingredients || []).length > 0
      ? proc.ingredients.map(ri => ({
          localId: ++_recipeRowLocalIdCounter,
          ingredientId: ri.ingredient_id,
          name: ri.ingredient_name,
          quantity: ri.quantity ?? '',
          unit: ri.unit || '',
          method: ri.method || '',
        }))
      : [makeEmptyIngredientRow()],
    wastes: (proc.wastes || []).map(w => ({
      localId: ++_recipeRowLocalIdCounter,
      wasteTypeId: w.waste_type_id,
      name: w.name,
      percent: w.percent,
      // The value at form-open, to diff against on Save (see saveProcessRecipeForm's
      // scoped-impact prompt) -- never set on a row added fresh in this session (+ Add
      // Waste/+ Create new waste type…), which is how that check knows to skip those rows
      // entirely: a brand-new row has no "existing usage elsewhere" to reach in the first place.
      originalPercent: w.percent,
    })),
    materialId: proc.material_id ?? null,
    materialFillWeightGrams: proc.material_fill_weight_grams ?? null,
    methodMode: null, methodText: '', methodItems: [],
  };
  initTextListField(built, makeProcessMethodCfg(built), proc.method);
  return built;
}

// From a freshly-extracted process (extract-recipe-for-extractor's shape) -- ingredientId
// already resolved where an exact match was found server-side, null otherwise (picked from the
// autocomplete same as typing a new name by hand).
function buildProcessFromImported(proc) {
  const built = {
    localId: ++_recipeRowLocalIdCounter,
    id: null,
    name: proc.name || '',
    ingredientRows: (proc.ingredients || []).length > 0
      ? proc.ingredients.map(ing => ({
          localId: ++_recipeRowLocalIdCounter,
          ingredientId: ing.ingredientId || null,
          name: ing.name || '',
          quantity: ing.quantity != null ? String(ing.quantity) : '',
          unit: ing.unit || '',
          method: ing.method || '',
        }))
      : [makeEmptyIngredientRow()],
    // Never extracted from the card -- a source recipe card wouldn't reliably show a
    // decomposed waste breakdown; chef-entered only.
    wastes: [],
    methodMode: null, methodText: '', methodItems: [],
  };
  initTextListField(built, makeProcessMethodCfg(built), proc.method);
  return built;
}

// Renders one process's ingredient table into an explicit <tbody> element (not a fixed
// document-wide id, since several processes' tables are mounted simultaneously). Single
// "Ingredient" column, same canonical-ingredient autocomplete/dedupe as before the multi-process
// migration (wireIngredientAutocomplete, unchanged) -- the separate free-text "display name"
// column this used to have (for reviewing/correcting a translated ingredient name distinct from
// its English match) was reverted along with extraction-time language selection; every
// extracted ingredient name is English again, so there's nothing left for a second column to
// hold. `ns` picks which namespace's ingredient table the autocomplete searches (Recipe Book's
// `ingredients` vs Recipe Extractor's `extracted_ingredients`) -- never cross-matched.
function renderProcessIngredientRows(ns, process, tbodyEl, onChange) {
  tbodyEl.innerHTML = process.ingredientRows.map(row => `
    <tr data-row="${row.localId}">
      <td class="row-drag-handle-cell"><span class="row-drag-handle" data-drag-handle="${row.localId}" draggable="true" title="Drag to reorder">⠿</span></td>
      <td class="autocomplete-wrap">
        <input class="rf-ing-name" value="${row.name}" autocomplete="off" />
        <div class="autocomplete-list" hidden></div>
      </td>
      <td><input class="rf-ing-qty" value="${formatIngredientQty(row.quantity)}" /></td>
      <td><input class="rf-ing-unit" value="${row.unit}" /></td>
      <td><input class="rf-ing-method" value="${row.method}" dir="auto" /></td>
      <td style="text-align:right">
        <button class="icon-btn danger" data-row-remove="${row.localId}">Remove</button>
      </td>
    </tr>
  `).join('');

  process.ingredientRows.forEach(row => {
    const tr = tbodyEl.querySelector(`tr[data-row="${row.localId}"]`);
    const nameInput = tr.querySelector('.rf-ing-name');
    const qtyInput = tr.querySelector('.rf-ing-qty');
    const unitInput = tr.querySelector('.rf-ing-unit');
    const methodInput = tr.querySelector('.rf-ing-method');
    const listEl = tr.querySelector('.autocomplete-list');

    qtyInput.addEventListener('input', () => { row.quantity = qtyInput.value; onChange(); });
    unitInput.addEventListener('input', () => { row.unit = unitInput.value; });
    methodInput.addEventListener('input', () => { row.method = methodInput.value; });

    wireIngredientAutocomplete(ns, nameInput, listEl, unitInput, row);
  });

  tbodyEl.querySelectorAll('[data-row-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.rowRemove, 10);
      process.ingredientRows = process.ingredientRows.filter(r => r.localId !== id);
      if (process.ingredientRows.length === 0) process.ingredientRows.push(makeEmptyIngredientRow());
      renderProcessIngredientRows(ns, process, tbodyEl, onChange);
    });
  });

  wireProcessIngredientRowDrag(process, tbodyEl, () => renderProcessIngredientRows(ns, process, tbodyEl, onChange));
  onChange();
}

// Drag-and-drop reordering, scoped to one process's rows/tbody. draggable="true" lives ONLY on
// the ⠿ handle cell, never on the <tr> or the inputs -- dragstart is otherwise a mousedown-drag
// gesture, which would hijack text selection/dragging inside the ingredient-name input (and the
// autocomplete dropdown that hangs off it) into a row-drag instead.
function wireProcessIngredientRowDrag(process, tbodyEl, rerender) {
  let draggedId = null;

  tbodyEl.querySelectorAll('[data-drag-handle]').forEach(handle => {
    handle.addEventListener('dragstart', (e) => {
      draggedId = parseInt(handle.dataset.dragHandle, 10);
      const tr = handle.closest('tr');
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedId));
      e.dataTransfer.setDragImage(tr, 20, tr.offsetHeight / 2);
    });
    handle.addEventListener('dragend', () => {
      tbodyEl.querySelectorAll('tr').forEach(tr => tr.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
      draggedId = null;
    });
  });

  tbodyEl.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('dragover', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = parseInt(tr.dataset.row, 10);
      tbodyEl.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      if (targetId === draggedId) return;
      const rect = tr.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      tr.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });

    tr.addEventListener('drop', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      const targetId = parseInt(tr.dataset.row, 10);
      const rows = process.ingredientRows;
      const fromIdx = rows.findIndex(r => r.localId === draggedId);
      let toIdx = rows.findIndex(r => r.localId === targetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
      const rect = tr.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const [moved] = rows.splice(fromIdx, 1);
      if (!before) toIdx += 1;
      if (fromIdx < toIdx) toIdx -= 1;
      rows.splice(toIdx, 0, moved);
      draggedId = null;
      rerender();
    });
  });
}

// One process's "Wastes Applied" list -- each row is a catalog waste type snapshotted onto this
// process (own editable/overridable percent, defaulted from the catalog's default_percent only
// at the moment it's added, per the composable-waste feature). Re-run after every add/remove
// (not just once per card render) since the "+ Add Waste" select's own options must exclude
// whichever waste types are already applied to this specific process. `wasteTypes` is the full
// catalog, fetched once per form open (see renderRecipeFormView) -- shared by every process card
// on the form, never re-fetched per process.
// A row's percent has "changed" only relative to originalPercent (see buildProcessFromSaved/the
// "+ Add Waste" pick handler below) -- a row with none (added via "+ Create new waste type…")
// never shows as changed, since it has no existing usage elsewhere for the choice to mean
// anything against.
function wasteRowIsChanged(w) {
  return w.originalPercent != null && parseFloat(w.percent) !== parseFloat(w.originalPercent);
}

function renderProcessWasteRow(proc, w, row) {
  const reducedText = row.reduced > 0 ? `−${row.reduced} G` : '0 G';
  return `
    <div class="process-waste-row" data-waste="${w.localId}">
      <span class="process-waste-name" dir="auto">${w.name}</span>
      <input type="number" min="0" max="100" step="0.1" id="ew-waste-${proc.localId}-${w.localId}" class="process-waste-percent" value="${w.percent ?? ''}" />
      <span class="process-waste-percent-sign">%</span>
      <span class="process-waste-reduced" id="ew-waste-reduced-${proc.localId}-${w.localId}">${reducedText}</span>
      <span class="process-waste-running" id="ew-waste-running-${proc.localId}-${w.localId}">→ ${row.after} G</span>
      <button type="button" class="icon-btn" data-update-waste="${w.localId}" ${wasteRowIsChanged(w) ? '' : 'hidden'}>Update</button>
      <button type="button" class="icon-btn danger" data-remove-waste="${w.localId}">Remove</button>
    </div>
  `;
}

function renderProcessWastes(proc, wasteTypes, onChange) {
  const rowsEl = document.getElementById(`ep-wastes-${proc.localId}`);
  const selectEl = document.querySelector(`[data-add-waste="${proc.localId}"]`);
  if (!rowsEl || !selectEl) return;

  // Base quantity the waterfall's first row reduces against -- the process's own Total Quantity,
  // same figure ep-total-<id> itself shows (see updateProcessNetWeight).
  const baseQty = sumIngredientQuantities(proc.ingredientRows);
  const waterfall = computeWasteWaterfall(baseQty, proc.wastes);

  rowsEl.innerHTML = proc.wastes.length > 0
    ? proc.wastes.map((w, i) => renderProcessWasteRow(proc, w, waterfall[i])).join('')
    : `<div class="process-waste-empty">No wastes applied.</div>`;

  proc.wastes.forEach(w => {
    const input = document.getElementById(`ew-waste-${proc.localId}-${w.localId}`);
    const updateBtn = rowsEl.querySelector(`[data-update-waste="${w.localId}"]`);
    // Freely adjustable (typing, spinner clicks, backspacing) with no prompt at any point here --
    // only toggles the "Update" button's visibility. The choice modal fires solely on that
    // button's own click, never automatically off this input.
    input.addEventListener('input', () => {
      w.percent = input.value;
      onChange();
      updateBtn.hidden = !wasteRowIsChanged(w);
    });
    updateBtn.addEventListener('click', () => onWastePercentUpdateClicked(proc, w, wasteTypes, onChange));
  });
  rowsEl.querySelectorAll('[data-remove-waste]').forEach(btn => {
    btn.addEventListener('click', () => {
      const localId = parseInt(btn.dataset.removeWaste, 10);
      proc.wastes = proc.wastes.filter(w => w.localId !== localId);
      renderProcessWastes(proc, wasteTypes, onChange);
      onChange();
    });
  });

  // Reassigned (not addEventListener) every render -- selectEl itself persists across a
  // rows-only refresh, so this avoids stacking duplicate handlers on repeated add/remove.
  const availableTypes = wasteTypes.filter(wt => !proc.wastes.some(w => w.wasteTypeId === wt.id));
  selectEl.innerHTML = `<option value="">+ Add Waste…</option>` +
    availableTypes.map(wt => `<option value="${wt.id}">${wt.name} (${wt.default_percent}%)</option>`).join('') +
    `<option value="__create__">+ Create new waste type…</option>`;
  selectEl.value = '';
  selectEl.onchange = () => {
    const rawValue = selectEl.value;
    selectEl.value = ''; // always reset immediately -- both branches below act on the value themselves
    if (!rawValue) return;
    if (rawValue === '__create__') {
      showCreateWasteTypeForm(proc, wasteTypes, onChange);
      return;
    }
    const wasteTypeId = parseInt(rawValue, 10);
    const wt = wasteTypes.find(w => w.id === wasteTypeId);
    if (!wt) return;
    // originalPercent = the catalog default at the moment it was picked -- a freshly-added
    // EXISTING type has a meaningful "already-saved elsewhere" baseline (the catalog itself, and
    // potentially other recipes) the instant it's applied, unlike a brand-new type created via
    // "+ Create new waste type…" (see showCreateWasteTypeForm), which has none yet.
    proc.wastes.push({ localId: ++_recipeRowLocalIdCounter, wasteTypeId: wt.id, name: wt.name, percent: wt.default_percent, originalPercent: wt.default_percent });
    renderProcessWastes(proc, wasteTypes, onChange);
    onChange();
  };
}

// Fires ONLY on the row's own "Update" button click -- never automatically off typing or the
// input losing focus, so she can freely adjust the value (typing, spinner clicks, backspacing,
// retyping) with no prompt at any point until she deliberately asks for one. Compares against
// w.originalPercent -- the value this row's percentage carried the moment it last became
// "current" (loaded from a saved recipe via buildProcessFromSaved, or the catalog's
// default_percent at the moment an existing type was picked from "+ Add Waste"). A row with no
// originalPercent (added via "+ Create new waste type…") never shows the button at all -- a
// brand-new, not-yet-saved-anywhere type has no "already-saved elsewhere" for cascade/
// default-only to mean anything against.
async function onWastePercentUpdateClicked(proc, w, wasteTypes, onChange) {
  const newPct = parseFloat(w.percent);
  const oldPct = parseFloat(w.originalPercent);
  if (isNaN(newPct) || newPct === oldPct) return;

  const choice = await openChoiceModal({
    title: `Update "${w.name}"`,
    message: `You changed this process's "${w.name}" waste from ${oldPct}% to ${newPct}%.`,
    options: [
      { value: 'cascade', label: `Apply ${newPct}% to every recipe process using this waste type, and update the catalog default` },
      { value: 'default-only', label: `Update the default going forward, and use ${newPct}% here too — other existing recipes stay as they are` },
      { value: 'this-only', label: 'Apply only to this process — leave the catalog default and every other recipe untouched', default: true },
    ],
  });

  if (choice === 'cascade' || choice === 'default-only') {
    try {
      await window.api.updateWasteType({ id: w.wasteTypeId, name: w.name, defaultPercent: newPct, cascadeToExisting: choice === 'cascade' });
    } catch (err) {
      alert(`Couldn't update "${w.name}": ${err.message}`);
    }
  }

  // Every accepted choice (cascade, default-only, this-only) keeps this row's own edited value --
  // only a Cancel reverts it. What differs between the three is exclusively how far the write
  // reaches beyond this one row (every other process + catalog / catalog only / nowhere else).
  if (!choice) {
    w.percent = w.originalPercent; // cancelled -- revert in place
  } else {
    w.originalPercent = newPct; // new baseline for any further edit to this same row
  }
  // Either way the Update button must disappear again (the value now matches its new baseline,
  // whichever way that baseline moved) -- a full re-render is the simplest way to get that right
  // alongside the reverted-or-kept input value, same as add/remove already do.
  renderProcessWastes(proc, wasteTypes, onChange);
  onChange();
}

// Inline "+ Create new waste type…" form -- lets the chef add a brand-new catalog entry and
// apply it to this process in one action, without leaving the recipe form or opening the Waste
// Types modal. Name is matched case-insensitively against the already-loaded catalog before
// creating anything -- a match reuses that existing type rather than creating a near-duplicate;
// the waste row that then appears shows the catalog's own canonical name (e.g. typing "baking
// waste" produces a row reading "Baking Waste"), which doubles as the only surfacing this needs
// for the quiet-reuse case, no separate notice.
function showCreateWasteTypeForm(proc, wasteTypes, onChange) {
  const holder = document.getElementById(`ep-new-waste-${proc.localId}`);
  if (!holder) return;

  holder.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
      <input type="text" class="new-waste-name" placeholder="New waste type name" dir="auto" style="max-width:180px;" />
      <input type="number" class="new-waste-percent" placeholder="Default %" min="0" max="100" step="0.1" style="width:90px;" />
      <button type="button" class="primary new-waste-confirm">Add</button>
      <button type="button" class="secondary new-waste-cancel">Cancel</button>
    </div>
  `;
  const nameInput = holder.querySelector('.new-waste-name');
  const pctInput = holder.querySelector('.new-waste-percent');
  nameInput.focus();

  holder.querySelector('.new-waste-cancel').addEventListener('click', () => { holder.innerHTML = ''; });

  holder.querySelector('.new-waste-confirm').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const pct = parseFloat(pctInput.value);
    if (!name) return alert('Please enter a name for the new waste type.');
    if (isNaN(pct) || pct < 0 || pct > 100) return alert('Please enter a default % between 0 and 100.');

    let wasteType = wasteTypes.find(wt => wt.name.toLowerCase() === name.toLowerCase());
    if (!wasteType) {
      try {
        wasteType = await window.api.addWasteType({ name, defaultPercent: pct });
        wasteTypes.push(wasteType);
      } catch (err) {
        alert(`Couldn't create "${name}": ${err.message}`);
        return;
      }
    }

    if (proc.wastes.some(w => w.wasteTypeId === wasteType.id)) {
      alert(`"${wasteType.name}" is already applied to this process.`);
      return;
    }
    // The percentage she just typed is applied here regardless of whether the type was newly
    // created or reused -- she typed it for this use, it's never assumed to equal the catalog's
    // own default_percent (which stays untouched either way).
    proc.wastes.push({ localId: ++_recipeRowLocalIdCounter, wasteTypeId: wasteType.id, name: wasteType.name, percent: pct });
    holder.innerHTML = '';
    renderProcessWastes(proc, wasteTypes, onChange);
    onChange();
  });
}

// Parses the data: URL every photo preview in this app already holds in memory (manually
// uploaded or AI-generated -- both end up in this exact shape) back into raw base64 + a file
// extension, for handing to save-photo-to-computer. Returns null for anything unexpected rather
// than guessing, since a malformed parse would otherwise silently save a corrupt file.
function parseImageDataUrl(dataUrl) {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { ext: match[1] === 'png' ? 'png' : 'jpg', base64: match[2] };
}

// Full-size photo viewer -- shared by every recipe photo preview (Recipe Book/Generator's single
// preview, Recipe Extractor's gallery thumbnails), whether the photo was manually uploaded or AI-
// generated (see wireGeneratePhotoButton below): clicking a preview thumbnail (capped at 220px)
// currently has no way to see the photo any larger. Reuses .modal-overlay's own backdrop/z-index
// for visual consistency with every other overlay in this app, but skips the .modal card chrome
// entirely -- just the image itself, sized up to 90vw/90vh. Same backdrop-click-to-close
// convention openRecipePreviewModal already uses, plus Escape (nothing else in this app currently
// needs Escape-to-close, since every other modal has an explicit Close/Cancel button, but a
// full-bleed image viewer with no visible chrome besides one small × button benefits from it).
//
// `suggestedName` (typically the recipe's own current name, read live at click time by each
// call site) only backs the save dialog's default filename -- purely cosmetic, never required.
function openPhotoLightbox(src, suggestedName) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <button type="button" class="photo-lightbox-close" aria-label="Close">×</button>
    <button type="button" class="photo-lightbox-save">Save to Computer</button>
    <img class="photo-lightbox-img" src="${src}" />
  `;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKeyDown); };
  function onKeyDown(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKeyDown);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.photo-lightbox-close').addEventListener('click', close);

  const saveBtn = overlay.querySelector('.photo-lightbox-save');
  saveBtn.addEventListener('click', async () => {
    const parsed = parseImageDataUrl(src);
    if (!parsed) { alert("Couldn't read this photo's data."); return; }
    saveBtn.disabled = true;
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const result = await window.api.savePhotoToComputer({
        base64: parsed.base64, ext: parsed.ext, suggestedName,
      });
      if (!result.success && !result.cancelled) alert('Failed to save photo.');
    } catch (err) {
      alert(`Failed to save photo: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  });
}

// Shared "Generate Photo" wiring for Recipe Book, Recipe Extractor, and Recipe Generator's edit
// forms -- all three call this the same way: read whatever's CURRENTLY in the form (including
// unsaved edits, per the chef's own request -- `getRecipeInfo` reads live DOM/state, never a
// re-fetch of the saved recipe), ask the shared generate-recipe-photo IPC channel for a photo,
// and hand the result to `onGenerated` to drop into that form's own pending-photo slot -- the
// EXACT same slot manual upload already populates, so the existing Save button uploads it through
// that recipe type's own existing photo-upload path with zero changes there, and nothing is
// persisted until she actually clicks Save (same rule as any other form edit).
//
// Indeterminate progress panel (createProgressPanel), not a plain "Generating…" label -- a real
// call measured at ~138s end to end (see generateDishImage.js's own comment), so this needs to
// read as "working", not "stuck", the same way Recipe Extractor's own photo-extraction call
// already handles its own multi-second wait.
function wireGeneratePhotoButton({ buttonId, progressWrapId, getRecipeInfo, onGenerated }) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const info = getRecipeInfo();
    if (!info) return; // getRecipeInfo already alerted (e.g. missing recipe name)
    btn.disabled = true;
    const progressWrap = document.getElementById(progressWrapId);
    const panel = createProgressPanel(progressWrap, { label: 'Generating photo… this can take a couple of minutes.' });
    try {
      const result = await window.api.generateRecipePhoto(info);
      const mime = result.ext === 'png' ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${result.b64}`;
      onGenerated({ dataUrl, base64: result.b64, ext: result.ext });
    } catch (err) {
      alert(`Couldn't generate a photo: ${err.message}`);
    } finally {
      panel.destroy();
      if (document.body.contains(btn)) btn.disabled = false;
    }
  });
}

async function renderRecipeFormView(main, ns) {
  fillRecipePeopleList(); // Prepared By / Checked By suggestions -- not awaited, the boxes work without them
  const s = state[ns.stateKey];
  const editing = !!s.formId;
  let recipe = null;
  let existingPhotoDataUrl = null; // single-photo model only (Recipe Book)
  // Fetched once per form open (not per process) -- the same global catalog backs every
  // process card's "+ Add Waste" control on this form, Book and Extractor alike.
  const wasteTypes = await window.api.listWasteTypes();
  // Same one-fetch-per-form-open convention, backing every process card's Material/Tray picker.
  const materials = await window.api.listMaterials();

  if (editing) {
    recipe = await ns.api.get(s.formId);
    if (ns.photoModel === 'gallery') {
      // Guarded the same way s.processes is below -- avoids re-fetching/clobbering photos
      // already loaded into the live-editable gallery array if this ever runs again without
      // navigating away.
      if (s.existingPhotos.length === 0 && recipe.photos && recipe.photos.length > 0) {
        const dataUrls = await ns.api.getPhotos(recipe.photos.map(p => p.photo_path));
        s.existingPhotos = recipe.photos.map((p, i) => ({ ...p, dataUrl: dataUrls[i] }));
      }
    } else if (recipe.photo_path) {
      existingPhotoDataUrl = await ns.api.getPhoto(recipe.photo_path);
    }
    if (s.processes.length === 0) {
      s.processes = (recipe.processes && recipe.processes.length > 0)
        ? recipe.processes.map(buildProcessFromSaved)
        : [makeEmptyProcess()];
    }
  } else {
    // A New Recipe form opened via "Upload Recipe" carries extracted values here -- consumed
    // once (and cleared) so a later edit/new open starts blank. Fully editable before saving,
    // same review-before-save discipline either way.
    recipe = s.importedRecipe;
    s.importedRecipe = null;
    if (s.processes.length === 0) {
      const importedProcesses = recipe?.processes || [];
      s.processes = importedProcesses.length > 0
        ? importedProcesses.map(buildProcessFromImported)
        : [makeEmptyProcess()];
    }
  }

  initTextListField(s, TEXT_LIST_FIELDS.presentation, recipe?.presentation_serving);

  const currentPhotoSrc = s.pendingPhoto
    ? s.pendingPhoto.dataUrl
    : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${editing ? 'Edit Recipe' : 'New Recipe'}</h1>
        <span class="page-description">${editing ? recipe.code : `${ns.codeLabel} code assigned after saving`}</span>
      </div>
      <button class="secondary" id="rf-back-btn">${ns.backLabel}</button>
    </div>

    <div class="generate-controls">
      <div class="field recipe-name-field"><label>Recipe Name</label><input id="rf-name" value="${recipe?.name || ''}" dir="auto" /></div>
      <div class="field"><label>Quantity Produced</label><input id="rf-qty" value="${recipe?.quantity_produced || ''}" dir="auto" /></div>
      <div class="field"><label>Portion Weight (g)</label><input id="rf-portion-weight" type="number" min="0" step="0.1" value="${recipe?.portion_weight_grams ?? ''}" /></div>
      <div class="field"><label>Prepared By</label><input id="rf-prepared-by" list="recipe-people-list" value="${recipe?.prepared_by || ''}" dir="auto" /></div>
      <div class="field"><label>Category</label><input id="rf-category" value="${recipe?.category || ''}" dir="auto" /></div>
      <div class="field"><label>Country/Origin</label><input id="rf-country" value="${recipe?.country_origin || ''}" dir="auto" /></div>
      <div class="field"><label>Total Quantity (g)</label><input id="rf-total-qty" value="${recipe?.yield_notes || ''}" /></div>
      <div class="field"><label>Net Weight (sum of processes)</label><input id="rf-yield" value="${recipe?.yield_notes || ''}" /></div>
      <div class="field"><label>Portions Produced</label><div class="computed-value-box" id="rf-portions-produced">–</div></div>
      <div class="field"><label>Date</label><input id="rf-date" type="date" value="${recipe?.date_created || ''}" /></div>
    </div>
    <div style="color:var(--neutral); font-size:12px; margin:-14px 0 16px;">Editing a Total Quantity or Net Weight (here or on a process card below) rescales ingredient quantities -- permanent once you save.</div>

    <h3 style="margin-bottom:10px;">Processes</h3>
    <div id="ep-process-list"></div>
    <button class="secondary" id="ep-add-process-btn" style="margin:10px 0 24px;">+ Add Process</button>

    <div class="field" style="margin-bottom:16px;">
      <label>Presentation / Decoration / Serving</label>
      <div id="rf-presentation-field"></div>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Comment</label>
      <textarea id="rf-comment" rows="3" dir="auto">${recipe?.comment || ''}</textarea>
    </div>
    ${ns.photoModel === 'gallery' ? `
    <div class="field" style="margin-bottom:20px;">
      <label>Photos (up to 10)</label>
      <div id="rf-photo-gallery" class="photo-gallery"></div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <input type="file" id="rf-photo-input" accept="image/jpeg,image/png" multiple />
        <button type="button" class="secondary" id="rf-generate-photo-btn">Generate Photo</button>
      </div>
      <div id="rf-generate-photo-progress-wrap" style="margin-top:8px;"></div>
    </div>
    ` : `
    <div class="field" style="margin-bottom:16px; max-width:320px;">
      <label>Upload Photo</label>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <input type="file" id="rf-photo-input" accept="image/jpeg,image/png" />
        <button type="button" class="secondary" id="rf-generate-photo-btn">Generate Photo</button>
      </div>
      <div id="rf-generate-photo-progress-wrap" style="margin-top:8px;"></div>
      <div id="rf-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="rf-photo-preview" src="${currentPhotoSrc || ''}" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block; cursor:zoom-in;" title="Click to view full size" />
        <button type="button" class="secondary" id="rf-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>
    `}
    <div class="field" style="margin-bottom:20px; max-width:320px;">
      <label>Checked By</label>
      <input id="rf-checked-by" list="recipe-people-list" value="${recipe?.checked_by || ''}" dir="auto" />
    </div>

    <button class="primary" id="rf-save-btn">${editing ? 'Save Changes' : 'Save Recipe'}</button>
    <span id="rf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  // Reads live form state, including any unsaved edits -- s.processes is the same in-memory array
  // saveProcessRecipeForm itself reads from, kept in sync with every ingredient/method input's own
  // 'input' listener as she types (see renderProcessCards below), so this never needs a re-fetch.
  function getRecipeInfoForPhoto() {
    const name = document.getElementById('rf-name').value.trim();
    if (!name) { alert('Please enter a recipe name first.'); return null; }
    const category = document.getElementById('rf-category').value.trim() || undefined;
    const ingredients = s.processes.flatMap(proc => proc.ingredientRows
      .filter(r => r.name.trim() !== '')
      .map(r => r.name.trim()));
    const method = s.processes
      .map(proc => collectTextListFieldValue(proc, makeProcessMethodCfg(proc)))
      .filter(Boolean)
      .join('; ') || undefined;
    return { dishName: name, category, ingredients, method };
  }

  if (ns.photoModel === 'gallery') {
    function totalPhotoCount() {
      return s.existingPhotos.length + s.pendingPhotos.length;
    }

    // Existing (already-saved) and pending (freshly added, not yet uploaded) photos are rendered
    // as one combined, ordered strip of thumbnails -- removing either kind just splices it out
    // of its own array (same "live editable array" convention as processes), no separate
    // remove-flag bookkeeping needed the way the single-photo pendingPhoto/removePhoto pair below
    // uses.
    function renderPhotoGallery() {
      const gallery = document.getElementById('rf-photo-gallery');
      const tiles = [
        ...s.existingPhotos.map(p => ({ kind: 'existing', key: p.id, src: p.dataUrl })),
        ...s.pendingPhotos.map(p => ({ kind: 'pending', key: p.localId, src: p.dataUrl })),
      ];
      gallery.innerHTML = tiles.length > 0
        ? tiles.map((t, i) => `
            <div class="photo-thumb">
              <img src="${t.src}" data-lightbox-index="${i}" style="cursor:zoom-in;" title="Click to view full size" />
              <button type="button" class="photo-thumb-remove" data-remove-photo="${t.kind}:${t.key}" title="Remove photo">×</button>
            </div>
          `).join('')
        : `<div class="photo-gallery-empty">No photos yet.</div>`;

      gallery.querySelectorAll('[data-remove-photo]').forEach(btn => {
        btn.addEventListener('click', () => {
          const [kind, key] = btn.dataset.removePhoto.split(':');
          if (kind === 'existing') {
            s.existingPhotos = s.existingPhotos.filter(p => String(p.id) !== key);
          } else {
            s.pendingPhotos = s.pendingPhotos.filter(p => String(p.localId) !== key);
          }
          renderPhotoGallery();
        });
      });
      gallery.querySelectorAll('[data-lightbox-index]').forEach(img => {
        img.addEventListener('click', () => openPhotoLightbox(
          tiles[parseInt(img.dataset.lightboxIndex, 10)].src,
          document.getElementById('rf-name').value.trim(),
        ));
      });
    }

    document.getElementById('rf-photo-input').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';

      let remaining = 10 - totalPhotoCount();
      let hitCap = false;
      for (const file of files) {
        if (remaining <= 0) { hitCap = true; break; }
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
          alert(`"${file.name}" isn't a JPG or PNG image and was skipped.`);
          continue;
        }
        if (file.size > 5 * 1024 * 1024) {
          alert(`"${file.name}" is larger than 5MB and was skipped.`);
          continue;
        }
        remaining -= 1;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(',')[1];
          const ext = file.type === 'image/png' ? 'png' : 'jpeg';
          s.pendingPhotos.push({ localId: ++_recipeRowLocalIdCounter, dataUrl, base64, ext });
          renderPhotoGallery();
        };
        reader.readAsDataURL(file);
      }
      if (hitCap) alert('You can attach up to 10 photos per recipe.');
    });

    wireGeneratePhotoButton({
      buttonId: 'rf-generate-photo-btn',
      progressWrapId: 'rf-generate-photo-progress-wrap',
      getRecipeInfo: getRecipeInfoForPhoto,
      onGenerated: ({ dataUrl, base64, ext }) => {
        if (totalPhotoCount() >= 10) { alert('You can attach up to 10 photos per recipe.'); return; }
        s.pendingPhotos.push({ localId: ++_recipeRowLocalIdCounter, dataUrl, base64, ext });
        renderPhotoGallery();
      },
    });

    renderPhotoGallery();
  } else {
    function updatePhotoPreview() {
      const src = s.pendingPhoto
        ? s.pendingPhoto.dataUrl
        : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);
      document.getElementById('rf-photo-preview-wrap').style.display = src ? '' : 'none';
      document.getElementById('rf-photo-preview').src = src || '';
    }
    document.getElementById('rf-photo-preview').addEventListener('click', () => {
      const src = document.getElementById('rf-photo-preview').src;
      if (src) openPhotoLightbox(src, document.getElementById('rf-name').value.trim());
    });

    document.getElementById('rf-photo-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        alert('Please choose a JPG or PNG image.');
        e.target.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert('Photo must be 5MB or smaller.');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const ext = file.type === 'image/png' ? 'png' : 'jpeg';
        s.pendingPhoto = { dataUrl, base64, ext };
        s.removePhoto = false;
        updatePhotoPreview();
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('rf-photo-remove-btn').addEventListener('click', () => {
      s.pendingPhoto = null;
      s.removePhoto = true;
      document.getElementById('rf-photo-input').value = '';
      updatePhotoPreview();
    });

    wireGeneratePhotoButton({
      buttonId: 'rf-generate-photo-btn',
      progressWrapId: 'rf-generate-photo-progress-wrap',
      getRecipeInfo: getRecipeInfoForPhoto,
      onGenerated: ({ dataUrl, base64, ext }) => {
        s.pendingPhoto = { dataUrl, base64, ext };
        s.removePhoto = false;
        updatePhotoPreview();
      },
    });
  }

  function renderProcessCards() {
    const container = document.getElementById('ep-process-list');
    container.innerHTML = s.processes.map((proc, idx) => `
      <div class="process-card" data-process="${proc.localId}">
        <div class="process-card-head">
          <input aria-label="Process name" placeholder="Name this process, e.g. dough or filling" class="process-name-input" value="${proc.name}" dir="auto" />
          <button type="button" class="icon-btn" data-move-process-up="${proc.localId}" title="Move process up" aria-label="Move process up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="icon-btn" data-move-process-down="${proc.localId}" title="Move process down" aria-label="Move process down" ${idx === s.processes.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="icon-btn danger" data-remove-process="${proc.localId}" ${s.processes.length <= 1 ? 'disabled' : ''}>Remove Process</button>
        </div>
        <table class="recipe-ingredients-table">
          <thead><tr><th></th><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Note</th><th></th></tr></thead>
          <tbody class="process-ing-rows"></tbody>
        </table>
        <button type="button" class="secondary process-add-row-btn" style="margin:8px 0 16px;">+ Add Ingredient Row</button>
        <div class="field" style="max-width:220px; margin-bottom:14px;">
          <label>Total Quantity</label>
          <input id="ep-total-${proc.localId}" />
        </div>
        <div class="field" style="margin-bottom:14px;">
          <label>Wastes Applied</label>
          <div class="process-waste-rows" id="ep-wastes-${proc.localId}"></div>
          <select class="builder-select process-add-waste-select" data-add-waste="${proc.localId}" style="margin-top:6px; max-width:240px;">
            <option value="">+ Add Waste…</option>
          </select>
          <div id="ep-new-waste-${proc.localId}"></div>
        </div>
        <div class="field" style="max-width:220px; margin-bottom:14px;">
          <label>Net Weight</label>
          <input id="ep-yield-${proc.localId}" />
        </div>
        <div class="field" style="max-width:280px; margin-bottom:14px;">
          <label>Material / Tray</label>
          <select class="builder-select" id="ep-material-${proc.localId}">
            <option value="">— None —</option>
            ${materials.map(m => `<option value="${m.id}" ${proc.materialId === m.id ? 'selected' : ''}>${m.code} — ${m.name}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="max-width:220px; margin-bottom:14px; display:${proc.materialId ? 'flex' : 'none'};" id="ep-material-fill-wrap-${proc.localId}">
          <label>Fill Weight (g)</label>
          <input type="number" min="0" step="0.1" id="ep-material-fill-${proc.localId}" value="${proc.materialFillWeightGrams ?? ''}" />
        </div>
        <div class="field" style="max-width:220px; margin-bottom:14px; display:${proc.materialId ? 'flex' : 'none'};" id="ep-trays-wrap-${proc.localId}">
          <label>Trays Needed</label>
          <div class="computed-value-box" id="ep-trays-${proc.localId}">–</div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Method</label>
          <div id="${makeProcessMethodCfg(proc).mountId}"></div>
        </div>
      </div>
    `).join('');

    s.processes.forEach(proc => {
      const card = container.querySelector(`[data-process="${proc.localId}"]`);

      const nameInput = card.querySelector('.process-name-input');
      nameInput.addEventListener('input', () => { proc.name = nameInput.value; });

      card.querySelector('[data-remove-process]').addEventListener('click', () => {
        s.processes = s.processes.filter(p => p.localId !== proc.localId);
        if (s.processes.length === 0) s.processes.push(makeEmptyProcess());
        renderProcessCards();
      });

      // Swaps this process with its neighbor in s.processes -- same "reorder the array, then
      // renumber sort_order from array position on save" convention ingredient-row reordering
      // already uses. Up/down buttons (not drag-and-drop) since process cards are tall, few in
      // number, and full of nested interactive content -- see conversation notes.
      const moveUpBtn = card.querySelector('[data-move-process-up]');
      const moveDownBtn = card.querySelector('[data-move-process-down]');
      moveUpBtn.addEventListener('click', () => {
        const i = s.processes.findIndex(p => p.localId === proc.localId);
        if (i <= 0) return;
        [s.processes[i - 1], s.processes[i]] = [s.processes[i], s.processes[i - 1]];
        renderProcessCards();
      });
      moveDownBtn.addEventListener('click', () => {
        const i = s.processes.findIndex(p => p.localId === proc.localId);
        if (i === -1 || i >= s.processes.length - 1) return;
        [s.processes[i], s.processes[i + 1]] = [s.processes[i + 1], s.processes[i]];
        renderProcessCards();
      });

      const tbody = card.querySelector('.process-ing-rows');
      const onIngredientChange = () => updateNetWeightSum(ns);
      renderProcessIngredientRows(ns, proc, tbody, onIngredientChange);

      card.querySelector('.process-add-row-btn').addEventListener('click', () => {
        proc.ingredientRows.push(makeEmptyIngredientRow());
        renderProcessIngredientRows(ns, proc, tbody, onIngredientChange);
      });

      // LEVEL 1 -- editing THIS process's own Total Quantity rescales only its own ingredients
      // (computeMultiplierFromTarget/scaleIngredients, same formula Calculator/Recipe Generator
      // already use -- not reimplemented here) and never touches any other process. Re-rendering
      // just this process's ingredient rows (not a full renderProcessCards()) is exactly the same
      // scoped-update pattern "+ Add Ingredient Row" above already uses; onIngredientChange's own
      // updateNetWeightSum(ns) call (fired from inside renderProcessIngredientRows) is what flows
      // the new combined total/Net Weight/Portions Produced UP to the recipe level as a re-sum,
      // not a second rescale. Fires on 'change' (blur/Enter), not per-keystroke.
      card.querySelector(`#ep-total-${proc.localId}`).addEventListener('change', (e) => {
        const result = computeMultiplierFromTarget(proc.ingredientRows, e.target.value);
        if (result.error) {
          alert(result.error);
          updateNetWeightSum(ns); // revert the displayed value back to the real current total
          return;
        }
        proc.ingredientRows = scaleIngredients(proc.ingredientRows, result.multiplier);
        renderProcessIngredientRows(ns, proc, tbody, onIngredientChange);
      });

      // LEVEL 1, Net Weight -- back-solves the Total Quantity this process would need (through
      // ITS OWN current waste %, held fixed) to produce the typed Net Weight, then hands that
      // number to the exact same rescale above -- see computeTargetTotalQuantityFromNetWeight's
      // own comment. Same "this process only, flows up as a re-sum" direction as Total Quantity.
      card.querySelector(`#ep-yield-${proc.localId}`).addEventListener('change', (e) => {
        const backSolve = computeTargetTotalQuantityFromNetWeight(processRetentionFactor(proc.wastes), e.target.value);
        if (backSolve.error) {
          alert(backSolve.error);
          updateNetWeightSum(ns);
          return;
        }
        const solved = scaleSetsToNetWeight([proc.ingredientRows], [proc.wastes], backSolve.targetTotalQuantity, e.target.value);
        if (solved.error) {
          alert(solved.error);
          updateNetWeightSum(ns);
          return;
        }
        proc.ingredientRows = solved.sets[0];
        renderProcessIngredientRows(ns, proc, tbody, onIngredientChange);
      });

      renderProcessWastes(proc, wasteTypes, () => updateNetWeightSum(ns));

      // Material/Tray link -- 1:1 per process (see Phase C design notes), not a multi-add list
      // like Wastes Applied above, so a plain <select> is enough. Fill Weight always resets to
      // the newly-picked material's own catalog weight_grams when the material changes (never
      // silently keeps a stale value from a previously-selected, differently-sized tray); it's
      // then freely editable per this one process without ever writing back to `materials`.
      const materialSelect = card.querySelector(`#ep-material-${proc.localId}`);
      const fillInput = card.querySelector(`#ep-material-fill-${proc.localId}`);
      const fillWrap = card.querySelector(`#ep-material-fill-wrap-${proc.localId}`);
      const traysWrap = card.querySelector(`#ep-trays-wrap-${proc.localId}`);
      materialSelect.addEventListener('change', () => {
        const id = materialSelect.value ? parseInt(materialSelect.value, 10) : null;
        proc.materialId = id;
        const mat = materials.find(m => m.id === id);
        proc.materialFillWeightGrams = mat ? materialCapacityGrams(mat) : null;
        fillInput.value = proc.materialFillWeightGrams ?? '';
        fillWrap.style.display = id ? 'flex' : 'none';
        traysWrap.style.display = id ? 'flex' : 'none';
        updateProcessNetWeight(proc);
      });
      fillInput.addEventListener('input', () => {
        const v = parseFloat(fillInput.value);
        proc.materialFillWeightGrams = isNaN(v) ? null : v;
        updateProcessNetWeight(proc);
      });

      renderTextListFieldBody(proc, makeProcessMethodCfg(proc));
    });

    updateNetWeightSum(ns);
  }

  document.getElementById('rf-back-btn').addEventListener('click', () => goBackToRecipeList(ns));
  document.getElementById('ep-add-process-btn').addEventListener('click', () => {
    s.processes.push(makeEmptyProcess());
    renderProcessCards();
  });
  document.getElementById('rf-save-btn').addEventListener('click', () => saveProcessRecipeForm(ns));
  // Portions Produced depends on this field but isn't stored on the process rows themselves, so
  // it needs its own listener rather than piggybacking on renderProcessCards' ingredient/waste
  // change handlers.
  document.getElementById('rf-portion-weight').addEventListener('input', () => updateNetWeightSum(ns));

  // LEVEL 2 -- editing the recipe-level Total Quantity computes ONE multiplier from the
  // combined sum across EVERY process's ingredients and rescales all of them uniformly
  // together (Calculator's own DEFAULT "scale all processes together" mode -- independent
  // per-process scaling stays a Calculator-only capability, not offered here). A full
  // renderProcessCards() re-render reflects every process's own Total Quantity/Net Weight as a
  // derived result of the rescale, same as add/remove/reorder process already trigger.
  document.getElementById('rf-total-qty').addEventListener('change', (e) => {
    const allRows = s.processes.flatMap(p => p.ingredientRows);
    const result = computeMultiplierFromTarget(allRows, e.target.value);
    if (result.error) {
      alert(result.error);
      updateNetWeightSum(ns); // revert the displayed value back to the real current total
      return;
    }
    const scaledSets = scaleIngredientSets(s.processes.map(p => p.ingredientRows), result.multiplier);
    s.processes.forEach((proc, i) => { proc.ingredientRows = scaledSets[i]; });
    renderProcessCards();
  });

  // LEVEL 2, Net Weight -- back-solves ONE recipe-level target Total Quantity through the
  // CURRENT implied aggregate retention factor (combinedNetWeight / combinedTotalQuantity, i.e.
  // what fraction of the whole recipe currently survives every process's own waste %), then
  // rescales every process uniformly by the resulting multiplier -- same mechanism as the
  // Total Quantity field just above, just entered from the Net Weight side.
  document.getElementById('rf-yield').addEventListener('change', (e) => {
    const combinedTotal = s.processes.reduce((acc, proc) => acc + sumIngredientQuantities(proc.ingredientRows), 0);
    const combinedNet = s.processes.reduce((acc, proc) => acc + compoundWasteYield(sumIngredientQuantities(proc.ingredientRows), proc.wastes), 0);
    const impliedRetention = combinedTotal > 0 ? combinedNet / combinedTotal : 0;
    const backSolve = computeTargetTotalQuantityFromNetWeight(impliedRetention, e.target.value);
    if (backSolve.error) {
      alert(backSolve.error);
      updateNetWeightSum(ns);
      return;
    }
    const solved = scaleSetsToNetWeight(s.processes.map(p => p.ingredientRows), s.processes.map(p => p.wastes), backSolve.targetTotalQuantity, e.target.value);
    if (solved.error) {
      alert(solved.error);
      updateNetWeightSum(ns);
      return;
    }
    s.processes.forEach((proc, i) => { proc.ingredientRows = solved.sets[i]; });
    renderProcessCards();
  });

  renderProcessCards();
  // Overrides dirAuto per-call rather than setting it on TEXT_LIST_FIELDS.presentation itself,
  // since that config object is used for this same field's init above too.
  renderTextListFieldBody(s, { ...TEXT_LIST_FIELDS.presentation, dirAuto: true });
}

async function saveProcessRecipeForm(ns) {
  const s = state[ns.stateKey];
  const name = document.getElementById('rf-name').value.trim();
  if (!name) return alert('Please enter a recipe name.');

  // Recipe Book requires every ingredient row to already be linked to a real ingredientId
  // (picked from the dropdown or added inline) before saving. Recipe Extractor skips this block
  // entirely -- ns.api.save auto-resolves/creates unlinked rows by name server-side instead, so
  // it's never stopped by this.
  if (ns.requireIngredientLink) {
    for (const proc of s.processes) {
      for (let i = 0; i < proc.ingredientRows.length; i++) {
        const row = proc.ingredientRows[i];
        if (row.name.trim() !== '' && !row.ingredientId) {
          const label = proc.name.trim() || 'this process';
          return alert(`"${label}", row ${i + 1}: please pick "${row.name}" from the dropdown (or add it as a new ingredient) before saving.`);
        }
      }
    }
  }

  const statusEl = document.getElementById('rf-status');
  statusEl.textContent = 'Saving…';

  const payload = {
    id: s.formId || undefined,
    name,
    quantityProduced: document.getElementById('rf-qty').value.trim(),
    // Numeric (unlike the rest of this payload's free-text fields) -- parsed here rather than
    // left as a string, since main.js writes it straight into a numeric column with no parsing
    // of its own. Blank stays null, never NaN or 0.
    portionWeightGrams: (() => {
      const raw = document.getElementById('rf-portion-weight').value.trim();
      return raw === '' ? null : parseFloat(raw);
    })(),
    preparedBy: document.getElementById('rf-prepared-by').value.trim(),
    category: document.getElementById('rf-category').value.trim(),
    countryOrigin: document.getElementById('rf-country').value.trim(),
    yieldNotes: document.getElementById('rf-yield').value.trim(),
    dateCreated: document.getElementById('rf-date').value,
    presentationServing: collectTextListFieldValue(s, TEXT_LIST_FIELDS.presentation),
    comment: document.getElementById('rf-comment').value,
    checkedBy: document.getElementById('rf-checked-by').value.trim(),
    processes: s.processes.map(proc => ({
      name: proc.name.trim(),
      method: collectTextListFieldValue(proc, makeProcessMethodCfg(proc)),
      materialId: proc.materialId || null,
      materialFillWeightGrams: proc.materialId ? (proc.materialFillWeightGrams ?? null) : null,
      wastes: proc.wastes.map(w => {
        const pct = parseFloat(w.percent);
        return { wasteTypeId: w.wasteTypeId, percent: isNaN(pct) ? 0 : pct };
      }),
      ingredients: proc.ingredientRows
        .filter(r => r.name.trim() !== '')
        .map(r => ({
          ingredientId: r.ingredientId,
          name: r.name.trim(),
          quantity: r.quantity ? parseFloat(r.quantity) : null,
          unit: r.unit || null,
          method: r.method || null,
        })),
    })),
  };

  if (ns.photoModel === 'gallery') {
    // Ordered list of kept-existing + newly-added photos -- save-extracted-recipe clears and
    // reinserts extracted_recipe_photos from this array (same convention as processes above),
    // purging from Storage any existing photo that's no longer present.
    payload.photos = [
      ...s.existingPhotos.map(p => ({ existingPhotoPath: p.photo_path })),
      ...s.pendingPhotos.map(p => ({ photoBase64: p.base64, photoExt: p.ext })),
    ];
  } else if (s.pendingPhoto) {
    payload.photoBase64 = s.pendingPhoto.base64;
    payload.photoExt = s.pendingPhoto.ext;
  } else if (s.removePhoto) {
    payload.removePhoto = true;
  }

  try {
    await ns.api.save(payload);
    goBackToRecipeList(ns);
  } catch (err) {
    statusEl.textContent = '';
    alert(`Save failed: ${err.message}`);
  }
}

// ============================================================
// RECIPE GENERATOR -- AI-generates a full ~150g reference recipe per dish pulled from an
// uploaded menu file (main.js's parse-and-generate-recipes), for every dish EXCEPT Bread/Milk/
// Juice (and the already-established Fruit Basket/Fruit Bar/Salad Bar/Water/Soft Drinks
// exclusions) -- see lib/recipeGenerator.js's isExcludedCategory/isReadyMadeItem. Two tabs: Drafts (generated_recipes rows
// with status='draft', reviewed/edited before being confirmed) and Recipe Generated (status=
// 'confirmed', an RG- code assigned the moment she confirms). Both tabs drill into the SAME
// bespoke edit form (renderGeneratedRecipeFormView) when a row is opened -- reviewing a draft
// and editing an already-confirmed recipe are the same screen, just with a different set of save
// buttons at the bottom (see that function).
//
// Deliberately NOT built on renderRecipeListView/renderRecipeFormView (Book/Extractor's shared
// screens) -- those assume Material/Tray linking, Waste %, a photo, and a catalog-aware
// ingredient autocomplete, none of which apply here (generated_recipe_processes has no material/
// waste columns at all -- see the migration's own comment -- and ingredients must never be
// catalog-linked, ever). RECIPE_NS.generated is still used for everything that DOES carry over
// unmodified: list/get/save/delete/preview/export IPC wiring, and Recipe Calculator's third
// source (see currentNs() below).
// ============================================================

function renderRecipeGeneratorView(main) {
  const ns = RECIPE_NS.generated;
  const s = state[ns.stateKey];
  if (s.view === 'form') return renderGeneratedRecipeFormView(main, ns);
  return renderRecipeGeneratorTabs(main, ns);
}

async function renderRecipeGeneratorTabs(main, ns) {
  const s = state[ns.stateKey];
  main.innerHTML = `
    <div class="topbar">
      <div><h1>${ns.title}</h1><span class="page-description">${ns.subtitle}</span></div>
      <div class="action-toolbar">
        <button class="primary" id="rg-upload-btn">${s.fileName ? 'Upload a Different File' : 'Upload Menu File'}</button>
      </div>
    </div>
    <input type="file" id="rg-file-input" accept=".xlsx" hidden />
    <div id="rg-progress-wrap"></div>
    ${s.fileName ? `<div style="color:var(--sage-dark); font-size:12.5px; margin:-10px 0 14px;">Last upload: "${s.fileName}"</div>` : ''}
    <div class="mode-toggle" style="margin-bottom:16px; max-width:360px;">
      <button type="button" class="mode-toggle-btn ${s.activeTab === 'drafts' ? 'active' : ''}" data-rg-tab="drafts">Drafts</button>
      <button type="button" class="mode-toggle-btn ${s.activeTab === 'generated' ? 'active' : ''}" data-rg-tab="generated">Recipe Generated</button>
    </div>
    <div id="rg-tab-content"></div>
  `;

  document.getElementById('rg-upload-btn').addEventListener('click', () => {
    document.getElementById('rg-file-input').click();
  });
  document.getElementById('rg-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const uploadBtn = document.getElementById('rg-upload-btn');
    uploadBtn.disabled = true;
    const uploadToken = crypto.randomUUID();
    s.uploadToken = uploadToken;
    const progressWrap = document.getElementById('rg-progress-wrap');
    const panel = createProgressPanel(progressWrap, { label: 'Reading file…' });
    const unsubscribe = window.api.onRecipeGeneratorProgress((payload) => panel.update(payload));
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const result = await window.api.parseAndGenerateRecipes({ base64, uploadToken, fileName: file.name });
      if (uploadToken !== s.uploadToken) return; // superseded by a newer upload
      if (!result.success) {
        if (!result.cancelled) alert(`Couldn't process this file: ${result.error}`);
        return;
      }
      s.fileName = file.name;
      const warningNote = result.failures && result.failures.length
        ? `\n\n${result.failures.length} warning(s) -- see the app logs for details.` : '';
      // No cross-upload skip anymore (removed per the chef's own explicit request) -- every
      // eligible dish in this upload gets its own recipe every time, regardless of whether a
      // similar one already exists from an earlier upload. dishCount can still exceed
      // createdCount when a batch genuinely failed/timed out (see `failures`), not because
      // anything was intentionally skipped.
      const summary = `Generated ${result.createdCount} of ${result.dishCount} eligible recipe(s).`;
      alert(`${summary} Review them in the Drafts tab.${warningNote}`);
      s.activeTab = 'drafts';
      s.draftFolder = null;
      renderRecipeGeneratorTabs(main, ns);
    } catch (err) {
      alert(`Couldn't process this file: ${err.message}`);
    } finally {
      unsubscribe();
      panel.destroy();
      if (document.body.contains(uploadBtn)) uploadBtn.disabled = false;
    }
  });

  document.querySelectorAll('[data-rg-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.rgTab === s.activeTab) return;
      s.activeTab = btn.dataset.rgTab;
      renderRecipeGeneratorTabs(main, ns);
    });
  });

  const content = document.getElementById('rg-tab-content');
  if (s.activeTab === 'drafts') await renderGeneratedDraftsList(content, ns, main);
  else await renderGeneratedConfirmedList(content, ns, main);
  // Back from a draft's review form (or after a delete): put the page back where it was. The list is fully rendered by now, so the
  // height is right; `instant` because .main has smooth scrolling, which would visibly glide down from the top instead.
  if (s.returnScroll != null) {
    const top = s.returnScroll;
    s.returnScroll = null;
    main.scrollTo({ top, behavior: 'instant' });
  }
}

// Drafts' day headings ("Monday 27-09-2026", or just "Monday", or nothing) must read in calendar order. The groups used to come out
// in first-seen order, which follows when each dish happened to finish generating (dishes are generated in parallel batches), so
// 30-09 could land above 29-09. Sorted here instead: dated labels by date (year, month, day -- so a menu that runs over a month
// end stays in order), then weekday-only labels Sunday..Saturday, then the "No day recorded" group; ties keep first-seen order.
const WEEKDAY_ORDER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function dayGroupSortKey(label) {
  const text = String(label || '');
  const d = text.match(/(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?/);
  if (d) {
    const year = d[3] ? (d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3])) : 0;
    return [0, year, Number(d[2]), Number(d[1])];
  }
  const wd = WEEKDAY_ORDER.findIndex(w => text.toLowerCase().includes(w));
  return wd >= 0 ? [1, wd, 0, 0] : [2, 0, 0, 0];
}
function sortDayGroups(entries) { // entries: [[dayLabel|null, rows], ...] in first-seen order
  return entries
    .map((entry, i) => ({ entry, i, key: dayGroupSortKey(entry[0]) }))
    .sort((a, b) => { for (let k = 0; k < 4; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return a.i - b.i; })
    .map(x => x.entry);
}

// "Prepared By" / "Checked By" suggestions. The boxes are free text; each carries list="recipe-people-list", and this fills that one
// <datalist> (kept in <body>, so it survives screen changes) with every name already used on a recipe plus Tetiana -- see the
// list-recipe-people handler in main.js. Called whenever one of those forms opens, so a name typed and saved on one recipe is
// offered on the next. Falls back to Tetiana alone if the lookup fails: the suggestion list must never block a form.
async function fillRecipePeopleList() {
  let list = document.getElementById('recipe-people-list');
  if (!list) { list = document.createElement('datalist'); list.id = 'recipe-people-list'; document.body.appendChild(list); }
  let names;
  try { names = await window.api.listRecipePeople(); } catch { names = ['Tetiana']; }
  list.textContent = '';
  for (const name of names) { const o = document.createElement('option'); o.value = name; list.appendChild(o); }
}

// Category filter shared by the Recipe Generator's Drafts table and its Recipe Generated list. `category` is a plain text column
// (set from the menu's own category heading, editable on the recipe), so the options are the distinct values in use, compared
// ignoring case and extra spaces ("Main Dish" and "main dish " are one option, shown as first seen). Recipes with no category
// are reachable through "Uncategorized", the same convention as the Ingredients view.
const categoryFilterKey = (c) => String(c || '').trim().replace(/\s+/g, ' ').toLowerCase();
const matchesCategoryFilter = (recipe, key) => !key || (key === UNCATEGORIZED_FILTER_VALUE ? !categoryFilterKey(recipe.category) : categoryFilterKey(recipe.category) === key);
// Fills `selectEl` and shows it, or leaves it hidden when there is nothing to choose between. Returns the option value now in
// effect ('' when `wantedKey` no longer exists in this list).
function fillCategoryFilter(selectEl, list, wantedKey = '') {
  const options = new Map(); // key -> { label, count }
  let uncategorized = 0;
  for (const r of list) {
    const key = categoryFilterKey(r.category);
    if (!key) { uncategorized++; continue; }
    if (!options.has(key)) options.set(key, { label: String(r.category).trim().replace(/\s+/g, ' '), count: 0 });
    options.get(key).count++;
  }
  selectEl.textContent = '';
  if (options.size + (uncategorized > 0 ? 1 : 0) < 2) { selectEl.hidden = true; return ''; }
  const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; selectEl.appendChild(o); };
  add('', 'All Categories');
  if (uncategorized > 0) add(UNCATEGORIZED_FILTER_VALUE, `Uncategorized (${uncategorized})`);
  [...options.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label)).forEach(([key, o]) => add(key, `${o.label} (${o.count})`));
  selectEl.value = [...selectEl.options].some(o => o.value === wantedKey) ? wantedKey : '';
  selectEl.hidden = false;
  return selectEl.value;
}

// Drafts are grouped into per-menu "folders" (requirement: don't mix every upload's drafts into
// one flat list) keyed by source_menu_label -- a pure client-side grouping of whatever
// listGeneratedRecipeDrafts() currently returns, not a separately persisted entity (there's no
// "folder" row anywhere in the schema). state[ns.stateKey].draftFolder is null for the folder
// list, or a label string to drill into that one menu's own drafts -- same list<->detail idiom
// the review form's own back button already uses one level up, not a new interaction style.
async function renderGeneratedDraftsList(container, ns, main) {
  const s = state[ns.stateKey];
  container.innerHTML = '<div class="loading-state" role="status">Loading recipes…</div>';
  const drafts = await window.api.listGeneratedRecipeDrafts();
  if (s.draftFolder !== null) return renderDraftFolderContents(container, ns, main, drafts, s.draftFolder);
  return renderDraftFolderList(container, ns, main, drafts);
}

// One row per source_menu_label present among today's drafts, with a live count of how many of
// its rows are still pending review. Every row listGeneratedRecipeDrafts() returns already has
// status='draft' (its own query filters to that), so "pending" and "present in this list" are the
// same thing -- no separate reviewed/unreviewed sub-state needed, the count is just the group's
// size. A folder that empties out (every draft inside it confirmed or deleted) simply stops
// appearing here on the next render -- same as how a single confirmed draft already vanishes from
// the old flat list today; there's no persisted folder to separately hide/keep around.
function renderDraftFolderList(container, ns, main, drafts) {
  if (drafts.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="display">No drafts yet</div>Click "Upload Menu File" above to generate recipes from a menu.</div>`;
    return;
  }
  const bySource = new Map();
  for (const d of drafts) {
    const key = d.source_menu_label || 'Unknown source';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(d);
  }
  // Most recently generated menu first -- same recency ordering the old flat list's own
  // `order('created_at', { ascending: false })` gave, just applied per-group.
  const folders = [...bySource.entries()]
    .map(([label, rows]) => ({ label, rows, latest: Math.max(...rows.map(r => new Date(r.created_at).getTime())) }))
    .sort((a, b) => b.latest - a.latest);

  container.innerHTML = `
    <div class="table-scroll"><table class="recipes-table rg-drafts-table">
      <thead><tr><th>Source Menu</th><th>Pending Review</th><th></th></tr></thead>
      <tbody>
        ${folders.map((f, i) => `
          <tr>
            <td>${f.label}</td>
            <td>${f.rows.length} to review</td>
            <td style="text-align:right"><button class="icon-btn" data-rg-open-folder="${i}">Open</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table></div>
  `;
  container.querySelectorAll('[data-rg-open-folder]').forEach(btn => {
    btn.addEventListener('click', () => {
      state[ns.stateKey].draftFolder = folders[parseInt(btn.dataset.rgOpenFolder, 10)].label;
      renderRecipeGeneratorTabs(main, ns);
    });
  });
}

// One menu's own drafts -- identical row markup/Review/Delete actions the old flat list always
// had, just pre-filtered to one source_menu_label, fronted by a back link that plays the same
// role as the review form's own "<- Back to Recipe Generator" button.
function renderDraftFolderContents(container, ns, main, drafts, folderLabel) {
  const rows = drafts.filter(d => (d.source_menu_label || 'Unknown source') === folderLabel);
  const backBtn = `<button class="secondary" id="rg-drafts-back-btn" style="margin-bottom:14px;">← Back to Drafts</button>`;

  function wireBack() {
    document.getElementById('rg-drafts-back-btn').addEventListener('click', () => {
      state[ns.stateKey].draftFolder = null;
      state[ns.stateKey].draftCategory = '';
      renderRecipeGeneratorTabs(main, ns);
    });
  }

  // Every draft in this folder was just confirmed/deleted elsewhere (or this is the last one and
  // she just acted on it) -- same calm, in-place empty state the top-level list already uses,
  // rather than yanking her back to the folder list without warning.
  if (rows.length === 0) {
    container.innerHTML = `${backBtn}<div class="empty-state"><div class="display">No more drafts here</div>Every dish from "${folderLabel}" has been reviewed.</div>`;
    wireBack();
    return;
  }

  function rowMarkup(d) {
    return `
      <tr>
        <td>${d.name}</td>
        <td>${d.category || '–'}</td>
        <td>${d.source_menu_label || '–'}</td>
        <td>${new Date(d.created_at).toLocaleDateString()}</td>
        <td style="text-align:right">
          <button class="icon-btn" data-rg-review="${d.id}">Review</button>
          <button class="icon-btn danger" data-rg-delete="${d.id}">Delete</button>
        </td>
      </tr>
    `;
  }

  // Sub-grouped by day WITHIN this menu folder (requirement 4) -- a pure client-side grouping,
  // same "no separately persisted grouping entity" convention the menu-folder grouping one level
  // up already uses (see this function's own header comment), just one level deeper. Insertion
  // order into the Map is first-seen-in-this-folder order, which is already chronological for a
  // real menu (the parser encounters day-blocks in the sheet's own top-to-bottom order).
  //
  // Falls back to the old flat table with NO day headings at all when not a single row in this
  // folder carries a day label -- true for every draft generated before source_day_label existed,
  // and for the AI-assisted layout-agnostic fallback parse path, which doesn't capture a day at
  // all today (see main.js's extractDishesWithAI) -- a lone "No day recorded" heading sitting over
  // literally every row would be noise, not a grouping aid.
  const hasAnyDayLabel = rows.some(d => d.source_day_label);

  container.innerHTML = `
    <div class="rg-draft-bar">${backBtn.replace('margin-bottom:14px;', 'margin-bottom:0;')}<select id="rg-draft-category-filter" aria-label="Filter by category" hidden></select></div>
    <div id="rg-draft-table"></div>
  `;
  wireBack();
  const s = state[ns.stateKey];
  const filterEl = document.getElementById('rg-draft-category-filter');
  s.draftCategory = fillCategoryFilter(filterEl, rows, s.draftCategory);

  // The table itself is unchanged; the category filter only decides which rows go into it.
  function renderTable() {
    const shown = rows.filter(d => matchesCategoryFilter(d, filterEl.value));
    let tableRowsHtml;
    if (shown.length === 0) {
      tableRowsHtml = `<tr><td colspan="5" style="color:var(--neutral);">No drafts in this category.</td></tr>`;
    } else if (hasAnyDayLabel) {
      const dayGroups = new Map(); // day label (or null) -> rows
      for (const d of shown) {
        const key = d.source_day_label || null;
        if (!dayGroups.has(key)) dayGroups.set(key, []);
        dayGroups.get(key).push(d);
      }
      tableRowsHtml = sortDayGroups([...dayGroups.entries()]).map(([day, groupRows]) => `
      <tr><td colspan="5" style="background:var(--paper-dim); font-weight:600; padding-top:10px;">${day || 'No day recorded'}</td></tr>
      ${groupRows.map(rowMarkup).join('')}
    `).join('');
    } else {
      tableRowsHtml = shown.map(rowMarkup).join('');
    }
    const tableEl = document.getElementById('rg-draft-table');
    tableEl.innerHTML = `
    <div class="table-scroll"><table class="recipes-table rg-drafts-table">
      <thead><tr><th>Dish</th><th>Category</th><th>Source Menu</th><th>Generated</th><th></th></tr></thead>
      <tbody>
        ${tableRowsHtml}
      </tbody>
    </table></div>
  `;
    tableEl.querySelectorAll('[data-rg-review]').forEach(btn => {
      btn.addEventListener('click', () => {
        s.returnScroll = document.getElementById('main').scrollTop;
        ns.openEdit(parseInt(btn.dataset.rgReview, 10));
      });
    });
    tableEl.querySelectorAll('[data-rg-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const d = rows.find(x => x.id === parseInt(btn.dataset.rgDelete, 10));
        if (!confirm(`Delete the draft "${d.name}"? This cannot be undone.`)) return;
        await window.api.deleteGeneratedRecipe(d.id);
        s.returnScroll = main.scrollTop; // keep her place in the list
        renderRecipeGeneratorTabs(main, ns);
      });
    });
  }
  filterEl.addEventListener('change', () => { s.draftCategory = filterEl.value; renderTable(); });
  renderTable();
}

// Adapted from renderRecipeListView's own content logic (search/month-group/export-selected/
// delete-selected/preview/edit), scoped to RECIPE_NS.generated and mounted inside the tab shell
// above instead of owning its own topbar -- see this section's own header comment on why this
// isn't a literal call to renderRecipeListView.
async function renderGeneratedConfirmedList(container, ns, main) {
  container.innerHTML = `
    <div class="search-bar">
      <label for="rg-search">${ns.searchLabel}</label>
      <input id="rg-search" type="search" />
      <select id="rg-category-filter" aria-label="Filter by category" hidden></select>
    </div>
    <div class="action-toolbar">
      <button class="secondary" id="rg-export-selected-btn" disabled>Export Selected</button>
      ${exportLanguagePickerHtml('rglist')}
      <button class="secondary" id="rg-delete-selected-btn" disabled>Delete Selected</button>
      <span id="rg-hidden-note" class="rg-hidden-note" role="status"></span>
    </div>
    <div id="rg-export-selected-progress-wrap"></div>
    <div id="rg-list-content"><div class="loading-state" role="status">Loading…</div></div>
  `;
  wireExportLanguagePicker('rglist');

  const recipes = await ns.api.list();
  const searchInput = document.getElementById('rg-search');
  const content = document.getElementById('rg-list-content');
  const exportBtn = document.getElementById('rg-export-selected-btn');
  const deleteSelectedBtn = document.getElementById('rg-delete-selected-btn');
  const selected = new Set();

  if (recipes.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No confirmed recipes yet</div>Confirm a draft from the Drafts tab to see it here.</div>`;
    return;
  }

  const categoryFilter = document.getElementById('rg-category-filter');
  fillCategoryFilter(categoryFilter, recipes);

  // What Export Selected / Delete Selected act on: the ticked recipes that are on screen right now. A recipe ticked
  // before a search or category filter hid it stays ticked (it reappears ticked when the filter is cleared) but is
  // never exported or deleted unseen.
  let shownIds = new Set(recipes.map(r => r.id));
  const actionIds = () => [...selected].filter(id => shownIds.has(id));
  function updateExportBtn() {
    const n = actionIds().length, hidden = selected.size - n;
    exportBtn.disabled = n === 0;
    exportBtn.textContent = n > 0 ? `Export Selected (${n})` : 'Export Selected';
    deleteSelectedBtn.disabled = n === 0;
    deleteSelectedBtn.textContent = n > 0 ? `Delete Selected (${n})` : 'Delete Selected';
    const note = document.getElementById('rg-hidden-note');
    if (note) note.textContent = hidden > 0 ? `${hidden} ticked recipe${hidden > 1 ? 's are' : ' is'} hidden by the current filter and won't be exported or deleted.` : '';
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value;
    const filtered = recipes.filter(r =>
      (!query || r.name.toLowerCase().includes(query) || r.code.toLowerCase().includes(query)) &&
      matchesCategoryFilter(r, cat)
    );
    shownIds = new Set(filtered.map(r => r.id));
    updateExportBtn();

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No recipes match the current filters.</div>`;
      return;
    }

    // Grouped by source menu, not calendar month -- see groupRecipesBySourceMenu's own comment
    // for why that's the more useful dimension for Recipe Generator's own confirmed recipes.
    // The .recipe-month-group/.month-select-all classes below are reused as-is (same styling
    // wanted either way) even though the label no longer literally means "month" here.
    const groups = groupRecipesBySourceMenu(filtered);
    content.innerHTML = groups.map(group => `
      <div class="recipe-month-group">
        <div class="recipe-month-head">
          <label>
            <input type="checkbox" class="month-select-all" data-month="${group.key}" />
            <strong>${group.label}</strong>
            <span style="color:var(--neutral); font-weight:400;">(${group.recipes.length})</span>
          </label>
        </div>
        <div class="table-scroll"><table class="recipes-table rg-generated-table">
          <thead><tr><th></th><th>Code</th><th>Name</th><th>Category</th><th>Date</th><th></th></tr></thead>
          <tbody>
            ${group.recipes.map(r => `
              <tr>
                <td><input type="checkbox" class="recipe-row-check" data-select="${r.id}" data-month="${group.key}" ${selected.has(r.id) ? 'checked' : ''} /></td>
                <td>${r.code}</td>
                <td>${r.name}</td>
                <td>${r.category || '–'}</td>
                <td>${r.date_created || '–'}</td>
                <td style="text-align:right">
                  <button class="icon-btn" data-preview="${r.id}" title="Preview export" aria-label="Preview export">${EYE_OFF_ICON_SVG}</button>
                  <button class="icon-btn" data-edit="${r.id}">Edit</button>
                  <button class="icon-btn danger" data-delete="${r.id}">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table></div>
      </div>
    `).join('');

    function updateMonthCheckboxStates() {
      content.querySelectorAll('.month-select-all').forEach(monthCb => {
        const monthKey = monthCb.dataset.month;
        const rowCbs = [...content.querySelectorAll('.recipe-row-check')].filter(cb => cb.dataset.month === monthKey);
        monthCb.checked = rowCbs.length > 0 && rowCbs.every(cb => cb.checked);
      });
    }

    content.querySelectorAll('.recipe-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.select, 10);
        if (cb.checked) selected.add(id); else selected.delete(id);
        updateMonthCheckboxStates();
        updateExportBtn();
      });
    });
    content.querySelectorAll('.month-select-all').forEach(monthCb => {
      monthCb.addEventListener('change', () => {
        const monthKey = monthCb.dataset.month;
        content.querySelectorAll('.recipe-row-check').forEach(cb => {
          if (cb.dataset.month !== monthKey) return;
          cb.checked = monthCb.checked;
          const id = parseInt(cb.dataset.select, 10);
          if (monthCb.checked) selected.add(id); else selected.delete(id);
        });
        updateExportBtn();
      });
    });
    updateMonthCheckboxStates();

    content.querySelectorAll('[data-preview]').forEach(btn => {
      btn.addEventListener('click', () => openRecipePreviewModal(ns, parseInt(btn.dataset.preview, 10), btn));
    });
    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => ns.openEdit(parseInt(btn.dataset.edit, 10)));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const recipe = recipes.find(r => r.id === id);
        if (!confirm(`Delete "${recipe.name}" (${recipe.code})? This cannot be undone.`)) return;
        await ns.api.del(id);
        renderRecipeGeneratorTabs(main, ns);
      });
    });
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    const progressWrap = document.getElementById('rg-export-selected-progress-wrap');
    const panel = createProgressPanel(progressWrap, { label: 'Exporting…' });
    const unsubscribe = window.api.onExportProgress((payload) => panel.update(payload));
    try {
      const result = await ns.api.exportSelected(actionIds(), getSelectedExportLanguage('rglist'));
      panel.destroy();
      if (result.success) alert(`Exported to ${result.path}`);
      else if (!result.cancelled) alert('Export failed.');
    } catch (err) {
      panel.destroy();
      alert(`Export failed: ${err.message}`);
    } finally {
      unsubscribe();
      updateExportBtn();
    }
  });

  deleteSelectedBtn.addEventListener('click', async () => {
    const ids = actionIds(), count = ids.length;
    if (count === 0 || !confirm(`Delete ${count} selected recipe${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    deleteSelectedBtn.disabled = true;
    deleteSelectedBtn.textContent = 'Deleting…';
    try {
      for (const id of ids) await ns.api.del(id);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
    renderRecipeGeneratorTabs(main, ns);
  });

  searchInput.addEventListener('input', renderFiltered);
  categoryFilter.addEventListener('change', renderFiltered);
  updateExportBtn();
  renderFiltered();
}

// Recipe Generator's own recipe-level aggregator, mirroring updateNetWeightSum's role but with
// TWO recipe-level numbers instead of one, now that drafts carry Waste % (see the parity
// migration): a combined pre-waste "Total Quantity" (rg-total-qty, EDITABLE -- see
// wireGeneratedTotalQuantityRescale) and a combined post-waste "Net Weight" (rg-yield, always
// read-only/computed, same as everywhere else in the app). Per-process math is NOT
// reimplemented here -- updateProcessNetWeight is the exact shared helper Book/Extractor's own
// updateNetWeightSum calls, reused unmodified because this form's process-card markup uses the
// same ep-total-*/ep-yield-*/ep-trays-* DOM id convention (see renderProcessCards below).
function updateGeneratedNetWeightSum(s) {
  let combinedTotal = 0;
  let combinedNet = 0;
  s.processes.forEach(proc => {
    combinedTotal += sumIngredientQuantities(proc.ingredientRows);
    combinedNet += updateProcessNetWeight(proc);
  });

  const totalEl = document.getElementById('rg-total-qty');
  // Never overwrite while she's actively typing in it -- direction #2 (an ingredient changed)
  // should recompute this field live, but not fight her own edit to this exact field mid-keystroke
  // (direction #1's own 'change' handler applies the rescale once she moves away/hits Enter).
  if (totalEl && document.activeElement !== totalEl) totalEl.value = roundNice(combinedTotal);

  const yieldEl = document.getElementById('rg-yield');
  // Same guard as rg-total-qty above -- rg-yield is now also editable (see
  // wireGeneratedNetWeightRescale).
  if (yieldEl && document.activeElement !== yieldEl) yieldEl.value = `${roundNice(combinedNet)} G`;

  const portionsEl = document.getElementById('rg-portions-produced');
  if (portionsEl) {
    const portionWeightInput = document.getElementById('rg-portion-weight');
    const pw = portionWeightInput ? parseFloat(portionWeightInput.value) : NaN;
    portionsEl.textContent = (!isNaN(pw) && pw > 0) ? String(Math.floor(roundNice(combinedNet) / pw)) : '–';
  }
}

// Part 1, direction #1 -- editing the recipe-level Total Quantity field directly proportionally
// rescales EVERY ingredient in EVERY process by one shared multiplier, matching Calculator's own
// DEFAULT "scale all processes together" mode (not its opt-in independent-per-process mode,
// which stays a Calculator-only capability post-confirmation -- confirmed with the chef). Reuses
// computeMultiplierFromTarget/scaleIngredients UNCHANGED -- same formula Calculator's "scale to
// target quantity" mode already uses, not reimplemented here. Fires on 'change' (blur/Enter), not
// per-keystroke, so a partially-typed number never triggers a rescale mid-edit.
function wireGeneratedTotalQuantityRescale(s, renderProcessCards) {
  const input = document.getElementById('rg-total-qty');
  input.addEventListener('change', () => {
    const allRows = s.processes.flatMap(p => p.ingredientRows);
    const result = computeMultiplierFromTarget(allRows, input.value);
    if (result.error) {
      alert(result.error);
      updateGeneratedNetWeightSum(s); // revert the displayed value back to the real current total
      return;
    }
    const scaledSets = scaleIngredientSets(s.processes.map(p => p.ingredientRows), result.multiplier);
    s.processes.forEach((proc, i) => { proc.ingredientRows = scaledSets[i]; });
    renderProcessCards();
  });
}

// LEVEL 2, Net Weight -- Recipe Generator's counterpart to Book/Extractor's own recipe-level
// Net Weight rescale (identical mechanism): back-solve one recipe-level target Total Quantity
// through the CURRENT implied aggregate retention factor, then rescale every process uniformly
// by the resulting multiplier -- same as wireGeneratedTotalQuantityRescale above, just entered
// from the Net Weight side.
function wireGeneratedNetWeightRescale(s, renderProcessCards) {
  const input = document.getElementById('rg-yield');
  input.addEventListener('change', () => {
    const combinedTotal = s.processes.reduce((acc, proc) => acc + sumIngredientQuantities(proc.ingredientRows), 0);
    const combinedNet = s.processes.reduce((acc, proc) => acc + compoundWasteYield(sumIngredientQuantities(proc.ingredientRows), proc.wastes), 0);
    const impliedRetention = combinedTotal > 0 ? combinedNet / combinedTotal : 0;
    const backSolve = computeTargetTotalQuantityFromNetWeight(impliedRetention, input.value);
    if (backSolve.error) {
      alert(backSolve.error);
      updateGeneratedNetWeightSum(s);
      return;
    }
    const solved = scaleSetsToNetWeight(s.processes.map(p => p.ingredientRows), s.processes.map(p => p.wastes), backSolve.targetTotalQuantity, input.value);
    if (solved.error) {
      alert(solved.error);
      updateGeneratedNetWeightSum(s);
      return;
    }
    s.processes.forEach((proc, i) => { proc.ingredientRows = solved.sets[i]; });
    renderProcessCards();
  });
}

// Recipe Generator's own lightweight sibling of renderProcessIngredientRows -- plain text name
// input, no autocomplete/catalog matching at all: an ingredient row here is pure free text,
// never linked to any ingredient catalog, ever, even after confirmation (see the migration's
// own comment) -- same "throwaway free text" row shape as Recipe Calculator's own inline rows,
// just without that function's dual quantity-column scaling machinery (nothing here is ever
// scaled in place -- scaling to ~150g happens once, server-side, right after generation; see
// lib/recipeGenerator.js's normalizeProcessesToGrams). Reuses wireProcessIngredientRowDrag
// UNCHANGED for drag-and-drop reordering, same as renderProcessIngredientRows does.
function renderGeneratedIngredientRows(process, tbodyEl, onChange) {
  tbodyEl.innerHTML = process.ingredientRows.map(row => `
    <tr data-row="${row.localId}">
      <td class="row-drag-handle-cell"><span class="row-drag-handle" data-drag-handle="${row.localId}" draggable="true" title="Drag to reorder">⠿</span></td>
      <td><input class="rg-ing-name" value="${row.name}" dir="auto" /></td>
      <td><input class="rg-ing-qty" value="${formatIngredientQty(row.quantity)}" /></td>
      <td><input class="rg-ing-unit" value="${row.unit}" /></td>
      <td><input class="rg-ing-method" value="${row.method}" dir="auto" /></td>
      <td style="text-align:right">
        <button type="button" class="icon-btn danger" data-row-remove="${row.localId}">Remove</button>
      </td>
    </tr>
  `).join('');

  process.ingredientRows.forEach(row => {
    const tr = tbodyEl.querySelector(`tr[data-row="${row.localId}"]`);
    tr.querySelector('.rg-ing-name').addEventListener('input', (e) => { row.name = e.target.value; });
    tr.querySelector('.rg-ing-qty').addEventListener('input', (e) => { row.quantity = e.target.value; onChange(); });
    tr.querySelector('.rg-ing-unit').addEventListener('input', (e) => { row.unit = e.target.value; });
    tr.querySelector('.rg-ing-method').addEventListener('input', (e) => { row.method = e.target.value; });
  });

  tbodyEl.querySelectorAll('[data-row-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.rowRemove, 10);
      process.ingredientRows = process.ingredientRows.filter(r => r.localId !== id);
      if (process.ingredientRows.length === 0) process.ingredientRows.push(makeEmptyIngredientRow());
      renderGeneratedIngredientRows(process, tbodyEl, onChange);
    });
  });

  wireProcessIngredientRowDrag(process, tbodyEl, () => renderGeneratedIngredientRows(process, tbodyEl, onChange));
  onChange();
}

// The Drafts/Generated tabs' shared "open a row" destination (ns.openEdit) -- reviewing a
// not-yet-confirmed draft and editing an already-confirmed recipe are the same form, just with a
// different save-button combo at the bottom (Save Draft + Confirm & Save vs plain Save Changes),
// since a confirmed recipe's code/status never move once assigned.
async function renderGeneratedRecipeFormView(main, ns) {
  fillRecipePeopleList();
  const s = state[ns.stateKey];
  // Fetched once per form open, same convention renderRecipeFormView uses -- backs every
  // process card's "+ Add Waste" control (Material/Tray's own catalog fetch, `listMaterials`,
  // is deliberately NOT here -- see the parity migration's own comment on why Material/Tray
  // stays excluded for a 150g reference recipe).
  const wasteTypes = await window.api.listWasteTypes();

  const recipe = await ns.api.get(s.formId);
  if (!recipe) {
    alert('This recipe was deleted or changed elsewhere.');
    goBackToRecipeList(ns);
    return;
  }
  let existingPhotoDataUrl = null;
  if (recipe.photo_path) existingPhotoDataUrl = await ns.api.getPhoto(recipe.photo_path);
  if (s.processes.length === 0) {
    s.processes = recipe.processes.length > 0 ? recipe.processes.map(buildProcessFromSaved) : [makeEmptyProcess()];
  }

  initTextListField(s, TEXT_LIST_FIELDS.generatedPresentation, recipe.presentation_serving);

  const isDraft = recipe.status === 'draft';
  const currentPhotoSrc = s.pendingPhoto
    ? s.pendingPhoto.dataUrl
    : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${isDraft ? 'Review Generated Recipe' : 'Edit Generated Recipe'}</h1>
        <span class="page-description">${recipe.code ? recipe.code : `${ns.codeLabel} code assigned after saving`}</span>
      </div>
      <button class="secondary" id="rg-back-btn">${ns.backLabel}</button>
    </div>
    ${isDraft ? `<div style="color:var(--neutral); font-size:12.5px; margin:-10px 0 14px;">Generated from "${recipe.source_menu_label}" -- source dish: "${recipe.source_dish_name}". Review and edit below, then Confirm &amp; Save to assign an RG- code.</div>` : ''}

    <div class="generate-controls">
      <div class="field recipe-name-field"><label>Recipe Name</label><input id="rg-name" value="${recipe.name || ''}" dir="auto" /></div>
      <div class="field"><label>Quantity Produced</label><input id="rg-qty" value="${recipe.quantity_produced || ''}" dir="auto" /></div>
      <div class="field"><label>Portion Weight (g)</label><input id="rg-portion-weight" type="number" min="0" step="0.1" value="${recipe.portion_weight_grams ?? ''}" /></div>
      <div class="field"><label>Prepared By</label><input id="rg-prepared-by" list="recipe-people-list" value="${recipe.prepared_by || ''}" dir="auto" /></div>
      <div class="field"><label>Category</label><input id="rg-category" value="${recipe.category || ''}" dir="auto" /></div>
      <div class="field"><label>Country/Origin</label><input id="rg-country" value="${recipe.country_origin || ''}" dir="auto" /></div>
      <div class="field"><label>Total Quantity (g)</label><input id="rg-total-qty" value="${recipe.yield_notes || ''}" /></div>
      <div class="field"><label>Net Weight (sum of processes)</label><input id="rg-yield" value="${recipe.yield_notes || ''}" /></div>
      <div class="field"><label>Portions Produced</label><div class="computed-value-box" id="rg-portions-produced">–</div></div>
      <div class="field"><label>Date</label><input id="rg-date" type="date" value="${recipe.date_created || ''}" /></div>
    </div>

    <h3 style="margin-bottom:10px;">Processes</h3>
    <div id="rg-process-list"></div>
    <button class="secondary" id="rg-add-process-btn" style="margin:10px 0 24px;">+ Add Process</button>

    <div class="field" style="margin-bottom:16px;">
      <label>Presentation / Decoration / Serving</label>
      <div id="rg-presentation-field"></div>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Comment</label>
      <textarea id="rg-comment" rows="3" dir="auto">${recipe.comment || ''}</textarea>
    </div>
    <div class="field" style="margin-bottom:16px; max-width:320px;">
      <label>Upload Photo</label>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <input type="file" id="rg-photo-input" accept="image/jpeg,image/png" />
        <button type="button" class="secondary" id="rg-generate-photo-btn">Generate Photo</button>
      </div>
      <div id="rg-generate-photo-progress-wrap" style="margin-top:8px;"></div>
      <div id="rg-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="rg-photo-preview" src="${currentPhotoSrc || ''}" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block; cursor:zoom-in;" title="Click to view full size" />
        <button type="button" class="secondary" id="rg-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>
    <div class="field" style="margin-bottom:20px; max-width:320px;">
      <label>Checked By</label>
      <input id="rg-checked-by" list="recipe-people-list" value="${recipe.checked_by || ''}" dir="auto" />
    </div>

    <button class="primary" id="rg-save-draft-btn">${isDraft ? 'Save Draft' : 'Save Changes'}</button>
    ${isDraft ? `<button class="primary" id="rg-confirm-btn" style="margin-left:10px;">Confirm &amp; Save</button>` : ''}
    <span id="rg-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  function updatePhotoPreview() {
    const src = s.pendingPhoto
      ? s.pendingPhoto.dataUrl
      : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);
    document.getElementById('rg-photo-preview-wrap').style.display = src ? '' : 'none';
    document.getElementById('rg-photo-preview').src = src || '';
  }
  document.getElementById('rg-photo-preview').addEventListener('click', () => {
    const src = document.getElementById('rg-photo-preview').src;
    if (src) openPhotoLightbox(src, document.getElementById('rg-name').value.trim());
  });

  document.getElementById('rg-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      alert('Please choose a JPG or PNG image.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be 5MB or smaller.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const ext = file.type === 'image/png' ? 'png' : 'jpeg';
      s.pendingPhoto = { dataUrl, base64, ext };
      s.removePhoto = false;
      updatePhotoPreview();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('rg-photo-remove-btn').addEventListener('click', () => {
    s.pendingPhoto = null;
    s.removePhoto = true;
    document.getElementById('rg-photo-input').value = '';
    updatePhotoPreview();
  });

  // Same live-form-state read as Recipe Book/Extractor's own getRecipeInfoForPhoto -- s.processes
  // is kept in sync with every ingredient/method input's own 'input' listener as she edits, so
  // this reflects unsaved changes without needing a re-fetch or an intermediate save.
  wireGeneratePhotoButton({
    buttonId: 'rg-generate-photo-btn',
    progressWrapId: 'rg-generate-photo-progress-wrap',
    getRecipeInfo: () => {
      const name = document.getElementById('rg-name').value.trim();
      if (!name) { alert('Please enter a recipe name first.'); return null; }
      const category = document.getElementById('rg-category').value.trim() || undefined;
      const ingredients = s.processes.flatMap(proc => proc.ingredientRows
        .filter(r => r.name.trim() !== '')
        .map(r => r.name.trim()));
      const method = s.processes
        .map(proc => collectTextListFieldValue(proc, makeProcessMethodCfg(proc)))
        .filter(Boolean)
        .join('; ') || undefined;
      return { dishName: name, category, ingredients, method };
    },
    onGenerated: ({ dataUrl, base64, ext }) => {
      s.pendingPhoto = { dataUrl, base64, ext };
      s.removePhoto = false;
      updatePhotoPreview();
    },
  });

  function renderProcessCards() {
    const container = document.getElementById('rg-process-list');
    container.innerHTML = s.processes.map((proc, idx) => `
      <div class="process-card" data-process="${proc.localId}">
        <div class="process-card-head">
          <input aria-label="Process name" placeholder="Name this process, e.g. dough or filling" class="process-name-input" value="${proc.name}" dir="auto" />
          <button type="button" class="icon-btn" data-move-process-up="${proc.localId}" title="Move process up" aria-label="Move process up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="icon-btn" data-move-process-down="${proc.localId}" title="Move process down" aria-label="Move process down" ${idx === s.processes.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="icon-btn danger" data-remove-process="${proc.localId}" ${s.processes.length <= 1 ? 'disabled' : ''}>Remove Process</button>
        </div>
        <table class="recipe-ingredients-table">
          <thead><tr><th></th><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Note</th><th></th></tr></thead>
          <tbody class="process-ing-rows"></tbody>
        </table>
        <button type="button" class="secondary process-add-row-btn" style="margin:8px 0 16px;">+ Add Ingredient Row</button>
        <div class="field" style="max-width:220px; margin-bottom:14px;">
          <label>Total Quantity</label>
          <input id="ep-total-${proc.localId}" readonly />
        </div>
        <div class="field" style="margin-bottom:14px;">
          <label>Wastes Applied</label>
          <div class="process-waste-rows" id="ep-wastes-${proc.localId}"></div>
          <select class="builder-select process-add-waste-select" data-add-waste="${proc.localId}" style="margin-top:6px; max-width:240px;">
            <option value="">+ Add Waste…</option>
          </select>
          <div id="ep-new-waste-${proc.localId}"></div>
        </div>
        <div class="field" style="max-width:220px; margin-bottom:14px;">
          <label>Net Weight</label>
          <input id="ep-yield-${proc.localId}" />
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Method</label>
          <div id="${makeProcessMethodCfg(proc).mountId}"></div>
        </div>
      </div>
    `).join('');

    s.processes.forEach(proc => {
      const card = container.querySelector(`[data-process="${proc.localId}"]`);

      const nameInput = card.querySelector('.process-name-input');
      nameInput.addEventListener('input', () => { proc.name = nameInput.value; });

      card.querySelector('[data-remove-process]').addEventListener('click', () => {
        s.processes = s.processes.filter(p => p.localId !== proc.localId);
        if (s.processes.length === 0) s.processes.push(makeEmptyProcess());
        renderProcessCards();
      });

      const moveUpBtn = card.querySelector('[data-move-process-up]');
      const moveDownBtn = card.querySelector('[data-move-process-down]');
      moveUpBtn.addEventListener('click', () => {
        const i = s.processes.findIndex(p => p.localId === proc.localId);
        if (i <= 0) return;
        [s.processes[i - 1], s.processes[i]] = [s.processes[i], s.processes[i - 1]];
        renderProcessCards();
      });
      moveDownBtn.addEventListener('click', () => {
        const i = s.processes.findIndex(p => p.localId === proc.localId);
        if (i === -1 || i >= s.processes.length - 1) return;
        [s.processes[i], s.processes[i + 1]] = [s.processes[i + 1], s.processes[i]];
        renderProcessCards();
      });

      const tbody = card.querySelector('.process-ing-rows');
      const onIngredientChange = () => updateGeneratedNetWeightSum(s);
      renderGeneratedIngredientRows(proc, tbody, onIngredientChange);

      card.querySelector('.process-add-row-btn').addEventListener('click', () => {
        proc.ingredientRows.push(makeEmptyIngredientRow());
        renderGeneratedIngredientRows(proc, tbody, onIngredientChange);
      });

      // LEVEL 1, Net Weight -- same mechanism as Book/Extractor's own per-process Net Weight
      // field (see the identical wiring in renderRecipeFormView): back-solve this process's own
      // target Total Quantity through its current waste %, then the same
      // computeMultiplierFromTarget/scaleIngredients cascade Total Quantity editing already
      // uses. This process's OWN Total Quantity field stays read-only/display-only here (never
      // made directly editable for Generator drafts, per the earlier Total Quantity round) --
      // only this Net Weight field is a new interactive entry point into the same rescale.
      card.querySelector(`#ep-yield-${proc.localId}`).addEventListener('change', (e) => {
        const backSolve = computeTargetTotalQuantityFromNetWeight(processRetentionFactor(proc.wastes), e.target.value);
        if (backSolve.error) {
          alert(backSolve.error);
          updateGeneratedNetWeightSum(s);
          return;
        }
        const solved = scaleSetsToNetWeight([proc.ingredientRows], [proc.wastes], backSolve.targetTotalQuantity, e.target.value);
        if (solved.error) {
          alert(solved.error);
          updateGeneratedNetWeightSum(s);
          return;
        }
        proc.ingredientRows = solved.sets[0];
        renderGeneratedIngredientRows(proc, tbody, onIngredientChange);
      });

      renderProcessWastes(proc, wasteTypes, onIngredientChange);
      renderTextListFieldBody(proc, makeProcessMethodCfg(proc));
    });

    updateGeneratedNetWeightSum(s);
  }

  document.getElementById('rg-back-btn').addEventListener('click', () => goBackToRecipeList(ns));
  document.getElementById('rg-add-process-btn').addEventListener('click', () => {
    s.processes.push(makeEmptyProcess());
    renderProcessCards();
  });
  document.getElementById('rg-save-draft-btn').addEventListener('click', () => saveGeneratedRecipeForm(ns, { confirm: false }));
  if (isDraft) {
    document.getElementById('rg-confirm-btn').addEventListener('click', () => saveGeneratedRecipeForm(ns, { confirm: true }));
  }
  // Portions Produced depends on this field but isn't stored on the process rows themselves --
  // same reasoning as the shared form's own rf-portion-weight listener.
  document.getElementById('rg-portion-weight').addEventListener('input', () => updateGeneratedNetWeightSum(s));
  wireGeneratedTotalQuantityRescale(s, renderProcessCards);
  wireGeneratedNetWeightRescale(s, renderProcessCards);

  renderProcessCards();
  renderTextListFieldBody(s, { ...TEXT_LIST_FIELDS.generatedPresentation, dirAuto: true });
}

async function saveGeneratedRecipeForm(ns, { confirm }) {
  const s = state[ns.stateKey];
  const name = document.getElementById('rg-name').value.trim();
  if (!name) return alert('Please enter a recipe name.');

  const statusEl = document.getElementById('rg-status');
  statusEl.textContent = confirm ? 'Confirming…' : 'Saving…';

  const payload = {
    id: s.formId,
    name,
    quantityProduced: document.getElementById('rg-qty').value.trim(),
    // Numeric, parsed here rather than left as a string -- same convention saveProcessRecipeForm
    // uses for this exact field.
    portionWeightGrams: (() => {
      const raw = document.getElementById('rg-portion-weight').value.trim();
      return raw === '' ? null : parseFloat(raw);
    })(),
    preparedBy: document.getElementById('rg-prepared-by').value.trim(),
    category: document.getElementById('rg-category').value.trim(),
    countryOrigin: document.getElementById('rg-country').value.trim(),
    yieldNotes: document.getElementById('rg-yield').value.trim(),
    dateCreated: document.getElementById('rg-date').value,
    presentationServing: collectTextListFieldValue(s, TEXT_LIST_FIELDS.generatedPresentation),
    comment: document.getElementById('rg-comment').value,
    checkedBy: document.getElementById('rg-checked-by').value.trim(),
    confirm: !!confirm,
    processes: s.processes.map(proc => ({
      name: proc.name.trim(),
      method: collectTextListFieldValue(proc, makeProcessMethodCfg(proc)),
      wastes: proc.wastes.map(w => {
        const pct = parseFloat(w.percent);
        return { wasteTypeId: w.wasteTypeId, percent: isNaN(pct) ? 0 : pct };
      }),
      ingredients: proc.ingredientRows
        .filter(r => r.name.trim() !== '')
        .map(r => ({
          name: r.name.trim(),
          quantity: r.quantity ? parseFloat(r.quantity) : null,
          unit: r.unit || null,
          method: r.method || null,
        })),
    })),
  };

  if (s.pendingPhoto) {
    payload.photoBase64 = s.pendingPhoto.base64;
    payload.photoExt = s.pendingPhoto.ext;
  } else if (s.removePhoto) {
    payload.removePhoto = true;
  }

  try {
    await ns.api.save(payload);
    // Stay on the tab she came from. A confirmed draft simply drops out of the Drafts list (it is no longer status='draft'), so
    // reviewing a batch is one uninterrupted pass: the next draft is where the confirmed one was. (This used to jump to Recipe
    // Generated, forcing her to navigate back to Drafts and find her place again after every draft.)
    goBackToRecipeList(ns);
  } catch (err) {
    statusEl.textContent = '';
    alert(`Save failed: ${err.message}`);
  }
}

// ============================================================
// RECIPE CALCULATOR -- scales a saved recipe by a multiplier and displays/exports the
// result live. Reads via the same get-recipe/export-recipes plumbing as the Recipe Book,
// but never writes anything back to the database.
// ============================================================

// Rounds to 2 decimals and returns a Number, so trailing zeros drop naturally when stringified
// (e.g. 60 not 60.00, 1.5 not 1.50000001) -- keeps scaled quantities readable.
function roundNice(n) {
  return Math.round(n * 100) / 100;
}

function gcdInt(a, b) {
  return b === 0 ? a : gcdInt(b, a % b);
}

// Scales one matched numeric token from free text: a simple `a/b` fraction is scaled and
// reduced (so "1/4" x2 -> "1/2", matching how a chef would actually write it), anything else
// is treated as a plain number and rounded via roundNice.
function scaleNumberToken(token, multiplier) {
  const fracMatch = token.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    const scaledNum = num * multiplier;
    if (Number.isInteger(scaledNum) && scaledNum > 0) {
      const g = gcdInt(scaledNum, den);
      const rn = scaledNum / g, rd = den / g;
      return rd === 1 ? String(rn) : `${rn}/${rd}`;
    }
    return String(roundNice((num / den) * multiplier));
  }
  return String(roundNice(parseFloat(token) * multiplier));
}

// Scales the free-text "Quantity Produced" field (e.g. "20 pax", "1 kg dough") by finding
// numeric tokens -- plain numbers or simple a/b fractions -- and replacing each in place.
// If the text has no number at all, it's left as-is with " (xN)" appended so the multiplier
// is still visible.
function scaleQuantityProducedText(text, multiplier) {
  if (!text) return text;
  let found = false;
  const scaled = text.replace(/\d+\/\d+|\d+(?:\.\d+)?/g, (token) => {
    found = true;
    return scaleNumberToken(token, multiplier);
  });
  if (!found) return `${text} (×${roundNice(multiplier)})`;
  return scaled;
}

// Turns exact (unrounded) quantities into whole hundredths of a gram that add up to `targetTicks` exactly: every value is
// floored to a whole hundredth, then the hundredths still missing from the target go to the values with the LARGEST
// fractional remainders (largest-remainder allocation). Rounding each value on its own instead makes the rounded parts drift
// off the total in a third to two thirds of recipes (typing 150 into Total Quantity came back as 149.99 or 150.02), because
// the individual errors don't cancel. Every value ends up within one hundredth of its exact value. Mirrored in
// lib/recipeGenerator.js (allocateHundredths), which normalizes freshly generated recipes the same way -- this file is a
// classic script and cannot require() it.
function allocateHundredths(exact, targetTicks) {
  const scaled = exact.map(v => v * 100);
  const base = scaled.map(v => Math.floor(v + 1e-7));
  let missing = targetTicks - base.reduce((a, b) => a + b, 0);
  const byRemainder = scaled.map((v, i) => ({ i, r: v - base[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; missing > 0 && byRemainder.length; k = (k + 1) % byRemainder.length, missing--) base[byRemainder[k].i] += 1;
  // Only reachable through floating-point noise: take a hundredth back from the smallest remainders.
  for (let k = byRemainder.length - 1; missing < 0 && k >= 0; k--) {
    if (base[byRemainder[k].i] > 0) { base[byRemainder[k].i] -= 1; missing++; }
  }
  return base;
}

const isBlankQuantity = (q) => q === null || q === undefined || q === '';

// How an ingredient quantity is SHOWN: one decimal place, two under 0.1 g (so 0.04 g of a spice stays visible instead of
// reading 0), and no trailing ".0" (40, not 40.0). Display only: recipes keep their stored 0.01 g precision, exports keep
// the exact number, and the totals are computed from the stored values, so the rows on screen can look a hair off their
// total. Quantities that are not plain numbers ("a pinch", "1/2") are shown exactly as written. Mirrored for Excel cells in
// lib/export.js (ingredientQtyNumFmt).
function formatIngredientQty(value) {
  if (isBlankQuantity(value)) return '';
  const text = String(value).trim();
  if (!/^-?\d*\.?\d+$/.test(text)) return String(value);
  const n = parseFloat(text), abs = Math.abs(n), scale = abs > 0 && abs < 0.1 ? 100 : 10;
  return String(Math.round(n * scale) / scale);
}

// Scales several processes' ingredient rows at once and returns new row arrays (same shape as `sets`). `multipliers` is one
// number for all of them or one per set. Processes that share a multiplier are rounded TOGETHER, so what they add up to is
// exactly the (correctly rounded) exact total -- the recipe-level Total Quantity a chef typed, not a total that wobbles by a
// hundredth per process. A multiplier of 1 is just the stored values, rounded per row as before (nothing is being solved for).
function scaleIngredientSets(sets, multipliers) {
  const mult = (i) => (Array.isArray(multipliers) ? multipliers[i] : multipliers);
  const out = sets.map(rows => rows.map(r => ({ ...r })));
  const groups = new Map(); // multiplier -> [set indexes]
  sets.forEach((_, i) => { const m = mult(i); if (!groups.has(m)) groups.set(m, []); groups.get(m).push(i); });
  for (const [m, idxs] of groups) {
    const slots = [], exact = [];
    idxs.forEach(si => sets[si].forEach((row, ri) => {
      if (isBlankQuantity(row.quantity)) return;
      const q = parseFloat(row.quantity);
      if (isNaN(q)) return;
      slots.push([si, ri]); exact.push(q * m);
    }));
    if (m === 1) { slots.forEach(([si, ri], k) => { out[si][ri].quantity = roundNice(exact[k]); }); continue; }
    const ticks = allocateHundredths(exact, Math.round(exact.reduce((a, b) => a + b, 0) * 100));
    slots.forEach(([si, ri], k) => { out[si][ri].quantity = ticks[k] / 100; });
  }
  return out;
}

// Called once per process being scaled (renderCalculatorView/renderScaledRecipeResult) -- Recipe
// Book and Recipe Extractor share this, since both are process-shaped now. The quantities add up to the correctly
// rounded exact total (see allocateHundredths); scale several processes together with scaleIngredientSets instead when
// their combined total matters.
function scaleIngredients(ingredients, multiplier) {
  return scaleIngredientSets([ingredients], multiplier)[0];
}

// Net Weight edits: computeTargetTotalQuantityFromNetWeight back-solves the Total Quantity that would give the typed Net
// Weight through the wastes held fixed, but that total is rarely a whole hundredth, and every process's Net Weight is itself
// rounded to 0.01 after its wastes -- so scaling to exactly that total can still display 149.99. This tries the totals around
// it, a hundredth at a time, and keeps the first whose DISPLAYED Net Weight (the sum of every process's compoundWasteYield,
// as updateNetWeightSum shows it) equals the typed one. `sets` are the processes' ingredient rows, `wastesList` their
// waste rows, in the same order. Returns { sets } or { error }.
function scaleSetsToNetWeight(sets, wastesList, targetTotalQuantity, targetNetText) {
  const currentTotal = sets.reduce((acc, rows) => acc + rows.reduce((a, r) => {
    const q = parseFloat(r.quantity); return isNaN(q) ? a : a + q;
  }, 0), 0);
  if (!currentTotal || currentTotal <= 0) return { error: 'This recipe has no ingredient quantities to scale against.' };
  const targetNet = roundNice(parseFloat(targetNetText));
  const shownNet = (scaled) => roundNice(scaled.reduce((acc, rows, i) => acc + compoundWasteYield(sumIngredientQuantities(rows), wastesList[i]), 0));
  const centre = Math.round(targetTotalQuantity * 100);
  let best = null;
  for (let step = 0; step <= 12; step++) {
    for (const k of (step === 0 ? [0] : [step, -step])) {
      const total = (centre + k) / 100;
      if (total <= 0) continue;
      const scaled = scaleIngredientSets(sets, total / currentTotal);
      const miss = Math.abs(shownNet(scaled) - targetNet);
      if (!best || miss < best.miss) best = { sets: scaled, miss };
      if (miss < 0.0005) return { sets: scaled };
    }
  }
  // Several processes each round their own Net Weight, so no single total may land exactly (rare: a fraction of a percent of
  // recipes with 3+ processes). Fine-tune: move one process's total by a few hundredths of a gram, on its largest ingredient
  // (invisible next to the ingredient itself), and keep any change that gets closer.
  let cur = best.sets, curMiss = best.miss;
  for (let round = 0; round < 6 && curMiss >= 0.0005; round++) {
    let improved = false;
    for (let pi = 0; pi < cur.length && curMiss >= 0.0005; pi++) {
      let ri = -1, biggest = -1;
      cur[pi].forEach((r, i) => { const q = parseFloat(r.quantity); if (!isNaN(q) && q > biggest) { biggest = q; ri = i; } });
      if (ri < 0) continue;
      for (let k = 1; k <= 25 && curMiss >= 0.0005; k++) {
        for (const sign of [1, -1]) {
          const cand = cur.map(rows => rows.map(r => ({ ...r })));
          const q = roundNice(parseFloat(cand[pi][ri].quantity) + sign * k / 100);
          if (q < 0) continue;
          cand[pi][ri].quantity = q;
          const miss = Math.abs(shownNet(cand) - targetNet);
          if (miss < curMiss - 1e-12) { cur = cand; curMiss = miss; improved = true; }
        }
      }
    }
    if (!improved) break;
  }
  return { sets: cur };
}

// Sums every ingredient's raw quantity number regardless of unit (120 GR + 5 PC = 125) --
// ingredients are recorded in grams today (see lib/export.js), so a plain sum is meaningful
// without any unit conversion. Shared by the "scale to target quantity" multiplier calc below
// and the Total Quantity field in renderScaledRecipeResult, so the two stay in sync.
function sumIngredientQuantities(ingredients) {
  return roundNice(ingredients.reduce((sum, ing) => {
    const q = typeof ing.quantity === 'number' ? ing.quantity : parseFloat(ing.quantity);
    return isNaN(q) ? sum : sum + q;
  }, 0));
}

// Computes the effective multiplier for "scale to target quantity" mode: target-total ÷ the
// recipe's current total ingredient quantity (NOT quantity_produced, which is a free-text
// container/serving count like "5pax" or "1 Tray" and isn't a weight). Returns { error } when
// there's nothing to divide by or the target doesn't parse; { multiplier } otherwise.
function computeMultiplierFromTarget(ingredients, targetQtyText) {
  const originalTotal = sumIngredientQuantities(ingredients);
  if (!originalTotal || originalTotal <= 0) {
    return { error: 'This recipe has no ingredient quantities to scale against.' };
  }
  const target = parseFloat(targetQtyText);
  if (!target || target <= 0) {
    return { error: 'Please enter a target quantity greater than 0, e.g. 2000.' };
  }
  return { multiplier: target / originalTotal };
}

// Sum of the given processes' own ORIGINAL (1x, unscaled) waste-adjusted Net Weight -- each
// process's compoundWasteYield(sumIngredientQuantities(p.ingredientRows), p.wastes), added
// together. Always reads ingredientRows (the persistent, never-scaled 1x basis), never
// scaledIngredients, so this stays stable across repeated Calculate clicks -- shared by
// computeMultiplierFromTargetPortions below and updateQtyOriginalDisplay's "portions" branch, so
// both read the exact same original basis.
function originalCombinedNetWeight(processes) {
  return roundNice(processes.reduce((sum, p) => sum + compoundWasteYield(sumIngredientQuantities(p.ingredientRows), p.wastes), 0));
}

// Nudges the target-portions multiplier up by a tiny relative amount so the scaled combined Net
// Weight reliably clears target*portionWeight despite the rounding chain below (originalNetWeight
// itself is roundNice'd, then every scaled ingredient quantity, each process's totalQuantity/
// netWeight, and the combined sum are each roundNice'd again) -- five compounding 0.01g roundings
// between "multiplier solved for" and "Portions Produced displayed", which on their own can leave
// the final combined Net Weight a hair below the exact target and cost a whole portion once
// Math.floor (computePortionsProducedLive) truncates it. On a multi-kilogram batch this is a few
// grams of headroom -- invisible to a chef, but enough to survive the rounding chain. See the
// investigation that led to this: simulating the full chain over 5000 randomized recipes without
// this margin landed exactly 1 portion short 36% of the time and never over; with it, 0/5000 short
// and 0/5000 over across the same randomized ranges (verified after adding this constant).
const TARGET_PORTIONS_SAFETY_MARGIN = 1.0008; // 0.08% -- middle of the 0.05-0.1% range that reliably covers the rounding chain without visibly over-provisioning the batch

// Computes the effective multiplier for "scale to target portion count" mode: (target portions x
// the recipe's Portion Weight (g)) / the ORIGINAL, unscaled combined Net Weight of the given
// processes -- never the currently-displayed/already-scaled figure, same discipline
// computeMultiplierFromTarget already applies to target-quantity mode, so repeated Calculate
// clicks always scale from the same 1x basis instead of compounding. Returns { error } when
// there's no Portion Weight set, nothing to divide by, or the target doesn't parse; { multiplier }
// otherwise.
function computeMultiplierFromTargetPortions(processes, targetPortionsText, portionWeightGrams) {
  const pw = parseFloat(portionWeightGrams);
  if (!pw || pw <= 0) {
    return { error: 'Set a Portion Weight (g) on this recipe before scaling to a target portion count.' };
  }
  const originalNetWeight = originalCombinedNetWeight(processes);
  if (!originalNetWeight || originalNetWeight <= 0) {
    return { error: 'This recipe has no ingredient quantities to scale against.' };
  }
  const target = parseFloat(targetPortionsText);
  if (!target || target <= 0) {
    return { error: 'Please enter a target portion count greater than 0, e.g. 50.' };
  }
  return { multiplier: (target * pw) / originalNetWeight * TARGET_PORTIONS_SAFETY_MARGIN };
}

function renderCalculatorView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Recipe Calculator</h1><span class="page-description">Scale a recipe -- export only, nothing is saved</span></div>
    </div>

    <div class="generate-controls">
      <div class="field source-field">
        <label>Recipe source</label>
        <div class="mode-toggle">
          <button type="button" class="mode-toggle-btn active" data-source="book">Recipe Book</button>
          <button type="button" class="mode-toggle-btn" data-source="extractor">Recipe Extractor</button>
          <button type="button" class="mode-toggle-btn" data-source="generated">Recipe Generator</button>
        </div>
      </div>
      <div class="field" style="min-width:260px;">
        <label>Recipe Name</label>
        <div class="autocomplete-wrap">
          <input id="calc-recipe-name" autocomplete="off" style="padding-right:28px; width:100%;" />
          <button type="button" class="autocomplete-browse-btn" id="calc-recipe-browse-btn" aria-label="Browse recipes" title="Browse all recipes">▾</button>
          <div class="autocomplete-list" id="calc-recipe-list" hidden></div>
        </div>
      </div>
      <div class="field" style="max-width:220px; display:none;" id="calc-process-field">
        <label>Process</label>
        <select id="calc-process-select"></select>
      </div>
      <div id="calc-single-scale-fields" style="display:contents;">
        <div class="field" style="max-width:200px;">
          <label id="calc-qty-original-label">Quantity Produced (original)</label>
          <input id="calc-qty-original" value="" disabled />
        </div>
        <div class="field" style="max-width:340px;">
          <label>Scaling Mode</label>
          <div class="mode-toggle">
            <button type="button" class="mode-toggle-btn active" data-mode="factor">Multiply by factor</button>
            <button type="button" class="mode-toggle-btn" data-mode="target">Scale to target quantity</button>
            <button type="button" class="mode-toggle-btn" data-mode="portions" id="calc-mode-portions-btn">Scale to target portions</button>
          </div>
        </div>
        <div class="field" style="max-width:120px;" id="calc-multiplier-field">
          <label>Multiplier</label>
          <input id="calc-multiplier" type="number" step="0.1" min="0" value="1" />
        </div>
        <div class="field" style="max-width:160px; display:none;" id="calc-target-field">
          <label>Target Total Quantity (g)</label>
          <input id="calc-target-qty" type="number" step="1" min="0" />
        </div>
        <div class="field" style="max-width:160px; display:none;" id="calc-portions-field">
          <label>Target Portion Count</label>
          <input id="calc-target-portions" type="number" step="1" min="0" />
        </div>
      </div>
      <div class="field" style="max-width:340px; display:none;" id="calc-multi-scale-field">
        <label>Multi-Process Scaling</label>
        <div class="mode-toggle">
          <button type="button" class="mode-toggle-btn active" data-multi-scale="together">Scale all processes together</button>
          <button type="button" class="mode-toggle-btn" data-multi-scale="independent">Scale each process independently</button>
        </div>
      </div>
      <div class="field" style="max-width:200px; display:none;" id="calc-all-portions-field">
        <label>Scale All to Target Portions</label>
        <input id="calc-all-portions-target" type="number" step="1" min="0" placeholder="e.g. 50" />
      </div>
      <button type="button" class="secondary" id="calc-all-portions-clear" style="display:none;" title="Clear the Scale All to Target Portions override">Reset to Default Scaling</button>
      <button class="primary" id="calc-calculate-btn" disabled>Calculate</button>
    </div>
    <div id="calc-mode-error" style="display:none; color:var(--danger, #c0392b); font-size:12.5px; margin:-10px 0 14px;"></div>

    <div id="calc-result"></div>
  `;

  const nameInput = document.getElementById('calc-recipe-name');
  const listEl = document.getElementById('calc-recipe-list');
  const browseBtn = document.getElementById('calc-recipe-browse-btn');
  const processField = document.getElementById('calc-process-field');
  const processSelect = document.getElementById('calc-process-select');
  const singleScaleFields = document.getElementById('calc-single-scale-fields');
  const qtyOriginalLabel = document.getElementById('calc-qty-original-label');
  const qtyOriginalInput = document.getElementById('calc-qty-original');
  const multiplierField = document.getElementById('calc-multiplier-field');
  const multiplierInput = document.getElementById('calc-multiplier');
  const targetField = document.getElementById('calc-target-field');
  const targetInput = document.getElementById('calc-target-qty');
  const portionsField = document.getElementById('calc-portions-field');
  const portionsInput = document.getElementById('calc-target-portions');
  const portionsModeBtn = document.getElementById('calc-mode-portions-btn');
  const multiScaleField = document.getElementById('calc-multi-scale-field');
  const allPortionsField = document.getElementById('calc-all-portions-field');
  const allPortionsInput = document.getElementById('calc-all-portions-target');
  const allPortionsClearBtn = document.getElementById('calc-all-portions-clear');
  const modeErrorEl = document.getElementById('calc-mode-error');
  const calculateBtn = document.getElementById('calc-calculate-btn');
  const resultEl = document.getElementById('calc-result');

  // Fetched once per Calculator view open, not per Calculate click -- same global catalog the
  // recipe form fetches once per form open, needed only to populate each process's own "+ Add
  // Waste" select in the editable result below (see renderCalcProcessWastes). Awaited at Calculate
  // time rather than blocking this view's initial render.
  const wasteTypesPromise = window.api.listWasteTypes();
  // Same one-fetch-per-view-open convention, backing each process card's Material/Tray picker.
  const materialsPromise = window.api.listMaterials();

  let source = 'book'; // 'book' | 'extractor'
  let scalingMode = 'factor';
  let selectedRecipe = null;
  // Full recipe is fetched once per selection (below) and cached here -- recipe-LEVEL fields only
  // (name/quantity_produced/prepared_by/category/country_origin/comment/presentation_serving) are
  // read/edited directly off this object; its own `.processes` (the pristine, as-saved array) is
  // never read again after workingProcesses is built from it below -- editing happens entirely on
  // the working copy, never on this or the DB. Comment is a plain string, edited in place by the
  // Comment textarea's own input listener (see renderScaledRecipeResult); Presentation goes
  // through the same Text/List toggle mechanism the recipe form uses (initTextListField below,
  // TEXT_LIST_FIELDS.calcPresentation), reusing that machinery unmodified since it has no
  // catalog-writing side effects of its own.
  let selectedFullRecipe = null;
  // The fully-editable, PERSISTENT working copy of every process on the selected recipe -- built
  // once per recipe selection via buildProcessFromSaved (the recipe form's own process-shaping
  // function, reused unmodified: it already produces exactly the {localId, id, name,
  // ingredientRows, wastes, methodMode/Text/Items} shape this needs, with zero DB/catalog calls of
  // its own). Structural edits (add/remove/reorder process or ingredient row, name/unit/method
  // edits, waste add/remove/percent, Method text) mutate this array/its objects directly and
  // PERSIST across Calculate/mode-switch/process-filter-change -- unlike each process's own
  // `multiplier`-derived `scaledIngredients`/`totalQuantity`/`netWeight`, which are recomputed
  // fresh (and freely hand-overridable) every render, exactly matching the original quantity-edit
  // design: scaling must always be relative to a stable, never-mutated-by-scaling 1x basis
  // (`ingredientRows[].quantity`), or repeated Calculate clicks would compound instead of always
  // scaling from the same original numbers.
  let workingProcesses = [];
  // The CURRENT scaling pool: the flattened 1x-basis ingredient rows of whichever process(es)
  // processSelection currently resolves to -- used for the "original" display and the
  // scale-to-target multiplier calc. Actual per-process scaling for export/display still reads
  // the real process objects via processesToScale(), not this flat view -- see
  // renderScaledRecipeResult.
  let selectedIngredients = null;
  // '__all__' or a specific process's localId (as a string). Irrelevant (and the picker stays
  // hidden) when the recipe has 1 process or fewer. Keyed by localId, not the DB `id` -- a
  // manually-added process has no DB id (null), so id-keying would collide the instant she adds a
  // second one; localId is always unique and always present, original or new alike.
  let processSelection = null;
  // Per-process scaling control state (own Mode/Multiplier/Target) when "All Processes" resolves
  // to 2+ processes -- processLocalId -> { mode, multiplier, target }. Lives here, not just in the
  // DOM, because renderScaledRecipeResult rebuilds its markup from scratch on every Calculate/
  // preview call (same "state object -> declarative render" convention the rest of this file
  // uses for ingredient/waste rows); this is what lets a typed multiplier survive a Calculate
  // click instead of visually resetting to "1". Reset fresh only when the process SET itself
  // changes -- see updateScalingControlsVisibility.
  let perProcessScaling = new Map();
  // 'together' (default) | 'independent' -- only meaningful when "All Processes" resolves to 2+
  // processes (see updateScalingControlsVisibility/calc-multi-scale-field). 'together' reuses the
  // single shared Mode/Multiplier/Target block (singleScaleFields) and applies its one multiplier
  // uniformly to every shown process; 'independent' is today's per-process inline-control behavior
  // (perProcessScaling). Defaults to 'together' -- the common case is one uniform scale, with
  // independent per-process control as the opt-in for genuinely different components (e.g.
  // Dough/Poolish).
  let multiScaleMode = 'together';
  // Tracks whether the currently-open list is the "browse all" list specifically, so a second
  // click on the browse button closes it instead of just re-opening the same full list -- but
  // starting to type (which hands the list over to wireRecipeAutocomplete's own search results)
  // clears it, so browse always shows the full list fresh rather than silently closing search results.
  let browseListShowing = false;

  function currentNs() {
    if (source === 'book') return RECIPE_NS.book;
    if (source === 'extractor') return RECIPE_NS.extractor;
    return RECIPE_NS.generated;
  }

  function allProcesses() {
    return workingProcesses;
  }

  // Which process objects actually get scaled/shown -- every process when there's only 1 (nothing
  // to choose) or when "All Processes" is picked, just the one matching processSelection otherwise.
  function processesToScale() {
    const procs = allProcesses();
    if (procs.length <= 1 || processSelection === '__all__' || !processSelection) return procs;
    return procs.filter(p => String(p.localId) === String(processSelection));
  }

  function populateProcessSelect() {
    const procs = allProcesses();
    if (procs.length <= 1) {
      processField.style.display = 'none';
      processSelect.innerHTML = '';
      return;
    }
    processField.style.display = 'flex';
    processSelect.innerHTML = [
      `<option value="__all__">All Processes</option>`,
      ...procs.map(p => `<option value="${p.localId}">${p.name || '(untitled process)'}</option>`),
    ].join('');
    processSelect.value = processSelection || '__all__';
  }

  function clearSelection() {
    selectedRecipe = null;
    selectedFullRecipe = null;
    workingProcesses = [];
    selectedIngredients = null;
    processSelection = null;
    processField.style.display = 'none';
    processSelect.innerHTML = '';
    qtyOriginalInput.value = '';
    calculateBtn.disabled = true;
    resultEl.innerHTML = '';
    modeErrorEl.style.display = 'none';
    singleScaleFields.style.display = 'contents';
    multiScaleField.style.display = 'none';
    allPortionsField.style.display = 'none';
    allPortionsClearBtn.style.display = 'none';
    allPortionsInput.value = '';
    perProcessScaling = new Map();
    multiScaleMode = 'together';
    document.querySelectorAll('.generate-controls [data-multi-scale]').forEach(b => b.classList.toggle('active', b.dataset.multiScale === multiScaleMode));
  }

  // "Quantity Produced (original)" shows the recipe-level free-text serving/container count in
  // Multiply-by-factor mode (what it's always meant). In Scale-to-target mode that field isn't
  // what the target is measured against -- so it switches to showing the actual basis (the
  // current scaling pool's total ingredient quantity), with the label swapped to match. Only
  // meaningful for the single-control case -- see updateScalingControlsVisibility, which is what
  // actually decides whether this or the per-process cards show.
  function updateQtyOriginalDisplay() {
    if (!selectedFullRecipe) return;
    if (scalingMode === 'factor') {
      qtyOriginalLabel.textContent = 'Quantity Produced (original)';
      qtyOriginalInput.value = selectedFullRecipe?.quantity_produced || '';
    } else if (scalingMode === 'target') {
      qtyOriginalLabel.textContent = 'Total Ingredient Quantity (original)';
      qtyOriginalInput.value = `${sumIngredientQuantities(selectedIngredients || [])}g`;
    } else {
      qtyOriginalLabel.textContent = 'Net Weight (original)';
      qtyOriginalInput.value = `${originalCombinedNetWeight(processesToScale())}g`;
    }
  }

  // Decides which scaling UI applies: the single shared Mode/Multiplier/Target block at the top
  // (a specific process is selected, the recipe has only one process to begin with, or "All
  // Processes" resolves to 2+ processes AND multiScaleMode is 'together') vs. one independent
  // scaling control per process ("All Processes" resolves to 2+ processes AND multiScaleMode is
  // 'independent'), rendered inline above each process's own section by renderCalcProcessCards --
  // see perProcessScaling. In the independent case, rebuilds the Map's KEY SET to match whichever
  // processes are currently shown, but PRESERVES each still-present process's own existing entry
  // (mode/multiplier/target she's already typed) rather than resetting it -- called after Add/
  // Remove/Reorder Process (via onProcessStructureChanged) as well as recipe pick/process-filter
  // change, and only the newly-shown-for-the-first-time processes should ever get fresh defaults;
  // a process that already existed shouldn't lose what she typed just because she added or
  // removed some OTHER process. (Switching multiScaleMode itself goes through a full reset
  // instead -- see the calc-multi-scale-field click handler -- since there's no sensible partial
  // migration between "one shared multiplier" and "N independent ones".)
  function updateScalingControlsVisibility() {
    const scaled = processesToScale();
    multiScaleField.style.display = scaled.length > 1 ? 'flex' : 'none';
    allPortionsField.style.display = scaled.length > 1 ? 'flex' : 'none';
    allPortionsClearBtn.style.display = scaled.length > 1 ? '' : 'none';

    const showSharedControls = scaled.length <= 1 || multiScaleMode === 'together';
    if (showSharedControls) {
      singleScaleFields.style.display = 'contents';
      perProcessScaling = new Map();
      // Scale-to-target-portions only makes sense against the recipe's whole finished product --
      // a single process filtered OUT of a multi-process recipe describes one component, not the
      // combined portion size, so the button (and mode, if she was already in it) is unavailable
      // in that one case even though the single-control block itself is still shown -- whether
      // that's because only 1 process is selected/exists, or because "Scale all processes
      // together" is applying this same block to the recipe's full set (scaled.length ===
      // allProcesses().length covers both).
      const portionsAvailable = scaled.length === allProcesses().length;
      portionsModeBtn.style.display = portionsAvailable ? '' : 'none';
      if (!portionsAvailable && scalingMode === 'portions') {
        scalingMode = 'factor';
        document.querySelectorAll('.generate-controls [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === scalingMode));
        multiplierField.style.display = 'flex';
        targetField.style.display = 'none';
        portionsField.style.display = 'none';
        multiplierInput.value = '';
        targetInput.value = '';
        portionsInput.value = '';
      }
      updateQtyOriginalDisplay();
    } else {
      singleScaleFields.style.display = 'none';
      const next = new Map();
      scaled.forEach(p => next.set(p.localId, perProcessScaling.get(p.localId) || { mode: 'factor', multiplier: '1', target: '' }));
      perProcessScaling = next;
    }
  }

  document.querySelectorAll('.generate-controls [data-source]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.source === source) return;
      source = btn.dataset.source;
      document.querySelectorAll('.generate-controls [data-source]').forEach(b => b.classList.toggle('active', b.dataset.source === source));
      nameInput.value = '';
      listEl.hidden = true;
      listEl.innerHTML = '';
      browseListShowing = false;
      clearSelection();
    });
  });

  document.querySelectorAll('.generate-controls [data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === scalingMode) return;
      scalingMode = btn.dataset.mode;
      document.querySelectorAll('.generate-controls [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === scalingMode));
      multiplierField.style.display = scalingMode === 'factor' ? 'flex' : 'none';
      targetField.style.display = scalingMode === 'target' ? 'flex' : 'none';
      portionsField.style.display = scalingMode === 'portions' ? 'flex' : 'none';
      // Clears whichever field she's leaving AND the one she's arriving at -- regardless of
      // direction -- so a value typed under the previous mode (e.g. Multiplier "20") never
      // silently carries over and reappears if she switches back later.
      multiplierInput.value = '';
      targetInput.value = '';
      portionsInput.value = '';
      modeErrorEl.style.display = 'none';
      updateQtyOriginalDisplay();
      // Whatever's currently shown was computed under the PREVIOUS mode (either a stale
      // Calculate result or the initial 1x preview) -- no multiplier/target has been entered yet
      // for the mode she just switched to, so the display resets back to unscaled/1x, same as
      // right after picking the recipe, rather than keep showing numbers that no longer match
      // what's selected.
      renderResultView(true);
    });
  });

  // "Scale all processes together" vs "Scale each process independently" -- only visible when
  // "All Processes" resolves to 2+ processes (see updateScalingControlsVisibility). Switching
  // clears every scale value currently entered -- the shared block's Multiplier/Target/Portions,
  // every process's own inline control (via the full perProcessScaling reset, since
  // updateScalingControlsVisibility rebuilds it from an empty Map below), and the sticky Scale All
  // to Target Portions override -- and shows the unscaled 1x preview, same "no confusing partial
  // migration, start fresh" reasoning as switching Scaling Mode above: there's no sensible way to
  // turn 2+ independent multipliers into one shared value, or vice versa.
  document.querySelectorAll('.generate-controls [data-multi-scale]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.multiScale === multiScaleMode) return;
      multiScaleMode = btn.dataset.multiScale;
      document.querySelectorAll('.generate-controls [data-multi-scale]').forEach(b => b.classList.toggle('active', b.dataset.multiScale === multiScaleMode));
      multiplierInput.value = '';
      targetInput.value = '';
      portionsInput.value = '';
      allPortionsInput.value = '';
      modeErrorEl.style.display = 'none';
      perProcessScaling = new Map();
      updateScalingControlsVisibility();
      renderResultView(true);
    });
  });

  // Backs out of "Scale All to Target Portions" -- clears the sticky field (so it stops
  // overriding future Calculate clicks), clears any error left showing, and resets whichever
  // scaling UI is currently active back to a clean default: every process's own inline
  // Mode/Multiplier/Target control in 'independent' mode (never hidden/disabled by the override in
  // the first place), or the shared block's Multiplier/Target/Portions in 'together' mode -- either
  // way, an explicit, unambiguous "start fresh" action instead of having to realize she can just
  // retype over the override field herself.
  allPortionsClearBtn.addEventListener('click', () => {
    allPortionsInput.value = '';
    modeErrorEl.style.display = 'none';
    if (multiScaleMode === 'independent') {
      processesToScale().forEach(p => perProcessScaling.set(p.localId, { mode: 'factor', multiplier: '1', target: '' }));
    } else {
      multiplierInput.value = '';
      targetInput.value = '';
      portionsInput.value = '';
    }
    renderResultView(true);
  });

  // Renders the currently-selected recipe/process(es) into #calc-result. `forceUnscaled` resets
  // every shown process's own `multiplier` to 1 first -- used by recipe pick, Scaling Mode switch,
  // and process-filter change, exactly the three moments that should visibly discard whatever was
  // previously calculated. A structural edit (add/remove/reorder a process or ingredient row) or a
  // successful Calculate instead passes false, preserving each process's own already-set
  // `multiplier` (Calculate sets it itself just before calling this) so unrelated processes/edits
  // aren't wiped out by an edit or Calculate elsewhere. previewToken guards against a slow
  // currentNs().api.get() or wasteTypesPromise resolving after she's already picked a different
  // recipe or process filter in the meantime -- same "superseded by a later pick" convention
  // onRecipePicked already uses below.
  let previewToken = 0;
  async function renderResultView(forceUnscaled) {
    const myToken = ++previewToken;
    if (!selectedFullRecipe) { resultEl.innerHTML = ''; return; }
    const scaled = processesToScale();
    scaled.forEach(p => { if (forceUnscaled || p.multiplier == null) p.multiplier = 1; });
    const wasteTypes = await wasteTypesPromise;
    const materials = await materialsPromise;
    if (myToken !== previewToken) return; // superseded by a later selection/process-filter change
    renderScaledRecipeResult(resultEl, currentNs(), selectedRecipe.id, selectedFullRecipe, workingProcesses, scaled, wasteTypes, materials, perProcessScaling, onProcessStructureChanged);
  }

  // Called after Add/Remove/Reorder Process (see renderCalcProcessCards) -- the process SET may
  // have changed, so the filter dropdown and its scaling-control state need to resync; the
  // process-filter selection itself falls back to "All Processes" if whatever was selected no
  // longer exists (e.g. she removed the one process the filter was scoped to). Passes false to
  // renderResultView -- a structural edit elsewhere shouldn't discard an already-Calculated scale.
  function onProcessStructureChanged() {
    if (processSelection !== '__all__' && !allProcesses().some(p => String(p.localId) === String(processSelection))) {
      processSelection = '__all__';
    }
    populateProcessSelect();
    selectedIngredients = processesToScale().flatMap(p => p.ingredientRows);
    updateScalingControlsVisibility();
    renderResultView(false);
  }

  processSelect.addEventListener('change', () => {
    processSelection = processSelect.value;
    selectedIngredients = processesToScale().flatMap(p => p.ingredientRows);
    updateScalingControlsVisibility();
    renderResultView(true);
  });

  async function onRecipePicked(recipe) {
    selectedRecipe = recipe;
    selectedFullRecipe = null;
    workingProcesses = [];
    selectedIngredients = null;
    processSelection = null;
    processField.style.display = 'none';
    nameInput.value = recipe.name;
    qtyOriginalInput.value = '…';
    calculateBtn.disabled = true;
    browseListShowing = false;
    previewToken++; // invalidate any preview still pending for a previously-picked recipe
    resultEl.innerHTML = '';

    const full = await currentNs().api.get(recipe.id);
    if (!selectedRecipe || selectedRecipe.id !== recipe.id) return; // superseded by a later pick

    selectedFullRecipe = full; // recipe-level fields (comment, presentation, etc.) edited directly on this
    // Photo edits are local/export-only, same guarantee as everything else in the Calculator --
    // existing photo(s) are fetched once per recipe selection into calc-prefixed fields on `full`
    // itself (same "fetched once, edited directly on this object" convention comment/presentation
    // already use), never touching `full.photo_path`/`full.photos` or the real saved recipe.
    if (currentNs().photoModel === 'gallery') {
      const paths = (full.photos || []).map(p => p.photo_path);
      const dataUrls = paths.length > 0 ? await currentNs().api.getPhotos(paths) : [];
      full.calcExistingPhotos = (full.photos || []).map((p, i) => ({ ...p, dataUrl: dataUrls[i] }));
      full.calcPendingPhotos = [];
    } else {
      full.calcExistingPhotoDataUrl = full.photo_path ? await currentNs().api.getPhoto(full.photo_path) : null;
      full.calcPendingPhoto = null;
      full.calcRemovePhoto = false;
    }
    if (!selectedRecipe || selectedRecipe.id !== recipe.id) return; // superseded during photo fetch

    // Reuses the recipe form's own process-shaping function unmodified -- see the comment on
    // workingProcesses above. Guarantees at least one (empty) process to edit, matching the form's
    // own "always at least 1 process" convention, in the unlikely case a saved recipe has none.
    workingProcesses = (full.processes || []).map(proc => buildProcessFromSaved(proc));
    if (workingProcesses.length === 0) workingProcesses.push(makeEmptyProcess());
    // Presentation's Text/List state lives directly on `full` (== selectedFullRecipe), reusing
    // TEXT_LIST_FIELDS.calcPresentation -- idempotent (only initializes once), so it's safe to
    // leave this call here even though renderScaledRecipeResult calls it again on every render.
    initTextListField(full, TEXT_LIST_FIELDS.calcPresentation, full.presentation_serving);
    processSelection = '__all__';
    populateProcessSelect();
    selectedIngredients = processesToScale().flatMap(p => p.ingredientRows);
    calculateBtn.disabled = false;
    updateScalingControlsVisibility();
    renderResultView(true);
  }

  nameInput.addEventListener('input', () => {
    clearSelection();
    browseListShowing = false;
  });

  wireRecipeAutocomplete(nameInput, listEl, onRecipePicked, (q) => currentNs().api.search(q));

  // Browsability: lets the chef see every recipe without already knowing part of the name to
  // type. Reuses the exact same render function and onRecipePicked callback as typed search, so
  // picking from either path is identical by construction. mousedown+preventDefault (not click)
  // for the same reason list items use it -- it needs to fire before the input's blur handler
  // hides the list.
  browseBtn.addEventListener('mousedown', async (e) => {
    e.preventDefault();
    if (browseListShowing && !listEl.hidden) {
      listEl.hidden = true;
      listEl.innerHTML = '';
      browseListShowing = false;
      return;
    }
    const all = await currentNs().api.list();
    const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
    renderRecipeAutocompleteList(listEl, sorted, nameInput, onRecipePicked, source === 'book' ? 'No recipes yet' : 'No extracted recipes yet');
    browseListShowing = true;
    nameInput.focus();
  });

  calculateBtn.addEventListener('click', async () => {
    if (!selectedFullRecipe || !selectedIngredients) return;
    modeErrorEl.style.display = 'none';

    const scaled = processesToScale();

    // "Scale All to Target Portions" -- takes priority over whichever scaling UI is currently
    // active on every Calculate click FOR AS LONG AS this field has a value (sticky, not a
    // one-shot -- see calc-all-portions-clear above for how she backs out of it), identically
    // whether processes are being scaled together or independently (multiScaleMode doesn't gate
    // this at all). Computes a single multiplier from the recipe's combined original Net Weight
    // and Portion Weight and applies it directly to every shown process; in 'independent' mode
    // also syncs each process's own inline control to 'factor' pre-filled with that multiplier so
    // it's visible and hand-tunable without needing another Calculate click ('together' mode has
    // no per-process controls to sync -- the shared block stays whatever it already showed).
    if (scaled.length > 1) {
      const allPortionsValue = allPortionsInput.value.trim();
      if (allPortionsValue) {
        const result = computeMultiplierFromTargetPortions(scaled, allPortionsValue, selectedFullRecipe.portion_weight_grams);
        if (result.error) {
          modeErrorEl.textContent = result.error;
          modeErrorEl.style.display = 'block';
          return;
        }
        scaled.forEach(proc => {
          proc.multiplier = result.multiplier;
          if (multiScaleMode === 'independent') {
            perProcessScaling.set(proc.localId, { mode: 'factor', multiplier: String(roundNice(result.multiplier)), target: '' });
          }
        });
        renderResultView(false);
        return;
      }
    }

    if (scaled.length > 1 && multiScaleMode === 'independent') {
      // Independent per-process scaling -- validate every process's own control (read from
      // perProcessScaling, kept live by the inline controls renderScaledRecipeResult renders
      // above each process's own section) and collect every error at once (unlike the
      // shared-control path below, more than one process can be invalid at the same time),
      // rather than stopping at the first. Error divs are queried directly off the currently
      // rendered result -- rendered fresh only on success below, so an error stays visible right
      // where she's looking rather than triggering a rebuild that would hide it. On success, each
      // process's own `multiplier` is set directly on it (not collected into a separate Map) --
      // renderResultView/renderScaledRecipeResult read it straight off the object.
      let hasError = false;
      for (const proc of scaled) {
        const st = perProcessScaling.get(proc.localId);
        const errorEl = resultEl.querySelector(`[data-proc-error="${proc.localId}"]`);
        if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

        if (st.mode !== 'target') {
          const val = parseFloat(st.multiplier);
          if (!val || val <= 0) {
            if (errorEl) { errorEl.textContent = 'Please enter a multiplier greater than 0.'; errorEl.style.display = 'block'; }
            hasError = true;
            continue;
          }
          proc.multiplier = val;
        } else {
          // Scoped to this process's OWN ingredients only -- scaling Dough to 5kg shouldn't be
          // measured against Poolish's ingredients too, unlike the shared-control path's target
          // mode, which is deliberately measured against whatever pool is currently selected.
          const result = computeMultiplierFromTarget(proc.ingredientRows, st.target);
          if (result.error) {
            if (errorEl) { errorEl.textContent = result.error; errorEl.style.display = 'block'; }
            hasError = true;
            continue;
          }
          proc.multiplier = result.multiplier;
        }
      }
      if (hasError) return;
    } else {
      // Shared Mode/Multiplier/Target block -- a single process (or a specific process selected),
      // or "Scale all processes together" applying this one multiplier uniformly to every shown
      // process (scaled.forEach below covers both: scaled has exactly 1 entry in the former case).
      let multiplier;
      if (scalingMode === 'factor') {
        multiplier = parseFloat(multiplierInput.value);
        if (!multiplier || multiplier <= 0) return alert('Please enter a multiplier greater than 0.');
      } else if (scalingMode === 'target') {
        const result = computeMultiplierFromTarget(selectedIngredients, targetInput.value);
        if (result.error) {
          modeErrorEl.textContent = result.error;
          modeErrorEl.style.display = 'block';
          return;
        }
        multiplier = result.multiplier;
      } else {
        const result = computeMultiplierFromTargetPortions(scaled, portionsInput.value, selectedFullRecipe.portion_weight_grams);
        if (result.error) {
          modeErrorEl.textContent = result.error;
          modeErrorEl.style.display = 'block';
          return;
        }
        multiplier = result.multiplier;
      }
      scaled.forEach(proc => { proc.multiplier = multiplier; });
    }

    renderResultView(false);
  });
}

// Same debounced-search-then-dropdown pattern as wireIngredientAutocomplete, minus the
// "add new" option -- the calculator only ever picks an existing saved recipe.
let _recipeAcDebounce = null;

// `searchFn` is a (query) => Promise<matches> function -- Recipe Calculator passes
// RECIPE_NS.book.api.search or RECIPE_NS.extractor.api.search depending on the selected source,
// so this one wiring works for either without knowing which table it's searching.
function wireRecipeAutocomplete(inputEl, listEl, onPick, searchFn) {
  inputEl.addEventListener('input', () => {
    const query = inputEl.value.trim();
    clearTimeout(_recipeAcDebounce);
    if (!query) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    _recipeAcDebounce = setTimeout(async () => {
      const matches = await searchFn(query);
      renderRecipeAutocompleteList(listEl, matches, inputEl, onPick);
    }, 150);
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => { listEl.hidden = true; }, 150);
  });
  inputEl.addEventListener('focus', () => {
    if (listEl.innerHTML) listEl.hidden = false;
  });
}

function renderRecipeAutocompleteList(listEl, matches, inputEl, onPick, emptyMessage) {
  if (matches.length === 0) {
    listEl.innerHTML = `<div class="autocomplete-item">${emptyMessage || 'No matching recipes'}</div>`;
    listEl.hidden = false;
    return;
  }
  listEl.innerHTML = matches.map(m => `
    <div class="autocomplete-item" data-pick="${m.id}">
      <span>${m.name}</span>
      <span class="autocomplete-meta">${[m.code, m.category].filter(Boolean).join(' · ')}</span>
    </div>
  `).join('');
  listEl.hidden = false;

  listEl.querySelectorAll('[data-pick]').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const match = matches.find(m => m.id === parseInt(el.dataset.pick, 10));
      onPick(match);
      listEl.hidden = true;
      listEl.innerHTML = '';
    });
  });
}

function renderCalcProcessWasteRow(proc, w, row) {
  const reducedText = row.reduced > 0 ? `−${row.reduced} G` : '0 G';
  return `
    <div class="process-waste-row" data-waste="${w.localId}">
      <span class="process-waste-name" dir="auto">${w.name}</span>
      <input type="number" min="0" max="100" step="0.1" id="calc-waste-${proc.localId}-${w.localId}" class="process-waste-percent" value="${w.percent ?? ''}" />
      <span class="process-waste-percent-sign">%</span>
      <span class="process-waste-reduced" id="calc-waste-reduced-${proc.localId}-${w.localId}">${reducedText}</span>
      <span class="process-waste-running" id="calc-waste-running-${proc.localId}-${w.localId}">→ ${row.after} G</span>
      <button type="button" class="icon-btn danger" data-calc-remove-waste="${w.localId}">Remove</button>
    </div>
  `;
}

// The Calculator's own stripped-down sibling of renderProcessWastes -- percent-edit and add/
// remove only, scoped strictly to this in-memory calculation. Deliberately has NO "Update" button
// and no "+ Create new waste type..." option: both of those write back to the shared waste_types
// catalog on the form's version (onWastePercentUpdateClicked / showCreateWasteTypeForm), which
// would break the Calculator's export-only/nothing-saved guarantee. A percent edit here never
// prompts anything -- it just updates the in-memory value and calls onChange to recompute. Keyed
// by proc.localId (not proc.id) throughout -- a manually-added process has no DB id.
function renderCalcProcessWastes(proc, wasteTypes, onChange) {
  const rowsEl = document.getElementById(`calc-wastes-${proc.localId}`);
  const selectEl = document.querySelector(`[data-calc-add-waste="${proc.localId}"]`);
  if (!rowsEl || !selectEl) return;

  // Same basis refreshProcessCalc itself uses for proc.totalQuantity -- computed directly here
  // (not read off proc.totalQuantity) so the very first render is correct even before
  // refreshProcessCalc has run once.
  const baseQty = sumIngredientQuantities(proc.scaledIngredients || []);
  const waterfall = computeWasteWaterfall(baseQty, proc.wastes);

  rowsEl.innerHTML = proc.wastes.length > 0
    ? proc.wastes.map((w, i) => renderCalcProcessWasteRow(proc, w, waterfall[i])).join('')
    : `<div class="process-waste-empty">No wastes applied.</div>`;

  proc.wastes.forEach(w => {
    const input = document.getElementById(`calc-waste-${proc.localId}-${w.localId}`);
    input.addEventListener('input', () => { w.percent = input.value; onChange(); });
  });
  rowsEl.querySelectorAll('[data-calc-remove-waste]').forEach(btn => {
    btn.addEventListener('click', () => {
      const localId = parseInt(btn.dataset.calcRemoveWaste, 10);
      proc.wastes = proc.wastes.filter(w => w.localId !== localId);
      renderCalcProcessWastes(proc, wasteTypes, onChange);
      onChange();
    });
  });

  // Reassigned (not addEventListener) every render, same convention renderProcessWastes uses --
  // selectEl persists across a rows-only refresh, so this avoids stacking duplicate handlers.
  const availableTypes = wasteTypes.filter(wt => !proc.wastes.some(w => w.wasteTypeId === wt.id));
  selectEl.innerHTML = `<option value="">+ Add Waste…</option>` +
    availableTypes.map(wt => `<option value="${wt.id}">${wt.name} (${wt.default_percent}%)</option>`).join('');
  selectEl.value = '';
  selectEl.onchange = () => {
    const rawValue = selectEl.value;
    selectEl.value = '';
    if (!rawValue) return;
    const wasteTypeId = parseInt(rawValue, 10);
    const wt = wasteTypes.find(w => w.id === wasteTypeId);
    if (!wt) return;
    proc.wastes.push({ localId: ++_recipeRowLocalIdCounter, wasteTypeId: wt.id, name: wt.name, percent: wt.default_percent });
    renderCalcProcessWastes(proc, wasteTypes, onChange);
    onChange();
  };
}

// One process's own Scaling Mode/Multiplier/Target, rendered inline above that process's own
// section (see perProcessScaling on renderCalcProcessCards below) -- same visual language as
// the single-control block at the top of the Calculator. Values are pre-filled from `state`
// (renderCalculatorView's perProcessScaling entry for this process) so a value she's already
// typed survives a Calculate/preview rebuild instead of resetting. Keyed by proc.localId, same
// reason as the waste rows above.
function renderInlineProcessScalingControls(proc, state) {
  return `
    <div class="process-scaling-inline" data-scale-process="${proc.localId}">
      <div class="field" style="max-width:240px;">
        <label>Scaling Mode</label>
        <div class="mode-toggle">
          <button type="button" class="mode-toggle-btn ${state.mode === 'factor' ? 'active' : ''}" data-proc-mode-btn="factor">Multiply by factor</button>
          <button type="button" class="mode-toggle-btn ${state.mode === 'target' ? 'active' : ''}" data-proc-mode-btn="target">Scale to target quantity</button>
        </div>
      </div>
      <div class="field" style="max-width:120px; ${state.mode === 'factor' ? '' : 'display:none;'}" data-proc-multiplier-field>
        <label>Multiplier</label>
        <input type="number" step="0.1" min="0" value="${state.multiplier}" data-proc-multiplier />
      </div>
      <div class="field" style="max-width:160px; ${state.mode === 'target' ? '' : 'display:none;'}" data-proc-target-field>
        <label>Target Total Quantity (g)</label>
        <input type="number" step="1" min="0" value="${state.target}" data-proc-target />
      </div>
    </div>
    <div data-proc-error="${proc.localId}" style="display:none; color:var(--danger, #c0392b); font-size:12px; margin:0 0 10px;"></div>
  `;
}

// The Calculator's own lightweight sibling of renderProcessIngredientRows -- plain text inputs
// only, no autocomplete/catalog matching at all: a row added here is pure free text, never linked
// to the real ingredients/extracted_ingredients table, per the Calculator's export-only nature
// (genuinely simpler than the form's version, not a stripped-down copy of it). Reuses
// wireProcessIngredientRowDrag UNCHANGED for drag-and-drop reordering -- it only ever splices
// process.ingredientRows by localId, no catalog coupling to strip out.
//
// Quantity is the one column NOT bound directly to the persistent row: the Quantity input is
// bound to process.scaledIngredients[i] instead, preserving the original quantity-edit contract --
// freely hand-overridable for this one calculation, reset back to multiplier x original Qty on
// the next Calculate. Original Qty (process.ingredientRows[].quantity) is this calculation
// session's own editable starting/base quantity -- session-local only, never read by
// save-recipe/save-extracted-recipe, so editing it (like everything else here) never touches
// recipe_ingredients/extracted_recipe_ingredients. Name/Unit/Method/Original-Qty bind directly to
// the persistent row.
//
// scaledIngredients is rebuilt every call by carrying forward each row's existing entry (keyed by
// localId, since scaleIngredients spreads it onto every entry) rather than unconditionally
// recomputing basis x multiplier -- only a genuinely new row (just added, no existing entry yet)
// gets a fresh computation. Without this, any hand-typed Quantity/Original Qty edit would be
// silently discarded by the next unrelated Add/Remove/Reorder Ingredient Row action -- for a
// brand-new ingredient (no ingredientRows-level basis at all) that meant its quantity vanishing
// from Total Quantity/Net Weight entirely, not just resetting to some fallback number. The actual
// reset-to-basis-x-multiplier still happens on a real Calculate click, since
// renderScaledRecipeResult's own top-level scaleIngredients() call runs first on every Calculate
// and its result is exactly what gets carried forward here on that render.
function renderCalcIngredientRows(process, tbodyEl, onChange) {
  const prevByLocalId = new Map((process.scaledIngredients || []).map(ing => [ing.localId, ing]));
  process.scaledIngredients = process.ingredientRows.map(row =>
    prevByLocalId.get(row.localId) || scaleIngredients([row], process.multiplier ?? 1)[0]);

  tbodyEl.innerHTML = process.ingredientRows.map((row, i) => `
    <tr data-row="${row.localId}">
      <td class="row-drag-handle-cell"><span class="row-drag-handle" data-drag-handle="${row.localId}" draggable="true" title="Drag to reorder">⠿</span></td>
      <td><input class="calc-ing-name" value="${row.name}" dir="auto" /></td>
      <td><input class="calc-ing-orig-qty" value="${formatIngredientQty(row.quantity)}" title="This calculation's starting/base quantity -- editable, never saved to the recipe" /></td>
      <td><input class="calc-ing-qty" value="${formatIngredientQty(process.scaledIngredients[i].quantity)}" /></td>
      <td><input class="calc-ing-unit" value="${row.unit}" /></td>
      <td><input class="calc-ing-method" value="${row.method}" dir="auto" /></td>
      <td style="text-align:right"><button type="button" class="icon-btn danger" data-row-remove="${row.localId}">Remove</button></td>
    </tr>
  `).join('');

  // Name/Unit/Method must be mirrored into scaledIngredients[i] (not just written to the
  // persistent row) because the Export payload reads ingredient fields off scaledIngredients
  // exclusively (see renderScaledRecipeResult's calc-export-btn handler), and because it's what
  // the carry-forward-by-localId rebuild above reuses on the next render -- without this mirror a
  // plain field edit here would silently never reach the exported file (this was the root cause
  // of both the "new ingredient missing from export" and "unit change not reflected in export"
  // bugs) or survive an unrelated Add/Remove/Reorder Ingredient Row action. Quantity already
  // worked this way -- kept as-is below.
  process.ingredientRows.forEach((row, i) => {
    const tr = tbodyEl.querySelector(`tr[data-row="${row.localId}"]`);
    tr.querySelector('.calc-ing-name').addEventListener('input', (e) => {
      row.name = e.target.value;
      process.scaledIngredients[i].name = e.target.value;
    });
    // Original Qty -- editing it wins over any previous manual override of the scaled Quantity
    // column: recomputes that column fresh from the new basis x the process's current multiplier
    // (reusing scaleIngredients, the same math the initial/Calculate-time computation uses),
    // since she's redefining the starting point and expects the derived number to follow.
    tr.querySelector('.calc-ing-orig-qty').addEventListener('input', (e) => {
      row.quantity = e.target.value;
      const recomputed = scaleIngredients([row], process.multiplier ?? 1)[0];
      process.scaledIngredients[i] = { ...process.scaledIngredients[i], quantity: recomputed.quantity };
      tr.querySelector('.calc-ing-qty').value = formatIngredientQty(process.scaledIngredients[i].quantity);
      onChange();
    });
    tr.querySelector('.calc-ing-unit').addEventListener('input', (e) => {
      row.unit = e.target.value;
      process.scaledIngredients[i].unit = e.target.value;
    });
    tr.querySelector('.calc-ing-method').addEventListener('input', (e) => {
      row.method = e.target.value;
      process.scaledIngredients[i].method = e.target.value;
    });
    tr.querySelector('.calc-ing-qty').addEventListener('input', (e) => {
      process.scaledIngredients[i].quantity = e.target.value;
      onChange();
    });
  });

  tbodyEl.querySelectorAll('[data-row-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.rowRemove, 10);
      process.ingredientRows = process.ingredientRows.filter(r => r.localId !== id);
      if (process.ingredientRows.length === 0) process.ingredientRows.push(makeEmptyIngredientRow());
      renderCalcIngredientRows(process, tbodyEl, onChange);
    });
  });

  wireProcessIngredientRowDrag(process, tbodyEl, () => renderCalcIngredientRows(process, tbodyEl, onChange));
  onChange();
}

// Calculator's own sibling of the recipe form's renderProcessCards -- builds/wires every process
// card currently in view: name, ingredient rows (renderCalcIngredientRows), waste rows
// (renderCalcProcessWastes), Method (the recipe form's own Text/List toggle, reused unmodified --
// see buildProcessFromSaved/makeEmptyProcess, which already initialize each process's
// methodMode/Text/Items), inline scaling control, and Total Quantity/Net Weight. Add/Remove/
// Reorder Process mutate `workingProcesses` (the FULL persistent list, not just whatever's
// currently filtered/shown) and then hand off to `onStructureChanged` for a full outer re-render
// -- simplest way to keep the process-filter dropdown, perProcessScaling, and the shown set all
// back in sync after membership changes, rather than re-deriving all of that locally too.
function renderCalcProcessCards(ns, workingProcesses, processesShown, wasteTypes, materials, mountEl, perProcessScaling, onStructureChanged, recomputeCombined) {
  mountEl.innerHTML = processesShown.map((proc, idx) => `
    <div class="process-card" data-process="${proc.localId}">
      <div class="process-card-head">
        <input aria-label="Process name" placeholder="Name this process, e.g. dough or filling" class="process-name-input" value="${proc.name}" dir="auto" />
        <span style="font-size:12px; color:var(--neutral); font-weight:400;">×${roundNice(proc.multiplier ?? 1)}</span>
        <button type="button" class="icon-btn" data-move-process-up="${proc.localId}" title="Move process up" aria-label="Move process up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="icon-btn" data-move-process-down="${proc.localId}" title="Move process down" aria-label="Move process down" ${idx === processesShown.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="icon-btn danger" data-remove-process="${proc.localId}" ${workingProcesses.length <= 1 ? 'disabled' : ''}>Remove Process</button>
      </div>
      ${perProcessScaling && perProcessScaling.has(proc.localId) ? renderInlineProcessScalingControls(proc, perProcessScaling.get(proc.localId)) : ''}
      <table class="recipe-ingredients-table">
        <thead><tr><th></th><th>Ingredient</th><th>Original Qty</th><th>Quantity</th><th>Unit</th><th>Method</th><th></th></tr></thead>
        <tbody class="calc-ing-rows"></tbody>
      </table>
      <button type="button" class="secondary calc-add-row-btn" style="margin:8px 0 16px;">+ Add Ingredient Row</button>
      <div class="field" style="max-width:220px; margin-bottom:14px;">
        <label>Total Quantity</label>
        <div id="calc-total-${proc.localId}" class="computed-value-box">0 G</div>
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Wastes Applied</label>
        <div class="process-waste-rows" id="calc-wastes-${proc.localId}"></div>
        <select data-calc-add-waste="${proc.localId}" style="margin-top:6px; max-width:240px;"></select>
      </div>
      <div class="field" style="max-width:220px; margin-bottom:14px;">
        <label>Net Weight (scaled)</label>
        <div id="calc-netweight-${proc.localId}" class="computed-value-box">0 G</div>
      </div>
      <div class="field" style="max-width:280px; margin-bottom:14px;">
        <label>Material / Tray</label>
        <select class="builder-select" id="calc-material-${proc.localId}">
          <option value="">— None —</option>
          ${materials.map(m => `<option value="${m.id}" ${proc.materialId === m.id ? 'selected' : ''}>${m.code} — ${m.name}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="max-width:220px; margin-bottom:14px; display:${proc.materialId ? 'flex' : 'none'};" id="calc-material-fill-wrap-${proc.localId}">
        <label>Fill Weight (g)</label>
        <input type="number" min="0" step="0.1" id="calc-material-fill-${proc.localId}" value="${proc.materialFillWeightGrams ?? ''}" />
      </div>
      <div class="field" style="max-width:220px; margin-bottom:14px; display:${proc.materialId ? 'flex' : 'none'};" id="calc-trays-wrap-${proc.localId}">
        <label>Trays Needed</label>
        <div class="computed-value-box" id="calc-trays-${proc.localId}">–</div>
      </div>
      <div class="field" style="margin-top:8px;">
        <label>Method</label>
        <div id="${makeProcessMethodCfg(proc).mountId}"></div>
      </div>
    </div>
  `).join('');

  // Recomputes one process's Total Quantity/Net Weight from its current (possibly edited)
  // scaledIngredients/wastes, writes both back to the DOM, then rolls the recipe-level combined
  // Net Weight forward too -- same "mutate the object, recompute, write the DOM" pattern
  // updateProcessNetWeight/updateNetWeightSum use live in the recipe form.
  function refreshProcessCalc(proc) {
    proc.totalQuantity = sumIngredientQuantities(proc.scaledIngredients || []);
    proc.netWeight = compoundWasteYield(proc.totalQuantity, proc.wastes);
    const totalEl = document.getElementById(`calc-total-${proc.localId}`);
    const yieldEl = document.getElementById(`calc-netweight-${proc.localId}`);
    if (totalEl) totalEl.textContent = `${proc.totalQuantity} G`;
    if (yieldEl) yieldEl.textContent = `${proc.netWeight} G`;

    // Same reasoning as updateProcessNetWeight's own call -- covers every path that recomputes
    // this process's totals, waste % edits included (see renderCalcProcessWastes' onChange).
    refreshProcessWasteWaterfallDisplay(proc, proc.totalQuantity, 'calc');

    // Trays Needed -- same ceil-not-round reasoning as updateProcessNetWeight's ep-trays-<id> in
    // the recipe form, just against this process's SCALED Net Weight instead of the unscaled one.
    const traysEl = document.getElementById(`calc-trays-${proc.localId}`);
    if (traysEl) {
      const fill = parseFloat(proc.materialFillWeightGrams);
      traysEl.textContent = (proc.materialId && !isNaN(fill) && fill > 0)
        ? String(Math.ceil(proc.netWeight / fill))
        : '–';
    }

    recomputeCombined();
  }

  processesShown.forEach(proc => {
    const card = mountEl.querySelector(`[data-process="${proc.localId}"]`);

    card.querySelector('.process-name-input').addEventListener('input', (e) => { proc.name = e.target.value; });

    card.querySelector('[data-remove-process]').addEventListener('click', () => {
      const i = workingProcesses.findIndex(p => p.localId === proc.localId);
      if (i === -1) return;
      workingProcesses.splice(i, 1);
      if (workingProcesses.length === 0) workingProcesses.push(makeEmptyProcess());
      onStructureChanged();
    });

    // Same "swap in the array, then re-render" reorder technique the recipe form's own
    // renderProcessCards uses (no separate function to import -- it's a 3-line inline pattern
    // there too), just operating on the Calculator's own workingProcesses.
    card.querySelector('[data-move-process-up]').addEventListener('click', () => {
      const i = workingProcesses.findIndex(p => p.localId === proc.localId);
      if (i <= 0) return;
      [workingProcesses[i - 1], workingProcesses[i]] = [workingProcesses[i], workingProcesses[i - 1]];
      onStructureChanged();
    });
    card.querySelector('[data-move-process-down]').addEventListener('click', () => {
      const i = workingProcesses.findIndex(p => p.localId === proc.localId);
      if (i === -1 || i >= workingProcesses.length - 1) return;
      [workingProcesses[i], workingProcesses[i + 1]] = [workingProcesses[i + 1], workingProcesses[i]];
      onStructureChanged();
    });

    const tbody = card.querySelector('.calc-ing-rows');
    const onIngredientChange = () => refreshProcessCalc(proc);
    renderCalcIngredientRows(proc, tbody, onIngredientChange);

    card.querySelector('.calc-add-row-btn').addEventListener('click', () => {
      proc.ingredientRows.push(makeEmptyIngredientRow());
      renderCalcIngredientRows(proc, tbody, onIngredientChange);
    });

    renderCalcProcessWastes(proc, wasteTypes, () => refreshProcessCalc(proc));

    // Material/Tray link -- same behavior as the recipe form's own ep-material-<id> control (Fill
    // Weight resets to the newly-picked material's catalog default, editable per this working copy
    // only; never written back to `materials` or the saved recipe -- export-only, like everything
    // else here).
    const materialSelect = card.querySelector(`#calc-material-${proc.localId}`);
    const fillInput = card.querySelector(`#calc-material-fill-${proc.localId}`);
    const fillWrap = card.querySelector(`#calc-material-fill-wrap-${proc.localId}`);
    const traysWrap = card.querySelector(`#calc-trays-wrap-${proc.localId}`);
    materialSelect.addEventListener('change', () => {
      const id = materialSelect.value ? parseInt(materialSelect.value, 10) : null;
      proc.materialId = id;
      const mat = materials.find(m => m.id === id);
      proc.materialFillWeightGrams = mat ? materialCapacityGrams(mat) : null;
      fillInput.value = proc.materialFillWeightGrams ?? '';
      fillWrap.style.display = id ? 'flex' : 'none';
      traysWrap.style.display = id ? 'flex' : 'none';
      refreshProcessCalc(proc);
    });
    fillInput.addEventListener('input', () => {
      const v = parseFloat(fillInput.value);
      proc.materialFillWeightGrams = isNaN(v) ? null : v;
      refreshProcessCalc(proc);
    });

    renderTextListFieldBody(proc, makeProcessMethodCfg(proc));

    // Wire this process's own inline scaling control, if it has one (empty perProcessScaling in
    // single-process mode means nothing to find here). Mutates the shared perProcessScaling entry
    // directly -- read back by calculateBtn's click handler in renderCalculatorView -- and never
    // triggers a recompute/rerender itself: the multiplier only takes effect on the next Calculate.
    const scalingState = perProcessScaling && perProcessScaling.get(proc.localId);
    if (scalingState) {
      const controlEl = card.querySelector(`[data-scale-process="${proc.localId}"]`);
      controlEl.querySelectorAll('[data-proc-mode-btn]').forEach(btn => {
        btn.addEventListener('click', () => {
          scalingState.mode = btn.dataset.procModeBtn;
          controlEl.querySelectorAll('[data-proc-mode-btn]').forEach(b => b.classList.toggle('active', b.dataset.procModeBtn === scalingState.mode));
          controlEl.querySelector('[data-proc-multiplier-field]').style.display = scalingState.mode === 'factor' ? 'flex' : 'none';
          controlEl.querySelector('[data-proc-target-field]').style.display = scalingState.mode === 'target' ? 'flex' : 'none';
          const errEl = card.querySelector(`[data-proc-error="${proc.localId}"]`);
          if (errEl) errEl.style.display = 'none';
        });
      });
      controlEl.querySelector('[data-proc-multiplier]')?.addEventListener('input', (e) => { scalingState.multiplier = e.target.value; });
      controlEl.querySelector('[data-proc-target]')?.addEventListener('input', (e) => { scalingState.target = e.target.value; });
    }
    // No explicit initial refreshProcessCalc call needed here -- renderCalcIngredientRows above
    // already calls its own onChange (== refreshProcessCalc) once at the end of every render,
    // including this first one, and the Total Quantity/Net Weight elements it writes into already
    // exist by then (mountEl.innerHTML was set before this loop started).
  });
}

// `workingProcesses` is the FULL persistent list (see renderCalculatorView) -- needed here only
// so "+ Add Process" and renderCalcProcessCards' own remove/reorder handlers can mutate it;
// `processesShown` is whichever subset processesToScale() currently resolves to, and is what
// actually gets rendered/scaled/exported. `perProcessScaling` non-empty only in "All Processes" /
// 2+ processes mode -- see renderInlineProcessScalingControls.
//
// `wasteTypes` is the global waste-type catalog (fetched once per Calculator view open, see
// renderCalculatorView), needed only to populate each process's own "+ Add Waste" select here --
// same catalog the recipe form uses, but nothing added/edited through it ever writes back to that
// catalog or to the saved recipe: everything below (ingredient rows, waste rows, Method,
// Presentation, Comment, process add/remove/reorder) is editable purely in-memory, on
// workingProcesses/`recipe`, matching the Calculator's "export only, nothing is saved" tagline.
// Export (the button wired at the bottom of this function) reads straight off these same mutated
// objects at click time, so whatever she's edited is exactly what gets sent.
function renderScaledRecipeResult(container, ns, recipeId, recipe, workingProcesses, processesShown, wasteTypes, materials, perProcessScaling, onStructureChanged) {
  fillRecipePeopleList();
  // Each shown process's own scaled view, derived fresh from its persistent 1x-basis
  // ingredientRows and its own `multiplier` (set directly on the object by Calculate, or forced
  // to 1 by renderResultView(true) -- see renderCalculatorView). Recomputed here up front so the
  // header's combined Net Weight/Quantity Produced figures below have something to read; each
  // process's own numbers are re-derived the same way by refreshProcessCalc as she edits.
  const scaledSets = scaleIngredientSets(processesShown.map(p => p.ingredientRows), processesShown.map(p => p.multiplier ?? 1));
  processesShown.forEach((proc, i) => {
    proc.scaledIngredients = scaledSets[i];
    proc.totalQuantity = sumIngredientQuantities(proc.scaledIngredients);
    proc.netWeight = compoundWasteYield(proc.totalQuantity, proc.wastes);
  });

  // Recipe-level Net Weight is the sum of every shown process's own scaled, waste-adjusted net
  // weight -- same convention updateNetWeightSum uses live in the form. Reassigned (not const) --
  // recomputeCombined below keeps it live as she edits quantities/wastes/rows/processes.
  let combinedNetWeight = roundNice(processesShown.reduce((sum, p) => sum + p.netWeight, 0));
  // Same floor-not-round-or-ceil reasoning as updateNetWeightSum's rf-portions-produced in the
  // recipe form -- a yield count of whole, actually-cuttable portions, not a capacity requirement.
  function computePortionsProducedLive() {
    const pw = parseFloat(recipe.portion_weight_grams);
    return (!isNaN(pw) && pw > 0) ? Math.floor(combinedNetWeight / pw) : null;
  }
  let portionsProduced = computePortionsProducedLive();

  // 2+ processes scaled together with (possibly) different multipliers each -- there's no
  // longer one coherent scale factor for the recipe-level Quantity Produced to apply, so it's
  // shown unscaled, for context only.
  const isMultiProcessScaling = processesShown.length > 1;
  const quantityProducedScaled = isMultiProcessScaling
    ? null
    : scaleQuantityProducedText(recipe.quantity_produced, processesShown[0]?.multiplier ?? 1);

  // Idempotent (only initializes once per recipe selection -- see the guard at the top of
  // initTextListField) -- also called once up front in onRecipePicked, but harmless/necessary to
  // repeat here since this is what renderTextListFieldBody below actually reads.
  initTextListField(recipe, TEXT_LIST_FIELDS.calcPresentation, recipe.presentation_serving);

  container.innerHTML = `
    <div class="day-card">
      <div class="day-head">
        <span>${recipe.name}</span>
      </div>
      <div style="padding:16px 18px;">
        <div class="generate-controls" style="border:none; padding:0; margin-bottom:18px;">
          <div class="field"><label>Quantity Produced (original)</label><input id="calc-qty-produced" value="${recipe.quantity_produced || ''}" dir="auto" /></div>
          <div class="field"><label>Quantity Produced (scaled)</label><div class="computed-value-box">${quantityProducedScaled || (isMultiProcessScaling ? 'Scaled independently per process' : '—')}</div></div>
          <div class="field"><label>Portion Weight (g)</label><input id="calc-portion-weight" type="number" min="0" step="0.1" value="${recipe.portion_weight_grams ?? ''}" /></div>
          <div class="field"><label>Prepared By</label><input id="calc-prepared-by" list="recipe-people-list" value="${recipe.prepared_by || ''}" dir="auto" /></div>
          <div class="field"><label>Category</label><input id="calc-category" value="${recipe.category || ''}" dir="auto" /></div>
          <div class="field"><label>Country/Origin</label><input id="calc-country" value="${recipe.country_origin || ''}" dir="auto" /></div>
          <div class="field"><label>Net Weight (scaled, combined)</label><div id="calc-combined-netweight" class="computed-value-box">${combinedNetWeight} G</div></div>
          <div class="field"><label>Portions Produced</label><div id="calc-portions-produced" class="computed-value-box">${portionsProduced ?? '–'}</div></div>
        </div>

        <div id="calc-process-cards"></div>
        <button type="button" class="secondary" id="calc-add-process-btn" style="margin:10px 0 20px;">+ Add Process</button>

        <div class="field" style="margin:16px 0;">
          <label>Presentation / Decoration / Serving</label>
          <div id="calc-presentation-field"></div>
        </div>
        <div class="field" style="margin-bottom:16px;">
          <label>Comment</label>
          <textarea id="calc-comment" rows="3" dir="auto">${recipe.comment || ''}</textarea>
        </div>

        ${ns.photoModel === 'gallery' ? `
        <div class="field" style="margin-bottom:20px;">
          <label>Photos (up to 10) -- export only, never saved to the recipe</label>
          <div id="calc-photo-gallery" class="photo-gallery"></div>
          <input type="file" id="calc-photo-input" accept="image/jpeg,image/png" multiple />
        </div>
        ` : `
        <div class="field" style="margin-bottom:16px; max-width:320px;">
          <label>Photo -- export only, never saved to the recipe</label>
          <input type="file" id="calc-photo-input" accept="image/jpeg,image/png" />
          <div id="calc-photo-preview-wrap" style="margin-top:8px; display:none;">
            <img id="calc-photo-preview" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block;" />
            <button type="button" class="secondary" id="calc-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
          </div>
        </div>
        `}

        <label style="display:flex; align-items:center; gap:6px; margin-bottom:12px; font-size:12.5px; color:var(--neutral);">
          <input type="checkbox" id="calc-include-original-qty" /> Include Original Quantity column
        </label>
        <div style="display:flex; align-items:center; gap:10px;">
          <button class="primary" id="calc-export-btn">Export to Excel</button>
          ${exportLanguagePickerHtml('calc')}
        </div>
        <div id="calc-export-progress-wrap" style="margin-top:10px;"></div>
      </div>
    </div>
  `;
  wireExportLanguagePicker('calc');
  renderTextListFieldBody(recipe, TEXT_LIST_FIELDS.calcPresentation);
  document.getElementById('calc-comment').addEventListener('input', (e) => { recipe.comment = e.target.value; });
  // Recipe-level header fields -- plain in-place edits on the same persistent `recipe` object
  // Comment uses, so they survive Calculate/mode-switch/structural edits exactly like it does.
  // Quantity Produced (scaled), just above, is deliberately left read-only/derived -- it's
  // regenerated from calc-qty-produced's value the next time this view re-renders, rather than
  // being a second, independently-editable field that could drift out of sync with it.
  document.getElementById('calc-qty-produced').addEventListener('input', (e) => { recipe.quantity_produced = e.target.value; });
  // Numeric (unlike the rest of these header fields) -- parsed on input so whatever ends up on
  // recipe.portion_weight_grams is already the right type for export, same as the recipe form's
  // own payload construction; export reads this straight off `recipe` via the plain object
  // spread below (no separate export-payload field for it), so nothing else needs to change for
  // it to reach the .xlsx -- exactly the same "no extra plumbing" pattern every other header
  // field here already relies on.
  document.getElementById('calc-portion-weight').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    recipe.portion_weight_grams = raw === '' ? null : parseFloat(raw);
    recomputeCombined();
  });
  document.getElementById('calc-prepared-by').addEventListener('input', (e) => { recipe.prepared_by = e.target.value; });
  document.getElementById('calc-category').addEventListener('input', (e) => { recipe.category = e.target.value; });
  document.getElementById('calc-country').addEventListener('input', (e) => { recipe.country_origin = e.target.value; });

  // Photo edit -- export-only, exactly like every other field here: state lives on
  // recipe.calcExistingPhotos/calcPendingPhotos (gallery) or recipe.calcPendingPhoto/
  // calcRemovePhoto (single), never on recipe.photos/recipe.photo_path, so the real saved
  // recipe/extracted_recipe_photos rows are never touched. Mirrors the recipe form's own
  // gallery/single photo widgets (renderRecipeFormView) field-for-field, just re-scoped onto
  // these calc-prefixed ids/state so nothing here can collide with the real form if both are
  // ever open at once.
  if (ns.photoModel === 'gallery') {
    function totalCalcPhotoCount() {
      return recipe.calcExistingPhotos.length + recipe.calcPendingPhotos.length;
    }
    function renderCalcPhotoGallery() {
      const gallery = document.getElementById('calc-photo-gallery');
      const tiles = [
        ...recipe.calcExistingPhotos.map(p => ({ kind: 'existing', key: p.id, src: p.dataUrl })),
        ...recipe.calcPendingPhotos.map(p => ({ kind: 'pending', key: p.localId, src: p.dataUrl })),
      ];
      gallery.innerHTML = tiles.length > 0
        ? tiles.map(t => `
            <div class="photo-thumb">
              <img src="${t.src}" />
              <button type="button" class="photo-thumb-remove" data-calc-remove-photo="${t.kind}:${t.key}" title="Remove photo">×</button>
            </div>
          `).join('')
        : `<div class="photo-gallery-empty">No photos yet.</div>`;

      gallery.querySelectorAll('[data-calc-remove-photo]').forEach(btn => {
        btn.addEventListener('click', () => {
          const [kind, key] = btn.dataset.calcRemovePhoto.split(':');
          if (kind === 'existing') {
            recipe.calcExistingPhotos = recipe.calcExistingPhotos.filter(p => String(p.id) !== key);
          } else {
            recipe.calcPendingPhotos = recipe.calcPendingPhotos.filter(p => String(p.localId) !== key);
          }
          renderCalcPhotoGallery();
        });
      });
    }

    document.getElementById('calc-photo-input').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';

      let remaining = 10 - totalCalcPhotoCount();
      let hitCap = false;
      for (const file of files) {
        if (remaining <= 0) { hitCap = true; break; }
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
          alert(`"${file.name}" isn't a JPG or PNG image and was skipped.`);
          continue;
        }
        if (file.size > 5 * 1024 * 1024) {
          alert(`"${file.name}" is larger than 5MB and was skipped.`);
          continue;
        }
        remaining -= 1;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const base64 = dataUrl.split(',')[1];
          const ext = file.type === 'image/png' ? 'png' : 'jpeg';
          recipe.calcPendingPhotos.push({ localId: ++_recipeRowLocalIdCounter, dataUrl, base64, ext });
          renderCalcPhotoGallery();
        };
        reader.readAsDataURL(file);
      }
      if (hitCap) alert('You can attach up to 10 photos per recipe.');
    });

    renderCalcPhotoGallery();
  } else {
    function updateCalcPhotoPreview() {
      const src = recipe.calcPendingPhoto
        ? recipe.calcPendingPhoto.dataUrl
        : (recipe.calcExistingPhotoDataUrl && !recipe.calcRemovePhoto ? recipe.calcExistingPhotoDataUrl : null);
      document.getElementById('calc-photo-preview-wrap').style.display = src ? '' : 'none';
      document.getElementById('calc-photo-preview').src = src || '';
    }

    document.getElementById('calc-photo-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        alert('Please choose a JPG or PNG image.');
        e.target.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert('Photo must be 5MB or smaller.');
        e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const ext = file.type === 'image/png' ? 'png' : 'jpeg';
        recipe.calcPendingPhoto = { dataUrl, base64, ext };
        recipe.calcRemovePhoto = false;
        updateCalcPhotoPreview();
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('calc-photo-remove-btn').addEventListener('click', () => {
      recipe.calcPendingPhoto = null;
      recipe.calcRemovePhoto = true;
      document.getElementById('calc-photo-input').value = '';
      updateCalcPhotoPreview();
    });

    updateCalcPhotoPreview();
  }

  function recomputeCombined() {
    combinedNetWeight = roundNice(processesShown.reduce((sum, p) => sum + p.netWeight, 0));
    const combinedEl = document.getElementById('calc-combined-netweight');
    if (combinedEl) combinedEl.textContent = `${combinedNetWeight} G`;
    portionsProduced = computePortionsProducedLive();
    const portionsEl = document.getElementById('calc-portions-produced');
    if (portionsEl) portionsEl.textContent = portionsProduced ?? '–';
  }

  renderCalcProcessCards(ns, workingProcesses, processesShown, wasteTypes, materials, document.getElementById('calc-process-cards'), perProcessScaling, onStructureChanged, recomputeCombined);

  document.getElementById('calc-add-process-btn').addEventListener('click', () => {
    workingProcesses.push(makeEmptyProcess());
    onStructureChanged();
  });

  document.getElementById('calc-export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('calc-export-btn');
    const progressWrap = document.getElementById('calc-export-progress-wrap');
    btn.disabled = true;
    const panel = createProgressPanel(progressWrap, { label: 'Exporting…' });
    // See the List "Export Selected" handler's comment -- same missing-try/catch bug fixed here.
    const unsubscribe = window.api.onExportProgress((payload) => panel.update(payload));
    try {
      // Strips this recipe's own (unscaled, full-set) `processes`/`photos` before sending, plus
      // every calc-prefixed photo-editing helper field (large dataUrl/base64 strings that would
      // otherwise double up in the payload -- their content is collected separately into
      // photoOverride/photosOverride below) -- the shown processes below are the ones that
      // actually belong in the export, not the full working-copy set.
      const {
        processes: _origProcesses, photos: _origPhotos,
        calcExistingPhotoDataUrl: _o1, calcPendingPhoto: _o2, calcRemovePhoto: _o3,
        calcExistingPhotos: _o4, calcPendingPhotos: _o5,
        ...recipeFields
      } = recipe;
      // Photo override -- always sent explicitly (never left for main.js to infer), since it's
      // the one clean way to tell the export handlers "use exactly this, don't touch the real
      // saved photo(s)" including the "she removed it/them for this export only" case, which a
      // falsy-value check alone couldn't distinguish from "no edit made".
      const photoOverrideFields = ns.photoModel === 'gallery'
        ? {
            photosOverride: [
              ...recipe.calcExistingPhotos.map(p => ({
                base64: p.dataUrl.split(',')[1],
                ext: p.photo_path && p.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg',
              })),
              ...recipe.calcPendingPhotos.map(p => ({ base64: p.base64, ext: p.ext })),
            ],
          }
        : {
            photoOverride: recipe.calcRemovePhoto
              ? null
              : recipe.calcPendingPhoto
                ? { base64: recipe.calcPendingPhoto.base64, ext: recipe.calcPendingPhoto.ext }
                : recipe.calcExistingPhotoDataUrl
                  ? {
                      base64: recipe.calcExistingPhotoDataUrl.split(',')[1],
                      ext: recipe.photo_path && recipe.photo_path.split('.').pop().toLowerCase() === 'png' ? 'png' : 'jpeg',
                    }
                  : null,
          };
      const exportRecipe = {
        ...recipeFields,
        // Falls back to the original, unscaled recipe-level quantity when processes were scaled
        // independently (quantityProducedScaled is null in that case, see above). `comment` is
        // already live in recipeFields (the Comment textarea mutates recipe.comment directly);
        // presentation_serving needs an explicit collect since its edited value lives in
        // recipe.presentationText/Items (the Text/List toggle's own state), not this field.
        quantity_produced: quantityProducedScaled || recipe.quantity_produced,
        yield_notes: `${combinedNetWeight} G`,
        presentation_serving: collectTextListFieldValue(recipe, TEXT_LIST_FIELDS.calcPresentation),
        ...photoOverrideFields,
      };
      // ingredient_name (not `name`) is what lib/export.js/the translate step actually read --
      // scaledIngredients rows carry `name` (the working copy's own field, from
      // buildProcessFromSaved) since this payload is the one place that distinction matters.
      const exportProcesses = processesShown.map(p => ({
        name: p.name,
        method: collectTextListFieldValue(p, makeProcessMethodCfg(p)),
        wastes: p.wastes,
        // original_quantity -- this calculation's own pre-scale basis (p.ingredientRows[i].quantity,
        // index-aligned with scaledIngredients since both are built 1:1 from ingredientRows) --
        // always sent, but only rendered as its own column when includeOriginalQty is checked
        // below (see buildRecipeSheet in lib/export.js).
        ingredients: (p.scaledIngredients || []).map((ing, i) => ({
          ingredient_name: ing.name, quantity: ing.quantity, unit: ing.unit, method: ing.method,
          original_quantity: p.ingredientRows[i]?.quantity ?? '',
        })),
        // material_id/material_code/material_name/material_fill_weight_grams -- the snake_case,
        // DB-shaped names lib/export.js's computeTraysNeeded actually reads (same convention as
        // ingredient_name above), not the working copy's own camelCase materialId/
        // materialFillWeightGrams.
        material_id: p.materialId || null,
        material_code: materials.find(m => m.id === p.materialId)?.code,
        material_name: materials.find(m => m.id === p.materialId)?.name,
        material_fill_weight_grams: p.materialId ? (p.materialFillWeightGrams ?? null) : null,
      }));
      const result = await ns.api.exportScaled({
        recipeId, recipe: exportRecipe, processes: exportProcesses, targetLanguage: getSelectedExportLanguage('calc'),
        includeOriginalQty: document.getElementById('calc-include-original-qty').checked,
      });
      panel.destroy();
      if (result.success) alert(`Exported to ${result.path}`);
      else if (!result.cancelled) alert('Export failed.');
    } catch (err) {
      panel.destroy();
      alert(`Export failed: ${err.message}`);
    } finally {
      unsubscribe();
      btn.disabled = false;
    }
  });
}

// ============================================================
// INGREDIENTS DATABASE VIEW
// ============================================================
const UNCATEGORIZED_FILTER_VALUE = '__uncategorized__';

async function renderIngredientsView(main) {
  const ingredients = await window.api.listIngredients();

  // Every write path (add/update-ingredient handlers, the modal's own .trim() || null, and
  // the Recipe form's inline "+ Add as new ingredient" flow which omits category entirely)
  // normalizes a missing category to null, never '' -- so `!i.category` is the one check
  // that catches every uncategorized row.
  const categoryNames = [...new Set(ingredients.map(i => i.category).filter(Boolean))].sort();
  const uncategorizedCount = ingredients.filter(i => !i.category).length;

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Ingredients</h1><span class="page-description">Canonical ingredient master</span></div>
      <button class="primary" id="add-ingredient-btn">+ Add Ingredient</button>
    </div>
    <div class="search-bar">
      <label for="ingredient-search">Search by name</label>
      <input id="ingredient-search" type="search" />
      <select id="ingredient-category-filter">
        <option value="">All Categories</option>
        ${uncategorizedCount > 0 ? `<option value="${UNCATEGORIZED_FILTER_VALUE}">Uncategorized (${uncategorizedCount})</option>` : ''}
        ${categoryNames.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
    </div>
    <div id="ingredients-content"><div class="loading-state" role="status">Loading…</div></div>
  `;
  document.getElementById('add-ingredient-btn').addEventListener('click', () => openIngredientModal());

  const searchInput = document.getElementById('ingredient-search');
  const categoryFilter = document.getElementById('ingredient-category-filter');
  const content = document.getElementById('ingredients-content');

  if (ingredients.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No ingredients yet</div>Click "+ Add Ingredient" to create the first one.</div>`;
    return;
  }

  categoryFilter.addEventListener('change', renderFiltered);

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value;
    const filtered = ingredients.filter(i =>
      (!query || i.name.toLowerCase().includes(query)) &&
      (!cat || (cat === UNCATEGORIZED_FILTER_VALUE ? !i.category : i.category === cat))
    );

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No ingredients match the current filters.</div>`;
      return;
    }

    // Same shared-table-with-rowspan-merged-category pattern as the Dish Catalog view --
    // keeps columns aligned across every category instead of one table per category.
    const byCategory = new Map();
    for (const ing of filtered) {
      const cat = ing.category || 'Uncategorized';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(ing);
    }

    const bodyRows = [];
    for (const [cat, list] of byCategory) {
      list.forEach((ing, idx) => {
        bodyRows.push(`
          <tr>
            ${idx === 0 ? `<td class="cat-cell" rowspan="${list.length}">${cat}</td>` : ''}
            <td>${ing.product_code || ''}</td>
            <td>${ing.name}</td>
            <td>${ing.default_unit || ''}</td>
            <td style="text-align:right">
              <button class="icon-btn" data-edit="${ing.id}">Edit</button>
              <button class="icon-btn danger" data-delete="${ing.id}">Delete</button>
            </td>
          </tr>
        `);
      });
    }

    content.innerHTML = `
      <div class="table-scroll"><table class="items-table ingredients-table">
        <thead><tr><th>Category</th><th>Product Code</th><th>Name</th><th>Default Unit</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table></div>
    `;

    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openIngredientModal(ingredients.find(i => i.id === parseInt(btn.dataset.edit, 10))));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const ing = ingredients.find(i => i.id === id);
        if (!confirm(`Delete "${ing.name}"? This cannot be undone.`)) return;
        const result = await window.api.deleteIngredient(id);
        if (!result.success) {
          if (result.inUse) alert(`"${ing.name}" is used in one or more recipes and can't be deleted. Remove it from those recipes first.`);
          else alert('Delete failed.');
          return;
        }
        renderIngredientsView(main);
      });
    });
  }

  searchInput.addEventListener('input', renderFiltered);
  renderFiltered();
}

// Generic small "pick one of N mutually exclusive options" modal -- reuses the exact same
// overlay/.modal/.actions chrome every other modal in this app already uses (openIngredientModal,
// openWasteTypesModal below), since a native confirm()/prompt() can't represent more than a
// binary OK/Cancel and introducing a visually distinct dialog type would be a bigger break from
// convention than reusing this one with radio options instead of a form. Resolves to the picked
// option's `value`, or null on Cancel -- callers use `if (!choice) { ... }` the same way existing
// code already does with `if (!confirm(...)) return;`.
function openChoiceModal({ title, message, options, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h2>${title}</h2>
        <p style="margin:0 0 14px; color:var(--neutral); font-size:13px;">${message}</p>
        ${options.map((opt, i) => `
          <label style="display:flex; align-items:flex-start; gap:8px; margin-bottom:10px; cursor:pointer;">
            <input type="radio" name="choice-modal-option" value="${opt.value}" ${opt.default ? 'checked' : ''} style="margin-top:3px;" />
            <span>${opt.label}</span>
          </label>
        `).join('')}
        <div class="actions">
          <button class="secondary" id="cm-cancel">Cancel</button>
          <button class="primary" id="cm-confirm">${confirmLabel || 'Apply'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#cm-cancel').addEventListener('click', () => { overlay.remove(); resolve(null); });
    overlay.querySelector('#cm-confirm').addEventListener('click', () => {
      const picked = overlay.querySelector('input[name="choice-modal-option"]:checked');
      overlay.remove();
      resolve(picked ? picked.value : null);
    });
  });
}

// Waste Types catalog management -- a small, global, chef-managed list (name + default %)
// shared by every Recipe Book/Extractor process card's "+ Add Waste" control (see
// renderProcessWastes). Entry point lives only on Recipe Book's screen (see
// renderRecipeListView), but the catalog itself isn't namespaced to either recipe type.
// Every row is inline-editable; Delete is immediate (mirrors openIngredientModal's list-screen
// delete convention, including the same FK-in-use guard). A default-% edit is ALSO immediate --
// but only once she clicks that row's own "Update" button (see catalogRowIsChanged/
// onCatalogDefaultPercentUpdateClicked below), never automatically off typing or the field
// losing focus, so she can freely adjust the value with no prompt until she deliberately asks for
// one. Name edits and brand-new rows are the only things still batched behind "Save" -- a rename
// has no scoped-impact decision to make (the name is read live via join everywhere, never
// snapshotted), so there's nothing to gain by making it immediate too.
// Recipe on Fire: the dough shape presets (name, weight, geometry type, size, taper, slashes), edited in a
// modal like Waste Types. Resolves true if anything was saved or deleted. `shapePreview` (from the game
// module) gives the outline to draw, so the chef sees the shape before saving.
function openShapesModal() {
  return new Promise((resolve) => {
    const TYPE_LABEL = { ball: 'Ball', disc: 'Disc (flat round)', log: 'Long loaf (baguette, roll)', oval: 'Oval (ciabatta, batard)' };
    const TYPE_SHORT = { ball: 'Ball', disc: 'Disc', log: 'Long loaf', oval: 'Oval' };
    let shapes = [];
    let form = null; // null = the list, else the shape being edited / created
    let changed = false;
    const opener = document.activeElement; // focus goes back here when the dialog closes
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    const close = () => { document.removeEventListener('keydown', onKeydown, true); overlay.remove(); if (opener && opener.focus) opener.focus(); resolve(changed); };
    // Escape backs out of the form (or closes the list); Tab stays inside the dialog.
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (form) { form = null; renderList(); } else close(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeydown, true);
    const sizeText = (r) => (r.archetype === 'ball' || r.archetype === 'disc'
      ? `⌀ ${roundNice(Number(r.length_cm))} × H ${roundNice(Number(r.height_cm))} cm`
      : `${roundNice(Number(r.length_cm))} × ${roundNice(Number(r.width_cm))} × H ${roundNice(Number(r.height_cm))} cm`);

    async function reload() {
      const res = await window.api.listDoughShapePresets();
      shapes = res.shapes || [];
    }

    function renderList() {
      overlay.innerHTML = `
        <div class="modal shapes-modal" role="dialog" aria-modal="true" aria-labelledby="sh-title">
          <h2 id="sh-title">Dough Shapes</h2>
          <div class="table-scroll"><table class="items-table shapes-table" aria-label="Dough shapes">
            <thead><tr><th>Name</th><th>Type</th><th>Weight</th><th>Size</th><th></th></tr></thead>
            <tbody>
              ${shapes.length === 0 ? '<tr><td colspan="5" style="color:var(--neutral);">No shapes yet.</td></tr>' : shapes.map(r => `
                <tr>
                  <td>${r.name}</td><td>${TYPE_SHORT[r.archetype] || r.archetype}</td><td>${roundNice(Number(r.unit_weight_grams))} g</td><td>${sizeText(r)}</td>
                  <td style="text-align:right; white-space:nowrap;">
                    <button class="icon-btn" data-edit-shape="${r.id}" aria-label="Edit ${r.name}">Edit</button>
                    <button class="icon-btn danger" data-delete-shape="${r.id}" aria-label="Delete ${r.name}">Delete</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table></div>
          <button type="button" class="secondary" id="sh-add-btn" style="margin:10px 0 16px;">+ Add Shape</button>
          <div class="actions"><button class="primary" id="sh-close">Close</button></div>
        </div>`;
      overlay.querySelector('#sh-close').addEventListener('click', close);
      overlay.querySelector('#sh-add-btn').focus();
      overlay.querySelector('#sh-add-btn').addEventListener('click', () => {
        form = { id: null, name: '', archetype: 'ball', weight: 90, lengthCm: 9.5, widthCm: 9.5, heightCm: 4.6, taperPct: 80, scoreCount: 0 };
        renderForm();
      });
      overlay.querySelectorAll('[data-edit-shape]').forEach(btn => btn.addEventListener('click', () => {
        const r = shapes.find(x => String(x.id) === btn.dataset.editShape);
        form = { id: r.id, name: r.name, archetype: r.archetype, weight: Number(r.unit_weight_grams), lengthCm: Number(r.length_cm),
          widthCm: Number(r.width_cm), heightCm: Number(r.height_cm), taperPct: Math.round(Number(r.taper ?? 0) * 100), scoreCount: r.score_count || 0 };
        renderForm();
      }));
      overlay.querySelectorAll('[data-delete-shape]').forEach(btn => btn.addEventListener('click', async () => {
        const r = shapes.find(x => String(x.id) === btn.dataset.deleteShape);
        if (!confirm(`Delete "${r.name}"?`)) return;
        try { await window.api.deleteDoughShapePreset(r.id); changed = true; await reload(); renderList(); }
        catch (err) { alert(`Couldn't delete "${r.name}": ${err.message}`); }
      }));
    }

    function renderForm() {
      const isRound = () => form.archetype === 'ball' || form.archetype === 'disc';
      overlay.innerHTML = `
        <div class="modal shapes-modal" role="dialog" aria-modal="true" aria-labelledby="sh-title">
          <h2 id="sh-title">${form.id ? 'Edit Shape' : 'New Shape'}</h2>
          <div class="field"><label for="sh-name">Name</label><input id="sh-name" value="${form.name.replace(/"/g, '&quot;')}" dir="auto" /></div>
          <div class="field"><label for="sh-type">Type</label>
            <select id="sh-type" class="builder-select">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === form.archetype ? 'selected' : ''}>${v}</option>`).join('')}</select>
          </div>
          <div class="shape-form-grid">
            <div class="field"><label for="sh-weight">Weight (g)</label><input id="sh-weight" type="number" min="5" max="5000" step="1" value="${form.weight}" /></div>
            <div class="field"><label id="sh-length-label" for="sh-length">${isRound() ? 'Diameter (cm)' : 'Length (cm)'}</label><input id="sh-length" type="number" min="2" max="120" step="0.1" value="${form.lengthCm}" /></div>
            <div class="field" data-for="log oval"><label for="sh-width">Width (cm)</label><input id="sh-width" type="number" min="1" max="60" step="0.1" value="${form.widthCm}" /></div>
            <div class="field"><label for="sh-height">Height (cm)</label><input id="sh-height" type="number" min="0.5" max="20" step="0.1" value="${form.heightCm}" /></div>
            <div class="field" data-for="log"><label for="sh-taper">Pointed ends (%)</label><input id="sh-taper" type="number" min="0" max="100" step="5" value="${form.taperPct}" /></div>
            <div class="field" data-for="log oval"><label for="sh-score">Slashes</label><input id="sh-score" type="number" min="0" max="9" step="1" value="${form.scoreCount}" /></div>
          </div>
          <canvas id="sh-preview" width="360" height="120" class="shape-preview" role="img" aria-label="Preview of the shape's outline and slashes"></canvas>
          <div style="font-size:11.5px; color:var(--neutral); margin:6px 0 4px;">Raw size at this weight. Pieces scale up or down when the dough is divided into more or fewer.</div>
          <div id="sh-error" role="alert" style="color:var(--danger, #c0392b); font-size:12.5px; min-height:18px;"></div>
          <div class="actions"><button class="secondary" id="sh-cancel">Cancel</button><button class="primary" id="sh-save">Save</button></div>
        </div>`;
      const $ = (id) => overlay.querySelector(id);
      const readForm = () => {
        form.name = $('#sh-name').value; form.archetype = $('#sh-type').value;
        form.weight = $('#sh-weight').value; form.lengthCm = $('#sh-length').value; form.widthCm = $('#sh-width').value;
        form.heightCm = $('#sh-height').value; form.taperPct = $('#sh-taper').value; form.scoreCount = $('#sh-score').value;
      };
      const syncVisibility = () => {
        overlay.querySelectorAll('[data-for]').forEach(el => { el.style.display = el.dataset.for.split(' ').includes(form.archetype) ? '' : 'none'; });
        $('#sh-length-label').textContent = isRound() ? 'Diameter (cm)' : 'Length (cm)';
      };
      const drawPreview = () => {
        const cv = $('#sh-preview'), ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        const L = parseFloat(form.lengthCm), H = parseFloat(form.heightCm);
        const W = isRound() ? L : parseFloat(form.widthCm);
        if (!(L > 0) || !(W > 0) || !(H > 0) || !window.RofGame) return;
        const spec = { archetype: form.archetype, lengthCm: L, widthCm: W, heightCm: H, taper: (parseFloat(form.taperPct) || 0) / 100, score: form.archetype === 'ball' || form.archetype === 'disc' ? 0 : Math.min(9, Math.max(0, parseInt(form.scoreCount, 10) || 0)) };
        const { outline, slashes } = window.RofGame.shapePreview(spec);
        const k = Math.min((cv.width - 24) / L, (cv.height - 24) / W);
        const X = (x) => cv.width / 2 + x * k, Y = (y) => cv.height / 2 - y * k;
        ctx.beginPath();
        outline.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
        ctx.closePath();
        ctx.fillStyle = '#E8D6AD'; ctx.fill(); ctx.strokeStyle = '#B79C68'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.strokeStyle = '#8B6F3E'; ctx.lineWidth = 1.6;
        slashes.forEach(([x1, y1, x2, y2]) => { ctx.beginPath(); ctx.moveTo(X(x1), Y(y1)); ctx.lineTo(X(x2), Y(y2)); ctx.stroke(); });
      };
      syncVisibility(); drawPreview();
      $('#sh-name').focus();
      overlay.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => { readForm(); syncVisibility(); drawPreview(); $('#sh-error').textContent = ''; }));
      $('#sh-cancel').addEventListener('click', () => { form = null; renderList(); });
      $('#sh-save').addEventListener('click', async () => {
        readForm();
        try {
          const res = await window.api.saveDoughShapePreset({ id: form.id, name: form.name, archetype: form.archetype, weight: form.weight,
            lengthCm: form.lengthCm, widthCm: form.widthCm, heightCm: form.heightCm, taper: (parseFloat(form.taperPct) || 0) / 100, scoreCount: form.scoreCount });
          if (!res.success) { $('#sh-error').textContent = res.error; return; }
          changed = true; form = null; await reload(); renderList();
        } catch (err) { $('#sh-error').textContent = `Couldn't save: ${err.message}`; }
      });
    }

    reload().then(renderList).catch((err) => { alert(`Couldn't load shapes: ${err.message}`); close(); });
  });
}

async function openWasteTypesModal() {
  let types = await window.api.listWasteTypes();
  let rows = types.map(t => ({ localId: ++_recipeRowLocalIdCounter, id: t.id, name: t.name, defaultPercent: t.default_percent }));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  // A never-saved new row (no r.id yet) never counts as "changed" -- Save will simply create it
  // at whatever % she leaves in the field, there's no existing catalog value to diff against yet.
  function catalogRowIsChanged(r) {
    if (!r.id) return false;
    const original = types.find(t => t.id === r.id);
    return !!original && parseFloat(r.defaultPercent) !== parseFloat(original.default_percent);
  }

  // Fires ONLY on the row's own "Update" button click -- never automatically off typing or blur.
  async function onCatalogDefaultPercentUpdateClicked(r) {
    const original = types.find(t => t.id === r.id);
    if (!original) return;
    const newPct = parseFloat(r.defaultPercent);
    const oldPct = parseFloat(original.default_percent);
    if (isNaN(newPct) || newPct === oldPct) return;

    const choice = await openChoiceModal({
      title: `Update "${r.name}"'s default %`,
      message: `You changed the default % for "${r.name}" from ${oldPct}% to ${newPct}%.`,
      options: [
        { value: 'cascade', label: `Apply ${newPct}% to every recipe process already using this waste type, and update the catalog default` },
        { value: 'default-only', label: 'Just update the catalog default going forward — leave already-saved recipes as they are', default: true },
      ],
    });

    if (!choice) {
      r.defaultPercent = original.default_percent; // revert this field in place
      render();
      return;
    }
    try {
      // original.name, not r.name -- a rename in progress in the same row stays deferred to
      // Save, so an unfinished edit there is never prematurely committed by this field's own
      // immediate write.
      await window.api.updateWasteType({ id: r.id, name: original.name, defaultPercent: newPct, cascadeToExisting: choice === 'cascade' });
      original.default_percent = newPct; // new baseline -- also keeps Save's own diff from re-firing on this
    } catch (err) {
      alert(`Couldn't update "${r.name}": ${err.message}`);
    }
    render(); // either way the Update button must disappear again
  }

  function render() {
    overlay.innerHTML = `
      <div class="modal">
        <h2>Waste Types</h2>
        <div class="table-scroll"><table class="items-table">
          <thead><tr><th>Name</th><th>Default %</th><th></th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr data-row="${r.localId}">
                <td><input class="wt-name" value="${r.name}" dir="auto" style="width:100%;" /></td>
                <td style="white-space:nowrap;">
                  <input class="wt-default" type="number" min="0" max="100" step="0.1" value="${r.defaultPercent ?? ''}" style="width:90px;" />
                  <button type="button" class="icon-btn" data-update-waste-type="${r.localId}" ${catalogRowIsChanged(r) ? '' : 'hidden'}>Update</button>
                </td>
                <td style="text-align:right"><button class="icon-btn danger" data-delete-waste-type="${r.localId}">Delete</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table></div>
        <button type="button" class="secondary" id="wt-add-btn" style="margin:10px 0 16px;">+ Add Waste Type</button>
        <div class="actions">
          <button class="secondary" id="wt-close">Close</button>
          <button class="primary" id="wt-save">Save</button>
        </div>
      </div>
    `;

    rows.forEach(r => {
      const tr = overlay.querySelector(`tr[data-row="${r.localId}"]`);
      tr.querySelector('.wt-name').addEventListener('input', (e) => { r.name = e.target.value; });
      const defaultInput = tr.querySelector('.wt-default');
      const updateBtn = tr.querySelector('[data-update-waste-type]');
      defaultInput.addEventListener('input', (e) => {
        r.defaultPercent = e.target.value;
        updateBtn.hidden = !catalogRowIsChanged(r);
      });
      updateBtn.addEventListener('click', () => onCatalogDefaultPercentUpdateClicked(r));
    });

    overlay.querySelectorAll('[data-delete-waste-type]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const localId = parseInt(btn.dataset.deleteWasteType, 10);
        const row = rows.find(r => r.localId === localId);
        if (!row.id) {
          // Never saved -- just drop it locally, nothing to delete server-side.
          rows = rows.filter(r => r.localId !== localId);
          render();
          return;
        }
        if (!confirm(`Delete "${row.name}"? This cannot be undone.`)) return;
        const result = await window.api.deleteWasteType(row.id);
        if (!result.success) {
          if (result.inUse) alert(`"${row.name}" is applied to one or more recipe processes and can't be deleted. Remove it from those processes first.`);
          else alert('Delete failed.');
          return;
        }
        rows = rows.filter(r => r.localId !== localId);
        render();
      });
    });

    overlay.querySelector('#wt-add-btn').addEventListener('click', () => {
      rows.push({ localId: ++_recipeRowLocalIdCounter, id: null, name: '', defaultPercent: '' });
      render();
    });

    overlay.querySelector('#wt-close').addEventListener('click', () => overlay.remove());

    // Percent changes on existing rows are already fully resolved and written immediately (see
    // onCatalogDefaultPercentUpdateClicked) by the time Save is ever clicked -- this is back to a
    // plain "persist whatever's currently in the fields" pass, same as before the scoped-impact
    // choice existed, for new rows and any still-pending name edits.
    overlay.querySelector('#wt-save').addEventListener('click', async () => {
      for (const r of rows) {
        const name = (r.name || '').trim();
        if (!name) return alert('Every waste type needs a name.');
        const pct = parseFloat(r.defaultPercent);
        if (isNaN(pct) || pct < 0 || pct > 100) return alert(`"${name}": please enter a default % between 0 and 100.`);
      }
      try {
        for (const r of rows) {
          const name = r.name.trim();
          const defaultPercent = parseFloat(r.defaultPercent);
          if (!r.id) {
            await window.api.addWasteType({ name, defaultPercent });
            continue;
          }
          const original = types.find(t => t.id === r.id);
          if (!original || original.name !== name || original.default_percent !== defaultPercent) {
            await window.api.updateWasteType({ id: r.id, name, defaultPercent });
          }
        }
        overlay.remove();
        renderView();
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      }
    });
  }

  render();
}

async function openIngredientModal(existingIngredient) {
  const editing = !!existingIngredient;
  const ingredients = await window.api.listIngredients();
  const categories = [...new Set(ingredients.map(i => i.category).filter(Boolean))].sort();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${editing ? 'Edit Ingredient' : 'Add Ingredient'}</h2>
      <div class="field">
        <label>Ingredient name</label>
        <input id="im-name" value="${existingIngredient?.name || ''}" />
      </div>
      <div class="field">
        <label>Product code</label>
        <input id="im-code" value="${existingIngredient?.product_code || ''}" />
      </div>
      <div class="field">
        <label>Default unit</label>
        <input id="im-unit" value="${existingIngredient?.default_unit || ''}" />
      </div>
      <div class="field">
        <label>Category</label>
        <input id="im-category" list="im-category-list" value="${existingIngredient?.category || ''}" />
        <datalist id="im-category-list">
          ${categories.map(c => `<option value="${c}"></option>`).join('')}
        </datalist>
      </div>
      <div class="actions">
        <button class="secondary" id="im-cancel">Cancel</button>
        <button class="primary" id="im-save">${editing ? 'Save Changes' : 'Add Ingredient'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#im-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#im-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#im-name').value.trim();
    if (!name) return alert('Please enter an ingredient name.');

    const payload = {
      name,
      productCode: overlay.querySelector('#im-code').value.trim() || null,
      defaultUnit: overlay.querySelector('#im-unit').value.trim() || null,
      category: overlay.querySelector('#im-category').value.trim() || null,
    };

    try {
      if (editing) {
        await window.api.updateIngredient({ id: existingIngredient.id, ...payload });
      } else {
        await window.api.addIngredient(payload);
      }
      overlay.remove();
      renderView();
    } catch (err) {
      alert(`${editing ? 'Save' : 'Add'} failed: ${err.message}`);
    }
  });
}

// Browse/cleanup screen for extracted_ingredients (the IN- rows auto-created by Recipe
// Extractor) -- mirrors renderIngredientsView/openIngredientModal above as closely as possible,
// but has no "+ Add" entry point: these rows are meant to be created only by the extraction
// flow, this screen exists purely to search, review, fix typos/translation artifacts, and
// delete unused ones.
async function renderExtractedIngredientsView(main) {
  const ingredients = await window.api.listExtractedIngredients();

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Extracted Ingredients</h1><span class="page-description">Recipe Extractor ingredient list (EX-IN-)</span></div>
    </div>
    <div class="search-bar">
      <label for="extracted-ingredient-search">Search by name</label>
      <input id="extracted-ingredient-search" type="search" />
    </div>
    <div id="extracted-ingredients-content"><div class="loading-state" role="status">Loading…</div></div>
  `;

  const searchInput = document.getElementById('extracted-ingredient-search');
  const content = document.getElementById('extracted-ingredients-content');

  if (ingredients.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No extracted ingredients yet</div>Upload a recipe card in Recipe Extractor to create the first one.</div>`;
    return;
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = ingredients.filter(i => !query || i.name.toLowerCase().includes(query));

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No extracted ingredients match the current search.</div>`;
      return;
    }

    const bodyRows = filtered.map(ing => `
      <tr>
        <td>${ing.product_code || ''}</td>
        <td>${ing.name}</td>
        <td>${ing.default_unit || ''}</td>
        <td style="text-align:right">
          <button class="icon-btn" data-edit="${ing.id}">Edit</button>
          <button class="icon-btn danger" data-delete="${ing.id}">Delete</button>
        </td>
      </tr>
    `);

    content.innerHTML = `
      <div class="table-scroll"><table class="items-table extracted-ingredients-table">
        <thead><tr><th>Product Code</th><th>Name</th><th>Default Unit</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table></div>
    `;

    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openExtractedIngredientModal(ingredients.find(i => i.id === parseInt(btn.dataset.edit, 10))));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const ing = ingredients.find(i => i.id === id);
        if (!confirm(`Delete "${ing.name}"? This cannot be undone.`)) return;
        const result = await window.api.deleteExtractedIngredient(id);
        if (!result.success) {
          if (result.inUse) alert(`"${ing.name}" is used in one or more extracted recipes and can't be deleted. Remove it from those recipes first.`);
          else alert('Delete failed.');
          return;
        }
        renderExtractedIngredientsView(main);
      });
    });
  }

  searchInput.addEventListener('input', renderFiltered);
  renderFiltered();
}

async function openExtractedIngredientModal(existingIngredient) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Edit Extracted Ingredient</h2>
      <div class="field">
        <label>Ingredient name</label>
        <input id="eim-name" value="${existingIngredient?.name || ''}" />
      </div>
      <div class="field">
        <label>Product code</label>
        <input id="eim-code" value="${existingIngredient?.product_code || ''}" readonly />
      </div>
      <div class="field">
        <label>Default unit</label>
        <input id="eim-unit" value="${existingIngredient?.default_unit || ''}" />
      </div>
      <div class="actions">
        <button class="secondary" id="eim-cancel">Cancel</button>
        <button class="primary" id="eim-save">Save Changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#eim-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#eim-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#eim-name').value.trim();
    if (!name) return alert('Please enter an ingredient name.');

    const payload = {
      name,
      defaultUnit: overlay.querySelector('#eim-unit').value.trim() || null,
    };

    try {
      await window.api.updateExtractedIngredient({ id: existingIngredient.id, ...payload });
      overlay.remove();
      renderView();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  });
}

// ============================================================
// MATERIALS / TRAYS CATALOG -- catalog-only phase (see conversation notes): a chef-managed list
// of baking equipment, list<->form drill-down like Recipe Book (state.materials.view/formId,
// single-photo model), plus a parametric 3D shape preview built live from whatever dimensions
// are currently entered. Not yet linked to recipes anywhere -- that's a separate later phase.
// ============================================================

// Per-shape dimension field sets -- drives both the form's dimension inputs (label/step) and,
// via readMaterialDims, the 3D preview + save payload. Only three shapes for now (see
// conversation notes): most of the requested starter equipment (sheet pans, cake pans,
// springform, loaf, pizza, focaccia trays) collapses into just Round or Rectangular -- the
// muffin tray is the one genuinely different, multi-cavity shape that needs its own field set.
const MATERIAL_SHAPE_PRESETS = {
  round: {
    label: 'Round',
    fields: [
      { key: 'diameterCm', label: 'Diameter (cm)', step: '0.1' },
      { key: 'heightCm', label: 'Height (cm)', step: '0.1' },
    ],
  },
  rectangular: {
    label: 'Rectangular / Tray',
    fields: [
      { key: 'lengthCm', label: 'Length (cm)', step: '0.1' },
      { key: 'widthCm', label: 'Width (cm)', step: '0.1' },
      { key: 'heightCm', label: 'Height (cm)', step: '0.1' },
    ],
  },
  muffin_tray: {
    label: 'Muffin / Multi-Cavity Tray',
    fields: [
      { key: 'lengthCm', label: 'Tray Length (cm)', step: '0.1' },
      { key: 'widthCm', label: 'Tray Width (cm)', step: '0.1' },
      { key: 'heightCm', label: 'Tray Height (cm)', step: '0.1' },
      { key: 'cupDiameterCm', label: 'Cup Diameter (cm)', step: '0.1' },
      { key: 'cupDepthCm', label: 'Cup Depth (cm)', step: '0.1' },
      { key: 'cupRows', label: 'Rows', step: '1' },
      { key: 'cupColumns', label: 'Columns', step: '1' },
    ],
  },
  // Isosceles, apex centered above the base -- fully determined by baseCm + triHeightCm (the 2D
  // triangle's own apex height, NOT the object's vertical height) with no third side-length/angle
  // input, matching how real triangular pastry/tart cutters are shaped. heightCm is REUSED as-is
  // (same DB column, same meaning as Round/Rectangular's own heightCm: how tall the object stands/
  // the prism's vertical wall height) rather than inventing a differently-named third dimension.
  triangle: {
    label: 'Triangle',
    fields: [
      { key: 'baseCm', label: 'Base (cm)', step: '0.1' },
      { key: 'triHeightCm', label: 'Triangle Height (cm)', step: '0.1' },
      { key: 'heightCm', label: 'Height (cm)', step: '0.1' },
    ],
  },
};

// Purpose, not shape -- shape stays entirely on shape_type, never duplicated here (see
// conversation notes: a combined field like "round_tray"/"square_cutter" would drift out of sync
// with shape_type and can't express e.g. a square-shaped tray without inventing yet another
// value). Only two values for now; deliberately no DB enum/CHECK constraint, same convention as
// shape_type -- this map is the only place validating it. Drives two things: the Materials list's
// grouping label (materialGroupLabel below, which derives "Round Tray"/"Cutter"/etc. from this
// plus shape_type without storing that combination anywhere) and buildMaterialGroup's floor --
// only a cutter renders open-top/open-bottom with no floor mesh at all.
const MATERIAL_CATEGORIES = {
  tray_pan: { label: 'Tray / Pan' },
  cutter: { label: 'Cutter' },
};

// Which shape types each category offers in the Materials form, with the label that reads right for it
// (a "Muffin cutter" or a "Rectangular / Tray" cutter made no sense). Same list is checked by main.js
// save-material (MATERIAL_CATEGORY_SHAPES there) -- keep the two in step. An existing material saved
// before this rule keeps its shape as an extra option (see materialShapeOptions).
const MATERIAL_CATEGORY_SHAPES = {
  tray_pan: { round: 'Round', rectangular: 'Rectangular / Square', muffin_tray: 'Muffin / Multi-Cavity Tray' },
  cutter: { round: 'Round', rectangular: 'Square / Rectangle', triangle: 'Triangle' },
};
function materialShapeLabel(category, shapeType) {
  return MATERIAL_CATEGORY_SHAPES[category]?.[shapeType] || MATERIAL_SHAPE_PRESETS[shapeType]?.label || shapeType;
}
// [key, label] pairs for the Shape Type dropdown. `keepShape` (the saved shape of the material being
// edited) stays listed even when it isn't one of the category's shapes, so opening an older material
// never silently changes it.
function materialShapeOptions(category, keepShape) {
  const allowed = MATERIAL_CATEGORY_SHAPES[category] || {};
  const opts = Object.entries(allowed);
  if (keepShape && !allowed[keepShape] && MATERIAL_SHAPE_PRESETS[keepShape]) {
    opts.push([keepShape, `${MATERIAL_SHAPE_PRESETS[keepShape].label} (not a usual ${MATERIAL_CATEGORIES[category]?.label.toLowerCase() || ''} shape)`]);
  }
  return opts;
}

// Display-only grouping label for the Materials list -- see MATERIAL_CATEGORIES' own comment for
// why this is derived here rather than stored as its own column. Cutters are one flat group
// (matching how they were requested -- no shape breakdown), trays/pans split by shape_type so
// "Round Tray"/"Rectangular Tray"/"Muffin Tray" fall out of just two stored fields. A rectangular
// tray with equal length/width ("a square tray") still groups as "Rectangular Tray" here, same as
// shape_type already treats square as a rectangular special case rather than its own shape.
const MATERIAL_SHAPE_NOUNS = { round: 'Round', rectangular: 'Rectangular', muffin_tray: 'Muffin', triangle: 'Triangle' };
function materialGroupLabel(m) {
  if (m.category === 'cutter') return 'Cutter';
  return `${MATERIAL_SHAPE_NOUNS[m.shape_type] || m.shape_type} Tray`;
}

// Every possible dimension column, camelCase form key -> snake_case DB column -- shared by
// materialDimsFromRow (loading) and buildMaterialDimensionPayload (saving) so the two can never
// drift out of sync with main.js's own save-material `fields` object.
const MATERIAL_DIMENSION_DB_KEYS = {
  diameterCm: 'diameter_cm', lengthCm: 'length_cm', widthCm: 'width_cm', heightCm: 'height_cm',
  baseCm: 'base_cm', triHeightCm: 'tri_height_cm',
  cupDiameterCm: 'cup_diameter_cm', cupDepthCm: 'cup_depth_cm', cupRows: 'cup_rows', cupColumns: 'cup_columns',
};

function materialDimsFromRow(material) {
  const dims = {};
  if (!material) return dims;
  Object.entries(MATERIAL_DIMENSION_DB_KEYS).forEach(([key, dbKey]) => { dims[key] = material[dbKey]; });
  return dims;
}

function formatMaterialDimensions(m) {
  if (m.shape_type === 'round') return `⌀${m.diameter_cm ?? '?'}cm × H${m.height_cm ?? '?'}cm`;
  if (m.shape_type === 'rectangular') return `${m.length_cm ?? '?'}×${m.width_cm ?? '?'}×H${m.height_cm ?? '?'}cm`;
  if (m.shape_type === 'muffin_tray') return `${m.length_cm ?? '?'}×${m.width_cm ?? '?'}cm tray, ${m.cup_rows ?? '?'}×${m.cup_columns ?? '?'} cups ⌀${m.cup_diameter_cm ?? '?'}cm`;
  if (m.shape_type === 'triangle') return `Base ${m.base_cm ?? '?'}cm × Face H${m.tri_height_cm ?? '?'}cm × H${m.height_cm ?? '?'}cm`;
  return '';
}

// A material's catalog weight_grams means different things depending on shape: for round/
// rectangular it's the whole item's weight, but for muffin_tray it's WEIGHT PER CUP (see the
// Materials form's own conditional label below) -- every place that needs "how much can the
// whole thing hold/weigh" (the recipe form/Calculator's Fill Weight pre-fill, the Materials list
// display) must go through this rather than reading weight_grams directly, or a muffin tray's
// per-cup number silently gets treated as if it were the whole tray's capacity -- wrong by a
// factor of rows x columns. Only muffin_tray is multi-cavity right now (the only shape with its
// own cup_rows/cup_columns fields at all -- see MATERIAL_SHAPE_PRESETS), so it's the only shape
// this branches on; a future multi-cavity shape would need the same treatment.
function materialCapacityGrams(m) {
  if (!m || m.weight_grams == null) return null;
  if (m.shape_type === 'muffin_tray') {
    if (!(m.cup_rows > 0) || !(m.cup_columns > 0)) return null;
    return m.cup_rows * m.cup_columns * m.weight_grams;
  }
  return m.weight_grams;
}

// Materials list column display -- muffin trays show the raw catalog value with its actual unit
// (per cup, matching the form's own relabeled field) alongside the computed tray total, so
// neither number is shown bare and mistakable for the other.
function formatMaterialWeight(m) {
  if (m.weight_grams == null) return '–';
  if (m.shape_type === 'muffin_tray') {
    const total = materialCapacityGrams(m);
    return total != null ? `${m.weight_grams} g/cup (${total} g total)` : `${m.weight_grams} g/cup`;
  }
  return `${m.weight_grams}`;
}

function renderMaterialDimensionFields(container, shapeType, existingValues) {
  const preset = MATERIAL_SHAPE_PRESETS[shapeType];
  container.innerHTML = preset.fields.map(f => `
    <div class="field" style="max-width:150px;">
      <label for="mf-dim-${f.key}">${f.label}</label>
      <input id="mf-dim-${f.key}" type="number" min="0" step="${f.step}" value="${existingValues?.[f.key] ?? ''}" />
    </div>
  `).join('');
}

function readMaterialDims(shapeType, root = document) {
  const preset = MATERIAL_SHAPE_PRESETS[shapeType];
  const dims = {};
  preset.fields.forEach(f => {
    const el = root.querySelector(`#mf-dim-${f.key}`);
    const raw = el ? el.value.trim() : '';
    dims[f.key] = raw === '' ? null : parseFloat(raw);
  });
  return dims;
}

// Always sends every possible dimension column, nulling out whichever ones don't belong to the
// CURRENT shape -- so switching a material from e.g. Muffin Tray to Round before saving doesn't
// leave stale cup_* values behind in the row.
function buildMaterialDimensionPayload(shapeType, root = document) {
  const current = readMaterialDims(shapeType, root);
  const payload = {};
  Object.keys(MATERIAL_DIMENSION_DB_KEYS).forEach(key => { payload[key] = current[key] ?? null; });
  return payload;
}

// ------------------------------------------------------------------
// Parametric 3D shape preview (three.js, pinned to 0.160.0's classic global build -- see
// index.html's own comment on why). Render-on-demand, not a continuous animation loop -- this
// only ever needs to redraw right after a drag/zoom/shape-change, never on its own, so there's
// no requestAnimationFrame loop to manage or leak. Camera orbit/zoom is hand-rolled (drag to
// orbit, wheel to zoom) since three.js dropped its own classic-script OrbitControls before
// 0.160.0 -- this only needs to spin/zoom around one object, not OrbitControls' full
// pan/damping/keyboard feature set.
//
// Shadow-mapped lighting (not just an ambient/fill pair) is deliberate, not decoration: each
// built shape is a genuinely hollow, open-top container (see buildMaterialGroup) whose own outer
// wall casts a real shadow onto its own inner floor -- that self-shadowing is what makes the
// inside read as darker/recessed than the sunlit outer rim, exactly the "this is a container, not
// a slab" cue asked for. A ground plane (THREE.ShadowMaterial -- invisible except where a shadow
// actually falls on it) grounds the object against the canvas's own background instead of leaving
// it looking like it's floating.
// ------------------------------------------------------------------
function createMaterialPreview3D(canvasEl) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);

  // Hemisphere light gives the steel a believable soft top/bottom tonal gradient with no
  // environment map to load (a full PBR reflection map would need an extra asset/RoomEnvironment
  // import -- this is the lightweight equivalent, tuned for a brushed-metal rather than mirror
  // look together with the material's own roughness below).
  scene.add(new THREE.HemisphereLight(0xffffff, 0x707070, 0.55));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0015;
  scene.add(keyLight);
  scene.add(keyLight.target);
  const fillLight = new THREE.DirectionalLight(0xdce8ff, 0.3);
  scene.add(fillLight);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.22 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  let group = null;
  // Second, independent slot alongside `group` -- e.g. Recipe on Fire's dough-fill mesh sitting
  // inside a tray's own group. Deliberately NOT touched by setShape (below), so swapping the
  // overlay never disposes/rebuilds the tray itself and vice versa; each is disposed only by its
  // own setter (called with null) or by dispose() below.
  let overlay = null;
  // Third, independent slot -- pure measurement geometry (dimension lines/tick marks, see
  // buildDimensionLine below), never a real tray/dough mesh. Kept separate from `overlay` so a
  // caller can swap the dough fill and its dimension line on different triggers without one
  // clobbering the other, though in practice Recipe on Fire currently updates both together.
  let annotations = null;

  // Text labels anchored to a 3D world position (e.g. "66 x 46 cm" sitting just outside a tray's
  // edge) -- no CSS2DRenderer available (three.js here is a plain classic <script> global build,
  // not an ES-module bundle, so the addons under three/examples/jsm/ aren't reachable without a
  // much bigger module-loading change), so this hand-rolls the same idea: real DOM text, absolutely
  // positioned over the canvas, re-projected from its 3D anchor point into 2D screen space on every
  // render() call below -- which already fires on every pointer drag/wheel/rebuild, so labels track
  // the model from any angle/zoom for free, with no separate render loop of their own.
  const labelsContainer = document.createElement('div');
  labelsContainer.style.cssText = 'position:absolute; inset:0; pointer-events:none; overflow:hidden;';
  canvasEl.parentElement.appendChild(labelsContainer);
  const labelEls = new Map(); // id -> { el, worldPos: THREE.Vector3 }

  function updateLabelPositions() {
    const w = canvasEl.clientWidth || 1, h = canvasEl.clientHeight || 1;
    labelEls.forEach(({ el, worldPos }) => {
      const p = worldPos.clone().project(camera);
      const behind = p.z > 1 || p.z < -1;
      el.style.display = behind ? 'none' : '';
      if (behind) return;
      const x = (p.x * 0.5 + 0.5) * w;
      const y = (-p.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    });
  }

  // Replaces the full label set in one call -- defs: [{ id, worldPos: THREE.Vector3, text }].
  // Reuses an existing element by `id` (just updates its text/position) rather than tearing down
  // and recreating every label on every recompute, and removes whichever ids are no longer present.
  function setLabels(defs) {
    const seen = new Set();
    (defs || []).forEach(d => {
      seen.add(d.id);
      let entry = labelEls.get(d.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'material-preview-dim-label';
        labelsContainer.appendChild(el);
        entry = { el, worldPos: new THREE.Vector3() };
        labelEls.set(d.id, entry);
      }
      entry.el.textContent = d.text;
      entry.worldPos.copy(d.worldPos);
    });
    [...labelEls.keys()].forEach(id => {
      if (!seen.has(id)) { labelEls.get(id).el.remove(); labelEls.delete(id); }
    });
    updateLabelPositions();
  }
  // Orbit target -- the built shape's own bounding-box center, not a hardcoded (0,0,0). The
  // hollow shapes below aren't built symmetric around the origin (each sits with its floor at
  // y=0, same convention a real tray "resting on a surface" would use), so orbiting around a
  // fixed world origin would spin the camera around the tray's base/corner instead of its middle.
  let target = new THREE.Vector3(0, 0, 0);
  let radius = 40, theta = Math.PI / 4, phi = Math.PI / 3;

  function positionCamera() {
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function render() { renderer.render(scene, camera); updateLabelPositions(); }

  let dragging = false, lastX = 0, lastY = 0;
  function onPointerDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; canvasEl.setPointerCapture(e.pointerId); }
  function onPointerUp(e) { dragging = false; canvasEl.releasePointerCapture(e.pointerId); }
  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    theta -= dx * 0.008;
    phi = Math.min(Math.max(phi - dy * 0.008, 0.15), Math.PI - 0.15);
    positionCamera();
    render();
  }
  function onWheel(e) {
    e.preventDefault();
    radius = Math.min(Math.max(radius * (1 + e.deltaY * 0.001), 8), 300);
    positionCamera();
    render();
  }
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });

  // Geometry only, deliberately -- every mesh's material is one of the two module-level,
  // permanently-shared MATERIAL_STEEL/MATERIAL_STEEL_DARK instances (reused across every shape
  // rebuild and every open preview, not created fresh per group), so disposing it here on every
  // dimension keystroke would kill a material still in use the moment the very next shape is
  // built. Geometry, by contrast, genuinely is rebuilt fresh every call and needs disposing.
  function disposeGroup(g) {
    g.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
    });
  }

  // Frames the camera (and the key light + its shadow frustum) to a given center/size, so a tiny
  // loaf pan and a huge sheet tray both fill the preview reasonably and both get a correctly-
  // scaled shadow -- rather than one fixed setup tuned for a single size. Split out of setShape
  // (which computes newTarget/maxDim from a just-built buildMaterialGroup shape) so a caller that
  // ISN'T showing a buildMaterialGroup shape at all -- e.g. Recipe on Fire's single-cutter-piece
  // close-up, a plain dough-colored solid, not a steel tray/cutter -- can still get the same
  // auto-fit camera/lighting via the returned fitCamera method below, instead of being stuck at
  // this preview's default startup radius (tuned for nothing in particular).
  function fitCameraAndLights(newTarget, maxDim) {
    target.copy(newTarget);
    radius = maxDim * 2.2;

    ground.position.y = newTarget.y - maxDim / 2;

    keyLight.position.set(target.x + maxDim * 1.4, target.y + maxDim * 2.2, target.z + maxDim * 1.6);
    keyLight.target.position.copy(target);
    keyLight.target.updateMatrixWorld();
    const shadowCam = keyLight.shadow.camera;
    const half = maxDim * 1.6;
    shadowCam.left = -half; shadowCam.right = half; shadowCam.top = half; shadowCam.bottom = -half;
    shadowCam.near = 0.1; shadowCam.far = maxDim * 8;
    shadowCam.updateProjectionMatrix();
    fillLight.position.set(target.x - maxDim * 1.2, target.y + maxDim * 0.8, target.z - maxDim * 1.4);

    positionCamera();
  }

  function setShape(shapeType, dims, category) {
    if (group) { scene.remove(group); disposeGroup(group); group = null; }
    const built = buildMaterialGroup(shapeType, dims, category);
    if (!built) { render(); return; }
    group = built;
    scene.add(group);

    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const newTarget = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    fitCameraAndLights(newTarget, maxDim);
    ground.position.y = box.min.y; // exact floor, not fitCameraAndLights' own maxDim-based estimate

    render();
  }

  function resize() {
    const w = canvasEl.clientWidth || 1, h = canvasEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  positionCamera();

  // Adds/replaces/clears (pass null) a second group alongside the tray, without touching `group`
  // or re-framing the camera -- the tray's own setShape call already framed the camera to the
  // tray's size, and the overlay (e.g. a dough-fill mesh) is always smaller than/contained within
  // it, so no re-framing is needed here.
  function setOverlay(builtGroup) {
    if (overlay) { scene.remove(overlay); disposeGroup(overlay); overlay = null; }
    if (builtGroup) { overlay = builtGroup; scene.add(overlay); }
    render();
  }

  // Same independent-slot treatment as setOverlay, for measurement-line geometry instead of a
  // real mesh -- see `annotations` above.
  function setAnnotations(builtGroup) {
    if (annotations) { scene.remove(annotations); disposeGroup(annotations); annotations = null; }
    if (builtGroup) { annotations = builtGroup; scene.add(annotations); }
    render();
  }

  return {
    setShape,
    setOverlay,
    setAnnotations,
    setLabels,
    resize,
    // Exposed so a caller can force a redraw after mutating something render() itself doesn't
    // know changed -- e.g. a material color set directly outside of setShape/setOverlay, which
    // needs a fresh render() call to actually show up (nothing here runs its own continuous
    // render loop otherwise).
    render,
    // For a caller showing content that never goes through setShape/buildMaterialGroup at all --
    // a plain custom mesh, not a steel tray/cutter -- so it still gets the same auto-fit camera/
    // lighting instead of being stuck at this preview's default startup radius. See
    // fitCameraAndLights' own comment.
    fitCamera: fitCameraAndLights,
    dispose() {
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('wheel', onWheel);
      if (group) disposeGroup(group);
      if (overlay) disposeGroup(overlay);
      if (annotations) disposeGroup(annotations);
      labelEls.forEach(({ el }) => el.remove());
      labelEls.clear();
      labelsContainer.remove();
      ground.geometry.dispose();
      ground.material.dispose();
      renderer.dispose();
    },
  };
}

// Stainless-steel PBR look (high metalness, moderate roughness for a brushed/satin sheen rather
// than a mirror) -- shared by every shape below. steelDarkMat is used only for the muffin tray's
// cup indentations, slightly darker/duller to read as recessed even before shadow is factored in.
const MATERIAL_STEEL = new THREE.MeshStandardMaterial({ color: 0xC9CDD1, metalness: 0.85, roughness: 0.38, side: THREE.DoubleSide });
const MATERIAL_STEEL_DARK = new THREE.MeshStandardMaterial({ color: 0x9BA1A6, metalness: 0.8, roughness: 0.5, side: THREE.DoubleSide });

// A Cutter's wall is a thin cutting blade, not a tray's structural wall -- FIXED regardless of the
// cutter's own size (a real cutter's sheet-metal gauge doesn't get proportionally thicker on a
// bigger cutter the way a tray's wall reasonably does), and much thinner than the tray formulas
// below ever produce (their own 0.3cm/3mm floor read as two visually separate rings rather than
// one thin band at typical cutter sizes -- this constant replaces that formula for cutters only,
// trays are untouched). 0.15cm = 1.5mm.
const MATERIAL_CUTTER_WALL_THICKNESS_CM = 0.15;

// Builds a genuinely hollow rectangular container (floor + 4 walls, five separate box meshes,
// unless openBottom) rather than one solid block -- plain box primitives instead of an extruded/
// holed shape or a CSG subtraction, so normals/UVs behave predictably with no exotic-geometry
// edge cases. Every mesh gets its own real inner faces (visible when looking down into it) and
// casts/receives shadow, which is what actually makes the inside read as recessed -- see
// createMaterialPreview3D. openBottom (a Cutter -- see MATERIAL_CATEGORIES) skips the floor mesh
// entirely and stretches all 4 walls to the FULL height h (rather than h-floorT, which exists
// only to leave room for a floor that no longer gets built) -- a genuinely open ring/tube, open at
// both top and bottom, same as buildMaterialGroup's round/triangle cutter branches. wallThickness
// overrides the tray-scaled formula below entirely when given -- the caller (buildMaterialGroup's
// cutter branch) passes MATERIAL_CUTTER_WALL_THICKNESS_CM plus l/w already expanded outward from
// the entered INNER size, since this function's own l/w are always its OUTER footprint.
function addHollowBox(group, l, w, h, mat, { openBottom = false, wallThickness } = {}) {
  const wallT = wallThickness ?? Math.min(Math.max(Math.min(l, w) * 0.045, 0.3), 2, Math.min(l, w) * 0.4);
  const floorT = openBottom ? 0 : Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
  const innerH = Math.max(h - floorT, 0.1);
  const sideDepth = Math.max(w - 2 * wallT, 0.1);

  function addMesh(geo, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  if (!openBottom) addMesh(new THREE.BoxGeometry(l, floorT, w), 0, floorT / 2, 0); // floor
  addMesh(new THREE.BoxGeometry(l, innerH, wallT), 0, floorT + innerH / 2, -w / 2 + wallT / 2); // back wall
  addMesh(new THREE.BoxGeometry(l, innerH, wallT), 0, floorT + innerH / 2, w / 2 - wallT / 2); // front wall
  addMesh(new THREE.BoxGeometry(wallT, innerH, sideDepth), -l / 2 + wallT / 2, floorT + innerH / 2, 0); // left wall
  addMesh(new THREE.BoxGeometry(wallT, innerH, sideDepth), l / 2 - wallT / 2, floorT + innerH / 2, 0); // right wall
}

// Shrinks a simple convex polygon inward by a constant perpendicular distance -- a real polygon
// offset (each edge pushed inward along its own normal, then adjacent offset edges intersected for
// the new vertices), not a naive scale-toward-centroid, which would give a visibly non-uniform
// wall thickness on anything but a regular/equilateral shape. `points` must be wound CLOCKWISE
// (matching every outer contour in this file -- see buildMaterialGroup's triangle branch and the
// muffin tray's own outline above), so "inward" is consistently each edge's RIGHT-hand normal.
// Generic over vertex count, not triangle-specific, so any future straight-edged shape can reuse it.
function insetPolygon(points, dist) {
  const n = points.length;
  const offsetEdges = points.map((p1, i) => {
    const p2 = points[(i + 1) % n];
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len, ny = -dx / len; // right-hand normal -- inward for a CW-wound polygon
    return { px: p1[0] + nx * dist, py: p1[1] + ny * dist, dx, dy };
  });
  function intersect(e1, e2) {
    const denom = e1.dx * e2.dy - e1.dy * e2.dx;
    if (Math.abs(denom) < 1e-9) return [e2.px, e2.py]; // parallel edges -- fall back rather than divide by ~0
    const dxp = e2.px - e1.px, dyp = e2.py - e1.py;
    const t = (dxp * e2.dy - dyp * e2.dx) / denom;
    return [e1.px + t * e1.dx, e1.py + t * e1.dy];
  }
  return points.map((_, i) => intersect(offsetEdges[(i - 1 + n) % n], offsetEdges[i]));
}

// Approximates each shape with plain geometry -- no CSG/boolean-subtraction library involved
// (three.js has none built in, and adding one would be a second, heavier dependency just for a
// cosmetic refinement). Round uses a single revolved (LatheGeometry) profile -- the natural way
// to build a hollow vessel of revolution, tracing outer wall up, across the rim, down the inner
// wall, and across the interior floor in one continuous path. Rectangular uses addHollowBox (a
// box has no rotational symmetry for Lathe to exploit). The muffin tray is its own case again --
// a solid base slab plus a thin extruded "rim plate" with one hole per cup (THREE.Shape + holes
// via ExtrudeGeometry), each hole continued below by its own small rounded/tapered LatheGeometry
// well -- see the muffin_tray branch below for the full reasoning. All shapes sit with their
// floor's underside at y=0 (like a real tray resting on a surface), not centered on the origin --
// see the preview's own orbit-target comment for why that matters here. Returns null when the
// current shape's required dimensions aren't all filled in yet (a blank/partial New Material form).
//
// `category` (see MATERIAL_CATEGORIES) decides whether the shape gets a floor at all -- a Cutter
// renders fully open, top AND bottom, a genuine hollow ring/tube, regardless of which shape it is;
// everything else (Tray/Pan) keeps the closed-floor container built here unchanged. Muffin trays
// are never cutters in practice (a multi-cavity tray has no cutter use), so that branch doesn't
// read `category` at all.
function buildMaterialGroup(shapeType, dims, category) {
  const group = new THREE.Group();
  const isCutter = category === 'cutter';

  if (shapeType === 'round') {
    const { diameterCm: d, heightCm: h } = dims;
    if (!(d > 0) || !(h > 0)) return null;

    if (isCutter) {
      // Entered diameter is the INNER (cutting) size -- the actual piece the cutter produces --
      // not an outer measurement the wall eats into, so a future area/portion calculation can use
      // exactly what she typed with no hidden offset. Wall is added OUTWARD from that, at the
      // fixed thin cutter gauge (not the tray formula), which is also what fixes the "two visually
      // separate rings" bug -- outer and inner tube now sit close enough to read as one thin band.
      const innerR = d / 2;
      const outerR = innerR + MATERIAL_CUTTER_WALL_THICKNESS_CM;
      // Open ring: two separate open tubes (outer wall, inner wall), each just a vertical line
      // revolved 360deg -- no closing segment at y=0 or y=h, so neither a floor nor a top rim cap
      // gets built. MATERIAL_STEEL's side:DoubleSide (set once, module-level) is what makes the
      // inner tube's inside face visible when looking down into the ring from above, same as the
      // tray version's own hollow interior below relies on for its floor -- proven convention,
      // just applied to two independent tubes instead of one closed profile here.
      [outerR, innerR].forEach(r => {
        const mesh = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(r, 0), new THREE.Vector2(r, h)], 48), MATERIAL_STEEL);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      });
    } else {
      // Tray semantics unchanged: entered diameter is the OUTER footprint, wall eats inward.
      const outerR = d / 2;
      const wallT = Math.min(Math.max(outerR * 0.07, 0.3), 1.8, outerR * 0.4);
      const innerR = Math.max(outerR - wallT, 0.05);
      const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
      const profile = [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(outerR, 0),
        new THREE.Vector2(outerR, h),
        new THREE.Vector2(innerR, h),
        new THREE.Vector2(innerR, floorT),
        new THREE.Vector2(0, floorT),
      ];
      const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), MATERIAL_STEEL);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  } else if (shapeType === 'rectangular') {
    const { lengthCm: l, widthCm: w, heightCm: h } = dims;
    if (!(l > 0) || !(w > 0) || !(h > 0)) return null;
    if (isCutter) {
      // Same inner-measurement treatment as round above -- entered l/w are the INNER cutting
      // footprint, addHollowBox's own l/w params are its OUTER footprint (unchanged contract), so
      // the outward-expanded size is computed here and passed in, along with the fixed thin cutter
      // wall gauge overriding addHollowBox's own tray-scaled wallT formula.
      const outerL = l + 2 * MATERIAL_CUTTER_WALL_THICKNESS_CM;
      const outerW = w + 2 * MATERIAL_CUTTER_WALL_THICKNESS_CM;
      addHollowBox(group, outerL, outerW, h, MATERIAL_STEEL, { openBottom: true, wallThickness: MATERIAL_CUTTER_WALL_THICKNESS_CM });
    } else {
      addHollowBox(group, l, w, h, MATERIAL_STEEL);
    }
  } else if (shapeType === 'muffin_tray') {
    const { lengthCm: l, widthCm: w, heightCm: h, cupDiameterCm: cd, cupDepthCm: cdepth, cupRows: rows, cupColumns: cols } = dims;
    if (!(l > 0) || !(w > 0) || !(h > 0) || !(cd > 0) || !(cdepth > 0) || !(rows > 0) || !(cols > 0)) return null;

    // A real muffin tray is a solid, flat-rimmed slab with round wells punched into it -- NOT an
    // open hollow box (addHollowBox, right for round/rectangular pans) with separate cup meshes
    // just dropped inside it, which is what this used to build: the gaps between/around cups
    // exposed the box's own large, much-lower open floor, reading as a deep surrounding pit
    // instead of a flat bordered tray. Rebuilt in two solid layers instead -- no CSG needed:
    //  1) a plain solid BoxGeometry filling the tray's full footprint/height (nothing hollow to
    //     see through), and
    //  2) a thin flat "rim plate" on top -- a THREE.Shape (the tray's outer rectangle) with one
    //     circular hole per cup, extruded via ExtrudeGeometry. Extruding a shape-with-holes is a
    //     genuine three.js feature (used for things like punched text/plate CAD demos): it
    //     triangulates correctly-wound walls around every hole for free, which is exactly "a flat
    //     bordered plate with round openings" -- no boolean subtraction required.
    // Each cup then continues below the rim plate's hole as its own small LatheGeometry well --
    // same profile family as the round vessel's hollow interior and the previous cup fix, just
    // with more points so the wall eases into a gentle curve (not a straight-sided cone) and a
    // quarter-circle fillet rounds the wall into the floor, instead of meeting it at a sharp
    // corner -- matching a real muffin cup's tapered, rounded-bottom shape.
    const cupX = (c) => -l / 2 + (l / (cols + 1)) * (c + 1);
    const cupZ = (r) => -w / 2 + (w / (rows + 1)) * (r + 1);
    const holeR = cd / 2;

    // Rim plate thickness -- thin relative to the tray (just enough to read as a real bordered
    // plate), but also capped by a fraction of cup depth so there's always meaningful well depth
    // left below it for the tapered/rounded portion.
    const rimT = Math.min(Math.max(h * 0.2, 0.15), 0.8, h * 0.4, cdepth * 0.35);
    const baseH = Math.max(h - rimT, 0.05);

    const base = new THREE.Mesh(new THREE.BoxGeometry(l, baseH, w), MATERIAL_STEEL);
    base.position.set(0, baseH / 2, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    // Shape is built in local XY and extruded along local Z, then rotated so Z becomes world Y
    // (up) -- the standard "floor plan extruded vertically" three.js pattern. That rotation
    // (rotateX(-90deg)) maps local Y to -world Z, which is why hole/outline Y coordinates below
    // are the NEGATED world Z they need to end up at.
    const outline = new THREE.Shape();
    outline.moveTo(-l / 2, w / 2);
    outline.lineTo(l / 2, w / 2);
    outline.lineTo(l / 2, -w / 2);
    outline.lineTo(-l / 2, -w / 2);
    outline.closePath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hole = new THREE.Path();
        hole.absarc(cupX(c), -cupZ(r), holeR, 0, Math.PI * 2, false);
        outline.holes.push(hole);
      }
    }
    const rimGeo = new THREE.ExtrudeGeometry(outline, { depth: rimT, bevelEnabled: false, curveSegments: 24 });
    const rimPlate = new THREE.Mesh(rimGeo, MATERIAL_STEEL);
    rimPlate.rotateX(-Math.PI / 2);
    rimPlate.position.y = baseH;
    rimPlate.castShadow = true;
    rimPlate.receiveShadow = true;
    group.add(rimPlate);

    // Each cup's well picks up exactly where the rim plate's hole wall ends (same radius holeR,
    // at y = baseH) and continues down to a rounded bottom: an eased taper from holeR to a
    // smaller bottomR, then a quarter-circle fillet from bottomR down to the center floor. Same
    // "down, then inward toward the axis" point direction as the round vessel's own hollow
    // interior and the previous cup fix -- that's what keeps the surface facing up/inward
    // (concave, visible from above) rather than flipping convex.
    const wellTopY = baseH;
    const floorY = Math.max(h - cdepth, 0.05);
    const wellDepth = Math.max(wellTopY - floorY, 0.05);
    const bottomR = Math.min(holeR * 0.55, wellDepth * 0.9);
    const wallBottomY = floorY + bottomR;
    const wallSegs = 6;
    const filletSegs = 6;
    const cupProfile = [];
    for (let i = 0; i <= wallSegs; i++) {
      const t = i / wallSegs;
      const ease = 0.5 - 0.5 * Math.cos(t * Math.PI); // smooth 0..1, curves the wall instead of a straight cone
      cupProfile.push(new THREE.Vector2(
        holeR + (bottomR - holeR) * ease,
        wellTopY + (wallBottomY - wellTopY) * ease
      ));
    }
    for (let j = 1; j <= filletSegs; j++) {
      const t = j / filletSegs;
      const a = t * Math.PI / 2;
      cupProfile.push(new THREE.Vector2(bottomR * Math.cos(a), floorY + bottomR * (1 - Math.sin(a))));
    }
    const cupGeo = new THREE.LatheGeometry(cupProfile, 24);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cup = new THREE.Mesh(cupGeo, MATERIAL_STEEL_DARK);
        cup.castShadow = true;
        cup.receiveShadow = true;
        cup.position.set(cupX(c), 0, cupZ(r));
        group.add(cup);
      }
    }
  } else if (shapeType === 'triangle') {
    // Isosceles, apex centered above the base -- see MATERIAL_SHAPE_PRESETS.triangle's own
    // comment for why (fully determined by base+triHeight, no third side-length/angle input).
    // Built the same way the muffin tray's rim plate is (a THREE.Shape extruded via
    // ExtrudeGeometry, with a hole triangulated for free) rather than addHollowBox's per-side box
    // walls, since a box's 4 orthogonal wall meshes don't generalize to a triangle's edges -- an
    // extruded outline-with-hole does, for any straight-edged shape. Two meshes normally: a solid
    // floor slab (outer outline, no hole) and a wall ring (outer outline with an inset hole, via
    // insetPolygon), stacked floorT..h same as every other shape here -- a Cutter skips the floor
    // mesh entirely and stretches the ring to the full height h at y=0, same "open top and bottom,
    // no floor at all" treatment as the round/rectangular cutter branches above.
    const { baseCm: b, triHeightCm: triH, heightCm: h } = dims;
    if (!(b > 0) || !(triH > 0) || !(h > 0)) return null;
    const floorT = isCutter ? 0 : Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
    const innerH = Math.max(h - floorT, 0.1);

    // Local shape-space (x,y) -- extruded along local Z (becomes world Y/vertical after the
    // rotateX(-90deg) below), so these two coordinates are purely a flat footprint outline, not
    // tied to any world X/Z orientation (unlike the muffin tray's holes, this shape has no other
    // world-space-positioned meshes it needs to align with, so no sign correction is needed).
    // Wound clockwise -- see insetPolygon's own comment on why that orientation matters.
    //
    // Cutter: entered base/triHeight are the INNER (cutting) triangle -- the actual piece the
    // cutter produces, no hidden offset -- so the OUTER triangle is computed by expanding OUTWARD
    // (insetPolygon with a NEGATIVE distance; the function doesn't care about the sign, it just
    // offsets each edge along its own normal either direction) at the fixed thin cutter wall gauge,
    // same fix as the round/rectangular branches above. Tray: unchanged, entered points are the
    // OUTER footprint and the inner hole is inset from that at the tray-scaled wallT formula.
    let outerPts, innerPts;
    if (isCutter) {
      innerPts = [[-b / 2, 0], [0, triH], [b / 2, 0]];
      outerPts = insetPolygon(innerPts, -MATERIAL_CUTTER_WALL_THICKNESS_CM);
    } else {
      outerPts = [[-b / 2, 0], [0, triH], [b / 2, 0]];
      const wallT = Math.min(Math.max(Math.min(b, triH) * 0.05, 0.3), 2, Math.min(b, triH) * 0.4);
      innerPts = insetPolygon(outerPts, wallT);
    }

    const outerShape = new THREE.Shape();
    outerShape.moveTo(outerPts[0][0], outerPts[0][1]);
    outerPts.slice(1).forEach(([x, y]) => outerShape.lineTo(x, y));
    outerShape.closePath();

    if (!isCutter) {
      const floorGeo = new THREE.ExtrudeGeometry(outerShape, { depth: floorT, bevelEnabled: false, curveSegments: 1 });
      const floor = new THREE.Mesh(floorGeo, MATERIAL_STEEL);
      floor.rotateX(-Math.PI / 2);
      floor.castShadow = true;
      floor.receiveShadow = true;
      group.add(floor);
    }

    const ringShape = new THREE.Shape();
    ringShape.moveTo(outerPts[0][0], outerPts[0][1]);
    outerPts.slice(1).forEach(([x, y]) => ringShape.lineTo(x, y));
    ringShape.closePath();
    // insetPolygon preserves its input's winding (CW, same as outerPts), but a hole needs the
    // OPPOSITE winding from its outer contour for three.js to triangulate it correctly (same rule
    // the muffin tray's own round holes follow via absarc's counterclockwise sweep) -- reversed
    // here rather than changing insetPolygon itself, which is winding-agnostic by design.
    const holePts = [...innerPts].reverse();
    const hole = new THREE.Path();
    hole.moveTo(holePts[0][0], holePts[0][1]);
    holePts.slice(1).forEach(([x, y]) => hole.lineTo(x, y));
    hole.closePath();
    ringShape.holes.push(hole);

    const ringGeo = new THREE.ExtrudeGeometry(ringShape, { depth: innerH, bevelEnabled: false, curveSegments: 1 });
    const ring = new THREE.Mesh(ringGeo, MATERIAL_STEEL);
    ring.rotateX(-Math.PI / 2);
    ring.position.y = floorT;
    ring.castShadow = true;
    ring.receiveShadow = true;
    group.add(ring);
  } else {
    return null;
  }

  return group;
}

// ---- Recipe on Fire (Phase 1) support -------------------------------------------------------
// Interior usable footprint (area, cm^2) and usable height (cm) for a tray/pan Material's
// dimensions -- mirrors buildMaterialGroup's own wall/floor-thickness formulas above exactly, so
// the dough-fill visual below always lines up with what that function actually renders. Can't just
// call buildMaterialGroup and read its geometry back out (it builds meshes as a side effect, no
// numeric return), so these are kept as a second copy of the same handful of one-line clamp
// formulas -- if those change up there, update the matching branch here too.
function trayInteriorFootprint(shapeType, dims) {
  if (shapeType === 'round') {
    const { diameterCm: d, heightCm: h } = dims;
    if (!(d > 0) || !(h > 0)) return null;
    const outerR = d / 2;
    const wallT = Math.min(Math.max(outerR * 0.07, 0.3), 1.8, outerR * 0.4);
    const innerR = Math.max(outerR - wallT, 0.05);
    const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
    return { areaCm2: Math.PI * innerR * innerR, usableHeightCm: Math.max(h - floorT, 0.1), floorT, innerR };
  }
  if (shapeType === 'rectangular') {
    const { lengthCm: l, widthCm: w, heightCm: h } = dims;
    if (!(l > 0) || !(w > 0) || !(h > 0)) return null;
    const wallT = Math.min(Math.max(Math.min(l, w) * 0.045, 0.3), 2, Math.min(l, w) * 0.4);
    const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
    const innerL = Math.max(l - 2 * wallT, 0.1);
    const innerW = Math.max(w - 2 * wallT, 0.1);
    return { areaCm2: innerL * innerW, usableHeightCm: Math.max(h - floorT, 0.1), floorT, innerL, innerW };
  }
  if (shapeType === 'triangle') {
    const { baseCm: b, triHeightCm: triH, heightCm: h } = dims;
    if (!(b > 0) || !(triH > 0) || !(h > 0)) return null;
    const outerPts = [[-b / 2, 0], [0, triH], [b / 2, 0]];
    const wallT = Math.min(Math.max(Math.min(b, triH) * 0.05, 0.3), 2, Math.min(b, triH) * 0.4);
    const innerPts = insetPolygon(outerPts, wallT);
    const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
    // Shoelace formula -- exact area for any simple polygon, not just an isosceles triangle, so
    // this stays correct even if insetPolygon's own offset math shifts the inner points slightly.
    let area2 = 0;
    for (let i = 0; i < innerPts.length; i++) {
      const [x1, y1] = innerPts[i];
      const [x2, y2] = innerPts[(i + 1) % innerPts.length];
      area2 += x1 * y2 - x2 * y1;
    }
    return { areaCm2: Math.abs(area2) / 2, usableHeightCm: Math.max(h - floorT, 0.1), floorT, innerPts };
  }
  if (shapeType === 'muffin_tray') {
    const { heightCm: h, cupDiameterCm: cd, cupDepthCm: cdepth, cupRows: rows, cupColumns: cols } = dims;
    if (!(cd > 0) || !(cdepth > 0) || !(rows > 0) || !(cols > 0) || !(h > 0)) return null;
    // Ignores the real cup's tapered wall/rounded-fillet bottom (see buildMaterialGroup's own
    // muffin_tray branch) -- a plain cylinder per cup is a deliberate simplification, good enough
    // for a capacity estimate/visual without replicating that geometry's frustum math here.
    const cupAreaCm2 = Math.PI * (cd / 2) * (cd / 2);
    const floorY = Math.max(h - cdepth, 0.05);
    return { areaCm2: cupAreaCm2 * rows * cols, usableHeightCm: cdepth, cupAreaCm2, floorY, rows, cols };
  }
  return null;
}

// ---- Recipe on Fire: cutter measurements -----------------------------------------------------
// Area and label of one cutter piece. (Where cutters go -- the auto-arrange packing -- lives in
// renderer/rof/packing.js.)

function cutterUnitAreaCm2(shapeType, dims) {
  if (shapeType === 'round') return Math.PI * ((dims.diameterCm || 0) / 2) ** 2;
  if (shapeType === 'rectangular') return (dims.lengthCm || 0) * (dims.widthCm || 0);
  if (shapeType === 'triangle') return 0.5 * (dims.baseCm || 0) * (dims.triHeightCm || 0);
  return 0;
}

// A one-line size label for a single cutter piece -- what the Trim panel's per-piece report
// leads with, since every piece from one layout is identical and that's the number a chef
// actually needs (how big is ONE portion), not just an aggregate.
function cutterPieceSizeLabel(shapeType, dims) {
  if (shapeType === 'round') return `⌀ ${roundNice(dims.diameterCm)} cm`;
  if (shapeType === 'rectangular') return `${roundNice(dims.lengthCm)} × ${roundNice(dims.widthCm)} cm`;
  if (shapeType === 'triangle') return `Base ${roundNice(dims.baseCm)} × H ${roundNice(dims.triHeightCm)} cm`;
  return '';
}

// ---- Recipe on Fire (Phase 1: process + tray selection, static 3D dough-fill visualization) ----
// New multi-phase feature, built and confirmed one phase at a time per the chef's own request.
// Phase 1 only: pick a recipe + exactly ONE of its processes (never "All Processes" -- Recipe on
// Fire always operates on a single process's dough), pick a tray/pan Material, and see that
// process's current Net Weight rendered as a dough-fill mesh inside the tray's own 3D model. Bake
// (proofing %), cutter layout/packing, manual drag-adjust, and confirm/persist are later phases --
// none of that exists yet, on purpose.
function renderRecipeOnFireView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Recipe on Fire</h1><span class="page-description">Pick the process(es) going into one tray, then the tray itself</span></div>
    </div>

    <div class="rof-layout">
      <div class="rof-side">
        <div id="rof-recipe-compact" class="rof-compact" style="display:none;"></div>
        <div id="rof-recipe-card">
        <div class="generate-controls">
          <div class="field source-field">
            <label>Recipe source</label>
            <div class="mode-toggle">
              <button type="button" class="mode-toggle-btn active" data-rof-source="book">Recipe Book</button>
              <button type="button" class="mode-toggle-btn" data-rof-source="extractor">Recipe Extractor</button>
              <button type="button" class="mode-toggle-btn" data-rof-source="generated">Recipe Generator</button>
            </div>
          </div>
          <div class="field" style="min-width:0;">
            <label>Recipe Name</label>
            <div class="autocomplete-wrap">
              <input id="rof-recipe-name" autocomplete="off" style="padding-right:28px; width:100%;" />
              <button type="button" class="autocomplete-browse-btn" id="rof-recipe-browse-btn" aria-label="Browse recipes" title="Browse all recipes">▾</button>
              <div class="autocomplete-list" id="rof-recipe-list" hidden></div>
            </div>
          </div>
        </div>
        </div>

        <div id="rof-setup-block">
        <div class="field" style="display:none; margin-bottom:14px;" id="rof-process-field">
          <div class="rof-process-head">
            <label>Process(es) going into this tray <span title="Check more than one when separate processes (e.g. a biga and a final dough) get combined into one dough before baking, or choose In layers when they are stacked (e.g. a pastry base with a filling on top). Leave a process unchecked if it isn't going into this tray." style="cursor:help; color:var(--neutral);">ⓘ</span></label>
            <span id="rof-layout-slot"></span>
          </div>
          <div id="rof-process-checks" style="display:flex; flex-direction:column; gap:6px; margin-top:4px;"></div>
        </div>

        <div id="rof-process-summary"></div>
        </div>
        <div id="rof-tray-section" style="display:none;">
          <div class="rof-steps" id="rof-steps"></div>
          <div id="rof-step-panel" class="rof-control-strip"></div>
        </div>
      </div>

      <div class="rof-stage-col">
        <div class="material-preview-wrap" id="rof-tray-canvas-wrap">
          <div class="rof-game-wrap" id="rof-game-wrap" hidden></div>
          <div class="material-preview-empty" id="rof-preview-empty">Pick a recipe and a tray to start.</div>
        </div>
      </div>
    </div>
  `;

  const sourceButtons = document.querySelectorAll('.generate-controls [data-rof-source]');
  const nameInput = document.getElementById('rof-recipe-name');
  const listEl = document.getElementById('rof-recipe-list');
  const browseBtn = document.getElementById('rof-recipe-browse-btn');
  const processField = document.getElementById('rof-process-field');
  const processChecksEl = document.getElementById('rof-process-checks');
  const summaryEl = document.getElementById('rof-process-summary');
  const traySection = document.getElementById('rof-tray-section');
  const previewEmptyEl = document.getElementById('rof-preview-empty');
  const gameWrapEl = document.getElementById('rof-game-wrap');
  const recipeCardEl = document.getElementById('rof-recipe-card');
  const setupBlockEl = document.getElementById('rof-setup-block');
  const recipeCompactEl = document.getElementById('rof-recipe-compact');

  // Reloaded each time Setup or Trim opens (and taken from the dialog after "+ Create new …"), so a
  // material added meanwhile -- by her in the dialog, or by a colleague in Materials -- is in the list.
  let materialsPromise = window.api.listMaterials();
  const reloadMaterials = () => { materialsPromise = window.api.listMaterials(); };
  const NEW_MATERIAL = '__new'; // the "+ Create new …" option's value in the tray / cutter dropdowns
  const wasteTypesPromise = window.api.listWasteTypes();

  let source = 'book';
  let selectedRecipe = null;
  let workingProcesses = [];
  let selectedProcessLocalIds = new Set();
  let browseListShowing = false;
  let trayMaterials = []; // tray_pan-only, refreshed by populateMaterialSelect each time it runs
  // Session-only, regenerated from the checked processes' own saved wastes on every structural
  // rebuild (see renderProcessSummary) -- ONE flat wastage list applied against the COMBINED total
  // quantity, never per-process. A single dough going into one tray (even when assembled from
  // several separate processes, e.g. a biga + a final dough) has one wastage picture, not several
  // independent ones stacked together.
  let combinedWastes = [];

  // ---- Layered tray (Sheet & Trim only) --------------------------------------------------------------
  // With two or more processes ticked she chooses how they go in: 'mixed' (one dough -- everything above,
  // unchanged) or 'layers' (stacked in the tray, bottom first: e.g. a puff pastry base pre-baked alone, then
  // a filling poured on top up to a height). The arithmetic is renderer/rof/layers.js (pure); this keeps the
  // choices and shows the plan. Session-only, like the rest of this screen. Phase L1: the plan only -- the
  // pre-bake / fill / bake / trim steps for layers come later, so Continue waits in layers mode.
  let doughLayout = 'mixed';       // 'mixed' | 'layers'
  let layerOrder = [];             // process localIds (strings), bottom first
  const layerCfg = new Map();      // localId -> { density, prebake, fillKind: 'all' | 'height', targetCm, wastes }
  let layerTraysManual = null;     // her tray count, or null = from the bottom layer's Fill Weight (else 1)
  let layerPlan = null;            // the last planLayers() result
  const layersActive = () => doughLayout === 'layers' && selectedProcesses().length >= 2;

  // ---- Step-wizard state -----------------------------------------------------------------------
  // One continuous session over shared state (processes / wastes / tray / whatever is in the game view),
  // not separate routes. `rofStep` decides which panel #rof-step-panel renders; the game view
  // (renderer/rof/) holds the pieces, sheet and cutters and persists across steps.
  //   Shape & Place ('shape'): setup -> place -> bake      (divide the dough into pieces, place each by hand)
  //   Sheet & Trim  ('sheet'): setup -> bake -> trim       (one sheet in the tray, baked whole, then cut)
  let rofMode = 'shape';
  let rofStep = 'setup'; // 'setup' | 'place' | 'bake' | 'trim'
  // Stages actually reached this session -- what the step-pill click handler (navigateRofStep, below)
  // uses to allow jumping back to a stage or forward to one already set up, never to one that hasn't
  // been. Reset to just {setup} at every full-session reset (recipe/process change, Back to Setup).
  let reachedRofSteps = new Set(['setup']);
  function goToRofStep(step) { rofStep = step; reachedRofSteps.add(step); }
  let placeShapeKey = 'burgerBall';
  let placeCount = null;   // pieces the dough is divided into; null = default for the chosen shape
  let placeSession = null; // { count, shape } while a Shape & Place session is running
  let placeFresh = true;   // true when entering the place step from Setup (start a new session)
  let placeNote = '';
  let placeGrams = null;         // portion weight the chef chose (g); null = start from the default
  let placeGramsUser = false;    // true once the chef set it -- kept when the shape changes
  let recipePortionGrams = null; // the recipe's own portion_weight_grams, when it has one
  let bakeDoneness = 'golden';   // 'light' | 'golden' | 'dark' (session-only)
  // Oven temperature and bake time, for the PDF. Session-only: never saved anywhere. Pre-filled from the recipe's method
  // text when it says something readable ('method'), and the chef confirms or corrects it ('chef').
  let bakeParams = { temp: '', unit: 'C', time: '', source: '', confirmed: true, snippet: '', touched: false };
  let bakeState = 'ready';       // 'ready' | 'baking' | 'done'
  let bakeCtl = null;            // { promise, skip() } while a bake is running
  let riseModel = null;          // deterministic rise estimate for the current dough
  let riseScale = 1;             // the chef's manual correction of that estimate (1 = as estimated)
  let recipeEditing = false; // Setup: the recipe card is collapsed to a strip once a recipe is picked, unless this is set
  // Sheet & Trim
  let sheetInfo = null;          // { thicknessCm, capacityGrams, sessionGrams, sessions } for this dough + tray
  let cutterMaterials = [];      // cutter-category Materials
  let armedCutterId = null;      // which cutter Material follows the pointer, if any
  let lastCutterId = null;       // last cutter chosen (auto-arrange uses it even after the pointer is freed)
  let cutterList = [];           // cutters currently on the sheet, as reported by the game (or a knife grid's pieces)
  let trimNote = '';
  // Trim step: 'cutter' (stamp / arrange cutters from Materials) or 'knife' (a centred grid of straight cuts; no
  // material involved). knifeSpec = { across, down, cut }: the piece size in cm, and whether she pressed Cut
  // (dotted preview -> solid lines; One portion / Export PDF wait for it). The sizes last for the screen visit.
  let trimMode = 'cutter';
  let knifeSpec = null;
  // Frozen when "Continue ->" is clicked on Setup: every later step computes off THIS snapshot, never
  // off live tray inputs, since those controls are gone once the Setup panel is replaced.
  let bakeSnapshot = null; // { material, dims, footprint, netWeight }
  let lastMaterialId = null; // remembered across a checkbox toggle / "<- Edit Setup" round-trip

  function currentNs() {
    if (source === 'book') return RECIPE_NS.book;
    if (source === 'extractor') return RECIPE_NS.extractor;
    return RECIPE_NS.generated;
  }

  // The process(es) actually feeding this tray -- 1 in the common case, 2+ when separate
  // components (a biga + a final dough, e.g. Ciabatta) get combined into one dough before baking.
  // Always an explicit chef choice (see the checkbox list below), never an automatic "combine
  // every process in the recipe" -- a cake's filling process must stay excludable.
  function selectedProcesses() {
    // selectedProcessLocalIds holds checkbox VALUES, always strings -- p.localId is a number
    // (++_recipeRowLocalIdCounter), so this must compare as strings on both sides or Set.has()
    // never matches anything (the bug behind an earlier "summary panel and 3D preview both went
    // blank" report: this always silently returned [], which both renderProcessSummary and
    // updateFillPreview treat identically to "nothing selected yet").
    return workingProcesses.filter(p => selectedProcessLocalIds.has(String(p.localId)));
  }

  // ---- 3D game view (renderer/rof/) --------------------------------------------------------------
  // The whole tray / bench / sheet / cutters view. If the module can't load, the stage says so.
  let rofGame = null, rofGamePromise = null, rofGameFailed = false, shownTrayKey = null;

  function ensureRofGame() {
    if (!rofGamePromise) {
      rofGamePromise = new Promise((resolve, reject) => {
        const make = () => {
          try {
            rofGame = window.RofGame.create(gameWrapEl, {});
            rofGame.setSfx({ pickup: playPickupSound, place: playPlaceSound, refuse: playRefuseSound, arrange: playArrangeSound, bakeAmbience: startBakeAmbience, ding: playDingSound });
            rofGame.on('placement', (state) => { placeNote = ''; updatePlaceSummary(state); });
            rofGame.on('cutters', (list) => { cutterList = list; trimNote = ''; updateTrimSummary(); });
            rofGame.on('armed', (spec) => { armedCutterId = spec ? spec.materialId : null; if (spec) lastCutterId = spec.materialId; syncCutterPicker(); });
            rofGame.on('portion', ({ open }) => syncPortionBtn(open));
            resolve(rofGame);
          } catch (err) { reject(err); }
        };
        if (window.RofGame) { make(); return; }
        const timer = setTimeout(() => reject(new Error('The 3D module did not load.')), 8000);
        window.addEventListener('rof-game-ready', () => { clearTimeout(timer); make(); }, { once: true });
      });
    }
    return rofGamePromise;
  }

  function syncPreviewMode() {
    const useGame = !!bakeSnapshot && !rofGameFailed;
    gameWrapEl.hidden = !useGame;
    if (rofGameFailed) { previewEmptyEl.textContent = "The 3D view couldn't load."; previewEmptyEl.style.display = ''; }
    if (!useGame) return;
    const { material, dims, footprint } = bakeSnapshot;
    const key = `${material.id}|${JSON.stringify(dims)}`;
    ensureRofGame().then((game) => {
      if (!bakeSnapshot) return;
      game.resize();
      if (key === shownTrayKey) return; // same tray -- keep it (and whatever is on it)
      shownTrayKey = key;
      game.setTray({ shapeType: material.shape_type, dims, footprint });
      try { if (localStorage.getItem('rofGameLookdev') === '1') game.showLookdev(); } catch { /* no storage */ }
    }).catch((err) => {
      console.error('[recipe-on-fire game]', err);
      rofGameFailed = true;
      gameWrapEl.hidden = true;
      previewEmptyEl.textContent = "The 3D view couldn't load.";
      previewEmptyEl.style.display = '';
    });
  }

  // Drops everything in the game view that belongs to the current session (pieces / sheet / cutters).
  function resetGameSession() {
    if (rofGame) { rofGame.endPlacement(); rofGame.endSheet(); rofGame.clearItems(); }
    placeSession = null; placeCount = null; placeNote = '';
    placeGrams = null; placeGramsUser = false;
    cutterList = []; armedCutterId = null; trimNote = ''; sheetInfo = null;
    if (knifeSpec) knifeSpec.cut = false;
    riseScale = 1;
    bakeParams = { temp: '', unit: 'C', time: '', source: '', confirmed: true, snippet: '', touched: false };
  }

  function clearSelection() {
    selectedRecipe = null;
    workingProcesses = [];
    selectedProcessLocalIds = new Set();
    combinedWastes = [];
    doughLayout = 'mixed'; layerOrder = []; layerCfg.clear(); layerTraysManual = null; layerPlan = null;
    rofStep = 'setup';
    reachedRofSteps = new Set(['setup']);
    bakeSnapshot = null;
    lastMaterialId = null;
    recipePortionGrams = null;
    processField.style.display = 'none';
    processChecksEl.innerHTML = '';
    summaryEl.innerHTML = '';
    const layoutSlot = document.getElementById('rof-layout-slot');
    if (layoutSlot) layoutSlot.innerHTML = '';
    traySection.style.display = 'none';
    previewEmptyEl.style.display = '';
    resetGameSession();
    recipeEditing = false;
    syncRecipeBlock();
    syncPreviewMode();
  }

  function combinedTotalQuantity(processes) {
    return roundNice(processes.reduce((sum, p) => sum + sumIngredientQuantities(p.ingredientRows), 0));
  }

  // Structural rebuild -- called on checkbox change / recipe pick, i.e. whenever the SET of
  // processes shown changes. Waste % edits/adds/removes (see renderWasteRowsFor) deliberately do
  // NOT go through this again for a plain % edit -- only refreshComputedNumbers, so a keystroke in
  // the % input never wipes the input's own focus mid-type. combinedWastes rebuilt here is a
  // session-only, unsaved copy (seeded from each checked process's own buildProcessFromSaved
  // wastes) -- this view has no Save action at all, so nothing typed/added/removed here ever
  // reaches the real recipe.
  function renderProcessSummary() {
    const procs = selectedProcesses();
    if (procs.length === 0) { summaryEl.innerHTML = ''; combinedWastes = []; wireLayoutToggle(); return; }
    if (layersActive()) { combinedWastes = []; renderLayerSummary(procs); return; }
    // One flat wastage list for the whole combined dough, not one per process -- see
    // combinedWastes' own declaration above for why. Fresh localIds so this copy is independent
    // of each process's own (untouched) proc.wastes, which stays available to reseed from the
    // next time the checked SET changes.
    combinedWastes = procs.flatMap(p => p.wastes.map(w => ({ ...w, localId: ++_recipeRowLocalIdCounter })));
    summaryEl.innerHTML = `
      <div class="computed-value-box" style="max-width:640px; margin:4px 0 18px;">
        ${procs.map(p => `
          <div style="margin-bottom:4px; font-size:13px;"><strong>${p.name || '(untitled process)'}</strong> — Total Quantity: <span id="rof-total-${p.localId}"></span> g</div>
        `).join('')}
        ${procs.length > 1 ? `<div style="margin:6px 0 10px;"><strong>Combined Total Quantity:</strong> <span id="rof-combined-total"></span> g</div>` : ''}
        <details class="rof-waste-details" style="margin:8px 0;">
          <summary style="font-size:12px; color:var(--neutral); cursor:pointer;">Wastage Applied${procs.length > 1 ? ' (combined -- one dough, one wastage picture)' : ''} <span id="rof-waste-count"></span></summary>
          <div id="rof-wastes-combined" style="margin-top:6px;"></div>
          <select class="builder-select" data-rof-add-waste="combined" style="margin-top:6px; max-width:220px; font-size:12px;">
            <option value="">+ Add Waste…</option>
          </select>
        </details>
        <div><strong>Net Weight:</strong> <span id="rof-net-combined"></span> g</div>
      </div>
    `;
    wireLayoutToggle();
    renderWasteRowsFor();
    refreshComputedNumbers();
  }

  // ---- Layered tray: Setup ------------------------------------------------------------------------------
  function layoutToggleHtml() {
    const on = doughLayout === 'layers';
    return `
      <div class="rof-layout-row">
        <div class="mode-toggle rof-mini-toggle" id="rof-layout-toggle" role="group" aria-label="How do these processes go into the tray?">
          <button type="button" class="mode-toggle-btn ${on ? '' : 'active'}" data-rof-layout="mixed" aria-pressed="${!on}" title="Mixed into one dough (e.g. a biga and a final dough)">One dough</button>
          <button type="button" class="mode-toggle-btn ${on ? 'active' : ''}" data-rof-layout="layers" aria-pressed="${on}" title="Stacked in the tray (e.g. a pastry base with a filling on top)">In layers</button>
        </div>
      </div>`;
  }
  // Draws the Mixed / In layers choice beside the "Process(es) going into this tray" label (no extra row), only
  // when two or more processes are ticked.
  function wireLayoutToggle() {
    const slot = document.getElementById('rof-layout-slot');
    if (!slot) return;
    slot.innerHTML = selectedProcesses().length > 1 ? layoutToggleHtml() : '';
    slot.querySelectorAll('[data-rof-layout]').forEach(b => b.addEventListener('click', () => {
      if (doughLayout === b.dataset.rofLayout) return;
      doughLayout = b.dataset.rofLayout;
      if (doughLayout === 'layers') rofMode = 'sheet'; // layers are Sheet & Trim only
      renderProcessSummary();
      if (rofStep === 'setup') renderTrayStepPanel();
    }));
  }
  // The rise estimate reads flour-based doughs; with no flour it falls back to a standard DOUGH rise, which is
  // wrong for a filling (egg / cheese / vegetables set and puff a little). So a flourless layer uses the
  // filling estimate from layers.js instead.
  function layerHMul(p) {
    const m = window.RofGame.estimateRise(p.ingredientRows.map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit })));
    return m.identified ? m.hMul : window.RofGame.layers.FILLING_H_MUL;
  }
  const hasFlour = (p) => window.RofGame ? window.RofGame.estimateRise(p.ingredientRows.map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit }))).identified : true;
  // Keeps layerOrder / layerCfg in step with the ticked processes: new ones go on top (in recipe order), each
  // with a fresh session copy of its own wastage and a density default (dough if flour is found, else filling).
  function syncLayers(procs) {
    const ids = procs.map(p => String(p.localId));
    layerOrder = layerOrder.filter(id => ids.includes(id)).concat(ids.filter(id => !layerOrder.includes(id)));
    const L = window.RofGame?.layers;
    procs.forEach(p => {
      const id = String(p.localId);
      if (layerCfg.has(id)) return;
      layerCfg.set(id, {
        density: hasFlour(p) ? (L ? L.DENSITY_DOUGH : 1.05) : (L ? L.DENSITY_FILLING : 1.0),
        prebake: false, fillKind: 'all', targetCm: '',
        wastes: p.wastes.map(w => ({ ...w, localId: ++_recipeRowLocalIdCounter })),
      });
    });
    return layerOrder.map(id => procs.find(p => String(p.localId) === id));
  }
  // One card per layer, bottom first: quantity, density (est., editable), its own wastage, and either
  // "Pre-bake alone first" (bottom) or how much goes in (above): all of it, or up to a height.
  function renderLayerSummary(procs) {
    const ordered = syncLayers(procs), n = ordered.length;
    summaryEl.innerHTML = `
      <div class="rof-layers" role="list" aria-label="Layers, top first, as they sit in the tray">
        ${ordered.map((p, i) => [p, i]).reverse().map(([p, i]) => {
          const id = String(p.localId), c = layerCfg.get(id);
          const pos = i === 0 ? 'bottom' : i === n - 1 ? 'top' : '';
          return `
          <div class="rof-layer" role="listitem" data-layer="${id}">
            <div class="rof-layer-head">
              <span class="rof-layer-num" aria-hidden="true">${i + 1}</span>
              <strong dir="auto">${escHtml(p.name || '(untitled process)')}</strong>
              ${pos ? `<span class="rof-layer-pos">${pos}</span>` : ''}
              <span class="rof-layer-qty">${roundNice(sumIngredientQuantities(p.ingredientRows))} g</span>
              <button type="button" class="icon-btn" data-layer-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escHtml(p.name || 'layer')} down" title="Move down">↓</button>
              <button type="button" class="icon-btn" data-layer-move="1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${escHtml(p.name || 'layer')} up" title="Move up">↑</button>
            </div>
            <div class="rof-layer-line">
              <label class="rof-layer-density">Density <input type="number" min="0.1" max="3" step="0.01" value="${c.density}" data-layer-density aria-label="Density of ${escHtml(p.name || 'this layer')}, g per cm³" /> g/cm³ <span class="rof-layer-est">est.</span></label>
              ${i === 0
                ? `<label class="rof-layer-check"><input type="checkbox" data-layer-prebake ${c.prebake ? 'checked' : ''} /> Pre-bake alone first</label>`
                : `<span class="rof-layer-fill">
                     <span class="mode-toggle rof-mini-toggle" role="group" aria-label="How much of ${escHtml(p.name || 'this layer')} goes in">
                       <button type="button" class="mode-toggle-btn ${c.fillKind === 'height' ? '' : 'active'}" data-layer-fill="all" aria-pressed="${c.fillKind !== 'height'}">All of it</button>
                       <button type="button" class="mode-toggle-btn ${c.fillKind === 'height' ? 'active' : ''}" data-layer-fill="height" aria-pressed="${c.fillKind === 'height'}">Up to a height</button>
                     </span>
                     ${c.fillKind === 'height' ? `<input type="number" min="0.1" step="0.1" value="${c.targetCm}" data-layer-target class="rof-layer-target" aria-label="Height from the tray floor, cm" placeholder="cm" /> cm` : ''}
                   </span>`}
              <details class="rof-waste-details rof-layer-wastes">
                <summary>Wastage (${c.wastes.length || 'none'})</summary>
                <div data-layer-waste-rows></div>
                <select class="builder-select" data-layer-add-waste style="margin-top:6px; max-width:220px; font-size:12px;"><option value="">+ Add Waste…</option></select>
              </details>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    wireLayoutToggle();
    summaryEl.querySelectorAll('.rof-layer').forEach(card => {
      const id = card.dataset.layer, c = layerCfg.get(id);
      card.querySelectorAll('[data-layer-move]').forEach(b => b.addEventListener('click', () => {
        const i = layerOrder.indexOf(id), j = i + Number(b.dataset.layerMove);
        if (j < 0 || j >= layerOrder.length) return;
        [layerOrder[i], layerOrder[j]] = [layerOrder[j], layerOrder[i]];
        renderLayerSummary(selectedProcesses());
        const same = summaryEl.querySelector(`[data-layer="${id}"] [data-layer-move="${b.dataset.layerMove}"]`);
        (same && !same.disabled ? same : summaryEl.querySelector(`[data-layer="${id}"] [data-layer-move="${-Number(b.dataset.layerMove)}"]`))?.focus();
      }));
      card.querySelector('[data-layer-density]').addEventListener('input', (e) => { c.density = e.target.value; updateLayerPlan(); });
      card.querySelector('[data-layer-prebake]')?.addEventListener('change', (e) => { c.prebake = e.target.checked; updateLayerPlan(); });
      card.querySelectorAll('[data-layer-fill]').forEach(b => b.addEventListener('click', () => {
        if (c.fillKind === b.dataset.layerFill) return;
        c.fillKind = b.dataset.layerFill;
        renderLayerSummary(selectedProcesses());
        summaryEl.querySelector(`[data-layer="${id}"] ${c.fillKind === 'height' ? '[data-layer-target]' : `[data-layer-fill="all"]`}`)?.focus();
      }));
      card.querySelector('[data-layer-target]')?.addEventListener('input', (e) => { c.targetCm = e.target.value; updateLayerPlan(); });
      renderLayerWasteRows(card, c);
    });
    updateSetupPreview();
  }
  // A layer's own wastage rows: edit the %, remove, or add one from the catalog -- session-only, like the
  // mixed dough's (renderWasteRowsFor); the recipe itself is never changed.
  function renderLayerWasteRows(card, c) {
    const rowsEl = card.querySelector('[data-layer-waste-rows]');
    const summary = card.querySelector('.rof-layer-wastes summary');
    if (summary) summary.textContent = `Wastage (${c.wastes.length || 'none'})`;
    rowsEl.innerHTML = c.wastes.length
      ? c.wastes.map(w => `
        <div class="rof-waste-row">
          <span class="rof-waste-name">${escHtml(w.name || 'Waste')}</span>
          <input type="number" min="0" max="100" step="0.1" value="${w.percent ?? 0}" class="process-waste-percent" data-lw-input="${w.localId}" aria-label="${escHtml(w.name || 'Waste')} %" />
          <button type="button" class="icon-btn danger" data-lw-remove="${w.localId}" title="Remove for this tray session only">✕</button>
          <span class="rof-waste-note">${w.originalPercent != null ? `% (recipe default: ${w.originalPercent}%)` : '% (added this session)'}</span>
        </div>`).join('')
      : '<div style="font-size:12px; color:var(--neutral);">None applied.</div>';
    rowsEl.querySelectorAll('[data-lw-input]').forEach(input => input.addEventListener('input', () => {
      const w = c.wastes.find(x => x.localId === Number(input.dataset.lwInput));
      if (w) w.percent = input.value;
      updateLayerPlan();
    }));
    rowsEl.querySelectorAll('[data-lw-remove]').forEach(btn => btn.addEventListener('click', () => {
      c.wastes = c.wastes.filter(x => x.localId !== Number(btn.dataset.lwRemove));
      renderLayerWasteRows(card, c);
      updateLayerPlan();
    }));
    const sel = card.querySelector('[data-layer-add-waste]');
    wasteTypesPromise.then((types) => {
      if (!sel.isConnected) return;
      sel.innerHTML = '<option value="">+ Add Waste…</option>' + types.filter(t => !c.wastes.some(w => w.wasteTypeId === t.id))
        .map(t => `<option value="${t.id}">${escHtml(t.name)} (${t.default_percent}%)</option>`).join('');
      sel.onchange = () => {
        const t = types.find(x => String(x.id) === sel.value);
        sel.value = '';
        if (!t) return;
        c.wastes.push({ localId: ++_recipeRowLocalIdCounter, wasteTypeId: t.id, name: t.name, percent: t.default_percent });
        renderLayerWasteRows(card, c);
        updateLayerPlan();
      };
    });
  }

  // The plan under the tray picker: trays in the batch, then per layer what goes in each tray and to what
  // height, what's left unused (or short), the assembled height and the estimated height after baking.
  function updateLayerPlan() {
    const el = document.getElementById('rof-fill-summary');
    if (!el || !layersActive()) return;
    const material = bakeSnapshot?.material, fp = bakeSnapshot?.footprint;
    if (!material || !fp) { el.innerHTML = ''; layerPlan = null; return; }
    if (material.shape_type === 'muffin_tray') {
      layerPlan = null;
      el.innerHTML = '<div class="computed-value-box rof-layer-plan"><div class="rof-leftover">Layers need a sheet tray -- a muffin tray has a portion per cup already.</div></div>';
      return;
    }
    const procs = syncLayers(selectedProcesses());
    const L = window.RofGame.layers, P = window.RofGame.portions;
    const base = procs[0];
    const baseFillWeight = base.materialId != null && String(base.materialId) === String(material.id) ? Number(base.materialFillWeightGrams) || null : null;
    const baseFillElsewhere = !baseFillWeight && base.materialId != null && Number(base.materialFillWeightGrams) > 0;
    layerPlan = L.planLayers({
      tray: { areaCm2: fp.areaCm2, usableHeightCm: fp.usableHeightCm },
      trays: { fillWeightGrams: baseFillWeight, manualCount: layerTraysManual },
      layers: procs.map((p, i) => {
        const c = layerCfg.get(String(p.localId));
        return {
          key: String(p.localId), name: p.name || '(untitled process)',
          totalGrams: sumIngredientQuantities(p.ingredientRows), wastes: c.wastes, density: parseFloat(c.density),
          prebake: i === 0 && c.prebake,
          fill: i === 0 || c.fillKind !== 'height' ? { kind: 'all' } : { kind: 'height', targetCm: parseFloat(c.targetCm) },
          hMul: layerHMul(p),
        };
      }),
    });
    const plan = layerPlan, g = (v) => `${P.fmtGrams(v)} g`, cm = (v) => `${Math.round(v * 100) / 100} cm`;
    if (!el.querySelector('#rof-layer-trays')) {
      el.innerHTML = `
        <div class="computed-value-box rof-layer-plan">
          <div class="rof-layer-trays"><label for="rof-layer-trays">Trays</label>
            <input id="rof-layer-trays" type="number" min="1" step="1" />
            <span id="rof-layer-trays-src"></span></div>
          <div id="rof-layer-plan-body" role="status" aria-live="polite"></div>
        </div>`;
      el.querySelector('#rof-layer-trays').addEventListener('input', (e) => {
        const v = Math.floor(Number(e.target.value));
        layerTraysManual = v >= 1 ? v : null;
        updateLayerPlan();
      });
    }
    const traysIn = el.querySelector('#rof-layer-trays');
    if (document.activeElement !== traysIn) traysIn.value = plan.ok || plan.trays ? plan.trays : '';
    const auto = L.trayCount({ baseRawGrams: plan.layers[0]?.availableRawTotal || 0, fillWeightGrams: baseFillWeight });
    el.querySelector('#rof-layer-trays-src').textContent = plan.traySource === 'manual'
      ? (auto.source === 'fillWeight' ? `your count (Fill Weight gives ${auto.count}; clear to use it)` : 'your count')
      : plan.traySource === 'fillWeight' ? `from ${escHtml(base.name || 'the bottom layer')}'s Fill Weight, ${g(baseFillWeight)} per tray`
      : baseFillElsewhere ? `no Fill Weight for this tray (the recipe's is for another tray) -- type a count` : 'no Fill Weight saved -- type a count';
    const body = el.querySelector('#rof-layer-plan-body');
    if (!plan.ok) {
      body.innerHTML = plan.errors.map(e => `<div class="rof-leftover">${escHtml(e)}</div>`).join('');
      syncLayerContinue();
      return;
    }
    const n = plan.trays;
    body.innerHTML = `
      ${plan.layers.map(r => {
        const heightTxt = r.prebake
          ? `${cm(r.rawHeightCm)} raw, pre-baked to ${cm(r.assemblyHeightCm)} ${r.measured ? '(measured)' : '<span class="rof-layer-est">est.</span>'}`
          : `${cm(r.bottomCm)} → ${cm(r.topCm)}`;
        let use = '';
        if (r.fill.kind === 'height' && r.index > 0) {
          use = r.shortTotal > 0
            ? `<div class="rof-leftover rof-layer-note">Short by ${g(r.shortTotal)}: the recipe has ${g(r.availableRawTotal)} for ${g(r.neededTotal)} needed. ${n === 1
                ? `All of it reaches ${cm(r.heightIfAllUsedCm)}.`
                : `It fills ${r.fullTraysAtTarget} of ${n} trays to ${cm(r.targetCm)}, or all ${n} to ${cm(r.heightIfAllUsedCm)}.`}</div>`
            : r.notUsedTotal > 0
              ? `<div class="rof-layer-note">Not used on ${n === 1 ? 'this tray' : `these ${n} trays`}: <strong>${g(r.notUsedTotal)}</strong> of ${g(r.availableRawTotal)} &middot; all of it would reach ${cm(r.heightIfAllUsedCm)}</div>`
              : '';
        }
        return `<div class="rof-layer-row"><strong dir="auto">${escHtml(r.name)}</strong> ${g(r.rawPerTray)} per tray &middot; ${heightTxt}</div>${use}`;
      }).join('')}
      <div class="rof-layer-total">Assembled <strong>${cm(plan.assembledHeightCm)}</strong> &middot; after the final bake about ${cm(plan.finalHeightEstCm)} <span class="rof-layer-est">est.</span></div>
      <div class="rof-layer-row">Per tray ${g(plan.rawPerTrayGrams)} raw → ${g(plan.finishedPerTrayGrams)} after Baking Waste</div>
      ${plan.warnings.filter(w => !/short by/.test(w)).map(w => `<div class="rof-leftover rof-layer-note">${escHtml(w)}</div>`).join('')}`;
    syncLayerContinue();
  }
  // Phase L1: the plan is all there is. Baking a layered tray (pre-bake, fill, bake, trim) is the next phases'.
  function syncLayerContinue() {
    const btn = document.getElementById('rof-continue-btn');
    if (!btn || !layersActive()) return;
    btn.disabled = true;
    btn.title = 'Baking a layered tray is not built yet -- this plan shows the numbers.';
  }

  // Rebuilds the combined waste rows -- called on structural change only (initial summary render,
  // a Remove click, or a fresh "+ Add Waste..." pick, all here). A plain % edit never calls this,
  // only refreshComputedNumbers, so the input the chef is actively typing into is never torn down
  // mid-edit.
  function renderWasteRowsFor() {
    const el = document.getElementById('rof-wastes-combined');
    if (!el) return;
    const countEl = document.getElementById('rof-waste-count');
    if (countEl) countEl.textContent = combinedWastes.length > 0 ? `(${combinedWastes.length})` : '(none)';
    el.innerHTML = combinedWastes.length > 0
      ? combinedWastes.map(w => `
        <div class="rof-waste-row">
          <span class="rof-waste-name">${w.name || 'Waste'}</span>
          <input type="number" min="0" max="100" step="0.1" value="${w.percent ?? 0}" class="process-waste-percent" data-rof-waste-input="${w.localId}" />
          <button type="button" class="icon-btn danger" data-rof-waste-remove="${w.localId}" title="Remove for this tray session only">✕</button>
          <span class="rof-waste-note">${w.originalPercent != null ? `% (recipe default: ${w.originalPercent}%)` : '% (added this session)'}</span>
        </div>
      `).join('')
      : `<div style="font-size:12px; color:var(--neutral);">None applied.</div>`;

    el.querySelectorAll('[data-rof-waste-input]').forEach(input => {
      input.addEventListener('input', () => {
        const localId = parseInt(input.dataset.rofWasteInput, 10);
        const w = combinedWastes.find(w => w.localId === localId);
        if (w) w.percent = input.value;
        refreshComputedNumbers();
      });
    });
    el.querySelectorAll('[data-rof-waste-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const localId = parseInt(btn.dataset.rofWasteRemove, 10);
        combinedWastes = combinedWastes.filter(w => w.localId !== localId);
        renderWasteRowsFor();
        refreshComputedNumbers();
      });
    });

    populateAddWasteSelect();
  }

  // Populates the combined "+ Add Waste..." select -- same reuse-the-catalog dropdown pattern as
  // Recipe Book/Recipe Extractor's process form (see renderProcessWastes), but deliberately NOT
  // that same function: this view has no Save at all (see renderProcessSummary's own comment
  // above), so picking a type here only pushes a session-only row onto combinedWastes -- it never
  // calls addWasteType/updateWasteType and skips "+ Create new waste type..." entirely, since
  // creating a brand-new catalog entry is a real, permanent write this view should never make on
  // the chef's behalf just to run one tray calculation.
  // Reassigned (not addEventListener) every call -- selectEl persists across a rows-only refresh
  // (it lives outside the #rof-wastes-combined div this rebuilds), so this avoids stacking
  // duplicate handlers the same way renderProcessWastes' own select does.
  async function populateAddWasteSelect() {
    const selectEl = document.querySelector('[data-rof-add-waste="combined"]');
    if (!selectEl) return;
    const wasteTypes = await wasteTypesPromise;
    // Re-check after the await -- the chef may have unchecked every process (or picked a
    // different recipe entirely) while the catalog fetch was in flight.
    if (!document.querySelector('[data-rof-add-waste="combined"]')) return;

    const availableTypes = wasteTypes.filter(wt => !combinedWastes.some(w => w.wasteTypeId === wt.id));
    selectEl.innerHTML = `<option value="">+ Add Waste…</option>` +
      availableTypes.map(wt => `<option value="${wt.id}">${wt.name} (${wt.default_percent}%)</option>`).join('');
    selectEl.value = '';
    selectEl.onchange = () => {
      const rawValue = selectEl.value;
      selectEl.value = ''; // always reset immediately, same as renderProcessWastes' own select
      if (!rawValue) return;
      const wasteTypeId = parseInt(rawValue, 10);
      const wt = wasteTypes.find(w => w.id === wasteTypeId);
      if (!wt) return;
      // No originalPercent -- this row has no "recipe default" to show or diff against (unlike
      // rows seeded from buildProcessFromSaved), it exists only for this tray session.
      combinedWastes.push({ localId: ++_recipeRowLocalIdCounter, wasteTypeId: wt.id, name: wt.name, percent: wt.default_percent });
      renderWasteRowsFor();
      refreshComputedNumbers();
    };
  }

  // Writes only the numeric spans (each process's own raw Total Quantity, the combined total, and
  // the single combined Net Weight) and refreshes the fill preview -- never touches the waste
  // input rows themselves, see renderWasteRowsFor's own comment on why that split matters.
  function refreshComputedNumbers() {
    const procs = selectedProcesses();
    procs.forEach(p => {
      const totalEl = document.getElementById(`rof-total-${p.localId}`);
      if (totalEl) totalEl.textContent = roundNice(sumIngredientQuantities(p.ingredientRows));
    });
    const combinedTotalEl = document.getElementById('rof-combined-total');
    if (combinedTotalEl) combinedTotalEl.textContent = combinedTotalQuantity(procs);
    const netEl = document.getElementById('rof-net-combined');
    if (netEl) netEl.textContent = compoundWasteYield(combinedTotalQuantity(procs), combinedWastes);
    updateSetupPreview();
  }

  // Setup-step only -- draws the tray to scale on the 2D canvas and computes this tray's own Net
  // Weight into `bakeSnapshot`. Density and fill-height are GONE (confirmed with the chef): they
  // only ever existed to drive the old 3D fill mesh, which no longer exists -- what replaces "how
  // much dough fits" is the Dough step's own placed-count-vs-Net-Weight check (see
  // updateDoughPlacementSummary), not anything computed here. Fresh document.getElementById
  // lookups (not hoisted consts) since #rof-material-select only exists while rofStep === 'setup'.
  // A no-op (via the early `if (rofStep !== 'setup') return`) is deliberately safe to call from
  // refreshComputedNumbers regardless of which step is active.
  function updateSetupPreview() {
    if (rofStep !== 'setup') return;
    const materialSelect = document.getElementById('rof-material-select');
    const fillSummaryEl = document.getElementById('rof-fill-summary');
    const continueBtn = document.getElementById('rof-continue-btn');
    if (!materialSelect || !fillSummaryEl) return;

    const procs = selectedProcesses();
    const material = trayMaterials.find(m => String(m.id) === String(materialSelect.value));
    if (procs.length === 0 || !material) {
      bakeSnapshot = null;
      previewEmptyEl.style.display = '';
      fillSummaryEl.innerHTML = '';
      if (continueBtn) continueBtn.disabled = true;
      syncPreviewMode();
      return;
    }

    const dims = materialDimsFromRow(material);
    const footprint = trayInteriorFootprint(material.shape_type, dims);
    if (!footprint) {
      bakeSnapshot = null;
      previewEmptyEl.textContent = 'This tray is missing some dimensions.';
      previewEmptyEl.style.display = '';
      fillSummaryEl.innerHTML = '';
      if (continueBtn) continueBtn.disabled = true;
      syncPreviewMode();
      return;
    }
    previewEmptyEl.style.display = 'none';

    const netWeight = compoundWasteYield(combinedTotalQuantity(procs), combinedWastes);
    bakeSnapshot = { material, dims, footprint, netWeight };
    if (layersActive()) {
      updateLayerPlan(); // the layer plan fills #rof-fill-summary; Continue waits (see syncLayerContinue)
    } else {
      fillSummaryEl.innerHTML = ''; // Net Weight is already shown in the summary above
      if (continueBtn) { continueBtn.disabled = false; continueBtn.title = ''; }
    }
    // A muffin tray has a portion per cup already, so there is no sheet to trim.
    const sheetBtn = document.querySelector('#rof-mode-toggle [data-rof-mode="sheet"]');
    if (sheetBtn) {
      const muffin = material.shape_type === 'muffin_tray';
      sheetBtn.disabled = muffin;
      sheetBtn.title = muffin ? 'Each cup is already a portion -- nothing to trim' : '';
      if (muffin && rofMode === 'sheet') {
        rofMode = 'shape';
        document.querySelectorAll('#rof-mode-toggle [data-rof-mode]').forEach(b => { b.classList.toggle('active', b.dataset.rofMode === 'shape'); b.setAttribute('aria-pressed', String(b.dataset.rofMode === 'shape')); });
        renderStepHeader();
      }
    }
    syncPreviewMode();
  }

  // Fresh document.getElementById lookups, same reasoning as updateSetupPreview above -- the
  // select this populates only exists while rofStep === 'setup', and this is itself async, so a
  // re-check after the await guards against the chef having moved past Setup (or unchecked every
  // process) while the materials list was still loading.
  async function populateMaterialSelect() {
    let materialSelect = document.getElementById('rof-material-select');
    if (!materialSelect) return;
    trayMaterials = (await materialsPromise).filter(m => m.category === 'tray_pan');
    materialSelect = document.getElementById('rof-material-select');
    if (!materialSelect) return;
    materialSelect.innerHTML = [
      `<option value="">— Select a tray —</option>`,
      ...trayMaterials.map(m => `<option value="${m.id}">${m.code} — ${m.name} (${formatMaterialDimensions(m)})</option>`),
      `<option value="${NEW_MATERIAL}">+ Create new tray…</option>`,
    ].join('');
    // Restore the chef's own last pick for this session (surviving a checkbox toggle or an
    // "<- Edit Setup" round-trip) before falling back to a linked process's own tray/pan (its own
    // recipe form's Material field, see buildProcessFromSaved) -- only when nothing's been picked
    // here yet, so toggling which processes are checked never clobbers a tray the chef already
    // chose by hand in this view.
    if (lastMaterialId && trayMaterials.some(m => String(m.id) === String(lastMaterialId))) {
      materialSelect.value = String(lastMaterialId);
    } else {
      const defaultId = selectedProcesses().map(p => p.materialId).find(id => id && trayMaterials.some(m => String(m.id) === String(id)));
      if (defaultId) materialSelect.value = String(defaultId);
    }
    lastMaterialId = materialSelect.value || lastMaterialId;
    updateSetupPreview();
  }

  // ---- Step header + per-step panel rendering --------------------------------------------------
  const ROF_STEP_LABELS_SHEET = [
    { key: 'setup', label: '1. Setup' },
    { key: 'bake', label: '2. Bake' },
    { key: 'trim', label: '3. Trim' },
  ];
  const ROF_STEP_LABELS_SHAPE = [
    { key: 'setup', label: '1. Setup' },
    { key: 'place', label: '2. Shape & Place' },
    { key: 'bake', label: '3. Bake' },
  ];
  const rofStepLabels = () => (rofMode === 'shape' ? ROF_STEP_LABELS_SHAPE : ROF_STEP_LABELS_SHEET);

  function renderStepHeader() {
    const stepsEl = document.getElementById('rof-steps');
    if (!stepsEl) return;
    stepsEl.setAttribute('role', 'list'); stepsEl.setAttribute('aria-label', 'Steps');
    // Each pill is a real button: clicking it jumps straight to that stage -- see navigateRofStep. The
    // current stage's own pill is inert (nothing to navigate to), and a stage not yet reached this
    // session is disabled (both visually, .disabled, and for real via the native `disabled` attribute)
    // rather than clickable-but-a-no-op, so "not set up yet" reads as unavailable, not broken.
    stepsEl.innerHTML = rofStepLabels().map((s) => {
      const active = s.key === rofStep, reached = reachedRofSteps.has(s.key);
      return `<span role="listitem"><button type="button" class="rof-step-pill ${active ? 'active' : ''} ${reached ? '' : 'disabled'}"
        data-rof-step="${s.key}" ${active ? 'aria-current="step"' : ''} ${reached ? '' : 'disabled'}>${s.label}</button></span>`;
    }).join('');
    stepsEl.querySelectorAll('[data-rof-step]').forEach((btn) => {
      btn.addEventListener('click', () => navigateRofStep(btn.dataset.rofStep));
    });
  }

  // Jumps directly to `target` from a step-pill click -- back to any stage already reached is always
  // allowed, forward only to one already reached (reachedRofSteps; renderStepHeader disables anything
  // else). Each branch replicates the EXACT transition that stage's own button already performs
  // (Edit Placement, Bake ->, Trim ->, <- Back to Bake) rather than a bare rofStep flip, so nothing
  // about entering that stage -- resetting the bake, recomputing the rise model, clearing cutters -- is
  // ever skipped just because it was reached by a pill click instead of the usual button.
  function navigateRofStep(target) {
    if (target === rofStep || !reachedRofSteps.has(target)) return;
    if (target === 'setup') { backToSetup(); return; }
    if (target === 'place') { // only reachable from 'bake', Shape & Place -- same as "<- Edit Placement"
      rofGame.resetBake();
      bakeState = 'ready';
      goToRofStep('place');
      placeFresh = false;
      renderTrayStepPanel();
      return;
    }
    if (target === 'bake') {
      if (rofStep === 'trim') { // backward, Sheet & Trim -- same as "<- Back to Bake"
        rofGame.disarmCutter(); rofGame.clearCutters();
        goToRofStep('bake'); bakeState = 'done';
        renderTrayStepPanel();
        return;
      }
      enterBakeStep(); // forward from 'place', Shape & Place -- same as "Bake ->"
      return;
    }
    if (target === 'trim') { goToRofStep('trim'); renderTrayStepPanel(); } // forward from 'bake' -- same as "Trim ->"
  }

  function renderTrayStepPanel() {
    if (rofGame) rofGame.hidePortion({ quiet: true });
    renderStepHeader();
    const panel = document.getElementById('rof-step-panel');
    if (!panel) return;
    const stepLabel = (rofStepLabels().find(x => x.key === rofStep) || {}).label || '';
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', stepLabel.replace(/^\d+\.\s*/, ''));
    if (rofStep === 'setup') renderSetupPanel(panel);
    else if (rofStep === 'place') renderPlaceStepPanel(panel);
    else if (rofStep === 'bake') renderBakeStepPanel(panel);
    else if (rofStep === 'trim') renderTrimStepPanel(panel);
    syncPreviewMode();
    syncRecipeBlock();
  }

  function renderSetupPanel(panel) {
    panel.innerHTML = `
      <div class="generate-controls" style="margin-bottom:12px;">
        <div class="field" style="max-width:none;">
          <label>Tray / Pan</label>
          <select id="rof-material-select" class="builder-select">
            <option value="">— Select a tray —</option>
          </select>
        </div>
      </div>
      <div id="rof-fill-summary"></div>
      <div class="field" style="margin-bottom:12px;">
        <label>Method</label>
        <div class="mode-toggle" id="rof-mode-toggle" role="group" aria-label="Method">
          <button type="button" class="mode-toggle-btn ${rofMode === 'shape' ? 'active' : ''}" data-rof-mode="shape" aria-pressed="${rofMode === 'shape'}">Shape &amp; Place</button>
          <button type="button" class="mode-toggle-btn ${rofMode === 'sheet' ? 'active' : ''}" data-rof-mode="sheet" aria-pressed="${rofMode === 'sheet'}">Sheet &amp; Trim</button>
        </div>
        <div id="rof-mode-hint" style="font-size:12px; color:var(--neutral); margin-top:6px;"></div>
      </div>
      <button type="button" class="primary" id="rof-continue-btn" style="margin-top:4px;" disabled>Continue →</button>
    `;
    const hintEl = document.getElementById('rof-mode-hint');
    const layered = layersActive();
    if (layered) {
      // Layers are Sheet & Trim only (for now): the toggle has one answer, so it gives way to a line saying so.
      rofMode = 'sheet';
      const toggle = document.getElementById('rof-mode-toggle');
      toggle.hidden = true;
      toggle.closest('.field').querySelector('label').textContent = 'Method: Sheet & Trim';
    }
    if (layered) hintEl.hidden = true; // "Method: Sheet & Trim" says it
    const showModeHint = () => {
      hintEl.textContent = rofMode === 'shape'
          ? 'Pieces placed by hand, baked as placed.'
          : 'One sheet, baked whole, then cut into portions.';
    };
    showModeHint();
    panel.querySelectorAll('[data-rof-mode]').forEach(btn => btn.addEventListener('click', () => {
      rofMode = btn.dataset.rofMode;
      panel.querySelectorAll('[data-rof-mode]').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
      showModeHint();
      renderStepHeader();
    }));
    document.getElementById('rof-material-select').addEventListener('change', (e) => {
      if (e.target.value === NEW_MATERIAL) { createTrayInline(e.target); return; }
      lastMaterialId = e.target.value || null;
      updateSetupPreview();
    });
    document.getElementById('rof-continue-btn').addEventListener('click', () => (rofMode === 'shape' ? startPlacementFlow() : startSheetFlow()));
    reloadMaterials();
    populateMaterialSelect();
  }

  // "+ Create new tray…": the dropdown goes back to what it showed (the option never stays picked), the
  // Materials dialog opens with Category fixed to Tray / Pan, and a saved tray becomes the chosen one.
  async function createTrayInline(select) {
    select.value = lastMaterialId && trayMaterials.some(m => String(m.id) === String(lastMaterialId)) ? String(lastMaterialId) : '';
    const res = await openMaterialCreateModal({ category: 'tray_pan' });
    if (!res) return;
    if (res.materials) materialsPromise = Promise.resolve(res.materials); else reloadMaterials();
    lastMaterialId = String(res.id);
    await populateMaterialSelect(); // selects lastMaterialId and redraws the tray preview
  }

  // Back to Setup from anywhere in a session (drops the pieces / sheet / cutters, keeps the tray).
  function backToSetup() {
    resetGameSession();
    rofStep = 'setup';
    reachedRofSteps = new Set(['setup']);
    bakeSnapshot = null;
    renderTrayStepPanel();
  }

  // The recipe card collapses to a one-line strip (with a Change button) as soon as a recipe is picked,
  // and after Setup the process/wastage block collapses into that strip too -- so the controls for the
  // current step sit beside the stage instead of below a stack of setup cards.
  const RECIPE_SOURCE_LABELS = { book: 'Recipe Book', extractor: 'Recipe Extractor', generated: 'Recipe Generator' };
  function syncRecipeBlock() {
    const haveRecipe = !!selectedRecipe && workingProcesses.length > 0;
    const inSetup = rofStep === 'setup';
    const collapseCard = haveRecipe && (!inSetup ? !!bakeSnapshot : !recipeEditing);
    recipeCardEl.style.display = collapseCard ? 'none' : '';
    recipeCompactEl.style.display = collapseCard ? '' : 'none';
    setupBlockEl.style.display = inSetup || !bakeSnapshot ? '' : 'none';
    if (!collapseCard) return;
    const procs = selectedProcesses();
    const detail = inSetup || !bakeSnapshot
      ? RECIPE_SOURCE_LABELS[source]
      : `${procs.map(p => p.name || '(untitled process)').join(' + ')} &middot; Net ${roundNice(bakeSnapshot.netWeight)} g`;
    recipeCompactEl.innerHTML = `
      <div class="rof-compact-text"><strong>${selectedRecipe.name}</strong><span>${detail}</span></div>
      <button type="button" class="secondary" id="rof-compact-change">Change</button>`;
    document.getElementById('rof-compact-change').addEventListener('click', () => {
      recipeEditing = true;
      if (rofStep !== 'setup') backToSetup();
      else syncRecipeBlock();
    });
  }

  // ---- Shape & Place (game view) ------------------------------------------------------------------
  // The shape presets: rows from the database when the shapes migration has been applied (then they can be
  // edited in the Shapes modal), otherwise the four built into the game (read-only).
  let shapePresets = null, shapesEditable = false, shapesPromise = null;
  const shapeFromRow = (r) => ({
    key: `db-${r.id}`, id: r.id, label: r.name, archetype: r.archetype,
    lengthCm: Number(r.length_cm), widthCm: Number(r.width_cm), heightCm: Number(r.height_cm),
    taper: Number(r.taper ?? 0), score: r.score_count || 0, weight: Number(r.unit_weight_grams),
  });
  function ensureShapePresets(force = false) {
    if (force) shapesPromise = null;
    if (!shapesPromise) {
      shapesPromise = (async () => {
        let res = null;
        try { res = await window.api.listDoughShapePresets(); } catch (err) { console.error('[shape presets]', err); }
        if (res && res.available) { shapesEditable = true; shapePresets = res.shapes.map(shapeFromRow); }
        else { shapesEditable = false; shapePresets = Object.values((window.RofGame && window.RofGame.shapes) || {}); }
        if (!shapePresets.some(sh => sh.key === placeShapeKey)) placeShapeKey = shapePresets[0] ? shapePresets[0].key : null;
        return shapePresets;
      })();
    }
    return shapesPromise;
  }
  const placeShapes = () => shapePresets || Object.values((window.RofGame && window.RofGame.shapes) || {});
  const currentShape = () => placeShapes().find(sh => sh.key === placeShapeKey) || null;
  const isMuffinTray = () => !!bakeSnapshot && bakeSnapshot.material.shape_type === 'muffin_tray';

  async function startPlacementFlow() {
    await ensureShapePresets();
    goToRofStep('place');
    placeFresh = true;
    placeSession = null;
    placeCount = null;
    placeNote = '';
    renderTrayStepPanel();
  }

  // Lays the dough out on the bench as `placeCount` equal pieces. Piece size follows its weight (the
  // cube root, since a piece scales in all three directions), so dividing into fewer pieces makes
  // each one bigger. A muffin tray overrides both: one piece per cup.
  const portionCups = () => (isMuffinTray() ? bakeSnapshot.dims.cupRows * bakeSnapshot.dims.cupColumns : 0);
  // The plan for the current dough: portion weight (the chef's, else the recipe's, else the shape's) -> whole
  // portions -> exactly what is left over. A muffin tray is one portion per cup.
  function currentPortionPlan(gramsOverride) {
    const P = window.RofGame.portions, shape = currentShape();
    const grams = gramsOverride ?? placeGrams ?? P.defaultGrams({ recipePortionGrams, shapeWeight: shape && shape.weight });
    return P.planPortions({ net: bakeSnapshot.netWeight, grams, cups: portionCups() });
  }

  // Lays the dough out on the bench as whole portions of the chosen weight. A piece's size follows its weight
  // (the cube root, since it scales in every direction); a muffin tray overrides both: one piece per cup.
  async function startPlacementSession() {
    const game = await ensureRofGame();
    // A muffin tray sizes its own pieces (one per cup), so it only needs a stand-in here.
    const shape = currentShape() || (isMuffinTray() ? { archetype: 'ball', lengthCm: 9.5, widthCm: 9.5, heightCm: 4.6, weight: 90 } : null);
    if (!shape) return null; // no shapes defined yet -- the panel says so
    const plan = currentPortionPlan();
    riseModel = computeRiseModel(); // how much room the dough will need once it has risen
    if (plan.count < 1) {          // nothing to lay out (portion bigger than the dough, or not a valid weight)
      game.endPlacement(); game.clearItems();
      placeSession = { count: 0, shape, grams: plan.grams, leftover: plan.leftover, plan };
      placeNote = '';
      return null;
    }
    const k = Math.min(1.9, Math.max(0.55, Math.cbrt(plan.grams / shape.weight)));
    const spec = { ...shape, lengthCm: shape.lengthCm * k, widthCm: shape.widthCm * k, heightCm: shape.heightCm * k };
    const used = game.beginPlacement({ spec, count: plan.count, spread: riseModel.wMul });
    placeSession = { count: used.count, shape, spec: used.spec, grams: plan.grams, leftover: plan.leftover, plan };
    placeCount = used.count;
    placeNote = '';
    return used;
  }

  // The line under the portion inputs: how many whole portions, and -- in red -- exactly what is not used.
  function portionLineHtml(plan) {
    const P = window.RofGame.portions, net = bakeSnapshot.netWeight;
    if (plan.invalid) return `<span class="rof-leftover">Enter a portion weight of at least ${P.MIN_GRAMS} g.</span>`;
    if (plan.tooBig) return `<span class="rof-leftover">${P.fmtGrams(plan.grams)} g is more than the ${P.fmtGrams(net)} g of dough -- not even one whole portion.</span>`;
    const left = plan.leftover > 0
      ? ` <span class="rof-leftover">${P.fmtGrams(plan.leftover)} g not used</span>`
      : ' <span class="rof-noleft">No dough left over</span>';
    const cap = plan.capped ? `<div class="rof-leftover" style="margin-top:2px;">Capped at ${P.MAX_PIECES} pieces (${plan.wanted} would fit by weight).</div>` : '';
    return `<strong>${plan.count}</strong> whole portion${plan.count === 1 ? '' : 's'} &times; ${P.fmtGrams(plan.grams)} g${left}${cap}`;
  }
  function refreshPortionLine(plan) {
    const el = document.getElementById('rof-portion-line');
    if (el && bakeSnapshot) el.innerHTML = portionLineHtml(plan);
  }
  // Fill the inputs from the session (not while the chef is typing in them).
  function refreshPortionUi() {
    if (!placeSession || !bakeSnapshot) return;
    const P = window.RofGame.portions;
    const input = document.getElementById('rof-grams-input');
    if (input && document.activeElement !== input) input.value = P.fmtGrams(placeSession.grams);
    refreshPortionLine(currentPortionPlan());
    const hint = document.getElementById('rof-portion-hint');
    if (hint) {
      const shape = currentShape();
      hint.textContent = placeGramsUser ? 'Set by you.'
        : recipePortionGrams ? `Starts from the recipe's portion weight (${P.fmtGrams(recipePortionGrams)} g).`
        : shape ? `Starts from the ${shape.label} shape's weight.` : '';
    }
  }

  function updatePlaceSummary(state) {
    const el = document.getElementById('rof-place-summary');
    if (!el || !placeSession || !bakeSnapshot) return;
    const { placed, total } = state || rofGame.getPlacement();
    if (placeSession.count === 0) {
      el.innerHTML = '';
      const b0 = document.getElementById('rof-bake-btn'); if (b0) b0.disabled = true;
      const c0 = document.getElementById('rof-count-val'); if (c0) c0.textContent = '0';
      return;
    }
    const net = bakeSnapshot.netWeight, unit = placeSession.grams;
    const bakeBtn = document.getElementById('rof-bake-btn');
    if (bakeBtn) bakeBtn.disabled = placed === 0;
    const status = placeNote || (placed === 0 ? 'Nothing placed yet.'
      : placed < total ? `${total - placed} piece(s) still on the bench.` : 'Everything is on the tray.');
    const countEl = document.getElementById('rof-count-val');
    if (countEl) countEl.textContent = total;
    const left = placeSession.leftover > 0
      ? `<div class="rof-leftover" style="margin-top:4px; font-size:12.5px;">${window.RofGame.portions.fmtGrams(placeSession.leftover)} g of dough not used (left over after whole portions).</div>` : '';
    el.innerHTML = `
      <div class="computed-value-box" style="margin:12px 0;">
        <div><strong>${placed}</strong> of ${total} pieces placed &nbsp;·&nbsp; <strong>${roundNice(placed * unit)} g</strong> of ${roundNice(net)} g</div>
        <div style="margin-top:4px; color:${placeNote ? 'var(--danger, #c0392b)' : 'var(--neutral)'}; font-size:12.5px;">${status}</div>${left}
      </div>`;
  }

  function renderPlaceStepPanel(panel) {
    const muffin = isMuffinTray();
    panel.innerHTML = `
      <div style="font-size:12.5px; color:var(--neutral); margin-bottom:8px;">Drag pieces onto the tray. Scroll turns a held piece; right-drag turns the view.</div>
      ${muffin ? `<div style="font-size:12.5px; margin-bottom:8px;" id="rof-muffin-note"></div>` : `
        <div class="rof-shape-row">
          <label for="rof-shape-select">Shape</label>
          <select id="rof-shape-select" class="builder-select" ${placeShapes().length === 0 ? 'disabled' : ''}>
            ${placeShapes().length === 0 ? '<option>No shapes yet -- add one</option>' : placeShapes().map(sh => `<option value="${sh.key}" ${sh.key === placeShapeKey ? 'selected' : ''}>${sh.label} — ${sh.weight} g · ${sh.lengthCm} cm</option>`).join('')}
          </select>
          <button type="button" class="rof-link-btn" id="rof-edit-shapes-btn">Edit…</button>
        </div>
        <div class="rof-portion">
          <div class="rof-portion-input">
            <label for="rof-grams-input">Portion weight</label>
            <input id="rof-grams-input" type="number" min="${window.RofGame.portions.MIN_GRAMS}" step="1" inputmode="decimal" aria-describedby="rof-portion-line rof-portion-hint" />
            <span>g</span>
          </div>
          <div class="rof-count-row">
            <label>Pieces</label>
            <button type="button" class="secondary" id="rof-count-minus" aria-label="Fewer pieces (heavier portions)">−</button>
            <span id="rof-count-val" style="min-width:26px; text-align:center; font-weight:600;"></span>
            <button type="button" class="secondary" id="rof-count-plus" aria-label="More pieces (lighter portions)">+</button>
          </div>
          <div id="rof-portion-line" class="rof-portion-line"></div>
          <div id="rof-portion-hint" class="rof-portion-hint"></div>
        </div>`}
      <div style="display:flex; gap:8px; margin-bottom:4px;">
        <button type="button" class="secondary" id="rof-auto-btn">Auto-arrange</button>
        <button type="button" class="secondary" id="rof-return-btn">Return all</button>
      </div>
      <div id="rof-place-summary"></div>
      <div class="rof-actions">
        <button type="button" class="secondary" id="rof-edit-setup-btn">← Edit Setup</button>
        <button type="button" class="primary" id="rof-bake-btn" disabled>Bake →</button>
      </div>
    `;

    const restart = async () => { await startPlacementSession(); refreshPortionUi(); updatePlaceSummary(); };
    const confirmReset = () => !rofGame || rofGame.getPlacement().placed === 0 || confirm('Changing this puts every placed piece back on the bench.');
    const shapeSelect = document.getElementById('rof-shape-select');
    if (shapeSelect) shapeSelect.addEventListener('change', async () => {
      if (shapeSelect.value === placeShapeKey) return;
      if (!confirmReset()) { shapeSelect.value = placeShapeKey; return; }
      placeShapeKey = shapeSelect.value; placeCount = null;
      if (!placeGramsUser) placeGrams = null; // an untouched default follows the shape; the chef's own weight is kept
      await restart();
      const sh = currentShape();
      if (sh) rofGame.announce(`${sh.label} chosen.`);
    });
    // The stepper sets the portion weight that divides the dough into exactly that many pieces (kept exact,
    // not rounded, so it really gives that count with nothing left over).
    let pendingCount = null; // the count the last click asked for, so a quick double-click steps twice
    const step = async (d) => {
      if (!placeSession || !confirmReset()) return;
      const P = window.RofGame.portions;
      const count = Math.min(P.MAX_PIECES, Math.max(1, (pendingCount ?? placeSession.count) + d));
      pendingCount = count;
      placeGrams = P.gramsForCount(bakeSnapshot.netWeight, count); placeGramsUser = true;
      await restart();
      if (pendingCount === count) pendingCount = null;
      rofGame.announce(`${count} pieces of ${P.fmtGrams(placeGrams)} grams.`);
    };
    const gramsInput = document.getElementById('rof-grams-input');
    if (gramsInput) {
      // Typing previews the count and leftover straight away; the pieces on the stage only change on commit
      // (Enter / leaving the field), because that puts everything back on the bench.
      gramsInput.addEventListener('input', () => {
        const g = parseFloat(gramsInput.value);
        refreshPortionLine(currentPortionPlan(Number.isFinite(g) ? g : NaN));
      });
      gramsInput.addEventListener('change', async () => {
        const g = parseFloat(gramsInput.value), P = window.RofGame.portions;
        if (!(g >= P.MIN_GRAMS)) { gramsInput.value = P.fmtGrams(placeSession ? placeSession.grams : 0); refreshPortionUi(); return; }
        if (placeSession && Math.abs(g - placeSession.grams) < 0.05) { refreshPortionUi(); return; }
        if (!confirmReset()) { gramsInput.value = P.fmtGrams(placeSession.grams); refreshPortionUi(); return; }
        placeGrams = g; placeGramsUser = true;
        await restart();
        const plan = currentPortionPlan();
        rofGame.announce(plan.count < 1 ? 'Not even one whole portion.' : `${plan.count} whole portions of ${P.fmtGrams(g)} grams.${plan.leftover > 0 ? ` ${P.fmtGrams(plan.leftover)} grams not used.` : ''}`);
      });
    }
    document.getElementById('rof-count-minus')?.addEventListener('click', () => step(-1));
    document.getElementById('rof-count-plus')?.addEventListener('click', () => step(1));
    document.getElementById('rof-edit-shapes-btn')?.addEventListener('click', async () => {
      if (!shapesEditable) {
        alert('Editing shapes needs a database update that has not been applied yet (supabase/migrations/20260920100000_dough_shape_presets.sql). The built-in shapes still work.');
        return;
      }
      const before = currentShape();
      if (!(await openShapesModal())) return;
      await ensureShapePresets(true);
      const after = currentShape();
      // Keep the session if the shape being used is untouched; otherwise start over on the bench.
      if (!(before && after && JSON.stringify(before) === JSON.stringify(after))) { placeFresh = true; placeCount = null; if (!placeGramsUser) placeGrams = null; }
      renderTrayStepPanel();
    });
    document.getElementById('rof-auto-btn').addEventListener('click', () => {
      const before = rofGame.getPlacement();
      rofGame.autoArrange();
      const after = rofGame.getPlacement();
      placeNote = after.placed < after.total
        ? `Only ${after.placed} of ${after.total} fit on this tray -- use fewer or smaller pieces, or a bigger tray.` : '';
      updatePlaceSummary(after);
    });
    document.getElementById('rof-return-btn').addEventListener('click', () => { placeNote = ''; rofGame.returnAllToBench(); });
    document.getElementById('rof-edit-setup-btn').addEventListener('click', backToSetup);
    document.getElementById('rof-bake-btn').addEventListener('click', enterBakeStep);

    if (placeFresh || !placeSession) {
      placeFresh = false;
      ensureRofGame().then(() => restart()).then(() => {
        const note = document.getElementById('rof-muffin-note');
        if (note && placeSession) note.textContent = `${placeSession.count} cups -- ${roundNice(bakeSnapshot.netWeight / placeSession.count)} g per piece.`;
      });
    } else {
      updatePlaceSummary();
    }
  }

  // ---- Bake (both methods) -------------------------------------------------------------------------

  // ---- Oven temperature and bake time (session-only; printed on the PDF) ------------------------------
  const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const methodTextOfSelected = () => selectedProcesses().map(p => collectTextListFieldValue(p, makeProcessMethodCfg(p))).filter(Boolean).join('\n');
  function prefillBakeParams() {
    if (bakeParams.touched) return; // the chef's own entry is never overwritten
    const r = window.RofGame.parseBakeParams(methodTextOfSelected());
    bakeParams = {
      temp: r.temp ? r.temp.value : '', unit: r.temp ? r.temp.unit : 'C', time: r.time ? r.time.value : '',
      source: r.temp || r.time ? 'method' : '', confirmed: !(r.temp || r.time), snippet: r.snippet || '', touched: false,
    };
  }
  const bakeTempText = () => (bakeParams.temp ? `${bakeParams.temp} °${bakeParams.unit}` : '');
  const bakeTimeText = () => (bakeParams.time ? `${bakeParams.time} min` : '');
  function bakeHintHtml() {
    const bp = bakeParams;
    if (bp.source === 'method' && !bp.confirmed) {
      return `<span class="rof-snippet" dir="auto" title="${escHtml(bp.snippet)}">Read from the method: ${escHtml(bp.snippet)}</span><button type="button" class="rof-link-btn" id="rof-bake-confirm">Looks right</button>`;
    }
    if (bp.source === 'method') return 'Read from the method, confirmed.';
    if (bp.temp || bp.time) return '';
    return 'Not in the method -- fill in to print them on the PDF.';
  }
  function bakeParamsHtml() {
    return `
      <div class="rof-row-field rof-bake-params">
        <label for="rof-bake-temp">Oven</label>
        <div class="rof-row-ctl rof-bake-row">
          <input id="rof-bake-temp" type="text" inputmode="decimal" autocomplete="off" placeholder="180" maxlength="4" value="${escHtml(bakeParams.temp)}" aria-label="Oven temperature" />
          <select id="rof-bake-unit" aria-label="Temperature unit"><option value="C" ${bakeParams.unit === 'C' ? 'selected' : ''}>°C</option><option value="F" ${bakeParams.unit === 'F' ? 'selected' : ''}>°F</option></select>
          <span class="rof-bake-sep">for</span>
          <input id="rof-bake-time" type="text" inputmode="decimal" autocomplete="off" placeholder="20–25" maxlength="8" value="${escHtml(bakeParams.time)}" aria-label="Bake time in minutes" />
          <span class="rof-bake-sep">min</span>
        </div>
      </div>
      <div class="rof-bake-hint" id="rof-bake-hint" role="status">${bakeHintHtml()}</div>`;
  }
  function wireBakeParams(panel) {
    const temp = panel.querySelector('#rof-bake-temp'), unit = panel.querySelector('#rof-bake-unit'), time = panel.querySelector('#rof-bake-time');
    if (!temp) return;
    const hint = () => {
      const el = document.getElementById('rof-bake-hint');
      if (!el) return;
      el.innerHTML = bakeHintHtml();
      document.getElementById('rof-bake-confirm')?.addEventListener('click', confirmBake);
    };
    const confirmBake = () => { bakeParams.confirmed = true; hint(); };
    const edited = () => { bakeParams.touched = true; bakeParams.source = 'chef'; bakeParams.confirmed = true; hint(); };
    temp.addEventListener('input', () => { temp.value = temp.value.replace(/[^\d.]/g, ''); bakeParams.temp = temp.value; edited(); });
    unit.addEventListener('change', () => { bakeParams.unit = unit.value; edited(); });
    time.addEventListener('input', () => { time.value = time.value.replace(/[^\d.\-–—]/g, '').replace(/[-—]/g, '–'); bakeParams.time = time.value; edited(); });
    document.getElementById('rof-bake-confirm')?.addEventListener('click', confirmBake);
  }

  // The deterministic rise model reads the checked processes' ingredient rows (no AI call).
  function computeRiseModel() {
    const rows = selectedProcesses().flatMap(p => p.ingredientRows).map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit }));
    return window.RofGame.estimateRise(rows);
  }
  // The model scaled by the chef's correction -- what the bake actually uses.
  const effectiveRiseModel = () => ({ ...riseModel, hMul: riseModel.hMul * riseScale, wMul: riseModel.wMul * riseScale });

  function enterBakeStep() {
    riseModel = computeRiseModel();
    prefillBakeParams();
    bakeState = 'ready';
    goToRofStep('bake');
    renderTrayStepPanel();
  }
  async function startBake() {
    bakeState = 'baking';
    renderTrayStepPanel();
    playIgniteSound();
    bakeCtl = rofGame.playBake({ doneness: bakeDoneness, model: effectiveRiseModel(), onProgress: updateBakeProgress });
    await bakeCtl.promise;
    bakeCtl = null;
    bakeState = 'done';
    lastAnnouncedPhase = null;
    rofGame.announce('Baked.');
    if (rofStep === 'bake') renderTrayStepPanel();
  }
  const BAKE_PHASE_LABEL = { proof: 'Proofing', oven: 'In the oven', out: 'Coming out' };
  let lastAnnouncedPhase = null;
  function updateBakeProgress({ phase, progress }) {
    const bar = document.getElementById('rof-bake-bar'), label = document.getElementById('rof-bake-phase');
    if (bar) { bar.style.width = `${Math.round(progress * 100)}%`; bar.parentElement.setAttribute('aria-valuenow', String(Math.round(progress * 100))); }
    if (label) label.textContent = BAKE_PHASE_LABEL[phase] || '';
    if (phase !== lastAnnouncedPhase) { lastAnnouncedPhase = phase; if (rofGame) rofGame.announce(BAKE_PHASE_LABEL[phase] || ''); }
  }


  // ---- One portion (the detail view, and the picture for the PDF) ----------------------------------
  // What one baked portion looks like and measures. Sizes that come from the rise model are marked `est`.
  const cmText = (v, est = false) => window.RofGame.fmtCm(v, est);
  const cmSpeech = (v) => `${Math.round(v * 10) / 10} centimetres`;
  // What a portion weighs, and what raw dough it took. The recipe's Net Weight is a FINISHED yield: every waste row, Baking Waste
  // included, is already taken off it, and Portion Weight / Portions Produced everywhere else in the app (Recipe Book, Calculator)
  // are finished weights too -- so a portion's weight here is a finished weight, and nothing further is deducted from it. The
  // raw dough it started from is that weight put back through the Baking Waste: portion / (1 - baking %). Every waste row named
  // like "baking" counts (they combine, each taking its % off what is left); a recipe without one has no baking loss to add back.
  function bakingLoss() {
    const rows = combinedWastes.filter(w => /baking/i.test(w.name || ''));
    if (rows.length === 0) return { found: false };
    const retention = rows.reduce((acc, w) => acc * (1 - Math.min(Math.max(parseFloat(w.percent) || 0, 0), 100) / 100), 1);
    return { found: true, retention, usable: retention > 0.001 };
  }
  // The two weight rows at the top of the portion card: finished weight, then raw dough before baking (or "no Baking Waste").
  function portionWeightRows(finishedGrams) {
    const P = window.RofGame.portions, b = bakingLoss();
    return [
      { key: 'weight', label: 'Portion weight (finished)', value: `${P.fmtGrams(finishedGrams)} g` },
      b.found && b.usable
        ? { key: 'raw', label: 'Raw dough before baking', value: `${P.fmtGrams(finishedGrams / b.retention)} g`, est: true }
        : { key: 'raw', label: 'Before baking', value: 'no Baking Waste' },
    ];
  }
  function trayCard(note) {
    const m = bakeSnapshot.material;
    return { name: m.name, dims: formatMaterialDimensions(m), note };
  }
  function portionDescShape() {
    if (!placeSession || !placeSession.spec || !bakeSnapshot || !rofGame) return null;
    const model = effectiveRiseModel(), P = window.RofGame.portions;
    const grams = isMuffinTray() ? bakeSnapshot.netWeight / placeSession.count : placeSession.grams;
    const desc = { kind: 'piece', spec: placeSession.spec, hMul: model.hMul, wMul: model.wMul, doneness: bakeDoneness, brownSpeed: model.brownSpeed };
    const m = window.RofGame.measurePortion(desc), raw = m.raw;
    const rows = portionWeightRows(grams);
    if (m.round) rows.push({ label: 'Diameter', value: cmText(m.lengthCm, true), est: true });
    else rows.push({ label: 'Length', value: cmText(m.lengthCm, true), est: true }, { label: 'Width', value: cmText(m.widthCm, true), est: true });
    rows.push({ label: 'Height', value: cmText(m.heightCm, true), est: true });
    rows.push({ label: 'Before rising', value: m.round ? `⌀ ${roundNice(raw.lengthCm)} × ${roundNice(raw.heightCm)} cm` : `${roundNice(raw.lengthCm)} × ${roundNice(raw.widthCm)} × ${roundNice(raw.heightCm)} cm` });
    const pl = rofGame.getPlacement();
    const name = placeSession.shape.label || placeSession.shape.name || 'Piece';
    return {
      ...desc, measures: m, weightGrams: grams, title: 'One portion', subtitle: `${name} · ${doneLabelOf(bakeDoneness)}`, rows,
      tray: trayCard(`${pl.placed} of ${pl.total} pieces on the tray`),
      footnote: 'est. = from the rise estimate, not measured.',
      speech: `One portion, ${name}. ${P.fmtGrams(grams)} grams finished. About ${cmSpeech(m.lengthCm)} ${m.round ? 'across' : 'long'}${m.round ? '' : `, ${cmSpeech(m.widthCm)} wide`}, ${cmSpeech(m.heightCm)} tall, estimated.`,
    };
  }
  // What a group of cut pieces is called: the cutter's catalog name, or "Knife cut" for a knife grid.
  const cutName = (key) => (String(key) === 'knife' ? 'Knife cut' : (cutterMaterials.find(c => String(c.id) === String(key)) || {}).name || 'Cutter');
  // Whether the cut is final enough for One portion / Export PDF: any cutter placed, or a knife grid that was Cut.
  const cutsReady = () => cutterList.length > 0 && (trimMode !== 'knife' || !!knifeSpec?.cut);
  const notReadyText = () => (trimMode === 'knife' ? 'Cut the tray first' : 'Place a cutter first');
  function cutGroups() {
    const groups = new Map();
    for (const c of cutterList) {
      const g = groups.get(c.data.materialId) || { key: String(c.data.materialId), data: c.data, n: 0 };
      g.n++; groups.set(c.data.materialId, g);
    }
    return [...groups.values()];
  }
  // One piece cut by a cutter of this shape from the current sheet: its measured sizes and finished grams
  // (its share of the tray's area, of the grams in this tray -- the sheet is uniform). Used by the portion
  // view and by the Trim panel's readout for the chosen cutter, before any is placed.
  function cutPortionFor(shapeType, dims) {
    const model = effectiveRiseModel(), fp = bakeSnapshot.footprint;
    const thicknessCm = sheetInfo.sessionGrams / (fp.areaCm2 * RAW_DOUGH_DENSITY);
    const desc = { kind: 'cut', shapeType, dims, thicknessCm, hMul: model.hMul, doneness: bakeDoneness, brownSpeed: model.brownSpeed };
    const m = window.RofGame.measurePortion(desc);
    return { desc, m, grams: (m.areaCm2 / fp.areaCm2) * sheetInfo.sessionGrams };
  }
  function portionDescSheet(key) {
    if (!bakeSnapshot || !sheetInfo || !rofGame || cutterList.length === 0) return null;
    const groups = cutGroups();
    const g = groups.find(x => x.key === String(key)) || groups.find(x => x.key === String(lastCutterId)) || groups.sort((a, b) => b.n - a.n)[0];
    const P = window.RofGame.portions;
    const { desc, m, grams } = cutPortionFor(g.data.shapeType, g.data.dims);
    const rows = portionWeightRows(grams);
    if (g.data.shapeType === 'round') rows.push({ label: 'Diameter', value: cmText(m.diameterCm) });
    else if (g.data.shapeType === 'rectangular') rows.push({ label: 'Length', value: cmText(m.lengthCm) }, { label: 'Width', value: cmText(m.widthCm) });
    else rows.push({ label: 'Base', value: cmText(m.baseCm) }, { label: 'Height', value: cmText(m.triHeightCm) });
    rows.push({ label: 'Thickness', value: cmText(m.heightCm, true), est: true });
    rows.push({ label: 'Before rising', value: `${Math.round(m.rawHeightCm * 100) / 10} mm` });
    rows.push({ label: 'Area', value: `${roundNice(m.areaCm2)} cm²` });
    const choices = groups.length > 1 ? groups.map(x => ({ key: x.key, label: cutName(x.key) })) : null;
    const name = cutName(g.key);
    return {
      ...desc, measures: m, weightGrams: grams, title: 'One portion', subtitle: `${name} · ${doneLabelOf(bakeDoneness)}`, rows,
      tray: trayCard(`${g.n} of ${cutterList.length} pieces cut`),
      choices, chosen: g.key, onChoose: (k) => openPortionView(k),
      footnote: 'est. = from the rise estimate, not measured.',
      speech: `One portion, ${name}. ${P.fmtGrams(grams)} grams finished, ${cutterPieceSizeLabel(g.data.shapeType, g.data.dims)}, about ${cmSpeech(m.heightCm)} thick, estimated.`,
    };
  }
  const doneLabelOf = (d) => ({ light: 'Light', golden: 'Golden', dark: 'Dark' }[d] || 'Golden');
  const portionDesc = (key) => (rofMode === 'sheet' ? portionDescSheet(key) : portionDescShape());
  function openPortionView(key) {
    const desc = portionDesc(key);
    if (desc) rofGame.showPortion(desc);
  }
  function togglePortionView() {
    if (!rofGame) return;
    if (rofGame.isPortionOpen()) rofGame.hidePortion(); else openPortionView();
  }
  function syncPortionBtn(open) {
    const b = document.getElementById('rof-portion-btn');
    if (!b) return;
    b.textContent = open ? 'Back to tray' : 'One portion';
    b.setAttribute('aria-pressed', String(!!open));
  }
  function wirePortionBtn() {
    const b = document.getElementById('rof-portion-btn');
    if (b) b.addEventListener('click', togglePortionView);
  }


  // ---- Export PDF -----------------------------------------------------------------------------------
  // One A4 page: the recipe and dough, the tray, the shape or cutters, one portion (with its picture), the waste
  // figures and the bake settings. Built from what is on screen right now; nothing is read from or written to the
  // database. main.js prints it (see lib/recipePdf.js).
  const wasteIdx = (re) => combinedWastes.findIndex(w => re.test(w.name || ''));
  function buildPdfData() {
    const P = window.RofGame.portions, sheetMode = rofMode === 'sheet';
    const g = (n) => `${P.fmtGrams(n)} g`;
    const procs = selectedProcesses();
    const total = combinedTotalQuantity(procs), wf = computeWasteWaterfall(total, combinedWastes), net = bakeSnapshot.netWeight;
    const pctOf = (w) => { const v = parseFloat(w.percent); return isNaN(v) ? 0 : v; };
    const fmtPct = (v) => `${Math.round(v * 10) / 10}%`;
    const desc = portionDesc();
    if (!desc) throw new Error(sheetMode ? `${notReadyText()}.` : 'Nothing to print yet.');

    // Dough and wastage: every waste on the recipe, each against the running total just before it.
    const dough = [{ label: 'Process', value: procs.map(p => p.name || '(untitled process)').join(' + ') }, { label: 'Total quantity', value: g(total) }];
    combinedWastes.forEach((w, i) => dough.push({ label: `${w.name || 'Waste'} (${fmtPct(pctOf(w))} of ${g(wf[i].before)})`, value: `−${g(wf[i].reduced)}` }));
    if (combinedWastes.length === 0) dough.push({ label: 'Wastage', value: 'none applied' });
    dough.push({ label: 'Net weight', value: g(net) });

    const m = bakeSnapshot.material, fp = bakeSnapshot.footprint;
    const tray = [{ label: 'Tray', value: m.name }, { label: 'Size', value: formatMaterialDimensions(m) }];
    if (fp && fp.areaCm2) tray.push({ label: 'Interior area', value: `${Math.round(fp.areaCm2)} cm²` });
    if (fp && fp.usableHeightCm) tray.push({ label: 'Usable height', value: `${roundNice(fp.usableHeightCm)} cm` });

    // What is being made.
    let make;
    if (sheetMode) {
      const groups = cutGroups();
      const thick = sheetInfo.sessionGrams / (fp.areaCm2 * RAW_DOUGH_DENSITY);
      make = { title: trimMode === 'knife' ? 'Sheet & knife cuts' : 'Sheet & cutters', rows: [
        { label: 'Net Weight on this tray', value: g(sheetInfo.sessionGrams), note: sheetInfo.sessions > 1 ? `This batch needs ${sheetInfo.sessions} trays; the figures below are for one.` : '' },
        { label: 'Sheet thickness', value: `${Math.round(thick * 100) / 10} mm`, note: `about ${window.RofGame.fmtCm(desc.measures.heightCm, true)} once baked (est.)` },
        ...groups.map(x => {
          const area = cutterUnitAreaCm2(x.data.shapeType, x.data.dims);
          return { label: `${x.n} × ${cutName(x.key)}`, value: `${g((area / fp.areaCm2) * sheetInfo.sessionGrams)} each`, note: cutterPieceSizeLabel(x.data.shapeType, x.data.dims) };
        }),
        { label: 'Pieces cut', value: String(cutterList.length) },
        { label: 'Tray used by pieces', value: `${Math.round((trimScrap().covered / fp.areaCm2) * 100)}%` },
      ] };
    } else {
      const s = placeSession, raw = desc.spec, pl = rofGame.getPlacement();
      make = { title: 'Shape & pieces', rows: [
        { label: 'Shape', value: s.shape.label || s.shape.name || 'Piece' },
        { label: 'Size before rising', value: `${roundNice(raw.lengthCm)} × ${roundNice(raw.widthCm)} × ${roundNice(raw.heightCm)} cm` },
        { label: 'Portion weight (finished)', value: g(desc.weightGrams) },
        { label: 'Pieces on the tray', value: `${pl.placed} of ${pl.total}` },
        ...(s.leftover > 0 && !isMuffinTray() ? [{ label: 'Dough not used', value: g(s.leftover), emphasis: true, note: 'left over after whole portions' }] : []),
      ] };
    }

    // One portion: its finished weight (from the recipe's Net Weight -- nothing further is deducted) and the raw dough it took, which
    // is that weight put back through the recipe's Baking Waste. See bakingLoss.
    const bl = bakingLoss(), bi = wasteIdx(/baking/i);
    const portionRows = desc.rows.filter(r => r.label !== 'Before rising' || !sheetMode).map(r => {
      if (r.key === 'weight') return { label: 'Portion weight (finished, from Net Weight)', value: r.value };
      if (r.key === 'raw') {
        return bl.found && bl.usable
          ? { label: 'Raw dough before baking', value: r.value, est: true, note: `portion weight ÷ (1 − ${fmtPct((1 - bl.retention) * 100)} Baking Waste)` }
          : { label: 'Raw dough before baking', value: 'not applicable', note: bl.found ? 'Baking Waste leaves nothing to work from' : 'No Baking Waste in this recipe' };
      }
      return { ...r };
    });

    // Waste: the recipe's own figures, and (Sheet & Trim) the scrap measured from the cutter layout -- each with its own base.
    const waste = [];
    waste.push(bi >= 0
      ? { label: 'Baking Waste (recipe)', value: `${fmtPct(pctOf(combinedWastes[bi]))} · ${g(wf[bi].reduced)}`, note: `of the ${g(wf[bi].before)} running total in the recipe` }
      : { label: 'Baking Waste (recipe)', value: 'not in this recipe' });
    let wasteNote = '';
    if (sheetMode) {
      const ti = wasteIdx(/trim/i), sc = trimScrap();
      waste.push(ti >= 0
        ? { label: 'Trimming Waste, planned (recipe)', value: `${fmtPct(pctOf(combinedWastes[ti]))} · ${g(wf[ti].reduced)}`, note: `of the ${g(wf[ti].before)} running total in the recipe` }
        : { label: 'Trimming Waste, planned (recipe)', value: 'not in this recipe' });
      waste.push({ label: 'Scrap, measured (cutter layout)', value: `${g(sc.grams)} · ${fmtPct(sc.pct)}`, emphasis: true, note: `of the ${g(sheetInfo.sessionGrams)} of dough on this tray` });
      wasteNote = 'Planned and measured are different figures with different bases; they are shown side by side, never combined.';
    }

    const baking = [
      { label: 'Oven', value: bakeTempText() || 'not set' }, { label: 'Time', value: bakeTimeText() || 'not set' },
      { label: 'Doneness', value: doneLabelOf(bakeDoneness) },
    ];
    const bakeNote = bakeParams.source === 'method' && !bakeParams.confirmed ? 'Oven and time were read from the recipe method and have not been confirmed.' : '';

    const cap = rofGame.capturePortion(desc);
    return {
      title: selectedRecipe.name, subtitle: `${procs.map(p => p.name || '(untitled process)').join(' + ')} · ${sheetMode ? 'Sheet & Trim' : 'Shape & Place'}`,
      dateText: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      image: cap ? { dataUrl: cap.dataUrl } : null,
      sections: [
        { title: 'Dough', rows: dough }, { title: 'Tray', rows: tray },
        make, { title: 'One portion', rows: portionRows },
        { title: 'Waste', rows: waste, note: wasteNote }, { title: 'Baking', rows: baking, note: bakeNote },
      ],
      footnotes: [
        'est. = estimated from the rise model, not measured.',
        'Portion weights are finished weights: the recipe’s Net Weight already has its wastes, Baking Waste included, taken off. Raw dough before baking is the portion weight put back through the Baking Waste.',
        'Generated by Menu Board · Recipe on Fire.',
      ],
    };
  }
  async function exportRofPdf() {
    const btn = document.getElementById('rof-export-pdf-btn'), status = document.getElementById('rof-export-status');
    if (!btn || btn.disabled) return;
    const say = (t, title = '') => { if (status) { status.textContent = t; status.title = title; } };
    btn.disabled = true; say('Preparing the PDF…');
    try {
      const data = buildPdfData();
      const r = await window.api.exportRecipePdf({ data, suggestedName: `${selectedRecipe.name} - Recipe on Fire` });
      if (r && r.cancelled) say('');
      else { say(`Saved ${String(r.path).split(/[\\/]/).pop()}`, r.path); rofGame.announce('PDF saved.'); }
    } catch (err) {
      say(`Could not export the PDF: ${err.message}`);
    } finally {
      btn.disabled = rofMode === 'sheet' && !cutsReady();
    }
  }

  // ---- Sheet & Trim: the dough as one sheet ------------------------------------------------------
  const RAW_DOUGH_DENSITY = 1.05; // g/cm3, raw dough
  function computeSheetInfo() {
    const { footprint, netWeight } = bakeSnapshot;
    const area = footprint.areaCm2, usable = footprint.usableHeightCm;
    const thicknessCm = netWeight / (area * RAW_DOUGH_DENSITY);
    // A tray is "full" at about 70% of its rim height, which leaves the sheet room to rise.
    const capacityGrams = area * usable * 0.7 * RAW_DOUGH_DENSITY;
    return {
      thicknessCm, capacityGrams,
      sessionGrams: Math.min(netWeight, capacityGrams),
      sessions: Math.max(1, Math.ceil(netWeight / capacityGrams)),
      renderThickness: Math.max(0.3, Math.min(thicknessCm, usable * 0.7)),
    };
  }
  function startSheetFlow() {
    riseModel = computeRiseModel();
    prefillBakeParams();
    sheetInfo = computeSheetInfo();
    cutterList = []; armedCutterId = null; lastCutterId = null; trimNote = '';
    bakeState = 'ready';
    goToRofStep('bake');
    renderTrayStepPanel();
    ensureRofGame().then((game) => {
      if (rofStep === 'bake' && rofMode === 'sheet') { game.beginSheet({ thicknessCm: sheetInfo.renderThickness }); game.setSheetGrams(sheetInfo.sessionGrams); }
    });
  }
  function sheetSummaryHtml() {
    if (!sheetInfo) return '';
    const over = sheetInfo.sessions > 1;
    return `
      <div class="computed-value-box" style="margin:12px 0;">
        <div><strong>${roundNice(bakeSnapshot.netWeight)} g</strong> of dough &middot; sheet ${roundNice(sheetInfo.thicknessCm * 10)} mm thick</div>
        <div style="margin-top:4px; font-size:12.5px; color:${over ? 'var(--danger, #c0392b)' : 'var(--neutral)'};">${over
          ? `This tray holds about ${roundNice(sheetInfo.capacityGrams)} g -- this batch needs ${sheetInfo.sessions} trays. The rest of this screen works on one tray of ${roundNice(sheetInfo.sessionGrams)} g.`
          : `Fits in one tray (it holds about ${roundNice(sheetInfo.capacityGrams)} g).`}</div>
      </div>`;
  }

  function renderBakeStepPanel(panel) {
    const sheetMode = rofMode === 'sheet';
    const doneLabel = { light: 'Light', golden: 'Golden', dark: 'Dark' }[bakeDoneness];
    if (bakeState === 'baking') {
      panel.innerHTML = `
        <h3 style="margin-bottom:10px;">Baking…</h3>
        <div class="rof-progress" role="progressbar" aria-label="Bake progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="rof-bake-progress"><div class="rof-progress-fill" id="rof-bake-bar"></div></div>
        <div id="rof-bake-phase" style="font-size:12.5px; color:var(--neutral); margin:6px 0 14px;">Proofing</div>
        <button type="button" class="secondary" id="rof-skip-bake-btn">Skip</button>`;
      document.getElementById('rof-skip-bake-btn').addEventListener('click', () => bakeCtl && bakeCtl.skip());
      return;
    }
    const ready = bakeState === 'ready';
    panel.innerHTML = `
      ${ready ? '' : `<h3 style="margin-bottom:8px;">Baked · ${doneLabel}</h3>`}
      ${ready ? `<ul class="rof-rise-notes">${(riseModel?.notes || []).map(n => `<li>${n}</li>`).join('')}</ul>
      <div class="rof-row-field">
        <label for="rof-rise-slider">Rise <span id="rof-rise-val">${Math.round(riseScale * 100)}%</span></label>
        <div class="rof-row-ctl"><input type="range" id="rof-rise-slider" min="30" max="160" step="5" value="${Math.round(riseScale * 100)}" aria-describedby="rof-rise-hint" /><button type="button" class="rof-link-btn" id="rof-rise-reset" ${riseScale === 1 ? 'hidden' : ''}>Reset</button></div>
      </div>
      <div id="rof-rise-hint" class="rof-rise-hint"></div>
      <div class="rof-row-field">
        <label id="rof-doneness-label">Doneness</label>
        <div class="mode-toggle" id="rof-doneness-toggle" role="group" aria-labelledby="rof-doneness-label">
          ${['light', 'golden', 'dark'].map(d => `<button type="button" class="mode-toggle-btn ${d === bakeDoneness ? 'active' : ''}" data-doneness="${d}" aria-pressed="${d === bakeDoneness}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}
        </div>
      </div>` : ''}
      ${bakeParamsHtml()}
      <div id="rof-place-summary">${sheetMode ? sheetSummaryHtml() : ''}</div>
      ${ready || sheetMode ? '' : '<div class="rof-export-status" id="rof-export-status" role="status"></div>'}
      <div class="rof-actions">
        <button type="button" class="secondary" id="rof-edit-place-btn">${sheetMode ? '← Edit Setup' : '← Edit Placement'}</button>
        ${ready ? '<button type="button" class="primary" id="rof-start-bake-btn">Start baking</button>'
                : `<button type="button" class="secondary" id="rof-bake-again-btn">Bake again</button>
                   ${sheetMode ? '<button type="button" class="primary" id="rof-trim-btn">Trim →</button>'
                               : '<button type="button" class="secondary" id="rof-portion-btn" aria-pressed="false">One portion</button><button type="button" class="secondary" id="rof-export-pdf-btn">Export PDF</button>'}`}
      </div>`;
    panel.querySelectorAll('[data-doneness]').forEach(btn => btn.addEventListener('click', () => {
      bakeDoneness = btn.dataset.doneness;
      panel.querySelectorAll('[data-doneness]').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
    }));
    // Manual correction of the rise estimate (the model matches ingredient NAMES, so it can be wrong).
    const slider = document.getElementById('rof-rise-slider');
    if (slider) {
      const hint = document.getElementById('rof-rise-hint');
      const refresh = () => {
        document.getElementById('rof-rise-val').textContent = `${Math.round(riseScale * 100)}%`;
        slider.setAttribute('aria-valuetext', `${Math.round(riseScale * 100)} percent of the estimated rise`);
        document.getElementById('rof-rise-reset').hidden = riseScale === 1;
        hint.textContent = riseScale === 1 ? ''
          : rofMode === 'shape' && riseScale > 1.02 ? 'More than the room reserved on the tray -- pieces may touch.' : 'Adjusted by hand.';
        hint.hidden = riseScale === 1;
      };
      refresh();
      slider.addEventListener('input', () => { riseScale = slider.value / 100; refresh(); });
      document.getElementById('rof-rise-reset').addEventListener('click', () => { riseScale = 1; slider.value = 100; refresh(); });
    }
    document.getElementById('rof-edit-place-btn').addEventListener('click', () => {
      if (sheetMode) { backToSetup(); return; }
      rofGame.resetBake();
      bakeState = 'ready';
      goToRofStep('place');
      placeFresh = false;
      renderTrayStepPanel();
    });
    wirePortionBtn();
    wireBakeParams(panel);
    document.getElementById('rof-export-pdf-btn')?.addEventListener('click', exportRofPdf);
    document.getElementById('rof-start-bake-btn')?.addEventListener('click', startBake);
    document.getElementById('rof-bake-again-btn')?.addEventListener('click', () => {
      rofGame.resetBake();
      bakeState = 'ready';
      renderTrayStepPanel();
    });
    document.getElementById('rof-trim-btn')?.addEventListener('click', () => { goToRofStep('trim'); renderTrayStepPanel(); });
    if (!sheetMode) updatePlaceSummary();
  }

  // ---- Sheet & Trim: the Trim step -----------------------------------------------------------------
  async function ensureCutterMaterials() {
    cutterMaterials = (await materialsPromise).filter(m => m.category === 'cutter');
    return cutterMaterials;
  }
  // The chosen cutter is lastCutterId (kept after Escape puts it down, so the readout and Auto-arrange still
  // use it); armedCutterId is whether it is in hand right now for stamping.
  const chosenCutter = () => cutterMaterials.find(x => String(x.id) === String(lastCutterId)) || null;
  function syncCutterPicker() {
    const sel = document.getElementById('rof-cutter-select');
    if (sel) sel.value = chosenCutter() ? String(lastCutterId) : '';
    const hand = document.getElementById('rof-cutter-hand-btn');
    if (hand) {
      const on = armedCutterId != null;
      hand.disabled = !chosenCutter();
      hand.classList.toggle('active', on);
      hand.setAttribute('aria-pressed', String(on));
    }
    updateCutterInfo();
  }
  function armCutter(m, { focus = false } = {}) {
    lastCutterId = m.id;
    rofGame.armCutter({ shapeType: m.shape_type, dims: materialDimsFromRow(m), materialId: m.id });
    // From the button, focus moves to the stage so the arrow keys position the cutter and Enter stamps it.
    // Not from the dropdown: the arrow keys there are still choosing a cutter.
    if (focus) rofGame.focusStage();
    rofGame.announce(`${m.name} picked. Click the sheet to stamp it, or use Auto-arrange. Escape puts it down.`);
  }
  function onCutterSelect(id) {
    if (id === NEW_MATERIAL) { createCutterInline(); return; }
    const m = cutterMaterials.find(x => String(x.id) === String(id));
    if (!m) { lastCutterId = null; rofGame.disarmCutter(); syncCutterPicker(); return; }
    armCutter(m);
  }
  // The cutter dropdown's options: every cutter, then "+ Create new cutter…" (there even with no cutters yet).
  function fillCutterSelect() {
    const sel = document.getElementById('rof-cutter-select');
    if (!sel) return;
    sel.innerHTML = `<option value="">${cutterMaterials.length ? 'Choose a cutter…' : 'No cutters yet'}</option>`
      + cutterMaterials.map(m => `<option value="${m.id}">${escHtml(m.name)} (${cutterPieceSizeLabel(m.shape_type, materialDimsFromRow(m))})</option>`).join('')
      + `<option value="${NEW_MATERIAL}">+ Create new cutter…</option>`;
    sel.disabled = false;
  }
  // "+ Create new cutter…": the cutter in hand is put down, the dropdown goes back to the chosen cutter, and
  // the Materials dialog opens with Category fixed to Cutter. A saved cutter is chosen and in hand at once,
  // with its one-portion readout -- nothing to close or reopen.
  async function createCutterInline() {
    if (armedCutterId != null) rofGame.disarmCutter();
    syncCutterPicker(); // puts the dropdown back on the chosen cutter (or the placeholder)
    const res = await openMaterialCreateModal({ category: 'cutter' });
    if (!res) return;
    if (res.materials) materialsPromise = Promise.resolve(res.materials); else reloadMaterials();
    await ensureCutterMaterials();
    if (!document.getElementById('rof-cutter-select')) return; // left Trim meanwhile
    fillCutterSelect();
    const m = cutterMaterials.find(x => String(x.id) === String(res.id));
    if (m) armCutter(m); else syncCutterPicker();
  }
  function toggleCutterInHand() {
    const m = chosenCutter();
    if (!m) return;
    if (armedCutterId != null) rofGame.disarmCutter();
    else armCutter(m, { focus: true });
  }
  // What ONE piece from the chosen cutter would weigh, and how many Auto-arrange would cut, before anything
  // is placed -- so a cutter can be reconsidered before it goes across the tray. Same arithmetic as the
  // portion view (cutPortionFor, portionWeightRows) and the same packer as Auto-arrange (planCutters).
  function updateCutterInfo() {
    const el = document.getElementById('rof-cutter-info');
    if (!el || !bakeSnapshot || !sheetInfo) return;
    const c = chosenCutter();
    if (!c) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const P = window.RofGame.portions, dims = materialDimsFromRow(c), fp = bakeSnapshot.footprint;
    const { m, grams } = cutPortionFor(c.shape_type, dims);
    if (!(m.areaCm2 > 0)) { el.innerHTML = '<div class="rof-cutter-info-line">This cutter has no size set -- check it in Materials.</div>'; return; }
    const [weight, raw] = portionWeightRows(grams);
    const n = rofGame.planCutters({ shapeType: c.shape_type, dims, marginCm: TRIM_MARGIN_CM, gapCm: TRIM_GAP_CM });
    const scrapPct = fp.areaCm2 > 0 ? Math.max(0, 1 - (n * m.areaCm2) / fp.areaCm2) * 100 : 0;
    el.innerHTML = `
      <div class="rof-cutter-info-grams">One portion: <strong>${weight.value}</strong> finished &middot; ${raw.est ? `${raw.value} raw dough (est.)` : 'no Baking Waste'}</div>
      <div class="rof-cutter-info-line">${cutterPieceSizeLabel(c.shape_type, dims)} &middot; about ${cmText(m.heightCm, true)} thick (est.)</div>
      <div class="rof-cutter-info-line">${n > 0
        ? `Auto-arrange would cut <strong>${n}</strong> on this tray &middot; scrap about ${P.fmtGrams(scrapPct)}%`
        : '<span class="rof-leftover">Too big for this tray -- Auto-arrange would cut none.</span>'}</div>`;
  }

  // Per-piece weight, count, utilization and waste -- the same area math as before, driven by however
  // many cutters are on the sheet right now. A piece's share of the dough is its share of the tray's
  // area (the sheet is uniform), of the grams that fit in this one tray.
  // The scrap of the current layout: what no cutter covers, in grams and as a share of the dough on this tray
  // (the sheet is uniform, so area share = weight share).
  function trimScrap() {
    const { footprint } = bakeSnapshot, grams = sheetInfo.sessionGrams;
    const covered = cutterList.reduce((sum, c) => sum + cutterUnitAreaCm2(c.data.shapeType, c.data.dims), 0);
    const frac = footprint.areaCm2 > 0 ? Math.max(0, footprint.areaCm2 - covered) / footprint.areaCm2 : 0;
    return { grams: frac * grams, pct: frac * 100, covered };
  }
  function updateTrimSummary() {
    const el = document.getElementById('rof-trim-summary');
    if (!el || !bakeSnapshot || !sheetInfo) return;
    const ready = cutsReady();
    const pbtn = document.getElementById('rof-portion-btn');
    if (pbtn) { pbtn.disabled = !ready; pbtn.title = ready ? '' : notReadyText(); }
    const xbtn = document.getElementById('rof-export-pdf-btn');
    if (xbtn) { xbtn.disabled = !ready; xbtn.title = ready ? '' : notReadyText(); }
    if (trimMode === 'knife') updateKnifeInfo();
    const { footprint } = bakeSnapshot, grams = sheetInfo.sessionGrams;
    // Knife, not cut yet: the readout above already has every number; say the lines are only a preview.
    if (trimMode === 'knife') {
      // The readout above already has every number (portion, pieces, trim); this just says where things stand.
      const covered = trimScrap().covered;
      el.innerHTML = `<div class="computed-value-box" style="margin:10px 0;"><div style="color:var(--neutral); font-size:12.5px;">${ready
        ? `<strong style="color:var(--ink);">Cut:</strong> ${cutterList.length} pieces &middot; ${Math.round((covered / footprint.areaCm2) * 100)}% of the tray used`
        : 'Dotted lines are a preview: nothing is cut until you press Cut.'}</div></div>`;
      return;
    }
    if (cutterList.length === 0) {
      el.innerHTML = `<div class="computed-value-box" style="margin:12px 0;"><div style="color:var(--neutral); font-size:12.5px;">${trimNote || 'No cutters placed yet.'}</div></div>`;
      return;
    }
    const groups = new Map();
    let covered = 0;
    for (const c of cutterList) {
      const area = cutterUnitAreaCm2(c.data.shapeType, c.data.dims);
      covered += area;
      const key = c.data.materialId;
      const g = groups.get(key) || { data: c.data, area, n: 0 };
      g.n++; groups.set(key, g);
    }
    const util = footprint.areaCm2 > 0 ? Math.round((covered / footprint.areaCm2) * 100) : 0;
    const scrap = trimScrap();
    el.innerHTML = `
      <div class="computed-value-box" style="margin:12px 0;">
        ${[...groups.values()].map(g => `<div style="font-size:13px; margin-bottom:2px;"><strong>${g.n}</strong> × ${cutterPieceSizeLabel(g.data.shapeType, g.data.dims)} &middot; ${roundNice((g.area / footprint.areaCm2) * grams)} g each</div>`).join('')}
        <div style="margin-top:8px; padding-top:6px; border-top:1px solid var(--line); font-size:12px; color:var(--neutral);"><strong>${cutterList.length}</strong> pieces &nbsp;·&nbsp; <strong>${util}%</strong> utilization</div>
        <div class="rof-leftover" style="margin-top:4px; font-size:12.5px;">Scrap: ${window.RofGame.portions.fmtGrams(scrap.grams)} g &middot; ${window.RofGame.portions.fmtGrams(scrap.pct)}% of the dough on this tray</div>
      </div>`;
  }

  // Auto-arrange: the packer (renderer/rof/packing.js) alternates up / down triangles the way a baker cuts them and
  // tests every cutter exactly against the tray. 0.3 cm clear of the tray wall, 0.2 cm between cutters.
  const TRIM_MARGIN_CM = 0.3, TRIM_GAP_CM = 0.2;
  function autoArrangeCutters() {
    const m = cutterMaterials.find(x => String(x.id) === String(armedCutterId ?? lastCutterId));
    if (!m) { trimNote = 'Choose a cutter first.'; updateTrimSummary(); return; }
    const res = rofGame.autoArrangeCutters({ shapeType: m.shape_type, dims: materialDimsFromRow(m), materialId: m.id, marginCm: TRIM_MARGIN_CM, gapCm: TRIM_GAP_CM });
    playArrangeSound();
    rofGame.disarmCutter(); // arranging is a finished action; putting the cutter down also lets you hover the scrap
    const sc = trimScrap(); // cutterList is already up to date (the game reports it synchronously)
    rofGame.announce(`${res.count} cutters arranged. Scrap ${Math.round(sc.grams)} grams, ${Math.round(sc.pct)} percent of the dough.`);
  }

  // ---- Trim by Knife --------------------------------------------------------------------------------
  // A centred grid of straight cuts (renderer/rof/knifeGrid.js): two numbers, the piece size across and down.
  // The dotted lines are a preview; Cut makes them solid and final (One portion / Export PDF), Edit cuts
  // unlocks them. Every piece is one portion, weighed exactly like a cutter piece (cutPortionFor).
  const KNIFE_MIN_CM = 1, KNIFE_MAX_CM = 100;
  // Starting size: the square that gives the recipe's portion weight, when it has one; else 5 x 5 cm.
  function knifeDefaultCm() {
    const pw = Number(selectedRecipe?.portion_weight_grams);
    const fp = bakeSnapshot.footprint;
    if (pw > 0 && sheetInfo.sessionGrams > 0) {
      const side = Math.sqrt((pw * fp.areaCm2) / sheetInfo.sessionGrams);
      return Math.min(20, Math.max(2, Math.round(side * 2) / 2));
    }
    return 5;
  }
  let knifePlan = null; // the game's last grid plan (counts, leftover strips)
  function applyKnifeGrid() {
    if (!rofGame || !knifeSpec) return;
    knifePlan = rofGame.setKnifeGrid({ acrossCm: knifeSpec.across, downCm: knifeSpec.down, solid: knifeSpec.cut });
    updateTrimSummary(); // the game reported the pieces synchronously
  }
  const cmNice = (v) => `${Math.round(v * 10) / 10} cm`;
  // The readout above Cut: one portion (the same rows the cutter readout and the portion view use), the grid,
  // and the trim -- the edge strips that don't make a whole piece, split evenly on opposite sides.
  function updateKnifeInfo() {
    const el = document.getElementById('rof-knife-info');
    const cutBtn = document.getElementById('rof-knife-cut-btn');
    if (!el || !knifeSpec) return;
    const plan = knifePlan;
    if (cutBtn && !knifeSpec.cut) cutBtn.disabled = !(plan && plan.fits);
    if (!plan || !plan.fits) {
      el.innerHTML = '<div class="rof-cutter-info-line"><span class="rof-leftover">Too big for this tray: no whole piece fits.</span></div>';
      return;
    }
    const P = window.RofGame.portions, dims = { lengthCm: knifeSpec.across, widthCm: knifeSpec.down };
    const { m, grams } = cutPortionFor('rectangular', dims);
    const [weight, raw] = portionWeightRows(grams);
    const W = plan.cols * plan.across + 2 * plan.leftover.across, H = plan.rows * plan.down + 2 * plan.leftover.down;
    const rect = bakeSnapshot.material.shape_type === 'rectangular';
    const sides = [];
    if (plan.leftover.across >= 0.05) sides.push(`${cmNice(plan.leftover.across)} strip left and right`);
    if (plan.leftover.down >= 0.05) sides.push(`${cmNice(plan.leftover.down)} top and bottom`);
    const sc = trimScrap();
    const trimText = sc.grams < 0.05
      ? 'No trim: the pieces fill the tray exactly.'
      : `Trim: ${rect ? (sides.join(', ') || 'none') : 'the edges outside the whole pieces'} &middot; ${P.fmtGrams(sc.grams)} g (${P.fmtGrams(sc.pct)}%)`;
    el.innerHTML = `
      <div class="rof-cutter-info-grams">One portion: <strong>${weight.value}</strong> finished &middot; ${raw.est ? `${raw.value} raw dough (est.)` : 'no Baking Waste'}</div>
      <div class="rof-cutter-info-line">${cutterPieceSizeLabel('rectangular', dims)} &middot; about ${cmText(m.heightCm, true)} thick (est.)</div>
      <div class="rof-cutter-info-line"><strong>${plan.count}</strong> pieces${rect ? ` (${plan.cols} across × ${plan.rows} down) &middot; tray inside ${Math.round(W * 10) / 10} × ${Math.round(H * 10) / 10} cm` : ''}</div>
      <div class="rof-cutter-info-line${sc.grams < 0.05 ? '' : ' rof-leftover'}">${trimText}</div>`;
  }
  function syncKnifeControls() {
    const cut = !!knifeSpec?.cut;
    ['rof-knife-across', 'rof-knife-down'].forEach(id => { const i = document.getElementById(id); if (i) i.disabled = cut; });
    const btn = document.getElementById('rof-knife-cut-btn');
    if (btn) {
      btn.textContent = cut ? 'Edit cuts' : 'Cut';
      btn.className = cut ? 'secondary' : 'primary';
      btn.disabled = !cut && !(knifePlan && knifePlan.fits);
    }
  }
  function onKnifeSize() {
    const read = (id) => parseFloat(document.getElementById(id)?.value);
    const a = read('rof-knife-across'), d = read('rof-knife-down');
    const ok = (v) => v >= KNIFE_MIN_CM && v <= KNIFE_MAX_CM;
    if (!ok(a) || !ok(d)) return; // half-typed: keep the last valid grid until the number is complete
    knifeSpec.across = a; knifeSpec.down = d;
    applyKnifeGrid();
    syncKnifeControls();
  }
  function toggleKnifeCut() {
    if (!knifeSpec) return;
    knifeSpec.cut = !knifeSpec.cut;
    rofGame.setKnifeSolid(knifeSpec.cut);
    if (knifeSpec.cut) { playArrangeSound(); rofGame.announce(`Cut. ${knifePlan ? knifePlan.count : 0} pieces.`); }
    else rofGame.announce('Editing the cuts. The lines are a preview again.');
    syncKnifeControls();
    updateTrimSummary();
  }
  // Cutter <-> Knife. A tray is cut one way or the other, so switching clears what is on it.
  function setTrimMode(mode) {
    if (mode === trimMode) return;
    trimMode = mode;
    if (mode === 'knife') {
      rofGame.disarmCutter();
      if (!knifeSpec) { const s0 = knifeDefaultCm(); knifeSpec = { across: s0, down: s0, cut: false }; }
      knifeSpec.cut = false;
    } else {
      rofGame.clearCutters(); // drops the knife grid
      if (knifeSpec) knifeSpec.cut = false;
    }
    renderTrimStepPanel(document.getElementById('rof-step-panel'));
  }

  async function renderTrimStepPanel(panel) {
    if (rofGame) rofGame.setInteractive(true); // the bake switches input off; cutters need it back
    const knifeMode = trimMode === 'knife';
    const tools = knifeMode ? `
      <div style="font-size:12.5px; color:var(--neutral); margin-bottom:8px;">Set the piece size; the dotted lines show where the knife goes, centred on the tray. Cut when it looks right.</div>
      <div class="rof-knife-row">
        <div class="field"><label for="rof-knife-across">Across (cm)</label><input id="rof-knife-across" type="number" min="${KNIFE_MIN_CM}" max="${KNIFE_MAX_CM}" step="0.5" value="${knifeSpec.across}" /></div>
        <div class="field"><label for="rof-knife-down">Down (cm)</label><input id="rof-knife-down" type="number" min="${KNIFE_MIN_CM}" max="${KNIFE_MAX_CM}" step="0.5" value="${knifeSpec.down}" /></div>
        <button type="button" class="primary" id="rof-knife-cut-btn">Cut</button>
      </div>
      <div class="rof-cutter-info" id="rof-knife-info" role="status"></div>` : `
      <div style="font-size:12.5px; color:var(--neutral); margin-bottom:8px;">Choose a cutter, then click the sheet to stamp it or use Auto-arrange. Drag to move one, scroll to turn it, Delete removes it.</div>
      <div class="rof-cutter-pick">
        <label for="rof-cutter-select" class="rof-sr-only">Cutter</label>
        <div class="rof-cutter-row">
          <select id="rof-cutter-select" disabled><option value="">Loading cutters…</option></select>
          <button type="button" class="secondary" id="rof-cutter-hand-btn" aria-pressed="false" disabled title="Take the cutter in hand to stamp it on the sheet">Place by hand</button>
        </div>
        <div class="rof-cutter-info" id="rof-cutter-info" role="status" hidden></div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:6px;">
        <button type="button" class="secondary" id="rof-auto-cut-btn">Auto-arrange</button>
        <button type="button" class="secondary" id="rof-clear-cuts-btn">Clear all</button>
      </div>`;
    panel.innerHTML = `
      <div class="mode-toggle rof-trim-mode" role="group" aria-label="Trim with">
        <button type="button" class="mode-toggle-btn ${knifeMode ? '' : 'active'}" data-trim-mode="cutter" aria-pressed="${!knifeMode}">Cutter</button>
        <button type="button" class="mode-toggle-btn ${knifeMode ? 'active' : ''}" data-trim-mode="knife" aria-pressed="${knifeMode}">Trim by Knife</button>
      </div>
      ${tools}
      <div id="rof-trim-summary"></div>
      <div class="rof-export-status" id="rof-export-status" role="status"></div>
      <div class="rof-actions"><button type="button" class="secondary" id="rof-back-bake-btn">← Back to Bake</button><button type="button" class="secondary" id="rof-portion-btn" aria-pressed="false" disabled>One portion</button><button type="button" class="secondary" id="rof-export-pdf-btn" disabled>Export PDF</button></div>`;
    wirePortionBtn();
    panel.querySelectorAll('[data-trim-mode]').forEach(b => b.addEventListener('click', () => setTrimMode(b.dataset.trimMode)));
    document.getElementById('rof-export-pdf-btn').addEventListener('click', exportRofPdf);
    rofGame.setScrapHighlight(true);
    document.getElementById('rof-back-bake-btn').addEventListener('click', () => {
      rofGame.disarmCutter(); rofGame.clearCutters();
      if (knifeSpec) knifeSpec.cut = false;
      goToRofStep('bake'); bakeState = 'done';
      renderTrayStepPanel();
    });

    if (knifeMode) {
      ['rof-knife-across', 'rof-knife-down'].forEach(id => document.getElementById(id).addEventListener('input', onKnifeSize));
      document.getElementById('rof-knife-cut-btn').addEventListener('click', toggleKnifeCut);
      // Coming (back) to Trim with no grid on the tray: lay it out again (as a preview).
      if (!cutterList.some(c => String(c.data.materialId) === 'knife')) { knifeSpec.cut = false; applyKnifeGrid(); }
      syncKnifeControls();
      updateTrimSummary();
      return;
    }

    document.getElementById('rof-auto-cut-btn').addEventListener('click', autoArrangeCutters);
    document.getElementById('rof-clear-cuts-btn').addEventListener('click', () => { rofGame.clearCutters(); });
    reloadMaterials();
    await ensureCutterMaterials();
    const sel = document.getElementById('rof-cutter-select');
    if (!sel) return; // moved on while the list loaded
    fillCutterSelect();
    sel.addEventListener('change', () => onCutterSelect(sel.value));
    document.getElementById('rof-cutter-hand-btn').addEventListener('click', toggleCutterInHand);
    syncCutterPicker();
    updateTrimSummary();
  }

  function onProcessCheckChanged() {
    selectedProcessLocalIds = new Set(
      [...processChecksEl.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value)
    );
    // Changing which processes feed this tray invalidates any in-progress/completed session --
    // always drop back to Setup rather than let stale placed dough/cutters survive a process
    // change (a different combined dough entirely).
    rofStep = 'setup';
    reachedRofSteps = new Set(['setup']);
    bakeSnapshot = null;
    resetGameSession();
    renderProcessSummary();
    const hasSelection = selectedProcessLocalIds.size > 0;
    traySection.style.display = hasSelection ? '' : 'none';
    if (hasSelection) renderTrayStepPanel();
    else { syncPreviewMode(); syncRecipeBlock(); }
  }

  function populateProcessChecks() {
    if (workingProcesses.length === 0) { processField.style.display = 'none'; return; }
    processField.style.display = 'flex';
    processChecksEl.innerHTML = workingProcesses.map(p => {
      const netWeight = compoundWasteYield(sumIngredientQuantities(p.ingredientRows), p.wastes);
      return `
        <label style="display:flex; align-items:center; gap:8px; font-weight:normal; font-size:13px;">
          <input type="checkbox" value="${p.localId}" data-rof-process-check />
          ${p.name || '(untitled process)'} <span style="color:var(--neutral); font-size:12px;">(Net ${netWeight} g)</span>
        </label>
      `;
    }).join('');
    processChecksEl.querySelectorAll('[data-rof-process-check]').forEach(cb => {
      cb.addEventListener('change', onProcessCheckChanged);
    });
    // A single-process recipe has nothing to choose -- auto-check it. 2+ processes start
    // unchecked, forcing the chef to explicitly pick which one(s) go into this tray rather than
    // silently defaulting to "just the first" and looking already-correct when it isn't (the
    // whole point of this being a manual choice, not an automatic "combine everything").
    if (workingProcesses.length === 1) {
      const onlyCb = processChecksEl.querySelector('[data-rof-process-check]');
      onlyCb.checked = true;
      onProcessCheckChanged();
    } else {
      onProcessCheckChanged();
    }
  }

  async function onRecipePicked(recipe) {
    selectedRecipe = recipe;
    recipeEditing = false;
    nameInput.value = recipe.name;
    browseListShowing = false;
    traySection.style.display = 'none';
    summaryEl.innerHTML = '';
    rofStep = 'setup';
    reachedRofSteps = new Set(['setup']);
    bakeSnapshot = null;
    resetGameSession();

    const full = await currentNs().api.get(recipe.id);
    if (!selectedRecipe || selectedRecipe.id !== recipe.id) return; // superseded by a later pick

    recipePortionGrams = Number(full.portion_weight_grams) > 0 ? Number(full.portion_weight_grams) : null;
    workingProcesses = (full.processes || []).map(proc => buildProcessFromSaved(proc));
    populateProcessChecks();
    syncRecipeBlock();
  }

  sourceButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.rofSource === source) return;
      source = btn.dataset.rofSource;
      sourceButtons.forEach(b => b.classList.toggle('active', b.dataset.rofSource === source));
      nameInput.value = '';
      listEl.hidden = true;
      listEl.innerHTML = '';
      clearSelection();
    });
  });

  nameInput.addEventListener('input', () => {
    clearSelection();
    browseListShowing = false;
  });

  wireRecipeAutocomplete(nameInput, listEl, onRecipePicked, (q) => currentNs().api.search(q));

  browseBtn.addEventListener('mousedown', async (e) => {
    e.preventDefault();
    if (browseListShowing && !listEl.hidden) {
      listEl.hidden = true;
      listEl.innerHTML = '';
      browseListShowing = false;
      return;
    }
    const all = await currentNs().api.list();
    const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
    renderRecipeAutocompleteList(listEl, sorted, nameInput, onRecipePicked, 'No recipes yet');
    browseListShowing = true;
    nameInput.focus();
  });

}

function renderMaterialsView(main) {
  const s = state.materials;
  if (s.view === 'form') return renderMaterialFormView(main);
  return renderMaterialsListView(main);
}

function openNewMaterialForm() {
  state.materials.view = 'form';
  state.materials.formId = null;
  state.materials.pendingPhoto = null;
  state.materials.removePhoto = false;
  renderView();
}

function openEditMaterialForm(id) {
  state.materials.view = 'form';
  state.materials.formId = id;
  state.materials.pendingPhoto = null;
  state.materials.removePhoto = false;
  renderView();
}

function goBackToMaterialsList() {
  state.materials.view = 'list';
  state.materials.formId = null;
  state.materials.pendingPhoto = null;
  state.materials.removePhoto = false;
  renderView();
}

async function renderMaterialsListView(main) {
  const materials = await window.api.listMaterials();

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Materials</h1><span class="page-description">Trays, molds &amp; pans</span></div>
      <button class="primary" id="add-material-btn">+ Add Material</button>
    </div>
    <div class="search-bar">
      <label for="material-search">Search by name or code</label>
      <input id="material-search" type="search" />
    </div>
    <div id="materials-content"><div class="loading-state" role="status">Loading…</div></div>
  `;
  document.getElementById('add-material-btn').addEventListener('click', () => openNewMaterialForm());

  const searchInput = document.getElementById('material-search');
  const content = document.getElementById('materials-content');

  if (materials.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No materials yet</div>Click "+ Add Material" to create the first one.</div>`;
    return;
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query
      ? materials.filter(m => m.name.toLowerCase().includes(query) || m.code.toLowerCase().includes(query))
      : materials;

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No materials match "${searchInput.value}".</div>`;
      return;
    }

    // Same shared-table-with-rowspan-merged-category pattern as the Dish Catalog/Ingredients
    // views -- one continuous table, not one per group, so columns stay aligned across every
    // category. Grouped by materialGroupLabel (Cutter / {Shape} Tray, see its own comment), not a
    // stored field -- so a fixed display order is needed here (unlike Dish Catalog, which can just
    // rely on its already-category-sorted backend query): materials has no such pre-sort to lean
    // on, since `list-materials` orders by name, not category.
    const GROUP_ORDER = ['Cutter', 'Round Tray', 'Rectangular Tray', 'Muffin Tray', 'Triangle Tray'];
    const byGroup = new Map();
    for (const m of filtered) {
      const label = materialGroupLabel(m);
      if (!byGroup.has(label)) byGroup.set(label, []);
      byGroup.get(label).push(m);
    }
    const groups = [...byGroup.entries()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a[0]), ib = GROUP_ORDER.indexOf(b[0]);
      if (ia === -1 && ib === -1) return a[0].localeCompare(b[0]);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const bodyRows = [];
    for (const [label, list] of groups) {
      list.forEach((m, idx) => {
        bodyRows.push(`
          <tr>
            ${idx === 0 ? `<td class="cat-cell" rowspan="${list.length}">${label}</td>` : ''}
            <td>${m.code}</td>
            <td>${m.name}</td>
            <td>${materialShapeLabel(m.category, m.shape_type)}</td>
            <td>${formatMaterialDimensions(m)}</td>
            <td>${formatMaterialWeight(m)}</td>
            <td style="text-align:right">
              <button class="icon-btn" data-edit="${m.id}">Edit</button>
              <button class="icon-btn danger" data-delete="${m.id}">Delete</button>
            </td>
          </tr>
        `);
      });
    }

    content.innerHTML = `
      <div class="table-scroll"><table class="materials-table">
        <thead><tr><th>Category</th><th>Code</th><th>Name</th><th>Shape</th><th>Dimensions</th><th>Weight (g)</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table></div>
    `;

    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openEditMaterialForm(parseInt(btn.dataset.edit, 10)));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const m = materials.find(x => x.id === id);
        if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
        const result = await window.api.deleteMaterial(id);
        if (!result.success) {
          if (result.inUse) alert(`"${m.name}" is used elsewhere and can't be deleted.`);
          else alert('Delete failed.');
          return;
        }
        renderMaterialsListView(main);
      });
    });
  }

  searchInput.addEventListener('input', renderFiltered);
  renderFiltered();
}

async function renderMaterialFormView(main) {
  const s = state.materials;
  const editing = !!s.formId;
  let material = null;
  let existingPhotoDataUrl = null;

  if (editing) {
    material = await window.api.getMaterial(s.formId);
    if (material.photo_path) existingPhotoDataUrl = await window.api.getMaterialPhoto(material.photo_path);
  }

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${editing ? 'Edit Material' : 'New Material'}</h1>
        <span class="page-description">${editing ? material.code : 'MS code assigned after saving'}</span>
      </div>
      <button class="secondary" id="mf-back-btn">← Back to Materials</button>
    </div>
    <div id="mf-form-root"></div>
    <button class="primary" id="mf-save-btn">${editing ? 'Save Changes' : 'Save Material'}</button>
    <span id="mf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  // The photo being picked lives in state.materials (reset whenever the form is opened); the form itself
  // is the shared one Recipe on Fire's "+ Create new …" dialog also uses.
  const form = mountMaterialForm(document.getElementById('mf-form-root'), { material, existingPhotoDataUrl, photoState: s });

  document.getElementById('mf-back-btn').addEventListener('click', () => {
    form.dispose();
    goBackToMaterialsList();
  });

  document.getElementById('mf-save-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('mf-status');
    const saveBtn = document.getElementById('mf-save-btn');
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    const saved = await form.save();
    if (!saved) { statusEl.textContent = ''; saveBtn.disabled = false; return; }
    form.dispose();
    goBackToMaterialsList();
  });
}

// The Materials Add / Edit form -- Name, Category, Shape Type (only the Category's shapes), Weight, the
// shape's dimension fields, the live 3D preview and the optional photo -- drawn into `root`. ONE form for
// every entry point: the Materials screen (renderMaterialFormView) and Recipe on Fire's "+ Create new
// cutter / tray…" dialog (openMaterialCreateModal), so the two can never drift apart. The caller draws its
// own Save / Cancel and calls:
//   save()    -> validates, calls saveMaterial (a real materials row, MS code assigned by main.js); resolves
//                { id } on success, or null after telling the chef what went wrong
//   dispose() -> frees the 3D preview's WebGL context and the resize listener; call on every way out.
// Options: material (the row being edited, or null for a new one), existingPhotoDataUrl, photoState (an
// object holding pendingPhoto / removePhoto; a private one by default) and lockCategory (a category key:
// the Category is fixed to it, so what gets made is usable where it was made).
function mountMaterialForm(root, { material = null, existingPhotoDataUrl = null, photoState = null, lockCategory = null } = {}) {
  const editing = !!material;
  const ps = photoState || { pendingPhoto: null, removePhoto: false };
  const $ = (id) => root.querySelector(`#${id}`);
  const currentPhotoSrc = ps.pendingPhoto ? ps.pendingPhoto.dataUrl : (existingPhotoDataUrl && !ps.removePhoto ? existingPhotoDataUrl : null);
  const initialCategory = lockCategory || material?.category || 'tray_pan';
  const initialShape = material?.shape_type || 'round';

  root.innerHTML = `
    <div class="generate-controls">
      <div class="field"><label for="mf-name">Name</label><input id="mf-name" dir="auto" /></div>
      <div class="field" style="max-width:200px;">
        <label for="mf-category">Category</label>
        <select id="mf-category" ${lockCategory ? 'disabled' : ''}>
          ${Object.entries(MATERIAL_CATEGORIES).filter(([key]) => !lockCategory || key === lockCategory).map(([key, c]) => `<option value="${key}" ${initialCategory === key ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="max-width:240px;">
        <label for="mf-shape">Shape Type</label>
        <select id="mf-shape"></select>
      </div>
      <div class="field" style="max-width:200px;">
        <label id="mf-weight-label" for="mf-weight">Weight (g)</label>
        <input id="mf-weight" type="number" min="0" step="1" value="${material?.weight_grams ?? ''}" />
        <span id="mf-weight-hint" style="font-size:11px; color:var(--neutral);"></span>
      </div>
    </div>

    <div style="display:flex; gap:24px; flex-wrap:wrap; margin-bottom:8px;">
      <div style="flex:1 1 280px; min-width:260px;">
        <h3 style="margin-bottom:10px;">Dimensions</h3>
        <div id="mf-dimension-fields" class="generate-controls" style="margin-bottom:0;"></div>
      </div>
      <div style="flex:1 1 340px; min-width:300px;">
        <h3 style="margin-bottom:10px;">3D Preview</h3>
        <div class="material-preview-wrap">
          <canvas id="mf-preview-canvas"></canvas>
          <div class="material-preview-empty" id="mf-preview-empty">Enter dimensions to see a live 3D preview.</div>
          <div class="material-preview-hint">Drag to rotate · Scroll to zoom</div>
        </div>
      </div>
    </div>

    <div class="field" style="margin:16px 0; max-width:320px;">
      <label for="mf-photo-input">Photo (optional)</label>
      <input type="file" id="mf-photo-input" accept="image/jpeg,image/png" />
      <div id="mf-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="mf-photo-preview" src="${currentPhotoSrc || ''}" alt="" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block;" />
        <button type="button" class="secondary" id="mf-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>
  `;

  // Set as a property, not in the markup, so a name with a quote in it can't break the field.
  $('mf-name').value = material?.name || '';

  // Photo -- single-photo model, same pattern as Recipe Book's own (see renderRecipeFormView).
  function updatePhotoPreview() {
    const src = ps.pendingPhoto ? ps.pendingPhoto.dataUrl : (existingPhotoDataUrl && !ps.removePhoto ? existingPhotoDataUrl : null);
    $('mf-photo-preview-wrap').style.display = src ? '' : 'none';
    $('mf-photo-preview').src = src || '';
  }
  $('mf-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      alert('Please choose a JPG or PNG image.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be 5MB or smaller.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const ext = file.type === 'image/png' ? 'png' : 'jpeg';
      ps.pendingPhoto = { dataUrl, base64, ext };
      ps.removePhoto = false;
      updatePhotoPreview();
    };
    reader.readAsDataURL(file);
  });
  $('mf-photo-remove-btn').addEventListener('click', () => {
    ps.pendingPhoto = null;
    ps.removePhoto = true;
    $('mf-photo-input').value = '';
    updatePhotoPreview();
  });

  // Dimensions + live 3D preview -- rebuilt whenever the shape type changes (a different field
  // set entirely), refreshed on every dimension keystroke otherwise.
  const preview3D = createMaterialPreview3D($('mf-preview-canvas'));
  const dimensionFieldsEl = $('mf-dimension-fields');

  function currentShape() { return $('mf-shape').value; }

  function currentCategory() { return $('mf-category').value; }

  function updatePreview() {
    const shape = currentShape();
    const dims = readMaterialDims(shape, root);
    const hasAllDims = MATERIAL_SHAPE_PRESETS[shape].fields.every(f => dims[f.key] > 0);
    $('mf-preview-empty').style.display = hasAllDims ? 'none' : '';
    preview3D.setShape(shape, dims, currentCategory());
  }

  // For muffin_tray, the Weight field means weight PER CUP, not the whole tray -- see
  // materialCapacityGrams's own comment for why every consumer of this catalog value needs to
  // multiply by rows x columns rather than reading weight_grams as a total. Relabels the field
  // and shows the computed total live so it's unambiguous while she's actually entering it, not
  // just after saving.
  function updateWeightLabel() {
    const shape = currentShape();
    const labelEl = $('mf-weight-label');
    const hintEl = $('mf-weight-hint');
    if (shape !== 'muffin_tray') {
      labelEl.textContent = 'Weight (g)';
      hintEl.textContent = '';
      return;
    }
    labelEl.textContent = 'Weight per Cup (g)';
    const dims = readMaterialDims(shape, root);
    const weightRaw = $('mf-weight').value.trim();
    const weight = weightRaw === '' ? null : parseFloat(weightRaw);
    const total = materialCapacityGrams({ shape_type: shape, weight_grams: weight, cup_rows: dims.cupRows, cup_columns: dims.cupColumns });
    hintEl.textContent = total != null ? `Tray total: ${total} g (${dims.cupRows}×${dims.cupColumns} cups)` : '';
  }

  function renderDimensionsForShape(shape, existingValues) {
    renderMaterialDimensionFields(dimensionFieldsEl, shape, existingValues);
    dimensionFieldsEl.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => { updatePreview(); updateWeightLabel(); });
    });
    updatePreview();
    updateWeightLabel();
  }

  $('mf-weight').addEventListener('input', updateWeightLabel);

  // Shape Type lists only the chosen Category's shapes (MATERIAL_CATEGORY_SHAPES). The saved shape of the
  // material being edited is kept as an option while its own category is selected.
  function fillShapeOptions(category, selected) {
    const keep = editing && category === material.category ? material.shape_type : null;
    const opts = materialShapeOptions(category, keep);
    const pick = opts.some(([k]) => k === selected) ? selected : opts[0][0];
    $('mf-shape').innerHTML = opts.map(([key, label]) => `<option value="${key}" ${pick === key ? 'selected' : ''}>${label}</option>`).join('');
    return pick;
  }

  const firstShape = fillShapeOptions(initialCategory, initialShape);
  renderDimensionsForShape(firstShape, firstShape === initialShape ? materialDimsFromRow(material) : {});

  $('mf-shape').addEventListener('change', () => {
    renderDimensionsForShape(currentShape(), {});
  });

  // A category change re-lists the shapes. If the current shape is still offered it stays, with its typed
  // dimensions (only the 3D preview's floor-or-not changes); otherwise the first shape of the new list is
  // chosen and its fields shown empty.
  $('mf-category').addEventListener('change', () => {
    const before = currentShape();
    const after = fillShapeOptions(currentCategory(), before);
    if (after === before) updatePreview();
    else renderDimensionsForShape(after, {});
  });

  // The preview canvas has no pixel size of its own (CSS gives its wrapper height:300px, width
  // 100%) -- resize once layout has settled, and again if the window itself resizes while this
  // form stays open.
  requestAnimationFrame(() => preview3D.resize());
  const onWindowResize = () => preview3D.resize();
  window.addEventListener('resize', onWindowResize);

  // Every screen in this app is torn down and rebuilt fresh on navigation, never re-rendered in place,
  // so the running WebGL context needs an explicit teardown, or every visit to this form leaks another
  // one. Every way out (Back, successful Save, the dialog's Cancel / Escape) goes through dispose().
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('resize', onWindowResize);
    preview3D.dispose();
  }

  async function save() {
    const name = $('mf-name').value.trim();
    if (!name) { alert('Please enter a material name.'); $('mf-name').focus(); return null; }

    const shape = currentShape();
    const weightRaw = $('mf-weight').value.trim();

    const payload = {
      id: material?.id || undefined,
      name,
      category: currentCategory(),
      shapeType: shape,
      ...buildMaterialDimensionPayload(shape, root),
      weightGrams: weightRaw === '' ? null : parseFloat(weightRaw),
      removePhoto: ps.removePhoto,
    };
    if (ps.pendingPhoto) {
      payload.photoBase64 = ps.pendingPhoto.base64;
      payload.photoExt = ps.pendingPhoto.ext;
    }

    try {
      return await window.api.saveMaterial(payload);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
      return null;
    }
  }

  return { save, dispose, focus: () => $('mf-name').focus() };
}

// "+ Create new cutter… / tray…" from Recipe on Fire: the Materials form (mountMaterialForm, the very same
// one the Materials screen uses) in a dialog over the screen, so a new material never needs a trip to
// Materials. The Category is fixed by where it was opened (a cutter from Trim, a tray / pan from Setup), so
// what she makes is usable right there. Saving creates a REAL materials row. Resolves { id, materials }
// (the freshly reloaded catalog, so the caller can select the new one straight away), or null on Cancel.
function openMaterialCreateModal({ category }) {
  return new Promise((resolve) => {
    const noun = category === 'cutter' ? 'Cutter' : 'Tray / Pan';
    const opener = document.activeElement; // focus goes back here when the dialog closes
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal material-create-modal" role="dialog" aria-modal="true" aria-labelledby="mcm-title">
        <h2 id="mcm-title">New ${noun}</h2>
        <p class="mcm-note">Saved to the Materials catalog (MS code assigned on save), exactly as if made there.</p>
        <div id="mcm-form"></div>
        <div class="actions">
          <span id="mcm-status" role="status"></span>
          <button type="button" class="secondary" id="mcm-cancel">Cancel</button>
          <button type="button" class="primary" id="mcm-save">Save ${noun.toLowerCase()}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const form = mountMaterialForm(overlay.querySelector('#mcm-form'), { lockCategory: category });
    let busy = false;
    const close = (result) => {
      document.removeEventListener('keydown', onKeydown, true);
      form.dispose();
      overlay.remove();
      if (opener && opener.focus) opener.focus();
      resolve(result);
    };
    // Escape cancels (not while saving); Tab stays inside the dialog -- same as the Dough Shapes dialog.
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(null); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeydown, true);
    overlay.querySelector('#mcm-cancel').addEventListener('click', () => { if (!busy) close(null); });
    overlay.querySelector('#mcm-save').addEventListener('click', async () => {
      const saveBtn = overlay.querySelector('#mcm-save'), cancelBtn = overlay.querySelector('#mcm-cancel'), status = overlay.querySelector('#mcm-status');
      busy = true; saveBtn.disabled = true; cancelBtn.disabled = true; status.textContent = 'Saving…';
      const saved = await form.save();
      if (!saved) { busy = false; saveBtn.disabled = false; cancelBtn.disabled = false; status.textContent = ''; return; }
      let materials = null;
      try { materials = await window.api.listMaterials(); } catch (err) { console.error('[materials] reload after create failed:', err); }
      close({ id: saved.id, materials });
    });
    form.focus();
  });
}

init().catch(showViewError);
