-- Migration 002: Text Revision tables (spaced repetition for poems/texts)

-- texts — one row per poem/text
CREATE TABLE IF NOT EXISTS public.texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck text NOT NULL,
  title text NOT NULL,
  author text,
  content text NOT NULL,
  lines_per_chunk int NOT NULL DEFAULT 4,
  context_lines int NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- text_line_progress — one row per reviewable chunk
CREATE TABLE IF NOT EXISTS public.text_line_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text_id uuid NOT NULL REFERENCES public.texts(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  stability float NOT NULL DEFAULT 0,
  difficulty float NOT NULL DEFAULT 5,
  last_review timestamptz,
  next_review timestamptz,
  review_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS + GRANTs (same pattern as 001)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.texts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.texts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.texts TO service_role;
ALTER TABLE public.texts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_texts" ON public.texts FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.text_line_progress TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.text_line_progress TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.text_line_progress TO service_role;
ALTER TABLE public.text_line_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_text_line_progress" ON public.text_line_progress FOR ALL USING (true) WITH CHECK (true);
