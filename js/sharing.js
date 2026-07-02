// ===================================================================
// DRIVE SHARING — multi-user shared items via Google Drive folders
// ===================================================================
//
// HYBRID MODEL: two ways to join a shared group
//
//   1. LINK JOIN (drive.file scope — default, no scary permissions)
//      A creates group → A invites B by email (shares folder) →
//      A sends B invite link (#join=<folderId>) → B opens link →
//      Google Picker opens → B selects the shared files →
//      Picker grants drive.file access → B saves file IDs in
//      DeLaClaw/joined-groups.json → done.
//
//   2. AUTO-DISCOVERY (full drive scope — opt-in via Settings)
//      A creates group → A invites B → B has A in trusted contacts →
//      B's app auto-discovers via sharedWithMe query → loads group.
//
// Both paths produce the same GroupEntry. A single group can have
// members using either path. Invite links always work regardless of
// scope.
//
// Scenarios (A=Alice, B=Bob, C=Carol, D=Dave):
//
//   S1: A(file) creates group, invites B(file) via link
//       A creates folder+files (app owns → drive.file OK)
//       A shares folder with B (app owns → OK)
//       A copies link → sends to B
//       B opens #join → Picker → selects files → joined
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
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, {
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
  //   joinedViaLink: boolean,   // true if joined via invite link
  // }

  // ── Joined groups (link-join, works with drive.file) ──

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

    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};

    if (fileIds.group) {
      try {
        const { data, etag } = await driveDownload(tok, fileIds.group);
        group = data;
        gMeta = { fileId: fileIds.group, etag };
      } catch (err) {
        console.warn(`sharing: failed to download group.json for joined group ${groupId}:`, err);
      }
    }

    const typeData = {};
    const typeMeta = {};
    for (const type of ITEM_TYPES) {
      typeData[type] = [];
      typeMeta[type] = {};
      if (fileIds[type]) {
        try {
          const { data, etag } = await driveDownload(tok, fileIds[type]);
          typeData[type] = Array.isArray(data) ? data : [];
          typeMeta[type] = { fileId: fileIds[type], etag };
        } catch (err) {
          console.warn(`sharing: failed to download ${type}.json for joined group ${groupId}:`, err);
        }
      }
    }

    // Store extra file IDs (reserved for future types — no data download needed)
    const extraMeta = {};
    for (const name of EXTRA_FILES) {
      if (fileIds[name]) {
        extraMeta[name] = { fileId: fileIds[name] };
      }
    }

    const entry = { folderId, group, typeData, typeMeta, extraMeta, gMeta, joinedViaLink: true };
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

    // Load group.json — targeted search (works for shared files after Picker)
    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};

    const gFile = await driveFindFile(tok, folderId, 'group.json');
    if (gFile) {
      const { data, etag } = await driveDownload(tok, gFile.id);
      group = data;
      gMeta = { fileId: gFile.id, etag, modifiedTime: gFile.modifiedTime };
    }

    // Load per-type files
    const typeData = {};
    const typeMeta = {};
    for (const type of ITEM_TYPES) {
      typeData[type] = [];
      typeMeta[type] = {};
      const file = await driveFindFile(tok, folderId, `${type}.json`);
      if (file) {
        try {
          const { data, etag } = await driveDownload(tok, file.id);
          typeData[type] = Array.isArray(data) ? data : [];
          typeMeta[type] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
        } catch (err) {
          console.warn(`sharing: failed to download ${type}.json for ${groupId}:`, err);
        }
      }
    }

    // Load extra file IDs (reserved for future types — no data download needed)
    const extraMeta = {};
    for (const name of EXTRA_FILES) {
      const file = await driveFindFile(tok, folderId, `${name}.json`);
      if (file) {
        extraMeta[name] = { fileId: file.id };
      }
    }

    const entry = { folderId, group, typeData, typeMeta, extraMeta, gMeta };
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
        e.gMeta = { fileId: gFile.id, etag, modifiedTime: gFile.modifiedTime };
        e.group.members = mergeMemberLists(e.group.members, data.members || []);
      }
    }

    try {
      const r = await driveUpload(tok, e.folderId, e.gMeta.fileId, 'group.json', e.group, e.gMeta.etag);
      e.gMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
    } catch (err) {
      if (err.code === 412 && retries < MAX_RETRIES) {
        const { data, etag } = await driveDownload(tok, e.gMeta.fileId);
        e.group.members = mergeMemberLists(e.group.members, data.members || []);
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
    for (const m of remote) map.set(m.email, m);
    for (const m of local)  map.set(m.email, m);   // local additions win
    return Array.from(map.values());
  }

  // ── Public interface ──

  const sharing = {
    // ─── Identity ───

    getCurrentUser: ensureUser,

    // ─── Groups ───

    /** Create a new shared group. Returns the group object. */
    async createGroup(name) {
      const user = await ensureUser();
      const rootId = await ensureRoot();
      const tok = await token();
      const groupId = crypto.randomUUID().slice(0, 8);

      const subfolder = await driveCreateFolder(tok, `${GROUP_PREFIX}${groupId}`, rootId);
      const group = {
        id: groupId,
        name,
        created_by: { email: user.email, name: user.name },
        members: [
          { email: user.email, name: user.name, role: 'owner', added_at: new Date().toISOString() },
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
      const extraMeta = {};
      for (let i = 0; i < allFiles.length; i++) {
        const { key } = allFiles[i];
        const r = results[i];
        if (ITEM_TYPES.includes(key)) {
          typeMeta[key] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
          typeData[key] = [];
        } else {
          extraMeta[key] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
        }
      }

      _groups.set(groupId, {
        folderId: subfolder.id,
        group,
        typeData,
        typeMeta,
        extraMeta,
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
      return Array.from(_groups.values()).map(e => ({ ...e.group, folderId: e.folderId }));
    },

    getGroup(groupId) {
      return _groups.get(groupId)?.group ?? null;
    },

    async deleteGroup(groupId) {
      const e = _groups.get(groupId);
      if (!e) return;
      const user = await ensureUser();

      // Only the creator can delete
      if (e.group.created_by?.email?.toLowerCase() !== user.email.toLowerCase()) {
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

    /** Invite a user by email. Shares the Drive subfolder + updates group.json. */
    async inviteUser(groupId, email) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const tok = await token();

      // Grant Drive editor access on the subfolder
      await driveShareWithUser(tok, e.folderId, email, 'writer');

      // Update member list if not already present
      if (!e.group.members.find(m => m.email === email)) {
        e.group.members.push({
          email,
          name: email,           // updated when they join and we can resolve display name
          role: 'member',
          added_at: new Date().toISOString(),
        });
        await saveGroup(groupId);
      }

      emit('member-invited', { groupId, email });
    },

    /** Remove a user from a group. Revokes Drive access + updates group.json. */
    async removeUser(groupId, email) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const tok = await token();

      const perms = await driveListPermissions(tok, e.folderId);
      const perm = perms.find(p => p.emailAddress?.toLowerCase() === email.toLowerCase());
      if (perm) await driveRemovePermission(tok, e.folderId, perm.id);

      e.group.members = e.group.members.filter(m => m.email.toLowerCase() !== email.toLowerCase());
      await saveGroup(groupId);
      emit('member-removed', { groupId, email });
    },

    /** Leave a group you don't own (removes your own access). */
    async leaveGroup(groupId) {
      const user = await ensureUser();
      const e = _groups.get(groupId);
      if (!e) return;

      // Remove self from member list
      e.group.members = e.group.members.filter(m => m.email.toLowerCase() !== user.email.toLowerCase());
      await saveGroup(groupId);

      // Note: we can't revoke our own Drive permission via the API easily,
      // but removing from group.json is sufficient — the polling will stop.
      _groups.delete(groupId);
      emit('group-left', { groupId });
    },

    // ─── Items ───

    async addItem(groupId, { item_type, payload, assignees = [] }) {
      const user = await ensureUser();
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      const item = {
        id: crypto.randomUUID(),
        item_type,             // 'todo' | 'habit' | 'list_item'
        payload,               // mirrors the fields of the native type
        assignees,             // emails
        done: false,
        done_by: [],
        done_at: null,
        created_by: user.email,
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
      const user = await ensureUser();
      if (!doneBy?.length) doneBy = [user.email];
      return this.updateItem(groupId, itemId, {
        done: true,
        done_by: doneBy,
        done_at: new Date().toISOString(),
      });
    },

    async uncompleteItem(groupId, itemId) {
      return this.updateItem(groupId, itemId, { done: false, done_by: [], done_at: null });
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
              if (JSON.stringify(remote) !== JSON.stringify(e.typeData[type])) {
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
              if (data && JSON.stringify(data) !== JSON.stringify(e.group)) {
                Object.assign(e.group, data);
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

      // Mark self as joined in group.json
      const e = _groups.get(groupId);
      if (e) {
        const member = e.group.members.find(m => m.email.toLowerCase() === user.email.toLowerCase());
        if (member) {
          member.joined_at = new Date().toISOString();
          if (user.name) member.name = user.name;
        } else {
          e.group.members.push({
            email: user.email,
            name: user.name || user.email,
            role: 'member',
            added_at: new Date().toISOString(),
            joined_at: new Date().toISOString(),
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

    /** Get the invite link for a group. */
    getInviteLink(groupId) {
      const e = _groups.get(groupId);
      if (!e) return null;
      const base = location.origin + location.pathname;
      return `${base}#join=${e.folderId}`;
    },

    /** Find a group by its Drive folder ID (for duplicate join detection). */
    getGroupByFolderId(folderId) {
      for (const [, e] of _groups) {
        if (e.folderId === folderId) return e.group;
      }
      return null;
    },

    /** Check if a group was joined via invite link. */
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
