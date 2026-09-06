// ===================================================================
// AUTH MODULE — Supabase email authentication
// ===================================================================

import { compareVersions } from '../migrations/version-compare.js';
//
// D+E hybrid: the project owner (A) authenticates by email to
// protect personal data. Group members (B) never authenticate — they
// use bearer tokens via RPC functions.
//
// Auth flow (PWA-safe):
//   1. A enters email → signInWithOtp() sends a Supabase auth email
//   2. A pastes the confirmation link or token in the same PWA context
//   3. Session stored in localStorage → auto-refreshes silently
//   4. On first auth, claimOwnership() stamps all existing rows
//
// Why paste-to-verify: iOS PWA + Gmail can open links outside the
// standalone app, losing the session to isolated browser storage.
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

  // If user clicked magic-link and landed with ?code=... , exchange it
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    if (code) {
      try { await client.auth.exchangeCodeForSession(code); } catch {}
      // Clean URL
      url.searchParams.delete('code');
      window.history.replaceState({}, '', url.toString());
    }
  } catch {}

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
 * Send a Supabase auth email to the given address.
 * Uses built-in Supabase SMTP (2 emails/hr — fine since only the
 * owner authenticates, once per device).
 *
 * Default Supabase confirmation links are supported. Custom templates
 * may use a token, as long as the pasted email content can be verified
 * inside the app.
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
      // No explicit emailRedirectTo; the project Site URL controls the
      // default redirect target for confirmation links.
      shouldCreateUser: true,
    },
  });
  return { error };
}

/**
 * Verify pasted email auth content inside the current browser context.
 * Accepts:
 *  - email token
 *  - full magic-link URL (https://xxx.supabase.co/auth/v1/verify?token=...&type=...)
 *  - redirected URL with ?code=... (PKCE)
 *
 * @param {Object} adapter
 * @param {string} email
 * @param {string} token — email token OR full verify URL
 * @returns {Promise<{user: Object|null, error: Object|null}>}
 */
export async function verifyOtpCode(adapter, email, token) {
  const client = adapter.raw;
  const raw = (token || '').trim();

  // ── URL pasted? Handle PKCE code= or token= ──
  if (raw.includes('code=') || raw.includes('token=') || raw.startsWith('http')) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://dummy.com/?${raw.startsWith('?') ? raw : '?' + raw}`);
      // PKCE: ?code=xxx — exchange for session (this is what Supabase redirects to)
      const pkceCode = url.searchParams.get('code');
      if (pkceCode) {
        const { data, error } = await client.auth.exchangeCodeForSession(pkceCode);
        if (!error) return { user: data?.user || data?.session?.user || null, session: data?.session || null, error: null };
      }
      // Magic link: ?token=xxx&type=signup
      const token_hash = url.searchParams.get('token') || url.searchParams.get('token_hash');
      const type = url.searchParams.get('type') || 'signup';
      if (token_hash) {
        const { data, error } = await client.auth.verifyOtp({ token_hash, type });
        return { user: data?.user || data?.session?.user || null, session: data?.session || null, error };
      }
    } catch { /* fall through */ }
  }

  // Raw token_hash pasted (long string)
  if (raw.length > 20 && !/^\d+$/.test(raw) && !raw.includes(' ')) {
    for (const t of ['signup', 'magiclink', 'email']) {
      try {
        const { data, error } = await client.auth.verifyOtp({ token_hash: raw, type: t });
        if (!error && (data?.user || data?.session)) return { user: data.user || data.session.user, session: data.session, error: null };
      } catch {}
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
  let dbVer = '0';
  try {
    const { data: verRow } = await adapter.from('settings')
      .select('value').eq('key', 'schema_version').maybeSingle();
    dbVer = verRow?.value || '0';
  } catch { /* settings table may not exist */ }
  if (compareVersions(dbVer, '1.297') >= 0) tables.push('joined_groups');

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

// ===================================================================
// EMAIL GUARD — prevent multi-email data splits (sec-006)
// ===================================================================
// After first successful auth, stores SHA-256(email.lower()) in
// auth_email_guard (no RLS). Subsequent logins check against it
// before sending the magic link. Mismatch → blocked.
// ===================================================================

/**
 * SHA-256 hash of a lowercased, trimmed email.
 * @param {string} email
 * @returns {Promise<string>} — hex-encoded hash
 */
export async function hashEmail(email) {
  const data = new TextEncoder().encode(email.toLowerCase().trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check whether the entered email matches the stored guard hash.
 * @param {Object} adapter — Supabase adapter
 * @param {string} email
 * @returns {Promise<{allowed: boolean, guarded: boolean}>}
 *   allowed: true if email matches or no guard exists yet
 *   guarded: true if a guard row exists (first auth already happened)
 */
export async function checkEmailGuard(adapter, email) {
  try {
    const { data, error } = await adapter.from('auth_email_guard')
      .select('email_hash').limit(1).maybeSingle();
    if (error || !data) return { allowed: true, guarded: false };
    const hash = await hashEmail(email);
    return { allowed: hash === data.email_hash, guarded: true };
  } catch {
    // Table may not exist (pre-migration) — allow
    return { allowed: true, guarded: false };
  }
}

/**
 * Store the email guard hash after first successful auth.
 * No-op if a guard already exists.
 * @param {Object} adapter — Supabase adapter
 * @param {string} email
 */
export async function setEmailGuard(adapter, email) {
  try {
    const { data } = await adapter.from('auth_email_guard')
      .select('email_hash').limit(1).maybeSingle();
    if (data) return; // already set
    const hash = await hashEmail(email);
    await adapter.from('auth_email_guard').insert({ email_hash: hash });
  } catch {
    // Table may not exist (pre-migration) — silently skip
  }
}
