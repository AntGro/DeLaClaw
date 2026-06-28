// ===================================================================
// DRIVE SHARING — multi-user shared items via Google Drive folders
// ===================================================================
//
// Folder structure (inside the user's Google Drive):
//
//   My Drive/
//   ├── DeLaClaw/                          ← personal data (existing)
//   └── DeLaClaw-Shared/                   ← shared root (one per user)
//       └── DeLaClaw-Shared-{groupId}/     ← per-group subfolder
//           ├── group.json                 ← metadata + member list
//           ├── todos.json                 ← shared todos
//           ├── habits.json                ← shared habits
//           └── lists.json                 ← shared list items
//
// Sharing flow:
//   1. User A creates a group → subfolder + group.json + per-type JSONs
//   2. A invites B by email → Drive permissions.create on the subfolder
//   3. B's app discovers groups via sharedWithMe query on DeLaClaw-Shared-*
//   4. Both read/write per-type JSONs; ETag + updated_at merge on conflict
//
// Identity:
//   User email comes from the Drive About API (works with drive.file scope,
//   no extra OAuth scope needed).
//
// Scope:
//   drive.file — the app creates the shared files, so they're in scope
//   for the creator. When A shares a subfolder with B, B's drive.file
//   scope does NOT automatically include it. B must "open" the folder
//   via the Google Picker API (one-time onboarding per group), which
//   brings it into B's drive.file scope permanently (survives token
//   refreshes, browser restarts, new devices — only lost if B revokes
//   the app entirely from Google Account > Security > Third-party apps).
//
// Prerequisites:
//   - Google Picker API must be enabled in the Cloud Console
//     (APIs & Services → Library → "Google Picker API" → Enable)
//   - App ID = project number (numeric prefix of the OAuth client ID)
//
// ===================================================================

const SHARED_ROOT_NAME = 'DeLaClaw-Shared';
const GROUP_PREFIX     = 'DeLaClaw-Shared-';
const POLL_MS          = 15_000;      // 15s — faster than personal (30s)
const MAX_RETRIES      = 2;
const ITEM_TYPES       = ['todos', 'habits', 'lists'];

// ── Picker API (lazy-loaded) ────────────────────────────────────

let _pickerReady = false;

function loadPickerApi() {
  if (_pickerReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const init = () => gapi.load('picker', {
      callback: () => { _pickerReady = true; resolve(); },
      onerror: reject,
    });
    if (typeof gapi !== 'undefined') { init(); return; }
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = init;
    s.onerror = () => reject(new Error('Failed to load Google Picker API'));
    document.head.appendChild(s);
  });
}

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

