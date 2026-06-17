# Commit Checklist

Every commit message must include a `Checked:` trailer confirming that the
committer reviewed the impact of their changes on each area below. Mark items
that are genuinely not affected with `[~]` (not applicable).

## Format

```
feat: add foo bar

Description of changes.

Checked: versioning, i18n, docs, readme, checklist, tests, welcome, prompts, xss
```

Items not relevant to this commit:

```
Checked: versioning, i18n, docs [~], readme [~], checklist [~], tests, welcome [~], prompts [~], xss
```

## Checklist items

| Tag | What to check |
|---|---|
| **versioning** | The `latest` bump is automated by the pre-commit hook — this item is about **compatibility judgment**. Does this commit change the DB schema (new table, new column, renamed field)? If so: should `latest_compat` move (new features won't work on older DBs)? Should `latest_compat_deprec` move (the app will break on older DBs)? Does `supabase_schema.sql` need updating? Does a migration file need to be added? |
| **i18n** | All new user-facing strings go through `t()` in `js/i18n.js`. Keys added for all three languages (EN, FR, ES). No hardcoded text in JS/HTML that the user will see. |
| **docs** | Does this change affect anything documented in `docs-site/`? Setup steps, architecture, privacy implications (new external requests, new data storage), browser support, accessibility, third-party dependencies, or attributions. |
| **readme** | Does this change affect the `README.md`? New features, changed backend modes, file structure changes, setup steps, feature list, file tree. |
| **checklist** | Does this change introduce a new area that future commits should review? If so, add the new tag here and to the `commit-msg` hook's `REQUIRED_TAGS` array. |
| **tests** | Not "do tests pass" (CI handles that) — **should the test pool change?** Does this commit add new logic, new UI behavior, new adapter methods, or new edge cases that need test coverage? Were existing tests invalidated by the change? If tests were added or removed, update the test count in `docs-site/contributing.md`. |
| **welcome** | Does this change affect data shown on the Welcome page (birthdays, habits, flashcards, projects, stats)? If so, verify `renderWelcome()` / `refreshWelcome()` still render correctly with the change. |
| **prompts** | Does this change affect how tasks, habits, or flashcards behave? If so, check `prompts` table entries and `CLAW.md` (when added) for alignment — the AI agent reads those to understand what to do. |
| **xss** | All user-sourced data (`name`, `text`, `note`, `brand`, `frequency_rule`, etc.) must be wrapped in `esc()` when interpolated into `innerHTML` / template literals. `renderMd()` and `truncateWithShowMore()` already call `esc()` internally — no double-wrapping for fields passed through those. `showDeleteConfirm` uses `.textContent` and is safe without `esc()`. |

## Skipping the hook

For exceptional cases (e.g. automated tooling, bulk reformats):

```bash
git commit --no-verify -m "chore: bulk reformat"
```

Use sparingly. The checklist exists to prevent regressions.
