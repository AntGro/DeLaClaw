# Sharing — Feature Contract

## Purpose
Cross-user collaborative sharing via Supabase. Group creator hosts data on their Supabase project; members connect via invite codes and interact through SECURITY DEFINER RPCs. Supports shared TODOs, habits (with completions), and list items.

User jobs:
- create a sharing group → invite others via DLC1 invite code
- join a group from another user's Supabase project
- share/unshare items (todos, habits, list items) to a group
- complete shared habits and todos collaboratively
- manage members: invite, revoke, leave
- view shared items inline alongside personal items

## Architecture Overview
Five modules, layered:
- `sharing-interface.js` — canonical method contract; `validateSharingAdapter()` enforces at init
- `sharing-envelope.js` — invite code encode/decode (`DLC1.<base64url JSON>`)
- `sharing-supabase.js` — Supabase adapter implementing `SharingInterface`
- `sharing-ui.js` — settings pane, share popovers, badges, completion modals
- `sharing.js` — factory that picks adapter (Supabase or Drive) and validates it
- `crypto-sync.js` — client-side encryption for joined-group credentials in `joined_groups`

## Entry & Ownership
- **Entry:** `js/sharing-ui.js` (UI), `js/sharing-supabase.js` (adapter), `js/sharing.js` (factory)
- **State:** `state.sharing` (adapter instance or null), `state.authUser`
- **Tables:** `sharing_groups`, `sharing_members`, `sharing_items` (on group creator's Supabase); `joined_groups` (on each member's own DB)
- **CODEMAP:** `core[sharing-ui]`, `core[sharing-supabase]`, `core[sharing]`, `core[sharing-interface]`, `core[sharing-envelope]` — see CODEMAP.json for current stats

## Dependencies
- **sharing-supabase** depends on: `sharing-envelope`, `crypto-sync`, `utils`
- **sharing-ui** depends on: `backend-logos`, `i18n`, `icons`, `sharing-envelope`, `state`, `utils`
- **sharing-ui dependents (blast radius):** `habits.js`, `lists.js`, `main.js`, `todos.js`, `welcome.js`

## Two Access Paths
- **Owner (A):** authenticated via magic link → direct table access through RLS (`auth_owner_id = auth.uid()`)
- **Member (B):** unauthenticated on owner's project → all writes via SECURITY DEFINER RPCs with `Bearer <anon_key>` + hashed token verification

## Invite Code Flow
- Format: `DLC1.<base64url(JSON)>` — opaque access code, not encryption
- Supabase payload: `{v:1, b:'supabase', u, k, g, t, x?}` (url, anonKey, groupId, token, expires_at)
- Creator generates invite → `sharing_members` row with `token_hash`, `joined_at=NULL`, `invited_label`
- Joiner decodes invite → calls `verify_join_token(token)` RPC → on success `confirm_join(token, display_name)`
- Joined credentials (url, anonKey, token) encrypted client-side via `crypto-sync.js` and stored in local `joined_groups`
- **Reconnect (owner migration):** if a joiner opens an invite link for a group_id already in `joined_groups` but the URL differs (trailing-slash-normalized), the UI shows a reconnect confirmation modal instead of "already joined". `reconnectGroup()` updates the stored URL + anon key, re-encrypts credentials, rebuilds the remote client, and reloads shared items — no new membership created, no `confirm_join` needed (member already confirmed)

## Security
- **Token hashing:** member tokens hashed at rest (`SHA-256 hex`). RPCs verify `token_hash = encode(digest(token,'sha256'),'hex')`
- **RLS:** `sharing_groups` / `sharing_members` / `sharing_items` → owner-only via `auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)`. Members bypass RLS through SECURITY DEFINER RPCs only
- **XSS:** `sharing-ui.js` wraps all display names, group names, labels in `esc()`. Member labels from remote projects are untrusted user input
- **Credential storage:** joined-group tokens encrypted via `crypto-sync.js` (AES-GCM with sync secret + KEK). Raw tokens never persisted in plaintext
- **Identity invariant:** emails are permission material, not identity. Shared identity is `memberId` + group-local `displayName`. Raw emails must not be stored in shared group state

## Interaction Guards
- **sharing-ui:** pendingSet per CODEMAP. Share/unshare popovers disable buttons until fulfilled
- **sharing-supabase:** pendingSet. `_pendingJoin` state machine for two-phase join (verify → confirm)

## RPCs (SECURITY DEFINER)
All RPCs validate token hash, joined status, and non-revoked before proceeding:
- `verify_join_token(token)` → group info for pending join
- `confirm_join(token, display_name)` → sets `joined_at`, optionally binds `auth_user_id`
- `get_group_members(token, group_id)` → active members
- `get_shared_items(token, group_id, item_type?)` → shared items
- `add_shared_item(token, item_id, group_id, item_type, payload, member_id, parent_item_id?)` → insert
- `update_shared_item(token, item_id, payload)` → update payload + `updated_at`
- `delete_shared_item(token, item_id)` → hard delete
- `leave_group(token)` → reassigns items to creator, then deletes member row
- `revoke_member(group_id, member_id)` → soft-revoke (`revoked_at = now()`)
- `update_member_display_name(token, display_name)` → member self-rename