async function driveDiscoverShared(token) {
  const q = `sharedWithMe=true and mimeType='application/vnd.google-apps.folder' and name contains '${GROUP_PREFIX}' and trashed=false`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,owners(emailAddress,displayName),modifiedTime)&pageSize=100`);
  const { files } = await res.json();
  return files || [];
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
export function createDriveSharing(getToken, appId) {
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
  // }

  // ── Joined-groups cache (localStorage fallback for discovery) ──

  const JOINED_KEY = 'dlc_shared_joined';

  function persistJoined() {
    const entries = [];
    for (const [gid, e] of _groups) entries.push({ groupId: gid, folderId: e.folderId });
    try { localStorage.setItem(JOINED_KEY, JSON.stringify(entries)); } catch (_) {}
  }

  function loadJoined() {
    try { return JSON.parse(localStorage.getItem(JOINED_KEY) || '[]'); } catch (_) { return []; }
  }

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

    const entry = { folderId, group, typeData, typeMeta, gMeta };
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

      // Create empty per-type files
      const typeMeta = {};
      const typeData = {};
      for (const type of ITEM_TYPES) {
        const r = await driveUpload(tok, subfolder.id, null, `${type}.json`, []);
        typeMeta[type] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
        typeData[type] = [];
      }

      _groups.set(groupId, {
        folderId: subfolder.id,
        group,
        typeData,
        typeMeta,
        gMeta: { fileId: gRes.id, etag: gRes.etag, modifiedTime: gRes.modifiedTime },
      });

      emit('group-created', { group });
      persistJoined();
      return group;
    },

    /**
     * Open the Google Picker so the user can select a shared DeLaClaw folder.
     * This is the one-time onboarding step that brings the folder into the
     * user's drive.file scope.
     *
     * @returns {Promise<object|null>} — the group object, or null if cancelled
     */
    async joinGroup() {
      await loadPickerApi();
      const tok = await token();

      return new Promise((resolve, reject) => {
        const view = new google.picker.DocsView()
          .setIncludeFolders(true)
          .setMimeTypes('application/vnd.google-apps.folder')
          .setSelectFolderEnabled(true)
          .setOwnedByMe(false);   // only "Shared with me"

        const picker = new google.picker.PickerBuilder()
          .setOAuthToken(tok)
          .setAppId(appId)
          .addView(view)
          .setTitle('Select a DeLaClaw shared group')
          .setCallback(async (data) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
              const doc = data[google.picker.Response.DOCUMENTS][0];
              const folderId = doc[google.picker.Document.ID];
              const folderName = doc[google.picker.Document.NAME];

              if (!folderName.startsWith(GROUP_PREFIX)) {
                reject(new Error('Selected folder is not a DeLaClaw shared group'));
                return;
              }

              const groupId = folderName.slice(GROUP_PREFIX.length);
              if (_groups.has(groupId)) {
                resolve(_groups.get(groupId).group);
                return;
              }

              try {
                const entry = await loadGroup(folderId, groupId);

                // Update our display name in the member list
                const user = await ensureUser();
                const member = entry.group.members.find(
                  m => m.email.toLowerCase() === user.email.toLowerCase()
                );
                if (member && member.name === member.email) {
                  member.name = user.name;
                  await saveGroup(groupId);
                }

                persistJoined();
                emit('group-joined', { groupId, group: entry.group });
                resolve(entry.group);
              } catch (err) {
                reject(err);
              }
            } else if (action === google.picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();

        picker.setVisible(true);
      });
    },

    /** Load all groups: own (from DeLaClaw-Shared/) + others' (sharedWithMe + Picker cache). */
    async loadAll() {
      const tok = await token();
      const promises = [];

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

      // Groups others shared with me (works after Picker onboarding)
      try {
        const shared = await driveDiscoverShared(tok);
        for (const folder of shared) {
          const gid = folder.name.slice(GROUP_PREFIX.length);
          if (!_groups.has(gid)) promises.push(loadGroup(folder.id, gid));
        }
      } catch (err) {
        console.warn('sharing: sharedWithMe discovery failed:', err);
      }

      // Fallback: try cached folder IDs from previous Picker joins
      const cached = loadJoined();
      for (const { groupId, folderId } of cached) {
        if (!_groups.has(groupId)) {
          promises.push(
            loadGroup(folderId, groupId).catch(err => {
              console.warn(`sharing: cached group ${groupId} unavailable:`, err);
            })
          );
        }
      }

      await Promise.all(promises);
      persistJoined();   // sync cache with current state
      return this.getAllGroups();
    },

    getAllGroups() {
      return Array.from(_groups.values()).map(e => ({ ...e.group }));
    },

    getGroup(groupId) {
      return _groups.get(groupId)?.group ?? null;
    },

    async deleteGroup(groupId) {
      const e = _groups.get(groupId);
      if (!e) return;
      const tok = await token();
      // Trash the entire subfolder (recoverable on Drive)
      await fetch(`https://www.googleapis.com/drive/v3/files/${e.folderId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      _groups.delete(groupId);
      persistJoined();
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
      persistJoined();
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

      for (const [groupId, e] of _groups) {
        // Poll per-type files
        for (const type of ITEM_TYPES) {
          const meta = e.typeMeta[type];
          if (!meta?.fileId) {
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
          } catch (err) { console.warn(`sharing poll group ${groupId}:`, err); }
        }
      }

      // Discover newly shared groups
      try {
        const shared = await driveDiscoverShared(tok);
        for (const folder of shared) {
          const gid = folder.name.slice(GROUP_PREFIX.length);
          if (!_groups.has(gid)) {
            await loadGroup(folder.id, gid);
            persistJoined();
            changed = true;
            emit('group-discovered', { groupId: gid, group: _groups.get(gid)?.group });
          }
        }
      } catch (err) { console.warn('sharing poll discover:', err); }

      return changed;
    },

    // ─── Events ───

    /** Register a listener. Returns an unsubscribe function. */
    onUpdate(fn) {
      _listeners.push(fn);
      return () => { _listeners = _listeners.filter(f => f !== fn); };
    },

    // ─── Lifecycle ───

    destroy() {
      this.stopPolling();
      _groups.clear();
      _user = null;
      _rootId = null;
      _listeners = [];
    },

    /** Number of loaded groups (for testing / debugging). */
    get groupCount() { return _groups.size; },
  };

  return sharing;
}
