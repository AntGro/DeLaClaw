# Architecture

DeLaClaw is a single-page application with no build step. The browser loads vanilla JavaScript ES modules directly. All state lives in memory at runtime, backed by a pluggable database adapter.

## High-level overview

```
Browser
  |
  index.html ── loads ── js/main.js (bootstrap)
  |                         |
  style.css               js/state.js (shared state)
  |                         |
  sw.js (service worker)  js/db.js (adapter abstraction)
                            |
            ┌───────────┬───┼───────────┬───────────────┐
            |           |   |           |               |
    adapters/       adapters/   adapters/       adapters/
    supabase.js     rest.js     demo.js         drive.js
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

| Method | Supabase | REST | Demo | Drive |
|---|---|---|---|---|
| `from(table)` | Supabase PostgREST builder | HTTP `QueryBuilder` class | In-memory array filter | In-memory (delegates to demo engine) |
| `channel(name)` | Supabase Realtime | No-op | No-op | No-op |
| `rpc(fn, params)` | Supabase RPC | HTTP POST | No-op | No-op |
| `bulkSortOrder(table, updates)` | RPC `bulk_sort_order` | Individual PATCHes | In-memory store mutation | Delegates to demo + schedules Drive save |

The chainable query builder supports: `.select()`, `.insert()`, `.update()`, `.delete()`, `.upsert()`, `.eq()`, `.neq()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.is()`, `.order()`, `.limit()`, `.single()`.

All adapters return `{ data, error }` objects. Successful queries return `{ data: [...], error: null }`.

### Google Drive adapter (drive.js)

Combines the demo adapter's in-memory query engine with Google Drive persistence. On connect, it authenticates via Google Identity Services (`drive.file` scope), finds or creates a `DeLaClaw/` folder, and loads per-table JSON files (e.g. `todos.json`, `habits.json`) into memory. All runtime queries hit the in-memory store (instant). On any mutation, a 2-second debounced write-back uploads the changed table to Drive as its own JSON file. The adapter exposes `forceSave()` for explicit flushes (called on `beforeunload` and `visibilitychange` → hidden), and `reseed()` for backup imports. A 30-second polling loop checks Drive for external changes; an immediate poll also fires on tab switch (`visibilitychange` → visible) and window focus. Legacy single-file stores (`delaclaw-data.json`) are automatically migrated to per-table files on first connect.

### Offline cache (offline-cache.js)

A transparent wrapper that can be applied to any adapter. It intercepts `adapter.from()` with a Proxy and:

1. On successful `.select()`: stores the result rows in IndexedDB, keyed by `scope:table`
2. On network failure: returns the cached rows and sets `state.offlineMode = true`
3. Uses `navigator.onLine` for fast-path detection and a 4-second timeout as a fallback

Cache details:
- Scoped by backend mode and URL (e.g. `supabase:<project-ref>`)
- All tables cached automatically; `prompts` and `nvidia_usage` are excluded
- `birthdays.avatar_url` is stripped from cache (base64 images, 30-80 KB each)
- New tables are included without code changes (exclusion list, not inclusion list)

## Data flow by backend

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

## State management

All shared state lives in `js/state.js` as a single exported `state` object:

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
  pausedMode: false,          // true when sync is paused
  dbSchemaVersion: '0.000',   // from settings table
  sharing: null,              // sharing adapter instance
  authUser: null,             // authenticated user object
  tabVisibility: null,        // {key: bool} from settings DB
  tabOrder: null,             // [key, …] from settings DB
  archivedProjectIds: [],     // [id, …] from settings DB
  showArchived: false,        // bool from settings DB
  // ...
};
```

On login, all data is fetched sequentially (`refreshAll`, `refreshTodos`, `refreshHabits`, etc.) and stored in these arrays. Each module reads from and writes to the arrays, then calls its `render*()` function to update the DOM.

There is no virtual DOM, no reactivity system, and no framework state management. Each module owns its render function and re-renders its view in full when data changes.

## Database schema

The canonical table list lives in `server/schema.sql` (Local SQLite base schema) and `migrations/1.484_sharing_ownership_categories.sql` (Supabase-only tables). Supabase has all local tables plus sharing and auth-guard tables.

