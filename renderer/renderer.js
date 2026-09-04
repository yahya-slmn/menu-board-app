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
  categories: [],
  proteinTypes: [],
  currentGeneratedMenuId: null,
  builder: { label: '', createdBy: '', startDate: '', endDate: '', numWeekdays: 20, activeSection: null, days: [], sections: {} },
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
  // Materials/Trays catalog -- same list<->form drill-down shape as recipes/extractor above
  // (view/formId), single-photo model like Recipe Book (pendingPhoto/removePhoto). shapeType and
  // the dimension fields aren't persisted here separately from the form's own inputs -- they're
  // read directly off the form DOM at save time, same convention every other simple text field
  // in the recipe form already uses (see renderMaterialFormView) -- this object only needs to
  // exist at all for view/formId/pendingPhoto/removePhoto, the same three things every other
  // list<->form screen's own state slice needs.
  materials: { view: 'list', formId: null, pendingPhoto: null, removePhoto: false },
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

const CATEGORY_COLOR = { CHICKEN: 'chicken', BEEF: 'beef', LAMB: 'lamb' };

// Categories where Protein Type is meaningful, confirmed against real item_portions/
// protein_type_id usage (not just categories literally named "Main") -- LUNCH_MAIN and
// STAFF_MAIN are the obvious ones; STAFF_BREAKFAST and STAFF_LUNCHBOX are structurally
// required by lib/generator.js's SECTION_SLOTS composition rules (1 vegetarian among Staff's
// 6 breakfast picks; 1 meat protein + 1 vegetarian for the lunchbox); STAFF_LUNCHBOX_SALAD
// isn't generator-enforced but is 100% consistently tagged in the existing catalog.
// CEO_LUNCH_MAIN was deliberately left out despite the "lunch main" name -- 0% real usage.
const PROTEIN_ELIGIBLE_CATEGORIES = new Set([
  'LUNCH_MAIN', 'STAFF_MAIN', 'STAFF_BREAKFAST', 'STAFF_LUNCHBOX', 'STAFF_LUNCHBOX_SALAD',
]);

async function init() {
  state.sections = await window.api.getSections();
  state.categories = await window.api.getCategories();
  state.proteinTypes = await window.api.getProteinTypes();
  state.currentSection = state.sections[0].code;

  renderSectionNav();
  wireNav();
  wireRefreshButton();
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
// renderExtractedIngredientsView/renderExportAllView/renderGenerateView), so replacing them just shows the same screen with
// fresher data underneath. Build Menu (state.builder.sections[...].selections) and an
// in-progress Recipe/Extractor form (state.recipes/extractor.ingredientRows) hold real unsaved work that a
// re-render would silently discard, and an open Add/Edit modal (Item/Ingredient, appended to
// document.body) was populated from data fetched at modal-open time -- none of these should
// ever be touched by a background refresh.
const SAFE_REFRESH_VIEWS = ['items', 'history', 'recipes', 'extractor', 'ingredients', 'extractedIngredients', 'exportAll', 'generate'];
function isSafeToForceRerender() {
  if (document.querySelector('.modal-overlay')) return false;
  if (state.currentView === 'build') return false;
  if (state.currentView === 'recipes' && state.recipes.view === 'form') return false;
  if (state.currentView === 'extractor' && state.extractor.view === 'form') return false;
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

function renderSectionNav() {
  const el = document.getElementById('section-nav');
  el.innerHTML = state.sections.map(s => `
    <button class="nav-btn ${s.code === state.currentSection ? 'active' : ''}" data-section="${s.code}">${s.name}</button>
  `).join('');
  el.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentSection = btn.dataset.section;
      renderSectionNav();
      renderView();
    });
  });
}

// The 3 screens grouped under the "Menu" nav parent (see index.html's #menu-sublist).
const MENU_GROUP_VIEWS = ['generate', 'build', 'exportAll'];

function wireNav() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
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
  // sub-list, landing on the first child (Generate Menu) the first time you enter the group,
  // same interaction as Dish Catalog above.
  document.getElementById('menu-parent-btn').addEventListener('click', () => {
    if (MENU_GROUP_VIEWS.includes(state.currentView)) {
      state.menuGroupExpanded = !state.menuGroupExpanded;
    } else {
      resetDrilldownScreens();
      state.menuGroupExpanded = true;
      state.currentView = 'generate';
    }
    renderView();
  });
}

function updateActiveViewButtons() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.currentView);
  });
  document.getElementById('menu-parent-btn').classList.toggle('active', MENU_GROUP_VIEWS.includes(state.currentView));
}

function updateItemCatalogExpansion() {
  const expanded = state.currentView === 'items' && state.itemCatalogExpanded;
  document.getElementById('section-nav').style.display = expanded ? 'block' : 'none';
  const caret = document.getElementById('items-caret');
  if (caret) caret.textContent = expanded ? '▾' : '▸';

  const menuExpanded = MENU_GROUP_VIEWS.includes(state.currentView) && state.menuGroupExpanded;
  document.getElementById('menu-sublist').style.display = menuExpanded ? 'block' : 'none';
  const menuCaret = document.getElementById('menu-caret');
  if (menuCaret) menuCaret.textContent = menuExpanded ? '▾' : '▸';
}

function renderView() {
  updateActiveViewButtons();
  updateItemCatalogExpansion();
  const main = document.getElementById('main');
  main.classList.toggle('build-mode', state.currentView === 'build');
  if (state.currentView === 'items') return renderItemsView(main);
  if (state.currentView === 'generate') return renderGenerateView(main);
  if (state.currentView === 'build') return renderBuildMenuView(main);
  if (state.currentView === 'history') return renderHistoryView(main);
  if (state.currentView === 'exportAll') return renderExportAllView(main);
  if (state.currentView === 'recipes') return renderRecipesView(main);
  if (state.currentView === 'extractor') return renderExtractorView(main);
  if (state.currentView === 'calculator') return renderCalculatorView(main);
  if (state.currentView === 'ingredients') return renderIngredientsView(main);
  if (state.currentView === 'extractedIngredients') return renderExtractedIngredientsView(main);
  if (state.currentView === 'materials') return renderMaterialsView(main);
}

