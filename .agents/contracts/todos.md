# Todos — Feature Contract

## Purpose
Quick standalone tasks with priority, due date, drag-drop reorder, inline note edit, snooze, and search.

User jobs:
- add a TODO fast → triage into category
- mark DONE / undo without duplicating
- find via search + clear button
- see focus TODOs in Welcome / Today

## Entry & Ownership
- **Entry:** `js/todos.js` (1395 LOC)
- **State:** `currentView`, `db`, `js`, `sharing`
- **Tables:** `todos`, `settings`
- **CODEMAP:** `features[todos]` — loc 1395, esc 24, i18n 48, guards [pendingSet]

## Dependencies
- **Depends on:** `i18n`, `icons` (via `data-icon`), `item-utils` (drag-drop + inline edit), `sharing-ui`, `state`, `utils`
- **Dependents (blast radius):** `habits.js`, `main.js`, `welcome.js` → editing `todos.js` can affect habit rendering and Welcome aggregation

## UI / UX
- **Reused components:**
  - `.page-empty-state` (icon + title + hint + CTA)
  - `.modal` for delete confirm / edit
  - `.view-tab` for filter tabs
  - bucket-card / project-card / toast
- **Search:** clear via CSS `:not(:placeholder-shown)` — no JS for clear button visibility
- **Drag-drop:** via `item-utils.js`, sort_order monotonic
- **Inline edit:** note field preserves whitespace

## Interaction Guards — Assume Double-Click
- **Pending set:** `window._pendingTodoToggles = Set<todoId>`
  - allow concurrent toggles on different IDs
  - block same ID double-click
  - pattern: `if (_pending.has(id)) return; _pending.add(id); try { ... } finally { _pending.delete(id); }`
- **Modal saves:** wrapped in `guard()` from `js/main.js` (adds `disabled` + `saving`/`is-pending` + `aria-busy`)
- **Button contract:** `onclick="toggleTodo(id,this)"` + `data-todo-id="${id}"` for queryability

## Security
- **XSS esc_count=24:** all user fields `name`, `note`, `url` → `esc()` when interpolating into templates
- `renderMd()` already esc internally — don't double-wrap
- `showDeleteConfirm` uses `.textContent` (safe)
- **URLs:** safe allowlist check, not raw `innerHTML`. No `javascript:`.

## i18n
- **Prefix:** `todos.` — 48 keys EN/FR/ES
- No hardcoded UI text in JS
- Shared keys via `t()` in `js/i18n.js`

## Business Invariants
- `priority ∈ {urgent, high, medium, low, normal}`
- `sort_order` monotonic per category
- `status=done` preserved on reorder
- Snooze: `snoozed_until` → filtered out of Today until due
- Delete → trash, not hard delete from UI (adapter handles)

## Adapter & Backend
- Only via `db.from('todos')` — never `if (backend === 'supabase')`
- Offline-cache wraps transparently via `js/adapters/offline-cache.js`
- All backends implement `.from(table).select/insert/update/delete`

## Sharing
- Uses `js/sharing-ui.js` + `sharing_items` type=todos (Supabase)
- Leaving group removes shared view, local data untouched
- `syncSharedTodos()` merges by `todo_id`

## Cross-Feature Edges
- `welcome.js` → `renderWelcome()` reads focus TODOs (urgent/high + due today)
- Any change to filter/sort/priority → verify Welcome still shows expected set
- `habits.js` depends on `todos.js` (imports helpers) — check CODEMAP dependents

## Risks / Gotchas
- Double toggle creates done/undone race → must use pendingSet
- Drag-drop reorder must not reset done state
- Search clear button must stay CSS-only (avoid JS flicker)

## Test Hooks
- `bun tests/tests.js` checks:
  - `esc_count` usage for `name,note`
  - `pendingSet` existence for toggle
  - CODEMAP freshness (`.agents/CODEMAP.json` matches regenerated)
- Playwright: empty state + search clear

## References
- `CODEMAP.json:features[todos]` — read before editing, check `dependents`
- Entry: `js/todos.js`, adapter: `js/adapters/`, icons: `js/icons.js`

