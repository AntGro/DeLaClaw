// ===================================================================
// LOCAL MIGRATIONS — SQLite DDL/DML for the Bun+SQLite backend
// ===================================================================
// Each key is a version string. Migrations run in version order on
// server startup when schema_version is behind.
//
// Migration values are SQL strings executed against the SQLite DB.
// After each migration:
//   1. schema_version is bumped in the settings table
//   2. Changes are committed (each migration runs in its own transaction)
//
// Before any migration runs, the .db file is copied to
// backup-v{currentVersion}.db alongside the original.
//
// Adding a migration:
//   1. Add an entry keyed by the version it brings the DB TO
//   2. The value is a SQL string — can contain multiple statements
//   3. Do NOT include schema_version bump — the runner handles it
//   4. Use SQLite-compatible syntax (not Postgres)
//
// Example:
//   '1.140': `
//     ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'normal';
//   `,
//   '1.145': `
//     CREATE TABLE IF NOT EXISTS new_table (
//       id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
//       name TEXT NOT NULL,
//       created_at TEXT DEFAULT (datetime('now'))
//     );
//   `,
//
// Common SQLite vs Postgres differences:
//   - TEXT instead of UUID/TIMESTAMPTZ
//   - datetime('now') instead of now()
//   - lower(hex(randomblob(16))) instead of gen_random_uuid()
//   - No ALTER TABLE ... ALTER COLUMN (drop+recreate instead)
//   - INTEGER for booleans (0/1) instead of BOOLEAN
// ===================================================================

export const LOCAL_MIGRATIONS = {
  // No migrations yet — schema.sql covers the full current schema
};
