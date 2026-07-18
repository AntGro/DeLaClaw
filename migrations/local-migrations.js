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
  '1.270': `
    ALTER TABLE habits ADD COLUMN shared_id TEXT;
    ALTER TABLE habits ADD COLUMN shared_group_id TEXT;
    ALTER TABLE habit_completions ADD COLUMN completed_by TEXT;
  `,
  '1.273': `
    ALTER TABLE todos ADD COLUMN shared_id TEXT;
    ALTER TABLE todos ADD COLUMN shared_group_id TEXT;
  `,
  '1.287': `
    ALTER TABLE list_items ADD COLUMN shared_id TEXT;
    ALTER TABLE list_items ADD COLUMN shared_group_id TEXT;
  `,
  '1.294': `
    ALTER TABLE projects ADD COLUMN owner_id TEXT;
    ALTER TABLE tasks ADD COLUMN owner_id TEXT;
    ALTER TABLE todos ADD COLUMN owner_id TEXT;
    ALTER TABLE habits ADD COLUMN owner_id TEXT;
    ALTER TABLE habit_completions ADD COLUMN owner_id TEXT;
    ALTER TABLE flashcard_notes ADD COLUMN owner_id TEXT;
    ALTER TABLE birthdays ADD COLUMN owner_id TEXT;
    ALTER TABLE vestiaire ADD COLUMN owner_id TEXT;
    ALTER TABLE lists ADD COLUMN owner_id TEXT;
    ALTER TABLE list_items ADD COLUMN owner_id TEXT;
    ALTER TABLE settings ADD COLUMN owner_id TEXT;
    ALTER TABLE prompts ADD COLUMN owner_id TEXT;
  `,
  '1.297': `
    CREATE TABLE IF NOT EXISTS joined_groups (
      group_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      token TEXT NOT NULL,
      display_name TEXT,
      group_name TEXT,
      remote_backend_type TEXT NOT NULL,
      remote_url TEXT,
      remote_anon_key TEXT,
      owner_id TEXT,
      joined_at TEXT DEFAULT (datetime('now'))
    );
  `,
  '1.301': `
    ALTER TABLE joined_groups ADD COLUMN token_ciphertext TEXT;
    ALTER TABLE joined_groups ADD COLUMN token_iv TEXT;
    ALTER TABLE joined_groups ADD COLUMN remote_anon_key_ciphertext TEXT;
    ALTER TABLE joined_groups ADD COLUMN remote_anon_key_iv TEXT;
  `,
};
