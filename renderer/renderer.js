const state = {
  sections: [],
  currentSection: null,
  currentView: 'items',
  categories: [],
  proteinTypes: [],
  currentGeneratedMenuId: null,
  builder: { label: '', startDate: '', numWeekdays: 20, activeSection: null, days: [], sections: {} },
  recipes: { view: 'list', formId: null, ingredientRows: [] },
};

const CATEGORY_COLOR = { CHICKEN: 'chicken', BEEF: 'beef', LAMB: 'lamb' };

async function init() {
  state.sections = await window.api.getSections();
  state.categories = await window.api.getCategories();
  state.proteinTypes = await window.api.getProteinTypes();
  state.currentSection = state.sections[0].code;

  renderSectionNav();
  wireNav();
  renderView();
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

function renderView() {
  updateActiveViewButtons();
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
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Item Catalog</h1><span class="section-pill">${currentSectionName()}</span></div>
      <button class="primary" id="add-item-btn">+ Add Item</button>
    </div>
    <div class="search-bar">
      <input id="item-search" type="search" placeholder="Search items by name…" />
    </div>
    <div id="items-content">Loading…</div>
  `;
  document.getElementById('add-item-btn').addEventListener('click', () => openItemModal());

  const items = await window.api.getItems(state.currentSection);
  const searchInput = document.getElementById('item-search');
  const content = document.getElementById('items-content');

  if (items.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No items yet</div>Add the first item for ${currentSectionName()}.</div>`;
    return;
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query ? items.filter(it => it.name.toLowerCase().includes(query)) : items;

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No items match "${searchInput.value}".</div>`;
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
        if (confirm('Delete this item? This cannot be undone.')) {
          await window.api.deleteItem(btn.dataset.delete);
          renderItemsView(main);
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
        <select id="m-category">
          ${sectionCategories.map(c => `<option value="${c.code}" ${isEdit && existingItem.category_code === c.code ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Protein type (lunch mains only)</label>
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
  const proteinSelect = overlay.querySelector('#m-protein');
  const dailyCheckbox = overlay.querySelector('#m-daily');

  if (isEdit) {
    const cat = state.categories.find(c => c.code === existingItem.category_code);
    if (cat) periodSelect.value = cat.meal_period_code;
  }

  nameInput.addEventListener('blur', async () => {
    if (isEdit || !nameInput.value.trim()) return;
    const suggestion = await window.api.suggestClassification({ name: nameInput.value, mealPeriod: periodSelect.value });
    if (suggestion.category) categorySelect.value = suggestion.category;
    if (suggestion.protein) proteinSelect.value = suggestion.protein;
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
function renderGenerateView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Generate Menu</h1><span class="section-pill">${currentSectionName()}</span></div>
    </div>
    <div class="generate-controls">
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

  document.getElementById('g-generate').addEventListener('click', async () => {
    const label = document.getElementById('g-label').value.trim() || 'Untitled Menu';
    const startDate = document.getElementById('g-start').value;
    const numWeekdays = parseInt(document.getElementById('g-days').value, 10);
    if (!startDate) return alert('Please choose a start date.');

    const resultEl = document.getElementById('g-result');
    resultEl.innerHTML = 'Generating…';
    const { menuId, resultDays, warnings } = await window.api.generateMenu({
      sectionCode: state.currentSection, label, startDate, numWeekdays,
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
async function renderHistoryView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>History</h1><span class="section-pill">${currentSectionName()}</span></div>
    </div>
    <div id="history-list"></div>
    <div id="history-detail"></div>
  `;
  const menus = await window.api.listGeneratedMenus(state.currentSection);
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
      <li class="history-item" data-id="${m.id}">
        <span>
          <input type="checkbox" class="history-row-check" data-select="${m.id}" />
          &nbsp; <strong>${m.label}</strong> &nbsp; <span style="color:var(--neutral)">${m.start_date}</span>
        </span>
        <span class="chip daily">${m.status}</span>
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
      const id = parseInt(cb.dataset.select, 10);
      if (cb.checked) selected.add(id); else selected.delete(id);
      selectAllEl.checked = selected.size === menus.length;
      updateDeleteBtn();
    });
  });

  selectAllEl.addEventListener('change', () => {
    listEl.querySelectorAll('.history-row-check').forEach(cb => {
      cb.checked = selectAllEl.checked;
      const id = parseInt(cb.dataset.select, 10);
      if (selectAllEl.checked) selected.add(id); else selected.delete(id);
    });
    updateDeleteBtn();
  });

  deleteBtn.addEventListener('click', async () => {
    const count = selected.size;
    if (!confirm(`Delete ${count} selected menu${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
    deleteBtn.disabled = true;
    await window.api.deleteGeneratedMenus([...selected]);
    renderHistoryView(main);
  });

  listEl.querySelectorAll('[data-id]').forEach(li => {
    li.addEventListener('click', async () => {
      const days = await window.api.getGeneratedMenuDetail(li.dataset.id);
      const formattedDays = days.map(d => ({
        date: d.menu_date, weekday: d.day_of_week,
        items: d.items.map(it => ({ category: it.category_code, name: it.name })),
      }));
      state.currentGeneratedMenuId = li.dataset.id;
      renderMenuResult(document.getElementById('history-detail'), li.dataset.id, formattedDays, []);
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
    const slotDefs = await window.api.getSectionSlots(section.code);
    const slots = await Promise.all(slotDefs.map(async ({ categoryCode, count }) => {
      const items = await window.api.getEligibleItems({ sectionCode: section.code, categoryCode });
      const dailyItems = items.filter(i => i.is_daily_repeating).slice(0, count);
      return { categoryCode, count, isDaily: dailyItems.length > 0, dailyItems, eligibleItems: items };
    }));

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
      byCategory[catCode].forEach((item, idx) => {
        const key = builderSelectionKey(day.date, catCode, idx);
        if (key in section.selections) section.selections[key] = String(item.id);
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

function openNewRecipeForm() {
  state.recipes.view = 'form';
  state.recipes.formId = null;
  state.recipes.ingredientRows = [];
  renderView();
}

function openEditRecipeForm(id) {
  state.recipes.view = 'form';
  state.recipes.formId = id;
  state.recipes.ingredientRows = [];
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
      <button class="primary" id="new-recipe-btn">+ New Recipe</button>
    </div>
    <div class="search-bar">
      <input id="recipe-search" type="search" placeholder="Search by name or TTY code…" />
    </div>
    <div style="margin-bottom:14px;">
      <button class="secondary" id="export-selected-btn" disabled>Export Selected</button>
    </div>
    <div id="recipes-content">Loading…</div>
  `;
  document.getElementById('new-recipe-btn').addEventListener('click', openNewRecipeForm);

  const recipes = await window.api.listRecipes();
  const searchInput = document.getElementById('recipe-search');
  const content = document.getElementById('recipes-content');
  const exportBtn = document.getElementById('export-selected-btn');
  const selected = new Set();

  if (recipes.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No recipes yet</div>Click "+ New Recipe" to create the first one.</div>`;
    return;
  }

  function updateExportBtn() {
    exportBtn.disabled = selected.size === 0;
    exportBtn.textContent = selected.size > 0 ? `Export Selected (${selected.size})` : 'Export Selected';
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
  if (editing) {
    recipe = await window.api.getRecipe(state.recipes.formId);
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
  } else if (state.recipes.ingredientRows.length === 0) {
    state.recipes.ingredientRows = [makeEmptyIngredientRow()];
  }

  main.innerHTML = `
    <div class="topbar">
      <div><h1>${editing ? 'Edit Recipe' : 'New Recipe'}</h1>
        <span class="section-pill">${recipe ? recipe.code : 'TTY code assigned after saving'}</span>
      </div>
      <button class="secondary" id="rf-back-btn">← Back to Recipe Book</button>
    </div>

    <div class="generate-controls">
      <div class="field"><label>Recipe Name</label><input id="rf-name" value="${recipe?.name || ''}" placeholder="e.g. Chicken Fatteh" /></div>
      <div class="field"><label>Quantity Produced</label><input id="rf-qty" value="${recipe?.quantity_produced || ''}" placeholder="e.g. 1 PAX" /></div>
      <div class="field"><label>Prepared By</label><input id="rf-prepared-by" value="${recipe?.prepared_by || ''}" /></div>
      <div class="field"><label>Category</label><input id="rf-category" value="${recipe?.category || ''}" placeholder="e.g. Main Course" /></div>
      <div class="field"><label>Country/Origin</label><input id="rf-country" value="${recipe?.country_origin || ''}" /></div>
      <div class="field"><label>Yield</label><input id="rf-yield" value="${recipe?.yield_notes || ''}" /></div>
      <div class="field"><label>Date</label><input id="rf-date" type="date" value="${recipe?.date_created || ''}" /></div>
    </div>

    <h3 style="margin-bottom:10px;">Ingredients</h3>
    <table class="recipe-ingredients-table">
      <thead><tr><th>Ingredient</th><th>Quantity</th><th>Unit</th><th>Method</th><th></th></tr></thead>
      <tbody id="rf-ing-rows"></tbody>
    </table>
    <button class="secondary" id="rf-add-row-btn" style="margin:10px 0 24px;">+ Add Ingredient Row</button>

    <div class="field" style="margin-bottom:16px;">
      <label>Preparation and Cooking</label>
      <textarea id="rf-prep" rows="5">${recipe?.preparation_cooking || ''}</textarea>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Presentation / Decoration / Serving</label>
      <textarea id="rf-presentation" rows="4">${recipe?.presentation_serving || ''}</textarea>
    </div>
    <div class="field" style="margin-bottom:16px;">
      <label>Comment</label>
      <textarea id="rf-comment" rows="3">${recipe?.comment || ''}</textarea>
    </div>
    <div class="field" style="margin-bottom:20px; max-width:320px;">
      <label>Checked By</label>
      <input id="rf-checked-by" value="${recipe?.checked_by || ''}" />
    </div>

    <button class="primary" id="rf-save-btn">${editing ? 'Save Changes' : 'Save Recipe'}</button>
    <span id="rf-status" style="margin-left:12px; color:var(--neutral); font-size:12.5px;"></span>
  `;

  document.getElementById('rf-back-btn').addEventListener('click', () => {
    state.recipes.view = 'list';
    state.recipes.formId = null;
    state.recipes.ingredientRows = [];
    renderView();
  });
  document.getElementById('rf-add-row-btn').addEventListener('click', () => {
    state.recipes.ingredientRows.push(makeEmptyIngredientRow());
    renderIngredientRows();
  });
  document.getElementById('rf-save-btn').addEventListener('click', saveRecipeForm);

  renderIngredientRows();
}

function renderIngredientRows() {
  const tbody = document.getElementById('rf-ing-rows');
  if (!tbody) return;

  tbody.innerHTML = state.recipes.ingredientRows.map(row => `
    <tr data-row="${row.localId}">
      <td class="autocomplete-wrap">
        <input class="rf-ing-name" value="${row.name}" placeholder="Start typing an ingredient…" autocomplete="off" />
        <div class="autocomplete-list" hidden></div>
      </td>
      <td><input class="rf-ing-qty" value="${row.quantity}" placeholder="e.g. 150" /></td>
      <td><input class="rf-ing-unit" value="${row.unit}" placeholder="e.g. gm" /></td>
      <td><input class="rf-ing-method" value="${row.method}" placeholder="e.g. marinated before 2 hours" /></td>
      <td style="text-align:right"><button class="icon-btn danger" data-row-remove="${row.localId}">Remove</button></td>
    </tr>
  `).join('');

  state.recipes.ingredientRows.forEach(row => {
    const tr = tbody.querySelector(`tr[data-row="${row.localId}"]`);
    const nameInput = tr.querySelector('.rf-ing-name');
    const qtyInput = tr.querySelector('.rf-ing-qty');
    const unitInput = tr.querySelector('.rf-ing-unit');
    const methodInput = tr.querySelector('.rf-ing-method');
    const listEl = tr.querySelector('.autocomplete-list');

    qtyInput.addEventListener('input', () => { row.quantity = qtyInput.value; });
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
      const created = await window.api.addIngredient({ name: query });
      selectIngredientForRow(created, inputEl, unitInput, row, listEl);
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
    dateCreated: document.getElementById('rf-date').value,
    preparationCooking: document.getElementById('rf-prep').value,
    presentationServing: document.getElementById('rf-presentation').value,
    comment: document.getElementById('rf-comment').value,
    checkedBy: document.getElementById('rf-checked-by').value.trim(),
    ingredients: rows.map(r => ({
      ingredientId: r.ingredientId,
      quantity: r.quantity ? parseFloat(r.quantity) : null,
      unit: r.unit || null,
      method: r.method || null,
    })),
  };

  try {
    const result = await window.api.saveRecipe(payload);
    state.recipes.formId = result.id;
    renderView();
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

function renderCalculatorView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Recipe Calculator</h1><span class="section-pill">Scale a recipe -- export only, nothing is saved</span></div>
    </div>

    <div class="generate-controls">
      <div class="field autocomplete-wrap" style="min-width:260px;">
        <label>Recipe Name</label>
        <input id="calc-recipe-name" placeholder="Start typing a recipe name…" autocomplete="off" />
        <div class="autocomplete-list" id="calc-recipe-list" hidden></div>
      </div>
      <div class="field" style="max-width:200px;">
        <label>Quantity Produced (original)</label>
        <input id="calc-qty-original" value="" disabled />
      </div>
      <div class="field" style="max-width:120px;">
        <label>Multiplier</label>
        <input id="calc-multiplier" type="number" step="0.1" min="0" value="1" />
      </div>
      <button class="primary" id="calc-calculate-btn" disabled>Calculate</button>
    </div>

    <div id="calc-result"></div>
  `;

  const nameInput = document.getElementById('calc-recipe-name');
  const listEl = document.getElementById('calc-recipe-list');
  const qtyOriginalInput = document.getElementById('calc-qty-original');
  const multiplierInput = document.getElementById('calc-multiplier');
  const calculateBtn = document.getElementById('calc-calculate-btn');
  const resultEl = document.getElementById('calc-result');

  let selectedRecipe = null;

  function clearSelection() {
    selectedRecipe = null;
    qtyOriginalInput.value = '';
    calculateBtn.disabled = true;
    resultEl.innerHTML = '';
  }

  nameInput.addEventListener('input', () => {
    clearSelection();
  });

  wireRecipeAutocomplete(nameInput, listEl, (recipe) => {
    selectedRecipe = recipe;
    nameInput.value = recipe.name;
    qtyOriginalInput.value = recipe.quantity_produced || '';
    calculateBtn.disabled = false;
  });

  calculateBtn.addEventListener('click', async () => {
    if (!selectedRecipe) return;
    const multiplier = parseFloat(multiplierInput.value);
    if (!multiplier || multiplier <= 0) return alert('Please enter a multiplier greater than 0.');

    const { ingredients, ...fullRecipe } = await window.api.getRecipe(selectedRecipe.id);
    renderScaledRecipeResult(resultEl, fullRecipe, ingredients, multiplier);
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

function renderRecipeAutocompleteList(listEl, matches, inputEl, onPick) {
  if (matches.length === 0) {
    listEl.innerHTML = `<div class="autocomplete-item">No matching recipes</div>`;
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
          <div class="field"><label>Yield</label><div>${recipe.yield_notes || '—'}</div></div>
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
async function renderIngredientsView(main) {
  main.innerHTML = `
    <div class="topbar">
      <div><h1>Ingredients</h1><span class="section-pill">Canonical ingredient master</span></div>
      <button class="primary" id="add-ingredient-btn">+ Add Ingredient</button>
    </div>
    <div class="search-bar">
      <input id="ingredient-search" type="search" placeholder="Search ingredients by name…" />
    </div>
    <div id="ingredients-content">Loading…</div>
  `;
  document.getElementById('add-ingredient-btn').addEventListener('click', () => openIngredientModal());

  const ingredients = await window.api.listIngredients();
  const searchInput = document.getElementById('ingredient-search');
  const content = document.getElementById('ingredients-content');

  if (ingredients.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="display">No ingredients yet</div>Click "+ Add Ingredient" to create the first one.</div>`;
    return;
  }

  function renderFiltered() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query ? ingredients.filter(i => i.name.toLowerCase().includes(query)) : ingredients;

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty-state">No ingredients match "${searchInput.value}".</div>`;
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
            <td style="text-align:right"><button class="icon-btn danger" data-delete="${ing.id}">Delete</button></td>
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

async function openIngredientModal() {
  const ingredients = await window.api.listIngredients();
  const categories = [...new Set(ingredients.map(i => i.category).filter(Boolean))].sort();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Add Ingredient</h2>
      <div class="field">
        <label>Ingredient name</label>
        <input id="im-name" placeholder="e.g. Bread Bagels" />
      </div>
      <div class="field">
        <label>Product code</label>
        <input id="im-code" placeholder="e.g. FB02-00001" />
      </div>
      <div class="field">
        <label>Default unit</label>
        <input id="im-unit" placeholder="e.g. PC, GR, ML, KG" />
      </div>
      <div class="field">
        <label>Category</label>
        <input id="im-category" list="im-category-list" placeholder="Pick existing or type a new one" />
        <datalist id="im-category-list">
          ${categories.map(c => `<option value="${c}"></option>`).join('')}
        </datalist>
      </div>
      <div class="actions">
        <button class="secondary" id="im-cancel">Cancel</button>
        <button class="primary" id="im-save">Add Ingredient</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#im-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#im-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#im-name').value.trim();
    if (!name) return alert('Please enter an ingredient name.');

    await window.api.addIngredient({
      name,
      productCode: overlay.querySelector('#im-code').value.trim() || null,
      defaultUnit: overlay.querySelector('#im-unit').value.trim() || null,
      category: overlay.querySelector('#im-category').value.trim() || null,
    });
    overlay.remove();
    renderView();
  });
}

init();
