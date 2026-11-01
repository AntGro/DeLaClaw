# Contract — Calendar & Events

Invariants the calendar surfaces must keep. (The Calendar page has no
CODEMAP feature entry; it aggregates todos, habits, birthdays and
events — see the per-type contracts for those, plus calendar-sync.md
for the Google Calendar mirror.)

## User events (v2.31.0)

- Storage is one `events` table on every backend (Drive file
  `events.json`, schema migration 2.28.0). Two shapes, never mixed:
  - **Timed**: `start_ts` / `end_ts` are absolute instants (UTC ISO);
    `timezone` is the IANA zone the wall times were entered in.
  - **Full-day**: `start_date`..`end_date` is an INCLUSIVE date range;
    instants and timezone are null.
- Placement is viewer-relative for timed events: the occupied days
  are the days the instant interval overlaps in the VIEWER's
  timezone (`eventSpan` / `eventDatesInRange` in calendar-pure.js).
  An end exactly at local midnight does not claim the new day.
  Full-day events never convert — they sit on their stored dates for
  every viewer.
- Editing a timed event happens in the event's own timezone (the
  form re-derives wall times from the instants in `timezone`), so an
  unchanged edit round-trips to the same instants.
- All placement/conversion logic lives in calendar-pure.js and is
  behaviorally tested; calendar.js only renders.

## Sharing

- Shared events ride the generic sharing item path
  (`item_type: 'event'`, group file `events.json`), with the TODO
  pointer pattern: a minimal local row (`title: ''`, `shared_id`,
  `shared_group_id`) enriched from the payload at load
  (`refreshEvents`), pointers created/dropped by `syncSharedEvents`.
- Any group member can edit or delete a shared event; the payload in
  the group file is canonical — edits go through
  `sharing.updateItem`, never the local row.
- Group lifecycle covers events like the other types: leave/delete
  converts or drops event pointers (`sharing-ui.js`).

## Google Calendar mirror

- Events mirror like the other types (see calendar-sync.md):
  prefix `[Event]` (`[Event][<group>]` when shared), note →
  description, timed payloads carry `dateTime` + the event's
  `timeZone`, full-day payloads use `date` with the exclusive end
  converted at the boundary (stored inclusive end + 1 day).
- Gated by the `gcal_sync_events` setting (default on), alongside
  the habits/todos/birthdays toggles.

## Grid ordering (Month/Week cells)

- Chips in a day cell sort by type: **Birthdays, Events, TODOs, Habits**
  (`TYPE_ORDER` in calendar.js, applied to every day's list). Within a
  type the sort is stable, so items keep load order.
- This also decides the +N overflow cutoff: chips past `MAX_CHIPS` hide
  from the end, so Habits fall behind the counter first.
- The day panel keeps its own section order (Events, Habits, TODOs,
  Birthdays) — deliberately different from the grid.
- The day panel title (`.cal-day-title-main`, via `dayTitleParts`) capitalizes
  the weekday and month in all locales via `formatToParts` (Intl returns
  them lowercase in French/Spanish); locale word order and particles stay
  untouched. No-op in English.
- `collectRangeEvents` / `dayCellHTML` are exported for the Welcome
  strip. `collectRangeEvents` takes an optional `show` override (default:
  the tab's funnel filter) — callers that must ignore the filter pass
  all-true explicitly.

## Day modal (v2.32.12)

- **Background scroll lock**: opening the day modal locks page scroll
  (body fixed at the saved offset, same pattern as Settings) on both
  Welcome and Calendar; closing it restores the position. The lock is
  owned by the day modal via a flag, so it never steals another
  modal's lock.
- **Stacked item modals**: opening an event/birthday add/edit modal
  from the day modal does NOT close it. The day modal stays open
  underneath, blurred and below the item overlay
  (`#calendarDayOverlay.cal-day-behind`, z-index 150 under the item
  overlay's 200). Every exit path (cancel / save / delete) goes
  through the item modal's close function, which clears the behind
  state — so the user returns to the day modal, never to the tab view.
  Delete paths no longer close the day modal either.
- **Panel freshness**: an open day panel re-renders after add/edit/
  delete. On the Calendar tab `renderCalendar()` inside
  `refreshEvents()`/`refreshBirthdays()` covers it; on other views
  (Welcome) listeners on `events-changed`/`birthdays-changed`
  re-render the panel (`refreshBirthdays` dispatches
  `birthdays-changed`, mirroring `events-changed`). Same-day refreshes
  preserve the panel's scroll position.

## Explicitly out of scope (deferred by the user, Oct 24, 2026)

- Recurrence, reminders, Welcome-page surfacing, demo sample events.
