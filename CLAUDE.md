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

## Recipe on Fire game view (`renderer/rof/`)

The one place the "classic scripts only" rule above doesn't apply. Recipe on Fire's tray/dough/bake
view is a Three.js game written as **ES modules**, loaded straight from `node_modules` through an
import map in `renderer/index.html` — still no bundler and no extra dependency (same pinned
`three@0.160.0` as Materials' classic-script preview, which is untouched). `renderer.js` stays a
classic script; `rof/boot.js` registers `window.RofGame` (`create(container)` / `disposeAll()`), and
`renderView()` calls `disposeAll()` so leaving the screen frees the WebGL context.

- `game.js` is the public API (`setTray`, `addCutter`, events). It takes plain data only — Materials'
  shape type + dims, and the interior footprint `trayInteriorFootprint()` already computed — so
  tray math stays in one place. Plan coordinates: cm, tray-centre origin, +y up the page (plan y →
  world −z).
- `stage.js` (renderer, fixed tilted camera with wheel zoom only — no orbit, lights, on-demand render
  loop), `quality.js` (GPU-probed quality tier + FPS governor that steps the tier down at runtime),
  `trayModels.js` (parametric trays/cutters using Materials' wall/floor formulas), `constraints.js`
  (containment + SAT overlap), `items.js`/`interaction.js` (drag with spring follow, lift, settle;
  `collision: 'solid' | 'lifted'`).
- `dough.js` (procedural dough: one plan-outline + dome-profile generator for ball / disc / log /
  oval, seeded per piece; rise is a **morph target** so shadows/AO see the risen shape; browning,
  scoring, flour and crust relief are fragment shader; colours in `BAKE_COLORS`), `post.js` (AO +
  output pass; skipped on the low tier).
- Three addons live in `rof/vendor/three-addons/` (16 files, MIT, pinned to the same 0.160.0)
  because electron-builder drops every `node_modules/**/examples/` folder from the packaged app —
  an import map into `node_modules/three/examples/jsm` works in `npm start` and breaks in the built
  `.app`. See the README there. Anything under `rof/` that adds a new addon import must vendor it too.
- Dev flags (`localStorage`): `rofGameStats = '1'` shows a tier / GPU / fps badge on the stage;
  `rofGameLookdev = '1'` drops draggable sample dough on the Setup tray with Rise / Bake sliders.
- `scripts/backup-dough-photos.js` (read-only; run it yourself, it asks for your login) saves the
  Dough Shapes rows + photos to `backups/` (gitignored) before that catalog is removed;
  `scripts/sample-baked-colors.js` then reads those photos to calibrate `BAKE_COLORS`.
- Shape & Place (Mode A) lives in the game: `placement.js` (rules: pieces are on the bench or the tray;
  carried pieces move freely and their outline turns red where a drop would be refused; on drop they
  settle at the nearest valid spot, snap into a free muffin cup, or return), `bench.js` (the board in
  front of the tray; bench pieces use their raw footprint, tray pieces their risen one so they never
  touch after proofing), `game.js` (`beginPlacement`, `autoArrange`, `playBake`). Piece size follows
  weight (cube root), so dividing dough into fewer pieces makes bigger ones.
- The Recipe on Fire screen is a two-column layout (controls beside a sticky stage). Method choice at
  Setup: Shape & Place (steps setup -> place -> bake, all in the game) or Sheet & Trim (still the old 2D
  dough/baked/cut flow until it is rebuilt in the game).
- Bake (Shape & Place): `riseModel.js` is a deterministic, explainable model (no AI) that reads the
  process's ingredient NAMES in baker's percentages (yeast / starter / baking powder, hydration, sugar,
  fat, egg, salt) and returns height/width multipliers, how much of the rise happens before the oven,
  and a browning speed, plus plain-language `notes` shown in the Bake panel. It also sizes the room
  each piece reserves on the tray (placement uses the same model, so a slack dough needs more space).
  `game.playBake` runs proof -> oven -> out (about 11.5 s, Skip available): pieces rise as two morph
  targets (height / footprint) with oven-spring overshoot, brown by doneness (Light / Golden / Dark),
  `oven.js` adds glowing rods, back glow, flickering heat lights and steam, and `post.js` adds bloom plus
  a heat-shimmer/vignette/tint grade pass (only active during the bake). The point lights live in the
  scene permanently at intensity 0: adding lights mid-bake recompiles every material (a ~1 s freeze).
  `stage.animate` tickers may call `requestRender()` -- the loop guards against double-scheduling.
- Sheet & Trim (Mode B): `sheet.js` builds the dough as ONE mesh over the tray's interior (a fine grid
  whose height rolls off to zero at the wall, lumped with seeded noise; it rises via a morph target and
  browns with the dough shader). A `CutterMask` canvas texture marks where cutters are so the shader can
  dim the scrap outside them. Thickness = net weight / (interior area x 1.05 g/cm3 raw density); a tray
  counts as full at ~70% of its rim height (`sheetInfo.capacityGrams`), and a bigger batch reports how many
  trays it needs. Steps: setup -> bake -> trim. In Trim, `game.armCutter` shows a see-through cutter at the
  pointer (red where it can't go), a click on empty sheet stamps one, clicking an existing cutter picks it
  up instead, and unplaceable cutters are dropped rather than overlapped. Per-piece weight / count /
  utilization / waste come from `updateTrimSummary` (share of tray area x grams in the tray);
  `computeCutterLayout` (pure geometry, still in renderer.js) drives Auto-arrange. Not offered on muffin
  trays (a portion per cup already).
- The old 2D tray canvas and photo-sprite dough flow are gone; the game view is the only tray view. The
  Bake panel (both methods) has a rise override slider (30-160%) scaling the model's height/width
  multipliers -- it applies at bake time only, so raising it above what placement reserved can make
  pieces touch (the panel says so).
- Shape presets are chef-configurable: rows of `dough_shapes` (name, weight, `archetype` ball / disc / log /
  oval, length / width / height, taper, slash count), edited in the "Edit shapes…" modal in Shape & Place
  (`openShapesModal`, with a live 2D outline from `shapePreview`). `lib/doughShapePresets.js` validates and
  saves; "Delete" ARCHIVES (`archived = true`) because `dough_shape_photos` cascades on delete, and
  re-adding an archived name revives that row. The columns come from
  `supabase/migrations/20260920100000_dough_shape_presets.sql` (additive only). Until it is applied,
  `list-dough-shape-presets` answers `{ available: false }` and the screen falls back to the four built-in
  shapes (`SEED_SHAPES`, read-only; the Edit button explains why) -- nothing breaks.
- Performance (measured on an M2, full-Retina 2560x1440-class buffer, 46 pieces): the frame was ~53 ms; the dough
  shader (~24 ms), ambient occlusion (~12 ms) and 4x MSAA (~7 ms) were the big costs. Now: the dough noise is a
  shared precomputed texture (`noise.js` `tileableNoiseData`), AO runs at half resolution (`aoScale`), MSAA is
  used only where the pixel ratio is under 1.75 (a dense display doesn't need it), and each tier has a pixel
  budget (`maxPixels`) so a huge window renders below native density instead of missing frames. Result: at or
  under the 60 Hz cap (16.7 ms). Profile by toggling features on a 46-piece scene and measuring average frame
  time under `stage.animate` -- values at 16.7 mean "at vsync", not "exactly".
- Graphics setting (bottom-right of the stage): Auto (default: the GPU probe picks a tier and the FPS governor
  steps down under ~38 fps, with an on-stage notice) or a fixed High / Medium / Low; stored in
  `localStorage.rofGameQuality`. A fixed choice is never overridden by the governor.
- Accessibility: the stage canvas is a focusable `role="application"` with described keys; a visually hidden
  live region (`game.announce`) says what happened. Keys: `]` / `[` choose a piece, Enter moves it between bench
  and tray, arrows nudge (Shift = bigger), R rotates, Delete returns it to the bench; with a cutter picked,
  arrows position it, Enter stamps it, Escape puts it down. Panels use `aria-pressed`, `aria-current="step"`, a
  real progressbar and labelled slider; the Shapes modal is a dialog (labels tied to inputs, Escape, focus
  moved in and returned, Tab kept inside). `prefers-reduced-motion` skips the camera intro, drop-ins and landing
  squash and shortens the bake (~3.4 s).
- Milestone status: Setup, Shape & Place, Sheet & Trim, the Bake, the shape presets, performance tiers and
  accessibility are done (shape-presets migration applied to Supabase 2026-09-20). Left:
  removing the old Dough Shapes screen,
  `dough_shape_photos`, the `dough-shape-photos` bucket, the `generate-dough-shape-image` edge function and
  `lib/doughShapes.js` / `lib/generateDoughShapeImage.js` (gated on the photo backup -- see
  `scripts/backup-dough-photos.js`).

## Adding a new section or category

Touch points, in order: `sections`/`categories`/`age_groups` rows in the DB →
`SECTION_SLOTS` entry in `lib/generator.js` → a sheet builder + entry in
`SECTION_BUILDERS`/`SECTION_DISPLAY_NAMES` in `lib/export.js` → the
`sectionOrder` arrays in `main.js`'s `generate-and-export-all` handler and
`exportCombinedWorkbook`'s `order` in `lib/export.js` (these three section
orderings are currently duplicated, not shared from one constant).
