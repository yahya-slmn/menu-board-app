-- Ingredient name map (unification phase U2, 2026-10-03). ONE ingredients master list (public.ingredients, the company's
-- purchasing list: "Oil Olive", "Spice Cumin Seed", "Flour Wheat White") is what every recipe will link to. Recipes are
-- written with kitchen names ("olive oil", "cumin", "flour"), so exact matching alone links only ~3% of them. The chef
-- decides, ONCE per name, which master product a kitchen name means; that decision is stored here and is itself an exact
-- match from then on. Nothing is linked or created silently.
--
-- ingredient_aliases: one row per spelling (name_key = lowercased, single-spaced -- the matching rule):
--   decision 'alias'      -> ingredient_id is the master product this spelling means
--   decision 'per_recipe' -> no product: the word means different products in different dishes; each recipe asks
-- ingredients.added_from / added_by: rows created in the name review are marked 'name_review' (not from the purchasing
--   list; no FB- product code until purchasing gives one). Existing rows stay NULL.
-- ingredient_merge_history: one row per duplicate merged into another (recipe rows and aliases moved, the duplicate's
--   name kept as an alias of the survivor, the duplicate deleted).
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied the Name map
-- tab says so and nothing else changes.

create table if not exists public.ingredient_aliases (
  id             bigint generated always as identity primary key,
  name_key       text        not null unique,
  display_name   text        not null,
  ingredient_id  bigint      references public.ingredients (id) on delete cascade,
  decision       text        not null default 'alias' check (decision in ('alias', 'per_recipe')),
  decided_by     text,
  decided_at     timestamptz not null default now(),
  check (decision = 'per_recipe' or ingredient_id is not null)
);
create index if not exists ingredient_aliases_ingredient_idx on public.ingredient_aliases (ingredient_id);

alter table public.ingredients add column if not exists added_from text;
alter table public.ingredients add column if not exists added_by text;

create table if not exists public.ingredient_merge_history (
  id                   bigint generated always as identity primary key,
  survivor_id          bigint references public.ingredients (id) on delete set null,
  survivor_name        text,
  merged_id            bigint,
  merged_name          text,
  merged_product_code  text,
  kept_product_code    text,
  recipe_rows_moved    integer not null default 0,
  aliases_moved        integer not null default 0,
  merged_by            text,
  merged_at            timestamptz not null default now()
);

alter table public.ingredient_aliases enable row level security;
alter table public.ingredient_merge_history enable row level security;

drop policy if exists "Allow authenticated full access" on public.ingredient_aliases; -- so the file can be run twice
create policy "Allow authenticated full access" on public.ingredient_aliases
  for all to authenticated using (true) with check (true);
drop policy if exists "Allow authenticated full access" on public.ingredient_merge_history;
create policy "Allow authenticated full access" on public.ingredient_merge_history
  for all to authenticated using (true) with check (true);
