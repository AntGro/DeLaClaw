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
    // Since 1.300 owner-only, we can't reliably detect new auth via NULL rows.
    // Always attempt claim_ownership() after sign-in (idempotent).
    return { user: session.user, isNewAuth: true };
  }

  return { user: null, isNewAuth: false };
}

/**
 * Send a magic link to the given email.
 * Uses built-in Supabase SMTP (2 emails/hr — fine since only the
 * owner authenticates, once per device).
 *
 * Supabase sends both a magic link AND a 6-digit OTP code. The code
 * path is critical for iOS PWA: clicking the link in Gmail opens
 * Chrome, not the standalone PWA, so the session would be lost.
 * Users should enter the 6-digit code inside the PWA.
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
      // We intentionally request the code, not just link. Supabase email
      // template should contain {{ .Token }} (6-digit) alongside link.
    },
  });
  return { error };
}

/**
 * Verify a 6-digit OTP code inside the current browser context.
 * This is the PWA-safe path: token stays in the PWA, no cross-browser
 * session loss when Gmail opens the link in Chrome.
 *
 * @param {Object} adapter
 * @param {string} email
 * @param {string} token — 6-digit code from email
 * @returns {Promise<{user: Object|null, error: Object|null}>}
 */
export async function verifyOtpCode(adapter, email, token) {
  const client = adapter.raw;
  const cleanToken = (token || '').trim();
  const { data, error } = await client.auth.verifyOtp({
    email,
    token: cleanToken,
    type: 'email',
  });
  return { user: data?.user || data?.session?.user || null, session: data?.session || null, error };
}

/**
 * Claim all unclaimed rows (owner_id IS NULL) for the authenticated user.
 * Called once after first successful auth. Idempotent — already-claimed
 * rows are untouched.
 *
 * For schema >= 1.300 this uses SECURITY DEFINER RPC claim_ownership()
 * which works even after owner-only RLS. Falls back to direct UPDATE
 * for older schemas.
 *
 * @param {Object} adapter
 * @param {string} userId — auth.uid()
 */
export async function claimOwnership(adapter, userId) {
  // Try RPC first (1.300+) — SECURITY DEFINER, bypasses RLS
  try {
    const { error } = await adapter.rpc('claim_ownership');
    if (!error) return;
  } catch {}

  const tables = [
    'projects', 'tasks', 'todos', 'habits', 'habit_completions',
    'flashcard_notes', 'birthdays', 'vestiaire', 'lists', 'list_items',
    'settings', 'prompts',
  ];
  // joined_groups only exists at schema >= 1.297
  let dbVer = 0;
  try {
    const { data: verRow } = await adapter.from('settings')
      .select('value').eq('key', 'schema_version').maybeSingle();
    dbVer = parseFloat(verRow?.value || '0');
  } catch { /* settings table may not exist */ }
  if (dbVer >= 1.297) tables.push('joined_groups');

  for (const table of tables) {
    try {
      await adapter.from(table)
        .update({ owner_id: userId })
        .is('owner_id', null);
    } catch { /* table may not exist yet */ }
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
