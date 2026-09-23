-- Menu rules v2 (Phase B) -- READ-ONLY pre-flight. Run this BEFORE
-- 20260924100000_menu_rules_v2.sql; it changes nothing.

-- 1. Protein types today (the migration adds VEGAN, distinct from VEGETARIAN).
select id, code, name from public.protein_types order by id;

-- 2. The category the three fixed Staff beverages replace, and the columns a new categories row
--    needs (the migration copies meal_period_id / sort_order from STAFF_JUICE).
select c.id, c.code, c.name, c.meal_period_id, c.sort_order from public.categories c
where c.code in ('STAFF_JUICE', 'STAFF_BREAKFAST_JUICE', 'STAFF_FRUIT_BASKET', 'STAFF_WATER', 'STAFF_SOFT_DRINK', 'STAFF_FRESH_JUICE')
order by c.sort_order;
select column_name, is_nullable, column_default from information_schema.columns
where table_schema = 'public' and table_name in ('categories', 'menu_slots', 'protein_types')
order by table_name, ordinal_position;

-- 3. What is in Staff's Juice category now, and any existing water / soft drink items anywhere --
--    candidates for the three fixed beverages (you add or re-file them in the Dish Catalog after
--    the migration; see its step 5).
select mi.id, mi.name, c.code as category, mi.is_daily_repeating, mi.is_active
from public.menu_items mi join public.categories c on c.id = mi.category_id
where c.code = 'STAFF_JUICE'
   or mi.name ilike '%water%' or mi.name ilike '%soft drink%' or mi.name ilike '%soda%' or mi.name ilike '%pepsi%' or mi.name ilike '%cola%'
order by c.code, mi.name;

-- 4. Staff Main's current meat-free dishes (Phase C's vegan review starts from these) and how many
--    Staff Main dishes still have no starch type (Phase C's backfill fills those).
select mi.id, mi.name, pt.code as protein, mi.carb_type
from public.menu_items mi
join public.categories c on c.id = mi.category_id
left join public.protein_types pt on pt.id = mi.protein_type_id
where c.code = 'STAFF_MAIN' and mi.is_active = 1 and (pt.code = 'VEGETARIAN' or pt.code is null)
order by mi.name;
select count(*) filter (where carb_type is null) as without_starch_type, count(*) as staff_main_active
from public.menu_items mi join public.categories c on c.id = mi.category_id
where c.code = 'STAFF_MAIN' and mi.is_active = 1;
