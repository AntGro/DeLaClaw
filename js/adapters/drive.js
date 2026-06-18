// ===================================================================
// GOOGLE DRIVE ADAPTER — in-memory runtime, per-table Drive persistence
// ===================================================================
// On connect: reads per-table JSON files from a DeLaClaw/ folder.
// At runtime: all reads/writes hit the in-memory store (instant).
// On mutation: debounced write-back per table (~2s after last change).
//
// Concurrency: uses Drive ETags for optimistic locking. On conflict
// (412 Precondition Failed), re-reads the table, merges by id
// (newer updated_at wins), and retries the write.
//
// Change detection: polls Drive every POLL_INTERVAL_MS for modified
// files and re-fetches only changed tables.
//
// Migration: detects the legacy single-file format (delaclaw-data.json)
// and splits it into per-table files on first connect.
//
// Uses the demo adapter's DemoQueryBuilder under the hood — same
// chainable .from().select().eq().insert() interface.
// ===================================================================

import { createDemoAdapter } from './demo.js';
import { DRIVE_MIGRATIONS } from '../../migrations/drive-migrations.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'DeLaClaw';
const LEGACY_FILE_NAME = 'delaclaw-data.json';
const DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 30000;
const MAX_RETRIES = 2;

// Tables that map to individual Drive files
const DRIVE_TABLES = [
  'projects', 'tasks', 'todos', 'habits', 'habit_completions',
  'flashcards', 'flashcard_notes', 'texts', 'text_line_progress',
  'birthdays', 'vestiaire', 'lists', 'list_items',
  'settings', 'prompts', 'nvidia_usage', 'daily_visits',
];

// ── Google Identity Services helpers ────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

function getGoogleAccessToken(clientId, promptIfNeeded = true) {
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) {
    return Promise.resolve(_cachedToken);
  }
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined' || !google.accounts) {
      reject(new Error('google_not_loaded'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
        } else {
          _cachedToken = resp.access_token;
          _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
          resolve(resp.access_token);
        }
      },
      error_callback: (err) => {
        reject(new Error(err.type || 'auth_error'));
      },
    });
    if (promptIfNeeded) {
      client.requestAccessToken();
    } else {
      client.requestAccessToken({ prompt: '' });
    }
  });
}

// ── Drive API helpers ───────────────────────────────────────────

async function findOrCreateFolder(token) {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (search.ok) {
    const { files } = await search.json();
    if (files && files.length > 0) return files[0].id;
  }

  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!create.ok) throw new Error('Failed to create Drive folder');
  return (await create.json()).id;
}

/** List all files in the DeLaClaw folder with id, name, modifiedTime */
async function listFolderFiles(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=100`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Failed to list Drive folder: ${resp.status}`);
  const { files } = await resp.json();
  return files || [];
}

/** Download a file and return { data, etag } */
async function downloadFile(token, fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status}`);
  const etag = resp.headers.get('ETag');
  const data = await resp.json();
  return { data, etag };
}

/** Upload/update a file with optional ETag for optimistic locking.
 *  Returns { id, etag } on success, throws on 412 (conflict). */
async function uploadFile(token, folderId, fileId, fileName, data, ifMatchEtag) {
  const json = JSON.stringify(data, null, 2);
  const metadata = { name: fileName, mimeType: 'application/json' };
  if (!fileId) metadata.parents = [folderId];

  const boundary = '---dlc-drive-boundary';
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `--${boundary}--`,
  ].join('\r\n');

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': `multipart/related; boundary=${boundary}`,
  };
  if (ifMatchEtag) headers['If-Match'] = ifMatchEtag;

  const resp = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers,
    body,
  });

  if (resp.status === 412) {
    const err = new Error('ETag conflict');
    err.code = 412;
    throw err;
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Drive upload failed: ${resp.status} ${errText}`);
  }

  const result = await resp.json();
  const etag = resp.headers.get('ETag');
  return { id: result.id, etag };
}