function currentSectionName() {
  return state.sections.find(s => s.code === state.currentSection)?.name || '';
}

// ============================================================
// ITEM CATALOG VIEW
// ============================================================
async function renderItemsView(main) {
  const [items, proteinTypes] = await Promise.all([
    window.api.getItems(state.currentSection),
    window.api.getProteinTypes(),
  ]);

  // Category options: distinct category_name values actually present in this section's items,
  // in the order they already appear (get-items pre-sorts by meal-period/category order) --
  // guarantees the dropdown exactly matches what's grouped in the table below, with no category
  // ever offered that would filter down to zero results.
  const categoryNames = [...new Set(items.map(it => it.category_name))];

  main.innerHTML = `
    <div class="topbar">
      <div><h1>Dish Catalog</h1><span class="section-pill">${currentSectionName()}</span></div>
      <button class="primary" id="add-item-btn">+ Add Item</button>
    </div>
    <div class="search-bar">
      <label for="item-search">Search by name</label>
      <input id="item-search" type="search" />
      <select id="item-category-filter">
        <option value="">All Categories</option>
        ${categoryNames.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <select id="item-protein-filter" hidden>
        <option value="">All Proteins</option>
        ${proteinTypes.map(p => `<option value="${p.code}">${p.name}</option>`).join('')}
      </select>
    </div>
    <div id="items-content">Loading…</div>
  `;
  document.getElementById('add-item-btn').addEventListener('click', () => openItemModal());

  const searchInput = document.getElementById('item-search');
  const categoryFilter = document.getElementById('item-category-filter');
  const proteinFilter = document.getElementById('item-protein-filter');
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

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value;
    const protein = proteinFilter.hidden ? '' : proteinFilter.value;
    const filtered = items.filter(it =>
      (!query || it.name.toLowerCase().includes(query)) &&
      (!cat || it.category_name === cat) &&
      (!protein || it.protein_code === protein)
    );

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No items match the current filters.</div>`;
      return;
    }

    // One shared table for every category (not a table-per-category), with the category
    // column merged via rowspan -- keeps Tags/RC in the same horizontal position for every
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
              ${it.protein_code ? `<span class="chip ${CATEGORY_COLOR[it.protein_code] || ''}">${it.protein_name}</span>` : ''}
              ${it.is_daily_repeating ? `<span class="chip daily">Daily</span>` : ''}
            </td>
            <td>
              <input class="rc-input ${it.rc_code ? '' : 'rc-missing'}" data-rc="${it.id}" value="${it.rc_code || ''}" placeholder="NEW" />
            </td>
            <td style="text-align:right">
              <button class="icon-btn" data-edit="${it.id}">Edit</button>
              <button class="icon-btn danger" data-delete="${it.id}">Delete</button>
            </td>
          </tr>
        `);
      });
    }

    content.innerHTML = `
      <table class="items-table">
        <thead><tr><th>Category</th><th>Name</th><th>Tags</th><th>RC</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
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
    content.querySelectorAll('[data-rc]').forEach(input => {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', async () => {
        const id = input.dataset.rc;
        const rcCode = input.value.trim() || null;
        await window.api.updateItemRc({ id, rcCode });
        const it = items.find(i => i.id == id);
        if (it) it.rc_code = rcCode;
        input.classList.toggle('rc-missing', !rcCode);
      });
    });
  }

  searchInput.addEventListener('input', renderFiltered);
  renderFiltered();
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
        <label>Protein type (only for main-dish categories)</label>
        <select id="m-protein">
          <option value="">— none —</option>
          ${state.proteinTypes.map(p => `<option value="${p.code}" ${isEdit && existingItem.protein_code === p.code ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label><input type="checkbox" id="m-daily" ${isEdit && existingItem.is_daily_repeating ? 'checked' : ''} /> Repeats every day automatically</label>
      </div>
      <div class="field">
        <label>Portions per age group (grams/ml)</label>
        <div class="portion-grid">
          ${ageGroups.map(ag => {
            const existing = portions.find(p => p.age_group_code === ag.code);
            return `<div class="portion-cell"><span class="portion-cell-label">${ag.name}</span><input data-ag="${ag.code}" value="${existing ? existing.quantity + existing.unit : ''}" /></div>`;
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

  const nameInput = overlay.querySelector('#m-name');
  const periodSelect = overlay.querySelector('#m-period');
  const categorySelect = overlay.querySelector('#m-category');
  const categoryWarning = overlay.querySelector('#m-category-warning');
  const proteinSelect = overlay.querySelector('#m-protein');
  const dailyCheckbox = overlay.querySelector('#m-daily');
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
  }

  // Rule 4: Protein Type only selectable for main-dish-type categories -- confirmed against
  // real item_portions/protein_type_id usage data, not just categories literally named "Main".
  function refreshProteinAvailability() {
    const eligible = PROTEIN_ELIGIBLE_CATEGORIES.has(categorySelect.value);
    proteinSelect.disabled = !eligible;
    if (!eligible) proteinSelect.value = '';
  }

  periodSelect.addEventListener('change', () => refreshCategoryOptions());
  categorySelect.addEventListener('change', () => {
    categoryWarning.style.display = 'none';
    saveBtn.disabled = !categorySelect.value;
    refreshProteinAvailability();
  });

  refreshCategoryOptions(isEdit ? existingItem.category_code : undefined);

  nameInput.addEventListener('blur', async () => {
    if (isEdit || !nameInput.value.trim()) return;
    const suggestion = await window.api.suggestClassification({ name: nameInput.value, mealPeriod: periodSelect.value, sectionCode: state.currentSection });
    if (suggestion.category) {
      categorySelect.value = suggestion.category;
      categoryWarning.style.display = 'none';
      saveBtn.disabled = !categorySelect.value;
      refreshProteinAvailability();
    }
    if (suggestion.protein && !proteinSelect.disabled) proteinSelect.value = suggestion.protein;
    dailyCheckbox.checked = suggestion.isDailyRepeating;
  });

  overlay.querySelector('#m-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#m-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return alert('Please enter an item name.');

    const portionInputs = overlay.querySelectorAll('[data-ag]');
    const parsedPortions = [];
    portionInputs.forEach(inp => {
      const val = inp.value.trim();
      if (!val) return;
      // accept "150gm", "180 ml", or a bare "150" (defaults to gm)
      const match = val.match(/([\d.]+)\s*(gm|g|ml|l)?/i);
      if (match) {
        const rawUnit = (match[2] || 'gm').toLowerCase();
        parsedPortions.push({
          ageGroupCode: inp.dataset.ag,
          quantity: parseFloat(match[1]),
          unit: rawUnit === 'g' ? 'gm' : rawUnit,
        });
      }
    });

    if (!isEdit && parsedPortions.length === 0) {
      return alert('Please enter a portion size (e.g. 150gm or 180ml) for at least one age group, otherwise the item can\'t be linked to this section and won\'t appear.');
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
          removeInvalidSectionPortions,
        })
      : await window.api.addItem({
          name, categoryCode: categorySelect.value,
          proteinCode: proteinSelect.value || null,
          isDailyRepeating: dailyCheckbox.checked,
          portions: parsedPortions,
          sectionCode: state.currentSection,
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
    <div id="g-result"></div>
  `;

  const sectionSelect = document.getElementById('g-section');
  const sectionPill = document.getElementById('g-section-pill');
  sectionSelect.addEventListener('change', () => {
    sectionPill.textContent = state.sections.find(s => s.code === sectionSelect.value)?.name || '';
  });

  wireDateRangeFields('g-start', 'g-end', 'g-day-count');

  document.getElementById('g-generate').addEventListener('click', async () => {
    const label = document.getElementById('g-label').value.trim() || 'Untitled Menu';
    const createdBy = document.getElementById('g-created-by').value.trim() || null;
    const startDate = document.getElementById('g-start').value;
    const endDate = document.getElementById('g-end').value;
    if (!startDate || !endDate) return alert('Please choose a start and end date.');
    if (endDate < startDate) return alert('End date must be on or after the start date.');

    const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
    if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');

    const resultEl = document.getElementById('g-result');
    resultEl.innerHTML = 'Generating…';
    const { menuId, resultDays, warnings } = await window.api.generateMenu({
      sectionCode: sectionSelect.value, label, startDate, numWeekdays, createdBy,
    });
    state.currentGeneratedMenuId = menuId;
    renderMenuResult(resultEl, menuId, resultDays, warnings, createdBy);
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
      <div><h1>History</h1><span class="section-pill">Every generated menu, all sections</span></div>
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
    <table class="history-table">
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
    </table>
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
          ? await window.api.exportAllSectionsToExcel({ menuIdsBySection: entry.menuIdsBySection })
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

function renderBuildMenuView(main) {
  if (!state.builder.activeSection) state.builder.activeSection = state.sections[0].code;

  main.innerHTML = `
    <div class="build-scroll">
      <div class="topbar">
        <div><h1>Build Menu</h1><span class="section-pill">Pick every dish yourself</span></div>
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
    const slots = slotDefs.map(({ categoryCode, count }) => {
      const items = itemsByCategory[categoryCode] || [];
      const dailyItems = items.filter(i => i.is_daily_repeating).slice(0, count);
      return { categoryCode, count, isDaily: dailyItems.length > 0, dailyItems, eligibleItems: items };
    });

    const selections = {};
    for (const slot of slots) {
      if (slot.isDaily) continue;
      for (const day of state.builder.days) {
        for (let idx = 0; idx < slot.count; idx++) {
          selections[builderSelectionKey(day.date, slot.categoryCode, idx)] = '';
        }
      }
    }
    state.builder.sections[section.code] = { slots, selections };
  }));

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
      updateBuilderCompleteness();
    });
  });
}

