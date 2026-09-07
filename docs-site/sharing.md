# Sharing

Last updated: 2026-09-07

DeLaClaw lets you share TODOs, habits, and list items with other people through sharing groups. This page explains the architecture, data flow, and security model.

This page describes the **target design** — the 14 design decisions made on 2026-09-07 (recorded in the "DeLaClaw design decisions" space, "Drive sharing" tab). Assumption: sharing is not yet exposed, no groups exist in the wild, so there are no backward-compatibility constraints (greenfield). Implementation is pending.

## Overview

Sharing is **decentralized**: there is no central DeLaClaw server. One user (the **creator**) hosts the shared data in a folder on their own Google Drive, and other users (**members**) connect to it via invite codes. The creator's folder is the single source of truth for all group data.

```
┌──────────────────────────────────────────────────┐
│                  Sharing group                   │
│                                                  │
│  Creator (A)            Member (B)               │
│  ┌──────────┐           ┌──────────┐             │
│  │ Personal │           │ Personal │             │
│  │  tables  │           │  tables  │             │
│  │ (Drive)  │           │ (Drive)  │             │
│  └────┬─────┘           └────┬─────┘             │
│       │                      │                   │
│       │  direct file         │  shared folder    │
│       ▼  read/write          ▼  read/write       │
│  ┌─────────────────────────────────────────┐     │
│  │  DeLaClaw-Shared-{groupId}              │     │
│  │  (creator's Drive)                      │     │
│  │                                         │     │
│  │  group.json — members, creator, name    │     │
│  │  todos/habits/lists.json — item files   │     │
│  │    (+ deletion tombstones)              │     │
│  │  revoked.json — removed member IDs      │     │
│  │  extra_1..12.json — future placeholders │     │
│  └─────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

## Concepts

**Group** — a named container that the creator creates. Each group has its own members, items, and invite codes.

**Invite code** — an opaque `DLC1.` prefixed string that encodes everything a joiner needs: the backend type, the shared folder ID, the group ID, and an optional expiry. Access control comes from Google Drive folder permissions plus a local trusted-contacts allowlist.

**Local pointer** — when a shared item is displayed on a member's device, a minimal row exists in their local database (e.g. a `todos` row with `shared_id` + `shared_group_id` but empty `text`). The real content comes from the creator's item files at sync time.

**Shared category (`__shared__`)** — items received from others always land in a protected `__shared__` category/list on the receiver's side. Items you share yourself stay in their current category.

**Tombstone** — when a shared item is deleted, a `{id, deleted_at}` tombstone is appended to the item file. The union merge skips tombstoned IDs, so a conflicting concurrent edit cannot resurrect the deleted item. The creator's poll prunes tombstones older than 30 days.

**revoked.json** — a notice file in the shared folder listing removed member IDs. A removed member keeps read-only access to this one file after losing access to everything else, so their client can distinguish "I was removed" from a flaky connection or a deleted group.

## Backend-agnostic design

All sharing logic goes through an adapter interface (`sharing-interface.js`). Views (`todos.js`, `habits.js`, `lists.js`) never talk directly to a backend — they call `state.sharing.addItem()`, `state.sharing.unjoinGroup()`, etc.

```
┌──────────────────────────┐
│     Feature views        │
│  todos · habits · lists  │
└───────────┬──────────────┘
            │  state.sharing.*
            ▼
┌──────────────────────────┐
│   Sharing interface      │
│   (canonical contract)   │
└───────────┬──────────────┘
            │
            ▼
     ┌────────────┐
     │   Drive    │
     │  adapter   │
     └────────────┘
