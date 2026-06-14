# Third-Party Attributions

DeLaClaw uses the following third-party software and assets. No npm dependencies are installed; all external libraries are loaded from CDN at runtime.

## Libraries

### Supabase JS Client
- **Package**: `@supabase/supabase-js` v2
- **License**: MIT
- **Source**: https://github.com/supabase/supabase-js
- **Loaded from**: `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- **Purpose**: database client for Supabase backend mode (PostgREST queries, real-time subscriptions)

### Three.js
- **Package**: `three` v0.170.0
- **License**: MIT
- **Source**: https://github.com/mrdoob/three.js
- **Loaded from**: `cdn.jsdelivr.net/npm/three@0.170.0`
- **Purpose**: 3D particle effect on the landing/hero page

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
