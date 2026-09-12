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
  estimateMissingCalories: () => ipcRenderer.invoke('estimate-missing-calories'),
  // Same one-way-progress-events pattern as onExportProgress above (main.js sends
  // 'calorie-estimate-progress' while working through batches, since a single invoke() call has
  // no way to report interim status on its own). Returns an unsubscribe function, same reason.
  // Payload is now { message, current?, total? } (current/total omitted when this particular step
  // has no real count -- see createProgressPanel in renderer.js), not a bare string -- forwarded
  // through as-is, same as every other progress channel below.
  onCalorieEstimateProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('calorie-estimate-progress', listener);
    return () => ipcRenderer.removeListener('calorie-estimate-progress', listener);
  },
  estimateMissingAmSnackStyles: () => ipcRenderer.invoke('estimate-missing-am-snack-styles'),
  onAmSnackStyleEstimateProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('am-snack-style-estimate-progress', listener);
    return () => ipcRenderer.removeListener('am-snack-style-estimate-progress', listener);
  },

  parseAndSuggestMenuIngredients: (payload) => ipcRenderer.invoke('parse-and-suggest-menu-ingredients', payload),
  exportMenuIngredients: (payload) => ipcRenderer.invoke('export-menu-ingredients', payload),
  onMenuIngredientsProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('menu-ingredients-progress', listener);
    return () => ipcRenderer.removeListener('menu-ingredients-progress', listener);
  },

  searchIngredients: (query) => ipcRenderer.invoke('search-ingredients', query),
  addIngredient: (payload) => ipcRenderer.invoke('add-ingredient', payload),
  updateIngredient: (payload) => ipcRenderer.invoke('update-ingredient', payload),
  listIngredients: () => ipcRenderer.invoke('list-ingredients'),
  deleteIngredient: (id) => ipcRenderer.invoke('delete-ingredient', id),

  listWasteTypes: () => ipcRenderer.invoke('list-waste-types'),
  addWasteType: (payload) => ipcRenderer.invoke('add-waste-type', payload),
  updateWasteType: (payload) => ipcRenderer.invoke('update-waste-type', payload),
  deleteWasteType: (id) => ipcRenderer.invoke('delete-waste-type', id),

  listMaterials: () => ipcRenderer.invoke('list-materials'),
  searchMaterials: (query) => ipcRenderer.invoke('search-materials', query),
  getMaterial: (id) => ipcRenderer.invoke('get-material', id),
  saveMaterial: (payload) => ipcRenderer.invoke('save-material', payload),
  deleteMaterial: (id) => ipcRenderer.invoke('delete-material', id),
  getMaterialPhoto: (photoPath) => ipcRenderer.invoke('get-material-photo', photoPath),
  listRecipes: () => ipcRenderer.invoke('list-recipes'),
  searchRecipes: (query) => ipcRenderer.invoke('search-recipes', query),
  getRecipe: (id) => ipcRenderer.invoke('get-recipe', id),
  saveRecipe: (payload) => ipcRenderer.invoke('save-recipe', payload),
  deleteRecipe: (id) => ipcRenderer.invoke('delete-recipe', id),
  getRecipePhoto: (photoPath) => ipcRenderer.invoke('get-recipe-photo', photoPath),
  previewRecipe: (id) => ipcRenderer.invoke('preview-recipe', id),
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
  previewExtractedRecipe: (id) => ipcRenderer.invoke('preview-extracted-recipe', id),
  exportExtractedRecipes: (payload) => ipcRenderer.invoke('export-extracted-recipes', payload),
  exportScaledExtractedRecipe: (payload) => ipcRenderer.invoke('export-scaled-extracted-recipe', payload),
  // One-way progress events during a translated export (main.js sends 'export-progress' while
  // translating/building a workbook, since a single invoke() call has no way to report interim
  // status on its own) -- the only ipcRenderer.on() listener in this app, everything else here
  // is request/response. Returns an unsubscribe function; callers remove it once their own
  // export call settles so a later, unrelated export's events are never delivered to a stale
  // handler from a previous one.
  // Payload is { message, current?, total? } -- see onCalorieEstimateProgress's own comment.
  onExportProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('export-progress', listener);
    return () => ipcRenderer.removeListener('export-progress', listener);
  },
  extractRecipeForExtractor: (payload) => ipcRenderer.invoke('extract-recipe-for-extractor', payload),

  parseAndGenerateRecipes: (payload) => ipcRenderer.invoke('parse-and-generate-recipes', payload),
  // Shared manual "Generate Photo" button -- Recipe Book, Recipe Extractor, and Recipe
  // Generator's edit forms all call this same channel (see main.js's own comment on why one
  // handler covers all three).
  generateRecipePhoto: (payload) => ipcRenderer.invoke('generate-recipe-photo', payload),
  onRecipeGeneratorProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('recipe-generator-progress', listener);
    return () => ipcRenderer.removeListener('recipe-generator-progress', listener);
  },
  listGeneratedRecipeDrafts: () => ipcRenderer.invoke('list-generated-recipe-drafts'),
  listGeneratedRecipes: () => ipcRenderer.invoke('list-generated-recipes'),
  searchGeneratedRecipes: (query) => ipcRenderer.invoke('search-generated-recipes', query),
  getGeneratedRecipe: (id) => ipcRenderer.invoke('get-generated-recipe', id),
  getGeneratedRecipePhoto: (photoPath) => ipcRenderer.invoke('get-generated-recipe-photo', photoPath),
  saveGeneratedRecipe: (payload) => ipcRenderer.invoke('save-generated-recipe', payload),
  deleteGeneratedRecipe: (id) => ipcRenderer.invoke('delete-generated-recipe', id),
  previewGeneratedRecipe: (id) => ipcRenderer.invoke('preview-generated-recipe', id),
  exportGeneratedRecipes: (payload) => ipcRenderer.invoke('export-generated-recipes', payload),
  exportScaledGeneratedRecipe: (payload) => ipcRenderer.invoke('export-scaled-generated-recipe', payload),

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
