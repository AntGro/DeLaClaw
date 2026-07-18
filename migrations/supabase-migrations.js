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
CREATE OR REPLACE FUNCTION set_owner_id() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN IF NEW.owner_id IS NULL THEN NEW.owner_id := auth.uid(); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION claim_ownership() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ DECLARE uid UUID := auth.uid(); BEGIN IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF; UPDATE projects SET owner_id = uid WHERE owner_id IS NULL; UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL; UPDATE todos SET owner_id = uid WHERE owner_id IS NULL; UPDATE habits SET owner_id = uid WHERE owner_id IS NULL; UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL; UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL; UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL; UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL; UPDATE lists SET owner_id = uid WHERE owner_id IS NULL; UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL; UPDATE settings SET owner_id = uid WHERE owner_id IS NULL; UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL; UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL; END; $$;
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
};

export { SUPABASE_MIGRATIONS };
