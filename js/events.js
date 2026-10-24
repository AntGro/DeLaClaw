import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, showToast, showConfirmAction, fetchAll } from './utils.js';
import { t, getLang } from './i18n.js';
import { wallTimeToInstant, instantToDateStr, instantToTimeStr, localTimeZone, toDateStr, parseLocalDate, gmtOffsetLabel } from './calendar-pure.js';
import { openSharePopover } from './sharing-ui.js';

// ===================================================================
// EVENTS — user calendar events (no page: events live on the Calendar)
// ===================================================================
// Timed events store absolute instants (start_ts / end_ts, UTC ISO)
// plus the IANA timezone they were entered in (timezone); rendering
// converts to the viewer's timezone (calendar-pure eventSpan /
// eventDatesInRange). Full-day events store an inclusive date range
// (start_date..end_date) and never convert. Shared events follow the
// TODO pattern: a minimal local pointer row (shared_id /
// shared_group_id) whose fields are enriched from the group payload
// (events.json) at load; edits/deletes of shared rows go through the
// sharing adapter, never the local row's payload fields.

const _pendingShare = new Set();
const _myCreatedSharedEventIds = new Set();

function isMySharedEvent(ev) {
  return !!ev?.shared_id && _myCreatedSharedEventIds.has(ev.shared_id);
}

async function refreshEvents() {
  if (!state.db.connected) return;
  let data;
  try {
    data = await fetchAll(() => state.db.from('events').select('*').order('created_at', { ascending: true }));
  } catch (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  let rows = data || [];

  // Enrich shared pointers with live payload data (TODO pattern).
  if (state.sharing) {
    const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'event');
    const sharedById = new Map(sharedItems.map(i => [i.id, i]));
    const groupIds = new Set();
    for (const ev of rows) {
      if (!ev.shared_id) continue;
      const sh = sharedById.get(ev.shared_id);
      if (sh) {
        applyPayload(ev, sh.payload || {});
        ev._shared = sh;
        if (ev.shared_group_id) groupIds.add(ev.shared_group_id);
      }
    }
    _myCreatedSharedEventIds.clear();
    if (typeof state.sharing.getCurrentMember === 'function') {
      const gidArr = [...groupIds];
      const members = await Promise.all(gidArr.map(gid => Promise.resolve(state.sharing.getCurrentMember(gid))));
      const memberIdPerGroup = new Map();
      gidArr.forEach((gid, i) => { if (members[i]?.member_id) memberIdPerGroup.set(gid, members[i].member_id); });
      for (const ev of rows) {
        if (!ev._shared || !ev.shared_group_id) continue;
        const myId = memberIdPerGroup.get(ev.shared_group_id);
        if (myId && ev._shared.created_by === myId) _myCreatedSharedEventIds.add(ev.shared_id);
      }
    }
    // Drop pointers whose shared payload could not be resolved.
    rows = rows.filter(ev => !ev.shared_id || ev._shared);
  }

  state.allEvents = rows;
  if (state.currentView === 'calendar' && window.renderCalendar) {
    window.renderCalendar();
  }
}

function applyPayload(ev, p) {
  ev.title = p.title || '';
  ev.note = p.note || null;
  ev.all_day = p.all_day ? 1 : 0;
  ev.start_ts = p.start_ts || null;
  ev.end_ts = p.end_ts || null;
  ev.start_date = p.start_date || null;
  ev.end_date = p.end_date || null;
  ev.timezone = p.timezone || null;
}

function eventPayload(ev) {
  return {
    title: ev.title || '',
    note: ev.note || null,
    all_day: !!ev.all_day,
    start_ts: ev.start_ts || null,
    end_ts: ev.end_ts || null,
    start_date: ev.start_date || null,
    end_date: ev.end_date || null,
    timezone: ev.timezone || null,
  };
}

// ===================================================================
// MODALS — ADD / EDIT (one field builder, two prefixes: new / edit)
// ===================================================================