| Table | Purpose | Key relationships | Backend |
|---|---|---|---|
| `projects` | Project metadata (name, color, links, sort order) | -- | All |
| `tasks` | Tasks within projects | `project` -> `projects.id` | All |
| `todos` | Standalone TODOs with priority and due dates | `category_id` -> `todo_categories.id` | All |
| `todo_categories` | TODO category containers | -- | All |
| `habits` | Habit definitions with scheduling rules | `category_id` -> `habit_categories.id` | All |
| `habit_categories` | Habit category containers | -- | All |
| `habit_completions` | Completion log for habits | `habit_id` -> `habits.id` | All |
| `flashcards` | SRS flashcards with FSRS scheduling data | `deck_id` -> `flashcard_decks.id` | All |
| `flashcard_decks` | Flashcard deck containers | -- | All |
| `flashcard_notes` | Draft notes with AI proposal workflow | -- | All |
| `texts` | Full texts for memorization (chunked) | -- | All |
| `text_line_progress` | Per-chunk SRS progress for texts | `text_id` -> `texts.id` | All |
| `birthdays` | Birthday records with optional avatars | -- | All |
| `vestiaire` | Wardrobe inventory | `category_id` -> `vestiaire_categories.id` | All |
| `vestiaire_categories` | Wardrobe category containers | -- | All |
| `lists` | Checklist containers | -- | All |
| `list_items` | Items within lists | `list_id` -> `lists.id` | All |
| `settings` | Key-value store (schema version, preferences) | -- | All |
| `prompts` | AI prompt templates | -- | All |
| `nvidia_usage` | API token usage tracking | -- | All |
| `daily_visits` | Login/visit tracking | -- | All |
| `joined_groups` | Groups the user has joined (encrypted tokens) | -- | All |
| `agent_grants` | AI agent permission grants | -- | All |
| `sharing_groups` | Shared group definitions | -- | Supabase only |
| `sharing_members` | Group membership with hashed invite tokens | `group_id` -> `sharing_groups.id` | Supabase only |
| `sharing_items` | Shared items (TODOs, habits, list items) | `group_id` -> `sharing_groups.id` | Supabase only |
| `auth_email_guard` | Single-owner email lock (see Security) | -- | Supabase only |

### Category integrity

Each category/deck table has one protected default row (`name=''`, `is_protected=1`). A `protect_category_row()` trigger prevents DELETE/UPDATE on protected rows. Item foreign keys (`category_id` / `deck_id`) use **CASCADE** on delete — deleting a user-created category deletes all its items. App-level sharing cleanup runs before CASCADE to propagate shared-item deletion to group members.

### CHECK constraints

CHECK constraints are enforced at the database level:
- `tasks.status`: `todo`, `in-progress`, `review`, `approved`, `revision`
- `todos.priority`: `urgent`, `high`, `medium`, `low`, `normal`
- `flashcard_notes.proposal_status`: `pending`, `ready`, `accepted`, `rejected`

The demo adapter mirrors these constraints in JavaScript.

## Security model (Supabase backend)

### Threat: anon key in invite codes

Invite codes are opaque strings with a `DLC1.` prefix and a base64url JSON envelope `{v:1,b:'supabase',u,k,g,t}` containing `u=project URL`, `k=anon key`, `g=group_id`, `t=join token`. This obfuscates the payload for UX, but is not encryption: it still leaks `u+k` to any recipient. Requirement: **B must NOT read A's private tables even with A’s anon key**.

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

### iOS PWA auth paste-to-verify (1.371+)

Supabase email links can break on iOS PWA when Gmail/Outlook opens them in Chrome or Safari instead of the standalone PWA's WebKit context. Browser storage is isolated, so `supabase-js` may create the session outside the PWA while the app remains signed out.

DeLaClaw avoids relying on external link opening:

- `sendMagicLink()` (kept name for compat) → `signInWithOtp({ email })`, which sends Supabase's normal auth email.
- `verifyOtpCode(email, token)` accepts a pasted confirmation URL, PKCE `?code=` URL, raw token hash, or email token and verifies it inside the requesting PWA context.
- `main.js` auth prompt flow: email → send auth email → paste confirmation link/token → verify → reload.

Default Supabase confirmation links work; custom token templates are optional. The important invariant is that verification happens inside the app context.

### Defense: CSP + credential stripping

- `style-src` keeps `unsafe-inline` for `style=` attrs, `script-src` is nonce/sha256 only since v1.350 (no `unsafe-inline`).
- `main.js` `saveStayConnectedCreds()` strips anon key for local/demo/drive, rejects `service_role` keys.
- `drive.js` tokens scoped by `clientId`, dedup pending promise.

### Defense: email guard (sec-006, 1.484+)

Prevents a second person from authenticating on a single-owner Supabase instance, which would split data or grant access to someone else's rows.

