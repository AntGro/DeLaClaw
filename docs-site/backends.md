# BACKENDS.md — Backend Architecture & Protocol

DeLaClaw supports four backend adapters. This document is the single source of truth for how they work, how they differ, and how to maintain them.

---

## 1. Overview

| Backend | Storage | Auth | Sync | Offline | Agent support |
|---------|---------|------|------|---------|---------------|
| **Supabase** | Postgres (cloud) | Anon key | Realtime (websocket) | IndexedDB cache | ✅ Full (REST API) |
| **Google Drive** | Per-table JSON files | OAuth 2.0 | 30s polling (single-user) | In-memory only | ✅ Via per-table JSON (see §8) |
| **Local** | SQLite (Bun server) | None | None (single-device) | N/A (is local) | ⚠️ Possible via REST |
| **Demo** | In-memory | None | None | N/A | ❌ |

---

## 2. Adapter Contract

Every adapter must expose this interface:

```js
{
  from(table)              → QueryBuilder   // chainable: .select() .eq() .insert() .update() .delete() .order() .limit() .single()
  channel(name)            → Channel        // { .on().subscribe() } or NoopChannel
  rpc(fn, params)          → Promise<{data, error}>
  bulkSortOrder(table, updates) → Promise   // batch-update sort_order; each adapter implements natively
}
```

### QueryBuilder return shape

All terminal methods (`.select()`, `.insert()`, `.update()`, `.delete()`, `.upsert()`) return:

```js
{ data: Array|Object|null, error: { message: string }|null }
```

### NoopChannel

Adapters without real-time support return a `NoopChannel`:

```js
{ on() { return this; }, subscribe() { return this; }, unsubscribe() { return this; } }
```

### Adding a new adapter

1. Implement the interface above
2. Add the backend option to `index.html` (picker button)
3. Wire it in `js/main.js` `connectAndInit()`
4. Add its CHECK constraints (or reuse the demo adapter — see §4)
5. Update this document's feature matrix
6. Add a CRUD smoke test (see §12)

---

## 3. Schema & Single Source of Truth

### The problem

Four adapters, three schema definitions:
- `sql/supabase_schema.sql` — Postgres DDL (Supabase)
- `server/schema.sql` — SQLite DDL (Local)
- `js/adapters/demo.js` — `CHECK_CONSTRAINTS` object (Demo + Drive)

These **must stay in sync**. The `draft` status bug (v1.105) was caused by the demo adapter missing statuses that existed in the Supabase schema.

### Rules

1. **`sql/supabase_schema.sql` is canonical.** It defines every table, column, default, CHECK constraint, index, RLS policy, and grant.
2. **`server/schema.sql`** mirrors it in SQLite syntax. When a migration adds/changes a table, update both.
3. **`js/adapters/demo.js` `CHECK_CONSTRAINTS`** must match Supabase CHECK constraints exactly. Test 31 enforces this automatically.
4. **Drive adapter** reuses the demo adapter's `DemoQueryBuilder` — no separate schema needed.

### Column defaults

| Column | Supabase | SQLite | Demo adapter |
|--------|----------|--------|--------------|
| `id` | `gen_random_uuid()` | `TEXT PRIMARY KEY` (app-generated) | `uid()` (crypto.randomUUID) |
| `created_at` | `now()` | `datetime('now')` | `new Date().toISOString()` |
| `updated_at` | `now()` | `datetime('now')` | `new Date().toISOString()` |
| `status` (tasks) | CHECK constraint | CHECK constraint | `CHECK_CONSTRAINTS` |

> **All timestamps are UTC.** Supabase `timestamptz` stores UTC internally (`now()` returns UTC). SQLite `datetime('now')` returns UTC. The demo/Drive adapter uses `new Date().toISOString()`, which is UTC by spec. Consumers comparing timestamps across backends can rely on this invariant.

---

## 4. Per-Backend Details

