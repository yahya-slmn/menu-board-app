# Menu Board — School Menu Generator

A cross-platform (Electron) app for generating school meal menus from a database
of tagged menu items, built around the structure found in your original
`JUNE_14-06-2026.xlsx` file (Daycare / KG-LP / MS-UP sections).

## What's included

- `main.js` — Electron main process: window setup + all Supabase/IPC logic
- `preload.js` — safe bridge exposing the API to the UI
- `lib/supabaseClient.js` — the Supabase client (all data lives in Supabase/Postgres now)
- `db/schema.sql` — historical reference documenting the original data model
  (the Postgres schema mirrors it; nothing in the app reads this file)
- `lib/generator.js` — the menu generation engine (no-repeat-in-4-weeks logic,
  distinct-protein-per-day rule, daily-repeating auto-fill)
- `lib/classify.js` — auto-suggests category/protein when you type a new item name
- `renderer/` — the UI (Item Catalog, Recipe Book, Recipe Calculator, Ingredients,
  Build Menu, Generate Menu, History, Export All Sections), plus a separate
  `login.html`/`login.js` screen shown before any of it

## Running it on your Mac

You'll need [Node.js](https://nodejs.org) installed (v20 or v22 LTS recommended —
avoid odd-numbered versions like 21, which often lack ready-made native binaries).

```bash
cd menu-board
npm install
npm start
```

There's no local database file anymore — every read and write goes to Supabase
over the network, so **you need internet access and a valid login** every time
you launch. The app shows a login screen first; nothing else loads until you
sign in (the session isn't persisted between launches, so this happens on
every restart, by design).

## Building a real .app (no Terminal needed after this)

```bash
npm run build:mac
```

This produces a signed-for-local-use `Menu Board.app` inside `dist/mac-arm64/`
(or `dist/mac/` on Intel Macs). Once it finishes:

1. Drag `Menu Board.app` into your `/Applications` folder
2. Double-click to launch it like any other Mac app

Since the app isn't signed with an Apple Developer certificate, the first time
you open it macOS will show an "unidentified developer" warning. Right-click
the app → **Open** → **Open** again to bypass this once; after that it opens
normally.


## Using the app

1. **Item Catalog** — pick a section (Daycare / KG-LP / MS-UP) in the sidebar,
   browse items grouped by category, add new ones. Typing a name and clicking
   away auto-suggests the category/protein (you can always override it).
2. **Generate Menu** — set a label, start date, and number of school days
   (Sun–Thu only, matching your calendar), then click Generate. The engine:
   - Auto-fills daily-repeating items (milk, bread, salad bar, fruit bar)
   - Picks lunch mains with different protein types where required
   - Avoids repeating any item within the last 28 days, when the catalog
     has enough variety to allow it — if not, it tells you exactly which
     items had to repeat sooner, via the warning banner
3. **History** — every generated menu is saved; click one to view it again
   or export it.
4. **Export to Excel** — from either Generate or History, exports the current
   menu to a `.xlsx` file.

## Known limitation (important)

If a section's catalog only holds a small pool of items per category, the
generator will have to repeat items more often than the 4-week rule ideally
allows (you'll see this flagged in the warning banner after generating). Add
more items via the Item Catalog screen to grow the pool — the more dishes per
category, the more the generator can spread things out.
