-- Migration 1.270: Add shared habit columns
-- habits: shared_id + shared_group_id link a local habit to a shared Drive item
-- habit_completions: completed_by tracks who completed (email, null for personal)

ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS completed_by TEXT;

-- Bump schema version
UPDATE settings SET value = '1.270', updated_at = now()
WHERE key = 'schema_version';
