-- Migration 1.608: Add sort_order to flashcard_notes for draft reorder
ALTER TABLE flashcard_notes ADD COLUMN sort_order INTEGER DEFAULT 0;

-- Bump schema version
INSERT INTO settings (key, value, updated_at)
VALUES ('schema_version', '1.608', datetime('now'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = datetime('now');
