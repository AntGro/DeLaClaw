# Release Guide

How to ship a new version of DeLaClaw.

## Branches

| Branch | Purpose | Auto-deploy |
|---|---|---|
| `dev` | Development — all new work lands here first | [dev.delaclaw.pages.dev](https://dev.delaclaw.pages.dev) (Cloudflare Pages) |
| `main` | Stable — user-facing release | [delaclaw.com](https://delaclaw.com) (GitHub Pages) |

Never commit directly to `main`. All changes go through `dev` first.

---

## Development workflow

1. **Create a feature branch** off `dev`:
   ```bash
   git checkout dev && git pull origin dev
   git checkout -b feat/my-feature
   ```

2. **Work on the branch**, committing with the [Commit Checklist](COMMIT_CHECKLIST.md):
   ```bash
   git config core.hooksPath .githooks   # required once per clone
   # bump `latest` in VERSION before each commit
   git add -A && git commit -m "feat: description"
   ```

3. **Merge into `dev`**:
   ```bash
   git checkout dev && git pull origin dev
   git merge feat/my-feature
   git push origin dev
   ```

4. **Verify** on [dev.delaclaw.pages.dev](https://dev.delaclaw.pages.dev).

5. **Delete** the feature branch:
   ```bash
   git branch -d feat/my-feature
   ```

---

## Release to `main`

When `dev` is stable and ready:

### Pre-release checklist

- [ ] All tests pass: `node tests/tests.js`
- [ ] Preview on [dev.delaclaw.pages.dev](https://dev.delaclaw.pages.dev) looks correct
- [ ] `VERSION` file has the right `latest`, `latest_compat`, and `latest_compat_deprec`
- [ ] If DB schema changed:
  - [ ] Migration `.sql` file exists in `migrations/` (Supabase)
  - [ ] `migrations/local-migrations.js` entry added (SQLite)
  - [ ] `migrations/drive-migrations.js` entry added (Drive)
  - [ ] `sql/supabase_schema.sql` updated with the new schema folded in
  - [ ] `latest_compat` (or `latest_compat_deprec`) bumped if needed
- [ ] i18n: all new strings present in EN, FR, ES
- [ ] No hardcoded dark-mode colors — all via CSS variables
- [ ] Responsive: tested on mobile viewport (≤ 480px)
- [ ] `README.md` updated if features, file tree, or setup steps changed
- [ ] `docs-site/` pages updated if architecture, privacy, or setup changed

### Merge

```bash
git checkout main && git pull origin main
git merge dev
git push origin main
```

GitHub Pages deploys automatically. Verify at [delaclaw.com](https://delaclaw.com).

### Post-release

- [ ] Smoke-test on [delaclaw.com](https://delaclaw.com):
  - Login with each backend (Supabase, Google Drive, Local, Demo)
  - Check the Today page loads
  - Quick-add a TODO and delete it
- [ ] If a migration was included, verify the schema banner appears on old DBs and the migration SQL runs cleanly
- [ ] Sync `dev` with `main`:
  ```bash
  git checkout dev && git merge main && git push origin dev
  ```

---

## Migration releases

When a release includes a DB schema change:

1. **Migration file** in `migrations/` (e.g. `1.105_add_new_column.sql`)
   - Must end with `UPDATE settings SET value = 'X.YYY', updated_at = now() WHERE key = 'schema_version';`
   - Supabase users run this manually in the SQL Editor
2. **Local migration** in `migrations/local-migrations.js`
   - SQLite syntax (see file header for Postgres→SQLite differences)
   - Runs automatically on server startup
3. **Drive migration** in `migrations/drive-migrations.js`
   - JS transform on in-memory data
   - Runs automatically on connect
4. **Bump `latest_compat`** if the new schema enables new features
5. **Bump `latest_compat_deprec`** only if the app will break without the migration

The app shows a banner when the DB version is behind, with a link to the pending migrations.

---

## Hotfix workflow

For urgent fixes to `main` that can't wait for `dev`:

```bash
git checkout main && git pull origin main
git checkout -b hotfix/fix-description
# fix + commit
git checkout main && git merge hotfix/fix-description
git push origin main
# backport to dev
git checkout dev && git merge main && git push origin dev
git branch -d hotfix/fix-description
```

---

## Version format

`X.YYY` — e.g. `1.098`, `1.160`, `2.000`.

- `latest` bumps on every commit (enforced by pre-commit hook)
- `latest_compat` bumps when a migration adds features
- `latest_compat_deprec` bumps when a migration is required for the app to function
- Major version (`X`) reserved for breaking changes to the data model

See `VERSION` and `migrations/MIGRATION_GUIDE.md` for details.
