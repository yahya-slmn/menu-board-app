-- Recipe on Fire, Shape & Place: chef-configurable dough shape presets.
--
-- The game builds every dough piece procedurally from a handful of numbers, so a "shape" is now just
-- a name, a real-world weight and those numbers (a geometry type plus length/width/height, taper and
-- score slashes) -- no reference photos. This repurposes the existing `dough_shapes` table instead of
-- adding a second one: purely ADDITIVE, every new column is nullable or defaulted, so existing rows
-- and the current Dough Shapes screen keep working untouched. Nothing is dropped here (the photo
-- table, the storage bucket and the image edge function are removed separately, later).

alter table public.dough_shapes
  -- Geometry type; the game only knows these four.
  add column if not exists archetype text check (archetype in ('ball', 'disc', 'log', 'oval')),
  -- Raw (un-proofed) size at `unit_weight_grams`, cm. For a ball/disc, length = width = diameter.
  add column if not exists length_cm numeric check (length_cm > 0),
  add column if not exists width_cm numeric check (width_cm > 0),
  add column if not exists height_cm numeric check (height_cm > 0),
  -- 0 = rounded ends, 1 = pointed baguette ends (long loaves only).
  add column if not exists taper numeric check (taper between 0 and 1),
  -- Number of score slashes across the top (long loaves / ovals).
  add column if not exists score_count integer check (score_count between 0 and 9),
  add column if not exists sort_order integer not null default 100,
  -- "Delete" in the app archives instead of deleting: dough_shape_photos.dough_shape_id is
  -- ON DELETE CASCADE, so a real delete would wipe a shape's legacy photo rows.
  add column if not exists archived boolean not null default false;

-- The four starting presets. A row that already exists under one of these names (created earlier on
-- the Dough Shapes screen) keeps the chef's own name, weight and size; only its empty new columns are
-- filled in, using its existing size_cm as the length.
insert into public.dough_shapes (name, unit_weight_grams, size_cm, archetype, length_cm, width_cm, height_cm, taper, score_count, sort_order)
values
  ('Burger Ball',   90,  9.5, 'ball', 9.5, 9.5, 4.6, 0,    0, 10),
  ('Long Baguette', 250, 48,  'log',  48,  5.4, 3.4, 0.85, 5, 20),
  ('Mini Baguette', 60,  18,  'log',  18,  4,   2.9, 0.8,  3, 30),
  ('Ciabatta',      220, 24,  'oval', 24,  10,  3.4, 0,    0, 40)
on conflict (name) do update set
  archetype   = coalesce(public.dough_shapes.archetype, excluded.archetype),
  length_cm   = coalesce(public.dough_shapes.length_cm, public.dough_shapes.size_cm, excluded.length_cm),
  width_cm    = coalesce(public.dough_shapes.width_cm, excluded.width_cm),
  height_cm   = coalesce(public.dough_shapes.height_cm, excluded.height_cm),
  taper       = coalesce(public.dough_shapes.taper, excluded.taper),
  score_count = coalesce(public.dough_shapes.score_count, excluded.score_count),
  sort_order  = case when public.dough_shapes.archetype is null then excluded.sort_order else public.dough_shapes.sort_order end;
