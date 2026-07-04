-- Shared list items: thin pointer model (same as habits & todos)
-- Local pointer stores only shared_id + shared_group_id; text, note, checked live on Drive

ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
