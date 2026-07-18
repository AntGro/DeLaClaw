# Architecture

DeLaClaw is a single-page application with no build step. The browser loads vanilla JavaScript ES modules directly. All state lives in memory at runtime, backed by a pluggable database adapter.

## High-level overview

```
Browser
  |
  index.html ── loads ── js/main.js (bootstrap)
  |                         |
  style.css               js/supabase.js (shared state)
  |                         |
  sw.js (service worker)  js/db.js (adapter abstraction)
                            |
            ┌───────────┬───┼───────────┬───────────────┐
            |           |   |           |               |
    adapters/       adapters/   adapters/       adapters/
    supabase.js     rest.js     demo.js         drive.js
            |           |       |               |
    (Supabase)   (Bun+SQLite) (in-memory) (in-memory + Drive)
            |
    adapters/offline-cache.js (wraps any adapter)
```

## Adapter pattern

The app never talks to a backend directly. All database access goes through `db.js`, which delegates to the active adapter.

### db.js

A thin abstraction exposing three methods:

- `db.from(table)` -- returns a chainable query builder (select/insert/update/delete)
- `db.channel(name)` -- real-time subscriptions (Supabase only)
- `db.rpc(fn, params)` -- remote procedure calls

Every call to `db.from()` wraps the result in a `tracked()` Proxy. This Proxy intercepts `.then()` to drive the activity indicator: the header logo spins while a query is in flight, and flashes red on error.

### Adapters

Each adapter implements the same interface:

| Method | Supabase | REST | Demo |
|---|---|---|---|
| `from(table)` | Supabase PostgREST builder | HTTP `QueryBuilder` class | In-memory array filter |
| `channel(name)` | Supabase Realtime | No-op | No-op |
| `rpc(fn, params)` | Supabase RPC | HTTP POST | No-op |

The chainable query builder supports: `.select()`, `.insert()`, `.update()`, `.delete()`, `.upsert()`, `.eq()`, `.neq()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.is()`, `.order()`, `.limit()`, `.single()`.

All adapters return `{ data, error }` objects. Successful queries return `{ data: [...], error: null }`.

### Google Drive adapter (drive.js)

Combines the demo adapter's in-memory query engine with Google Drive persistence. On connect, it authenticates via Google Identity Services (`drive.file` scope), finds or creates a `DeLaClaw/` folder, and downloads `delaclaw-data.json` into memory. All runtime queries hit the in-memory store (instant). On any mutation, a 2-second debounced write-back uploads the full store to Drive as a single JSON file. The adapter exposes `forceSave()` for explicit flushes (called on disconnect and `beforeunload`), and `reseed()` for backup imports.

### Offline cache (offline-cache.js)

A transparent wrapper that can be applied to any adapter. It intercepts `adapter.from()` with a Proxy and:

1. On successful `.select()`: stores the result rows in IndexedDB, keyed by `scope:table`
2. On network failure: returns the cached rows and sets `state.offlineMode = true`
3. Uses `navigator.onLine` for fast-path detection and a 4-second timeout as a fallback

Cache details:
- Scoped by backend mode and URL (e.g. `supabase:<project-ref>`)
- 14 of 16 tables cached automatically; `prompts` and `nvidia_usage` are excluded
- `birthdays.avatar_url` is stripped from cache (base64 images, 30-80 KB each)
- New tables are included without code changes (exclusion list, not inclusion list)

## State management

All shared state lives in `js/supabase.js` as a single exported `state` object:

```javascript
const state = {
  db,                        // db.js abstraction
  PROJECTS: [],              // project objects
  allTasks: [],              // task objects
  allHabits: [],             // habit objects
  allHabitCompletions: [],   // habit completion records
  allBirthdays: [],          // birthday objects
  allVestiaire: [],          // wardrobe items
  allLists: [],              // list objects
  allListItems: [],          // list item objects
  currentView: 'projects',   // active tab
  offlineMode: false,         // true when serving cached data
  dbSchemaVersion: '0.000',   // from settings table
  // ...
};
```

On login, all data is fetched sequentially (`refreshAll`, `refreshTodos`, `refreshHabits`, etc.) and stored in these arrays. Each module reads from and writes to the arrays, then calls its `render*()` function to update the DOM.

There is no virtual DOM, no reactivity system, and no framework state management. Each module owns its render function and re-renders its view in full when data changes.

## Database schema

16 tables, all with the same structure across SQLite and PostgreSQL:

