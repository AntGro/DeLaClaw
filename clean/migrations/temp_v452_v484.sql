-- temp_v452_v484.sql
-- Aggregates migrations 1.452, 1.453, 1.474, 1.484
-- Net effect:
--   1. get_group_members filters revoked members (1.452)
--   2. auth_email_guard table (1.453)
--   3. Category tables + FK columns + data discovery + protection trigger (1.474+1.484)
--   4. claim_ownership hardened (1.484)

-- ── 1. get_group_members — final version (filters revoked) ──
DROP FUNCTION IF EXISTS get_group_members(text, text);

CREATE OR REPLACE FUNCTION get_group_members(p_token text, p_group_id text)
RETURNS TABLE(member_id text, display_name text, invited_label text, role text, joined_at timestamp with time zone, auth_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sm.member_id, sm.display_name, sm.invited_label, sm.role, sm.joined_at, sm.auth_user_id
  FROM sharing_members sm
  WHERE sm.group_id = p_group_id
  AND sm.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM sharing_members sm2
    WHERE sm2.group_id = p_group_id
      AND sm2.token_hash = encode(digest(p_token::text, 'sha256'::text), 'hex'::text)
      AND sm2.joined_at IS NOT NULL
      AND sm2.revoked_at IS NULL
  );
$$;

-- ── 2. auth_email_guard ──
CREATE TABLE IF NOT EXISTS auth_email_guard (
  email_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now()
);

GRANT SELECT ON auth_email_guard TO anon;
GRANT SELECT, INSERT ON auth_email_guard TO authenticated;

-- ── 3. Category tables ──
CREATE TABLE IF NOT EXISTS todo_categories (
  id TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(16), 'hex'),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected BOOLEAN DEFAULT FALSE,
  owner_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habit_categories (
  id TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(16), 'hex'),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected BOOLEAN DEFAULT FALSE,
  owner_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vestiaire_categories (
  id TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(16), 'hex'),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected BOOLEAN DEFAULT FALSE,
  owner_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flashcard_decks (
  id TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(16), 'hex'),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected BOOLEAN DEFAULT FALSE,
  owner_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE todo_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE habit_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE vestiaire_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcard_decks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner or agent" ON todo_categories;
CREATE POLICY "owner or agent" ON todo_categories FOR ALL
  USING (owner_id = auth.uid() OR has_agent_access(owner_id))
  WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "owner or agent" ON habit_categories;
CREATE POLICY "owner or agent" ON habit_categories FOR ALL
  USING (owner_id = auth.uid() OR has_agent_access(owner_id))
  WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "owner or agent" ON vestiaire_categories;
CREATE POLICY "owner or agent" ON vestiaire_categories FOR ALL
  USING (owner_id = auth.uid() OR has_agent_access(owner_id))
  WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));
DROP POLICY IF EXISTS "owner or agent" ON flashcard_decks;
CREATE POLICY "owner or agent" ON flashcard_decks FOR ALL
  USING (owner_id = auth.uid() OR has_agent_access(owner_id))
  WITH CHECK (owner_id = auth.uid() OR has_agent_access(owner_id));

-- Triggers (owner_id)
DROP TRIGGER IF EXISTS trg_set_owner_id ON todo_categories;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON todo_categories FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON habit_categories;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON habit_categories FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON vestiaire_categories;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON vestiaire_categories FOR EACH ROW EXECUTE FUNCTION set_owner_id();
DROP TRIGGER IF EXISTS trg_set_owner_id ON flashcard_decks;
CREATE TRIGGER trg_set_owner_id BEFORE INSERT ON flashcard_decks FOR EACH ROW EXECUTE FUNCTION set_owner_id();

-- Realtime
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE todo_categories, habit_categories, vestiaire_categories, flashcard_decks; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed protected rows (idempotent)
INSERT INTO todo_categories (name, is_protected, sort_order)
  SELECT '', TRUE, 0 WHERE NOT EXISTS (SELECT 1 FROM todo_categories WHERE is_protected = TRUE AND name = '');
INSERT INTO todo_categories (name, is_protected, sort_order)
  SELECT '__shared__', TRUE, 9999 WHERE NOT EXISTS (SELECT 1 FROM todo_categories WHERE is_protected = TRUE AND name = '__shared__');
