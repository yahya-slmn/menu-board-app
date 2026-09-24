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
- Staff Main (since 2026-09-23) is exactly 7: KG-LP/MS-UP's 2 Lunch Mains + 2 Lunch Starches and MS-UP's Lunch
  Vegetable (forced in, `STAFF_MAIN_SHARED_CATEGORIES` / `STAFF_MAIN_VEGETABLE_*`), then Staff's own 1 VEGAN + 1
  VEGETARIAN with different `carb_type` (`distinctAmongOwnOnly`). Daycare's main is no longer shared into Staff Main (the
  export's Lists sheet still lists Daycare mains so older saved menus re-export). "Meat-free" rules (Staff Breakfast, Lunch
  Box) accept VEGAN or VEGETARIAN. Daycare's Lunch Main never repeats the previous school day's protein
  (`noConsecutiveProtein`, including the last saved school day before the run). Staff's lunch drinks are three FIXED
  daily-repeating items (`STAFF_WATER` / `STAFF_SOFT_DRINK` / `STAFF_FRESH_JUICE`, `fixedDaily`), replacing `STAFF_JUICE`,
  which stays only for old menus; with no daily item set the row stays empty and a warning says so. They export under one
  "Beverages" label. Staff Fruit Basket left Staff lunch on 2026-09-24 (`STAFF_FRUIT_BASKET` stays in the export map / parser
  vocabulary only so older menus still export and parse).
