# BACKENDS.md — Backend Architecture & Protocol

DeLaClaw supports four backend adapters. This document is the single source of truth for how they work, how they differ, and how to maintain them.

---

## 1. Overview

| Backend | Storage | Auth | Sync | Offline | Agent support |
|---------|---------|------|------|---------|---------------|
| **Supabase** | Postgres (cloud) | Anon key | Realtime (websocket) | IndexedDB cache | ✅ Full (REST API) |
| **Google Drive** | Single JSON file | OAuth 2.0 | None (single-device) | In-memory only | ❌ |
| **Local** | SQLite (Bun server) | None | None (single-device) | N/A (is local) | ⚠️ Possible via REST |
| **Demo** | In-memory | None | None | N/A | ❌ |

---

## 2. Adapter Contract

Every adapter must expose this interface:

```js
{
  from(table)        → QueryBuilder   // chainable: .select() .eq() .insert() .update() .delete() .order() .limit() .single()
  channel(name)      → Channel        // { .on().subscribe() } or NoopChannel
  rpc(fn, params)    → Promise<{data, error}>
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

---

## 4. Per-Backend Details

### 4.1 Supabase

**Adapter:** `js/adapters/supabase.js` (31 lines — thin pass-through to `@supabase/supabase-js`)

**Auth:** Anon key (`sb_publishable_*`) in both `apikey` and `Authorization: Bearer` headers. No user-level auth — the key grants full access scoped by RLS policies (currently open: `USING (true) WITH CHECK (true)`).

**Session:** Stateless. The anon key doesn't expire. "Stay connected" saves `{ url, key, mode }` to localStorage and auto-reconnects on reload.

**Realtime:** Supabase Realtime via `postgres_changes` websocket subscription. Requires tables to be added to the `supabase_realtime` publication (see migration `1.099_enable_realtime.sql`). Fires on INSERT/UPDATE/DELETE; the handler calls `refreshAll()` or the relevant `refresh*()` function. Edits in progress are protected by `isEditing()` guard.

**Offline:** Wrapped by `js/adapters/offline-cache.js`. On network failure, cached data from IndexedDB is returned and an "Offline — read-only" banner appears. Writes fail silently in offline mode. Cache is scoped by `{mode}:{url}` to prevent cross-backend contamination. Tables in `EXCLUDE` set (`prompts`, `nvidia_usage`) are not cached.

**Agent support:** Full. The Claw agent reads/writes tasks via the REST API using the same anon key. The heartbeat picks up `status=todo` and `status=revision` tasks, works on them, and sets `status=review`.

**Storage limits:** Supabase free tier: 500 MB database, 1 GB file storage, 2 GB bandwidth/month, 50 MB max file upload. Row count unlimited but performance degrades at scale.

**Security:** RLS enabled on all tables. Current policies are open (`USING (true)`). The anon key is visible in client JS — acceptable because DeLaClaw is a personal tool with no multi-tenant auth. The key should not be shared publicly.

**Setup:** Run `sql/supabase_schema.sql` in the Supabase SQL Editor. Enter project URL + anon key in the login form.

### 4.2 Google Drive

**Adapter:** `js/adapters/drive.js` (268 lines) — wraps the demo adapter with Drive persistence.

**Architecture:** On connect, pulls a single `delaclaw-data.json` file from a `DeLaClaw/` folder in the user's Drive. All reads/writes hit the in-memory store (instant). On mutation, a debounced write-back flushes to Drive after 2 seconds of inactivity.

**Auth:** Google OAuth 2.0 via Google Identity Services. Scope: `drive.file` (access only to files created by the app). Token stored in memory; "Stay connected" saves the client ID and triggers silent re-auth on reload (`prompt: ''`). If silent auth fails (session expired, consent revoked), credentials are cleared and the user sees the login form with "Session expired" message.

**Sync:** None. Drive is single-device — there's no mechanism to detect changes made by another device. If two devices are open, the last flush wins and the other device's in-memory state is stale until reload.

**Offline:** No offline support. If the initial Drive fetch fails, connect fails. If a flush fails mid-session, changes are lost on reload.

**Agent support:** Not supported. The agent cannot authenticate with Google OAuth.

**Storage limits:** Google Drive free tier: 15 GB shared across Gmail, Drive, and Photos. DeLaClaw's JSON file is typically < 1 MB.

**Security:** Inherits Google account security. `drive.file` scope means DeLaClaw can only access files it created — no access to the user's other Drive files.

**Setup:** Click "Connect with Google" on the login form. Authorize the app. DeLaClaw creates the folder and data file automatically.

### 4.3 Local (Bun + SQLite)

**Adapter:** `js/adapters/rest.js` (153 lines) — plain HTTP client with chainable PostgREST-like API.

**Server:** `server/server.js` — Bun-powered REST server. Serves static files and a REST API backed by SQLite. Schema applied on startup via `CREATE TABLE IF NOT EXISTS`.

**Auth:** None. No authentication or authorization. ⚠️ **The server binds to `0.0.0.0` by default**, exposing the API to the local network. Anyone on the same network can read/write all data.

**Sync:** None. Single-server, single-device.

**Offline:** N/A — the data is local. If the server process dies, the app shows connection errors.

**Agent support:** Possible in theory — the REST API is the same shape as Supabase's PostgREST. Not currently wired.

**Storage limits:** SQLite practical limit: ~281 TB. Effectively unlimited for personal use.

**Security:** No auth, no encryption at rest. Suitable for trusted local networks only. **TODO:** bind to `127.0.0.1` by default; add optional auth token.

**Setup:** `cd server && bun run server.js`. Enter `http://localhost:3737` in the login form.

