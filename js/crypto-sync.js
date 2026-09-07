// ===================================================================
// crypto-sync.js — Sync-secret based token encryption for joined_groups
// ===================================================================
// Design (1.301):
//   - Per-user sync_secret: 32 random bytes, stored in localStorage
//     claw_sync_secret (base64). This secret encrypts join tokens T
//     via AES-GCM: CT = AES-GCM(sync_secret, T) stored as
//     token_ciphertext + token_iv in joined_groups.
//   - KEK = SHA-256(refresh_token) — used to wrap sync_secret for backup
//     so anon key + token leak alone is insufficient without session.
//   - 1.396: removed plaintext fallback, now ciphertext-only.
//   - 1.397 (Option A): sync_secret itself is stored in settings table
//     (owner-only RLS) for cross-device portability. LS is cache,
//     settings is source of truth. Flow:
//       LS has S -> use (and ensure settings has it)
//       LS missing, DB has S -> load DB -> save LS
//       neither -> generate S, save LS + DB
//   This protects against single-table RLS leak, but not full DB dump
//   (full dump already gives all personal data anyway).
//
// All ops use WebCrypto (async). No external deps.

const LS_SECRET = 'claw_sync_secret';
const LS_SECRET_WRAPPED = 'claw_sync_secret_wrapped';
const LS_SECRET_WRAPPED_IV = 'claw_sync_secret_wrapped_iv';
const SETTINGS_KEY = 'sync_secret';

function _b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}
function _bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function _isValidSecretBytes(bytes) {
  return bytes && bytes.length === 32;
}

async function _getKeyFromBytes(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function _sha256Bytes(text) {
  const enc = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return new Uint8Array(hash);
}

export async function sha256Hex(text) {
  const h = await _sha256Bytes(text);
  return Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Sync secret management (LS cache) ────────────────────────────

export function getOrCreateSyncSecret() {
  let b64 = localStorage.getItem(LS_SECRET);
  if (b64) {
    const bytes = _b64ToBytes(b64);
    if (_isValidSecretBytes(bytes)) return bytes;
  }
  // Generate new 32-byte secret
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  localStorage.setItem(LS_SECRET, _bytesToB64(fresh));
  return fresh;
}

export function getSyncSecretFromLS() {
  const b64 = localStorage.getItem(LS_SECRET);
  if (!b64) return null;
  const bytes = _b64ToBytes(b64);
  return _isValidSecretBytes(bytes) ? bytes : null;
}

export function hasSyncSecret() {
  const b64 = localStorage.getItem(LS_SECRET);
  return !!b64;
}

export function clearSyncSecret() {
  localStorage.removeItem(LS_SECRET);
  localStorage.removeItem(LS_SECRET_WRAPPED);
  localStorage.removeItem(LS_SECRET_WRAPPED_IV);
}

export function setSyncSecretBytes(bytes) {
  if (!_isValidSecretBytes(bytes)) throw new Error('Invalid secret length');
  localStorage.setItem(LS_SECRET, _bytesToB64(bytes));
}

// ── Settings-backed cross-device portability (Option A) ────────

async function _fetchSettingsRow(adapter, key) {
  if (!adapter) return null;
  try {
    // All adapters return arrays here — take the first row
    if (adapter.from) {
      const { data } = await adapter.from('settings').select('value').eq('key', key);
      if (Array.isArray(data)) return data[0] || null;
      return data || null;
    }
  } catch { /* ignore */ }
  return null;
}

export async function fetchSecretFromSettings(adapter) {
  const row = await _fetchSettingsRow(adapter, SETTINGS_KEY);
  if (!row || !row.value) return null;
  const bytes = _b64ToBytes(row.value);
  return _isValidSecretBytes(bytes) ? bytes : null;
}

export async function persistSecretToSettings(adapter, secretBytes) {
  if (!adapter) return false;
  const b64 = _bytesToB64(secretBytes);
  try {
    // Try upsert first
    if (adapter.from) {
      const res = await adapter.from('settings').upsert({ key: SETTINGS_KEY, value: b64 });
      // upsert may return error in result, but we check no throw
      if (res && !res.error) return true;
    }
  } catch {}
  try {
    // Fallback: update then insert (pattern used in todos.js)
    const { data } = await adapter.from('settings').update({ value: b64, updated_at: new Date().toISOString() }).eq('key', SETTINGS_KEY).select();
    if (data && (Array.isArray(data) ? data.length > 0 : !!data)) return true;
    const ins = await adapter.from('settings').insert({ key: SETTINGS_KEY, value: b64 });
    return !(ins && ins.error);
  } catch {
    return false;
  }
}

/**
 * Ensure we have a sync secret, with cross-device portability via settings.
 * Flow:
 *   1. LS has valid secret -> return it (and best-effort ensure settings has it)
 *   2. LS missing, settings has -> load settings -> save LS -> return
 *   3. Neither -> generate fresh -> save LS + settings -> return
 */
export async function ensureSyncSecret(adapter) {
  // 1. LS cache
  let secret = getSyncSecretFromLS();
  if (secret) {
    if (adapter) {
      // Best-effort backfill to settings for cross-device (no await needed but we await)
      try { await persistSecretToSettings(adapter, secret); } catch {}
    }
    return secret;
  }
  // 2. Try settings (cross-device)
  if (adapter) {
    try {
      const fromSettings = await fetchSecretFromSettings(adapter);
      if (fromSettings) {
        setSyncSecretBytes(fromSettings);
        return fromSettings;
      }
    } catch {}
  }
  // 3. Generate fresh
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  setSyncSecretBytes(fresh);
  if (adapter) {
    try { await persistSecretToSettings(adapter, fresh); } catch {}
  }
  return fresh;
}

/**
 * Get secret if available (LS or settings) without generating a new one.
 * Used for decryption path where we don't want to overwrite existing secret.
 */
export async function getSyncSecretWithSettings(adapter) {
  let secret = getSyncSecretFromLS();
  if (secret) return secret;
  if (adapter) {
    try {
      const fromSettings = await fetchSecretFromSettings(adapter);
      if (fromSettings) {
        setSyncSecretBytes(fromSettings);
        return fromSettings;
      }
    } catch {}
  }
  return null;
}

// ── Encrypt / Decrypt text with AES-GCM ─────────────────────────

export async function encryptText(plaintext, secretBytes) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await _getKeyFromBytes(secretBytes);
  const enc = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc);
  const ct = new Uint8Array(ctBuf);
  return {
    ciphertext: _bytesToB64(ct),
    iv: _bytesToB64(iv),
  };
}