- **Table:** `auth_email_guard` — single row, `email_hash TEXT PRIMARY KEY, created_at TIMESTAMPTZ`, no RLS (must be readable before authentication).
- **Grants:** `SELECT` to anon, `SELECT + INSERT` to authenticated.
- **Flow:** after first successful magic-link verification, `setEmailGuard()` stores `SHA-256(email.lower().trim())`. On every subsequent login attempt, `checkEmailGuard()` compares the entered email's hash against the stored one _before_ `sendMagicLink()` fires. Mismatch → magic link never sent, user sees an error.
- **Recovery:** there is no UI to change the guarded email. If the owner loses access to their email, the `auth_email_guard` row must be deleted directly in the database.

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
5. Regenerates `.agents/CODEMAP.json` and `.agents/CODEMAP.md` from source
6. Stages all generated files
7. Prints an impact hint from CODEMAP `dependents` to help fill the `Checked:` trailer

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
  state.js                 Shared state object
  db.js                    Adapter abstraction with activity tracking
  version.js               Auto-generated version constants
  adapters/
    supabase.js            Supabase PostgREST adapter
    rest.js                Local Bun+SQLite REST adapter
    demo.js                In-memory adapter
    drive.js               Google Drive adapter (in-memory + per-table JSON persistence)
    offline-cache.js       IndexedDB caching layer
  auth.js                  Supabase email auth (magic link / OTP paste-to-verify)
  crypto-sync.js           AES-GCM encryption for joined_groups tokens
  sharing.js               Sharing factory (selects Supabase or Drive adapter)
  sharing-interface.js     Sharing adapter interface contract
  sharing-supabase.js      Supabase sharing adapter (RPC-based)
  sharing-drive.js         Google Drive sharing adapter (per-table JSON)
  sharing-envelope.js      DLC1 invite-code encode/decode
  sharing-ui.js            Sharing UI: settings pane, share popovers, completion modal
  delegation.js            Cross-module action delegation for shared items
  welcome.js               Today dashboard
  projects.js              Project boards + task management
  todos.js                 TODO management
  habits.js                Habit tracking
  flashcards.js            Flashcard SRS + text memorization
  birthdays.js             Birthday tracker
  vestiaire.js             Wardrobe inventory
  lists.js                 Checklists
  agents-ui.js             Agent task board UI
  i18n.js                  Translation strings (en/fr/es)
  icons.js                 Lucide icon rendering + path data
  utils.js                 Shared utilities (escaping, toasts, markdown)
  item-utils.js            Drag-and-drop, inline editing, hover actions
  backend-logos.js         Backend picker logo SVGs
  hero.js                  Landing page animations
  logo.js                  Logo animation engine
  storm3d.js               Three.js hero particle effect
  demo-chooser.js          Demo dataset selector UI
  demo-data.js             Sample data for demo mode
  bootstrap.js             ES module loader (extracted from inline script)
  sw-register.js           Service worker registration

server/
  server.js                Bun HTTP server (PostgREST-compatible API)
  schema.sql               SQLite base schema

migrations/                Incremental schema migrations
tests/
  tests.js                 Unit + adapter + integration + guard tests
icons/
  brand/                   Self-hosted brand SVGs (thesvg.org + dashboard-icons)
.agents/
  CODEMAP.json             Auto-generated dependency index (see AGENTS.md §1.4)
  CODEMAP.md               Human-readable matrix summary
  contracts/               Feature contracts (business invariants per feature)
.githooks/
  pre-commit               VERSION enforcement + CODEMAP regeneration + impact hint
```

## Internationalization

`js/i18n.js` exports a `t(key)` function that returns the translated string for the active language. All UI text goes through `t()`. Currently supported: English, French, Spanish.

Language is stored in `localStorage` and can be changed in Settings. The `t()` function falls back to English if a key is missing in the active language.

## Drag-and-drop

`js/item-utils.js` provides reusable drag-and-drop reordering via long-press (100ms threshold). Both category nav buttons and bucket items (TODOs, Projects, Vestiaire, Lists, Flashcard drafts) share the same UX:

- **Activation**: long-press on touch/pointer (`LONG_PRESS_MS = 100`), not native HTML drag events
- **Visual**: the real item follows the cursor/finger; a placeholder gap shows the drop position; siblings slide with FLIP animation. No visible drag handles — shadow-only to indicate float
- **Cross-container**: TODOs, Vestiaire, Projects, Habits, and Lists support dragging items between categories/lists — drop updates the FK and re-numbers `sort_order` in both source and target containers
- **Persistence**: `sort_order` updates are batched into a single DB write
- **Auto-scroll**: scrollable containers auto-scroll when dragging near edges
