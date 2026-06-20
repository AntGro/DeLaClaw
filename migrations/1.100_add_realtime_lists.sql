-- Migration 1.100: Add lists, list_items, daily_visits to Realtime publication
-- These tables were added to the schema but missing from the Realtime publication.

ALTER PUBLICATION supabase_realtime ADD TABLE lists, list_items, daily_visits;

-- Bump schema version
UPDATE settings SET value = '1.100', updated_at = now()
WHERE key = 'schema_version';
