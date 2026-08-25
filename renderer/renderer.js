const state = {
  sections: [],
  currentSection: null,
  currentView: 'items',
  // Whether Item Catalog's own section sub-list is expanded -- toggled by clicking "Item
  // Catalog" while it's already the active view. Only ever shown while currentView === 'items'.
  itemCatalogExpanded: true,
  categories: [],
  proteinTypes: [],
  currentGeneratedMenuId: null,
  builder: { label: '', startDate: '', numWeekdays: 20, activeSection: null, days: [], sections: {} },
  recipes: {
    view: 'list', formId: null, ingredientRows: [], pendingPhoto: null, removePhoto: false,
    prepMode: null, prepText: '', prepItems: [],
    presentationMode: null, presentationText: '', presentationItems: [],
    // Set by "Import Recipe from File" just before opening a fresh New Recipe form; consumed
    // (and cleared) the moment renderRecipeFormView reads it, so it never leaks into a later
    // plain "+ New Recipe" click -- see renderRecipeFormView's non-editing branch.
    importedRecipe: null,
  },
};

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
// renderExportAllView/renderGenerateView), so replacing them just shows the same screen with
// fresher data underneath. Build Menu (state.builder.sections[...].selections) and an
// in-progress Recipe form (state.recipes.ingredientRows) hold real unsaved work that a
// re-render would silently discard, and an open Add/Edit modal (Item/Ingredient, appended to
// document.body) was populated from data fetched at modal-open time -- none of these should
// ever be touched by a background refresh.
const SAFE_REFRESH_VIEWS = ['items', 'history', 'recipes', 'ingredients', 'exportAll', 'generate'];
function isSafeToForceRerender() {
  if (document.querySelector('.modal-overlay')) return false;
  if (state.currentView === 'build') return false;
  if (state.currentView === 'recipes' && state.recipes.view === 'form') return false;
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

function wireNav() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      // Clicking Item Catalog while it's already open toggles its own section sub-list
      // open/closed, like a normal collapsible nav section; clicking it from anywhere else
      // always opens it expanded. Picking a different nav item just switches views -- the
      // sub-list belongs only to Item Catalog and is hidden for every other view regardless
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
}

function updateActiveViewButtons() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === state.currentView);
  });
}

