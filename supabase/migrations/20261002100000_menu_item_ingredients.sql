-- Dish Catalog ingredients (phase M1, 2026-10-02): a chef-approved Menu Ingredients list saved ON the catalog dish, so a
-- later Menu Ingredients upload can reuse it instead of asking the AI. Stored on menu_items (not a separate table of
-- dishes): the catalog stays the one list of which dishes exist.
--
-- menu_items.ingredients_text / allergens_text: the CURRENT approved list, in the Menu Ingredients format
--   ("chicken - basmati rice - onion ..."). It is the dish's general list: on reuse the app runs it through the same
--   per-section code filters as an AI answer (nut / sesame, spicy, halal, student seafood), so safety never depends on
--   what was stored. NULL = nothing saved; the dish goes to the AI as today.
-- ingredients_updated_at: when the list last changed. A save checks it is still the value the preview read (two people
--   may save at once), so an upload never overwrites a newer list silently.
-- ingredients_updated_by: the login that saved it (text, as ai_menu_runs.created_by).
-- ingredients_source: where it came from -- 'menu_upload' (an approved Menu Ingredients file) or 'manual' (Add / Edit Item).
--
-- menu_item_ingredient_history: one row per change, append-only (old and new text, who, when, from which file), for
--   checking and undoing. Nothing reads it to decide what a menu uses: that is always the current list on menu_items.
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Older app builds ignore these
-- columns; until it is applied the app works as before.

alter table public.menu_items add column if not exists ingredients_text text;
alter table public.menu_items add column if not exists allergens_text text;
alter table public.menu_items add column if not exists ingredients_updated_at timestamptz;
alter table public.menu_items add column if not exists ingredients_updated_by text;
alter table public.menu_items add column if not exists ingredients_source text;

create table if not exists public.menu_item_ingredient_history (
  id              bigint generated always as identity primary key,
  item_id         bigint      not null references public.menu_items (id) on delete cascade,
  old_ingredients text,
  new_ingredients text,
  old_allergens   text,
  new_allergens   text,
  source          text        not null,              -- 'menu_upload' | 'manual'
  source_file     text,                              -- the uploaded file's name, for a 'menu_upload'
  changed_by      text,
  changed_at      timestamptz not null default now()
);

create index if not exists menu_item_ingredient_history_item_idx on public.menu_item_ingredient_history (item_id, changed_at desc);

alter table public.menu_item_ingredient_history enable row level security;

drop policy if exists "Allow authenticated full access" on public.menu_item_ingredient_history; -- so the file can be run twice
create policy "Allow authenticated full access" on public.menu_item_ingredient_history
  for all to authenticated using (true) with check (true);
