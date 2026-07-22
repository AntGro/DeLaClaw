// ===================================================================
// DRIVE SHARING ADAPTER — implements SharingInterface for Google Drive
// ===================================================================

import { deepEqual } from './utils.js';
import { encodeInviteEnvelope } from './sharing-envelope.js';
//
// See sharing-interface.js for the abstract contract this implements.
//
// HYBRID MODEL: two ways to join a shared group
//
//   1. LINK JOIN (drive.file scope — default, no scary permissions)
//      A creates group → A invites B by email (shares folder) →
//      A sends B invite code → B pastes code →
//      Google Picker opens → B selects the shared files →
//      Picker grants drive.file access → B saves file IDs in
//      DeLaClaw/joined-groups.json → done.
//
//   2. AUTO-DISCOVERY (full drive scope — opt-in via Settings)
//      A creates group → A invites B → B has A in trusted contacts →
//      B's app auto-discovers via sharedWithMe query → loads group.
//
// Both paths produce the same GroupEntry. A single group can have
// members using either path. Invite codes always work regardless of
// scope.
//
// Scenarios (A=Alice, B=Bob, C=Carol, D=Dave):
//
//   S1: A(file) creates group, invites B(file) via link
//       A creates folder+files (app owns → drive.file OK)
//       A shares folder with B (app owns → OK)
//       A copies invite code → sends to B
//       B pastes invite code → Picker → selects files → joined
//
//   S2: B leaves a joined group
//       B removes from joined-groups.json → polling stops
//       Drive permissions untouched (B still has user-level access
//       but DeLaClaw no longer loads it)
//
// Folder structure (inside the user's Google Drive):
//
//   My Drive/
//   ├── DeLaClaw/                          ← personal data (existing)
//   │   └── joined-groups.json             ← link-joined group refs
//   └── DeLaClaw-Shared/                   ← shared root (one per user)
//       └── DeLaClaw-Shared-{groupId}/     ← per-group subfolder
//           ├── group.json                 ← metadata + member list
//           ├── todos.json                 ← shared todos
//           ├── habits.json                ← shared habits
//           └── lists.json                 ← shared list items
//
// Identity:
//   User email comes from the Drive About API (no extra OAuth scope needed).
//
// Scope:
//   drive.file — app-created files + Picker-granted access for joining.
//
// Trust model:
//   Link join: explicit user consent (clicking a link + using Picker).
//
// ===================================================================

const SHARED_ROOT_NAME = 'DeLaClaw-Shared';
const GROUP_PREFIX     = 'DeLaClaw-Shared-';
const POLL_MS          = 15_000;      // 15s — faster than personal (30s)
const MAX_RETRIES      = 2;
const ITEM_TYPES       = ['todos', 'habits', 'lists'];
const EXTRA_COUNT      = 10;
const EXTRA_FILES      = Array.from({ length: EXTRA_COUNT }, (_, i) => `extra_${i + 1}`);

// ── Drive API helpers (self-contained, no drive.js dependency) ──

async function driveGet(token, url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Drive GET ${res.status}`), { code: res.status });
  return res;
}

async function driveAboutUser(token) {
  const res = await driveGet(token,
    'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink)');
  const { user } = await res.json();
  return { email: user.emailAddress, name: user.displayName || '', photo: user.photoLink || '' };
}

async function driveFindFolder(token, name, parentId) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
  const { files } = await res.json();
  return files?.[0] ?? null;
}

async function driveCreateFolder(token, name, parentId) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw new Error(`Drive createFolder ${res.status}`);
  return res.json();
}

async function driveFindOrCreateFolder(token, name, parentId) {
  return await driveFindFolder(token, name, parentId) ?? await driveCreateFolder(token, name, parentId);
}

async function driveListChildren(token, folderId, mime) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (mime) q += ` and mimeType='${mime}'`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=200&orderBy=name`);
  const { files } = await res.json();
  return files || [];
}

/**
 * Find a file by name inside a folder.
 * Works for both owned and shared-with-me files.
 */
async function driveFindFile(token, folderId, fileName) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=1`);
  const { files } = await res.json();
  return files?.[0] ?? null;
}

async function driveDownload(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return { data: await res.json(), etag: res.headers.get('ETag') };
}

async function driveUpload(token, folderId, fileId, fileName, data, etag) {
  const json = JSON.stringify(data, null, 2);
  const boundary = '---dlc-sharing';
  const meta = { name: fileName, mimeType: 'application/json' };
  if (!fileId) meta.parents = [folderId];

  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `--${boundary}--`,
  ].join('\r\n');

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': `multipart/related; boundary=${boundary}`,
  };
  if (etag) headers['If-Match'] = etag;

  const res = await fetch(url, { method: fileId ? 'PATCH' : 'POST', headers, body });
  if (res.status === 412) throw Object.assign(new Error('ETag conflict'), { code: 412 });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);

  const result = await res.json();
  return { id: result.id, etag: res.headers.get('ETag'), modifiedTime: result.modifiedTime };
}

async function driveFileMeta(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`);
  return res.json();
}

async function driveShareWithUser(token, fileId, email, role = 'writer') {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&fields=id,emailAddress,role,type`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email }),
    });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Share failed: ${res.status}`);
  }
  return res.json();
}

