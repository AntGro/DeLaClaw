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

    /** Batch-update sort_order via RPC */
    async bulkSortOrder(table, updates) {
      if (updates.length === 0) return;
      await client.rpc('bulk_sort_order', { p_table: table, p_updates: updates });
    },

    /** Escape hatch: raw Supabase client for anything not yet abstracted */
    raw: client,

    /**
     * Delete the user's account: truncate all personal tables (RLS scopes
     * deletes to the current user) and sign out. Does NOT delete the
     * Supabase Auth user (requires admin/service-role key).
     */
    async deleteAccount() {
      try {
        // Children first, then parents; FK cascades handle the rest
        const ID_TABLES = [
          'tasks', 'habit_completions', 'flashcard_notes', 'text_line_progress',
          'list_items', 'flashcards', 'texts',
          'todos', 'habits', 'vestiaire', 'birthdays',
          'todo_categories', 'habit_categories', 'vestiaire_categories', 'flashcard_decks',
          'projects', 'lists', 'nvidia_usage',
        ];
        for (const table of ID_TABLES) {
          await client.from(table).delete().neq('id', '__never__');
        }
        // Tables with non-id PKs
        await client.from('settings').delete().neq('key', '__never__');
        await client.from('prompts').delete().neq('key', '__never__');
        await client.from('daily_visits').delete().neq('visit_date', '1970-01-01');
        await client.from('gcal_sync').delete().neq('item_type', '__never__');
        await client.auth.signOut();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || 'Unexpected error' };
      }
    },
  };
}
