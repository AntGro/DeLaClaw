# Welcome — Feature Contract

## Purpose
Today / Welcome aggregation — focus TODOs, due habits, flashcard reviews, text reading progress, birthdays, snooze, priority picker.

## Entry & Ownership
- **Entry:** `js/welcome.js`
- **State:** see `CODEMAP.json:features[welcome]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** reads indirectly via state (habits, habit_completions, todos, flashcards, texts, text_line_progress, birthdays)

## Dependencies
- **Depends on:** `flashcards`, `habits`, `i18n`, `icons`, `item-utils`, `sharing-ui`, `state`, `todos`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.modal`, `.app-header`, `.btn`, toast
- **Aggregates:** focus TODOs (urgent/high), due-today habits, due flashcard reviews, text reading progress, upcoming birthdays
- **Scroll stability:** `renderWelcome` preserves `window.scrollY` and each bucket's inner `.welcome-items` scroll across re-renders (same pattern as Lists), so marking a habit done or toggling a TODO doesn't jump the page or the bucket to the top

## Interaction Guards
- **Pending set:** welcome uses pendingSet for toggle/snooze (see CODEMAP guards)
  - `welcomeToggleTodo`, `welcomeDeleteTodo` must use `_pendingTodoToggles` pattern or own set to allow concurrent different IDs
  - `welcomeMarkHabitDone`, `welcomeDeleteHabit` same pattern — concurrent different IDs allowed, same ID blocked
  - Pass `this` + `data-*-id`
- **Modal saves:** `guard()` for snooze submit

## Security
- **XSS:** highest esc_count in the app (see CODEMAP for current count) — all aggregated fields (`todo name`, `habit name`, `birthday name`, `flashcard front`, `text title`) via `esc()`
- Welcome renders from multiple tables — ensure each field is escaped
- URLs via allowlist

## i18n
- **Prefix:** `welcome.` — see CODEMAP for current key count

