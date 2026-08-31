# Todos — Feature Contract

## Purpose
Quick standalone tasks with priority, due date, snooze, cross-category drag, category CRUD, sharing, and search.

User jobs:
- add a TODO fast with optional priority via quick-add picker → triage into category
- mark DONE / undo without duplicating
- drag TODOs between categories
- reorder category nav buttons
- filter by pending / done / snoozed / outdated
- find via search
- snooze with presets or custom date, unsnooze to re-snooze
- share/unshare TODOs, bulk-share a category, copy shared to personal
- manage categories (create, edit name/shortname/color, delete)
- see focus TODOs in Welcome / Today

## Entry & Ownership
- **Entry:** `js/todos.js`
- **State:** see `CODEMAP.json:features[todos]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `todos`, `todo_categories`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils` (drag-drop + inline edit), `sharing-ui`, `state`, `utils`
- **Dependents (blast radius):** `main.js`, `welcome.js` → editing `todos.js` can affect Welcome aggregation

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.btn`, `.project-card`, `.category-nav-btn`, `.empty-state`, toast
- **Search:** `filterTodos` / `todoSearchQuery` — filters across TODO text and notes; clear via CSS `:not(:placeholder-shown)`
- **Filter tabs:** `setTodoFilter` with 4 modes: `pending` (active, not snoozed), `done`, `snoozed`, `outdated` (past due_date)
- **Category nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted; displays shortname or name with `--cat-color`
- **Cross-category drag:** `initItemDragDrop` with `crossContainerSelector` — TODOs draggable between categories, updates `category_id` FK and re-numbers `sort_order`
- **Inline edit:** note field via `inlineEditText`, preserves whitespace
- **Done section:** `toggleDoneTodos` shows/hides completed items per category; `deleteAllDoneTodos` bulk-deletes done items in a category

## Interaction Guards
- **Pending set:** `_pendingTodoToggles = Set<todoId>` for done/undone toggle
  - concurrent toggles on different IDs allowed, same ID blocked
  - pattern: `if (_pending.has(id)) return; _pending.add(id); try { ... } finally { _pending.delete(id); }`
- **Sharing pending set:** `_pendingShare = Set<key>` for share/unshare operations
- **Modal saves:** wrapped in `guard()` from `js/main.js`
- **Button contract:** `data-action` routed via `delegation.js` + `data-todo-id` for queryability

## Security
- **XSS:** see CODEMAP for current esc_count — all user fields `text`, `note`, `url` → `esc()` when interpolating
- `renderMd()` already escapes internally — don't double-wrap
- `showDeleteConfirm` uses `.textContent` (safe)
- **URLs:** safe allowlist check, not raw `innerHTML`. No `javascript:`

## i18n
- **Prefix:** `todos.` — see CODEMAP for current key count (EN/FR/ES)
- No hardcoded UI text in JS
- Modals rebuild innerHTML on open (not on page load) so translations reflect the active language

## Business Invariants

### TODOs
- `priority ∈ {urgent, high, medium, low, normal}`
- `sort_order` monotonic per category
- `status=done` preserved on reorder
- `due_date` — optional; outdated filter shows TODOs past due
- New TODOs inserted at top of category (min `sort_order - 1`)
- Delete → trash, not hard delete from UI (adapter handles)

### Snooze
- `snooze_until` — filters TODO out of pending view until date passes
- Preset options: 1h, 3h, 1d, 3d, 1w, 1m + custom datetime picker
- Snoozed items show moon icon with date; unsnooze button (moon-off icon) clears `snooze_until`
- Changing snooze date requires unsnoozing first, then re-snoozing

### Quick-Add
- Priority can be set during quick-add via `openQuickAddPriorityPicker` / `setQuickAddPriority`
- Priority button updates dynamically (`updateQuickAddPriorityBtn`)

### Category CRUD
- `openAddCategoryModal` / `saveNewCategory` — create with name, shortname, color
- `openEditCategoryModal` / `saveEditCategory` — edit name, shortname, color
- `deleteCategory` — deletes category (CASCADE deletes all its TODOs; sharing cleanup runs first)
- **Explicit item deletion before category delete**: items are deleted individually before the category row so that calendar dirty tracking (`markDirty`) fires for each item. Drive/Demo have no FK enforcement, so CASCADE alone would not trigger per-item sync
- Protected default row (`name=''`, `is_protected=1`) cannot be deleted
- `sort_order` on categories persisted and reorderable via nav button drag

### Sharing Operations
- `shareTodoFromAdd` — share a TODO at creation time
- `shareExistingTodo` — share an already-existing TODO to a group
- `bulkShareTodoCategory` — share all TODOs in a category at once
- `unshareTodo` — remove a TODO from sharing
- `copyTodoToPersonal` — copy a shared TODO into personal collection
- `syncSharedTodos()` merges shared items by `todo_id`

## Adapter & Backend
- Only via `db.from('todos')`, `db.from('todo_categories')` — never `if (backend === 'supabase')`
- Offline-cache wraps transparently

## Cross-Feature Edges
- `welcome.js` → `renderWelcome()` reads focus TODOs (urgent/high + due today)
- Any change to filter/sort/priority → verify Welcome still shows expected set
- Sharing: uses `sharing-ui` + `sharing_items` type=todo
- **Calendar sync**: category rename/shortname change calls `markCategoryRenamed('todo_categories')` → full calendar resync of all TODO events in that type

## Risks / Gotchas
- Double toggle creates done/undone race → must use `_pendingTodoToggles`
- Double share/unshare → must use `_pendingShare`
- Drag-drop reorder must not reset done state
- Cross-category drag updates `category_id` FK — must re-number `sort_order` in target
- Search clear button must stay CSS-only (avoid JS flicker)
- Category cascade: deleting a category deletes all its TODOs — sharing cleanup runs before CASCADE

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: drag TODO between categories, verify FK updated
- Manual: snooze → verify hidden from pending, unsnooze → verify reappears
- Manual: quick-add with priority, verify priority persists

## References
- `CODEMAP.json:features[todos]`
- Entry: `js/todos.js`, adapter: `js/adapters/`, icons: `js/icons.js`
