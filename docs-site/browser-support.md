# Browser Support

Last updated: 2026-08-21

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
| Optional chaining (`?.`) | Chrome 80, Firefox 72, Safari 13.1 | Null-safe property access |
| Nullish coalescing (`??`) | Chrome 80, Firefox 72, Safari 13.1 | Default values |
| `Proxy` | All modern | db.js activity tracking, offline cache |
| `for...of` | All modern | Iteration |
| Template literals | All modern | HTML generation |
| Arrow functions | All modern | Callbacks |
| `Set` / `Map` | All modern | Collections |
| Dynamic `import()` | Chrome 63, Firefox 67, Safari 11.1 | Lazy module loading |
| `crypto.randomUUID()` | Chrome 92, Firefox 95, Safari 15.4 | ID generation (items, completions, shared entries) |
| `crypto.subtle` (WebCrypto) | All modern | AES-GCM encryption, SHA-256 hashing (`crypto-sync.js`, `auth.js`) |
| `ResizeObserver` | Chrome 64, Firefox 69, Safari 13.1 | Layout observation |
| IndexedDB | All modern | Offline cache |
| `navigator.onLine` | All modern | Offline detection |
| `AbortController` | All modern | Fetch cancellation |
| `PasswordCredential` API | Chrome 51, Firefox: no, Safari: no | Auto-fill (used with feature detection) |

### Notes

- The `PasswordCredential` API is Chrome-only but is wrapped in `if (window.PasswordCredential)` checks, so it degrades gracefully.
- `crypto.randomUUID()` has no fallback — browsers below the minimum will break on item creation.

## CSS features used

| Feature | Minimum support | Potential issues |
|---|---|---|
| `oklch()` color function | Chrome 111, Firefox 113, Safari 15.4 | **Bottleneck for Firefox** (113, May 2023) |
| `color-mix()` | Chrome 111, Firefox 113, Safari 16.2 | Used extensively for dynamic category/accent colors |
| `backdrop-filter` | Chrome 76, Firefox 103, Safari 9 | Needs `-webkit-backdrop-filter` for Safari (see Known issues) |
| `:has()` selector | Chrome 105, Firefox 121, Safari 15.4 | **Bottleneck for Firefox** (121, Dec 2023) |
| `clamp()` | Chrome 79, Firefox 75, Safari 13.1 | Responsive typography |
| CSS Custom Properties | All modern | Theme system |
| `gap` in Flexbox | Chrome 84, Firefox 63, Safari 14.1 | Layout spacing |
| `container-type` | Chrome 105, Firefox 110, Safari 16 | Used on `.project-card` for inline-size containment |
| `position: sticky` | All modern | Header |

### Bottleneck analysis

The most demanding features that determine the minimum browser versions:

1. **`:has()` in CSS** — requires Firefox 121 (Dec 2023), Chrome 105 (Aug 2022), Safari 15.4. This is the strictest requirement for Firefox. Used across multiple pages for conditional styling (inline edit states, banner stacking, action grid layouts).
2. **`oklch()` and `color-mix()`** — require Chrome 111, Firefox 113. Used for accent colors and dynamic theming.
3. **Import Maps** — require Firefox 108, Safari 16.4.

## Known issues

### Safari

- `backdrop-filter` requires the `-webkit-` prefix. Most usages include it, but two rules are currently missing the prefix (`.header-actions .btn` and `.project-card-header .fc-practice-btn`). These cause no visible breakage because one is `backdrop-filter: none` and the other is a minor blur on a button overlay.
- `PasswordCredential` API is not supported; login auto-fill falls back to browser password manager.

### Firefox

- `:has()` requires version 121+ (Dec 2023). Earlier versions will miss CSS rules using `:has()`, which may cause styling issues — particularly around inline edit backgrounds, banner stacking, and action grid layouts.
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
2. **Add missing `-webkit-backdrop-filter` prefixes**: two rules are missing the vendor prefix.
3. **Test matrix**: set up automated cross-browser testing (e.g., BrowserStack or Playwright with multiple browsers) as part of CI/CD.
