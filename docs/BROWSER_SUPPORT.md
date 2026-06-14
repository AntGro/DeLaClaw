# Browser Support

Last updated: 2026-06-08

## Minimum requirements

DeLaClaw uses modern web APIs extensively. The minimum supported browsers are:

| Browser | Minimum version | Release date |
|---|---|---|
| Chrome | 105+ | Aug 2022 |
| Edge | 105+ | Aug 2022 |
| Firefox | 121+ | Dec 2023 |
| Safari | 17.0+ | Sep 2023 |
| Safari iOS | 17.0+ | Sep 2023 |
| Chrome Android | 105+ | Aug 2022 |
| Samsung Internet | 20.0+ | Mar 2023 |

These versions are determined by the most demanding features used (see below). Older browsers will fail silently or show broken layouts.

## JavaScript features used

| Feature | Minimum support | Used for |
|---|---|---|
| ES Modules (`import`/`export`) | All modern | Module system |
| Import Maps (`<script type="importmap">`) | Chrome 89, Firefox 108, Safari 16.4 | Three.js loading |
| `async`/`await` | All modern | Database operations |
| Optional chaining (`?.`) | Chrome 80, Firefox 72, Safari 13.1 | Null-safe property access (79 occurrences) |
| Nullish coalescing (`??`) | Chrome 80, Firefox 72, Safari 13.1 | Default values (6 occurrences) |
| `Proxy` | All modern | db.js activity tracking, offline cache |
| `for...of` | All modern | Iteration (62 occurrences) |
| Template literals | All modern | HTML generation |
| Arrow functions | All modern | Callbacks |
| `Set` / `Map` | All modern | Collections (21 occurrences) |
| Dynamic `import()` | Chrome 63, Firefox 67, Safari 11.1 | Lazy module loading (6 occurrences) |
| IndexedDB | All modern | Offline cache |
| `navigator.onLine` | All modern | Offline detection |
| `PasswordCredential` API | Chrome 51, Firefox: no, Safari: no | Auto-fill (used with feature detection) |

### Notes

- The `PasswordCredential` API is Chrome-only but is wrapped in `if (window.PasswordCredential)` checks, so it degrades gracefully.
- `AbortController` is used in one place but all modern browsers support it.

## CSS features used

| Feature | Minimum support | Potential issues |
|---|---|---|
| `oklch()` color function | Chrome 111, Firefox 113, Safari 15.4 | **Bottleneck for Firefox** (113, May 2023) |
| `color-mix()` | Chrome 111, Firefox 113, Safari 16.2 | 47 occurrences, used for dynamic colors |
| `backdrop-filter` | Chrome 76, Firefox 103, Safari 9 | Prefixed with `-webkit-backdrop-filter` for Safari |
| `:has()` selector | Chrome 105, Firefox 121, Safari 15.4 | **Bottleneck for Firefox** (121, Dec 2023) |
| `clamp()` | Chrome 79, Firefox 75, Safari 13.1 | Responsive typography |
| CSS Custom Properties | All modern | Theme system (595 occurrences) |
| `gap` in Flexbox | Chrome 84, Firefox 63, Safari 14.1 | Layout spacing (199 occurrences) |
| Container queries | Chrome 105, Firefox 110, Safari 16 | 11 occurrences |
| `position: sticky` | All modern | Header |

### Bottleneck analysis

The most demanding features that determine the minimum browser versions:

1. **`:has()` in CSS** -- requires Firefox 121 (Dec 2023), Chrome 105 (Aug 2022), Safari 15.4. This is the strictest requirement for Firefox.
2. **`oklch()` and `color-mix()`** -- require Chrome 111, Firefox 113. Used for accent colors and dynamic theming.
3. **Import Maps** -- require Firefox 108, Safari 16.4.

## Known issues

### Safari

- `backdrop-filter` requires the `-webkit-` prefix, which is already included in the CSS.
- `PasswordCredential` API is not supported; login auto-fill falls back to browser password manager.

### Firefox

- `:has()` requires version 121+ (Dec 2023). Earlier versions will miss CSS rules using `:has()`, which may cause minor styling differences but should not break functionality.
- `oklch()` requires version 113+ (May 2023). Colors using `oklch()` will fall through to fallback values or be invisible.

### Older browsers

- Internet Explorer is not supported (no ES modules, no Proxy, no CSS custom properties).
- Pre-Chromium Edge is not supported.

## PWA support

The PWA (installable app) works on:

- Chrome (desktop and Android)
- Edge (desktop)
- Safari (iOS 16.4+ for full PWA support)
- Samsung Internet
- Firefox: limited PWA support on Android, none on desktop

## Recommendations for future work

1. **Add fallback values for `oklch()`**: where `oklch()` is used, add a preceding `color:` rule with an `rgb()` fallback for older browsers.
2. **Minimize `:has()` usage**: the 2 occurrences of `:has()` could potentially be replaced with JavaScript-driven class toggles to widen Firefox support.
3. **Test matrix**: set up automated cross-browser testing (e.g., BrowserStack or Playwright with multiple browsers) as part of CI/CD.