```

The adapter is validated at init time against the interface contract — a missing method is a hard error, not a silent runtime crash. The Supabase sharing adapter was removed with the Supabase backend; Drive is the only sharing path.

## Supabase ↔ Supabase (removed)

The Supabase sharing adapter (`sharing-supabase.js`) was removed together with the Supabase backend. The pre-deprecation codebase is preserved on the `dev-latest-supabase-support` branch.

## Drive ↔ Drive

The Google Drive sharing adapter is the only sharing path. Drive sharing has no server: the shared state is a folder in the **creator's** Google Drive, and every member reads and writes the same files through the Drive API. The joiner's own Drive only ever holds a pointer (`joined-groups.json`) with the shared folder's file IDs. Access control is enforced by Drive folder permissions plus a local trusted-contacts allowlist.

### Storage layout

```
Creator's Drive                                Joiner's Drive
───────────────                                ──────────────
My Drive/                                      My Drive/
├── DeLaClaw/                  (personal)      ├── DeLaClaw/                  (personal)
│   ├── todos.json                             │   ├── todos.json
│   ├── habits.json                            │   ├── habits.json
│   ├── lists.json                             │   ├── lists.json
│   └── joined-groups.json                     │   └── joined-groups.json  ◄── pointer only
│                                                  {folderId, groupId, fileIds}
└── DeLaClaw-Shared/           (shared root)
    └── DeLaClaw-Shared-{groupId}/
        ├── group.json         ← members (hashed IDs + pseudos), creator, name
        ├── todos.json         ← item files: {items: [...],
        ├── habits.json            tombstones: [{id, deleted_at}]}
        ├── lists.json
        ├── revoked.json       ← removed member IDs; read-only
        │                         for removed members
        └── extra_1..12.json   ← empty placeholders, pre-authorize
                                  future item types (avoids sending every
                                  member back through the Drive Picker)
```

- **Invite code**: `DLC1.<base64url({v:1, b:'googledrive', f:<folderId>})>` — one group-level code, no per-member tokens.
- **Access control**: Drive folder permissions (writer) plus the trusted-contacts allowlist; `group.json` holds the member list. No RPC layer, no token hashing.
- **Member identity**: member IDs are opaque hashes (never raw emails); each member picks a pseudo, the hash stays immutable. The pending invite stores an `emailHash` so the joiner can match their invite without exposing the email.
- **Sync**: every member polls every 15 s, keyed on each file's `modifiedTime`. Concurrent writes use ETags with up to two conflict retries; the merge is a union of item IDs that honors deletion tombstones.
- **Drive scopes**: with `drive.file` scope the joiner grants access through the Google Picker (only the selected files, revoked.json included); with full `drive` scope the folder is listed directly.

### Local pointers and per-member buckets

Shared items do **not** force the same buckets on every member. Each member's personal database holds a **pointer row** per shared item (`shared_id` + `shared_group_id`, with empty `text`/`name`); the live content is overlaid from the group's item files at render time.

- Items **you** share stay in your current category with a shared badge.
- Items **received** from others always land in the protected `__shared__` category — and like any other row, the pointer can then be moved into one of your own categories.
- Ordering (`sort_order`) is per-member and never synced.
- When a shared item disappears remotely, the next sync deletes the local pointer; when a whole group disappears, a confirmation dialog offers to unlink the pointers or keep retrying (it re-prompts until resolved).

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'primaryColor': '#ffffff', 'primaryBorderColor': '#cbd5e1', 'primaryTextColor': '#0f172a', 'lineColor': '#334155'}}}%%
flowchart LR
    SF["DeLaClaw-Shared-{id}<br/><b>todos.json</b><br/>item <i>abc123</i><br/>payload: text, done, done_by…"]
    PA["Member A's personal DB<br/>pointer row<br/>shared_id = <i>abc123</i><br/>category: <b>Work</b>"]
    PB["Member B's personal DB<br/>pointer row<br/>shared_id = <i>abc123</i><br/>category: <b>__shared__</b>"]
    SF --> PA
    SF --> PB
```

### Lifecycle

