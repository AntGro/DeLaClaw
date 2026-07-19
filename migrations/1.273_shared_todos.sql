-- Migration 1.273: Add shared TODO columns
-- todos: shared_id + shared_group_id link a local todo to a shared Drive item

ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.273', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
