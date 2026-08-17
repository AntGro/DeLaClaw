# Third-Party Attributions

DeLaClaw uses the following third-party software and assets. No npm dependencies are installed at runtime. Most external libraries are self-hosted in `vendor/` for CSP hardening and offline PWA support; only Google Identity must remain on CDN per Google ToS (no SRI allowed).

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
- **Purpose**: monospace typeface used in code/paste areas (referenced in CSS, loaded via system fallback)

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
- **Purpose**: brand SVG icons for agent name pills (Claude, Codex, Grok, Cursor, Hermes, OpenClaw)
- **Loaded from**: `icons/brand/` (self-hosted SVG files, sourced from thesvg.org mono/default variants)
