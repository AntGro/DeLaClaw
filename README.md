# DeLaClaw

A personal life OS that runs in the browser. Your data lives in your Google Drive — no account, no server, no SaaS.

[![Tests](https://github.com/AntGro/DeLaClaw/actions/workflows/test.yml/badge.svg)](https://github.com/AntGro/DeLaClaw/actions/workflows/test.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-delaclaw.com-454dc6)](https://delaclaw.com)

<p align="center">
  <img src="screenshots/welcome.png" alt="DeLaClaw Today dashboard" width="720">
</p>

## What it does

DeLaClaw is a single-page productivity dashboard that runs entirely in the browser. Sign in with Google and your data is stored as JSON files in your own Google Drive — your personal files are never accessed. No API keys, no database, no backend to maintain.

### Modules

| Module | Description |
|---|---|
| **Today** | Daily briefing: focus TODOs, due habits, flashcard reviews, upcoming birthdays, stats |
| **Projects** | Kanban-style project boards with task statuses, links, and drag-and-drop |
| **TODOs** | Categorized tasks with 5 priority levels, due dates, snooze, drag-and-drop reordering |
| **Habits** | Recurring habits with flexible scheduling (structured rules + free text), completion tracking, streaks |
| **Flashcards** | Spaced repetition (FSRS algorithm) with deck organization and text memorization mode |
| **Birthdays** | Birthday tracker with countdowns and avatar support |
| **Wardrobe** | Clothing inventory with brand, size, category, and purchase status tracking |
| **Lists** | General-purpose checklists with archival support |

### Capabilities

- **Google Drive storage**: data saved as per-table JSON files in a `DeLaClaw/` folder in your Drive
- **Google Calendar sync**: optionally mirror habits, TODOs, and birthdays to a dedicated Google Calendar
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

### Google Drive

1. Open [delaclaw.com](https://delaclaw.com)
2. Click "Connect with Google"
3. Sign in with your Google account — DeLaClaw creates a `DeLaClaw/` folder in your Drive with one JSON file per table
4. All data syncs automatically; no API keys or database setup needed

### Demo (no setup)

1. Open [delaclaw.com](https://delaclaw.com)
2. Click "Try the demo" and choose a dataset
3. All data lives in memory and resets on refresh

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
  auth.js               Google authentication flows
  adapters/
    demo.js             In-memory adapter with sample data
    drive.js            Google Drive adapter (in-memory + per-table JSON persistence)
  calendar-sync.js      Google Calendar sync
  welcome.js            Today dashboard
  projects.js           Project boards and task management
  todos.js              TODO management
  habits.js             Habit tracking
  flashcards.js         Flashcard SRS + text memorization
  birthdays.js          Birthday tracker
  vestiaire.js          Wardrobe inventory
  lists.js              Checklists
  delegation.js         CSP-safe event delegation
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
sw.js                   Service worker (network-first + precache)
```

The adapter pattern (`db.js`) means the app logic never touches the storage directly. Each adapter exposes the same `.from(table).select()/.insert()/.update()/.delete()` interface.

Category/deck foreign keys use CASCADE on delete — deleting a category deletes its items.

See [docs-site/architecture.md](docs-site/architecture.md) for details.

## Testing

```bash
node tests/tests.js
```

Tests covering unit logic, adapter compliance, and browser-based end-to-end flows. All tests must pass before pushing to `dev`.

## Contributing

See [Contributing](docs-site/contributing.md).

## License

[AGPL-3.0](LICENSE) — see [NOTICE](NOTICE) for attribution requirements.

DeLaClaw is free software. You can use, modify, and distribute it under the terms of the GNU Affero General Public License v3. If you run a modified version as a network service, you must make your source available to users of that service. Derivative works must credit DeLaClaw as described in the NOTICE file.

## Third-party

- [Lucide](https://lucide.dev) icons (ISC License)
- [DM Sans](https://fonts.google.com/specimen/DM+Sans) font (Open Font License)
- [Three.js](https://threejs.org) for hero animations (MIT License)

See [Attributions](docs-site/attributions.md) for full details.
