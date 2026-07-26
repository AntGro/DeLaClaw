-- temp_v301_v436.sql
-- Aggregates temp_v301_v401 + temp_v402_v436
-- Covers migrations 1.301, 1.393, 1.396, 1.398, 1.399, 1.401, 1.402, 1.404, 1.405, 1.410, 1.436
-- Net effect:
--   1. pgcrypto + token hashing/expiry/revocation on sharing_members
--   2. invited_label on sharing_members
--   3. auth_user_id on sharing_members
--   4. Encryption columns on joined_groups
--   5. owner_id + RLS on 5 additional tables (flashcards, texts, text_line_progress, nvidia_usage, daily_visits)
--   6. daily_visits composite PK
--   7. agent_grants table + has_agent_access() + create/revoke/touch RPCs
--   8. All RLS → "owner or agent" (skips intermediate "owner only")
--   9. All insert triggers on all tables
--  10. All sharing RPCs — final versions (search_path, ::text casts, invited_label, token_hash)
--  11. claim_ownership — final version with agent_grants
--  12. All indexes

-- ══════════════════════════════════════════════════
-- 1. pgcrypto
-- ══════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- ══════════════════════════════════════════════════
-- 2. sharing_members: token hashing, expiry, revocation, auth_user_id, invited_label
-- ══════════════════════════════════════════════════
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS auth_user_id UUID;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS invited_label TEXT;

-- Backfill token_hash from plaintext
UPDATE sharing_members SET token_hash = encode(digest(token::text, 'sha256'::text), 'hex'::text)
  WHERE token_hash IS NULL AND token IS NOT NULL;
-- Default expiry for pending invites
UPDATE sharing_members SET expires_at = created_at + INTERVAL '24 hours'
  WHERE joined_at IS NULL AND expires_at IS NULL;
-- Backfill auth_user_id for creators
UPDATE sharing_members sm SET auth_user_id = sg.auth_owner_id
  FROM sharing_groups sg
  WHERE sm.group_id = sg.id AND sm.role = 'creator'
    AND sm.auth_user_id IS NULL AND sg.auth_owner_id IS NOT NULL;
