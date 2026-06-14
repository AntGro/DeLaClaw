-- Migration 001: Enable RLS on all tables with permissive policy
-- Satisfies Supabase's upcoming GRANT/RLS requirement (Oct 30, 2026)
-- No behavioral change — all operations still allowed for all roles

-- birthdays
GRANT SELECT, INSERT, UPDATE, DELETE ON public.birthdays TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.birthdays TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.birthdays TO service_role;
ALTER TABLE public.birthdays ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_birthdays" ON public.birthdays FOR ALL USING (true) WITH CHECK (true);

-- habit_completions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habit_completions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habit_completions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habit_completions TO service_role;
ALTER TABLE public.habit_completions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_habit_completions" ON public.habit_completions FOR ALL USING (true) WITH CHECK (true);

-- habits
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habits TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.habits TO service_role;
ALTER TABLE public.habits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_habits" ON public.habits FOR ALL USING (true) WITH CHECK (true);

-- flashcard_notes
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcard_notes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcard_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcard_notes TO service_role;
ALTER TABLE public.flashcard_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_flashcard_notes" ON public.flashcard_notes FOR ALL USING (true) WITH CHECK (true);

-- flashcards
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcards TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flashcards TO service_role;
ALTER TABLE public.flashcards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_flashcards" ON public.flashcards FOR ALL USING (true) WITH CHECK (true);

-- nvidia_usage
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nvidia_usage TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nvidia_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nvidia_usage TO service_role;
ALTER TABLE public.nvidia_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_nvidia_usage" ON public.nvidia_usage FOR ALL USING (true) WITH CHECK (true);

-- projects
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_projects" ON public.projects FOR ALL USING (true) WITH CHECK (true);

-- prompts
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompts TO service_role;
ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_prompts" ON public.prompts FOR ALL USING (true) WITH CHECK (true);

-- settings
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_settings" ON public.settings FOR ALL USING (true) WITH CHECK (true);

-- tasks
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_tasks" ON public.tasks FOR ALL USING (true) WITH CHECK (true);

-- todos
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO service_role;
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_todos" ON public.todos FOR ALL USING (true) WITH CHECK (true);

-- vestiaire
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vestiaire TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vestiaire TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vestiaire TO service_role;
ALTER TABLE public.vestiaire ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_vestiaire" ON public.vestiaire FOR ALL USING (true) WITH CHECK (true);
