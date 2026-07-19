-- Migration 1.410: Agent grants — multi-token access for external agents (Claude Code, Codex, etc.)
-- Pattern: hashed tokens (SHA256) like sharing_members, RLS owner or agent, RPCs SECURITY DEFINER

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- ── Table ───────────────────────────────────────────────────────
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

-- ── Helper: has_agent_access(target_owner) ─────────────────────
-- Reads X-Agent-Token from request.headers (PostgREST) and checks hash against agent_grants
-- SECURITY DEFINER to read agent_grants even when caller is anon (auth.uid() IS NULL)
-- Throttled last_used_at update: once per 5 min to avoid write amplification on per-row RLS checks

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
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
  IF hdr IS NULL OR hdr = '' THEN RETURN FALSE; END IF;
  BEGIN
    -- PostgREST normalizes header names to lowercase
    tok := (hdr::jsonb ->> 'x-agent-token');
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'X-Agent-Token'); END IF;
    IF tok IS NULL OR tok = '' THEN tok := (hdr::jsonb ->> 'x-api-token'); END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
  IF tok IS NULL OR tok = '' THEN RETURN FALSE; END IF;
  h := encode(digest(tok::text, 'sha256'::text), 'hex'::text);
  SELECT id INTO matched_id FROM agent_grants
  WHERE owner_id = target_owner
    AND token_hash = h
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
  IF matched_id IS NULL THEN RETURN FALSE; END IF;
  -- Best-effort throttled touch
  BEGIN
    UPDATE agent_grants SET last_used_at = now()
    WHERE id = matched_id AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '5 minutes');
  EXCEPTION WHEN OTHERS THEN
    -- Don't fail RLS check if touch fails
    NULL;
  END;
  RETURN TRUE;
END;
$$;

-- ── RPC: create_agent_grant (returns raw token once) ───────────
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

