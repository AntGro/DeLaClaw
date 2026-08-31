# DeLaClaw

A personal command center you own. No SaaS lock-in, no frameworks, bring your own backend.

[![Tests](https://github.com/AntGro/DeLaClaw/actions/workflows/test.yml/badge.svg)](https://github.com/AntGro/DeLaClaw/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-delaclaw.com-454dc6)](https://delaclaw.com)

<p align="center">
  <img src="screenshots/welcome.png" alt="DeLaClaw Today dashboard" width="720">
</p>

## What it does

DeLaClaw is a single-page productivity dashboard that runs entirely in the browser. It connects to your own storage (Google Drive, local SQLite, or an in-memory demo) and gives you a unified view of your projects, tasks, habits, flashcards, and more.

### Modules

| Module | Description |
|---|---|
| **Today** | Daily briefing: focus TODOs, due habits, flashcard reviews, upcoming birthdays, stats |
| **Projects** | Kanban-style project boards with task statuses, links, and drag-and-drop |
| **TODOs** | Categorized tasks with 5 priority levels, due dates, snooze, drag-and-drop reordering |
| **Habits** | Recurring habits with flexible scheduling (structured rules + free text), completion tracking, streaks |
| **Flashcards** | Spaced repetition (FSRS algorithm) with deck organization, text memorization mode, draft-to-card proposal workflow |
| **Birthdays** | Birthday tracker with countdowns and avatar support |
| **Wardrobe** | Clothing inventory with brand, size, category, and purchase status tracking |
| **Lists** | General-purpose checklists with archival support |

### Capabilities

- **Three backend modes**: Google Drive (per-table JSON files in your Drive), local REST server (Bun + SQLite), in-memory demo
- **Google Calendar sync**: optionally mirror habits, TODOs, and birthdays to a dedicated Google Calendar (Drive backend)
- **Sharing**: Cross-user collaborative sharing for TODOs, habits, and lists — create groups, invite via opaque codes, collaborative editing and completion tracking
- **Offline-first**: IndexedDB cache serves read-only data when the network is down, with automatic recovery
- **PWA**: installable on mobile and desktop via service worker with network-first caching
- **Dark and light themes** with automatic OS preference detection
- **Internationalization**: English, French, Spanish
- **Drag-and-drop** reordering across all list views
- **Keyboard shortcuts** for common actions
- **Zero frameworks**: vanilla JavaScript with ES modules, no build step

## Screenshots

<p align="center">
  <img src="screenshots/projects.png" alt="Project boards" width="720">
</p>

## Quick start

DeLaClaw supports three backend modes. Pick one:

### Demo (no setup)

1. Open [delaclaw.com](https://delaclaw.com)
2. Click "Demo" and choose a dataset
3. All data lives in memory and resets on refresh

### Google Drive

1. Open [delaclaw.com](https://delaclaw.com)
2. Select "Drive" and click "Connect with Google"
3. Sign in with your Google account — DeLaClaw creates a `DeLaClaw/` folder in your Drive with one JSON file per table
4. All data syncs automatically; no API keys or database setup needed

### Local (Bun + SQLite)

1. Install [Bun](https://bun.sh)
2. Run the server:
   ```bash
   cd server
   bun run server.js
   ```
3. Open `http://localhost:3000` in a browser
4. Select "Local" and enter the server URL

See [docs-site/setup.md](docs-site/setup.md) for detailed instructions.

## Architecture

Single-page application with no build step. The browser loads ES modules directly.

```
index.html              Shell: login gate, tab navigation, all views
style.css               All styles (dark + light themes, responsive)
js/
  main.js               App bootstrap, view switching, settings, footer
  state.js              Centralized state and constants
  db.js                 Adapter abstraction with Proxy-based activity tracking
  auth.js               Authentication flows (legacy — Supabase migration support)
  adapters/
    supabase.js         Supabase PostgREST adapter (legacy — migration support)
    rest.js             Local Bun+SQLite REST adapter
    demo.js             In-memory adapter with sample data
    drive.js            Google Drive adapter (in-memory + per-table JSON persistence)
    offline-cache.js    IndexedDB caching layer (legacy — Supabase migration support)
  calendar-sync.js      Google Calendar sync (Drive backend)
  sharing.js            Sharing adapter factory (picks backend, validates interface)
  sharing-interface.js  Canonical sharing adapter contract
  sharing-supabase.js   Supabase sharing adapter (legacy — migration support)
  sharing-drive.js      Drive sharing adapter
  sharing-envelope.js   Invite code encode/decode (DLC1 format)
  sharing-ui.js         Sharing UI: settings pane, share popovers, completion modal
  crypto-sync.js        AES-GCM encryption for joined-group credentials (legacy — Supabase migration support)
  welcome.js            Today dashboard
  projects.js           Project boards and task management
  todos.js              TODO management
  habits.js             Habit tracking
  flashcards.js         Flashcard SRS + text memorization
  birthdays.js          Birthday tracker
  vestiaire.js          Wardrobe inventory
  lists.js              Checklists
  delegation.js         AI agent delegation and task routing
  i18n.js               Translation strings (en/fr/es)
  icons.js              Lucide icon rendering
  utils.js              Shared utilities
  item-utils.js         Drag-and-drop, inline editing
  backend-logos.js      Backend brand icons (SVG)
  hero.js               Landing page animations
  logo.js               Logo animation engine
  storm3d.js            Three.js hero effect
  bootstrap.js          Extracted inline init script (CSP-safe)
  sw-register.js        Service worker registration (CSP-safe)
  version.js            Auto-generated version constant
  demo-chooser.js       Demo dataset selector
  demo-data.js          Sample data for demo mode
server/
  server.js             Bun HTTP server (SQLite backend)
  schema.sql            SQLite base schema
migrations/             Incremental SQL migrations
sw.js                   Service worker (network-first + precache)
```

The adapter pattern (`db.js`) means the app logic never touches the backend directly. Each adapter exposes the same `.from(table).select()/.insert()/.update()/.delete()` interface. Sharing follows the same pattern via a validated adapter interface.

The canonical table list lives in `server/schema.sql` (Local SQLite). `sql/supabase_schema.sql` is retained as a legacy reference. Category/deck foreign keys use CASCADE on delete — deleting a category deletes its items.

See [docs-site/architecture.md](docs-site/architecture.md) for details.

## Testing

```bash
node tests/tests.js
```

Tests covering unit logic, adapter compliance, REST server integration, and browser-based end-to-end flows. All tests must pass before pushing to `dev`.

## Contributing

See [Contributing](docs-site/contributing.md).

## License

[AGPL-3.0](LICENSE) — see [NOTICE](NOTICE) for attribution requirements.

DeLaClaw is free software. You can use, modify, and distribute it under the terms of the GNU Affero General Public License v3. If you run a modified version as a network service, you must make your source available to users of that service. Derivative works must credit DeLaClaw as described in the NOTICE file.

## Third-party

- [Lucide](https://lucide.dev) icons (ISC License)
- [DM Sans](https://fonts.google.com/specimen/DM+Sans) font (Open Font License)
- [Supabase JS](https://github.com/supabase/supabase-js) client (MIT License) — legacy, retained for migration support
- [Three.js](https://threejs.org) for hero animations (MIT License)

See [Attributions](docs-site/attributions.md) for full details.
