-- Migration 1.099: Enable Supabase Realtime for all tables
-- Required for cross-device live sync (postgres_changes subscriptions)

ALTER PUBLICATION supabase_realtime ADD TABLE
  tasks, projects, todos, habits, habit_completions,
  birthdays, vestiaire, flashcards, flashcard_notes,
  prompts, settings;

-- Bump schema version
UPDATE settings SET value = '1.099', updated_at = now()
WHERE key = 'schema_version';
