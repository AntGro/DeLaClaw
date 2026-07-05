-- Migration 1.296: RPC functions for token-based member access
--
-- All functions are SECURITY DEFINER — they bypass RLS and validate
-- access via the member token internally. This is how User B (no auth)
-- accesses shared data on User A's Supabase project.

-- ── verify_join_token ──────────────────────────────────────────
-- Called by B before joining. Returns group info if the token is valid
-- and not yet used (joined_at IS NULL).

CREATE OR REPLACE FUNCTION verify_join_token(p_token TEXT)
RETURNS TABLE(group_id TEXT, group_name TEXT, member_id TEXT,
              display_name TEXT, backend_type TEXT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token = p_token AND sm.joined_at IS NULL;
$$;

-- ── confirm_join ───────────────────────────────────────────────
-- Called by B to accept the invite. Sets joined_at and optionally
-- updates display_name.

CREATE OR REPLACE FUNCTION confirm_join(p_token TEXT, p_display_name TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''), display_name)
  WHERE token = p_token AND joined_at IS NULL;
$$;

-- ── get_shared_items ───────────────────────────────────────────
-- Returns items for a group. Token must belong to a joined member.

CREATE OR REPLACE FUNCTION get_shared_items(p_token TEXT, p_group_id TEXT,
                                             p_item_type TEXT DEFAULT NULL)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT si.* FROM sharing_items si
  WHERE si.group_id = p_group_id
  AND (p_item_type IS NULL OR si.item_type = p_item_type)
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token = p_token
    AND sm.joined_at IS NOT NULL
  );
$$;

-- ── add_shared_item ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION add_shared_item(
  p_token TEXT, p_item_id TEXT, p_group_id TEXT, p_item_type TEXT,
  p_payload JSONB, p_member_id TEXT, p_parent_item_id TEXT DEFAULT NULL
)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO sharing_items
    (item_id, group_id, item_type, parent_item_id, payload, created_by)
  SELECT p_item_id, p_group_id, p_item_type,
         p_parent_item_id, p_payload, p_member_id
  WHERE EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = p_group_id
    AND sm.token = p_token
    AND sm.member_id = p_member_id
    AND sm.joined_at IS NOT NULL
  )
  RETURNING *;
$$;

-- ── update_shared_item ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_shared_item(p_token TEXT, p_item_id TEXT,
                                               p_payload JSONB)
RETURNS SETOF sharing_items
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_items si
  SET payload = p_payload, updated_at = now()
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token = p_token
    AND sm.joined_at IS NOT NULL
  )
  RETURNING *;
$$;

-- ── delete_shared_item ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION delete_shared_item(p_token TEXT, p_item_id TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_items si
  WHERE si.item_id = p_item_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm
    WHERE sm.group_id = si.group_id
    AND sm.token = p_token
    AND sm.joined_at IS NOT NULL
  );
END;
$$;

-- ── get_group_members ──────────────────────────────────────────
-- Any joined member can see the full roster of their group.

CREATE OR REPLACE FUNCTION get_group_members(p_token TEXT, p_group_id TEXT)
RETURNS TABLE(member_id TEXT, display_name TEXT, role TEXT,
              joined_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sm.member_id, sm.display_name, sm.role, sm.joined_at
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
    AND sm2.token = p_token
    AND sm2.joined_at IS NOT NULL
  );
$$;

-- ── leave_group ────────────────────────────────────────────────
-- A member (non-creator) removes themselves from a group.

CREATE OR REPLACE FUNCTION leave_group(p_token TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token = p_token
  AND role != 'creator';
END;
$$;

-- Bump schema version
UPDATE settings SET value = '1.296', updated_at = now() WHERE key = 'schema_version';
