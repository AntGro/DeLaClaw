// sharing-envelope.js — obfuscated invite-code envelope
// Format: DLC1.<base64url(JSON.stringify({ v, b, ... }))>
// v = version (1)
// b = backend ('googledrive'; 'supabase' only decodes legacy invites, which are rejected as unsupported)
// Supabase payload (legacy, rejected downstream): { v:1, b:'supabase', u, k, g, t, x? }
//   u = remote Supabase URL, k = anon key, g = groupId, t = member token, x = expires_at
// Drive payload: { v:1, b:'googledrive', f }
//   f = shared Drive folderId
// This is an opaque access code, not encryption. For Drive, access control is
// enforced by Drive folder permissions plus the trusted-contacts allowlist.

const INVITE_CODE_PREFIX = 'DLC1.';
const INVITE_CODE_RE = /^DLC1\.([A-Za-z0-9_-]+)$/;

function base64urlEncode(json) {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeInviteEnvelope(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const normalized = { ...payload, v: 1 };
    if (!normalized.b) return null;
    const json = JSON.stringify(normalized);
    return INVITE_CODE_PREFIX + base64urlEncode(json);
  } catch (e) {
    console.warn('encodeInviteEnvelope failed', e);
    return null;
  }
}

export function decodeInviteEnvelope(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  const m = trimmed.match(INVITE_CODE_RE);
  if (!m) return null;
  try {
    const json = base64urlDecode(m[1]);
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== 1) return null;
    if (obj.b === 'supabase') {
      if (!obj.u || !obj.k || !obj.g || !obj.t) return null;
      return obj;
    }
    if (obj.b === 'googledrive') {
      if (!obj.f) return null;
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

export function isInviteCode(str) {
  return !!decodeInviteEnvelope(str);
}
