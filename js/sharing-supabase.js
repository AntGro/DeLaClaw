// ===================================================================
// SHARING ADAPTER — SUPABASE (D+E hybrid)
// ===================================================================
//
// Implements the SharingInterface contract for Supabase-hosted groups.
//
// Two access paths:
//   - OWNER (A): authenticated via magic link → direct table access
//     through RLS (auth_owner_id = auth.uid())
//   - MEMBER (B): unauthenticated → RPC functions with bearer token
//     (SECURITY DEFINER, see migration 1.296)
//
// Group data lives on the creator's Supabase project. Members store
// connection details (URL, anon key, token) in their own `joined_groups`
// table so they can reconnect without the invite link.
//
// ===================================================================

/**
 * Create a Supabase sharing adapter.
 *
 * @param {Object} adapter — the user's own Supabase/Drive/Local adapter
 * @param {Object} config
 * @param {Function} config.getAuthUser — () => auth user object or null
 * @param {string}   config.supabaseUrl — project URL (for invite links)
 * @param {string}   config.anonKey — project anon key (for invite links)
 * @returns {Promise<SharingAdapter>}
 */
export async function createSupabaseSharing(adapter, config) {
  const { getAuthUser, supabaseUrl, anonKey } = config;

  // ── Internal state ──────────────────────────────────────────
  let _ownedGroups = [];   // Groups created by this user (on their own Supabase)
  let _joinedGroups = [];  // Groups joined from other Supabase projects
  let _allItems = [];      // Cached shared items across all groups
  let _memberCache = {};   // groupId -> members array
  let _remoteClients = {}; // groupId -> { client, token, memberId }
  let _pollTimer = null;
  let _updateCallbacks = [];
  let _loaded = false;

  const POLL_MS = 30000;

  // ── Helpers ─────────────────────────────────────────────────

  function _uid8() {
    return crypto.randomUUID().slice(0, 8);
  }

  function _notifyUpdate() {
    for (const cb of _updateCallbacks) {
      try { cb(); } catch (e) { console.warn('sharing update callback:', e); }
    }
  }

  /**
   * Create a temporary Supabase client for a remote project.
   * Used by B to talk to A's Supabase.
   */
  function _createRemoteClient(url, key) {
    return window.supabase.createClient(url, key);
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
        email: user.email,
        displayName: user.user_metadata?.display_name || user.email.split('@')[0],
      };
    }
    return { email: 'anonymous', displayName: 'Anonymous' };
  }

  async function createGroup(name) {
    const user = getAuthUser();
    if (!user) throw new Error('Auth required to create groups');

    const groupId = _uid8();
    const creatorMemberId = _uid8();
    const creatorToken = crypto.randomUUID();

    // Direct INSERT (owner, RLS allows)
    const { error: gErr } = await adapter.from('sharing_groups').insert({
      id: groupId,
      name,
      backend_type: 'supabase',
      auth_owner_id: user.id,
    });
    if (gErr) throw new Error('Failed to create group: ' + gErr.message);

    const displayName = user.user_metadata?.display_name || user.email.split('@')[0];
    const { error: mErr } = await adapter.from('sharing_members').insert({
      member_id: creatorMemberId,
      group_id: groupId,
      token: creatorToken,
      display_name: displayName,
      role: 'creator',
      joined_at: new Date().toISOString(),
    });
    if (mErr) throw new Error('Failed to add creator member: ' + mErr.message);

    // Store creator's member_id locally
    localStorage.setItem('claw_member_' + groupId, creatorMemberId);

    const group = {
      id: groupId,
      name,
      backendType: 'supabase',
      createdBy: user.email,
      members: [{
        email: user.email,
        role: 'creator',
        accepted: true,
        memberId: creatorMemberId,
        displayName,
      }],
    };
    _ownedGroups.push(group);
    _memberCache[groupId] = group.members;
    _notifyUpdate();
    return group;
  }

  async function loadAll() {
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

          const memberList = (members || []).map(m => ({
            email: m.display_name || m.member_id,
            role: m.role,
            accepted: m.joined_at != null,
            memberId: m.member_id,
            displayName: m.display_name,
          }));

          _ownedGroups.push({
            id: g.id,
            name: g.name,
            backendType: g.backend_type,
            createdBy: memberList.find(m => m.role === 'creator')?.email || '',
            members: memberList,
          });

          _memberCache[g.id] = memberList;

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
        try {
          const remote = _createRemoteClient(jg.remote_url, jg.remote_anon_key);
          _remoteClients[jg.group_id] = {
            client: remote,
            token: jg.token,
            memberId: jg.member_id,
          };

          const { data: members } = await remote.rpc('get_group_members', {
            p_token: jg.token,
            p_group_id: jg.group_id,
          });

          if (!members || members.length === 0) {
            // Group deleted or token revoked — clean up
            await _cleanupJoinedGroup(jg.group_id);
            continue;
          }

          const memberList = (members || []).map(m => ({
            email: m.display_name || m.member_id,
            role: m.role,
            accepted: m.joined_at != null,
            memberId: m.member_id,
            displayName: m.display_name,
          }));

          _joinedGroups.push({
            id: jg.group_id,
            name: jg.group_name,
            backendType: jg.remote_backend_type,
            createdBy: memberList.find(m => m.role === 'creator')?.email || '',
            members: memberList,
            _isJoined: true,
          });

          _memberCache[jg.group_id] = memberList;

          // Load items
          const { data: items } = await remote.rpc('get_shared_items', {
            p_token: jg.token,
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
    localStorage.removeItem('claw_member_' + groupId);
    _notifyUpdate();
  }

  async function inviteUser(groupId, displayName) {
    const user = getAuthUser();
    if (!user) throw new Error('Auth required to invite');

    const memberId = _uid8();
    const token = crypto.randomUUID();

    const { error } = await adapter.from('sharing_members').insert({
      member_id: memberId,
      group_id: groupId,
      token,
      display_name: displayName || null,
      role: 'member',
      joined_at: null,
    });
    if (error) throw new Error('Failed to invite: ' + error.message);

    // Update local member cache
    if (_memberCache[groupId]) {
      _memberCache[groupId].push({
        email: displayName || memberId,
        role: 'member',
        accepted: false,
        memberId,
        displayName,
      });
    }

    // Update group in owned list
    const group = _ownedGroups.find(g => g.id === groupId);
    if (group) {
      group.members = _memberCache[groupId];
    }

    _notifyUpdate();
    return { memberId, token };
  }

  async function removeUser(groupId, email) {
    // Find the member by email/displayName
    const members = _memberCache[groupId] || [];
    const member = members.find(m =>
      m.email === email || m.displayName === email);
    if (!member) throw new Error('Member not found');
    if (member.role === 'creator') throw new Error('Cannot remove the creator');

    const { error } = await adapter.from('sharing_members')
      .delete().eq('member_id', member.memberId);
    if (error) throw new Error('Failed to remove member: ' + error.message);

    _memberCache[groupId] = members.filter(m => m.memberId !== member.memberId);
    const group = _ownedGroups.find(g => g.id === groupId);
    if (group) group.members = _memberCache[groupId];
    _notifyUpdate();
  }

  async function leaveGroup(groupId) {
    const remote = _getRemote(groupId);
    if (!remote) throw new Error('Not a joined group');

    // Remove self from A's member list via RPC
    await remote.client.rpc('leave_group', { p_token: remote.token });

    // Clean up locally
    await _cleanupJoinedGroup(groupId);
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
    delete _remoteClients[groupId];
  }

  async function tryDirectJoin(connectionRef) {
    // connectionRef format: "supabase:<url>:<anonKey>:<groupId>:<token>"
    // (the "supabase:" prefix is already stripped by the caller)
    const parts = connectionRef.split(':');
    if (parts.length < 4) return null;

    // Reconstruct the URL (it may contain colons in https://)
    // Format after prefix strip: <url>:<anonKey>:<groupId>:<token>
    // URL is everything up to the 3rd-from-last colon
    const token = parts[parts.length - 1];
    const gid = parts[parts.length - 2];
    const key = parts[parts.length - 3];
    const url = parts.slice(0, parts.length - 3).join(':');

    if (!url || !key || !gid || !token) return null;

    try {
      const remote = _createRemoteClient(url, key);
      const { data } = await remote.rpc('verify_join_token', { p_token: token });

      if (!data || data.length === 0) return null;

      const info = Array.isArray(data) ? data[0] : data;
      // Store the parsed connection info for the join confirmation step
      _pendingJoin = { url, anonKey: key, groupId: gid, token, info, remote };
      return {
        id: info.group_id,
        name: info.group_name,
        backendType: info.backend_type,
        members: [],
        _pendingJoin: true,
        _suggestedName: info.display_name,
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

    const displayName = fileIds?.displayName || pj.info.display_name || '';

    // Confirm join on remote
    await pj.remote.rpc('confirm_join', {
      p_token: pj.token,
      p_display_name: displayName,
    });

    // Store connection on our own backend
    const authUser = getAuthUser();
    await adapter.from('joined_groups').upsert({
      group_id: pj.groupId,
      member_id: pj.info.member_id,
      token: pj.token,
      display_name: displayName,
      group_name: pj.info.group_name,
      remote_backend_type: 'supabase',
      remote_url: pj.url,
      remote_anon_key: pj.anonKey,
      owner_id: authUser?.id || null,
    });

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

    const memberList = (members || []).map(m => ({
      email: m.display_name || m.member_id,
      role: m.role,
      accepted: m.joined_at != null,
      memberId: m.member_id,
      displayName: m.display_name,
    }));

    const group = {
      id: pj.groupId,
      name: pj.info.group_name,
      backendType: 'supabase',
      createdBy: memberList.find(m => m.role === 'creator')?.email || '',
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

  async function unjoinGroup(groupId) {
    await leaveGroup(groupId);
  }

  // ── Queries ─────────────────────────────────────────────────

  function getAllGroups() {
    return [..._ownedGroups, ..._joinedGroups];
  }

  function getAllSharedItems() {
    return _allItems;
  }

  function getItems(groupId, itemType) {
    return _allItems.filter(i =>
      i.group_id === groupId && (!itemType || i.item_type === itemType));
  }

  function getGroupByFolderId(connectionRef) {
    // For Supabase, connectionRef is the groupId
    return getAllGroups().find(g => g.id === connectionRef);
  }

  function getInviteLink(groupId) {
    if (!supabaseUrl || !anonKey) return null;
    return location.origin + location.pathname
      + '#join=supabase:' + encodeURIComponent(supabaseUrl)
      + ':' + anonKey + ':' + groupId;
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
    // Check if this is an owned group
    if (_ownedGroups.some(g => g.id === groupId)) {
      const memberId = localStorage.getItem('claw_member_' + groupId);
      return { type: 'direct', memberId };
    }
    throw new Error('Group not found: ' + groupId);
  }

  async function addItem(groupId, itemData) {
    const w = await _getItemWriter(groupId);
    const itemId = itemData.id || _uid8();
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
      done_by: [doneBy || getCurrentUser().email],
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
    return addItem(groupId, {
      item_type: 'habit',
      payload: habitData,
    });
  }

  async function updateSharedHabit(groupId, sharedId, changes) {
    return updateItem(groupId, sharedId, { payload: changes });
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
    return addItem(groupId, {
      item_type: 'habit_completion',
      parent_item_id: sharedId,
      payload: completion,
    });
  }

  // ── Sync ────────────────────────────────────────────────────

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
            const ml = members.map(m => ({
              email: m.display_name || m.member_id,
              role: m.role,
              accepted: m.joined_at != null,
              memberId: m.member_id,
              displayName: m.display_name,
            }));
            group.members = ml;
            _memberCache[group.id] = ml;
          }

          if (items) {
            const old = _allItems.filter(i => i.group_id === group.id);
            const newItems = items.map(it => _mapItem(it));
            if (JSON.stringify(old) !== JSON.stringify(newItems)) {
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

      try {
        const { data: members } = await remote.client.rpc('get_group_members', {
          p_token: remote.token,
          p_group_id: group.id,
        });

        if (!members || members.length === 0) {
          // Group deleted or token revoked
          await _cleanupJoinedGroup(group.id);
          changed = true;
          continue;
        }

        const ml = members.map(m => ({
          email: m.display_name || m.member_id,
          role: m.role,
          accepted: m.joined_at != null,
          memberId: m.member_id,
          displayName: m.display_name,
        }));
        group.members = ml;
        _memberCache[group.id] = ml;

        const { data: items } = await remote.client.rpc('get_shared_items', {
          p_token: remote.token,
          p_group_id: group.id,
        });

        if (items) {
          const old = _allItems.filter(i => i.group_id === group.id);
          const newItems = items.map(it => _mapItem(it));
          if (JSON.stringify(old) !== JSON.stringify(newItems)) {
            _allItems = _allItems.filter(i => i.group_id !== group.id);
            _allItems.push(...newItems);
            changed = true;
          }
        }
      } catch (e) { console.warn('sharing poll joined', group.id, e); }
    }

    if (changed) _notifyUpdate();
  }

  async function forceSave() {
    // Supabase writes are immediate — nothing to flush
  }

  function destroy() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    _updateCallbacks = [];
    _remoteClients = {};
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(
      () => poll().catch(e => console.warn('sharing poll:', e)),
      POLL_MS,
    );
  }

  function onUpdate(fn) {
    _updateCallbacks.push(fn);
  }

  // ── Return adapter ──────────────────────────────────────────

  return {
    getCurrentUser,
    createGroup,
    loadAll,
    deleteGroup,
    inviteUser,
    removeUser,
    leaveGroup,
    tryDirectJoin,
    joinWithFileIds,
    unjoinGroup,
    getAllGroups,
    getAllSharedItems,
    getItems,
    getGroupByFolderId,
    getInviteLink,
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
    onUpdate,
    openJoinPicker: null,
  };
}
