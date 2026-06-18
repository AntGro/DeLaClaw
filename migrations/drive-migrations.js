// ===================================================================
// DRIVE MIGRATIONS — JS transforms for per-table Drive data
// ===================================================================
// Each key is a version string. Migrations run in version order when
// the Drive backend's schema_version is behind the app.
//
// Migration functions receive the in-memory store object and modify
// it in place. After each migration:
//   1. All modified tables are flushed to Drive
//   2. schema_version is bumped and settings.json is flushed
//
// Before any migration runs, a full backup is saved to Drive as
// backup-v{currentVersion}.json.
//
// Adding a migration:
//   1. Add an entry keyed by the version it brings the DB TO
//   2. The function receives `store` — the raw in-memory object
//      where store.tableName is an array of records
//   3. Modify in place: add/remove/rename fields, create new tables
//   4. Return nothing — the runner handles persistence
//
// Example:
//   '1.140': async (store) => {
//     // Rename field in todos
//     (store.todos || []).forEach(t => {
//       t.priority = t.importance;
//       delete t.importance;
//     });
//   },
//   '1.145': async (store) => {
//     // New table
//     if (!store.new_table) store.new_table = [];
//   },
// ===================================================================

export const DRIVE_MIGRATIONS = {
  // No migrations yet — per-table format starts clean at 1.132
};