#### Invite → join

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(239,246,255) Creator's Google account
    participant CA as Creator app
    participant CD as Creator's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(240,253,244) Joiner's Google account
    participant JA as Joiner app
    participant JD as Joiner's Drive
    end

    CA->>CD: findOrCreate DeLaClaw-Shared/
    CA->>SF: create subfolder DeLaClaw-Shared-{id}
    CA->>SF: upload group.json + item files<br/>(todos/habits/lists.json)<br/>+ revoked.json<br/>+ 12 empty extra_N.json placeholders
    Note over CA,SF: creator-only: inviteUser throws<br/>unless the caller is the creator
    CA->>SF: share folder with B@email (writer)<br/>+ revoked.json (reader)
    CA->>SF: group.json += member<br/>{hashId, pending, emailHash, pseudo: null}
    CA-->>JA: DLC1 invite code {b:'googledrive', f:folderId}
    Note over CA,JA: sent out of band — chat, email, …
    JA->>JA: paste code → decode → folderId
    JA->>SF: Google Picker → select shared files<br/>(revoked.json included)
    Note over JA,SF: Picker grants drive.file access<br/>to only the selected files —<br/>placeholders pre-authorize future item types
    JA->>SF: download group.json + item files
    JA->>SF: match pending row by emailHash<br/>no match → join rejected
    JA->>SF: pending → joined, set chosen pseudo
    JA->>JD: save DeLaClaw/joined-groups.json
    Note over JD: pointer only:<br/>{folderId, groupId, fileIds}<br/>fileIds include revoked.json
    JA->>JA: startPolling (15s)
    CA->>SF: next poll (≤15s): group.json modified?
    SF-->>CA: changed → re-download
    CA->>CA: toast "B joined" + member list re-renders
```

Joining requires two gates: Drive access to the folder (the join must download `group.json`) **and** a matching pending invite (by `emailHash`). Drive access alone is not enough.

#### Create an item (creator and member)

The flow is identical for creator and member — shared items are collaboratively editable: any group member can add, update, or delete any item.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(240,253,244) Any member's Google account
    participant MA as Member app
    participant MD as Member's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(239,246,255) Other member's Google account
    participant OA as Other member app
    participant OD as Other member's Drive
    end

    MA->>MD: insert pointer row<br/>text:'', shared_id=UUID<br/>category = own choice
    MA->>SF: addItem → append to item file<br/>(ETag-guarded write)
    Note over MA,SF: Drive write fails →<br/>local pointer row deleted (rollback)
    MA->>MA: toast "Shared!" + refresh
    OA->>SF: next poll (≤15s): item file modified?
    SF-->>OA: changed → re-download + merge
    OA->>OD: syncShared*: new shared_id →<br/>create pointer in __shared__
    OA->>OA: refresh → item appears with shared badge
```

#### Modify an item (rename, mark done, habit completion)

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(240,253,244) Any member's Google account
    participant MA as Member app
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(239,246,255) Other member's Google account
    participant OA as Other member app
    end

    MA->>SF: updateItem — rename<br/>merge changes + updated_at
    MA->>SF: completeItem — done=true<br/>done_by=[hashId], done_at=now
    MA->>SF: addSharedHabitCompletion —<br/>completions += {completed_at, note}
    OA->>SF: next poll (≤15s): item file modified?
    SF-->>OA: changed → re-download
    OA->>OA: sharing-changed → sync + refresh
    Note over OA: attribution = stable hashId + timestamp<br/>(done_by / completion entries)
```

#### Delete an item

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(240,253,244) Any member's Google account
    participant MA as Member app
    participant MD as Member's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(239,246,255) Other member's Google account
    participant OA as Other member app
    participant OD as Other member's Drive
    end

    MA->>SF: deleteItem — splice from item file<br/>+ append {id, deleted_at} tombstone<br/>+ ETag-guarded write
    OA->>SF: next poll (≤15s): item file modified?
    SF-->>OA: changed → re-download
    OA->>OD: syncShared*: shared_id gone remotely →<br/>delete local pointer
    OA->>OA: refresh → item disappears
    Note over MA,OA: union merge skips tombstoned IDs —<br/>a conflicting concurrent edit<br/>cannot resurrect the deleted item
    Note over MA,OA: creator's poll prunes tombstones<br/>older than 30 days<br/>(residual risk: a member offline >30 days<br/>with pending edits can still resurrect<br/>via the 412 conflict merge)
```