async function driveListPermissions(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress,role,type)`);
  const { permissions } = await res.json();
  return permissions || [];
}

async function driveRemovePermission(token, fileId, permissionId) {
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
}

// ── Merge ───────────────────────────────────────────────────────

function mergeItems(local, remote) {
  const map = new Map();
  for (const r of remote) map.set(r.id, r);
  for (const l of local) {
    const existing = map.get(l.id);
    if (!existing || l.updated_at > existing.updated_at) {
      map.set(l.id, l);
    }
  }
  return Array.from(map.values());
}

function _itemsChangedDrive(oldArr, newArr) {
  if (oldArr.length !== newArr.length) return true;
  const oldById = new Map(oldArr.map(it => [it.id, it]));
  for (const n of newArr) {
    const o = oldById.get(n.id);
    if (!o) return true;
    if (!deepEqual(o, n)) return true;
  }
  return false;
}

// ── Migration: items.json → per-type files ──────────────────────

/**
 * If a legacy items.json exists, split its contents into per-type files
 * and trash items.json. Idempotent.
 */
async function migrateItemsJson(tok, folderId, entry) {
  const legacyFile = await driveFindFile(tok, folderId, 'items.json');
  if (!legacyFile) return;

  try {
    const { data } = await driveDownload(tok, legacyFile.id);
    const items = Array.isArray(data) ? data : [];

    if (items.length > 0) {
      for (const type of ITEM_TYPES) {
        const itemType = type === 'lists' ? 'list_item' : type.slice(0, -1);
        const typedItems = items.filter(i => i.item_type === itemType);
        if (typedItems.length > 0) {
          entry.typeData[type] = mergeItems(entry.typeData[type] || [], typedItems);
        }
      }
      // Save migrated data to per-type files
      for (const type of ITEM_TYPES) {
        if (entry.typeData[type]?.length) {
          const fileName = `${type}.json`;
          const meta = entry.typeMeta[type] || {};
          if (!meta.fileId) {
            const existing = await driveFindFile(tok, folderId, fileName);
            if (existing) meta.fileId = existing.id;
          }
          const r = await driveUpload(tok, folderId, meta.fileId, fileName, entry.typeData[type]);
          entry.typeMeta[type] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
        }
      }
    }

    // Trash legacy file
    await fetch(`https://www.googleapis.com/drive/v3/files/${legacyFile.id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    console.log(`sharing: migrated items.json → per-type files for folder ${folderId}`);
  } catch (err) {
    console.warn('sharing: items.json migration error:', err);
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Create a Drive sharing manager.
 *
 * @param {() => Promise<string>} getToken  — returns a valid Google access token
 * @param {string} appId  — Google Cloud project number (numeric prefix of client ID)
 * @returns {DriveSharingManager}
 */
/**
 * @param {() => Promise<string>} getToken
 * @param {string} personalFolderId
 * @param {Object} [capabilities]  — backend-specific hooks so the UI never
 *   reaches past state.sharing. A future Supabase backend would supply its own
 *   implementations (or omit the ones that don't apply).
 * @param {(folderId: string) => Promise<Array|null>} [capabilities.openJoinPicker]
 */
export function createDriveSharing(getToken, personalFolderId, capabilities = {}) {
  let _user   = null;            // { email, name, photo }
  let _rootId  = null;           // DeLaClaw-Shared folder id (own)
  const _groups = new Map();     // groupId → GroupEntry
  let _pollTimer = null;
  let _listeners = [];

  // GroupEntry shape:
  // {
  //   folderId: string,
  //   group: { id, name, created_by, members, created_at },
  //   typeData: { todos: [], habits: [], lists: [] },
  //   typeMeta: { todos: { fileId, etag, modifiedTime }, ... },
  //   gMeta: { fileId, etag, modifiedTime },
  //   joinedViaLink: boolean,   // true if joined via invite code
  // }

  // ── Joined groups (code-join, works with drive.file) ──

  let _joinedGroups = [];       // [{ folderId, groupId, fileIds: { group, todos, habits, lists }, joinedAt }]
  let _joinedMeta = {};         // { fileId, etag }

  // ── Internals ──

  function emit(event, detail) {
    for (const fn of _listeners) {
      try { fn(event, detail); } catch (e) { console.error('sharing listener error:', e); }
    }
  }

  async function token() { return getToken(); }

  async function ensureUser() {
    if (!_user) _user = await driveAboutUser(await token());
    return _user;
  }

  async function ensureRoot() {
    if (_rootId) return _rootId;
    const tok = await token();
    const folder = await driveFindOrCreateFolder(tok, SHARED_ROOT_NAME, null);
    _rootId = folder.id;
    return _rootId;
  }

  function fallbackDisplayName(value, fallback = 'Member') {
    const v = String(value || '').trim();
    if (!v) return fallback;
    return v.includes('@') ? v.split('@')[0] : v;
  }

  function legacyMemberIdFromEmail(groupId, email) {
    let hash = 0;
    const seed = `${groupId}:${String(email || '').toLowerCase()}`;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    return `legacy-${groupId}-${Math.abs(hash).toString(36)}`;
  }

  async function currentMemberId(groupId) {
    const member = await getCurrentMemberInternal(groupId);
    return member?.memberId || null;
  }

  async function normalizeMember(member = {}, groupId = '') {
    const user = _user || null;
    const legacyEmail = member.email || member.emailAddress || '';
    const isCurrentUser = user?.email && legacyEmail && legacyEmail.toLowerCase() === user.email.toLowerCase();
    const memberId = member.memberId || member.member_id || member.drivePermissionId || member.permissionId
      || (isCurrentUser ? `drive-user-${user.email.toLowerCase()}` : null)
      || (legacyEmail ? legacyMemberIdFromEmail(groupId, legacyEmail) : null)
      || `legacy-${groupId}-${crypto.randomUUID().slice(0, 8)}`;
    const joinedAt = member.joinedAt ?? member.joined_at ?? member.added_at ?? null;
    const role = member.role === 'owner' ? 'creator' : (member.role || 'member');
    const invitedLabel = member.invitedLabel ?? member.invited_label ?? null;
    const displayName = fallbackDisplayName(
      member.displayName || member.display_name || member.name || (isCurrentUser ? user?.name : '') || invitedLabel || legacyEmail || memberId,
    );
    return {
      memberId,
      role,
      status: member.status || (joinedAt || role === 'creator' ? 'joined' : 'pending'),
      displayName,
      invitedLabel,
      joinedAt,
      drivePermissionId: member.drivePermissionId || member.permissionId || null,
      emailHint: member.emailHint || (legacyEmail ? fallbackDisplayName(legacyEmail) : null),
    };
  }

  async function normalizeGroup(group, folderId = '') {
    const rawMembers = Array.isArray(group?.members) ? group.members : [];
    const members = [];
    for (const m of rawMembers) members.push(await normalizeMember(m, group?.id || folderId));
    const createdBy = typeof group?.created_by === 'string'
      ? group.created_by
      : (group?.created_by?.memberId || members.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null);
    return {
      ...(group || {}),
      backendType: group?.backendType || 'googledrive',
      created_by: createdBy,
      members,
    };
  }

  async function normalizeEntry(entry) {
    if (!entry?.group) return entry;
    const rawGroup = entry.group;
    entry.group = await normalizeGroup(rawGroup, entry.folderId);
    const memberIds = new Set(entry.group.members.map(m => m.memberId));
    const legacyRefMap = new Map();
    for (const m of (rawGroup.members || [])) {
      if (m.email) legacyRefMap.set(String(m.email).toLowerCase(), legacyMemberIdFromEmail(rawGroup.id || entry.folderId, m.email));
    }
    const normalizeMemberRef = ref => {
      if (!ref) return null;
      if (memberIds.has(ref)) return ref;
      if (String(ref).includes('@')) return legacyRefMap.get(String(ref).toLowerCase()) || legacyMemberIdFromEmail(rawGroup.id || entry.folderId, ref);
      return memberIds.has(ref) ? ref : null;
    };
    for (const type of ITEM_TYPES) {
      entry.typeData[type] = (entry.typeData[type] || []).map(item => ({
        ...item,
        assignees: (item.assignees || []).map(normalizeMemberRef).filter(Boolean),
        done_by: (item.done_by || []).map(normalizeMemberRef).filter(Boolean),
        created_by: normalizeMemberRef(item.created_by) || entry.group.created_by || null,
      }));
    }
    return entry;
  }

  async function getCurrentMemberInternal(groupId) {
    const user = await ensureUser();
    const entry = _groups.get(groupId);
    if (!entry) return null;
    if (!entry.group?.members?.length) return null;
    return entry.group.members.find(m => m.memberId === `drive-user-${user.email.toLowerCase()}`)
      || entry.group.members.find(m => m.emailHint && m.emailHint === fallbackDisplayName(user.email))
      || null;
  }

  function publicMember(member) {
    return {
      memberId: member.memberId,
      role: member.role,
      status: member.status,
      displayName: member.displayName,
      invitedLabel: member.invitedLabel,
      joinedAt: member.joinedAt,
    };
  }

  function publicGroup(entry) {
    if (!entry) return null;
    return {
      ...entry.group,
      members: (entry.group.members || []).map(publicMember),
      folderId: entry.folderId,
    };
  }

  /** Load joined groups from DeLaClaw/joined-groups.json. */
  async function loadJoinedGroups() {
    const tok = await token();
    const file = await driveFindFile(tok, personalFolderId, 'joined-groups.json');
    if (file) {
      try {
        const { data, etag } = await driveDownload(tok, file.id);
        _joinedGroups = Array.isArray(data) ? data : [];
        _joinedMeta = { fileId: file.id, etag };
      } catch (err) {
        console.warn('sharing: failed to load joined groups:', err);
      }
    }
  }

  /** Save joined groups to Drive. */
  async function saveJoinedGroups() {
    const tok = await token();
    try {
      const r = await driveUpload(tok, personalFolderId, _joinedMeta.fileId,
        'joined-groups.json', _joinedGroups, _joinedMeta.etag);
      _joinedMeta = { fileId: r.id, etag: r.etag };
    } catch (err) {
      if (err.code === 412 && _joinedMeta.fileId) {
        const { data, etag } = await driveDownload(tok, _joinedMeta.fileId);
        const remote = Array.isArray(data) ? data : [];
        // Merge: union by folderId
        const map = new Map(remote.map(j => [j.folderId, j]));
        for (const j of _joinedGroups) map.set(j.folderId, j);
        _joinedGroups = Array.from(map.values());
        const r2 = await driveUpload(tok, personalFolderId, _joinedMeta.fileId,
          'joined-groups.json', _joinedGroups);
        _joinedMeta = { fileId: r2.id, etag: r2.etag };
      } else {
        throw err;
      }
    }
  }

  /** Load a joined group using explicit file IDs (no search queries needed). */
  async function loadGroupWithIds(folderId, groupId, fileIds) {
    const tok = await token();

    // Download group.json + all type files in parallel
    const downloads = [
      fileIds.group
        ? driveDownload(tok, fileIds.group).catch(err => { console.warn(`sharing: failed to download group.json for joined group ${groupId}:`, err); return null; })
        : Promise.resolve(null),
      ...ITEM_TYPES.map(type =>
        fileIds[type]
          ? driveDownload(tok, fileIds[type]).catch(err => { console.warn(`sharing: failed to download ${type}.json for joined group ${groupId}:`, err); return null; })
          : Promise.resolve(null)
      ),
    ];
    const [gResult, ...typeResults] = await Promise.all(downloads);

    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};
    if (gResult) {
      group = gResult.data;
      gMeta = { fileId: fileIds.group, etag: gResult.etag };
    }

    const typeData = {};
    const typeMeta = {};
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const type = ITEM_TYPES[i];
      const r = typeResults[i];
      if (r) {
        typeData[type] = Array.isArray(r.data) ? r.data : [];
        typeMeta[type] = { fileId: fileIds[type], etag: r.etag };
      } else {
        typeData[type] = [];
        typeMeta[type] = {};
      }
    }

    const entry = await normalizeEntry({ folderId, group, typeData, typeMeta, gMeta, joinedViaLink: true });
    _groups.set(groupId, entry);
    return entry;
  }

  /** Map item_type to the per-type file key. */
  function typeKey(itemType) {
    if (itemType === 'list_item') return 'lists';
    return itemType + 's';   // todo → todos, habit → habits
  }

  /** Load a single group from its Drive subfolder. */
  async function loadGroup(folderId, groupId) {
    const tok = await token();

    // Find all core files in parallel
    const [gFile, ...typeFiles] = await Promise.all([
      driveFindFile(tok, folderId, 'group.json'),
      ...ITEM_TYPES.map(type => driveFindFile(tok, folderId, `${type}.json`)),
    ]);

    // Download all found files in parallel
    const downloads = [];
    downloads.push(gFile
      ? driveDownload(tok, gFile.id).then(r => ({ ...r, file: gFile }))
      : Promise.resolve(null));
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const file = typeFiles[i];
      downloads.push(file
        ? driveDownload(tok, file.id).then(r => ({ ...r, file })).catch(err => { console.warn(`sharing: failed to download ${ITEM_TYPES[i]}.json for ${groupId}:`, err); return null; })
        : Promise.resolve(null));
    }
    const [gResult, ...typeResults] = await Promise.all(downloads);

    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};
    if (gResult) {
      group = gResult.data;
      gMeta = { fileId: gFile.id, etag: gResult.etag, modifiedTime: gFile.modifiedTime };
    }

    const typeData = {};
    const typeMeta = {};
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const type = ITEM_TYPES[i];
      const r = typeResults[i];
      if (r) {
        typeData[type] = Array.isArray(r.data) ? r.data : [];
        typeMeta[type] = { fileId: r.file.id, etag: r.etag, modifiedTime: r.file.modifiedTime };
      } else {
        typeData[type] = [];
        typeMeta[type] = {};
      }
    }

    const entry = await normalizeEntry({ folderId, group, typeData, typeMeta, gMeta });
    _groups.set(groupId, entry);

    // Migrate legacy items.json if present
    await migrateItemsJson(tok, folderId, entry);

    return entry;
  }

  /** Persist group.json with ETag conflict handling. */
  async function saveGroup(groupId, retries = 0) {
    const e = _groups.get(groupId);
    if (!e) return;
    const tok = await token();

    // If we don't have a fileId for group.json, find it first
    if (!e.gMeta.fileId) {
      const gFile = await driveFindFile(tok, e.folderId, 'group.json');
      if (gFile) {
        const { data, etag } = await driveDownload(tok, gFile.id);
        const remoteGroup = await normalizeGroup(data || {}, groupId);
        e.gMeta = { fileId: gFile.id, etag, modifiedTime: gFile.modifiedTime };
        e.group.members = mergeMemberLists(e.group.members, remoteGroup.members || []);
      }
    }

    try {
      const r = await driveUpload(tok, e.folderId, e.gMeta.fileId, 'group.json', e.group, e.gMeta.etag);
      e.gMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
    } catch (err) {
      if (err.code === 412 && retries < MAX_RETRIES) {
        const { data, etag } = await driveDownload(tok, e.gMeta.fileId);
        const remoteGroup = await normalizeGroup(data || {}, groupId);
        e.group.members = mergeMemberLists(e.group.members, remoteGroup.members || []);
        e.gMeta.etag = etag;
        return saveGroup(groupId, retries + 1);
      }
      throw err;
    }
  }

  /** Persist a per-type items file with ETag conflict handling. */
  async function saveTypedItems(groupId, type, retries = 0) {
    const e = _groups.get(groupId);
    if (!e) return;
    const tok = await token();
    const fileName = `${type}.json`;
    const meta = e.typeMeta[type] || {};

    // If we don't have a fileId, search for existing file to avoid duplicates
    if (!meta.fileId) {
      const existing = await driveFindFile(tok, e.folderId, fileName);
      if (existing) {
        // Found existing file — download, merge, then update
        try {
          const { data, etag } = await driveDownload(tok, existing.id);
          const remoteItems = Array.isArray(data) ? data : [];
          e.typeData[type] = mergeItems(e.typeData[type] || [], remoteItems);
          meta.fileId = existing.id;
          meta.etag = etag;
        } catch (err) {
          meta.fileId = existing.id;
        }
        e.typeMeta[type] = meta;
      }
    }

    try {
      const r = await driveUpload(tok, e.folderId, meta.fileId, fileName, e.typeData[type] || [], meta.etag);
      e.typeMeta[type] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
    } catch (err) {
      if (err.code === 412 && retries < MAX_RETRIES) {
        const { data, etag } = await driveDownload(tok, e.typeMeta[type].fileId);
        e.typeData[type] = mergeItems(e.typeData[type] || [], Array.isArray(data) ? data : []);
        e.typeMeta[type].etag = etag;
        return saveTypedItems(groupId, type, retries + 1);
      }
      throw err;
    }
  }

  function mergeMemberLists(local, remote) {
    const map = new Map();
    for (const m of remote) map.set(m.memberId, m);
    for (const m of local)  map.set(m.memberId, m);   // local additions win
    return Array.from(map.values());
  }

  // ── Public interface ──

  const sharing = {
    // ─── Identity ───

    async getCurrentUser() {
      const user = await ensureUser();
      return { displayName: user.name || fallbackDisplayName(user.email), backendUserId: 'googledrive' };
    },

    // ─── Groups ───

    /** Create a new shared group. Returns the group object. */
    async createGroup(name) {
      const user = await ensureUser();
      const rootId = await ensureRoot();
      const tok = await token();
      const groupId = crypto.randomUUID().slice(0, 8);

      const subfolder = await driveCreateFolder(tok, `${GROUP_PREFIX}${groupId}`, rootId);
      const creatorMemberId = `drive-user-${user.email.toLowerCase()}`;
      const group = {
        id: groupId,
        name,
        backendType: 'googledrive',
        created_by: creatorMemberId,
        members: [
          {
            memberId: creatorMemberId,
            role: 'creator',
            status: 'joined',
            displayName: user.name || fallbackDisplayName(user.email),
            joinedAt: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
      };

      const gRes = await driveUpload(tok, subfolder.id, null, 'group.json', group);

      // Create empty per-type files + reserved extras in parallel
      const allFiles = [
        ...ITEM_TYPES.map(type => ({ key: type, name: `${type}.json` })),
        ...EXTRA_FILES.map(name => ({ key: name, name: `${name}.json` })),
      ];
      const results = await Promise.all(
        allFiles.map(f => driveUpload(tok, subfolder.id, null, f.name, []))
      );

      const typeMeta = {};
      const typeData = {};
      for (let i = 0; i < allFiles.length; i++) {
        const { key } = allFiles[i];
        const r = results[i];
        if (ITEM_TYPES.includes(key)) {
          typeMeta[key] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
          typeData[key] = [];
        }
        // Extra files are created on Drive but not tracked in memory (unused for now)
      }

      _groups.set(groupId, {
        folderId: subfolder.id,
        group,
        typeData,
        typeMeta,
        gMeta: { fileId: gRes.id, etag: gRes.etag, modifiedTime: gRes.modifiedTime },
      });

      emit('group-created', { group });
      return group;
    },

    /** Load all groups: own + joined (link) + auto-discovered (if full Drive scope). */
    async loadAll() {
      const tok = await token();
      const promises = [];

      // Load joined groups metadata
      await loadJoinedGroups();

      // Own groups: list subfolders under DeLaClaw-Shared/
      const rootFolder = await driveFindFolder(tok, SHARED_ROOT_NAME, null);
      if (rootFolder) {
        _rootId = rootFolder.id;
        const subs = await driveListChildren(tok, rootFolder.id, 'application/vnd.google-apps.folder');
        for (const sub of subs) {
          if (!sub.name.startsWith(GROUP_PREFIX)) continue;
          const gid = sub.name.slice(GROUP_PREFIX.length);
          if (!_groups.has(gid)) promises.push(loadGroup(sub.id, gid));
        }
      }

      // Joined groups (link-join): load using saved file IDs
      for (const joined of _joinedGroups) {
        if (_groups.has(joined.groupId)) continue;
        if (joined.fileIds) {
          promises.push(loadGroupWithIds(joined.folderId, joined.groupId, joined.fileIds));
        } else {
          // Legacy entry without fileIds — try search-based load
          promises.push(loadGroup(joined.folderId, joined.groupId));
        }
      }

      await Promise.all(promises);
      return this.getAllGroups();
    },

    getAllGroups() {
      return Array.from(_groups.values()).map(e => publicGroup(e));
    },

    getGroup(groupId) {
      const e = _groups.get(groupId);
      return e ? publicGroup(e) : null;
    },

    async getCurrentMember(groupId) {
      return getCurrentMemberInternal(groupId);
    },

    getAgentSafeGroup(groupId) {
      const e = _groups.get(groupId);
      return e ? publicGroup(e) : null;
    },

    async deleteGroup(groupId) {
      const e = _groups.get(groupId);
      if (!e) return;
      const user = await ensureUser();

      // Only the creator can delete
      const currentMember = await getCurrentMemberInternal(groupId);
      if (!currentMember || currentMember.memberId !== e.group.created_by) {
        throw new Error('Only the group creator can delete it');
      }

      const tok = await token();

      // Revoke Drive permissions for all non-owner members before trashing
      try {
        const perms = await driveListPermissions(tok, e.folderId);
        for (const perm of perms) {
          // Keep owner permission, revoke everyone else
          if (perm.role === 'owner') continue;
          try { await driveRemovePermission(tok, e.folderId, perm.id); }
          catch (err) { console.warn('sharing: failed to revoke permission for', perm.emailAddress, err); }
        }
      } catch (err) { console.warn('sharing: could not list permissions before delete:', err); }

      // Trash the entire subfolder (recoverable on Drive)
      await fetch(`https://www.googleapis.com/drive/v3/files/${e.folderId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      _groups.delete(groupId);
      emit('group-deleted', { groupId });
    },

    // ─── Membership ───

    /** Invite a user. Drive uses the email only for the permission grant; group.json stores permission id + label. */
    async inviteUser(groupId, inviteTarget) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const tok = await token();
      const email = String(inviteTarget || '').trim();
      if (!email) throw new Error('Invite target required');

      // Grant Drive editor access on the subfolder. The returned permission id becomes the member id.
      const perm = await driveShareWithUser(tok, e.folderId, email, 'writer');
      const memberId = `drive-perm-${perm.id}`;

      // Update member list if not already present. Do not persist raw email in group.json.
      if (!e.group.members.find(m => m.memberId === memberId)) {
        e.group.members.push({
          memberId,
          role: 'member',
          status: 'pending',
          displayName: fallbackDisplayName(email),
          invitedLabel: fallbackDisplayName(email),
          joinedAt: null,
          drivePermissionId: perm.id,
          emailHint: fallbackDisplayName(email),
        });
        await saveGroup(groupId);
      }

      emit('member-invited', { groupId, memberId });
      return { memberId };
    },

    /** Remove a member from a group. Revokes Drive access + updates group.json. */
    async removeUser(groupId, memberId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const tok = await token();
      const member = e.group.members.find(m => m.memberId === memberId);
      if (!member) throw new Error('Member not found');
      if (member.role === 'creator') throw new Error('Cannot remove the creator');

      const permissionId = member.drivePermissionId || (member.memberId || '').replace(/^drive-perm-/, '');
      if (permissionId) await driveRemovePermission(tok, e.folderId, permissionId).catch(() => {});

      e.group.members = e.group.members.filter(m => m.memberId !== memberId);
      await saveGroup(groupId);
      emit('member-removed', { groupId, memberId });
    },

    /** Leave a group you don't own (removes your own access). */
    async leaveGroup(groupId) {
      const user = await ensureUser();
      const e = _groups.get(groupId);
      if (!e) return;

      // Remove self from member list
      const currentMember = await getCurrentMemberInternal(groupId);
      if (currentMember) e.group.members = e.group.members.filter(m => m.memberId !== currentMember.memberId);
      await saveGroup(groupId);

      // Note: we can't revoke our own Drive permission via the API easily,
      // but removing from group.json is sufficient — the polling will stop.
      _groups.delete(groupId);
      emit('group-left', { groupId });
    },

    // ─── Items ───

    async addItem(groupId, { id: presetId, item_type, payload, assignees = [] }) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      const memberId = await currentMemberId(groupId);
      if (!memberId) throw new Error('Current group member not found');
      const item = {
        id: presetId || crypto.randomUUID(),
        item_type,             // 'todo' | 'habit' | 'list_item'
        payload,               // mirrors the fields of the native type
        assignees,             // memberIds
        done: false,
        done_by: [],
        done_at: null,
        created_by: memberId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const key = typeKey(item_type);
      if (!e.typeData[key]) e.typeData[key] = [];
      e.typeData[key].push(item);
      await saveTypedItems(groupId, key);
      emit('item-added', { groupId, item });
      return item;
    },

    async updateItem(groupId, itemId, changes) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      // Find item across all type files
      let item = null;
      let key = null;
      for (const type of ITEM_TYPES) {
        item = (e.typeData[type] || []).find(i => i.id === itemId);
        if (item) { key = type; break; }
      }
      if (!item) throw new Error(`Item ${itemId} not found`);

      Object.assign(item, changes, { updated_at: new Date().toISOString() });
      await saveTypedItems(groupId, key);
      emit('item-updated', { groupId, item });
      return item;
    },

    async deleteItem(groupId, itemId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      for (const type of ITEM_TYPES) {
        const idx = (e.typeData[type] || []).findIndex(i => i.id === itemId);
        if (idx >= 0) {
          e.typeData[type].splice(idx, 1);
          await saveTypedItems(groupId, type);
          break;
        }
      }
      emit('item-deleted', { groupId, itemId });
    },

    /**
     * Complete a shared item.
     * @param {string[]} doneBy — emails of who did it; defaults to current user
     */
    async completeItem(groupId, itemId, doneBy) {
      const normalizedDoneBy = (Array.isArray(doneBy) ? doneBy : [doneBy]).filter(Boolean);
      if (!normalizedDoneBy.length) {
        const memberId = await currentMemberId(groupId);
        if (memberId) normalizedDoneBy.push(memberId);
      }
      return this.updateItem(groupId, itemId, {
        done: true,
        done_by: normalizedDoneBy,
        done_at: new Date().toISOString(),
      });
    },

    async uncompleteItem(groupId, itemId) {
      return this.updateItem(groupId, itemId, { done: false, done_by: [], done_at: null });
    },

    // ─── Shared Habits (new format) ───

    /**
     * Add a shared habit to a group's habits.json.
     * Uses the new format: { id, item_type:'habit', name, frequency_rule,
     * creator_category, created_by, completions:[] }
     */
    async addSharedHabit(groupId, habitData) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      if (!e.typeData.habits) e.typeData.habits = [];
      e.typeData.habits.push(habitData);
      await saveTypedItems(groupId, 'habits');
      emit('item-added', { groupId, item: habitData });
      return habitData;
    },

    /**
     * Update a shared habit in a group's habits.json.
     * Merges `changes` into the habit with matching id.
     */
    async updateSharedHabit(groupId, sharedId, changes) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const item = items.find(h => h.id === sharedId);
      if (!item) throw new Error(`Shared habit ${sharedId} not found`);
      Object.assign(item, changes, { updated_at: new Date().toISOString() });
      await saveTypedItems(groupId, 'habits');
      emit('item-updated', { groupId, item });
      return item;
    },

    /**
     * Delete a shared habit from a group's habits.json.
     */
    async deleteSharedHabit(groupId, sharedId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const idx = items.findIndex(h => h.id === sharedId);
      if (idx >= 0) {
        items.splice(idx, 1);
        await saveTypedItems(groupId, 'habits');
      }
      emit('item-deleted', { groupId, itemId: sharedId });
    },

    /**
     * Add a completion to a shared habit on Drive.
     */
    async addSharedHabitCompletion(groupId, sharedId, completion) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const item = items.find(h => h.id === sharedId);
      if (!item) throw new Error(`Shared habit ${sharedId} not found`);
      if (!item.completions) item.completions = [];
      item.completions.push(completion);
      item.updated_at = new Date().toISOString();
      await saveTypedItems(groupId, 'habits');
      emit('item-updated', { groupId, item });
      return item;
    },

    /**
     * Get all shared habits across all groups (new format).
     * Returns items with group_id / group_name annotated.
     */
    getAllSharedHabits() {
      const out = [];
      for (const e of _groups.values()) {
        for (const item of (e.typeData.habits || [])) {
          if (item.item_type === 'habit' && item.completions !== undefined) {
            out.push({ ...item, group_id: e.group.id, group_name: e.group.name });
          }
        }
      }
      return out;
    },

    getAllSharedTodos() {
      return this.getAllSharedItems('todo');
    },

    getAllSharedListItems() {
      return this.getAllSharedItems('list_item');
    },

    /** Get items for one group, optionally filtered by type. */
    getItems(groupId, itemType) {
      const e = _groups.get(groupId);
      if (!e) return [];
      if (itemType) {
        const key = typeKey(itemType);
        return [...(e.typeData[key] || [])];
      }
      const out = [];
      for (const type of ITEM_TYPES) out.push(...(e.typeData[type] || []));
      return out;
    },

    /** Get all shared items across all groups, annotated with group_id / group_name. */
    getAllSharedItems(itemType) {
      const out = [];
      for (const e of _groups.values()) {
        const types = itemType ? [typeKey(itemType)] : ITEM_TYPES;
        for (const type of types) {
          for (const item of (e.typeData[type] || [])) {
            out.push({ ...item, group_id: e.group.id, group_name: e.group.name });
          }
        }
      }
      return out;
    },

    // ─── Polling ───

    startPolling() {
      if (_pollTimer) return;
      _pollTimer = setInterval(() => this.poll().catch(e => console.warn('sharing poll:', e)), POLL_MS);
    },

    stopPolling() {
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    },

    /** Force-save all groups and their items to Drive. */
    async forceSave() {
      for (const [groupId, e] of _groups) {
        if (e.joinedViaLink) continue; // can't write to someone else's group.json as non-owner
        await saveGroup(groupId);
        for (const type of ITEM_TYPES) {
          if (e.typeData[type]?.length) await saveTypedItems(groupId, type);
        }
      }
    },

    async poll() {
      const tok = await token();
      let changed = false;
      const staleGroupIds = [];  // groups to remove after iteration

      for (const [groupId, e] of _groups) {
        // Poll per-type files
        for (const type of ITEM_TYPES) {
          const meta = e.typeMeta[type];
          if (!meta?.fileId) {
            // For joined groups without a file ID, skip (can't discover by search under drive.file)
            if (e.joinedViaLink) continue;
            // Check if file was created by another user since last poll
            try {
              const file = await driveFindFile(tok, e.folderId, `${type}.json`);
              if (file) {
                const { data, etag } = await driveDownload(tok, file.id);
                e.typeData[type] = Array.isArray(data) ? data : [];
                e.typeMeta[type] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
                changed = true;
              }
            } catch (err) { console.warn(`sharing poll discover ${type} ${groupId}:`, err); }
            continue;
          }
          try {
            const fileMeta = await driveFileMeta(tok, meta.fileId);
            if (fileMeta.modifiedTime > (meta.modifiedTime || '')) {
              const { data, etag } = await driveDownload(tok, meta.fileId);
              const remote = Array.isArray(data) ? data : [];
              if (_itemsChangedDrive(e.typeData[type] || [], remote)) {
                e.typeData[type] = mergeItems(e.typeData[type] || [], remote);
                e.typeMeta[type].etag = etag;
                e.typeMeta[type].modifiedTime = fileMeta.modifiedTime;
                changed = true;
                emit('items-changed', { groupId, type, items: e.typeData[type] });
              }
            }
          } catch (err) { console.warn(`sharing poll ${type} ${groupId}:`, err); }
        }

        // Poll group.json (membership changes)
        if (e.gMeta.fileId) {
          try {
            const meta = await driveFileMeta(tok, e.gMeta.fileId);
            e.notFoundStrikes = 0;  // successful fetch — reset 404 counter
            if (meta.modifiedTime > (e.gMeta.modifiedTime || '')) {
              const { data, etag } = await driveDownload(tok, e.gMeta.fileId);
              const normalizedGroup = data ? await normalizeGroup(data, groupId) : null;
              if (normalizedGroup && !deepEqual(normalizedGroup, e.group)) {
                Object.assign(e.group, normalizedGroup);
                e.gMeta.etag = etag;
                e.gMeta.modifiedTime = meta.modifiedTime;
                changed = true;
                emit('group-changed', { groupId, group: e.group });
              }
            }
          } catch (err) {
            // 404 = group may have been deleted (folder trashed) or access revoked
            // Require 3 consecutive 404s before purging (guards against transient Drive hiccups)
            if (err?.code === 404 || err?.status === 404) {
              e.notFoundStrikes = (e.notFoundStrikes || 0) + 1;
              if (e.notFoundStrikes >= 3) staleGroupIds.push(groupId);
            } else {
              console.warn(`sharing poll group ${groupId}:`, err);
            }
          }
        }
      }

      // Clean up groups whose files are gone (deleted by creator or access revoked)
      if (staleGroupIds.length) {
        for (const gid of staleGroupIds) {
          _groups.delete(gid);
          emit('group-deleted', { groupId: gid });
        }
        // Purge from joined-groups.json
        const before = _joinedGroups.length;
        _joinedGroups = _joinedGroups.filter(j => !staleGroupIds.includes(j.groupId));
        if (_joinedGroups.length !== before) saveJoinedGroups().catch(() => {});
        changed = true;
      }

      return changed;
    },

    // ─── Events ───

    /** Register a listener. Returns an unsubscribe function. */
    onUpdate(fn) {
      _listeners.push(fn);
      return () => { _listeners = _listeners.filter(f => f !== fn); };
    },

    // ─── Link join ───

    /** Try to join a shared group by direct folder access (needs full Drive scope).
     *  Returns the group object on success, null if scope is insufficient. */
    async tryDirectJoin(folderId) {
      const tok = await token();
      try {
        const children = await driveListChildren(tok, folderId);
        if (children.length === 0) return null;
        const fileIds = {};
        for (const f of children) {
          const key = f.name.replace('.json', '');
          if (['group', ...ITEM_TYPES, ...EXTRA_FILES].includes(key)) fileIds[key] = f.id;
        }
        if (!fileIds.group) return null;
        return this.joinWithFileIds(folderId, fileIds);
      } catch {
        return null; // permission denied → needs Picker
      }
    },

    /** Join a shared group using explicit file IDs (from Picker or direct access).
     *  @param {string} folderId — the shared subfolder ID
     *  @param {Object} fileIds — { group: fileId, todos: fileId, habits: fileId, lists: fileId } */
    async joinWithFileIds(folderId, fileIds) {
      const tok = await token();
      const user = await ensureUser();

      // Read group.json to get groupId
      let groupId, groupData;
      if (fileIds.group) {
        const { data } = await driveDownload(tok, fileIds.group);
        groupData = data;
        groupId = data?.id;
      }
      if (!groupId) throw new Error('Could not read group metadata');

      // Already loaded?
      if (_groups.has(groupId)) {
        emit('group-joined', { groupId, group: _groups.get(groupId).group });
        return _groups.get(groupId).group;
      }

      // Load group data using explicit file IDs
      await loadGroupWithIds(folderId, groupId, fileIds);

      // Mark self as joined in group.json without storing raw email.
      const e = _groups.get(groupId);
      if (e) {
        const selfId = `drive-user-${user.email.toLowerCase()}`;
        let member = e.group.members.find(m => m.memberId === selfId);
        if (!member) member = e.group.members.find(m => m.status === 'pending' && m.emailHint === fallbackDisplayName(user.email));
        if (member) {
          member.status = 'joined';
          member.joinedAt = new Date().toISOString();
          member.displayName = user.name || fallbackDisplayName(user.email);
        } else {
          e.group.members.push({
            memberId: selfId,
            role: 'member',
            status: 'joined',
            displayName: user.name || fallbackDisplayName(user.email),
            joinedAt: new Date().toISOString(),
          });
        }
        await saveGroup(groupId);
      }

      // Persist in joined-groups.json
      const entry = { folderId, groupId, fileIds, joinedAt: new Date().toISOString() };
      const existing = _joinedGroups.findIndex(j => j.folderId === folderId || j.groupId === groupId);
      if (existing >= 0) _joinedGroups[existing] = entry;
      else _joinedGroups.push(entry);
      await saveJoinedGroups();

      const group = _groups.get(groupId)?.group;
      emit('group-joined', { groupId, group });
      this.startPolling();
      return group;
    },

    /** Leave a joined group (removes from joined-groups.json). */
    async unjoinGroup(groupId) {
      _joinedGroups = _joinedGroups.filter(j => j.groupId !== groupId);
      await saveJoinedGroups();
      _groups.delete(groupId);
      emit('group-left', { groupId });
    },

    /** Get the invite code for a group. */
    getInviteLink(groupId) {
      const e = _groups.get(groupId);
      if (!e) return null;
      return encodeInviteEnvelope({ v: 1, b: 'googledrive', f: e.folderId });
    },

    /** Member invite code (Drive: same as getInviteLink, token unused). */
    getMemberInviteLink(groupId, _token) {
      return this.getInviteLink(groupId);
    },

    /** Find a group by its Drive folder ID (for duplicate join detection). */
    getGroupByFolderId(folderId) {
      for (const [, e] of _groups) {
        if (e.folderId === folderId) return e.group;
      }
      return null;
    },

    /** Check if a group was joined via invite code. */
    isJoinedViaLink(groupId) {
      return _groups.get(groupId)?.joinedViaLink === true;
    },

    // ─── Backend capabilities (injected, backend-agnostic) ───

    /** Open a backend-specific file picker for join-via-link.
     *  Returns array of selected docs or null if cancelled.
     *  Null/undefined when the backend has no picker concept. */
    openJoinPicker: capabilities.openJoinPicker ?? null,

    // ─── Lifecycle ───

    destroy() {
      this.stopPolling();
      _groups.clear();
      _joinedGroups = [];
      _joinedMeta = {};
      _user = null;
      _rootId = null;
      _listeners = [];
    },

    /** Number of loaded groups (for testing / debugging). */
    get groupCount() { return _groups.size; },
  };

  return sharing;
}
