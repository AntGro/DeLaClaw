-- Last — local SQLite schema (mirrors Supabase tables)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shortname TEXT,
  color TEXT,
  tech TEXT,
  links TEXT, -- JSON array
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project TEXT REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'review', 'approved', 'revision')),
  plan_note TEXT,
  hatch_response TEXT,
  context TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  text TEXT,
  done INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'normal')),
  due_date TEXT,
  snooze_until TEXT,
  category TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  frequency_rule TEXT,
  category TEXT DEFAULT 'General',
  is_draft INTEGER DEFAULT 0,
  next_due TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_completions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  habit_id TEXT REFERENCES habits(id) ON DELETE CASCADE,
  completed_at TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deck TEXT NOT NULL,
  front TEXT,
  back TEXT,
  stability REAL DEFAULT 0,
  difficulty REAL DEFAULT 5,
  last_review TEXT,
  next_review TEXT,
  review_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flashcard_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  content TEXT,
  proposed_front TEXT,
  proposed_back TEXT,
  proposed_deck TEXT,
  proposal_status TEXT DEFAULT 'pending' CHECK (proposal_status IN ('pending', 'ready', 'accepted', 'rejected')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deck TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  content TEXT NOT NULL,
  lines_per_chunk INTEGER NOT NULL DEFAULT 4,
  context_lines INTEGER NOT NULL DEFAULT 3,
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS birthdays (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  birthday TEXT NOT NULL,
  note TEXT,
  avatar_url TEXT,
  category TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vestiaire (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  category TEXT DEFAULT '',
  color TEXT,
  note TEXT,
  purchase_status TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  key TEXT PRIMARY KEY,
  text TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nvidia_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_visits (
  visit_date TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
