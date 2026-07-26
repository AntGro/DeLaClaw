-- temp_v270_v300.sql
-- Aggregates temp_v270_v287, temp_v294_v296, temp_v297_v300
-- Covers migrations 1.270–1.300
-- Net effect:
--   1. Sharing pointer columns on habits, todos, list_items
--   2. owner_id on 12 personal tables
--   3. Sharing tables (groups, members, items) + RLS + realtime
--   4. joined_groups table
--   5. set_owner_id() trigger + claim_ownership() RPC
--   6. "owner only" RLS + insert triggers on all personal tables (skips intermediate "owner or unclaimed")
--   7. RPC functions for token-based sharing access

-- ══════════════════════════════════════════════════
-- 1. Sharing pointer columns
-- ══════════════════════════════════════════════════
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_group_id TEXT;
ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS completed_by TEXT;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_id TEXT;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_group_id TEXT;

-- ══════════════════════════════════════════════════
-- 2. owner_id on personal tables
-- ══════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════
-- 3. Sharing tables
-- ══════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════
-- 4. joined_groups table
-- ══════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════
-- 5. Helper functions
-- ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_owner_id() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN NEW.owner_id := auth.uid(); END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION claim_ownership() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE projects SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE todos SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habits SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE lists SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE settings SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL;
END;
$$;

-- ══════════════════════════════════════════════════
-- 6. "owner only" RLS + insert triggers
--    (replaces "allow all" from 1.100 directly — skips intermediate "owner or unclaimed")
-- ══════════════════════════════════════════════════
DROP POLICY IF EXISTS "allow all" ON projects; DROP POLICY IF EXISTS "owner only" ON projects;
CREATE POLICY "owner only" ON projects FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON projects; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON tasks; DROP POLICY IF EXISTS "owner only" ON tasks;
CREATE POLICY "owner only" ON tasks FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON todos; DROP POLICY IF EXISTS "owner only" ON todos;
CREATE POLICY "owner only" ON todos FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON todos; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON habits; DROP POLICY IF EXISTS "owner only" ON habits;
CREATE POLICY "owner only" ON habits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON habit_completions; DROP POLICY IF EXISTS "owner only" ON habit_completions;
CREATE POLICY "owner only" ON habit_completions FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON flashcard_notes; DROP POLICY IF EXISTS "owner only" ON flashcard_notes;
CREATE POLICY "owner only" ON flashcard_notes FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON birthdays; DROP POLICY IF EXISTS "owner only" ON birthdays;
CREATE POLICY "owner only" ON birthdays FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON vestiaire; DROP POLICY IF EXISTS "owner only" ON vestiaire;
CREATE POLICY "owner only" ON vestiaire FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON lists; DROP POLICY IF EXISTS "owner only" ON lists;
CREATE POLICY "owner only" ON lists FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON lists; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON list_items; DROP POLICY IF EXISTS "owner only" ON list_items;
CREATE POLICY "owner only" ON list_items FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON settings; DROP POLICY IF EXISTS "owner only" ON settings;
CREATE POLICY "owner only" ON settings FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON settings; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON prompts; DROP POLICY IF EXISTS "owner only" ON prompts;
CREATE POLICY "owner only" ON prompts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- ══════════════════════════════════════════════════
-- 7. RPC functions for token-based sharing
-- ══════════════════════════════════════════════════
-- verify_join_token: v300 version with creator_name
CREATE OR REPLACE FUNCTION verify_join_token(p_token TEXT)
RETURNS TABLE(group_id TEXT, group_name TEXT, member_id TEXT,
              display_name TEXT, backend_type TEXT, creator_name TEXT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm
          WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
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
