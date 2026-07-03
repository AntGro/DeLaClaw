-- Migration 1.273: Add shared TODO columns
-- todos: shared_id + shared_group_id link a local todo to a shared Drive item

ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

-- Bump schema version
UPDATE settings SET value = '1.273', updated_at = now()
WHERE key = 'schema_version';
