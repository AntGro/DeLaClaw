# CSP Phase 2 Mapping — inline handlers → data-action delegation

**Branch:** dev — **Version:** 1.361 → 1.362 (Phase2)
**Goal:** Remove all `onclick=`, `onchange=`, `oninput=`, `onkeydown=` inline handlers from `js/*.js` and unify under 4 listeners in `js/delegation.js` (click/change/input/keydown).

## Summary
- **Before Phase2:** 272 inline handlers in `js/*.js` (18 in todos.js, etc.) + 109 in index.html already removed in Phase1
- **After Phase2:** 0 inline handlers in `js/` (verified via `grep -R "onclick=" js/ → 0`)
- **delegation.js:** 449 lines, exactly 4 `document.addEventListener` calls
- **data-action unique count:** 218 in js/ + ~40 from Phase1 = ~258 total

## Conversion Rules (applied by subagents)

| Pattern | Old | New |
|---------|-----|-----|
| Simple id | `onclick="deleteTodo('${escQ(id)}')"` | `data-action="delete-todo" data-id="${esc(id)}"` |
| Bool flag | `toggleTodo('${escQ(id)}', true, this)` | `data-action="toggle-todo" data-id="..." data-done="true"` (el passed via delegation) |
| Guarded (pending Set) | `markHabitDone('${escQ(id)}', this)` | `data-action="mark-habit-done" data-habit-id="..."` + `markHabitDone(id, el)` preserves `_pendingHabitDones` |
| Stop propagation | `deleteAllDoneTodos(cat); event.stopPropagation()` | `case 'delete-all-done': e.stopPropagation(); callWindow('deleteAllDoneTodos',[cat])` |
| Priority picker | `openPriorityPicker('${escQ(id)}', event)` | `data-action="open-priority-picker" data-id="..."` → `openPriorityPicker(id, e)` |
| Amount/unit | `snoozeFor(1,'h')` | `data-action="snooze-for" data-amount="1" data-unit="h"` |
| Category nav | `navigateToCategory('${escQ(cat)}')` | `data-action="navigate-to-category" data-category="${esc(cat)}"` |
| Welcome quick-add input ref | `addTodoFromAddRow(this)` with `closest().querySelector` | `data-action="add-todo-from-add-row"` → `closest('.todo-cat-add')?.querySelector('.todo-cat-input')` in delegation |
| Welcome category sync | `<select onchange="nextSibling.dataset.category=this.value">` | `data-action="update-next-sibling-category"` handled in `change` listener: `next.dataset.category = el.value` |
| Enter handlers | `onkeydown="if(e.key==='Enter') saveNewHabit()"` | `data-action="save-new-habit-on-enter"` handled in `keydown` listener (Enter without Shift) |
| Select all | `onclick="this.select()"` | `data-action="select-all-on-click"` → `el.select()` |

## Escaping
- Use `esc()` (HTML escape) not `escQ()` (quote escape) for `data-*` attributes — safe via `esc()`, as attributes are HTML-escaped.
- No `innerHTML` with unescaped user data.

## Full Action List (218)

### Todos (17)
- `show-todo-general-card`
- `navigate-to-category`, `delete-category`, `delete-all-done`, `toggle-done-todos`, `open-edit-category-modal`
- `open-quick-add-priority-picker`, `add-todo-from-add-row`, `share-todo-from-add`
- `open-priority-picker`, `toggle-todo` (with data-done + el guard `_pendingTodoToggles`), `open-snooze-modal`, `edit-todo-inline`, `delete-todo`
- `set-todo-priority`, `set-quick-add-priority`, `snooze-for`, `close-snooze-modal`, `submit-snooze`, `save-new-category`, `close-add-category-modal`
- `save-new-category-on-enter`, `add-todo-to-category` (Enter)

### Habits
- `open-add-habit-modal`, `navigate-to-habit-category`, `delete-habit-category`, `open-edit-habit-category-modal`
- `add-habit-from-input` (Enter), `promote-habit`, `mark-habit-done` (guard `_pendingHabitDones`), `open-habit-history`, `open-edit-habit-modal`, `delete-habit`, `edit-habit-last-done`, `edit-habit-inline`
- `close-add-habit-modal`, `save-new-habit`, `close-edit-habit-modal`, `save-edit-habit`, `close-habit-history-modal`, etc.
- `save-new-habit-on-enter`, `save-new-habit-category-on-enter`, `save-edit-habit-category-on-enter`, etc.

### Flashcards
- `navigate-to-flash-deck`, `handle-draft-input` (Enter → quickAddDraft), `quick-add-draft`, `update-proposed-deck` (change), `accept-proposal`, `edit-proposal`, `toggle-feedback-input`, `reject-proposal`, `submit-feedback`, `request-proposal`, `start-inline-edit-draft`, `delete-draft`, `prompt-flash-shortname`, `open-add-flashcard`, `delete-deck`, `start-text-practice`, `open-add-text`, `open-edit-flashcard`, `delete-flashcard`, `close-add-draft`, `save-new-draft`, `close-edit-proposal`, `save-edited-proposal`, etc., `rate-card` (data-rating), `handle-line-click` (data-line-idx)

