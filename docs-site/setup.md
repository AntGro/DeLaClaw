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

## Supabase (cloud PostgreSQL)

### 1. Create a Supabase project

Sign up at [supabase.com](https://supabase.com) and create a new project. Note your **Project URL** and **anon (public) key** from Settings > API.

### 2. Create the database schema

Open the **SQL Editor** in your Supabase dashboard.

**New installs**: run `sql/supabase_schema.sql`. This is the complete current schema with all migrations folded in. It sets `schema_version` automatically and enables `pgcrypto` for invite token hashing.

**Existing installs**: run any pending migrations in `migrations/` in order (files are named by target version, e.g. `1.099_enable_realtime.sql`). See `migrations/MIGRATION_GUIDE.md` for the full versioning system. Since `1.300` mandatory auth and `1.301` hashed invites are security-critical, run them as soon as possible.

### 3. Configure Auth (mandatory since 1.300)

DeLaClaw uses Supabase Auth with magic-link only (no password). Owner-only RLS means **no data is readable without a session**.

In your Supabase dashboard → **Authentication → Providers**:

1. Enable **Email** provider
2. Disable email confirmations if you want instant magic-link login (or keep it enabled — DeLaClaw sends a magic link)
3. Set **Site URL** to your deployed origin, e.g. `https://delaclaw.com`
4. Under **Additional Redirect URLs**, add:
   - `https://delaclaw.com`
   - `https://dev.delaclaw.pages.dev` (preview)
   - `http://localhost:3737` (local dev)
   - any custom domain you self-host on

In **Authentication → Settings**:

- Enable **Magic Link** (Email OTP)
- Set **JWT expiry** to 1 hour (default is fine)
- Set **Refresh token lifetime** to **1 year** (`8760 hours` / `31536000 seconds`) — DeLaClaw stores the refresh token in localStorage and reuses it; a long lifetime avoids repeated email logins. Users can still log out explicitly.

In **Authentication → Rate Limits**: keep defaults, or increase Magic Link limit to 10/hour if you test frequently.

> Since 1.300, the "Skip" / anonymous path is removed for Supabase. You must sign in via magic link after entering URL + anon key. Your `owner_id` is set to `auth.uid()` on every insert via `trg_set_owner_id`, and `claim_ownership()` backfills legacy unclaimed rows on first login.

### 4. Connect the app

1. Open [delaclaw.com](https://delaclaw.com) (or serve `index.html` locally)
2. Select **Supabase** on the login screen
3. Enter your Project URL and anon key
4. Enter your email → click **Send magic link** → open link from inbox

#### iPhone PWA + Gmail/Outlook quirk (important since 1.371)

On iOS, if you use DeLaClaw as a Home Screen PWA and receive the login email in Gmail (or Outlook):

- **Gmail opens links in Chrome**, not in your PWA. Chrome's localStorage is isolated from the PWA's standalone WebKit context, so clicking the magic link creates a session **in Chrome, not in the PWA**. Your PWA stays signed out.
- Same for Safari vs PWA since iOS 16: standalone PWA storage is separate from Safari tabs.

**Fix**: DeLaClaw now shows a 6-digit code entry after you request the link.

1. In the PWA, enter email → **Send magic link**
2. Open Gmail/Apple Mail → open the email
3. **Copy the 6-digit code** (e.g. `482913`) — don't just tap the link
4. Return to PWA → paste code → **Verify code**

The code is verified via `supabase.auth.verifyOtp({ email, token, type: 'email' })` inside the PWA, so the session stays in the PWA.

> Your Supabase email template must include `{{ .Token }}` (the 6-digit code). In Dashboard → **Authentication → Email Templates → Magic Link**, ensure the template contains both the link button (`{{ .ConfirmationURL }}`) and the code line like `Your code is {{ .Token }}`. Default Supabase template already includes both. If you customized it to link-only, add the token back.

5. Optionally check "Stay connected" to persist URL + anon key (the session itself is stored separately by Supabase Auth)

### Notes

- **Security 1.300**: RLS is `owner only` on all 13 personal tables (`projects`, `tasks`, `todos`, `habits`, `habit_completions`, `flashcards`, `flashcard_notes`, `texts`, `text_line_progress`, `birthdays`, `vestiaire`, `lists`, `list_items`, `settings`, `prompts`, `joined_groups`). Policies are `FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())`. Even if the anon key leaks inside an invite link, `B` cannot read `A`'s private tables.
- **Security 1.301**: Invite tokens are never stored plaintext for lookups. `sharing_members` stores `token_hash = encode(digest(token,'sha256'),'hex')`, `expires_at` (24h) and `revoked_at`. All sharing RPCs (`verify_join_token`, `confirm_join`, `get_shared_items`, ...) verify hash + revocation + expiry.
- **Encrypted joins**: `joined_groups` stores `token_ciphertext`/`token_iv` and `remote_anon_key_ciphertext/_iv` encrypted with a per-user `sync_secret` (WebCrypto AES-GCM, 32 bytes in localStorage `claw_sync_secret`). Plaintext columns remain only for fallback/migration.
- The app uses the Supabase JS client v2 from CDN. No server-side code is needed.
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
