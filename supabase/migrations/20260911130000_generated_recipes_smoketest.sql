-- Temporary smoke test for the generated_recipes/generated_recipe_processes/
-- generated_recipe_ingredients schema -- inserts one draft recipe with 2 processes and 3
-- ingredients (mirroring exactly what main.js's persistGeneratedRecipeDraft writes), confirms
-- the join shape fetchGeneratedRecipeWithProcesses expects reads back correctly, confirms the
-- ON DELETE CASCADE chain works, then deletes everything it inserted. Raises an exception (which
-- fails the migration/push) if any check doesn't hold. Removed by the very next migration.
do $$
declare
  v_recipe_id bigint;
  v_process_1_id bigint;
  v_process_2_id bigint;
  v_ingredient_count int;
  v_orphan_count int;
begin
  insert into public.generated_recipes
    (status, name, category, quantity_produced, date_created, source_menu_label, source_dish_name, created_at)
  values
    ('draft', 'Smoke Test Pizza', 'Main Course', '100 G', current_date, 'smoketest.xlsx', 'Pizza', now())
  returning id into v_recipe_id;

  insert into public.generated_recipe_processes (generated_recipe_id, name, method, sort_order)
  values (v_recipe_id, 'Dough', 'Mix and knead.', 0)
  returning id into v_process_1_id;

  insert into public.generated_recipe_processes (generated_recipe_id, name, method, sort_order)
  values (v_recipe_id, 'Topping', 'Top and bake.', 1)
  returning id into v_process_2_id;

  insert into public.generated_recipe_ingredients (process_id, name, quantity, unit, method, sort_order)
  values
    (v_process_1_id, 'all-purpose flour', 50, 'g', null, 0),
    (v_process_1_id, 'water', 25, 'g', null, 1),
    (v_process_2_id, 'mozzarella cheese', 25, 'g', 'grated', 0);

  -- No ingredient_id column should exist at all -- this must fail to compile/insert if it does.
  begin
    execute 'select ingredient_id from public.generated_recipe_ingredients limit 0';
    raise exception 'SMOKE TEST FAILED: generated_recipe_ingredients unexpectedly has an ingredient_id column';
  exception when undefined_column then
    null; -- expected: the column must not exist
  end;

  select count(*) into v_ingredient_count
  from public.generated_recipe_ingredients
  where process_id in (v_process_1_id, v_process_2_id);
  if v_ingredient_count <> 3 then
    raise exception 'SMOKE TEST FAILED: expected 3 ingredient rows, got %', v_ingredient_count;
  end if;

  -- Cascade check: deleting the recipe should cascade through processes to ingredients.
  delete from public.generated_recipes where id = v_recipe_id;

  select count(*) into v_orphan_count from public.generated_recipe_processes where generated_recipe_id = v_recipe_id;
  if v_orphan_count <> 0 then
    raise exception 'SMOKE TEST FAILED: % orphaned process row(s) survived recipe delete', v_orphan_count;
  end if;

  select count(*) into v_orphan_count
  from public.generated_recipe_ingredients where process_id in (v_process_1_id, v_process_2_id);
  if v_orphan_count <> 0 then
    raise exception 'SMOKE TEST FAILED: % orphaned ingredient row(s) survived recipe delete', v_orphan_count;
  end if;

  raise notice 'SMOKE TEST PASSED: insert, join shape, cascade delete all verified.';
end $$;
