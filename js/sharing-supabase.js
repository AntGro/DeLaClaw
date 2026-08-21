// ===================================================================
// SHARING ADAPTER — SUPABASE (D+E hybrid)
// ===================================================================
//
// Implements the SharingInterface contract for Supabase-hosted groups.
//
// Two access paths:
//   - OWNER (A): authenticated via magic link → direct table access
//     through RLS (auth_owner_id = auth.uid())
//   - MEMBER (B): unauthenticated → RPC functions with Bearer <redacted>
//     (SECURITY DEFINER, see migration 1.296)
//
// Group data lives on the creator's Supabase project. Members store
// connection details (URL, anon key, token) in their own `joined_groups`
// table so they can reconnect without the invite code.
//
// Invite code format (sec-003/sec-005): DLC1.<base64url JSON envelope>
// Payload: {v:1,b:'supabase',u,k,g,t,x}; opaque/obfuscated access code, not encryption.
// ===================================================================

import { encodeInviteEnvelope, decodeInviteEnvelope } from './sharing-envelope.js';
import { ensureSyncSecret, getSyncSecretWithSettings, encryptText, decryptText, hashTokenClient, getKEK, storeWrappedSecret } from './crypto-sync.js';
import { deepEqual } from './utils.js';

/**
 * Create a Supabase sharing adapter.
 *
 * @param {Object} adapter — the user's own Supabase/Drive/Local adapter
 * @param {Object} config
 * @param {Function} config.getAuthUser — () => auth user object or null
 * @param {string}   config.supabaseUrl — project URL (for invite codes)
 * @param {string}   config.anonKey — project anon key (for invite codes)
 * @returns {Promise<SharingAdapter>}
 */
