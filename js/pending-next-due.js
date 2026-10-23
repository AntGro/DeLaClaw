// ===================================================================
// PENDING NEXT-DUE — per-habit in-flight publish tracking (pure)
// ===================================================================
// Tracks shared habits with a next_due publish in flight, so refreshes
// trust the locally recomputed value instead of stale shared storage.
//
// Reference-counted per habit id: overlapping mutations on the same habit
// must not release each other's marker. The marker is held until the last
// outstanding mutation settles, so a failure-triggered refresh still
// respects a sibling mutation that remains in flight. Releasing an id with
// no outstanding mutations is a harmless no-op.

export function createPendingNextDue() {
  const counts = new Map(); // sharedId -> in-flight mutation count
  return {
    add(sharedId) {
      counts.set(sharedId, (counts.get(sharedId) || 0) + 1);
    },
    release(sharedId) {
      const n = (counts.get(sharedId) || 0) - 1;
      if (n <= 0) counts.delete(sharedId);
      else counts.set(sharedId, n);
    },
    has(sharedId) {
      return counts.has(sharedId);
    },
  };
}

// Singleton used by the habits view.
export const pendingSharedNextDue = createPendingNextDue();
