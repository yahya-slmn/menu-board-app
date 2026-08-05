# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app that generates recurring school/staff meal menus from a
tagged catalog of menu items, stored in Supabase (Postgres). It's not a
build-tooled web app — no bundler, no framework, no test runner. The renderer
is plain HTML/CSS/JS loaded directly by Electron.

Originally built on a local SQLite database (`better-sqlite3`); fully migrated
to Supabase across several stages. There is no local database of any kind
anymore — every read and write goes over the network to Supabase.

## Commands

```bash
npm install       # no native modules to rebuild anymore (better-sqlite3 is gone)
npm start          # launch the app (electron .)
npm run build:mac  # package a signed-for-local-use .app into dist/
```

There is no lint, test, or typecheck script — none are configured in this repo.

**Login is required on every launch.** `lib/supabaseClient.js` creates the
Supabase client with `persistSession: false` (there's no `localStorage` in the
main process to persist into), so quitting and reopening the app always shows
the login screen again — this is intentional, not a bug.

**RLS gotcha:** every table has row-level security requiring an authenticated
session. An unauthenticated (anonymous) `select` doesn't error — it silently
returns zero rows. If a query "works" but comes back empty, check whether
`auth-sign-in` has actually completed before assuming the table is empty.

**Error visibility gotcha:** Electron's `ipcMain.handle` only reconstructs a
readable `Error` on the renderer side when the thrown value's own `.message`
is a real string. Every Supabase call site wraps its error through
`supaFail(context, error)` (`lib/supabaseClient.js`) specifically so failures
show up as a real message in both the renderer console and the main-process
terminal instead of `[object Object]`.

## Architecture

**Process split (standard Electron):**
- `main.js` — main process. Talks to Supabase (via `lib/supabaseClient.js`)
  and defines every `ipcMain.handle(...)` endpoint (data access, menu
  generation, Excel export). All business logic is invoked from here; there
  is no separate server.
- `preload.js` — contextBridge shim exposing `window.api.*` methods 1:1 with
  the `ipcMain.handle` channels. Renderer code only ever calls `window.api.*`.
- `renderer/` — plain JS/HTML/CSS UI (`renderer.js`, `index.html`,
  `styles.css`), no framework. `renderer.js` is a single `state` object plus
  view-render functions (`renderItemsView`, `renderGenerateView`,
  `renderBuildMenuView`, `renderHistoryView`, `renderExportAllView`,
  `renderRecipeListView`/`renderRecipeFormView`, `renderCalculatorView`,
  `renderIngredientsView`) swapped via `state.currentView`. `login.html`/
  `login.js` are a separate, pre-auth window (`createLoginWindow()` in
  `main.js`) shown before the main window ever loads.

**Database (Supabase, Postgres):**
- Every table from the original SQLite schema now lives in Supabase: `sections`,
  `age_groups`, `meal_periods`, `categories`, `protein_types`, `menu_items`,
  `item_portions`, `menu_slots`, `generated_menus`, `menu_days`,
  `menu_day_items`, `ingredients`, `recipes`, `recipe_ingredients`.
- `db/schema.sql` is kept around as **historical reference only** — it documents
  the original SQLite column shapes/relationships (which the Postgres schema
  mirrors), but nothing in the app reads it and it's not guaranteed to be
  hand-synced going forward. When in doubt about a column, check Supabase
  directly (there's no local file to inspect instead, unlike the old
  `sqlite3`/`python3` workaround this section used to document).