/** Delete a file from Drive */
async function deleteFile(token, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

// ── Merge logic for conflict resolution ─────────────────────────

/** Merge two arrays of records by id. Newer updated_at wins per record. */
function mergeRecords(local, remote) {
  const map = new Map();
  for (const r of remote) map.set(r.id, r);
  for (const r of local) {
    const existing = map.get(r.id);
    if (!existing) {
      map.set(r.id, r);
    } else {
      const localTime = r.updated_at || r.created_at || '';
      const remoteTime = existing.updated_at || existing.created_at || '';
      if (localTime >= remoteTime) map.set(r.id, r);
    }
  }
  return [...map.values()];
}

/** Merge for key-value tables (settings, prompts) — keyed by 'key' not 'id' */
function mergeKeyValueRecords(local, remote) {
  const map = new Map();
  for (const r of remote) map.set(r.key, r);
  for (const r of local) {
    const existing = map.get(r.key);
    if (!existing) {
      map.set(r.key, r);
    } else {
      const localTime = r.updated_at || '';
      const remoteTime = existing.updated_at || '';
      if (localTime >= remoteTime) map.set(r.key, r);
    }
  }
  return [...map.values()];
}

const KEY_VALUE_TABLES = new Set(['settings', 'prompts']);

function mergeTable(tableName, local, remote) {
  if (KEY_VALUE_TABLES.has(tableName)) return mergeKeyValueRecords(local, remote);
  return mergeRecords(local, remote);
}

// ── Drive Adapter ───────────────────────────────────────────────

export async function createDriveAdapter(clientId, onStatus, { silent = false } = {}) {
  if (onStatus) onStatus('authenticating');

  const token = await getGoogleAccessToken(clientId, !silent);

  if (onStatus) onStatus('loading');

  const folderId = await findOrCreateFolder(token);

  // Per-table file IDs, ETags, and modified times
  const fileMeta = {}; // { tableName: { fileId, etag, modifiedTime } }
  const dirtyTables = new Set();
  const saveTimers = {};

  // ── Load: list files, detect legacy format, read all tables ──

  const existingFiles = await listFolderFiles(token, folderId);
  const filesByName = new Map(existingFiles.map(f => [f.name, f]));

  let initialData = {};

  // Check for legacy single-file format
  const legacyFile = filesByName.get(LEGACY_FILE_NAME);
  if (legacyFile) {
    if (onStatus) onStatus('migrating');
    const { data: legacyData } = await downloadFile(token, legacyFile.id);

    // Write each table as its own file
    for (const table of DRIVE_TABLES) {
      const tableData = legacyData[table] || [];
      const fileName = `${table}.json`;
      const result = await uploadFile(token, folderId, null, fileName, tableData);
      fileMeta[table] = { fileId: result.id, etag: result.etag, modifiedTime: new Date().toISOString() };
      initialData[table] = tableData;
    }

    // Delete legacy file
    await deleteFile(token, legacyFile.id);
  } else {
    // Normal load: read each per-table file in parallel
    const readPromises = DRIVE_TABLES.map(async (table) => {
      const fileName = `${table}.json`;
      const fileInfo = filesByName.get(fileName);
      if (fileInfo) {
        const { data, etag } = await downloadFile(token, fileInfo.id);
        fileMeta[table] = { fileId: fileInfo.id, etag, modifiedTime: fileInfo.modifiedTime };
        initialData[table] = Array.isArray(data) ? data : [];
      } else {
        initialData[table] = [];
        fileMeta[table] = { fileId: null, etag: null, modifiedTime: null };
      }
    });
    await Promise.all(readPromises);
  }

  // ── Create in-memory adapter seeded with loaded data ──

  const inner = createDemoAdapter(initialData);

  // ── Token refresh helper ──

  async function getToken() {
    try {
      return await getGoogleAccessToken(clientId, false);
    } catch {
      return _cachedToken;
    }
  }

  // ── Run pending migrations ──

  const pendingMigrations = Object.keys(DRIVE_MIGRATIONS)
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  if (pendingMigrations.length > 0) {
    const settings = inner._store.settings || [];
    const svEntry = settings.find(s => s.key === 'schema_version');
    const currentVersion = svEntry ? String(svEntry.value) : '0';

    const toRun = pendingMigrations.filter(v => v > currentVersion);

    if (toRun.length > 0) {
      if (onStatus) onStatus('migrating');

      // Save a full backup before any migration runs
      const backupData = {};
      for (const table of DRIVE_TABLES) {
        backupData[table] = JSON.parse(JSON.stringify(inner._store[table] || []));
      }
      backupData._meta = {
        backup_of: currentVersion,
        created_at: new Date().toISOString(),
        reason: `pre-migration (${toRun.length} pending: ${toRun.join(', ')})`,
      };
      const tok = await getToken();
      if (tok) {
        await uploadFile(tok, folderId, null, `backup-v${currentVersion}.json`, backupData);
      }

      // Run each migration, bump schema_version after each success
      for (const version of toRun) {
        await DRIVE_MIGRATIONS[version](inner._store);

        // Update schema_version in memory
        const entry = (inner._store.settings || []).find(s => s.key === 'schema_version');
        if (entry) {
          entry.value = version;
        } else {
          if (!inner._store.settings) inner._store.settings = [];
          inner._store.settings.push({ key: 'schema_version', value: version });
        }

        // Flush all tables + settings to Drive
        const flushTok = await getToken();
        if (flushTok) {
          for (const table of DRIVE_TABLES) {
            const fileName = `${table}.json`;
            const meta = fileMeta[table] || {};
            const result = await uploadFile(flushTok, folderId, meta.fileId, fileName, inner._store[table] || []);
            fileMeta[table] = { fileId: result.id || meta.fileId, etag: result.etag, modifiedTime: new Date().toISOString() };
          }
        }
      }
    }
  }

  // ── Per-table flush with ETag conflict handling ──

  const flushingTables = new Set();

  async function flushTable(table, retries = 0) {
    if (flushingTables.has(table)) return;
    flushingTables.add(table);
    try {
      const tok = await getToken();
      if (!tok) { console.warn(`Drive: no token for save of ${table}`); return; }

      const localData = inner._store[table] || [];
      const meta = fileMeta[table] || {};
      const fileName = `${table}.json`;

      try {
        const result = await uploadFile(tok, folderId, meta.fileId, fileName, localData, meta.etag);
        fileMeta[table] = {
          fileId: result.id || meta.fileId,
          etag: result.etag,
          modifiedTime: new Date().toISOString(),
        };
      } catch (err) {
        if (err.code === 412 && retries < MAX_RETRIES) {
          console.warn(`Drive: ETag conflict on ${table}, merging (attempt ${retries + 1})`);
          const { data: remoteData, etag: newEtag } = await downloadFile(tok, meta.fileId);
          const merged = mergeTable(table, localData, Array.isArray(remoteData) ? remoteData : []);
          inner._store[table] = merged;
          fileMeta[table] = { ...meta, etag: newEtag };
          flushingTables.delete(table);
          return flushTable(table, retries + 1);
        }
        throw err;
      }
    } catch (e) {
      console.error(`Drive: save failed for ${table}`, e);
    } finally {
      flushingTables.delete(table);
    }
  }

  function scheduleSave(table) {
    dirtyTables.add(table);
    if (saveTimers[table]) clearTimeout(saveTimers[table]);
    saveTimers[table] = setTimeout(() => {
      dirtyTables.delete(table);
      delete saveTimers[table];
      flushTable(table);
    }, DEBOUNCE_MS);
  }

  // ── Polling for external changes ──

  let pollTimer = null;

  async function pollForChanges() {
    try {
      const tok = await getToken();
      if (!tok) return;

      const files = await listFolderFiles(tok, folderId);
      for (const file of files) {
        const tableName = file.name.replace('.json', '');
        if (!DRIVE_TABLES.includes(tableName)) continue;
        const meta = fileMeta[tableName];
        if (!meta) continue;

        // Skip tables currently being edited locally
        if (dirtyTables.has(tableName) || flushingTables.has(tableName)) continue;

        if (meta.modifiedTime && file.modifiedTime > meta.modifiedTime) {
          const { data, etag } = await downloadFile(tok, file.id);
          inner._store[tableName] = Array.isArray(data) ? data : [];
          fileMeta[tableName] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
          if (adapter._onExternalChange) adapter._onExternalChange(tableName);
        }
      }
    } catch (e) {
      console.warn('Drive: poll failed', e);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollForChanges, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ── Wrapped adapter ──

  const adapter = {
    from(table) {
      const builder = inner.from(table);
      const origThen = builder.then.bind(builder);
      builder.then = (resolve, reject) => {
        origThen((result) => {
          if (builder._method !== 'GET') {
            scheduleSave(table);
          }
          resolve(result);
        }, reject);
      };
      return builder;
    },
    channel() { return inner.channel(); },
    rpc(fn, params) { return inner.rpc(fn, params); },

    reseed(data) {
      inner.reseed(data);
      for (const table of DRIVE_TABLES) scheduleSave(table);
    },

    get _store() { return inner._store; },

    async forceSave() {
      for (const table of Object.keys(saveTimers)) {
        clearTimeout(saveTimers[table]);
        delete saveTimers[table];
      }
      const tablesToSave = [...dirtyTables];
      dirtyTables.clear();
      await Promise.all(tablesToSave.map(t => flushTable(t)));
    },

    get connected() { return true; },
    get driveFolderId() { return folderId; },
    get driveFileMeta() { return { ...fileMeta }; },

    // Callback for external change notification
    _onExternalChange: null,

    startPolling,
    stopPolling,

    destroy() {
      stopPolling();
      for (const t of Object.keys(saveTimers)) clearTimeout(saveTimers[t]);
    },
  };

  startPolling();

  if (onStatus) onStatus('ready');
  return adapter;
}