INSERT INTO habit_categories (name, is_protected, sort_order)
  SELECT '', TRUE, 0 WHERE NOT EXISTS (SELECT 1 FROM habit_categories WHERE is_protected = TRUE AND name = '');
INSERT INTO habit_categories (name, is_protected, sort_order)
  SELECT '__shared__', TRUE, 9999 WHERE NOT EXISTS (SELECT 1 FROM habit_categories WHERE is_protected = TRUE AND name = '__shared__');
INSERT INTO vestiaire_categories (name, is_protected, sort_order)
  SELECT '', TRUE, 0 WHERE NOT EXISTS (SELECT 1 FROM vestiaire_categories WHERE is_protected = TRUE AND name = '');
INSERT INTO vestiaire_categories (name, is_protected, sort_order)
  SELECT '__shared__', TRUE, 9999 WHERE NOT EXISTS (SELECT 1 FROM vestiaire_categories WHERE is_protected = TRUE AND name = '__shared__');
INSERT INTO flashcard_decks (name, is_protected, sort_order)
  SELECT '', TRUE, 0 WHERE NOT EXISTS (SELECT 1 FROM flashcard_decks WHERE is_protected = TRUE AND name = '');
INSERT INTO flashcard_decks (name, is_protected, sort_order)
  SELECT '__shared__', TRUE, 9999 WHERE NOT EXISTS (SELECT 1 FROM flashcard_decks WHERE is_protected = TRUE AND name = '__shared__');

-- Discover categories from existing items
INSERT INTO todo_categories (name, sort_order, owner_id)
SELECT DISTINCT t.category, ROW_NUMBER() OVER (ORDER BY t.category), t.owner_id
FROM todos t
WHERE t.category != '' AND t.category != '__shared__'
AND NOT EXISTS (SELECT 1 FROM todo_categories tc WHERE tc.name = t.category AND tc.owner_id = t.owner_id);

INSERT INTO habit_categories (name, sort_order, owner_id)
SELECT DISTINCT h.category, ROW_NUMBER() OVER (ORDER BY h.category), h.owner_id
FROM habits h
WHERE h.category != '' AND h.category != '__shared__'
AND NOT EXISTS (SELECT 1 FROM habit_categories hc WHERE hc.name = h.category AND hc.owner_id = h.owner_id);

INSERT INTO vestiaire_categories (name, sort_order, owner_id)
SELECT DISTINCT v.category, ROW_NUMBER() OVER (ORDER BY v.category), v.owner_id
FROM vestiaire v
WHERE v.category != '' AND v.category != '__shared__'
AND NOT EXISTS (SELECT 1 FROM vestiaire_categories vc WHERE vc.name = v.category AND vc.owner_id = v.owner_id);

INSERT INTO flashcard_decks (name, sort_order, owner_id)
SELECT DISTINCT f.deck, ROW_NUMBER() OVER (ORDER BY f.deck), f.owner_id
FROM flashcards f
WHERE f.deck != '' AND f.deck != '__shared__'
AND NOT EXISTS (SELECT 1 FROM flashcard_decks fd WHERE fd.name = f.deck AND fd.owner_id = f.owner_id);

INSERT INTO flashcard_decks (name, sort_order, owner_id)
SELECT DISTINCT t.deck,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM flashcard_decks) + ROW_NUMBER() OVER (ORDER BY t.deck),
       t.owner_id
FROM texts t
WHERE t.deck != '' AND t.deck != '__shared__'
AND NOT EXISTS (SELECT 1 FROM flashcard_decks fd WHERE fd.name = t.deck AND fd.owner_id = t.owner_id);

-- Backfill metadata from settings JSON
UPDATE todo_categories SET color = sub.val FROM (
  SELECT je.key AS cat_name, je.value #>> '{}' AS val, s.owner_id
  FROM settings s, jsonb_each(s.value::jsonb) je WHERE s.key = 'todo_category_colors'
) sub WHERE todo_categories.name = sub.cat_name AND todo_categories.owner_id = sub.owner_id;

