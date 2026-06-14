# Migration Guide

## Schema Strategy

DeLaClaw maintains two parallel paths for database setup:

### New Users → `sql/initial_schema.sql`
A single file containing the complete current schema. Generated via `supabase db pull`. Run it once in the Supabase SQL Editor.

### Existing Users → `migrations/NNN_*.sql`
Incremental migration files applied in order.

**Rule:** whenever you add a migration, also update `sql/initial_schema.sql` (and `server/schema.sql` for SQLite) so all three stay in sync.

### Local Backend
`server/schema.sql` is the SQLite equivalent of `sql/initial_schema.sql`. The Bun server applies it on startup with `CREATE TABLE IF NOT EXISTS`, so local users always get the latest schema automatically.

---

## Supabase API Exposure (October 2026)

Starting **October 30, 2026**, new tables in the `public` schema won't be exposed to PostgREST / supabase-js by default. Any migration that creates a new table must include an explicit GRANT:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO anon, authenticated;
```

### Migration Template

```sql
-- Migration NNN: Description
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

After creating the migration, update:
1. `sql/initial_schema.sql` — add the table + RLS/grants
2. `server/schema.sql` — add the SQLite equivalent
3. `js/main.js` — add to `BACKUP_TABLES` if applicable
4. `js/demo-data.js` — add empty array entry

Ref: [Supabase changelog — May 2026](https://supabase.com/changelog)
