-- temp_v294_v296.sql
-- Aggregates migrations 1.294, 1.295, 1.296
-- 1.294: owner_id on personal tables + owner-or-unclaimed RLS
-- 1.295: sharing tables (groups, members, items) + RLS + realtime
-- 1.296: RPC functions for token-based member access

-- ── 1. owner_id on personal tables ──
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

-- ── 2. RLS: owner or unclaimed ──
DROP POLICY IF EXISTS "allow all" ON projects;
DROP POLICY IF EXISTS "owner or unclaimed" ON projects;
CREATE POLICY "owner or unclaimed" ON projects USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON tasks;
DROP POLICY IF EXISTS "owner or unclaimed" ON tasks;
CREATE POLICY "owner or unclaimed" ON tasks USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON todos;
DROP POLICY IF EXISTS "owner or unclaimed" ON todos;
CREATE POLICY "owner or unclaimed" ON todos USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON habits;
DROP POLICY IF EXISTS "owner or unclaimed" ON habits;
CREATE POLICY "owner or unclaimed" ON habits USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON habit_completions;
DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions;
CREATE POLICY "owner or unclaimed" ON habit_completions USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes;
CREATE POLICY "owner or unclaimed" ON flashcard_notes USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON birthdays;
DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays;
CREATE POLICY "owner or unclaimed" ON birthdays USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON vestiaire;
DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire;
CREATE POLICY "owner or unclaimed" ON vestiaire USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON lists;
DROP POLICY IF EXISTS "owner or unclaimed" ON lists;
CREATE POLICY "owner or unclaimed" ON lists USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON list_items;
DROP POLICY IF EXISTS "owner or unclaimed" ON list_items;
CREATE POLICY "owner or unclaimed" ON list_items USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON settings;
DROP POLICY IF EXISTS "owner or unclaimed" ON settings;
CREATE POLICY "owner or unclaimed" ON settings USING (owner_id = auth.uid() OR owner_id IS NULL);
DROP POLICY IF EXISTS "allow all" ON prompts;
DROP POLICY IF EXISTS "owner or unclaimed" ON prompts;
CREATE POLICY "owner or unclaimed" ON prompts USING (owner_id = auth.uid() OR owner_id IS NULL);

-- ── 3. Sharing tables ──
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

DROP POLICY IF EXISTS "owner" ON sharing_groups;
CREATE POLICY "owner" ON sharing_groups FOR ALL USING (auth_owner_id = auth.uid());
DROP POLICY IF EXISTS "owner" ON sharing_members;
CREATE POLICY "owner" ON sharing_members FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));
DROP POLICY IF EXISTS "owner" ON sharing_items;
CREATE POLICY "owner" ON sharing_items FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sharing_groups, sharing_members, sharing_items;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. RPC functions for token-based member access ──
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
