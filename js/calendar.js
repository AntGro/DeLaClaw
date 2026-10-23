// ===================================================================
// calendar.js — Calendar page: month grid of todos, habits & birthdays.
//
// Replaces the Birthdays tab/page (the birthdays table and its CRUD live
// in js/birthdays.js). Date math lives in js/calendar-pure.js.
// ===================================================================

import state, { CALENDAR_PREFS_KEY } from './state.js';
import { esc, renderMd } from './utils.js';
import { lucideIcon } from './icons.js';
import { sharedBadge } from './sharing-ui.js';
import { t, getLang } from './i18n.js';
import { getTodos, catIdForTodo, getCategoryColor, getTodoCatPath, getTodoCatOrderKey } from './todos.js';
import { computeNextDue, isStructuredRule, normalizeFrequencyRule, catIdForHabit, getHabitCategoryColor, getHabitCatPath, getHabitCatOrderKey, isAutoHabit } from './habits.js';
import { compareOrderKeys } from './sections-pure.js';
import { toDateStr, getMonthGrid, expandHabitOccurrences, birthdaysInRange, toggleShow, addDays, getWeekDates, isHabitSnoozed } from './calendar-pure.js';

let calYear;
let calMonth; // 0-based
let calDate; // 'YYYY-MM-DD' anchor for day/week views (always in sync with calYear/calMonth)
// Display preferences — view granularity and type filters — persist
// per device in localStorage (like the theme and the current tab), so
// they survive reloads without fighting across devices the way a
// synced setting would.
function loadCalPrefs() {
  try { return JSON.parse(localStorage.getItem(CALENDAR_PREFS_KEY)) || {}; } catch { return {}; }
}
const _calPrefs = loadCalPrefs();
let calView = ['day', 'week', 'month', 'year'].includes(_calPrefs.view) ? _calPrefs.view : 'month'; // 'day' | 'week' | 'month' | 'year'
let calPanelDate = null; // date string of the open day panel, if any
let calAddCleanup = null;
let calShow = { // type filters
  todo: _calPrefs.show?.todo !== false,
  habit: _calPrefs.show?.habit !== false,
  birthday: _calPrefs.show?.birthday !== false,
};

function saveCalPrefs() {
  try { localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ view: calView, show: calShow })); } catch {}
}

