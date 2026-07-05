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

  '1.287': `-- Shared list items: thin pointer model
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

-- Bump schema version
UPDATE settings SET value = '1.287', updated_at = now()
WHERE key = 'schema_version';`,

  '1.294': `-- Migration 1.294: Add owner_id to personal tables + rewrite RLS
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE flashcard_notes ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE birthdays ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE vestiaire ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS owner_id UUID;

DROP POLICY IF EXISTS "allow all" ON projects;
CREATE POLICY "owner or unclaimed" ON projects USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON tasks;
CREATE POLICY "owner or unclaimed" ON tasks USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON todos;
CREATE POLICY "owner or unclaimed" ON todos USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON habits;
CREATE POLICY "owner or unclaimed" ON habits USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON habit_completions;
CREATE POLICY "owner or unclaimed" ON habit_completions USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON flashcard_notes;
CREATE POLICY "owner or unclaimed" ON flashcard_notes USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON birthdays;
CREATE POLICY "owner or unclaimed" ON birthdays USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON vestiaire;
CREATE POLICY "owner or unclaimed" ON vestiaire USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON lists;
CREATE POLICY "owner or unclaimed" ON lists USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON list_items;
CREATE POLICY "owner or unclaimed" ON list_items USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON settings;
CREATE POLICY "owner or unclaimed" ON settings USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON prompts;
CREATE POLICY "owner or unclaimed" ON prompts USING (owner_id = auth.uid() OR owner_id IS NULL);

UPDATE settings SET value = '1.294', updated_at = now() WHERE key = 'schema_version';`,

  '1.295': `-- Migration 1.295: Sharing tables for D+E hybrid
CREATE TABLE IF NOT EXISTS sharing_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  backend_type TEXT NOT NULL DEFAULT 'supabase',
  auth_owner_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sharing_members (
  member_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES sharing_groups(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sharing_items (
  item_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES sharing_groups(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  parent_item_id TEXT,
  payload JSONB NOT NULL,
  created_by TEXT REFERENCES sharing_members(member_id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sharing_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner" ON sharing_groups FOR ALL USING (auth_owner_id = auth.uid());
CREATE POLICY "owner" ON sharing_members FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));
CREATE POLICY "owner" ON sharing_items FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));

ALTER PUBLICATION supabase_realtime ADD TABLE sharing_groups, sharing_members, sharing_items;

UPDATE settings SET value = '1.295', updated_at = now() WHERE key = 'schema_version';`,

  '1.296': `-- Migration 1.296: RPC functions for token-based member access
CREATE OR REPLACE FUNCTION verify_join_token(p_token TEXT)
RETURNS TABLE(group_id TEXT, group_name TEXT, member_id TEXT, display_name TEXT, backend_type TEXT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token = p_token AND sm.joined_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION confirm_join(p_token TEXT, p_display_name TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_members
  SET joined_at = now(), display_name = COALESCE(NULLIF(p_display_name, ''), display_name)
  WHERE token = p_token AND joined_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION get_shared_items(p_token TEXT, p_group_id TEXT, p_item_type TEXT DEFAULT NULL)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT si.* FROM sharing_items si
  WHERE si.group_id = p_group_id
  AND (p_item_type IS NULL OR si.item_type = p_item_type)
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id AND sm.token = p_token AND sm.joined_at IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION add_shared_item(p_token TEXT, p_item_id TEXT, p_group_id TEXT, p_item_type TEXT, p_payload JSONB, p_member_id TEXT, p_parent_item_id TEXT DEFAULT NULL)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO sharing_items (item_id, group_id, item_type, parent_item_id, payload, created_by)
  SELECT p_item_id, p_group_id, p_item_type, p_parent_item_id, p_payload, p_member_id
  WHERE EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id AND sm.token = p_token AND sm.member_id = p_member_id AND sm.joined_at IS NOT NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION update_shared_item(p_token TEXT, p_item_id TEXT, p_payload JSONB)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_items si
  SET payload = p_payload, updated_at = now()
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id AND sm.token = p_token AND sm.joined_at IS NOT NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION delete_shared_item(p_token TEXT, p_item_id TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_items si
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id AND sm.token = p_token AND sm.joined_at IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION get_group_members(p_token TEXT, p_group_id TEXT)
RETURNS TABLE(member_id TEXT, display_name TEXT, role TEXT, joined_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id AND sm2.token = p_token AND sm2.joined_at IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_members WHERE token = p_token AND role != 'creator';
END;
$$;

UPDATE settings SET value = '1.296', updated_at = now() WHERE key = 'schema_version';`,

  '1.297': `-- Migration 1.297: Persistent token storage for joined groups
CREATE TABLE IF NOT EXISTS joined_groups (
  group_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  token TEXT NOT NULL,
  display_name TEXT,
  group_name TEXT,
  remote_backend_type TEXT NOT NULL,
  remote_url TEXT,
  remote_anon_key TEXT,
  owner_id UUID,
  joined_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE joined_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner or unclaimed" ON joined_groups FOR ALL USING (owner_id = auth.uid() OR owner_id IS NULL);

UPDATE settings SET value = '1.297', updated_at = now() WHERE key = 'schema_version';`,
};

export { SUPABASE_MIGRATIONS };
