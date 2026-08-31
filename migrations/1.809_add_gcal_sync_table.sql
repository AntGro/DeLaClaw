-- Migration 1.809: Add gcal_sync table for Google Calendar integration
-- frozen — last Supabase migration (Supabase backend deprecated)
-- Tracks which habits/todos/birthdays have been synced to Google Calendar
-- and stores the corresponding Calendar event ID for updates/deletes.

CREATE TABLE IF NOT EXISTS gcal_sync (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  gcal_event_id TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_type, item_id)
);

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.809', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
