# ADR 0009: Hosting on Cloudflare Pages

Date: 2026-10-23 (move carried out June 2026)
Status: Accepted — supersedes the hosting part of ADR 0001

## Context

ADR 0001 put DeLaClaw on GitHub Pages: zero host cost, static files only. Since then the workflow has settled into two long-lived branches — `dev` for day-to-day work and `main` for production — and that workflow needs two things GitHub Pages does not offer for one repository: a standing preview deployment of the `dev` branch under its own URL, and production on the custom domain served from `main`.

In June 2026 hosting moved to Cloudflare Pages.

## Decision

- Host the app on **Cloudflare Pages**, built from the `AntGro/DeLaClaw` repository with **no build command** — the repository root is served as static files, exactly as before.
- `main` deploys production: [delaclaw.com](https://delaclaw.com) (and `delaclaw.pages.dev`).
- `dev` deploys the preview: `dev.delaclaw.pages.dev`. All new work lands on `dev` first and is merged to `main` only when tested and stable.
- ADR 0001's other decisions are unchanged: vanilla JS, ES modules, no build step, BYOB backends, zero recurring host cost.

## Consequences

- Positive: per-branch preview URL makes the dev → main workflow practical — every change is testable on a real deployment before it reaches production.
- Positive: still zero host cost and zero build infrastructure; the no-build principle survives intact.
- Neutral: the `CNAME` file remains in the repository as a leftover GitHub Pages artifact; Cloudflare Pages does not use it.
- Neutral: GitHub remains the code host — only static hosting moved.

## Alternatives considered

- Stay on GitHub Pages — rejected: one deployment per repository, so no standing `dev` preview alongside production.
- Self-host the static files — rejected: recurring cost and maintenance for zero benefit over a static host.
