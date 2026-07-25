# Category Tables Migration Plan (v2 — post-decisions)

**Date**: 2026-07-25
**Decisions**: 9 approved, 5 rejected → plan revised accordingly.

---

## Key Design Choices

| # | Decision | Outcome |
|---|---|---|
| 5 | FK vs string | **FK** — items use `category_id` referencing category table, not name strings |
| 9 | Rename propagation | **Not needed** — FK means only category row name changes, items untouched |
| 10 | Delete behavior | **Cascade** — deleting a category deletes its items |
| 11 | `__shared__` | **Real row** with protected fields (can't delete/rename) |
| 13 | Settings cleanup | **Immediate** — delete dead settings keys when migration completes |
| 3 | IDs | **Random hex** (`lower(hex(randomblob(16)))`), not human-readable |
| 1 | Flashcard scope | `flashcard_decks` covers both `flashcards` and `texts` tables |

---

## New Tables

```sql
CREATE TABLE IF NOT EXISTS todo_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vestiaire_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcard_decks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

`is_protected` — guards `__shared__` and General rows against deletion/rename.

---

## Item Table Changes

### Add `category_id` FK, drop `category` string

```sql
-- todos
ALTER TABLE todos ADD COLUMN category_id TEXT REFERENCES todo_categories(id) ON DELETE CASCADE;
-- then migrate existing data, then:
ALTER TABLE todos DROP COLUMN category;

-- habits
ALTER TABLE habits ADD COLUMN category_id TEXT REFERENCES habit_categories(id) ON DELETE CASCADE;
ALTER TABLE habits DROP COLUMN category;

-- vestiaire
ALTER TABLE vestiaire ADD COLUMN category_id TEXT REFERENCES vestiaire_categories(id) ON DELETE CASCADE;
ALTER TABLE vestiaire DROP COLUMN category;

-- flashcards
ALTER TABLE flashcards ADD COLUMN deck_id TEXT REFERENCES flashcard_decks(id) ON DELETE CASCADE;
ALTER TABLE flashcards DROP COLUMN deck;

-- texts
ALTER TABLE texts ADD COLUMN deck_id TEXT REFERENCES flashcard_decks(id) ON DELETE CASCADE;
ALTER TABLE texts DROP COLUMN deck;
```

`ON DELETE CASCADE` — deleting a category deletes all its items.

---

## Protected Rows

Each feature table gets two protected rows on creation (via migration):

| Row | `name` | `is_protected` | Notes |
|---|---|---|---|
| General | `""` (todos) / `"General"` (habits) / feature-appropriate | 1 | Default bucket. Can edit color/shortname but not delete or rename. |
| Shared | `"__shared__"` | 1 | Shared items land here. Can edit color but not delete or rename. |

Protected means:
- UI hides delete button
- UI prevents rename (name field disabled or hidden)
- Backend rejects DELETE/UPDATE-name for `is_protected = 1` rows

---

## Migration Strategy

Runs once, all backends:

1. **Create 4 category tables**
2. **Seed protected rows**: General + `__shared__` for each feature
3. **Backfill categories from existing items**:
   - Scan distinct `category` (or `deck`) values from items
   - For each unique value not already in the category table → INSERT with auto-assigned color from palette
4. **Backfill metadata from settings JSON**:
   - Read `todo_category_colors`, `todo_category_shortnames`, `habit_category_shortnames`, `vest_category_shortnames`, `flash_shortnames` from `settings` table
   - Parse JSON → UPDATE matching category rows with `color` and `shortname`
5. **Read localStorage category arrays** → assign `sort_order` from array position
6. **Add `category_id` / `deck_id` FK column to item tables**
7. **Populate FK**: `UPDATE todos SET category_id = (SELECT id FROM todo_categories WHERE name = todos.category)` (same for each feature)
8. **Drop old `category` / `deck` string columns**
9. **Delete dead settings keys immediately**
10. **Clean up localStorage keys**
11. **Bump `schema_version`**

---

## JS Module Changes

### Core pattern: string → ID lookup

Before:
```js
const category = todo.category; // "Work"
const color = getCategoryColor("Work"); // settings JSON lookup
```

After:
```js
const categoryId = todo.category_id; // "a3f8b2c1..."
const cat = categoryMap.get(categoryId); // { id, name, color, shortname, sort_order }
const color = cat.color;
```

Each module loads categories into a `Map<id, CategoryRow>` at startup and refreshes on CRUD.

### `js/todos.js`
- Remove: `getCategories()`, `saveCategories()`, `syncCategoriesFromTodos()`, `_colorsAccessor`, `_shortnamesAccessor`, `getCategoryColor()`, `getCategoryShortname()`, `setCategoryColor()`, `setCategoryShortname()`, `CATEGORIES_KEY`, `CATEGORY_COLORS_KEY`, `CATEGORY_SHORTNAMES_KEY`
- Add: `loadTodoCategories()` → `state.db.from('todo_categories').select('*')` → Map
- All renders: look up category by `todo.category_id`
- Create TODO: assign `category_id` from dropdown
- Edit category modal: UPDATE row (name, shortname, color)
- Delete category: DELETE row (CASCADE removes items), block if `is_protected`
- Reorder: update `sort_order` on rows
- Category toolbar: render from loaded rows sorted by `sort_order`

### `js/habits.js`
- Same pattern. Remove `getHabitCategories()`, `saveHabitCategories()`, `_habitShortnamesAccessor`, `SHARED_CATEGORY` constant
- `__shared__` is a real row — look up by `name = '__shared__'`

### `js/vestiaire.js`
- Remove `getVestiaireCategories()`, `saveVestiaireCategories()`, `_vestShortnamesAccessor`, `CATEGORY_COLORS` array, index-based `getCategoryColor()`

### `js/flashcards.js`
- Remove `_flashShortnamesAccessor`, `getDeckColor()` (index-based)
- Both `flashcards` and `texts` reference `flashcard_decks` via `deck_id`
- Deck list from table, not scanning distinct values

### `js/welcome.js`
- Replace `getCategoryColor()` imports → category map lookups

### `js/state.js`
- Remove: `HABIT_CATEGORIES_KEY`
- Add: `state.todoCategories`, `state.habitCategories`, `state.vestiaireCategories`, `state.flashcardDecks`

### `js/sharing-*.js`
- Shared items: set `category_id` to `__shared__` row's ID

---

## Auto-Discovery (Decision #8)

- Shared items not yet reassigned → `__shared__` category row ID
- Import/sync with unknown category names → auto-create category row before inserting item
- FK constraints prevent orphaned category_ids (CASCADE deletes items if category removed)

---

## Adapter Changes

| Adapter | Work |
|---|---|
| `server/schema.sql` | Add 4 CREATE TABLE + ALTER TABLE |
| `js/adapters/rest.js` | No change (generic CRUD) |
| `js/adapters/supabase.js` | No change (PostgREST) |
| `js/adapters/drive.js` | Add 4 new file entries |
| `js/adapters/demo.js` | Add mock category data |
| `js/adapters/offline-cache.js` | Add 4 new IndexedDB tables |
| Supabase RLS | `owner_id = auth.uid()` on all 4 tables |

---

## Execution Order

1. Schema: migration SQL (`migrations/` + `server/schema.sql`)
2. Supabase: RLS policies
3. Adapters: Drive + demo + offline-cache
4. JS migration script: one-time backfill (all backends)
5. Module refactor: todos → habits → vestiaire → flashcards (test after each)
6. Settings + localStorage cleanup: immediate on migration
7. Tests: category CRUD, FK integrity, cascade delete, protected row guards
8. Contracts + CODEMAP: update `.agents/contracts/`

---

## Open Questions

1. **SQLite DROP COLUMN**: supported in SQLite ≥ 3.35.0 (2021). Bun's bundled SQLite should be fine — verify.
2. **Supabase RPCs**: check if `get_group_members` or other RPCs reference `category` column.
3. **Drive adapter**: stores data as JSON files — handle column rename in JSON structure.
4. **Texts table `deck` column**: verify current schema has this column and how it's used.
