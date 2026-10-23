// ===================================================================
// SHARING FILE RECONCILIATION — backend-agnostic sync-intent engine
// ===================================================================
//
// Pure functions shared by every file-based sharing adapter
// (Google Drive today; kDrive / Dropbox tomorrow). No transport code,
// no error codes, no Drive/Dropbox specifics — those stay in the adapter.
//
// Problem: deletion is only absence. A file backend syncs whole item
// files (todos.json, habits.json, lists.json); a plain union-by-id merge
// cannot tell "deleted by a member" apart from "not yet seen", so a
// deletion uploaded by one member is resurrected by another member's
// stale in-memory copy on the next merge.
//
// Mechanism: each group entry keeps, per item file, two in-memory intent
// sets — ids created locally but not yet acknowledged by a successful
// upload (createdIds), and ids deleted locally but not yet acknowledged
// (deletedIds). Reconciliation consults them:
//
//   - local item absent remotely + pending create  → retain it
//   - local item absent remotely + no pending create → remotely deleted → drop it
//   - remote item absent locally + pending delete → suppress it
//   - remote item absent locally + no pending delete → accept it (remote creation)
//   - present on both sides → newer updated_at wins (ties → remote)
//
// Intents are acknowledged per upload, never per batch: each upload
// captures the exact intent snapshot its payload represents, and a
// successful upload clears only the captured intents that are still
// current. An id created while an upload is in flight stays pending;
// a failed upload retains every intent. markCreated/markDeleted keep the
// two sets disjoint per id, so a same-id intent change mid-flight can
// never be acknowledged by the stale capture.
//
// Intents never leave the tab: nothing is persisted, nothing to prune.
// ===================================================================

/** Fresh intent state for one item file: { createdIds: Set, deletedIds: Set }. */
export function createIntentState() {
  return { createdIds: new Set(), deletedIds: new Set() };
}

/** Record a local creation. Clears any pending delete for the same id. */
export function markCreated(intentState, id) {
  intentState.deletedIds.delete(id);
  intentState.createdIds.add(id);
}

/** Record a local deletion. Clears any pending create for the same id. */
export function markDeleted(intentState, id) {
  intentState.createdIds.delete(id);
  intentState.deletedIds.add(id);
}

/**
 * Forget any pending intent for an id — rollback of a mutation whose upload
 * failed, so a later merge treats the id as untouched by this tab.
 */
export function discardIntent(intentState, id) {
  intentState.createdIds.delete(id);
  intentState.deletedIds.delete(id);
}

/**
 * Plain union by id, newer updated_at wins (ties → remote).
 * For merging two authoritative remote snapshots (e.g. legacy migration),
 * where local intents do not apply.
 */
export function unionItems(local, remote) {
  const map = new Map();
  for (const r of remote) map.set(r.id, r);
  for (const l of local) {
    const existing = map.get(l.id);
    if (!existing || l.updated_at > existing.updated_at) {
      map.set(l.id, l);
    }
  }
  return Array.from(map.values());
}

/**
 * Intent-aware reconciliation of in-memory items against a downloaded file.
 * See the header comment for the rule table.
 */
export function reconcileItems(local, remote, intents) {
  const localById = new Map(local.map(item => [item.id, item]));
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const out = [];

  for (const r of remote) {
    const l = localById.get(r.id);
    if (l) {
      out.push(l.updated_at > r.updated_at ? l : r);
    } else if (!intents.deletedIds.has(r.id)) {
      out.push(r); // remote creation — accept
    }
    // else: locally deleted, not yet acknowledged — suppress the stale remote copy
  }

  for (const l of local) {
    if (!remoteById.has(l.id)) {
      if (intents.createdIds.has(l.id)) {
        out.push(l); // locally created, not yet uploaded — retain
      }
      // else: absent remotely with no pending create — remotely deleted → drop
    }
  }

  return out;
}

/**
 * Resolve a pending↔joined conflict on the same member row by invite
 * generation. The joined row wins iff its invited_at is the same or newer
 * than the pending row's — i.e. the join belongs to the current (or a newer)
 * invite. A re-invite stamps a newer invited_at, so a stale 'joined' from an
 * older invite can never override the fresh 'pending'. Any other status
 * pair (or a missing invited_at) returns null: no precedence applies.
 */
