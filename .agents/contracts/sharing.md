# Sharing — Feature Contract

## Purpose
Cross-user collaborative sharing via Google Drive. Group creator hosts shared data in a Drive folder; members connect via DLC1 invite codes and read/write the shared folder through the Drive API. Supports shared TODOs, habits (with completions), and list items. Drive is the only sharing path.

**Target design (decided 2026-09-07, implementation pending):** 14 design decisions recorded in the "DeLaClaw design decisions" space ("Drive sharing" tab). Assumption: sharing is not yet exposed, no groups in the wild, no backward-compatibility constraints (greenfield). `docs-site/sharing.md` describes the target flows; this contract must stay in sync with it.

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
- `crypto-sync.js` — client-side encryption for joined-group credentials in `joined_groups`

## Entry & Ownership
- **Entry:** `js/sharing-ui.js` (UI), `js/sharing-drive.js` (adapter), `js/sharing.js` (factory)
- **State:** `state.sharing` (adapter instance or null)
- **Storage:** shared data lives in the creator's Drive folder `DeLaClaw-Shared-{groupId}/` (`group.json`, item files `todos.json` / `habits.json` / `lists.json` as plain JSON arrays of item objects, `revoked.json`, `extra_1..12.json` placeholders); joined groups tracked in the member's own `joined_groups` personal table (`joined_groups.json`) as `{id (=groupId), folderId, groupId, fileIds, memberId}` (fileIds include `revoked.json`; memberId lets the client match its own revoked.json entry after removal). `sharing-ui` also reads `habit_categories`, `habit_completions`, `habits`, `todo_categories`, `todos`, `list_items` for category assignment and sync rendering
- **Creation-completion marker:** `createGroup` uploads item files + placeholders first and `group.json` LAST — its presence means creation completed. A missing `group.json` on an owned folder means a partial creation: trashed at load time if the folder is older than `ABANDONED_GROUP_AGE_MS` (15 min, via Drive `createdTime`; recoverable via Drive trash), skipped if younger (may be mid-creation on another device), never trashed for unowned (joined) folders. In-session failures best-effort trash the partial folder before rethrowing. `loadAll` isolates per-folder load failures so one bad folder cannot fail the whole load.
- **CODEMAP:** `core[sharing-ui]`, `core[sharing-drive]`, `core[sharing]`, `core[sharing-interface]`, `core[sharing-envelope]` — see CODEMAP.json for current stats

## Dependencies
- **sharing-drive** depends on: `sharing-file-reconcile`, `sharing-envelope`, `crypto-sync`, `utils`
- **sharing-file-reconcile** depends on: nothing (pure, backend-agnostic sync-intent engine used by file-based sharing adapters)
- **sharing-ui** depends on: `backend-logos`, `i18n`, `icons`, `sharing-envelope`, `state`, `utils`
- **sharing-ui dependents (blast radius):** `habits.js`, `lists.js`, `main.js`, `todos.js`, `welcome.js`

## Two Access Paths
- **Creator (A):** owns the Drive folder → direct file read/write
- **Member (B):** added as writer on the shared folder via Drive permissions, plus reader on `revoked.json` (survives folder-permission revocation) → direct file read/write; must also be in the creator's `trusted-contacts.json` allowlist

## Invite Code Flow
- Format: `DLC1.<base64url(JSON)>` — opaque access code, not encryption
- Drive payload: `{v:1, b:'googledrive', f, g}` (folderId, groupId)
- Creator generates invite → shares the group folder with the member's Google account via Drive permissions (writer on folder, reader on `revoked.json`) → pending member row `{hashId, status:'pending', emailHash, pseudo:null}` in `group.json`. `inviteUser` throws unless the caller is the creator
- Joiner decodes invite → Google Picker selects the shared files (`revoked.json` included) → downloads `group.json` → must match a pending row by `emailHash` (no match → join rejected) → flips pending → joined and picks a pseudo → join persisted in the local `joined_groups` table (fileIds include `revoked.json`)
- **Join is gated on the full file set:** `joinWithFileIds` throws unless the joiner has access to ALL required files (`group.json` + item files + every `extra_N.json` placeholder, via `getRequiredGroupFiles()`); a partial grant (e.g. only `group.json` picked) can never half-join — the direct-join path falls back to the Picker instead
- Joining requires BOTH Drive access and a matching pending invite; Drive access alone is not enough
- **Join is desktop-only:** the joiner must multi-select every group file in the Google file picker, which phones/tablets (coarse pointer, no hover) dismiss after a single tap — on such devices `sharingOpenJoinCodeModal` shows a not-available notice instead of the invite-code form. The gate is capability-based (`isDesktopLike()`: fine pointer + hover), not UA sniffing, so touchscreen laptops are not gated
- Creator's next poll (≤15s) detects the pending → joined flip and shows a toast