function updateItemCatalogExpansion() {
  const expanded = state.currentView === 'items' && state.itemCatalogExpanded;
  document.getElementById('section-nav').style.display = expanded ? 'block' : 'none';
  const caret = document.getElementById('items-caret');
  if (caret) caret.textContent = expanded ? '▾' : '▸';
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
  if (state.currentView === 'calculator') return renderCalculatorView(main);
  if (state.currentView === 'ingredients') return renderIngredientsView(main);
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
      <div><h1>Item Catalog</h1><span class="section-pill">${currentSectionName()}</span></div>
      <button class="primary" id="add-item-btn">+ Add Item</button>
    </div>
    <div class="search-bar">
      <input id="item-search" type="search" placeholder="Search items by name…" />
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
        <input id="m-name" value="${isEdit ? existingItem.name : ''}" placeholder="e.g. grilled chicken with rice" />
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
            return `<input data-ag="${ag.code}" placeholder="${ag.name} e.g. 150gm" value="${existing ? existing.quantity + existing.unit : ''}" />`;
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
    const suggestion = await window.api.suggestClassification({ name: nameInput.value, mealPeriod: periodSelect.value });
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

    const result = isEdit
      ? await window.api.updateItem({
          id: existingItem.id, name,
          categoryCode: categorySelect.value,
          proteinCode: proteinSelect.value || null,
          isDailyRepeating: dailyCheckbox.checked,
          isActive: true,
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
// deliberately NOT wired to state.currentSection or the Item Catalog sidebar list. The two
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
        <label>Label</label>
        <input id="g-label" placeholder="e.g. September 2026" />
      </div>
      <div class="field">
        <label>Start date</label>
        <input id="g-start" type="date" />
      </div>
      <div class="field">
        <label>Number of school days</label>
        <input id="g-days" type="number" value="20" min="1" max="60" />
      </div>
      <button class="primary" id="g-generate">Generate Menu</button>
    </div>
    <div id="g-result"></div>
  `;

  const sectionSelect = document.getElementById('g-section');
  const sectionPill = document.getElementById('g-section-pill');
  sectionSelect.addEventListener('change', () => {
    sectionPill.textContent = state.sections.find(s => s.code === sectionSelect.value)?.name || '';
  });

  document.getElementById('g-generate').addEventListener('click', async () => {
    const label = document.getElementById('g-label').value.trim() || 'Untitled Menu';
    const startDate = document.getElementById('g-start').value;
    const numWeekdays = parseInt(document.getElementById('g-days').value, 10);
    if (!startDate) return alert('Please choose a start date.');

    const resultEl = document.getElementById('g-result');
    resultEl.innerHTML = 'Generating…';
    const { menuId, resultDays, warnings } = await window.api.generateMenu({
      sectionCode: sectionSelect.value, label, startDate, numWeekdays,
    });
    state.currentGeneratedMenuId = menuId;
    renderMenuResult(resultEl, menuId, resultDays, warnings);
  });
}

function renderMenuResult(container, menuId, days, warnings) {
  container.innerHTML = `
    ${warnings && warnings.length ? `
      <div class="warning-banner">
        ⚠ ${warnings.length} item(s) had to repeat sooner than 4 weeks — the item catalog doesn't yet have
        enough variety for a full no-repeat cycle. Add more dishes in the Item Catalog to fix this over time.
      </div>` : ''}
    <div style="margin-bottom:14px;">
      <button class="secondary" id="export-btn">Export to Excel</button>
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
    <ul class="history-list">${menus.map(m => `
      <li class="history-item" data-id="${m.id}" ${m.isBatch ? 'title="Bundled export across all sections — no combined detail view, but exportable and deletable as one"' : ''}>
        <span>
          <input type="checkbox" class="history-row-check" data-select="${m.id}" />
          &nbsp; <strong>${m.label}</strong> &nbsp; <span style="color:var(--neutral)">${m.start_date}</span>
        </span>
        <span class="chip daily">${m.tag}</span>
        <span class="chip daily">${m.status}</span>
        <button class="icon-btn history-export-btn" data-export="${m.id}">Export</button>
      </li>
    `).join('')}</ul>
  `;

  const selectAllEl = document.getElementById('history-select-all');
  const deleteBtn = document.getElementById('history-delete-btn');

  function updateDeleteBtn() {
    deleteBtn.disabled = selected.size === 0;
    deleteBtn.textContent = selected.size > 0 ? `Delete Selected (${selected.size})` : 'Delete Selected';
  }

  listEl.querySelectorAll('.history-row-check').forEach(cb => {
    // Stop the click from bubbling to the <li>'s own listener below, which opens the detail view.
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

  listEl.querySelectorAll('[data-id]').forEach(li => {
    const entry = menus.find(m => m.id === li.dataset.id);
    if (!entry || entry.isBatch) return; // no combined detail view across 5 sections
    li.addEventListener('click', async () => {
      const days = await window.api.getGeneratedMenuDetail(entry.menuIds[0]);
      const formattedDays = days.map(d => ({
        date: d.menu_date, weekday: d.day_of_week,
        items: d.items.map(it => ({ category: it.category_code, name: it.name })),
      }));
      state.currentGeneratedMenuId = entry.menuIds[0];
      renderMenuResult(document.getElementById('history-detail'), entry.menuIds[0], formattedDays, []);
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
          <label>Label</label>
          <input id="bm-label" placeholder="e.g. September 2026" value="${state.builder.label}" />
        </div>
        <div class="field">
          <label>Start date</label>
          <input id="bm-start" type="date" value="${state.builder.startDate}" />
        </div>
        <div class="field">
          <label>Number of school days</label>
          <input id="bm-days" type="number" value="${state.builder.numWeekdays}" min="1" max="60" />
        </div>
        <button class="secondary" id="bm-build-btn">Build Grids</button>
        <button class="secondary" id="bm-template-btn">Export Blank Template</button>
        <button class="primary" id="bm-export-btn" disabled>Export</button>
      </div>
      <div id="bm-status" style="color:var(--neutral); font-size:12.5px; margin-bottom:14px;"></div>
      <div id="bm-grid"></div>
    </div>
    <div id="bm-tabs" class="builder-tabs"></div>
  `;

  document.getElementById('bm-build-btn').addEventListener('click', buildAllBuilderGrids);
  document.getElementById('bm-template-btn').addEventListener('click', exportBuilderBlankTemplate);
  document.getElementById('bm-export-btn').addEventListener('click', exportBuilderMenu);

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
  const startDate = document.getElementById('bm-start').value;
  const numWeekdays = parseInt(document.getElementById('bm-days').value, 10);
  if (!startDate) return alert('Please choose a start date.');
  if (!label) return alert('Please enter a label.');

  state.builder.label = label;
  state.builder.startDate = startDate;
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
      <button class="secondary" id="bm-fill-btn">Fill with Suggestions</button>
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
  statusEl.textContent = `Filling ${currentBuilderSectionName(code)} with suggestions…`;

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
    ? `Filled ${currentBuilderSectionName(code)} — ${warnings.length} repeat-rule warning(s) (pool too small for full 4-week variety).`
    : `Filled ${currentBuilderSectionName(code)} with suggestions.`;
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
    statusEl.textContent = `${emptyCount} slot(s) still empty across all sections — fill them in, or use "Fill with Suggestions" on each tab.`;
  } else {
    statusEl.textContent = 'All sections complete — ready to export.';
  }
}

async function exportBuilderMenu() {
  const { label, startDate, days, sections } = state.builder;
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
    const { menuId } = await window.api.saveManualMenu({ sectionCode: code, label, startDate, days: payloadDays });
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
  const numWeekdays = parseInt(document.getElementById('bm-days').value, 10);
  if (!startDate) return alert('Please choose a start date.');

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
      Generates a fresh menu for every section (Daycare, KG - LP, MS - UP (B-G), Staff, CEO) for the
      same date range, then exports them all into one workbook with a tab per section --
      matching your original file's layout.
    </p>
    <div class="generate-controls">
      <div class="field">
        <label>Workbook name</label>
        <input id="ea-label" placeholder="e.g. September 2026" />
      </div>
      <div class="field">
        <label>Start date</label>
        <input id="ea-start" type="date" />
      </div>
      <div class="field">
        <label>Number of school days</label>
        <input id="ea-days" type="number" value="20" min="1" max="60" />
      </div>
      <button class="primary" id="ea-generate-btn">Generate &amp; Export All Sections</button>
    </div>
    <div id="ea-result" style="margin-top:16px;"></div>
  `;

  document.getElementById('ea-generate-btn').addEventListener('click', async () => {
    const label = document.getElementById('ea-label').value.trim() || 'Untitled Menu';
    const startDate = document.getElementById('ea-start').value;
    const numWeekdays = parseInt(document.getElementById('ea-days').value, 10);
    if (!startDate) return alert('Please choose a start date.');

    const resultEl = document.getElementById('ea-result');
    resultEl.textContent = 'Generating all 5 sections and exporting…';

    const result = await window.api.generateAndExportAll({ label, startDate, numWeekdays });

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
          -- add more items to those categories in the Item Catalog to improve variety over time.
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
  if (state.recipes.view === 'form') return renderRecipeFormView(main);
  return renderRecipeListView(main);
}

// Shared by both form-entry points and "Back to Recipe Book" -- clears every piece of
// in-progress form state so the next renderRecipeFormView() call re-initializes it fresh
// from whichever recipe (or blank slate) it's opening.
function resetRecipeFormState() {
  state.recipes.ingredientRows = [];
  state.recipes.pendingPhoto = null;
  state.recipes.removePhoto = false;
  state.recipes.prepMode = null;
  state.recipes.prepText = '';
  state.recipes.prepItems = [];
  state.recipes.presentationMode = null;
  state.recipes.presentationText = '';
  state.recipes.presentationItems = [];
}

function openNewRecipeForm() {
  state.recipes.view = 'form';
  state.recipes.formId = null;
  resetRecipeFormState();
  renderView();
}

function openEditRecipeForm(id) {
  state.recipes.view = 'form';
  state.recipes.formId = id;
  resetRecipeFormState();
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

async function renderRecipeListView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Recipe Book</h1><span class="section-pill">Company recipe cards</span></div>
      <div style="display:flex; gap:10px;">
        <button class="secondary" id="import-recipe-btn">Import Recipe from File</button>
        <button class="primary" id="new-recipe-btn">+ New Recipe</button>
      </div>
    </div>
    <input type="file" id="import-recipe-input" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" hidden />
    <div class="search-bar">
      <input id="recipe-search" type="search" placeholder="Search by name or TTY code…" />
    </div>
    <div style="margin-bottom:14px;">
      <button class="secondary" id="export-selected-btn" disabled>Export Selected</button>
      <button class="secondary" id="delete-selected-btn" disabled>Delete Selected</button>
    </div>
    <div id="recipes-content">Loading…</div>
  `;
  document.getElementById('new-recipe-btn').addEventListener('click', openNewRecipeForm);

  const importBtn = document.getElementById('import-recipe-btn');
  const importInput = document.getElementById('import-recipe-input');
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // always reset so picking the same file twice still fires 'change'
    if (!file) return;

    importBtn.disabled = true;
    importBtn.textContent = 'Extracting recipe…';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      const result = await window.api.extractRecipeFromFile({ base64, mimeType: file.type });
      if (!result.success) {
        alert(`Couldn't extract this file: ${result.error || 'unknown error'}. Opening a blank recipe instead — you can fill it in manually.`);
        openNewRecipeForm();
        return;
      }
      // openNewRecipeForm() resets and re-renders the form synchronously, so importedRecipe
      // must be set first -- renderRecipeFormView reads it on its very first (synchronous)
      // pass through the non-editing branch, before this function would get a chance to set it
      // afterward.
      state.recipes.importedRecipe = result.recipe;
      openNewRecipeForm();
    } catch (err) {
      alert(`Couldn't extract this file: ${err.message}. Opening a blank recipe instead — you can fill it in manually.`);
      openNewRecipeForm();
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = 'Import Recipe from File';
    }
  });

  const recipes = await window.api.listRecipes();
  const searchInput = document.getElementById('recipe-search');
  const content = document.getElementById('recipes-content');
  const exportBtn = document.getElementById('export-selected-btn');
  const deleteSelectedBtn = document.getElementById('delete-selected-btn');
  const selected = new Set();

  if (recipes.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No recipes yet</div>Click "+ New Recipe" to create the first one.</div>`;
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

    content.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openEditRecipeForm(parseInt(btn.dataset.edit, 10)));
    });
    content.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.delete, 10);
        const recipe = recipes.find(r => r.id === id);
        if (!confirm(`Delete "${recipe.name}" (${recipe.code})? This cannot be undone.`)) return;
        await window.api.deleteRecipe(id);
        renderRecipeListView(main);
      });
    });
  }

  exportBtn.addEventListener('click', async () => {
    const originalLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    const result = await window.api.exportRecipes({ recipeIds: [...selected] });
    if (result.success) alert(`Exported to ${result.path}`);
    else if (!result.cancelled) alert('Export failed.');
    exportBtn.textContent = originalLabel;
    updateExportBtn();
  });

  deleteSelectedBtn.addEventListener('click', async () => {
    const count = selected.size;
    if (!confirm(`Delete ${count} selected recipe${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    deleteSelectedBtn.disabled = true;
    deleteSelectedBtn.textContent = 'Deleting…';
    try {
      for (const id of selected) await window.api.deleteRecipe(id);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
    renderRecipeListView(main);
  });

  searchInput.addEventListener('input', renderFiltered);
  updateExportBtn();
  renderFiltered();
}