-- Backfill invited_label from display_name for pending invites
UPDATE sharing_members
SET invited_label = display_name, display_name = NULL
WHERE joined_at IS NULL AND invited_label IS NULL AND display_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sharing_members_token_hash ON sharing_members(token_hash);
CREATE INDEX IF NOT EXISTS idx_sharing_members_expires_at ON sharing_members(expires_at);
CREATE INDEX IF NOT EXISTS idx_sharing_members_revoked_at ON sharing_members(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sharing_members_auth_user_id ON sharing_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_auth ON sharing_members(group_id, auth_user_id);

-- ══════════════════════════════════════════════════
-- 3. joined_groups: encryption columns
-- ══════════════════════════════════════════════════
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_iv TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_iv TEXT;

-- ══════════════════════════════════════════════════
-- 4. owner_id on 5 additional tables
-- ══════════════════════════════════════════════════
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE texts ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE text_line_progress ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE nvidia_usage ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE daily_visits ADD COLUMN IF NOT EXISTS owner_id UUID;

-- ══════════════════════════════════════════════════
-- 5. daily_visits PK: visit_date → composite (visit_date, owner_id)
-- ══════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════
-- 6. agent_grants table + RPCs
-- ══════════════════════════════════════════════════
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
CREATE POLICY "owner only" ON agent_grants FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE INDEX IF NOT EXISTS idx_agent_grants_owner_id ON agent_grants(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_grants_token_hash ON agent_grants(token_hash);
DROP TRIGGER IF EXISTS trg_set_owner_id ON agent_grants;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON agent_grants FOR EACH ROW EXECUTE FUNCTION set_owner_id();

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE agent_grants; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION has_agent_access(target_owner UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  hdr TEXT; tok TEXT; h TEXT; matched_id UUID;
BEGIN
  IF target_owner IS NULL THEN RETURN FALSE; END IF;
  BEGIN hdr := current_setting('request.headers', true); EXCEPTION WHEN OTHERS THEN RETURN FALSE; END;
  IF hdr IS NULL OR hdr = '' THEN RETURN FALSE; END IF;
  BEGIN
    tok := (hdr::jsonb ->> 'x-agent-token');
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'X-Agent-Token'); END IF;
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'x-api-token'); END IF;
  EXCEPTION WHEN OTHERS THEN RETURN FALSE; END;
  IF tok IS NULL OR tok = '' THEN RETURN FALSE; END IF;
  h := encode(digest(tok::text, 'sha256'::text), 'hex'::text);
  SELECT id INTO matched_id FROM agent_grants
    WHERE owner_id = target_owner AND token_hash = h
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  uid UUID := auth.uid(); raw TEXT; hash TEXT; new_id UUID; new_created TIMESTAMPTZ;
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
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE agent_grants SET revoked_at = now() WHERE id = p_id AND owner_id = uid AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION touch_agent_grant()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
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

-- ══════════════════════════════════════════════════
-- 7. All RLS → "owner or agent"
--    (skips intermediate "owner only" — goes straight from "allow all" to "owner or agent")
-- ══════════════════════════════════════════════════
-- Personal tables (12 from v270_v300 + 5 additional)
DROP POLICY IF EXISTS "allow all" ON projects; DROP POLICY IF EXISTS "owner or unclaimed" ON projects; DROP POLICY IF EXISTS "owner only" ON projects; DROP POLICY IF EXISTS "owner or agent" ON projects;
CREATE POLICY "owner or agent" ON projects FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON tasks; DROP POLICY IF EXISTS "owner or unclaimed" ON tasks; DROP POLICY IF EXISTS "owner only" ON tasks; DROP POLICY IF EXISTS "owner or agent" ON tasks;
CREATE POLICY "owner or agent" ON tasks FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON todos; DROP POLICY IF EXISTS "owner or unclaimed" ON todos; DROP POLICY IF EXISTS "owner only" ON todos; DROP POLICY IF EXISTS "owner or agent" ON todos;
CREATE POLICY "owner or agent" ON todos FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON habits; DROP POLICY IF EXISTS "owner or unclaimed" ON habits; DROP POLICY IF EXISTS "owner only" ON habits; DROP POLICY IF EXISTS "owner or agent" ON habits;
CREATE POLICY "owner or agent" ON habits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON habit_completions; DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions; DROP POLICY IF EXISTS "owner only" ON habit_completions; DROP POLICY IF EXISTS "owner or agent" ON habit_completions;
CREATE POLICY "owner or agent" ON habit_completions FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON flashcards; DROP POLICY IF EXISTS "Allow all access to flashcards" ON flashcards; DROP POLICY IF EXISTS "allow_all_flashcards" ON flashcards; DROP POLICY IF EXISTS "owner only" ON flashcards; DROP POLICY IF EXISTS "owner or agent" ON flashcards;
CREATE POLICY "owner or agent" ON flashcards FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON flashcard_notes; DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes; DROP POLICY IF EXISTS "owner only" ON flashcard_notes; DROP POLICY IF EXISTS "owner or agent" ON flashcard_notes;
CREATE POLICY "owner or agent" ON flashcard_notes FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON texts; DROP POLICY IF EXISTS "Allow all access to texts" ON texts; DROP POLICY IF EXISTS "allow_all_texts" ON texts; DROP POLICY IF EXISTS "owner only" ON texts; DROP POLICY IF EXISTS "owner or agent" ON texts;
CREATE POLICY "owner or agent" ON texts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON text_line_progress; DROP POLICY IF EXISTS "Allow all access to text_line_progress" ON text_line_progress; DROP POLICY IF EXISTS "allow_all_text_line_progress" ON text_line_progress; DROP POLICY IF EXISTS "owner only" ON text_line_progress; DROP POLICY IF EXISTS "owner or agent" ON text_line_progress;
CREATE POLICY "owner or agent" ON text_line_progress FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON birthdays; DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays; DROP POLICY IF EXISTS "owner only" ON birthdays; DROP POLICY IF EXISTS "owner or agent" ON birthdays;
CREATE POLICY "owner or agent" ON birthdays FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON vestiaire; DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire; DROP POLICY IF EXISTS "owner only" ON vestiaire; DROP POLICY IF EXISTS "owner or agent" ON vestiaire;
CREATE POLICY "owner or agent" ON vestiaire FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON lists; DROP POLICY IF EXISTS "owner or unclaimed" ON lists; DROP POLICY IF EXISTS "owner only" ON lists; DROP POLICY IF EXISTS "owner or agent" ON lists;
CREATE POLICY "owner or agent" ON lists FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON list_items; DROP POLICY IF EXISTS "owner or unclaimed" ON list_items; DROP POLICY IF EXISTS "owner only" ON list_items; DROP POLICY IF EXISTS "owner or agent" ON list_items;
CREATE POLICY "owner or agent" ON list_items FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON settings; DROP POLICY IF EXISTS "owner or unclaimed" ON settings; DROP POLICY IF EXISTS "owner only" ON settings; DROP POLICY IF EXISTS "owner or agent" ON settings;
CREATE POLICY "owner or agent" ON settings FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON prompts; DROP POLICY IF EXISTS "owner or unclaimed" ON prompts; DROP POLICY IF EXISTS "owner only" ON prompts; DROP POLICY IF EXISTS "owner or agent" ON prompts;
CREATE POLICY "owner or agent" ON prompts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON nvidia_usage; DROP POLICY IF EXISTS "Allow all access to nvidia_usage" ON nvidia_usage; DROP POLICY IF EXISTS "allow_all_nvidia_usage" ON nvidia_usage; DROP POLICY IF EXISTS "owner only" ON nvidia_usage; DROP POLICY IF EXISTS "owner or agent" ON nvidia_usage;
CREATE POLICY "owner or agent" ON nvidia_usage FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON daily_visits; DROP POLICY IF EXISTS "Allow all access to daily_visits" ON daily_visits; DROP POLICY IF EXISTS "owner only" ON daily_visits; DROP POLICY IF EXISTS "owner or agent" ON daily_visits;
CREATE POLICY "owner or agent" ON daily_visits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "allow all" ON joined_groups; DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups; DROP POLICY IF EXISTS "owner only" ON joined_groups; DROP POLICY IF EXISTS "owner or agent" ON joined_groups;
CREATE POLICY "owner or agent" ON joined_groups FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Sharing tables
DROP POLICY IF EXISTS "owner" ON sharing_groups; DROP POLICY IF EXISTS "owner or agent" ON sharing_groups;
CREATE POLICY "owner or agent" ON sharing_groups FOR ALL USING (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)) WITH CHECK (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id));
DROP POLICY IF EXISTS "owner" ON sharing_members; DROP POLICY IF EXISTS "owner or agent" ON sharing_members;
CREATE POLICY "owner or agent" ON sharing_members FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))) WITH CHECK (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)));
DROP POLICY IF EXISTS "owner" ON sharing_items; DROP POLICY IF EXISTS "owner or agent" ON sharing_items;
CREATE POLICY "owner or agent" ON sharing_items FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))) WITH CHECK (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)));

