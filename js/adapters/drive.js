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
// Migration: legacy single-file → per-table conversion and subsequent
// schema migrations are handled by migrations/drive-migrations.js.
//
// Uses the demo adapter's DemoQueryBuilder under the hood — same
// chainable .from().select().eq().insert() interface.
// ===================================================================

import { createDemoAdapter } from './demo.js';
import { DRIVE_MIGRATIONS } from '../../migrations/drive-migrations.js';
import { t } from '../i18n.js';

export const DRIVE_SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file';

export function getDriveScope() {
  return DRIVE_SCOPE_FILE;
}
const DRIVE_FOLDER_NAME = 'DeLaClaw';
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
// sec: token scoped by clientId + dedup pending promise to avoid popup spam

let _cachedToken = null;
let _cachedClientId = null;
let _tokenExpiry = 0;
let _pendingPromise = null;
let _pendingClientId = null;

const _TOKEN_KEY_PREFIX = 'claw_drive_token:';

function _tokenKey(clientId) {
  // clientId is public — use as suffix to scope per OAuth client
  return `${_TOKEN_KEY_PREFIX}${clientId || 'default'}`;
}

function _persistToken(token, expiryMs, clientId) {
  try {
    sessionStorage.setItem(_tokenKey(clientId), JSON.stringify({ token, expiry: expiryMs }));
  } catch (_) {}
}

function _loadPersistedToken(clientId) {
  try {
    const raw = sessionStorage.getItem(_tokenKey(clientId));
    if (!raw) return null;
    const { token, expiry } = JSON.parse(raw);
    // Still valid with ≥60s margin
    if (token && expiry && Date.now() < expiry - 60000) return { token, expiry };
  } catch (_) {}
  return null;
}

function clearDriveTokenCache(clientId) {
  // If clientId given, clear only that scoped entry; otherwise clear all prefixed entries (defense on mode switch)
  _cachedToken = null;
  _cachedClientId = null;
  _tokenExpiry = 0;
  _pendingPromise = null;
  _pendingClientId = null;
  try {
    if (clientId) {
      sessionStorage.removeItem(_tokenKey(clientId));
    } else {
      // clear all scoped drive tokens
      const toRemove = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(_TOKEN_KEY_PREFIX)) toRemove.push(k);
      }
      toRemove.forEach(k => sessionStorage.removeItem(k));
      // legacy unscoped key (pre-1.368)
      sessionStorage.removeItem('claw_drive_token');
    }
  } catch (_) {}
}

