-- Migration 1.560: drop plaintext token/remote_anon_key from joined_groups
-- Since 1.397 the app stores only encrypted versions (token_ciphertext/token_iv,
-- remote_anon_key_ciphertext/remote_anon_key_iv). The plaintext columns were
-- already set to NULL by the app; remove them entirely.

ALTER TABLE joined_groups DROP COLUMN IF EXISTS token;
ALTER TABLE joined_groups DROP COLUMN IF EXISTS remote_anon_key;

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.560', now())
  ON CONFLICT (key) DO UPDATE SET value = '1.560', updated_at = now();