let _recipeRowLocalIdCounter = 0;
function makeEmptyIngredientRow() {
  return { localId: ++_recipeRowLocalIdCounter, ingredientId: null, name: '', quantity: '', unit: '', method: '' };
}

async function renderRecipeFormView(main) {
  const editing = !!state.recipes.formId;
  let recipe = null;
  let existingPhotoDataUrl = null;
  if (editing) {
    recipe = await window.api.getRecipe(state.recipes.formId);
    if (recipe.photo_path) {
      existingPhotoDataUrl = await window.api.getRecipePhoto(recipe.photo_path);
    }
    if (state.recipes.ingredientRows.length === 0) {
      state.recipes.ingredientRows = recipe.ingredients.map(ri => ({
        localId: ++_recipeRowLocalIdCounter,
        ingredientId: ri.ingredient_id,
        name: ri.ingredient_name,
        quantity: ri.quantity ?? '',
        unit: ri.unit || '',
        method: ri.method || '',
      }));
    }
  } else {
    // A New Recipe form opened via "Import Recipe from File" carries extracted values here --
    // consumed once (and cleared) so a later plain "+ New Recipe" click starts blank. Every
    // downstream read below goes through the same recipe?.field accessors the editing branch
    // above uses, so imported data is fully editable and goes through the exact same save path
    // as a hand-typed new recipe -- it's never sent anywhere on its own.
    recipe = state.recipes.importedRecipe;
    state.recipes.importedRecipe = null;
    if (state.recipes.ingredientRows.length === 0) {
      const importedIngredients = recipe?.ingredients || [];
      state.recipes.ingredientRows = importedIngredients.length > 0
        ? importedIngredients.map(ing => ({
            localId: ++_recipeRowLocalIdCounter,
            ingredientId: null, // not linked to the ingredients table yet -- pick from the autocomplete, same as typing a new name by hand
            name: ing.name || '',
            quantity: ing.quantity != null ? String(ing.quantity) : '',
            unit: ing.unit || '',
            method: ing.method || '',
          }))
        : [makeEmptyIngredientRow()];
    }
  }

  initTextListField('prep', recipe?.preparation_cooking);
  initTextListField('presentation', recipe?.presentation_serving);

  const currentPhotoSrc = state.recipes.pendingPhoto
    ? state.recipes.pendingPhoto.dataUrl
    : (existingPhotoDataUrl && !state.recipes.removePhoto ? existingPhotoDataUrl : null);

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${editing ? 'Edit Recipe' : 'New Recipe'}</h1>
        <span class="section-pill">${editing ? recipe.code : 'TTY code assigned after saving'}</span>
      </div>
      <button class="secondary" id="rf-back-btn">← Back to Recipe Book</button>
    </div>

    <div class="generate-controls">
      <div class="field"><label>Recipe Name</label><input id="rf-name" value="${recipe?.name || ''}" placeholder="e.g. Chicken Fatteh" /></div>
      <div class="field"><label>Quantity Produced</label><input id="rf-qty" value="${recipe?.quantity_produced || ''}" placeholder="e.g. 1 PAX" /></div>
      <div class="field"><label>Prepared By</label><input id="rf-prepared-by" value="${recipe?.prepared_by || ''}" /></div>
      <div class="field"><label>Category</label><input id="rf-category" value="${recipe?.category || ''}" placeholder="e.g. Main Course" /></div>
      <div class="field"><label>Country/Origin</label><input id="rf-country" value="${recipe?.country_origin || ''}" /></div>
      <div class="field"><label>Waste %</label><input id="rf-waste" type="number" min="0" max="100" step="0.1" placeholder="e.g. 15" value="${recipe?.waste_percent ?? ''}" /></div>
      <div class="field"><label>Yield (computed)</label><input id="rf-yield" value="${recipe?.yield_notes || ''}" readonly /></div>
      <div class="field"><label>Date</label><input id="rf-date" type="date" value="${recipe?.date_created || ''}" /></div>
    </div>

    <h3 style="margin-bottom:10px;">Ingredients</h3>
    <table class="recipe-ingredients-table">
      <thead><tr><th></th><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Method</th><th></th></tr></thead>
      <tbody id="rf-ing-rows"></tbody>
    </table>
    <div id="rf-total-qty" class="total-qty-display"></div>
    <button class="secondary" id="rf-add-row-btn" style="margin:10px 0 24px;">+ Add Ingredient Row</button>

    <div class="field" style="margin-bottom:16px;">
      <label>Preparation and Cooking</label>
      <div id="rf-prep-field"></div>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Presentation / Decoration / Serving</label>
      <div id="rf-presentation-field"></div>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Comment</label>
      <textarea id="rf-comment" rows="3">${recipe?.comment || ''}</textarea>
    </div>
    <div class="field" style="margin-bottom:16px; max-width:320px;">
      <label>Upload Photo</label>
      <input type="file" id="rf-photo-input" accept="image/jpeg,image/png" />
      <div id="rf-photo-preview-wrap" style="margin-top:8px; ${currentPhotoSrc ? '' : 'display:none;'}">
        <img id="rf-photo-preview" src="${currentPhotoSrc || ''}" style="max-width:220px; max-height:220px; border:1px solid var(--line); border-radius:6px; display:block;" />
        <button type="button" class="secondary" id="rf-photo-remove-btn" style="margin-top:6px;">Remove Photo</button>
      </div>
    </div>
    <div class="field" style="margin-bottom:20px; max-width:320px;">
      <label>Checked By</label>
      <input id="rf-checked-by" value="${recipe?.checked_by || ''}" />
    </div>

    <button class="primary" id="rf-save-btn">${editing ? 'Save Changes' : 'Save Recipe'}</button>
    <span id="rf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  function updatePhotoPreview() {
    const src = state.recipes.pendingPhoto
      ? state.recipes.pendingPhoto.dataUrl
      : (existingPhotoDataUrl && !state.recipes.removePhoto ? existingPhotoDataUrl : null);
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
      state.recipes.pendingPhoto = { dataUrl, base64, ext };
      state.recipes.removePhoto = false;
      updatePhotoPreview();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('rf-photo-remove-btn').addEventListener('click', () => {
    state.recipes.pendingPhoto = null;
    state.recipes.removePhoto = true;
    document.getElementById('rf-photo-input').value = '';
    updatePhotoPreview();
  });

  document.getElementById('rf-back-btn').addEventListener('click', goBackToRecipeList);
  document.getElementById('rf-add-row-btn').addEventListener('click', () => {
    state.recipes.ingredientRows.push(makeEmptyIngredientRow());
    renderIngredientRows();
  });
  document.getElementById('rf-save-btn').addEventListener('click', saveRecipeForm);
  document.getElementById('rf-waste').addEventListener('input', updateYieldCalculation);

  renderIngredientRows();
  renderTextListFieldBody('prep');
  renderTextListFieldBody('presentation');
}

