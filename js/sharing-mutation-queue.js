// ===================================================================
// SHARING MUTATION QUEUE — per-item optimistic-mutation sequencing
// ===================================================================
// Pure logic, no DOM or Drive access. The Drive sharing adapter supplies
// per-mutation restore/replay closures; the queue decides ordering and
// failure recomputation.
//
// Staging always stays immediate (the UI unblocks on staging). Uploads for
// the same item are serialized, so a rapid second mutation can't interleave
// its Drive write with the first. When an upload fails, the item state is
// recomputed as oldest-pending-base + replays of the surviving mutations,
// in staging order: a failed mutation never affects the eventual Drive
// state, while newer mutations survive it.

/**
 * Create a per-item mutation queue.
 *
 * enqueue(key, { restore, replay }) — call at staging time, synchronously
 *   with the in-memory change. `restore` puts the pre-staging snapshot back
 *   into the current holder; `replay` re-applies this mutation's change.
 *   Both must resolve the holder lazily (a 412 retry may have replaced the
 *   array). Returns an opaque entry handle.
 *
 * runSerialized(key, entry, uploadFn) — call for the upload phase. Runs
 *   uploadFn after the item's previous upload has settled. On failure the
 *   entry is marked failed and the state is recomputed (see above); the
 *   error is rethrown.
 */
export function createMutationQueue() {
  const tails = new Map();   // key -> tail promise (resolves when the item's latest upload settles; never rejects)
  const pending = new Map(); // key -> [{ restore, replay, failed }] in staging order

  /** Recompute the item state: oldest-pending base + surviving replays. */
  function recompute(key) {
    const q = pending.get(key);
    if (!q || !q.length) return;
    q[0].restore();
    for (const en of q) if (!en.failed) en.replay();
  }

  /** Drop bookkeeping once nothing for the item is still in flight. */
  function prune(key) {
    const q = pending.get(key);
    if (q && q.every(en => en.failed)) pending.delete(key);
  }

  return {
    enqueue(key, { restore, replay }) {
      const entry = { restore, replay, failed: false };
      let q = pending.get(key);
      if (!q) { q = []; pending.set(key, q); }
      q.push(entry);
      return entry;
    },

    async runSerialized(key, entry, uploadFn) {
      const prevTail = tails.get(key) || Promise.resolve();
      let release;
      const tail = new Promise(resolve => { release = resolve; });
      tails.set(key, tail);
      let ok = false;
      try {
        await prevTail;
        await uploadFn();
        ok = true;
      } catch (err) {
        entry.failed = true;
        recompute(key);
        throw err;
      } finally {
        const q = pending.get(key);
        if (q) {
          const ix = q.indexOf(entry);
          if (ok && ix >= 0) q.splice(ix, 1);
          prune(key);
        }
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
