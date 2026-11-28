# Lists

Lists are general-purpose checklists — anything that doesn't fit TODOs, habits, or Memory. A list holds items; lists live in sections or at the top level.

## Lists and sections

- A list has a name (100 characters, shortname 20), a colour and an icon.
- Lists can be organised into nested sections: a section is a list row (`kind='section'`) containing other lists. A list can be turned into a section, and a new list can be added inside a section. Deleting a section deletes its whole subtree. See [ADR 0010](adrs/0010-nested-sections.md).
- Lists reorder by long-press drag (150ms) on the nav buttons, the same uniform system as the rest of the app.

## Items

- An item has text (up to 2000 characters), a checked state, and an optional note.
- Checking an item moves it to the bottom of the list: unchecked items sort by `sort_order` first, checked items sit below them.
- Item text shows truncated at 120 characters with a show-more; notes at 500 with a show-more.
- Quick-add from the list; inline edit saves only on Enter or the confirm button — clicking away cancels, never saves.
- Items reorder by long-press drag (150ms), within a list or across lists: moving an item to another list updates its `list_id` and re-numbers `sort_order` on both lists. A shared item keeps its sharing data when moved — only the list is local.
- A list taller than its 400px height shows a subtle shadow at the top edge while there is more content above, and at the bottom edge while there is more below.

## Search

The Lists filter matches item text, note, and attachment file names, case-insensitively.

## Attachments

The paperclip on a list item attaches a Google Drive file (Drive backend only — the attach button is hidden in Demo and Local mode).

Each attachment is a record — file id, name, size, Drive link, and the uploader's member id — stored on the item; the file itself is never downloaded on page load, only the link.

Uploads go to the uploader's Drive, in a per-item folder `DeLaClaw/attachments/<item id>/` (a shared item's folder uses its shared id). Files up to 5 MB upload in one request; larger files use the chunked resumable upload (1 MB chunks, retried, resumed after failures). There is no user-facing size cap.

The chip appears immediately with a progress ring; uploads run in the background while the user navigates elsewhere, and one file uploads at a time per item. A failed upload leaves an error chip with retry; cancelling is silent. Pending state is memory-only, so a reload drops the chip and kills the upload.

Same-name files are renamed silently: the first keeps the plain name, later ones take `(1)`, `(2)`, and so on, with the suffix splitting only the last extension. Deleting a chip frees the name.

The attachment record is the source of truth: an item's attachments are whatever its records point at (`drive_file_id`), never the contents of its per-item folder. Files never move when an item's identity changes — sharing an item, unsharing it, leaving with keep-copies, or copying it to personal all carry the records as-is; only new uploads go to the folder named after the item's current key. The folder matters for two things only: name dedupe at upload time, and trashing the folder (with its orphans) on delete.

Deleting an item trashes only the deleter's own recorded files and their own per-item folder (orphans from cancelled uploads included) — another member's files are never trashed: the code only attempts files whose `uploaded_by` matches the deleter, and the folder lookup runs in the deleter's own Drive, so it can only ever find their folder. If the deleter's member id cannot be resolved, nothing is trashed at all. A file still referenced by another item is never trashed: the same file can be linked from several items since copies carry the records as-is, so deleting an item — or removing a chip — first checks whether any other item still references it (your own items and the shared payloads; another member's personal copy is invisible to your client, so it can still dangle). The folder is trashed only when nothing referenced remains inside it. Removing a single chip trashes the file only when it is yours; removing someone else's chip removes the record from the item and leaves their file alone. On a shared item, each chip's tooltip names the member who uploaded the file, resolved from the group row; personal items show no uploader.

The group rules — grants, join-backfill, revoke on unshare, keep-copies — live in [Sharing](sharing.md#attachments).

TODOs and Habits support the same mechanism (v2.32.193): the paperclip sits on the TODO/habit row, chips render under it, and the upload, record and delete rules above apply unchanged. Two differences: a TODO's records travel in the sharing payload like a list item's, while a habit's travel top-level on the shared habit; and on the Welcome page both show read-only chips — attach and remove happen only on their own pages. On touch devices Attach is in the kebab menu for TODOs and Habits (Done + Edit stay the primaries), while list items keep Attach as a primary. Events support the same mechanism (v2.32.199): the paperclip and chips live in the edit modal (a new event has no row to attach to yet), the day panel shows read-only chips under the event row, and a shared event's records travel in the payload like a TODO's — the edit merge carries them, so saving an edit never wipes them.

## Sharing

Share a single item, share from the add row, or bulk-share a whole list. Unshare is offered on shared items you created; other members' shared items offer copy-to-personal instead. Group management is currently behind a release gate — the Group tab shows a coming-soon placeholder; the sharing logic and any existing groups are unaffected. Full model: [Sharing](sharing.md).

## Data model

| Table | Contents |
|---|---|
| `lists` | id, name, shortname, color, icon, sort_order, archived, kind (`'bucket'` / `'section'`), parent_id, owner_id |
| `list_items` | id, list_id (FK, CASCADE on delete), text, checked, note, attachments (JSON string), sort_order, shared_id, shared_group_id, owner_id |

The `archived` column exists in the schema but list archival is not exposed in the UI.

Character limits: [Character Limits](char-limits.md) (list name 100 / shortname 20, item text 2000, item note 1000000 stored, 500 shown with show-more).

## Related

- [Sharing](sharing.md) — group model, attachment group rules, design decisions 15–26
- [ADR 0010 — Nested sections](adrs/0010-nested-sections.md)
- [Character Limits](char-limits.md)
