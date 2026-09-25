-- CEO menu structure v2 (2026-09-25) -- the "September week_04" layout.
--   Breakfast: Main Dish, Juice, Yogurt          Lunch: Main Dish (+ Protein label), Salad, Juice, Snack, Bread
--
-- The only database change: the CEO Fruits category is RENAMED to Snack. Its code stays CEO_FRUITS
-- (the app refers to it by code), and its dishes become the Snack pool unchanged.
-- Everything else is in the app's code (lib/generator.js SECTION_SLOTS.CEO, lib/export.js):
--   * CEO_RAW_VEG retires forward-only: the category and its dishes stay exactly as they are, it is
--     just no longer generated; old menus keep their Raw Veg row when re-exported.
--   * "Protein" is a second label on the Lunch Main Dish's own cell in the export, not a category.
--   * menu_slots needs nothing: the engine adds CEO's slot rows itself as menus are saved.
-- Nothing is deleted; history is untouched. Safe to run twice.

-- Before: the current name.
select id, code, name from public.categories where code = 'CEO_FRUITS';

-- Replaces the word, whatever the exact wording is ("CEO Fruits" -> "CEO Snack", "Fruits" -> "Snack").
update public.categories
set name = regexp_replace(name, 'Fruits?', 'Snack', 'i')
where code = 'CEO_FRUITS' and name ~* 'fruit';

-- After: check the new name reads right.
select id, code, name from public.categories where code = 'CEO_FRUITS';