export async function decryptText(ciphertextB64, ivB64, secretBytes) {
  const ct = _b64ToBytes(ciphertextB64);
  const iv = _b64ToBytes(ivB64);
  if (!ct || !iv) throw new Error('Invalid base64');
  const key = await _getKeyFromBytes(secretBytes);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(ptBuf);
}

// ── Wrap / Unwrap sync_secret with KEK ──────────────────────────

export async function wrapSyncSecret(secretBytes, kekBytes) {
  return encryptText(_bytesToB64(secretBytes), kekBytes);
}

export async function unwrapSyncSecret(wrappedCt, wrappedIv, kekBytes) {
  const b64 = await decryptText(wrappedCt, wrappedIv, kekBytes);
  return _b64ToBytes(b64);
}

// Convenience: store wrapped backup
export async function storeWrappedSecret() {
  const secret = getOrCreateSyncSecret();
  const kek = await getKEK();
  if (!kek) return false;
  const wrapped = await wrapSyncSecret(secret, kek);
  localStorage.setItem(LS_SECRET_WRAPPED, wrapped.ciphertext);
  localStorage.setItem(LS_SECRET_WRAPPED_IV, wrapped.iv);
  return true;
}

export async function loadWrappedSecret() {
  const ct = localStorage.getItem(LS_SECRET_WRAPPED);
  const iv = localStorage.getItem(LS_SECRET_WRAPPED_IV);
  if (!ct || !iv) return null;
  const kek = await getKEK();
  if (!kek) return null;
  try {
    const secret = await unwrapSyncSecret(ct, iv, kek);
    if (secret) {
      localStorage.setItem(LS_SECRET, _bytesToB64(secret));
      return secret;
    }
  } catch { /* decryption failed */ }
  return null;
}

// ── Token hash (client-side, mirrors server SHA256 hex) ─────────
export async function hashTokenClient(token) {
  return sha256Hex(token);
}
