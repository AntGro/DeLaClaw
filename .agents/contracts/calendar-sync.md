# Calendar Sync — Feature Contract

## Overview

Calendar sync creates and maintains a dedicated **DeLaClaw** calendar in the user's Google Calendar, populated with all-day events derived from habits, TODOs, and birthdays. The calendar is a **pure projection of the in-memory database** — it only changes when the DB changes, and is never read back to verify state.

## Availability

- **Drive backend**: fully operational (reuses the Drive OAuth token which includes `calendar.app.created` scope).
- **Demo backend**: tables and settings exist, but no real Calendar API calls are made.
- **Supabase backend**: removed — see `dev-latest-supabase-support` branch. Migration `1.809` (`gcal_sync` table) is frozen.
- **Local SQLite**: not wired.

## Token

No separate OAuth flow. The Google token obtained during Drive sign-in includes `calendar.app.created` scope. Any device connected to Google Drive automatically has calendar access. The shared `gcal_sync_enabled` setting is the cross-device gate.

## Opt-in

Only possible when calendar sync is not already enabled. On enable:

1. Obtain the shared Google token from the Drive adapter.
2. Find or create the dedicated **DeLaClaw** calendar (name derived from the hostname: `DeLaClaw` on production, `DeLaClawDev` elsewhere).
3. Store `gcal_sync_enabled=true` and the calendar ID in the `settings` key-value table.
4. Run a full push of all enabled item types (habits, TODOs, birthdays).

## Opt-out

- **Master toggle off**: wipes every event in the DeLaClaw calendar (wipe-based: paginated list + batch delete, catching orphans with no ledger row), then clears the `gcal_sync` ledger. The calendar itself is kept for re-use (avoids orphaned/duplicate calendars). All-or-nothing: on wipe failure the ledger is kept so a later toggle-off retries. Sets `gcal_sync_enabled=false`. Cross-device: any device reading the shared settings will see sync as disabled.
- **Account deletion** (`deleteCalendar=true`): deletes the entire DeLaClaw calendar from Google, clears the ledger, clears the stored calendar ID.

## Event format

Events appear in the user's calendar with prefixed names that include the item type and category shortname (language-aware at creation time):

- **TODO**: `[TODO][<category shortname>] <todo name>`
- **Habit**: `[Habit][<category shortname>] <habit name>`
- **Birthday**: `[Birthday] <name>`

If no category shortname exists, the category name is used. Birthdays have no categories.

All events are **all-day events** (date only, no specific time). Birthdays are **yearly recurring** (`RRULE:FREQ=YEARLY`).

Each event carries `extendedProperties.private` with `delaclaw_type` and `delaclaw_id` for identification.

## ID mapping

Event IDs are **deterministic**: the Google event ID is the item's UUID with dashes stripped (32 hex chars — valid base32hex). The `gcal_sync` table is a bare set of live `(item_type, item_id)` pairs; the event ID is derived, never stored. Rows written before the deterministic-ID migration still carry `gcal_event_id`, which wins while present so the migration's delete phase can address the old events.

Consequences:

- A `409` on create means "this item's event already exists" (retry after a crash between insert and entry write, or an interrupted migration) — the handler PATCHes the existing event into shape and records the entry, never duplicates.
- Cross-device races are safe: two tabs creating the same item's event converge on the same ID via 409 → patch.
- `last_synced_at` was write-only (nothing read it) and is gone.

One-shot migration (`migrateEventIdsToDeterministic`, runs as a **login gate** in `connect()` before the app shell shows — a deferred migration throws `cal_migration_failed` and returns to the login screen, like the schema migrations):

1. **Row-driven gate**: migration work remains iff a `gcal_sync` row still carries `gcal_event_id` (inspects the rows, not the calendar prefs — sync-off with leftover rows is not "done").
2. Verifies the saved calendar (or creates it — also heals a stale `gcal_calendar_id`).
3. Loads the category maps (so rebuilt titles keep their `[Category]` prefixes), then checks every syncable item ID is derivable — fails before touching the calendar.
4. **Wipe phase**: deletes every event in the calendar (paginated `events.list` with `singleEvents=false` + an explicit far-past `timeMin`, batch deletes of 50) — ledger rows and orphans alike — then clears the ledger. All-or-nothing: a failed wipe throws before the ledger is touched.
5. **Recreate phase** (sync on only): full scan per enabled type via the normal `syncTable` path.
6. **Validation**: dirty sets empty, every syncable item has a ledger row — only then sets `gcal_event_id_migration=done`.

A 403 (calendar scope missing/revoked) turns calendar sync off instead of blocking the app forever: clears the ledger, sets `gcal_sync_enabled=false` + `gcal_scope_missing=true`, marks done; the app toasts how to re-enable (which re-requests the scope). Any other failure defers to the next login. Safe to re-run: the 409-on-create path heals partial runs (recreate → 409 → patch + entry).

