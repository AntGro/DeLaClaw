-- Migration 1.300: Enforce owner-only RLS (mandatory auth for Supabase)
-- After this, anon users see 0 rows. Authenticated users see only rows where owner_id = auth.uid()
-- Existing NULL rows must be claimed BEFORE or VIA claim_ownership() RPC (SECURITY DEFINER)

-- ── Helper: auto-set owner_id on insert ───────────────────────
CREATE OR REPLACE FUNCTION set_owner_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    NEW.owner_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- ── Helper: claim all unclaimed rows for current auth user ─────
-- SECURITY DEFINER bypasses RLS so it works even after owner-only policies
CREATE OR REPLACE FUNCTION claim_ownership()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
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

-- ── Apply owner-only policies + triggers for each personal table ─
-- Projects
DROP POLICY IF EXISTS "allow all" ON projects;
DROP POLICY IF EXISTS "owner or unclaimed" ON projects;
DROP POLICY IF EXISTS "owner only" ON projects;
CREATE POLICY "owner only" ON projects FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON projects;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Tasks
DROP POLICY IF EXISTS "allow all" ON tasks;
DROP POLICY IF EXISTS "owner or unclaimed" ON tasks;
DROP POLICY IF EXISTS "owner only" ON tasks;
CREATE POLICY "owner only" ON tasks FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Todos
DROP POLICY IF EXISTS "allow all" ON todos;
DROP POLICY IF EXISTS "owner or unclaimed" ON todos;
DROP POLICY IF EXISTS "owner only" ON todos;
CREATE POLICY "owner only" ON todos FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON todos;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Habits
DROP POLICY IF EXISTS "allow all" ON habits;
DROP POLICY IF EXISTS "owner or unclaimed" ON habits;
DROP POLICY IF EXISTS "owner only" ON habits;
CREATE POLICY "owner only" ON habits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habits;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Habit completions
DROP POLICY IF EXISTS "allow all" ON habit_completions;
DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions;
DROP POLICY IF EXISTS "owner only" ON habit_completions;
CREATE POLICY "owner only" ON habit_completions FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Flashcard notes
DROP POLICY IF EXISTS "allow all" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes;
DROP POLICY IF EXISTS "owner only" ON flashcard_notes;
CREATE POLICY "owner only" ON flashcard_notes FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Birthdays
DROP POLICY IF EXISTS "allow all" ON birthdays;
DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays;
DROP POLICY IF EXISTS "owner only" ON birthdays;
CREATE POLICY "owner only" ON birthdays FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Vestiaire
DROP POLICY IF EXISTS "allow all" ON vestiaire;
DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire;
DROP POLICY IF EXISTS "owner only" ON vestiaire;
CREATE POLICY "owner only" ON vestiaire FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Lists
DROP POLICY IF EXISTS "allow all" ON lists;
DROP POLICY IF EXISTS "owner or unclaimed" ON lists;
DROP POLICY IF EXISTS "owner only" ON lists;
CREATE POLICY "owner only" ON lists FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON lists;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- List items
DROP POLICY IF EXISTS "allow all" ON list_items;
DROP POLICY IF EXISTS "owner or unclaimed" ON list_items;
DROP POLICY IF EXISTS "owner only" ON list_items;
CREATE POLICY "owner only" ON list_items FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Settings
DROP POLICY IF EXISTS "allow all" ON settings;
DROP POLICY IF EXISTS "owner or unclaimed" ON settings;
DROP POLICY IF EXISTS "owner only" ON settings;
CREATE POLICY "owner only" ON settings FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON settings;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Prompts
DROP POLICY IF EXISTS "allow all" ON prompts;
DROP POLICY IF EXISTS "owner or unclaimed" ON prompts;
DROP POLICY IF EXISTS "owner only" ON prompts;
CREATE POLICY "owner only" ON prompts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Joined groups (already owner only, but ensure trigger + WITH CHECK)
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Bump version
UPDATE settings SET value = '1.300', updated_at = now() WHERE key = 'schema_version';
INSERT INTO settings (key, value, owner_id, updated_at)
VALUES ('schema_version', '1.300', NULL, now())
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
