-- Migration 1.523: RPC to let a joined member update their own display name
-- Token-authenticated: only the member who owns the token can change their name

CREATE OR REPLACE FUNCTION update_member_display_name(p_token text, p_display_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  UPDATE sharing_members
  SET display_name = p_display_name
  WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND joined_at IS NOT NULL
    AND revoked_at IS NULL;
END;
$$;

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.523', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