// Total Quantity is the sum of every ingredient row's numeric quantity -- same convention
// the Excel export's "Total Quantity" row already uses (lib/export.js, showTotalQuantity),
// just surfaced live in the form instead of only appearing after exporting. All ingredients
// are recorded in grams today, so a plain sum is meaningful with no unit conversion needed.
// Yield is read-only and always reflects Total Quantity reduced by Waste % (0% if blank).
// Waste % is a persisted, fixed-per-recipe value (recipes.waste_percent) -- since it's always
// correctly pre-filled on load, recomputing here on every render reproduces exactly what was
// last saved, so there's no clobbering risk the way there was when waste was transient.
function updateYieldCalculation() {
  const totalEl = document.getElementById('rf-total-qty');
  const yieldEl = document.getElementById('rf-yield');
  const wasteEl = document.getElementById('rf-waste');
  if (!totalEl || !yieldEl || !wasteEl) return;

  const totalQty = state.recipes.ingredientRows.reduce((sum, row) => {
    const q = parseFloat(row.quantity);
    return isNaN(q) ? sum : sum + q;
  }, 0);
  totalEl.textContent = `Total Quantity: ${roundNice(totalQty)} G`;

  const waste = parseFloat(wasteEl.value);
  const wastePct = isNaN(waste) ? 0 : Math.min(Math.max(waste, 0), 100);
  yieldEl.value = `${roundNice(totalQty * (1 - wastePct / 100))} G`;
}

