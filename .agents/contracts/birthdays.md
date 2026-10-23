# Birthdays — Feature Contract

## Purpose
Birthday reminders with avatar photos and crop modal. Since v2.14 the
dedicated Birthdays page is gone: birthdays surface on the **Calendar page**
(month grid + day panel) alongside todos and habits.

User jobs:
- add birthday with name, date, avatar photo (crop/pan/zoom) — via the
  Calendar page "+" menu
- see birthdays on the calendar (yearly occurrence, "turns X")
- edit name/date/note/avatar, delete — via the day panel → edit modal

## Entry & Ownership
- **Entry:** `js/birthdays.js` (data + CRUD + modals), `js/calendar.js` (page)
- **State:** see `CODEMAP.json:features[birthdays]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `birthdays` (kept; the page was removed, the data was not)

## Dependencies
- **Depends on:** `i18n`, `icons`, `state`, `utils`
- **Dependents:** `main.js`, `calendar.js`

## UI / UX
- **Reused components:** `.modal`, toast, `.new-birthday-avatar-row`
- **Views (granularity):** Day / Week / Month / Year via the `calendar-days`
  toolbar button (radio popup). Month is the default; the choice is per-session.
  - Day: selected day full-page (same grouped rows as the day panel)
  - Week: 7 Mon–Sun columns, chips on desktop / dots on phones
  - Month: the grid
  - Year: 12 mini-months with dots; tap a month name → that month; tap a day → day panel
- **Navigation:** ‹ Today › steps by the current granularity (day/week/month/year).
  The toolbar label is clickable day/month/year segments opening jump
  pickers (month grid, year range, native date input); the anchor day is
  kept when valid in the target month, clamped otherwise.
- **Day panel / day view:** wider modal (980px); Habits / TODOs / Birthdays are
  welcome-style sections in a responsive grid (`.cal-day-sections`,
  side-by-side when width allows) with per-category subsections
  (`.welcome-todo-cat-label`) for habits and TODOs. Rows reuse the
  `.bucket-item` look. Month/week cells stretch (`flex`) to fill the space
  between toolbar and footer, keeping their min-height as the floor.
- **Habit DONE gating:** only the row on the habit's actual `next_due` has an
  enabled DONE button — completing any other occurrence would complete the
  current `next_due` instead (`markHabitDone` always completes the current
  due date). Other rows show a disabled button (`calendar.only_next_due`).
- **Chips:** shape encodes type (todo = square chip/marker, habit = pill/circle,
  birthday = soft rect + avatar); background encodes the item's category
  color (birthdays → pink). Dots (phones, year view) keep type colors.
- **Filters:** funnel toolbar button → checkbox popup (TODOs/Habits/Birthdays),
  swatches reuse the chip/dot colors (accent/green/pink)
- **Avatar:** interactive crop modal with drag/pan/zoom, 384px resolution, migration `003_birthday_avatars.sql`
- **Add:** Calendar "+" dropdown menu → existing add-birthday modal (only menu item for now)
- **Edit:** tap a birthday in the calendar day panel → edit modal (name, date,
  note, avatar via the preview overlay, delete button)
- **Delete:** from the edit modal, confirm → closes modal + day panel, refreshes calendar
- **Empty state:** n/a (no page)

## Interaction Guards
- **Modal saves:** single-flight via disabled state while the async save runs
- **Crop modal:** single-action save, disable until upload complete
- **Day panel DONE buttons:** reuse the per-ID pending sets of todos/habits
  (`toggleTodo`, `markHabitDone`), then re-render calendar + panel

## Security
- **XSS:** see CODEMAP for current esc_count — `name` wrapped in `esc()`
- Avatar handling: photos as data URLs, never innerHTML
- `showDeleteConfirm` via textContent

## i18n
- **Prefix:** `birthdays.` — see CODEMAP for current key count
- Calendar page strings: `calendar.` prefix; month/weekday names via `Intl`
- Date formatting via `t()` + locale, no hardcoded month names

## Business Invariants
- `birthdays` table: `name`, `birthday` (date), optional `avatar_url`, crop state held in modal UI (not persisted separately)
- Occurrence math (`birthdayInMonth`, `js/calendar-pure.js`): JS Date overflow
  semantics (Feb 29 → Mar 1 on non-leap years), matching the old
  `getNextBirthday()` behavior used by Welcome
- Calendar views collect birthdays via `birthdaysInRange(birthday, start, end)`:
  occurrences depend only on the requested range (every month it spans),
  never on the view's anchor month
- Avatar crop persists at 384px resolution, centered
- `refreshBirthdays()` re-renders the calendar when it is the current view

## Adapter & Backend
- Only `db.from('birthdays')`
- Offline-cache wraps; avatar binary not cached (fetch on demand)

## Sharing
- Private (birthdays not shared)

## Cross-Feature Edges
- Welcome aggregates upcoming birthdays (next 7 days) — untouched
- Changing avatar → verify Welcome birthday cards show new crop
- **Calendar sync**: birthdays participate in calendar sync as yearly recurring events (`RRULE:FREQ=YEARLY`). Delete, rename, and date changes trigger calendar event updates
- `#birthdays` deep links redirect to `#calendar`
