# Commit Checklist

Every commit message must include a `Checked:` trailer confirming that the
committer reviewed the impact of their changes on each area below. Mark items
that are genuinely not affected with `[~]` (not applicable).

## Format

```
feat: add foo bar

Description of changes.

Checked: versioning, i18n, docs, readme, checklist, tests, welcome, prompts, xss, no-emoji
```

Items not relevant to this commit:

```
Checked: versioning, i18n, docs [~], readme [~], checklist [~], tests, welcome [~], prompts [~], xss, no-emoji
```

## Checklist items

| Tag | What to check |
|---|---|
| **versioning** | `VERSION` file bumped (`latest`). If DB schema changed: bump `latest_compat` / `latest_compat_deprec` as needed. `supabase_schema.sql` schema_version aligned. Migration file added if needed. |
| **i18n** | All new UI strings go through `t()` in `js/i18n.js`. Keys added for all supported languages (EN, FR, ES). No hardcoded user-facing text in JS/HTML. |
| **docs** | `docs-site/` updated if behavior, setup steps, architecture, privacy implications, browser support, accessibility, or third-party dependencies changed. |
| **readme** | `README.md` updated if features, backend modes, file structure, or setup steps changed. |
| **checklist** | This checklist itself — does the change introduce a new area that future commits should review? If so, add it here and to the `commit-msg` hook. |
| **tests** | New logic has tests. Existing tests still pass (`node tests/tests.js`). Test count in `docs-site/contributing.md` updated if tests were added/removed. |
| **welcome** | If the change affects data shown on the Welcome page (birthdays, habits, flashcards, projects, stats), verify `renderWelcome()` / `refreshWelcome()` still render correctly. |
| **prompts** | If task/habit/flashcard behavior changed, check `prompts` table entries and `CLAW.md` (when added) for alignment. |
| **xss** | All user-sourced data (`name`, `text`, `note`, `brand`, `frequency_rule`, etc.) wrapped in `esc()` when interpolated into `innerHTML` / template literals. `renderMd()` and `truncateWithShowMore()` already call `esc()` internally — no double-wrapping for fields passed through those. `showDeleteConfirm` uses `.textContent` and is safe without `esc()`. |
| **no-emoji** | No emoji in UI elements. Use Lucide icons via `lucideIcon()` in `js/icons.js`. |

## Skipping the hook

For exceptional cases (e.g. automated tooling, bulk reformats):

```bash
git commit --no-verify -m "chore: bulk reformat"
```

Use sparingly. The checklist exists to prevent regressions.