## Business Invariants
- Focus TODOs: `priority ∈ {urgent,high}` + due today / overdue, not snoozed
- **TODO/habit actions from Welcome**: toggle, snooze, edit, copy-item-link (deep-links to native page via `#todo/{id}` / `#habit/{id}`), delete
- **TODO inline edit rows must stay inside the card**: the deadline row is label + a wrapping fields block — the label stays vertically centred across both lines when the time drops below the date, the date never stretches (minimum required width, so its calendar icon stays next to the date), and the time + clear stay grouped, sitting directly under the date on the second line so the two boxes share the same left edge. Shared `.inline-edit-input` has `min-width:0` so the category select shrinks below its longest option. Measured before the fix at 800px: wrapper 365px content in a 265px card, time input 45px past the card edge, clear button out of view.
- **Dropdown chevrons sit clear of the right border**: the native arrow is painted flush against the edge on iOS Safari, so the Welcome toolbar category select (`.welcome-quick-cat-select`) and the inline-edit category select (`select.inline-edit-input`) reuse the modal select's custom chevron — `appearance:none`, 12px icon at `right 12px center`, 32px right padding — instead of the native arrow. The flashcard proposal deck select keeps its native arrow (compact 2px padding by design).
- **Welcome quick-add rows fit narrow buckets**: the input's default size (~192px min-content) forced the row past the card edge (measured 61px overflow at 800px, + button 40px past the edge), so the input gets a 120px floor and shrinks above it, the select gets `min-width:0`, the buttons never shrink, and the row wraps instead of ever being cut. Below 800px the grid goes single-column (a two-column card is too narrow for the quick-add to fit on one line — it starts wrapping at 770px and fits exactly at 780px), so the quick-add stays on one line; wrapping remains only as a fallback for very narrow single-column widths (at 320px the TODOs buttons drop to a second line with the input still 148px wide).
- **Quick-add category selector**: shows all categories sorted by `sort_order`, excluding `__shared__` — not limited to categories of currently visible items
- **Quick-add default priority**: `medium` (differs from TODOs page default of `normal`)
- Due habits: computed via `isStructuredRule()` + `computeNextDue()` + completions today excluded
- **Habit actions from Welcome**: mark-done, delete, history, and copy-item-link are exposed — must behave identically to the Habits page (delegates to `window.markHabitDone`, `window.deleteHabit`, `window.openHabitHistory`, `window.copyItemLink`)
- Flashcard reviews: due count per deck
- **Text reading progress**: aggregates texts via `getTexts()` + `getTextProgress()` from flashcards module — shows reading completion status
- Birthdays: next 7 days
- **Overview events card**: the Overview shows the number of distinct calendar events in the next 7 days (today + 6, the Coming Up strip's window at offset 0), counted from `collectRangeEvents` and deduplicated by event id — a multi-day event places one entry per day it occupies. It follows the Calendar funnel like the strip (events filtered out there count as 0).
- **Upcoming Birthdays header + button**: a + button (same ghost style as the Coming Up nav buttons) opens the normal add-birthday modal (`data-action="open-add-birthday"`, no preset date). Saving dispatches `birthdays-changed`, which re-renders Welcome when it is the current view — so the new birthday appears in the bucket right away when its next occurrence falls in the next 7 days, and nowhere otherwise.
- **Calendar strip**: reuses the Calendar tab's week cells (`collectRangeEvents` + `dayCellHTML` from calendar.js) — same chips, same overdue mirrors, same day-panel modal on click. It uses the Calendar tab's funnel filter (no override), so a strip cell never shows an item its day panel would hide; it never passes a search query. Navigation (prev/next week, Today) uses a Welcome-owned offset (`wCalWeekOffset`) that never moves the Calendar tab's anchor and resets on `refreshWelcome()`; nav re-renders only the calendar section. Event mutations notify via `events-changed` (dispatched by `refreshEvents`), same pattern as todos/habits-changed.
- **Calendar strip window**: rolling 7 days — today + the next 6 — not the Mon–Sun week. Prev/next shift the window by 7 days (the buttons keep their prev/next-week labels); Today resets the offset to 0. The Calendar tab keeps its Mon–Sun weeks (`getWeekDates` untouched).
- **Calendar strip scrolling**: the strip has the same scroll treatment as `.welcome-items` (`flex:1; min-height:0; overflow-y:auto`), so it scrolls inside the capped section instead of clipping on phones. It also needs `grid-auto-rows:max-content`: `flex:1` gives the strip a definite height, and day cells have `overflow:hidden` (automatic minimum size 0), so without it the grid compresses rows below content height instead of overflowing and scrolling.
- **Calendar strip on phones**: the strip goes single-column under 600px, so each day is a full-width row and shows titles (CSS override scoped to `.welcome-calendar-strip` restores `.cal-chips`/`.cal-more` + weekday label, hides `.cal-dots`). The dots-only rule under 640px exists for the narrow month-grid cells and must not apply here — otherwise every busy day renders as an identical row of dots. No JS change: `fitCalendarChips` only runs on `#calendarGrid`, never on Welcome cells.
- **Container width**: `.welcome-container` must keep `width:100%` alongside `max-width:1200px` + `margin:0 auto`. `#welcomeView` is a flex item of `#app.active` (column flex), and cross-axis auto margins override `align-items:stretch`, so without `width:100%` the container shrink-wraps to its content and its width follows the week's chip titles (wide on long-title weeks, narrow on short-title weeks). Do not remove it; `align-self:stretch` alone does not fix this.
- `refreshWelcome()` must be called after any change to todos/habits/flashcards/texts/birthdays
- `impact.js` suggests `welcome [x]` when any of those change — check blast radius

## Adapter & Backend
- Reads via `db.from()` indirectly through state (allHabits etc. populated elsewhere)
- No direct backend if checks

## Sharing
- Aggregates shared TODOs/habits if present via `syncSharedTodos/Habits`

## Cross-Feature Edges
- This IS the cross-feature aggregator — any change to todos, habits, flashcards, texts, birthdays requires verifying Welcome still renders correctly
- Changing `frequency_rule` parsing → Welcome due habits must update
- Changing text progress tracking → Welcome reading section must update

## Risks / Gotchas
- Highest esc_count — easy to miss esc on new aggregated field
- Double snooze / toggle / habit-done race → use pendingSet
- View flash on reload fixed (projectsView missing display:none) — Welcome must not flash

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: mark habit DONE in habits page → Welcome due count decreases without reload
- Manual: advance text reading → Welcome progress updates

## References
- `CODEMAP.json:features[welcome]`
- Entry: `js/welcome.js`, State aggregates
