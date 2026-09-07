# Drive sharing — Phases 2–5 implementation plan

Status: **plan only** (no behavior-changing code yet). Prepared 2026-09-07 on branch
`feat/sharing-phase2-phase5`, against `dev` @ v2.0.13 (commit `6bf3218`, Phases 0+1 done).

Source of truth for the target behavior: `docs-site/sharing.md` (14 decisions, 2026-09-07)
and `.agents/contracts/sharing.md`. This plan describes *how* to implement what those
documents already specify. Greenfield assumption holds: sharing is not yet exposed, no
groups exist in the wild, no backward-compatibility constraints.

Standing rules for the implementation work:
- Feature branch → `dev`; merge only after `node tests/tests.js` **and** `bash run_tests.sh`
  are green (repo rule: full suite before push).
- Commits authored as Antoine Grosnit <antoine.grosnit70@gmail.com>, `Checked:` trailer
  per `.githooks/commit-msg` (pre-commit auto-bumps VERSION, regenerates CODEMAP).
- Read `.agents/contracts/sharing.md` + CODEMAP `core[sharing-*]` entries before editing.
- UI: `t()` i18n (EN/FR/ES), Lucide icons, no emoji, English interface text; `guard()` /
  per-ID pending sets for mutating actions (AGENTS.md 1.1–1.2); XSS `esc()` on remote data.

Current state of the Drive adapter (what Phases 2–5 build on):
- Item files (`todos.json`, `habits.json`, `lists.json`) are **plain JSON arrays**.
  `saveTypedItems()` uploads `e.typeData[type] || []`.
- `mergeItems(local, remote)` unions by `id`, latest `updated_at` wins — used both in the
  poll path and the 412 ETag-conflict retry path.
- `EXTRA_COUNT = 10` (`extra_1..10.json`).
- `deleteItem` / `deleteSharedHabit` hard-splice, no tombstone.
- No `revoked.json`. `getRevokedMembers()` is a stub returning `[]`.
- `removeUser()` revokes the folder Drive permission and drops the member row — no item
  reassignment, no notice file.
- `deleteGroup()` revokes all non-owner permissions then **trashes the folder immediately** —
  no grace period, no `deletedAt`.
- `deleteAccount()` (db adapter, `js/adapters/drive.js`) trashes the personal `DeLaClaw/`
  folder and revokes OAuth — knows nothing about shared groups.
- Poll: 3 consecutive folder-404s → purge group locally + `sharing-group-removed-remotely`.
- Orphan dialog exists in `js/main.js` (`sharing-orphan-detected`, threshold 2, queue,
  `_orphanConfirmed` set).

---

## Phase 2 — Deletion tombstones (decision 2)

**Goal:** concurrent offline edits can never resurrect a deleted shared item.

### Data shape change
- Item files become `{ items: [...], tombstones: [{ id, deleted_at }] }`.
- Add a read normalizer (`normalizeTypeEnvelope(data)`): array → `{ items: arr, tombstones: [] }`
  (defensive only; greenfield means no legacy files are expected in the wild).

### Files to touch
- `js/sharing-drive.js`:
  - `saveTypedItems()` — upload the envelope instead of the bare array.
  - Poll path + 412-retry path — replace `mergeItems` with `mergeTypeEnvelopes(local, remote)`:
    union `items` by id (latest `updated_at` wins) **rejecting any id present in either
    side's tombstones**; merge tombstone lists (dedupe by id, keep earliest `deleted_at`).
  - `deleteItem()` / `deleteSharedHabit()` — splice item + append
    `{ id, deleted_at: <now ISO> }`; make delete idempotent (no-op if already tombstoned).
  - `migrateItemsJson()` — write the envelope shape.
  - `createGroup()` — initialize `typeData[type] = { items: [], tombstones: [] }`
    (internal representation follows the envelope).
  - Creator-side prune: in `poll()`, if the current user is the group creator, drop
    tombstones with `deleted_at` older than ~30 days and save the file.
- `js/sharing-interface.js` — update the `deleteItem`/`deleteSharedHabit` comments to
  document tombstone semantics (no signature change).
- `.agents/contracts/sharing.md` — already documents tombstones; keep in sync on details
  (prune rule, idempotent delete).

### Migration / conflict-merge implications
- The 412-conflict path must merge envelopes, not arrays — this is where the
  resurrection bug would otherwise live: remote delete (tombstone) + local offline edit
  reconciled by re-download → union must still honor the tombstone.
