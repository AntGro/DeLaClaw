// ===================================================================
// AUTH MODULE — Supabase magic-link authentication
// ===================================================================
//
// D+E hybrid: the project owner (A) authenticates via magic link to
// protect personal data. Group members (B) never authenticate — they
// use bearer tokens via RPC functions.
//
// Auth flow:
//   1. A enters email → signInWithOtp() sends magic link
//   2. A clicks link → supabase-js auto-detects hash tokens
//   3. Session stored in localStorage → auto-refreshes silently
//   4. On first auth, claimOwnership() stamps all existing rows
//
// Re-auth only needed if: localStorage cleared, new browser/device,
// or refresh token explicitly revoked.
// ===================================================================

/**
 * Initialize auth: check for existing session.
 * supabase-js auto-detects magic link callback hash fragments.
 *
 * @param {Object} adapter — Supabase adapter (must have .raw for auth)
 * @returns {Promise<{user: Object|null, isNewAuth: boolean}>}
 */
export async function initAuth(adapter) {
  const client = adapter.raw;

  // supabase-js v2 detects magic link hash tokens automatically
  const { data: { session } } = await client.auth.getSession();

  if (session) {
    // Check if this is a brand new auth (no prior owner_id claim)
    const { data: row } = await adapter.from('settings')
      .select('owner_id').limit(1).maybeSingle();
    const isNewAuth = row && row.owner_id == null;
    return { user: session.user, isNewAuth };
  }

  return { user: null, isNewAuth: false };
}

/**
 * Send a magic link to the given email.
 * Uses built-in Supabase SMTP (2 emails/hr — fine since only the
 * owner authenticates, once per device).
 *
 * @param {Object} adapter
 * @param {string} email
 * @returns {Promise<{error: Object|null}>}
 */
export async function sendMagicLink(adapter, email) {
  const client = adapter.raw;
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  return { error };
}

/**
 * Claim all unclaimed rows (owner_id IS NULL) for the authenticated user.
 * Called once after first successful auth. Idempotent — already-claimed
 * rows are untouched.
 *
 * @param {Object} adapter
 * @param {string} userId — auth.uid()
 */
export async function claimOwnership(adapter, userId) {
  const tables = [
    'projects', 'tasks', 'todos', 'habits', 'habit_completions',
    'flashcard_notes', 'birthdays', 'vestiaire', 'lists', 'list_items',
    'settings', 'prompts', 'joined_groups',
  ];
  for (const table of tables) {
    await adapter.from(table)
      .update({ owner_id: userId })
      .is('owner_id', null);
  }
}

/**
 * Get current auth user (if any).
 * @param {Object} adapter
 * @returns {Promise<Object|null>}
 */
export async function getAuthUser(adapter) {
  const { data: { user } } = await adapter.raw.auth.getUser();
  return user;
}

/**
 * Sign out and clear the session.
 * @param {Object} adapter
 */
export async function signOut(adapter) {
  await adapter.raw.auth.signOut();
}

/**
 * Listen for auth state changes.
 * @param {Object} adapter
 * @param {Function} callback — (event, session) => void
 * @returns {{ data: { subscription } }} — call .data.subscription.unsubscribe() to stop
 */
export function onAuthStateChange(adapter, callback) {
  return adapter.raw.auth.onAuthStateChange(callback);
}