While a wipe is in flight (`_wipeRunning`), `syncTable` returns early without consuming dirty sets, so events created mid-wipe keep their dirty marks for the next run instead of being orphaned by the ledger clear.

## Sync model

Calendar is a pure projection of the DB. It only updates when the DB updates:

- **No page-load reconciliation**: on page load, trust that the calendar is already synced.
- **No self-healing**: if an event is deleted externally in Google Calendar, it will not be re-created until the source item is next modified in DeLaClaw.
- **Sync at debounce**: mutations are instant in-memory. The Drive adapter debounces writes (~2s). After a successful table flush, the flush hook triggers `syncTable()` which processes only the dirty item IDs.

### Dirty-ID tracking

The Drive adapter extracts the item ID from each non-GET mutation (via builder `.eq('id', ...)` filter or insert body) and calls `markDirty(table, id)`. On flush, `syncTable()` consumes the dirty set and processes only those IDs. If the ID cannot be determined (bulk ops), a `__all__` sentinel forces a full scan for that type.

### Category shortname changes

Category tables (`habit_categories`, `todo_categories`) are separate from item tables. A category write does **not** automatically dirty any items. Only when the category's `shortname` or `name` actually changes does the rename handler (`saveEditCategory` / `saveEditHabitCategory`) call `markCategoryRenamed(catTable)`, which triggers a full scan of the corresponding item type so that all events get their summaries updated. Category inserts, color changes, and sort_order changes have no calendar effect.

## Per-type behaviour

### Habits

| Action | Calendar effect |
|--------|----------------|
| Created with `next_due` | Create event |
| `next_due` updated (done, inline edit, freq change, last-done edit) | Update event date |
| Renamed | Update event summary |
| Moved to another category | Update event summary (category shortname changes) |
| Deleted | Delete event |
| Category shortname changed | Update all events in that category |

### TODOs

| Action | Calendar effect |
|--------|----------------|
| Created with `due_date` or `snoozed_until` | Create event |
| `due_date` or `snoozed_until` updated | Update event date (`due_date` takes priority) |
| Renamed | Update event summary |
| Marked done | Delete event |
| Un-completed (done → not done) with a date | Re-create event |
| Snoozed | Update event date (only if no `due_date`) |
| Moved to another category | Update event summary |
| Deleted | Delete event |
| Category shortname changed | Update all events in that category |

**Date priority**: when a TODO has both `due_date` and `snoozed_until`, `due_date` prevails for the calendar event date.

### Birthdays

| Action | Calendar effect |
|--------|----------------|
| Created with a date | Create yearly recurring event |
| Date changed | Update event date |
| Renamed | Update event summary |
| Deleted | Delete event |

## Type toggles

Each type (habits, TODOs, birthdays) has an independent toggle in settings (`gcal_sync_habits`, `gcal_sync_todos`, `gcal_sync_birthdays`). Defaults: all `true`.

- **Disabling a type**: deletes all existing calendar events for that type (entry-based) and removes their `gcal_sync` entries. Failed deletes keep their entries and requeue the IDs so a later run retries. Future mutations of that type do not trigger calendar work. Cross-device.
- **Re-enabling a type**: runs a full push of all items of that type.

## Resynchronize

The Resynchronize button (settings, shown while sync is active) is strictly equivalent to toggling sync off then on: wipe the calendar → clear the ledger → verify/create the calendar → full-push all types. Toggles are greyed out while it runs.

## Batch API

Calendar operations are sent to Google's Calendar batch endpoint (`multipart/mixed`). Requests are split into chunks of at most **50 operations** (Google's limit).

## Error handling

Failed operations (network error, 429, 5xx) go back into the per-table dirty set and are retried on a later `syncTable` run — a failed op is never silently dropped. Other 4xx are not retried. Update on a 404 keeps the entry without resurrecting the event. Per-type deletion (`deleteTypeEvents`) requeues failed IDs the same way; entries are only cleared for events actually deleted (2xx/404/410).

Calendar-wide wipes (migration, toggle-off, resync) are all-or-nothing: any event surviving the batch delete throws before the ledger is cleared, so the ledger always describes the calendar.

## Settings storage

All calendar settings live in the shared `settings` key-value table (persisted through the Drive backend):

- `gcal_sync_enabled` — master toggle
- `gcal_calendar_id` — the DeLaClaw calendar's Google ID
- `gcal_sync_habits` — type toggle
- `gcal_sync_todos` — type toggle
- `gcal_sync_birthdays` — type toggle
- `gcal_scope_missing` — transient marker set by the migration gate when the calendar scope is missing (consumed at startup with a toast, then deleted)
- `gcal_event_id_migration` — `done` once the deterministic-ID migration completed
