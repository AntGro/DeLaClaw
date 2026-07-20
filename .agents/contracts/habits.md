# Habits — Feature Contract

## Purpose
Recurring habits with completions, streak stats, calendar view, and free-text + structured `frequency_rule`.

User jobs:
- create habit with rule (e.g. `daily`, `weekly:Mon,Fri`, or free-text "every other weekend")
- mark DONE today → creates `habit_completions` row
- see due-today in Welcome / Today
- view history per habit

## Entry & Ownership
- **Entry:** `js/habits.js` (2122 LOC)
- **State:** `allHabits`, `allHabitCompletions`, `_historyHabitId`, `currentView`, `db`, `js`, `sharing`
- **Tables:** `habits`, `habit_completions`, `settings`
- **CODEMAP:** `features[habits]` — loc 2122, esc 47, i18n 68, guards [pendingSet]

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `sharing-ui`, `state`, `todos`, `utils`
- **Dependents (blast radius):** `main.js`, `welcome.js` → Welcome shows due-today; change to `frequency_rule` → check Welcome aggregation

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.view-tab`, bucket layout, toast
- **Empty state:** shared `.page-empty-state` with Lucide icon + CTA
- **View modes:** calendar vs list via `data-action="set-habit-view-mode"`

## Interaction Guards
- **Pending set:** `window._pendingHabitDones = Set<habitId>`
  - allow concurrent DONE on different habits
  - block same habit double DONE → prevents duplicate `habit_completions`
  - pattern: pass `this` from `onclick="markHabitDone(id,this)"` + `data-habit-id`
- **Modal saves:** `guard()` wrapper (disabled + saving)

## Security
- **XSS esc_count=47:** wrap `name`, `frequency_rule`, `note` in `esc()`
- `renderMd()` for notes already esc internally
- URL handling not needed, but links use safe allowlist if added

## i18n
- **Prefix:** `habits.` — 68 keys EN/FR/ES
- `frequency_rule` parsed client-side; display uses `t()` keys

## Business Invariants — Critical
- `isStructuredRule()` in `js/habits.js` is **SINGLE SOURCE OF TRUTH** (const `STRUCTURED_PREFIXES`: `daily`, `every_N_days:`, `weekly:`, `every_N_weeks:`, `monthly:`, `monthly_weekday:`, `every_N_months:`, `yearly:`)
- `computeNextDue()` deterministic client-side for structured rules — must not be duplicated elsewhere
- For free-text / custom rules (`isStructuredRule()==false`), `updateHabitNextDue()` sets `next_due = null` to indicate that due date is not client-deterministic and will be resolved externally
- Shared completions merge by `habit_id`, latest per day

## Adapter & Backend
- `db.from('habits')`, `db.from('habit_completions')`
- Offline-cache stores completions; avatars not cached (intentional)
- No backend if checks

## Sharing
- Supabase sharing via `sharing_items` type=habits
- `syncSharedHabits()` merges completions by habit_id + date
- Leaving group → local completions stay

## Cross-Feature Edges
- Welcome aggregates due habits via `state.allHabits` + `allHabitCompletions`
- `frequency_rule` change → verify `welcome.js` rendering
- Bug history: duplicated prefix list once computed `weekly:Fri` as lastDone+5 days (confused day index with offset) → produced Wednesday. Fixed by exporting single source `isStructuredRule()` from `js/habits.js`.

## Risks / Gotchas
- Double DONE → duplicate completion row → must guard
- Free-text rules (e.g. "every other weekend", "biweekly" → +14d, "Le premier week-end" → first Saturday next month) are not deterministic in client — `next_due` stays null until externally resolved
- Changing `STRUCTURED_PREFIXES` → update only in `js/habits.js`, single source

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: create habit `weekly:Fri`, mark done Wed, verify next_due = Friday (not Wed+5)

## References
- `CODEMAP.json:features[habits]`
- Entry: `js/habits.js`

