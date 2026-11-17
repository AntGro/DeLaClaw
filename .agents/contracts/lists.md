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
- attach files to list items (Drive only, several per item)

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
  - `_pendingAttachmentUploads = Set<itemId>` — block a second upload to the same item while one runs, allow concurrent different items
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
- **Attachments (v2.32.122, resumable upload v2.32.123, progress v2.32.124):** a list item carries zero or more attachments as `{drive_file_id, name, size, url}`. Canonical storage is a JSON string in the `list_items.attachments` TEXT column (migration 2.32.122); in-memory `item.attachments` is always the parsed, validated array (`normalizeAttachments` — string/array/missing all accepted, invalid entries dropped). The file lives in the uploader's Drive under `<app folder>/attachments/`; only the link is stored on the item, never fetched on page load. The transfer runs over XHR, not fetch — fetch cannot report upload progress (`xhrRequest` wraps one call; session initiation stays on fetch). Uploads up to 5 MB go multipart; larger files go through the resumable endpoint in 1 MB chunks (`ATTACHMENT_CHUNK_BYTES`, Content-Range per chunk; 308 advances, 200/201 completes). A failed chunk is retried twice, then the session is asked how far it got (`queryResumableOffset`) and the upload resumes from there. There is no user-facing size cap. Picked files appear immediately as pending chips with a circular progress ring (SVG, `stroke-dashoffset` patched in place by `updateAttachmentProgress` — never a full re-render per tick), no link yet; × cancels (aborts the XHR, silent), a failed upload leaves an error chip with retry. Pending state is memory-only (`_pendingAttachments`, itemId → pendingId → entry with file/progress/status/AbortController) — a reload drops it and the upload dies with the page. The upload and its state live outside the view, so navigating away mid-upload changes nothing. One file at a time per item (sequential queue, `processAttachmentQueue`); each finished file is saved onto the item at once (freshly-read list, so a removal mid-upload is not resurrected) and its chip turns real without waiting for its siblings. The attach button stays enabled while uploading; the per-item guard is gone. Filename dedupe counts in-flight names too. The attach button is Drive-only (hidden when no Drive adapter). Duplicate filenames in the folder are deduped as `name (1).ext`. Removing an attachment (or deleting its item) trashes the Drive file best-effort — the link is gone either way.
- **Attachments on shared items:** the payload carries the array (`payload.attachments`, real array, not a string) — the local pointer row's column is never the source of truth for shared items; the load enrichment copies `sh.payload.attachments` into `item.attachments`, and writes go through `state.sharing.updateItem` with a payload spread (same as text/note edits). Before the payload update, the uploaded file is shared with every other joined member as reader via `state.sharing.shareFileWithGroup` — a share failure aborts the attach (the file stays in the uploader's Drive folder, unlinked). A member who joins later still sees the attachment (name, size, Drive link — the payload syncs through the join, `lists.json` is one of the downloaded group files) but has no access to the file itself until someone grants it; clicking the link lands on Drive's request-access page, so they can ask from there. Known gaps: join-backfill (auto-granting access to files attached before a member joined) and revoke on unshare are still open.
- Wardrobe removal (v2.9.17): former wardrobe categories became lists named `<name>` inside a `Wardrobe` section (id `vest_wardrobe`); items in the protected default or an unknown category went to a `*` list inside the section (`vest_wardrobe_star`); item notes carry a `Brand / Make:` / `Size:` / `Color:` / `Status:` field block with only non-empty lines, then pre-existing notes after a blank line. Migrated ids are prefixed `vest_`. On the local backend the section kind/parent links are applied by 2.23.0, which adds those columns

## Adapter & Backend
- `db.from('lists')`, `db.from('list_items')`
- Offline-cache wraps

## Sharing
- Drive adapter shared items, type=`list_item`
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

## Nested Sections (v2.23.0)

- The `lists` table itself holds both kinds: buckets (`kind='bucket'`, hold `list_items`) and sections (`kind='section'`, hold lists/sub-sections, never items). `parent_id` is a plain column, never a foreign key.
- Same shared mechanism as TODOs/Habits: tree logic only in `js/sections-pure.js`, names unique per parent, per-group `sort_order`, path typing in add/edit creates or converts (items move to a `*` list on conversion).
- The `__shared__` list is identified by name, is always a root bucket, and never enters a section; copy-to-personal fallbacks must skip section rows.
- Section delete: move children up (at the section's position) or delete the subtree (items deleted per bucket first, sharing cleanup per bucket, as list delete).