- ETag tracking (`typeMeta`) is unchanged; only the payload shape changes.

### Test coverage to add (`tests/tests.js`)
- Unit: `deleteItem` appends `{id, deleted_at}` and removes the item; double-delete is a no-op.
- Unit: `mergeTypeEnvelopes` rejects tombstoned IDs from both sides, keeps latest
  `updated_at` for the rest, dedupes tombstones.
- Unit: prune drops tombstones > 30 days old, keeps newer ones.
- **Regression (offline edit vs delete):** simulate member A editing an item offline while
  member B deletes it (tombstone on the "remote"); run the 412-conflict merge with A's
  stale edit → assert the item stays deleted and the tombstone survives. (Accepted residual
  risk: member offline > 30 days with pending edits can still resurrect after pruning —
  decision 2 keeps this.)

### Open questions for Antoine
1. Tie-break rule: if an edit and a delete land with nearly identical timestamps, should
   delete always win (tombstone suppresses regardless of `updated_at`), or last-write-wins
   on `deleted_at` vs `updated_at`? (Plan default: delete always wins once a tombstone exists.)
2. Pruning: creator-only (as specified) or any member may prune? If the creator's app is
   idle for months, tombstones accumulate — acceptable?
3. Habit completions are child items edited via `updateSharedHabit` — should deleting a
   single completion also write a tombstone, or only whole-item deletes?

---

## Phase 3 — `revoked.json` + member removal (decisions 6, 7, 12, 13)

**Goal:** a removed member gets an explicit "you were removed" signal instead of an
ambiguous 404; their items transfer cleanly to the creator.

### Files to touch
- `js/sharing-drive.js`:
  - `createGroup()` — create `revoked.json` (`{ version: 1, revoked: [] }`), track
    `revokedMeta = { fileId, etag }` in the group entry. Keep the file out of
    `typeData`; it is notice state, not items.
  - `inviteUser()` — after the folder writer grant, also grant **reader** on
    `revoked.json`: `driveShareWithUser(tok, revokedFileId, email, 'reader')`.
    Store the revoked file id in the joined `fileIds` map (`fileIds.revoked`) and handle
    it in `loadGroupWithIds()` / `tryDirectJoin()`.
  - `removeUser()` (creator-only, `assertCreator` already enforced):
    1. Reassign the removed member's items to the creator: rewrite `created_by` →
       creator `memberId` across `todos`/`habits`/`lists` (including habit-completion
       child items) and `saveTypedItems` each touched file.
    2. Append `{ memberId, removedAt }` to `revoked.json` via an ETag-retry
       read-modify-write helper (`appendRevokedMember()`).
    3. `driveRemovePermission(tok, folderId, permissionId)` — the `revoked.json`
       reader grant remains. Tolerate partial failure (revocation is not atomic).
    4. Remove the member row from `group.json`, `saveGroup`, emit `member-removed`.
    5. Do NOT write to `revoked.json` when removing a *pending* invite (they never had
       access) — just drop the row and the Drive permission.
  - Poll 404 path — replace blind purge with state discrimination. New internal
    `resolveGroupAccessState(groupId)`:
    - folder 404 (keep the 3-strike rule) → fetch `revoked.json` by stored fileId:
      - own `memberId` present → **removed**;
      - `revoked.json` also 404/403 → **deleted** (group grace-deleted, see Phase 4);
      - transport/other error → **unavailable** (keep polling).
    - On **removed**/**deleted**: stop polling that group, purge the local entry and the
      `joined-groups.json` entry, dispatch a distinct event
      (`sharing-group-access-lost`, detail `{ groupId, state }`).
    - Handle 403 as well as 404 — Drive may return either for a revoked member.
  - `getRevokedMembers()` — implement for real: return the `revoked.json` entries for a
    group the caller created (`[{ memberId, removedAt }]`). Update the interface comment:
    it returns notice-file entries, not `GroupMember` rows.
- `js/sharing-ui.js`:
  - Settings pane: distinct copy for the removed vs deleted states; orphan unlink flow
    for both. Keep invite/remove controls hidden from non-creators (Phase 1) and add the
    same gate to the new "check member accounts" action (Phase 5).
  - `getRevokedMembers` display: show opaque IDs + removal date in the creator's
    removed-members section (replaces the current Supabase-era stub UI).
- `js/main.js` — orphan dialog: listen for `sharing-group-access-lost`; keep the
  re-prompt-until-resolved loop (decision 12) for the transient/unavailable case; for an
  explicit **removed**/**deleted** state the dialog resolves by unlinking (do not
  re-prompt forever on a terminal state).