// Curated shortlist shown as its own group; the full IANA list follows.
// Options carry the zone's GMT offset ON THE EVENT'S DATE (DST-aware).
const COMMON_TIMEZONES = ['UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
const _tzOptionsCache = new Map();

function timezoneOptionsHTML(selected, dateStr) {
  const sel = selected || localTimeZone();
  const key = `${dateStr || ''}|${sel}`;
  const cached = _tzOptionsCache.get(key);
  if (cached) return cached;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.length) zones = [...COMMON_TIMEZONES];
  const local = localTimeZone();
  const label = (tz) => {
    const off = gmtOffsetLabel(tz, dateStr);
    return `${tz.replace(/_/g, ' ')}${off ? ` · ${off}` : ''}`;
  };
  const opt = (tz) => `<option value="${esc(tz)}"${tz === sel ? ' selected' : ''}>${esc(label(tz))}</option>`;
  // The selected zone and the device zone are pinned above the groups so
  // the common cases never need a scroll through ~400 entries.
  const pinned = [...new Set([sel, local])];
  const common = COMMON_TIMEZONES.filter(tz => !pinned.includes(tz) && zones.includes(tz));
  const rest = zones.filter(tz => !pinned.includes(tz));
  let html = pinned.map(opt).join('');
  if (common.length) html += `<optgroup label="${esc(t('events.tz_common'))}">${common.map(opt).join('')}</optgroup>`;
  html += `<optgroup label="${esc(t('events.tz_all'))}">${rest.map(opt).join('')}</optgroup>`;
  if (_tzOptionsCache.size > 8) _tzOptionsCache.clear();
  _tzOptionsCache.set(key, html);
  return html;
}

function eventFieldsHTML(p) {
  return `
    <label>${t('events.title_label')}</label>
    <input type="text" id="${p}EventTitle" class="event-title-input" placeholder="${t('events.title_placeholder')}" maxlength="200"
      data-action="save-${p}-event-on-enter">
    <div class="event-mode" role="group" aria-label="${t('events.all_day')}">
      <button type="button" data-action="event-set-mode" data-prefix="${p}" data-mode="timed">${lucideIcon('clock', 14)}<span>${t('events.timed')}</span></button>
      <button type="button" data-action="event-set-mode" data-prefix="${p}" data-mode="allday">${lucideIcon('calendar-days', 14)}<span>${t('events.all_day')}</span></button>
    </div>
    <input type="checkbox" id="${p}EventAllDay" class="event-allday-state" tabindex="-1">
    <label>${t('events.date_label')}</label>
    <input type="date" id="${p}EventDate" data-action="event-field" data-prefix="${p}">
    <div id="${p}EventEndDateRow" style="display:none">
      <label>${t('events.end_date_label')}</label>
      <input type="date" id="${p}EventEndDate" data-action="event-field" data-prefix="${p}">
    </div>
    <div id="${p}EventTimeRow">
      <div class="event-time-grid">
        <div>
          <label>${t('events.start_label')}</label>
          <input type="time" id="${p}EventStartTime" value="09:00" data-action="event-field" data-prefix="${p}">
        </div>
        <span class="event-time-arrow">${lucideIcon('arrow-right', 15)}</span>
        <div>
          <label>${t('events.end_label')}</label>
          <input type="time" id="${p}EventEndTime" value="10:00" data-action="event-field" data-prefix="${p}">
        </div>
      </div>
      <label>${t('events.timezone_label')}</label>
      <select id="${p}EventTimezone" data-action="event-field" data-prefix="${p}"></select>
    </div>
    <div class="event-summary" id="${p}EventSummary" style="display:none"></div>
    <label>${t('events.note_label')}</label>
    <input type="text" id="${p}EventNote" placeholder="${t('events.note_placeholder')}" maxlength="1000">`;
}

function addEventModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('calendar-plus', 20)} ${t('events.add_event')}</h2>
    ${eventFieldsHTML('new')}
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-event">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-event">${t('common.add')}</button>
    </div>
  </div>`;
}

function editEventModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('events.edit_event')}</h2>
    <input type="hidden" id="editEventId">
    ${eventFieldsHTML('edit')}
    <div class="modal-actions">
      <button class="modal-delete" data-action="delete-event" id="editEventDeleteBtn" data-id="">${lucideIcon('trash-2', 14)} ${t('common.delete')}</button>
      <span id="editEventShareSlot"></span>
      <button class="modal-cancel" data-action="close-edit-event">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-event">${t('common.save')}</button>
    </div>
  </div>`;
}

function initEventModals() {
  const app = document.getElementById('app');
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addEventModal';
  m1.innerHTML = addEventModalHTML();
  app.appendChild(m1);

  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editEventModal';
  m2.dataset.action = 'close-edit-event';
  m2.dataset.overlayClose = 'true';
  m2.innerHTML = editEventModalHTML();
  app.appendChild(m2);
}

// ===================================================================
// MODAL OPEN / CLOSE + FIELD PLUMBING
// ===================================================================

function toggleEventAllDay(prefix, checked) {
  const timeRow = document.getElementById(`${prefix}EventTimeRow`);
  const endRow = document.getElementById(`${prefix}EventEndDateRow`);
  if (timeRow) timeRow.style.display = checked ? 'none' : '';
  if (endRow) endRow.style.display = checked ? '' : 'none';
  document.querySelectorAll(`[data-action="event-set-mode"][data-prefix="${prefix}"]`)
    .forEach(b => b.classList.toggle('active', (b.dataset.mode === 'allday') === !!checked));
  if (checked) {
    const dateEl = document.getElementById(`${prefix}EventDate`);
    const endEl = document.getElementById(`${prefix}EventEndDate`);
    if (dateEl && endEl && !endEl.value) endEl.value = dateEl.value;
  }
}

function setEventMode(prefix, mode) {
  const cb = document.getElementById(`${prefix}EventAllDay`);
  if (!cb) return;
  cb.checked = mode === 'allday';
  toggleEventAllDay(prefix, cb.checked);
  updateEventSummary(prefix);
}

/**
 * Live one-line summary of what will be created: the day and times as
 * entered, plus — when the event's timezone differs from the device's —
 * the converted local times. This is the instant model made visible
 * before saving. Also keeps the timezone options' GMT offsets in sync
 * with the chosen date (they shift with DST).
 */
