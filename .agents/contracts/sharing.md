# Sharing — Feature Contract

## Purpose
Cross-user collaborative sharing via Google Drive. Group creator hosts shared data in a Drive folder; members connect via DLC1 invite codes and read/write the shared folder through the Drive API. Supports shared TODOs, habits (with completions), and list items. Drive is the only sharing path.

**Shipped design (decided 2026-09-07):** 14 design decisions recorded in the "DeLaClaw design decisions" space ("Drive sharing" tab). Assumption: sharing is not yet exposed, no groups in the wild, no backward-compatibility constraints (greenfield). `docs-site/sharing.md` describes the flows; this contract must stay in sync with it.

User jobs:
- create a sharing group → invite others via DLC1 invite code
- join a group from another user's Drive
- share/unshare items (todos, habits, list items) to a group
- complete shared habits and todos collaboratively
- manage members: invite, revoke, leave
- view shared items inline alongside personal items

## Architecture Overview
Five modules, layered:
- `sharing-interface.js` — canonical method contract; `validateSharingAdapter()` enforces at init
- `sharing-envelope.js` — invite code encode/decode (`DLC1.<base64url JSON>`)
- `sharing-drive.js` — Drive adapter implementing `SharingInterface`
- `sharing-ui.js` — settings pane, share popovers, badges, join picker, completion modals
- `sharing.js` — factory that picks adapter and validates it

## Entry & Ownership
- **Entry:** `js/sharing-ui.js` (UI), `js/sharing-drive.js` (adapter), `js/sharing.js` (factory)
- **State:** `state.sharing` (adapter instance or null)
- **Storage:** shared data lives in the creator's Drive folder `DeLaClaw-Shared-{groupId}/` (`group.json`, item files `todos.json` / `habits.json` / `lists.json` as plain JSON arrays of item objects, `extra_1..12.json` placeholders — 16 files total, no notice/marker files); joined groups tracked in the member's own `groups` personal table (`groups.json`) as `{id, kind: 'joined', folderId, name, fileIds, memberId}` (fileIds are the 16 required files from `getRequiredGroupFiles()`; name is stored so the access-loss toast can name the group when its folder is unreachable). Groups the user created are recorded in the same table as `{id, kind: 'created', name}` — id + name only. Own-group discovery is purely row-based: `loadAll` reads the `kind: 'created'` rows and finds each folder by its deterministic `DeLaClaw-Shared-{groupId}` name (one Drive name search per group); no `DeLaClaw-Shared/` folder scan. A row whose folder is missing (trashed/renamed on Drive) surfaces the skipped chip with the stored name; the row stays until the group is deleted. `sharing-ui` also reads `habit_categories`, `habit_completions`, `habits`, `todo_categories`, `todos`, `list_items` for category assignment and sync rendering
- **Creation-completion marker:** `createGroup` uploads item files + placeholders first and `group.json` LAST — its presence means creation completed, and only then is the `kind: 'created'` row written to the groups table, so a row always points at a fully created group. The group is only registered in memory (`_groups`) and announced to the UX (`group-created`) after that row write succeeds: a failed upsert throws, the folder is trashed (best effort), and nothing is registered or emitted — creation is all-or-nothing. A missing `group.json` on an owned folder means the folder's files were deleted on Drive: the load throws so the skipped notice names the group instead of silently dropping it. In-session failures best-effort trash the partial folder before rethrowing; a tab killed mid-creation may leave a small orphan folder (accepted — no row is written, so the app never sees it). `loadAll` isolates per-folder load failures so one bad folder cannot fail the whole load.
- **CODEMAP:** `core[sharing-ui]`, `core[sharing-drive]`, `core[sharing]`, `core[sharing-interface]`, `core[sharing-envelope]` — see CODEMAP.json for current stats

## Dependencies
- **sharing-drive** depends on: `sharing-file-reconcile`, `sharing-envelope`, `utils`
- **sharing-file-reconcile** depends on: nothing (pure, backend-agnostic sync-intent engine used by file-based sharing adapters)
- **sharing-ui** depends on: `backend-logos`, `i18n`, `icons`, `sharing-envelope`, `state`, `utils`
- **sharing-ui dependents (blast radius):** `habits.js`, `lists.js`, `main.js`, `todos.js`, `welcome.js`

## Two Access Paths
- **Creator (A):** owns the Drive folder → direct file read/write
- **Member (B):** added as writer on the shared folder via Drive permissions → direct file read/write; must also be in the creator's `trusted-contacts.json` allowlist

