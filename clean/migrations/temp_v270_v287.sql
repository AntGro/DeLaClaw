-- temp_v270_v287.sql
-- Aggregates migrations 1.270, 1.273, 1.287
-- Adds sharing pointer columns to habits, todos, list_items

ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS completed_by TEXT;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
