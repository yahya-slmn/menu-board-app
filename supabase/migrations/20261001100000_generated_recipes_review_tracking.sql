-- Recipe Generator keeps the chef's reviewed ingredient list (Menu Ingredients -> Recipe Generator pipeline, Phase F).
--
-- generated_recipe_ingredients.origin: where a recipe's ingredient row came from, worked out in code at generation by
--   matching its name against the reviewed list (case and spacing ignored): 'reviewed' (on her list) or 'added' (the AI
--   added it -- the method needed it). NULL: no reviewed list (a plain menu), a recipe from before this column, or a row
--   she typed or renamed herself in the draft form.
-- generated_recipe_ingredients.override_policy: set when a reviewed ingredient was KEPT although a code filter would
--   have removed it -- her deliberate override, shown as "chef-confirmed override". Only 'nut' (nut / sesame false
--   positives). Student seafood is never overridden (decided with the chef 2026-10-01).
-- generated_recipes.review_flags: what the draft needs her to look at, as JSON:
--   { "missing": [reviewed ingredients the recipe still left out after one retry],
--     "seafoodRemoved": [reviewed ingredients removed because the dish is on a student menu] }
--   NULL when there is nothing to flag.
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied the app saves
-- drafts as before, without these markers.
alter table public.generated_recipe_ingredients add column if not exists origin text;
alter table public.generated_recipe_ingredients add column if not exists override_policy text;
alter table public.generated_recipes add column if not exists review_flags jsonb;
