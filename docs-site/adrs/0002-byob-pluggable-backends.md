# ADR 0002: BYOB — pluggable backends via db.js proxy

Date: 2026-07-20
Status: Accepted

## Context

Personal OS must have 0 scaling cost for the author and data sovereignty for the user. Hosting user data centrally would create cost, liability, and privacy risk.

Requirement: user brings their own storage, author hosts only static files.

Options considered: Supabase (PostgREST), Google Drive (files as tables), local Bun+SQLite (self-host anywhere), in-memory Demo. Need one surface for all, so views never branch on backend.

## Decision

- All business logic talks to `js/db.js` proxy, never directly to Supabase/Drive
- Each adapter in `js/adapters/` implements same surface: `.from(table).select/insert/update/delete` + auth helpers
  - `supabase` — cloud default, anon key in both `apikey` + `Authorization: Bearer` (Supabase quirk)
  - `rest` — Bun server `server/server.js` + SQLite, PostgREST-compatible
  - `drive` — Google Drive folder with JSON files + sharing protocol
  - `demo` — in-memory, seeded localized datasets, backend-scoped localStorage via `swapLsScope`
  - `offline-cache` — IndexedDB wrapper around any adapter, transparent
- Sharing protocols (Drive + Supabase) implement common interface — no `if (backend === 'supabase')` in views, add method to adapter instead
- Base schema + migrations runnable in both Supabase SQL editor and local SQLite (`server/schema.sql`)

## Consequences

- Positive: zero scaling cost — author only serves GitHub Pages, users pay their own storage (free tier enough)
- Positive: views stay backend-agnostic, easy to test/demo, offline-first via cache
- Positive: demo mode isolated via scoped localStorage (16 keys) — no leak of real data
- Negative: adapter parity must be maintained manually, each new table needs 4 implementations + migrations
- Neutral: `VERSION` `latest_compat` gates schema changes across all backends

## Alternatives considered

- Single Supabase-only — rejected: central cost, not self-hostable, privacy
- PocketBase / Firebase — rejected: auth complexity (Neon JWKS), vendor lock-in
- Backend if-checks in views — rejected: leaks abstraction, maintenance burden (see AGENTS.md 1.3)
