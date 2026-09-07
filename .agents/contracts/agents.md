# Agents — Feature Contract

## Purpose
Allow external AI agents (Claude Code, Codex CLI, OpenClaw…) to access the user's DeLaClaw data via API tokens. Multi-token, hashed-at-rest, revocable, scoped to owner.

Supabase was removed (v2.0.9) — the agent *connection method* (how an external agent reaches the data) is being reworked and is currently TBD. The token lifecycle in Settings (create / copy setup prompt / revoke / list) is kept and functional.

User jobs:
- create named agent token → get ready-to-paste prompt for Claude/Codex
- copy prompt or token only (one-time display)
- revoke to disconnect
- see last_used + created

## Entry & Ownership
- **Entry:** `js/agents-ui.js`
- **State:** transient `_lastCreatedToken`, `_lastCreatedPrompt` (closure-local, never persisted raw)
- **Tables:** `agent_grants` (id, owner_id, display_name, token_hash UNIQUE, scope='full', last_used_at, expires_at, revoked_at, created_at) — local SQLite via `server/schema.sql` + `2.0.10` local migration; Drive via `DRIVE_TABLES` + `agent_grants.json` store + `2.0.10` drive migration
- **CODEMAP:** `core[agents-ui]` — see CODEMAP.json for current loc, esc_count, i18n_count, guards

## Dependencies
- **Depends on:** `db` (proxy), `i18n` (t()), `icons` (lucideIcon + brandFileIcon for agent brand SVGs), `utils` (esc, toast, confirm action)
- **Dependents (blast radius):** `main.js` → `switchSettingsPane()` + `applyAgentsI18n()`; `index.html` settings nav/pane; `sw.js` precache

## UI / UX
- **Settings nav:** `settingsNavAgentsBtn data-pane="agents"` with `bot` icon (Lucide)
- **Pane:** `#settingsPane-agents` / `#agentsPaneContent`
- **Reused components:**
  - `.page-empty-state` for demo / no tokens
  - `.settings-data-btn` + `.sharing-group-card` for token rows
  - `.setting-group-label`, `.setting-hint` for explainer
  - `.agent-name-pill` — quick-select pills with `brandFileIcon` brand icons for known agents (Claude Code, Codex CLI, OpenClaw, Hermes, NanoClaw, Grok Bot, Cursor, Aider); click prefills display name input via `agentsPrefillName`
- **Copy UX:** textarea readonly `min-height:260px` monospace, select-on-render, two buttons: Copy setup + Copy token only
- **Demo guard:** if `localStorage.claw_cc_active_mode==='demo'` → show empty state, no token creation

## Interaction Guards
- **Create:** manual disable (`disabled=true` + `opacity:0.5`) on button until fulfilled — no `guard()` or pendingSet in agents-ui itself
- **Revoke:** via `showConfirmAction` → `executeConfirmAction` which is `guard()`'d in `main.js` (global inFlight)
- **Button contract:** `data-action="agents-create"` / `data-action="agents-revoke" data-id` / `data-action="agents-copy-prompt"` / `data-action="agents-copy-last-token"` / `data-action="agents-prefill-name"` routed via `delegation.js` default camelCase fallback (`window.agentsCreate`, etc.)

## Security
- **XSS:** see CODEMAP for current esc_count — wrap `display_name`, `id`, `created_at`, `last_used_at` in `esc()`
- **Token storage:** raw token generated client-side (32-byte `crypto.getRandomValues` hex), SHA-256 hashed via `crypto.subtle.digest`, only `token_hash` stored (UNIQUE), raw never persisted
- **No server-side validation yet:** there is no RPC and no RLS anymore. Tokens are issued, listed, and revoked through the adapter interface; the connection method that will validate them is TBD (do not point agents at the local REST server — it performs no token validation)
- **Risks:** token leak via clipboard/history — UI warns "copy once, paste privately"

## i18n
- **Prefix:** `agents.` — see CODEMAP for current key count (EN/FR/ES)
- Keys: `title`, `nav`, `description(_friendly)`, `create*`, `name_*`, `token_*`, `copy*`, `revoke*`, `no_tokens*`, `last_used`, `never_used`, `how_it_works*`, `how_to_use*`, `security_hint`, `manage_title`, `revoke_hint`
- Supabase-specific copy was rewritten post-removal: `how_it_works_body` and the setup prompt state the connection method is being reworked; no Project URL / anon key references remain
- All UI via `t()`, placeholder via `esc(t(...))`

## Business Invariants
- Raw token returned once at creation into `_lastCreatedToken` memory only; never re-displayed
- Display name not unique, token hash unique
- Revoke = `revoked_at=now()` soft delete, row kept for audit
- Token creation is backend-agnostic: single client-side path via `db.from('agent_grants').insert().select()` — no `if (backend ===)`, no RPC
- `buildAgentPrompt({displayName, token})` builds the ready-to-paste setup block; its "Connecting" section is a TBD placeholder until the connection method is decided

## Adapter & Backend
- Only via `db.from('agent_grants')` (select / insert / update) — works on local, rest, drive, offline-cache adapters
- Drive: `agent_grants` is in `DRIVE_TABLES`, persisted as `agent_grants.json`
- Local: `server/schema.sql` + `migrations/local-migrations.js` `2.0.10`
- Demo: token creation blocked in UI (no persistence)

## Cross-Feature Edges
- No Welcome aggregation
- Migration history: `1.410` created the table (Supabase parity era) → `2.0.9` dropped it (Supabase removal) → `2.0.10` restored it (agents pane kept)

## Risks / Gotchas
- Token shown once — no recovery
- Double create without guard → duplicate display_name allowed (hash unique)
- Global `guard()` on `executeDeleteConfirm` serializes revokes — add per-ID pendingSet for parity
- PWA cache: `sw.js` PRECACHE_URLS must include `js/agents-ui.js`
- Do not invent a connection method in the prompt — wiring is an explicit open decision

## Test Hooks
- `bun tests/tests.js`:
  - `All named imports resolve` (covers agents-ui.js)
  - `All lucideIcon() calls reference defined icons` — agents-ui uses `bot,check-circle,copy,key,plus,shield,info,trash-2,git-branch`
  - `No HTML entities in JS files`
  - CODEMAP freshness
- Manual: create token → copy prompt → revoke → confirm row shows revoked

## References
- `CODEMAP.json:core[agents-ui]`
- Entry: `js/agents-ui.js`, wiring: `js/main.js:switchSettingsPane()`, delegation: `js/delegation.js` (default camelCase fallback)
