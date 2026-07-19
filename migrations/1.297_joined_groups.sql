-- Migration 1.297: Persistent token storage for joined groups
--
-- When User B joins a group on User A's Supabase, the connection
-- details (URL, anon key, token) are stored here on B's own backend.
-- This survives browser wipes, device switches, PWA reinstalls —
-- B can reconnect without needing the invite link again.

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

CREATE POLICY "owner or unclaimed" ON joined_groups
  FOR ALL USING (owner_id = auth.uid() OR owner_id IS NULL);

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.297', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