export function resolveMemberStatusConflict(a, b) {
  const statuses = new Set([a?.status, b?.status]);
  if (!(statuses.has('pending') && statuses.has('joined'))) return null;
  const joined = a.status === 'joined' ? a : b;
  const pending = a.status === 'pending' ? a : b;
  const joinedInvitedAt = joined.invited_at || '';
  const pendingInvitedAt = pending.invited_at || '';
  if (!joinedInvitedAt || !pendingInvitedAt) return null;
  return joinedInvitedAt >= pendingInvitedAt ? joined : pending;
}

/**
 * Intent-aware merge of group member rosters (keyed on member_id).
 * Used when a group.json write hits a 412 conflict: only rows this client
 * actually changed since the load (intents.createdIds) win locally — rows
 * this client merely holds take the newer remote version, so a concurrent
 * join (pending → joined, flipped by the invitee) is not reverted by the
 * creator's retry. Rows this client removed (intents.deletedIds) stay
 * removed even if still present remotely.
 * When both sides hold the same row with conflicting pending/joined
 * statuses and neither side has an intent on it, resolveMemberStatusConflict
 * decides by invite generation: joined wins iff its invited_at is the same or
 * newer than the pending row's.
 * Without intents, falls back to local-wins-wholesale per row.
 */
export function mergeMemberLists(local, remote, intents) {
  const created = intents?.createdIds;
  const deleted = intents?.deletedIds;
  const map = new Map();
  for (const m of remote) {
    if (deleted?.has(m.member_id)) continue; // we removed them: stay removed
    map.set(m.member_id, m);
  }
  for (const m of local) {
    if (!created || created.has(m.member_id)) map.set(m.member_id, m); // our change wins (legacy: all rows)
    else if (!map.has(m.member_id)) map.set(m.member_id, m); // row unknown to both sides: keep
    else {
      // Same row both sides, no local intent: resolve a pending↔joined
      // conflict by invite generation; anything else keeps the remote row.
      const winner = resolveMemberStatusConflict(m, map.get(m.member_id));
      if (winner) map.set(m.member_id, winner);
    }
  }
  return Array.from(map.values());
}

/**
 * Intent-aware application of a downloaded member roster over the in-memory
 * one, for the periodic poll (the 412-conflict path uses mergeMemberLists).
 * Rule: the remote roster wins wholesale, except rows this tab created but
 * hasn't flushed yet (intents.createdIds) — those are retained even when
 * absent remotely, so the poll can't drop an invite whose upload is still in
 * flight. Rows this tab removed are deliberately NOT suppressed here: after
 * a failed removal the row resurrects in memory, which is what lets the user
 * retry the removal.
 */
export function reconcileMembers(local, remote, intents) {
  const created = intents?.createdIds;
  if (!created || created.size === 0) return remote.slice();
  const remoteIds = new Set(remote.map(m => m.member_id));
  const out = remote.slice();
  for (const m of local) {
    if (m.member_id && created.has(m.member_id) && !remoteIds.has(m.member_id)) out.push(m);
  }
  return out;
}

/**
 * Snapshot the intents an upload payload represents. Call immediately
 * before the transport write; pass the result to acknowledgeIntents
 * only if that exact write succeeds.
 */
export function captureIntents(intentState, payloadItems) {
  return {
    createdIds: new Set(intentState.createdIds),
    deletedIds: new Set(intentState.deletedIds),
    payloadIds: new Set(payloadItems.map(item => item.id)),
  };
}

/**
 * Clear the captured intents acknowledged by a successful upload.
 * An intent is cleared only if it is still current (unchanged since
 * capture) and the payload actually carried it (creates) or omitted it
 * (deletes). Anything added or changed mid-flight stays pending.
 */
export function acknowledgeIntents(intentState, captured) {
  for (const id of captured.createdIds) {
    if (intentState.createdIds.has(id) && captured.payloadIds.has(id)) {
      intentState.createdIds.delete(id);
    }
  }
  for (const id of captured.deletedIds) {
    if (intentState.deletedIds.has(id) && !captured.payloadIds.has(id)) {
      intentState.deletedIds.delete(id);
    }
  }
}