### 4.4 Demo

**Adapter:** `js/adapters/demo.js` (292 lines) — full in-memory query builder with CHECK constraints.

**Architecture:** Seeded with localized sample data from `js/demo-data.js` (EN/FR/ES). All operations run against an in-memory JavaScript object. Nothing persists across page refresh.

**Auth:** None.

**Sync:** N/A.

**Offline:** N/A.

**Agent support:** N/A.

**Purpose:** Let users try DeLaClaw without connecting any backend. Also serves as the foundation for the Drive adapter's query engine.

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
- Subscribes to all data tables on connect (see `js/main.js` line ~882).
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

The Claw agent (Hatch) interacts with DeLaClaw via Supabase REST API.

### Current capabilities

- **Task pickup:** Heartbeat fetches `status=todo` and `status=revision` tasks, works on them, sets `status=review` with `hatch_response`.
- **Flashcard proposals:** Heartbeat fetches `proposal_status=pending` drafts, generates Q/A pairs, sets `proposal_status=ready`.
- **Habit `next_due`:** Heartbeat computes `next_due` for free-text frequency rules.
- **Prompts:** Reads global + per-project prompts from the `prompts` table for task context.

### Update detection (agent → app)

When the agent writes to Supabase, the Realtime subscription fires on all connected clients. The app automatically refreshes and shows the updated data. The `markLastUpdated()` call updates the "last updated" footer label.

### Update detection (app → agent)

The agent polls on heartbeat interval (~30 min). No push notification from app to agent.

### Non-Supabase limitations

Agent support is Supabase-only. The agent has no way to authenticate with Google Drive or connect to a user's local Bun server.

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
| Drive free | 15 GB shared | Single JSON file (typically < 1 MB) |
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
| Auth | Anon key | Google OAuth | None | None |
| Encryption in transit | HTTPS | HTTPS | HTTP (localhost) | N/A |
| Encryption at rest | Supabase-managed | Google-managed | None | N/A |
| Access control | RLS (open policies) | `drive.file` scope | None — **open API** | N/A |
| Key exposure | Anon key in JS | OAuth token in memory | N/A | N/A |

### Known risks

1. **Local server on `0.0.0.0`:** Exposes the full API to the local network. Should default to `127.0.0.1`.
2. **Open RLS policies:** All rows accessible to anyone with the anon key. Acceptable for single-user but blocks multi-user.
3. **No HTTPS on local:** Data travels in plaintext on localhost. Fine for `127.0.0.1`; risky if bound to a network interface.

### Hardening roadmap

- [ ] Local server: bind to `127.0.0.1` by default, optional `--host` flag
- [ ] Local server: optional bearer token auth
- [ ] Supabase: user-scoped RLS policies (when multi-user is needed)

---

## 12. Testing Strategy

### Static tests (every commit)

- **Test 31: CHECK constraint parity.** Verifies `demo.js CHECK_CONSTRAINTS` match `supabase_schema.sql` CHECK constraints. Catches drift between adapters.

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

## 13. Setup Guides

### Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Open the SQL Editor
3. Paste and run `sql/supabase_schema.sql`
4. Copy the project URL and anon key from Settings → API Keys
5. Enter them in the DeLaClaw login form
6. (Optional) Enable Realtime: run `migrations/1.099_enable_realtime.sql` for cross-device sync

### Google Drive

1. Click "Google Drive" in the backend picker
2. Click "Connect with Google"
3. Authorize with your Google account
4. DeLaClaw creates `DeLaClaw/delaclaw-data.json` automatically

### Local (Bun + SQLite)

1. Install [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
2. From the repo: `cd server && bun run server.js`
3. Enter `http://localhost:3737` in the DeLaClaw login form

### Demo

1. Click "Demo" in the backend picker
2. Choose "Sample data" or "Empty"
3. Explore — nothing is saved

---

## Appendix: Table Inventory

Tables tracked in `BACKUP_TABLES` (import order):

| Table | Purpose | FK dependencies |
|-------|---------|-----------------|
| `projects` | Project cards | — |
| `habits` | Habit definitions | — |
| `texts` | Long-form texts | — |
| `lists` | User-created lists | — |
| `todos` | TODO items | — |
| `tasks` | Project tasks | `projects.id` |
| `habit_completions` | Habit check-ins | `habits.id` |
| `flashcards` | Flashcard Q/A pairs | — |
| `flashcard_notes` | Draft flashcard proposals | — |
| `text_line_progress` | Reading progress per line | `texts.id` |
| `birthdays` | Birthday tracker | — |
| `vestiaire` | Wardrobe items | — |
| `list_items` | Items within lists | `lists.id` |
| `settings` | App settings (key/value) | — |
| `prompts` | AI prompts (global + per-project) | — |
| `nvidia_usage` | LLM API usage tracking | — |
| `daily_visits` | Daily visit log | — |
