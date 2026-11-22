// ===================================================================
// drive.js — the extension's small Drive client (spec §5, contracts §2).
//
// Reads and writes the variant's table files. Every write is a
// whole-file read-modify-write guarded by the md5 pre-check: Drive
// returns no ETag anywhere (spike, 15 Nov 2026), so the app's
// If-Match/412 path is dead and there is nothing to put in an
// If-Match header. Serialization is exactly the app's:
// JSON.stringify(data, null, 2).
//
// All functions take fetchImpl (default: global fetch) so Node tests can
// stub the network. Nothing here touches chrome.* except through the
// token passed in — auth lives in auth.js.
// ===================================================================

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
// The app's multipart boundary (js/adapters/drive.js uploadFile).
export const MULTIPART_BOUNDARY = '---dlc-drive-boundary';

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function apiJson(fetchImpl, url, { token, method = 'GET', headers = {}, body } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { ...authHeaders(token), ...headers },
    body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`Drive request failed (HTTP ${res.status}): ${(text || '').slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Resolves the variant folder by name. Aborts unless exactly one folder
// matches — a missing folder means "open the app and sign in there
// first"; the extension never creates one (spec §4).
export async function resolveFolderId(token, folderName, fetchImpl = fetch) {
  const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const data = await apiJson(fetchImpl,
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { token });
  const files = data?.files || [];
  if (files.length === 0) {
    const err = new Error(`No '${folderName}' folder found in this Drive account. Open DeLaClaw and sign in there first.`);
    err.code = 'NO_FOLDER';
    throw err;
  }
  if (files.length > 1) {
    throw new Error(`More than one '${folderName}' folder found — refusing to guess.`);
  }
  return files[0].id;
}

// A folder id belongs to one account: the cache is keyed by the
// account email and drops when the account changes or on sign-out, so
// switching Google accounts never reuses the previous account's folder
// id (006c30f review).
export function createFolderCache() {
  let cached = null; // { email, folderId }
  return {
    async folderId(token, folderName, accountEmail, fetchImpl = fetch) {
      if (!cached || cached.email !== accountEmail) {
        cached = { email: accountEmail || null, folderId: await resolveFolderId(token, folderName, fetchImpl) };
      }
      return cached.folderId;
    },
    reset() { cached = null; },
  };
}

// One files.list on the folder: id, name, size, md5Checksum, modifiedTime.
export async function listFolderFiles(token, folderId, fetchImpl = fetch) {
  const q = `'${folderId}' in parents and trashed=false`;
  const data = await apiJson(fetchImpl,
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum,modifiedTime)&pageSize=100`,
    { token });
  return data?.files || [];
}

export function findFile(files, name) {
  return files.find((f) => f.name === name) || null;
}

export async function downloadFile(token, fileId, fetchImpl = fetch) {
  const res = await fetchImpl(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: authHeaders(token),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Could not download the file (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// The app's upload shape, verbatim: PATCH uploadType=multipart, a
// multipart/related body with a metadata part and a JSON part.
export async function uploadFile(token, fileId, fileName, data, fetchImpl = fetch) {
  const body = [
    `--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, mimeType: 'application/json' })}`,
    `--${MULTIPART_BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 2)}`,
    `--${MULTIPART_BOUNDARY}--`,
  ].join('\r\n');
  const res = await fetchImpl(
    `${UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id`,
    {
      method: 'PATCH',
      headers: {
        ...authHeaders(token),
        'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
      },
      body,
    },
  );
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Could not save the file (HTTP ${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text || '{}');
}

// Reads a table file's metadata (md5Checksum) without downloading it.
async function fetchFileMeta(token, fileId, fetchImpl) {
  return apiJson(fetchImpl,
    `${DRIVE_API}/files/${fileId}?fields=md5Checksum,modifiedTime`, { token });
}

// One write at a time per file, inside this worker: two concurrent
// writeTable calls for the same file would both pass the md5 pre-check
// and the second upload would silently clobber the first (006c30f
// review). The chain tail never rejects, so a failed write does not
// stall later writers; the entry is dropped once the chain drains.
const writeQueues = new Map();

// The §2 write protocol. `file` is the files.list entry for the table
// (id, name, md5Checksum): its md5Checksum is the baseline — the file
// as listed at the start of the operation. mutate(rows) returns the new
// rows; verify(rows) confirms the change landed (a write without a
// confirming read-back is not a success). On a moved file, re-reads once
// and re-applies; a second move aborts and writes nothing.
export async function writeTable(token, file, mutate, verify, fetchImpl = fetch) {
  const attempt = async (n, baselineMd5) => {
    const rows = await downloadFile(token, file.id, fetchImpl);
    // md5 pre-check, immediately before upload.
    const metaNow = (await fetchFileMeta(token, file.id, fetchImpl)).md5Checksum;
    if (metaNow !== baselineMd5) {
      if (n === 1) {
        // Re-read once: fresh baseline, fresh rows, re-apply.
        const freshMeta = await fetchFileMeta(token, file.id, fetchImpl);
        return attempt(2, freshMeta.md5Checksum);
      }
      throw new Error('The file changed twice while saving — aborting, nothing written.');
    }
    const newRows = mutate(rows);
    await uploadFile(token, file.id, file.name, newRows, fetchImpl);
    const readBack = await downloadFile(token, file.id, fetchImpl);
    // The read-back must still hold every row this write produced — not
    // just the new one the caller's verify checks: another writer
    // overwriting the file between our upload and this read would
    // otherwise silently drop rows we just re-wrote.
    const writtenIds = new Set((Array.isArray(newRows) ? newRows : []).filter(r => r && r.id).map(r => r.id));
    const readIds = new Set((Array.isArray(readBack) ? readBack : []).filter(r => r && r.id).map(r => r.id));
    if ([...writtenIds].some(id => !readIds.has(id))) {
      throw new Error('The file changed while saving — some rows are missing from the read-back. Please try again.');
    }
    if (!verify(readBack)) {
      throw new Error('The change did not survive the save — please try again.');
    }
    return readBack;
  };
  const prev = writeQueues.get(file.id) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => attempt(1, file.md5Checksum));
  const tail = run.catch(() => {});
  writeQueues.set(file.id, tail);
  tail.finally(() => { if (writeQueues.get(file.id) === tail) writeQueues.delete(file.id); });
  return run;
}

// Reads settings.json's schema_version (a { key, value } row). Returns
// null when the row is missing — the caller refuses the write.
export async function readSchemaVersion(token, files, fetchImpl = fetch) {
  const settings = findFile(files, 'settings.json');
  if (!settings) return null;
  const rows = await downloadFile(token, settings.id, fetchImpl);
  const entry = (Array.isArray(rows) ? rows : []).find((r) => r.key === 'schema_version');
  return entry ? String(entry.value) : null;
}
