# Contributing to DeLaClaw

Thanks for your interest in contributing. This document covers the ground rules.

## Getting started

1. Fork the repository and clone it locally
2. Install [Bun](https://bun.sh) (needed for the local backend and some tests)
3. Set up the git hooks:
   ```bash
   git config core.hooksPath .githooks
   ```
4. Run the tests to make sure everything works:
   ```bash
   node tests/tests.js
   ```

## Code style

DeLaClaw is vanilla JavaScript by design. No frameworks, no build step, no transpilation.

### JavaScript

- **No frameworks or libraries** for UI rendering. The app uses ES modules loaded directly by the browser.
- Use `const` and `let`, never `var`.
- Prefer early returns over deep nesting.
- Keep functions focused. If a function is doing too much, split it.
- Template literals for HTML generation are fine (the app uses them extensively).

### CSS

- **No inline styles** in JavaScript. Use CSS classes defined in `style.css`.
  - Exception: dynamic values that must be computed at runtime (e.g. `style.display = 'none'` for show/hide toggling, or `style.setProperty('--var', value)` for CSS custom properties).
- Use CSS custom properties (`var(--name)`) for colors, spacing, and theme-dependent values.
- Dark and light themes are handled via CSS. Both must work.

### UI conventions

- **No emoji in the interface.** Use [Lucide](https://lucide.dev) icons via the `lucideIcon()` helper in `js/icons.js`.
- All UI text must be in English and go through the `t()` function in `js/i18n.js` for translation support.
- Keep the interface clean and information-dense. No decorative elements.

## Git workflow

### Branches

- Work on feature branches. Name them descriptively: `fix/offline-banner`, `feat/export-csv`, `docs/setup-guide`.
- Never force-push to `main`.

### Commits

- Keep commit messages short and factual. No emoji, no conventional-commit prefixes required (though `fix:`, `feat:`, `docs:` are fine).
- Every commit must bump the `latest` field in `VERSION` (the pre-commit hook enforces this).
- Every commit must include a `Checked:` trailer listing the impact areas reviewed (the commit-msg hook enforces this). See [COMMIT_CHECKLIST.md](/COMMIT_CHECKLIST.md) for the full list.

### Pull requests

- One logical change per PR.
- All tests must pass (`node tests/tests.js` -- 76 tests currently).
- The PR description should explain *what* changed and *why*.
- Screenshots or before/after comparisons for UI changes.

## Testing

Run the full test suite before submitting:

```bash
node tests/tests.js
```

Tests include:
- Unit tests for core logic (version parsing, drag-and-drop, utilities)
- Adapter compliance tests (all four backends implement the same interface)
- REST server integration tests (requires Bun)
- Browser-based end-to-end tests (requires Playwright -- `npx playwright install chromium`)

All 76 tests must pass. If you add a new feature, add tests for it.

## What contributions are welcome

### Good first issues

If you are new to the project, look for issues labeled `good first issue`. Typical examples:
- Adding missing ARIA labels to interactive elements
- Adding a new translation key to `js/i18n.js`
- Fixing a CSS inconsistency between dark and light themes
- Improving mobile responsiveness for a specific view

### Feature contributions

Larger features should be discussed in an issue before starting work. This avoids wasted effort if the feature does not fit the project direction. Examples that would benefit from discussion:
- New modules (new tabs/views)
- Changes to the adapter interface
- New backend adapters
- Significant UI redesigns

### Bug reports

File an issue with:
- Steps to reproduce
- Expected vs. actual behavior
- Backend mode (Supabase / local / demo)
- Browser and OS
- Screenshots if applicable

### Documentation

Documentation improvements are always welcome. The main docs live in `docs/` and the README.

## Code review

- All PRs are reviewed before merge.
- Reviews focus on correctness, consistency with existing patterns, and test coverage.
- Nitpicks are marked as such and are non-blocking.

## Releasing

All changes land on `dev` first, which auto-deploys to [dev.delaclaw.pages.dev](https://dev.delaclaw.pages.dev). When `dev` is stable, merge it into `main` (which deploys to [delaclaw.com](https://delaclaw.com) via GitHub Pages).

### Pre-release checklist

- All tests pass
- Preview on [dev.delaclaw.pages.dev](https://dev.delaclaw.pages.dev) looks correct
- `VERSION` has the right `latest`, `latest_compat`, and `latest_compat_deprec`
- If DB schema changed: migration entries exist for Local (`local-migrations.js`) and Drive (`drive-migrations.js`), and `sql/supabase_schema.sql` is updated. See [MIGRATION_GUIDE.md](/migrations/MIGRATION_GUIDE.md)
- i18n: all new strings present in EN, FR, ES
- No hardcoded dark-mode colors — all via CSS variables
- Responsive: tested on mobile viewport (≤ 480px)
- `README.md` updated if features, file tree, or setup steps changed
- `docs-site/` pages updated if architecture, privacy, or setup changed

### Post-release smoke test

- Login with each backend (Supabase, Google Drive, Local, Demo)
- Check the Today page loads
- Quick-add a TODO and delete it
- If a migration was included, verify the schema banner appears on old DBs and the migration runs cleanly

### Hotfix workflow

For urgent fixes to `main` that can't wait for the normal `dev` cycle: branch off `main`, fix, merge back into `main`, then backport the fix into `dev`.

## Architecture notes

Before diving into the code, read [docs-site/architecture.md](docs-site/architecture.md) for an overview of the adapter pattern, state management, and file structure.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