| Table | Purpose | Key relationships |
|---|---|---|
| `projects` | Project metadata (name, color, links, sort order) | -- |
| `tasks` | Tasks within projects | `project` -> `projects.id` |
| `todos` | Standalone TODOs with priority and due dates | -- |
| `habits` | Habit definitions with scheduling rules | -- |
| `habit_completions` | Completion log for habits | `habit_id` -> `habits.id` |
| `flashcards` | SRS flashcards with FSRS scheduling data | -- |
| `flashcard_notes` | Draft notes with AI proposal workflow | -- |
| `texts` | Full texts for memorization (chunked) | -- |
| `text_line_progress` | Per-chunk SRS progress for texts | `text_id` -> `texts.id` |
| `birthdays` | Birthday records with optional avatars | -- |
| `vestiaire` | Wardrobe inventory | -- |
| `lists` | Checklist containers | -- |
| `list_items` | Items within lists | `list_id` -> `lists.id` |
| `settings` | Key-value store (schema version, preferences) | -- |
| `prompts` | AI prompt templates | -- |
| `nvidia_usage` | API token usage tracking | -- |

CHECK constraints are enforced at the database level:
- `tasks.status`: `todo`, `in-progress`, `review`, `approved`, `revision`
- `todos.priority`: `urgent`, `high`, `medium`, `low`, `normal`
- `flashcard_notes.proposal_status`: `pending`, `ready`, `accepted`, `rejected`

The demo adapter mirrors these constraints in JavaScript.

## Security model (Supabase backend)

### Threat: anon key in invite links

Invite links are envelope `base64url JSON {v:1,b:'supabase',u,k,g,t}` containing `u=project URL`, `k=anon key`, `g=group_id`, `t=join token`. This envelope leaks `u+k` to any recipient. Requirement: **B must NOT read A's private tables even with A’s anon key**.

### Defense: owner-only RLS (1.300)

Since `1.300`, all personal tables have `owner_id UUID REFERENCES auth.users` and policy:

```sql
FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())
```

Trigger `trg_set_owner_id` (`set_owner_id()` SECURITY DEFINER) forces `NEW.owner_id := auth.uid()` on INSERT if NULL. No anon read/write is possible. `claim_ownership()` backfills legacy NULL rows on first login. Login requires magic link (`auth.js` `initAuth()` always `isNewAuth:true`), no anonymous skip.

### Defense: hashed invite tokens + expiry + revocation (1.301)

`sharing_members` no longer looked up by plaintext `token`:

- `token_hash TEXT = encode(digest(token,'sha256'),'hex')` — unique index
- `expires_at TIMESTAMPTZ` — pending invites expire after 24h
- `revoked_at TIMESTAMPTZ` — `revoke_member(p_group_id,p_member_id)` sets this, member is excluded from all checks

All sharing RPCs (`verify_join_token`, `confirm_join`, `get_shared_items`, `add_shared_item`, `update_shared_item`, `delete_shared_item`, `get_group_members`, `leave_group`) now:

```sql
WHERE token_hash = encode(digest(p_token,'sha256'),'hex')
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND joined_at IS NOT NULL -- where applicable
```

### Defense: encrypted joined_groups (1.301)

The joiner's local `joined_groups` table previously stored `token` and `remote_anon_key` plaintext, readable if their own DB is exfiltrated. Since 1.301 it stores:

- `token_ciphertext`, `token_iv`
- `remote_anon_key_ciphertext`, `remote_anon_key_iv`

Encrypted with WebCrypto AES-GCM 256 using a per-user `sync_secret` (32 random bytes, `localStorage.claw_sync_secret`). `js/crypto-sync.js` provides `getOrCreateSyncSecret()`, `encryptText()`, `decryptText()`, `hashTokenClient()`, `getKEK()` (= `SHA-256(refresh_token)`) and `storeWrappedSecret()` for KEK-wrapped backup. Code falls back to plaintext columns if decryption fails (migration compatibility).

Flow: `createGroup`/`inviteUser` → generate token + hash + expiry → store hash; `joinWithFileIds`/`tryDirectJoin` → `encryptForJoined(token, anonKey)` → upsert ciphertexts + plaintext fallback; `loadAll` → `decryptJoinedRow()` prefers decryption.

### iOS PWA auth + OTP code (1.371+)

Supabase magic links break on iOS PWA: Gmail/Outlook opens links in Chrome (or Safari), not the standalone PWA's WebKit context. Chrome's localStorage is isolated, so `supabase-js` would create the session in Chrome and the PWA would still be signed out.

Since `1.371`, `auth.js` exposes:

