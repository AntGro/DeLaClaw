// ===================================================================
// GOOGLE DRIVE ADAPTER — in-memory runtime, Drive persistence
// ===================================================================
// On connect: pull a single JSON file from Google Drive into memory.
// At runtime: all reads/writes hit the in-memory store (instant).
// On mutation: debounced write-back to Drive (~2s after last change).
//
// Uses the demo adapter's DemoQueryBuilder under the hood — same
// chainable .from().select().eq().insert() interface, same CHECK
// constraints, same filtering and sorting logic. The only addition
// is the persistence layer.
//
// Requires Google Identity Services (loaded in index.html) and the
// OAuth client ID defined in main.js (GOOGLE_CLIENT_ID).
// ===================================================================

import { createDemoAdapter } from './demo.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FILE_NAME = 'delaclaw-data.json';
const DRIVE_FOLDER_NAME = 'DeLaClaw';
const DEBOUNCE_MS = 2000;

// ── Google Identity Services helpers ────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

function getGoogleAccessToken(clientId, promptIfNeeded = true) {
  // Return cached token if still valid (with 60s margin)
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
          // expires_in is in seconds
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
  // Search for existing folder
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

  // Create folder
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
  const folder = await create.json();
  return folder.id;
}

async function findDataFile(token, folderId) {
  const q = encodeURIComponent(
    `name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  const { files } = await resp.json();
  return (files && files.length > 0) ? files[0] : null;
}

async function downloadDataFile(token, fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status}`);
  return resp.json();
}

async function uploadDataFile(token, folderId, fileId, data) {
  const json = JSON.stringify(data, null, 2);
  const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json' };
  if (!fileId) metadata.parents = [folderId];

  const boundary = '---dlc-drive-boundary';
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `--${boundary}--`,
  ].join('\r\n');

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const resp = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive upload failed: ${resp.status} ${err}`);
  }
  return resp.json();
}

// ── Drive Adapter ───────────────────────────────────────────────

export async function createDriveAdapter(clientId, onStatus, { silent = false } = {}) {
  if (onStatus) onStatus('authenticating');

  // 1. Authenticate (silent = no popup, for auto-reconnect)
  const token = await getGoogleAccessToken(clientId, !silent);

  if (onStatus) onStatus('loading');

  // 2. Find or create folder + data file
  const folderId = await findOrCreateFolder(token);
  const existingFile = await findDataFile(token, folderId);

  let initialData = {};
  let fileId = existingFile ? existingFile.id : null;

  if (existingFile) {
    initialData = await downloadDataFile(token, existingFile.id);
  }

  // 3. Create in-memory adapter seeded with Drive data
  const inner = createDemoAdapter(initialData);

  // 4. Debounced write-back
  let saveTimer = null;
  let saving = false;
  let pendingSave = false;

  async function flush() {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    try {
      // Refresh token if needed (silent, no popup)
      let tok;
      try {
        tok = await getGoogleAccessToken(clientId, false);
      } catch {
        // Silent refresh failed — use cached token, might still work
        tok = _cachedToken;
      }
      if (!tok) {
        console.warn('Drive adapter: no valid token for save, skipping');
        return;
      }

      const store = inner._store;
      const data = {};
      for (const [table, rows] of Object.entries(store)) {
        data[table] = rows;
      }
      data._meta = {
        version: 1,
        saved_at: new Date().toISOString(),
        tables: Object.keys(store),
      };

      const result = await uploadDataFile(tok, folderId, fileId, data);
      // On first save, capture the file ID for subsequent updates
      if (!fileId) fileId = result.id;
    } catch (e) {
      console.error('Drive adapter: save failed', e);
    } finally {
      saving = false;
      if (pendingSave) {
        pendingSave = false;
        scheduleSave();
      }
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  // 5. Wrap the inner adapter to intercept mutations
  const adapter = {
    from(table) {
      const builder = inner.from(table);
      // Intercept thenable execution to detect writes
      const origThen = builder.then.bind(builder);
      builder.then = (resolve, reject) => {
        origThen((result) => {
          // If this was a mutation (not a GET), schedule a save
          if (builder._method !== 'GET') {
            scheduleSave();
          }
          resolve(result);
        }, reject);
      };
      return builder;
    },
    channel() { return inner.channel(); },
    rpc(fn, params) { return inner.rpc(fn, params); },
    // Expose for backup import compatibility
    reseed(data) {
      inner.reseed(data);
      scheduleSave();
    },
    get _store() { return inner._store; },
    // Manual save (e.g., before disconnect)
    async forceSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await flush();
    },
    // Expose for status checks
    get connected() { return true; },
    get driveFileId() { return fileId; },
    get driveFolderId() { return folderId; },
  };

  if (onStatus) onStatus('ready');
  return adapter;
}
