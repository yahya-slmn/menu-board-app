-- General Ingredients (2026-10-06): a REFERENCE list of world ingredients (~2,150), imported once from the
-- kitchen_ingredients Excel file (sheet "Items", plus each item's departments from sheet "Department use").
--
-- It is NOT Nayyara Ingredients (public.ingredients, the company's purchasing list with FB- codes) and is not linked to
-- it: nothing in Recipe Book, the Name map, aliases, merges or any generator reads this table.
--
-- One row per item. item_code is the file's own code (ING-0000001 ...). name_key is the name lowercased with its spacing
-- tidied (trimmed, runs of spaces / tabs made one space) -- the same rule as ingredient_aliases.name_key -- worked out BY
-- THE DATABASE from name, so no writer can store it differently; it is unique, so the same name can't be added twice
-- whatever its case or spacing. parent_name is the file's parent ("deglet noor date" -> "date"), kept as plain text, not
-- a foreign key. departments = every department the file lists for the item (primary_department is one of them).
--
-- Additive only, safe to run twice. Apply BY HAND in the Supabase SQL editor (never `supabase db push`).

create table if not exists public.general_ingredients (
  id                  bigint generated always as identity primary key,
  item_code           text        not null unique,
  name                text        not null check (btrim(name) <> ''),
  name_key            text        generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  name_ar             text,
  parent_name         text,
  category            text,
  form                text,
  primary_department  text,
  item_type           text,
  storage             text,
  typical_uom         text,
  departments         text[]      not null default '{}',
  created_at          timestamptz not null default now(),
  created_by          text
);
create unique index if not exists general_ingredients_name_key_idx on public.general_ingredients (name_key);

alter table public.general_ingredients enable row level security;

drop policy if exists "Allow authenticated full access" on public.general_ingredients; -- so the file can be run twice
create policy "Allow authenticated full access" on public.general_ingredients
  for all to authenticated using (true) with check (true);

-- Verify (read-only; run after applying). Expected before the import:
--   table_exists true | columns 15 | rls_enabled true | policies 1 | unique_indexes 3 | name_key_generated true | rows 0
-- select
--   to_regclass('public.general_ingredients') is not null                                   as table_exists,
--   (select count(*) from information_schema.columns
--     where table_schema = 'public' and table_name = 'general_ingredients')                as columns,
--   (select relrowsecurity from pg_class where oid = 'public.general_ingredients'::regclass) as rls_enabled,
--   (select count(*) from pg_policies
--     where schemaname = 'public' and tablename = 'general_ingredients')                   as policies,
--   (select count(*) from pg_indexes
--     where schemaname = 'public' and tablename = 'general_ingredients'
--       and indexdef ilike 'create unique index%')                                         as unique_indexes,
--   (select is_generated = 'ALWAYS' from information_schema.columns
--     where table_schema = 'public' and table_name = 'general_ingredients'
--       and column_name = 'name_key')                                                      as name_key_generated,
--   (select count(*) from public.general_ingredients)                                      as rows;
