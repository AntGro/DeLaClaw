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
2. Find or create the dedicated **DeLaClaw** calendar (hardcoded name).
3. Store `gcal_sync_enabled=true` and the calendar ID in the `settings` key-value table.
4. Run a full push of all enabled item types (habits, TODOs, birthdays).

## Opt-out

Always deletes the DeLaClaw calendar (which removes all its events in Google Calendar). Sets `gcal_sync_enabled=false`. Cross-device: any device reading the shared settings will see sync as disabled.

## Event format

Events appear in the user's calendar with prefixed names that include the item type and category shortname (language-aware at creation time):

- **TODO**: `[TODO][<category shortname>] <todo name>`
- **Habit**: `[Habit][<category shortname>] <habit name>`
- **Birthday**: `[Birthday] <name>`

If no category shortname exists, the category name is used. Birthdays have no categories.

All events are **all-day events** (date only, no specific time). Birthdays are **yearly recurring** (`RRULE:FREQ=YEARLY`).

Each event carries `extendedProperties.private` with `delaclaw_type` and `delaclaw_id` for identification.

## ID mapping

The `gcal_sync` table maps `(item_type, item_id)` → `gcal_event_id`. This is the only link between a DeLaClaw item and its Calendar event.

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

- **Disabling a type**: deletes all existing calendar events for that type and removes their `gcal_sync` entries. Future mutations of that type do not trigger calendar work. Cross-device.
- **Re-enabling a type**: runs a full push of all items of that type.

## Batch API

Calendar operations are sent to Google's Calendar batch endpoint (`multipart/mixed`). Requests are split into chunks of at most **50 operations** (Google's limit).

## Error handling

Fire-and-forget. If a Calendar API call fails (network, expired token), the event stays out of sync until the source item is next modified, which will retry the operation.

## Settings storage

All calendar settings live in the shared `settings` key-value table (persisted through the Drive backend):

- `gcal_sync_enabled` — master toggle
- `gcal_calendar_id` — the DeLaClaw calendar's Google ID
- `gcal_sync_habits` — type toggle
- `gcal_sync_todos` — type toggle
- `gcal_sync_birthdays` — type toggle
