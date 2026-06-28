# Privacy

DeLaClaw is designed so that your data stays yours. This document explains what happens with your information.

## Where your data lives

DeLaClaw does not operate a central server. Depending on which backend mode you choose:

- **Supabase**: your data is stored in your own Supabase project. DeLaClaw connects directly from your browser to your Supabase instance. No data passes through any DeLaClaw server.
- **Google Drive**: your data is stored as JSON files in a `DeLaClaw/` folder in your own Google Drive. Authentication uses Google Identity Services directly in the browser. No data passes through any DeLaClaw server.
- **Local (Bun + SQLite)**: your data is stored in a SQLite file on your machine.
- **Demo**: data exists only in browser memory and is lost when you close or refresh the page.

## Google Drive scopes

DeLaClaw requests one of two Google Drive scopes depending on your usage:

- **`drive.file`** (default) — limits access strictly to files and folders that DeLaClaw itself creates. Used for personal data storage and backups.
- **`drive`** (when sharing is enabled) — broader access required to discover and read folders shared with you by other DeLaClaw users. This scope is requested only when you explicitly enable the sharing feature. DeLaClaw uses this access solely to list folders shared with you and read/write shared group data within those folders.

You can revoke the broader scope at any time by disabling sharing in Settings, which returns the app to `drive.file` only.

## Sharing and user-to-user data exchange

DeLaClaw offers an optional sharing feature that lets you exchange TODOs, habits, and lists with other users via shared Google Drive folders. When you use sharing:

- You explicitly choose which items to share and with whom by creating sharing groups and inviting members by email.
- Shared data (group metadata, shared TODOs, habits, and lists) is stored in shared Google Drive folders that all group members can access.
- A **trusted contacts** system controls whose shared folders your app will load. Only folders from people you have added to your trusted contacts list are accepted; all others are automatically rejected.
- Your trusted contacts list is stored in your own Google Drive (`DeLaClaw/trusted-contacts.json`) and is not shared with anyone.

Sharing is entirely opt-in. If you do not enable sharing, no data is exchanged with other users.

## What DeLaClaw does not do

- **No analytics.** No usage tracking, no page view counting, no event logging.
- **No telemetry.** The app sends no data to any DeLaClaw-operated service.
- **No cookies.** DeLaClaw does not set any cookies.
- **No third-party tracking.** No Google Analytics, no Meta Pixel, no advertising scripts.
- **No user accounts on our side.** There is no DeLaClaw account system. Authentication is handled entirely by your chosen backend (Supabase auth, or none for local/demo).

## What is stored in your browser

DeLaClaw uses browser-standard storage mechanisms for local preferences:

- **localStorage**: theme preference, language, active tab, stay-connected credentials (your Supabase URL and anon key, if you opt in), sharing preferences, and tab visibility/order settings.
- **IndexedDB**: offline cache of your database tables, scoped by backend mode. Used to serve read-only data when the network is unavailable. Cleared automatically when you reconnect.
- **Service Worker cache**: static app assets (HTML, CSS, JS, icons) for offline loading. Versioned and replaced on each update.

None of this data leaves your browser.

## External requests

When using DeLaClaw, your browser makes requests to:

- **Your Supabase project** (if using Supabase mode): API calls to your own database.
- **Google Identity Services** (`accounts.google.com/gsi/client`) (if using Google Drive mode): OAuth token flow for Drive authentication. Subject to [Google's privacy policy](https://policies.google.com/privacy).
- **Google Drive API** (`www.googleapis.com`) (if using Google Drive mode): reading and writing your data files and shared folders. Subject to [Google's privacy policy](https://policies.google.com/privacy).
- **Google Static** (`www.gstatic.com`): Google Drive logo image on the login screen.
- **Google Fonts** (`fonts.googleapis.com`): to load the DM Sans typeface. Subject to [Google's privacy policy](https://policies.google.com/privacy).
- **jsDelivr CDN** (`cdn.jsdelivr.net`): to load the Supabase JS client and Three.js. Subject to [jsDelivr's privacy policy](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net).
- **GitHub Pages** (`delaclaw.com`): serves the static app files if you use the hosted version. Subject to [GitHub's privacy policy](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

No other external requests are made.

## Data sharing with third parties

DeLaClaw does not sell, share, or transfer any user data to third parties for any purpose, including advertising, analytics, or AI training. The only data exchange is user-to-user sharing as described above, which you control entirely.

## Open source

DeLaClaw is licensed under AGPL-3.0. The full source code is available at [github.com/AntGro/DeLaClaw](https://github.com/AntGro/DeLaClaw). You can inspect exactly what the app does, self-host it, and modify it.

## Changes

If this policy changes, the change will be visible in the repository commit history.
