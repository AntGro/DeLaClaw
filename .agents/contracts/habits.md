# Habits — Feature Contract

## Purpose
Recurring habits with completions, draft workflow, calendar/heatmap view, categories with cross-category drag, inline editing, frequency picker, and structured + free-text `frequency_rule`.

User jobs:
- create habit with structured rule (e.g. `daily`, `weekly:Mon,Fri`) or free-text ("every other weekend")
- save as draft (no due date) → promote to active later
- mark DONE today → creates `habit_completions` row
- see due-today in Welcome / Today
- view history, edit completions, edit last-done date
- calendar/heatmap view of completion history
- manage categories: create, rename, recolor, reorder, delete
- drag habits between categories
- search by name

## Entry & Ownership
- **Entry:** `js/habits.js`
- **State:** see `CODEMAP.json:features[habits]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `habits`, `habit_completions`, `habit_categories`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `sharing-ui`, `state`, `utils`
- **Dependents (blast radius):** `main.js`, `welcome.js` → Welcome shows due-today; change to `frequency_rule` → check Welcome aggregation

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.view-tab`, `.category-nav-btn`, bucket layout, toast
- **Empty state:** shared `.page-empty-state` with Lucide icon + CTA
- **View modes:** list vs calendar/heatmap via `setHabitViewMode`; calendar has month navigation and scale toggle
- **Frequency picker:** rich structured-rule builder (`buildFrequencyPicker` / `readFrequencyPicker` / `prefillFrequencyPicker`) with type selectors, day pickers, interval inputs — used in add, edit, and inline edit
- **Inline edit:** `inlineEditText` for habit names with frequency picker integration in inline mode
- **Category nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted
- **Cross-category drag:** `initItemDragDrop` with `crossOnly: true` — habits can be dragged between categories but not reordered within a category
- **Search:** text filter by name across all categories

## Interaction Guards
- **Pending set:** `window._pendingHabitDones = Set<habitId>`
  - allow concurrent DONE on different habits
  - block same habit double DONE → prevents duplicate `habit_completions`
  - pattern: pass `this` from `onclick="markHabitDone(id,this)"` + `data-habit-id`
- **Modal saves:** `guard()` wrapper (disabled + saving)

## Security
- **XSS:** see CODEMAP for current esc_count — wrap `name`, `frequency_rule`, `note` in `esc()`
- `renderMd()` for notes already escapes internally
- URL handling not needed, but links use safe allowlist if added

## i18n
- **Prefix:** `habits.` — see CODEMAP for current key count (EN/FR/ES)
- `frequency_rule` parsed client-side; display uses `t()` keys

## Business Invariants — Critical

### Frequency Rules
- `isStructuredRule()` in `js/habits.js` is **SINGLE SOURCE OF TRUTH** (const `STRUCTURED_PREFIXES`: `daily`, `every_N_days:`, `weekly:`, `every_N_weeks:`, `monthly:`, `monthly_weekday:`, `every_N_months:`, `yearly:`)
- `computeNextDue()` deterministic client-side for structured rules — must not be duplicated elsewhere
- For free-text / custom rules (`isStructuredRule()==false`), `updateHabitNextDue()` sets `next_due = null` to indicate that due date is not client-deterministic and will be resolved externally
- Bug history: duplicated prefix list once computed `weekly:Fri` as lastDone+5 days (confused day index with offset) → produced Wednesday. Fixed by exporting single source `isStructuredRule()` from `js/habits.js`.

### Initial Next-Due (No Completions)
- **Pure interval rules** (`every_N_days`, `every_N_weeks` without specific days): `next_due = today` — habit starts immediately
- **Anchored rules** (weekly on specific days, monthly on a date/weekday, yearly): `next_due` = next valid occurrence on or after today — e.g. "first Monday of each month" created on a Sunday schedules the next first Monday, not today
- Implementation: anchored rules use yesterday as the base date so the existing "next after base" logic naturally includes today as a candidate

### Early Completion & Next-Due
- **`updateHabitNextDue` two-mode behavior:**
  - **Completion path** (`earlyGuard: true`, default): if the computed next-due ≤ current due date, recompute from the current due date — early-completion guard (e.g. `weekly:Fri` done on Wednesday → next Friday, not same Friday)
  - **Manual edit path** (`earlyGuard: false`): `next_due = min(currentDue, computedDue)` — due date can move earlier but never double-advances. Used when editing last-done or changing frequency