### Migration / conflict-merge implications
- `revoked.json` writes are rare and creator-serialized; ETag retry on 412 is enough.
- Item reassignment + tombstones (Phase 2): reassigned items keep their ids, so no
  tombstone interaction; the reassignment itself is a normal `saveTypedItems` write.

### Test coverage to add
- `removeUser` rewrites `created_by` → creator across all three item files.
- `removeUser` appends the member id to `revoked.json` and keeps the reader grant
  (assert the permission-removal call targets the folder permission, not the file one).
- 404-path discrimination: stubbed Drive errors → removed / deleted / unavailable states.
- Re-invite of a previously removed member clears their `revoked.json` entry on join.
- Source-pattern test: UI invite/remove/check controls are only rendered for creators.

### Open questions for Antoine
4. `revoked.json` content: bare member IDs per decision 13, or IDs + removal timestamp
   (+ maybe the last display name for the creator's UX)? Plan default: `{ memberId,
   removedAt }`, no display name — opaque IDs only, privacy-preserving.
5. For an explicit **removed** state, should the orphan dialog offer "keep polling" at all,
   or only unlink? (Plan default: unlink-only; re-prompt loop applies to transient states.)
6. Re-inviting a removed member: clear their `revoked.json` entry automatically on
   re-join (plan default: yes)?

---

## Phase 4 — Grace-period deletion + account deletion (decisions 8, 14)

**Goal:** group deletion is a ~30-day grace period with an explicit stop-polling signal;
account deletion follows a strict, safe order.

### Files to touch
- `js/sharing-drive.js`:
  - `deleteGroup()` — replace immediate trash with the grace flow (creator-only check stays):
    1. Write **all** member ids to `revoked.json` (append, dedupe).
    2. `driveListPermissions(folderId)` → revoke every non-owner permission on the
       **folder**; `revoked.json` reader grants remain. Tolerate partial failure.
    3. Do NOT trash the folder — members must still read `revoked.json`.
    4. Persist `deletedAt` durably (see open question 7) keyed by `groupId`
       (with `folderId` for the later hard delete).
    5. Drop the group from `_groups`, emit `group-deleted`.
  - Startup sweep: in `loadAll()` (or `startPolling` init), read the durable
    deleted-groups record; for entries with `deletedAt` older than ~30 days,
    permanently delete the shell folder (`files.delete`, not trash) and drop the record.
    Members infer deletion even if the sweep never runs (folder 404 + `revoked.json`
    unreachable → **deleted** state, Phase 3).
  - Creator poll prune (Phase 2) keeps running for the shell's item files during grace.
- `js/main.js` (`confirmDeleteAccount` flow, ~line 3563) and/or `js/adapters/drive.js`
  `deleteAccount()` — implement the ordered sequence **before** OAuth is revoked:
    1. For each group the user **created**: grace-period `deleteGroup()` (revoked.json
       flow, so members get the explicit signal).
    2. **Joined groups: left alone** — no unjoin; rows linger as ghosts on the creator side.
    3. Trash the personal `DeLaClaw/` folder (current behavior).
    4. Revoke the OAuth token **last** (current behavior).
  - The sharing adapter must be reachable from the delete-account path: add a
    `capabilities.onBeforeDeleteAccount` hook invoked by `deleteAccount()`, or
    orchestrate in `main.js` via `state.sharing` before calling `db.adapter.deleteAccount()`.
    Keep the existing gcal-calendar deletion in the same ordered sequence.
  - Stop sharing polling before the OAuth revoke so no writes race the teardown.
- `js/sharing-ui.js` — delete-group confirm dialog copy: warn when members remain,
  explain the 30-day grace period and that members keep read access to the notice file;
  keep-copies → pointers become personal items (existing pattern from unjoin).
- `.agents/contracts/sharing.md` — update the `deleteGroup`/`deleteAccount` operation
  docs to the grace flow (currently describes immediate trash).

### Migration / conflict-merge implications
- None for the item merge path. `deletedAt` persistence must survive app restarts and
  ideally device switches (open question 7).

### Test coverage to add
- `deleteGroup` writes all member ids to `revoked.json`, revokes non-owner folder
  permissions, does NOT trash the folder, records `deletedAt`.
- Startup sweep: only entries older than ~30 days are hard-deleted; younger shells kept.
- `deleteAccount` ordering test with stubbed Drive calls: created groups grace-deleted
  → joined groups untouched → personal folder trashed → OAuth revoked last.
- Member-side: folder 404 + `revoked.json` containing own id → **deleted** state, stop
  polling, purge local group, orphan unlink flow.

### Open questions for Antoine
7. Where should `deletedAt` live durably? Options: (a) a `deleted-sharing-groups.json`
   in the creator's personal `DeLaClaw/` Drive folder (+ localStorage mirror) —
   survives device switches, dies with account deletion (fine, sweep is moot then);
   (b) localStorage only — simpler, but a new device never sweeps. Recommendation: (a).
8. Final hard delete: `files.delete` (permanent) vs trash? Decision 14 says "permanently
   deletes it" — plan default: `files.delete`.
9. Fast path: if a group has no joined members (only the creator), skip the grace period
   and trash immediately? (Plan default: yes — no one to notify — but confirm.)

---

## Phase 5 — Polish: toasts, placeholders, manual checks, `__shared__` (decisions 1, 9, 10, 11)

### Work items
- **Join toast (decision 1):** creator's poll already emits `group-changed` when
  `group.json` flips pending → joined. Verify `js/sharing-ui.js` shows a toast on that
  transition; if missing, add: listen for the pending→joined member flip, `toast()` +
  new `sharing.member_joined` i18n key (EN/FR/ES). One toast per member per session
  (guard against re-toast on every poll).
- **12 placeholders (decision 10):** `EXTRA_COUNT 10 → 12` in `js/sharing-drive.js`;
  `tryDirectJoin`'s file-id key list derives from `EXTRA_FILES` already — verify and add a
  source-pattern test asserting 12. (Exhaustion behavior stays deferred per decision 10.)
- **Manual external-account check (decision 9):** new creator-only Settings → Sharing
  action "Check member accounts": for each created group, `driveListPermissions(folderId)`
  → hash each permission's `emailAddress` locally (SHA-256, same `emailHash`) → diff
  against `group.json` member `emailHash`es. Report ghost rows (permission without
  member) and stale members (member without permission); offer per-row "remove" (reuses
  `removeUser`). Read-only report, **no automatic enforcement**, no scheduling.
- **Verify received pointers start in `__shared__` (decision 11):** audit
  `syncSharedTodos` / `syncSharedHabits` / `syncSharedListItems` — every newly created
  pointer row for a received item must land in the protected `__shared__` category/list;
  pointer remains movable afterwards; `sort_order` stays per-member and unsynced.
  Add a regression test if the current coverage doesn't pin this.

### Files to touch
- `js/sharing-drive.js` (`EXTRA_COUNT`), `js/sharing-ui.js` (toast, check-members UI),
  `js/i18n.js` (new keys), `js/main.js` if the check action needs wiring, `tests/tests.js`.

### Test coverage to add
- `EXTRA_COUNT === 12` source-pattern test.
- Join-toast: pending→joined flip emits exactly one toast per member per session.
- Check-members: stubbed permissions vs member list → correct ghost/stale diff.
- `__shared__`: new received pointer lands in `__shared__` for todos, habits, lists.

### Open questions for Antoine
10. Placeholder exhaustion (decision 10 deferred this): when the 12 are used up, prefer
    (a) auto-create more on demand, or (b) prompt the creator to re-run the Picker?
11. Should the manual account check also surface members whose Drive permission exists
    but whose `group.json` row is still `pending` past some age (stale invites)?

---

## Cross-phase notes
- Phases are ordered by dependency (2 → 3 → 4 → 5) but each is independently shippable
  behind the existing feature branch; do not merge to `dev` until the full suite
  (`node tests/tests.js` + `bash run_tests.sh`) is green.
- `docs-site/sharing.md` already describes the target end-state; update its "Last updated"
  line and any "pending" wording as each phase lands. The 14 decisions themselves are
  settled — this plan asks only the implementation-level questions above.
- Decision 12 (orphan re-prompt) is partially implemented today; Phase 3/4 wire the new
  removed/deleted states into the existing dialog rather than replacing it.
