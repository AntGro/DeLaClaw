-- Migration 1.299: Fix joined_groups RLS leak (P0)
-- Previous policy "owner or unclaimed" allowed any anon holder of anonKey to SELECT
-- rows where owner_id IS NULL, stealing tokens + remote_url + remote_anon_key.
-- Fix: require auth, owner only. Anon joins should use localStorage, not table.
-- Also clean existing unclaimed rows (they were publicly readable).

-- Delete leaked unclaimed rows (they were readable by any anon)
DELETE FROM joined_groups WHERE owner_id IS NULL;

-- Rewrite policy to owner-only
DROP POLICY IF EXISTS "owner or unclaimed" ON joined_groups;
DROP POLICY IF EXISTS "owner only" ON joined_groups;
CREATE POLICY "owner only" ON joined_groups FOR ALL USING (owner_id = auth.uid());

-- Bump schema version
UPDATE settings SET value = '1.299', updated_at = now() WHERE key = 'schema_version';
