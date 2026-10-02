-- Master Items + Dish Variants (phase MV1, 2026-10-03). PURELY ADDITIVE: the Dish Catalog (menu_items) keeps every
-- column, row and meaning it has -- the menu engine, its composition rules, Build Menu and every export read it exactly
-- as before and never read anything below.
--
--   master_items   one row per truly distinct dish (one per exact name, case / spacing aside -- name_key)
--   dish_variants  the versions of a dish that really differ (MS-UP's Macaroni & Cheese vs Staff's), under one master
--                  item. A variant carries the chef-approved ingredient list (moved here from menu_items by MV2), and --
--                  ASSUMPTION A, to be confirmed -- its calories and its linked Recipe Book recipe (a recipe and its
--                  calories per 100 g describe one composition). Display name (lib/masterItemsPlan.js
--                  variantDisplayName): "<section names> — <date>" until a recipe is linked, then the recipe's name.
--   menu_items.dish_variant_id   which variant a Dish Catalog row USES (nullable; set by MV2's preview-then-confirm).
--                  The only new column on menu_items; nothing in the engine reads it. Deleting a variant only clears it.
--   menu_item_ingredient_history.dish_variant_id   history rows written after MV4 point at the variant they changed.
--
-- The menu_items ingredient / calorie columns are NOT dropped or changed: they stay as a frozen copy until the features
-- have moved (MV4 / MV5), then are dropped by hand much later.
--
-- Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied nothing changes.

create table if not exists public.master_items (
  id          bigint generated always as identity primary key,
  name        text        not null,
  name_key    text        not null unique,
  created_by  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.dish_variants (
  id                      bigint generated always as identity primary key,
  master_item_id          bigint      not null references public.master_items (id) on delete cascade,
  ingredients_text        text,
  allergens_text          text,
  ingredients_updated_at  timestamptz,
  ingredients_updated_by  text,
  ingredients_source      text,
  calories_per_100g       numeric,
  calories_unverified     boolean     not null default false,
  recipe_id               bigint      references public.recipes (id) on delete set null,
  created_by              text,
  created_at              timestamptz not null default now()
);
create index if not exists dish_variants_master_idx on public.dish_variants (master_item_id);

alter table public.menu_items add column if not exists dish_variant_id bigint references public.dish_variants (id) on delete set null;
create index if not exists menu_items_dish_variant_idx on public.menu_items (dish_variant_id);

alter table public.menu_item_ingredient_history add column if not exists dish_variant_id bigint references public.dish_variants (id) on delete set null;

alter table public.master_items enable row level security;
alter table public.dish_variants enable row level security;

drop policy if exists "Allow authenticated full access" on public.master_items; -- so the file can be run twice
create policy "Allow authenticated full access" on public.master_items
  for all to authenticated using (true) with check (true);
drop policy if exists "Allow authenticated full access" on public.dish_variants;
create policy "Allow authenticated full access" on public.dish_variants
  for all to authenticated using (true) with check (true);