function updateEventSummary(prefix) {
  const el = document.getElementById(`${prefix}EventSummary`);
  if (!el) return;
  const date = document.getElementById(`${prefix}EventDate`)?.value;
  const allDay = document.getElementById(`${prefix}EventAllDay`)?.checked;
  const sel = document.getElementById(`${prefix}EventTimezone`);
  if (sel && date) {
    const cur = sel.value || localTimeZone();
    const fresh = timezoneOptionsHTML(cur, date);
    if (sel.innerHTML !== fresh) { sel.innerHTML = fresh; sel.value = cur; }
  }
  let html = '';
  if (date) {
    const fmtDay = (ds) => parseLocalDate(ds).toLocaleDateString(getLang(), { weekday: 'short', day: 'numeric', month: 'short' });
    if (allDay) {
      const end = document.getElementById(`${prefix}EventEndDate`)?.value || date;
      html = end > date
        ? `${esc(fmtDay(date))} → ${esc(fmtDay(end))} · ${t('events.all_day')} · ${t('events.days_n', Math.round((parseLocalDate(end) - parseLocalDate(date)) / 86400000) + 1)}`
        : `${esc(fmtDay(date))} · ${t('events.all_day')}`;
    } else {
      const tz = sel?.value || localTimeZone();
      const st = document.getElementById(`${prefix}EventStartTime`)?.value;
      const et = document.getElementById(`${prefix}EventEndTime`)?.value;
      if (st && et) {
        const city = (z) => z.split('/').pop().replace(/_/g, ' ');
        html = `${esc(fmtDay(date))} · ${esc(st)} – ${esc(et)} ${esc(city(tz))}`;
        const local = localTimeZone();
        if (tz !== local) {
          const sI = wallTimeToInstant(date, st, tz);
          const eI = wallTimeToInstant(date, et, tz);
          if (sI && eI) html += ` <span class="event-summary-local">→ ${esc(instantToTimeStr(sI, local))} – ${esc(instantToTimeStr(eI, local))} ${esc(city(local))}</span>`;
        }
      }
    }
  }
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

function fillEventForm(prefix, ev, presetDate) {
  const tzSel = document.getElementById(`${prefix}EventTimezone`);
  const tz = ev?.timezone || localTimeZone();
  const dateForTz = ev?.all_day ? (ev.start_date || presetDate) : (ev?.start_ts ? instantToDateStr(ev.start_ts, tz) : presetDate);
  if (tzSel) tzSel.innerHTML = timezoneOptionsHTML(tz, dateForTz);
  document.getElementById(`${prefix}EventTitle`).value = ev?.title || '';
  document.getElementById(`${prefix}EventNote`).value = ev?.note || '';
  const allDay = !!ev?.all_day;
  document.getElementById(`${prefix}EventAllDay`).checked = allDay;
  if (allDay) {
    document.getElementById(`${prefix}EventDate`).value = ev.start_date || presetDate || '';
    document.getElementById(`${prefix}EventEndDate`).value = ev.end_date || ev.start_date || presetDate || '';
  } else if (ev?.start_ts) {
    // Edit in the event's own timezone: the wall times the user set.
    document.getElementById(`${prefix}EventDate`).value = instantToDateStr(ev.start_ts, tz);
    document.getElementById(`${prefix}EventStartTime`).value = instantToTimeStr(ev.start_ts, tz) || '09:00';
    document.getElementById(`${prefix}EventEndTime`).value = instantToTimeStr(ev.end_ts, tz) || '10:00';
    document.getElementById(`${prefix}EventEndDate`).value = instantToDateStr(ev.start_ts, tz);
  } else {
    document.getElementById(`${prefix}EventDate`).value = presetDate || '';
    document.getElementById(`${prefix}EventEndDate`).value = presetDate || '';
  }
  toggleEventAllDay(prefix, allDay);
  if (tzSel) tzSel.value = tz;
  updateEventSummary(prefix);
}

/** Read a form into event fields, or null (a toast explains why). */
function readEventForm(prefix) {
  const title = document.getElementById(`${prefix}EventTitle`).value.trim();
  const note = document.getElementById(`${prefix}EventNote`).value.trim();
  const date = document.getElementById(`${prefix}EventDate`).value;
  const allDay = document.getElementById(`${prefix}EventAllDay`).checked;
  if (!title) { showToast(t('events.enter_title'), 'error'); return null; }
  if (!date) { showToast(t('events.enter_date'), 'error'); return null; }
  if (allDay) {
    const endDate = document.getElementById(`${prefix}EventEndDate`).value || date;
    if (endDate < date) { showToast(t('events.end_before_start'), 'error'); return null; }
    return { title, note: note || null, all_day: 1, start_date: date, end_date: endDate, start_ts: null, end_ts: null, timezone: null };
  }
  const startTime = document.getElementById(`${prefix}EventStartTime`).value;
  const endTime = document.getElementById(`${prefix}EventEndTime`).value;
  const tz = document.getElementById(`${prefix}EventTimezone`).value || localTimeZone();
  if (!startTime || !endTime) { showToast(t('events.enter_times'), 'error'); return null; }
  const start_ts = wallTimeToInstant(date, startTime, tz);
  const end_ts = wallTimeToInstant(date, endTime, tz);
  if (!start_ts || !end_ts || end_ts <= start_ts) { showToast(t('events.end_after_start'), 'error'); return null; }
  return { title, note: note || null, all_day: 0, start_ts, end_ts, start_date: null, end_date: null, timezone: tz };
}

function openAddEventModal(presetDate) {
  const modal = document.getElementById('addEventModal');
  modal.innerHTML = addEventModalHTML();
  modal.style.setProperty('--cat-color', 'var(--event-color)');
  const now = new Date();
  fillEventForm('new', null, presetDate || toDateStr(now.getFullYear(), now.getMonth(), now.getDate()));
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('newEventTitle').focus(), 100);
}