// ------------------------------------------------------------------
// Preparation/Presentation Text-vs-List toggle
//
// Both fields are plain TEXT columns in the DB (no schema change here) --
// list items are just newline-joined text, same convention the Excel export
// already used for presentation_serving. Mode isn't persisted as a flag; it's
// inferred on load (initTextListField): more than one non-empty line after
// split-by-newline opens in List mode, otherwise Text mode. Toggling between
// modes is non-destructive in both directions (split on \n / join with \n),
// so a wrong guess costs one click, never data.
// ------------------------------------------------------------------
const TEXT_LIST_FIELDS = {
  prep: {
    modeKey: 'prepMode', textKey: 'prepText', itemsKey: 'prepItems',
    textareaId: 'rf-prep', mountId: 'rf-prep-field', rows: 5,
    placeholder: 'Describe preparation and cooking…', itemPlaceholder: 'Step',
  },
  presentation: {
    modeKey: 'presentationMode', textKey: 'presentationText', itemsKey: 'presentationItems',
    textareaId: 'rf-presentation', mountId: 'rf-presentation-field', rows: 4,
    placeholder: 'Describe presentation, decoration and serving…', itemPlaceholder: 'Step',
  },
};

function initTextListField(key, rawValue) {
  const cfg = TEXT_LIST_FIELDS[key];
  if (state.recipes[cfg.modeKey] !== null) return; // already initialized this form session
  const raw = rawValue || '';
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  state.recipes[cfg.modeKey] = lines.length > 1 ? 'list' : 'paragraph';
  state.recipes[cfg.textKey] = raw;
  state.recipes[cfg.itemsKey] = (lines.length ? lines : ['']).map(v => ({ localId: ++_recipeRowLocalIdCounter, value: v }));
}

