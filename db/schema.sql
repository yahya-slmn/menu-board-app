-- ============================================================
-- Menu Generation Database Schema (SQLite)
-- Sections: Daycare, KG-LP, MS-UP (Boys/Girls)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 1. SECTIONS  (the 3 menu sheets)
-- ------------------------------------------------------------
CREATE TABLE sections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,      -- 'DAYCARE', 'KG_LP', 'MS_UP'
    name        TEXT NOT NULL              -- 'Daycare', 'KG - LP', 'MS - UP (B-G)'
);

-- ------------------------------------------------------------
-- 2. AGE GROUPS (sub-populations inside each section, each with
--    its own pricing/grammage — e.g. KG vs LP, MS-Girls vs MS-Boys)
-- ------------------------------------------------------------
CREATE TABLE age_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id  INTEGER NOT NULL REFERENCES sections(id),
    code        TEXT NOT NULL,             -- 'KG', 'LP', 'MSG', 'MSB', 'UPG', 'UPB', 'DAYCARE'
    name        TEXT NOT NULL,
    UNIQUE(section_id, code)
);

-- ------------------------------------------------------------
-- 3. MEAL PERIODS  (Breakfast / Lunch / PM Snack)
-- ------------------------------------------------------------
CREATE TABLE meal_periods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,      -- 'BREAKFAST', 'LUNCH', 'PM_SNACK'
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- 4. CATEGORIES  (the "table" groupings you asked for:
--    chicken/beef/lamb mains, salads, vegetarian, juices, etc.)
-- ------------------------------------------------------------
CREATE TABLE categories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_period_id  INTEGER NOT NULL REFERENCES meal_periods(id),
    code            TEXT NOT NULL UNIQUE,   -- 'AM_SNACK','LUNCH_BREAD','LUNCH_MAIN',
                                             -- 'LUNCH_STARCH','SALAD_BAR','FRUIT_BAR',
                                             -- 'FRUIT_BASKET','SOUP_APPETIZER','JUICE','PM_SNACK'
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- 5. PROTEIN TYPES (tags for lunch mains / vegetarian split)
-- ------------------------------------------------------------
CREATE TABLE protein_types (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,      -- 'CHICKEN','BEEF','LAMB','VEGETARIAN','NONE'
    name        TEXT NOT NULL
);

-- ------------------------------------------------------------
-- 6. MENU ITEMS (the actual dishes/products)
-- ------------------------------------------------------------
CREATE TABLE menu_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    category_id         INTEGER NOT NULL REFERENCES categories(id),
    protein_type_id     INTEGER REFERENCES protein_types(id),   -- NULL if not applicable
    is_daily_repeating  INTEGER NOT NULL DEFAULT 0,  -- 1 = auto-fill every day (e.g. Plain Milk, Bun Bread)
    is_active           INTEGER NOT NULL DEFAULT 1,
    sauce_type          TEXT,    -- RED / WHITE / ASIAN / GLAZED / GRAVY / DRY / NULL -- used to avoid
                                 -- two same-day main courses sharing the same sauce style
    carb_type           TEXT,    -- RICE / PASTA / POTATO / OTHER -- used to avoid two same-day
                                 -- starch picks being the same carb type
    dish_concept        TEXT,    -- EGG / PASTRY / SANDWICH / CEREAL_DAIRY / CHEESE / OTHER -- used to
                                 -- avoid picking two breakfast items that are really "the same idea"
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    rc_code             TEXT,    -- kitchen/costing reference code shown in Excel export; 'NEW' badge
                                 -- in export.js when absent
    UNIQUE(name, category_id)
);

-- ------------------------------------------------------------
-- 7. ITEM PORTIONS (grammage/qty/price per age group — this is
--    why the same dish shows different numbers in KG vs LP vs
--    MS-Girls vs MS-Boys columns in your sheet)
-- ------------------------------------------------------------
CREATE TABLE item_portions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    age_group_id    INTEGER NOT NULL REFERENCES age_groups(id),
    unit            TEXT NOT NULL,          -- 'gm', 'ml'
    quantity        REAL NOT NULL,          -- e.g. 150, 180
    price           REAL,                   -- optional cost/GM-ML value from sheet
    UNIQUE(item_id, age_group_id)
);

