-- Smoke test for this round's two changes:
--  1. generated_recipe_process_wastes accepts inserts referencing a real waste_types row (the
--     exact shape resolveWasteTypeId/persistGeneratedRecipeDraft now write), and the
--     ilike-exact-match pattern resolveWasteTypeId uses actually matches case-insensitively.
--  2. The update-waste-type cascade fix -- confirms an UPDATE on generated_recipe_process_wastes
--     scoped by waste_type_id (the exact query the fixed IPC handler now runs) correctly reaches
--     a row referencing that type.
-- Cleans up everything it inserted (including the waste_types row) afterward.
do $$
declare
  v_waste_type_id bigint;
  v_ilike_match_id bigint;
  v_recipe_id bigint;
  v_process_id bigint;
  v_percent_after_cascade numeric;
begin
  insert into public.waste_types (name, default_percent) values ('__Smoketest Waste__', 12)
  returning id into v_waste_type_id;

  -- Case-insensitive exact match, same query resolveWasteTypeId runs.
  select id into v_ilike_match_id from public.waste_types where name ilike '__smoketest waste__' limit 1;
  if v_ilike_match_id is distinct from v_waste_type_id then
    raise exception 'SMOKE TEST FAILED: case-insensitive exact match did not find the waste type (got %)', v_ilike_match_id;
  end if;

  insert into public.generated_recipes
    (status, name, category, quantity_produced, date_created, source_menu_label, source_dish_name, created_at)
  values
    ('draft', 'Smoke Test Waste Generation', 'Main Course', '100 G', current_date, 'smoketest.xlsx', 'Dish', now())
  returning id into v_recipe_id;

  insert into public.generated_recipe_processes (generated_recipe_id, name, method, sort_order)
  values (v_recipe_id, 'Main', 'Cook.', 0)
  returning id into v_process_id;

  insert into public.generated_recipe_process_wastes (process_id, waste_type_id, percent, sort_order)
  values (v_process_id, v_waste_type_id, 12, 0);

  -- The exact query update-waste-type's cascade branch now runs for this third table.
  update public.generated_recipe_process_wastes set percent = 20 where waste_type_id = v_waste_type_id;

  select percent into v_percent_after_cascade from public.generated_recipe_process_wastes where process_id = v_process_id;
  if v_percent_after_cascade <> 20 then
    raise exception 'SMOKE TEST FAILED: cascade update did not reach generated_recipe_process_wastes (got %)', v_percent_after_cascade;
  end if;

  delete from public.generated_recipes where id = v_recipe_id;
  delete from public.waste_types where id = v_waste_type_id;

  raise notice 'SMOKE TEST PASSED: ilike exact match and generated_recipe_process_wastes cascade update both verified.';
end $$;
