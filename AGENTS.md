# AGENTS.md — DeLaClaw Operating Manual

For any coding agent (Human, Claude, Cursor, Codex) working in this repo. This is the single source of truth for how DeLaClaw is built. The global `~/AGENTS.md` is also read by agents — keep both in sync (this file is the repo canonical).

## 0. Purpose

DeLaClaw is an anti-SaaS personal life OS. Single-page app, no build step, no framework, vanilla JS (ES modules). Own your data: Supabase | Local Bun+SQLite | Google Drive | Demo. PWA, offline-first via IndexedDB cache, dark/light, i18n (EN/FR/ES).

## 1. Core Product Principles

**1.1 Reuse components for unified style**
- Never create one-off buttons, cards, modals, or inputs. Reuse existing CSS: `.view-tab`, `.page-empty-state`, `.modal`, `.settings-data-btn`, `.bucket-card`, `.usage-stats-container`, etc.
- Icons: Lucide only, via `js/icons.js` (`data-icon`), never emoji in UI.
- I18n: all user strings via `t()` in `js/i18n.js`, with EN/FR/ES keys. No hardcoded UI text in JS/HTML.
- Styles: reuse CSS variables (`--cat-color`, `--bg`, `--text`, `--muted`). Solid header backgrounds with 6% tinted body (color-mix) since v1.348 overhaul.
- Theme compatibility: all new CSS must work in both dark and light mode. Never hardcode colours — use CSS variables (`--bg`, `--text`, `--muted`, `--accent`, `--surface`, `--surface2`, etc.). Test visibility and contrast in both themes; `color-mix` tints that look fine in light mode can vanish on dark surfaces.

**1.2 UI interaction guards**
- When adding any interactive element (button, toggle, checkbox, link that mutates state), ask: what happens if it fires 2x before the first promise resolves? Does it duplicate a task, double-toggle, double-insert?
- Rule: one-click → disable until fulfilled.
  - Modal saves: use `guard()` in `js/main.js` (adds `disabled` + `saving`/`is-pending` + `aria-busy`).
  - List items (habit DONE / TODO DONE / project task approve/promote): use per-ID pending Sets (`_pendingHabitDones`, `_pendingTodoToggles`, `_pendingTaskStatus`). Allow concurrent different IDs, block same ID double-click.
  - Always pass `this` from `onclick="fn(id,this)"` and add `data-*-id` attribute for queryability.
- Enforced from v1.346. Tests guard existence of debounce/pending logic.

**1.3 Modular & abstract-first**
- Adapter pattern: all business logic talks to `db.js` proxy, never directly to Supabase/Drive. Each backend in `js/adapters/` must implement the same surface: `.from(table).select/insert/update/delete`, plus auth helpers. Offline-cache wraps any adapter transparently.
- Sharing protocols: Drive-based sharing (`js/sharing*.js`) must implement a common top-level interface/class (groups, invites, items, completions). Don't leak Drive-specific code into views (`todos.js`, `habits.js`, `lists.js` check `sharing` abstraction).
- Don't add `if (backend === 'supabase')` in views. Add a method to the adapter interface instead.
- Single responsibility: `utils.js` = generic helpers, `item-utils.js` = drag-drop + inline edit, `db.js` = activity tracking proxy only. Abstract first, implement second.

