# Sharing — Feature Contract

## Purpose
Cross-user collaborative sharing via Google Drive. Group creator hosts shared data in a Drive folder; members connect via DLC1 invite codes and read/write the shared folder through the Drive API. Supports shared TODOs, habits (with completions), and list items. Maintenance mode (stale, not actively developed).

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
- **Storage:** shared data lives in the owner's Drive folder under `shared/<groupId>/` (`meta.json`, `items.json`, typed item files); joined groups tracked in `joined_groups` (on each member's own DB). `sharing-ui` also reads `habit_categories`, `habit_completions`, `habits`, `todo_categories`, `todos`, `list_items` for category assignment and sync rendering
- **CODEMAP:** `core[sharing-ui]`, `core[sharing-drive]`, `core[sharing]`, `core[sharing-interface]`, `core[sharing-envelope]` — see CODEMAP.json for current stats

## Dependencies
- **sharing-drive** depends on: `sharing-envelope`, `crypto-sync`, `utils`
- **sharing-ui** depends on: `backend-logos`, `i18n`, `icons`, `sharing-envelope`, `state`, `utils`
- **sharing-ui dependents (blast radius):** `habits.js`, `lists.js`, `main.js`, `todos.js`, `welcome.js`

## Two Access Paths
- **Owner (A):** owns the Drive folder → direct file read/write
- **Member (B):** added as writer on the shared folder via Drive permissions → direct file read/write; must also be in the owner's `trusted-contacts.json` allowlist

## Invite Code Flow
- Format: `DLC1.<base64url(JSON)>` — opaque access code, not encryption
- Drive payload: `{v:1, b:'googledrive', f, g}` (folderId, groupId)
- Creator generates invite → shares the group folder with the member's Google account via Drive permissions
- Joiner decodes invite → opens shared folder via Drive API → joined group tracked in local `joined_groups`

## Security
- **Access control:** Google Drive folder permissions + local `trusted-contacts.json` allowlist
- **XSS:** `sharing-ui.js` wraps all display names, group names, labels in `esc()`. Member labels from remote folders are untrusted user input
- **Credential storage:** joined-group folder IDs tracked in `joined_groups`; credentials encrypted via `crypto-sync.js` (AES-GCM with sync secret + KEK). Raw tokens never persisted in plaintext
- **Identity invariant:** emails are permission material, not identity. Shared identity is `memberId` + group-local `displayName`. Raw emails must not be stored in shared group state

## Interaction Guards
- **sharing-ui:** pendingSet per CODEMAP. Share/unshare popovers disable buttons until fulfilled

## UI Actions
- **Settings pane:** create group, delete group, invite member, revoke member, leave group, unjoin group, edit own display name, toggle revoked member visibility (`toggleRevokedMembers`)
- **Join picker:** `sharingOpenJoinPicker` — method picker for joining (paste invite code or open invite link)
- **Share popovers:** `submitSharePopover` — share/unshare items to groups; `sharePopoverOpenSharing` — no-groups hint links to Settings → Sharing
- **Clipboard:** `sharingCopyCode` / `sharingCopyLink` / `sharingCopyMemberCode` / `sharingCopyMemberLink` — copy invite code or link to clipboard
- **Completion modal:** `sharingCompleteSubmit` — submit shared habit/todo completions with attribution

## Drive Adapter Operations
No RPC layer — both users read/write the shared folder directly via the Drive API:
- `createGroup(name)` → creates `shared/<groupId>/` with `meta.json`
- `inviteUser(groupId, email)` → shares folder with the member's Google account (writer role)
- `removeUser(groupId, memberId)` → removes the Drive permission
- `loadGroup(groupId)` / `saveGroup(groupId)` → read/write `meta.json`
- `saveTypedItems(groupId, type)` → write typed item files (`items.json` + per-type files)
- `leaveGroup(groupId)` → removes local membership
- `deleteGroup(groupId)` → deletes the shared folder

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
- **Completion attribution:** completions carry `created_by` (member_id) for attribution. Personal/non-shared items don't need attribution
- **Category placement is personal:** `creator_category` is origin metadata only. Local category/deck placement remains personal and must not rewrite `creator_category`
- **Leaving a group:** the local `joined_groups` row is deleted client-side. Local completions stay
- **Group deletion:** deleting a group deletes the shared Drive folder. Open design question: what happens to local pointers when a group is deleted
- **Polling:** joined groups poll every 15s (`POLL_MS`)
- **Member identity:** `memberId` is an 8-char UUID prefix, stable per group. Display names are group-local and mutable via `update_member_display_name`
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
- **Sharing tables** (`sharing_groups`, `sharing_members`, `sharing_items`, `joined_groups`) included in `BACKUP_TABLES` where present
- **Joiner-side** (`joined_groups`) also in `BACKUP_TABLES`; `sync_secret` transfers via `settings`
- **Owner ID rewriting on import:** `owner_id` on `joined_groups` stripped (trigger stamps new UID)

## Risks / Gotchas
- Remote Drive folder unavailable → joined group items stale until next successful poll
- Invite token single-use is not enforced server-side — anyone with folder access can read/write
- Schema mismatch between owner and joiner → migration error messages hint to run pending migrations
- Credential decryption failure (lost sync secret) → member can't reconnect; must re-join via new invite

## Test Hooks
- `bun tests/tests.js`: CODEMAP freshness, esc usage, named imports
- Manual: create group → invite → join from second account → share TODO → verify both see it → complete → verify attribution
