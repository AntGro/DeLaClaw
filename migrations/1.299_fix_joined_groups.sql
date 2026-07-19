-- Migration 1.299: Fix joined_groups RLS leak (P0)
-- Previous policy allowed anon to read all owner_id IS NULL rows
DELETE FROM joined_groups WHERE owner_id IS NULL;
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid());
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.299', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Refresh PostgREST schema cache so new policy is visible immediately
NOTIFY pgrst, 'reload schema';
