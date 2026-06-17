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
3. Sign in with your Google account and grant the `drive.file` scope (lets DeLaClaw access only files it creates)
4. DeLaClaw creates a `DeLaClaw/` folder in your Google Drive containing a single `delaclaw-data.json` file

All data loads into memory on connect and writes back to Drive with a 2-second debounce after each mutation. The JSON file is a plain export of all tables — you can download, inspect, or delete it from Drive at any time.

### OAuth testing mode

The OAuth client ID is configured for **Testing** mode in Google Cloud Console, which means:

- Only test users added to the consent screen can sign in
- Refresh tokens expire after 7 days — you'll need to re-authenticate

To remove these restrictions, submit the app for Google verification (requires a privacy policy and domain ownership).

## Supabase (cloud PostgreSQL)

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com) and create a new project. Note your **Project URL** and **anon (public) key** from Settings > API.

### 2. Create the database schema

Open the **SQL Editor** in your Supabase dashboard.

**New installs**: run `sql/supabase_schema.sql`. This is the complete current schema with all migrations folded in. It sets `schema_version` automatically.

**Existing installs**: run any pending migrations in `migrations/` in order (files are named by target version, e.g. `1.099_enable_realtime.sql`). See `migrations/MIGRATION_GUIDE.md` for the full versioning system.

### 3. Connect the app

1. Open [delaclaw.com](https://delaclaw.com) (or serve `index.html` locally)
2. Select **Supabase** on the login screen
3. Enter your Project URL and anon key
4. Optionally check "Stay connected" to persist credentials in the browser

### Notes

- Row Level Security (RLS) is enabled on all tables. The default policies allow all operations with the anon key. For multi-user setups, tighten the policies.
- The app uses the Supabase JS client v2 loaded from CDN. No server-side code is needed.
- Real-time subscriptions are enabled: changes from other tabs or devices appear automatically.
- The app checks DB `schema_version` against the `VERSION` file and shows a banner if migrations are pending.

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

## After connecting

Regardless of the backend mode:

- **Theme**: defaults to your OS preference. Toggle in Settings (gear icon in the header).
- **Language**: defaults to English. Change in Settings (English, French, Spanish).
- **PWA install**: on supported browsers, you can install DeLaClaw as a standalone app from the browser menu.
- **Offline mode**: after the first load, data is cached in IndexedDB. If the network drops, the app serves cached data in read-only mode with an amber banner. Full functionality resumes automatically when connectivity returns.