#### Member unjoins

`leaveGroup` is removed — `unjoinGroup` is the only leave path.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(240,253,244) Member's Google account
    participant MA as Member app
    participant MD as Member's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end

    MA->>MA: confirm dialog: keep copies?
    alt keep copies
    MA->>MD: pointers → personal items<br/>(__shared__ items → General)
    end
    MA->>SF: best-effort: remove self from group.json
    MA->>MD: delete joined-groups.json entry
    MA->>MA: drop group, emit group-left<br/>polling stops
```

#### Creator removes a member

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(239,246,255) Creator's Google account
    participant CA as Creator app
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(240,253,244) Removed member's Google account
    participant MA as Member app
    participant MD as Member's Drive
    end

    CA->>CA: verify caller is the creator (else throw)<br/>member UI for invite/remove is hidden from non-creators
    CA->>SF: reassign removed member's items:<br/>created_by → creator
    CA->>SF: revoked.json += member hashId
    CA->>SF: driveRemovePermission(folderPermId)<br/>reader grant on revoked.json remains
    Note over CA,SF: revocation is not atomic —<br/>permissions are removed one by one
    CA->>SF: group.json −= member row, save
    CA->>CA: emit member-removed
    MA->>SF: next poll: folder → 404
    MA->>SF: fetch revoked.json by stored fileId
    alt own hashId present
    MA->>MA: explicit "removed" state →<br/>stop polling, purge group + pointer
    MA->>MA: orphan dialog: unlink pointers<br/>(re-prompts until resolved)
    else revoked.json also 404
    MA->>MA: group deleted → purge (see below)
    else transport error
    MA->>MA: flaky connection — keep polling
    end
```

#### Creator deletes a group

Deletion goes through a ~30-day grace period so members get an explicit stop-polling signal instead of an abrupt 404.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(239,246,255) Creator's Google account
    participant CA as Creator app
    participant CD as Creator's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end
    box rgb(240,253,244) Member's Google account
    participant MA as Member app
    end

    CA->>CA: confirm dialog (warns if members remain):<br/>keep copies?
    alt keep copies
    CA->>CD: pointers → personal items<br/>(__shared__ items → General)
    end
    CA->>CA: verify caller is the creator (else throw)
    CA->>SF: revoked.json += ALL member hashIds
    CA->>SF: list permissions → revoke all non-owner<br/>(revoked.json reader grants remain)
    Note over CA,SF: folder is NOT trashed yet —<br/>members must still read revoked.json
    CA->>CA: record deletedAt in local state<br/>drop group, emit group-deleted
    MA->>SF: next poll: folder → 404
    MA->>SF: fetch revoked.json by stored fileId →<br/>own hashId present
    MA->>MA: explicit "group deleted" →<br/>stop polling, purge group + pointer
    MA->>MA: orphan dialog → unlink pointers<br/>(re-prompts until resolved)
    Note over CA,CD: creator app startup: deletedAt > 30 days →<br/>permanently delete DeLaClaw-Shared-{id}
