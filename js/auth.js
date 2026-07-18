// ===================================================================
// AUTH MODULE — Supabase 6-digit OTP code authentication
// ===================================================================
//
// D+E hybrid: the project owner (A) authenticates via 6-digit code to
// protect personal data. Group members (B) never authenticate — they
// use bearer tokens via RPC functions.
//
// Auth flow (code-only, PWA-safe):
//   1. A enters email → signInWithOtp() sends 6-digit code
//   2. A enters code in same PWA context → verifyOtp({ email, token })
//   3. Session stored in localStorage → auto-refreshes silently
//   4. On first auth, claimOwnership() stamps all existing rows
//
// Why code-only: iOS PWA + Gmail opens magic links in Chrome, losing
// the session (isolated storage). 6-digit code stays inside the PWA.
//
// Re-auth only needed if: localStorage cleared, new browser/device,
// or refresh token explicitly revoked.
// ===================================================================

/**
 * Initialize auth: check for existing session.
 * supabase-js auto-detects session from storage / PKCE callback.
 *
 * @param {Object} adapter — Supabase adapter (must have .raw for auth)
 * @returns {Promise<{user: Object|null, isNewAuth: boolean}>}
 */
export async function initAuth(adapter) {
  const client = adapter.raw;

  // supabase-js v2 detects session automatically
  const { data: { session } } = await client.auth.getSession();

  if (session) {
    // Since 1.300 owner-only, we can't reliably detect new auth via NULL rows.
    // Always attempt claim_ownership() after sign-in (idempotent).
    return { user: session.user, isNewAuth: true };
  }

  return { user: null, isNewAuth: false };
}

/**
 * Send a 6-digit verification code to the given email.
 * Uses built-in Supabase SMTP (2 emails/hr — fine since only the
 * owner authenticates, once per device).
 *
 * Email template must contain {{ .Token }} (code-only). Do NOT include
 * {{ .ConfirmationURL }} — we no longer use magic links to avoid
 * iOS PWA Chrome isolation issues.
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
      // No emailRedirectTo needed for code-only, but keep origin for
      // fallback if template still contains a link.
      shouldCreateUser: true,
    },
  });
  return { error };
}

/**
 * Verify a 6-digit OTP code inside the current browser context.
 * This is the PWA-safe path: token stays in the PWA, no cross-browser
 * session loss.
 *
 * Also accepts a full magic-link URL (fallback for projects without
 * custom SMTP where template editing is locked). In that case we extract
 * token_hash + type and verify via token_hash.
 *
 * @param {Object} adapter
 * @param {string} email
 * @param {string} token — 6-digit code from email OR full verify URL
 * @returns {Promise<{user: Object|null, error: Object|null}>}
 */
export async function verifyOtpCode(adapter, email, token) {
  const client = adapter.raw;
  const raw = (token || '').trim();

  // ── Magic-link URL pasted? Extract token_hash ──
  if (raw.includes('token=') || raw.startsWith('http')) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://dummy.com/?${raw}`);
      const token_hash = url.searchParams.get('token') || url.searchParams.get('token_hash') || raw.match(/token=([^&]+)/)?.[1];
      const type = url.searchParams.get('type') || 'signup';
      if (token_hash) {
        const { data, error } = await client.auth.verifyOtp({
          token_hash,
          type,
        });
        return { user: data?.user || data?.session?.user || null, session: data?.session || null, error };
      }
    } catch { /* fall through to normal code path */ }
    // Also handle raw token_hash pasted (long string)
    if (raw.length > 20 && !/^\d+$/.test(raw)) {
      for (const t of ['signup', 'magiclink', 'email']) {
        try {
          const { data, error } = await client.auth.verifyOtp({ token_hash: raw, type: t });
          if (!error && (data?.user || data?.session)) return { user: data.user || data.session.user, session: data.session, error: null };
        } catch {}
      }
    }
  }

  const cleanToken = raw.trim();
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