|  | **Supabase** | **Google Drive** | **Local (Bun + SQLite)** | **Demo** |
|---|---|---|---|---|
| **Adapter** | `supabase.js` — thin pass-through to `@supabase/supabase-js` | `drive.js` — wraps the demo adapter with per-table Drive persistence, ETag-based conflict resolution, and polling for external changes | `rest.js` — plain HTTP client with chainable PostgREST-like API | `demo.js` — full in-memory query builder with CHECK constraints |
| **Architecture** | Direct Postgres queries via Supabase JS client | Stores one JSON file per table in a `DeLaClaw/` Drive folder. Reads/writes hit in-memory store (instant). Debounced per-table write-back flushes to Drive after 2s of inactivity. Polls Drive every 30s for external changes | `server/server.js` — Bun REST server + static file server. SQLite schema applied on startup via `CREATE TABLE IF NOT EXISTS` | Seeded with localized sample data from `demo-data.js` (EN/FR/ES). All operations run against in-memory JS objects. Nothing persists across refresh |
| **Auth** | **Since 1.300: mandatory magic-link**. Anon key still in Bearer header, but RLS is `owner only` (`owner_id = auth.uid()`). `set_owner_id()` + `claim_ownership()`. Invites store `token_hash=SHA256` + `expires_at` 24h + `revoked_at` (1.301) | Google OAuth 2.0 via Google Identity Services. Scope: `drive.file` (only files created by the app). "Stay connected" triggers silent re-auth on reload (`prompt: ''`); clears credentials on failure | None. ⚠️ Server binds to `0.0.0.0` by default, exposing the API to the local network | None |
| **Session** | Auth session (access+refresh 1y) + `sync_secret` 32B (`localStorage`) encrypts `joined_groups` token+anon_key via AES-GCM (1.301) — KEK = SHA256(refresh_token) via `js/crypto-sync.js` | Token in memory. "Stay connected" saves client ID to localStorage | N/A | N/A |
| **Realtime / Sync** | `postgres_changes` websocket subscription. Fires on INSERT/UPDATE/DELETE → calls `refreshAll()` or specific `refresh*()`. Edits in progress protected by `isEditing()` guard. Requires `supabase_realtime` publication (migration `1.099`) | Polls Drive every 30s via `files.list` — re-fetches only tables whose `modifiedTime` changed. Skips locally-dirty tables. External change callback available for UI refresh. Immediate poll also fires on tab focus / `visibilitychange` → visible | None. Single-server, single-device | N/A |
| **Offline** | `offline-cache.js` wrapper. Network failure → IndexedDB cache serves reads, writes fail silently, "Offline — read-only" banner. Cache scoped by `{mode}:{url}`. Tables in `EXCLUDE` set (`prompts`, `nvidia_usage`) not cached. No write queue — changes while offline are lost | None. Initial Drive fetch failure → connect fails. Mid-session flush failure → changes lost on reload | N/A — data is local. Server process dying → connection errors | N/A |
| **Agent support** | ✅ Full. Claw agent reads/writes via REST API with same anon key. Heartbeat picks up `status=todo` / `status=revision` tasks | ✅ Agent reads/writes individual per-table JSON files via Drive API. Concurrent edits on different tables can't conflict. Same-table conflicts resolved via ETag optimistic locking (412 → merge by id, newer `updated_at` wins) | ⚠️ Possible in theory — REST API matches PostgREST shape. Not currently wired | ❌ N/A |
| **Storage limits** | Free tier: 500 MB DB, 1 GB file storage, 2 GB bandwidth/month, 50 MB max upload. Row count unlimited | Free tier: 15 GB shared across Gmail/Drive/Photos. DeLaClaw JSON typically < 1 MB | SQLite limit: ~281 TB. Effectively unlimited | N/A |
| **Security** | **1.300**: owner-only RLS (`owner_id=auth.uid()`), `trg_set_owner_id`, `claim_ownership()`, mandatory auth. **1.301**: tokens hashed (`token_hash=SHA256`), 24h expiry, `revoke_member()` revocation, RPCs check hash+expiry+revocation, `joined_groups` encrypted (AES-GCM sync_secret). Service_role rejected, Drive tokens scoped. | Inherits Google account security. `drive.file` scope → no access to user's other Drive files | No auth, no encryption at rest. Trusted local networks only. **TODO:** bind to `127.0.0.1`; add optional auth token | N/A |
| **Setup** | Run `sql/supabase_schema.sql` in SQL Editor. Enable Email provider + Magic Link, set Site URL `https://delaclaw.com` (+ `dev.delaclaw.pages.dev`, `localhost:3737`), refresh token 1y. Enter URL+anon key+magic link in app | Click "Connect with Google" → authorize → folder and data file created automatically | `cd server && bun run server.js`. Enter `http://localhost:3737` in login form | Click "Demo" on login screen, choose a sample dataset or start empty |
| **Purpose** | Primary backend for full-featured use with cross-device sync and agent integration | Simple persistent backend — no database, no API keys, just a Google account | Self-hosted option for privacy-conscious users on trusted networks | Try DeLaClaw without any backend. Also serves as the Drive adapter's query engine |

---

## 4b. Data Flow

The read/write/sync paths differ fundamentally between backends:

### Supabase — backend-first

