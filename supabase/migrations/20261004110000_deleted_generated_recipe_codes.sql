-- Recipe Generator bulk delete (2026-10-04): the RG codes of deleted confirmed recipes, so a code is never given to another
-- recipe (the next code = the highest number among codes in use AND here, plus one). One row per deleted confirmed recipe.
-- Additive. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied, deleting a
-- CONFIRMED recipe is refused (deleting drafts -- which have no code -- works as before).

create table if not exists public.deleted_generated_recipe_codes (
  code         text        primary key,
  recipe_name  text,
  deleted_by   text,
  deleted_at   timestamptz not null default now()
);

alter table public.deleted_generated_recipe_codes enable row level security;

drop policy if exists "Allow authenticated full access" on public.deleted_generated_recipe_codes; -- so the file can be run twice
create policy "Allow authenticated full access" on public.deleted_generated_recipe_codes
  for all to authenticated using (true) with check (true);