-- ------------------------------------------------------------
-- 8. MENU SLOTS (defines the required "shape" of a day's menu
--    PER SECTION — e.g. Daycare lunch = 1 main course;
--    MS-UP lunch = 2 main courses with differing protein types)
-- ------------------------------------------------------------
CREATE TABLE menu_slots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id          INTEGER NOT NULL REFERENCES sections(id),
    category_id         INTEGER NOT NULL REFERENCES categories(id),
    slot_order          INTEGER NOT NULL,
    items_required      INTEGER NOT NULL DEFAULT 1,  -- how many items from this category per day
    require_distinct_protein INTEGER NOT NULL DEFAULT 0, -- 1 = if items_required>1, force different protein_types
    is_auto_filled      INTEGER NOT NULL DEFAULT 0,  -- 1 = always the same daily-repeating item, skip generation
    fixed_item_id       INTEGER REFERENCES menu_items(id) -- used when is_auto_filled=1 and it's a single fixed item
);

-- ------------------------------------------------------------
-- 9. GENERATED MENUS (a "run" of the generator — e.g. one month)
-- ------------------------------------------------------------
CREATE TABLE generated_menus (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id      INTEGER NOT NULL REFERENCES sections(id),
    label           TEXT NOT NULL,          -- e.g. 'June 2026'
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT / FINAL
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- 10. MENU DAYS (one row per calendar day within a generated menu)
-- ------------------------------------------------------------
CREATE TABLE menu_days (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_menu_id   INTEGER NOT NULL REFERENCES generated_menus(id) ON DELETE CASCADE,
    menu_date           TEXT NOT NULL,     -- ISO date
    day_of_week         TEXT NOT NULL,     -- 'Sunday', 'Monday', ...
    UNIQUE(generated_menu_id, menu_date)
);

-- ------------------------------------------------------------
-- 11. MENU DAY ITEMS (the actual generated selections per slot)
-- ------------------------------------------------------------
CREATE TABLE menu_day_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_day_id     INTEGER NOT NULL REFERENCES menu_days(id) ON DELETE CASCADE,
    slot_id         INTEGER NOT NULL REFERENCES menu_slots(id),
    item_id         INTEGER NOT NULL REFERENCES menu_items(id),
    is_manual_override INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- 12. INGREDIENTS (raw kitchen ingredient master list, imported from
--     the company's product code list -- product_code is the kitchen/
--     costing SKU, distinct from menu_items.rc_code)
-- ------------------------------------------------------------
CREATE TABLE ingredients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code    TEXT,
    name            TEXT NOT NULL UNIQUE,
    default_unit    TEXT,
    category        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- 13. RECIPES (company recipe cards -- TTY-##### code auto-assigned
--     on first save, see main.js "save-recipe" handler / nextRecipeCode)
-- ------------------------------------------------------------
CREATE TABLE recipes (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    code                    TEXT NOT NULL UNIQUE,   -- 'TTY-00001', assigned once, never reused
    name                    TEXT NOT NULL,
    quantity_produced       TEXT,       -- e.g. '1 PAX', '1 VIP insert'
    prepared_by             TEXT,
    category                TEXT,       -- e.g. 'Main Course', 'Cold Kitchen'
    country_origin          TEXT,
    yield_notes             TEXT,
    date_created            TEXT,       -- the recipe card's own "Date" header field (not created_at)
    preparation_cooking     TEXT,
    presentation_serving    TEXT,
    comment                 TEXT,
    checked_by              TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- 14. RECIPE INGREDIENTS (one row per ingredient line in a recipe,
--     linked to the canonical ingredients master so the same
--     ingredient is always spelled identically across recipes)
-- ------------------------------------------------------------
CREATE TABLE recipe_ingredients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id       INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    ingredient_id   INTEGER NOT NULL REFERENCES ingredients(id),
    quantity        REAL,
    unit            TEXT,
    method          TEXT,       -- e.g. 'marinated before 2 hours'
    sort_order      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- INDEXES to make "no repeat within last N days" lookups fast
-- ------------------------------------------------------------
CREATE INDEX idx_menu_day_items_item ON menu_day_items(item_id);
CREATE INDEX idx_menu_days_date ON menu_days(menu_date);
CREATE INDEX idx_item_portions_item ON item_portions(item_id);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

-- ------------------------------------------------------------
-- VIEW: quick lookup of an item's last-used date per section,
-- used by the generator to enforce "no repeat within 4 weeks"
-- ------------------------------------------------------------
CREATE VIEW v_item_last_used AS
SELECT
    gm.section_id,
    mdi.item_id,
    MAX(md.menu_date) AS last_used_date
FROM menu_day_items mdi
JOIN menu_days md ON md.id = mdi.menu_day_id
JOIN generated_menus gm ON gm.id = md.generated_menu_id
GROUP BY gm.section_id, mdi.item_id;