```
WRITE (user action)
  view code ──► db.from(table).update() ──► Supabase (HTTP PATCH) ──► response
                                                 │
                                                 ▼
                                          refreshTodos() ──► re-fetch from Supabase ──► state.* ──► render

EXTERNAL CHANGE (realtime)
  Supabase Realtime ws ──► debouncedHandler (300ms) ──► refreshTodos() ──► same path
                                                         └─ cooldown guard: skips if <500ms since last refresh

SHARING (realtime + polling)
  sharing module poll ──► compare cache ──► 'sharing-changed' event ──► syncShared*() + refresh*()
```

Writes go to Supabase first; the app re-fetches after each mutation to update in-memory state.
Realtime subscriptions on item tables (`todos`, `habits`, etc.) detect changes from other
devices or sharing members. A 500ms cooldown on refresh functions deduplicates self-triggered
realtime events.

### Google Drive — local-first

```
WRITE (user action)
  view code ──► db.from(table).update() ──► in-memory store (instant) ──► render
                                                 │
                                                 ▼ (debounced, 2s)
                                          upload table JSON to Drive

EXTERNAL CHANGE (polling)
  Drive polling (30s) ──► ETag check ──► re-fetch changed tables ──► merge into memory ──► render
```

All reads and writes hit the in-memory store immediately. The Drive adapter delegates to the
demo engine for query execution. Mutations mark the table dirty; a 2-second debounce per table
uploads the JSON file to Drive. Conflict resolution uses ETags (412 → re-read, merge by
`updated_at`, retry). `forceSave()` flushes on `beforeunload` / `visibilitychange`.

### Demo — ephemeral in-memory

```
WRITE (user action)
  view code ──► db.from(table).update() ──► in-memory store (instant) ──► render

No persistence, no sync. Data resets on page reload.
```

### Local (Bun + SQLite) — backend-first

```
WRITE (user action)
  view code ──► db.from(table).update() ──► HTTP POST to localhost ──► SQLite ──► response
                                                 │
                                                 ▼
                                          refresh*() ──► re-fetch via HTTP ──► state.* ──► render

No realtime. Single-user, single-device.
```

---

## 5. Migrations

See `migrations/MIGRATION_GUIDE.md` for the full protocol. Key points:

- **Single version number** shared between app (`VERSION` file) and DB (`settings.schema_version`).
- **Migration files** named `<version>_<description>.sql` (e.g., `1.099_enable_realtime.sql`).
- **Pre-commit hook** blocks commits without a VERSION bump; auto-generates `js/version.js`.
- **Client-side check:** on Supabase connect, the app compares `schema_version` against `LATEST_COMPAT` / `LATEST_COMPAT_DEPREC` from `js/version.js`. Shows amber banner (features unavailable) or red banner (app may break).

### Dev / prod workflow

| Branch | Deploys to | Supabase instance |
|--------|------------|-------------------|
| `dev` | `dev.delaclaw.pages.dev` | Dev project (testing) |
| `main` | `delaclaw.com` | Production |

1. Write migration on feature branch
2. Test against dev Supabase
3. Merge to `dev`, verify on preview
4. Merge to `main`, run migration on prod
5. Fold migration into `sql/supabase_schema.sql`

### Non-Supabase backends

- **Local:** `server/schema.sql` uses `CREATE TABLE IF NOT EXISTS` — new columns require a migration or DB reset. Auto-migration on server start is possible but not implemented.
- **Drive / Demo:** Schema is implicit (in-memory objects). New columns just appear as `undefined` in old data — the app should handle missing fields gracefully.

---

## 6. Offline Behavior

### Supabase (with offline cache)

| State | Reads | Writes | UI |
|-------|-------|--------|-----|
| Online | Live from Postgres | Live | Normal |
| Offline | From IndexedDB cache | Fail silently | "Offline — read-only" banner, last synced timestamp |
| Back online | Auto-retry on next `select()` | Resume | Banner dismissed |

The cache stores every successful `select()` response keyed by table name. Scoped by `{mode}:{url}`. Tables in `EXCLUDE` set are never cached.

**Limitation:** There is no write queue. Changes made while offline are lost. The app becomes read-only.

### Google Drive

No offline support. If the network drops mid-session, in-memory state is preserved until the tab closes, but flushes to Drive will fail.

### Local

N/A — the server and client are on the same machine (or local network).

### Demo

N/A — everything is in-memory.

### Future consideration

A write queue (store pending writes in IndexedDB, replay on reconnect) would make Supabase and Drive usable in flaky-network scenarios. This is the most impactful offline improvement.

---

## 7. Cross-Device Sync

### Supabase: Realtime