-- ── RPC: revoke_agent_grant ─────────────────────────────────────
CREATE OR REPLACE FUNCTION revoke_agent_grant(p_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE agent_grants SET revoked_at = now() WHERE id = p_id AND owner_id = uid AND revoked_at IS NULL;
END;
$$;

-- ── RPC: touch for explicit last_used (optional, agents may call) ─
CREATE OR REPLACE FUNCTION touch_agent_grant()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  hdr TEXT;
  tok TEXT;
  h TEXT;
BEGIN
  BEGIN
    hdr := current_setting('request.headers', true);
  EXCEPTION WHEN OTHERS THEN RETURN; END;
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

-- ── Update claim_ownership to include new tables ────────────────
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

-- ── Replace owner-only policies with owner or agent ────────────
-- Helper: for each personal table with owner_id UUID
-- Projects
DROP POLICY IF EXISTS "allow all" ON projects;
DROP POLICY IF EXISTS "owner or unclaimed" ON projects;
DROP POLICY IF EXISTS "owner only" ON projects;
DROP POLICY IF EXISTS "owner or agent" ON projects;
CREATE POLICY "owner or agent" ON projects FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Tasks
DROP POLICY IF EXISTS "allow all" ON tasks;
DROP POLICY IF EXISTS "owner or unclaimed" ON tasks;
DROP POLICY IF EXISTS "owner only" ON tasks;
DROP POLICY IF EXISTS "owner or agent" ON tasks;
CREATE POLICY "owner or agent" ON tasks FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Todos
DROP POLICY IF EXISTS "allow all" ON todos;
DROP POLICY IF EXISTS "owner or unclaimed" ON todos;
DROP POLICY IF EXISTS "owner only" ON todos;
DROP POLICY IF EXISTS "owner or agent" ON todos;
CREATE POLICY "owner or agent" ON todos FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Habits
DROP POLICY IF EXISTS "allow all" ON habits;
DROP POLICY IF EXISTS "owner or unclaimed" ON habits;
DROP POLICY IF EXISTS "owner only" ON habits;
DROP POLICY IF EXISTS "owner or agent" ON habits;
CREATE POLICY "owner or agent" ON habits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Habit completions
DROP POLICY IF EXISTS "allow all" ON habit_completions;
DROP POLICY IF EXISTS "owner or unclaimed" ON habit_completions;
DROP POLICY IF EXISTS "owner only" ON habit_completions;
DROP POLICY IF EXISTS "owner or agent" ON habit_completions;
CREATE POLICY "owner or agent" ON habit_completions FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Flashcards
DROP POLICY IF EXISTS "allow all" ON flashcards;
DROP POLICY IF EXISTS "Allow all access to flashcards" ON flashcards;
DROP POLICY IF EXISTS "allow_all_flashcards" ON flashcards;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcards;
DROP POLICY IF EXISTS "owner only" ON flashcards;
DROP POLICY IF EXISTS "owner or agent" ON flashcards;
CREATE POLICY "owner or agent" ON flashcards FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Flashcard notes
DROP POLICY IF EXISTS "allow all" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or unclaimed" ON flashcard_notes;
DROP POLICY IF EXISTS "owner only" ON flashcard_notes;
DROP POLICY IF EXISTS "owner or agent" ON flashcard_notes;
CREATE POLICY "owner or agent" ON flashcard_notes FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Texts
DROP POLICY IF EXISTS "allow all" ON texts;
DROP POLICY IF EXISTS "Allow all access to texts" ON texts;
DROP POLICY IF EXISTS "allow_all_texts" ON texts;
DROP POLICY IF EXISTS "owner or unclaimed" ON texts;
DROP POLICY IF EXISTS "owner only" ON texts;
DROP POLICY IF EXISTS "owner or agent" ON texts;
CREATE POLICY "owner or agent" ON texts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Text line progress
DROP POLICY IF EXISTS "allow all" ON text_line_progress;
DROP POLICY IF EXISTS "Allow all access to text_line_progress" ON text_line_progress;
DROP POLICY IF EXISTS "allow_all_text_line_progress" ON text_line_progress;
DROP POLICY IF EXISTS "owner or unclaimed" ON text_line_progress;
DROP POLICY IF EXISTS "owner only" ON text_line_progress;
DROP POLICY IF EXISTS "owner or agent" ON text_line_progress;
CREATE POLICY "owner or agent" ON text_line_progress FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Birthdays
DROP POLICY IF EXISTS "allow all" ON birthdays;
DROP POLICY IF EXISTS "owner or unclaimed" ON birthdays;
DROP POLICY IF EXISTS "owner only" ON birthdays;
DROP POLICY IF EXISTS "owner or agent" ON birthdays;
CREATE POLICY "owner or agent" ON birthdays FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Vestiaire
DROP POLICY IF EXISTS "allow all" ON vestiaire;
DROP POLICY IF EXISTS "owner or unclaimed" ON vestiaire;
DROP POLICY IF EXISTS "owner only" ON vestiaire;
DROP POLICY IF EXISTS "owner or agent" ON vestiaire;
CREATE POLICY "owner or agent" ON vestiaire FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Lists
DROP POLICY IF EXISTS "allow all" ON lists;
DROP POLICY IF EXISTS "owner or unclaimed" ON lists;
DROP POLICY IF EXISTS "owner only" ON lists;
DROP POLICY IF EXISTS "owner or agent" ON lists;
CREATE POLICY "owner or agent" ON lists FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- List items
DROP POLICY IF EXISTS "allow all" ON list_items;
DROP POLICY IF EXISTS "owner or unclaimed" ON list_items;
DROP POLICY IF EXISTS "owner only" ON list_items;
DROP POLICY IF EXISTS "owner or agent" ON list_items;
CREATE POLICY "owner or agent" ON list_items FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Settings
DROP POLICY IF EXISTS "allow all" ON settings;
DROP POLICY IF EXISTS "owner or unclaimed" ON settings;
DROP POLICY IF EXISTS "owner only" ON settings;
DROP POLICY IF EXISTS "owner or agent" ON settings;
CREATE POLICY "owner or agent" ON settings FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Prompts
DROP POLICY IF EXISTS "allow all" ON prompts;
DROP POLICY IF EXISTS "owner or unclaimed" ON prompts;
DROP POLICY IF EXISTS "owner only" ON prompts;
DROP POLICY IF EXISTS "owner or agent" ON prompts;
CREATE POLICY "owner or agent" ON prompts FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Nvidia usage
DROP POLICY IF EXISTS "allow all" ON nvidia_usage;
DROP POLICY IF EXISTS "Allow all access to nvidia_usage" ON nvidia_usage;
DROP POLICY IF EXISTS "allow_all_nvidia_usage" ON nvidia_usage;
DROP POLICY IF EXISTS "owner or unclaimed" ON nvidia_usage;
DROP POLICY IF EXISTS "owner only" ON nvidia_usage;
DROP POLICY IF EXISTS "owner or agent" ON nvidia_usage;
CREATE POLICY "owner or agent" ON nvidia_usage FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Daily visits
DROP POLICY IF EXISTS "allow all" ON daily_visits;
DROP POLICY IF EXISTS "Allow all access to daily_visits" ON daily_visits;
DROP POLICY IF EXISTS "owner or unclaimed" ON daily_visits;
DROP POLICY IF EXISTS "owner only" ON daily_visits;
DROP POLICY IF EXISTS "owner or agent" ON daily_visits;
CREATE POLICY "owner or agent" ON daily_visits FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Joined groups
DROP POLICY IF EXISTS "allow all" ON joined_groups;
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
DROP POLICY IF EXISTS "owner or agent" ON joined_groups;
CREATE POLICY "owner or agent" ON joined_groups FOR ALL USING (owner_id = auth.uid() OR has_agent_access(owner_id)) WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Ensure triggers exist for all (idempotent)
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

-- ── Sharing tables also allow agent ─────────────────────────────
DROP POLICY IF EXISTS "owner" ON sharing_groups;
DROP POLICY IF EXISTS "owner or agent" ON sharing_groups;
CREATE POLICY "owner or agent" ON sharing_groups FOR ALL USING (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id)) WITH CHECK (auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id));

DROP POLICY IF EXISTS "owner" ON sharing_members;
DROP POLICY IF EXISTS "owner or agent" ON sharing_members;
CREATE POLICY "owner or agent" ON sharing_members FOR ALL USING (
  group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))
) WITH CHECK (
  group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))
);

DROP POLICY IF EXISTS "owner" ON sharing_items;
DROP POLICY IF EXISTS "owner or agent" ON sharing_items;
CREATE POLICY "owner or agent" ON sharing_items FOR ALL USING (
  group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))
) WITH CHECK (
  group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid() OR has_agent_access(auth_owner_id))
);

-- ── Realtime ────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE agent_grants;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Bump version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.410', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
INSERT INTO settings (key, value, owner_id, updated_at)
VALUES ('schema_version', '1.410', NULL, now())
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