// Renders the Text/List toggle plus whichever editor is active, and rewires its listeners --
// a full rebuild on every change, same approach as renderIngredientRows.
function renderTextListFieldBody(key) {
  const cfg = TEXT_LIST_FIELDS[key];
  const mount = document.getElementById(cfg.mountId);
  if (!mount) return;
  const mode = state.recipes[cfg.modeKey];
  const items = state.recipes[cfg.itemsKey];

  mount.innerHTML = `
    <div class="mode-toggle">
      <button type="button" class="mode-toggle-btn ${mode === 'paragraph' ? 'active' : ''}" data-mode="paragraph">Text</button>
      <button type="button" class="mode-toggle-btn ${mode === 'list' ? 'active' : ''}" data-mode="list">List</button>
    </div>
    ${mode === 'paragraph' ? `
      <textarea id="${cfg.textareaId}" rows="${cfg.rows}" placeholder="${cfg.placeholder}">${state.recipes[cfg.textKey] || ''}</textarea>
    ` : `
      <div class="text-list">
        ${items.map((item, idx) => `
          <div class="text-list-row" data-item="${item.localId}">
            <span class="text-list-index">${idx + 1}.</span>
            <input class="text-list-input" value="${item.value}" placeholder="${cfg.itemPlaceholder} ${idx + 1}…" />
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
        const raw = document.getElementById(cfg.textareaId)?.value ?? state.recipes[cfg.textKey] ?? '';
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        state.recipes[cfg.itemsKey] = (lines.length ? lines : ['']).map(v => ({ localId: ++_recipeRowLocalIdCounter, value: v }));
      } else {
        state.recipes[cfg.textKey] = state.recipes[cfg.itemsKey].map(it => it.value.trim()).filter(Boolean).join('\n');
      }
      state.recipes[cfg.modeKey] = newMode;
      renderTextListFieldBody(key);
    });
  });

  if (mode === 'paragraph') {
    const textarea = document.getElementById(cfg.textareaId);
    textarea.addEventListener('input', () => { state.recipes[cfg.textKey] = textarea.value; });
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
      renderTextListFieldBody(key);
      mount.querySelector(`[data-item="${newItem.localId}"] .text-list-input`)?.focus();
    });
  });

  mount.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.remove, 10);
      state.recipes[cfg.itemsKey] = items.filter(it => it.localId !== id);
      if (state.recipes[cfg.itemsKey].length === 0) state.recipes[cfg.itemsKey].push({ localId: ++_recipeRowLocalIdCounter, value: '' });
      renderTextListFieldBody(key);
    });
  });
}

// Final saved value for either mode: paragraph text trimmed as-is, or list items trimmed and
// filtered of blanks (drops the trailing empty item from a last Enter press) and \n-joined --
// the same "one idea per line" text shape the Excel export already expects.
function collectTextListFieldValue(key) {
  const cfg = TEXT_LIST_FIELDS[key];
  if (state.recipes[cfg.modeKey] === 'paragraph') {
    const el = document.getElementById(cfg.textareaId);
    return (el ? el.value : state.recipes[cfg.textKey] || '').trim();
  }
  return state.recipes[cfg.itemsKey].map(it => it.value.trim()).filter(Boolean).join('\n');
}

function renderIngredientRows() {
  const tbody = document.getElementById('rf-ing-rows');
  if (!tbody) return;

  tbody.innerHTML = state.recipes.ingredientRows.map(row => `
    <tr data-row="${row.localId}">
      <td class="row-drag-handle-cell"><span class="row-drag-handle" data-drag-handle="${row.localId}" draggable="true" title="Drag to reorder">⠿</span></td>
      <td class="autocomplete-wrap">
        <input class="rf-ing-name" value="${row.name}" placeholder="Start typing an ingredient…" autocomplete="off" />
        <div class="autocomplete-list" hidden></div>
      </td>
      <td><input class="rf-ing-qty" value="${row.quantity}" placeholder="e.g. 150" /></td>
      <td><input class="rf-ing-unit" value="${row.unit}" placeholder="e.g. gm" /></td>
      <td><input class="rf-ing-method" value="${row.method}" placeholder="e.g. marinated before 2 hours" /></td>
      <td style="text-align:right">
        <button class="icon-btn danger" data-row-remove="${row.localId}">Remove</button>
      </td>
    </tr>
  `).join('');

  state.recipes.ingredientRows.forEach(row => {
    const tr = tbody.querySelector(`tr[data-row="${row.localId}"]`);
    const nameInput = tr.querySelector('.rf-ing-name');
    const qtyInput = tr.querySelector('.rf-ing-qty');
    const unitInput = tr.querySelector('.rf-ing-unit');
    const methodInput = tr.querySelector('.rf-ing-method');
    const listEl = tr.querySelector('.autocomplete-list');

    qtyInput.addEventListener('input', () => { row.quantity = qtyInput.value; updateYieldCalculation(); });
    unitInput.addEventListener('input', () => { row.unit = unitInput.value; });
    methodInput.addEventListener('input', () => { row.method = methodInput.value; });

    wireIngredientAutocomplete(nameInput, listEl, unitInput, row);
  });

  tbody.querySelectorAll('[data-row-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.rowRemove, 10);
      state.recipes.ingredientRows = state.recipes.ingredientRows.filter(r => r.localId !== id);
      if (state.recipes.ingredientRows.length === 0) state.recipes.ingredientRows.push(makeEmptyIngredientRow());
      renderIngredientRows();
    });
  });

  wireIngredientRowDrag(tbody);
  updateYieldCalculation();
}

// Drag-and-drop reordering. draggable="true" lives ONLY on the ⠿ handle cell, never on the
// <tr> or the inputs -- dragstart is otherwise a mousedown-drag gesture, which would hijack
// text selection/dragging inside the ingredient-name input (and the autocomplete dropdown
// that hangs off it) into a row-drag instead. Reordering just moves one entry within
// state.recipes.ingredientRows -- saveRecipeForm already builds its payload from that same
// array (order-preserving), and save-recipe already renumbers sort_order from array position
// on every save, so a reordered array is all that's needed for the new order to persist and
// show up in the Excel export.
function wireIngredientRowDrag(tbody) {
  let draggedId = null;

  tbody.querySelectorAll('[data-drag-handle]').forEach(handle => {
    handle.addEventListener('dragstart', (e) => {
      draggedId = parseInt(handle.dataset.dragHandle, 10);
      const tr = handle.closest('tr');
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedId));
      // Drag the whole row's image, not just the small handle glyph, so it reads as "picking
      // up the row" rather than dragging a tiny icon around.
      e.dataTransfer.setDragImage(tr, 20, tr.offsetHeight / 2);
    });
    handle.addEventListener('dragend', () => {
      tbody.querySelectorAll('tr').forEach(tr => tr.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
      draggedId = null;
    });
  });

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('dragover', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetId = parseInt(tr.dataset.row, 10);
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      if (targetId === draggedId) return;
      const rect = tr.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      tr.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
    });

    tr.addEventListener('drop', (e) => {
      if (draggedId === null) return;
      e.preventDefault();
      const targetId = parseInt(tr.dataset.row, 10);
      const rows = state.recipes.ingredientRows;
      const fromIdx = rows.findIndex(r => r.localId === draggedId);
      let toIdx = rows.findIndex(r => r.localId === targetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
      const rect = tr.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const [moved] = rows.splice(fromIdx, 1);
      if (!before) toIdx += 1;
      if (fromIdx < toIdx) toIdx -= 1; // account for the shift caused by removing `moved` above
      rows.splice(toIdx, 0, moved);
      draggedId = null;
      renderIngredientRows();
    });
  });
}

// Anti-typo autocomplete: matches what's typed against the canonical `ingredients` table so
// the same ingredient is always linked (and spelled) identically across every recipe.
let _ingredientAcDebounce = null;

function wireIngredientAutocomplete(inputEl, listEl, unitInput, row) {
  inputEl.addEventListener('input', () => {
    row.name = inputEl.value;
    row.ingredientId = null; // typing invalidates the previous link until something is picked again
    const query = inputEl.value.trim();
    clearTimeout(_ingredientAcDebounce);
    if (!query) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    _ingredientAcDebounce = setTimeout(async () => {
      const matches = await window.api.searchIngredients(query);
      renderAutocompleteList(listEl, matches, query, inputEl, unitInput, row);
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

function renderAutocompleteList(listEl, matches, query, inputEl, unitInput, row) {
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
        // left blank here (not everyone has one on hand mid-recipe); it's editable later via
        // the Ingredients screen's Edit action.
        const created = await window.api.addIngredient({ name: query, defaultUnit: 'G' });
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

// Shared by "Back to Recipe Book" and a successful save -- both exit the form the same way.
function goBackToRecipeList() {
  state.recipes.view = 'list';
  state.recipes.formId = null;
  resetRecipeFormState();
  renderView();
}

async function saveRecipeForm() {
  const name = document.getElementById('rf-name').value.trim();
  if (!name) return alert('Please enter a recipe name.');

  const rows = state.recipes.ingredientRows.filter(r => r.name.trim() !== '');
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].ingredientId) {
      return alert(`Row ${i + 1}: please pick "${rows[i].name}" from the dropdown (or add it as a new ingredient) before saving.`);
    }
  }

  const statusEl = document.getElementById('rf-status');
  statusEl.textContent = 'Saving…';

  const payload = {
    id: state.recipes.formId || undefined,
    name,
    quantityProduced: document.getElementById('rf-qty').value.trim(),
    preparedBy: document.getElementById('rf-prepared-by').value.trim(),
    category: document.getElementById('rf-category').value.trim(),
    countryOrigin: document.getElementById('rf-country').value.trim(),
    yieldNotes: document.getElementById('rf-yield').value.trim(),
    wastePercent: document.getElementById('rf-waste').value === '' ? null : parseFloat(document.getElementById('rf-waste').value),
    dateCreated: document.getElementById('rf-date').value,
    preparationCooking: collectTextListFieldValue('prep'),
    presentationServing: collectTextListFieldValue('presentation'),
    comment: document.getElementById('rf-comment').value,
    checkedBy: document.getElementById('rf-checked-by').value.trim(),
    ingredients: rows.map(r => ({
      ingredientId: r.ingredientId,
      quantity: r.quantity ? parseFloat(r.quantity) : null,
      unit: r.unit || null,
      method: r.method || null,
    })),
  };
  if (state.recipes.pendingPhoto) {
    payload.photoBase64 = state.recipes.pendingPhoto.base64;
    payload.photoExt = state.recipes.pendingPhoto.ext;
  } else if (state.recipes.removePhoto) {
    payload.removePhoto = true;
  }

  try {
    await window.api.saveRecipe(payload);
    goBackToRecipeList();
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

function scaleRecipeForExport(recipe, ingredients, multiplier) {
  const scaledRecipe = {
    ...recipe,
    quantity_produced: scaleQuantityProducedText(recipe.quantity_produced, multiplier),
  };
  const scaledIngredients = ingredients.map(ing => ({
    ...ing,
    quantity: (ing.quantity === null || ing.quantity === undefined || ing.quantity === '')
      ? ing.quantity
      : roundNice(parseFloat(ing.quantity) * multiplier),
  }));
  return { scaledRecipe, scaledIngredients };
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
      <div class="field" style="min-width:260px;">
        <label>Recipe Name</label>
        <div class="autocomplete-wrap">
          <input id="calc-recipe-name" placeholder="Start typing or browse recipes…" autocomplete="off" style="padding-right:28px; width:100%;" />
          <button type="button" class="autocomplete-browse-btn" id="calc-recipe-browse-btn" aria-label="Browse recipes" title="Browse all recipes">▾</button>
          <div class="autocomplete-list" id="calc-recipe-list" hidden></div>
        </div>
      </div>
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
        <input id="calc-target-qty" type="number" step="1" min="0" placeholder="e.g. 2000" />
      </div>
      <button class="primary" id="calc-calculate-btn" disabled>Calculate</button>
    </div>
    <div id="calc-mode-error" style="display:none; color:var(--danger, #c0392b); font-size:12.5px; margin:-10px 0 14px;"></div>

    <div id="calc-result"></div>
  `;

  const nameInput = document.getElementById('calc-recipe-name');
  const listEl = document.getElementById('calc-recipe-list');
  const browseBtn = document.getElementById('calc-recipe-browse-btn');
  const qtyOriginalLabel = document.getElementById('calc-qty-original-label');
  const qtyOriginalInput = document.getElementById('calc-qty-original');
  const multiplierField = document.getElementById('calc-multiplier-field');
  const multiplierInput = document.getElementById('calc-multiplier');
  const targetField = document.getElementById('calc-target-field');
  const targetInput = document.getElementById('calc-target-qty');
  const modeErrorEl = document.getElementById('calc-mode-error');
  const calculateBtn = document.getElementById('calc-calculate-btn');
  const resultEl = document.getElementById('calc-result');

  let scalingMode = 'factor';
  let selectedRecipe = null;
  // Full recipe + ingredients are fetched once per selection (below) and cached here, both to
  // drive the "original" display for whichever mode is active and so Calculate doesn't have to
  // re-fetch the same data.
  let selectedFullRecipe = null;
  let selectedIngredients = null;
  // Tracks whether the currently-open list is the "browse all" list specifically, so a second
  // click on the browse button closes it instead of just re-opening the same full list -- but
  // starting to type (which hands the list over to wireRecipeAutocomplete's own search results)
  // clears it, so browse always shows the full list fresh rather than silently closing search results.
  let browseListShowing = false;

  function clearSelection() {
    selectedRecipe = null;
    selectedFullRecipe = null;
    selectedIngredients = null;
    qtyOriginalInput.value = '';
    calculateBtn.disabled = true;
    resultEl.innerHTML = '';
    modeErrorEl.style.display = 'none';
  }

  // "Quantity Produced (original)" shows the recipe's free-text serving/container count in
  // Multiply-by-factor mode (what it's always meant), but in Scale-to-target mode that field
  // isn't what the target is measured against -- so it switches to showing the actual basis,
  // the recipe's current total ingredient quantity, with the label swapped to match.
  function updateQtyOriginalDisplay() {
    if (!selectedFullRecipe) return;
    if (scalingMode === 'factor') {
      qtyOriginalLabel.textContent = 'Quantity Produced (original)';
      qtyOriginalInput.value = selectedFullRecipe.quantity_produced || '';
    } else {
      qtyOriginalLabel.textContent = 'Total Ingredient Quantity (original)';
      qtyOriginalInput.value = `${sumIngredientQuantities(selectedIngredients || [])}g`;
    }
  }

  document.querySelectorAll('.generate-controls .mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === scalingMode) return;
      scalingMode = btn.dataset.mode;
      document.querySelectorAll('.generate-controls .mode-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === scalingMode));
      multiplierField.style.display = scalingMode === 'factor' ? 'flex' : 'none';
      targetField.style.display = scalingMode === 'target' ? 'flex' : 'none';
      modeErrorEl.style.display = 'none';
      updateQtyOriginalDisplay();
    });
  });

  async function onRecipePicked(recipe) {
    selectedRecipe = recipe;
    selectedFullRecipe = null;
    selectedIngredients = null;
    nameInput.value = recipe.name;
    qtyOriginalInput.value = '…';
    calculateBtn.disabled = true;
    browseListShowing = false;

    const { ingredients, ...fullRecipe } = await window.api.getRecipe(recipe.id);
    if (!selectedRecipe || selectedRecipe.id !== recipe.id) return; // superseded by a later pick
    selectedFullRecipe = fullRecipe;
    selectedIngredients = ingredients;
    calculateBtn.disabled = false;
    updateQtyOriginalDisplay();
  }

  nameInput.addEventListener('input', () => {
    clearSelection();
    browseListShowing = false;
  });

  wireRecipeAutocomplete(nameInput, listEl, onRecipePicked);

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
    const all = await window.api.listRecipes();
    const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
    renderRecipeAutocompleteList(listEl, sorted, nameInput, onRecipePicked, 'No recipes yet');
    browseListShowing = true;
    nameInput.focus();
  });

  calculateBtn.addEventListener('click', () => {
    if (!selectedFullRecipe || !selectedIngredients) return;
    modeErrorEl.style.display = 'none';

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
    renderScaledRecipeResult(resultEl, selectedFullRecipe, selectedIngredients, multiplier);
  });
}