- **Completion delete/edit recomputation:** deleting or editing a completion recomputes `next_due` from the habit's frequency rule and the new latest remaining completion (`earlyGuard: false`). Never blindly clears to null — always passes the real rule and latest date through `updateHabitNextDue`

### Draft Habits
- `is_draft` field: draft habits have no `next_due`, skip due computation, show a distinct "draft" status badge
- "Save as draft" toggle in add modal
- `promoteHabit()` converts draft → active (sets `is_draft = false`), then `next_due` is computed normally
- Drafts are excluded from calendar view and Welcome aggregation

### Last-Done Editing
- **`planLastDoneEdit` pure helper:** shared decision logic for editing last-done date. Both `setLocalHabitLastDone` (DB operations) and `setSharedHabitLastDone` (shared storage array) delegate to it. Returns `{ kept, toDelete, updateId, needsInsert }`
- **Last-done edit deletes future completions:** setting last-done to date X removes all completions after X and ensures one exists on X. The "last done" display always reflects the latest remaining completion

### Categories
- Category CRUD: create (with name, shortname, color), edit (rename, recolor), delete
- **Category FK**: `category_id` FK → `habit_categories(id)`, CASCADE on delete. Deleting a category deletes all its habits + completions. App-level sharing cleanup runs first — shared items are removed from `sharing_items` before CASCADE fires
- **Explicit item deletion before category delete**: items are deleted individually before the category row so that calendar dirty tracking (`markDirty`) fires for each item. Drive/Demo have no FK enforcement, so CASCADE alone would not trigger per-item sync
- Protected default row (`name=''`, `is_protected=1`) cannot be deleted
- Category nav order persisted via `sort_order`, reorderable by long-press drag

## Adapter & Backend
- `db.from('habits')`, `db.from('habit_completions')`, `db.from('habit_categories')`
- Offline-cache stores completions

## Sharing
- Sharing via the Drive adapter (`sharing_items` equivalent in shared folder JSON, type=habits)
- `syncSharedHabits()` merges completions by habit_id + date
- Shared habit IDs are canonical: the shared record id is the value stored in every local pointer's `shared_id`
- `creator_category` is origin metadata only. Local category placement remains personal and must not rewrite `creator_category`
- Leaving group → local completions stay
- Share buttons shown whenever sharing is enabled/initialized, even if no group exists yet

## Cross-Feature Edges
- Welcome aggregates due habits via `state.allHabits` + `allHabitCompletions`; drafts excluded
- `frequency_rule` change → verify `welcome.js` rendering
- Habit mark-done, delete, and history are also exposed from Welcome — must behave identically
- **Calendar sync**: category rename/shortname change calls `markCategoryRenamed('habit_categories')` → full calendar resync of all habit events in that type

## Risks / Gotchas
- Double DONE → duplicate completion row → must guard with pendingSet
- Free-text rules (e.g. "every other weekend", "biweekly" → +14d, "Le premier week-end" → first Saturday next month) are not deterministic in client — `next_due` stays null until externally resolved
- Changing `STRUCTURED_PREFIXES` → update only in `js/habits.js`, single source
- Cross-category drag updates FK — must re-number `sort_order` in target category

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: create habit `weekly:Fri`, mark done Wed, verify next_due = Friday (not Wed+5)
- Manual: create habit `every_N_months:1:first:Mon` with no last-done, verify next_due = next first Monday (not today)
- Manual: create habit `every_N_days:3` with no last-done, verify next_due = today
- Manual: edit `weekly:Fri` habit's last-done to Monday → next_due stays at current Friday (min keeps the earlier)
- Manual: change frequency from `weekly:Fri` to `daily` → next_due moves earlier (min picks closer date)
- Manual: save habit as draft, verify no next_due, promote, verify next_due computed
- Manual: drag habit between categories, verify FK updated and sort_order re-numbered
- Manual: reorder category nav buttons, reload, verify order persists

## References
- `CODEMAP.json:features[habits]`
- Entry: `js/habits.js`