## Security
- **Access control:** Google Drive folder permissions + local `trusted-contacts.json` allowlist
- **XSS:** `sharing-ui.js` wraps all display names, group names, labels in `esc()`. Member labels from remote folders are untrusted user input
- **Credential storage:** joined-group folder IDs tracked in `joined_groups`; credentials encrypted via `crypto-sync.js` (AES-GCM with sync secret + KEK). Raw tokens never persisted in plaintext
- **Identity invariant:** emails are permission material, not identity. Shared identity is `memberId` + group-local `displayName`. Raw emails must not be stored in shared group state

## Interaction Guards
- **sharing-ui:** pendingSet per CODEMAP. Share/unshare popovers disable buttons until fulfilled

## UI Actions
- **Settings pane:** create group, delete group, invite member, revoke member, unjoin group, edit own display name, manual "check member accounts" (re-validate Drive permissions against `group.json` to surface externally deleted Google accounts)
- **Join picker:** `sharingOpenJoinPicker` — method picker for joining (paste invite code or open invite link); the Picker selection must include `revoked.json`
- **Share popovers:** `submitSharePopover` — share/unshare items to groups; `sharePopoverOpenSharing` — no-groups hint links to Settings → Sharing
- **Clipboard:** `sharingCopyCode` / `sharingCopyLink` / `sharingCopyMemberCode` / `sharingCopyMemberLink` — copy invite code or link to clipboard
- **Completion modal:** `sharingCompleteSubmit` — submit shared habit/todo completions with attribution

