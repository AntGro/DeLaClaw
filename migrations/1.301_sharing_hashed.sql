-- Migration 1.301: Hash sharing invite tokens, add expiry/revocation, prep joined_groups encryption
-- Implements Option for hashed tokens + 24h expiry + revocation support

-- Enable pgcrypto for SHA256 digest
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── sharing_members: add hash, expiry, revocation ──────────────
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE sharing_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Backfill token_hash from existing token where missing
UPDATE sharing_members
SET token_hash = encode(digest(token, 'sha256'), 'hex')
WHERE token_hash IS NULL AND token IS NOT NULL;

-- For pending invites (joined_at IS NULL) that have no expires_at, set 24h from created_at
UPDATE sharing_members
SET expires_at = created_at + INTERVAL '24 hours'
WHERE joined_at IS NULL AND expires_at IS NULL;

-- Unique index on hash (allows fast lookup + prevents duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sharing_members_token_hash ON sharing_members(token_hash);
CREATE INDEX IF NOT EXISTS idx_sharing_members_expires_at ON sharing_members(expires_at);
CREATE INDEX IF NOT EXISTS idx_sharing_members_revoked_at ON sharing_members(revoked_at) WHERE revoked_at IS NOT NULL;

-- ── joined_groups: add encrypted storage columns ───────────────
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS token_iv TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_ciphertext TEXT;
ALTER TABLE joined_groups ADD COLUMN IF NOT EXISTS remote_anon_key_iv TEXT;

-- ── RPCs rewritten to use token_hash + expiry + revocation ─────
CREATE OR REPLACE FUNCTION verify_join_token(p_token TEXT)
RETURNS TABLE(group_id TEXT, group_name TEXT, member_id TEXT, display_name TEXT, backend_type TEXT, creator_name TEXT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND sm.revoked_at IS NULL
    AND (sm.expires_at IS NULL OR sm.expires_at > now())
    AND sm.joined_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION confirm_join(p_token TEXT, p_display_name TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_members
  SET joined_at = now(),
      display_name = COALESCE(NULLIF(p_display_name, ''), display_name)
  WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
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
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
  );
$$;

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
    AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND sm.member_id = p_member_id
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
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
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
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
    WHERE sm.group_id = si.group_id
    AND sm.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND sm.joined_at IS NOT NULL
    AND sm.revoked_at IS NULL
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
    WHERE sm2.group_id = p_group_id
    AND sm2.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND sm2.joined_at IS NOT NULL
    AND sm2.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION leave_group(p_token TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM sharing_members
  WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
  AND role != 'creator'
  AND joined_at IS NOT NULL
  AND revoked_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_member(p_group_id TEXT, p_member_id TEXT)
RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE sharing_members
  SET revoked_at = now()
  WHERE group_id = p_group_id
    AND member_id = p_member_id
    AND role != 'creator';
$$;

-- Bump schema version
UPDATE settings SET value = '1.301', updated_at = now() WHERE key = 'schema_version';
INSERT INTO settings (key, value, owner_id, updated_at) VALUES ('schema_version', '1.301', NULL, now()) ON CONFLICT (key) DO NOTHING;
NOTIFY pgrst, 'reload schema';
