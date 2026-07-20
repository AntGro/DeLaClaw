# Lists — Feature Contract

## Purpose
Generic user-created lists for anything that doesn't fit todos/habits (travel destinations, movies, expenses). Bucket-card layout, checkboxes per item.

## Entry & Ownership
- **Entry:** `js/lists.js` (880 LOC)
- **State:** `allLists`, `allListItems`, `currentView`, `db`, `js`, `sharing`
- **Tables:** `lists`, `list_items`, `settings`
- **CODEMAP:** `features[lists]` — loc 880, esc 18, i18n 26, i18n_prefix `toast.` (legacy), guards []

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `sharing-ui`, `state`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.bucket-card` (teal `#14b8a6` tab), `.project-card`, `.card-header`
- **Checkboxes:** per `list_item`, inline edit with note field via `item-utils.js`
- **Drag-drop:** list order + item order via `item-utils`

## Interaction Guards
- **Modal saves:** `guard()` for `saveNewList`, `saveEditList`, `quickAddListItem`
- List items toggle: single action, disable until fulfilled via item-utils pattern

## Security
- **XSS esc_count=18:** `list name`, `item name`, `note` via `esc()`
- No raw innerHTML; URLs not used

## i18n
- **Prefix:** currently `toast.` in CODEMAP (26 keys) — actually uses `lists.` keys via `t()`; CODEMAP i18n_prefix lagging
- EN/FR/ES keys for empty state, add, edit

## Business Invariants
- Lists are generic buckets; items have checkbox state, optional note
- `sort_order` monotonic per list and per item
- Category shortnames DB-synced via `settings`

## Adapter & Backend
- Only `db.from('lists')`, `db.from('list_items')`
- Sharing via `sharing_items` type=lists, `syncSharedLists` pattern similar to todos/habits

## Sharing
- Supabase `sharing_items` type=lists; Drive sharing via `sharing-ui.js`

## Cross-Feature Edges
- No Welcome aggregation

## Risks / Gotchas
- Duplicate list names allowed (no unique constraint)
- Item toggle race — ensure disable until fulfilled

## Test Hooks
- `bun tests/tests.js`: esc usage, modal existence, CODEMAP freshness

## References
- `CODEMAP.json:features[lists]`
- Entry: `js/lists.js`