- Uses Supabase Realtime `postgres_changes` websocket channel.
- Subscribes to all data tables on connect (see `js/main.js` realtime setup).
- On change: calls `refreshAll()` or the specific `refresh*()` function.
- **Edit guard:** `isEditing()` prevents incoming changes from clobbering an active inline edit.
- **Requirement:** Tables must be in the `supabase_realtime` publication. Migration `1.099` adds them.

### Other backends

No cross-device sync. Drive, Local, and Demo are effectively single-device.

### Conflict resolution

**Current strategy:** Last write wins. There is no conflict detection or merge logic.

**Risk areas:**
- **Task reordering:** Two devices reorder the same project's tasks → sort_order values conflict.
- **Concurrent edits:** Two devices edit the same task text → last save overwrites.
- **Settings:** Two devices change the same setting → last write wins.

**Mitigation (future):** For critical operations, a `version` or `updated_at` column could enable optimistic locking (reject writes where the row has changed since it was read).

---

## 8. Agent Integration (Claw)

The Claw agent interacts with DeLaClaw via Supabase REST API.

### Current capabilities

- **Task pickup:** Heartbeat fetches `status=todo` and `status=revision` tasks, works on them, sets `status=review` with `hatch_response`.
- **Flashcard proposals:** Heartbeat fetches `proposal_status=pending` drafts, generates Q/A pairs, sets `proposal_status=ready`.
- **Habit `next_due`:** Heartbeat computes `next_due` for free-text frequency rules.
- **Prompts:** Reads global + per-project prompts from the `prompts` table for task context.

### Update detection (agent → app)

When the agent writes to Supabase, the Realtime subscription fires on all connected clients. The app automatically refreshes and shows the updated data. The `markLastUpdated()` call updates the "last updated" footer label.

### Update detection (app → agent)

The agent polls on heartbeat interval (~30 min). No push notification from app to agent.

### Other backends

**Google Drive:** The agent accesses individual per-table JSON files in the `DeLaClaw/` Drive folder via the Google Drive API (OAuth via Drive `drive.file` scope).
- **Per-table granularity** — the agent reads/writes only the table it needs (e.g., `tasks.json`), without touching others.
- **ETag-based conflict resolution** — writes include an `If-Match` header. If the app flushed the same table since the agent's read, the write fails with 412 and the agent re-reads, merges (newer `updated_at` wins per record), and retries.
- **Polling for changes** — the app polls Drive every 30s and re-fetches tables whose `modifiedTime` changed, so agent edits show up without a full reload.

**Local:** The agent could in theory hit the REST API (same shape as Supabase PostgREST), but has no way to reach the user's local server unless it's exposed via a tunnel.

**Demo:** N/A — ephemeral in-memory data.

---

## 9. Storage & Quotas

### Reporting

**Current:** No storage reporting in the app.

**Planned:** A "Storage" section in Settings showing:
- Row count per table
- Estimated total size
- Backend-specific limits and usage percentage

### Limits by backend

| Backend | Limit | What counts |
|---------|-------|-------------|
| Supabase free | 500 MB database | All tables + indexes |
| Drive free | 15 GB shared | Per-table JSON files (typically < 1 MB total) |
| Local SQLite | Disk space | Single `.db` file |
| Demo | Browser memory | Ephemeral |

### Quota alerts (future)

For Supabase: query `pg_database_size()` via RPC and warn at 80% capacity.

---

## 10. Backup & Restore

### Export

`generateBackupJSON()` in `js/main.js` reads all tables in `BACKUP_TABLES` order and produces a JSON file:

```json
{
  "_meta": { "version": 1, "exported_at": "...", "tables": [...] },
  "projects": [...],
  "tasks": [...],
  ...
}
```

**Export options:**
- **Download:** Browser download as `.json` file.
- **Push to Drive:** Available when connected to Drive backend. Saves backup as a separate file in the `DeLaClaw/` folder.

### Import

`importBackupJSON()` reads a backup file and upserts all rows into the current backend. Import order follows `BACKUP_TABLES` (parent tables first for FK integrity).

### Backend migration (data portability)

To move data between backends:
1. Connect to source backend
2. Export backup JSON
3. Connect to target backend (fresh schema)
4. Import backup JSON

**Limitation:** Backend-specific features don't transfer (Realtime subscriptions, RLS policies, agent task workflow). Only data moves.

### Automated backups (future)

Options:
- **Scheduled export:** Cron job that runs `generateBackupJSON()` and pushes to Drive/S3/local disk.
- **Supabase native:** Point-in-time recovery is available on Supabase Pro plan.

---

## 11. Security Model

