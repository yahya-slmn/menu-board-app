-- Recipe Generator: Drafts is now sub-grouped by which day of the source menu a dish came from,
-- within each menu's own folder (extends the existing folder-by-source_menu_label grouping) --
-- requires persisting the day, which generated_recipes had no column for at all before this
-- (only date_created, the GENERATION date, never the menu's own day/date). Nullable and free
-- text on purpose, same treatment as source_menu_label: a single human-readable display string
-- ("Monday 14-09-2026", see main.js's formatDayLabel), not separate structured date/weekday
-- columns, since nothing needs to sort or query by it -- it's read-only grouping/display text.
-- Null for any recipe generated via the AI-assisted layout-agnostic fallback parse path (that
-- pass doesn't currently extract a day/date header at all, only category) or for any recipe
-- generated before this column existed -- Drafts simply shows no day sub-heading for those,
-- same "unknown grouping key" treatment source_menu_label's own "Unknown source" fallback uses.
alter table public.generated_recipes
  add column if not exists source_day_label text;

comment on column public.generated_recipes.source_day_label is
  'Human-readable day/date label (e.g. "Monday 14-09-2026") from the source menu row this recipe was generated from -- the FIRST occurrence''s day when the same dish repeated across multiple days in one upload. Null when the source parse pass never captured a day (always true for the AI-assisted fallback path today) or for recipes generated before this column existed.';
