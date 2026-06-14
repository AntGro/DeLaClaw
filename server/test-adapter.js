#!/usr/bin/env bun
// ===================================================================
// End-to-end adapter test — exercises the REST adapter with the same
// chainable API that Last's main.js uses (via state.db.from(...))
// ===================================================================

import { createRestAdapter } from '../js/adapters/rest.js';

const BASE = 'http://localhost:3737';
const adapter = createRestAdapter(BASE);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

console.log('\n🔗 REST Adapter End-to-End Tests\n');

// ── 1. Projects ──
console.log('── Projects (adapter chain) ──');
{
  // Insert
  const { error: err1 } = await adapter.from('projects').insert({ id: 'e2e-proj', name: 'E2E Project', color: '#00ff00', sort_order: 0 });
  assert(!err1, 'insert project via adapter');

  // Select all
  const { data: all, error: err2 } = await adapter.from('projects').select('*');
  assert(!err2 && Array.isArray(all) && all.some(p => p.id === 'e2e-proj'), 'select all projects');

  // Select with .eq()
  const { data: filtered } = await adapter.from('projects').select('*').eq('id', 'e2e-proj');
  assert(filtered.length === 1 && filtered[0].name === 'E2E Project', 'select with .eq()');

  // Update with .eq()
  const { error: err3 } = await adapter.from('projects').update({ name: 'Updated E2E' }).eq('id', 'e2e-proj');
  assert(!err3, 'update via adapter');

  // Verify update
  const { data: check } = await adapter.from('projects').select('*').eq('id', 'e2e-proj');
  assert(check[0].name === 'Updated E2E', 'update persisted');

  // Order
  await adapter.from('projects').insert({ id: 'e2e-proj-2', name: 'Second', sort_order: 5 });
  const { data: ordered } = await adapter.from('projects').select('*').order('sort_order', { ascending: true });
  assert(ordered.length >= 2 && ordered[0].sort_order <= ordered[ordered.length - 1].sort_order, 'order ascending');

  const { data: descOrdered } = await adapter.from('projects').select('*').order('sort_order', { ascending: false });
  assert(descOrdered[0].sort_order >= descOrdered[descOrdered.length - 1].sort_order, 'order descending');

  // Limit
  const { data: limited } = await adapter.from('projects').select('*').limit(1);
  assert(limited.length === 1, 'limit(1)');
}

// ── 2. Tasks ──
console.log('── Tasks ──');
{
  const { error } = await adapter.from('tasks').insert({ project: 'e2e-proj', text: 'E2E Task', status: 'todo', sort_order: 0 });
  assert(!error, 'insert task');

  const { data: tasks } = await adapter.from('tasks').select('*').eq('project', 'e2e-proj');
  assert(tasks.length >= 1 && tasks[0].text === 'E2E Task', 'select tasks by project');

  const taskId = tasks[0].id;
  await adapter.from('tasks').update({ status: 'review', hatch_response: 'Done it' }).eq('id', taskId);
  const { data: updated } = await adapter.from('tasks').select('*').eq('id', taskId);
  assert(updated[0].status === 'review' && updated[0].hatch_response === 'Done it', 'update task fields');
}

// ── 3. Todos ──
console.log('── Todos ──');
{
  const { error } = await adapter.from('todos').insert({ text: 'E2E Todo', priority: 'normal', category: 'Test', sort_order: 0 });
  assert(!error, 'insert todo');

  const { data: todos } = await adapter.from('todos').select('*');
  const todo = todos.find(t => t.text === 'E2E Todo');
  assert(!!todo, 'todo exists in select');

  await adapter.from('todos').update({ done: 1 }).eq('id', todo.id);
  const { data: check } = await adapter.from('todos').select('*').eq('id', todo.id);
  assert(check[0].done === 1, 'update todo done');
}

// ── 4. Habits ──
console.log('── Habits ──');
{
  const { data: inserted } = await adapter.from('habits').insert({ name: 'E2E Habit', frequency_rule: 'daily', category: 'General' }).select().single();
  assert(inserted && inserted.id, 'insert habit with .select().single()');

  const habitId = inserted.id;
  const { error } = await adapter.from('habit_completions').insert({ habit_id: habitId, completed_at: new Date().toISOString() });
  assert(!error, 'insert habit completion');

  await adapter.from('habits').update({ next_due: '2026-06-15' }).eq('id', habitId);
  const { data: check } = await adapter.from('habits').select('*').eq('id', habitId);
  assert(check[0].next_due === '2026-06-15', 'update habit next_due');
}

// ── 5. Flashcards ──
console.log('── Flashcards ──');
{
  const { error } = await adapter.from('flashcards').insert({ deck: 'Général', front: 'Q', back: 'A' });
  assert(!error, 'insert flashcard');

  const { data: cards } = await adapter.from('flashcards').select('*');
  const card = cards.find(c => c.front === 'Q');
  assert(!!card, 'flashcard exists');

  await adapter.from('flashcards').update({ stability: 3.14, difficulty: 2.5, review_count: 1 }).eq('id', card.id);
  const { data: check } = await adapter.from('flashcards').select('*').eq('id', card.id);
  assert(check[0].stability === 3.14 && check[0].review_count === 1, 'update flashcard FSRS');
}

