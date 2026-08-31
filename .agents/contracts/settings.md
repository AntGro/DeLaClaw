# Settings — Core Contract

## Purpose
Cross-cutting app configuration — theme, language, backend picker, AI/NVIDIA config, sharing management, usage stats, agent tokens, data import/export, and category table management.

## Entry & Ownership
- **Entry:** `js/main.js` (settings pane switching, backup, loadSettings, usage stats) + `js/state.js` (STAY_CONNECTED_KEY) + `js/agents-ui.js` (agents pane) + `js/version.js`
- **State:** see `CODEMAP.json:core[main,state,agents-ui]` for current loc, esc_count, i18n_count
- **Tables:** `settings` (key-value: `schema_version`, `nvidia_api_key`, `nvidia_model`, theme, etc.), `prompts`, `daily_visits`, `nvidia_usage`, `agent_grants`, `todo_categories`, `habit_categories`, `vestiaire_categories`, `flashcard_decks`

## Dependencies
- **Depends on:** `db`, `i18n`, `icons`, `utils`, `state`, all feature modules (for data loading)
- **Dependents:** all features read `settings` for config; all features use category/deck tables

## UI / UX
- **Reused components:** `.settings-nav-btn` with `data-pane`, `.settings-data-btn`, `.setting-group`, `.setting-hint`, `.usage-stats-container`, `.page-empty-state`
- **Panes:** `['general', 'ai', 'sharing', 'data', 'stats', 'agents']`
  - **general** — language picker (EN/FR/ES), theme toggle (dark/light)
  - **ai** — NVIDIA API key, model selector, usage toggle
  - **sharing** — auth link sending (`sendAuthFromSharing`), sharing group management
  - **data** — backup export/import, backend connection
  - **stats** — usage statistics: DB age, visit count, streak via `daily_visits` + `nvidia_usage`
  - **agents** — API token management for external agents (`agent_grants`)
- **Hash routing:** `#settings` and `#settings/<pane>` deep-link to specific panes

## Interaction Guards
- **Saves:** `guard()` for import/export, category edits, prompt saves
- Backend switch: disabled during connection test

## Security
- **XSS:** all category names/shortnames via `esc()` when rendering tabs and bucket headers
- Backup JSON export must not leak `agent_grants` raw tokens (only hashes), no secrets
- Backup `_meta` includes `source_url` (Supabase project URL at export time) for migration detection

## i18n
- **Prefix:** `menu.` + `settings.` + `auth.` + `agents.` — see CODEMAP core modules for current key counts
- Language change must trigger `applyI18n()` for all panes

## Business Invariants

### Settings Table
- Key-value store: `schema_version`, `nvidia_api_key`, `nvidia_model`, archived project IDs, `gcal_sync_enabled`, `gcal_calendar_id`, `gcal_sync_habits`, `gcal_sync_todos`, `gcal_sync_birthdays`
- `loadSettings()` reads at startup, populates `state.nvidiaApiKey`, `state.nvidiaModel`
- `schema_version` checked against `VERSION` `latest_compat` / `latest_compat_deprec` for compatibility banners

### Category Tables
- `todo_categories`, `habit_categories`, `vestiaire_categories`, `flashcard_decks` — each has a protected default row (`name=''`, `is_protected=1`) guarded by `protect_category_row()` trigger
- Item FKs use CASCADE on delete — deleting a user category deletes its items
- App-level sharing cleanup runs before CASCADE to propagate shared-item deletion to all group members
- Shortnames live directly on category/deck/project/list table rows as a `shortname` column (not in settings table)
- Colors: solid header `var(--cat-color)` + 6% tinted body via `color-mix(in srgb, var(--cat-color) 6%, var(--bg))`

### Backend Picker
- Supabase | Local | Demo — segmented pill, mode-aware labels/hints/placeholders
- `#login` hash timing fixed to avoid race
- `STAY_CONNECTED_KEY` persists connection credentials in localStorage

### Backend-Scoped localStorage
- `swapLsScope(newMode)` isolates per-backend settings so switching backends doesn't leak real user data into demo mode
- Scoped keys: theme, view, category config — global keys (STAY_CONNECTED_KEY, lang, install-dismiss) are never scoped

### Daily Visits / Stats
- `daily_visits` table: upsert on each app load for visit tracking
- Stats pane renders DB age, total visits, streak, NVIDIA usage breakdown

### Backup Export/Import
- `BACKUP_TABLES` order: category/deck parents → parent tables → child/independent tables → settings/prompts/usage → sharing (groups → members → items) → joined_groups, agent_grants
- Clear runs in reverse order (children before parents)
- Export: `_meta` includes version, timestamp, table list, and `source_url`
- Import: strips `owner_id` from all rows (trigger stamps new UID), rewrites `auth_owner_id` on `sharing_groups` to new `auth.uid()`, runs migrations before applying settings

## Adapter & Backend
- `db.from('settings')`, `db.from('prompts')`, `db.from('daily_visits')`, `db.from('nvidia_usage')`, `db.from('agent_grants')`
- All backends implement settings table

## Sharing
- Settings are per-user, not shared
- Sharing pane in settings manages group creation, auth, and member management

## Cross-Feature Edges
- Changing category color → all features using bucket layout must re-render (todos, habits, projects, vestiaire, lists, flashcards)
- Theme toggle → affects hero, gate, storm, all header backgrounds
- Language change → all features re-render via `applyI18n()`

## Risks / Gotchas
- Wardrobe category duplication on lang switch (fixed May 31) — root cause SW caching stale JS
- Demo mode leaking real categories — fixed via `swapLsScope` sandbox
- Backup import must run migrations before applying settings
- Stats pane loads lazily (`loadUsageStats()` called only when pane activated)

## Test Hooks
- `bun tests/tests.js`: theme var usage, esc for category names, CODEMAP freshness
- Manual: switch language → verify no duplicate categories, theme persists after reload
- Manual: export backup, import on fresh instance, verify all data restored
- Manual: deep-link `#settings/ai` → verify AI pane opens directly

## References
- `CODEMAP.json:core[main,state,agents-ui,version]`
- Tables: `settings`, `prompts`, `daily_visits`, `nvidia_usage`, `agent_grants`
- Entry: `js/state.js`, `js/main.js:switchSettingsPane()`, `js/agents-ui.js`
