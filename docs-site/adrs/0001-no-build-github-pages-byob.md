# ADR 0001: No build step, vanilla JS, GitHub Pages + BYOB

Date: 2026-07-20
Status: Accepted

## Context

Goal was a personal life OS you can run forever with zero recurring cost:

- Host cost must be 0 → GitHub Pages serves static `index.html`, no server to run for the author
- Scaling cost must be 0 → BYOB (bring your own backend): Supabase (free tier), Local Bun+SQLite, Google Drive, or in-memory Demo. Author pays zero per user.
- Longevity matters — code should be readable and forkable in 10 years, no framework churn, no `npm install` to audit.

Framework + bundler would add build complexity, supply-chain risk, and break the GitHub Pages zero-host model.

## Decision

- Single-page app, vanilla JS ES modules, no build step
- `index.html` is the entry — open it via GitHub Pages, no bundler
- Vendor JS self-hosted in `vendor/` (supabase, three) except Google Identity (ToS requires CDN, explicitly allowed via CSP)
- PWA via `sw.js` with exact `PRECACHE_URLS`, `CACHE_VERSION` bumped by hook
- Backend abstraction via `js/db.js` proxy — same surface for Supabase / REST / Drive / Demo (BYOB)

## Consequences

- Positive: clone → open, zero host cost (Pages), zero scaling cost (BYOB), low supply-chain risk, easy XSS audit (`esc()`)
- Positive: PWA install fails loudly if precached URL 404 — forces exact list
- Negative: no JSX/HMR, manual DOM templating, discipline required to reuse components (`.page-empty-state`, `.modal`, `.view-tab`, etc.)
- Neutral: `.agents/CODEMAP.json` indexes `js/*.js` directly, no build artifacts to ignore

## Alternatives considered

- Vite + React — rejected: build step breaks zero-cost Pages model, bundle churn
- Svelte / Next — rejected: compiler/framework lock-in, server cost
- All-CDN vendor — rejected: CSP sec-004 requires self-host, except GSI exception documented
