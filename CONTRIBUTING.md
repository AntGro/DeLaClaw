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
- Every commit to `main` must bump the `latest` field in `VERSION` (the pre-commit hook enforces this).

### Pull requests

- One logical change per PR.
- All tests must pass (`node tests/tests.js` -- 54 tests currently).
- The PR description should explain *what* changed and *why*.
- Screenshots or before/after comparisons for UI changes.

## Testing

Run the full test suite before submitting:

```bash
node tests/tests.js
```

Tests include:
- Unit tests for core logic (version parsing, drag-and-drop, utilities)
- Adapter compliance tests (all three backends implement the same interface)
- REST server integration tests (requires Bun)
- Browser-based end-to-end tests (requires Playwright -- `npx playwright install chromium`)

All 54 tests must pass. If you add a new feature, add tests for it.

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

## Architecture notes

Before diving into the code, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an overview of the adapter pattern, state management, and file structure.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
