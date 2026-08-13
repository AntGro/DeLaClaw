# Projects — Feature Contract

## Purpose
Kanban-style project boards with task workflow (todo → in-progress → review → approved), prompts, archiving, and global prompts.

User jobs:
- create project with category color
- add tasks, drag-drop reorder, approve/promote through workflow
- archive project, toggle archived tasks
- view per-project prompts

## Entry & Ownership
- **Entry:** `js/projects.js` (981 LOC)
- **State:** `PROJECTS`, `allTasks`, `archivedProjectIds`, `db`, `js`, `showArchived`
- **Tables:** `projects`, `tasks`, `prompts`, `settings`
- **CODEMAP:** `features[projects]` — loc 981, esc 35, i18n 35, guards [pendingSet]

## Dependencies
- **Depends on:** `i18n`, `icons` (data-icon), `item-utils` (drag-drop + inline edit), `state`, `utils`
- **Dependents (blast radius):** `main.js` → grid balancing, view switcher

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.card-header`, `.bucket-card`, `.view-tab`
- **Grid:** `balanceGrid()` called inside `buildProjectCards()` — must be called on sort, not only dropdown, else 6-col vs 5-col at wide widths (regression May 26)
- **Empty state:** shared `.page-empty-state` with CTA to create project
- **Archive toggle:** archived tasks hidden by default, toggle via view tab

## Interaction Guards
- **Pending set:** `window._pendingTaskStatus = Set<taskId>` for approve/promote
  - concurrent different tasks allowed, same ID blocked
  - `onclick="updateTaskStatus(id,'approved',this)"` + `data-task-id`
- **Modal saves:** `guard()` for `saveNewProject`, `saveEditProject`, `addTask`, `submitRevision`
- **Delete:** `executeDeleteConfirm` guarded

## Security
- **XSS esc_count=35:** wrap `project.name`, `task.title`, `note`, `brand` in `esc()` when templating
- `renderMd()` for project description esc internally
- URLs via safe allowlist if present, not raw innerHTML
- `showDeleteConfirm` uses `.textContent`

## i18n
- **Prefix:** `projects.` — 35 keys EN/FR/ES
- Task status labels via `t()` — no hardcoded workflow strings

## Business Invariants
- Task workflow: `todo → in-progress → review → approved` (BYA design for AI agents)
- `sort_order` monotonic per project, preserved on archive
- Archive = soft flag, not delete; `toggleArchivedTasks` shows/hides
- Project categories: shortnames DB-synced via `settings` keys `project_category_shortnames`
- `balanceGrid()` must run after `renderProjectGrid` — ensures 5-col max at wide view

## Adapter & Backend
- Only via `db.from('projects')`, `db.from('tasks')`, `db.from('prompts')`
- Offline-cache wraps; prompts table global + per-project

## Sharing
- Not sharing-enabled currently (projects private); tasks share via project ownership

## Cross-Feature Edges
- Welcome does NOT aggregate projects (only todos/habits/flashcards/birthdays)
- Changing project categories → check bucket-card color (solid header `--cat-color` + 6% tinted body via color-mix)

## Risks / Gotchas
- Double approve creates duplicate status transition → must use `_pendingTaskStatus`
- Grid imbalance: `balanceGrid()` must be inside `buildProjectCards()`, not only sort dropdown
- Static modal shells conflicted with JS-created modals historically → root cause duplicate modal IDs (fixed May 22)

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness, modal existence
- Manual: drag task across statuses, verify no duplicate, archive toggle preserves order

## References
- `CODEMAP.json:features[projects]`
- Entry: `js/projects.js`, Grid: `balanceGrid()`, Workflow: tasks status enum

