// ===================================================================
// CALENDAR SYNC — sync habits, todos, birthdays to Google Calendar
// ===================================================================
// Creates a dedicated "DeLaClaw" calendar and maps items via the
// gcal_sync table. Works with Drive and Demo backends only.
// Demo mode: table + settings exist but no actual API calls.
//
// Token: reuses the Drive token (which includes calendar.app.created
// scope). No separate OAuth flow — any device connected to Google Drive
// automatically has calendar access. The sync toggle in shared settings
// is the sole gate for whether sync fires.
// ===================================================================

import state from './state.js';
import { t } from './i18n.js';
import { showToast, showConfirmAction, closeConfirmAction } from './utils.js';
import { lucideIcon } from './icons.js';
import { getTodoCategories } from './todos.js';
import { getHabitCategories } from './habits.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ── Token: provided by the Drive adapter ────────────────────────

let _getToken = null;

// ── Settings helpers ────────────────────────────────────────────

async function getSetting(key) {
  const { data } = await state.db.from('settings').select('value').eq('key', key).single();
  return data?.value ?? null;
}

async function setSetting(key, value) {
  await state.db.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

export async function isCalSyncEnabled() {
  return (await getSetting('gcal_sync_enabled')) === 'true';
}

export async function getCalSyncPrefs() {
  const [enabled, calId, habits, todos, birthdays] = await Promise.all([
    getSetting('gcal_sync_enabled'),
    getSetting('gcal_calendar_id'),
    getSetting('gcal_sync_habits'),
    getSetting('gcal_sync_todos'),
    getSetting('gcal_sync_birthdays'),
  ]);
  return {
    enabled: enabled === 'true',
    calendarId: calId,
    habits: habits !== 'false',   // default true
    todos: todos !== 'false',     // default true
    birthdays: birthdays !== 'false', // default true
  };
}

// ── Calendar CRUD (API) ─────────────────────────────────────────

async function findOrCreateCalendar(token, name = 'DeLaClaw') {
  const listResp = await fetch(`${CALENDAR_API}/users/me/calendarList`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (listResp.status === 403) throw new Error('Calendar scope not granted (403)');
  if (listResp.ok) {
    const { items } = await listResp.json();
    const existing = items?.find(c => c.summary === name && !c.deleted);
    if (existing) return existing.id;
  }
  const createResp = await fetch(`${CALENDAR_API}/calendars`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  if (!createResp.ok) throw new Error(`Calendar create failed: ${createResp.status}`);
  return (await createResp.json()).id;
}

async function createEvent(token, calendarId, event) {
  const resp = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!resp.ok) throw new Error(`Event create failed: ${resp.status}`);
  return await resp.json();
}

async function updateEvent(token, calendarId, eventId, event) {
  const resp = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!resp.ok) {
    if (resp.status === 404) return null; // Event was deleted externally
    throw new Error(`Event update failed: ${resp.status}`);
  }
  return await resp.json();
}

async function deleteEvent(token, calendarId, eventId) {
  const resp = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  // 404/410 = already deleted, that's fine
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    throw new Error(`Event delete failed: ${resp.status}`);
  }
}

// ── gcal_sync table operations ──────────────────────────────────

async function getSyncEntry(itemType, itemId) {
  const { data } = await state.db.from('gcal_sync').select('*')
    .eq('item_type', itemType).eq('item_id', itemId).single();
  return data;
}

async function upsertSyncEntry(itemType, itemId, eventId) {
  await state.db.from('gcal_sync').upsert({
    item_type: itemType,
    item_id: itemId,
    gcal_event_id: eventId,
    last_synced_at: new Date().toISOString(),
  }, { onConflict: 'item_type,item_id' });
}

// Fallback for adapters without composite onConflict: delete + insert
async function upsertSyncEntryFallback(itemType, itemId, eventId) {
  await state.db.from('gcal_sync').delete().eq('item_type', itemType).eq('item_id', itemId);
  await state.db.from('gcal_sync').insert({
    item_type: itemType,
    item_id: itemId,
    gcal_event_id: eventId,
    last_synced_at: new Date().toISOString(),
  });
}

async function deleteSyncEntry(itemType, itemId) {
  await state.db.from('gcal_sync').delete().eq('item_type', itemType).eq('item_id', itemId);
}

// ── Item → Event conversion ─────────────────────────────────────