// Renders one day as a vertical table (category column on the left, item rows stacked
// top-to-bottom underneath), matching the row-per-item layout of the Excel blank menu
// template (see buildSchoolTemplateSheet in lib/export.js) instead of a horizontal card grid.
function renderBuilderDayTable(code, day, section, catName) {
  const rows = [];
  section.slots.forEach(slot => {
    const label = catName[slot.categoryCode] || slot.categoryCode.replace(/_/g, ' ');
    if (slot.isDaily) {
      slot.dailyItems.forEach(it => {
        rows.push({ label, cellHtml: `<span class="item-name">${it.name}</span>` });
      });
    } else {
      for (let idx = 0; idx < slot.count; idx++) {
        const key = builderSelectionKey(day.date, slot.categoryCode, idx);
        const current = state.builder.sections[code].selections[key] || '';
        rows.push({
          label,
          cellHtml: `
            <select class="builder-select" data-key="${key}">
              <option value="">— choose —</option>
              ${slot.eligibleItems.map(it => `<option value="${it.id}" ${String(it.id) === current ? 'selected' : ''}>${it.name}</option>`).join('')}
            </select>`,
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

  const { resultDays, warnings } = await window.api.builderFillSuggestions({ sectionCode: code, startDate, numWeekdays });
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
          slot.eligibleItems.push({ id: item.id, name: item.name });
        }
      });
    }
  }

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

  const result = await window.api.exportAllSectionsToExcel({ menuIdsBySection });
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
// EXPORT ALL SECTIONS VIEW
// ============================================================
async function renderExportAllView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Export All Sections</h1><span class="section-pill">One click, one workbook</span></div>
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
    <div id="ea-result" style="margin-top:16px;"></div>
  `;

  wireDateRangeFields('ea-start', 'ea-end', 'ea-day-count');

  document.getElementById('ea-generate-btn').addEventListener('click', async () => {
    const label = document.getElementById('ea-label').value.trim() || 'Untitled Menu';
    const createdBy = document.getElementById('ea-created-by').value.trim() || null;
    const startDate = document.getElementById('ea-start').value;
    const endDate = document.getElementById('ea-end').value;
    if (!startDate || !endDate) return alert('Please choose a start and end date.');
    if (endDate < startDate) return alert('End date must be on or after the start date.');

    const numWeekdays = await window.api.getSchoolDayCount({ startDate, endDate });
    if (numWeekdays < 1) return alert('That date range has no school days (Sun-Thu) in it.');

    const resultEl = document.getElementById('ea-result');
    resultEl.textContent = 'Generating all 5 sections and exporting…';

    const result = await window.api.generateAndExportAll({ label, startDate, numWeekdays, createdBy });

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
    `;
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

async function renderRecipeListView(main, ns) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>${ns.title}</h1><span class="section-pill">${ns.subtitle}</span></div>
      <div style="display:flex; gap:10px; align-items:center;">
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
    <div style="margin-bottom:14px; display:flex; align-items:center; gap:10px;">
      <button class="secondary" id="export-selected-btn" disabled>Export Selected</button>
      ${exportLanguagePickerHtml('list')}
      <button class="secondary" id="delete-selected-btn" disabled>Delete Selected</button>
    </div>
    <div id="recipes-content">Loading…</div>
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
      // Visible spinner + indeterminate progress bar -- the extraction call is a single-shot
      // Anthropic API round trip through the Edge Function, with no real progress fraction to
      // report, so this is deliberately indeterminate rather than a fake percentage.
      const fileWord = files.length === 1 ? 'photo' : 'photos';
      progressWrap.innerHTML = `
        <div class="extract-progress">
          <div class="extract-progress-row">
            <span class="extract-progress-spinner"></span>
            <span>Extracting recipe from ${files.length} ${fileWord}… this can take a few seconds.</span>
          </div>
          <div class="extract-progress-track"><div class="extract-progress-bar"></div></div>
        </div>
      `;
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
        progressWrap.innerHTML = '';
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
        <table class="recipes-table">
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
        </table>
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
    const originalLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    // Bug found in production: this had no try/catch at all -- when the underlying IPC call
    // rejected (e.g. a translation failure), the exception escaped this handler uncaught and
    // every line below (resetting the button) never ran, leaving it stuck on "Exporting…"
    // forever with no visible error. Looked like an infinite hang; was actually a fast failure
    // with nothing to surface it. See conversation notes.
    const unsubscribe = window.api.onExportProgress((message) => { exportBtn.textContent = message; });
    try {
      const result = await ns.api.exportSelected([...selected], getSelectedExportLanguage('list'));
      if (result.success) alert(`Exported to ${result.path}`);
      else if (!result.cancelled) alert('Export failed.');
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      unsubscribe();
      exportBtn.textContent = originalLabel;
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
          <tr><td>${ing.name}</td><td>${ing.quantity}</td><td>${ing.unit}</td><td>${ing.method}</td></tr>
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
            ${(proc.wastes || []).map(w => `<div class="preview-field"><span class="preview-field-label">${w.name}</span><span>${w.percent}%</span></div>`).join('')}
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
  totalEl.value = `${roundNice(totalQty)} G`;

  const netWeight = compoundWasteYield(totalQty, proc.wastes);
  yieldEl.value = `${netWeight} G`;

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
  yieldEl.value = `${roundedSum} G`;

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
      <td><input class="rf-ing-qty" value="${row.quantity}" /></td>
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

function renderProcessWasteRow(proc, w) {
  return `
    <div class="process-waste-row" data-waste="${w.localId}">
      <span class="process-waste-name" dir="auto">${w.name}</span>
      <input type="number" min="0" max="100" step="0.1" id="ew-waste-${proc.localId}-${w.localId}" class="process-waste-percent" value="${w.percent ?? ''}" />
      <span class="process-waste-percent-sign">%</span>
      <button type="button" class="icon-btn" data-update-waste="${w.localId}" ${wasteRowIsChanged(w) ? '' : 'hidden'}>Update</button>
      <button type="button" class="icon-btn danger" data-remove-waste="${w.localId}">Remove</button>
    </div>
  `;
}

function renderProcessWastes(proc, wasteTypes, onChange) {
  const rowsEl = document.getElementById(`ep-wastes-${proc.localId}`);
  const selectEl = document.querySelector(`[data-add-waste="${proc.localId}"]`);
  if (!rowsEl || !selectEl) return;

  rowsEl.innerHTML = proc.wastes.length > 0
    ? proc.wastes.map(w => renderProcessWasteRow(proc, w)).join('')
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

async function renderRecipeFormView(main, ns) {
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
        <span class="section-pill">${editing ? recipe.code : `${ns.codeLabel} code assigned after saving`}</span>
      </div>
      <button class="secondary" id="rf-back-btn">${ns.backLabel}</button>
    </div>

    <div class="generate-controls">
      <div class="field"><label>Recipe Name</label><input id="rf-name" value="${recipe?.name || ''}" dir="auto" /></div>
      <div class="field"><label>Quantity Produced</label><input id="rf-qty" value="${recipe?.quantity_produced || ''}" dir="auto" /></div>
      <div class="field"><label>Portion Weight (g)</label><input id="rf-portion-weight" type="number" min="0" step="0.1" value="${recipe?.portion_weight_grams ?? ''}" /></div>
      <div class="field"><label>Prepared By</label><input id="rf-prepared-by" value="${recipe?.prepared_by || ''}" dir="auto" /></div>
      <div class="field"><label>Category</label><input id="rf-category" value="${recipe?.category || ''}" dir="auto" /></div>
      <div class="field"><label>Country/Origin</label><input id="rf-country" value="${recipe?.country_origin || ''}" dir="auto" /></div>
      <div class="field"><label>Net Weight (sum of processes)</label><input id="rf-yield" value="${recipe?.yield_notes || ''}" readonly /></div>
      <div class="field"><label>Portions Produced</label><div class="computed-value-box" id="rf-portions-produced">–</div></div>
      <div class="field"><label>Date</label><input id="rf-date" type="date" value="${recipe?.date_created || ''}" /></div>
    </div>

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
      <input type="file" id="rf-photo-input" accept="image/jpeg,image/png" multiple />
    </div>
    ` : `
    <div class="field" style="margin-bottom:16px; max-width:320px;">
      <label>Upload Photo</label>
      <input type="file" id="rf-photo-input" accept="image/jpeg,image/png" />
      <div id="rf-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="rf-photo-preview" src="${currentPhotoSrc || ''}" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block;" />
        <button type="button" class="secondary" id="rf-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>
    `}
    <div class="field" style="margin-bottom:20px; max-width:320px;">
      <label>Checked By</label>
      <input id="rf-checked-by" value="${recipe?.checked_by || ''}" dir="auto" />
    </div>

    <button class="primary" id="rf-save-btn">${editing ? 'Save Changes' : 'Save Recipe'}</button>
    <span id="rf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

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
        ? tiles.map(t => `
            <div class="photo-thumb">
              <img src="${t.src}" />
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

    renderPhotoGallery();
  } else {
    function updatePhotoPreview() {
      const src = s.pendingPhoto
        ? s.pendingPhoto.dataUrl
        : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);
      document.getElementById('rf-photo-preview-wrap').style.display = src ? '' : 'none';
      document.getElementById('rf-photo-preview').src = src || '';
    }

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
  }

  function renderProcessCards() {
    const container = document.getElementById('ep-process-list');
    container.innerHTML = s.processes.map((proc, idx) => `
      <div class="process-card" data-process="${proc.localId}">
        <div class="process-card-head">
          <input class="process-name-input" value="${proc.name}" dir="auto" />
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
          <input id="ep-yield-${proc.localId}" readonly />
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

// Called once per process being scaled (renderCalculatorView/renderScaledRecipeResult) -- Recipe
// Book and Recipe Extractor share this, since both are process-shaped now.
function scaleIngredients(ingredients, multiplier) {
  return ingredients.map(ing => ({
    ...ing,
    quantity: (ing.quantity === null || ing.quantity === undefined || ing.quantity === '')
      ? ing.quantity
      : roundNice(parseFloat(ing.quantity) * multiplier),
  }));
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

function renderCalculatorView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Recipe Calculator</h1><span class="section-pill">Scale a recipe -- export only, nothing is saved</span></div>
    </div>

    <div class="generate-controls">
      <div class="field" style="max-width:220px;">
        <label>Source</label>
        <div class="mode-toggle">
          <button type="button" class="mode-toggle-btn active" data-source="book">Recipe Book</button>
          <button type="button" class="mode-toggle-btn" data-source="extractor">Recipe Extractor</button>
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
        <div class="field" style="max-width:260px;">
          <label>Scaling Mode</label>
          <div class="mode-toggle">
            <button type="button" class="mode-toggle-btn active" data-mode="factor">Multiply by factor</button>
            <button type="button" class="mode-toggle-btn" data-mode="target">Scale to target quantity</button>
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
      </div>
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
  // Tracks whether the currently-open list is the "browse all" list specifically, so a second
  // click on the browse button closes it instead of just re-opening the same full list -- but
  // starting to type (which hands the list over to wireRecipeAutocomplete's own search results)
  // clears it, so browse always shows the full list fresh rather than silently closing search results.
  let browseListShowing = false;

  function currentNs() {
    return source === 'book' ? RECIPE_NS.book : RECIPE_NS.extractor;
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
    perProcessScaling = new Map();
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
    } else {
      qtyOriginalLabel.textContent = 'Total Ingredient Quantity (original)';
      qtyOriginalInput.value = `${sumIngredientQuantities(selectedIngredients || [])}g`;
    }
  }

  // Decides which scaling UI applies: the single shared Mode/Multiplier/Target block at the top
  // (a specific process is selected, or the recipe has only one process to begin with --
  // unchanged from before the per-process feature) vs. one independent scaling control per
  // process ("All Processes" resolves to 2+ processes), rendered inline above each process's own
  // section by renderCalcProcessCards -- see perProcessScaling. Rebuilds the Map's KEY SET to
  // match whichever processes are currently shown, but PRESERVES each still-present process's own
  // existing entry (mode/multiplier/target she's already typed) rather than resetting it --
  // called after Add/Remove/Reorder Process (via onProcessStructureChanged) as well as recipe
  // pick/process-filter change, and only the newly-shown-for-the-first-time processes should ever
  // get fresh defaults; a process that already existed shouldn't lose what she typed just because
  // she added or removed some OTHER process.
  function updateScalingControlsVisibility() {
    const scaled = processesToScale();
    if (scaled.length > 1) {
      singleScaleFields.style.display = 'none';
      const next = new Map();
      scaled.forEach(p => next.set(p.localId, perProcessScaling.get(p.localId) || { mode: 'factor', multiplier: '1', target: '' }));
      perProcessScaling = next;
    } else {
      singleScaleFields.style.display = 'contents';
      perProcessScaling = new Map();
      updateQtyOriginalDisplay();
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
      // Clears whichever field she's leaving AND the one she's arriving at -- regardless of
      // direction -- so a value typed under the previous mode (e.g. Multiplier "20") never
      // silently carries over and reappears if she switches back later.
      multiplierInput.value = '';
      targetInput.value = '';
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

    if (scaled.length > 1) {
      // Independent per-process scaling -- validate every process's own control (read from
      // perProcessScaling, kept live by the inline controls renderScaledRecipeResult renders
      // above each process's own section) and collect every error at once (unlike the
      // single-control path below, more than one process can be invalid at the same time),
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
          // measured against Poolish's ingredients too, unlike the single-control path's target
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
      let multiplier;
      if (scalingMode === 'factor') {
        multiplier = parseFloat(multiplierInput.value);
        if (!multiplier || multiplier <= 0) return alert('Please enter a multiplier greater than 0.');
      } else {
        const result = computeMultiplierFromTarget(selectedIngredients, targetInput.value);
        if (result.error) {
          modeErrorEl.textContent = result.error;
          modeErrorEl.style.display = 'block';
          return;
        }
        multiplier = result.multiplier;
      }
      scaled[0].multiplier = multiplier;
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

function renderCalcProcessWasteRow(proc, w) {
  return `
    <div class="process-waste-row" data-waste="${w.localId}">
      <span class="process-waste-name" dir="auto">${w.name}</span>
      <input type="number" min="0" max="100" step="0.1" id="calc-waste-${proc.localId}-${w.localId}" class="process-waste-percent" value="${w.percent ?? ''}" />
      <span class="process-waste-percent-sign">%</span>
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

  rowsEl.innerHTML = proc.wastes.length > 0
    ? proc.wastes.map(w => renderCalcProcessWasteRow(proc, w)).join('')
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
// Quantity is the one column NOT bound to the persistent row: process.ingredientRows[].quantity
// is the immutable 1x basis (set once, at working-copy build time, and never touched by scaling),
// so process.scaledIngredients is (re)computed fresh here on every call -- from ingredientRows x
// process.multiplier -- and the Quantity input is bound to THAT instead, preserving the original
// quantity-edit contract: freely hand-overridable for this one calculation, reset back to
// multiplier x original on the next Calculate. Name/Unit/Method bind directly to the persistent
// row, so those edits (and row add/remove/reorder) survive future Calculate clicks.
function renderCalcIngredientRows(process, tbodyEl, onChange) {
  process.scaledIngredients = scaleIngredients(process.ingredientRows, process.multiplier ?? 1);

  tbodyEl.innerHTML = process.ingredientRows.map((row, i) => `
    <tr data-row="${row.localId}">
      <td class="row-drag-handle-cell"><span class="row-drag-handle" data-drag-handle="${row.localId}" draggable="true" title="Drag to reorder">⠿</span></td>
      <td><input class="calc-ing-name" value="${row.name}" dir="auto" /></td>
      <td><input class="calc-ing-qty" value="${process.scaledIngredients[i].quantity ?? ''}" /></td>
      <td><input class="calc-ing-unit" value="${row.unit}" /></td>
      <td><input class="calc-ing-method" value="${row.method}" dir="auto" /></td>
      <td style="text-align:right"><button type="button" class="icon-btn danger" data-row-remove="${row.localId}">Remove</button></td>
    </tr>
  `).join('');

  process.ingredientRows.forEach((row, i) => {
    const tr = tbodyEl.querySelector(`tr[data-row="${row.localId}"]`);
    tr.querySelector('.calc-ing-name').addEventListener('input', (e) => { row.name = e.target.value; });
    tr.querySelector('.calc-ing-unit').addEventListener('input', (e) => { row.unit = e.target.value; });
    tr.querySelector('.calc-ing-method').addEventListener('input', (e) => { row.method = e.target.value; });
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
        <input class="process-name-input" value="${proc.name}" dir="auto" placeholder="Process name" />
        <span style="font-size:12px; color:var(--neutral); font-weight:400;">×${roundNice(proc.multiplier ?? 1)}</span>
        <button type="button" class="icon-btn" data-move-process-up="${proc.localId}" title="Move process up" aria-label="Move process up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="icon-btn" data-move-process-down="${proc.localId}" title="Move process down" aria-label="Move process down" ${idx === processesShown.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="icon-btn danger" data-remove-process="${proc.localId}" ${workingProcesses.length <= 1 ? 'disabled' : ''}>Remove Process</button>
      </div>
      ${perProcessScaling && perProcessScaling.has(proc.localId) ? renderInlineProcessScalingControls(proc, perProcessScaling.get(proc.localId)) : ''}
      <table class="recipe-ingredients-table">
        <thead><tr><th></th><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Method</th><th></th></tr></thead>
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
  // Each shown process's own scaled view, derived fresh from its persistent 1x-basis
  // ingredientRows and its own `multiplier` (set directly on the object by Calculate, or forced
  // to 1 by renderResultView(true) -- see renderCalculatorView). Recomputed here up front so the
  // header's combined Net Weight/Quantity Produced figures below have something to read; each
  // process's own numbers are re-derived the same way by refreshProcessCalc as she edits.
  processesShown.forEach(proc => {
    proc.scaledIngredients = scaleIngredients(proc.ingredientRows, proc.multiplier ?? 1);
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
          <div class="field"><label>Prepared By</label><input id="calc-prepared-by" value="${recipe.prepared_by || ''}" dir="auto" /></div>
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

        <div style="display:flex; align-items:center; gap:10px;">
          <button class="primary" id="calc-export-btn">Export to Excel</button>
          ${exportLanguagePickerHtml('calc')}
        </div>
        <span id="calc-export-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
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
    const statusEl = document.getElementById('calc-export-status');
    btn.disabled = true;
    statusEl.textContent = 'Exporting…';
    // See the List "Export Selected" handler's comment -- same missing-try/catch bug fixed here.
    const unsubscribe = window.api.onExportProgress((message) => { statusEl.textContent = message; });
    try {
      // Strips this recipe's own (unscaled, full-set) `processes`/`photos` before sending --
      // export-scaled-extracted-recipe re-fetches Extractor photos fresh by recipeId itself (a
      // no-op for Recipe Book, whose export-scaled-recipe handler ignores recipeId and reads
      // photo_path off `recipe` directly instead), and the shown processes below are the ones
      // that actually belong in the export, not the full working-copy set.
      const { processes: _origProcesses, photos: _origPhotos, ...recipeFields } = recipe;
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
      };
      // ingredient_name (not `name`) is what lib/export.js/the translate step actually read --
      // scaledIngredients rows carry `name` (the working copy's own field, from
      // buildProcessFromSaved) since this payload is the one place that distinction matters.
      const exportProcesses = processesShown.map(p => ({
        name: p.name,
        method: collectTextListFieldValue(p, makeProcessMethodCfg(p)),
        wastes: p.wastes,
        ingredients: (p.scaledIngredients || []).map(ing => ({
          ingredient_name: ing.name, quantity: ing.quantity, unit: ing.unit, method: ing.method,
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
      });
      if (result.success) statusEl.textContent = `Exported to ${result.path}`;
      else if (!result.cancelled) statusEl.textContent = 'Export failed.';
      else statusEl.textContent = '';
    } catch (err) {
      statusEl.textContent = `Export failed: ${err.message}`;
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
      <div><h1>Ingredients</h1><span class="section-pill">Canonical ingredient master</span></div>
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
    <div id="ingredients-content">Loading…</div>
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
      <table class="items-table">
        <thead><tr><th>Category</th><th>Product Code</th><th>Name</th><th>Default Unit</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
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
        <table class="items-table">
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
        </table>
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
      <div><h1>Extracted Ingredients</h1><span class="section-pill">Recipe Extractor ingredient list (EX-IN-)</span></div>
    </div>
    <div class="search-bar">
      <label for="extracted-ingredient-search">Search by name</label>
      <input id="extracted-ingredient-search" type="search" />
    </div>
    <div id="extracted-ingredients-content">Loading…</div>
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
      <table class="items-table">
        <thead><tr><th>Product Code</th><th>Name</th><th>Default Unit</th><th></th></tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
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
};

// Every possible dimension column, camelCase form key -> snake_case DB column -- shared by
// materialDimsFromRow (loading) and buildMaterialDimensionPayload (saving) so the two can never
// drift out of sync with main.js's own save-material `fields` object.
const MATERIAL_DIMENSION_DB_KEYS = {
  diameterCm: 'diameter_cm', lengthCm: 'length_cm', widthCm: 'width_cm', heightCm: 'height_cm',
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
      <label>${f.label}</label>
      <input id="mf-dim-${f.key}" type="number" min="0" step="${f.step}" value="${existingValues?.[f.key] ?? ''}" />
    </div>
  `).join('');
}

function readMaterialDims(shapeType) {
  const preset = MATERIAL_SHAPE_PRESETS[shapeType];
  const dims = {};
  preset.fields.forEach(f => {
    const el = document.getElementById(`mf-dim-${f.key}`);
    const raw = el ? el.value.trim() : '';
    dims[f.key] = raw === '' ? null : parseFloat(raw);
  });
  return dims;
}

// Always sends every possible dimension column, nulling out whichever ones don't belong to the
// CURRENT shape -- so switching a material from e.g. Muffin Tray to Round before saving doesn't
// leave stale cup_* values behind in the row.
function buildMaterialDimensionPayload(shapeType) {
  const current = readMaterialDims(shapeType);
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

  function render() { renderer.render(scene, camera); }

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

  function setShape(shapeType, dims) {
    if (group) { scene.remove(group); disposeGroup(group); group = null; }
    const built = buildMaterialGroup(shapeType, dims);
    if (!built) { render(); return; }
    group = built;
    scene.add(group);

    // Frames the camera (and the key light + its shadow frustum, below) to the built shape's own
    // size, so a tiny loaf pan and a huge sheet tray both fill the preview reasonably and both
    // get a correctly-scaled shadow -- rather than one fixed setup tuned for a single size.
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(target);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    radius = maxDim * 2.2;

    ground.position.y = box.min.y;

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

  return {
    setShape,
    resize,
    dispose() {
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('wheel', onWheel);
      if (group) disposeGroup(group);
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

// Builds a genuinely hollow, open-top rectangular container (floor + 4 walls, five separate box
// meshes) rather than one solid block -- plain box primitives instead of an extruded/holed shape
// or a CSG subtraction, so normals/UVs behave predictably with no exotic-geometry edge cases.
// Every mesh gets its own real inner faces (visible when looking down into it) and casts/receives
// shadow, which is what actually makes the inside read as recessed -- see createMaterialPreview3D.
function addHollowBox(group, l, w, h, mat) {
  const wallT = Math.min(Math.max(Math.min(l, w) * 0.045, 0.3), 2, Math.min(l, w) * 0.4);
  const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
  const innerH = Math.max(h - floorT, 0.1);
  const sideDepth = Math.max(w - 2 * wallT, 0.1);

  function addMesh(geo, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  addMesh(new THREE.BoxGeometry(l, floorT, w), 0, floorT / 2, 0); // floor
  addMesh(new THREE.BoxGeometry(l, innerH, wallT), 0, floorT + innerH / 2, -w / 2 + wallT / 2); // back wall
  addMesh(new THREE.BoxGeometry(l, innerH, wallT), 0, floorT + innerH / 2, w / 2 - wallT / 2); // front wall
  addMesh(new THREE.BoxGeometry(wallT, innerH, sideDepth), -l / 2 + wallT / 2, floorT + innerH / 2, 0); // left wall
  addMesh(new THREE.BoxGeometry(wallT, innerH, sideDepth), l / 2 - wallT / 2, floorT + innerH / 2, 0); // right wall
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
function buildMaterialGroup(shapeType, dims) {
  const group = new THREE.Group();

  if (shapeType === 'round') {
    const { diameterCm: d, heightCm: h } = dims;
    if (!(d > 0) || !(h > 0)) return null;
    const outerR = d / 2;
    const wallT = Math.min(Math.max(outerR * 0.07, 0.3), 1.8, outerR * 0.4);
    const floorT = Math.min(Math.max(h * 0.15, 0.3), 1.5, h * 0.6);
    const innerR = Math.max(outerR - wallT, 0.05);
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
  } else if (shapeType === 'rectangular') {
    const { lengthCm: l, widthCm: w, heightCm: h } = dims;
    if (!(l > 0) || !(w > 0) || !(h > 0)) return null;
    addHollowBox(group, l, w, h, MATERIAL_STEEL);
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
  } else {
    return null;
  }

  return group;
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
      <div><h1>Materials</h1><span class="section-pill">Trays, molds &amp; pans</span></div>
      <button class="primary" id="add-material-btn">+ Add Material</button>
    </div>
    <div class="search-bar">
      <label for="material-search">Search by name or code</label>
      <input id="material-search" type="search" />
    </div>
    <div id="materials-content">Loading…</div>
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

    content.innerHTML = `
      <table class="materials-table">
        <thead><tr><th>Code</th><th>Name</th><th>Shape</th><th>Dimensions</th><th>Weight (g)</th><th></th></tr></thead>
        <tbody>
          ${filtered.map(m => `
            <tr>
              <td>${m.code}</td>
              <td>${m.name}</td>
              <td>${MATERIAL_SHAPE_PRESETS[m.shape_type]?.label || m.shape_type}</td>
              <td>${formatMaterialDimensions(m)}</td>
              <td>${formatMaterialWeight(m)}</td>
              <td style="text-align:right">
                <button class="icon-btn" data-edit="${m.id}">Edit</button>
                <button class="icon-btn danger" data-delete="${m.id}">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
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

  const currentPhotoSrc = s.pendingPhoto ? s.pendingPhoto.dataUrl : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);
  const initialShape = material?.shape_type || 'round';

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${editing ? 'Edit Material' : 'New Material'}</h1>
        <span class="section-pill">${editing ? material.code : 'MS code assigned after saving'}</span>
      </div>
      <button class="secondary" id="mf-back-btn">← Back to Materials</button>
    </div>

    <div class="generate-controls">
      <div class="field"><label>Name</label><input id="mf-name" value="${material?.name || ''}" dir="auto" /></div>
      <div class="field" style="max-width:240px;">
        <label>Shape Type</label>
        <select id="mf-shape">
          ${Object.entries(MATERIAL_SHAPE_PRESETS).map(([key, p]) => `<option value="${key}" ${initialShape === key ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="max-width:200px;">
        <label id="mf-weight-label">Weight (g)</label>
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
      <label>Photo (optional)</label>
      <input type="file" id="mf-photo-input" accept="image/jpeg,image/png" />
      <div id="mf-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="mf-photo-preview" src="${currentPhotoSrc || ''}" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block;" />
        <button type="button" class="secondary" id="mf-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>

    <button class="primary" id="mf-save-btn">${editing ? 'Save Changes' : 'Save Material'}</button>
    <span id="mf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  // Photo -- single-photo model, same pattern as Recipe Book's own (see renderRecipeFormView).
  function updatePhotoPreview() {
    const src = s.pendingPhoto ? s.pendingPhoto.dataUrl : (existingPhotoDataUrl && !s.removePhoto ? existingPhotoDataUrl : null);
    document.getElementById('mf-photo-preview-wrap').style.display = src ? '' : 'none';
    document.getElementById('mf-photo-preview').src = src || '';
  }
  document.getElementById('mf-photo-input').addEventListener('change', (e) => {
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
  document.getElementById('mf-photo-remove-btn').addEventListener('click', () => {
    s.pendingPhoto = null;
    s.removePhoto = true;
    document.getElementById('mf-photo-input').value = '';
    updatePhotoPreview();
  });

  // Dimensions + live 3D preview -- rebuilt whenever the shape type changes (a different field
  // set entirely), refreshed on every dimension keystroke otherwise.
  const preview3D = createMaterialPreview3D(document.getElementById('mf-preview-canvas'));
  const dimensionFieldsEl = document.getElementById('mf-dimension-fields');

  function currentShape() { return document.getElementById('mf-shape').value; }

  function updatePreview() {
    const shape = currentShape();
    const dims = readMaterialDims(shape);
    const hasAllDims = MATERIAL_SHAPE_PRESETS[shape].fields.every(f => dims[f.key] > 0);
    document.getElementById('mf-preview-empty').style.display = hasAllDims ? 'none' : '';
    preview3D.setShape(shape, dims);
  }

  // For muffin_tray, the Weight field means weight PER CUP, not the whole tray -- see
  // materialCapacityGrams's own comment for why every consumer of this catalog value needs to
  // multiply by rows x columns rather than reading weight_grams as a total. Relabels the field
  // and shows the computed total live so it's unambiguous while she's actually entering it, not
  // just after saving.
  function updateWeightLabel() {
    const shape = currentShape();
    const labelEl = document.getElementById('mf-weight-label');
    const hintEl = document.getElementById('mf-weight-hint');
    if (shape !== 'muffin_tray') {
      labelEl.textContent = 'Weight (g)';
      hintEl.textContent = '';
      return;
    }
    labelEl.textContent = 'Weight per Cup (g)';
    const dims = readMaterialDims(shape);
    const weightRaw = document.getElementById('mf-weight').value.trim();
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

  document.getElementById('mf-weight').addEventListener('input', updateWeightLabel);

  renderDimensionsForShape(initialShape, materialDimsFromRow(material));

  document.getElementById('mf-shape').addEventListener('change', () => {
    renderDimensionsForShape(currentShape(), {});
  });

  // The preview canvas has no pixel size of its own (CSS gives its wrapper height:300px, width
  // 100%) -- resize once layout has settled, and again if the window itself resizes while this
  // form stays open.
  requestAnimationFrame(() => preview3D.resize());
  const onWindowResize = () => preview3D.resize();
  window.addEventListener('resize', onWindowResize);

  // This view is torn down and rebuilt fresh on every navigation (same as every other screen in
  // this app), never re-rendered in place -- so the running WebGL context needs an explicit
  // teardown, or every visit to this form leaks another one. Both ways out of this form (Back,
  // successful Save) go through here.
  function leaveForm() {
    window.removeEventListener('resize', onWindowResize);
    preview3D.dispose();
  }

  document.getElementById('mf-back-btn').addEventListener('click', () => {
    leaveForm();
    goBackToMaterialsList();
  });

  document.getElementById('mf-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('mf-name').value.trim();
    if (!name) return alert('Please enter a material name.');

    const statusEl = document.getElementById('mf-status');
    const saveBtn = document.getElementById('mf-save-btn');
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';

    const shape = currentShape();
    const weightRaw = document.getElementById('mf-weight').value.trim();

    const payload = {
      id: s.formId || undefined,
      name,
      shapeType: shape,
      ...buildMaterialDimensionPayload(shape),
      weightGrams: weightRaw === '' ? null : parseFloat(weightRaw),
      removePhoto: s.removePhoto,
    };
    if (s.pendingPhoto) {
      payload.photoBase64 = s.pendingPhoto.base64;
      payload.photoExt = s.pendingPhoto.ext;
    }

    try {
      await window.api.saveMaterial(payload);
      leaveForm();
      goBackToMaterialsList();
    } catch (err) {
      statusEl.textContent = '';
      saveBtn.disabled = false;
      alert(`Save failed: ${err.message}`);
    }
  });
}

init();
