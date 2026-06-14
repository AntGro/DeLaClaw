#!/usr/bin/env bun
// ===================================================================
// Integration tests for the local REST server
// Tests all CRUD operations against the real SQLite-backed API
// ===================================================================

const BASE = 'http://localhost:3737';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BASE}${path}`, opts);
  if (resp.status === 204) return { status: resp.status, data: null };
  return { status: resp.status, data: await resp.json() };
}

// ── Helper: mimic the REST adapter's chainable interface ──
function from(table) {
  return {
    async select() {
      const r = await api('GET', `/rest/v1/${table}`);
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async selectWithFilter(col, val) {
      const r = await api('GET', `/rest/v1/${table}?${col}=eq.${val}`);
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async selectOrdered(col, asc = true) {
      const r = await api('GET', `/rest/v1/${table}?order=${col}.${asc ? 'asc' : 'desc'}`);
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async selectLimited(n) {
      const r = await api('GET', `/rest/v1/${table}?limit=${n}`);
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async insert(row) {
      const r = await api('POST', `/rest/v1/${table}`, row, { Prefer: 'return=representation' });
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async update(body, col, val) {
      const r = await api('PATCH', `/rest/v1/${table}?${col}=eq.${val}`, body, { Prefer: 'return=representation' });
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async upsert(body, conflictCol) {
      const params = conflictCol ? `?on_conflict=${conflictCol}` : '';
      const r = await api('PUT', `/rest/v1/${table}${params}`, body, { Prefer: 'return=representation' });
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
    async delete(col, val) {
      const r = await api('DELETE', `/rest/v1/${table}?${col}=eq.${val}`);
      return { data: r.data, error: r.status >= 400 ? r.data : null };
    },
  };
}

// ===================================================================
// TEST SUITE
// ===================================================================
(async () => {
console.log('\n🧪 Local REST Server Integration Tests\n');

// ── 1. Projects CRUD ──
console.log('── Projects ──');
{
  const { data, error } = await from('projects').insert({
    id: 'test-proj-1', name: 'Test Project', shortname: 'TP', color: '#ff0000', sort_order: 0
  });
  assert(!error && data.length === 1 && data[0].id === 'test-proj-1', 'INSERT project returns row');

  const { data: all } = await from('projects').select();
  assert(Array.isArray(all) && all.length >= 1, 'SELECT all projects');

  const { data: updated } = await from('projects').update(
    { name: 'Updated Project' }, 'id', 'test-proj-1'
  );
  assert(updated[0].name === 'Updated Project', 'UPDATE project name');

  const { data: filtered } = await from('projects').selectWithFilter('id', 'test-proj-1');
  assert(filtered.length === 1 && filtered[0].name === 'Updated Project', 'SELECT with .eq() filter');
}

// ── 2. Tasks CRUD ──
console.log('── Tasks ──');
{
  const { data } = await from('tasks').insert({
    project: 'test-proj-1', text: 'Task A', status: 'todo', sort_order: 0
  });
  assert(!data[0].error && data[0].id, 'INSERT task (auto-generated ID)');
  const taskId = data[0].id;

  const { data: upd } = await from('tasks').update({ status: 'review', hatch_response: 'Done' }, 'id', taskId);
  assert(upd[0].status === 'review', 'UPDATE task status');

  const { data: byProj } = await from('tasks').selectWithFilter('project', 'test-proj-1');
  assert(byProj.length >= 1, 'SELECT tasks by project');
}

// ── 3. Todos CRUD ──
console.log('── Todos ──');
{
  const { data } = await from('todos').insert({ text: 'Buy milk', priority: 'normal', category: 'Groceries', sort_order: 0 });
  const todoId = data[0].id;
  assert(!!todoId, 'INSERT todo');

  const { data: upd } = await from('todos').update({ done: 1, snooze_until: '2026-06-01T00:00:00Z' }, 'id', todoId);
  assert(upd[0].done === 1 && upd[0].snooze_until === '2026-06-01T00:00:00Z', 'UPDATE todo done + snooze');
}

// ── 4. Habits + completions ──
console.log('── Habits ──');
{
  const { data } = await from('habits').insert({ name: 'Hoovering', frequency_rule: 'weekly:Mon', category: 'General' });
  const habitId = data[0].id;
  assert(!!habitId, 'INSERT habit');

  const { data: comp } = await from('habit_completions').insert({ habit_id: habitId, completed_at: new Date().toISOString() });
  assert(!!comp[0].id, 'INSERT habit completion');

  const { data: upd } = await from('habits').update({ next_due: '2026-06-01' }, 'id', habitId);
  assert(upd[0].next_due === '2026-06-01', 'UPDATE habit next_due');
}

// ── 5. Flashcards ──
console.log('── Flashcards ──');
{
  const { data } = await from('flashcards').insert({ deck: 'Général', front: 'Q1', back: 'A1' });
  const cardId = data[0].id;
  assert(!!cardId, 'INSERT flashcard');

  const { data: upd } = await from('flashcards').update({
    stability: 4.5, difficulty: 3.2, last_review: new Date().toISOString(),
    next_review: new Date(Date.now() + 86400000).toISOString(), review_count: 1
  }, 'id', cardId);
  assert(upd[0].stability === 4.5 && upd[0].review_count === 1, 'UPDATE flashcard FSRS fields');
}

// ── 6. Flashcard notes (drafts) ──
console.log('── Flashcard Notes ──');
{
  const { data } = await from('flashcard_notes').insert({ content: 'Napoleon' });
  const noteId = data[0].id;
  assert(!!noteId && data[0].proposal_status === 'pending', 'INSERT flashcard note (default pending)');

  const { data: upd } = await from('flashcard_notes').update({
    proposed_front: 'Quand?', proposed_back: '1769', proposed_deck: 'Histoire de France', proposal_status: 'ready'
  }, 'id', noteId);
  assert(upd[0].proposal_status === 'ready', 'UPDATE flashcard note proposal');
}

// ── 7. Texts + line progress ──
console.log('── Texts ──');
{
  const { data } = await from('texts').insert({ deck: 'Poésie', title: 'Test Poem', content: 'line1\nline2\nline3\nline4' });
  const textId = data[0].id;
  assert(!!textId, 'INSERT text');

  const { data: chunk } = await from('text_line_progress').insert({ text_id: textId, chunk_index: 0 });
  assert(!!chunk[0].id, 'INSERT text_line_progress');

  const { data: upd } = await from('text_line_progress').update({ stability: 2.1, review_count: 3 }, 'id', chunk[0].id);
  assert(upd[0].stability === 2.1, 'UPDATE text_line_progress');
}

// ── 8. Birthdays ──
console.log('── Birthdays ──');
{
  const { data } = await from('birthdays').insert({ name: 'Test Person', birthday: '1990-03-22' });
  assert(!!data[0].id, 'INSERT birthday');

  const { data: upd } = await from('birthdays').update({ avatar_url: 'data:image/jpeg;base64,abc' }, 'id', data[0].id);
  assert(upd[0].avatar_url.startsWith('data:'), 'UPDATE birthday avatar');
}

// ── 9. Vestiaire ──
console.log('── Vestiaire ──');
{
  const { data } = await from('vestiaire').insert({ name: 'Oxford Shirt', brand: 'Uniqlo', size: 'M', category: 'Hauts', color: 'White', sort_order: 0 });
  assert(!!data[0].id, 'INSERT vestiaire item');

  const { data: upd } = await from('vestiaire').update({ purchase_status: 'achete' }, 'id', data[0].id);
  assert(upd[0].purchase_status === 'achete', 'UPDATE vestiaire purchase_status');
}

// ── 10. Settings (upsert) ──
console.log('── Settings ──');
{
  const { data } = await from('settings').upsert({ key: 'nvidia_api_key', value: 'test-key-123', updated_at: new Date().toISOString() }, 'key');
  assert(data[0].key === 'nvidia_api_key', 'UPSERT setting (insert)');

  const { data: upd } = await from('settings').upsert({ key: 'nvidia_api_key', value: 'updated-key', updated_at: new Date().toISOString() }, 'key');
  assert(upd[0].value === 'updated-key', 'UPSERT setting (update)');
}

// ── 11. Prompts (upsert) ──
console.log('── Prompts ──');
{
  const { data } = await from('prompts').upsert({ key: 'global', text: 'Be helpful' }, 'key');
  assert(data[0].key === 'global', 'UPSERT prompt');
}

// ── 12. Ordering ──
console.log('── Ordering ──');
{
  await from('projects').insert({ id: 'proj-z', name: 'Z Project', sort_order: 10 });
  await from('projects').insert({ id: 'proj-a', name: 'A Project', sort_order: 1 });
  const { data: asc } = await from('projects').selectOrdered('sort_order', true);
  assert(asc.length >= 2 && asc[0].sort_order <= asc[1].sort_order, 'ORDER BY ascending');

  const { data: desc } = await from('projects').selectOrdered('sort_order', false);
  assert(desc.length >= 2 && desc[0].sort_order >= desc[1].sort_order, 'ORDER BY descending');
}

// ── 13. Limit ──
console.log('── Limit ──');
{
  const { data } = await from('projects').selectLimited(1);
  assert(data.length === 1, 'LIMIT 1 returns exactly 1 row');
}

// ── 14. DELETE ──
console.log('── Delete ──');
{
  await from('projects').delete('id', 'proj-z');
  const { data } = await from('projects').selectWithFilter('id', 'proj-z');
  assert(data.length === 0, 'DELETE removes row');
}

// ── 15. CASCADE delete ──
console.log('── Cascade Delete ──');
{
  const { data: tasksBefore } = await from('tasks').selectWithFilter('project', 'test-proj-1');
  assert(tasksBefore.length >= 1, 'Tasks exist before project delete');

  await from('projects').delete('id', 'test-proj-1');
  const { data: tasksAfter } = await from('tasks').selectWithFilter('project', 'test-proj-1');
  assert(tasksAfter.length === 0, 'CASCADE deletes tasks when project deleted');
}

// ── 16. RPC ──
console.log('── RPC ──');
{
  const { status, data } = await api('POST', '/rest/v1/rpc/db_size_mb');
  assert(status === 200 && typeof data === 'number', 'RPC db_size_mb returns number');
}

// ── 17. 404 on unknown table ──
console.log('── Error Handling ──');
{
  const { status } = await api('GET', '/rest/v1/nonexistent');
  assert(status === 404, 'Unknown table returns 404');
}

// ── Summary ──
console.log(`\n══════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
})();
