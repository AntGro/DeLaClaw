-- Migration 1.453: Auth email guard
--
-- Prevents silent data splits when the same Supabase project is
-- authenticated with two different emails on different devices.
-- Stores a SHA-256 hash of the first authenticated email (lowercased).
-- Subsequent devices check the hash before sending a magic link.
--
-- No RLS: anon must SELECT pre-auth to validate the email.
-- INSERT restricted to authenticated role only (prevents race attacks).

CREATE TABLE IF NOT EXISTS auth_email_guard (
  email_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Anon can read (pre-auth check), only authenticated can write
GRANT SELECT ON auth_email_guard TO anon;
GRANT SELECT, INSERT ON auth_email_guard TO authenticated;

-- Update schema version
INSERT INTO settings (key, value, updated_at)
VALUES ('schema_version', '1.453', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

NOTIFY pgrst, 'reload schema';
