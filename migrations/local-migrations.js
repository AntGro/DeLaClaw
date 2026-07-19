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
  '1.393': `
    CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
    CREATE INDEX IF NOT EXISTS idx_todos_owner_id ON todos(owner_id);
    CREATE INDEX IF NOT EXISTS idx_habits_owner_id ON habits(owner_id);
    CREATE INDEX IF NOT EXISTS idx_habit_completions_owner_id ON habit_completions(owner_id);
    CREATE INDEX IF NOT EXISTS idx_flashcard_notes_owner_id ON flashcard_notes(owner_id);
    CREATE INDEX IF NOT EXISTS idx_birthdays_owner_id ON birthdays(owner_id);
    CREATE INDEX IF NOT EXISTS idx_vestiaire_owner_id ON vestiaire(owner_id);
    CREATE INDEX IF NOT EXISTS idx_lists_owner_id ON lists(owner_id);
    CREATE INDEX IF NOT EXISTS idx_list_items_owner_id ON list_items(owner_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_owner_id ON prompts(owner_id);
    CREATE INDEX IF NOT EXISTS idx_settings_owner_id ON settings(owner_id);
    CREATE INDEX IF NOT EXISTS idx_joined_groups_owner_id ON joined_groups(owner_id);
    CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
    CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
    CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
    CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
    CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
    CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);
  `,
  '1.396': `
    -- 1.396: drop plaintext fallback for joined_groups (assume >=1.301, ciphertext exists)
    UPDATE joined_groups SET token = NULL, remote_anon_key = NULL WHERE token_ciphertext IS NOT NULL;
    DELETE FROM joined_groups WHERE owner_id IS NULL;
  `,
  '1.398': `
    -- 1.398: owner-only for previously open tables
    ALTER TABLE flashcards ADD COLUMN owner_id TEXT;
    ALTER TABLE texts ADD COLUMN owner_id TEXT;
    ALTER TABLE text_line_progress ADD COLUMN owner_id TEXT;
    ALTER TABLE nvidia_usage ADD COLUMN owner_id TEXT;
    -- daily_visits: add owner_id, migrate to composite PK (visit_date, owner_id)
    ALTER TABLE daily_visits ADD COLUMN owner_id TEXT;
    -- Recreate daily_visits with composite PK to allow same date per owner
    CREATE TABLE IF NOT EXISTS daily_visits_new (
      visit_date TEXT NOT NULL,
      owner_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (visit_date, owner_id)
    );
    INSERT OR IGNORE INTO daily_visits_new (visit_date, owner_id, created_at)
      SELECT visit_date, owner_id, created_at FROM daily_visits;
    DROP TABLE daily_visits;
    ALTER TABLE daily_visits_new RENAME TO daily_visits;

    CREATE INDEX IF NOT EXISTS idx_flashcards_owner_id ON flashcards(owner_id);
    CREATE INDEX IF NOT EXISTS idx_texts_owner_id ON texts(owner_id);
    CREATE INDEX IF NOT EXISTS idx_text_line_progress_owner_id ON text_line_progress(owner_id);
    CREATE INDEX IF NOT EXISTS idx_nvidia_usage_owner_id ON nvidia_usage(owner_id);
    CREATE INDEX IF NOT EXISTS idx_daily_visits_owner_id ON daily_visits(owner_id);
  `,
  '1.410': `
    CREATE TABLE IF NOT EXISTS agent_grants (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      owner_id TEXT,
      display_name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL DEFAULT 'full',
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_grants_owner_id ON agent_grants(owner_id);
    CREATE INDEX IF NOT EXISTS idx_agent_grants_token_hash ON agent_grants(token_hash);
  `,
};
