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
                <td>${r.category || ''}</td>
                <td>${r.prepared_by || ''}</td>
                <td>${r.date_created || ''}</td>
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
      <div class="preview-field"><span class="preview-field-label">${labels.preparedBy}</span><span>${header.preparedBy}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.category}</span><span>${header.category}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.countryOrigin}</span><span>${header.countryOrigin}</span></div>
      <div class="preview-field"><span class="preview-field-label">${labels.netWeight}</span><span class="preview-field-strong">${header.netWeight}</span></div>
    </div>
    ${model.processes.map(proc => `
      <div class="preview-process-card">
        <div class="preview-section-label">${proc.name}</div>
        ${proc.ingredients.length ? `
          ${renderPreviewIngredientsTable(labels, proc.ingredients, proc.totalQuantity, false, labels.noteColumnHeader)}
          <div class="preview-fields-grid preview-fields-grid-inline">
            ${proc.quantityProduced ? `<div class="preview-field"><span class="preview-field-label">${labels.quantityProduced}</span><span>${proc.quantityProduced}</span></div>` : ''}
            <div class="preview-field"><span class="preview-field-label">${labels.totalQuantity}</span><span>${proc.totalQuantity}</span></div>
            ${(proc.wastes || []).map(w => `<div class="preview-field"><span class="preview-field-label">${w.name}</span><span>${w.percent}%</span></div>`).join('')}
            <div class="preview-field"><span class="preview-field-label">${labels.netWeight}</span><span class="preview-field-strong">${proc.netWeight}</span></div>
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

// Each process's own Wastes Applied/Net Weight -- reads/writes that one process card's own
// elements (ep-total-<id>/ep-yield-<id>). Returns the computed net weight (a Number) so callers
// summing across every process don't need to re-read the DOM afterward. Shared by Recipe Book
// and Recipe Extractor (both process-shaped since the multi-process migration). Every selected
// waste type is compounded sequentially, not summed -- Qty x (1-w1%) x (1-w2%) x ... -- confirmed
// with the chef; mathematically order-independent (multiplication commutes), so proc.wastes's
// own order only matters for display. Reads proc.wastes directly (kept live by each waste row's
// own 'input' listener, see renderProcessWastes) rather than re-querying every input here.
function updateProcessNetWeight(proc) {
  const totalEl = document.getElementById(`ep-total-${proc.localId}`);
  const yieldEl = document.getElementById(`ep-yield-${proc.localId}`);
  if (!totalEl || !yieldEl) return 0;

  const totalQty = sumIngredientQuantities(proc.ingredientRows);
  totalEl.textContent = `Total Quantity: ${roundNice(totalQty)} G`;

  const netWeight = roundNice((proc.wastes || []).reduce((acc, w) => {
    const raw = parseFloat(w.percent);
    const pct = isNaN(raw) ? 0 : Math.min(Math.max(raw, 0), 100);
    return acc * (1 - pct / 100);
  }, totalQty));
  yieldEl.value = `${netWeight} G`;
  return netWeight;
}

// Recomputes every process's own Total Quantity/Net Weight (via updateProcessNetWeight above)
// and writes the recipe-level Net Weight (rf-yield) as their plain sum -- no recipe-level waste
// is applied on top, matching how neither recipes nor extracted_recipes has its own waste field
// any more (waste lives per-process only, since the multi-process migration).
function updateNetWeightSum(ns) {
  const s = state[ns.stateKey];
  const yieldEl = document.getElementById('rf-yield');
  if (!yieldEl) return;
  const sum = s.processes.reduce((acc, proc) => acc + updateProcessNetWeight(proc), 0);
  yieldEl.value = `${roundNice(sum)} G`;
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
    quantityProduced: '',
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
    quantityProduced: proc.quantity_produced || '',
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
    // Never extracted from the card, same reasoning as quantityProduced below -- a source
    // recipe card wouldn't reliably show a decomposed waste breakdown; chef-entered only.
    wastes: [],
    quantityProduced: '',
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
    <div class="process-waste-row" data-waste="${w.localId}" style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
      <span style="min-width:150px;" dir="auto">${w.name}</span>
      <input type="number" min="0" max="100" step="0.1" id="ew-waste-${proc.localId}-${w.localId}" value="${w.percent ?? ''}" style="width:80px;" />
      <span>%</span>
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
    : `<div style="color:var(--neutral); font-size:12.5px;">No wastes applied.</div>`;

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
      <div class="field"><label>Prepared By</label><input id="rf-prepared-by" value="${recipe?.prepared_by || ''}" dir="auto" /></div>
      <div class="field"><label>Category</label><input id="rf-category" value="${recipe?.category || ''}" dir="auto" /></div>
      <div class="field"><label>Country/Origin</label><input id="rf-country" value="${recipe?.country_origin || ''}" dir="auto" /></div>
      <div class="field"><label>Net Weight (computed, sum of processes)</label><input id="rf-yield" value="${recipe?.yield_notes || ''}" readonly /></div>
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
        <div class="process-calc-row" style="display:flex; gap:16px; align-items:flex-end; margin:0 0 16px; flex-wrap:wrap;">
          <div class="field" style="max-width:160px;">
            <label>Quantity Produced</label>
            <input id="ep-qty-${proc.localId}" value="${proc.quantityProduced || ''}" dir="auto" />
          </div>
          <div id="ep-total-${proc.localId}" class="total-qty-display"></div>
          <div class="field" style="max-width:200px;">
            <label>Net Weight (computed)</label>
            <input id="ep-yield-${proc.localId}" readonly />
          </div>
        </div>
        <div class="field" style="margin:0 0 16px;">
          <label>Wastes Applied</label>
          <div class="process-waste-rows" id="ep-wastes-${proc.localId}"></div>
          <select class="builder-select process-add-waste-select" data-add-waste="${proc.localId}" style="margin-top:6px; max-width:240px;">
            <option value="">+ Add Waste…</option>
          </select>
          <div id="ep-new-waste-${proc.localId}"></div>
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

      const qtyProducedInput = card.querySelector(`#ep-qty-${proc.localId}`);
      qtyProducedInput.addEventListener('input', () => { proc.quantityProduced = qtyProducedInput.value; });

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
      wastes: proc.wastes.map(w => {
        const pct = parseFloat(w.percent);
        return { wasteTypeId: w.wasteTypeId, percent: isNaN(pct) ? 0 : pct };
      }),
      quantityProduced: (proc.quantityProduced || '').trim() || null,
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
// and the "Total Quantity" row in renderScaledRecipeResult, so the two stay in sync.
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

    <!-- Shown instead of #calc-single-scale-fields when "All Processes" resolves to 2+
         processes -- one scaling control per process (own Mode/Multiplier/Target), so each can
         be scaled independently in the same Calculate step. See renderPerProcessScalingControls. -->
    <div id="calc-per-process-controls" style="display:none; margin-bottom:14px;"></div>

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
  const perProcessControlsEl = document.getElementById('calc-per-process-controls');
  const calculateBtn = document.getElementById('calc-calculate-btn');
  const resultEl = document.getElementById('calc-result');

  let source = 'book'; // 'book' | 'extractor'
  let scalingMode = 'factor';
  let selectedRecipe = null;
  // Full recipe is fetched once per selection (below) and cached here -- keeps its own
  // `processes` (each carrying its own ingredients) and, for Extractor, `photos` array intact.
  // Both namespaces are process-shaped since the Recipe Book multi-process migration.
  let selectedFullRecipe = null;
  // The CURRENT scaling pool: the flattened ingredients of whichever process(es)
  // processSelection currently resolves to -- used for the "original" display and the
  // scale-to-target multiplier calc. Actual per-process scaling for export/display still reads
  // the real process objects via processesToScale(), not this flat view -- see
  // renderScaledRecipeResult.
  let selectedIngredients = null;
  // '__all__' or a specific process id string. Irrelevant (and the picker stays hidden) when
  // the recipe has 1 process or fewer.
  let processSelection = null;
  // Tracks whether the currently-open list is the "browse all" list specifically, so a second
  // click on the browse button closes it instead of just re-opening the same full list -- but
  // starting to type (which hands the list over to wireRecipeAutocomplete's own search results)
  // clears it, so browse always shows the full list fresh rather than silently closing search results.
  let browseListShowing = false;

  function currentNs() {
    return source === 'book' ? RECIPE_NS.book : RECIPE_NS.extractor;
  }

  function allProcesses() {
    return (selectedFullRecipe && selectedFullRecipe.processes) || [];
  }

  // Which process objects actually get scaled -- every process when there's only 1 (nothing to
  // choose) or when "All Processes" is picked, just the one matching processSelection otherwise.
  function processesToScale() {
    const procs = allProcesses();
    if (procs.length <= 1 || processSelection === '__all__' || !processSelection) return procs;
    return procs.filter(p => String(p.id) === String(processSelection));
  }

  // Quantity Produced's source: "All Processes", or a genuinely single-process recipe (nothing
  // else to pick) uses the recipe-level field -- a specifically-selected process's own field
  // otherwise, since it can describe a completely independent production context (see
  // renderScaledRecipeResult, which detects this the same structural way).
  function quantityProducedSource() {
    const scaled = processesToScale();
    if (scaled.length === 1 && allProcesses().length > 1) return scaled[0].quantity_produced || '';
    return selectedFullRecipe?.quantity_produced || '';
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
      ...procs.map(p => `<option value="${p.id}">${p.name}</option>`),
    ].join('');
    processSelect.value = processSelection || '__all__';
  }

  function clearSelection() {
    selectedRecipe = null;
    selectedFullRecipe = null;
    selectedIngredients = null;
    processSelection = null;
    processField.style.display = 'none';
    processSelect.innerHTML = '';
    qtyOriginalInput.value = '';
    calculateBtn.disabled = true;
    resultEl.innerHTML = '';
    modeErrorEl.style.display = 'none';
    singleScaleFields.style.display = 'contents';
    perProcessControlsEl.style.display = 'none';
    perProcessControlsEl.innerHTML = '';
  }

  // "Quantity Produced (original)" shows a free-text serving/container count in Multiply-by-
  // factor mode (what it's always meant) -- source picked by quantityProducedSource() above
  // (recipe-level, or a specifically-selected process's own). In Scale-to-target mode that field
  // isn't what the target is measured against -- so it switches to showing the actual basis (the
  // current scaling pool's total ingredient quantity), with the label swapped to match. Only
  // meaningful for the single-control case -- see updateScalingControlsVisibility, which is what
  // actually decides whether this or the per-process cards show.
  function updateQtyOriginalDisplay() {
    if (!selectedFullRecipe) return;
    if (scalingMode === 'factor') {
      const scaled = processesToScale();
      const isProcessLevel = scaled.length === 1 && allProcesses().length > 1;
      qtyOriginalLabel.textContent = isProcessLevel ? 'Quantity Produced (process, original)' : 'Quantity Produced (original)';
      qtyOriginalInput.value = quantityProducedSource();
    } else {
      qtyOriginalLabel.textContent = 'Total Ingredient Quantity (original)';
      qtyOriginalInput.value = `${sumIngredientQuantities(selectedIngredients || [])}g`;
    }
  }

  // Decides which scaling UI applies: the single shared Mode/Multiplier/Target block (a specific
  // process is selected, or the recipe has only one process to begin with -- unchanged from
  // before this feature) vs. one independent scaling control per process ("All Processes"
  // resolves to 2+ processes) -- see renderPerProcessScalingControls.
  function updateScalingControlsVisibility() {
    const scaled = processesToScale();
    if (scaled.length > 1) {
      singleScaleFields.style.display = 'none';
      perProcessControlsEl.style.display = '';
      renderPerProcessScalingControls(scaled);
    } else {
      singleScaleFields.style.display = 'contents';
      perProcessControlsEl.style.display = 'none';
      perProcessControlsEl.innerHTML = '';
      updateQtyOriginalDisplay();
    }
  }

  // One process's own Scaling Mode/Multiplier/Target, in a process-card styled block -- same
  // visual language as the recipe form's own process cards. Built fresh each time "All
  // Processes" resolves to a different process set (a different recipe picked, or a process
  // added/removed from the underlying recipe since -- not expected mid-session, but cheap to
  // just rebuild). Mode toggling/error display is scoped per-card via [data-scale-process],
  // read back at Calculate time -- see the button handler below.
  function renderPerProcessScalingControls(procs) {
    perProcessControlsEl.innerHTML = procs.map(proc => `
      <div class="process-card" data-scale-process="${proc.id}" style="margin-bottom:10px;">
        <div class="process-card-head"><strong>${proc.name}</strong></div>
        <div class="generate-controls" style="border:none; padding:0; margin:10px 0 0; gap:14px;">
          <div class="field" style="max-width:200px;">
            <label>Quantity Produced (original)</label>
            <input value="${proc.quantity_produced || ''}" disabled />
          </div>
          <div class="field" style="max-width:240px;">
            <label>Scaling Mode</label>
            <div class="mode-toggle">
              <button type="button" class="mode-toggle-btn active" data-proc-mode-btn="factor">Multiply by factor</button>
              <button type="button" class="mode-toggle-btn" data-proc-mode-btn="target">Scale to target quantity</button>
            </div>
          </div>
          <div class="field" style="max-width:120px;" data-proc-multiplier-field>
            <label>Multiplier</label>
            <input type="number" step="0.1" min="0" value="1" data-proc-multiplier />
          </div>
          <div class="field" style="max-width:160px; display:none;" data-proc-target-field>
            <label>Target Total Quantity (g)</label>
            <input type="number" step="1" min="0" data-proc-target />
          </div>
        </div>
        <div data-proc-error style="display:none; color:var(--danger, #c0392b); font-size:12px; margin-top:8px;"></div>
      </div>
    `).join('');

    perProcessControlsEl.querySelectorAll('[data-scale-process]').forEach(card => {
      card.querySelectorAll('[data-proc-mode-btn]').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.procModeBtn;
          card.querySelectorAll('[data-proc-mode-btn]').forEach(b => b.classList.toggle('active', b.dataset.procModeBtn === mode));
          card.querySelector('[data-proc-multiplier-field]').style.display = mode === 'factor' ? 'flex' : 'none';
          card.querySelector('[data-proc-target-field]').style.display = mode === 'target' ? 'flex' : 'none';
          card.querySelector('[data-proc-error]').style.display = 'none';
        });
      });
    });
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
      modeErrorEl.style.display = 'none';
      updateQtyOriginalDisplay();
    });
  });

  processSelect.addEventListener('change', () => {
    processSelection = processSelect.value;
    selectedIngredients = processesToScale().flatMap(p => p.ingredients);
    updateScalingControlsVisibility();
  });

  async function onRecipePicked(recipe) {
    selectedRecipe = recipe;
    selectedFullRecipe = null;
    selectedIngredients = null;
    processSelection = null;
    processField.style.display = 'none';
    nameInput.value = recipe.name;
    qtyOriginalInput.value = '…';
    calculateBtn.disabled = true;
    browseListShowing = false;

    const full = await currentNs().api.get(recipe.id);
    if (!selectedRecipe || selectedRecipe.id !== recipe.id) return; // superseded by a later pick

    selectedFullRecipe = full; // keeps .processes (and, for Extractor, .photos) intact
    processSelection = '__all__';
    populateProcessSelect();
    selectedIngredients = processesToScale().flatMap(p => p.ingredients);
    calculateBtn.disabled = false;
    updateScalingControlsVisibility();
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

  calculateBtn.addEventListener('click', () => {
    if (!selectedFullRecipe || !selectedIngredients) return;
    modeErrorEl.style.display = 'none';

    const scaled = processesToScale();
    const multiplierByProcessId = new Map();

    if (scaled.length > 1) {
      // Independent per-process scaling -- validate every process's own control and collect
      // every error at once (unlike the single-control path below, more than one process can be
      // invalid at the same time), rather than stopping at the first.
      let hasError = false;
      for (const proc of scaled) {
        const card = perProcessControlsEl.querySelector(`[data-scale-process="${proc.id}"]`);
        const errorEl = card.querySelector('[data-proc-error]');
        errorEl.style.display = 'none';

        const isTarget = card.querySelector('[data-proc-mode-btn="target"]').classList.contains('active');
        if (!isTarget) {
          const val = parseFloat(card.querySelector('[data-proc-multiplier]').value);
          if (!val || val <= 0) {
            errorEl.textContent = 'Please enter a multiplier greater than 0.';
            errorEl.style.display = 'block';
            hasError = true;
            continue;
          }
          multiplierByProcessId.set(proc.id, val);
        } else {
          // Scoped to this process's OWN ingredients only -- scaling Dough to 5kg shouldn't be
          // measured against Poolish's ingredients too, unlike the single-control path's target
          // mode, which is deliberately measured against whatever pool is currently selected.
          const result = computeMultiplierFromTarget(proc.ingredients, card.querySelector('[data-proc-target]').value);
          if (result.error) {
            errorEl.textContent = result.error;
            errorEl.style.display = 'block';
            hasError = true;
            continue;
          }
          multiplierByProcessId.set(proc.id, result.multiplier);
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
      multiplierByProcessId.set(scaled[0].id, multiplier);
    }

    renderScaledRecipeResult(resultEl, currentNs(), selectedRecipe.id, selectedFullRecipe, scaled, multiplierByProcessId);
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

// Shared by Recipe Book and Recipe Extractor (both process-shaped since the multi-process
// migration). `processes` is either every process on the recipe ("All Processes") or just the
// one the chef picked -- either way each is scaled independently (own ingredients, own waste%,
// and now its own multiplier -- see multiplierByProcessId) and shown as its own section, same
// visual pattern as the form's own process cards and the export sheet's per-process sections,
// rather than merged into one flat list (preserves per-component meaning, and lets the export
// payload below match buildRecipeSheet's shape exactly).
//
// `multiplierByProcessId` is a Map<processId, multiplier> -- always one entry per process in
// `processes`, whether that's a single shared multiplier (the calculator's single-control path,
// which still just puts one entry in the map keyed by that one process's id) or genuinely
// different multipliers per process (the "All Processes" independent-scaling path). This
// function itself never distinguishes the two cases beyond that lookup -- the UI decision of
// "one control or many" lives entirely in renderCalculatorView.
function renderScaledRecipeResult(container, ns, recipeId, recipe, processes, multiplierByProcessId) {
  const scaledProcesses = processes.map(proc => {
    const multiplier = multiplierByProcessId.get(proc.id);
    const scaledIngredients = scaleIngredients(proc.ingredients, multiplier);
    const totalQuantity = sumIngredientQuantities(scaledIngredients);
    // Waste percents themselves are never scaled -- each is a percentage, not a quantity, same
    // reasoning export-scaled-recipe/renderScaledRecipeResult already apply elsewhere. Compounded
    // sequentially against the already-scaled Total Quantity, same formula as
    // updateProcessNetWeight/computeProcessTotals use live in the form/export.
    const netWeight = roundNice((proc.wastes || []).reduce((acc, w) => {
      const pct = w.percent != null ? Math.min(Math.max(parseFloat(w.percent), 0), 100) : 0;
      return acc * (1 - pct / 100);
    }, totalQuantity));
    // Each process's own Quantity Produced scales the same way the recipe-level one always has
    // -- it's a genuinely independent production figure (e.g. a sponge baked as "30 trays" has
    // nothing to do with the finished recipe's "10 cakes"), scaled and shown per process
    // regardless of which selection mode is active (see quantityProducedSource below for the
    // *summary* row, which switches source instead of showing both).
    const scaledQuantityProduced = scaleQuantityProducedText(proc.quantity_produced, multiplier);
    return { ...proc, ingredients: scaledIngredients, totalQuantity, netWeight, scaledQuantityProduced, multiplier };
  });

  // Recipe-level Net Weight is the sum of every shown process's own scaled, waste-adjusted net
  // weight -- same convention updateNetWeightSum uses live in the form.
  const combinedNetWeight = roundNice(scaledProcesses.reduce((sum, p) => sum + p.netWeight, 0));

  // "All Processes" (or a single-process recipe, where there's nothing else to pick) uses the
  // recipe-level Quantity Produced -- the finished dish's overall yield. Scaling one specific
  // process out of several uses THAT process's own instead, since they can describe unrelated
  // production contexts. Detected structurally (exactly one process was handed in, out of a
  // recipe that actually has more than one) rather than from separate UI state, so this can't
  // drift out of sync with what processesToScale() actually resolved.
  const isSingleProcessSelection = processes.length === 1 && (recipe.processes || []).length > 1;
  // 2+ processes scaled together with (possibly) different multipliers each -- there's no
  // longer one coherent scale factor for the recipe-level Quantity Produced to apply, so it's
  // shown unscaled, for context only. Each process's own scaled Quantity Produced still shows on
  // its own card below regardless.
  const isMultiProcessScaling = processes.length > 1;
  const quantityProducedLabel = isSingleProcessSelection ? 'process' : 'recipe';
  const quantityProducedOriginal = isSingleProcessSelection ? processes[0].quantity_produced : recipe.quantity_produced;
  const quantityProducedScaled = isMultiProcessScaling
    ? null
    : (isSingleProcessSelection ? scaledProcesses[0].scaledQuantityProduced : scaleQuantityProducedText(recipe.quantity_produced, scaledProcesses[0].multiplier));

  container.innerHTML = `
    <div class="day-card">
      <div class="day-head">
        <span>${recipe.name}</span>
      </div>
      <div style="padding:16px 18px;">
        <div class="generate-controls" style="border:none; padding:0; margin-bottom:18px;">
          <div class="field"><label>Quantity Produced (${quantityProducedLabel}, original)</label><div>${quantityProducedOriginal || '—'}</div></div>
          <div class="field"><label>Quantity Produced (${quantityProducedLabel}, scaled)</label><div><strong>${quantityProducedScaled || (isMultiProcessScaling ? 'Scaled independently per process' : '—')}</strong></div></div>
          <div class="field"><label>Prepared By</label><div>${recipe.prepared_by || '—'}</div></div>
          <div class="field"><label>Category</label><div>${recipe.category || '—'}</div></div>
          <div class="field"><label>Country/Origin</label><div>${recipe.country_origin || '—'}</div></div>
          <div class="field"><label>Net Weight (scaled, combined)</label><div><strong>${combinedNetWeight} G</strong></div></div>
        </div>

        ${scaledProcesses.map(proc => `
          <div class="process-card">
            <div class="process-card-head"><strong>${proc.name}</strong> <span style="font-size:12px; color:var(--neutral); font-weight:400;">×${roundNice(proc.multiplier)}</span></div>
            <table class="recipe-ingredients-table">
              <thead><tr><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Method</th></tr></thead>
              <tbody>
                ${proc.ingredients.map(ing => `
                  <tr>
                    <td>${ing.ingredient_name}</td>
                    <td>${ing.quantity ?? ''}</td>
                    <td>${ing.unit || ''}</td>
                    <td>${ing.method || ''}</td>
                  </tr>
                `).join('')}
                <tr style="font-weight:600;">
                  <td>Total Quantity</td>
                  <td>${proc.totalQuantity}</td>
                  <td></td>
                  <td></td>
                </tr>
              </tbody>
            </table>
            <div class="generate-controls" style="border:none; padding:0; margin:10px 0 4px;">
              <div class="field" style="max-width:180px;"><label>Quantity Produced (scaled)</label><div><strong>${proc.scaledQuantityProduced || '—'}</strong></div></div>
              ${(proc.wastes || []).map(w => `<div class="field" style="max-width:160px;"><label>${w.name}</label><div>${w.percent}%</div></div>`).join('')}
              <div class="field" style="max-width:200px;"><label>Net Weight (scaled)</label><div><strong>${proc.netWeight} G</strong></div></div>
            </div>
            <div class="field" style="margin-top:8px;">
              <label>Method</label>
              <div style="white-space:pre-wrap;">${proc.method || '—'}</div>
            </div>
          </div>
        `).join('')}

        <div class="field" style="margin:16px 0;">
          <label>Presentation / Decoration / Serving</label>
          <div style="white-space:pre-wrap;">${recipe.presentation_serving || '—'}</div>
        </div>
        <div class="field" style="margin-bottom:16px;">
          <label>Comment</label>
          <div style="white-space:pre-wrap;">${recipe.comment || '—'}</div>
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
      // photo_path off `recipe` directly instead), and the scaled processes below are the ones
      // that actually belong in the export, not the original full set.
      const { processes: _origProcesses, photos: _origPhotos, ...recipeFields } = recipe;
      const exportRecipe = {
        ...recipeFields,
        // Falls back to the original, unscaled recipe-level quantity when processes were scaled
        // independently (quantityProducedScaled is null in that case, see above) -- each
        // process's own scaled Quantity Produced is still exported correctly via exportProcesses
        // below regardless.
        quantity_produced: quantityProducedScaled || recipe.quantity_produced,
        yield_notes: `${combinedNetWeight} G`,
      };
      const exportProcesses = scaledProcesses.map(p => ({
        name: p.name, method: p.method, wastes: p.wastes,
        quantity_produced: p.scaledQuantityProduced, ingredients: p.ingredients,
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

init();
