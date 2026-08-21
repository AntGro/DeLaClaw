# ADR 0008: Category schema — dedicated tables with FK, CASCADE, and protected rows

Date: 2026-08-21
Status: Accepted

## Context

Categories in DeLaClaw organize items into buckets: TODOs into "Work" / "Personal", habits into "Health" / "Routine", flashcards into decks, wardrobe items into clothing types.

Originally, categories were plain strings stored directly on item rows (`todo.category = "Work"`). Category metadata was scattered across three storage layers:

- **Item rows**: category name as a string column
- **Settings table**: JSON blobs for colors and shortnames (`todo_category_colors`, `todo_category_shortnames`)
- **localStorage**: arrays for sort order

This made category operations fragile:

- **Rename**: required updating every item row matching the old string
- **Delete**: required finding and reassigning/deleting all items, then cleaning up settings and localStorage
- **Metadata**: color/shortname/order changes touched different storage layers in separate transactions, with no atomicity
- **Integrity**: no FK constraint, so orphaned category strings and stale metadata accumulated silently

## Decision

### Dedicated category tables with FK relationships

Each feature gets its own category table:

| Feature | Category table | Item FK |
|---|---|---|
| TODOs | `todo_categories` | `todos.category_id` |
| Habits | `habit_categories` | `habits.category_id` |
| Vestiaire | `vestiaire_categories` | `vestiaire.category_id` |
| Flashcards + Texts | `flashcard_decks` | `flashcards.deck_id`, `texts.deck_id` |

**One table per feature, not polymorphic.** Each feature has different category semantics — `flashcard_decks` covers both flashcards and texts (they share decks in the Memory UI), vestiaire has no sharing, habits have frequency-aware categorization. Separate tables keep schemas independent and avoid type-column filtering on every query.

### Schema choices

**Random hex IDs:**

All tables — including projects — use opaque auto-generated IDs (`lower(hex(randomblob(16)))` at the DB level, `crypto.randomUUID()` at the app level). Renaming a category or project changes only its `name` column; no FK updates needed, no aliasing.

**FK with CASCADE on delete:**

Items reference their category via `category_id` FK with `ON DELETE CASCADE`. Deleting a category deletes all its items. This is intentional: categories are organizational buckets, and deleting one means the user wants that bucket and its contents gone. App-level sharing cleanup runs before CASCADE fires to propagate shared-item deletion to all group members.

**Protected default rows:**

Each category table has a protected row (`is_protected=1`) for the General/default bucket. A `protect_category_row()` trigger at the DB level prevents DELETE or UPDATE on protected rows — not just UI hiding. This guarantees the invariant that every feature always has a default bucket.

The `__shared__` category is also a real protected row. Shared items land there and participate in the same FK/CASCADE/sort_order system as personal items, with no special-case code paths. Its color can be edited; its name and existence cannot.

**Metadata on category rows:**

Color, shortname, and sort_order live directly on the category row — not in settings JSON or localStorage. Category metadata is part of the same DB transaction as the category itself, survives across devices, and needs no cross-storage reconciliation.

### Shared schema structure

All four tables share the same column set:

```
id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))
name TEXT NOT NULL
shortname TEXT
color TEXT
sort_order INTEGER DEFAULT 0
is_protected INTEGER DEFAULT 0
owner_id TEXT
created_at TEXT DEFAULT (datetime('now'))
updated_at TEXT DEFAULT (datetime('now'))
```

## Consequences

- Positive: category rename is a single UPDATE on one row — no item rows touched, FKs handle it
- Positive: category delete is atomic — CASCADE removes items, trigger protects defaults, sharing cleanup runs first
- Positive: all category metadata in one place per transaction, no cross-storage reconciliation
- Positive: `__shared__` as a real row eliminates special-case code for shared items
- Positive: opaque IDs decouple identity from display, making renames free
- Positive: DB-level trigger enforcement means bugs in UI code cannot delete the default bucket
- Negative: each new feature that needs categories requires a new table (4 CREATE TABLEs, adapter support in Drive/demo/offline-cache)
- Negative: CASCADE delete is destructive — no soft-delete, no undo at the DB level (app-level confirmation required)
- Neutral: projects historically used user-typed slug IDs; existing slugs are preserved but new projects now use auto-generated IDs like categories

## Alternatives considered

- **Keep string categories with settings metadata** — rejected: three storage layers, no atomicity, rename/delete fragile, metadata drift proven in production
- **Single polymorphic categories table with type column** — rejected: different features have different semantics; type-column filtering on every query; schema coupling between unrelated features
- **Human-readable slug IDs** — rejected for categories: couples ID to display name, renames become FK migrations. Kept for projects where IDs are user-facing.
- **SET NULL on delete (orphan items)** — rejected: orphaned items with no category create UI confusion; user intent when deleting a category is to remove the bucket
- **App-level-only protection for defaults** — rejected: a bug in JS could delete the default bucket; DB trigger is the safety net
