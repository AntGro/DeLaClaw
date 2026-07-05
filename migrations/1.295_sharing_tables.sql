-- Migration 1.295: Create sharing tables for D+E hybrid sharing
--
-- sharing_groups   — one row per shared group
-- sharing_members  — one row per member (creator + invitees), each with a token
-- sharing_items    — shared items (todos, habits, list_items, habit_completions)
--
-- Owner (A) accesses via auth.uid() through direct RLS.
-- Members (B) access via SECURITY DEFINER RPC functions (see 1.296).

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

-- Enable RLS
ALTER TABLE sharing_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharing_items ENABLE ROW LEVEL SECURITY;

-- Owner-only direct access (members use RPC)
CREATE POLICY "owner" ON sharing_groups
  FOR ALL USING (auth_owner_id = auth.uid());

CREATE POLICY "owner" ON sharing_members
  FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));

CREATE POLICY "owner" ON sharing_items
  FOR ALL USING (group_id IN (SELECT id FROM sharing_groups WHERE auth_owner_id = auth.uid()));

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE sharing_groups, sharing_members, sharing_items;

-- Bump schema version
UPDATE settings SET value = '1.295', updated_at = now() WHERE key = 'schema_version';
