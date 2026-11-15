# DeLaClaw Chrome extension

Thin v1 (spec: `~/workspace/your_files/delaclaw-chrome-extension-spec/`):
popup quick-add TODO, page capture, due-habit Done, open app. Two
variants from one source — **DeLaClaw** (Production, `DeLaClaw/`) and
**DeLaClaw Dev** (Dev, `DeLaClawDev/`). Auth is the implicit flow with
the web app's existing OAuth client (no secret, no refresh token);
silent re-auth is still unproven — validate it during the week of
unpacked use.

## Layout

- `src/` — the source. `manifest.json` and `variant.js` are templates;
  the packager stamps the per-variant values. Never hand-edit anything
  under `dist/`.
- `dist/prod/`, `dist/dev/` — stamped, loadable outputs (generated,
  committed). Load one unpacked in Chrome.
- `package.mjs` — copy-and-stamp packaging (not a build step).

## Build

```sh
node extension/package.mjs
```

Stamps the repo `VERSION` into both manifests, the known schema
version (latest `DRIVE_MIGRATIONS` key) into `variant.js`, copies the
app's pure modules (`js/frequency-rule.js`, `js/calendar-pure.js`,
`migrations/version-compare.js`) and the theme variables from
`style.css`, and downscales the icons. It fails loudly if a pinned key
does not derive its registered extension ID.

## Load unpacked

1. `chrome://extensions` → Developer mode on.
2. Load unpacked → `extension/dist/prod` (and `dist/dev` for the Dev
   variant). The two install side by side.
3. Click the toolbar icon → Sign in with Google
   (`antoine.grosnit70@gmail.com`), confirm the account shown, then
   quick-add and mark habits done.
4. Verify the shortcut registered: `chrome://extensions/shortcuts`
   (Ctrl+Shift+Y Prod / Ctrl+Shift+U Dev; Command+Shift on Mac).

First sign-in needs the `DeLaClaw/` folder to exist in the account —
open delaclaw.com and sign in there first if the popup says the folder
is missing. The extension never creates folders.

## Tests

Extension tests live in the repo suite (`node tests/tests.js`,
section "Chrome extension"): manifest shape, permissions, redirect-URI
IDs derived from the pinned keys, folder resolution per variant,
version stamping, and the pure data contracts (TODO row shape,
pending-only sort_order, due-list filter, next_due recompute against
the app's algorithm, schema-version guard, capture escaping).

## Notes

- The extension writes whole-file read-modify-write with an md5
  pre-check. There is no ETag: Drive returns none, so the app's
  If-Match/412 path is dead (contracts §2).
- The popup is UI only; auth and all Drive I/O run in the service
  worker. A failed write keeps the typed text and shows the error.
- Data contracts: `~/workspace/goals/delaclaw-chrome-extension/files/delaclaw-extension-data-contracts.md`.
- The `__shared__` category and the General row are excluded from the
  category picker; the picker defaults to General (spec §5/§6 tension,
  resolved as: General is the preselected default, not a listed user
  category — flag it if that reading is wrong).
- Snoozed habits are hidden from the due list (decided 15 Nov 2026).
