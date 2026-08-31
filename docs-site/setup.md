# Setup Guide

DeLaClaw supports four backend modes. Each stores data differently but provides the same user experience.

## Demo mode (no setup)

1. Open [delaclaw.com](https://delaclaw.com) or serve `index.html` locally
2. On the login screen, click **Demo**
3. Choose a sample dataset (or start empty)

Data lives in memory only. It resets when you close or refresh the page. Good for trying out the app before committing to a backend.

## Google Drive

The simplest persistent backend — no database, no API keys.

### How it works

1. Open [delaclaw.com](https://delaclaw.com) or serve `index.html` locally
2. Select **Drive** in the backend picker and click **Connect with Google**
3. Sign in with your Google account and grant the `drive.file` scope (lets DeLaClaw access only files it creates). You may also be offered a `calendar.app.created` permission — this is optional and enables [Google Calendar sync](sync-architecture.md). You can decline it and enable it later from Settings
4. DeLaClaw creates a `DeLaClaw/` folder in your Google Drive containing one JSON file per table (e.g. `todos.json`, `habits.json`, `settings.json`)

All data loads into memory on connect and writes back to Drive with a 2-second debounce per table after each mutation. The JSON files are plain exports — you can download, inspect, or delete them from Drive at any time.

## Supabase (deprecated)

> **Supabase backend support has been removed.** Existing users who connect with their Supabase credentials will be offered a one-click migration to Google Drive or a data backup download. The Supabase adapter and client library remain in the codebase temporarily to support this migration path. The pre-deprecation codebase is preserved on the `dev-latest-supabase-support` branch.

## Local mode (Bun + SQLite)

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Start the server

```bash
cd server
bun run server.js
```

The server starts on port 3737 by default. Override with the `PORT` environment variable:

```bash
PORT=8080 bun run server.js
```

The SQLite database is created automatically at `server/last.db`. The schema (`server/schema.sql`) is applied on first run — local users always get the latest schema automatically.

### 3. Connect the app

1. Open `http://localhost:3737` in your browser (the server also serves the static files)
2. Select **Local** on the login screen
3. Enter the server URL (e.g. `http://localhost:3737`)

### Notes

- The REST server exposes a PostgREST-compatible API, so the app code works identically with both backends.
- Data is stored in a single SQLite file. Back it up by copying `server/last.db`.
- The server has no authentication. Run it on localhost or behind a reverse proxy if exposing to a network.

## Install on your phone

DeLaClaw is a PWA, so you can add it to your home screen and run it fullscreen like a native app — no App Store, no Play Store, no account. Watch the short for your platform, or follow the steps below it.

### iPhone / iPad

<iframe width="315" height="560" src="https://www.youtube.com/embed/uRh2HcT_KcY" title="Install DeLaClaw on iPhone — Add to Home Screen" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

1. Open [delaclaw.com](https://delaclaw.com) in **Safari**
2. Tap the **Share** button
3. Tap **Add to Home Screen**
4. Tap **Add**

> On iOS the install option only appears in **Safari**, not Chrome or Firefox.

### Android

<iframe width="315" height="560" src="https://www.youtube.com/embed/54JBnBFZM_I" title="Install DeLaClaw on Android — Add to Home Screen" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

1. Open [delaclaw.com](https://delaclaw.com) in **Chrome**
2. Tap the **⋮** menu (top right)
3. Tap **Install app** (or **Add to Home screen**)
4. Confirm

## After connecting

Regardless of the backend mode:

- **Theme**: defaults to your OS preference. Toggle in Settings (gear icon in the header).
- **Language**: defaults to English. Change in Settings (English, French, Spanish).
- **PWA install**: add DeLaClaw to your home screen to run it fullscreen like a native app — see [Install on your phone](setup.md?id=install-on-your-phone).
- **Offline mode**: after the first load, data is cached in IndexedDB. If the network drops, the app serves cached data in read-only mode with an amber banner. Full functionality resumes automatically when connectivity returns.