UPDATE todo_categories SET shortname = sub.val FROM (
  SELECT je.key AS cat_name, je.value #>> '{}' AS val, s.owner_id
  FROM settings s, jsonb_each(s.value::jsonb) je WHERE s.key = 'todo_category_shortnames'
) sub WHERE todo_categories.name = sub.cat_name AND todo_categories.owner_id = sub.owner_id;

UPDATE habit_categories SET shortname = sub.val FROM (
  SELECT je.key AS cat_name, je.value #>> '{}' AS val, s.owner_id
  FROM settings s, jsonb_each(s.value::jsonb) je WHERE s.key = 'habit_category_shortnames'
) sub WHERE habit_categories.name = sub.cat_name AND habit_categories.owner_id = sub.owner_id;

UPDATE vestiaire_categories SET shortname = sub.val FROM (
  SELECT je.key AS cat_name, je.value #>> '{}' AS val, s.owner_id
  FROM settings s, jsonb_each(s.value::jsonb) je WHERE s.key = 'vest_category_shortnames'
) sub WHERE vestiaire_categories.name = sub.cat_name AND vestiaire_categories.owner_id = sub.owner_id;

UPDATE flashcard_decks SET shortname = sub.val FROM (
  SELECT je.key AS cat_name, je.value #>> '{}' AS val, s.owner_id
  FROM settings s, jsonb_each(s.value::jsonb) je WHERE s.key = 'flash_shortnames'
) sub WHERE flashcard_decks.name = sub.cat_name AND flashcard_decks.owner_id = sub.owner_id;

-- ── 4. FK columns on item tables (CASCADE) ──
ALTER TABLE todos ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE vestiaire ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS deck_id TEXT;
ALTER TABLE texts ADD COLUMN IF NOT EXISTS deck_id TEXT;

-- Drop any existing FKs then add with CASCADE
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_category_id_fkey;
ALTER TABLE todos ADD CONSTRAINT todos_category_id_fkey FOREIGN KEY (category_id) REFERENCES todo_categories(id) ON DELETE CASCADE;
ALTER TABLE habits DROP CONSTRAINT IF EXISTS habits_category_id_fkey;
ALTER TABLE habits ADD CONSTRAINT habits_category_id_fkey FOREIGN KEY (category_id) REFERENCES habit_categories(id) ON DELETE CASCADE;
ALTER TABLE vestiaire DROP CONSTRAINT IF EXISTS vestiaire_category_id_fkey;
ALTER TABLE vestiaire ADD CONSTRAINT vestiaire_category_id_fkey FOREIGN KEY (category_id) REFERENCES vestiaire_categories(id) ON DELETE CASCADE;
ALTER TABLE flashcards DROP CONSTRAINT IF EXISTS flashcards_deck_id_fkey;
ALTER TABLE flashcards ADD CONSTRAINT flashcards_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES flashcard_decks(id) ON DELETE CASCADE;
ALTER TABLE texts DROP CONSTRAINT IF EXISTS texts_deck_id_fkey;
ALTER TABLE texts ADD CONSTRAINT texts_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES flashcard_decks(id) ON DELETE CASCADE;

-- Populate FK values from existing string columns
UPDATE todos SET category_id = tc.id FROM todo_categories tc
WHERE tc.name = todos.category AND tc.owner_id = todos.owner_id AND todos.category_id IS NULL;

UPDATE habits SET category_id = hc.id FROM habit_categories hc
WHERE hc.name = habits.category AND hc.owner_id = habits.owner_id AND habits.category_id IS NULL;

UPDATE vestiaire SET category_id = vc.id FROM vestiaire_categories vc
WHERE vc.name = vestiaire.category AND vc.owner_id = vestiaire.owner_id AND vestiaire.category_id IS NULL;

UPDATE flashcards SET deck_id = fd.id FROM flashcard_decks fd
WHERE fd.name = flashcards.deck AND fd.owner_id = flashcards.owner_id AND flashcards.deck_id IS NULL;

UPDATE texts SET deck_id = fd.id FROM flashcard_decks fd
WHERE fd.name = texts.deck AND fd.owner_id = texts.owner_id AND texts.deck_id IS NULL;

