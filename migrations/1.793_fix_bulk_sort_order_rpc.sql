-- Migration 1.793: fix bulk_sort_order for text-ID and no-updated_at tables
-- - Compare id as text (works for both UUID and text PKs)
-- - Conditionally set updated_at only if the column exists (projects has none)

create or replace function bulk_sort_order(p_table text, p_updates jsonb)
returns void language plpgsql security invoker
set search_path = public as $$
declare
  has_updated_at boolean;
begin
  -- Allowlist: only tables that have a sort_order column
  if p_table not in (
    'todos', 'tasks', 'projects', 'vestiaire', 'lists', 'list_items',
    'flashcards', 'flashcard_notes', 'todo_categories', 'habit_categories',
    'vestiaire_categories', 'flashcard_decks', 'habits'
  ) then
    raise exception 'bulk_sort_order: table not allowed: %', p_table;
  end if;

  select exists(
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = 'updated_at'
  ) into has_updated_at;

  if has_updated_at then
    execute format(
      'update %I set sort_order = (u->>''sort_order'')::int, updated_at = now()
       from jsonb_array_elements($1) u
       where %I.id::text = u->>''id''',
      p_table, p_table
    ) using p_updates;
  else
    execute format(
      'update %I set sort_order = (u->>''sort_order'')::int
       from jsonb_array_elements($1) u
       where %I.id::text = u->>''id''',
      p_table, p_table
    ) using p_updates;
  end if;
end;
$$;

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.793', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