// ── 6. Flashcard notes ──
console.log('── Flashcard Notes ──');
{
  const { error } = await adapter.from('flashcard_notes').insert({ content: 'Napoleon' });
  assert(!error, 'insert flashcard note');

  const { data: notes } = await adapter.from('flashcard_notes').select('*');
  const note = notes.find(n => n.content === 'Napoleon');
  assert(note && note.proposal_status === 'pending', 'default proposal_status=pending');

  await adapter.from('flashcard_notes').update({ proposal_status: 'ready', proposed_front: 'When?', proposed_back: '1769' }).eq('id', note.id);
  const { data: check } = await adapter.from('flashcard_notes').select('*').eq('id', note.id);
  assert(check[0].proposal_status === 'ready', 'update flashcard note');
}

// ── 7. Texts ──
console.log('── Texts ──');
{
  const { data: inserted } = await adapter.from('texts').insert({ deck: 'Poésie', title: 'Le Lac', author: 'Lamartine', content: 'Ainsi, toujours poussés...' }).select().single();
  assert(inserted && inserted.id, 'insert text with .select().single()');

  const { error } = await adapter.from('text_line_progress').insert({ text_id: inserted.id, chunk_index: 0 });
  assert(!error, 'insert text_line_progress');
}

// ── 8. Birthdays ──
console.log('── Birthdays ──');
{
  const { error } = await adapter.from('birthdays').insert({ name: 'E2E Person', birthday: '1990-01-15' });
  assert(!error, 'insert birthday');

  const { data: bdays } = await adapter.from('birthdays').select('*');
  const b = bdays.find(x => x.name === 'E2E Person');
  assert(!!b, 'birthday exists');

  await adapter.from('birthdays').update({ avatar_url: 'data:image/jpeg;base64,abc' }).eq('id', b.id);
  const { data: check } = await adapter.from('birthdays').select('*').eq('id', b.id);
  assert(check[0].avatar_url.startsWith('data:'), 'update birthday avatar');
}

// ── 9. Vestiaire ──
console.log('── Vestiaire ──');
{
  const { error } = await adapter.from('vestiaire').insert({ name: 'E2E Shirt', brand: 'Uniqlo', category: 'Hauts', sort_order: 0 });
  assert(!error, 'insert vestiaire');

  const { data: items } = await adapter.from('vestiaire').select('*').order('sort_order', { ascending: true });
  assert(items.length >= 1, 'select vestiaire ordered');

  const item = items.find(v => v.name === 'E2E Shirt');
  await adapter.from('vestiaire').update({ purchase_status: 'achete' }).eq('id', item.id);
  const { data: check } = await adapter.from('vestiaire').select('*').eq('id', item.id);
  assert(check[0].purchase_status === 'achete', 'update vestiaire status');
}

// ── 10. Settings (upsert) ──
console.log('── Settings ──');
{
  await adapter.from('settings').upsert({ key: 'nvidia_api_key', value: 'test-123', updated_at: new Date().toISOString() }, { onConflict: 'key' });
  const { data } = await adapter.from('settings').select('*').eq('key', 'nvidia_api_key');
  assert(data.length === 1 && data[0].value === 'test-123', 'upsert setting (insert)');

  await adapter.from('settings').upsert({ key: 'nvidia_api_key', value: 'updated-456', updated_at: new Date().toISOString() }, { onConflict: 'key' });
  const { data: check } = await adapter.from('settings').select('*').eq('key', 'nvidia_api_key');
  assert(check[0].value === 'updated-456', 'upsert setting (update)');
}

// ── 11. Prompts (upsert) ──
console.log('── Prompts ──');
{
  await adapter.from('prompts').upsert({ key: 'global', text: 'Be helpful' }, { onConflict: 'key' });
  const { data } = await adapter.from('prompts').select('*').eq('key', 'global');
  assert(data.length === 1, 'upsert prompt');
}

// ── 12. Delete ──
console.log('── Delete ──');
{
  await adapter.from('projects').delete().eq('id', 'e2e-proj-2');
  const { data } = await adapter.from('projects').select('*').eq('id', 'e2e-proj-2');
  assert(data.length === 0, 'delete removes row');
}

// ── 13. Cascade delete ──
console.log('── Cascade ──');
{
  const { data: before } = await adapter.from('tasks').select('*').eq('project', 'e2e-proj');
  assert(before.length >= 1, 'tasks exist before cascade');

  await adapter.from('projects').delete().eq('id', 'e2e-proj');
  const { data: after } = await adapter.from('tasks').select('*').eq('project', 'e2e-proj');
  assert(after.length === 0, 'cascade deletes tasks');
}

// ── 14. RPC ──
console.log('── RPC ──');
{
  const { data, error } = await adapter.rpc('db_size_mb');
  assert(!error && typeof data === 'number', 'rpc db_size_mb');
}

// ── 15. Channel (noop) ──
console.log('── Channel (noop realtime) ──');
{
  const ch = adapter.channel('test');
  const result = ch.on('postgres_changes', { event: '*' }, () => {}).subscribe();
  assert(!!result, 'channel().on().subscribe() returns without error');
}

// ── Summary ──
console.log(`\n══════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