-- ── 5. Column fixes from 1.484 ──
ALTER TABLE text_line_progress DROP COLUMN IF EXISTS deck_id;
ALTER TABLE vestiaire ALTER COLUMN category SET DEFAULT '';
ALTER TABLE texts ALTER COLUMN deck SET DEFAULT '';

-- ── 6. Protection trigger ──
CREATE OR REPLACE FUNCTION protect_category_row() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_protected THEN
      RAISE EXCEPTION 'Cannot delete protected row %', OLD.id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.is_protected AND OLD.owner_id IS NULL AND NEW.owner_id IS NOT NULL THEN
      IF OLD.name IS DISTINCT FROM NEW.name OR OLD.is_protected IS DISTINCT FROM NEW.is_protected THEN
        RAISE EXCEPTION 'Cannot change name/flag of protected %', OLD.id;
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.is_protected AND (OLD.name IS DISTINCT FROM NEW.name OR OLD.id IS DISTINCT FROM NEW.id OR OLD.is_protected IS DISTINCT FROM NEW.is_protected) THEN
      RAISE EXCEPTION 'Cannot modify protected row % (only color/shortname/sort_order)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_todo_categories ON todo_categories;
CREATE TRIGGER trg_protect_todo_categories BEFORE DELETE OR UPDATE ON todo_categories FOR EACH ROW WHEN (OLD.is_protected = TRUE) EXECUTE FUNCTION protect_category_row();
DROP TRIGGER IF EXISTS trg_protect_habit_categories ON habit_categories;
CREATE TRIGGER trg_protect_habit_categories BEFORE DELETE OR UPDATE ON habit_categories FOR EACH ROW WHEN (OLD.is_protected = TRUE) EXECUTE FUNCTION protect_category_row();
DROP TRIGGER IF EXISTS trg_protect_vestiaire_categories ON vestiaire_categories;
CREATE TRIGGER trg_protect_vestiaire_categories BEFORE DELETE OR UPDATE ON vestiaire_categories FOR EACH ROW WHEN (OLD.is_protected = TRUE) EXECUTE FUNCTION protect_category_row();
DROP TRIGGER IF EXISTS trg_protect_flashcard_decks ON flashcard_decks;
CREATE TRIGGER trg_protect_flashcard_decks BEFORE DELETE OR UPDATE ON flashcard_decks FOR EACH ROW WHEN (OLD.is_protected = TRUE) EXECUTE FUNCTION protect_category_row();

-- ── 7. Indexes ──
CREATE INDEX IF NOT EXISTS idx_todo_categories_owner_id ON todo_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_habit_categories_owner_id ON habit_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_vestiaire_categories_owner_id ON vestiaire_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_decks_owner_id ON flashcard_decks(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_category_id ON todos(category_id);
CREATE INDEX IF NOT EXISTS idx_habits_category_id ON habits(category_id);
CREATE INDEX IF NOT EXISTS idx_vestiaire_category_id ON vestiaire(category_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_deck_id ON flashcards(deck_id);
CREATE INDEX IF NOT EXISTS idx_texts_deck_id ON texts(deck_id);

-- ── 8. claim_ownership — hardened final version ──
CREATE OR REPLACE FUNCTION claim_ownership()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  BEGIN DELETE FROM daily_visits WHERE owner_id IS NULL AND visit_date IN (SELECT visit_date FROM daily_visits WHERE owner_id = uid); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE projects SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE tasks SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE todos SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE habits SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE habit_completions SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE flashcards SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE flashcard_notes SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE texts SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE text_line_progress SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE birthdays SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE vestiaire SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE lists SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE list_items SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE settings SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE prompts SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE nvidia_usage SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE daily_visits SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table OR unique_violation THEN NULL; END;
  BEGIN UPDATE joined_groups SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE agent_grants SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE todo_categories SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE habit_categories SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE vestiaire_categories SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN UPDATE flashcard_decks SET owner_id = uid WHERE owner_id IS NULL; EXCEPTION WHEN undefined_table THEN NULL; END;
END;
$$;

-- ── 9. Clean up dead settings keys ──
DELETE FROM settings WHERE key IN (
  'todo_category_colors', 'todo_category_shortnames',
  'habit_category_shortnames', 'vest_category_shortnames',
  'flash_shortnames'
);
