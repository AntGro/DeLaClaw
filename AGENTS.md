# AGENTS.md — DeLaClaw Operating Manual

For any coding agent (Human, Claude, Cursor, Codex) working in this repo. This is the canonical copy of the operating manual for how DeLaClaw is built. A mirror lives at `~/AGENTS.md` for agents that read the global file — edit here, mirror there.

## 0. Purpose

DeLaClaw is an anti-SaaS personal life OS. Single-page app, no build step, no framework, vanilla JS (ES modules). Own your data: Google Drive | Local Bun+SQLite | Demo. PWA, dark/light, i18n (EN/FR/ES).

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
  - List items (habit DONE / TODO DONE): use per-ID pending Sets (`_pendingHabitDones`, `_pendingTodoToggles`). Allow concurrent different IDs, block same ID double-click.
  - Pass ids via `data-*-id` attributes for queryability; handlers read them from the delegated event. Inline `onclick` handlers were removed (none remain in `js/` or `index.html`) — never add one back.
- Enforced from v1.346. Tests guard existence of debounce/pending logic.

**1.3 Event delegation**
- `js/delegation.js` owns all click/change/input/keydown handling via 4 document-level listeners. Elements declare their action with `data-action="do-something"`.
- Explicit `case` entries in the switch handle actions that need specific argument mapping. The `default` fallback camelCases the action name and calls the matching `window` function.
- **Never add `.onclick` or `addEventListener('click')` on an element that has `data-action`** — delegation already fires the handler, and the duplicate will call it twice (the calendar-sync double-toggle bug, v1.884).
- Dynamic elements without `data-action` (modals, overlays, one-time dismiss handlers) can use direct handlers safely.

**1.4 Modular & abstract-first**
- Adapter pattern: all business logic talks to `db.js` proxy, never directly to any backend. Each backend in `js/adapters/` must implement the same surface: `.from(table).select/insert/update/delete`, plus auth helpers.
- Sharing protocols: all sharing goes through an adapter interface (`js/sharing-interface.js`), validated at init by `validateSharingAdapter()`. Views (`todos.js`, `habits.js`, `lists.js`) talk to `state.sharing` abstraction, never to a backend directly.
- Don't add backend-specific conditionals in views. Add a method to the adapter interface instead.
- Single responsibility: `utils.js` = generic helpers, `item-utils.js` = drag-drop + inline edit, `db.js` = activity tracking proxy only. Abstract first, implement second.

