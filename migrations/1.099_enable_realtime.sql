-- Migration 1.099: Enable Supabase Realtime for all tables
-- Required for cross-device live sync (postgres_changes subscriptions)

ALTER PUBLICATION supabase_realtime ADD TABLE
  tasks, projects, todos, habits, habit_completions,
  birthdays, vestiaire, flashcards, flashcard_notes,
  prompts, settings;

-- Bump schema version
INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.099', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