export async function createSupabaseSharing(adapter, config) {
  const { getAuthUser, supabaseUrl, anonKey } = config;

  // ── Internal state ──────────────────────────────────────────
  let _ownedGroups = [];   // Groups created by this user (on their own Supabase)
  let _joinedGroups = [];  // Groups joined from other Supabase projects
  let _allItems = [];      // Cached shared items across all groups
  let _memberCache = {};   // groupId -> active+pending members array
  let _revokedCache = {};  // groupId -> revoked members array
  let _remoteClients = {}; // groupId -> { client, token, memberId }
  let _groupNameCache = {}; // groupId -> name (survives group deletion)
  let _groupHealth = {};   // groupId -> health tracking state
  let _pollTimer = null;
  let _realtimeChannel = null;
  let _updateCallbacks = [];
  let _loaded = false;

  const POLL_MS = 30000;
  const GRACE_CONSECUTIVE = 3;       // empty responses before confirmation
  const GRACE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  const TOKEN_REVOKED_CONSECUTIVE = 2;
  const BACKOFF_INITIAL_MS = 30000;
  const BACKOFF_CAP_MS = 5 * 60 * 1000;
  const BACKOFF_STOP_AFTER = 3;      // stop polling after N attempts at cap

  // ── Group health tracking ─────────────────────────────────────

  function _initGroupHealth(groupId) {
    if (!_groupHealth[groupId]) {
      _groupHealth[groupId] = {
        status: 'healthy',
        consecutiveEmpty: 0,
        consecutive401: 0,
        lastHealthyAt: Date.now(),
        backoffMs: BACKOFF_INITIAL_MS,
        attemptsAtCap: 0,
        pollStopped: false,
        nextPollAt: 0,
        unreachableNotified: false,
      };
    }
    return _groupHealth[groupId];
  }

  function _markHealthy(groupId) {
    const h = _initGroupHealth(groupId);
    const wasUnhealthy = h.status !== 'healthy';
    h.status = 'healthy';
    h.consecutiveEmpty = 0;
    h.consecutive401 = 0;
    h.lastHealthyAt = Date.now();
    h.backoffMs = BACKOFF_INITIAL_MS;
    h.attemptsAtCap = 0;
    h.pollStopped = false;
    h.nextPollAt = 0;
    h.unreachableNotified = false;
    if (wasUnhealthy) {
      _notifyUpdate();
      // Dismiss any pending confirmation
      try { document.dispatchEvent(new CustomEvent('sharing-group-recovered', { detail: { groupId } })); } catch {}
    }
  }

  /**
   * Classify an RPC error as UNREACHABLE or TOKEN_REVOKED.
   * supabase-js may return { data, error } or throw.
   */
  function _classifyRpcError(error) {
    if (!error) return 'UNREACHABLE';
    const status = error.status || error.code;
    const msg = String(error.message || '').toLowerCase();
    if (status === 401 || status === 403 ||
        msg.includes('401') || msg.includes('403') ||
        msg.includes('unauthorized') || msg.includes('forbidden')) {
      return 'TOKEN_REVOKED';
    }
    return 'UNREACHABLE';
  }

  function _handleUnreachable(groupId) {
    const h = _initGroupHealth(groupId);
    if (h.status === 'pending_confirmation') return; // don't overwrite pending confirmation
    h.status = 'unreachable';
    // Apply exponential backoff
    if (h.backoffMs >= BACKOFF_CAP_MS) {
      h.attemptsAtCap++;
      if (h.attemptsAtCap >= BACKOFF_STOP_AFTER) {
        h.pollStopped = true;
      }
    } else {
      h.backoffMs = Math.min(h.backoffMs * 2, BACKOFF_CAP_MS);
    }
    h.nextPollAt = Date.now() + h.backoffMs;
    // Notify UI on first detection only
    if (!h.unreachableNotified) {
      h.unreachableNotified = true;
      const groupName = _groupName(groupId);
      try { document.dispatchEvent(new CustomEvent('sharing-group-unreachable', { detail: { groupId, groupName } })); } catch {}
    }
    _notifyUpdate();
  }

  function _handlePossiblyDeleted(groupId) {
    const h = _initGroupHealth(groupId);
    h.consecutiveEmpty++;
    const cooldownElapsed = (Date.now() - h.lastHealthyAt) >= GRACE_COOLDOWN_MS;
    if (h.consecutiveEmpty >= GRACE_CONSECUTIVE && cooldownElapsed) {
      h.status = 'pending_confirmation';
      const groupName = _groupName(groupId);
      try { document.dispatchEvent(new CustomEvent('sharing-group-deletion-confirm', { detail: { groupId, groupName } })); } catch {}
    } else {
      h.status = 'possibly_deleted';
    }
    _notifyUpdate();
  }

  function _handleTokenRevoked(groupId) {
    const h = _initGroupHealth(groupId);
    h.consecutive401++;
    if (h.consecutive401 >= TOKEN_REVOKED_CONSECUTIVE) {
      // Immediate cleanup — token revocation is intentional
      h.status = 'token_revoked';
      const groupName = _groupName(groupId);
      _cleanupJoinedGroup(groupId);
      try { document.dispatchEvent(new CustomEvent('sharing-group-removed-remotely', { detail: { groupName } })); } catch {}
    } else {
      h.status = 'unreachable';
      _notifyUpdate();
    }
  }

  function _shouldPollGroup(groupId) {
    const h = _groupHealth[groupId];
    if (!h) return true;
    if (h.pollStopped) return false;
    if (h.status === 'pending_confirmation') return false;
    return Date.now() >= h.nextPollAt;
  }

  function getGroupHealthStatus(groupId) {
    const h = _groupHealth[groupId];
    if (!h) return 'healthy';
    return h.status;
  }

  /** Called by UI when user confirms deletion of a group in pending_confirmation state. */
  async function confirmGroupDeletion(groupId) {
    const groupName = _groupName(groupId);
    await _cleanupJoinedGroup(groupId);
    delete _groupHealth[groupId];
    try { document.dispatchEvent(new CustomEvent('sharing-group-removed-remotely', { detail: { groupName } })); } catch {}
    _notifyUpdate();
  }

  /** Called by UI when user wants to keep a group in pending_confirmation state. */
  function keepGroup(groupId) {
    const h = _initGroupHealth(groupId);
    h.status = 'unreachable';
    h.consecutiveEmpty = 0;
    h.consecutive401 = 0;
    h.backoffMs = BACKOFF_INITIAL_MS;
    h.attemptsAtCap = 0;
    h.pollStopped = false;
    h.nextPollAt = 0;
    h.unreachableNotified = false;
    _notifyUpdate();
  }

  // ── Helpers ─────────────────────────────────────────────────

  /** Split normalized member list and cache active vs revoked. */
  function _cacheMembers(groupId, allNormalized) {
    const active = allNormalized.filter(m => m.status !== 'revoked');
    const revoked = allNormalized.filter(m => m.status === 'revoked');
    _memberCache[groupId] = active;
    _revokedCache[groupId] = revoked;
    return active;
  }

  function _uid8() {
    return crypto.randomUUID().slice(0, 8);
  }

  function _notifyUpdate() {
    for (const cb of _updateCallbacks) {
      try { cb(); } catch (e) { console.warn('sharing update callback:', e); }
    }
  }

  async function _hashToken(token) {
    try { return await hashTokenClient(token); } catch { return null; }
  }

  function _fallbackDisplayName(value, fallback = 'Member') {
    const v = String(value || '').trim();
    if (!v) return fallback;
    return v.includes('@') ? v.split('@')[0] : v;
  }

  function _normalizeMember(row = {}) {
    const memberId = row.member_id || row.memberId || row.id || _uid8();
    const role = row.role || 'member';
    const joinedAt = row.joined_at ?? row.joinedAt ?? null;
    const revokedAt = row.revoked_at ?? row.revokedAt ?? null;
    const invitedLabel = row.invited_label ?? row.invitedLabel ?? null;
    const rawDisplay = row.display_name ?? row.displayName ?? row.name ?? null;
    const displayName = _fallbackDisplayName(rawDisplay || invitedLabel || memberId);
    return {
      memberId,
      role,
      status: revokedAt ? 'revoked' : (joinedAt ? 'joined' : 'pending'),
      displayName,
      invitedLabel,
      joinedAt,
      authUserId: row.auth_user_id || row.authUserId || null,
      token: row.token || null,
    };
  }

  function _publicMember(member, { includeInviteToken = false } = {}) {
    const m = _normalizeMember(member);
    const out = {
      memberId: m.memberId,
      role: m.role,
      status: m.status,
      displayName: m.displayName,
      invitedLabel: m.invitedLabel,
      joinedAt: m.joinedAt,
    };
    if (includeInviteToken && m.token) out.token = m.token;
    return out;
  }

  function _safeGroup(group, opts = {}) {
    if (!group) return null;
    return {
      id: group.id,
      name: group.name,
      backendType: group.backendType,
      created_by: typeof group.created_by === 'string'
        ? group.created_by
        : (group.created_by?.memberId || group.members?.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null),
      members: (group.members || []).map(m => _publicMember(m, opts)),
      ...(group.folderId ? { folderId: group.folderId } : {}),
      ...(group._isJoined ? { _isJoined: true } : {}),
    };
  }

  function _normalizeDoneBy(doneBy, groupId = null) {
    if (Array.isArray(doneBy)) return doneBy.filter(Boolean);
    if (doneBy) return [doneBy];
    return [getCurrentMember(groupId)?.memberId].filter(Boolean);
  }

  async function _encryptForJoined(token, anonKey) {
    // Option A (1.397): secret synced via settings for cross-device portability
    const secret = await ensureSyncSecret(adapter);
    const encTok = await encryptText(token, secret);
    const encKey = await encryptText(anonKey, secret);
    // Best-effort wrap backup with KEK (legacy, still useful)
    try { await storeWrappedSecret(); } catch {}
    return {
      token_ciphertext: encTok.ciphertext,
      token_iv: encTok.iv,
      remote_anon_key_ciphertext: encKey.ciphertext,
      remote_anon_key_iv: encKey.iv,
    };
  }

  async function _decryptJoinedRow(row) {
    // Option A: try LS, then settings (cross-device), no plaintext fallback
    let token = null;
    let anonKey = null;
    try {
      const secret = await getSyncSecretWithSettings(adapter);
      if (!secret) return { token: null, anonKey: null };
      if (row.token_ciphertext && row.token_iv) {
        token = await decryptText(row.token_ciphertext, row.token_iv, secret);
      }
      if (row.remote_anon_key_ciphertext && row.remote_anon_key_iv) {
        anonKey = await decryptText(row.remote_anon_key_ciphertext, row.remote_anon_key_iv, secret);
      }
    } catch (e) {
      console.warn('sharing decrypt failed', e);
    }
    return { token, anonKey };
  }

  /**
   * Create a temporary Supabase client for a remote project.
   * Used by B to talk to A's Supabase.
   */
  function _createRemoteClient(url, key) {
    return window.supabase.createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  function _getRemote(groupId) {
    return _remoteClients[groupId] || null;
  }

  /**
   * Determine if this user is the owner (has auth) — if so, they
   * access their own sharing tables directly.
   */
  function _isOwner() {
    return !!getAuthUser();
  }

  // ── Interface methods ───────────────────────────────────────

  function getCurrentUser() {
    const user = getAuthUser();
    if (user) {
      return {
        backendUserId: user.id,
        displayName: user.user_metadata?.display_name || _fallbackDisplayName(user.email, 'Member'),
      };
    }
    return { displayName: 'Anonymous' };
  }

  async function getCurrentMemberId(groupId) {
    try {
      const w = await _getItemWriter(groupId);
      return w.memberId || null;
    } catch {
      return null;
    }
  }

  async function createGroup(name) {
    const user = getAuthUser();
    if (!user) throw new Error('Auth required to create groups');

    const groupId = _uid8();
    const creatorMemberId = _uid8(); // 1.401 fix: keep random globally-unique PK, use auth_user_id for stable lookup
    const creatorToken = crypto.randomUUID();
    const creatorHash = await _hashToken(creatorToken);

    // Direct INSERT (owner, RLS allows)
    const { error: gErr } = await adapter.from('sharing_groups').insert({
      id: groupId,
      name,
      backend_type: 'supabase',
      auth_owner_id: user.id,
    });
    if (gErr) throw new Error('Failed to create group: ' + gErr.message);

    const displayName = user.user_metadata?.display_name || user.email.split('@')[0];
    // Build payload without expires_at (creator never expires, column may not exist pre-1.301)
    // Try with token_hash first, fallback without for older schemas.
    let memberPayload = {
      member_id: creatorMemberId,
      group_id: groupId,
      token: creatorToken,
      token_hash: creatorHash,
      display_name: displayName,
      invited_label: displayName,
      role: 'creator',
      joined_at: new Date().toISOString(),
      auth_user_id: user.id,
    };
    let { error: mErr } = await adapter.from('sharing_members').insert(memberPayload);
    if (mErr && /invited_label/i.test(mErr.message || '')) {
      delete memberPayload.invited_label;
      const retry = await adapter.from('sharing_members').insert(memberPayload);
      mErr = retry.error;
    }
    if (mErr && /token_hash/i.test(mErr.message || '')) {
      // Schema <1.301 — column missing, retry without token_hash/expires_at
      delete memberPayload.token_hash;
      delete memberPayload.expires_at;
      const retry = await adapter.from('sharing_members').insert(memberPayload);
      mErr = retry.error;
    }
    if (mErr && /auth_user_id/i.test(mErr.message || '')) {
      // Pre-1.399 schema — column missing, retry without it (will be backfilled by migration)
      delete memberPayload.auth_user_id;
      const retry = await adapter.from('sharing_members').insert(memberPayload);
      mErr = retry.error;
    }
    if (mErr) throw new Error('Failed to add creator member: ' + mErr.message + (/(?:expires_at|token_hash|revoked_at|auth_user_id)/i.test(mErr.message || '') ? ' — schema mismatch, run pending migrations from the banner' : ''));

    const creatorMember = _normalizeMember({
      member_id: creatorMemberId,
      role: 'creator',
      joined_at: new Date().toISOString(),
      auth_user_id: user.id,
      display_name: displayName,
      invited_label: displayName,
    });
    const group = {
      id: groupId,
      name,
      backendType: 'supabase',
      created_by: creatorMemberId,
      members: [creatorMember],
    };
    _ownedGroups.push(group);
    _groupNameCache[groupId] = name;
    _memberCache[groupId] = group.members;
    _notifyUpdate();
    return group;
  }

  async function loadAll() {
    // 1.399 breaking cleanup: purge legacy LS keys (creator attribution now DB-backed)
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('claw_member_')) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }

    // 1. Load owned groups (direct table access, requires auth)
    if (_isOwner()) {
      const { data: groups } = await adapter.from('sharing_groups').select('*');
      if (groups) {
        _ownedGroups = [];
        for (const g of groups) {
          const { data: members } = await adapter.from('sharing_members')
            .select('*').eq('group_id', g.id);
          const { data: items } = await adapter.from('sharing_items')
            .select('*').eq('group_id', g.id);

          const allNormalized = (members || []).map(m => _normalizeMember(m));
          const creatorMemberId = allNormalized.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null;
          const activeMembers = _cacheMembers(g.id, allNormalized);
          _ownedGroups.push({
            id: g.id,
            name: g.name,
            backendType: g.backend_type,
            created_by: creatorMemberId,
            members: activeMembers,
          });
          _groupNameCache[g.id] = g.name;

          // Merge items
          if (items) {
            _allItems = _allItems.filter(i => i.group_id !== g.id);
            for (const it of items) {
              _allItems.push(_mapItem(it));
            }
          }
        }
      }
    }

    // 2. Load joined groups from local joined_groups table
    const { data: joined } = await adapter.from('joined_groups').select('*');
    if (joined && joined.length > 0) {
      _joinedGroups = [];
      for (const jg of joined) {
        // loadAll always tries all groups (reset pollStopped for fresh page load)
        const h = _initGroupHealth(jg.group_id);
        h.pollStopped = false;

        try {
          const { token, anonKey } = await _decryptJoinedRow(jg);
          if (!token || !anonKey) {
            console.warn('sharing: missing token/anonKey for joined group', jg.group_id);
            continue;
          }
          const remote = _createRemoteClient(jg.remote_url, anonKey);
          _remoteClients[jg.group_id] = {
            client: remote,
            token,
            memberId: jg.member_id,
          };

          let members = null;
          let rpcError = null;
          try {
            const result = await remote.rpc('get_group_members', {
              p_token: token,
              p_group_id: jg.group_id,
            });
            members = result.data;
            rpcError = result.error;
          } catch (fetchErr) {
            // Network-level failure (503, timeout, connection refused)
            const errType = _classifyRpcError(fetchErr);
            if (errType === 'TOKEN_REVOKED') {
              _handleTokenRevoked(jg.group_id);
            } else {
              _handleUnreachable(jg.group_id);
            }
            // Keep group in list with stale/empty state
            _groupNameCache[jg.group_id] = jg.group_name;
            _joinedGroups.push({
              id: jg.group_id,
              name: jg.group_name,
              backendType: jg.remote_backend_type,
              created_by: null,
              members: [],
              _isJoined: true,
            });
            continue;
          }

          // RPC returned but with an error object
          if (rpcError) {
            const errType = _classifyRpcError(rpcError);
            if (errType === 'TOKEN_REVOKED') {
              _handleTokenRevoked(jg.group_id);
            } else {
              _handleUnreachable(jg.group_id);
            }
            _groupNameCache[jg.group_id] = jg.group_name;
            _joinedGroups.push({
              id: jg.group_id,
              name: jg.group_name,
              backendType: jg.remote_backend_type,
              created_by: null,
              members: [],
              _isJoined: true,
            });
            continue;
          }

          // Successful RPC but empty members → possibly deleted
          if (!members || members.length === 0) {
            _handlePossiblyDeleted(jg.group_id);
            _groupNameCache[jg.group_id] = jg.group_name;
            _joinedGroups.push({
              id: jg.group_id,
              name: jg.group_name,
              backendType: jg.remote_backend_type,
              created_by: null,
              members: [],
              _isJoined: true,
            });
            continue;
          }

          // Successful response with members — group is healthy
          _markHealthy(jg.group_id);

          const memberList = (members || []).map(m => _normalizeMember(m));
          const creatorMemberId = memberList.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null;
          const activeMembers = _cacheMembers(jg.group_id, memberList);
          _joinedGroups.push({
            id: jg.group_id,
            name: jg.group_name,
            backendType: jg.remote_backend_type,
            created_by: creatorMemberId,
            members: activeMembers,
            _isJoined: true,
          });
          _groupNameCache[jg.group_id] = jg.group_name;

          // Load items
          const { data: items } = await remote.rpc('get_shared_items', {
            p_token: token,
            p_group_id: jg.group_id,
          });
          if (items) {
            _allItems = _allItems.filter(i => i.group_id !== jg.group_id);
            for (const it of items) {
              _allItems.push(_mapItem(it));
            }
          }
        } catch (e) {
          console.warn('sharing: failed to load joined group', jg.group_id, e);
          _handleUnreachable(jg.group_id);
          _groupNameCache[jg.group_id] = jg.group_name;
          _joinedGroups.push({
            id: jg.group_id,
            name: jg.group_name,
            backendType: jg.remote_backend_type,
            created_by: null,
            members: [],
            _isJoined: true,
          });
        }
      }
    }

    _loaded = true;
  }

  function _mapItem(row) {
    const p = row.payload || {};
    return {
      id: row.item_id,
      group_id: row.group_id,
      item_type: row.item_type,
      payload: p,
      assignees: p.assignees || [],
      done: !!p.done,
      done_by: p.done_by || [],
      done_at: p.done_at || null,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      parent_item_id: row.parent_item_id,
    };
  }

  async function deleteGroup(groupId) {
    // Only owner can delete
    const { error } = await adapter.from('sharing_groups')
      .delete().eq('id', groupId);
    if (error) throw new Error('Failed to delete group: ' + error.message);

    _ownedGroups = _ownedGroups.filter(g => g.id !== groupId);
    _allItems = _allItems.filter(i => i.group_id !== groupId);
    delete _memberCache[groupId];
    delete _revokedCache[groupId];

    // Clear shared pointers on local items so they revert to personal
    const nullShared = { shared_id: null, shared_group_id: null };
    await adapter.from('habits').update(nullShared).eq('shared_group_id', groupId);
    await adapter.from('todos').update(nullShared).eq('shared_group_id', groupId);
    await adapter.from('list_items').update(nullShared).eq('shared_group_id', groupId);

    _notifyUpdate();
  }

  async function inviteUser(groupId, displayName) {
    const user = getAuthUser();
    if (!user) throw new Error('Auth required to invite');

    const memberId = _uid8();
    const token = crypto.randomUUID();
    const tokenHash = await _hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    let payload = {
      member_id: memberId,
      group_id: groupId,
      token,
      token_hash: tokenHash,
      display_name: null,
      invited_label: displayName || null,
      role: 'member',
      joined_at: null,
      expires_at: expiresAt,
      auth_user_id: null,
    };
    let { error } = await adapter.from('sharing_members').insert(payload);
    if (error && /invited_label/i.test(error.message || '')) {
      payload.display_name = payload.invited_label;
      delete payload.invited_label;
      const r1 = await adapter.from('sharing_members').insert(payload);
      error = r1.error;
    }
    if (error && /expires_at/i.test(error.message || '')) {
      // Pre-1.301 schema has no expires_at / token_hash — retry with stripped columns
      delete payload.expires_at;
      const r2 = await adapter.from('sharing_members').insert(payload);
      error = r2.error;
    }
    if (error && /token_hash/i.test(error.message || '')) {
      delete payload.token_hash;
      delete payload.expires_at;
      // token_hash also missing implies older schema; retry minimal
      let minimal = {
        member_id: memberId,
        group_id: groupId,
        token,
        display_name: displayName || null,
        role: 'member',
        joined_at: null,
      };
      const r3 = await adapter.from('sharing_members').insert(minimal);
      error = r3.error;
    }
    if (error && /auth_user_id/i.test(error.message || '')) {
      delete payload.auth_user_id;
      const r4 = await adapter.from('sharing_members').insert(payload);
      error = r4.error;
    }
    if (error) throw new Error('Failed to invite: ' + error.message + (/(?:expires_at|token_hash|auth_user_id)/i.test(error.message || '') ? ' — schema mismatch, run pending migrations' : ''));

    // Update local member cache
    if (_memberCache[groupId]) {
      _memberCache[groupId].push(_normalizeMember({
        member_id: memberId,
        role: 'member',
        joined_at: null,
        invited_label: displayName || null,
        display_name: null,
        token,
      }));
    }

    // Update group in owned list
    const group = _ownedGroups.find(g => g.id === groupId);
    if (group) {
      group.members = _memberCache[groupId];
    }

    _notifyUpdate();
    const inviteCode = getMemberInviteLink(groupId, token, expiresAt);
    return { memberId, token, expiresAt, inviteCode };
  }

  async function removeUser(groupId, memberId) {
    const members = _memberCache[groupId] || [];
    const member = members.find(m => m.memberId === memberId);
    if (!member) throw new Error('Member not found');
    if (member.role === 'creator') throw new Error('Cannot remove the creator');

    const { error: revokeErr } = await adapter.rpc('revoke_member', {
      p_group_id: groupId,
      p_member_id: member.memberId,
    });
    if (revokeErr) {
      // Fallback for old servers: delete directly (will fail under RLS if not owner, but try)
      const { error } = await adapter.from('sharing_members')
        .delete().eq('member_id', member.memberId);
      if (error) throw new Error('Failed to remove member: ' + error.message);
    }

    _memberCache[groupId] = members.filter(m => m.memberId !== member.memberId);
    // Track as revoked for "show removed" toggle
    const revoked = { ...member, status: 'revoked' };
    if (!_revokedCache[groupId]) _revokedCache[groupId] = [];
    _revokedCache[groupId].push(revoked);
    const group = _ownedGroups.find(g => g.id === groupId);
    if (group) group.members = _memberCache[groupId];
    _notifyUpdate();
  }

  async function leaveGroup(groupId) {
    const remote = _getRemote(groupId);
    if (!remote) throw new Error('Not a joined group');

    // RPC reassigns items to creator then deletes member row (atomic)
    await remote.client.rpc('leave_group', { p_token: remote.token });

    // Clean up locally
    await _cleanupJoinedGroup(groupId);
    _notifyUpdate();
  }


  async function updateMyDisplayName(groupId, newName) {
    const remote = _getRemote(groupId);
    if (remote) {
      // Joined member: update via RPC on the owner's Supabase
      await remote.client.rpc('update_member_display_name', { p_token: remote.token, p_display_name: newName });
      // Update local cache
      const members = _memberCache[groupId] || [];
      const me = members.find(m => m.memberId === remote.memberId);
      if (me) me.displayName = newName;
    } else if (_ownedGroups.some(g => g.id === groupId)) {
      // Owner: direct update
      const w = await _getItemWriter(groupId);
      await adapter.from('sharing_members').update({ display_name: newName }).eq('member_id', w.memberId);
      const members = _memberCache[groupId] || [];
      const me = members.find(m => m.memberId === w.memberId);
      if (me) me.displayName = newName;
    }
    _notifyUpdate();
  }

  async function _cleanupJoinedGroup(groupId) {
    // Delete local pointers
    await adapter.from('habits').delete().eq('shared_group_id', groupId);
    await adapter.from('todos').delete().eq('shared_group_id', groupId);
    await adapter.from('list_items').delete().eq('shared_group_id', groupId);

    // Delete joined_groups entry
    await adapter.from('joined_groups').delete().eq('group_id', groupId);

    // Clean internal state
    _joinedGroups = _joinedGroups.filter(g => g.id !== groupId);
    _allItems = _allItems.filter(i => i.group_id !== groupId);
    delete _memberCache[groupId];
    delete _revokedCache[groupId];
    delete _remoteClients[groupId];
    delete _groupHealth[groupId];
  }

  async function tryDirectJoin(connectionRef) {
    // Envelope only (sec-003 fix, no legacy per user decision)
    const parsed = decodeInviteEnvelope(connectionRef);
    if (!parsed || parsed.b !== 'supabase' || !parsed.u || !parsed.k || !parsed.g || !parsed.t) return null;

    const url = parsed.u;
    const key = parsed.k;
    const gid = parsed.g;
    const token = parsed.t;

    try {
      const remote = _createRemoteClient(url, key);
      const { data } = await remote.rpc('verify_join_token', { p_token: token });

      if (!data || data.length === 0) return null;

      const info = Array.isArray(data) ? data[0] : data;
      _pendingJoin = { url, anonKey: key, groupId: gid, token, info, remote };
      return {
        id: info.group_id,
        name: info.group_name,
        backendType: info.backend_type,
        members: [],
        _pendingJoin: true,
        _suggestedName: info.display_name || info.invited_label || '',
        _creatorName: info.creator_name || '',
      };
    } catch (e) {
      console.warn('sharing: tryDirectJoin failed', e);
      return null;
    }
  }

  let _pendingJoin = null;

  async function joinWithFileIds(connectionRef, fileIds) {
    // Not used for Supabase — join is confirmed through tryDirectJoin
    // But we use this as the "confirm join" entry point
    if (!_pendingJoin) throw new Error('No pending join');

    const pj = _pendingJoin;
    _pendingJoin = null;

    const displayName = fileIds?.displayName || pj.info.display_name || pj.info.invited_label || '';

    // Confirm join on remote
    await pj.remote.rpc('confirm_join', {
      p_token: pj.token,
      p_display_name: displayName,
    });

    // Store connection on our own backend — require auth (P0 fix 1.299)
    const authUser = getAuthUser();
    if (!authUser) {
      throw new Error('Auth required to join Supabase groups — sign in first. Anon joins must use localStorage.');
    }
    const encrypted = await _encryptForJoined(pj.token, pj.anonKey);
    const { error: joinedErr } = await adapter.from('joined_groups').upsert({
      group_id: pj.groupId,
      member_id: pj.info.member_id,
      token_ciphertext: encrypted.token_ciphertext || null,
      token_iv: encrypted.token_iv || null,
      display_name: displayName,
      group_name: pj.info.group_name,
      remote_backend_type: 'supabase',
      remote_url: pj.url,
      remote_anon_key_ciphertext: encrypted.remote_anon_key_ciphertext || null,
      remote_anon_key_iv: encrypted.remote_anon_key_iv || null,
      owner_id: authUser.id,
    });
    if (joinedErr) console.error('[DeLaClaw] joined_groups upsert failed:', joinedErr);

    // Set up remote client
    _remoteClients[pj.groupId] = {
      client: pj.remote,
      token: pj.token,
      memberId: pj.info.member_id,
    };

    // Load group data
    const { data: members } = await pj.remote.rpc('get_group_members', {
      p_token: pj.token,
      p_group_id: pj.groupId,
    });

    const memberList = (members || []).map(m => _normalizeMember(m));
    const creatorMemberId = memberList.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null;

    const group = {
      id: pj.groupId,
      name: pj.info.group_name,
      backendType: 'supabase',
      created_by: creatorMemberId,
      members: memberList,
      _isJoined: true,
    };

    _joinedGroups.push(group);
    _memberCache[pj.groupId] = memberList;

    // Load existing items
    const { data: items } = await pj.remote.rpc('get_shared_items', {
      p_token: pj.token,
      p_group_id: pj.groupId,
    });
    if (items) {
      for (const it of items) {
        _allItems.push(_mapItem(it));
      }
    }

    _notifyUpdate();
    return group;
  }

  /**
   * Reconnect an already-joined group to a new remote URL (owner migrated).
   * Updates joined_groups connection details + rebuilds remote client + reloads data.
   * @param {string} groupId
   * @param {string} newUrl - new Supabase project URL
   * @param {string} newAnonKey - new project anon key
   * @param {string} token - member token (same as original)
   */
  async function reconnectGroup(groupId, newUrl, newAnonKey, token) {
    const authUser = getAuthUser();
    if (!authUser) throw new Error('Auth required to reconnect group');

    // Verify the token works on the new remote
    const remote = _createRemoteClient(newUrl, newAnonKey);
    const { data: members } = await remote.rpc('get_group_members', {
      p_token: token,
      p_group_id: groupId,
    });
    if (!members || members.length === 0) {
      throw new Error('Token not valid on new remote — re-invite needed');
    }

    // Update joined_groups with new connection details
    const existing = (await adapter.from('joined_groups').select('*').eq('group_id', groupId)).data?.[0];
    if (!existing) throw new Error('Group not found in joined_groups');

    const encrypted = await _encryptForJoined(token, newAnonKey);
    await adapter.from('joined_groups').update({
      remote_url: newUrl,
      remote_anon_key_ciphertext: encrypted.remote_anon_key_ciphertext || null,
      remote_anon_key_iv: encrypted.remote_anon_key_iv || null,
      token_ciphertext: encrypted.token_ciphertext || null,
      token_iv: encrypted.token_iv || null,
    }).eq('group_id', groupId);

    // Replace remote client
    _remoteClients[groupId] = { client: remote, token, memberId: existing.member_id };

    // Refresh group data in memory
    const memberList = (members || []).map(m => _normalizeMember(m));
    const creatorMemberId = memberList.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null;
    const idx = _joinedGroups.findIndex(g => g.id === groupId);
    const updatedGroup = {
      id: groupId,
      name: existing.group_name,
      backendType: 'supabase',
      created_by: creatorMemberId,
      members: memberList,
      _isJoined: true,
    };
    if (idx >= 0) _joinedGroups[idx] = updatedGroup;
    else _joinedGroups.push(updatedGroup);
    _memberCache[groupId] = memberList;

    // Reload shared items from new remote
    _allItems = _allItems.filter(it => it.groupId !== groupId);
    const { data: items } = await remote.rpc('get_shared_items', { p_token: token, p_group_id: groupId });
    if (items) {
      for (const it of items) _allItems.push(_mapItem(it));
    }

    _notifyUpdate();
    return updatedGroup;
  }

  async function unjoinGroup(groupId) {
    await leaveGroup(groupId);
  }

  // ── Queries ─────────────────────────────────────────────────

  function getAllGroups() {
    return [..._ownedGroups, ..._joinedGroups].map(g => _safeGroup(g, { includeInviteToken: true }));
  }

  function getGroup(groupId) {
    return getAllGroups().find(g => g.id === groupId) || null;
  }

  function getCurrentMember(groupId) {
    const remote = _getRemote(groupId);
    if (remote?.memberId) {
      return (_memberCache[groupId] || []).find(m => m.memberId === remote.memberId) || null;
    }
    const uid = getAuthUser()?.id;
    if (!uid) return null;
    return (_memberCache[groupId] || []).find(m => m.authUserId === uid)
      || (_memberCache[groupId] || []).find(m => m.role === 'creator' || m.role === 'owner')
      || null;
  }

  function getAgentSafeGroup(groupId) {
    const group = [..._ownedGroups, ..._joinedGroups].find(g => g.id === groupId) || null;
    return _safeGroup(group);
  }

  function getAllSharedItems() {
    return _allItems;
  }

  function _groupName(groupId) {
    return getAllGroups().find(g => g.id === groupId)?.name || _groupNameCache[groupId] || '';
  }

  function _normalizeSharedHabit(item) {
    const payload = item.payload || {};
    const childCompletions = _allItems
      .filter(i => i.item_type === 'habit_completion' && i.parent_item_id === item.id)
      .map(i => ({
        ...(i.payload || {}),
        id: i.payload?.id || i.id,
        _item_id: i.id,
        created_by: i.created_by,
        created_at: i.created_at,
        updated_at: i.updated_at,
      }));

    // Legacy Supabase habits may still have their first completions embedded
    // in the habit payload. Keep reading them, but new writes use child items.
    const merged = [];
    const seen = new Set();
    for (const completion of childCompletions) {
      const key = completion.id || completion.completed_at;
      if (key) seen.add(key);
      merged.push(completion);
    }
    for (const completion of (Array.isArray(payload.completions) ? payload.completions : [])) {
      const key = completion.id || completion.completed_at;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(completion);
    }
    merged.sort((a, b) => String(a.completed_at || '').localeCompare(String(b.completed_at || '')));

    return {
      ...payload,
      id: item.id,
      item_type: 'habit',
      group_id: item.group_id,
      group_name: item.group_name || _groupName(item.group_id),
      created_by: payload.created_by || item.created_by,
      created_at: payload.created_at || item.created_at,
      updated_at: item.updated_at || payload.updated_at,
      completions: merged,
      _payload_id: payload.id || null,
      _shared_item: item,
    };
  }

  function getAllSharedHabits() {
    return _allItems
      .filter(i => i.item_type === 'habit')
      .map(_normalizeSharedHabit);
  }

  function getAllSharedTodos() {
    return _allItems.filter(i => i.item_type === 'todo');
  }

  function getAllSharedListItems() {
    return _allItems.filter(i => i.item_type === 'list_item');
  }

  function getItems(groupId, itemType) {
    return _allItems.filter(i =>
      i.group_id === groupId && (!itemType || i.item_type === itemType));
  }

  function getGroupByFolderId(connectionRef) {
    // For Supabase, connectionRef is the groupId (or envelope that contains g)
    // Try envelope first for new links
    const env = decodeInviteEnvelope(connectionRef);
    if (env && env.g) return getAllGroups().find(g => g.id === env.g);
    return getAllGroups().find(g => g.id === connectionRef);
  }

  function getInviteLink(_groupId) {
    // Supabase invites are member-scoped and single-use; there is no reusable group code.
    // Kept for interface compatibility. New code should use getMemberInviteLink.
    return null;
  }

  function getMemberInviteLink(groupId, token, expiresAt = null) {
    if (!supabaseUrl || !anonKey || !token) return null;
    return encodeInviteEnvelope({
      v: 1,
      b: 'supabase',
      u: supabaseUrl,
      k: anonKey,
      g: groupId,
      t: token,
      ...(expiresAt ? { x: expiresAt } : {}),
    });
  }

  function isJoinedViaLink(groupId) {
    return _joinedGroups.some(g => g.id === groupId);
  }

  // ── Item CRUD ───────────────────────────────────────────────

  async function _getItemWriter(groupId) {
    // Owner writes directly, members write via RPC
    const remote = _getRemote(groupId);
    if (remote) {
      return { type: 'rpc', client: remote.client, token: remote.token, memberId: remote.memberId };
    }
    // Owned group — breaking 1.399: lookup memberId via auth_user_id, no localStorage
    if (_ownedGroups.some(g => g.id === groupId)) {
      const uid = getAuthUser()?.id;
      const cache = _memberCache[groupId] || [];
      // Prefer member whose auth_user_id matches current uid, fallback to creator role, fallback to uid itself (for new groups where member_id == uid)
      const found = cache.find(m => m.authUserId === uid) || cache.find(m => m.role === 'creator') || null;
      const memberId = found?.memberId || uid || null;
      if (!memberId) throw new Error('Creator memberId not found — run migrations');
      return { type: 'direct', memberId };
    }
    throw new Error('Group not found: ' + groupId);
  }

  async function addItem(groupId, itemData) {
    const w = await _getItemWriter(groupId);
    const itemId = itemData.id || crypto.randomUUID();
    const payload = itemData.payload || {};

    if (w.type === 'rpc') {
      const { data, error } = await w.client.rpc('add_shared_item', {
        p_token: w.token,
        p_item_id: itemId,
        p_group_id: groupId,
        p_item_type: itemData.item_type,
        p_payload: payload,
        p_member_id: w.memberId,
        p_parent_item_id: itemData.parent_item_id || null,
      });
      if (error) throw new Error('add_shared_item: ' + error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row) {
        const mapped = _mapItem(row);
        _allItems.push(mapped);
        _notifyUpdate();
        return mapped;
      }
    } else {
      const { data, error } = await adapter.from('sharing_items').insert({
        item_id: itemId,
        group_id: groupId,
        item_type: itemData.item_type,
        parent_item_id: itemData.parent_item_id || null,
        payload,
        created_by: w.memberId,
      }).select().single();
      if (error) throw new Error('insert sharing_items: ' + error.message);
      const mapped = _mapItem(data);
      _allItems.push(mapped);
      _notifyUpdate();
      return mapped;
    }
  }

  async function updateItem(groupId, itemId, changes) {
    const w = await _getItemWriter(groupId);
    const existing = _allItems.find(i => i.id === itemId);
    const payload = Object.assign({}, existing?.payload || {}, changes.payload || changes);

    if (w.type === 'rpc') {
      const { error } = await w.client.rpc('update_shared_item', {
        p_token: w.token,
        p_item_id: itemId,
        p_payload: payload,
      });
      if (error) throw new Error('update_shared_item: ' + error.message);
    } else {
      const { error } = await adapter.from('sharing_items')
        .update({ payload, updated_at: new Date().toISOString() })
        .eq('item_id', itemId);
      if (error) throw new Error('update sharing_items: ' + error.message);
    }

    // Update cache
    const idx = _allItems.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      _allItems[idx].payload = payload;
      _allItems[idx].done = !!payload.done;
      _allItems[idx].done_by = payload.done_by || [];
      _allItems[idx].done_at = payload.done_at || null;
      _allItems[idx].updated_at = new Date().toISOString();
    }
    _notifyUpdate();
    return _allItems[idx] || null;
  }

  async function deleteItem(groupId, itemId) {
    const w = await _getItemWriter(groupId);

    if (w.type === 'rpc') {
      const { error } = await w.client.rpc('delete_shared_item', {
        p_token: w.token,
        p_item_id: itemId,
      });
      if (error) throw new Error('delete_shared_item: ' + error.message);
    } else {
      const { error } = await adapter.from('sharing_items')
        .delete().eq('item_id', itemId);
      if (error) throw new Error('delete sharing_items: ' + error.message);
    }

    _allItems = _allItems.filter(i => i.id !== itemId);
    _notifyUpdate();
  }

  async function completeItem(groupId, itemId, doneBy) {
    const existing = _allItems.find(i => i.id === itemId);
    if (!existing) throw new Error('Item not found');
    const payload = Object.assign({}, existing.payload, {
      done: true,
      done_by: _normalizeDoneBy(doneBy, groupId),
      done_at: new Date().toISOString(),
    });
    return updateItem(groupId, itemId, { payload });
  }

  async function uncompleteItem(groupId, itemId) {
    const existing = _allItems.find(i => i.id === itemId);
    if (!existing) throw new Error('Item not found');
    const payload = Object.assign({}, existing.payload, {
      done: false,
      done_by: [],
      done_at: null,
    });
    return updateItem(groupId, itemId, { payload });
  }

  // ── Habit-specific ──────────────────────────────────────────

  async function addSharedHabit(groupId, habitData) {
    const sharedId = habitData.id || crypto.randomUUID();
    const { completions = [], ...habitPayload } = habitData;
    const item = await addItem(groupId, {
      id: sharedId,
      item_type: 'habit',
      payload: { ...habitPayload, id: sharedId, completions: [] },
    });
    for (const completion of completions) {
      await addSharedHabitCompletion(groupId, sharedId, completion);
    }
    return getAllSharedHabits().find(h => h.id === sharedId) || item;
  }

  async function _replaceSharedHabitCompletions(groupId, sharedId, completions) {
    const desired = Array.isArray(completions) ? completions : [];
    const existing = _allItems.filter(i =>
      i.item_type === 'habit_completion' && i.parent_item_id === sharedId);
    const usedItemIds = new Set();

    for (const completion of desired) {
      const completionId = completion.id || crypto.randomUUID();
      const existingItem = existing.find(i =>
        !usedItemIds.has(i.id) && (
          i.id === completionId ||
          i.payload?.id === completionId ||
          (!completion.id && i.payload?.completed_at === completion.completed_at)
        ));
      const payload = { ...completion, id: completionId };
      if (existingItem) {
        usedItemIds.add(existingItem.id);
        await updateItem(groupId, existingItem.id, { payload });
      } else {
        const added = await addItem(groupId, {
          id: completionId,
          item_type: 'habit_completion',
          parent_item_id: sharedId,
          payload,
        });
        usedItemIds.add(added.id);
      }
    }

    for (const item of existing) {
      if (!usedItemIds.has(item.id)) {
        await deleteItem(groupId, item.id);
      }
    }
  }

  async function updateSharedHabit(groupId, sharedId, changes) {
    const { completions, ...habitChanges } = changes || {};
    const existing = _allItems.find(i => i.id === sharedId && i.item_type === 'habit');
    let updated = existing || null;

    if (Object.keys(habitChanges).length > 0 || Object.prototype.hasOwnProperty.call(changes || {}, 'completions')) {
      const payload = { ...(existing?.payload || {}), ...habitChanges };
      // Completions live as child sharing_items on Supabase. Clear any legacy
      // embedded array when completions are rewritten so there is one source.
      if (Object.prototype.hasOwnProperty.call(changes || {}, 'completions')) payload.completions = [];
      updated = await updateItem(groupId, sharedId, { payload });
    }

    if (Object.prototype.hasOwnProperty.call(changes || {}, 'completions')) {
      await _replaceSharedHabitCompletions(groupId, sharedId, completions);
    }

    return getAllSharedHabits().find(h => h.id === sharedId) || updated;
  }

  async function deleteSharedHabit(groupId, sharedId) {
    // Also delete completions for this habit
    const completions = _allItems.filter(
      i => i.parent_item_id === sharedId && i.item_type === 'habit_completion');
    for (const c of completions) {
      await deleteItem(groupId, c.id);
    }
    return deleteItem(groupId, sharedId);
  }

  async function addSharedHabitCompletion(groupId, sharedId, completion) {
    const completionId = completion.id || crypto.randomUUID();
    return addItem(groupId, {
      id: completionId,
      item_type: 'habit_completion',
      parent_item_id: sharedId,
      payload: { ...completion, id: completionId },
    });
  }

  // ── Sync ────────────────────────────────────────────────────

  function _membersChanged(oldMl, ml) {
    if (oldMl.length !== ml.length) return true;
    const oldById = new Map(oldMl.map(m => [m.memberId, m]));
    for (const m of ml) {
      const o = oldById.get(m.memberId);
      if (!o) return true;
      if (o.status !== m.status || o.authUserId !== m.authUserId || o.role !== m.role || o.displayName !== m.displayName || o.invitedLabel !== m.invitedLabel) return true;
    }
    return false;
  }

  function _itemsChanged(old, newItems) {
    if (old.length !== newItems.length) return true;
    const oldById = new Map(old.map(it => [it.id, it]));
    for (const n of newItems) {
      const o = oldById.get(n.id);
      if (!o) return true;
      if (o.group_id !== n.group_id || o.type !== n.type || o.parent_item_id !== n.parent_item_id || o.created_by !== n.created_by) return true;
      if (!deepEqual(o.payload, n.payload)) return true;
    }
    return false;
  }

  async function poll() {
    if (!_loaded) return;
    let changed = false;

    // Poll owned groups
    if (_isOwner()) {
      for (const group of _ownedGroups) {
        try {
          const { data: members } = await adapter.from('sharing_members')
            .select('*').eq('group_id', group.id);
          const { data: items } = await adapter.from('sharing_items')
            .select('*').eq('group_id', group.id);

          if (members) {
            const allNorm = members.map(m => _normalizeMember(m));
            const oldMl = _memberCache[group.id] || [];
            const activeMembers = _cacheMembers(group.id, allNorm);
            if (_membersChanged(oldMl, activeMembers)) {
              changed = true;
            }
            group.members = activeMembers;
          }

          if (items) {
            const old = _allItems.filter(i => i.group_id === group.id);
            const newItems = items.map(it => _mapItem(it));
            if (_itemsChanged(old, newItems)) {
              _allItems = _allItems.filter(i => i.group_id !== group.id);
              _allItems.push(...newItems);
              changed = true;
            }
          }
        } catch (e) { console.warn('sharing poll owned', group.id, e); }
      }
    }

    // Poll joined groups
    for (const group of [..._joinedGroups]) {
      const remote = _getRemote(group.id);
      if (!remote) continue;

      // Respect per-group backoff
      if (!_shouldPollGroup(group.id)) continue;

      try {
        let members = null;
        let rpcError = null;
        try {
          const result = await remote.client.rpc('get_group_members', {
            p_token: remote.token,
            p_group_id: group.id,
          });
          members = result.data;
          rpcError = result.error;
        } catch (fetchErr) {
          const errType = _classifyRpcError(fetchErr);
          if (errType === 'TOKEN_REVOKED') {
            _handleTokenRevoked(group.id);
            changed = true;
          } else {
            _handleUnreachable(group.id);
          }
          continue;
        }

        if (rpcError) {
          const errType = _classifyRpcError(rpcError);
          if (errType === 'TOKEN_REVOKED') {
            _handleTokenRevoked(group.id);
            changed = true;
          } else {
            _handleUnreachable(group.id);
          }
          continue;
        }

        if (!members || members.length === 0) {
          _handlePossiblyDeleted(group.id);
          continue;
        }

        // Successful non-empty response — group is healthy
        _markHealthy(group.id);

        const ml = members.map(m => _normalizeMember(m));
        const oldMl = _memberCache[group.id] || [];
        const activeMembers = _cacheMembers(group.id, ml);
        if (_membersChanged(oldMl, activeMembers)) {
          changed = true;
        }
        group.members = activeMembers;

        const { data: items } = await remote.client.rpc('get_shared_items', {
          p_token: remote.token,
          p_group_id: group.id,
        });

        if (items) {
          const old = _allItems.filter(i => i.group_id === group.id);
          const newItems = items.map(it => _mapItem(it));
          if (_itemsChanged(old, newItems)) {
            _allItems = _allItems.filter(i => i.group_id !== group.id);
            _allItems.push(...newItems);
            changed = true;
          }
        }
      } catch (e) {
        console.warn('sharing poll joined', group.id, e);
        _handleUnreachable(group.id);
      }
    }

    if (changed) _notifyUpdate();
  }

  async function forceSave() {
    // Supabase writes are immediate — nothing to flush
  }

  function destroy() {
    _stopRealtime();
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    _updateCallbacks = [];
    _remoteClients = {};
    _groupHealth = {};
  }

  // ── Realtime (owned groups — instant member/item updates) ───

  let _rtDebounce = null;
  function _realtimePoll() {
    if (_rtDebounce) clearTimeout(_rtDebounce);
    _rtDebounce = setTimeout(() => {
      _rtDebounce = null;
      poll().catch(e => console.warn('realtime poll:', e));
    }, 500);
  }

  function _startRealtime() {
    if (_realtimeChannel || !_isOwner() || !adapter.channel) return;
    try {
      _realtimeChannel = adapter.channel('sharing-realtime')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'sharing_members' },
          () => _realtimePoll())
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'sharing_items' },
          () => _realtimePoll())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.info('sharing: realtime subscribed');
          }
        });
    } catch (e) {
      console.warn('sharing: realtime setup failed, falling back to poll', e);
    }
  }

  function _stopRealtime() {
    if (_realtimeChannel) {
      try { adapter.raw?.removeChannel?.(_realtimeChannel) || _realtimeChannel.unsubscribe(); }
      catch { /* ignore */ }
      _realtimeChannel = null;
    }
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(
      () => poll().catch(e => console.warn('sharing poll:', e)),
      POLL_MS,
    );
    _startRealtime();
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _stopRealtime();
  }

  function onUpdate(fn) {
    _updateCallbacks.push(fn);
  }

  function getRevokedMembers(groupId) {
    return _revokedCache[groupId] || [];
  }

  // ── Return adapter ──────────────────────────────────────────

  return {
    getCurrentUser,
    getCurrentMemberId,
    createGroup,
    loadAll,
    deleteGroup,
    inviteUser,
    removeUser,
    leaveGroup,
    tryDirectJoin,
    joinWithFileIds,
    reconnectGroup,
    unjoinGroup,
    getAllGroups,
    getGroup,
    getGroupName: _groupName,
    getCurrentMember,
    getAgentSafeGroup,
    getAllSharedItems,
    getAllSharedHabits,
    getAllSharedTodos,
    getAllSharedListItems,
    getItems,
    getGroupByFolderId,
    getInviteLink,
    getMemberInviteLink,
    isJoinedViaLink,
    addItem,
    updateItem,
    deleteItem,
    completeItem,
    uncompleteItem,
    addSharedHabit,
    updateSharedHabit,
    deleteSharedHabit,
    addSharedHabitCompletion,
    poll,
    forceSave,
    destroy,
    startPolling,
    stopPolling,
    onUpdate,
    getRevokedMembers,
    updateMyDisplayName,
    isReady() { return _loaded; },
    getGroupHealthStatus,
    confirmGroupDeletion,
    keepGroup,
    openJoinPicker: null,
  };
}
