-- Menu rules v2 (Phase B): schema for the rules confirmed 2026-09-23. Run the read-only
-- 20260924090000_menu_rules_v2_preflight.sql first.
--
-- Purely ADDITIVE: new rows and one new nullable column. Nothing existing is changed or removed --
-- STAFF_JUICE stays as a category (old menus in History still export with it); the app simply
-- stops scheduling it once Phase D ships, and schedules the three fixed beverages below instead.

begin;

-- 1. VEGAN protein type, distinct from VEGETARIAN. Rules that mean "meat-free" (Staff Breakfast,
--    Lunch Box) accept either one; Staff Main needs one of each.
insert into public.protein_types (code, name)
select 'VEGAN', 'Vegan'
where not exists (select 1 from public.protein_types where code = 'VEGAN');

-- 2. Staff's three FIXED lunch beverages (water, soft drink, fresh juice -- the same three every
--    day), replacing the rotating STAFF_JUICE pick. Same meal period and position as STAFF_JUICE.
insert into public.categories (meal_period_id, code, name, sort_order)
select j.meal_period_id, v.code, v.name, j.sort_order
from public.categories j
cross join (values ('STAFF_WATER', 'Water'), ('STAFF_SOFT_DRINK', 'Soft Drink'), ('STAFF_FRESH_JUICE', 'Fresh Juice')) as v(code, name)
where j.code = 'STAFF_JUICE'
  and not exists (select 1 from public.categories c where c.code = v.code);

-- 3. Staff's menu_slots rows for them, so the Dish Catalog offers these categories for Staff right
--    away (it lists a section's categories from menu_slots + the section's items; normally the row
--    is only created the first time a menu is saved). Same column values persistMenu writes.
insert into public.menu_slots (section_id, category_id, slot_order, items_required, require_distinct_protein, is_auto_filled)
select s.id, c.id, 0, 1, 0, 0
from public.sections s
cross join public.categories c
where s.code = 'STAFF' and c.code in ('STAFF_WATER', 'STAFF_SOFT_DRINK', 'STAFF_FRESH_JUICE')
  and not exists (select 1 from public.menu_slots m where m.section_id = s.id and m.category_id = c.id);

-- 4. National Day: the cuisine an AI draft dish was made for (null = a regular, non-Tuesday dish).
alter table public.ai_menu_draft_dishes add column if not exists cuisine text;
comment on column public.ai_menu_draft_dishes.cuisine is
  'National Day cuisine this dish was invented for (Tuesdays only), e.g. ''Turkish''; null for regular dishes.';

commit;

notify pgrst, 'reload schema';

-- 5. AFTER running this (not part of the migration): in the Dish Catalog, for Staff, add -- or
--    re-file with Edit -- one dish in each of Water, Soft Drink and Fresh Juice, tick "Repeats every
--    day automatically", and give it Staff's age group. That is what makes them fixed. Until each
--    has one, Generate Menu leaves that row empty and says so in its warnings. Then press Refresh
--    (top right) so the app sees the new categories.
