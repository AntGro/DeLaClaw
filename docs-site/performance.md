# Performance Audit

Last updated: 2026-08-21

## Overview

DeLaClaw is a no-build, no-bundle vanilla JS application. Performance characteristics are unusual compared to framework-based SPAs: there is no tree-shaking, no code splitting, and no minification. The tradeoff is zero build complexity and instant development iteration.

## Bundle structure

All files are served as raw, unminified source. No build step, no transpilation.

### JavaScript

Feature modules live in `js/` and adapters in `js/adapters/`. The largest modules are `main.js` (app bootstrap, settings, login, view switching), `i18n.js` (translation strings for 3 languages), `habits.js`, and `flashcards.js`. Sharing logic is split across several modules (`sharing.js`, `sharing-ui.js`, `sharing-drive.js`, `sharing-interface.js`, `sharing-envelope.js`). Other modules handle individual features (todos, projects, vestiaire, birthdays, lists, welcome), drag-and-drop (`item-utils.js`), utilities, and the landing page (hero, logo, storm3d).

### CSS

A single `style.css` covers both themes (dark and light), all pages, and all responsive breakpoints.

### Vendor libraries (self-hosted)

| Library | Location | Notes |
|---|---|---|
| Three.js v0.170.0 | `vendor/three/` | Loaded via import map, used only for the hero landing page |

Both were moved from CDN to self-hosted as part of CSP hardening. See `attributions.md` for versions and licenses.

### External resources (CDN)

| Resource | Blocking? |
|---|---|
| Google Identity Services (`accounts.google.com`) | No (async) |
| Google API client (`apis.google.com`) | No (loaded on demand) |
| DM Sans font (Google Fonts) | Render-blocking (`<link>` in `<head>`, uses `display=swap`) |

## Network requests on initial load

1. `index.html` — render-blocking
2. `style.css` — render-blocking
3. Google Fonts CSS + font files — render-blocking (FOUT mitigated by `display=swap`)
4. `js/main.js` + all ES module imports — deferred (`type="module"`)
5. `manifest.json` + PWA icons
6. Three.js from `vendor/three/` — lazy, only when the hero landing page is shown

After first load, the service worker serves all assets from cache (network-first strategy with precache fallback).

## Render-blocking resources

Two resources block first paint:

1. **`style.css`** — necessary for styled rendering.
2. **Google Fonts** — font swap may cause FOUT (flash of unstyled text).

### Potential improvements (not implemented)

- **Self-host the font**: DM Sans could be served from `vendor/` to eliminate the Google Fonts DNS lookup and make the app fully self-contained.
- **Lazy-load Three.js**: Three.js is only used for the hero landing page effect. Returning users who skip the hero don't need it. A dynamic `import()` on hero visibility would avoid loading it entirely for most sessions.
- **Code splitting**: `demo-data.js` and `demo-chooser.js` are only needed in demo mode. `hero.js`, `storm3d.js`, and `logo.js` are only needed for the landing page. Dynamic imports could defer these.
- **Minification**: a simple minification pass would reduce JS significantly. Not implemented because the project intentionally ships readable source (AGPL philosophy: users can inspect the code they run).
- **i18n splitting**: `i18n.js` includes all 3 languages. Could load only the active language and lazy-load others on switch.

## Runtime performance

- **No virtual DOM**: all renders are full DOM replacements via `.innerHTML`. This is efficient for the current data scale (hundreds of items per table) but would need optimization for thousands.
- **Sequential data loading**: on login, projects and settings are loaded sequentially before the first render. Feature-specific data (todos, habits, etc.) is loaded per-view. Could be parallelized with `Promise.all()` for faster startup.
- **No debouncing on search**: search/filter functions fire on every keypress. For large datasets, debouncing would help.
- **Drag-and-drop**: uses long-press + pointer events with FLIP animation (not native HTML drag). Native `dragstart` is explicitly prevented. Performant for current list sizes.

## Conclusion

For a personal productivity tool with moderate data volumes, performance is adequate. The main bottleneck is initial load time due to render-blocking resources (CSS, fonts) before first paint. After the service worker is installed, subsequent loads are near-instant from cache. The no-build philosophy is a deliberate architectural choice that trades bundle optimization for development simplicity and source transparency.
