# habits Contract
Purpose: recurring habits with completions, frequency_rule free-text + structured.
Entry: `js/habits.js` (2112 LOC) / State: `allHabits,allHabitCompletions,_historyHabitId,currentView,db,js,sharing`
Tables: `habits,habit_completions,settings`; Depends: `i18n,icons,item-utils,sharing-ui,state,todos,utils`
Dependents: `main.js,welcome.js` → welcome shows due-today; blast via `state.allHabits`
UI: `.page-empty-state,.modal,.btn,.project-card,.empty-state,.toast`; view-tab + bucket layout
Guards: `pendingSet _pendingHabitDones` for DONE; allow concurrent different IDs, block same ID double-click
XSS: `esc_count=47`; wrap `name,frequency_rule,note` in `esc()`; `renderMd` already esc internally
i18n: `habits.` 68 keys; frequency_rule parsed client-side via `isStructuredRule()`, heartbeat computes `next_due` only when `isStructuredRule()==false`
Invariants: `isStructuredRule()` in `js/habits.js` is single source (STRUCTURED_PREFIXES); `computeNextDue()` deterministic client-side; heartbeat MUST skip when true; `updateHabitNextDue()` sets null for custom to signal heartbeat
Sharing: `habits` + `habit_completions` shareable via Supabase; `syncSharedHabits()` merges completions by habit_id
Adapter: `db.from('habits')/.from('habit_completions')`; offline-cache stores completions; avatar not cached
Welcome edge: due habits rendered in welcome; `frequency_rule` change → check welcome aggregation + heartbeat `next_due`
Risks: double DONE creates duplicate completion; must disable until fulfilled; URL-safe check for links
Ref: `CODEMAP.json:features[habits]` — check `dependents` before editing `todos.js` (habits depends on todos)
