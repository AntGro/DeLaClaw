# Migration Guide

## Version System

DeLaClaw uses a **single version number** for both the app and the database schema, stored in two places:

- **`VERSION`** file (repo root) — `latest` field is the app version
- **`settings.schema_version`** (Supabase / Local) — DB version, bumped by migrations

### Format

`X.Y.Z` (semantic versioning) — e.g. `1.939.0`, `1.939.1`, `2.0.0`. Patch increments on every commit, minor on features, major on breaking schema changes. Legacy two-part versions (`X.YYY`, e.g. `1.939`) are treated as `X.YYY.0` when compared.

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

## How Migrations Work Per Backend

| Backend | Schema source | Migration strategy | User action required |
|---|---|---|---|
| **Local** | `server/schema.sql` (SQLite DDL) | `CREATE TABLE IF NOT EXISTS` on server startup. New columns need manual migration or DB reset | No for new tables. New columns on existing tables: yes |
| **Google Drive** | Per-table JSON files in Drive | JS migration functions run on connect when `schema_version` is behind. New fields handled gracefully (undefined + defaults) | No — automatic on connect |
| **Demo** | Schemaless (in-memory) | Same as Drive — new fields are simply absent on old objects | No — automatic |

### Local (Bun + SQLite)

`server/schema.sql` is the SQLite equivalent of the Supabase schema. The Bun server applies it on startup with `CREATE TABLE IF NOT EXISTS`, so new tables are created automatically.

**Limitation:** `CREATE TABLE IF NOT EXISTS` doesn't add new columns to existing tables. If a migration adds a column, local users need to either:
- Run the SQLite equivalent manually (`ALTER TABLE ... ADD COLUMN ...`)
- Delete the SQLite DB file and let the server recreate it (loses data)

Auto-migration on server start is possible but not yet implemented.

### Google Drive & Demo

Google Drive stores data as per-table JSON files in a `DeLaClaw/` folder. When the app adds a new field, old records have `undefined` for that field — the app handles this with default values or conditional checks, same as Demo.

For structural changes (new tables, renamed fields, table splits), Drive uses **JS migration functions** defined in `migrations/drive-migrations.js`. They run on connect when `schema_version` in `settings.json` is behind the app version. These are JavaScript transforms — not SQL — that modify the in-memory store. Example:

```js
export const DRIVE_MIGRATIONS = {
  '1.140': async (store) => {
    // New table
    if (!store.texts) store.texts = [];
  },
  '1.145': async (store) => {
    // Rename field
    (store.todos || []).forEach(t => {
      t.priority = t.importance;
      delete t.importance;
    });
  },
};
```

Migration runner behaviour:
1. **Backup first** — before any migration runs, all table data is saved to `backup-v{currentVersion}.json` in the DeLaClaw/ Drive folder. This is a full snapshot that can be used for manual recovery.
2. **Sequential execution** — migrations run in version order. After each one succeeds, `schema_version` is bumped in `settings.json` and all tables are flushed to Drive.
3. **Safe resume** — if a migration fails mid-batch, `schema_version` reflects the last fully-applied step. Next connect retries from where it stopped, and the backup is still intact.

Demo mode is truly schemaless with no migration mechanism — data doesn't persist across refresh, so there's nothing to migrate.

---

## Writing a Migration

1. Write the SQL change
2. Bump `latest` in `VERSION` to match
3. If the migration adds required schema, bump `latest_compat` (or `latest_compat_deprec` if breaking)
4. Update `sql/supabase_schema.sql` to include the change for new installs
5. Update `server/schema.sql` (SQLite equivalent) if applicable
6. If the new field is used in app code, ensure it handles `undefined` / missing values for Drive and Demo backends
7. If adding a new CHECK constraint, update `CHECK_CONSTRAINTS` in `js/adapters/demo.js` (test 31 enforces parity)
8. If the change is structural (new table, renamed field, table split), add a matching entry in `migrations/drive-migrations.js`
9. Add a matching entry in `migrations/local-migrations.js` for Local backend
10. Commit — the pre-commit and commit-msg hooks will verify

### Migration Template

```sql
-- Migration X.Y.Z: Description

-- ... your DDL / DML here ...

-- Bump schema version
UPDATE settings SET value = 'X.Y.Z', updated_at = now()
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

## Git Hooks

Hooks live in `.githooks/` (tracked in the repo). Activate them with:

```sh
git config core.hooksPath .githooks
```

| Hook | What it does |
|---|---|
| **pre-commit** | Blocks commits without a `VERSION` bump. Auto-regenerates `js/version.js` and updates `sw.js` cache version. Lints staged code for pictographic emoji. |
| **commit-msg** | Enforces the `Checked:` trailer with impact review tags. See `COMMIT_CHECKLIST.md`. |

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
