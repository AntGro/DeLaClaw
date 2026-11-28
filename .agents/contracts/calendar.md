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
  strip. `dayCellHTML` wraps the day number and the weekday label in one
  `.cal-day-head` row, so the weekday always sits next to the number.
  `collectRangeEvents` takes an optional `show` override (default:
  the tab's funnel filter) — the strip uses the default, so its cells
  agree with the day panel; a caller that must ignore the filter passes
  all-true explicitly.

## Calendar search (v2.32.42)

- The toggle is the shared `.search-wrapper` (same UX as the other
  tabs: search icon, input + clear ×, collapse on blur when empty),
  in the toolbar-right next to the + add button — not with the funnel
  filter on the left. The placeholder/title come from `common.search`
  via the `searchMap` in main.js.
- Matching is title/name plus attachment names, case-insensitive
  substring on the collected `title` and on each collected
  attachment's `name` (`(ev.attachments || []).some(...)`, v2.32.199 —
  only events carry attachments in the collected objects; notes are
  never matched).
  Notes are never matched — they are not collected — and neither are
  category names.
- The query is session-only (`calSearch` module var, never persisted):
  a reload starts unfiltered. Closing the input clears the query
  (blur-collapse of an empty input dispatches an input event, which
  clears the filter; the × clears it and keeps the input open).
- Filtering happens in `collectRangeEvents(start, end, show, search)`,
  whose 4th parameter defaults to `''` (no filter). The four Calendar
  tab call sites (month, week, year, day panel) pass `calSearch`; the
  Welcome strip never passes a query, so a tab search never leaks
  into Welcome. Filtering applies after the type sort, so chip order
  and the +N cutoff follow the filtered set.
- **Filter-status disc**: the funnel button keeps its plain `.btn`
  shape and size; only its background is one radial sector per
  filterable type (`buildFilterDiscBackground` in calendar-pure.js,
  driven by `CAL_FILTER_TYPES` in calendar.js, in menu order
  clockwise from the top) — pale (the type colour at 15% over the
  surface) when shown, the neutral button background
  (`var(--surface2)`) when filtered out, so it reads as switched
  off. Display-only: toggling stays in the funnel menu. The icon
  keeps the button's own colour with no halo. The sector width comes
  from the list length, never a hard-coded count — adding a type is
  one entry in `CAL_FILTER_TYPES` plus its funnel toggle, its
  `calShow` default and its `collectRangeEvents` branch.
  `syncCalendarToolbar` repaints the disc on every filter change.

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

## Attachments (v2.32.199)

- Same mechanism as lists/TODOs/habits (see the lists contract for the
  shared model): one record shape `{drive_file_id, name, size, url,
  uploaded_by}`; canonical storage is a JSON string in the event's
  `attachments` TEXT column (migration 2.32.199, both backends) and a real
  array in the sharing payload.
- A shared event's records travel in the payload, like a TODO's.
  `eventPayload(ev)` carries them, so share, unshare and copy carry them
  — and the edit merge reads the live payload via `sharedEventPayload`
  and throws when unreadable, never a stub, so saving an edit never
  wipes attachments added by another member (the v2.32.194 pattern,
  event-shaped; the attachment save uses the same helper).
- Attach lives in the **edit modal only** (paperclip + chips in
  `#editEventAttachments`, Drive-only gate): a new event has no row until
  it is saved, so the add modal cannot attach. The queue's render
  re-renders the modal section and the calendar behind it, so the day
  panel updates without waiting for a save.
- The **day panel** shows read-only chips under the event row (the chips
  sit after the row's `<button>`, never inside it). The grid day cells
  and the Welcome strip show no chips. Calendar search matches
  attachment names as well as titles.
- Share grants each file reader first and rolls the grants back on any
  later failure (pointer-insert failure, upload failure after the swap).
  Unshare and copy-to-personal carry the records; unshare revokes the
  group's access to the unsharer's own files only. Leaving/deleting a
  group with keep-copies carries the records (`_convertGroupItemsToPersonal`
  events branch, v2.32.199). Deleting an event trashes only the deleter's
  own files — the shared path already awaits the remote delete first, so
  there is no delete-ordering hazard here. The join-backfill sweep scans
  events alongside lists, TODOs and habits.
- The Google Calendar mirror is untouched: attachment-only changes
  no-op (attachments are not in the shared-event fingerprint), and no
  attachment link is written into the mirrored description.

## Explicitly out of scope (deferred by the user, Oct 24, 2026)

- Recurrence, reminders, Welcome-page surfacing, demo sample events.