- `sendMagicLink()` — still sends a link ( `ConfirmationURL` ), but docs require template to also include `{{ .Token }}` 6-digit code.
- `verifyOtpCode(email, token)` → `auth.verifyOtp({ email, token, type: 'email' })` — verifies the code **inside the PWA** so the session stays in the PWA's storage.
- `main.js` auth prompt now shows OTP box after sending: input `type=text inputmode=numeric autocomplete=one-time-code` + Verify button, with i18n hints `otp_hint`, `link_hint`, etc. On iPhone, user copies code from Mail/Gmail and pastes in PWA.

This is the recommended path for any PWA that can be opened from an external mail app.

### Defense: CSP + credential stripping

- `style-src` keeps `unsafe-inline` for `style=` attrs, `script-src` is nonce/sha256 only since v1.350 (no `unsafe-inline`).
- `main.js` `saveStayConnectedCreds()` strips anon key for local/demo/drive, rejects `service_role` keys.
- `drive.js` tokens scoped by `clientId`, dedup pending promise.

## Service worker

`sw.js` implements a **network-first** strategy for all requests:

1. Try the network
2. On success: cache the response and serve it
3. On failure: serve from the SW precache

The precache (`PRECACHE_URLS`) includes all static assets. The `CACHE_VERSION` string is updated automatically by the pre-commit hook from the `VERSION` file (format: `dlc-X.YYY`).

On install, the SW calls `skipWaiting()`. On activate, it purges old caches and calls `clients.claim()`. The page listens for `controllerchange` events and reloads automatically when a new SW takes over.

## Version management

The `VERSION` file at the repo root is the single source of truth:

```
latest=1.016
latest_compat=1.000
latest_compat_deprec=1.000
```

The pre-commit hook (`.githooks/pre-commit`):
1. Verifies `VERSION` is staged and `latest` has increased
2. Validates the `latest_compat_deprec <= latest_compat <= latest` invariant
3. Regenerates `js/version.js` with exported constants
4. Updates `CACHE_VERSION` in `sw.js`
5. Stages both generated files

Schema version is stored in the `settings` table (`key = 'schema_version'`). The app compares it against `latest_compat` and `latest_compat_deprec` at startup, showing a warning banner if the database is behind.

## File structure

```
index.html                 Single-page shell (login gate + all views)
style.css                  All styles (dark + light themes, responsive)
sw.js                      Service worker
manifest.json              PWA manifest
VERSION                    Version source of truth
CNAME                      GitHub Pages custom domain

js/
  main.js                  Bootstrap, view switching, settings, login, footer
  supabase.js              Shared state object
  db.js                    Adapter abstraction with activity tracking
  version.js               Auto-generated version constants
  adapters/
    supabase.js            Supabase PostgREST adapter
    rest.js                Local Bun+SQLite REST adapter
    demo.js                In-memory adapter
    drive.js               Google Drive adapter (in-memory + Drive JSON persistence)
    offline-cache.js       IndexedDB caching layer
  welcome.js               Today dashboard
  projects.js              Project boards + task management
  todos.js                 TODO management
  habits.js                Habit tracking
  flashcards.js            Flashcard SRS + text memorization
  birthdays.js             Birthday tracker
  vestiaire.js             Wardrobe inventory
  lists.js                 Checklists
  i18n.js                  Translation strings (en/fr/es)
  icons.js                 Lucide icon rendering + path data
  utils.js                 Shared utilities (escaping, toasts, markdown)
  item-utils.js            Drag-and-drop, inline editing, hover actions
  hero.js                  Landing page animations
  logo.js                  Logo animation engine
  storm3d.js               Three.js hero particle effect
  demo-chooser.js          Demo dataset selector UI
  demo-data.js             Sample data for demo mode

server/
  server.js                Bun HTTP server (PostgREST-compatible API)
  schema.sql               SQLite schema (16 tables)

migrations/                Incremental SQL migrations (001-007)
tests/
  tests.js                 54 tests (unit + adapter + integration + e2e)
.githooks/
  pre-commit               VERSION enforcement + code generation
```

## Internationalization

`js/i18n.js` exports a `t(key)` function that returns the translated string for the active language. All UI text goes through `t()`. Currently supported: English, French, Spanish.

Language is stored in `localStorage` and can be changed in Settings. The `t()` function falls back to English if a key is missing in the active language.

## Drag-and-drop

`js/item-utils.js` provides reusable drag-and-drop reordering. Items are repositioned via `sort_order` updates. The implementation uses native HTML drag events with custom styling during the drag operation.
