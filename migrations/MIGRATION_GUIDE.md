# Migration Guide

## Version System

DeLaClaw uses a **single version number** for both the app and the database schema, stored in two places:

- **`VERSION`** file (repo root) — `latest` field is the app version
- **`settings.schema_version`** (Supabase) — DB version, bumped by migrations

These must stay in sync. The pre-commit hook blocks commits that change app files (`.js`, `.css`, `.html`, `.sql`) without bumping `latest` in `VERSION`.

### Format

`X.YYY` — e.g. `1.098`, `1.099`, `2.000`. Minor increments for features/fixes, major bump for breaking schema changes.

### Compatibility Fields (VERSION file)

| Field | Meaning |
|---|---|
| `latest` | Current app version — bumped on every commit |
| `latest_compat` | Minimum DB version for full feature support |
| `latest_compat_deprec` | Minimum DB version that won't break the app |

The app checks `schema_version` on Supabase connect and shows:
- **Red banner** if DB < `latest_compat_deprec` — app may not work
- **Amber banner** if DB < `latest_compat` — some features unavailable
- Nothing if DB >= `latest_compat`

---

## Schema Setup

### New Users → `sql/supabase_schema.sql`

Complete current schema including all migrations folded in. Run once in the Supabase SQL Editor. Sets `schema_version` to the latest version.

### Existing Users → `migrations/*.sql`

Incremental migration files, named by the version they target:

```
migrations/1.099_enable_realtime.sql
migrations/1.102_add_lists.sql
```

Each migration ends with:
```sql
UPDATE settings SET value = 'X.YYY', updated_at = now()
WHERE key = 'schema_version';
```

Run pending migrations in order in the Supabase SQL Editor.

### Local Backend

`server/schema.sql` is the SQLite equivalent. The Bun server applies it on startup with `CREATE TABLE IF NOT EXISTS` — local users always get the latest schema automatically.

---

## Writing a Migration

1. Create `migrations/<version>_<description>.sql`
2. Write the SQL (see template below)
3. Bump `latest` in `VERSION` to match
4. If the migration adds required schema, bump `latest_compat` (or `latest_compat_deprec` if breaking)
5. Update `sql/supabase_schema.sql` to include the change for new installs
6. Update `server/schema.sql` (SQLite equivalent) if applicable
7. Commit — the pre-commit hook will verify `VERSION` is staged

### Migration Template

```sql
-- Migration X.YYY: Description

-- ... your DDL / DML here ...

-- Bump schema version
UPDATE settings SET value = 'X.YYY', updated_at = now()
WHERE key = 'schema_version';
```

### New Table Template (Supabase)

Starting October 2026, new `public` tables require explicit grants:

```sql
CREATE TABLE IF NOT EXISTS public.your_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- columns...
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

CREATE POLICY "your_table_policy" ON public.your_table
  FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO anon, authenticated, service_role;
```

After creating the table, also add it to:
- `js/main.js` — `BACKUP_TABLES` array
- `js/demo-data.js` — empty array entry
- Realtime publication (if cross-device sync needed):
  ```sql
  ALTER PUBLICATION supabase_realtime ADD TABLE your_table;
  ```

---

## Pre-Commit Hook

Located at `hooks/pre-commit` (tracked in repo). Install with:

```sh
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

What it does:
1. **VERSION guard** — blocks commits that change `.js`/`.css`/`.html`/`.sql` files without staging `VERSION`
2. **SW cache bump** — auto-updates the service worker cache hash when JS/CSS changes

---

## Dev / Prod Workflow

| Branch | Deploys to | Supabase instance |
|---|---|---|
| `dev` | `dev.delaclaw.pages.dev` | Dev project (testing) |
| `main` | `delaclaw.com` | Prod project |

1. Write migration on a feature branch
2. Test against dev Supabase
3. Merge to `dev`, verify on preview
4. Merge to `main`, run migration on prod Supabase
5. Fold migration into `sql/supabase_schema.sql`