- Shared snacks + Pastry / Cold Kitchen (2026-09-24): Daycare and KG-LP serve ONE AM Snack and ONE PM Snack a day
  (`SECTION_COUPLINGS`: KG-LP/MS-UP share lunch, Daycare/KG-LP share snacks; whichever is generated second copies the first's
  saved picks for the same dates, else both-catalogs pool + merged history); MS-UP keeps its own. `SNACK_STYLE_BY_PATTERN` /
  `snackStyleFor`: one flip per school day of the run (Pattern A on day 1, reset per run), AMs opposite, PMs opposite,
  Daycare/KG-LP AM vs PM opposite -> 2 Pastry + 2 Cold Kitchen daily (AM Snack's pattern is unchanged). The style filter also
  applies on the shared (coupled) path (`_styleSplit`). Staff Breakfast shares TWO AM Snacks (Daycare's -- or KG-LP's -- and
  MS-UP's) and its `styleMix` makes the six 3 Pastry + 3 Cold Kitchen (`_styleMixTracker`): the meat-free composition pick
  first (either style; breaks the mix only if no fitting meat-free dish exists, warned "style mix short of"), then the mix
  outranks different dish types (relaxed first), then the mix gives way, warned. Build Menu: KG-LP's snack cells follow Daycare
  read-only (`syncBuilderSharedSnacks`), Daycare's dropdown lists dishes both catalogs have, grouped by today's style; a
  wrong-style pick is allowed and labelled "breaks today's rotation"; Auto-Fill sends the grid's other sections as the engine's
  `partnerPicks` (`builder-fill-suggestions` `gridPicks`), never feeding KG-LP's mirror back into Daycare. In a styleMix slot
  a dish not served in 28 days also outranks different dish types (a repeat is worse than two of one kind on a 6-dish buffet).
- Chicken / beef are never AM or PM Snack, for EVERY dish (`lib/categoryRules.js` `snackLunchOnlyHit`: protein type, or a
  whole word in the name; one definition, also used by `lib/aiMenuSafety.js`). Enforced 2026-09-24 as the chef's explicit
  exception to "new rules apply forward only": the engine's catalog / draft pools (`_snackAllowed`), copies from a partner's
  saved menu and Staff Breakfast shares (refused + warned), Build Menu's dropdowns (`get-section-item-pool`) and the AI review
  catalog replace list. Offending catalog dishes stay in the catalog, tagged "Not served: chicken/beef in a snack"
  (`snack_rule_blocked` from `get-items`); Add / Edit Item only warns. AM / PM Snack have an editable protein type
  (`PROTEIN_ELIGIBLE_CATEGORIES`, 2026-09-24) -- set the real one (Turkey, Vegetarian...); saving keeps it. History is never changed or flagged; the Excel `_Lists`
  dropdowns are not filtered. Staff Breakfast's own dishes are out of scope. `scripts/snack-chicken-beef-list.js` (read-only,
  login) lists the offending dishes to `backups/snack-chicken-beef-list.txt`, plus every dish (any category) whose name says
  turkey but whose protein type is chicken / beef.
- TURKEY protein type (`supabase/migrations/20260924160000_turkey_protein_type.sql`, additive): before it, the AI filed turkey
  as CHICKEN (then blocked as a snack, or counted as a KG-LP / MS-UP chicken main). Turkey counts as meat for the Staff Lunch Box
  rule (generator / aiMenuGenerate `MEAT_PROTEINS` / aiMenuRules `MEAT`), never as the chicken main; `lib/classify.js` suggests
  it for turkey names; the `generate-menu-dishes` guide says "Turkey, including turkey ham, is TURKEY, never CHICKEN". Not
  retroactive. Protein codes the live table lacks are simply unused (request spreads filter by live codes).
- Reading exports back in (`lib/menuIngredients.js` `parseWorkbookDishes`, used by Menu Ingredients Generator and the Recipe
  Generator's upload): a day block is found by date + weekday; layout comes from the old RC / Quantity / Weight-Unit markers
  when present (files already sent out), else CEO by its person-name header cells (`lib/menuLayout.js` `CEO_PERSONS`, shared
  with the exporter) or by two twin dish columns, and School vs Staff by vocabulary (warns only when the fit is unclear).
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

**Dish Catalog "Created By"** (`menu_items.created_by_label`, `supabase/migrations/20260924140000_menu_items_created_by_label.sql`):
free-text attribution ("AI", "OLD" = existed before the column was added, a chef's name), a column between Tags and RC (inline
edit, like RC) and a field under Item name in Add / Edit Item. It is NOT provenance: `is_ai_generated` / `ai_menu_run_id` still
drive the AI chip, the "AI-generated" filter and the calorie scope, and editing the label never changes them. New manual items
start blank; Approve writes "AI". `lib/catalogCreatedBy.js` tidies the value and snaps a case-only variant to the spelling
already in use; suggestions are every label in use plus the recipe people. The Dish Catalog's source filter is one "Created
By" dropdown (All / AI-generated by the flag / each label / Not set). `update-item` only writes the label when it is sent.

**Pastry / Cold Kitchen style** (`menu_items.am_snack_style`, despite the name): AM Snack, and since 2026-09-24 PM Snack and
Staff Breakfast too (`STYLED_CATEGORIES` in main.js / `STYLE_ELIGIBLE_CATEGORIES` in renderer.js). The `estimate-am-snack-style`
Edge Function takes a `category` (PM Snack Cold Kitchen = the savory / salty side); the Dish Catalog's "Estimate missing styles"
button fills blanks only. `scripts/snack-style-pool-check.js` (read-only, asks for a login) reports the pool sizes by style for the
Daycare / KG-LP shared snack rule (it writes `backups/snack-style-pool-check.txt`; a test must never run it unredirected).

**Classification (`lib/classify.js`):** keyword-based heuristics that
auto-suggest a new item's category/protein/daily-repeating flag from its
name, mirroring the logic originally used to import the seed Excel file. Pure
function, no DB access — returns `{ category: null, ... }` when it can't
guess, forcing manual selection in the UI.

**Export (`lib/export.js`):** builds `.xlsx` workbooks with `exceljs`. Since 2026-09-24 no menu export (Generate Menu,
Build Menu and its blank template, Export All, AI Menu Generator, History re-exports) carries an RC or a quantity column --
just meal period, category / item type and dish name(s); RC stays in-app catalog data. The hidden `_Lists` sheet holds only
dish names for the dish-name dropdowns (`List_*` ranges). The blank template keeps its fill-in headcount (School) and
department (Staff) columns. Each
section has its own sheet builder in `SECTION_BUILDERS` (school sections
share `buildSchoolSheet`; Staff and CEO each get a distinct layout) because
their source spreadsheets have fundamentally different column structures —
adding a new section usually means adding a new builder function here, not
extending an existing one.

**Recipe quantities (scaling, rounding, display):** ingredient quantities are stored at 0.01 g. Whenever a scale has a target
(Total Quantity or Net Weight typed into a recipe form, the Calculator's target quantity, and the generation-time scaling), the
scaled quantities go through largest-remainder rounding (`allocateHundredths`, mirrored in `renderer.js` because it is a classic
script) so they add up to the target EXACTLY; rounding each ingredient on its own let the total drift by a hundredth or two
(149.99 for 150). Net Weight edits use `scaleSetsToNetWeight`, which picks the total whose displayed Net Weight equals the typed
one. Processes that share a multiplier are rounded together (`scaleIngredientSets`). Newly generated recipes are scaled so the
recipe-level NET WEIGHT (each process's own waste-adjusted total, summed) is `REFERENCE_NET_WEIGHT_GRAMS` = 150 g
(`normalizeProcessesToNetWeight` in `lib/recipeGenerator.js`) -- the raw Total Quantity is whatever that takes (about 164 g with an
8.5% waste) -- and Quantity Produced is set to that Net Weight; editing a waste % afterwards moves the Net Weight, and retyping 150
restores it. Quantities are DISPLAYED with `formatIngredientQty` (one decimal, two under 0.1 g, no trailing ".0") in the forms,
previews and Calculator, and exports keep the exact number with an Excel number format (`ingredientQtyNumFmt`); on-screen rows can
therefore look a hair off their total. Recipes generated before the 150 g change stay at ~100 g -- nothing rescales them.

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
- `stage.js` (renderer, camera with yaw / pitch / presets and wheel zoom, lights, on-demand render
  loop, side-view inset), `quality.js` (GPU-probed quality tier + FPS governor that steps the tier down at runtime),
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
  Auto-arrange is `packing.js` (below). Not offered on muffin trays (a portion per cup already).
- The old 2D tray canvas and photo-sprite dough flow are gone; the game view is the only tray view. The
  Bake panel (both methods) has a rise override slider (30-160%) scaling the model's height/width
  multipliers -- it applies at bake time only, so raising it above what placement reserved can make
  pieces touch (the panel says so).
- Shape presets are chef-configurable: rows of `dough_shapes` (name, weight, `archetype` ball / disc / log /
  oval, length / width / height, taper, slash count), edited in the "Edit shapes…" modal in Shape & Place
  (`openShapesModal`, with a live 2D outline from `shapePreview`). `lib/doughShapePresets.js` validates and
  saves; "Delete" ARCHIVES (`archived = true`) -- re-adding an archived name revives that row. The columns
  come from `supabase/migrations/20260920100000_dough_shape_presets.sql` (additive only). Until it is applied,
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
- Portions by weight (`portions.js`): grams is the primary input in Shape & Place, defaulting from
  `recipes.portion_weight_grams`, then the shape's weight; the piece count is a linked stepper. `planPortions`
  returns whole portions and the leftover dough (shown in red, `.rof-leftover`); counts cap at 60 and a
  portion larger than the dough reports `tooBig` instead of a count. Portion weight is session-only state.
- Cutter packing (`packing.js`, pure geometry, unit-tested in the scratchpad harness): `packCutters` does the
  exact layout for round (hex), rect (grid) and triangle (alternating up/down lattice with a frame-angle and
  phase search, tray-edge angles included) cutters inside a circle / rect / poly region, honouring a margin and
  a gap. Triangle placements carry a rotation (`rot`); dropping it was the bug behind the old 38% utilization.
  `scrap.js` (`analyzeScrap`) rasterises the sheet, finds each connected piece of scrap, its exact area and the
  widest point (where its flag goes). The flag stays ONE per connected region (no chunking); regions of 2% or
  more get a flag, at most five. A cutter's exact `area` is passed in so the panel and the chip agree to the gram.
  The scrap is tinted red with hatching in the dough shader; "Highlight scrap" is a toggle on the stage.
- Camera and the side view: yaw / pitch presets (Top, Angled, Low front, Low side; keys 1-4), Q / E turn the
  view 15 degrees (Shift = 5), right-drag or Alt+left-drag orbits when nothing is held. Turning the view while
  a piece is held calls `interaction.reanchor()` so the grab offset is recomputed from the cursor's new ray:
  a piece never moves because the camera did. The side-view inset is an orthographic second render into a
  scissored corner of the same canvas (fog off, `shadowMap.autoUpdate` false, CSS-px viewport), eased to the
  tray or the held piece; a DOM frame is drawn over it, clicks inside it are blocked, and it hides during the
  bake. It is on by default in Shape & Place and OFF by default in Sheet & Trim (a baked sheet is ~1 cm thick, so it
  shows a thin line); the button still turns it on, and each method remembers its own choice
  (`rofSideView` / `rofSideViewSheet`). The chip / toggle / view buttons sit over the stage, so on a narrow stage a container query drops
  the scrap row under the view buttons rather than letting them overlap.
- One-portion view (`portion.js`, opened from the panel's "One portion" button: Bake step in Shape & Place, Trim step in
  Sheet & Trim once a cutter is placed): `game.showPortion(desc)` hides the tray / bench / sheet / cutters (visibility
  only -- `hidePortion` restores exactly what was there), shows ONE baked portion on a board, dimension lines drawn
  over it on a 2D canvas, and a card along the bottom. `desc` is plain data built by `portionDescShape` /
  `portionDescSheet` in renderer.js (raw sizes + the rise model's `hMul` / `wMul`); `RofGame.measurePortion(desc)` is
  the pure arithmetic (piece: length x (1 + R.l * wMul), width x (1 + R.w * wMul), height x (1 + R.h * hMul), the
  same morph the dough shader applies; cut piece: raw thickness x (1 + sheet `RISE_H` * hMul)). Anything that comes
  from the rise model is labelled "est."; cutter sizes and the dough weight are exact. `frameModel` zooms / slides
  the camera by PROJECTING the board, the piece and every label box into the free area (between the view buttons and
  the card), so any size -- 3 cm or 50 cm -- fits; it must run at the final pose (no dolly-in). Several cutter types on
  the sheet give a chooser on the card. Every game call that changes the tray closes the view first, and Escape
  closes it. `game.capturePortion(desc)` returns a JPEG (data URL) of the portion with the dimension lines baked in,
  for the PDF; it works whether or not the view is open and leaves everything as it found it.
- Oven temperature and bake time (Bake panel, both methods; session-only, never saved): pre-filled from the recipe's
  method text by `rof/bakeParams.js` `parseBakeParams` (English and Arabic words and digits; a time counts only in a
  sentence that mentions the oven, so a rest or proof time is never read as a bake time; hours become minutes; a
  temperature with no unit is guessed C below 260 and flagged), then the chef confirms ("Looks right") or types over it.
  Values that were read from the method and never confirmed are printed on the PDF with a note saying so.
- Export PDF (Bake step in Shape & Place, Trim step in Sheet & Trim): `buildPdfData` in renderer.js gathers what is on
  screen (dough and every waste with its own base, tray, shape or cutters, one portion + the `capturePortion` picture,
  waste, oven) and `window.api.exportRecipePdf` -> `export-recipe-pdf` in main.js -> `lib/recipePdf.js`. It builds an HTML page
  and prints it with Electron's `printToPDF` (no PDF library; Arabic / RTL names shape correctly because Chromium lays
  them out). The save dialog comes first; the hidden print window has scripting off and a CSP; `renderFitPdf` shrinks
  the page a step at a time until it is ONE A4 page. A print window needs the app to have another window open
  (Electron quits when the last window closes) -- true in the app, but test scripts need a keep-alive window.
  The PDF keeps the planned Trimming Waste % (recipe, base = the running total before it) and the measured scrap
  (cutter layout, base = dough on this tray) as two separately labelled figures; never merge them.
  Portion weights in Recipe on Fire are FINISHED weights, like Portion Weight / Portions Produced everywhere else in the app: the
  recipe's Net Weight already has every waste row, Baking Waste included, taken off, and pieces are counted as
  floor(Net Weight / portion weight). Nothing further is deducted from a portion. "Raw dough before baking (est.)" is the portion
  weight put back through the Baking Waste, portion / (1 - baking %) (`bakingLoss` / `portionWeightRows` in renderer.js; every
  waste row named like "baking" counts, combined); a recipe without one shows "No Baking Waste in this recipe". The 3D pieces are
  still sized from the finished weight (drawing them from the raw weight would make them ~3% wider with an 8.5% baking waste;
  deliberately not done -- revisit only if it becomes a visible complaint).
- No scrolling to reach anything on this screen: every step's controls and the sticky `.rof-actions` bar fit at
  the default window (1280x800). Check `main.scrollHeight <= main.clientHeight` on every step after adding a
  control; that was a recurring regression.
- Milestone status: Setup, Shape & Place, Sheet & Trim, the Bake, the shape presets, performance tiers,
  accessibility, portions by grams, exact cutter packing with scrap flags, the camera views / side view, the
  one-portion view and the PDF export are done (shape-presets migration applied to Supabase 2026-09-20). Left:
  applying the DB/infra cleanup the chef runs by hand (drop `dough_shape_photos`, delete the
  `dough-shape-photos` bucket, undeploy `generate-dough-shape-image`) -- the app-side removal (old Dough
  Shapes screen, `lib/doughShapes.js`, `lib/generateDoughShapeImage.js`, the nav entry) is done; `dough_shapes`
  and its Shapes modal are the live, in-use feature and were untouched by that removal.

## AI Menu Generator (in progress on `feature/ai-menu-generator`)

The AI invents dishes for a date range (Daycare / KG-LP / MS-UP / Staff; CEO never), the unchanged engine schedules them, and
the chef reviews a DRAFT before anything reaches `menu_items` / `generated_menus`. Tables: `ai_menu_runs`,
`ai_menu_draft_dishes`, `ai_menu_draft_picks` (`supabase/migrations/20260923100000_ai_menu_generator.sql`).
- `lib/aiMenu.js`: which categories are AI (`AI_CATEGORIES`, Staff Sweets included; the rest stay catalog-only) and `computeDraftMenus`, the engine run
  over in-memory pools (`MenuGenerator({ draftPools, partnerPicks })`).
- `lib/aiMenuGenerate.js`: pool sizing, the AI calls (`generate-menu-dishes` Edge Function, Sonnet 5, thinking off), the gates,
  and the top-up loop that reads the engine's own warnings. Deploy the function with `--use-api` (Docker bundling hangs here).
- `lib/aiMenuSafety.js` is MANDATORY on every AI or chef-written dish (generate, edit, replace, approve): nut/sesame
  (`nutFilter`; za'atar allowed in a dish NAME only), seafood for student sections, halal (`halalFilter.js`), and known-risk dishes
  (hummus, pesto...) must list their substitute. Also feature-only (not in `halalFilter.js`): pepperoni / sausage / hot dog /
  frankfurter / wiener / salami / chorizo banned whatever meat is named, no spicy framing (`SPICY_TERMS`; aromatic words like
  cumin, paprika, baharat stay allowed), and per-category rules (Daycare Lunch Salad = cooked veg sticks, no puree / raw
  carrot or celery; PM Snack never manakish; Daycare PM Snack soft only). A hit is a hard block, reported, never cleaned up or
  overridden.
- Catalog duplicates (`findDuplicateMatch`, same category) LINK to the existing item; deliberately not widened (reviewed).
- Review screen (`renderAiMenuView`, `lib/aiMenuReview.js`, `lib/aiMenuRules.js`): shared picks (MS-UP Lunch Main / Starch,
  Staff's shared Main / Breakfast) are read-only copies and follow their source; menu rules only WARN after edits; empty slots
  block Approve.
- Approve (`lib/aiMenuApprove.js`, needs `20260924120000_ai_menu_approve.sql`): the only step that writes the Dish Catalog and
  History. Claim draft -> approving by compare-and-swap (`approve_claim` + heartbeat `approve_claimed_at`; a claim quiet for
  `STALE_MS` can be resumed). Before any write: empty slots, the full safety check and the retired-name check block and hand the
  run back as a draft. Then dishes -> `menu_items` (`is_ai_generated`, `ai_menu_run_id`; marker `resolved_item_id`; a unique-name
  clash links instead of duplicating), missing `item_portions` for the sections whose menus have the dish's category (shared
  copies don't add Staff portions), the four sections via `persistMenu` (recorded in `approve_progress`; a half-saved one is
  deleted and redone) and CEO by the unchanged engine, all in one `batch_id`. Every step is idempotent, so Resume finishes it.
- Calories are NOT part of Approve: after a successful Approve, main.js `estimateApprovedRunCalories` runs the shared
  `runCalorieBackfill` in the background for that run's new dishes and stores the result in `approve_progress.calories` (the
  approved run shows it and can re-run it). Scope (`lib/calorieScope.js`): school sections as before, plus every
  `is_ai_generated` dish in any section; AI dishes' draft key ingredients are the estimator's input when no real recipe matches.
  Dish Catalog has an "Estimate missing calories" button and an AI badge / "AI-generated only" filter.
- Snacks in the AI generator follow the same sharing: one `DAYCARE+KG_LP` pool per snack (Daycare's audience limits; the
  shared PM Snack is soft only, its savory side included), MS-UP's own pools, every snack pool split by style; KG-LP's snack
  picks are read-only copies of Daycare's (`source_section_code` DAYCARE; review propagates Daycare -> KG-LP -> Staff
  Breakfast). Staff Breakfast's own four a day are sized per style (6 dish types in 6 dishes means one of each type a day, so
  few dishes fit a given day: the pools are deliberately generous).
- National Day (`lib/nationalDay.js`): every Tuesday, every AI category in every section is one cuisine from a 16-entry cycle,
  calendar-anchored (2026-09-01 = Saudi; Tuesdays since then mod 16). The generator orders each Tuesday's dishes to that day's
  exact rules (`tuesdayGroups`) in the same calls as the regular dishes (each group carries its `cuisine`, which the AI must
  echo back); themed dishes are kept for their Tuesday (`ai_menu_draft_dishes.cuisine`). The engine's `dayTheme` option
  (`_themeSplit` / `_pickThemed`, AI only -- the regular engine never passes it) falls back themed -> themed with the distinct
  rule relaxed -> regular -> regular relaxed, warning at each step; never an empty slot, never relaxed safety.
  Exports of an approved run's menus (at Approve and History re-exports) label each themed Tuesday's weekday header cell
  `TUESDAY · ARMENIAN DAY` (School and Staff; never CEO, which is unthemed): main.js `fetchGeneratedMenuExportData` matches the
  menu's `batch_id` to an approved `ai_menu_runs` row and `nationalDayThemesForBatch` (`lib/aiMenuApprove.js`) reads the cuisine
  SAVED on that date's picked draft dishes (never recalculated from the calendar). Other menus get no label. The parser reads
  the weekday as the text before the `·`; School's weekday column widens only on sheets that carry a label.
- Trial scripts (`scripts/ai-menu-trial-run.js`, `scripts/ai-menu-dup-check.js`, `scripts/staff-main-backfill.js`) ask for a
  login: run them in a normal terminal.

## Adding a new section or category

Touch points, in order: `sections`/`categories`/`age_groups` rows in the DB →
`SECTION_SLOTS` entry in `lib/generator.js` → a sheet builder + entry in
`SECTION_BUILDERS`/`SECTION_DISPLAY_NAMES` in `lib/export.js` → the
`sectionOrder` arrays in `main.js`'s `generate-and-export-all` handler and
`exportCombinedWorkbook`'s `order` in `lib/export.js` (these three section
orderings are currently duplicated, not shared from one constant).