function getCatLabel(catMap, catId) {
  if (!catId) return '';
  const cat = catMap.get(catId);
  if (!cat) return '';
  return cat.shortname || cat.name || '';
}

/** Google all-day end.date is exclusive — return the day after. */
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function habitToEvent(habit) {
  if (!habit.next_due) return null;
  const date = habit.next_due.slice(0, 10); // YYYY-MM-DD
  const catLabel = getCatLabel(getHabitCategories(), habit.category_id);
  const prefix = catLabel ? `[Habit][${catLabel}]` : '[Habit]';
  return {
    summary: `${prefix} ${habit.name}`,
    start: { date },
    end: { date: nextDay(date) },
    extendedProperties: { private: { delaclaw_type: 'habit', delaclaw_id: habit.id } },
  };
}

function todoToEvent(todo) {
  const date = todo.due_date || todo.snoozed_until;
  if (!date) return null;
  const d = date.slice(0, 10);
  const catLabel = getCatLabel(getTodoCategories(), todo.category_id);
  const prefix = catLabel ? `[TODO][${catLabel}]` : '[TODO]';
  return {
    summary: `${prefix} ${todo.text}`,
    start: { date: d },
    end: { date: nextDay(d) },
    extendedProperties: { private: { delaclaw_type: 'todo', delaclaw_id: todo.id } },
  };
}

function birthdayToEvent(birthday) {
  const dateStr = birthday.date || birthday.birthday;
  if (!dateStr) return null;
  const mmdd = dateStr.slice(5); // MM-DD
  let year = new Date().getFullYear();
  // Feb 29 guard: advance to the next leap year if current year isn't one
  if (mmdd === '02-29') {
    while ((year % 4 !== 0) || (year % 100 === 0 && year % 400 !== 0)) year++;
  }
  const startDate = `${year}-${mmdd}`;
  return {
    summary: `[Birthday] ${birthday.name}`,
    start: { date: startDate },
    end: { date: nextDay(startDate) },
    recurrence: ['RRULE:FREQ=YEARLY'],
    extendedProperties: { private: { delaclaw_type: 'birthday', delaclaw_id: birthday.id } },
  };
}

