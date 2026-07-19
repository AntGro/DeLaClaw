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
//
// IMPORTANT: all statements must be idempotent. The initial schema
// SQL (supabase_schema.sql) may already include tables, columns,
// policies, and publication memberships that migrations also touch.
// Use:
//   - CREATE TABLE IF NOT EXISTS
//   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS
//   - DROP POLICY IF EXISTS before CREATE POLICY
//   - DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$
//     for ALTER PUBLICATION ADD TABLE (no IF NOT EXISTS in PG)
// ===================================================================

const SUPABASE_MIGRATIONS = {
  '1.099': `-- Migration 1.099: Enable Supabase Realtime for all tables
-- Required for cross-device live sync (postgres_changes subscriptions)

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE
    tasks, projects, todos, habits, habit_completions,
    birthdays, vestiaire, flashcards, flashcard_notes,
    prompts, settings;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Bump schema version
UPDATE settings SET value = '1.099', updated_at = now()
WHERE key = 'schema_version';`,

  '1.100': `-- Migration 1.100: Add lists, list_items, daily_visits to Realtime publication
-- These tables were added to the schema but missing from the Realtime publication.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE lists, list_items, daily_visits;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
CREATE POLICY "owner or unclaimed" ON joined_groups FOR ALL USING (owner_id = auth.uid() OR owner_id IS NULL);

UPDATE settings SET value = '1.297', updated_at = now() WHERE key = 'schema_version';`,

  '1.298': `-- Migration 1.298: Add creator_name to verify_join_token RPC
-- Return type changes (5 -> 6 cols) so DROP is required
DROP FUNCTION IF EXISTS "public"."verify_join_token"("text");

CREATE OR REPLACE FUNCTION "public"."verify_join_token"("p_token" "text")
RETURNS TABLE("group_id" "text", "group_name" "text", "member_id" "text",
              "display_name" "text", "backend_type" "text", "creator_name" "text")
LANGUAGE "sql" SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm
          WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token = p_token AND sm.joined_at IS NULL;
$$;

UPDATE settings SET value = '1.298', updated_at = now() WHERE key = 'schema_version';`,

  '1.299': `-- Migration 1.299: Fix joined_groups RLS leak (P0)
-- Previous policy allowed anon to read all owner_id IS NULL rows
DELETE FROM joined_groups WHERE owner_id IS NULL;
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid());
UPDATE settings SET value = '1.299', updated_at = now() WHERE key = 'schema_version';
NOTIFY pgrst, 'reload schema';`,

  '1.300': `-- Migration 1.300: Enforce owner-only RLS (mandatory auth for Supabase)
CREATE OR REPLACE FUNCTION set_owner_id() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$ BEGIN IF NEW.owner_id IS NULL THEN NEW.owner_id := auth.uid(); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION claim_ownership() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$ DECLARE uid UUID := auth.uid(); BEGIN IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF; UPDATE projects SET owner_id = uid WHERE owner_id IS NULL; UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL; UPDATE todos SET owner_id = uid WHERE owner_id IS NULL; UPDATE habits SET owner_id = uid WHERE owner_id IS NULL; UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL; UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL; UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL; UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL; UPDATE lists SET owner_id = uid WHERE owner_id IS NULL; UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL; UPDATE settings SET owner_id = uid WHERE owner_id IS NULL; UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL; UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL; END; $$;
DROP POLICY IF EXISTS "allow all" ON projects; DROP POLICY IF EXISTS "owner or unclaimed" ON projects; DROP POLICY IF EXISTS "owner only" ON projects; CREATE POLICY "owner only" ON projects FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON projects; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON tasks; DROP POLICY IF EXISTS "owner or unclaimed" ON tasks; DROP POLICY IF EXISTS "owner only" ON tasks; CREATE POLICY "owner only" ON tasks FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON todos; DROP POLICY IF EXISTS "owner or unclaimed" ON todos; DROP POLICY IF EXISTS "owner only" ON todos; CREATE POLICY "owner only" ON todos FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON todos; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON habits; DROP POLICY IF EXISTS "owner or unclaimed" ON habits; DROP POLICY IF EXISTS "owner only" ON habits; CREATE POLICY "owner only" ON habits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON habits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON habit_completions; DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions; DROP POLICY IF EXISTS "owner only" ON habit_completions; CREATE POLICY "owner only" ON habit_completions FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON flashcard_notes; DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes; DROP POLICY IF EXISTS "owner only" ON flashcard_notes; CREATE POLICY "owner only" ON flashcard_notes FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON birthdays; DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays; DROP POLICY IF EXISTS "owner only" ON birthdays; CREATE POLICY "owner only" ON birthdays FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON vestiaire; DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire; DROP POLICY IF EXISTS "owner only" ON vestiaire; CREATE POLICY "owner only" ON vestiaire FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON lists; DROP POLICY IF EXISTS "owner or unclaimed" ON lists; DROP POLICY IF EXISTS "owner only" ON lists; CREATE POLICY "owner only" ON lists FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON lists; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON list_items; DROP POLICY IF EXISTS "owner or unclaimed" ON list_items; DROP POLICY IF EXISTS "owner only" ON list_items; CREATE POLICY "owner only" ON list_items FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON settings; DROP POLICY IF EXISTS "owner or unclaimed" ON settings; DROP POLICY IF EXISTS "owner only" ON settings; CREATE POLICY "owner only" ON settings FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON settings; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "allow all" ON prompts; DROP POLICY IF EXISTS "owner or unclaimed" ON prompts; DROP POLICY IF EXISTS "owner only" ON prompts; CREATE POLICY "owner only" ON prompts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups; DROP POLICY IF EXISTS "owner only" ON joined_groups; CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid()); DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();
UPDATE settings SET value = '1.300', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.300', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,

  '1.301': `-- Migration 1.301: Hash sharing invite tokens, add expiry/revocation, prep joined_groups encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
UPDATE sharing_members SET token_hash = encode(digest(token, 'sha256'), 'hex') WHERE token_hash IS NULL AND token IS NOT NULL;
UPDATE sharing_members SET expires_at = created_at + INTERVAL '24 hours' WHERE joined_at IS NULL AND expires_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sharing_members_token_hash ON sharing_members(token_hash);
CREATE INDEX IF NOT EXISTS idx_sharing_members_expires_at ON sharing_members(expires_at);
CREATE INDEX IF NOT EXISTS idx_sharing_members_revoked_at ON sharing_members(revoked_at) WHERE revoked_at IS NOT NULL;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_iv TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_iv TEXT;
CREATE OR REPLACE FUNCTION verify_join_token(p_token TEXT) RETURNS TABLE(group_id TEXT, group_name TEXT, member_id TEXT, display_name TEXT, backend_type TEXT, creator_name TEXT) LANGUAGE sql SECURITY DEFINER AS $$ SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type, (SELECT cm.display_name FROM sharing_members cm WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1) FROM sharing_members sm JOIN sharing_groups sg ON sg.id = sm.group_id WHERE sm.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm.revoked_at IS NULL AND (sm.expires_at IS NULL OR sm.expires_at > now()) AND sm.joined_at IS NULL; $$;
CREATE OR REPLACE FUNCTION confirm_join(p_token TEXT, p_display_name TEXT) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE sharing_members SET joined_at = now(), display_name = COALESCE(NULLIF(p_display_name, ''), display_name) WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex') AND joined_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()); $$;
CREATE OR REPLACE FUNCTION get_shared_items(p_token TEXT, p_group_id TEXT, p_item_type TEXT DEFAULT NULL) RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER AS $$ SELECT si.* FROM sharing_items si WHERE si.group_id = p_group_id AND (p_item_type IS NULL OR si.item_type = p_item_type) AND EXISTS ( SELECT 1 FROM sharing_members sm WHERE sm.group_id = p_group_id AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL ); $$;
CREATE OR REPLACE FUNCTION add_shared_item(p_token TEXT, p_item_id TEXT, p_group_id TEXT, p_item_type TEXT, p_payload JSONB, p_member_id TEXT, p_parent_item_id TEXT DEFAULT NULL) RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO sharing_items (item_id, group_id, item_type, parent_item_id, payload, created_by) SELECT p_item_id, p_group_id, p_item_type, p_parent_item_id, p_payload, p_member_id WHERE EXISTS ( SELECT 1 FROM sharing_members sm WHERE sm.group_id = p_group_id AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm.member_id = p_member_id AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL ) RETURNING *; $$;
CREATE OR REPLACE FUNCTION update_shared_item(p_token TEXT, p_item_id TEXT, p_payload JSONB) RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER AS $$ UPDATE sharing_items si SET payload = p_payload, updated_at = now() WHERE si.item_id = p_item_id AND EXISTS ( SELECT 1 FROM sharing_members sm WHERE sm.group_id = si.group_id AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL ) RETURNING *; $$;
CREATE OR REPLACE FUNCTION delete_shared_item(p_token TEXT, p_item_id TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM sharing_items si WHERE si.item_id = p_item_id AND EXISTS ( SELECT 1 FROM sharing_members sm WHERE sm.group_id = si.group_id AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL ); END; $$;
CREATE OR REPLACE FUNCTION get_group_members(p_token TEXT, p_group_id TEXT) RETURNS TABLE(member_id TEXT, display_name TEXT, role TEXT, joined_at TIMESTAMPTZ) LANGUAGE sql SECURITY DEFINER AS $$ SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at FROM sharing_members sm WHERE sm.group_id = p_group_id AND EXISTS ( SELECT 1 FROM sharing_members sm2 WHERE sm2.group_id = p_group_id AND sm2.token_hash = encode(digest(p_token, 'sha256'), 'hex') AND sm2.joined_at IS NOT NULL AND sm2.revoked_at IS NULL ); $$;
CREATE OR REPLACE FUNCTION leave_group(p_token TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN DELETE FROM sharing_members WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex') AND role != 'creator' AND joined_at IS NOT NULL AND revoked_at IS NULL; END; $$;
CREATE OR REPLACE FUNCTION revoke_member(p_group_id TEXT, p_member_id TEXT) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE sharing_members SET revoked_at = now() WHERE group_id = p_group_id AND member_id = p_member_id AND role != 'creator'; $$;
UPDATE settings SET value = '1.301', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.301', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,

  '1.393': `-- Migration 1.393: Add indexes for owner_id and shared_id to avoid seq scans as data grows
-- owner_id is used in every RLS policy (owner_id = auth.uid()) — without an index every query seq scans the whole table
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
CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_groups_auth_owner_id ON sharing_groups(auth_owner_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_id ON sharing_members(group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_items_group_id ON sharing_items(group_id);
UPDATE settings SET value = '1.393', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.393', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,

  '1.396': `-- Migration 1.396: Remove plaintext fallback for joined_groups (>=1.301 assumed on dev)
UPDATE joined_groups SET token = NULL, remote_anon_key = NULL WHERE token_ciphertext IS NOT NULL;
DELETE FROM joined_groups WHERE owner_id IS NULL;
UPDATE settings SET value = '1.396', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.396', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,

  '1.398': `-- Migration 1.398: Enforce owner-only RLS on previously open tables (flashcards, texts, text_line_progress, nvidia_usage, daily_visits)
-- Add owner_id columns
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE texts ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE text_line_progress ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE nvidia_usage ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE daily_visits ADD COLUMN IF NOT EXISTS owner_id uuid;

-- daily_visits is in supabase_realtime publication which publishes deletes.
-- If PK is dropped (as in a previous failed run) it has no replica identity, causing:
-- ERROR 55000: cannot delete because it does not have a replica identity and publishes deletes
-- Set FULL up-front to allow deletes even when PK is missing.
ALTER TABLE daily_visits REPLICA IDENTITY FULL;

-- Clean NULL visit_date while we can (old PK may already be dropped from failed run)
DELETE FROM daily_visits WHERE visit_date IS NULL;

-- Drop old PK (visit_date) to allow per-owner same date — idempotent
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_visits_pkey' AND conrelid='daily_visits'::regclass) THEN
    ALTER TABLE daily_visits DROP CONSTRAINT daily_visits_pkey;
  END IF;
END $$;

-- Existing rows have owner_id NULL (column newly added). Composite PK (visit_date, owner_id) requires NOT NULL,
-- so we must remove NULL-owner rows before creating new PK. Daily_visits is low-value analytics, safe to reset.
DELETE FROM daily_visits WHERE owner_id IS NULL;

-- Dedup any remaining duplicate (visit_date, owner_id) pairs
DELETE FROM daily_visits a USING daily_visits b WHERE a.ctid < b.ctid AND a.visit_date = b.visit_date AND COALESCE(a.owner_id::text,'') = COALESCE(b.owner_id::text,'');

-- Add new composite PK
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_visits_pkey' AND conrelid='daily_visits'::regclass) THEN
    ALTER TABLE daily_visits ADD CONSTRAINT daily_visits_pkey PRIMARY KEY (visit_date, owner_id);
  END IF;
END $$;

-- Reset replica identity to default (PK will be used)
ALTER TABLE daily_visits REPLICA IDENTITY DEFAULT;

-- Update claim_ownership to include new tables
CREATE OR REPLACE FUNCTION claim_ownership() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE projects SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE todos SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habits SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE flashcards SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE texts SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE text_line_progress SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE lists SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE settings SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE nvidia_usage SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE daily_visits SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL;
END;
$$;

-- Drop old allow_all policies
DROP POLICY IF EXISTS "Allow all access to daily_visits" ON daily_visits;
DROP POLICY IF EXISTS "allow_all_flashcards" ON flashcards;
DROP POLICY IF EXISTS "allow_all_nvidia_usage" ON nvidia_usage;
DROP POLICY IF EXISTS "allow_all_text_line_progress" ON text_line_progress;
DROP POLICY IF EXISTS "allow_all_texts" ON texts;
DROP POLICY IF EXISTS "owner only" ON flashcards;
DROP POLICY IF EXISTS "owner only" ON texts;
DROP POLICY IF EXISTS "owner only" ON text_line_progress;
DROP POLICY IF EXISTS "owner only" ON nvidia_usage;
DROP POLICY IF EXISTS "owner only" ON daily_visits;

-- Create owner-only policies
CREATE POLICY "owner only" ON flashcards FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON texts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON text_line_progress FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON nvidia_usage FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON daily_visits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Triggers to auto-set owner_id
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcards;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcards FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON texts;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON texts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON text_line_progress;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON text_line_progress FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON nvidia_usage;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON nvidia_usage FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON daily_visits;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON daily_visits FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Indexes for owner_id lookups
CREATE INDEX IF NOT EXISTS idx_flashcards_owner_id ON flashcards(owner_id);
CREATE INDEX IF NOT EXISTS idx_texts_owner_id ON texts(owner_id);
CREATE INDEX IF NOT EXISTS idx_text_line_progress_owner_id ON text_line_progress(owner_id);
CREATE INDEX IF NOT EXISTS idx_nvidia_usage_owner_id ON nvidia_usage(owner_id);
CREATE INDEX IF NOT EXISTS idx_daily_visits_owner_id ON daily_visits(owner_id);

UPDATE settings SET value = '1.398', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.398', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.399': `-- 1.399: stable creator attribution via auth_user_id, keep member_id random (global PK)
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS auth_user_id uuid;
CREATE INDEX IF NOT EXISTS idx_sharing_members_auth_user_id ON sharing_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_auth ON sharing_members(group_id, auth_user_id);

-- Backfill existing creators from sharing_groups.auth_owner_id
UPDATE sharing_members sm SET auth_user_id = sg.auth_owner_id
FROM sharing_groups sg
WHERE sm.group_id = sg.id AND sm.role='creator' AND sm.auth_user_id IS NULL AND sg.auth_owner_id IS NOT NULL;

-- RPCs updated for 1.399: confirm_join sets auth_user_id, get_group_members returns auth_user_id
CREATE OR REPLACE FUNCTION confirm_join(p_token text, p_display_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''::text), display_name),
      auth_user_id = COALESCE(auth_user_id, auth.uid())
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND joined_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
$$;

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
    AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm2.joined_at IS NOT NULL
    AND sm2.revoked_at IS NULL
  );
$$;

UPDATE settings SET value = '1.399', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.399', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.401': `-- 1.401 repair: 1.399 originally tried to set member_id = uid causing duplicate PK 23505 for users with >1 group
-- If any creator was rewritten to auth_user_id::text, randomize back to unique 8-char and fix sharing_items FK
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

DO $$
BEGIN
  -- Ensure column exists (idempotent if 1.399 failed mid-way)
  BEGIN
    ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS auth_user_id uuid;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END;

  -- Ensure FK is not blocking updates: drop it temporarily if exists
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sharing_items_created_by_fkey') THEN
    ALTER TABLE sharing_members DROP CONSTRAINT IF EXISTS sharing_items_created_by_fkey;
    ALTER TABLE sharing_items DROP CONSTRAINT IF EXISTS sharing_items_created_by_fkey;
  END IF;
END $$;

-- Backfill auth_user_id again
UPDATE sharing_members sm SET auth_user_id = sg.auth_owner_id
FROM sharing_groups sg
WHERE sm.group_id = sg.id AND sm.role='creator' AND sm.auth_user_id IS NULL AND sg.auth_owner_id IS NOT NULL;

-- Fix: for any member where member_id = auth_user_id::text (leftover from broken 1.399), generate a new random 8-char id and update referencing items
DO $$
DECLARE
  rec RECORD;
  new_id text;
BEGIN
  FOR rec IN SELECT member_id, group_id, auth_user_id FROM sharing_members WHERE role='creator' AND auth_user_id IS NOT NULL AND member_id = auth_user_id::text
  LOOP
    new_id := substr(md5(random()::text || rec.group_id), 1, 8);
    -- avoid collision
    WHILE EXISTS (SELECT 1 FROM sharing_members WHERE member_id = new_id) LOOP
      new_id := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    END LOOP;

    UPDATE sharing_items SET created_by = new_id WHERE group_id = rec.group_id AND created_by = rec.member_id;
    UPDATE sharing_members SET member_id = new_id WHERE group_id = rec.group_id AND member_id = rec.member_id;
  END LOOP;
END $$;

-- Re-add FK if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sharing_items_created_by_fkey') THEN
    ALTER TABLE sharing_items ADD CONSTRAINT sharing_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES sharing_members(member_id);
  END IF;
END $$;

-- Refresh RPCs (idempotent) with casts
CREATE OR REPLACE FUNCTION confirm_join(p_token text, p_display_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''::text), display_name),
      auth_user_id = COALESCE(auth_user_id, auth.uid())
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND joined_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
$$;

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
    AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm2.joined_at IS NOT NULL
    AND sm2.revoked_at IS NULL
  );
$$;

CREATE INDEX IF NOT EXISTS idx_sharing_members_auth_user_id ON sharing_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_auth ON sharing_members(group_id, auth_user_id);

UPDATE settings SET value = '1.401', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.401', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.402': `-- 1.402: ensure pgcrypto for digest() + fix digest(text, unknown) error 42883
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- Recreate all sharing RPCs with explicit ::text casts and search_path = public
CREATE OR REPLACE FUNCTION verify_join_token(p_token text)
RETURNS TABLE(group_id text, group_name text, member_id text, display_name text, backend_type text, creator_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.revoked_at IS NULL
    AND (sm.expires_at IS NULL OR sm.expires_at > now())
    AND sm.joined_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION confirm_join(p_token text, p_display_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''::text), display_name),
      auth_user_id = COALESCE(auth_user_id, auth.uid())
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND joined_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
$$;

CREATE OR REPLACE FUNCTION get_shared_items(p_token text, p_group_id text, p_item_type text DEFAULT NULL::text)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT si.* FROM sharing_items si
  WHERE si.group_id = p_group_id
  AND (p_item_type IS NULL OR si.item_type = p_item_type)
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION add_shared_item(p_token text, p_item_id text, p_group_id text, p_item_type text, p_payload jsonb, p_member_id text, p_parent_item_id text DEFAULT NULL::text)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  INSERT INTO sharing_items (item_id, group_id, item_type, parent_item_id, payload, created_by)
  SELECT p_item_id, p_group_id, p_item_type, p_parent_item_id, p_payload, p_member_id
  WHERE EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.member_id = p_member_id
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION update_shared_item(p_token text, p_item_id text, p_payload jsonb)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_items si
  SET payload = p_payload, updated_at = now()
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION delete_shared_item(p_token text, p_item_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  DELETE FROM sharing_items si
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
    AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm2.joined_at IS NOT NULL
    AND sm2.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
  AND role != 'creator'
  AND joined_at IS NOT NULL
  AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_member(p_group_id text, p_member_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members SET revoked_at = now() WHERE group_id = p_group_id AND member_id = p_member_id AND role != 'creator';
$$;

UPDATE settings SET value = '1.402', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.402', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.404': `-- 1.404: fix digest() visibility on fresh projects — pgcrypto may be in extensions schema, not public
-- Ensure extension exists and recreate RPCs with search_path = public, extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

CREATE OR REPLACE FUNCTION verify_join_token(p_token text)
RETURNS TABLE(group_id text, group_name text, member_id text, display_name text, backend_type text, creator_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.revoked_at IS NULL
    AND (sm.expires_at IS NULL OR sm.expires_at > now())
    AND sm.joined_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION confirm_join(p_token text, p_display_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''::text), display_name),
      auth_user_id = COALESCE(auth_user_id, auth.uid())
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND joined_at IS NULL
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
$$;

CREATE OR REPLACE FUNCTION get_shared_items(p_token text, p_group_id text, p_item_type text DEFAULT NULL::text)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT si.* FROM sharing_items si
  WHERE si.group_id = p_group_id
  AND (p_item_type IS NULL OR si.item_type = p_item_type)
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION add_shared_item(p_token text, p_item_id text, p_group_id text, p_item_type text, p_payload jsonb, p_member_id text, p_parent_item_id text DEFAULT NULL::text)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  INSERT INTO sharing_items (item_id, group_id, item_type, parent_item_id, payload, created_by)
  SELECT p_item_id, p_group_id, p_item_type, p_parent_item_id, p_payload, p_member_id
  WHERE EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.member_id = p_member_id
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION update_shared_item(p_token text, p_item_id text, p_payload jsonb)
RETURNS SETOF sharing_items LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_items si
  SET payload = p_payload, updated_at = now()
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION delete_shared_item(p_token text, p_item_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  DELETE FROM sharing_items si
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
    AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND sm2.joined_at IS NOT NULL
    AND sm2.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
  AND role != 'creator'
  AND joined_at IS NOT NULL
  AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_member(p_group_id text, p_member_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members SET revoked_at = now() WHERE group_id = p_group_id AND member_id = p_member_id AND role != 'creator';
$$;

UPDATE settings SET value = '1.404', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.404', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.405': `-- 1.405: fix fresh schema missing shared_id/shared_group_id columns (habits, todos, list_items)
-- These were added in 1.270/1.273/1.287 but sql/supabase_schema.sql dump was out of sync, causing ERROR 42703 on fresh init when creating indexes
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_id text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared_group_id text;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_id text;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS shared_group_id text;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_id text;
ALTER TABLE list_items ADD COLUMN IF NOT EXISTS shared_group_id text;

CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);

UPDATE settings SET value = '1.405', updated_at = now() WHERE key = 'schema_version'; INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.405', NULL, now()) ON CONFLICT (key) DO NOTHING; NOTIFY pgrst, 'reload schema';`,
  '1.410': `-- Migration 1.410: Agent grants — multi-token access for external agents (Claude Code, Codex, etc.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

CREATE TABLE IF NOT EXISTS agent_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner only" ON agent_grants;
DROP POLICY IF EXISTS "owner or agent" ON agent_grants;
CREATE POLICY "owner only" ON agent_grants FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_agent_grants_owner_id ON agent_grants(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_grants_token_hash ON agent_grants(token_hash);
DROP TRIGGER IF EXISTS trg_set_owner_id ON agent_grants;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON agent_grants FOR EACH ROW EXECUTE FUNCTION set_owner_id();

CREATE OR REPLACE FUNCTION has_agent_access(target_owner UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  hdr TEXT;
  tok TEXT;
  h TEXT;
  matched_id UUID;
BEGIN
  IF target_owner IS NULL THEN RETURN FALSE; END IF;
  BEGIN
    hdr := current_setting('request.headers', true);
  EXCEPTION WHEN OTHERS THEN RETURN FALSE; END;
  IF hdr IS NULL OR hdr = '' THEN RETURN FALSE; END IF;
  BEGIN
    tok := (hdr::jsonb ->> 'x-agent-token');
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'X-Agent-Token'); END IF;
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'x-api-token'); END IF;
  EXCEPTION WHEN OTHERS THEN RETURN FALSE; END;
  IF tok IS NULL OR tok = '' THEN RETURN FALSE; END IF;
  h := encode(digest(tok::text, 'sha256'::text), 'hex'::text);
  SELECT id INTO matched_id FROM agent_grants
  WHERE owner_id = target_owner
    AND token_hash = h
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
  IF matched_id IS NULL THEN RETURN FALSE; END IF;
  BEGIN
    UPDATE agent_grants SET last_used_at = now()
    WHERE id = matched_id AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '5 minutes');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION create_agent_grant(p_display_name TEXT, p_scope TEXT DEFAULT 'full')
RETURNS TABLE(id UUID, token TEXT, display_name TEXT, scope TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  uid UUID := auth.uid();
  raw TEXT;
  hash TEXT;
  new_id UUID;
  new_created TIMESTAMPTZ;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_display_name IS NULL OR btrim(p_display_name) = '' THEN RAISE EXCEPTION 'display_name required'; END IF;
  raw := encode(gen_random_bytes(32), 'hex');
  hash := encode(digest(raw::text, 'sha256'::text), 'hex'::text);
  INSERT INTO agent_grants (owner_id, display_name, token_hash, scope)
  VALUES (uid, btrim(p_display_name), hash, COALESCE(p_scope, 'full'))
  RETURNING agent_grants.id, agent_grants.created_at INTO new_id, new_created;
  RETURN QUERY SELECT new_id, raw, btrim(p_display_name), COALESCE(p_scope, 'full'), new_created;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_agent_grant(p_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE agent_grants SET revoked_at = now() WHERE id = p_id AND owner_id = uid AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION touch_agent_grant()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE hdr TEXT; tok TEXT; h TEXT;
BEGIN
  BEGIN hdr := current_setting('request.headers', true); EXCEPTION WHEN OTHERS THEN RETURN; END;
  IF hdr IS NULL THEN RETURN; END IF;
  BEGIN
    tok := (hdr::jsonb ->> 'x-agent-token');
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'X-Agent-Token'); END IF;
  EXCEPTION WHEN OTHERS THEN RETURN; END;
  IF tok IS NULL OR tok = '' THEN RETURN; END IF;
  h := encode(digest(tok::text, 'sha256'::text), 'hex'::text);
  UPDATE agent_grants SET last_used_at = now() WHERE token_hash = h;
END;
$$;

CREATE OR REPLACE FUNCTION claim_ownership()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE projects SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE todos SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habits SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE flashcards SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE texts SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE text_line_progress SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE lists SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE settings SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE nvidia_usage SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE daily_visits SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL;
  UPDATE agent_grants SET owner_id = uid WHERE owner_id IS NULL;
END;
$$;

DROP POLICY IF EXISTS "allow all" ON projects;
DROP POLICY IF EXISTS "owner or unclaimed" ON projects;
DROP POLICY IF EXISTS "owner only" ON projects;
DROP POLICY IF EXISTS "owner or agent" ON projects;
CREATE POLICY "owner or agent" ON projects FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON tasks;
DROP POLICY IF EXISTS "owner or unclaimed" ON tasks;
DROP POLICY IF EXISTS "owner only" ON tasks;
DROP POLICY IF EXISTS "owner or agent" ON tasks;
CREATE POLICY "owner or agent" ON tasks FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON todos;
DROP POLICY IF EXISTS "owner or unclaimed" ON todos;
DROP POLICY IF EXISTS "owner only" ON todos;
DROP POLICY IF EXISTS "owner or agent" ON todos;
CREATE POLICY "owner or agent" ON todos FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON habits;
DROP POLICY IF EXISTS "owner or unclaimed" ON habits;
DROP POLICY IF EXISTS "owner only" ON habits;
DROP POLICY IF EXISTS "owner or agent" ON habits;
CREATE POLICY "owner or agent" ON habits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON habit_completions;
DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions;
DROP POLICY IF EXISTS "owner only" ON habit_completions;
DROP POLICY IF EXISTS "owner or agent" ON habit_completions;
CREATE POLICY "owner or agent" ON habit_completions FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON flashcards;
DROP POLICY IF EXISTS "Allow all access to flashcards" ON flashcards;
DROP POLICY IF EXISTS "allow_all_flashcards" ON flashcards;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcards;
DROP POLICY IF EXISTS "owner only" ON flashcards;
DROP POLICY IF EXISTS "owner or agent" ON flashcards;
CREATE POLICY "owner or agent" ON flashcards FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes;
DROP POLICY IF EXISTS "owner only" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or agent" ON flashcard_notes;
CREATE POLICY "owner or agent" ON flashcard_notes FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON texts;
DROP POLICY IF EXISTS "Allow all access to texts" ON texts;
DROP POLICY IF EXISTS "allow_all_texts" ON texts;
DROP POLICY IF EXISTS "owner or unclaimed" ON texts;
DROP POLICY IF EXISTS "owner only" ON texts;
DROP POLICY IF EXISTS "owner or agent" ON texts;
CREATE POLICY "owner or agent" ON texts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON text_line_progress;
DROP POLICY IF EXISTS "Allow all access to text_line_progress" ON text_line_progress;
DROP POLICY IF EXISTS "allow_all_text_line_progress" ON text_line_progress;
DROP POLICY IF EXISTS "owner or unclaimed" ON text_line_progress;
DROP POLICY IF EXISTS "owner only" ON text_line_progress;
DROP POLICY IF EXISTS "owner or agent" ON text_line_progress;
CREATE POLICY "owner or agent" ON text_line_progress FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON birthdays;
DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays;
DROP POLICY IF EXISTS "owner only" ON birthdays;
DROP POLICY IF EXISTS "owner or agent" ON birthdays;
CREATE POLICY "owner or agent" ON birthdays FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON vestiaire;
DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire;
DROP POLICY IF EXISTS "owner only" ON vestiaire;
DROP POLICY IF EXISTS "owner or agent" ON vestiaire;
CREATE POLICY "owner or agent" ON vestiaire FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON lists;
DROP POLICY IF EXISTS "owner or unclaimed" ON lists;
DROP POLICY IF EXISTS "owner only" ON lists;
DROP POLICY IF EXISTS "owner or agent" ON lists;
CREATE POLICY "owner or agent" ON lists FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON list_items;
DROP POLICY IF EXISTS "owner or unclaimed" ON list_items;
DROP POLICY IF EXISTS "owner only" ON list_items;
DROP POLICY IF EXISTS "owner or agent" ON list_items;
CREATE POLICY "owner or agent" ON list_items FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON settings;
DROP POLICY IF EXISTS "owner or unclaimed" ON settings;
DROP POLICY IF EXISTS "owner only" ON settings;
DROP POLICY IF EXISTS "owner or agent" ON settings;
CREATE POLICY "owner or agent" ON settings FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON prompts;
DROP POLICY IF EXISTS "owner or unclaimed" ON prompts;
DROP POLICY IF EXISTS "owner only" ON prompts;
DROP POLICY IF EXISTS "owner or agent" ON prompts;
CREATE POLICY "owner or agent" ON prompts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON nvidia_usage;
DROP POLICY IF EXISTS "Allow all access to nvidia_usage" ON nvidia_usage;
DROP POLICY IF EXISTS "allow_all_nvidia_usage" ON nvidia_usage;
DROP POLICY IF EXISTS "owner or unclaimed" ON nvidia_usage;
DROP POLICY IF EXISTS "owner only" ON nvidia_usage;
DROP POLICY IF EXISTS "owner or agent" ON nvidia_usage;
CREATE POLICY "owner or agent" ON nvidia_usage FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON daily_visits;
DROP POLICY IF EXISTS "Allow all access to daily_visits" ON daily_visits;
DROP POLICY IF EXISTS "owner or unclaimed" ON daily_visits;
DROP POLICY IF EXISTS "owner only" ON daily_visits;
DROP POLICY IF EXISTS "owner or agent" ON daily_visits;
CREATE POLICY "owner or agent" ON daily_visits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON joined_groups;
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
DROP POLICY IF EXISTS "owner or agent" ON joined_groups;
CREATE POLICY "owner or agent" ON joined_groups FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

DROP TRIGGER IF EXISTS trg_set_owner_id ON projects;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON todos;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON habits;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcards;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcards FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON texts;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON texts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON text_line_progress;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON text_line_progress FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON lists;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON settings;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON nvidia_usage;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON nvidia_usage FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON daily_visits;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON daily_visits FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DROP POLICY IF EXISTS "owner" ON sharing_groups;
DROP POLICY IF EXISTS "owner or agent" ON sharing_groups;
CREATE POLICY "owner or agent" ON sharing_groups FOR ALL USING (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)) WITH CHECK (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id));
DROP POLICY IF EXISTS "owner" ON sharing_members;
DROP POLICY IF EXISTS "owner or agent" ON sharing_members;
CREATE POLICY "owner or agent" ON sharing_members FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))) WITH CHECK (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)));
DROP POLICY IF EXISTS "owner" ON sharing_items;
DROP POLICY IF EXISTS "owner or agent" ON sharing_items;
CREATE POLICY "owner or agent" ON sharing_items FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))) WITH CHECK (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)));

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE agent_grants; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE settings SET value = '1.410', updated_at = now() WHERE key = 'schema_version';
INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.410', NULL, now()) ON CONFLICT (key) DO NOTHING;
NOTIFY pgrst, 'reload schema';`,
};

export { SUPABASE_MIGRATIONS };
