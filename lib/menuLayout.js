// Layout facts shared by the exporter (lib/export.js) and the parser that reads exports back in
// (lib/menuIngredients.js -- Menu Ingredients Generator and the Recipe Generator's upload). Kept in
// one place because the parser identifies a CEO sheet by these exact header names.
//
// The CEO sheet's two fixed person columns, left to right (each person's dish sits under their name).
const CEO_PERSONS = ['Dr Steffen', 'Khodary'];

module.exports = { CEO_PERSONS };