**1.4 AI-native dependency index (CODEMAP) + Feature contracts — mandatory for agents**
- Generated: `.agents/CODEMAP.json` (T2, ~25KB pretty / ~15KB compact) + `.agents/CODEMAP.md` (6KB matrix). Source: `scripts/generate-codemap.js`. Do not hand-edit.
- Contains per `js/*.js`: `entry`, `loc`, `tables`, `state`, `depends_on`, `dependents` (blast radius), `ui_components` (reusable CSS), `i18n_prefix`, `guards` (`guard`/`pendingSet`), `esc_count`, `window_exposed`.
- 8 features: `todos`, `habits`, `projects`, `birthdays`, `vestiaire`, `flashcards`, `lists`, `welcome`. Core modules + 5 adapters (`supabase`, `rest`, `demo`, `drive`, `offline-cache`). `welcome` aggregates all features. Exact counts live in CODEMAP itself.
- Feature contracts: `.agents/contracts/*.md` — agent-only, NOT in `docs-site`. Captures invariants CODEMAP can't: single source of truth (`isStructuredRule()`), guard patterns, XSS fields, RLS policies, welcome edges, business rules. BEFORE editing a feature, agents MUST read `CODEMAP.json:features[feature]` + `contracts/<feature>.md` if present.
- Rule: BEFORE editing any `js/*.js`, agents MUST read `.agents/CODEMAP.json` → `features[feature]` and relevant `core` entries. Reuse `depends_on` + `ui_components`, check `dependents` for impact scope, follow `guards` per AGENTS 1.2, verify `esc_count`/`tables` for XSS/schema impact.
- Freshness: pre-commit auto-regenerates JSON+MD and stages them. `tests/tests.js` will fail if JSON is out-of-date (CODEMAP freshness test). No manual sync.
- Impact: `scripts/impact.js` reads staged diff + CODEMAP `dependents` to suggest `Checked:` trailer (e.g. `birthdays` change → `welcome [x]` + `xss [x]`). Pre-commit prints `[impact] Checked: …` hint; commit-msg prints full blast-radius report on failure.
- Keep it small: exclude `demo-data.js`, don't index function bodies. If it grows >50KB, trim `window_exposed` to 8.

**1.5 Architecture Decision Records (ADRs) — public context, SHOULD read**
- Location: `docs-site/adrs/` — numbered `0001-*.md`, `0002-*.md` …
- Public, NOT agent-only — captures *why* a decision was made, vs contracts which capture *what* must stay true.
- Agents SHOULD read relevant ADR before major refactor: adapter change → `0002-byob-pluggable-backends.md`, build/tooling/hosting → `0001-no-build-github-pages-byob.md`.
- If a change introduces a significant architectural decision (new pattern, trade-off, cost model, security boundary), agents MUST surface a proposal for a new ADR in chat/review rather than silently pushing an ADR alongside the code. ADR creation is a discussion, not an implementation detail.
- Not enforced on every edit like CODEMAP/contracts, but provides rationale to avoid re-litigating past decisions.

## 2. UI / UX System

- Welcome / Today aggregates focus TODOs, due habits, flashcard reviews, birthdays.
- All pages share: search + clear button (CSS `:not(:placeholder-shown)`), drag-drop reorder, inline edit with note field, keyboard shortcuts.
- Empty states use shared `.page-empty-state` (icon + title + hint + CTA) with i18n keys.

## 3. Security

- **XSS**: No `innerHTML` with user data unless escaped. Wrap all user fields (`name`, `text`, `note`, `brand`, etc.) in `esc()` when interpolating into template literals. `renderMd()` and `truncateWithShowMore()` already esc internally, don't double-wrap. `showDeleteConfirm` uses `.textContent` (safe).
- **Safe DOM for URLs**: TODO/project links with user-provided URLs must use safe allowlist check, not raw `innerHTML`.
- **CSP hardening (sec-004)**: Vendor JS self-hosted in `vendor/` (`supabase@2.110.6`, `three@0.170.0`). No `cdn.jsdelivr.net` for app code. CSP meta in `index.html`: `default-src 'self'; script-src 'self' 'sha256-...importmap...' accounts.google.com apis.google.com gstatic; style-src 'self' 'unsafe-inline'...;` — `unsafe-inline` removed from `script-src` since v1.350 (inline scripts extracted to `js/bootstrap.js` + `js/sw-register.js`). `style-src` still needs `unsafe-inline` for `style=` attributes.
- **Google Identity exception**: GSI (`accounts.google.com/gsi/client` + `apis.google.com/js/api.js`) must stay CDN per Google ToS, no SRI allowed. Documented exception allowed only via CSP.
- **Supabase auth quirk**: use `anon_key` (`sb_publishable_*`) in BOTH `apikey:` and `Authorization: Bearer` headers. `service_role_key` (`sb_secret_*`) doesn't resolve to JWT in curl context. Confirmed June 11, 2026.