## i18n
- **sharing-ui prefix:** `sharing.` — keys for group management, invite flow, badges, completion UI
- All UI via `t()`, no hardcoded strings

## Shared Item Types
- `todo` — shared via `sharing_items`, synced into local `todos` with `shared_id` pointer
- `habit` — shared via `sharing_items` with `item_type='habit'`; completions as child `sharing_items` with `item_type='habit_completion'` and `parent_item_id`
- `list_item` — shared via `sharing_items`, synced into local `list_items` with `shared_id` pointer

## Business Invariants
- **Share-button visibility:** buttons render when `!!state.sharing`, not when groups exist
- **No-groups popover:** clicking a share button with no groups opens the same `share-popover` container with a hint message and a link to Settings → Sharing (via `sharePopoverOpenSharing`), instead of silently returning
- **Collaborative editing:** shared items are collaboratively editable — any group member can update or delete any item in a group they belong to, not just items they created
- **Completion attribution:** completions carry `created_by` (member_id) for attribution. Personal/non-shared items don't need attribution
- **Category placement is personal:** `creator_category` is origin metadata only. Local category/deck placement remains personal and must not rewrite `creator_category`
- **Leaving a group:** `leave_group` RPC reassigns the leaving member's created items to the group creator (FK constraint), then deletes the member row. Local `joined_groups` row deleted client-side. Local completions stay
- **Group deletion:** deleting a group cascades to `sharing_members` and `sharing_items` (FK CASCADE). Open design question: what happens to local pointers when a group is deleted
- **Polling:** joined groups poll every 30s (`POLL_MS`). Owner groups use Supabase Realtime when available
- **Member identity:** `memberId` is an 8-char UUID prefix, stable per group. Display names are group-local and mutable via `update_member_display_name`
- **Shared habit `next_due` — write-once, read on refresh:** `next_due` is computed at write time (mark done, edit frequency, edit last-done, etc.) and published to the shared item payload via `updateSharedHabit`. Recipients read `sh.next_due` from shared storage during `refreshHabits()` — no local recomputation. A null `sh.next_due` clears the local pointer's stale value

## Adapter & Backend
- Adapter pattern: `sharing.js` factory creates Supabase or Drive adapter, validates via `SHARING_INTERFACE`
- All view code (`todos.js`, `habits.js`, `lists.js`) talks to `state.sharing` abstraction, never directly to Supabase
- Drive sharing exists but shows "coming soon" in UI — not yet functional for cross-user sync

## Cross-Feature Edges
- **todos.js:** `syncSharedTodos()` merges shared items into `state.allTodos`; shared badge via `sharedBadge()`
- **habits.js:** `syncSharedHabits()` merges by habit_id + date; shared completions displayed in history
- **lists.js:** shared list items enriched with `_shared` metadata; `_myCreatedSharedListItemIds` tracks creator info
- **welcome.js:** aggregates shared TODOs/habits alongside personal ones
- **Category FK cascade:** app-level sharing cleanup runs before CASCADE to propagate shared-item deletion to all group members

## Backup & Restore
- **Creator-side tables** (`sharing_groups`, `sharing_members`, `sharing_items`) included in `BACKUP_TABLES` — exported/imported in FK order (groups → members → items)
- **Joiner-side** (`joined_groups`) also in `BACKUP_TABLES`; `sync_secret` transfers via `settings`
- **Owner ID rewriting on import:** `sharing_groups.auth_owner_id` rewritten to new `auth.uid()` (no trigger on this table). `sharing_members.auth_user_id` rewritten on creator rows only (`role='creator'`). `owner_id` on `joined_groups` stripped (trigger stamps new UID)
- **URL comparison:** all remote URL comparisons normalize trailing slashes before `!==`
- **Migration hint:** backup `_meta.source_url` captures the Supabase URL at export. On import, if URL changed and backup has sharing groups, a toast tells the owner to re-send invite links
- **Limitation:** joiners' stored `remote_url` still points to the old project after owner migrates — requires re-invite (see Reconnect above)

## Risks / Gotchas
- Remote Supabase unavailable → joined group items stale until next successful poll
- Token leak via clipboard/history — UI warns "copy once, paste privately"
- Schema mismatch between owner and joiner → migration error messages hint to run pending migrations
- `_pendingJoin` is a state machine — calling `joinWithFileIds` without prior `tryDirectJoin` throws
- Invite token single-use: `confirm_join` only works when `joined_at IS NULL`
- Credential decryption failure (lost sync secret) → member can't reconnect; must re-join via new invite

## Migration
- Core tables + RPCs: `migrations/1.484_sharing_ownership_categories.sql`
- Member display name update: `migrations/1.523_update_member_display_name.sql`

## Test Hooks
- `bun tests/tests.js`: CODEMAP freshness, esc usage, named imports
- Manual: create group → invite → join from second account → share TODO → verify both see it → complete → verify attribution
