-- temp_v301_v401.sql
-- Aggregates migrations 1.301, 1.393, 1.396, 1.398, 1.399, 1.401
-- Net effect:
--   1. pgcrypto + token hashing on sharing_members
--   2. Encryption columns on joined_groups
--   3. auth_user_id on sharing_members (stable creator attribution)
--   4. All RPCs in final form (token_hash, ::text casts, auth_user_id)
--   5. RLS on 5 additional tables (flashcards, texts, text_line_progress, nvidia_usage, daily_visits)
--   6. daily_visits PK → composite (visit_date, owner_id)
--   7. claim_ownership covers all tables
--   8. All owner_id + shared_id indexes

-- ── 1. pgcrypto ──
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- ── 2. sharing_members: token hashing + expiry/revocation + auth_user_id ──
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS auth_user_id UUID;

-- Backfill token_hash from plaintext (idempotent, no-op if no data)
UPDATE sharing_members SET token_hash = encode(digest(token, 'sha256'), 'hex')
  WHERE token_hash IS NULL AND token IS NOT NULL;
-- Default expiry for pending invites
UPDATE sharing_members SET expires_at = created_at + INTERVAL '24 hours'
  WHERE joined_at IS NULL AND expires_at IS NULL;
-- Backfill auth_user_id for creators
UPDATE sharing_members sm SET auth_user_id = sg.auth_owner_id
  FROM sharing_groups sg
  WHERE sm.group_id = sg.id AND sm.role = 'creator'
    AND sm.auth_user_id IS NULL AND sg.auth_owner_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sharing_members_token_hash ON sharing_members(token_hash);
CREATE INDEX IF NOT EXISTS idx_sharing_members_expires_at ON sharing_members(expires_at);
CREATE INDEX IF NOT EXISTS idx_sharing_members_revoked_at ON sharing_members(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sharing_members_auth_user_id ON sharing_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_auth ON sharing_members(group_id, auth_user_id);

-- ── 3. joined_groups: encryption columns ──
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_iv TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_iv TEXT;

-- ── 4. All RPCs — final versions (token_hash, revocation, auth_user_id, ::text casts) ──
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
  WHERE sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
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

CREATE OR REPLACE FUNCTION get_shared_items(p_token TEXT, p_group_id TEXT, p_item_type TEXT DEFAULT NULL)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT si.* FROM sharing_items si
  WHERE si.group_id = p_group_id
    AND (p_item_type IS NULL OR si.item_type = p_item_type)
    AND EXISTS (
      SELECT 1 FROM sharing_members sm
      WHERE sm.group_id = p_group_id
        AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION add_shared_item(p_token TEXT, p_item_id TEXT, p_group_id TEXT, p_item_type TEXT, p_payload JSONB, p_member_id TEXT, p_parent_item_id TEXT DEFAULT NULL)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO sharing_items (item_id, group_id, item_type, parent_item_id, payload, created_by)
  SELECT p_item_id, p_group_id, p_item_type, p_parent_item_id, p_payload, p_member_id
  WHERE EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
      AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
      AND sm.member_id = p_member_id
      AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
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
      WHERE sm.group_id = si.group_id
        AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
    )
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION delete_shared_item(p_token TEXT, p_item_id TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_items si
  WHERE si.item_id = p_item_id
    AND EXISTS (
      SELECT 1 FROM sharing_members sm
      WHERE sm.group_id = si.group_id
        AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
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
        AND sm2.joined_at IS NOT NULL AND sm2.revoked_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND role != 'creator'
    AND joined_at IS NOT NULL AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_member(p_group_id TEXT, p_member_id TEXT)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_members SET revoked_at = now()
  WHERE group_id = p_group_id AND member_id = p_member_id AND role != 'creator';
$$;

-- ── 5. owner_id + RLS on 5 additional tables ──
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE texts ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE text_line_progress ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE nvidia_usage ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE daily_visits ADD COLUMN IF NOT EXISTS owner_id UUID;

-- daily_visits PK: visit_date → composite (visit_date, owner_id)
ALTER TABLE daily_visits REPLICA IDENTITY FULL;
DELETE FROM daily_visits WHERE visit_date IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_visits_pkey' AND conrelid='daily_visits'::regclass) THEN
    ALTER TABLE daily_visits DROP CONSTRAINT daily_visits_pkey;
  END IF;
END $$;
DELETE FROM daily_visits WHERE owner_id IS NULL;
DELETE FROM daily_visits a USING daily_visits b
  WHERE a.ctid < b.ctid AND a.visit_date = b.visit_date
    AND COALESCE(a.owner_id::text,'') = COALESCE(b.owner_id::text,'');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_visits_pkey' AND conrelid='daily_visits'::regclass) THEN
    ALTER TABLE daily_visits ADD CONSTRAINT daily_visits_pkey PRIMARY KEY (visit_date, owner_id);
  END IF;
END $$;
ALTER TABLE daily_visits REPLICA IDENTITY DEFAULT;

-- RLS policies
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

CREATE POLICY "owner only" ON flashcards FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON texts FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON text_line_progress FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON nvidia_usage FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "owner only" ON daily_visits FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Insert triggers
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcards; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcards FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON texts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON texts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON text_line_progress; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON text_line_progress FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON nvidia_usage; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON nvidia_usage FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON daily_visits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON daily_visits FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- ── 6. claim_ownership — final version covering all tables ──
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

-- ── 7. All indexes (owner_id, shared_id, sharing tables) ──
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
CREATE INDEX IF NOT EXISTS idx_flashcards_owner_id ON flashcards(owner_id);
CREATE INDEX IF NOT EXISTS idx_texts_owner_id ON texts(owner_id);
CREATE INDEX IF NOT EXISTS idx_text_line_progress_owner_id ON text_line_progress(owner_id);
CREATE INDEX IF NOT EXISTS idx_nvidia_usage_owner_id ON nvidia_usage(owner_id);
CREATE INDEX IF NOT EXISTS idx_daily_visits_owner_id ON daily_visits(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_groups_auth_owner_id ON sharing_groups(auth_owner_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_id ON sharing_members(group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_items_group_id ON sharing_items(group_id);
