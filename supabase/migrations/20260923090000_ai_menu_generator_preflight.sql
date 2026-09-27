-- AI Menu Generator, Phase 0 -- READ-ONLY pre-flight. Run this BEFORE
-- 20260923100000_ai_menu_generator.sql and paste the results back.
--
-- The draft table's check constraints on sauce_type / carb_type / dish_concept / am_snack_style
-- use the value lists from db/schema.sql's comments (the SQLite original). The app never writes
-- those three columns itself, so the live catalog may hold values the comments don't list. If
-- query 1 shows any value outside the lists in the migration, the constraints must be widened
-- first: an AI dish tagged with a value real rows don't use would never collide with them in the
-- "different sauce / carb / concept" rules.

-- 1. Attribute values actually in use.
select 'sauce_type' as attr, sauce_type as value, count(*) from public.menu_items where sauce_type is not null group by sauce_type
union all
select 'carb_type', carb_type, count(*) from public.menu_items where carb_type is not null group by carb_type
union all
select 'dish_concept', dish_concept, count(*) from public.menu_items where dish_concept is not null group by dish_concept
union all
select 'am_snack_style', am_snack_style, count(*) from public.menu_items where am_snack_style is not null group by am_snack_style
order by 1, 2;

-- 2. Protein type codes (the AI's protein_code must be one of these).
select id, code, name from public.protein_types order by id;

-- 3. Column types the new foreign keys / batch link must match.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'menu_items' and column_name = 'id')
    or (table_name = 'generated_menus' and column_name = 'batch_id'));

-- 4. Confirms where KG-LP's fixed "Laban and bun bread" comes from: expected to be an
--    is_daily_repeating = 1 row in SOUP_APPETIZER linked to KG-LP's age groups.
select distinct mi.id, mi.name, c.code as category, mi.is_daily_repeating, s.code as section
from public.menu_items mi
join public.categories c on c.id = mi.category_id
join public.item_portions ip on ip.item_id = mi.id
join public.age_groups ag on ag.id = ip.age_group_id
join public.sections s on s.id = ag.section_id
where mi.is_daily_repeating = 1 and mi.is_active = 1
order by section, category, mi.name;