### Welcome (16)
- `welcome-set-priority` (stopPropagation), `welcome-open-priority-picker` (el,e), `welcome-toggle-todo` (data-done bool), `welcome-snooze`, `welcome-delete-todo`, `welcome-mark-habit-done` (el), `welcome-open-habit-history`, `welcome-delete-habit`, `scroll-to-welcome-bucket`, `welcome-add-todo-from-quick` (closest input), `welcome-add-habit-from-quick`, `go-to-practice`, `go-to-revise`, `update-next-sibling-category`, `welcome-quick-add-todo-on-enter`, `welcome-quick-add-habit-on-enter`, `open-quick-add-priority-picker`

### Projects
- `open-add-project`, `archive-project`, `unarchive-project`, `delete-project`, `copy-project-title`, `navigate-to-project`, `toggle-expand-project`, `open-edit-project`, `close-task-expand`, `open-project-prompt`, `add-task` (data-id), `update-task-status` (data-status + el guard `_pendingTaskStatus`), `open-revision-modal`, `prompt-edit-task`, `delete-task`, `toggle-archived-tasks`, `delete-all-archived-tasks`, `task-input` (Enter + auto-resize), `approve-task-and-close`, `close-and-open-revision`

### Birthdays
- `open-add-birthday`, `navigate-to-birthday-section` (data-key), `handle-avatar-click`, `open-edit-birthday`, `delete-birthday`, `pick-new-birthday-avatar` (addEventListener change), `clear-new-birthday-avatar`, `close-add-birthday`, `save-new-birthday`, `close-edit-birthday`, `save-edit-birthday`, `remove-avatar`, `pick-avatar-file`, `close-avatar-preview`

### Lists
- `open-add-list`, `navigate-to-list`, `open-edit-list`, `delete-list`, `quick-add-list-item` / `quick-add-input` (Enter), `toggle-list-item-check`, `edit-list-item-inline`, `delete-list-item`, `share-list-item-from-add`

### Vestiaire
- `open-add-vestiaire`, `navigate-to-vestiaire-cat`, `open-add-vestiaire-category`, `open-edit-vestiaire`, `delete-vestiaire`, `edit-vestiaire-inline`, `edit-vestiaire-brand-inline`, `cycle-vestiaire-status`, etc., `save-new-vestiaire-on-enter` etc.

### Sharing
- `send-auth-from-sharing`, `sign-out-from-sharing`, `sharing-copy-link`, `sharing-leave-group` / `sharing-unjoin-group` (static ternary, no dynamic data-action), `sharing-copy-member-link` (data-token), `sharing-remove-member` (data-email), `sharing-invite` (Enter via `sharing-invite-on-enter`), `sharing-delete-group`, `sharing-create-group`, `sharing-create-group-submit` (Enter), `sharing-copy-link-value`, `sharing-open-join-picker` (folder-id), `submit-share-popover`, `sharing-complete-submit`, `select-all-on-click`

### Other
- `expand-meta`, `collapse-meta`, `close-modal` (data-modal-id), `show-migration-modal`, `dismiss-schema-banner`, `check-migration-status`, `close-migration-modal`, `close-compare-modal`, `export-backup`, `export-to-drive`, `import-backup` (addEventListener change)

## Guard Sets preserved
- `_pendingTodoToggles` (726) in `toggleTodo(id, done, btnEl)`
- `_pendingHabitDones` (1319) in `markHabitDone(id, btnEl)` + `welcomeMarkHabitDone`
- `_pendingTaskStatus` (449) in `updateTaskStatus(id, status, btnEl)`

## Allowed non-delegation listeners (must stay)
- `projects.js:535` overlay click to close modal
- `projects.js:935` textarea auto-resize on input (id startsWith input-)
- `projects.js` pointerdown/move/up for drag (pre-existing)
- `projects.js:805` revision textarea Enter submit (converted from `onkeydown=` assignment)
- `birthdays.js:340/618` avatar file pickers converted to `addEventListener('change')`
- `main.js:3652` importBackup file input converted to `addEventListener('change')`

## Testing
- `bun tests/tests.js` → 142 passed, 3 Playwright missing (expected without browser install)
- Fixed duplicate `call` function definitions in delegation.js → single `callWindow`
- Updated tests for delegated actions: `edit-habit-inline` and `sign-out-from-sharing`

## Commit
```
fix(csp): remove inline handlers from js/*.js — delegation phase 2
Checked: versioning [x], i18n [~], docs [~], readme [~], checklist [~], tests [x], welcome [~], prompts [~], xss [x]
```
