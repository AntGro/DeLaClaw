-- Migration 1.560: make joined_groups.token nullable
-- The plaintext token column was NOT NULL from 1.484, but since 1.397
-- the app stores only the encrypted version (token_ciphertext/token_iv)
-- and sets token = NULL. Drop the constraint so joins don't fail.

ALTER TABLE joined_groups ALTER COLUMN token DROP NOT NULL;

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.560', now())
  ON CONFLICT (key) DO UPDATE SET value = '1.560', updated_at = now();
