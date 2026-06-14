# Performance Audit

Last updated: 2026-06-08

## Overview

DeLaClaw is a no-build, no-bundle vanilla JS application. Performance characteristics are unusual compared to framework-based SPAs: there is no tree-shaking, no code splitting, and no minification. The tradeoff is zero build complexity and instant development iteration.

## Bundle size

All files are served as raw, unminified source. Sizes below are uncompressed / gzip-estimated.

### JavaScript (25 files)

| File | Raw | Notes |
|---|---|---|
| `style.css` | 131 KB (~24 KB gzip) | All styles for both themes |
| `js/main.js` | 82 KB (~20 KB gzip) | App bootstrap, settings, login, view switching |
| `js/habits.js` | 78 KB | Habit tracking |
| `js/flashcards.js` | 72 KB | Flashcard SRS + text memorization |
| `js/i18n.js` | 61 KB | Translation strings (3 languages) |
| `js/demo-data.js` | 50 KB | Sample data for demo mode |
| `js/todos.js` | 43 KB | TODO management |
| `js/projects.js` | 42 KB | Project boards |
| `js/welcome.js` | 39 KB | Today dashboard |
| `js/vestiaire.js` | 33 KB | Wardrobe inventory |
| `js/birthdays.js` | 33 KB | Birthday tracker |
| `js/demo-chooser.js` | 24 KB | Demo dataset selector |
| `js/lists.js` | 22 KB | Checklists |
| `js/icons.js` | 18 KB | Lucide icon SVG paths |
| `js/hero.js` | 18 KB | Landing page animations |
| `js/utils.js` | 15 KB | Shared utilities |
| `js/item-utils.js` | 14 KB | Drag-and-drop, inline editing |
| `js/logo.js` | 9 KB | Logo animation |
| Other adapters/modules | ~46 KB | db.js, supabase.js, rest.js, demo.js, offline-cache.js, storm3d.js, version.js |

**Total JavaScript**: ~686 KB raw, ~163 KB gzip  
**Total CSS**: ~131 KB raw, ~24 KB gzip  
**Total HTML**: ~40 KB raw, ~9 KB gzip

**Grand total (application code)**: ~857 KB raw, ~196 KB gzip

### Static assets

| Asset | Size |
|---|---|
| `icons/icon-512.png` | 110 KB |
| `icons/icon-192.png` | 22 KB |
| `icons/favicon.png` | 22 KB |
| `manifest.json` | < 1 KB |

### External resources (CDN)

| Resource | Size (approx) | Blocking? |
|---|---|---|
| Supabase JS v2 (`@supabase/supabase-js`) | ~115 KB gzip | Yes (loaded via `<script>` in `<head>`) |
| Three.js v0.170.0 | ~160 KB gzip | No (loaded via import map, used only for hero) |
| DM Sans font (4 weights) | ~100 KB | Render-blocking (linked in `<head>`) |

## Network requests on initial load

1. `index.html` (40 KB)
2. `style.css` (131 KB) -- render-blocking
3. Google Fonts CSS + font files (~100 KB) -- render-blocking
4. `@supabase/supabase-js` from jsDelivr (~115 KB) -- render-blocking `<script>`
5. `js/main.js` + all ES module imports (25 files, ~686 KB total) -- deferred (`type="module"`)
6. `manifest.json` + icons (~155 KB)
7. Three.js from jsDelivr (~160 KB) -- lazy, only when hero page is shown

After first load, the service worker serves all assets from cache (network-first strategy with precache fallback).

## Render-blocking resources

Three resources block first paint:

1. **`style.css`** -- necessary for styled rendering
2. **Google Fonts** -- font swap may cause FOUT (flash of unstyled text)
3. **`@supabase/supabase-js`** -- loaded synchronously in `<head>`

### Potential improvements (not implemented)

- **Load Supabase JS with `defer` or `async`**: move `<script src="...supabase-js">` to end of body or add `defer`. Requires ensuring the global `window.supabase` is available before the Supabase adapter initializes (the adapter is only created on login, so the timing should work).
- **Preload font with `font-display: swap`**: Google Fonts already uses `display=swap` in the URL. Could self-host the font to eliminate the DNS lookup.
- **Lazy-load Three.js**: currently loaded via import map; Three.js is only used for the hero landing page effect. Consider dynamic `import()` so it only loads when the hero is visible. This would save ~160 KB on app load for returning users who skip the hero.
- **Code splitting (future)**: `demo-data.js` (50 KB) and `demo-chooser.js` (24 KB) are only needed in demo mode. `hero.js` (18 KB), `storm3d.js` (6 KB), and `logo.js` (9 KB) are only needed for the landing page. Dynamic imports could defer these.
- **Minification**: a simple minification pass would reduce JS by ~40-50%. Not implemented because the project intentionally ships readable source (AGPL philosophy: users can inspect the code they run).
- **i18n splitting**: `i18n.js` (61 KB) includes all 3 languages. Could load only the active language and lazy-load others on switch.

## Runtime performance

- **No virtual DOM**: all renders are full DOM replacements via `.innerHTML`. This is efficient for the current data scale (hundreds of items per table) but would need optimization for thousands.
- **Sequential data loading**: on login, 8+ sequential `await` calls fetch all tables. Could be parallelized with `Promise.all()` for faster startup.
- **No debouncing on search**: the `filterProjects(event)` etc. functions fire on every keypress. For large datasets, debouncing would help.
- **Drag-and-drop**: uses native HTML drag events, which are performant.

## Conclusion

For a personal productivity tool with moderate data volumes, performance is adequate. The main bottleneck is initial load time due to render-blocking CDN resources (~375 KB gzip before first paint). After the service worker is installed, subsequent loads are near-instant from cache. The no-build philosophy is a deliberate architectural choice that trades bundle optimization for development simplicity and source transparency.