// Same debounced-search-then-dropdown pattern as wireIngredientAutocomplete, minus the
// "add new" option -- the calculator only ever picks an existing saved recipe.
let _recipeAcDebounce = null;

function wireRecipeAutocomplete(inputEl, listEl, onPick) {
  inputEl.addEventListener('input', () => {
    const query = inputEl.value.trim();
    clearTimeout(_recipeAcDebounce);
    if (!query) { listEl.hidden = true; listEl.innerHTML = ''; return; }
    _recipeAcDebounce = setTimeout(async () => {
      const matches = await window.api.searchRecipes(query);
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

function renderScaledRecipeResult(container, recipe, ingredients, multiplier) {
  const { scaledRecipe, scaledIngredients } = scaleRecipeForExport(recipe, ingredients, multiplier);

  // Same logic as the "Total Quantity" row in the Excel export, kept in sync with it.
  const totalQuantity = sumIngredientQuantities(scaledIngredients);

  // Yield here is always recomputed from the scaled Total Quantity and the recipe's own fixed
  // waste_percent (read-only -- waste is set once on the recipe, not re-entered per
  // calculation), NOT read from the original recipe's saved yield_notes, which reflects the
  // unscaled quantity. This overwrites scaledRecipe.yield_notes so both this live display and
  // the exported Excel show the scaled, waste-adjusted figure -- waste_percent itself never
  // gets written into scaledRecipe fields that reach the export.
  const wastePct = recipe.waste_percent != null ? Math.min(Math.max(parseFloat(recipe.waste_percent), 0), 100) : 0;
  scaledRecipe.yield_notes = `${roundNice(totalQuantity * (1 - wastePct / 100))} G`;

  container.innerHTML = `
    <div class="day-card">
      <div class="day-head">
        <span>${recipe.name}</span>
        <span class="date">×${roundNice(multiplier)}</span>
      </div>
      <div style="padding:16px 18px;">
        <div class="generate-controls" style="border:none; padding:0; margin-bottom:18px;">
          <div class="field"><label>Quantity Produced (original)</label><div>${recipe.quantity_produced || '—'}</div></div>
          <div class="field"><label>Quantity Produced (scaled)</label><div><strong>${scaledRecipe.quantity_produced || '—'}</strong></div></div>
          <div class="field"><label>Prepared By</label><div>${recipe.prepared_by || '—'}</div></div>
          <div class="field"><label>Category</label><div>${recipe.category || '—'}</div></div>
          <div class="field"><label>Country/Origin</label><div>${recipe.country_origin || '—'}</div></div>
          <div class="field"><label>Waste %</label><div>${recipe.waste_percent != null ? recipe.waste_percent + '%' : '—'}</div></div>
          <div class="field"><label>Yield (scaled)</label><div><strong>${scaledRecipe.yield_notes}</strong></div></div>
        </div>

        <h3 style="margin-bottom:10px;">Ingredients (scaled)</h3>
        <table class="recipe-ingredients-table">
          <thead><tr><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Method</th></tr></thead>
          <tbody>
            ${scaledIngredients.map(ing => `
              <tr>
                <td>${ing.ingredient_name}</td>
                <td>${ing.quantity ?? ''}</td>
                <td>${ing.unit || ''}</td>
                <td>${ing.method || ''}</td>
              </tr>
            `).join('')}
            <tr style="font-weight:600;">
              <td>Total Quantity</td>
              <td>${totalQuantity}</td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>

        <div class="field" style="margin:16px 0;">
          <label>Preparation and Cooking</label>
          <div style="white-space:pre-wrap;">${recipe.preparation_cooking || '—'}</div>
        </div>
        <div class="field" style="margin-bottom:16px;">
          <label>Presentation / Decoration / Serving</label>
          <div style="white-space:pre-wrap;">${recipe.presentation_serving || '—'}</div>
        </div>
        <div class="field" style="margin-bottom:16px;">
          <label>Comment</label>
          <div style="white-space:pre-wrap;">${recipe.comment || '—'}</div>
        </div>

        <button class="primary" id="calc-export-btn">Export to Excel</button>
        <span id="calc-export-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
      </div>
    </div>
  `;

  document.getElementById('calc-export-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('calc-export-status');
    statusEl.textContent = 'Exporting…';
    const result = await window.api.exportScaledRecipe({ recipe: scaledRecipe, ingredients: scaledIngredients });
    if (result.success) statusEl.textContent = `Exported to ${result.path}`;
    else if (!result.cancelled) statusEl.textContent = 'Export failed.';
    else statusEl.textContent = '';
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
      <input id="ingredient-search" type="search" placeholder="Search ingredients by name…" />
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

    // Same shared-table-with-rowspan-merged-category pattern as the Item Catalog view --
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
        <input id="im-name" placeholder="e.g. Bread Bagels" value="${existingIngredient?.name || ''}" />
      </div>
      <div class="field">
        <label>Product code</label>
        <input id="im-code" placeholder="e.g. FB02-00001" value="${existingIngredient?.product_code || ''}" />
      </div>
      <div class="field">
        <label>Default unit</label>
        <input id="im-unit" placeholder="e.g. PC, GR, ML, KG" value="${existingIngredient?.default_unit || ''}" />
      </div>
      <div class="field">
        <label>Category</label>
        <input id="im-category" list="im-category-list" placeholder="Pick existing or type a new one" value="${existingIngredient?.category || ''}" />
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

init();
