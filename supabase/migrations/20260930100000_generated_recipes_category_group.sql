-- Recipe Generator: the menu category group a draft came from (AM Snack, Main Course, Lunch Box, ...), so drafts and
-- confirmed recipes can be grouped by category within each day (lib/recipeCategoryGroups.js, CATEGORY_GROUPS keys).
-- Set once at generation from the parsed menu row (its category label AND meal period: Staff's "Main Dish" is
-- Breakfast's or Lunch's only by period), never edited afterwards. NULL on recipes generated before this column:
-- the app then guesses from the category text.
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`: the CLI's history lists the
-- hand-applied migrations since 2026-09-23 as unapplied). Until it is applied the app still works: it saves drafts
-- without the group and groups every recipe by its category text.
alter table public.generated_recipes add column if not exists source_category_group text;