function itemToEvent(itemType, item) {
  switch (itemType) {
    case 'habit': return habitToEvent(item);
    case 'todo': return todoToEvent(item);
    case 'birthday': return birthdayToEvent(item);
    default: return null;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Initialize calendar sync module. Call on page load.
 * @param {Function} getTokenFn — async function that returns a valid Google token (from the Drive adapter)
 */
export function initCalSync(getTokenFn) {
  _getToken = getTokenFn;
}

/**
 * Enable calendar sync: create calendar, save settings.
 * No separate OAuth — reuses the Drive token.
 * Returns the calendar ID on success, null on failure.
 */
export async function enableCalSync() {
  if (state.demoMode) {
    await setSetting('gcal_sync_enabled', 'true');
    await setSetting('gcal_calendar_id', 'demo-calendar-id');
    return 'demo-calendar-id';
  }
  if (!_getToken) return null;
  try {
    const token = await _getToken();
    if (!token) { showToast(t('cal_sync.enable_failed'), 'error'); return null; }
    const calId = await findOrCreateCalendar(token);
    await setSetting('gcal_sync_enabled', 'true');
    await setSetting('gcal_calendar_id', calId);
    return calId;
  } catch (e) {
    console.error('Calendar sync enable failed:', e);
    const msg = String(e?.message || '');
    if (msg.includes('403') || msg.includes('Insufficient')) {
      // Calendar scope not granted — show modal, then request permission
      const adapter = state.driveAdapter;
      if (adapter?.requestCalendarScope) {
        const userConfirmed = await new Promise(resolve => {
          showConfirmAction(
            t('cal_sync.scope_prompt_title'),
            t('cal_sync.scope_prompt_body'),
            () => resolve(true),
            t('cal_sync.scope_prompt_detail'),
            {
              detailHtml: true,
              variant: 'neutral',
              btnText: t('cal_sync.scope_prompt_btn'),
              iconSvg: lucideIcon('calendar-check', 32),
              btnIconSvg: lucideIcon('calendar-check', 16, '#fff'),
              onCancel: () => resolve(false),
            }
          );
        });
        if (!userConfirmed) return null;
        try {
          const newToken = await adapter.requestCalendarScope();
          if (newToken) {
            const calId = await findOrCreateCalendar(newToken);
            await setSetting('gcal_sync_enabled', 'true');
            await setSetting('gcal_calendar_id', calId);
            return calId;
          }
        } catch (e2) {
          console.error('Calendar scope re-request failed:', e2);
          const msg2 = String(e2?.message || '');
          if (msg2.includes('access_denied') || msg2.includes('popup_closed')) {
            // User declined or closed the popup — no toast
          } else if (msg2.includes('403') || msg2.includes('Insufficient')) {
            showToast(t('cal_sync.scope_missing'), 'error');
          } else {
            showToast(t('cal_sync.enable_failed'), 'error');
          }
        }
      } else {
        showToast(t('cal_sync.scope_missing'), 'error');
      }
    } else {
      showToast(t('cal_sync.enable_failed'), 'error');
    }
    return null;
  }
}

/**
 * Disable calendar sync. Always deletes the DeLaClaw calendar
 * (which removes all its events in Google Calendar).
 */
export async function disableCalSync() {
  if (!state.demoMode && _getToken) {
    try {
      const token = await _getToken();
      const calId = await getSetting('gcal_calendar_id');
      if (token && calId) {
        await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      }
    } catch (_) { /* best effort */ }
  }
  // Clear all sync entries since the calendar is gone
  await state.db.from('gcal_sync').delete().neq('item_type', '__never__');
  await setSetting('gcal_sync_enabled', 'false');
  await setSetting('gcal_calendar_id', '');
}

// ── Table-name → item-type mapping for Drive flush hook ─────────

const TABLE_TO_TYPE = { todos: 'todo', habits: 'habit', birthdays: 'birthday' };
// Category tables → corresponding item table (shortname rename triggers full scan)
export const CAT_TABLE_TO_ITEM_TABLE = { todo_categories: 'todos', habit_categories: 'habits' };
const BATCH_ENDPOINT = 'https://www.googleapis.com/batch/calendar/v3';
const MAX_BATCH_SIZE = 50; // Google's limit per batch request

// ── Dirty-item tracking ─────────────────────────────────────────
// Views mutate in-memory state → adapter.from(table).update/insert/delete
// → scheduleSave → debounce → flush → _onTableFlushed → syncTable.
// To avoid scanning all items on every flush, track which IDs changed.
// markDirty() is called from the adapter wrapper on every write.

const _dirtyItems = new Map(); // table → Set<id>

/**
 * Mark an item as dirty so the next flush syncs only it.
 * Called by the Drive adapter on non-GET mutations.
 * Also handles category tables: a category change triggers a full scan
 * of the corresponding item type (shortname affects event summaries).
 * @param {string} table — table name
 * @param {string|null} id — item ID, or null for bulk ops (forces full scan)
 */
export function markDirty(table, id) {
  // Category table change → mark the item table for full scan
  const itemTable = CAT_TABLE_TO_ITEM_TABLE[table];
  if (itemTable) {
    if (!_dirtyItems.has(itemTable)) _dirtyItems.set(itemTable, new Set());
    _dirtyItems.get(itemTable).add('__all__');
    return;
  }
  if (!TABLE_TO_TYPE[table]) return; // not a calendar-synced table
  if (!_dirtyItems.has(table)) _dirtyItems.set(table, new Set());
  const set = _dirtyItems.get(table);
  if (id === null) { set.add('__all__'); } // sentinel: full scan needed
  else { set.add(id); }
}

/**
 * Build a multipart/mixed batch body and send it to the Calendar batch endpoint.
 * Each op: { method, path, body? }. Returns an array of per-op { status, body }.
 */
async function sendBatch(token, ops) {
  if (ops.length === 0) return [];
  const results = [];
  for (let i = 0; i < ops.length; i += MAX_BATCH_SIZE) {
    const chunk = ops.slice(i, i + MAX_BATCH_SIZE);
    const boundary = `batch_delaclaw_${Date.now()}_${i}`;
    let body = '';
    for (let j = 0; j < chunk.length; j++) {
      const op = chunk[j];
      body += `--${boundary}\r\n`;
      body += `Content-Type: application/http\r\nContent-ID: <item${i + j}>\r\n\r\n`;
      body += `${op.method} ${op.path} HTTP/1.1\r\n`;
      if (op.body) {
        body += `Content-Type: application/json\r\n\r\n${JSON.stringify(op.body)}\r\n`;
      } else {
        body += `\r\n`;
      }
    }
    body += `--${boundary}--\r\n`;

    const resp = await fetch(BATCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      console.warn('Calendar batch request failed:', resp.status);
      for (let j = 0; j < chunk.length; j++) results.push({ status: resp.status, body: null });
      continue;
    }

    // Parse multipart response
    const respText = await resp.text();
    const respBoundary = resp.headers.get('Content-Type')?.match(/boundary=(.+)/)?.[1];
    if (respBoundary) {
      const parts = respText.split(`--${respBoundary}`).filter(p => p.trim() && p.trim() !== '--');
      for (const part of parts) {
        const statusMatch = part.match(/HTTP\/1\.1 (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;
        const jsonMatch = part.match(/\{[\s\S]*\}/);
        let parsed = null;
        if (jsonMatch) try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
        results.push({ status, body: parsed });
      }
    }
  }
  return results;
}

/**
 * Look up an item by ID in the current in-memory state.
 * Returns the item if it should have a calendar event, null otherwise.
 */
function getActiveItem(itemType, itemId) {
  if (itemType === 'habit') {
    const h = (state.allHabits || []).find(x => x.id === itemId);
    return (h && h.next_due) ? h : null;
  } else if (itemType === 'todo') {
    // TODOs aren't in a global state array — read from DB handled at call site
    return null; // caller handles todos specially
  } else if (itemType === 'birthday') {
    const b = (state.allBirthdays || []).find(x => x.id === itemId);
    return (b && (b.date || b.birthday)) ? b : null;
  }
  return null;
}

/**
 * Sync only changed items for one table after a Drive flush.
 * Uses the dirty-item set to avoid scanning all items.
 * On first enable (empty gcal_sync), pushes all items.
 */
export async function syncTable(tableName) {
  const itemType = TABLE_TO_TYPE[tableName];
  if (!itemType) return;

  const prefs = await getCalSyncPrefs();
  if (!prefs.enabled || !prefs.calendarId || state.demoMode || !_getToken) return;
  if (!prefs[itemType + 's']) return;

  let token;
  try { token = await _getToken(); } catch (_) { return; }
  if (!token) return;

  const calPath = `/calendar/v3/calendars/${encodeURIComponent(prefs.calendarId)}`;

  // Consume dirty set for this table
  const dirtySet = _dirtyItems.get(tableName);
  _dirtyItems.delete(tableName);
  const fullScan = !dirtySet || dirtySet.has('__all__');

  // ── Gather items to process ──
  const ops = [];
  const opMeta = [];

  if (fullScan) {
    // Full push: all items with dates → create or update; orphaned sync entries → delete
    const wantSync = [];
    if (itemType === 'habit') {
      for (const h of (state.allHabits || [])) {
        if (h.next_due) wantSync.push({ id: h.id, item: h });
      }
    } else if (itemType === 'todo') {
      const { data: todos } = await state.db.from('todos').select('*');
      for (const td of (todos || [])) {
        if (!td.done && (td.due_date || td.snoozed_until)) wantSync.push({ id: td.id, item: td });
      }
    } else if (itemType === 'birthday') {
      for (const b of (state.allBirthdays || [])) {
        if (b.date || b.birthday) wantSync.push({ id: b.id, item: b });
      }
    }

    const { data: syncEntries } = await state.db.from('gcal_sync').select('*').eq('item_type', itemType);
    const syncMap = new Map((syncEntries || []).map(e => [e.item_id, e]));
    const handledIds = new Set();

    for (const { id, item } of wantSync) {
      handledIds.add(id);
      const event = itemToEvent(itemType, item);
      if (!event) continue;
      const existing = syncMap.get(id);
      if (existing?.gcal_event_id) {
        ops.push({ method: 'PATCH', path: `${calPath}/events/${encodeURIComponent(existing.gcal_event_id)}`, body: event });
        opMeta.push({ action: 'update', id, eventId: existing.gcal_event_id, event });
      } else {
        ops.push({ method: 'POST', path: `${calPath}/events`, body: event });
        opMeta.push({ action: 'create', id });
      }
    }

    for (const [itemId, entry] of syncMap) {
      if (handledIds.has(itemId)) continue;
      ops.push({ method: 'DELETE', path: `${calPath}/events/${encodeURIComponent(entry.gcal_event_id)}` });
      opMeta.push({ action: 'delete', id: itemId });
    }
  } else {
    // Targeted sync: only dirty IDs
    for (const itemId of dirtySet) {
      const syncEntry = await getSyncEntry(itemType, itemId);
      let item;

      if (itemType === 'todo') {
        const { data: todos } = await state.db.from('todos').select('*').eq('id', itemId);
        const td = todos?.[0];
        item = (td && !td.done && (td.due_date || td.snoozed_until)) ? td : null;
      } else {
        item = getActiveItem(itemType, itemId);
      }

      if (item) {
        const event = itemToEvent(itemType, item);
        if (!event) continue;
        if (syncEntry?.gcal_event_id) {
          // Update existing event
          ops.push({ method: 'PATCH', path: `${calPath}/events/${encodeURIComponent(syncEntry.gcal_event_id)}`, body: event });
          opMeta.push({ action: 'update', id: itemId, eventId: syncEntry.gcal_event_id, event });
        } else {
          // Create new event
          ops.push({ method: 'POST', path: `${calPath}/events`, body: event });
          opMeta.push({ action: 'create', id: itemId });
        }
      } else if (syncEntry?.gcal_event_id) {
        // Item deleted or lost its date → remove event
        ops.push({ method: 'DELETE', path: `${calPath}/events/${encodeURIComponent(syncEntry.gcal_event_id)}` });
        opMeta.push({ action: 'delete', id: itemId });
      }
    }
  }

  if (ops.length === 0) return;

  // ── Execute batch ──
  const results = await sendBatch(token, ops);

  // ── Process results ──
  for (let i = 0; i < opMeta.length; i++) {
    const meta = opMeta[i];
    const result = results[i] || { status: 0, body: null };

    try {
      if (meta.action === 'create') {
        if (result.status >= 200 && result.status < 300 && result.body?.id) {
          await upsertSyncEntryFallback(itemType, meta.id, result.body.id);
        }
      } else if (meta.action === 'delete') {
        // Only clear sync entry if the delete actually succeeded (or event was already gone)
        const s = result.status;
        if (s === 0 || (s >= 200 && s < 300) || s === 404 || s === 410) {
          await deleteSyncEntry(itemType, meta.id);
        }
      }
      // update: sync entry stays as-is (event ID unchanged)
    } catch (e) {
      console.warn(`Calendar sync failed for ${itemType} ${meta.id}:`, e);
    }
  }
}

/**
 * Full push: sync all items for all enabled types.
 * Called on first enable only (not on page load).
 */
export async function reconcileAll() {
  const prefs = await getCalSyncPrefs();
  if (!prefs.enabled || !prefs.calendarId || state.demoMode || !_getToken) return;

  // Force full scan for each type
  if (prefs.habits) { markDirty('habits', null); await syncTable('habits'); }
  if (prefs.todos) { markDirty('todos', null); await syncTable('todos'); }
  if (prefs.birthdays) { markDirty('birthdays', null); await syncTable('birthdays'); }
}

/**
 * Delete all calendar events for one item type and clear sync entries.
 * Called when a type toggle is turned off.
 */
export async function deleteTypeEvents(itemType) {
  const prefs = await getCalSyncPrefs();
  if (!prefs.calendarId || state.demoMode || !_getToken) return;

  let token;
  try { token = await _getToken(); } catch (_) { return; }
  if (!token) return;

  const calPath = `/calendar/v3/calendars/${encodeURIComponent(prefs.calendarId)}`;

  // Load all sync entries for this type
  const { data: syncEntries } = await state.db.from('gcal_sync').select('*').eq('item_type', itemType);
  if (!syncEntries || syncEntries.length === 0) return;

  // Build delete ops
  const ops = syncEntries.map(e => ({
    method: 'DELETE',
    path: `${calPath}/events/${encodeURIComponent(e.gcal_event_id)}`,
  }));

  const results = await sendBatch(token, ops);

  // Only clear sync entries for successfully deleted events
  for (let i = 0; i < syncEntries.length; i++) {
    const s = results[i]?.status || 0;
    if (s === 0 || (s >= 200 && s < 300) || s === 404 || s === 410) {
      await deleteSyncEntry(itemType, syncEntries[i].item_id);
    }
  }
}

/**
 * Full push for one item type. Called when a type toggle is re-enabled.
 */
export async function pushType(itemType) {
  const tableName = { habit: 'habits', todo: 'todos', birthday: 'birthdays' }[itemType];
  if (!tableName) return;
  markDirty(tableName, null);
  await syncTable(tableName);
}
