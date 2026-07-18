// ===================================================================
// SUPABASE ADAPTER — wraps @supabase/supabase-js as a DB backend
// ===================================================================
// This is a thin pass-through: every method delegates directly to the
// raw Supabase client. Alternative adapters (PocketBase, REST, local)
// must expose the same chainable interface.
//
// Client singleton: Supabase warns "Multiple GoTrueClient instances
// detected in the same browser context" when createClient is called
// multiple times with the same storage key (e.g. on failed login
// retries). We cache clients by URL to avoid that warning and to
// preserve the auth session across adapter re-creation.
// ===================================================================

const _clientCache = new Map();

/**
 * Create a Supabase adapter.
 * @param {string} url  — Supabase project URL
 * @param {string} key  — Supabase anon/public key
 * @returns {{ from, channel, rpc, raw }}
 */
export function createSupabaseAdapter(url, key) {
  const cacheKey = `${url}::${(key || '').slice(0, 24)}`;
  let client = _clientCache.get(cacheKey);
  if (!client) {
    client = window.supabase.createClient(url, key);
    _clientCache.set(cacheKey, client);
  }

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
