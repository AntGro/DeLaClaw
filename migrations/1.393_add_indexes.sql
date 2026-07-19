-- Migration 1.393: Add indexes for owner_id and shared_id to avoid seq scans as data grows
-- Covers audit item originally proposed as 1.341_add_indexes.sql
-- owner_id is used in every RLS policy (owner_id = auth.uid()) — without an index every query seq scans the whole table
-- shared_id / shared_group_id are used to lookup local pointers for shared todos/habits/list_items

-- ── owner_id indexes (13 personal tables + joined_groups) ──
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

-- ── shared_id / shared_group_id indexes (shared pointers) ──
CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);

-- ── sharing tables (auth_owner_id / group_id lookups) ──
CREATE INDEX IF NOT EXISTS idx_sharing_groups_auth_owner_id ON sharing_groups(auth_owner_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_id ON sharing_members(group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_items_group_id ON sharing_items(group_id);

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.393', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.393', now()) ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