function closeAddEventModal() {
  document.getElementById('addEventModal').classList.remove('visible');
}

function openEditEventModal(id) {
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev) return;
  const modal = document.getElementById('editEventModal');
  modal.innerHTML = editEventModalHTML();
  modal.style.setProperty('--cat-color', 'var(--event-color)');
  document.getElementById('editEventId').value = id;
  fillEventForm('edit', ev, null);
  document.getElementById('editEventDeleteBtn').dataset.id = id;
  renderEditEventShareSlot(ev);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('editEventTitle').focus(), 100);
}

function renderEditEventShareSlot(ev) {
  const slot = document.getElementById('editEventShareSlot');
  if (!slot) return;
  if (!state.sharing) { slot.innerHTML = ''; return; }
  if (!ev.shared_id) {
    slot.innerHTML = `<button class="btn" data-action="share-event" data-id="${esc(ev.id)}">${lucideIcon('share', 14)} ${t('sharing.share')}</button>`;
  } else if (isMySharedEvent(ev)) {
    slot.innerHTML = `<button class="btn" data-action="unshare-event" data-id="${esc(ev.id)}">${lucideIcon('share-off', 14)} ${t('sharing.unshare')}</button>`;
  } else {
    slot.innerHTML = `<button class="btn" data-action="copy-event-to-personal" data-id="${esc(ev.id)}">${lucideIcon('copy', 14)} ${t('sharing.copy_to_personal')}</button>`;
  }
}

function closeEditEventModal() {
  document.getElementById('editEventModal').classList.remove('visible');
}

// ===================================================================
// CRUD
// ===================================================================

async function saveNewEvent() {
  const fields = readEventForm('new');
  if (!fields) return;
  const { error } = await state.db.from('events').insert(fields);
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  closeAddEventModal();
  showToast(t('events.event_added', fields.title), 'success');
  await refreshEvents();
  pokeCalendarSync();
}

async function saveEditEvent() {
  const id = document.getElementById('editEventId').value;
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev) return;
  const fields = readEventForm('edit');
  if (!fields) return;
  if (ev.shared_id && ev.shared_group_id) {
    // Shared: the payload is canonical — update it via the adapter.
    try {
      await state.sharing.updateItem(ev.shared_group_id, ev.shared_id, { payload: { ...eventPayload(ev), ...fields, all_day: !!fields.all_day } });
    } catch (e) { showToast(e.message, 'error'); return; }
    closeEditEventModal();
    showToast(t('events.event_updated'), 'success');
    await refreshEvents();
    pokeCalendarSync();
    return;
  }
  const { error } = await state.db.from('events').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
  closeEditEventModal();
  showToast(t('events.event_updated'), 'success');
  await refreshEvents();
  pokeCalendarSync();
}

async function deleteEvent(id) {
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev) return;
  showConfirmAction(
    t('events.delete_title'),
    t('events.delete_confirm', ev.title),
    async () => {
      if (ev.shared_id && ev.shared_group_id) {
        try { await state.sharing.deleteItem(ev.shared_group_id, ev.shared_id); }
        catch (e) { showToast(e.message, 'error'); return; }
      }
      const { error } = await state.db.from('events').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      closeEditEventModal();
      if (window.closeCalendarDay) window.closeCalendarDay();
      showToast(t('events.event_removed'), 'info');
      await refreshEvents();
      pokeCalendarSync();
    }
  );
}

/** After any event change, the Google Calendar mirror needs a pass. */
function pokeCalendarSync() {
  if (typeof state.syncCalendarTable === 'function') {
    state.syncCalendarTable('events').catch(() => {});
  }
}

// ===================================================================
// SHARING — share / unshare / copy (TODO pattern)
// ===================================================================

