# Migration Guide

## Version System

DeLaClaw uses a **single version number** for both the app and the database schema, stored in two places:

- **`VERSION`** file (repo root) — `latest` field is the app version
- **`settings.schema_version`** (Supabase / Local) — DB version, bumped by migrations

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

## How Migrations Work Per Backend

| Backend | Schema source | Migration strategy | User action required |
|---|---|---|---|
| **Supabase** | `sql/supabase_schema.sql` (Postgres DDL) | Incremental `.sql` files in `migrations/`, run manually in the SQL Editor | Yes — run pending migration files in order |
| **Local** | `server/schema.sql` (SQLite DDL) | `CREATE TABLE IF NOT EXISTS` on server startup. New columns need manual migration or DB reset | No for new tables. New columns on existing tables: yes |
| **Google Drive** | Per-table JSON files in Drive | JS migration functions run on connect when `schema_version` is behind. New fields handled gracefully (undefined + defaults) | No — automatic on connect |
| **Demo** | Schemaless (in-memory) | Same as Drive — new fields are simply absent on old objects | No — automatic |

### Supabase

The primary migration path. Migration files live in `migrations/` and are named by target version:

```
migrations/1.099_enable_realtime.sql
migrations/1.102_add_lists.sql
```

Each migration ends with:
```sql
UPDATE settings SET value = 'X.YYY', updated_at = now()
WHERE key = 'schema_version';
```

**New installs:** run `sql/supabase_schema.sql` once — it includes all migrations folded in and sets `schema_version` to the latest version.

**Existing installs:** run pending migration files in order in the Supabase SQL Editor.

### Local (Bun + SQLite)

`server/schema.sql` is the SQLite equivalent of the Supabase schema. The Bun server applies it on startup with `CREATE TABLE IF NOT EXISTS`, so new tables are created automatically.

**Limitation:** `CREATE TABLE IF NOT EXISTS` doesn't add new columns to existing tables. If a migration adds a column, local users need to either:
- Run the SQLite equivalent manually (`ALTER TABLE ... ADD COLUMN ...`)
- Delete the SQLite DB file and let the server recreate it (loses data)

Auto-migration on server start is possible but not yet implemented.

### Google Drive & Demo

Google Drive stores data as per-table JSON files in a `DeLaClaw/` folder. When the app adds a new field, old records have `undefined` for that field — the app handles this with default values or conditional checks, same as Demo.

For structural changes (new tables, renamed fields, table splits), Drive uses **JS migration functions** that run on connect when `schema_version` in `settings.json` is behind the app version. These are JavaScript transforms — not SQL — that read, transform, and write back the affected JSON files. Example:

```js
const migrations = {
  '1.130': async (drive) => {
    // New table: create empty file if missing
    await drive.ensureFile('texts.json', []);
  },
  '1.135': async (drive) => {
    // Rename field
    const todos = await drive.readTable('todos.json');
    todos.forEach(t => { t.priority = t.importance; delete t.importance; });
    await drive.writeTable('todos.json', todos);
  }
};
```

After all pending migrations succeed, `schema_version` is updated in `settings.json`.

Demo mode is truly schemaless with no migration mechanism — data doesn't persist across refresh, so there's nothing to migrate.

---

## Writing a Migration

1. Create `migrations/<version>_<description>.sql`
2. Write the SQL (see template below)
3. Bump `latest` in `VERSION` to match
4. If the migration adds required schema, bump `latest_compat` (or `latest_compat_deprec` if breaking)
5. Update `sql/supabase_schema.sql` to include the change for new installs
6. Update `server/schema.sql` (SQLite equivalent) if applicable
7. If the new field is used in app code, ensure it handles `undefined` / missing values for Drive and Demo backends
8. If adding a new CHECK constraint, update `CHECK_CONSTRAINTS` in `js/adapters/demo.js` (test 31 enforces parity)
9. Commit — the pre-commit and commit-msg hooks will verify

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
