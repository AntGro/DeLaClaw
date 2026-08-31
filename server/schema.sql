-- Last — local SQLite schema (mirrors Supabase tables)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  tech TEXT,
  links TEXT, -- JSON array
  sort_order INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project TEXT REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('draft', 'todo', 'in-progress', 'review', 'approved', 'revision', 'idea', 'idea-shipped', 'idea-plan-requested')),
  plan_note TEXT,
  hatch_response TEXT,
  context TEXT,
  sort_order INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ── Category tables ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS todo_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vestiaire_categories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcard_decks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  is_protected INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  text TEXT,
  done INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  due_date TEXT,
  snooze_until TEXT,
  category TEXT DEFAULT '',
  category_id TEXT REFERENCES todo_categories(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  shared_id TEXT,
  shared_group_id TEXT,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  frequency_rule TEXT,
  category TEXT DEFAULT '',
  category_id TEXT REFERENCES habit_categories(id) ON DELETE CASCADE,
  is_draft INTEGER DEFAULT 0,
  next_due TEXT,
  shared_id TEXT,
  shared_group_id TEXT,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_completions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  habit_id TEXT REFERENCES habits(id) ON DELETE CASCADE,
  completed_at TEXT,
  completed_by TEXT,
  owner_id TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deck TEXT NOT NULL,
  deck_id TEXT REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  front TEXT,
  back TEXT,
  stability REAL DEFAULT 0,
  difficulty REAL DEFAULT 5,
  last_review TEXT,
  next_review TEXT,
  review_count INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcard_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content TEXT,
  proposed_front TEXT,
  proposed_back TEXT,
  proposed_deck TEXT,
  proposal_status TEXT DEFAULT 'pending' CHECK (proposal_status IN ('pending', 'ready', 'accepted', 'rejected')),
  sort_order INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deck TEXT NOT NULL,
  deck_id TEXT REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  content TEXT NOT NULL,
  lines_per_chunk INTEGER NOT NULL DEFAULT 4,
  context_lines INTEGER NOT NULL DEFAULT 3,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS text_line_progress (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  text_id TEXT REFERENCES texts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 5,
  last_review TEXT,
  next_review TEXT,
  review_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS birthdays (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  birthday TEXT NOT NULL,
  note TEXT,
  avatar_url TEXT,
  category TEXT DEFAULT '',
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vestiaire (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  category TEXT DEFAULT '',
  category_id TEXT REFERENCES vestiaire_categories(id) ON DELETE CASCADE,
  color TEXT,
  note TEXT,
  purchase_status TEXT,
  sort_order INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  owner_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  key TEXT PRIMARY KEY,
  text TEXT,
  owner_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nvidia_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  checked INTEGER DEFAULT 0,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  shared_id TEXT,
  shared_group_id TEXT,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_visits (
  visit_date TEXT NOT NULL,
  owner_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (visit_date, owner_id)
);

CREATE TABLE IF NOT EXISTS joined_groups (
  group_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  token TEXT,
  display_name TEXT,
  group_name TEXT,
  remote_backend_type TEXT NOT NULL,
  remote_url TEXT,
  remote_anon_key TEXT,
  owner_id TEXT,
  token_ciphertext TEXT,
  token_iv TEXT,
  remote_anon_key_ciphertext TEXT,
  remote_anon_key_iv TEXT,
  joined_at TEXT DEFAULT (datetime('now'))
);

-- ── Indexes for owner_id and shared_id — avoid full scans as tables grow ──
CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_owner_id ON todos(owner_id);
CREATE INDEX IF NOT EXISTS idx_habits_owner_id ON habits(owner_id);
CREATE INDEX IF NOT EXISTS idx_habit_completions_owner_id ON habit_completions(owner_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_notes_owner_id ON flashcard_notes(owner_id);
CREATE INDEX IF NOT EXISTS idx_birthdays_owner_id ON birthdays(owner_id);
CREATE INDEX IF NOT EXISTS idx_vestiaire_owner_id ON vestiaire(owner_id);
CREATE INDEX IF NOT EXISTS idx_lists_owner_id ON lists(owner_id);
CREATE INDEX IF NOT EXISTS idx_list_items_owner_id ON list_items(owner_id);
CREATE INDEX IF NOT EXISTS idx_prompts_owner_id ON prompts(owner_id);
CREATE INDEX IF NOT EXISTS idx_settings_owner_id ON settings(owner_id);
CREATE INDEX IF NOT EXISTS idx_joined_groups_owner_id ON joined_groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_id ON todos(shared_id);
CREATE INDEX IF NOT EXISTS idx_todos_shared_group_id ON todos(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_id ON habits(shared_id);
CREATE INDEX IF NOT EXISTS idx_habits_shared_group_id ON habits(shared_group_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_id ON list_items(shared_id);
CREATE INDEX IF NOT EXISTS idx_list_items_shared_group_id ON list_items(shared_group_id);

-- ── Category table indexes ──
CREATE INDEX IF NOT EXISTS idx_todo_categories_owner_id ON todo_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_habit_categories_owner_id ON habit_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_vestiaire_categories_owner_id ON vestiaire_categories(owner_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_decks_owner_id ON flashcard_decks(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_category_id ON todos(category_id);
CREATE INDEX IF NOT EXISTS idx_habits_category_id ON habits(category_id);
CREATE INDEX IF NOT EXISTS idx_vestiaire_category_id ON vestiaire(category_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_deck_id ON flashcards(deck_id);
CREATE INDEX IF NOT EXISTS idx_texts_deck_id ON texts(deck_id);

-- 1.410 agent grants (parity with Supabase)
CREATE TABLE IF NOT EXISTS agent_grants (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id TEXT,
  display_name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_grants_owner_id ON agent_grants(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_grants_token_hash ON agent_grants(token_hash);

-- ── Seed protected category rows ──
INSERT OR IGNORE INTO todo_categories (id, name, is_protected, sort_order) VALUES ('_default_todo_cat', '', 1, 0);
INSERT OR IGNORE INTO todo_categories (id, name, is_protected, sort_order) VALUES ('_shared_todo_cat', '__shared__', 1, 9999);
INSERT OR IGNORE INTO habit_categories (id, name, is_protected, sort_order) VALUES ('_default_habit_cat', '', 1, 0);
INSERT OR IGNORE INTO habit_categories (id, name, is_protected, sort_order) VALUES ('_shared_habit_cat', '__shared__', 1, 9999);
INSERT OR IGNORE INTO vestiaire_categories (id, name, is_protected, sort_order) VALUES ('_default_vest_cat', '', 1, 0);
INSERT OR IGNORE INTO vestiaire_categories (id, name, is_protected, sort_order) VALUES ('_shared_vest_cat', '__shared__', 1, 9999);
INSERT OR IGNORE INTO flashcard_decks (id, name, is_protected, sort_order) VALUES ('_default_deck', '', 1, 0);
INSERT OR IGNORE INTO flashcard_decks (id, name, is_protected, sort_order) VALUES ('_shared_deck', '__shared__', 1, 9999);

-- ── Protection triggers: prevent DELETE or UPDATE of is_protected rows ──
CREATE TRIGGER IF NOT EXISTS trg_protect_todo_categories
  BEFORE DELETE ON todo_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot delete protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_todo_categories_upd
  BEFORE UPDATE ON todo_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot modify protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_habit_categories
  BEFORE DELETE ON habit_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot delete protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_habit_categories_upd
  BEFORE UPDATE ON habit_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot modify protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_vestiaire_categories
  BEFORE DELETE ON vestiaire_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot delete protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_vestiaire_categories_upd
  BEFORE UPDATE ON vestiaire_categories FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot modify protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_flashcard_decks
  BEFORE DELETE ON flashcard_decks FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot delete protected category row'); END;

CREATE TRIGGER IF NOT EXISTS trg_protect_flashcard_decks_upd
  BEFORE UPDATE ON flashcard_decks FOR EACH ROW
  WHEN OLD.is_protected = 1
  BEGIN SELECT RAISE(ABORT, 'Cannot modify protected category row'); END;

-- Google Calendar sync tracking
CREATE TABLE IF NOT EXISTS gcal_sync (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  gcal_event_id TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (item_type, item_id)
);
