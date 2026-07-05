-- Migration 1.294: Add owner_id to personal tables + rewrite RLS
--
-- Enables Supabase Auth magic-link sign-in for data ownership.
-- Backward compatible: owner_id IS NULL rows stay accessible (same as
-- current "allow all" policy) until the user authenticates and claims
-- their data via claimOwnership().
--
-- After claiming, only the authenticated owner can access their rows.

-- ── Add owner_id column to every personal table ────────────────

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

-- ── Rewrite RLS policies ───────────────────────────────────────
-- Pattern: owner_id matches auth.uid() OR unclaimed (NULL)

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

-- Bump schema version
UPDATE settings SET value = '1.294', updated_at = now() WHERE key = 'schema_version';
