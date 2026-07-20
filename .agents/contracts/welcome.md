# Welcome — Feature Contract

## Purpose
Today / Welcome aggregation — focus TODOs, due habits, flashcard reviews, birthdays, snooze, priority picker.

## Entry & Ownership
- **Entry:** `js/welcome.js` (868 LOC)
- **State:** `PROJECTS`, `allBirthdays`, `allHabitCompletions`, `allHabits`, `allVestiaire`, `currentView`, `db`, `js`
- **Tables:** reads `habits`, `habit_completions`, `todos` (plus birthdays via state)
- **CODEMAP:** `features[welcome]` — loc 868, esc 78, i18n 49, guards [pendingSet]

## Dependencies
- **Depends on:** `flashcards`, `habits`, `i18n`, `icons`, `item-utils`, `state`, `todos`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.modal`, `.app-header`, `.btn`, toast
- **Aggregates:** focus TODOs (urgent/high), due-today habits, due flashcard reviews, upcoming birthdays
- **Snooze:** modal via `openSnoozeModal`, priority picker via `welcomeOpenPriorityPicker`

## Interaction Guards
- **Pending set:** welcome uses pendingSet for toggle/snooze (CODEMAP guards [pendingSet])
  - `welcomeToggleTodo`, `welcomeDeleteTodo` must use `_pendingTodoToggles` pattern or own set to allow concurrent different IDs
  - Pass `this` + `data-todo-id`
- **Modal saves:** `guard()` for snooze submit

## Security
- **XSS esc_count=78** (highest): all aggregated fields `todo name`, `habit name`, `birthday name`, `flashcard front` via `esc()`
- Welcome renders from multiple tables — ensure each field esc
- URLs via allowlist

## i18n
- **Prefix:** `welcome.` — 49 keys EN/FR/ES

## Business Invariants
- Focus TODOs: `priority ∈ {urgent,high}` + due today / overdue, not snoozed
- Due habits: computed via `isStructuredRule()` + `computeNextDue()` + completions today excluded
- Flashcard reviews: due count per deck
- Birthdays: next 7 days
- `refreshWelcome()` must be called after any change to todos/habits/flashcards/birthdays
- `impact.js` suggests `welcome [x]` when any of those change — check blast radius

## Adapter & Backend
- Reads via `db.from()` indirectly through state (allHabits etc. populated elsewhere)
- No direct backend if checks

## Sharing
- Aggregates shared TODOs/habits if present via `syncSharedTodos/Habits`

## Cross-Feature Edges
- This IS the cross-feature aggregator — any change to todos, habits, flashcards, birthdays, lists requires verifying Welcome still renders correctly
- Changing `frequency_rule` parsing → Welcome due habits must update

## Risks / Gotchas
- Highest esc_count — easy to miss esc on new aggregated field
- Double snooze / toggle race → use pendingSet
- View flash on reload fixed (projectsView missing display:none) — Welcome must not flash

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: mark habit DONE in habits page → Welcome due count decreases without reload

## References
- `CODEMAP.json:features[welcome]`
- Entry: `js/welcome.js`, State aggregates

