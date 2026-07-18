// ===================================================================
// DRIVE MIGRATIONS — JS transforms for per-table Drive data
// ===================================================================
// Each key is a version string. Migrations run in version order when
// the Drive backend's schema_version is behind the app.
//
// Migration functions receive two arguments:
//   store — the raw in-memory object (store.tableName = array of records)
//   ctx   — Drive API context for file-level operations:
//           { token, folderId, fileMeta, filesByName, getToken,
//             DRIVE_TABLES, uploadFile, downloadFile, deleteFile,
//             listFolderFiles }
//
// Most migrations only need `store` (in-memory transforms).
// Use `ctx` only when the migration needs to create/delete/rename
// Drive files themselves (like the legacy format conversion below).
//
// After each migration:
//   1. schema_version is bumped in the in-memory settings
//   2. All tables are flushed to Drive (the runner handles this)
//
// Before any migration runs, a full backup is saved to Drive as
// backup-v{currentVersion}.json.
//
// Adding a migration:
//   1. Add an entry keyed by the version it brings the DB TO
//   2. Modify `store` in place for data transforms
//   3. Use `ctx` for file-level operations if needed
//   4. Return nothing — the runner handles persistence
//
// Example (data transform only):
//   '1.150': async (store) => {
//     (store.todos || []).forEach(t => {
//       t.priority = t.importance;
//       delete t.importance;
//     });
//   },
//
// Example (file-level operation):
//   '1.160': async (store, ctx) => {
//     const tok = await ctx.getToken();
//     await ctx.uploadFile(tok, ctx.folderId, null, 'new_table.json', []);
//   },
// ===================================================================

const LEGACY_FILE_NAME = 'delaclaw-data.json';

export const DRIVE_MIGRATIONS = {
  // Convert legacy single-file format to per-table files.
  // The adapter has already loaded data into memory from whatever
  // format it found; this migration creates the per-table Drive files
  // and deletes the legacy blob.
  '1.132': async (store, ctx) => {
    const legacyFile = ctx.filesByName.get(LEGACY_FILE_NAME);
    if (!legacyFile) return; // Already per-table or fresh install

    const tok = await ctx.getToken();
    if (!tok) throw new Error('No token for legacy migration');

    // Create per-table files from the in-memory store
    for (const table of ctx.DRIVE_TABLES) {
      const fileName = `${table}.json`;
      const result = await ctx.uploadFile(tok, ctx.folderId, null, fileName, store[table] || []);
      ctx.fileMeta[table] = { fileId: result.id, etag: result.etag, modifiedTime: new Date().toISOString() };
    }

    // Delete legacy file
    await ctx.deleteFile(tok, legacyFile.id);
  },
  // 1.393: indexes for owner_id / shared_id — perf only for Postgres/SQLite, no-op for Drive (in-memory)
  // Drive has no seq scans: whole tables are loaded into memory. Bump version only.
  '1.393': async (_store) => {},
  '1.396': async (store) => {
    // Remove plaintext fallback (>=1.301 assumed)
    for (const row of (store.joined_groups || [])) {
      if (row.token_ciphertext) {
        row.token = null;
        row.remote_anon_key = null;
      }
    }
    // Delete owner_id IS NULL (legacy pre-1.299 rows)
    if (store.joined_groups) {
      store.joined_groups = store.joined_groups.filter(r => r.owner_id != null);
    }
  },
};