function getGoogleAccessToken(clientId, promptIfNeeded = true) {
  // 1. In-memory cache — scoped by clientId
  if (_cachedToken && _cachedClientId === clientId && Date.now() < _tokenExpiry - 60000) {
    return Promise.resolve(_cachedToken);
  }
  // 2. sessionStorage cache (survives refresh within the ~1h token lifetime) — scoped
  const persisted = _loadPersistedToken(clientId);
  if (persisted) {
    _cachedToken = persisted.token;
    _cachedClientId = clientId;
    _tokenExpiry = persisted.expiry;
    return Promise.resolve(_cachedToken);
  }
  // 3. Dedup in-flight request — prevents popup spam on concurrent getToken()
  if (_pendingPromise && _pendingClientId === clientId) {
    return _pendingPromise;
  }
  // 4. Fresh OAuth flow — single flight
  _pendingClientId = clientId;
  _pendingPromise = new Promise((resolve, reject) => {
    if (typeof google === 'undefined' || !google.accounts) {
      reject(new Error('google_not_loaded'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: getDriveScope(),
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
        } else {
          _cachedToken = resp.access_token;
          _cachedClientId = clientId;
          _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
          _persistToken(_cachedToken, _tokenExpiry, clientId);
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
  }).finally(() => {
    _pendingPromise = null;
    _pendingClientId = null;
  });
  return _pendingPromise;
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

// ── Google Picker API (lazy-loaded for sharing join flow) ────────

let _pickerApiLoaded = false;

async function ensurePickerApi() {
  if (_pickerApiLoaded) return;
  // Wait for gapi script to load
  if (typeof gapi === 'undefined') {
    await new Promise((resolve, reject) => {
      let elapsed = 0;
      const iv = setInterval(() => {
        if (typeof gapi !== 'undefined') { clearInterval(iv); resolve(); }
        elapsed += 100;
        if (elapsed > 10000) { clearInterval(iv); reject(new Error('Google API not loaded')); }
      }, 100);
    });
  }
  await new Promise((resolve, reject) => {
    gapi.load('picker', { callback: () => { _pickerApiLoaded = true; resolve(); }, onerror: reject });
  });
}

export async function createDriveAdapter(clientId, onStatus, { silent = false } = {}) {
  // onStatus receives: { status, message?, progress?, total? }
  const emit = (status, message, progress, total) => {
    if (onStatus) onStatus({ status, message, progress, total });
  };

  emit('authenticating', t('menu.drive_signing_in'));

  const token = await getGoogleAccessToken(clientId, !silent);

  emit('loading', t('menu.drive_connecting'));

  const folderId = await findOrCreateFolder(token);

  // Per-table file IDs, ETags, and modified times
  const fileMeta = {}; // { tableName: { fileId, etag, modifiedTime } }
  const dirtyTables = new Set();
  const saveTimers = {};

  // ── Load: list files, read data from whatever format exists ──

  const existingFiles = await listFolderFiles(token, folderId);
  const filesByName = new Map(existingFiles.map(f => [f.name, f]));

  let initialData = {};

  // Check for per-table files first, fall back to legacy single-file
  const hasPerTableFiles = DRIVE_TABLES.some(t => filesByName.has(`${t}.json`));
  const legacyFile = filesByName.get('delaclaw-data.json');

  if (hasPerTableFiles) {
    // Normal load: read each per-table file in parallel
    let loaded = 0;
    const total = DRIVE_TABLES.filter(t => filesByName.has(`${t}.json`)).length;
    emit('loading', t('menu.drive_loading_tables'), 0, total);
    const readPromises = DRIVE_TABLES.map(async (table) => {
      const fileName = `${table}.json`;
      const fileInfo = filesByName.get(fileName);
      if (fileInfo) {
        const { data, etag } = await downloadFile(token, fileInfo.id);
        fileMeta[table] = { fileId: fileInfo.id, etag, modifiedTime: fileInfo.modifiedTime };
        initialData[table] = Array.isArray(data) ? data : [];
        loaded++;
        emit('loading', t('menu.drive_loading_table', table), loaded, total);
      } else {
        initialData[table] = [];
        fileMeta[table] = { fileId: null, etag: null, modifiedTime: null };
      }
    });
    await Promise.all(readPromises);
  } else if (legacyFile) {
    // Legacy format: read single file, populate initialData from it
    emit('migrating', t('menu.drive_upgrading'));
    const { data: legacyData } = await downloadFile(token, legacyFile.id);
    for (const table of DRIVE_TABLES) {
      initialData[table] = legacyData[table] || [];
      fileMeta[table] = { fileId: null, etag: null, modifiedTime: null };
    }
  } else {
    // Fresh install: no files at all
    for (const table of DRIVE_TABLES) {
      initialData[table] = [];
      fileMeta[table] = { fileId: null, etag: null, modifiedTime: null };
    }
  }

  const isFreshInstall = !hasPerTableFiles && !legacyFile;

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

  if (isFreshInstall) {
    // Fresh install: create all table files on Drive with progress, set schema to latest
    const latestVersion = Object.keys(DRIVE_MIGRATIONS).sort((a, b) => parseFloat(a) - parseFloat(b)).pop() || '0';
    const total = DRIVE_TABLES.length;
    emit('loading', t('menu.drive_creating_tables'), 0, total);
    const tok = await getToken();
    if (tok) {
      for (let i = 0; i < DRIVE_TABLES.length; i++) {
        const table = DRIVE_TABLES[i];
        emit('loading', t('menu.drive_creating_table', table), i + 1, total);
        const result = await uploadFile(tok, folderId, null, `${table}.json`, []);
        fileMeta[table] = { fileId: result.id, etag: result.etag, modifiedTime: new Date().toISOString() };
      }
    }
    // Set schema_version to latest — no migrations needed
    if (!inner._store.settings) inner._store.settings = [];
    inner._store.settings.push({ key: 'schema_version', value: latestVersion });
    // Flush settings with the version stamp
    const settingsTok = await getToken();
    if (settingsTok) {
      const meta = fileMeta.settings || {};
      const result = await uploadFile(settingsTok, folderId, meta.fileId, 'settings.json', inner._store.settings);
      fileMeta.settings = { fileId: result.id || meta.fileId, etag: result.etag, modifiedTime: new Date().toISOString() };
    }
  } else {
    // ── Run pending migrations (existing installs only) ──

    const pendingMigrations = Object.keys(DRIVE_MIGRATIONS)
      .sort((a, b) => parseFloat(a) - parseFloat(b));

    if (pendingMigrations.length > 0) {
      const settings = inner._store.settings || [];
      const svEntry = settings.find(s => s.key === 'schema_version');
      const currentVersion = svEntry ? String(svEntry.value) : '0';

      const toRun = pendingMigrations.filter(v => v > currentVersion);

      if (toRun.length > 0) {
        emit('migrating', t('menu.drive_backing_up'), 0, toRun.length);

        // Context object for migrations that need Drive API access
        const migrationCtx = {
          token, folderId, fileMeta, filesByName,
          getToken, DRIVE_TABLES,
          uploadFile, downloadFile, deleteFile, listFolderFiles,
        };

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
        for (let i = 0; i < toRun.length; i++) {
          const version = toRun[i];
          emit('migrating', t('menu.drive_migrating', version), i + 1, toRun.length);

          // Snapshot table lengths + content hashes to detect which tables changed
          const snapshots = {};
          for (const table of DRIVE_TABLES) {
            snapshots[table] = JSON.stringify(inner._store[table] || []);
          }

          await DRIVE_MIGRATIONS[version](inner._store, migrationCtx);

          // Update schema_version in memory
          const entry = (inner._store.settings || []).find(s => s.key === 'schema_version');
          if (entry) {
            entry.value = version;
          } else {
            if (!inner._store.settings) inner._store.settings = [];
            inner._store.settings.push({ key: 'schema_version', value: version });
          }

          // Flush only tables that actually changed + settings (for version bump)
          const dirtyTables = new Set(['settings']);
          for (const table of DRIVE_TABLES) {
            if (table === 'settings') continue;
            if (JSON.stringify(inner._store[table] || []) !== snapshots[table]) {
              dirtyTables.add(table);
            }
          }

          const flushTok = await getToken();
          if (flushTok) {
            for (const table of dirtyTables) {
              const fileName = `${table}.json`;
              const meta = fileMeta[table] || {};
              const result = await uploadFile(flushTok, folderId, meta.fileId, fileName, inner._store[table] || []);
              fileMeta[table] = { fileId: result.id || meta.fileId, etag: result.etag, modifiedTime: new Date().toISOString() };
            }
          }
        }
      }
    }
  }

  // ── Per-table flush with ETag conflict handling ──

  const flushingTables = new Set();
  const flushPromises = {};

  async function flushTable(table, retries = 0) {
    // If a flush is already in progress, wait for it then re-flush
    // to capture any writes that happened during the previous flush.
    while (flushingTables.has(table)) {
      await (flushPromises[table] || Promise.resolve());
    }
    flushingTables.add(table);
    const p = (async () => {
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
            delete flushPromises[table];
            return flushTable(table, retries + 1);
          }
          throw err;
        }
      } catch (e) {
        console.error(`Drive: save failed for ${table}`, e);
      } finally {
        flushingTables.delete(table);
        delete flushPromises[table];
      }
    })();
    flushPromises[table] = p;
    return p;
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
          const newData = Array.isArray(data) ? data : [];
          const oldData = inner._store[tableName] || [];

          // Only update + notify if data actually changed (skip our own writes)
          if (JSON.stringify(newData) !== JSON.stringify(oldData)) {
            inner._store[tableName] = newData;
            fileMeta[tableName] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
            if (adapter._onExternalChange) adapter._onExternalChange(tableName);
          } else {
            // Same data (our own flush reflected back) — update metadata only
            fileMeta[tableName] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
          }
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

  // ── Global sync bar (covers ALL write operations) ──

  let _syncCount = 0;
  let _syncBar = null;

  function ensureSyncBar() {
    if (_syncBar) return _syncBar;
    _syncBar = document.createElement('div');
    _syncBar.className = 'drive-sync-bar';
    document.body.appendChild(_syncBar);
    return _syncBar;
  }

  function syncStart() {
    if (++_syncCount > 1) return;
    const bar = ensureSyncBar();
    bar.classList.remove('done', 'error');
    bar.classList.add('active');
  }

  function syncEnd(error) {
    if (--_syncCount > 0) return;
    _syncCount = 0;
    if (!_syncBar) return;
    _syncBar.classList.remove('active');
    _syncBar.classList.add(error ? 'error' : 'done');
    setTimeout(() => { if (_syncBar) _syncBar.classList.remove('done', 'error'); }, error ? 2500 : 400);
  }

  // ── Wrapped adapter ──

  const adapter = {
    from(table) {
      const builder = inner.from(table);
      const origThen = builder.then.bind(builder);
      builder.then = (resolve, reject) => {
        origThen(async (result) => {
          if (builder._method !== 'GET') {
            // Cancel any pending debounced save — we flush immediately
            if (saveTimers[table]) {
              clearTimeout(saveTimers[table]);
              delete saveTimers[table];
              dirtyTables.delete(table);
            }
            syncStart();
            let _err = false;
            try { await flushTable(table); }
            catch (e) { _err = true; console.error(`Drive: sync flush failed for ${table}`, e); }
            finally { syncEnd(_err); }
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

    /** Expose token getter for sharing module. */
    getToken,

    /** Open Google Picker to select files inside a shared folder.
     *  Used for drive.file scope: Picker grants per-file access. */
    async openSharedFolderPicker(folderId) {
      await ensurePickerApi();
      const tok = await getToken();
      const appId = clientId.split('-')[0];

      return new Promise((resolve) => {
        // Primary view: contents of the shared folder
        const folderView = new google.picker.DocsView()
          .setParent(folderId)
          .setIncludeFolders(false)
          .setMode(google.picker.DocsViewMode.LIST);

        // Fallback view: "Shared with me" (in case setParent fails)
        const sharedView = new google.picker.DocsView()
          .setOwnedByMe(false)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true);

        const picker = new google.picker.PickerBuilder()
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
          .addView(folderView)
          .addView(sharedView)
          .setOAuthToken(tok)
          .setAppId(appId)
          .setCallback((data) => {
            if (data.action === google.picker.Action.PICKED) {
              resolve(data.docs.map(d => ({
                id: d[google.picker.Document.ID],
                name: d[google.picker.Document.NAME],
                mimeType: d[google.picker.Document.MIME_TYPE],
              })));
            } else if (data.action === google.picker.Action.CANCEL) {
              resolve(null);
            }
          })
          .build();

        picker.setVisible(true);
      });
    },

    // Callback for external change notification
    _onExternalChange: null,

    startPolling,
    stopPolling,

    destroy() {
      stopPolling();
      for (const t of Object.keys(saveTimers)) clearTimeout(saveTimers[t]);
      clearDriveTokenCache(clientId);
    },
  };

  startPolling();

  emit('ready');
  return adapter;
}
