// ===================================================================
// auth.js — Google sign-in for the extension (spec §4).
//
// Implicit flow with the web app's EXISTING OAuth client (not a new
// one): the code exchange needs a client secret Google will not issue
// to a browser flow, proven by the 15 Nov 2026 spike (HTTP 400
// `client_secret is missing` for both the web client and a Desktop
// client). The flow runs from the service worker, never from the popup:
// the popup's document is destroyed the moment the auth window takes
// focus, killing the flow mid-way.
//
// Token + expiry live in chrome.storage.session only. There is no
// refresh token: the implicit flow issues none. Silent re-auth is
// UNPROVEN inside the real extension — validate it during the week of
// unpacked use (spec §8 step 6); the code falls back to interactive
// once, then errors, and never loops.
// ===================================================================


// The web app's OAuth client (js/main.js) — public identifier, not a secret.
export const CLIENT_ID = '883846698493-5v6hfn0vvnq7mn5gua454cgvibbgqt8i.apps.googleusercontent.com';
// Both scopes in the grant (settled §11): v1 uses the Drive scope only;
// the Calendar scope is carried so a later calendar feature needs no
// second consent round.
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.app.created',
].join(' ');

// Refresh when fewer than 5 minutes remain (spec §4).
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_KEY = 'dlc_token';
const ACCOUNT_KEY = 'dlc_account'; // { email, confirmedAt } — chrome.storage.local

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomState() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return b64url(a);
}

// Pure: builds the authorization URL for a given redirect URI and state.
// interactive=true → prompt=consent; silent → prompt=none.
export function buildAuthUrl({ redirectUri, state, interactive }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: SCOPES,
    prompt: interactive ? 'consent' : 'none',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Pure: parses the redirect URL fragment. Throws on a state mismatch or
// a Google error (access_denied, ...). The fragment is never sent to any
// server — it is read from the URL launchWebAuthFlow returns.
export function parseAuthRedirect(redirectUrl, expectedState) {
  const u = new URL(redirectUrl);
  const frag = new URLSearchParams(u.hash.slice(1));
  const err = frag.get('error');
  if (err) throw new Error(`Google sign-in failed: ${err}`);
  const state = frag.get('state');
  if (!state || state !== expectedState) {
    throw new Error('Sign-in state mismatch — rejecting the token.');
  }
  const accessToken = frag.get('access_token');
  const expiresIn = Number(frag.get('expires_in') || 0);
  if (!accessToken || !expiresIn) {
    throw new Error('Google sign-in returned no access token.');
  }
  return { accessToken, expiresInSec: expiresIn };
}

async function readToken() {
  const { [TOKEN_KEY]: stored } = await chrome.storage.session.get(TOKEN_KEY);
  if (!stored || !stored.accessToken || !stored.expiresAt) return null;
  return stored;
}

async function storeToken(accessToken, expiresInSec) {
  await chrome.storage.session.set({
    [TOKEN_KEY]: {
      accessToken,
      // Absolute expiry: now + expires_in. The token is never written to
      // chrome.storage.local and never stored in a file.
      expiresAt: Date.now() + expiresInSec * 1000,
    },
  });
}

// One launchWebAuthFlow round. The pending state is persisted before
// launching so a service-worker restart mid-flow cannot orphan it.
async function launchFlow(interactive) {
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const state = randomState();
  await chrome.storage.session.set({ dlc_pending_state: state });
  const url = buildAuthUrl({ redirectUri, state, interactive });
  const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!redirectUrl) throw new Error('Sign-in was closed before completing.');
  const { dlc_pending_state: expected } = await chrome.storage.session.get('dlc_pending_state');
  await chrome.storage.session.remove('dlc_pending_state');
  const { accessToken, expiresInSec } = parseAuthRedirect(redirectUrl, expected);
  await storeToken(accessToken, expiresInSec);
  return accessToken;
}

// Returns a valid access token, refreshing silently when the stored one
// is missing, expired, or within 5 minutes of expiry; falls back to one
// interactive attempt, then throws. Callers retry their Drive call once
// after a 401 by calling getToken({ forceRefresh: true }). Pass
// allowInteractive: false when no window may appear (e.g. opening the
// popup): a silent failure then throws AUTH_REQUIRED instead.
export async function getToken({ interactive = false, forceRefresh = false, allowInteractive = true } = {}) {
  const stored = forceRefresh ? null : await readToken();
  if (stored && stored.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return stored.accessToken;
  }
  // Silent first (prompt=none), unless the caller already asked for
  // interactive. A silent failure is expected when there is no Google
  // session — it is not an error, it is the signal to go interactive.
  if (!interactive) {
    try {
      return await launchFlow(false);
    } catch (e) {
      // Fall through to interactive once below.
      console.warn('[dlc] silent re-auth failed, going interactive:', e.message);
    }
  }
  if (!allowInteractive) {
    const err = new Error('Sign-in required.');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  return launchFlow(true);
}

export async function clearToken() {
  await chrome.storage.session.remove(TOKEN_KEY);
}

// The account email for the current token, via Drive about.get. Do NOT
// use the userinfo endpoint: it would need an `openid email` scope the
// grant does not have (spec §4).
export async function fetchAccountEmail(token) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read the signed-in account (HTTP ${res.status}).`);
  const data = await res.json();
  const email = data?.user?.emailAddress;
  if (!email) throw new Error('Google did not return an account email.');
  return email;
}

export async function getAccount() {
  const { [ACCOUNT_KEY]: account } = await chrome.storage.local.get(ACCOUNT_KEY);
  return account || null;
}

// Persists the user's confirmation that the shown email is their
// DeLaClaw account. Writes stay blocked until this exists (spec §4).
export async function confirmAccount(email) {
  await chrome.storage.local.set({ [ACCOUNT_KEY]: { email, confirmedAt: new Date().toISOString() } });
}

// Logout: clears the session store and the persisted account
// confirmation, and revokes the access token.
export async function signOut() {
  const stored = await readToken();
  await clearToken();
  await chrome.storage.local.remove(ACCOUNT_KEY);
  if (stored?.accessToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.accessToken)}`, {
        method: 'POST',
      });
    } catch (_) {
      // Revocation is best-effort; the token is already forgotten locally.
    }
  }
}
