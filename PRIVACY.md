# Privacy

DeLaClaw is designed so that your data stays yours. This document explains what happens with your information.

## Where your data lives

DeLaClaw does not operate a central server. Depending on which backend mode you choose:

- **Supabase**: your data is stored in your own Supabase project. DeLaClaw connects directly from your browser to your Supabase instance. No data passes through any DeLaClaw server.
- **Local (Bun + SQLite)**: your data is stored in a SQLite file on your machine.
- **Demo**: data exists only in browser memory and is lost when you close or refresh the page.

## What DeLaClaw does not do

- **No analytics.** No usage tracking, no page view counting, no event logging.
- **No telemetry.** The app sends no data to any DeLaClaw-operated service.
- **No cookies.** DeLaClaw does not set any cookies.
- **No third-party tracking.** No Google Analytics, no Meta Pixel, no advertising scripts.
- **No user accounts on our side.** There is no DeLaClaw account system. Authentication is handled entirely by your chosen backend (Supabase auth, or none for local/demo).

## What is stored in your browser

DeLaClaw uses browser-standard storage mechanisms for local preferences:

- **localStorage**: theme preference, language, active tab, stay-connected credentials (your Supabase URL and anon key, if you opt in), tab visibility/order settings.
- **IndexedDB**: offline cache of your database tables, scoped by backend mode. Used to serve read-only data when the network is unavailable. Cleared automatically when you reconnect.
- **Service Worker cache**: static app assets (HTML, CSS, JS, icons) for offline loading. Versioned and replaced on each update.

None of this data leaves your browser.

## External requests

When using DeLaClaw, your browser makes requests to:

- **Your Supabase project** (if using Supabase mode): API calls to your own database.
- **Google Fonts** (`fonts.googleapis.com`): to load the DM Sans typeface. Subject to [Google's privacy policy](https://policies.google.com/privacy).
- **jsDelivr CDN** (`cdn.jsdelivr.net`): to load the Supabase JS client and Three.js. Subject to [jsDelivr's privacy policy](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net).
- **GitHub Pages** (`delaclaw.com`): serves the static app files if you use the hosted version. Subject to [GitHub's privacy policy](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

No other external requests are made.

## Open source

DeLaClaw is licensed under AGPL-3.0. The full source code is available at [github.com/AntGro/DeLaClaw](https://github.com/AntGro/DeLaClaw). You can inspect exactly what the app does, self-host it, and modify it.

## Changes

If this policy changes, the change will be visible in the repository commit history.
