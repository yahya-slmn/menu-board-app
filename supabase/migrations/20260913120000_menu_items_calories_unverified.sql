-- Dish Catalog calorie estimates now always get written (never left blank), even when a value
-- fails the plausibility sanity check both times (see main.js's estimate-missing-calories and
-- checkCaloriePlausibility) -- this flag is what keeps that "AI best guess, no real data to
-- ground it" case visibly distinct from a normal, plausible estimate, instead of the two looking
-- identical in the Dish Catalog. Defaults false so every existing row (all estimated under the
-- old leave-blank-on-failure behavior, so implicitly "not flagged" -- there was never a written-
-- but-implausible value to begin with) reads as verified without needing a backfill.
alter table public.menu_items
  add column if not exists calories_unverified boolean not null default false;

comment on column public.menu_items.calories_unverified is
  'True when calories_per_100g was written even though it failed the plausibility sanity check on both the initial estimate and its retry (no real recipe/ingredient data was available to ground it) -- surfaced in the Dish Catalog UI so chef review can tell it apart from a normal estimate.';
