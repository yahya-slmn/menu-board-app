// The ingredient picker's "add" wording per screen (Nayyara Ingredients labels, 2026-10-06). The picker
// (renderAutocompleteList) is shared by the Recipe Book and the Recipe Extractor: the Recipe Book adds to Nayyara
// Ingredients (the `ingredients` table), the Extractor to its own list -- its wording must stay as it was.
// Runs the REAL RECIPE_NS and renderAutocompleteList out of renderer/renderer.js with a stand-in list element.
// No login, nothing written.  Usage: node scripts/ingredient-picker-labels-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// The source of `start ... { ... }`, braces counted from the first `{` after `start`.
function block(startText) {
  const at = src.indexOf(startText);
  if (at < 0) throw new Error(`not found in renderer.js: ${startText}`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(at, i + 1);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

const alerts = [];
const ctx = {
  alert: (m) => alerts.push(m),
  window: { api: { addIngredient: async () => { throw new Error('offline'); } } },
  selectIngredientForRow: () => {},
};
vm.createContext(ctx);
vm.runInContext(`${block('const RECIPE_NS = {')};\n${block('function renderAutocompleteList(')}\nthis.RECIPE_NS = RECIPE_NS;`, ctx);

// A stand-in for the dropdown element: keeps the HTML, and hands back the "+ Add" row so its click can be run.
function fakeList() {
  const handlers = {};
  return {
    hidden: true,
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector(sel) {
      if (sel !== '[data-add]' || !this.innerHTML.includes('data-add')) return null;
      return { addEventListener: (type, fn) => { handlers[type] = fn; } };
    },
    async clickAdd() { await handlers.mousedown({ preventDefault() {} }); },
  };
}
const addText = (html) => (html.match(/data-add="1">([^<]*)</) || [])[1];

(async () => {
  const cases = [
    ['Recipe Book', ctx.RECIPE_NS.book, '+ Add "Sumac" to Nayyara Ingredients', 'Couldn\'t add "Sumac" to Nayyara Ingredients: offline'],
    ['Recipe Extractor', ctx.RECIPE_NS.extractor, '+ Add "Sumac" as new ingredient', 'Couldn\'t add "Sumac" as a new ingredient: offline'],
  ];
  for (const [name, ns, wantAdd, wantAlert] of cases) {
    ns.api.addIngredient = async () => { throw new Error('offline'); };
    const list = fakeList();
    renderList(ns, list, [{ id: 1, name: 'Sumac Ground', category: 'Spice', default_unit: 'G' }], 'Sumac');
    check(`${name}: the picker's add row reads ${JSON.stringify(wantAdd)}`, addText(list.innerHTML) === wantAdd, `got ${JSON.stringify(addText(list.innerHTML))}`);
    alerts.length = 0;
    await list.clickAdd();
    check(`${name}: a failed add says ${JSON.stringify(wantAlert)}`, alerts[0] === wantAlert, `got ${JSON.stringify(alerts[0])}`);

    const exactList = fakeList();
    renderList(ns, exactList, [{ id: 2, name: 'sumac', category: 'Spice', default_unit: 'G' }], 'Sumac');
    check(`${name}: no add row when the name is already there`, !exactList.innerHTML.includes('data-add'));
  }
  // Every screen with an ingredient search reaches the picker (the Recipe Generator's own form doesn't use it).
  const pickerScreens = Object.keys(ctx.RECIPE_NS).filter(k => ctx.RECIPE_NS[k].api.searchIngredients);
  check(`Every screen using the picker has its wording (${pickerScreens.join(', ')})`,
    pickerScreens.length === 2 && pickerScreens.every(k => ctx.RECIPE_NS[k].addIngredientWords && ctx.RECIPE_NS[k].addIngredientErrorWords));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll ingredient picker label checks passed.');
  process.exit(failures ? 1 : 0);
})();

function renderList(ns, listEl, matches, query) {
  ctx.__args = [ns, listEl, matches, query, {}, {}, {}];
  vm.runInContext('renderAutocompleteList(...__args)', ctx);
}