## 4. Backend & Data

- Tables (27 Supabase / 23 Local): 16 personal (`projects`, `tasks`, `todos`, `habits`, `habit_completions`, `flashcards`, `flashcard_notes`, `texts`, `text_line_progress`, `birthdays`, `vestiaire`, `lists`, `list_items`, `settings`, `prompts`, `nvidia_usage`) + 4 category/deck tables (`todo_categories`, `habit_categories`, `vestiaire_categories`, `flashcard_decks`) + `daily_visits`, `joined_groups`, `agent_grants` (all backends) + `sharing_groups`, `sharing_members`, `sharing_items`, `auth_email_guard` (Supabase only).
- **Category integrity**: each category/deck table has one protected default row (`name=''`, `is_protected=1`). `protect_category_row()` trigger prevents DELETE/UPDATE on protected rows. Item FKs (`category_id` / `deck_id`) use **CASCADE** on delete — deleting a user category deletes its items. App-level sharing cleanup runs before CASCADE to propagate shared-item deletion to all group members.
- Schema version in `settings` key `schema_version`, migrations in `migrations/`. Check `latest_compat` logic in `VERSION`.
- Base schema + migrations must be runnable in Supabase SQL editor + local SQLite (`server/schema.sql`).
- Vendor: `scripts/update-vendor.sh [supabase_ver] [three_ver]` updates `vendor/` + `index.html` comment + `docs-site/attributions.md`. Weekly GitHub Action `vendor-check.yml` opens PR to `dev` if new versions.

## 5. Git, Versioning, Commit

- **Target branch**: `dev` (preview at `dev.delaclaw.pages.dev`). `main` only when stable + user-approved. All PRs (including bot) target `dev`.
- **Hooks**: ALWAYS `git config core.hooksPath .githooks` on fresh clone/subagent. Pre-commit bumps `VERSION` → updates `sw.js` CACHE_VERSION + ` .agents/CODEMAP.json/.md` (via `scripts/generate-codemap.js`) + prints `[impact] Checked: …` hint + blocks emoji. Commit-msg enforces `Checked:` trailer and on failure runs `scripts/impact.js --staged` to show blast radius from CODEMAP dependents and suggested trailer.
- **VERSION file**: `latest` bumped every commit (X.YYY), `latest_compat` / `latest_compat_deprec` only on schema change. See `COMMIT_CHECKLIST.md`.
- **Checked trailer**: Format `Checked: versioning [x], i18n [~], docs [~], readme [~], checklist [~], tests [~], welcome [~], prompts [~], xss [x]` — decide each individually, no batch-marking. `[x]` = diff touches area, `[~]` = does not. Bare item = rejected. Lesson v1.145: tests + xss left unmarked by inertia. Use CODEMAP `dependents` to assess `welcome` impact.
- **Commit style**: `feat|fix|refactor|chore|ci|docs(scope): message`. Include test result (e.g. `N passed`) when relevant.

## 6. Testing

- `bun tests/tests.js` (or `node`). All tests must pass before pushing. Covers: unit logic, adapter compliance, import/export, window-assignment guard, XSS esc usage, CODEMAP freshness (`.agents/CODEMAP.json` matches regenerated output).
- PWA: `CACHE_VERSION` + `PRECACHE_URLS` in `sw.js` — `cache.addAll` fails entire install if any entry 404, so list must be exact. Include new `js/*.js` and `vendor/*` files.
- CODEMAP: `scripts/generate-codemap.js` must be idempotent. CI fails if committed JSON differs from regenerated.

## 7. Docs

- `docs-site/attributions.md` must list all third-party assets with correct load source (vendor/ vs CDN). Update when vendor versions change.
- `docs-site/setup.md`, `architecture.md`, `contributing.md` must stay in sync with adapter changes.
- No personal info, workspace config, memory files in public repo.

Keep this file short, accurate, and alive. When you learn a durable lesson that prevents a bug, add it here.
