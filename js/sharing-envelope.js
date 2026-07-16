// sharing-envelope.js — base64url JSON envelope for invite links
// Fixes sec-003 + bug-003: replaces fragile colon-split with versioned envelope
// Format: base64url( JSON.stringify({ v, b, u, k, g, t }) )
// v = version (1), b = backend ('supabase'), u = url, k = anonKey, g = groupId, t = token
// No backward compat with legacy colon format per user decision — envelope only.

export function encodeInviteEnvelope(payload) {
  try {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  } catch (e) {
    console.warn('encodeInviteEnvelope failed', e);
    return null;
  }
}

export function decodeInviteEnvelope(str) {
  if (!str || typeof str !== 'string') return null;
  if (str.includes(':')) return null; // not envelope (Drive folderIds never contain ':')
  if (str.length < 20) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  try {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== 1) return null;
    if (!obj.g) return null;
    if (obj.b !== 'supabase') return null;
    return obj;
  } catch {
    return null;
  }
}