-- ══════════════════════════════════════════════════
-- 8. Insert triggers on all tables
-- ══════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_set_owner_id ON projects; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON tasks; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON todos; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todos FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON habits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habits FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_completions; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_completions FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcards; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcards FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_notes; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_notes FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON texts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON texts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON text_line_progress; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON text_line_progress FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON birthdays; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON birthdays FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON lists; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON lists FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON list_items; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON list_items FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON settings; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON prompts; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON nvidia_usage; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON nvidia_usage FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON daily_visits; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON daily_visits FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON joined_groups; CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON joined_groups FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- ══════════════════════════════════════════════════
-- 9. All sharing RPCs — final versions (search_path, ::text casts, invited_label, token_hash)
-- ══════════════════════════════════════════════════
DROP FUNCTION IF EXISTS verify_join_token(text);

CREATE OR REPLACE FUNCTION verify_join_token(p_token text)
RETURNS TABLE(group_id text, group_name text, member_id text, display_name text, invited_label text, backend_type text, creator_name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sm.invited_label, sg.backend_type,
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
      display_name = COALESCE(NULLIF(p_display_name, ''::text), display_name, invited_label),
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
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
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
      AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
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
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
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
        AND sm.joined_at IS NOT NULL AND sm.revoked_at IS NULL
    );
END;
$$;

DROP FUNCTION IF EXISTS get_group_members(text, text);

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, invited_label text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.invited_label, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
    AND EXISTS (
      SELECT 1 FROM sharing_members sm2
      WHERE sm2.group_id = p_group_id
        AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
        AND sm2.joined_at IS NOT NULL AND sm2.revoked_at IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
    AND role != 'creator'
    AND joined_at IS NOT NULL AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_member(p_group_id text, p_member_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  UPDATE sharing_members SET revoked_at = now()
  WHERE group_id = p_group_id AND member_id = p_member_id AND role != 'creator';
$$;

-- ══════════════════════════════════════════════════
-- 10. claim_ownership — final version with agent_grants
-- ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_ownership()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
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

-- ══════════════════════════════════════════════════
-- 11. All indexes
-- ══════════════════════════════════════════════════
-- owner_id indexes
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
-- shared_id indexes
CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);
-- sharing table indexes
CREATE INDEX IF NOT EXISTS idx_sharing_groups_auth_owner_id ON sharing_groups(auth_owner_id);
CREATE INDEX IF NOT EXISTS idx_sharing_members_group_id ON sharing_members(group_id);
CREATE INDEX IF NOT EXISTS idx_sharing_items_group_id ON sharing_items(group_id);
