-- Migration 1.452: filter revoked members from get_group_members RPC
-- Previously the RPC returned ALL members including revoked ones,
-- leaking revoked members to joined (non-owner) clients.

DROP FUNCTION IF EXISTS get_group_members(text, text);

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, invited_label text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.invited_label, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND sm.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
      AND sm2.token_hash = encode(digest(p_token, 'sha256'), 'hex')
      AND sm2.joined_at IS NOT NULL
      AND sm2.revoked_at IS NULL
  );
$$;

INSERT INTO settings (key, value, updated_at)
VALUES ('schema_version', '1.452', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

NOTIFY pgrst, 'reload schema';
