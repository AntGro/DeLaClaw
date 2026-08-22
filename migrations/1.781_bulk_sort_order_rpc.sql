-- Migration 1.781: bulk_sort_order RPC function
-- Batches sort_order updates into a single DB statement.
-- Replaces N individual PATCHes with one RPC call during drag-and-drop reorder.

create or replace function bulk_sort_order(p_table text, p_updates jsonb)
returns void language plpgsql security invoker
set search_path = public as $$
begin
  -- Allowlist: only tables that have a sort_order column
  if p_table not in (
    'todos', 'tasks', 'projects', 'vestiaire', 'lists', 'list_items',
    'flashcards', 'flashcard_notes', 'todo_categories', 'habit_categories',
    'vestiaire_categories', 'flashcard_decks', 'habits'
  ) then
    raise exception 'bulk_sort_order: table not allowed: %', p_table;
  end if;

  execute format(
    'update %I set sort_order = (u->>''sort_order'')::int, updated_at = now()
     from jsonb_array_elements($1) u
     where %I.id = (u->>''id'')::uuid',
    p_table, p_table
  ) using p_updates;
end;
$$;

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.781', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
