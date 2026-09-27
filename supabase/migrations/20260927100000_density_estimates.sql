-- Recipe on Fire: shared cache of AI density estimates (phase D2; lib/densityCache.js, lib/densityKey.js).
--
-- One row per composition and prompt version: a paid estimate is made once for everyone, on every machine. The key is a
-- sha256 of the mass's composition as PROPORTIONS (so a scaled recipe reuses it and an edited one gets a new estimate),
-- its type (dough / filling / mixed) and its method text. These are AI answers, not recipe data: no recipe table is
-- touched, and deleting every row only costs a re-estimate. Additive; safe to apply at any time -- until it is, the app
-- simply estimates without caching.

create table if not exists public.density_estimates (
  cache_key      text        not null,
  prompt_version integer     not null,
  density        numeric     not null check (density between 0.1 and 1.6),
  low            numeric     not null check (low between 0.1 and 1.6),
  high           numeric     not null check (high between 0.1 and 1.6),
  confidence     text        not null check (confidence in ('low', 'medium', 'high')),
  basis          text        not null default '',
  label          text,                                   -- the mass it was first estimated for, for reading the table only
  created_at     timestamptz not null default now(),
  created_by     uuid                 default auth.uid(),
  primary key (cache_key, prompt_version),
  check (low <= density and density <= high)
);

alter table public.density_estimates enable row level security;

drop policy if exists "Allow authenticated full access" on public.density_estimates; -- so the file can be run twice
create policy "Allow authenticated full access" on public.density_estimates
  for all to authenticated using (true) with check (true);
