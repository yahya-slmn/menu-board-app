-- Master Items MV3 + MV4 (2026-10-04): a list edited on a dish VERSION (dish_variants) belongs to the version, not to one
-- Dish Catalog row, so its history row has dish_variant_id and no item_id. Until now item_id was required (M2, migration
-- 20261002100000). Existing rows keep their item_id; nothing else changes.
--
-- Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Safe to run twice.

alter table public.menu_item_ingredient_history alter column item_id drop not null;

-- Every history row must still say WHAT it is about: a catalog row, a version, or both.
alter table public.menu_item_ingredient_history drop constraint if exists menu_item_ingredient_history_subject_chk;
alter table public.menu_item_ingredient_history add constraint menu_item_ingredient_history_subject_chk
  check (item_id is not null or dish_variant_id is not null);
