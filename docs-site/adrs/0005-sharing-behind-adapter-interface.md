# ADR 0005: Sharing behind a backend adapter interface

Date: 2026-07-20
Status: Accepted

## Context

DeLaClaw needs to share todos, habits, and lists between users (groups, invites, shared items, completions). Original implementation was Google Drive only — folder with JSON files. Adding Supabase required a second implementation.

If sharing logic lived in views with `if (backend === 'supabase')`, every view (`todos.js`, `habits.js`, `lists.js`) would duplicate branching, leak backend details, and break when adding a third backend. Also violates BYOB principle of adapter parity.

Requirements:
- Same sharing behavior across backends (Drive, Supabase, Local)
- Views must stay backend-agnostic
- Owner isolation preserved — shared items still enforce owner_id
- Must not require central infrastructure operated by author

## Decision

Sharing is implemented behind a backend adapter interface, not as conditional logic in views.

- Interface: groups, invites, items, completions — common methods for create/join/leave, share/unshare, and completion tracking
- Views interact only with the sharing abstraction, never directly with Drive APIs or Supabase tables
- Each backend provides its own implementation behind same interface:
  - Drive: files/folders + permission ACLs
  - Supabase: tables with RLS enforcing owner and group membership
- Synchronization preserves set semantics — order does not affect sharing state
- Member identity is adapter-owned and group-local: shared state exposes `memberId`, `displayName`, `invitedLabel`, role/status, and join timestamps; raw emails remain permission material only
- Views use `getCurrentMember(groupId)` for "you" detection and `removeUser(groupId, memberId)` for removal; agents use `getAgentSafeGroup(groupId)` to avoid invite tokens or backend permission details

All mutating views check the sharing abstraction; no backend conditionals in feature code — new behavior is added to the adapter interface instead.

## File-based sync reconciliation (amended 2026-09-12)

For file-based backends (Drive, and future kDrive/Dropbox), item synchronization is not implemented per adapter. The reconciliation logic lives in a backend-agnostic engine (`sharing-file-reconcile.js`, zero dependencies): per group entry and item file, in-memory `createdIds`/`deletedIds` intent sets track local creates/deletes not yet acknowledged by a successful upload. Reconciliation retains pending creates, drops remotely-deleted items, and suppresses stale remote copies of pending deletes; both-sides conflicts resolve by newer `updated_at`. Each upload captures the exact intents its payload represents and acknowledges only those on success, so an id created while an upload is in flight stays pending and failed writes retain intents.

Drive transport specifics — ETags, 412 conflict retries, file discovery, polling — stay in the Drive adapter (`sharing-drive.js`), which calls the engine for every merge.

Consequence: future file-based adapters get correct create/delete propagation for free, but must call `markCreated`/`markDeleted` on every local mutation — otherwise reconciliation silently degrades to last-writer-wins.

## Consequences

- Positive: views remain backend-agnostic, new backends only need to implement sharing interface
- Positive: owner isolation enforced at adapter boundary for both implementations
- Positive: sharing behavior is testable via adapter contract, not per-view
- Negative: adapter interface must evolve when new sharing concepts appear (e.g. item ownership on group delete), requiring changes in multiple implementations
- Neutral: introduces dedicated sharing abstraction layer between features and storage

## Alternatives considered

- Backend branching in views — rejected: leaks abstraction, duplicates logic, breaks when adding backends
- Sharing as separate service operated by author — rejected: scaling cost, central infra, violates BYOB
- Drive-only sharing — rejected: not usable for Supabase/Local users, no RLS enforcement
- Sharing via public links with no groups — rejected: no revocation, no owner isolation, poor UX for ongoing collaboration
