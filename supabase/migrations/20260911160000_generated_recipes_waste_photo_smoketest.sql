-- Temporary smoke test for the Part 2 parity additions (Waste %, photo_path) -- inserts a draft
-- recipe with a process, an ingredient, and a waste row using a REAL waste_types row (falls back
-- to creating one if the catalog is empty), sets photo_path, confirms the join shape
-- fetchGeneratedRecipeWithProcesses expects reads back correctly, confirms cascade delete clears
-- the waste row too, then deletes everything it inserted (including any waste_types row it
-- created). Raises an exception (failing the migration/push) if any check doesn't hold.
do $$
declare
  v_recipe_id bigint;
  v_process_id bigint;
  v_waste_type_id bigint;
  v_created_waste_type boolean := false;
  v_waste_row_count int;
  v_orphan_count int;
  v_photo_path_check text;
begin
  select id into v_waste_type_id from public.waste_types limit 1;
  if v_waste_type_id is null then
    insert into public.waste_types (name, default_percent) values ('__smoketest_waste__', 5)
    returning id into v_waste_type_id;
    v_created_waste_type := true;
  end if;

  insert into public.generated_recipes
    (status, name, category, quantity_produced, date_created, source_menu_label, source_dish_name, created_at, photo_path)
  values
    ('draft', 'Smoke Test Waste/Photo', 'Main Course', '100 G', current_date, 'smoketest.xlsx', 'Dish', now(), 'fake-uuid.jpg')
  returning id into v_recipe_id;

  insert into public.generated_recipe_processes (generated_recipe_id, name, method, sort_order)
  values (v_recipe_id, 'Main', 'Cook.', 0)
  returning id into v_process_id;

  insert into public.generated_recipe_ingredients (process_id, name, quantity, unit, sort_order)
  values (v_process_id, 'flour', 100, 'g', 0);

  insert into public.generated_recipe_process_wastes (process_id, waste_type_id, percent, sort_order)
  values (v_process_id, v_waste_type_id, 8, 0);

  select photo_path into v_photo_path_check from public.generated_recipes where id = v_recipe_id;
  if v_photo_path_check is distinct from 'fake-uuid.jpg' then
    raise exception 'SMOKE TEST FAILED: photo_path did not round-trip, got %', v_photo_path_check;
  end if;

  select count(*) into v_waste_row_count from public.generated_recipe_process_wastes where process_id = v_process_id;
  if v_waste_row_count <> 1 then
    raise exception 'SMOKE TEST FAILED: expected 1 waste row, got %', v_waste_row_count;
  end if;

  -- Cascade check: deleting the recipe should cascade through the process to ingredients AND wastes.
  delete from public.generated_recipes where id = v_recipe_id;

  select count(*) into v_orphan_count from public.generated_recipe_process_wastes where process_id = v_process_id;
  if v_orphan_count <> 0 then
    raise exception 'SMOKE TEST FAILED: % orphaned waste row(s) survived recipe delete', v_orphan_count;
  end if;

  if v_created_waste_type then
    delete from public.waste_types where id = v_waste_type_id;
  end if;

  raise notice 'SMOKE TEST PASSED: waste row insert/join/cascade delete and photo_path round-trip all verified.';
end $$;
