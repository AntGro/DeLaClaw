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
- **List colors:** customizable, default teal. Stable fallback for legacy lists: hash-based color from id
- **Checkboxes:** per `list_item`, inline edit with note field via `inlineEditText` / `editListItemInlineFull`
- **List nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted
- **Cross-list drag:** `initItemDragDrop` with `crossContainerSelector` — items can be dragged between lists, updates FK and re-numbers `sort_order` in source/target; shared items keep sharing data
- **Sort order:** no sort selector — lists ordered manually via drag only. Items within a list: unchecked first by `sort_order`, checked at bottom
- **Smooth rank change (v2.32.184):** ticking an item FLIP-animates the rows to their new ranks (`snapshotRows` / `animateRowsFromSnapshot` in item-utils.js, 250ms) — the render rebuilds the rows, so a CSS transition alone cannot move them. Only rows whose old and new spots are both on screen animate; a row whose new rank is below the fold just appears there. This supersedes the inner-shift scroll compensation considered in Nov 2026 (lowering the inner scrollTop by the ticked row's height was never built).
- **Scroll anchoring (v2.32.176):** `#listsGrid{overflow-anchor:none}` in style.css — `renderLists()` replaces the whole grid and restores `window.scrollY` itself; Chrome's scroll anchoring would re-adjust the scroll after the restore, because the anchor row was destroyed by the re-render (ticking an item jumped the window). The same innerHTML+scrollTo pattern exists on every view (todos, habits, calendar, flashcards, welcome, main) — only the lists grid is opted out for now.
- **Long-link wrapping (v2.32.182, wrapper correction v2.32.183):** the text column wrapper `.list-item-content` carries `flex:1; min-width:0; overflow-wrap:anywhere` — a bare URL (renderMd turns it into one `<a>` token) breaks inside the text column instead of overflowing the card. The text span and the note inherit the break rules. (The first fix put the rules on the inline `.list-item-text` span; the review of aac524f showed the flex sizing there was dead — the wrapper div is the real flex item.)
- **Scroll-edge shadows (v2.32.185):** a scrollable list shows an inset shadow at the top edge while there is more content above, and at the bottom edge while there is more below (`.scrollable--more-above` / `.scrollable--more-below`, box-shadow fades over 0.2s). Covers the six `SCROLLABLE_LIST_SELECTOR` containers plus `.welcome-calendar-strip`. One delegated capture-phase scroll listener in item-utils.js (`initScrollEdgeShadows`, installed at boot) updates the classes on scroll; `restoreInnerScrollPositions` re-applies them after every re-render, since rebuilt elements lose the classes. Light theme has its own lighter shadow values.
- **Search:** `filterLists` / `listSearchQuery` — filters across list names and item names
- **`__shared__` list:** auto-created on first shared item sync, hidden when empty, purple color
- **Touch row actions (v2.32.146):** on touch-first devices (`html.touch`, set at boot from `isTouchDevice()`), a row shows Attach + Edit plus a kebab menu holding share/copy-link/delete (see todos.md for the shared mechanism in `item-utils.js`). The attach button only renders in Drive mode, so demo shows Edit alone. Desktop unchanged.
- **Row-action columns (v2.32.189):** the item actions lay out 3-across like TODOs/Habits — the old `cols-2` class (2 columns whenever a share button was present) is gone, so 5 buttons form 2 rows of 3.

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
- **Attachments (v2.32.122, resumable upload v2.32.123, progress v2.32.124, per-item folders v2.32.125, uploaded_by v2.32.126, compulsory v2.32.127, reference check v2.32.138, uploader tooltip v2.32.139):** a list item carries zero or more attachments as `{drive_file_id, name, size, url, uploaded_by}`. `uploaded_by` is compulsory — `normalizeAttachments` drops any record without a non-empty string uploader. It is the group member id (a hash, never an email) of the member who uploaded the file. The member id is purely a hash of the email, so it is the same on shared and personal items: shared items read it from the group row via `state.sharing.getCurrentMemberId(groupId)` (the group is the authority for group identity — see the habit-completion authorship guard), personal items via the new group-independent `state.sharing.getCurrentUserMemberId()` (interface key; Drive impl hashes the account email from `ensureUser`; demo stub returns `'demo'`; cached adapter takes any value from the snapshot's `currentMemberIds`). The queue resolves the id once per drain and threads it through the adapter opts into the record on both upload paths; if it cannot be resolved, the upload is refused before it starts (error chip + `lists.attachment_no_uploader` toast, entries stay retryable) — an unattributed record would be dropped on save and orphan the file in Drive. No attachment has ever been uploaded outside dev, so there are no legacy records without the field to keep reading. Canonical storage is a JSON string in the `list_items.attachments` TEXT column (migration 2.32.122); in-memory `item.attachments` is always the parsed, validated array (`normalizeAttachments` — string/array/missing all accepted, invalid entries dropped). The file lives in the uploader's Drive under `<app folder>/attachments/<folderKey>/`, one subfolder per item — the folder key is the `shared_id` for a shared item (the stable identity across members; a shared item's local id is replaced by a fresh pointer row when it is shared, so the local id would orphan the folder at share time) and the local id otherwise. The attachment record is the source of truth: an item's attachments are whatever its records point at (`drive_file_id`), never the contents of its per-item folder. Files never move when an item's identity changes — sharing, unsharing, keep-copies and copy-to-personal all carry the records as-is; only new uploads go to the folder named after the item's current key. The folder is consulted for two things only: name dedupe at upload time, and the folder trash on delete (which also catches orphans from cancelled uploads). Files uploaded before per-item folders stay in the flat `attachments/` folder; their records still work and their names still count for dedupe. The transfer runs over XHR, not fetch — fetch cannot report upload progress (`xhrRequest` wraps one call; session initiation stays on fetch). Uploads up to 5 MB go multipart; larger files go through the resumable endpoint in 1 MB chunks (`ATTACHMENT_CHUNK_BYTES`, Content-Range per chunk; 308 advances, 200/201 completes). A failed chunk is retried twice, then the session is asked how far it got (`queryResumableOffset`) and the upload resumes from there. There is no user-facing size cap. Picked files appear immediately as pending chips with a circular progress ring (SVG, `stroke-dashoffset` patched in place by `updateAttachmentProgress` — never a full re-render per tick), no link yet; × cancels (aborts the XHR, silent), a failed upload leaves an error chip with retry. Cancelling during the group-share step drops the pending chip too (v2.32.198) — the cancelled branch used to roll back the grants and leave the entry in the pending map, a ghost chip until dismissed or reload. Pending state is memory-only (`_pendingAttachments`, itemId → pendingId → entry with file/progress/status/AbortController) — a reload drops it and the upload dies with the page. The upload and its state live outside the view, so navigating away mid-upload changes nothing. One file at a time per item (sequential queue, `processAttachmentQueue`); each finished file is saved onto the item at once (the item is re-resolved via `getItem` before each save, v2.32.197, so a removal mid-upload is not resurrected and the chip lands on the live object — refreshes replace every object, so the item held from attach/retry may be detached) and its chip turns real without waiting for its siblings. The attach button stays enabled while uploading; the per-item guard is gone. Filename dedupe is scoped to one item — a name used on another item never forces a `(1)` suffix — and names are claimed sequentially (`claimAttachmentName`: the folder listing plus the item's own attachment names plus the names already claimed by uploads still in flight; a claim is released when its upload settles, since a landed file is in the next listing). Duplicate filenames on the same item are deduped as `name (1).ext`. A photo or video taken on the fly arrives with a generated name (a camera capture reports e.g. `att.d_<id>`) — it is renamed to `Photo.jpg` / `Video.mov` from its type before queuing (v2.32.200, `simpleCaptureName`, pure), so the pending chip, the Drive file and the saved record all carry the simple name; any real filename, and a generated name on a non-photo/video file, is left alone. Removing an attachment trashes the Drive file best-effort, but only when it is the remover's; deleting an item trashes only the deleter's own recorded files and their own attachments folder in one call (trashing a folder trashes everything inside it, including orphans from cancelled uploads) — the link is gone either way. Reference check (v2.32.138): a file still referenced by another item is never trashed — `referencedFileIdsFromItems` (pure) collects the drive_file_ids of all items except the excluded ones (local id or shared id), `referencedAttachmentFileIds` adds the shared payloads in groups the client is in, and `trashOwnItemAttachments` (item, list and section delete) and `removeListItemAttachment` skip every file in that set; batch deletes exclude the whole batch, so deleting a list that holds two items linking the same file still trashes it. Batch deletes (v2.32.198) compute that set once for the whole batch (`trashBatchItemAttachments`) and run the cleanup unawaited after the refresh, so a big clear-done never blocks the toast; the Drive adapter caches missing attachment folders per session, so repeat deletes don't re-search Drive for folder-less items (invalidated when a folder is created). The folder trash takes the same set — `folderTrashPlan` (pure, in js/adapters/drive.js) spares every referenced file in the folder and trashes the folder itself only when nothing referenced remains inside it, so the folder trash cannot defeat the file check. Limit: another member's PERSONAL copy is invisible to this client, so the check cannot cover it — deleting the last visible reference can still dangle a personal copy elsewhere; only the file owner can trash it, and the trash is recoverable from Drive for 30 days. Chips show the uploader in the tooltip on shared items (v2.32.139): `attachmentUploaderName` resolves the member's display name from the group row (`memberDisplayName`, pure — display_name, else invited_label, else null); personal items and unresolvable ids show no uploader, never a raw id. The Lists search matches attachment file names too (v2.32.140): `listItemMatchesSearch` (pure) matches text, note, and attachment names, case-insensitively.
- **Attachments on shared items:** the payload carries the array (`payload.attachments`, real array, not a string) — the local pointer row's column is never the source of truth for shared items; the load enrichment copies `sh.payload.attachments` into `item.attachments`, and writes go through `state.sharing.updateItem` with a payload spread (same as text/note edits). Before the payload update, the uploaded file is shared with every other joined member as reader via `state.sharing.shareFileWithGroup` — a share failure aborts the attach (the file stays in the uploader's Drive folder, unlinked). Sharing an existing item with attachments (v2.32.129) carries its records into the payload (`sharedListItemPayload`) and grants each file reader to the group first, via the shared `shareAttachmentsWithGroup` helper — a grant failure aborts the share outright (the item stays personal) — and any grants already issued are rolled back, only for the members newly granted in that operation (v2.32.142); the same rollback runs when the payload upload, the pointer insert, or (in the upload path) the record save fails afterwards, and when the attach is cancelled mid-share. The bulk share applies the same per item and skips the ones whose grants fail. The final toast counts the skipped items in its total (shared N of M, v2.32.198) — an all-skipped run still gets a toast instead of silence. Access level is reader by default (decided Nov 21, 2026): readers cannot re-share or delete, and the owner may also disable download/print/copy per file. A member who joins later still sees the attachment (name, size, Drive link — the payload syncs through the join, `lists.json` is one of the downloaded group files) but has no access to the file itself until the grant sweep runs: every member's client grants its own files reader to the new member, on group load and when the poll spots the fresh join (join-backfill, v2.32.131); until then, clicking the link lands on Drive's request-access page, so they can ask from there. Known gaps: none. Deleting an item trashes only the deleter's own files (`ownAttachmentFiles` by `uploaded_by`, v2.32.132); deleting a list trashes the deleter's own files on every item in it (v2.32.135); deleting a section does the same for its whole subtree. The folder trash only ever finds the deleter's own folder, since each member's files live in their own Drive. Removing a chip trashes the file only when it is the remover's; an unresolvable member id trashes nothing at all. Revoke on unshare (v2.32.135): unsharing revokes the group's access to the unsharer's own files only (`revokeFileWithGroup`); another member's files keep their grants. Keep-copies on leave, copy-to-personal and the unshare personal copy (v2.32.136) all carry the original attachment records, still pointing at the shared files — the grants survive leaving, so the links keep opening; the records keep their original uploaded_by.
- Wardrobe removal (v2.9.17): former wardrobe categories became lists named `<name>` inside a `Wardrobe` section (id `vest_wardrobe`); items in the protected default or an unknown category went to a `*` list inside the section (`vest_wardrobe_star`); item notes carry a `Brand / Make:` / `Size:` / `Color:` / `Status:` field block with only non-empty lines, then pre-existing notes after a blank line. Migrated ids are prefixed `vest_`. On the local backend the section kind/parent links are applied by 2.23.0, which adds those columns
- Projects removal (v2.32.190, fixes in 2.32.191): the Projects tab is gone; on first boot after the upgrade the migration (key `2.32.190`, both backends) moves every project into a list inside a `<Migrated> Projects` section (id `mig_projects`, next palette colour, `sort_order` 9999). Each project becomes a list (`mig_<id>`) holding its tasks as items (`mig_<taskId>`, checked iff status was `approved` or `idea-shipped`); the per-project prompt (looked up by project id, then by project name) becomes the list's top item (`mig_prompt_<id>`) and a `Project info` item (`mig_info_<id>`) carries a `Tech:` line plus `[label](url)` links (brackets stripped from labels, `)` in URLs percent-encoded — renderMd's link pattern stops at both). Both top items sit above the tasks: their orders are `base − 2` and `base − 1` where `base` is the minimum of 0 and the project's task orders (tasks were added at min − 1, so their orders run negative). The global task-pickup prompt (prompts key `global`) becomes an item (`mig_prompt_global`) in a `*` list (`mig_projects_star`) inside the section; prompts matching no project (and not `global`) land in the same `*` list with a `Prompt key:` note. Archived projects (settings key `archived_project_ids`) go under an `Archived` subsection (`mig_projects_archived`); empty projects are kept. Task notes carry a field block with only non-empty lines: `Status:` (only for statuses the checkbox cannot express — not todo/approved/idea-shipped), `Plan:` (plan_note), `Claw:` (hatch_response), `Context:` (context). Migrated item text keeps its full length (up to the old 5000-char task cap; prompts were unbounded) — the 2000-char inline-edit cap only constrains retyping. The review/approve workflow is dropped. Old `#project/...` and `#task/...` deep links no longer resolve. Source rows are deleted only when the run actually copied something (projects/tasks/prompts + the `archived_project_ids`/`show_archived` settings rows); a second run is a no-op and drops nothing, and orphan tasks are dropped. Restoring a pre-2.32.190 backup resurrects the rows, and the restore re-runs pending migrations, so they migrate on restore. The tables stay in `DRIVE_TABLES` and `server/schema.sql` until every account has migrated, so the migration can flush them empty.

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
