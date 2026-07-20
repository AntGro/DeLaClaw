# Settings — Core Contract

## Purpose
Cross-cutting app configuration — theme, language, category shortnames/colors, auth, backend picker, agent tokens, data import/export.

## Entry & Ownership
- **Entry:** `js/main.js` (settings pane switching) + `js/state.js` (STAY_CONNECTED_KEY) + `js/agents-ui.js` (agents pane) + `js/version.js`
- **State:** `STAY_CONNECTED_KEY`, theme, language, `flash_shortnames`, `habit_category_shortnames`, `todo_category_shortnames`, `todo_category_colors`, `vest_category_shortnames`, `project_category_shortnames`, `list_category_*`
- **Tables:** `settings` (key-value: `schema_version`, category shortnames, colors, theme, etc.), `prompts`
- **CODEMAP:** core — `state`, `main`, `agents-ui` (settings pane), not a feature

## Dependencies
- **Depends on:** `db`, `i18n`, `icons`, `utils`, `state`
- **Dependents:** all features read `settings` for shortnames/colors/theme

## UI / UX
- **Reused components:** `.settings-nav-btn` with `data-pane`, `.settings-data-btn`, `.setting-group`, `.setting-hint`, `.page-empty-state`
- **Panes:** general, data, prompts, agents (bot icon), backend chooser
- **Language picker:** EN/FR/ES in General pane, persisted via settings + i18n
- **Theme:** dark/light toggle via Settings > Display, CSS vars

## Interaction Guards
- **Saves:** `guard()` for `saveGlobalPrompt`, `saveProjectPrompt`, `saveNewCategory`, import/export
- Category edits: modal save disabled until fulfilled
- Backend switch: disabled during connection test

## Security
- **XSS:** all category names/shortnames via `esc()` when rendering tabs and bucket headers
- Settings keys like `todo_category_colors` contain user-controlled hex — validate via allowlist, not raw style injection
- Backup JSON export must not leak `agent_grants` raw tokens (only hashes), no secrets

## i18n
- **Prefix:** `settings.` + `auth.` + `agents.` — ~80 keys
- Language change must trigger `applyI18n()` for all panes + CODEMAP i18n_prefix checks

## Business Invariants
- Category shortnames are DB-synced: keys `flash_shortnames`, `habit_category_shortnames`, `todo_category_shortnames`, `vest_category_shortnames`, `project_category_shortnames` in `settings` table — not hardcoded
- Colors: `todo_category_colors` etc. — solid header `var(--cat-color)` + 6% tinted body via `color-mix(in srgb,var(--cat-color) 6%, var(--bg))`
- Language picker persists `settings.lang` and updates `js/i18n.js` `t()` cache
- Backend picker: Supabase | Local | Demo — segmented pill, mode-aware labels/hints/placeholders; `#login` hash timing fixed to avoid race
- `schema_version` in `settings` tracks migrations, checked against `VERSION` `latest_compat`

## Adapter & Backend
- Only via `db.from('settings')`, `db.from('prompts')`
- Settings are backend-scoped localStorage (`swapLsScope`) for demo mode isolation — 16 scoped keys (theme/view/categories/shortnames) to prevent leaking real user data into demo
- All backends implement settings table

## Sharing
- Settings are per-user, not shared; category definitions not shared via groups

## Cross-Feature Edges
- Changing category shortname/color → all features using bucket layout must re-render (todos, habits, projects, vestiaire, lists)
- Theme toggle → affects hero, gate, storm, all header backgrounds (solid cat-color)

## Risks / Gotchas
- Wardrobe category duplication on lang switch (fixed May 31) — root cause SW caching stale JS
- Demo mode leaking real categories — fixed via `swapLsScope` sandbox
- Backup import must run migrations before applying settings

## Test Hooks
- `bun tests/tests.js`: checks category shortnames DB-sync, theme var usage, esc for category names, CODEMAP freshness
- Manual: switch language → verify no duplicate vestiaire categories, theme persists after reload

## References
- `CODEMAP.json:core[state,main,agents-ui]`
- Tables: `settings`, `prompts`, Entry: `js/state.js`, `js/main.js:switchSettingsPane()`