async function shareEvent(id, el) {
  if (!state.sharing) return;
  if (_pendingShare.has(id)) return;
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev || ev.shared_id) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-event"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  openSharePopover(btn, (groupId) => {
    if (_pendingShare.has(id)) return;
    _pendingShare.add(id);
    btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true');
    (async () => {
      const sharedId = crypto.randomUUID();
      const payload = eventPayload(ev);
      const personalRow = { ...ev };
      delete personalRow._shared;
      let onStaged;
      let wasStaged = false;
      const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
      let locallyStaged = false;
      const upload = state.sharing.addItem(groupId, { id: sharedId, item_type: 'event', payload, onStaged });
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (driveErr) => {
          if (locallyStaged) {
            await state.db.from('events').delete().eq('shared_id', sharedId);
            await state.db.from('events').insert(personalRow);
            await refreshEvents();
          }
          showToast(driveErr.message, 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      if (!wasStaged) return;
      const { error: ptrErr } = await state.db.from('events').insert({
        title: '', all_day: 0, shared_id: sharedId, shared_group_id: groupId,
      });
      if (ptrErr) {
        state.sharing.deleteItem(groupId, sharedId).catch(() => {});
        showToast(ptrErr.message, 'error');
        return;
      }
      await state.db.from('events').delete().eq('id', ev.id);
      locallyStaged = true;
      closeEditEventModal();
      await refreshEvents();
      pokeCalendarSync();
    })().catch(e => showToast(e.message, 'error'))
      .finally(() => {
        _pendingShare.delete(id);
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
      });
  }, { showAssignees: false });
}