## Invite Code Flow
- Format: `DLC1.<base64url(JSON)>` — opaque access code, not encryption
- Drive payload: `{v:1, b:'googledrive', f, g}` (folderId, groupId)
- Creator generates invite → shares the group folder with the member's Google account via Drive permissions (writer) → pending member row `{member_id, role: 'member', status: 'pending', display_name: null, invited_label, invited_at, joined_at: null, drive_permission_id}` in `group.json`. `inviteUser` throws unless the caller is the creator, and throws if the email hash already matches a joined or pending member (checked against the in-memory roster before any Drive call) — a re-invite revives the existing row in place (status reset to pending, `invited_at` re-stamped, `left_at`/`joined_at`/`display_name` cleared), so a repeated invite can neither demote a joined member nor duplicate a pending one
- Joiner decodes invite → Google Picker selects the shared files (the full 16-file set) → downloads `group.json` → must match a pending row by `emailHash` (no match → join rejected) → flips pending → joined and picks a pseudo → join persisted in the local `groups` table (fileIds are the 16 required files)
- **Join is gated on the full file set:** `joinWithFileIds` throws unless the joiner has access to ALL required files (`group.json` + item files + every `extra_N.json` placeholder, via `getRequiredGroupFiles()`); a partial grant (e.g. only `group.json` picked) can never half-join — the direct-join path falls back to the Picker instead
- Joining requires BOTH Drive access and a matching pending invite; Drive access alone is not enough
- **Join is desktop-only:** the joiner must multi-select every group file in the Google file picker, which phones/tablets (coarse pointer, no hover) dismiss after a single tap — on such devices `sharingOpenJoinCodeModal` shows a not-available notice instead of the invite-code form. The gate is capability-based (`isDesktopLike()`: fine pointer + hover), not UA sniffing, so touchscreen laptops are not gated
- Creator's next poll (≤15s) reconciles the roster intent-aware (`reconcileMembers`): rows this tab created but hasn't flushed yet are kept (an in-flight invite upload can't be dropped by the poll), everything else takes the remote version; it then detects the pending → joined flip, emits `member-joined` (one per newly joined member, excluding self), and the UX shows a toast

## Security
- **Access control:** Google Drive folder permissions + local `trusted-contacts.json` allowlist
- **XSS:** `sharing-ui.js` wraps all display names, group names, labels in `esc()`. Member labels from remote folders are untrusted user input
- **Credential storage:** joined-group folder IDs tracked in `groups`; Drive API access uses the session OAuth token, never persisted in group state
- **Identity invariant:** emails are permission material, not identity. Shared identity is `memberId` + group-local `displayName`. Raw emails must not be stored in shared group state

## Interaction Guards
- **sharing-ui:** pendingSet per CODEMAP. Share/unshare popovers disable buttons until fulfilled

## UI Actions
- **Settings pane:** create group, delete group, invite member, revoke member, unjoin group, edit own display name
- **Join picker:** `sharingOpenJoinPicker` — method picker for joining (paste invite code or open invite link); the Picker selection must be the full 16-file set
- **Share popovers:** `submitSharePopover` — share/unshare items to groups; `sharePopoverOpenSharing` — no-groups hint links to Settings → Sharing
- **Clipboard:** `sharingCopyCode` / `sharingCopyLink` / `sharingCopyMemberCode` / `sharingCopyMemberLink` — copy invite code or link to clipboard
- **Completion modal:** `sharingCompleteSubmit` — submit shared habit/todo completions with attribution

## Drive Adapter Operations
No RPC layer — both users read/write the shared folder directly via the Drive API:
- `createGroup(name)` → creates `DeLaClaw-Shared-{groupId}/` with `group.json`, item files, 12 `extra_N.json` placeholders
- `inviteUser(groupId, email)` → creator-only; rejects already-joined or pending members against the in-memory roster before any Drive call; shares folder with the member's Google account (writer); adds pending member row with hashed ID (marks `createdIds` in the entry's `memberIntents`). A failed `group.json` write rolls the in-memory roster back (pushed row dropped, revived row restored) and discards the intent — the invite is exactly as if it never happened, so a manual retry passes the duplicate-invite guard; no UI blocking, no bounded retry, the error toast is the failure surface. The Drive writer grant is left in place on write failure — reaped by the load-time permission audit
- `removeUser(groupId, memberId)` → creator-only; reassigns the member's items' `created_by` to the creator (per item file, `updated_at` bumped — a failed item-file upload aborts the removal); revokes the member's folder Drive permission (failure swallowed — the load-time permission audit reaps writer grants with no matching member row); removes the member row from `group.json` outright (marks `deletedIds` in the entry's `memberIntents`; no tombstone, no notice file). On the member side, the next 15s poll (or startup load) hits definite access loss and purges the group — see the access-loss invariant below
- `loadGroup(groupId)` / `saveGroup(groupId)` → read/write `group.json`. On load, creator tabs run a permission audit (`auditFolderPermissions`): list the folder's Drive permissions and revoke writer grants with no matching member row — orphans from failed invite writes (grant issued, row never persisted) or failed revocations; Drive exposes no grant timestamp, so every unmatched writer grant is reaped; best-effort, never fails the load, members never run it (a member must not touch another owner's folder ACL). `saveGroup` uses ETag optimistic concurrency (If-Match, ≤2 retries on 412): a conflict re-downloads and re-merges the member roster with `mergeMemberLists` — only rows this tab changed since load win locally (tracked in the entry's `memberIntents` via `createdIds`/`deletedIds`, captured before the upload and acknowledged only on success); untouched rows take the remote version, so a concurrent join (pending → joined) is not reverted by the retry. Residual: concurrent edits to the same row by two clients → last-writer-wins at row granularity; non-member fields are never merged
- `saveTypedItems(groupId, type)` → writes the typed item file (plain JSON array); captures the per-file sync intents its payload represents and acknowledges only those on success (failed writes retain intents; a 412 conflict re-reconciles intent-aware and retries)
- `deleteItem` → splices the item from memory AND records a pending delete intent (`deletedIds`); the intent-aware merge (`reconcileItems`, including the 412-conflict path) suppresses the stale remote copy until the deletion upload succeeds
- `unjoinGroup(groupId)` → best-effort flip of own member row to `status: 'left'` (+ `left_at`) in `group.json` — the row is kept, not deleted — + purges the member's still-shared pointers outright (kept copies are converted to personal before the flip) + deletes the local `groups` row (full detach; `leaveGroup` is removed). The creator's poll then revokes the leaver's Drive permission (only the folder owner can revoke it) and clears the row, so leaving actually removes folder access. The `'left'` write is best-effort and swallowed: on failure the leave continues locally and the Drive permission lingers until the creator next syncs
- `deleteGroup(groupId)` → creator-only; revokes all non-owner folder permissions, trashes the subfolder immediately (recoverable from Drive trash), drops the group from memory, deletes the created-group row. No deletion marker is written — members take the access-loss path below
- `deleteOwnedGroups()` → deletes every created group (each via the `deleteGroup` path); a folder already gone from Drive counts as done, its row dropped
- `leaveJoinedGroups()` → leaves every joined group; no keep-copies dialog. Definite access loss during a leave → silent `handleStaleGroup` cleanup + continue; transient failure → throw (aborts the wipe)
- `deleteAccount` (Settings → Account → Danger zone) → gated 4-step wipe (sequential, fail-stop — completed steps are not rolled back): (1) `deleteOwnedGroups()` deletes every created group — revoke member permissions + trash the subfolder per group; (2) `leaveJoinedGroups()` leaves every joined group via `unjoinGroup` in strict mode (row flip and groups-row delete failures throw); (3) calendar sync disabled with calendar deletion; (4) `deletePersonalData()` permanently deletes every file in the personal `DeLaClaw/` folder (`files.delete`, not trash) then the folder itself. OAuth token revoked best-effort last, then `disconnect()` → reload to the login gate. Any step failing aborts the whole wipe: error toast names the step, reload to the gate, connection intact so retry works; no rollback of completed steps
- **Access loss (member removed OR group deleted — indistinguishable):** `isDefiniteAccessLoss(err)` classifies: 404 → definite; 403 → definite only with a known access-loss reason (`insufficientPermissions`, `forbidden`) and not rate-limited (`isDriveRateLimited` → transient); anything else (throttled 403, 403 with unknown/missing reason, 5xx, network blip) → transient. Definite access loss at the 15s poll or at startup load (`loadAll`) purges the group: dropped from memory, all item pointers deleted outright via `sharing-group-purge-items` (main.js deletes `todos`/`habits`/`list_items` rows with that `shared_group_id`, no dialog), groups-row delete staged; a single toast says access was lost (`group_no_longer_accessible`). Transient failures never purge — retried on the next poll/load. A group whose load fails transiently is marked skipped (chip in the Sharing pane, retried on the next page load); definite access loss never reaches the skipped state

## i18n
- **sharing-ui prefix:** `sharing.` — keys for group management, invite flow, badges, completion UI
- All UI via `t()`, no hardcoded strings

## Shared Item Types
- `todo` — shared via the group folder, synced into local `todos` with `shared_id` pointer
- `habit` — shared with `item_type='habit'`; completions as child items with `item_type='habit_completion'` and `parent_item_id`
- `list_item` — shared, synced into local `list_items` with `shared_id` pointer

## Business Invariants
- **Share-button visibility:** buttons render when `!!state.sharing`, not when groups exist
- **No-groups popover:** clicking a share button with no groups opens the same `share-popover` container with a hint message and a link to Settings → Sharing (via `sharePopoverOpenSharing`), instead of silently returning
- **Collaborative editing:** shared items are collaboratively editable — any group member can update or delete any item in a group they belong to, not just items they created
- **Completion attribution:** completions carry `created_by` (member hashId) for attribution. Personal/non-shared items don't need attribution
- **Category placement is personal:** `creator_category` is origin metadata only. Local category/deck placement remains personal and must not rewrite `creator_category`
- **Received items always land in `__shared__`** (pointer movable afterwards); per-member `sort_order` is never synced
- **Unjoining:** `unjoinGroup` is the only leave path (`leaveGroup` removed) — best-effort flip of own row to `status: 'left'` (+ `left_at`) in `group.json`; the row is kept as a tombstone until the creator's poll revokes the leaver's Drive permission and clears it. Local `groups` row deleted; still-shared pointers purged outright (kept copies were converted to personal before the flip). If the row delete never reaches Drive, the next `loadAll` repairs it: a joined group whose own member row is already `'left'` in `group.json` is dropped without surfacing it (so the pointer sync can't re-add pointers for already-converted copies) and the row delete is retried — best-effort, never fails startup. With keep-copies, the converted tables are force-flushed to Drive (`driveAdapter.flushTables()`) BEFORE the flip — the flip uploads group.json immediately while table writes are debounced, so without the gate a hard crash in between would lose the kept copies; a flush failure aborts the leave (tables stay dirty, debounced retry continues). The UI never displays `status: 'left'` rows (`visibleMembers`), so the member list always reflects who actually has access. Re-inviting the same email revives the existing row in place (status reset to pending, `invited_at` re-stamped, `left_at`/`joined_at`/`display_name` cleared)
- **Drive upload failures are not swallowed:** `flushTable` rethrows — the debounced `scheduleSave` catch re-schedules the retry and the table stays dirty; `forceSave` settles per table so one failure doesn't skip the rest
- **Optimistic mutations roll back at the adapter level:** every mutating adapter method (`addItem`/`updateItem`/`deleteItem`/`completeItem`/`uncompleteItem`, `addSharedHabit`/`updateSharedHabit`/`deleteSharedHabit`/`addSharedHabitCompletion`) stages in memory first, fires the optional `onStaged` hook, then uploads. A failed upload undoes the in-memory staging (item snapshot restored, create/delete intents restored to their pre-staging membership) and rethrows — no zombie item or stale intent survives to be resurrected by a later flush/merge. Update-style mutations (`updateItem` — including `completeItem`/`uncompleteItem` via delegation — `updateSharedHabit`, `addSharedHabitCompletion`) additionally go through the per-item mutation queue (`js/sharing-mutation-queue.js`): staging stays immediate (the UI still unblocks on staging), but a rapid second mutation's upload waits for the first to settle, and a failed upload recomputes the item as oldest-pending-base + replays of the surviving mutations in staging order — a mutation whose upload is known to have failed is excluded from subsequent local uploads, while newer mutations survive it. Note the distributed-systems caveat: a network timeout after Drive has already committed is indistinguishable from a failure client-side, so the queue cannot guarantee a failed mutation never reached Drive — only that it is never replayed locally. Ordering is split across two intentional mechanisms: the per-item queue serializes update-style mutations to the same item; cross-operation and cross-item ordering (update vs delete, two items in the same file) is defined by the file-level `If-Match` ETag — every `saveTypedItems` upload carries the etag captured at upload start, a 412 downloads + runs the intent-aware `reconcileItems` and retries with a re-serialized payload — so a stale payload can never commit over a newer write. `deleteItem`/`addSharedHabit`/`addItem` deliberately do not join the item queue: delete's rollback also restores intent membership (riskier to thread through restore/replay closures), and the ETag+intent path already defines their ordering. Views unblock on staging (`Promise.race`) and run the upload in the background with a local rollback + error toast
- **Two-layer rollback:** the adapter owns the Drive/in-memory staging + rollback; views own the local-DB side (e.g. deleting the pointer row before a shared delete and re-inserting it if the background upload fails). A failed background operation rolls both layers back, each in its own store — the adapter never touches the local DB
- **Sync intents (in-memory, per group entry + item file):** `addItem`/`addSharedHabit` record pending creates (`createdIds`), `deleteItem`/`deleteSharedHabit` record pending deletes (`deletedIds`); both sets start empty on every load. `reconcileItems` retains pending creates missing remotely, drops local items missing remotely without a create intent (remote deletion), suppresses remote items with a pending delete intent, accepts other remote items as creations, and resolves both-sides conflicts by newer `updated_at`. Intents are acknowledged per successful upload only for the ids that upload actually carried/omitted and whose intent is unchanged since capture — ids added mid-flight stay pending. Nothing is written to Drive, so there is nothing to prune
- **Creator-only mutations:** `inviteUser`/`removeUser`/`deleteGroup` throw unless the caller is the group creator; invite/remove UI is hidden from non-creators
- **Removed members' items** are reassigned to the creator (`created_by` rewrite) — no ghost creator IDs
- **Group deletion:** permissions revoked and the folder trashed immediately; no deletion marker, no grace period; members purge on definite access loss
- **Polling:** joined groups poll every 15s (`POLL_MS`)
- **Member identity:** `memberId` is an opaque immutable hash (never a raw email); display names are group-local pseudos, mutable via `updateMyDisplayName`. Pending invites carry `emailHash` for join matching
- **Shared habit `next_due` — write-once, read on refresh:** `next_due` is computed at write time (mark done, edit frequency, edit last-done, etc.) and published to the shared item payload via `updateSharedHabit`. Recipients read `sh.next_due` from shared storage during `refreshHabits()` — no local recomputation. A null `sh.next_due` clears the local pointer's stale value

## Adapter & Backend
- Adapter pattern: `sharing.js` factory creates adapter and validates via `SHARING_INTERFACE`
- All view code (`todos.js`, `habits.js`, `lists.js`) talks to `state.sharing` abstraction, never directly to Drive

## Cross-Feature Edges
- **todos.js:** `syncSharedTodos()` merges shared items into `state.allTodos`; shared badge via `sharedBadge()`
- **habits.js:** `syncSharedHabits()` merges by habit_id + date; shared completions displayed in history
- **lists.js:** shared list items enriched with `_shared` metadata; `_myCreatedSharedListItemIds` tracks creator info
- **welcome.js:** aggregates shared TODOs/habits alongside personal ones
- **Category FK cascade:** app-level sharing cleanup runs before CASCADE to propagate shared-item deletion to all group members

## Backup & Restore
- **Drive files are the backup surface:** the shared folder (`group.json`, item files) lives in the creator's Drive; the member's `groups` table is the joiner-side pointer record
- **Joiner-side** `groups` rows are personal-table rows, covered by normal table backups; `sync_secret` transfers via `settings`

## Risks / Gotchas
- Remote Drive folder unavailable → joined group items stale until next successful poll
- Invite token single-use is not enforced server-side — anyone with folder access can read/write; the pending-invite check is the second gate
- Revocation is not atomic — Drive permissions are removed one by one; `removeUser` must tolerate partial failure
- Leaving revokes Drive access only when the creator's app next polls (≤15s while running) — if the creator never opens the app again, the permission lingers, because only the folder owner can revoke it
- Sync intents are in-memory per tab: reloading (or a fresh device) starts with empty intent sets and re-syncs from Drive, so there is no long-lived resurrection state to prune — but a tab that stays alive with unacknowledged intents across a long sleep still guards its own merges
- Schema mismatch between owner and joiner → migration error messages hint to run pending migrations
- Credential decryption failure (lost sync secret) → member can't reconnect; must re-join via new invite

## Test Hooks
- `bun tests/tests.js`: CODEMAP freshness, esc usage, named imports
- Manual: create group → invite → join from second account → share TODO → verify both see it → complete → verify attribution
