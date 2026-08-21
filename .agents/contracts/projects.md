# Projects — Feature Contract

## Purpose
Kanban-style project boards with task workflow, draft tasks, cross-project drag, expand/collapse, prompt editor, archiving, and search.

User jobs:
- create project with name, shortname, color
- add tasks with draft toggle, drag-drop reorder, approve/promote through workflow
- drag tasks between projects
- expand project card or individual task for focused view
- reorder project nav buttons
- archive/unarchive projects, toggle archived tasks, bulk-delete archived
- edit global and per-project prompts (BYA agent instructions)
- search across project names, task titles, and agent responses

## Entry & Ownership
- **Entry:** `js/projects.js`
- **State:** see `CODEMAP.json:features[projects]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `projects`, `tasks`, `prompts`, `settings` (settings used for persisting archived project IDs)

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `state`, `utils`
- **Dependents (blast radius):** `main.js` → grid balancing, view switcher

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.card-header`, `.bucket-card`, `.category-nav-btn`, `.view-tab`, toast
- **Grid:** `balanceGrid()` called inside `buildProjectCards()` — must be called on sort, not only dropdown, else 6-col vs 5-col at wide widths (regression May 26)
- **Empty state:** shared `.page-empty-state` with CTA to create project
- **Project nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted
- **Cross-project drag:** `initItemDragDrop` with `crossContainerSelector: '.task-list[data-project]'` — tasks can be dragged between projects, updates project FK and re-numbers `sort_order`
- **Expand/collapse:** `toggleExpandProject` expands a project card for focused view; `expandTask` shows a single task's full metadata in a modal
- **Search:** `filterProjects` / `projectSearchQuery` — filters across project names, task titles, `hatch_response` content
- **Archive toggle:** archived projects hidden by default, `toggleShowArchived` shows/hides; archived tasks within a project toggled via `toggleArchivedTasks`

## Interaction Guards
- **Pending set:** `_pendingTaskStatus = Set<taskId>` for approve/promote
  - concurrent different tasks allowed, same ID blocked
  - `onclick="updateTaskStatus(id,'approved',this)"` + `data-task-id`
- **Modal saves:** `guard()` for `saveNewProject`, `saveEditProject`, `addTask`, `submitRevision`
- **Delete:** `executeDeleteConfirm` guarded

## Security
- **XSS:** see CODEMAP for current esc_count — wrap `project.name`, `task.title`, `note`, `hatch_response`, `plan_note` in `esc()` or via `truncateWithShowMore` (which escapes internally)
- `renderMd()` for project description escapes internally
- URLs via safe allowlist if present, not raw innerHTML
- `showDeleteConfirm` uses `.textContent`

## i18n
- **Prefix:** `projects.` — see CODEMAP for current key count (EN/FR/ES)
- Task status labels via `t()` — no hardcoded workflow strings

## Business Invariants

### Task Workflow
- Statuses: `draft`, `todo`, `in-progress`, `review`, `revision`, `approved`
- `draft` → created via draft slider toggle, sorted after non-draft tasks within a project
- `todo → in-progress → review → approved` is the standard BYA agent workflow
- `revision` → feedback loop: task sent back with user context for rework
- `approved` = done — heartbeat must never touch approved tasks

### Task Metadata
- `plan_note` — agent's plan before starting work
- `hatch_response` — agent's response after completing work
- Both rendered with `truncateWithShowMore` in task cards, full view in expand modal

### Projects
- Projects have `name`, `shortname` (displayed in nav button), `color`, `sort_order`
- `sort_order` monotonic, preserved on archive
- Archive = soft flag via `settings` table (key stores archived project ID list), not delete
- `balanceGrid()` must run after `renderProjectGrid` — ensures balanced column layout

### Prompts
- Global prompt: shared instructions for all projects (stored in `prompts` table, key=`global`)
- Per-project prompt: project-specific agent instructions (stored in `prompts` table, key=project name)
- Prompt editor with char counter (`updateCharCounter`)

## Adapter & Backend
- `db.from('projects')`, `db.from('tasks')`, `db.from('prompts')`, `db.from('settings')`
- Offline-cache wraps; prompts table global + per-project

## Sharing
- Not sharing-enabled currently (projects private)

## Cross-Feature Edges
- Welcome does NOT aggregate projects (only todos/habits/flashcards/birthdays)
- Changing project colors → check bucket-card color (solid header `--cat-color` + 6% tinted body via color-mix)

## Risks / Gotchas
- Double approve creates duplicate status transition → must use `_pendingTaskStatus`
- Grid imbalance: `balanceGrid()` must be inside `buildProjectCards()`, not only sort dropdown
- Static modal shells conflicted with JS-created modals historically → root cause duplicate modal IDs (fixed May 22)
- Cross-project drag updates project FK — must re-number `sort_order` in target project

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness, modal existence
- Manual: drag task between projects, verify project FK updated
- Manual: create draft task, verify it sorts after non-draft tasks
- Manual: expand project card, verify full task metadata visible
- Manual: reorder project nav buttons, reload, verify order persists
- Manual: archive toggle preserves order

## References
- `CODEMAP.json:features[projects]`
- Entry: `js/projects.js`, Grid: `balanceGrid()`, Workflow: task status enum