async function unshareEvent(id, el) {
  if (!state.sharing) return;
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev || !ev.shared_id || !ev.shared_group_id) return;
  showConfirmAction(
    t('sharing.unshare'),
    t('sharing.unshare_confirm'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unshare-event"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        const fields = eventPayload(ev);
        const { data: personalRow, error: insErr } = await state.db.from('events').insert({
          title: fields.title, note: fields.note, all_day: fields.all_day ? 1 : 0,
          start_ts: fields.start_ts, end_ts: fields.end_ts,
          start_date: fields.start_date, end_date: fields.end_date, timezone: fields.timezone,
        }).select().single();
        if (insErr) { showToast(insErr.message, 'error'); return; }
        const pointerRow = { ...ev };
        delete pointerRow._shared;
        await state.db.from('events').delete().eq('id', ev.id);
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteItem(ev.shared_group_id, ev.shared_id, { onStaged });
        upload.then(
          () => showToast(t('sharing.unshared'), 'success'),
          async (e) => {
            console.warn('Failed to unshare event on Drive:', e);
            if (personalRow?.id) await state.db.from('events').delete().eq('id', personalRow.id);
            await state.db.from('events').insert(pointerRow);
            await refreshEvents();
            showToast(e.message, 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
        closeEditEventModal();
        await refreshEvents();
        pokeCalendarSync();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
      }
    },
    null,
    { variant: 'neutral', btnText: t('sharing.unshare'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
  );
}

async function copyEventToPersonal(id, el) {
  if (!state.sharing) return;
  const ev = (state.allEvents || []).find(x => x.id === id);
  if (!ev || !ev.shared_id) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="copy-event-to-personal"][data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try {
    const fields = eventPayload(ev);
    const { error: insErr } = await state.db.from('events').insert({
      title: fields.title, note: fields.note, all_day: fields.all_day ? 1 : 0,
      start_ts: fields.start_ts, end_ts: fields.end_ts,
      start_date: fields.start_date, end_date: fields.end_date, timezone: fields.timezone,
    });
    if (insErr) { showToast(insErr.message, 'error'); return; }
    showToast(t('sharing.copied_to_personal'), 'success');
    await refreshEvents();
    pokeCalendarSync();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}

// ===================================================================
// SHARED POINTER SYNC — create/drop local pointers as group events
// appear and disappear remotely (TODO pattern), and drive the Google
// Calendar mirror when a remote edit changes payload fields.
// ===================================================================

const _sharedEventCalFp = new Map();
const _sharedEventSeenAt = new Map();
function sharedEventCalFingerprint(sh) {
  const p = sh.payload || {};
  return JSON.stringify([
    p.title || '', p.note || null, p.all_day ? 1 : 0,
    p.start_ts || null, p.end_ts || null,
    p.start_date || null, p.end_date || null, p.timezone || null,
    sh.group_name || '',
  ]);
}

let _syncingEvents = false;
async function syncSharedEvents() {
  if (_syncingEvents) return false;
  _syncingEvents = true;
  try {
    return await _doSyncSharedEvents();
  } finally {
    _syncingEvents = false;
  }
}

async function _doSyncSharedEvents() {
  if (!state.sharing || !state.db?.connected) return false;

  const allShared = state.sharing.getAllSharedItems().filter(i => i.item_type === 'event');
  let localShared = [];
  try {
    const rows = await fetchAll(() => state.db.from('events').select('id,shared_id,shared_group_id'));
    localShared = (rows || []).filter(ev => ev.shared_id);
  } catch (e) {
    console.warn('syncSharedEvents: failed to load local pointers', e);
    localShared = (state.allEvents || []).filter(ev => ev.shared_id);
  }
  const localBySharedId = new Map(localShared.map(ev => [ev.shared_id, ev]));
  const driveSharedIds = new Set(allShared.map(i => i.id));
  let needsRefresh = false;

  // Create pointers for new shared events
  for (const sh of allShared) {
    if (!localBySharedId.has(sh.id)) {
      if (state.sharing.hasPendingCreate(sh.group_id, sh.id)) continue;
      const { data: existing } = await state.db.from('events').select('id').eq('shared_id', sh.id).limit(1);
      if (existing?.length) continue;
      const { error } = await state.db.from('events').insert({
        title: '', all_day: 0, shared_id: sh.id, shared_group_id: sh.group_id,
      });
      if (error) { console.warn('syncSharedEvents: failed to create pointer', sh.id, error); continue; }
      needsRefresh = true;
    }
  }

  // Calendar dirty marks + remote-edit detection
  let calDirtyMarked = false;
  for (const sh of allShared) {
    const fp = sharedEventCalFingerprint(sh);
    const prev = _sharedEventCalFp.get(sh.id);
    _sharedEventCalFp.set(sh.id, fp);
    if (prev !== undefined && prev !== fp) {
      const pointer = localBySharedId.get(sh.id);
      if (pointer) { state.markCalDirty?.('events', pointer.id); calDirtyMarked = true; }
    }
    const prevSeen = _sharedEventSeenAt.get(sh.id);
    _sharedEventSeenAt.set(sh.id, sh.updated_at);
    if (prevSeen !== undefined && prevSeen !== sh.updated_at) needsRefresh = true;
  }
  if (calDirtyMarked) await state.syncCalendarTable?.('events');

  // Cleanup: pointers whose shared item vanished while the group lives
  for (const local of localShared) {
    if (!driveSharedIds.has(local.shared_id)) {
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        await state.db.from('events').delete().eq('id', local.id);
        _sharedEventSeenAt.delete(local.shared_id);
        needsRefresh = true;
      }
    }
  }

  return needsRefresh;
}

export { refreshEvents, initEventModals, isMySharedEvent, syncSharedEvents };

window.syncSharedEvents = syncSharedEvents;
window.openAddEventModal = openAddEventModal;
window.closeAddEventModal = closeAddEventModal;
window.saveNewEvent = saveNewEvent;
window.openEditEventModal = openEditEventModal;
window.closeEditEventModal = closeEditEventModal;
window.saveEditEvent = saveEditEvent;
window.deleteEvent = deleteEvent;
window.toggleEventAllDay = toggleEventAllDay;
window.setEventMode = setEventMode;
window.updateEventSummary = updateEventSummary;
window.shareEvent = shareEvent;
window.unshareEvent = unshareEvent;
window.copyEventToPersonal = copyEventToPersonal;
