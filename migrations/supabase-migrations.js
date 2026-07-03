// ===================================================================
// SUPABASE MIGRATIONS — embedded SQL for the schema-banner modal
// ===================================================================
// Each key is a version string (the version it brings the DB TO).
// Values are the raw SQL to run in the Supabase SQL Editor.
//
// When a new migration .sql file is added to migrations/, add the
// same SQL here so the in-app banner can show it.
//
// It is safe to concatenate multiple migrations — intermediate
// schema_version bumps are simply overwritten by the final one.
// ===================================================================

const SUPABASE_MIGRATIONS = {
  '1.099': `-- Migration 1.099: Enable Supabase Realtime for all tables
-- Required for cross-device live sync (postgres_changes subscriptions)

ALTER PUBLICATION supabase_realtime ADD TABLE
  tasks, projects, todos, habits, habit_completions,
  birthdays, vestiaire, flashcards, flashcard_notes,
  prompts, settings;

-- Bump schema version
UPDATE settings SET value = '1.099', updated_at = now()
WHERE key = 'schema_version';`,

  '1.100': `-- Migration 1.100: Add lists, list_items, daily_visits to Realtime publication
-- These tables were added to the schema but missing from the Realtime publication.

ALTER PUBLICATION supabase_realtime ADD TABLE lists, list_items, daily_visits;

-- Bump schema version
UPDATE settings SET value = '1.100', updated_at = now()
WHERE key = 'schema_version';`,

  '1.270': `-- Migration 1.270: Add shared habit columns
-- habits: shared_id + shared_group_id link a local habit to a shared Drive item
-- habit_completions: completed_by tracks who completed (email, null for personal)

ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS completed_by TEXT;

-- Bump schema version
UPDATE settings SET value = '1.270', updated_at = now()
WHERE key = 'schema_version';`,

  '1.273': `-- Migration 1.273: Add shared TODO columns
-- todos: shared_id + shared_group_id link a local todo to a shared Drive item

ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

-- Bump schema version
UPDATE settings SET value = '1.273', updated_at = now()
WHERE key = 'schema_version';`,
};

export { SUPABASE_MIGRATIONS };
