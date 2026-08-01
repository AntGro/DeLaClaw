-- Migration 1.573: Move list shortnames from settings accessor to a proper column
-- Aligns lists with todo_categories / habit_categories / vestiaire_categories / flashcard_decks
-- which all have a shortname TEXT column directly.

-- Add the column
ALTER TABLE lists ADD COLUMN IF NOT EXISTS shortname TEXT;

-- Backfill from settings JSON (key = 'list_shortnames', value is {"<list_id>": "<shortname>", ...})
UPDATE lists SET shortname = (
  SELECT je.value FROM settings s, json_each(s.value::text) je
  WHERE s.key = 'list_shortnames' AND je.key = lists.id::text LIMIT 1
) WHERE EXISTS (
  SELECT 1 FROM settings s, json_each(s.value::text) je
  WHERE s.key = 'list_shortnames' AND je.key = lists.id::text
);

-- Remove the dead settings key
DELETE FROM settings WHERE key = 'list_shortnames';

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.573', now())
  ON CONFLICT (key) DO UPDATE SET value = '1.573', updated_at = now();
