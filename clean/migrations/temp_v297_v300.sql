-- temp_v297_v300.sql
-- Aggregates migrations 1.297, 1.298, 1.299, 1.300
-- Net effect:
--   1. joined_groups table (with owner-only RLS directly, skipping the broken "or unclaimed" intermediate)
--   2. verify_join_token replaced to include creator_name (supersedes 1.296 version)
--   3. set_owner_id() trigger function + claim_ownership() RPC
--   4. All personal tables upgraded from "owner or unclaimed" → "owner only" + insert triggers

-- ── 1. joined_groups table ──
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

-- ── 2. verify_join_token with creator_name (replaces 1.296 version) ──
DROP FUNCTION IF EXISTS verify_join_token(text);

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

-- ── 3. Helper functions ──
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

-- ── 4. Owner-only RLS + insert triggers on all personal tables ──
-- (replaces "owner or unclaimed" from 1.294)

DROP POLICY IF EXISTS "allow all" ON projects; DROP POLICY IF EXISTS "owner or unclaimed" ON projects; DROP POLICY IF EXISTS "owner only" ON projects;
CREATE POLICY "owner only" ON projects FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON projects; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON tasks; DROP POLICY IF EXISTS "owner or unclaimed" ON tasks; DROP POLICY IF EXISTS "owner only" ON tasks;
CREATE POLICY "owner only" ON tasks FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON todos; DROP POLICY IF EXISTS "owner or unclaimed" ON todos; DROP POLICY IF EXISTS "owner only" ON todos;
CREATE POLICY "owner only" ON todos FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON todos; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON habits; DROP POLICY IF EXISTS "owner or unclaimed" ON habits; DROP POLICY IF EXISTS "owner only" ON habits;
CREATE POLICY "owner only" ON habits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON habit_completions; DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions; DROP POLICY IF EXISTS "owner only" ON habit_completions;
CREATE POLICY "owner only" ON habit_completions FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON flashcard_notes; DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes; DROP POLICY IF EXISTS "owner only" ON flashcard_notes;
CREATE POLICY "owner only" ON flashcard_notes FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON birthdays; DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays; DROP POLICY IF EXISTS "owner only" ON birthdays;
CREATE POLICY "owner only" ON birthdays FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON vestiaire; DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire; DROP POLICY IF EXISTS "owner only" ON vestiaire;
CREATE POLICY "owner only" ON vestiaire FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON lists; DROP POLICY IF EXISTS "owner or unclaimed" ON lists; DROP POLICY IF EXISTS "owner only" ON lists;
CREATE POLICY "owner only" ON lists FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON lists; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON list_items; DROP POLICY IF EXISTS "owner or unclaimed" ON list_items; DROP POLICY IF EXISTS "owner only" ON list_items;
CREATE POLICY "owner only" ON list_items FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON settings; DROP POLICY IF EXISTS "owner or unclaimed" ON settings; DROP POLICY IF EXISTS "owner only" ON settings;
CREATE POLICY "owner only" ON settings FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON settings; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "allow all" ON prompts; DROP POLICY IF EXISTS "owner or unclaimed" ON prompts; DROP POLICY IF EXISTS "owner only" ON prompts;
CREATE POLICY "owner only" ON prompts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups; DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();