- `lib/referenceData.js` — `sections`/`categories`/`protein_types`/`age_groups`/
  `meal_periods` are small, effectively-static, and read constantly and
  synchronously throughout the app (every dropdown, every ID lookup inside
  `MenuGenerator`'s tight loops). Querying Supabase for each of those would be
  both slow and unnecessary, so `loadReferenceData()` fetches all five once
  into an in-memory cache and everything else uses its synchronous accessors
  (`getSectionByCode`, `getCategoryById`, `getAgeGroupsForSection`, etc.)
  instead of querying Supabase directly. **Must be called after successful
  login** (`auth-sign-in` in `main.js`), not at app startup — RLS blocks
  anonymous reads, so calling it before login just caches five empty arrays.
  `menu_slots` is the one table conceptually similar to these five but *not*
  cached this way, since `MenuGenerator.persistMenu()` writes new rows to it
  at runtime; it's queried live instead.
- Core relational shape (unchanged from the original SQLite design): `sections`
  (Daycare / KG_LP / MS_UP / Staff / CEO — five, not three, despite older
  docs) → `age_groups` (pricing/portion sub-populations within a section) →
  `menu_items` tagged with `category_id` and optional `protein_type_id` →
  `item_portions` (per-age-group grammage) → `menu_slots` (the required shape
  of a day's menu per section/category) → `generated_menus` → `menu_days` →
  `menu_day_items` (the actual picks). The no-repeat-within-N-days lookup that
  used to be a SQLite view (`v_item_last_used`) is now computed in
  `MenuGenerator._loadLastUsedMap()` — a batched in-memory reduction over
  `generated_menus`/`menu_days`/`menu_day_items`, done once per generation run
  rather than once per candidate (which would be thousands of Supabase round
  trips otherwise).

**Generation engine (`lib/generator.js`):**
- `SECTION_SLOTS` is the declarative spec of what each section's daily menu
  must contain: an ordered list of `[categoryCode, count, options]`. This is
  the first place to look when a section's menu shape needs to change.
- `options` can include `distinctProtein` (no two picks share a protein
  type), `distinctAttr` (no two picks share a `sauce_type`/`carb_type`/
  `dish_concept` value), and `composition` (ordered sub-rules like "exactly 1
  CHICKEN then 1 BEEF") — composition rules are satisfied first, then
  remaining slot count is filled by `_scoreAndSort`.
- Item selection scores candidates by recency gap (days since last used,
  across both the batched history map and the in-progress generation run via
  `_runUsage`/`_lastUsedIncludingRun`) and prefers the largest gap; a repeat
  inside `NO_REPEAT_DAYS` (28) still happens if the pool is too small, but
  gets pushed onto `this.warnings` and surfaced to the UI.
- Daily-repeating items (`is_daily_repeating`) short-circuit selection —
  they're always picked, skipping the scoring logic.
- `MenuGenerator.generate()` walks calendar days starting at `startDate`,
  skipping Friday/Saturday (`SCHOOL_WEEKDAYS` = Sun–Thu) until
  `numWeekdays` school days are placed. `persistMenu()` writes everything as a
  handful of batched Supabase inserts (one `generated_menus` row, one
  `menu_slots` resolve/create pass, one multi-row `menu_days` insert, one
  multi-row `menu_day_items` insert) rather than a SQL transaction — Supabase
  has no equivalent of `better-sqlite3`'s synchronous `db.transaction()`, so
  a failure partway through is not rolled back automatically.

**Classification (`lib/classify.js`):** keyword-based heuristics that
auto-suggest a new item's category/protein/daily-repeating flag from its
name, mirroring the logic originally used to import the seed Excel file. Pure
function, no DB access — returns `{ category: null, ... }` when it can't
guess, forcing manual selection in the UI.

**Export (`lib/export.js`):** builds `.xlsx` workbooks with `exceljs`. Each
section has its own sheet builder in `SECTION_BUILDERS` (school sections
share `buildSchoolSheet`; Staff and CEO each get a distinct layout) because
their source spreadsheets have fundamentally different column structures —
adding a new section usually means adding a new builder function here, not
extending an existing one.

## Adding a new section or category

Touch points, in order: `sections`/`categories`/`age_groups` rows in the DB →
`SECTION_SLOTS` entry in `lib/generator.js` → a sheet builder + entry in
`SECTION_BUILDERS`/`SECTION_DISPLAY_NAMES` in `lib/export.js` → the
`sectionOrder` arrays in `main.js`'s `generate-and-export-all` handler and
`exportCombinedWorkbook`'s `order` in `lib/export.js` (these three section
orderings are currently duplicated, not shared from one constant).
