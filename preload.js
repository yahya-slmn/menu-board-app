const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (id, password) => ipcRenderer.invoke('auth-sign-in', { id, password }),

  getSections: () => ipcRenderer.invoke('get-sections'),
  getAgeGroups: (sectionCode) => ipcRenderer.invoke('get-age-groups', sectionCode),
  getCategories: () => ipcRenderer.invoke('get-categories'),
  getCategoriesForSection: (sectionCode) => ipcRenderer.invoke('get-categories-for-section', sectionCode),
  getProteinTypes: () => ipcRenderer.invoke('get-protein-types'),
  refreshReferenceData: () => ipcRenderer.invoke('refresh-reference-data'),

  getItems: (sectionCode) => ipcRenderer.invoke('get-items', sectionCode),
  getItemPortions: (itemId) => ipcRenderer.invoke('get-item-portions', itemId),
  suggestClassification: (payload) => ipcRenderer.invoke('suggest-classification', payload),
  addItem: (payload) => ipcRenderer.invoke('add-item', payload),
  updateItem: (payload) => ipcRenderer.invoke('update-item', payload),
  checkCategoryChangeImpact: (payload) => ipcRenderer.invoke('check-category-change-impact', payload),
  updateItemRc: (payload) => ipcRenderer.invoke('update-item-rc', payload),
  deleteItem: (itemId) => ipcRenderer.invoke('delete-item', itemId),

  searchIngredients: (query) => ipcRenderer.invoke('search-ingredients', query),
  addIngredient: (payload) => ipcRenderer.invoke('add-ingredient', payload),
  updateIngredient: (payload) => ipcRenderer.invoke('update-ingredient', payload),
  listIngredients: () => ipcRenderer.invoke('list-ingredients'),
  deleteIngredient: (id) => ipcRenderer.invoke('delete-ingredient', id),
  listRecipes: () => ipcRenderer.invoke('list-recipes'),
  searchRecipes: (query) => ipcRenderer.invoke('search-recipes', query),
  getRecipe: (id) => ipcRenderer.invoke('get-recipe', id),
  saveRecipe: (payload) => ipcRenderer.invoke('save-recipe', payload),
  deleteRecipe: (id) => ipcRenderer.invoke('delete-recipe', id),
  getRecipePhoto: (photoPath) => ipcRenderer.invoke('get-recipe-photo', photoPath),
  exportRecipes: (payload) => ipcRenderer.invoke('export-recipes', payload),
  exportScaledRecipe: (payload) => ipcRenderer.invoke('export-scaled-recipe', payload),

  searchExtractedIngredients: (query) => ipcRenderer.invoke('search-extracted-ingredients', query),
  addExtractedIngredient: (payload) => ipcRenderer.invoke('add-extracted-ingredient', payload),
  listExtractedIngredients: () => ipcRenderer.invoke('list-extracted-ingredients'),
  updateExtractedIngredient: (payload) => ipcRenderer.invoke('update-extracted-ingredient', payload),
  deleteExtractedIngredient: (id) => ipcRenderer.invoke('delete-extracted-ingredient', id),
  listExtractedRecipes: () => ipcRenderer.invoke('list-extracted-recipes'),
  searchExtractedRecipes: (query) => ipcRenderer.invoke('search-extracted-recipes', query),
  getExtractedRecipe: (id) => ipcRenderer.invoke('get-extracted-recipe', id),
  saveExtractedRecipe: (payload) => ipcRenderer.invoke('save-extracted-recipe', payload),
  deleteExtractedRecipe: (id) => ipcRenderer.invoke('delete-extracted-recipe', id),
  getExtractedRecipePhotos: (photoPaths) => ipcRenderer.invoke('get-extracted-recipe-photos', photoPaths),
  exportExtractedRecipes: (payload) => ipcRenderer.invoke('export-extracted-recipes', payload),
  exportScaledExtractedRecipe: (payload) => ipcRenderer.invoke('export-scaled-extracted-recipe', payload),
  // One-way progress events during a translated export (main.js sends 'export-progress' while
  // translating/building a workbook, since a single invoke() call has no way to report interim
  // status on its own) -- the only ipcRenderer.on() listener in this app, everything else here
  // is request/response. Returns an unsubscribe function; callers remove it once their own
  // export call settles so a later, unrelated export's events are never delivered to a stale
  // handler from a previous one.
  onExportProgress: (callback) => {
    const listener = (event, message) => callback(message);
    ipcRenderer.on('export-progress', listener);
    return () => ipcRenderer.removeListener('export-progress', listener);
  },
  extractRecipeForExtractor: (payload) => ipcRenderer.invoke('extract-recipe-for-extractor', payload),

  generateMenu: (payload) => ipcRenderer.invoke('generate-menu', payload),
  listGeneratedMenus: () => ipcRenderer.invoke('list-generated-menus'),
  getLatestGeneratedMenu: (sectionCode) => ipcRenderer.invoke('get-latest-generated-menu', sectionCode),
  getGeneratedMenuDetail: (id) => ipcRenderer.invoke('get-generated-menu-detail', id),
  deleteGeneratedMenus: (menuIds) => ipcRenderer.invoke('delete-generated-menus', menuIds),
  swapMenuItem: (payload) => ipcRenderer.invoke('swap-menu-item', payload),
  getEligibleSwapItems: (payload) => ipcRenderer.invoke('get-eligible-swap-items', payload),

  exportMenuToExcel: (payload) => ipcRenderer.invoke('export-menu-to-excel', payload),
  exportAllSectionsToExcel: (payload) => ipcRenderer.invoke('export-all-sections-to-excel', payload),
  generateAndExportAll: (payload) => ipcRenderer.invoke('generate-and-export-all', payload),

  getSectionSlots: (sectionCode) => ipcRenderer.invoke('get-section-slots', sectionCode),
  getSchoolDays: (payload) => ipcRenderer.invoke('get-school-days', payload),
  getSchoolDayCount: (payload) => ipcRenderer.invoke('get-school-day-count', payload),
  getSectionItemPool: (sectionCode) => ipcRenderer.invoke('get-section-item-pool', sectionCode),
  builderFillSuggestions: (payload) => ipcRenderer.invoke('builder-fill-suggestions', payload),
  saveManualMenu: (payload) => ipcRenderer.invoke('save-manual-menu', payload),
  exportBlankTemplate: (payload) => ipcRenderer.invoke('export-blank-template', payload),
});
