-- 1.436: agent-safe sharing member identity
-- Emails are permission material, not identity. Preserve creator-provided invite labels
-- separately from the joined member's chosen display name.

ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS invited_label TEXT;

-- Compatibility backfill: pre-1.436 pending invites stored the creator's label in
-- display_name. Move that value to invited_label and leave display_name for the
-- joiner's chosen group-local name.
UPDATE sharing_members
SET invited_label = display_name,
    display_name = NULL
WHERE joined_at IS NULL
  AND invited_label IS NULL
  AND display_name IS NOT NULL;

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
      AND sm2.joined_at IS NOT NULL
      AND sm2.revoked_at IS NULL
  );
$$;

INSERT INTO settings (key, value, updated_at)
VALUES ('schema_version', '1.436', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO settings (key, value, owner_id, updated_at)
VALUES ('schema_version', '1.436', NULL, now())
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