## Drive Adapter Operations
No RPC layer — both users read/write the shared folder directly via the Drive API:
- `createGroup(name)` → creates `DeLaClaw-Shared-{groupId}/` with `group.json`, item files, `revoked.json`, 12 `extra_N.json` placeholders
- `inviteUser(groupId, email)` → creator-only; shares folder with the member's Google account (writer on folder, reader on `revoked.json`); adds pending member row with hashed ID
- `removeUser(groupId, memberId)` → creator-only; reassigns the member's items' `created_by` to the creator; appends `{id: memberId, removed_at}` to `revoked.json` (before revoking the permission — a failed write aborts the removal); revokes the folder Drive permission (the `revoked.json` reader grant remains); removes the member row from `group.json`. Removal detection on the member side is based only on reading `revoked.json` by stored fileId (no consecutive-404 counting): own id present → "removed", revoked.json also 404 → "group deleted", transport error → keep polling. On a "removed" verdict the member's poll dispatches `sharing-group-purge-items` and `main.js` deletes all local `todos`/`habits`/`list_items` rows with that `shared_group_id` outright (habit completions cascade) — no dialog, removal is certain — and suppresses the orphan dialog for that group. The orphan dialog is kept for the "deleted" verdict, where an unreachable group may be an infra issue rather than a real deletion
- `loadGroup(groupId)` / `saveGroup(groupId)` → read/write `group.json`
- `saveTypedItems(groupId, type)` → writes the typed item file (plain JSON array); captures the per-file sync intents its payload represents and acknowledges only those on success (failed writes retain intents; a 412 conflict re-reconciles intent-aware and retries)
- `deleteItem` → splices the item from memory AND records a pending delete intent (`deletedIds`); the intent-aware merge (`reconcileItems`, including the 412-conflict path) suppresses the stale remote copy until the deletion upload succeeds
- `unjoinGroup(groupId)` → best-effort flip of own member row to `status: 'left'` (+ `leftAt`) in `group.json` — the row is kept, not deleted — + deletes the local `joined_groups` row (full detach; `leaveGroup` is removed). The creator's poll then revokes the leaver's Drive permission (only the folder owner can revoke it) and clears the row, so leaving actually removes folder access
- `deleteGroup(groupId)` → creator-only; writes ALL member hashIds to `revoked.json`; revokes all non-owner folder permissions (`revoked.json` readers remain); does NOT trash the folder yet; records `deletedAt` in creator local state. Members hitting folder-404 fetch `revoked.json` by stored fileId: own hashId present → explicit "group deleted", stop polling and purge. Creator app startup sweep permanently deletes folders with `deletedAt` older than 30 days
- `deleteAccount` → joined groups left alone (ghost rows linger); created groups deleted via the grace-period `deleteGroup` flow above; personal `DeLaClaw/` folder trashed last; OAuth revoked last
- Removed-member poll states: folder 404 → fetch `revoked.json`: own hashId present = "removed"; `revoked.json` also 404 = "group deleted"; transport error = flaky connection, keep polling

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
- **Unjoining:** `unjoinGroup` is the only leave path (`leaveGroup` removed) — best-effort flip of own row to `status: 'left'` (+ `leftAt`) in `group.json`; the row is kept as a tombstone until the creator's poll revokes the leaver's Drive permission and clears it. Local `joined_groups` row deleted; local completions stay. The UI never displays `status: 'left'` rows (`visibleMembers`), so the member list always reflects who actually has access. Re-inviting the same email drops the stale `left` row before creating the new pending invite
- **Sync intents (in-memory, per group entry + item file):** `addItem`/`addSharedHabit` record pending creates (`createdIds`), `deleteItem`/`deleteSharedHabit` record pending deletes (`deletedIds`); both sets start empty on every load. `reconcileItems` retains pending creates missing remotely, drops local items missing remotely without a create intent (remote deletion), suppresses remote items with a pending delete intent, accepts other remote items as creations, and resolves both-sides conflicts by newer `updated_at`. Intents are acknowledged per successful upload only for the ids that upload actually carried/omitted and whose intent is unchanged since capture — ids added mid-flight stay pending. Nothing is written to Drive, so there is nothing to prune
- **Creator-only mutations:** `inviteUser`/`removeUser`/`deleteGroup` throw unless the caller is the group creator; invite/remove UI is hidden from non-creators
- **Removed members' items** are reassigned to the creator (`created_by` rewrite) — no ghost creator IDs
- **Group deletion:** grace-period flow via `revoked.json` (see Drive Adapter Operations); orphan dialog re-prompts until the group returns or deletion is accepted. Phase 4 must write an explicit group-deleted marker into `revoked.json` when it records all member IDs there — otherwise members would read their own ID and get the "removed" verdict (auto-purge) instead of "deleted" (dialog)
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
- **Drive files are the backup surface:** the shared folder (`group.json`, item files, `revoked.json`) lives in the creator's Drive; the member's `joined_groups` table is the joiner-side pointer record
- **Joiner-side** `joined_groups` rows are personal-table rows, covered by normal table backups; `sync_secret` transfers via `settings`

## Risks / Gotchas
- Remote Drive folder unavailable → joined group items stale until next successful poll
- Invite token single-use is not enforced server-side — anyone with folder access can read/write; the pending-invite check is the second gate
- Revocation is not atomic — Drive permissions are removed one by one; `removeUser` must tolerate partial failure
- Leaving revokes Drive access only when the creator's app next polls (≤15s while running) — if the creator never opens the app again, the permission lingers, because only the folder owner can revoke it
- Removed members can read the full `revoked.json` ID list (opaque hashIds, not emails)
- Sync intents are in-memory per tab: reloading (or a fresh device) starts with empty intent sets and re-syncs from Drive, so there is no long-lived resurrection state to prune — but a tab that stays alive with unacknowledged intents across a long sleep still guards its own merges
- The 30-day deletion sweep needs the creator's app to run; shell folders linger otherwise (members still infer deletion via the `revoked.json`-unreachable fallback)
- Schema mismatch between owner and joiner → migration error messages hint to run pending migrations
- Credential decryption failure (lost sync secret) → member can't reconnect; must re-join via new invite

## Test Hooks
- `bun tests/tests.js`: CODEMAP freshness, esc usage, named imports
- Manual: create group → invite → join from second account → share TODO → verify both see it → complete → verify attribution
