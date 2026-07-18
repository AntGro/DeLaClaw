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
//   - For migration: fallback to plaintext token columns if ciphertext
//     missing or decryption fails.
//
// All ops use WebCrypto (async). No external deps.

const LS_SECRET = 'claw_sync_secret';
const LS_SECRET_WRAPPED = 'claw_sync_secret_wrapped';
const LS_SECRET_WRAPPED_IV = 'claw_sync_secret_wrapped_iv';

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

// ── Sync secret management ──────────────────────────────────────

export function getOrCreateSyncSecret() {
  let b64 = localStorage.getItem(LS_SECRET);
  if (b64) {
    const bytes = _b64ToBytes(b64);
    if (bytes && bytes.length === 32) return bytes;
  }
  // Generate new 32-byte secret
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  localStorage.setItem(LS_SECRET, _bytesToB64(fresh));
  return fresh;
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

// ── KEK from refresh_token ──────────────────────────────────────

export function getRefreshToken() {
  // Supabase stores session in localStorage as sb-<ref>-auth-token
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const token = parsed?.refresh_token || parsed?.currentSession?.refresh_token || null;
        if (token) return token;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export async function getKEK() {
  const rt = getRefreshToken();
  if (!rt) return null;
  return _sha256Bytes(rt); // 32 bytes
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
