-- Menu Ingredients history (2026-10-06). Each Menu Ingredients generation is saved so the chef can reopen, edit and export it
-- later from the same screen (History tab). Reverses MI's earlier "nothing is saved" rule, on purpose. History never writes to
-- the Dish Catalog: M2 (saving approved lists) and M3 (reusing them) are unchanged.
--
--   menu_ingredient_runs        one row per upload (one or more files): who / when, the file names, and the review rows
--                               (section, category, day, row position, dish, ingredients, allergens, basis, removal notes,
--                               catalog note, "Same as" links, served-as-is rows) as gzip-compressed JSON in base64 (rows_gz).
--                               version: an edit is saved only if the version is still the one the editor opened (no one
--                               overwrites another's edits); updated_at / updated_by: the last save. complete: the original
--                               files are stored too (an entry whose files failed to save is shown as incomplete).
--   menu_ingredient_run_files   the original uploaded workbook(s), base64 -- export edits the original file, so it is kept.
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied, generation works as
-- before and the History tab says it needs this update.

create table if not exists public.menu_ingredient_runs (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  created_by    text,
  file_names    text[]      not null default '{}',
  row_count     integer     not null default 0,
  failed_files  jsonb,
  rows_gz       text        not null,
  data_format   smallint    not null default 1,
  complete      boolean     not null default false,
  version       integer     not null default 1,
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists menu_ingredient_runs_created_idx on public.menu_ingredient_runs (created_at desc);

create table if not exists public.menu_ingredient_run_files (
  run_id       bigint  not null references public.menu_ingredient_runs (id) on delete cascade,
  file_index   integer not null,
  file_name    text    not null,
  content_b64  text    not null,
  byte_size    integer not null,
  primary key (run_id, file_index)
);

alter table public.menu_ingredient_runs enable row level security;
alter table public.menu_ingredient_run_files enable row level security;

drop policy if exists "Allow authenticated full access" on public.menu_ingredient_runs; -- so the file can be run twice
create policy "Allow authenticated full access" on public.menu_ingredient_runs
  for all to authenticated using (true) with check (true);
drop policy if exists "Allow authenticated full access" on public.menu_ingredient_run_files;
create policy "Allow authenticated full access" on public.menu_ingredient_run_files
  for all to authenticated using (true) with check (true);
