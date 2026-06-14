// ===================================================================
// SUPABASE ADAPTER — wraps @supabase/supabase-js as a DB backend
// ===================================================================
// This is a thin pass-through: every method delegates directly to the
// raw Supabase client. Alternative adapters (PocketBase, REST, local)
// must expose the same chainable interface.
// ===================================================================

/**
 * Create a Supabase adapter.
 * @param {string} url  — Supabase project URL
 * @param {string} key  — Supabase anon/public key
 * @returns {{ from, channel, rpc, raw }}
 */
export function createSupabaseAdapter(url, key) {
  const client = window.supabase.createClient(url, key);

  return {
    /** Supabase query builder — returns the native chainable object */
    from(table) { return client.from(table); },

    /** Realtime channel */
    channel(name) { return client.channel(name); },

    /** RPC call */
    rpc(fn, params) { return client.rpc(fn, params); },

    /** Escape hatch: raw Supabase client for anything not yet abstracted */
    raw: client,
  };
}
