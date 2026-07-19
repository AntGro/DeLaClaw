# todos Contract
Purpose: quick standalone tasks, priority + due, drag-drop + inline edit.
Entry: `js/todos.js` (1395 LOC) / State: `currentView,db,js,sharing` / Tables: `todos,settings`
Depends: `i18n,icons,item-utils,sharing-ui,state,utils` (icons via data-icon)
Dependents blast: `habits.js,main.js,welcome.js` → welcome aggregates focus todos
UI: `.page-empty-state,.modal,.btn,.project-card,.empty-state,.toast`; search clear via :not(:placeholder-shown)
Guards: `pendingSet _pendingTodoToggles` + pass `this` + `data-todo-id`; modal saves via `guard()`
XSS: `esc_count=24`; all `name,note,url` via `esc()`; URLs via safe allowlist, not raw innerHTML
i18n: prefix `todos.` (48 keys) + shared via `t()` EN/FR/ES; no hardcoded UI strings
Invariants: `priority∈{urgent,high,medium,low,normal}`, `sort_order` monotonic, `status=done` preserved
Sharing: uses `js/sharing-ui.js`; Supabase `sharing_items` type=todos; leaving group removes shared view
Adapter: only via `db.from('todos')`; no backend if; offline-cache wraps transparently
Welcome edge: `welcome.js` reads todos; any change → verify `renderWelcome()/refreshWelcome()`
Test hook: `bun tests/tests.js` must keep esc usage + pendingSet check; CODEMAP freshness enforced
Ref: `CODEMAP.json:features[todos]` — see dependents for impact before edit.