```

#### Member deletes their DeLaClaw account connection (deleteAccount)

This is DeLaClaw's Drive-backed `deleteAccount` (trash the personal
`DeLaClaw/` folder, revoke OAuth), not deletion of the Google account itself —
externally deleted Google accounts are handled manually (see below).

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#fbfaf8', 'actorBkg': '#ffffff', 'actorBorder': '#cbd5e1', 'actorTextColor': '#0f172a', 'actorLineColor': '#cbd5e1', 'signalColor': '#334155', 'signalTextColor': '#1e293b', 'noteBkgColor': '#fffbeb', 'noteBorderColor': '#f59e0b', 'noteTextColor': '#78350f', 'labelBoxBkgColor': '#0f172a', 'labelBoxBorderColor': '#0f172a', 'labelTextColor': '#ffffff'}}}%%
sequenceDiagram
    autonumber
    box rgb(240,253,244) Member's Google account
    participant MA as Member app
    participant MD as Member's Drive
    end
    box rgb(255,251,235) Shared — lives in the creator's Drive
    participant SF as DeLaClaw-Shared-{id}
    end

    MA->>SF: for each created group:<br/>grace-period deletion (see above)
    Note over MA,SF: created groups go through the<br/>revoked.json flow so members<br/>get the explicit stop-polling signal
    MA->>MD: trash personal DeLaClaw/ folder
    MA->>MA: revoke OAuth token (last)
    Note over MD,SF: joined groups are left alone —<br/>member rows linger as ghost rows<br/>(no unjoin performed)
    Note over MA,SF: the 30-day sweep needs the app to run —<br/>if never reopened, shell folders linger;<br/>members still infer deletion<br/>(revoked.json + folder both 404)
```

#### Externally deleted Google accounts (manual)

If a member deletes their Google account outside DeLaClaw, their Drive permission dies but their row stays in `group.json` — a ghost member. Detection is manual-only: the creator periodically re-validates Drive permissions against the `group.json` member list (a "check member accounts" action in Settings → Sharing) and removes the ghost rows surfaced by the check. No automatic polling or enforcement.

### Design decisions (decided 2026-09-07)

The flows above surfaced 14 design questions, all decided on 2026-09-07 and recorded in the **DeLaClaw design decisions** space ("Drive sharing" tab). Assumption: sharing is not yet exposed — no groups exist in the wild, so there are no backward-compatibility constraints (greenfield).

1. **Join notification** — the creator's poll shows a toast when a pending invitee flips to joined.
2. **Deletion tombstones** — item files carry `{id, deleted_at}` tombstones so the union merge cannot resurrect deleted items; the creator prunes tombstones older than 30 days.
3. **leave vs unjoin** — `leaveGroup` removed; `unjoinGroup` is the only leave path.
4. **Member IDs** — opaque hashes, never raw emails; members pick a pseudo, the hash stays immutable.
5. **Join admission** — joining requires a matching pending invite (by `emailHash`); Drive access alone is not enough.
6. **Removed members' items** — reassigned to the creator (`created_by` rewrite), no ghost creator IDs.
7. **Creator-only enforcement** — `inviteUser`/`removeUser` throw unless the caller is the creator; the invite/remove UI is hidden from non-creators.
8. **Account deletion** — joined groups are left alone; created groups are deleted via the grace-period flow.
9. **Externally deleted accounts** — manual detection only.
10. **Placeholder exhaustion** — `extra_N.json` raised from 10 to 12 now; behavior at exhaustion deferred.
11. **Received-item placement** — always `__shared__`.
12. **Orphan dialog** — re-prompts until the group returns or deletion is accepted.
13. **revoked.json on member removal** — removed members keep read-only access to a single `revoked.json` notice file.
14. **Group deletion grace period** — all member IDs written to `revoked.json`, shell folder kept ~30 days, then hard-deleted.


## Module structure

| Module | Role |
|---|---|
| `sharing-interface.js` | Canonical method contract; validated at init |
| `sharing-envelope.js` | Invite code encode/decode (`DLC1.<base64url>`) |
| `sharing-drive.js` | Drive adapter (implements the target design) |
| `sharing-ui.js` | Settings pane, share popovers, badges, join flow |
| `sharing.js` | Factory that picks adapter by backend mode |
| `crypto-sync.js` | AES-GCM encryption for joined-group credentials |

## Related

- [ADR 0005 — Sharing behind adapter interface](adrs/0005-sharing-behind-adapter-interface.md)
- [Setup Guide](setup.md)
- [Privacy — Google Drive scopes and data exchange](privacy.md)
