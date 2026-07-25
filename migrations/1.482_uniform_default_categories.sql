-- Migration 1.482: Uniform default category names
-- All protected default rows now use '' (empty string) as the name.
-- Display is handled by i18n in the UI (t('common.category_default')).

-- Habits: 'General' → ''
UPDATE habit_categories SET name = '' WHERE is_protected = TRUE AND name = 'General';

-- Flashcard decks: 'Général' → ''
UPDATE flashcard_decks SET name = '' WHERE is_protected = TRUE AND name = 'Général';

-- Update default values on item string columns
ALTER TABLE habits ALTER COLUMN category SET DEFAULT '';
ALTER TABLE flashcards ALTER COLUMN deck SET DEFAULT '';

-- Backfill existing items that still have the old default names
UPDATE habits SET category = '' WHERE category = 'General' AND category_id IS NOT NULL
  AND category_id IN (SELECT id FROM habit_categories WHERE is_protected = TRUE AND name = '');

UPDATE flashcards SET deck = '' WHERE deck = 'Général' AND deck_id IS NOT NULL
  AND deck_id IN (SELECT id FROM flashcard_decks WHERE is_protected = TRUE AND name = '');

UPDATE texts SET deck = '' WHERE deck = 'Général' AND deck_id IS NOT NULL
  AND deck_id IN (SELECT id FROM flashcard_decks WHERE is_protected = TRUE AND name = '');

-- Bump schema version
UPDATE settings SET value = '1.482' WHERE key = 'schema_version';