**1.5 AI-native dependency index (CODEMAP) + Feature contracts — mandatory for agents**
- Generated: `.agents/CODEMAP.json` + `.agents/CODEMAP.md` (human-readable matrix). Source: `scripts/generate-codemap.js`. Do not hand-edit. Sizes and counts live in CODEMAP itself — do not restate them here.
- Contains per `js/*.js`: `entry`, `loc`, `tables`, `state`, `depends_on`, `dependents` (blast radius), `ui_components` (reusable CSS), `i18n_prefix`, `guards` (`guard`/`pendingSet`), `esc_count`, `window_exposed`.
- Features, core modules and adapters are enumerated in CODEMAP itself — it is the source of truth, so they are not listed here. `welcome` aggregates todos, habits, flashcards and birthdays (birthdays via calendar) — not lists.
- Feature contracts: `.agents/contracts/*.md` — agent-only, NOT in `docs-site`. Captures invariants CODEMAP can't: single source of truth (`isStructuredRule()`), guard patterns, XSS fields, welcome edges, business rules. BEFORE editing a feature, agents MUST read `CODEMAP.json:features[feature]` + `contracts/<feature>.md` if present.
- Rule: BEFORE editing any `js/*.js`, agents MUST read `.agents/CODEMAP.json` → `features[feature]` and relevant `core` entries. Reuse `depends_on` + `ui_components`, check `dependents` for impact scope, follow `guards` per AGENTS 1.2, verify `esc_count`/`tables` for XSS/schema impact.
- Freshness: pre-commit auto-regenerates JSON+MD and stages them. `tests/tests.js` will fail if JSON is out-of-date (CODEMAP freshness test). No manual sync.
- Impact: `scripts/impact.js` reads staged diff + CODEMAP `dependents` to suggest `Checked:` trailer (e.g. `todos` change → `welcome [x]` + `xss [x]` — todos' dependents are calendar-sync.js, calendar.js, main.js, welcome.js). Pre-commit prints `[impact] Checked: …` hint; commit-msg prints full blast-radius report on failure.
- Keep it small: exclude `demo-data.js`, don't index function bodies. If it grows >50KB, trim `window_exposed` to 8.

**1.6 Architecture Decision Records (ADRs) — public context, SHOULD read**
- Location: `docs-site/adrs/` — numbered `0001-*.md`, `0002-*.md` …
- Public, NOT agent-only — captures *why* a decision was made, vs contracts which capture *what* must stay true.
- Agents SHOULD read relevant ADR before major refactor: adapter change → `0002-byob-pluggable-backends.md`, build/tooling → `0001-no-build-github-pages-byob.md`, hosting → `0009-cloudflare-pages-hosting.md` (0001's hosting part is superseded by 0009).
- If a change introduces a significant architectural decision (new pattern, trade-off, cost model, security boundary), agents MUST surface a proposal for a new ADR in chat/review rather than silently pushing an ADR alongside the code. ADR creation is a discussion, not an implementation detail.
- Not enforced on every edit like CODEMAP/contracts, but provides rationale to avoid re-litigating past decisions.

## 2. UI / UX System

- Welcome / Today aggregates focus TODOs, due habits, flashcard reviews, birthdays.
- All pages share: search + clear button (CSS `:not(:placeholder-shown)`), drag-drop reorder, inline edit with note field, keyboard shortcuts.
- Empty states use shared `.page-empty-state` (icon + title + hint + CTA) with i18n keys.

## 3. Security

- **XSS**: No `innerHTML` with user data unless escaped. Wrap all user fields (`name`, `text`, `note`, `brand`, etc.) in `esc()` when interpolating into template literals. `renderMd()` and `truncateWithShowMore()` already esc internally, don't double-wrap. `showConfirmAction` uses `.textContent` by default (safe); its `messageHtml`/`detailHtml` options take `innerHTML` only with content already run through `renderMd`.
- **Safe DOM for URLs**: TODO/list links with user-provided URLs must use safe allowlist check, not raw `innerHTML`.
- **CSP hardening (sec-004)**: No vendored JS and no `cdn.jsdelivr.net` for app code since three.js was dropped (Nov 2026) — the hero storm is a single SVG from hero to gate (logo.js), no canvas stage. CSP meta in `index.html`: `default-src 'self'; script-src 'self' accounts.google.com apis.google.com gstatic cloudflareinsights; style-src 'self' 'unsafe-inline'...;` — `unsafe-inline` removed from `script-src` since v1.350 (inline scripts extracted to `js/bootstrap.js` + `js/sw-register.js`). `style-src` still needs `unsafe-inline` for `style=` attributes. Cloudflare Web Analytics beacon allowed in both `script-src` (`static.cloudflareinsights.com`) and `connect-src` (`cloudflareinsights.com`).
- **Google Identity exception**: GSI (`accounts.google.com/gsi/client` + `apis.google.com/js/api.js`) must stay CDN per Google ToS, no SRI allowed. Documented exception allowed only via CSP.

## 4. Backend & Data

- Tables: canonical list lives in `server/schema.sql` (Local SQLite). Personal tables, category/deck tables, and the cross-backend table `daily_visits` exist on all backends. Sharing runs on Drive files, not SQL tables: the joined-group list is the Drive adapter's file-backed `groups` table (no Local equivalent), and the `sharing_groups` / `sharing_members` / `sharing_items` names survive only in main.js's backup enumeration — no adapter stores or reads them.
- **Category integrity**: each category/deck table has one protected default row (`name=''`, `is_protected=1`). per-table triggers (`trg_protect_todo_categories`, `trg_protect_habit_categories`, `trg_protect_flashcard_decks`, each with a `_upd` variant) prevent DELETE/UPDATE on protected rows. Item FKs (`category_id` / `deck_id`) use **CASCADE** on delete — deleting a user category deletes its items. App-level sharing cleanup runs before CASCADE to propagate shared-item deletion to all group members.
- Schema version in `settings` key `schema_version`, migrations in `migrations/`.
- Base schema + migrations must be runnable in local SQLite (`server/schema.sql`).
- Vendor: none since three.js was dropped (Nov 2026) — the `vendor/` directory, `scripts/update-vendor.sh`, and the weekly `vendor-check.yml` action were all removed with it.
- **Local backend is hidden**: no login option exposes it (his decision, Oct 16, 2026) — keep it hidden without removing it. The code (`js/adapters/rest.js`, `server/`, `server/schema.sql`) stays as maintained plumbing: migrations run on both backends and the suite covers it; no Local-specific feature work.

## 5. Git, Versioning, Commit

- **Target branch**: `dev` (preview at `dev.delaclaw.pages.dev`). `main` only when stable + user-approved. All PRs (including bot) target `dev`.
- **Hooks**: ALWAYS `git config core.hooksPath .githooks` on fresh clone/subagent. Bump `latest` in `VERSION` by hand and stage it — pre-commit rejects the commit if `VERSION` isn't staged, then regenerates `js/version.js`, updates `sw.js` CACHE_VERSION and `.agents/CODEMAP.json/.md` (via `scripts/generate-codemap.js`), prints the `[impact] Checked: …` hint and blocks emoji. Commit-msg enforces `Checked:` trailer and on failure runs `scripts/impact.js --staged` to show blast radius from CODEMAP dependents and suggested trailer.
- **VERSION file**: `latest` bumped every commit (X.Y.Z — patch per commit, minor on features, major on breaking schema). See `COMMIT_CHECKLIST.md`.
- **Checked trailer**: Format `Checked: versioning [x], i18n [~], docs [~], readme [~], checklist [~], tests [~], welcome [~], prompts [~], xss [x]` — decide each individually, no batch-marking. `[x]` = diff touches area, `[~]` = does not. Bare item = rejected. Lesson v1.145: tests + xss left unmarked by inertia. Use CODEMAP `dependents` to assess `welcome` impact.
- **Commit style**: `feat|fix|refactor|chore|ci|docs(scope): message`. Include test result (e.g. `N passed`) when relevant.
- **Never suppress `git stash pop` output** — a failed pop (e.g. conflict with test-regenerated files) silently leaves work in the stash while the tree looks clean; lesson Sep 22, 2026: always check pop output and `git stash list` afterwards.

## 6. Testing

- `bun tests/tests.js` (or `node`). All tests must pass before pushing. Covers: unit logic, adapter compliance, import/export, window-assignment guard, XSS esc usage, CODEMAP freshness (`.agents/CODEMAP.json` matches regenerated output).
- PWA: `CACHE_VERSION` + `PRECACHE_URLS` in `sw.js` — `cache.addAll` fails entire install if any entry 404, so list must be exact. Include new `js/*.js` files.
- CODEMAP: `scripts/generate-codemap.js` must be idempotent. CI fails if committed JSON differs from regenerated.

## 7. Docs

- `docs-site/attributions.md` must list all third-party assets with correct load source (CDN, embedded, or self-hosted). Update when a third-party asset changes.
- `docs-site/setup.md`, `architecture.md`, `sharing.md` must stay in sync with adapter changes.
- No personal info, workspace config, memory files in public repo.
- **Mermaid diagrams** (`docs-site/`): read `.agents/skills/mermaid-diagrams.md` before creating or editing Mermaid diagrams. Validate every touched block with the Mermaid v10 parser (`mermaid.parse`, node + jsdom shim) before committing — a block missing its `sequenceDiagram` header fails to render with no useful error (lesson v2.9.6).

Keep this file short, accurate, and alive. When you learn a durable lesson that prevents a bug, add it here.
