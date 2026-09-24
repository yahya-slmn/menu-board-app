-- TURKEY as a real protein type (2026-09-24). Purely ADDITIVE: one row, only if it isn't there yet.
--
-- Without it the AI Menu Generator (whose protein choices come from this table) filed turkey dishes
-- as CHICKEN -- which the chicken / beef snack rule then blocks, and which in a KG-LP / MS-UP Lunch
-- Main counts as the day's chicken. Turkey counts as meat for the Staff Lunch Box "1 meat + 1
-- meat-free" rule (lib/generator.js / aiMenuGenerate.js / aiMenuRules.js). Not retroactive: no
-- existing dish is re-tagged; mistagged ones are listed by scripts/snack-chicken-beef-list.js and
-- fixed by hand in the Dish Catalog.

begin;

insert into public.protein_types (code, name)
select 'TURKEY', 'Turkey'
where not exists (select 1 from public.protein_types where code = 'TURKEY');

commit;

notify pgrst, 'reload schema';
