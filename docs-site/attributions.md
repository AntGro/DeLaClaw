# Third-Party Attributions

DeLaClaw uses the following third-party software and assets. No npm dependencies are installed at runtime. Most external libraries are self-hosted in `vendor/` for CSP hardening and offline PWA support; only Google Identity must remain on CDN per Google ToS (no SRI allowed).

Vendor versions are checked weekly by the `vendor-check` GitHub Action, which opens a PR to `dev` when new releases are available. Manual updates: `scripts/update-vendor.sh [supabase_ver] [three_ver]`.

## Libraries

### Supabase JS Client
- **Package**: `@supabase/supabase-js` v2.110.6
- **License**: MIT
- **Source**: https://github.com/supabase/supabase-js
- **Loaded from**: `vendor/supabase.js` (self-hosted UMD copy, originally `cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.6/dist/umd/supabase.js`)
- **Purpose**: database client for Supabase backend mode (PostgREST queries, real-time subscriptions)

### Three.js
- **Package**: `three` v0.170.0
- **License**: MIT
- **Source**: https://github.com/mrdoob/three.js
- **Loaded from**: `vendor/three/build/three.module.js` + `vendor/three/examples/jsm/utils/BufferGeometryUtils.js` (self-hosted ESM copy, originally `cdn.jsdelivr.net/npm/three@0.170.0`)
- **Purpose**: 3D extruded heptagram on the landing/hero page

### Google Identity Services
- **Library**: GIS (`accounts.google.com/gsi/client`)
- **License**: Google APIs Terms of Service
- **Source**: https://developers.google.com/identity
- **Loaded from**: `accounts.google.com/gsi/client` (must stay on CDN per ToS, documented CSP exception)
- **Purpose**: OAuth 2.0 token flow for Google Drive backend mode

### Google API Client (GAPI)
- **Library**: `apis.google.com/js/api.js`
- **License**: Google APIs Terms of Service
- **Source**: https://developers.google.com/api-client-library/javascript
- **Loaded from**: `apis.google.com` (CDN, loaded on demand for Drive backend)
- **Purpose**: Google Drive API file operations (read/write/list user app data)

## Fonts

### DM Sans
- **License**: SIL Open Font License 1.1
- **Source**: https://fonts.google.com/specimen/DM+Sans
- **Designers**: Colophon Foundry, Jonny Pinhorn, Indian Type Foundry
- **Loaded from**: `fonts.googleapis.com`
- **Purpose**: primary typeface throughout the app

### DM Mono
- **License**: SIL Open Font License 1.1
- **Source**: https://fonts.google.com/specimen/DM+Mono
- **Designers**: Colophon Foundry, Jonny Pinhorn
- **Purpose**: monospace typeface for code/paste areas (referenced in CSS font stack, falls back to system monospace)

## Icons

### Lucide
- **License**: ISC
- **Source**: https://github.com/lucide-icons/lucide
- **Purpose**: all UI icons throughout the app
- **Note**: icon SVG path data is embedded directly in `js/icons.js` (not loaded from CDN). Only a subset of the full icon set is included.

### theSVG
- **License**: MIT (codebase and tooling); individual brand icons remain trademarks of their respective owners
- **Source**: https://github.com/glincker/thesvg
- **Website**: https://thesvg.org
- **Purpose**: brand SVG icons for agent name pills (Claude, Codex, Grok, Cursor, Hermes, OpenClaw), the Google Drive backend logo, and the Google Calendar Settings icon
- **Loaded from**: `icons/brand/` (self-hosted SVG files, sourced from thesvg.org mono/default variants)

### Dashboard Icons (homarr-labs)
- **License**: MIT
- **Source**: https://github.com/homarr-labs/dashboard-icons
- **Purpose**: brand SVG icon for NanoClaw agent pill
- **Loaded from**: `icons/brand/nanoclaw.svg` (self-hosted, sourced from dashboard-icons collection)

## Docs Site

The documentation site (`docs-site/`) uses the following libraries loaded from CDN:

### Docsify
- **Package**: `docsify` v4
- **License**: MIT
- **Source**: https://github.com/docsifyjs/docsify
- **Plugins**: search, copy-code, pagination
- **Purpose**: static documentation site generator (SPA from Markdown)

### docsify-themeable
- **Package**: `docsify-themeable`
- **License**: MIT
- **Source**: https://github.com/jhildenbiddle/docsify-themeable
- **Purpose**: theme framework for the docs site (theme-simple)

### Prism.js
- **Package**: `prismjs` v1
- **License**: MIT
- **Source**: https://github.com/PrismJS/prism
- **Purpose**: syntax highlighting in docs code blocks (JavaScript, SQL, Bash, JSON)

### Mermaid
- **Package**: `mermaid` v10
- **License**: MIT
- **Source**: https://github.com/mermaid-js/mermaid
- **Purpose**: renders flowchart and sequence diagrams in docs (sync architecture)
