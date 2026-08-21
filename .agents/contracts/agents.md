# Agents — Feature Contract

## Purpose
Allow external AI agents (Claude Code, Codex CLI, OpenClaw…) to access user's DeLaClaw data via Supabase REST + `X-Agent-Token` header. Multi-token, hashed-at-rest, revocable, scoped to owner.

User jobs:
- create named agent token → get ready-to-paste prompt for Claude/Codex
- copy prompt or token only (one-time display)
- revoke to disconnect
- see last_used + created

## Entry & Ownership
- **Entry:** `js/agents-ui.js`
- **State:** transient `_lastCreatedToken`, `_lastCreatedPrompt` (closure-local, never persisted raw)
- **Tables:** `agent_grants` (id UUID PK, owner_id, display_name, token_hash UNIQUE, scope='full', last_used_at, expires_at, revoked_at, created_at)
- **CODEMAP:** `core[agents-ui]` — see CODEMAP.json for current loc, esc_count, i18n_count, guards

## Dependencies
- **Depends on:** `db` (proxy), `i18n` (t()), `icons` (lucideIcon + brandFileIcon for agent brand SVGs), `state` (STAY_CONNECTED_KEY), `utils` (esc, toast, delete confirm)
- **Dependents (blast radius):** `main.js` → `switchSettingsPane()` + delegation fallback; editing RLS affects 18 personal tables

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
- **Revoke:** via `showDeleteConfirm` → `executeDeleteConfirm` which is `guard()`'d in `main.js` (global inFlight)
- **Button contract:** `data-action="agents-create"` / `data-action="agents-revoke" data-id` routed via `delegation.js`

## Security
- **XSS:** see CODEMAP for current esc_count — wrap `display_name`, `id`, `created_at`, `last_used_at`, `creds.url/key` slice in `esc()`
- **Token storage:** `token_hash = encode(digest(token::text,'sha256'::text),'hex')` UNIQUE, raw never stored. Client generates 32-byte `crypto.getRandomValues` hex if RPC unavailable, hashed via `crypto.subtle.digest('SHA-256')`
- **RLS:**
  - `agent_grants`: `owner only` — `FOR ALL USING owner_id=auth.uid() WITH CHECK owner_id=auth.uid()`
  - 18 personal tables: `owner or agent` → `owner_id=auth.uid() OR has_agent_access(owner_id)`
- **has_agent_access(target_owner UUID):** SECURITY DEFINER, `SET search_path=public,extensions`, reads `current_setting('request.headers',true)::jsonb` → `x-agent-token` fallback `X-Agent-Token` / `x-api-token`, checks `token_hash=h AND revoked_at IS NULL AND (expires_at IS NULL OR > now())`, throttled `last_used_at` update `now() - 5 min`
- **Headers:** must send `apikey: ANON_KEY` + `Authorization: Bearer ANON_KEY` + `X-Agent-Token: YOUR_TOKEN`
- **Risks:** token leak via clipboard/history, edge logs may capture header — docs warn "copy once, paste privately"

## i18n
- **Prefix:** `agents.` — see CODEMAP for current key count (EN/FR/ES)
- Keys: `title`, `nav`, `description_friendly`, `create_title`, `create_hint_friendly`, `name_placeholder`, `token_created_for`, `copy_prompt_hint`, `how_it_works_body`, `missing_creds_hint`
- All UI via `t()`, placeholder via `esc(t(...))`

## Business Invariants
- Raw token returned once via RPC `create_agent_grant(p_display_name, p_scope)` → `TABLE(id,token,display_name,scope,created_at)`; client stores in `_lastCreatedToken` memory only
- Display name not unique, token hash unique
- Revoke = `revoked_at=now()` soft delete, row kept for audit
- Last used throttled 5 min to avoid write amplification
- Creds for prompt pulled from `STAY_CONNECTED_KEY` localStorage (url + anon key); masked display `first20…last6`

## Adapter & Backend
- Only via `db.from('agent_grants')` + `db.rpc('create_agent_grant'/'revoke_agent_grant')`
- No `if (backend ===)` — fallback: try RPC, catch → client hash + direct insert
- Local: `server/schema.sql` + `local-migrations.js` + `drive-migrations.js` + `supabase-migrations.js` embed same DDL + `set_owner_id()` trigger
- Offline-cache wraps transparently

## Cross-Feature Edges
- No Welcome aggregation, but agent edits to todos/habits/projects → verify Welcome re-renders via `state.all*`
- Migration: `1.410_agent_grants.sql` (consolidated into `1.484_sharing_ownership_categories.sql`)

## Risks / Gotchas
- Token shown once — no recovery
- Double create without guard → duplicate display_name allowed (hash unique)
- Global `guard()` on `executeDeleteConfirm` serializes revokes — add per-ID pendingSet for parity
- PWA cache: `sw.js` PRECACHE_URLS must include `js/agents-ui.js`

## Test Hooks
- `bun tests/tests.js`:
  - `All named imports resolve`
  - `All lucideIcon() calls reference defined icons` — checks `bot,key,terminal,code-2`
  - `No HTML entities in JS files`
  - CODEMAP freshness
- Manual: create grant → copy prompt → `curl $URL/rest/v1/tasks?select=* -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "X-Agent-Token: $TOKEN"`

## References
- `CODEMAP.json:core[agents-ui]`
- Migration: `migrations/1.410_agent_grants.sql`
- Entry: `js/agents-ui.js`, wiring: `js/main.js:switchSettingsPane()`, delegation: `js/delegation.js`
