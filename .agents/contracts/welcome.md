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
- **Quick-add category selector**: shows all categories sorted by `sort_order`, excluding `__shared__` — not limited to categories of currently visible items
- Due habits: computed via `isStructuredRule()` + `computeNextDue()` + completions today excluded
- **Habit actions from Welcome**: mark-done, delete, and history are exposed — must behave identically to the Habits page (delegates to `window.markHabitDone`, `window.deleteHabit`, `window.openHabitHistory`)
- Flashcard reviews: due count per deck
- **Text reading progress**: aggregates texts via `getTexts()` + `getTextProgress()` from flashcards module — shows reading completion status
- Birthdays: next 7 days
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
