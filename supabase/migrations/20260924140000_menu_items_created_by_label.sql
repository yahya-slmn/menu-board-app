-- Dish Catalog "Created By": a free-text attribution label per catalog item. Purely ADDITIVE: one
-- nullable column, no default, plus a one-time backfill of the rows that exist right now.
--
-- created_by_label is informal attribution ("AI", "OLD", "Tetiana", ...), edited freely in the Dish
-- Catalog list and the Add / Edit Item form. It is NOT provenance: is_ai_generated (and
-- ai_menu_run_id) stay the source of truth for "made by the AI Menu Generator", and editing the
-- label never changes them (the AI chip, the AI-generated filter and the calorie scope keep using
-- the flag).
--
-- Backfill: AI-generated items -> 'AI', every other existing item -> 'OLD' ("existed before this
-- change"). Only blanks are filled, so re-running this changes nothing. New items added by hand
-- start blank; the AI Menu Generator's Approve writes 'AI' on the dishes it creates.

begin;

alter table public.menu_items
  add column if not exists created_by_label text;

update public.menu_items
   set created_by_label = case when is_ai_generated then 'AI' else 'OLD' end
 where created_by_label is null;

commit;

notify pgrst, 'reload schema';
