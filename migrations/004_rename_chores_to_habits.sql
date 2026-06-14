-- Rename chores tables and columns to habits
ALTER TABLE chores RENAME TO habits;
ALTER TABLE chore_completions RENAME TO habit_completions;
ALTER TABLE habit_completions RENAME COLUMN chore_id TO habit_id;

-- Update RLS policies (if named after old table)
-- Supabase auto-renames policies tied to the table, but if you have
-- manually named policies referencing "chore", update them:
-- ALTER POLICY "chore_select" ON habits RENAME TO "habit_select";
-- (Adjust based on your actual policy names)