// Reflect calView/calShow on the toolbar buttons (the static HTML
// defaults to Month + all filters on, so this also repairs the
// buttons on first paint after a restore).
function syncCalendarToolbar() {
  document.querySelectorAll('#calendarViewMenu [data-action="set-calendar-view"]').forEach(btn => {
    const active = btn.dataset.view === calView;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  document.querySelectorAll('[data-action="toggle-calendar-filter"]').forEach(btn => {
    const active = !!calShow[btn.dataset.filter];
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

const TYPE_ORDER = { todo: 0, habit: 1, birthday: 2 };
const MAX_CHIPS = 3;

function setAnchor(dateStr) {
  calDate = dateStr;
  const [y, m] = dateStr.split('-').map(Number);
  calYear = y;
  calMonth = m - 1;
}

function ensureInit() {
  if (calDate === undefined) {
    const now = new Date();
    setAnchor(toDateStr(now.getFullYear(), now.getMonth(), now.getDate()));
  }
}

function todayStr() {
  const now = new Date();
  return toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function monthStartStr() { return toDateStr(calYear, calMonth, 1); }
function monthEndStr() {
  return toDateStr(calYear, calMonth, new Date(calYear, calMonth + 1, 0).getDate());
}

// -------------------------------------------------------------------
// Event collection
// -------------------------------------------------------------------

function collectMonthEvents() {
  return collectRangeEvents(monthStartStr(), monthEndStr());
}

function collectRangeEvents(start, end) {
  const map = new Map(); // dateStr → [{ type, id, title, sub, avatar }]
  const push = (date, ev) => {
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(ev);
  };
  const today = todayStr();

  // TODOs: on their due date; an overdue TODO also appears on today
  // (it still needs doing today). Overdue instances are flagged for
  // the dashed-red highlight.
  for (const td of getTodos()) {
    if (!calShow.todo) break;
    if (td.done) continue;
    const d = (td.due_date || '').slice(0, 10);
    if (!d) continue;
    const catId = catIdForTodo(td);
    const evBase = {
      type: 'todo', id: td.id, title: td.text || '', sub: '',
      catId, catColor: getCategoryColor(catId), catName: getTodoCatPath(catId), catOrder: getTodoCatOrderKey(catId),
      shared_id: td.shared_id || null, shared_group_id: td.shared_group_id || null,
    };
    const overdue = d < today;
    if (d >= start && d <= end) push(d, { ...evBase, ...(overdue ? { overdue: true } : {}) });
    if (overdue && today >= start && today <= end) push(today, { ...evBase, overdue: true, dueToday: true });
  }

  // Habits: every occurrence of structured rules within the month;
  // free-text rules pin a single occurrence on next_due.
  for (const h of state.allHabits || []) {
    if (!calShow.habit) break;
    if (h.is_draft) continue;
    if (h.is_finished) continue;
    const rule = normalizeFrequencyRule(h.frequency_rule || '');
    const hCatId = catIdForHabit(h);
    const hBase = {
      type: 'habit', id: h.id, title: h.name || '', sub: '',
      catId: hCatId, catColor: getHabitCategoryColor(hCatId), catName: getHabitCatPath(hCatId), catOrder: getHabitCatOrderKey(hCatId),
      next_due: (h.next_due || '').slice(0, 10) || null,
      shared_id: h.shared_id || null, shared_group_id: h.shared_group_id || null,
      is_auto: isAutoHabit(h),
    };
    // While a snooze is active, occurrences inside the window are hidden;
    // occurrences on/after the wake date show normally (the habit wakes
    // that day, overdue if its due date passed during the window).
    const snoozed = isHabitSnoozed(h, today);
    const ndStr = (h.next_due || '').slice(0, 10);
    const habitOverdue = !!ndStr && ndStr < today;
    if (rule && !isStructuredRule(rule)) {
      const d = ndStr;
      if (d && d >= start && d <= end && !(h.end_date && d > h.end_date) && !(snoozed && d < h.snoozed_until)) {
        push(d, { ...hBase, ...(habitOverdue ? { overdue: true } : {}) });
      }
      // Overdue free-text habit: no cadence to project, but it still
      // needs doing today — mirror it onto today like structured ones.
      if (habitOverdue && today >= start && today <= end && !(h.end_date && d > h.end_date) && !(snoozed && today < h.snoozed_until)) {
        push(today, { ...hBase, overdue: true, dueToday: true });
      }
      continue;
    }
    const occ = expandHabitOccurrences(
      { frequency_rule: rule, next_due: h.next_due, end_date: h.end_date },
      start, end,
      (r, lastDone) => computeNextDue(r, lastDone),
      today,
    );
    for (const d of occ) {
      if (snoozed && d < h.snoozed_until) continue;
      push(d, {
        ...hBase,
        ...(habitOverdue && (d === ndStr || d === today) ? { overdue: true } : {}),
        ...(habitOverdue && d === today ? { dueToday: true } : {}),
      });
    }
  }

  // Birthdays: yearly occurrence in every month the range spans
  for (const b of state.allBirthdays || []) {
    if (!calShow.birthday) break;
    for (const occ of birthdaysInRange(b.birthday, start, end)) {
      push(occ.date, {
        type: 'birthday', id: b.id, title: b.name || '',
        sub: t('calendar.turns', occ.turningAge), avatar: b.avatar_url || null,
      });
    }
  }

  for (const evs of map.values()) evs.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  return map;
}

// -------------------------------------------------------------------
// Grid rendering
// -------------------------------------------------------------------

function weekdayNames() {
  // A known Monday (Oct 5, 2026) + 7 days → locale short weekday names
  const fmt = new Intl.DateTimeFormat(getLang(), { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 9, 5 + i)));
}

function chipHTML(ev, hidden) {
  const icon = ev.type === 'birthday' && ev.avatar
    ? `<img src="${esc(ev.avatar)}" alt="" class="cal-chip-avatar">`
    : `<i></i>`;
  // TODOs/habits render markdown like their own pages do; birthdays stay plain text
  const title = ev.type === 'birthday' ? esc(ev.title) : renderMd(ev.title);
  // Shape encodes the type; background encodes the item's category color
  // (birthdays have no category → type color fallback).
  const catColor = ev.catColor || (ev.type === 'birthday' ? 'var(--pink)' : 'var(--accent)');
  return `<span class="cal-chip cal-${ev.type}${ev.overdue ? ' cal-chip-overdue' : ''}" style="--cat-color:${catColor}"${hidden ? ' data-hidden=""' : ''}>${icon}<span>${title}</span></span>`;
}

// Show as many chips per day cell as fit in the available space, hiding the
// rest behind the +N counter. Runs synchronously right after render (reading
// scrollHeight forces layout, so there is no un-fitted flash).
function fitCalendarChips() {
  const grid = document.getElementById('calendarGrid');
  if (!grid || !grid.offsetParent) return; // view hidden
  // Lock each week row to its laid-out height first: otherwise revealing a
  // chip grows the row (flex-shrink: 0) and everything trivially "fits".
  const rows = [...grid.querySelectorAll('.cal-week')];
  for (const row of rows) row.style.height = row.clientHeight + 'px';
  try {
    for (const cell of grid.querySelectorAll('.cal-day')) {
      const wrap = cell.querySelector('.cal-chips');
      if (!wrap || getComputedStyle(wrap).display === 'none') continue; // dots-only mode
      const chips = [...wrap.querySelectorAll('.cal-chip')];
      const total = chips.length;
      if (!total) continue;
      const more = wrap.querySelector('.cal-more');
      const setShown = (n) => chips.forEach((c, i) => c.toggleAttribute('data-hidden', i >= n));
      const fits = () => cell.scrollHeight <= cell.clientHeight + 1;
      let shown = Math.min(MAX_CHIPS, total);
      setShown(shown);
      while (shown > 0 && !fits()) { shown--; setShown(shown); }
      while (shown < total) {
        setShown(shown + 1);
        if (fits()) shown++;
        else { setShown(shown); break; }
      }
      const remaining = total - shown;
      if (more) {
        if (remaining > 0) { more.textContent = `+${remaining}`; more.style.display = ''; }
        else more.style.display = 'none';
      }
    }
  } finally {
    for (const row of rows) row.style.height = '';
  }
}

let calResizeTimer = null;
function armCalendarResize() {
  if (armCalendarResize.done) return;
  armCalendarResize.done = true;
  window.addEventListener('resize', () => {
    clearTimeout(calResizeTimer);
    calResizeTimer = setTimeout(() => {
      if (state.currentView === 'calendar') renderCalendar();
    }, 200);
  });
}

function dayCellHTML(date, inMonth, events, dowLabel) {
  const dayNum = parseInt(date.slice(8, 10), 10);
  const evs = events.get(date) || [];
  const chips = evs.map((e, i) => chipHTML(e, i >= MAX_CHIPS)).join('');
  const more = evs.length > MAX_CHIPS
    ? `<span class="cal-more">+${evs.length - MAX_CHIPS}</span>` : '';
  const dots = evs.slice(0, 5).map(e => `<i class="cal-dot cal-${e.type}"></i>`).join('');
  // Week view passes its weekday label: on narrow screens the week
  // grid wraps to two rows, the 7-column header no longer aligns,
  // and the weekday is shown inside the cell instead (CSS reveals
  // .cal-day-dow only in that layout).
  const dow = dowLabel ? `<span class="cal-day-dow">${esc(dowLabel)}</span>` : '';
  return `<button class="cal-day${inMonth ? '' : ' cal-out'}${date === todayStr() ? ' cal-today' : ''}"
      data-action="open-calendar-day" data-date="${date}">
    <span class="cal-day-num">${dayNum}</span>${dow}
    <span class="cal-chips">${chips}${more}</span>
    <span class="cal-dots">${dots}</span>
  </button>`;
}

function fullDateStr(dateStr) {
  return new Intl.DateTimeFormat(getLang(), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(parseDateStr(dateStr));
}

function labelSeg(picker, text) {
  return `<button class="cal-label-seg" data-action="open-calendar-picker" data-picker="${picker}">${esc(text)}${lucideIcon('chevron-down', 12)}</button>`;
}

function updateCalendarLabel() {
  const label = document.getElementById('calendarMonthLabel');
  if (!label) return;
  const monthName = new Intl.DateTimeFormat(getLang(), { month: 'long' }).format(new Date(calYear, calMonth, 1));
  if (calView === 'year') {
    label.innerHTML = labelSeg('year', String(calYear));
  } else if (calView === 'day') {
    const dayNum = parseInt(calDate.slice(8, 10), 10);
    label.innerHTML = labelSeg('day', String(dayNum)) + ' ' + labelSeg('month', monthName) + ' ' + labelSeg('year', String(calYear));
  } else {
    label.innerHTML = labelSeg('month', monthName) + ' ' + labelSeg('year', String(calYear));
  }
}

// Jump pickers: pick a month/year/day without repeated prev/next clicks.
// The anchor day is kept when valid in the target month (clamped otherwise).
function daysInMonthOf(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

function openCalendarPicker(kind, btn) {
  const menu = document.getElementById('calendarPickerMenu');
  if (!menu) return;
  closeCalendarAddMenu();
  const cur = { y: calYear, m: calMonth, d: parseInt(calDate.slice(8, 10), 10) };
  if (kind === 'month') {
    let cells = '';
    for (let m = 0; m < 12; m++) {
      const name = new Intl.DateTimeFormat(getLang(), { month: 'short' }).format(new Date(cur.y, m, 1));
      cells += `<button class="${m === cur.m ? 'active' : ''}" data-action="pick-calendar-month" data-month="${m}" role="menuitemradio" aria-checked="${m === cur.m}">${esc(name)}</button>`;
    }
    menu.innerHTML = `<div class="cal-picker-grid">${cells}</div>`;
  } else if (kind === 'year') {
    let cells = '';
    for (let y = cur.y - 6; y <= cur.y + 6; y++) {
      cells += `<button class="${y === cur.y ? 'active' : ''}" data-action="pick-calendar-year" data-year="${y}" role="menuitemradio" aria-checked="${y === cur.y}">${y}</button>`;
    }
    menu.innerHTML = `<div class="cal-picker-grid">${cells}</div>`;
  } else {
    menu.innerHTML = `<input type="date" class="cal-picker-date" data-action="pick-calendar-day" value="${calDate}" aria-label="${t('calendar.day')}">`;
  }
  menu.style.display = '';
  menu.style.left = ''; menu.style.right = '';
  clampMenuToViewport(menu);
  armMenuDismiss(menu, [document.getElementById('calendarMonthLabel')]);
  if (kind === 'day') {
    const input = menu.querySelector('input');
    if (input) {
      input.focus();
      try { input.showPicker && input.showPicker(); } catch (e) { /* keep the inline input */ }
    }
  }
}

function pickCalendarMonth(m) {
  m = parseInt(m, 10);
  const day = Math.min(parseInt(calDate.slice(8, 10), 10), daysInMonthOf(calYear, m));
  setAnchor(toDateStr(calYear, m, day));
  closeCalendarAddMenu();
  renderCalendar();
}

function pickCalendarYear(y) {
  y = parseInt(y, 10);
  const [yy, mm, dd] = calDate.split('-').map(Number);
  const day = Math.min(dd, daysInMonthOf(y, mm - 1));
  setAnchor(toDateStr(y, mm - 1, day));
  closeCalendarAddMenu();
  renderCalendar();
}

function pickCalendarDay(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) setAnchor(dateStr);
  closeCalendarAddMenu();
  renderCalendar();
}

function renderCalendar() {
  ensureInit();
  const grid = document.getElementById('calendarGrid');
  if (!grid) return;
  syncCalendarToolbar();
  updateCalendarLabel();
  armCalendarResize();
  if (calView === 'week') renderWeekView(grid);
  else if (calView === 'day') renderDayView(grid);
  else if (calView === 'year') renderYearView(grid);
  else renderMonthView(grid);
  fitCalendarChips();
  // Keep an open day panel in sync (e.g. after add/edit/delete)
  if (calPanelDate) renderCalendarDayPanel(calPanelDate);
}

function renderMonthView(grid) {
  const events = collectMonthEvents();
  const weeks = getMonthGrid(calYear, calMonth);
  let html = `<div class="cal-weekdays">${weekdayNames().map(w => `<span>${esc(w)}</span>`).join('')}</div>`;
  html += '<div class="cal-weeks">';
  for (const week of weeks) {
    html += '<div class="cal-week">';
    for (const cell of week) html += dayCellHTML(cell.date, cell.inMonth, events);
    html += '</div>';
  }
  html += '</div>';
  grid.innerHTML = html;
}

function renderWeekView(grid) {
  const dates = getWeekDates(calDate);
  const events = collectRangeEvents(dates[0], dates[6]);
  const names = weekdayNames();
  let html = `<div class="cal-weekdays">${names.map(w => `<span>${esc(w)}</span>`).join('')}</div>`;
  html += '<div class="cal-week cal-week-page">';
  dates.forEach((date, i) => { html += dayCellHTML(date, true, events, names[i]); });
  html += '</div>';
  grid.innerHTML = html;
}

function monthShortName(m) {
  return new Intl.DateTimeFormat(getLang(), { month: 'short' }).format(new Date(calYear, m, 1));
}

function renderYearView(grid) {
  const events = collectRangeEvents(`${calYear}-01-01`, `${calYear}-12-31`);
  let html = '<div class="cal-year">';
  for (let m = 0; m < 12; m++) {
    html += `<div class="cal-mini">
      <button class="cal-mini-title" data-action="set-calendar-view" data-view="month" data-month="${m}">${esc(monthShortName(m))}</button>
      <div class="cal-mini-grid">`;
    for (const week of getMonthGrid(calYear, m)) {
      for (const cell of week) {
        const dayNum = parseInt(cell.date.slice(8, 10), 10);
        const evs = events.get(cell.date) || [];
        const dots = evs.slice(0, 3).map(e => `<i class="cal-dot cal-${e.type}"></i>`).join('');
        html += `<button class="cal-mini-day${cell.inMonth ? '' : ' cal-out'}${cell.date === todayStr() ? ' cal-today' : ''}"
            data-action="open-calendar-day" data-date="${cell.date}">
          <span>${dayNum}</span><span class="cal-dots">${dots}</span>
        </button>`;
      }
    }
    html += '</div></div>';
  }
  html += '</div>';
  grid.innerHTML = html;
}

function renderDayView(grid) {
  grid.innerHTML = `<div class="cal-dayview">${dayGroupsHTML(calDate)}</div>`;
}

// -------------------------------------------------------------------
// Navigation + add menu
// -------------------------------------------------------------------

function calendarNav(delta) {
  ensureInit();
  if (calView === 'week') setAnchor(addDays(calDate, 7 * delta));
  else if (calView === 'day') setAnchor(addDays(calDate, delta));
  else if (calView === 'year') setAnchor(toDateStr(calYear + delta, 0, 1));
  else {
    const d = new Date(calYear, calMonth + delta, 1);
    setAnchor(toDateStr(d.getFullYear(), d.getMonth(), 1));
  }
  renderCalendar();
}

function setCalendarView(view, opts) {
  if (!['day', 'week', 'month', 'year'].includes(view)) return;
  calView = view;
  saveCalPrefs();
  if (opts && opts.month !== undefined && opts.month !== '') {
    const m = parseInt(opts.month, 10);
    if (m >= 0 && m < 12) setAnchor(toDateStr(calYear, m, 1));
  }
  if (opts && opts.date) setAnchor(opts.date);
  syncCalendarToolbar();
  renderCalendar();
}

// Keep a dropdown menu fully on-screen: default is right-aligned to its
// button; flip to left-aligned when it would overflow the left edge.
function clampMenuToViewport(menu) {
  const rect = menu.getBoundingClientRect();
  if (rect.left < 8) {
    menu.style.left = '0';
    menu.style.right = 'auto';
  } else if (rect.right > window.innerWidth - 8) {
    menu.style.left = 'auto';
    menu.style.right = '0';
  }
}

function toggleCalendarFilter(type) {
  const next = toggleShow(calShow, type);
  if (next === calShow) return;
  calShow = next;
  saveCalPrefs();
  syncCalendarToolbar();
  renderCalendar();
}

function openCalendarDate(dateStr) {
  ensureInit();
  setAnchor(dateStr);
  if (state.currentView !== 'calendar' && window.switchView) window.switchView('calendar');
  else renderCalendar();
  openCalendarDay(dateStr);
}

function calendarToday() {
  const now = new Date();
  setAnchor(toDateStr(now.getFullYear(), now.getMonth(), now.getDate()));
  renderCalendar();
}

function closeCalendarAddMenu() {
  document.querySelectorAll('.calendar-add-menu').forEach(m => {
    m.style.display = 'none';
    m.style.left = ''; m.style.right = '';
  });
  document.querySelectorAll('[data-action="toggle-calendar-add"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  if (calAddCleanup) { calAddCleanup(); calAddCleanup = null; }
}

// Dismiss a menu on outside click / Escape. keepEls are toggle elements
// whose own clicks shouldn't close it (the menu may have several).
function armMenuDismiss(menu, keepEls) {
  const onDocClick = (e) => {
    if (menu.contains(e.target)) return;
    if ((keepEls || []).some(el => el && el.contains(e.target))) return;
    closeCalendarAddMenu();
  };
  const onKey = (e) => { if (e.key === 'Escape') closeCalendarAddMenu(); };
  calAddCleanup = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };
  // Defer so the opening click doesn't immediately close the menu
  setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function toggleCalendarAddMenu(btnEl) {
  const menu = document.getElementById(btnEl.dataset.menu || 'calendarAddMenu');
  if (!menu) return;
  const wasOpen = menu.style.display !== 'none';
  closeCalendarAddMenu();
  if (wasOpen) return;
  menu.style.display = '';
  menu.style.left = ''; menu.style.right = '';
  btnEl.setAttribute('aria-expanded', 'true');
  clampMenuToViewport(menu);
  armMenuDismiss(menu, [btnEl]);
}

// -------------------------------------------------------------------
// Day panel
// -------------------------------------------------------------------

// Same shared group chip as the TODO/Habit pages (members tooltip on
// hover/click comes from the document-level badge handlers in sharing-ui.js).
function calSharedBadge(ev) {
  if (!ev.shared_id || !ev.shared_group_id || !state.sharing) return '';
  const group = state.sharing.getAllGroups().find(g => g.id === ev.shared_group_id);
  return sharedBadge(group?.name || '', ev.shared_group_id);
}

function dayPanelRow(ev, dateStr) {
  if (ev.type === 'birthday') {
    const thumb = ev.avatar
      ? `<img src="${esc(ev.avatar)}" alt="" class="cal-row-avatar">`
      : `<span class="cal-row-avatar cal-row-initial">${esc((ev.title || '?').charAt(0).toUpperCase())}</span>`;
    return `<button class="cal-row" data-action="calendar-birthday-edit" data-id="${esc(ev.id)}">
      ${thumb}
      <span class="cal-row-main"><strong>${esc(ev.title)}</strong><span class="cal-row-sub">${esc(ev.sub)}</span></span>
      ${lucideIcon('pencil', 15)}
    </button>`;
  }
  if (ev.type === 'todo') {
    return `<div class="cal-row${ev.overdue ? ' cal-row-overdue' : ''}">
      <span class="cal-row-main">${calSharedBadge(ev)}<strong>${renderMd(ev.title)}</strong></span>
      <button class="todo-done-btn" data-todo-id="${esc(ev.id)}" data-action="calendar-toggle-todo"
        data-done="true" data-date="${dateStr}" title="${t('common.done')}">
        ${lucideIcon('circle-check', 18)}
      </button>
    </div>`;
  }
  // Only the next due occurrence can be marked done — plus its overdue
  // mirror on today: completing a future occurrence would complete the
  // current next_due instead (markHabitDone always completes the
  // habit's current due date, stamped today).
  // Automatic habits validate themselves — no Done button, just the badge.
  if (ev.is_auto) {
    return `<div class="cal-row${ev.overdue ? ' cal-row-overdue' : ''}">
      <span class="cal-row-main">${calSharedBadge(ev)}<strong>${renderMd(ev.title)}</strong></span>
      <span class="habit-auto-badge">${lucideIcon('zap', 12)} ${t('habits.auto_badge')}</span>
    </div>`;
  }
  const isNextDue = ev.next_due && dateStr === ev.next_due;
  // The overdue mirror on today is also completable: marking it done
  // validates the habit today (markHabitDone completes with today's
  // date and recomputes next_due from it).
  const canComplete = isNextDue || ev.dueToday;
  const doneAttrs = canComplete
    ? `title="${t('common.done')}"`
    : `disabled title="${esc(t('calendar.only_next_due'))}"`;
  return `<div class="cal-row${ev.overdue ? ' cal-row-overdue' : ''}">
    <span class="cal-row-main">${calSharedBadge(ev)}<strong>${renderMd(ev.title)}</strong></span>
    <button class="habit-done-btn" data-habit-id="${esc(ev.id)}" data-action="calendar-habit-done"
      data-date="${dateStr}" ${doneAttrs}>
      ${lucideIcon('circle-check', 18)}
    </button>
  </div>`;
}

function openCalendarDay(dateStr) {
  closeCalendarAddMenu();
  calPanelDate = dateStr;
  let overlay = document.getElementById('calendarDayOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'calendarDayOverlay';
  overlay.className = 'modal-overlay visible';
  overlay.innerHTML = `<div class="modal modal-wide cal-day-modal" id="calendarDayModal"></div>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCalendarDay();
  });
  document.getElementById('app').appendChild(overlay);
  renderCalendarDayPanel(dateStr);
}

function closeCalendarDay() {
  calPanelDate = null;
  const overlay = document.getElementById('calendarDayOverlay');
  if (overlay) overlay.remove();
}

function dayGroupsHTML(dateStr) {
  const events = collectRangeEvents(dateStr, dateStr).get(dateStr) || [];
  const groups = [
    { type: 'habit', label: t('calendar.habits'), color: 'var(--green)', icon: 'repeat' },
    { type: 'todo', label: t('calendar.todos'), color: 'var(--accent)', icon: 'list-checks' },
    { type: 'birthday', label: t('calendar.birthdays'), color: 'var(--pink)', icon: 'cake' },
  ];
  let body = '';
  for (const g of groups) {
    const evs = events.filter(e => e.type === g.type);
    if (!evs.length) continue;
    let items = '';
    if (g.type === 'birthday') {
      items = evs.map(e => dayPanelRow(e, dateStr)).join('');
    } else {
      // Subsections per category, like the welcome buckets — ordered
      // by tree order, labelled by full path, chips keep bucket colour
      const byCat = new Map();
      for (const e of evs) {
        const key = e.catId || '__none';
        if (!byCat.has(key)) byCat.set(key, { name: e.catName, color: e.catColor, order: e.catOrder || [0], items: [] });
        byCat.get(key).items.push(e);
      }
      const orderedGroups = [...byCat.values()].sort((a, b) => compareOrderKeys(a.order, b.order));
      for (const { name, color, items: catItems } of orderedGroups) {
        if (byCat.size > 1 || name) {
          items += `<div class="welcome-todo-cat-label" style="--cat-color:${color}"><span class="welcome-todo-cat-dot"></span>${esc(name || '')}</div>`;
        }
        items += catItems.map(e => dayPanelRow(e, dateStr)).join('');
      }
    }
    body += `<div class="welcome-section cal-day-section" style="--cat-color:${g.color}">
      <div class="welcome-section-header">${lucideIcon(g.icon, 18)}<span>${g.label}</span></div>
      <div class="welcome-items">${items}</div>
    </div>`;
  }
  if (!body) body = `<div class="page-empty-state"><p>${t('calendar.no_events')}</p></div>`;
  else body = `<div class="cal-day-sections">${body}</div>`;
  return body;
}

function renderCalendarDayPanel(dateStr) {
  const modal = document.getElementById('calendarDayModal');
  if (!modal) return;
  calPanelDate = dateStr;
  const title = fullDateStr(dateStr);

  modal.innerHTML = `
    <div class="cal-day-header">
      <h2>${esc(title)}</h2>
      <div class="calendar-add-wrap">
        <button class="btn" data-action="toggle-calendar-add" data-menu="calendarDayAddMenu"
          title="${t('common.add')}" aria-expanded="false" aria-haspopup="true">${lucideIcon('plus', 16)}</button>
        <div class="calendar-add-menu" id="calendarDayAddMenu" style="display:none" role="menu">
          <button data-action="open-add-birthday" data-date="${dateStr}" role="menuitem">${lucideIcon('cake', 15)} <span>${t('birthdays.add_birthday')}</span></button>
        </div>
      </div>
    </div>
    <div class="cal-day-list">${dayGroupsHTML(dateStr)}</div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-calendar-day">${t('common.close')}</button>
    </div>`;
}

export { renderCalendar };

// Keep the grid fresh when todo/habit data changes elsewhere
// (same pattern as the Welcome view); birthdays refresh via refreshBirthdays().
document.addEventListener('todos-changed', () => {
  if (state.currentView === 'calendar') renderCalendar();
});
document.addEventListener('habits-changed', () => {
  if (state.currentView === 'calendar') renderCalendar();
});

window.renderCalendar = renderCalendar;
window.calendarNav = calendarNav;
window.calendarToday = calendarToday;
window.toggleCalendarFilter = toggleCalendarFilter;
window.openCalendarDate = openCalendarDate;
window.setCalendarView = setCalendarView;
window.openCalendarPicker = openCalendarPicker;
window.pickCalendarMonth = pickCalendarMonth;
window.pickCalendarYear = pickCalendarYear;
window.pickCalendarDay = pickCalendarDay;
window.toggleCalendarAddMenu = toggleCalendarAddMenu;
window.closeCalendarAddMenu = closeCalendarAddMenu;
window.openCalendarDay = openCalendarDay;
window.closeCalendarDay = closeCalendarDay;
window.renderCalendarDayPanel = renderCalendarDayPanel;
