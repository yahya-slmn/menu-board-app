-- Dish code history (unification phase U1, 2026-10-03): every change to a Dish Catalog dish's code, kept for audit.
-- U1 removes every old code (menu_items.rc_code: 493 real RC codes and 1,614 dishes holding the literal text "NEW", per
-- the U0 measurement) -- one row here per dish cleared, with the code it had. Later phases record the TTY- codes dishes
-- get from their linked Recipe Book recipe (U3) in the same table.
--
--   item_id    the dish (kept as NULL if the dish is ever deleted, so the record of the code survives it)
--   item_name  the dish's name at the time, readable without a join
--   old_code / new_code   what the code was and became (new_code NULL = removed)
--   reason     'rc_removal' for U1
--   batch_id   one id per apply, so a whole removal can be found (and, if ever needed, undone) together
--
-- Additive only. Apply BY HAND in the Supabase SQL editor (never `supabase db push`). Until it is applied the app's
-- "Remove old codes" refuses to run (it never clears a code without writing its history).

create table if not exists public.menu_item_code_history (
  id          bigint generated always as identity primary key,
  item_id     bigint      references public.menu_items (id) on delete set null,
  item_name   text,
  old_code    text,
  new_code    text,
  reason      text        not null,
  batch_id    uuid,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

create index if not exists menu_item_code_history_item_idx on public.menu_item_code_history (item_id, changed_at desc);
create index if not exists menu_item_code_history_batch_idx on public.menu_item_code_history (batch_id);

alter table public.menu_item_code_history enable row level security;

drop policy if exists "Allow authenticated full access" on public.menu_item_code_history; -- so the file can be run twice
create policy "Allow authenticated full access" on public.menu_item_code_history
  for all to authenticated using (true) with check (true);