| Aspect | Supabase | Drive | Local | Demo |
|--------|----------|-------|-------|------|
| Auth | **Since 1.300**: magic-link mandatory (`auth.uid()`), anon key in Bearer header but worthless without session | Google OAuth | None | None |
| Encryption in transit | HTTPS | HTTPS | HTTP (localhost) | N/A |
| Encryption at rest | Supabase-managed + client-side AES-GCM for `joined_groups` (sync_secret, KEK=SHA256(refresh_token)) since 1.301 | Google-managed | None | N/A |
| Access control | **Owner-only RLS** `owner_id=auth.uid()` (1.300) on all personal tables + `joined_groups`; Sharing RPCs check `token_hash`+expiry+revocation (1.301) | `drive.file` scope | None — **open API** | N/A |
| Invite token storage | `token_hash=SHA256` + 24h expiry + `revoked_at` (1.301). Plaintext `token` column kept for compat but not used for lookups | N/A | N/A | N/A |
| Key exposure | Anon key in invite envelope `{u,k,g,t}` — now safe because RLS requires auth.uid() | OAuth token in memory + scoped by clientId + dedup promise | N/A | N/A |

### Known risks

1. **Local server on `0.0.0.0`:** Exposes the full API to the local network. Should default to `127.0.0.1`.
2. **No HTTPS on local:** Data travels in plaintext on localhost. Fine for `127.0.0.1`; risky if bound to a network interface.
3. **Drive token scope:** mitigated — tokens scoped by clientId and dedup promise since sec-003.

### Hardening roadmap

- [x] Supabase: owner-only RLS (1.300) + hashed invites + encrypted joined_groups (1.301)
- [ ] Local server: bind to `127.0.0.1` by default, optional `--host` flag
- [ ] Local server: optional bearer token auth
- [ ] Supabase: user-scoped RLS policies (when multi-user is needed)

---

## 12. Testing Strategy

### Static tests (every commit)

- **CHECK constraint parity test.** Verifies `demo.js CHECK_CONSTRAINTS` match `supabase_schema.sql` CHECK constraints. Catches drift between adapters.

### Integration tests (Playwright + local Bun server)

- **Archive + delete flow:** Creates projects, archives one, deletes it, verifies remaining cards render.
- **TODO priority flow:** Tests priority levels across the full lifecycle.
- **Flashcard import flow:** Tests import with existing/new decks, zero-deck edge case.

### Missing test coverage

- [ ] **CRUD smoke test per adapter:** Insert, select, update, delete across all four adapters. Currently only tested implicitly through the local Bun server.
- [ ] **Realtime subscription test:** Verify that a write on one client triggers a refresh on another. Requires two browser contexts + Supabase.
- [ ] **Offline cache test:** Simulate network failure, verify cached data is returned, verify write fails gracefully.
- [ ] **Drive flush test:** Verify debounced write-back to Drive after mutation.
- [ ] **Schema parity test for SQLite:** Extend test 31 to also verify `server/schema.sql` matches Supabase schema (table names, column names, CHECK constraints).

---

## 13. Setup

See the [Setup Guide](setup.md) for step-by-step instructions for each backend.

---

## Appendix: Table Inventory

Tables tracked in `BACKUP_TABLES` (import order):

| Table | Purpose | FK dependencies |
|-------|---------|-----------------|
| `todo_categories` | TODO category containers | — |
| `habit_categories` | Habit category containers | — |
| `vestiaire_categories` | Wardrobe category containers | — |
| `flashcard_decks` | Flashcard deck containers | — |
| `projects` | Project cards | — |
| `habits` | Habit definitions | — |
| `texts` | Long-form texts | — |
| `lists` | User-created lists | — |
| `todos` | TODO items | `todo_categories.id` |
| `tasks` | Project tasks | `projects.id` |
| `habit_completions` | Habit check-ins | `habits.id` |
| `flashcards` | Flashcard Q/A pairs | `flashcard_decks.id` |
| `flashcard_notes` | Draft flashcard proposals | — |
| `text_line_progress` | Reading progress per line | `texts.id` |
| `birthdays` | Birthday tracker | — |
| `vestiaire` | Wardrobe items | `vestiaire_categories.id` |
| `list_items` | Items within lists | `lists.id` |
| `settings` | App settings (key/value) | — |
| `prompts` | AI prompts (global + per-project) | — |
| `nvidia_usage` | LLM API usage tracking | — |
| `daily_visits` | Daily visit log | — |
| `sharing_groups` | Shared group definitions | — |
| `sharing_members` | Group membership | `sharing_groups.id` |
| `sharing_items` | Shared items (TODOs, habits, list items) | `sharing_groups.id` |
| `joined_groups` | Groups the user has joined | — |
| `agent_grants` | AI agent permission grants | — |
