# Lists — Feature Contract

## Purpose
Generic user-created lists for anything that doesn't fit todos/habits. Bucket-card layout with checkboxes, customizable colors, cross-list drag, inline editing, sharing, and search.

User jobs:
- create lists with name, shortname, color
- add items with checkbox, optional note
- drag items between lists
- reorder lists via nav button drag
- inline edit items
- search across list names and items
- share lists and items

## Entry & Ownership
- **Entry:** `js/lists.js`
- **State:** see `CODEMAP.json:features[lists]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `lists`, `list_items`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `sharing-ui`, `state`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.bucket-card`, `.project-card`, `.card-header`, `.category-nav-btn`, empty-state, toast
- **List colors:** customizable via color picker in add/edit modal; default `#14b8a6` (teal). Stable fallback for legacy lists: hash-based color from id
- **Checkboxes:** per `list_item`, inline edit with note field via `inlineEditText` / `editListItemInlineFull`
- **List nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted
- **Cross-list drag:** `initItemDragDrop` with `crossContainerSelector` — items can be dragged between lists, updates FK and re-numbers `sort_order` in source/target; shared items keep sharing data
- **Sort order:** no sort selector — lists ordered manually via drag only. Items within a list: unchecked first by `sort_order`, checked at bottom
- **Search:** `filterLists` / `listSearchQuery` — filters across list names and item names
- **`__shared__` list:** auto-created on first shared item sync, hidden when empty, purple color (`#a78bfa`)

## Interaction Guards
- **Pending sets:**
  - `_pendingListItemToggles = Set<itemId>` — block same-item double checkbox toggle, allow concurrent different items
  - `_pendingShare = Set<guardKey>` — block duplicate share/unshare actions
- **Modal saves:** `guard()` for `saveNewList`, `saveEditList`
- **Quick add:** `quickAddListItem` guarded

## Security
- **XSS:** see CODEMAP for current esc_count — `list name`, `item name`, `shortname`, `note` via `esc()`
- No raw innerHTML with user data

## i18n
- **Prefix:** CODEMAP reports `toast.` (legacy); actual keys use `lists.*` via `t()` — see CODEMAP for current key count
- EN/FR/ES keys for empty state, add, edit, sharing

## Business Invariants
- Lists are generic buckets; items have checkbox state (`checked`), optional `note`
- Lists have `name`, `shortname` (displayed in nav button), `color`, `icon`, `sort_order`
- `sort_order` monotonic per list (for list ordering) and per item (within-list ordering)
- Duplicate list names allowed (no unique constraint)
- Inline edit: save on Enter/confirm, cancel on blur (standard DeLaClaw inline edit UX)

## Adapter & Backend
- `db.from('lists')`, `db.from('list_items')`
- Offline-cache wraps

## Sharing
- Supabase `sharing_items` type=`list_item`
- `shareListItemFromAdd` — share from add modal
- `shareExistingListItem` — share an existing item
- `bulkShareList` — share all items in a list at once
- `unshareListItem` — remove sharing from an item
- `copyListItemToPersonal` — copy a shared item to personal list
- Share buttons shown whenever sharing is enabled/initialized, even if no group exists yet
- Shared items preserve sharing data when dragged between lists

## Cross-Feature Edges
- No Welcome aggregation

## Risks / Gotchas
- Checkbox toggle race → use `_pendingListItemToggles` pendingSet
- Cross-list drag updates FK — must re-number `sort_order` in both source and target lists
- `__shared__` list hidden when empty — rendering must filter it out

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: drag item between lists, verify FK updated and sort_order correct
- Manual: reorder list nav buttons, reload, verify order persists
- Manual: toggle checkbox, verify no double-toggle on rapid clicks
- Manual: search filters both list names and item names

## References
- `CODEMAP.json:features[lists]`
- Entry: `js/lists.js`
