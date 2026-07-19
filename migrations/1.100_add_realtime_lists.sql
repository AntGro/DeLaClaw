-- Migration 1.100: Add lists, list_items, daily_visits to Realtime publication
-- These tables were added to the schema but missing from the Realtime publication.

ALTER PUBLICATION supabase_realtime ADD TABLE lists, list_items, daily_visits;

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.100', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
