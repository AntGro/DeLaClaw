// ===================================================================
// WELCOME / TODAY — Daily briefing dashboard
// ===================================================================
import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state, { SHARED_CATEGORY } from './state.js';
import { esc, escQ, renderMd, formatRelativeDate, formatRelativeDay, truncateWithShowMore } from './utils.js';
import { initItemHoverDelay, inlineEditText, captureInnerScrollPositions, restoreInnerScrollPositions } from './item-utils.js';
import { formatFrequency, formatHabitDue, habitDueStatus, getHabitLastDone, formatHabitRelative, getHabitCompletionCount, getHabitCategoryColor, catIdForHabit, getHabitCatDisplayName, getHabitCatPath, getHabitCatOrderKey, getHabitCategories, isMyCreatedSharedHabit, isAutoHabit } from './habits.js';
import { getCategoryColor, getTodos, catIdForTodo, getCatDisplayName, getTodoCatPath, getTodoCatOrderKey, getTodoCategories } from './todos.js';
import { compareOrderKeys } from './sections-pure.js';
import { getFlashcards, getTexts, getTextProgress } from './flashcards.js';
import { sharedBadge } from './sharing-ui.js';
import { parseLocalDate, isHabitSnoozed, toDateStr, isDateOnly, isDueOverdue, isDueSoon, compareDueDates, addDays, getWeekDates } from './calendar-pure.js';
import { collectRangeEvents, dayCellHTML } from './calendar.js';

// ── Local data cache ──
let wTodos = [];
let wHabits = [];
let wHabitCompletionsWeek = 0;
let wFlashcards = [];
let wTexts = [];
let wTextProgress = [];
let wBirthdays = [];
let wProjectCount = 0;
// Weeks from the current week shown in the Welcome calendar strip.
// Welcome-owned: navigating here never moves the Calendar tab's anchor.
let wCalWeekOffset = 0;

// ── Helpers ──
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Flashcard "day" runs 06:00→06:00 instead of midnight→midnight. */
function flashcardDayStart(d) {
  const s = new Date(d);
  if (s.getHours() < 6) s.setDate(s.getDate() - 1);
  return new Date(s.getFullYear(), s.getMonth(), s.getDate(), 6, 0, 0, 0);
}

const FLASHCARD_PRACTICE_THRESHOLD = 10;

function retrievability(S, lastReview, nowStr) {
  if (!S || !lastReview) return 0;
  const elapsed = (new Date(nowStr) - new Date(lastReview)) / 86400000;
  return Math.pow(0.9, elapsed / S);
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return t('welcome.good_morning');
  if (h < 18) return t('welcome.good_afternoon');
  return t('welcome.good_evening');
}

function formatDateLocale() {
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  return new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function getNextBirthday(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  const thisYear = today.getFullYear();
  const todayStart = startOfDay(today);
  const next = new Date(thisYear, bd.getMonth(), bd.getDate());
  if (next < todayStart) next.setFullYear(thisYear + 1);
  return next;
}

function daysUntilBirthday(birthdayStr) {
  const next = getNextBirthday(birthdayStr);
  const todayStart = startOfDay(new Date());
  return Math.round((next - todayStart) / 86400000);
}

function getAge(birthdayStr) {
  const bd = new Date(birthdayStr + 'T00:00:00');
  const today = new Date();
  let age = today.getFullYear() - bd.getFullYear();
  const m = today.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < bd.getDate())) age--;
  return age;
}

// ── Data fetch ──

async function refreshWelcome() {
  if (!state.db.connected) return;
  // Welcome is a today page: any data refresh re-anchors the strip.
  wCalWeekOffset = 0;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  wTodos = getTodos();
  wHabits = state.allHabits;
  wHabitCompletionsWeek = state.allHabitCompletions.filter(c => new Date(c.completed_at) >= weekAgo).length;
  wFlashcards = getFlashcards();
  wTexts = getTexts();
  wTextProgress = getTextProgress();
  wBirthdays = state.allBirthdays;
  const archivedIds = state.archivedProjectIds || [];
  wProjectCount = state.PROJECTS.filter(p => !archivedIds.includes(p.id)).length;
}

// ── Listen for todo mutations from the TODOs module ──
document.addEventListener('todos-changed', () => {
  if (state.currentView === 'welcome') {
    refreshWelcome().then(renderWelcome);
  }
});

// ── Listen for habit mutations from the Habits module ──
document.addEventListener('habits-changed', () => {
  if (state.currentView === 'welcome') {
    refreshWelcome().then(renderWelcome);
  }
});

// ── Listen for event mutations from the Events module ──
document.addEventListener('events-changed', () => {
  if (state.currentView === 'welcome') {
    refreshWelcome().then(renderWelcome);
  }
});

// ── Welcome-specific TODO action handlers ──

function welcomeToggleTodo(id, done, btnEl) {
  if (typeof window.toggleTodo === 'function') {
    return window.toggleTodo(id, done, btnEl);
  }
}

function welcomeDeleteTodo(id) {
  if (typeof window.deleteTodo === 'function') {
    return window.deleteTodo(id);
  }
}

const W_PRIORITY_LEVELS = window.PRIORITY_LEVELS || [
  { key: 'urgent', color: '#ef4444', icon: 'alert-triangle' },
  { key: 'high', color: '#f97316', icon: 'flag' },
  { key: 'medium', color: '#eab308', icon: 'flag' },
  { key: 'low', color: '#3b82f6', icon: 'flag' },
  { key: 'normal', color: null, icon: 'circle-off' },
];

function welcomeOpenPriorityPicker(id, event, triggerEl) {
  event.stopPropagation();
  const existing = document.getElementById('welcomePriorityPickerPopover');
  if (existing) { welcomeClosePriorityPicker(); return; }
  welcomeClosePriorityPicker();
  const todo = wTodos.find(t => t.id === id);
  if (!todo) return;
  const btn = triggerEl || (event.currentTarget instanceof HTMLElement && event.currentTarget !== document ? event.currentTarget : event.target?.closest('[data-action="welcome-open-priority-picker"]')) || event.target;
  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.className = 'priority-picker';
  picker.id = 'welcomePriorityPickerPopover';

  picker.innerHTML = W_PRIORITY_LEVELS.map(lv => {
    const isActive = (todo.priority || 'normal') === lv.key;
    const label = t(`todos.priority_${lv.key}`) || lv.key;
    const dot = lv.color
      ? `<span class="priority-picker-dot" style="background:${lv.color}"></span>`
      : `${lucideIcon('circle-off', 14, 'var(--muted)')}`;
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" data-action="welcome-set-priority" data-todo-id="${esc(id)}" data-priority="${esc(lv.key)}">${dot}<span>${label}</span></div>`;
  }).join('');

  document.body.appendChild(picker);

  const ph = picker.offsetHeight;
  let top = rect.bottom + 4;
  let left = rect.left;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if (left + picker.offsetWidth > window.innerWidth - 8) left = window.innerWidth - picker.offsetWidth - 8;
  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;

  setTimeout(() => {
    document.addEventListener('click', welcomeClosePriorityPicker, { once: true });
  }, 0);
}

function welcomeClosePriorityPicker() {
  const el = document.getElementById('welcomePriorityPickerPopover');
  if (el) el.remove();
  document.removeEventListener('click', welcomeClosePriorityPicker);
}

function welcomeSetPriority(id, level) {
  welcomeClosePriorityPicker();
  if (typeof window.setTodoPriority === 'function') {
    return window.setTodoPriority(id, level);
  }
}

function welcomeSnooze(id) {
  // Reuse the snooze modal from todos — its doSnooze calls refreshTodos
  // which dispatches 'todos-changed', and our listener refreshes welcome
  if (typeof window.openSnoozeModal === 'function') {
    window.openSnoozeModal(id);
  }
}

// Register welcome action functions on window for onclick handlers
window.welcomeToggleTodo = welcomeToggleTodo;
window.welcomeDeleteTodo = welcomeDeleteTodo;
window.welcomeOpenPriorityPicker = welcomeOpenPriorityPicker;
window.welcomeSetPriority = welcomeSetPriority;
window.welcomeClosePriorityPicker = welcomeClosePriorityPicker;
window.welcomeSnooze = welcomeSnooze;

// ── Render a focus TODO item (same structure as todos.js) ──
function renderFocusTodoItem(td) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const isOverdue = td.due_date && !td.done && isDueOverdue(td.due_date, now);
  const isSnoozed = td.snooze_until && new Date(td.snooze_until) > now;
  const isFlagged = td.priority && td.priority !== 'normal';

  const prioColors = { urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6' };
  const flagColor = prioColors[td.priority] || null;
  const flagIconName = td.priority === 'urgent' ? 'alert-triangle' : 'flag';
  const flagIcon = flagColor ? lucideIcon(flagIconName, 14, flagColor) : lucideIcon('flag', 14);
  const flagTitle = t('todos.set_priority');
  const flagBtn = `<button class="todo-flag-btn ${isFlagged ? 'flagged' : ''}" data-action="welcome-open-priority-picker" data-todo-id="${esc(td.id)}" title="${flagTitle}">${flagIcon}</button>`;

  let dueDateStr = '';
  if (td.due_date) {
    const dueLabel = isDateOnly(td.due_date) ? formatRelativeDay(td.due_date, now) : formatRelativeDate(new Date(td.due_date));
    if (isOverdue) {
      dueDateStr = `<span class="todo-due overdue">${lucideIcon('alert-triangle', 14)} ${t('todos.overdue')} (${dueLabel})</span>`;
    } else if (isDueSoon(td.due_date, now)) {
      dueDateStr = `<span class="todo-due due-soon">${lucideIcon("bell", 16)} ${t('todos.due')} ${dueLabel}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">${lucideIcon("calendar", 16)} ${dueLabel}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon", 16)} ${t('todos.snoozed_until')} ${new Date(td.snooze_until).toLocaleString(getLang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  const classes = [
    'bucket-item',
    'todo-item',
    isOverdue ? 'todo-overdue' : '',
    isFlagged ? `todo-priority-${td.priority}` : ''
  ].filter(Boolean).join(' ');

  // Shared TODO badge (match TODO page rendering)
  const isShared = td.shared_id && td.shared_group_id;
  let sharedHtml = '';
  if (isShared && state.sharing) {
    const group = state.sharing.getAllGroups().find(g => g.id === td.shared_group_id);
    sharedHtml = sharedBadge(group?.name || '', td.shared_group_id);
  }

  return `<div class="${classes}" data-todo-id="${td.id}">
    ${sharedHtml}
    <div class="todo-row">
      ${flagBtn}
      <span class="todo-text">${td.text.length > 150 ? truncateWithShowMore(td.text, 150, td.id, 'todo') : renderMd(td.text)}</span>
      <div class="todo-actions">
        <button data-action="welcome-toggle-todo" data-todo-id="${esc(td.id)}" data-done="true" title="${t('common.done')}">${lucideIcon("circle-check", 16)}</button>
        <button data-action="welcome-snooze" data-todo-id="${esc(td.id)}" title="${t('todos.snooze')}">${lucideIcon("moon", 16)}</button>
        <button data-action="edit-todo-inline" data-todo-id="${esc(td.id)}" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
        <button data-action="copy-item-link" data-link-type="todo" data-id="${esc(td.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link", 16)}</button>
        <button data-action="welcome-delete-todo" data-todo-id="${esc(td.id)}" title="${t('common.delete')}">${lucideIcon("trash-2", 16)}</button>
      </div>
    </div>
    ${dueDateStr || snoozeInfo ? `<div class="todo-meta">${dueDateStr}${snoozeInfo}</div>` : ''}
  </div>`;
}

// ── Init hover delay for focus items after render ──
function initWelcomeFocusHover() {
  const container = document.querySelector('#welcomeView .welcome-focus-todos');
  if (!container) return;
  initItemHoverDelay(container, {
    itemSelector: '.todo-item',
    actionsSelector: '.todo-actions',
    rowSelector: '.todo-row',
    textSelector: '.todo-text',
    editingSelector: '.task-edit-input, .todo-edit-wrapper',
    onDblClick: (item) => {
      const id = item.dataset.todoId;
      if (id && typeof window.editTodoInline === 'function') {
        window.editTodoInline(id, item);
      }
    },
  });
}

// ===================================================================
// WELCOME — Habit action handlers (mirrors Habits page actions)
// ===================================================================

function welcomeMarkHabitDone(habitId, btnEl) {
  if (typeof window.markHabitDone === 'function') {
    return window.markHabitDone(habitId, btnEl);
  }
}

function welcomeDeleteHabit(habitId) {
  if (typeof window.deleteHabit === 'function') {
    return window.deleteHabit(habitId);
  }
}

function welcomeOpenHabitHistory(habitId) {
  if (typeof window.openHabitHistory === 'function') {
    window.openHabitHistory(habitId);
  }
}

window.welcomeMarkHabitDone = welcomeMarkHabitDone;
window.welcomeDeleteHabit = welcomeDeleteHabit;
window.welcomeOpenHabitHistory = welcomeOpenHabitHistory;

// ── Render a focus habit item (same structure as habits.js renderHabitItem) ──
function renderFocusHabitItem(habit) {
  const lastDone = getHabitLastDone(habit.id);
  const completionCount = getHabitCompletionCount(habit.id);
  const status = habitDueStatus(habit);
  const dueHtml = formatHabitDue(habit);

  const lastDoneStr = lastDone
    ? `${t('habits.last_done')}: ${lastDone.toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })} (${formatHabitRelative(lastDone)})`
    : t('habits.never_done');

  const isShared = habit.shared_id && habit.shared_group_id;
  let sharedHtml = '';
  if (isShared && state.sharing) {
    const group = state.sharing.getAllGroups().find(g => g.id === habit.shared_group_id);
    sharedHtml = sharedBadge(group?.name || '', habit.shared_group_id);
  }

  return `<div class="bucket-item habit-item habit-status-${status}" data-habit-id="${habit.id}">
    ${sharedHtml}
    <div class="habit-row">
      <div class="habit-info">
        <span class="habit-name">${renderMd(habit.name)}</span>
        <span class="habit-frequency">${esc(formatFrequency(habit.frequency_rule))}</span>
      </div>
      <div class="habit-actions">
        <button data-habit-id="${esc(habit.id)}" data-action="welcome-mark-habit-done" title="${t('habits.mark_done')}" class="habit-done-btn">${lucideIcon("circle-check", 16)}</button>
        <button data-action="open-habit-snooze-modal" data-id="${esc(habit.id)}" title="${t('habits.snooze')}">${lucideIcon("moon", 16)}</button>
        <button data-action="welcome-open-habit-history" data-habit-id="${esc(habit.id)}" title="${t('habits.habit_history')} (${completionCount})" class="habit-history-btn">${lucideIcon("clipboard-list", 16)} ${completionCount}</button>
        ${!isShared && state.sharing ? `<button data-action="share-existing-habit" data-id="${esc(habit.id)}" title="${t('sharing.share')}">${lucideIcon("share",16)}</button>` : ''}
        ${isShared && isMyCreatedSharedHabit(habit.shared_id) ? `<button data-action="unshare-habit" data-id="${esc(habit.id)}" title="${t('sharing.unshare')}">${lucideIcon("share-off",16)}</button>` : ''}
        ${isShared && !isMyCreatedSharedHabit(habit.shared_id) ? `<button data-action="copy-habit-to-personal" data-id="${esc(habit.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon("copy",16)}</button>` : ''}
        <button data-action="edit-habit-inline" data-habit-id="${esc(habit.id)}" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
        <button data-action="copy-item-link" data-link-type="habit" data-id="${esc(habit.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link", 16)}</button>
        <button data-action="welcome-delete-habit" data-habit-id="${esc(habit.id)}" title="${t('common.delete')}">${lucideIcon("trash-2", 16)}</button>
      </div>
    </div>
    <div class="habit-meta">
      ${dueHtml}
      <span class="habit-last-done">${lastDoneStr}</span>
    </div>
  </div>`;
}

// ── Init hover delay for habit items after render ──
function initWelcomeFocusHabitHover() {
  const container = document.querySelector('#welcomeView .welcome-focus-habits');
  if (!container) return;
  initItemHoverDelay(container, {
    itemSelector: '.habit-item',
    actionsSelector: '.habit-actions',
    rowSelector: '.habit-row',
    textSelector: '.habit-name',
    onDblClick: (item) => {
      const id = item.dataset.habitId;
      if (id && typeof window.editHabitInline === 'function') {
        window.editHabitInline(id, item);
      }
    },
  });
}

// ===================================================================
// WELCOME — Calendar week strip: the Calendar tab's week cells, reused.
// Same chips (Birthday > Events > TODOs > Habits), same overdue mirrors,
// same day-panel modal on click — no bespoke placement logic here.
// All types, always: the strip never inherits the Calendar tab's funnel filter.
function renderWelcomeCalendar() {
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  const now = new Date();
  const today = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
  const dates = getWeekDates(addDays(today, wCalWeekOffset * 7));
  const events = collectRangeEvents(dates[0], dates[6], { todo: true, habit: true, birthday: true, event: true });
  const names = dates.map(d => parseLocalDate(d).toLocaleDateString(locale, { weekday: 'short' }).replace('.', ''));

  // Month context — if the week spans two months, show both
  const firstMonth = parseLocalDate(dates[0]).toLocaleDateString(locale, { month: 'long' });
  const lastMonth = parseLocalDate(dates[6]).toLocaleDateString(locale, { month: 'long' });
  const monthLabel = firstMonth === lastMonth ? firstMonth : `${firstMonth} – ${lastMonth}`;
  const yearLabel = parseLocalDate(dates[0]).getFullYear();

  let html = `<div class="welcome-section" id="welcome-bucket-calendar" style="--cat-color:var(--accent)">`;
  html += `<div class="welcome-section-header">${lucideIcon('calendar-days', 18)} <span>${esc(t('welcome.coming_up'))}</span><span class="welcome-cal-month-ctx">${esc(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))} ${yearLabel}</span>`;
  html += `<span class="welcome-cal-nav"><button data-action="welcome-cal-nav" data-delta="-1" title="${esc(t('calendar.prev_week'))}">${lucideIcon('chevron-left', 16)}</button><button data-action="welcome-cal-today">${esc(t('calendar.today'))}</button><button data-action="welcome-cal-nav" data-delta="1" title="${esc(t('calendar.next_week'))}">${lucideIcon('chevron-right', 16)}</button></span></div>`;
  html += `<div class="welcome-calendar-strip">`;
  dates.forEach((date, i) => { html += dayCellHTML(date, true, events, names[i]); });
  html += `</div>`;
  html += `</div>`;
  return html;
}

// Week navigation re-renders only the calendar section, so scroll position
// and anything typed elsewhere on the page survive it.
function welcomeCalNav(delta) {
  wCalWeekOffset += delta;
  const el = document.getElementById('welcome-bucket-calendar');
  if (el) el.outerHTML = renderWelcomeCalendar();
}

function welcomeCalToday() {
  wCalWeekOffset = 0;
  const el = document.getElementById('welcome-bucket-calendar');
  if (el) el.outerHTML = renderWelcomeCalendar();
}

// ── Render ──
function renderWelcome() {
  const container = document.getElementById('welcomeView');
  if (!container) return;

  const now = new Date();
  const todayStart = startOfDay(now);
  const nowStr = now.toISOString();

  // ── 1. Focus TODOs ──
  const focusTodos = wTodos.filter(td => {
    if (td.done) return false;
    // Snoozed and still sleeping → skip
    if (td.snooze_until && new Date(td.snooze_until) > now) return false;
    // Flagged
    if (td.priority && td.priority !== 'normal') return true;
    // Deadline today or overdue
    if (td.due_date) {
      const due = startOfDay(parseLocalDate(td.due_date));
      if (due <= todayStart) return true;
    }
    return false;
  });
  // Sort: urgent first, then high, medium, low, then by deadline
  const priOrd = { urgent: 0, high: 1, medium: 2, low: 3 };
  focusTodos.sort((a, b) => {
    const pa = priOrd[a.priority] ?? 4;
    const pb = priOrd[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    if (a.due_date && b.due_date) return compareDueDates(a.due_date, b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  // ── 2. Habits due ──
  const todayStr = toDateStr(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());
  const habitsDue = wHabits.filter(c => {
    if (c.is_draft) return false;
    if (!c.next_due) return false;
    if (isHabitSnoozed(c, todayStr)) return false;
    if (isAutoHabit(c)) return false; // validates itself — nothing to do
    return startOfDay(parseLocalDate(c.next_due)) <= todayStart;
  });
  habitsDue.sort((a, b) => String(a.next_due).slice(0, 10).localeCompare(String(b.next_due).slice(0, 10))); // date-only strings sort chronologically

  // ── 3. Flashcards ──
  const dueCards = wFlashcards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now));
  const newCards = wFlashcards.filter(c => !c.last_review);
  // Did the user already practice today? Check if any card was reviewed today.
  // Flashcard "day" runs 06:00→06:00; require ≥10 cards to count as practiced
  const fcDayStart = flashcardDayStart(now);
  const todayReviewedCards = wFlashcards.filter(c => c.last_review && new Date(c.last_review) >= fcDayStart);
  const practicedToday = todayReviewedCards.length >= FLASHCARD_PRACTICE_THRESHOLD;
  let avgR = 0;
  const reviewedCards = wFlashcards.filter(c => c.last_review && c.stability);
  if (reviewedCards.length > 0) {
    const sumR = reviewedCards.reduce((acc, c) => acc + retrievability(c.stability, c.last_review, nowStr), 0);
    avgR = sumR / reviewedCards.length;
  }

  // ── 4. Upcoming birthdays (next 7 days) ──
  const upcomingBDs = wBirthdays
    .map(b => ({ ...b, daysUntil: daysUntilBirthday(b.birthday), age: getAge(b.birthday) }))
    .filter(b => b.daysUntil >= 0 && b.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  // ── 5. Stats ──
  const todosPending = wTodos.filter(td => !td.done).length;
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  if (weekStart > todayStart) weekStart.setDate(weekStart.getDate() - 7);
  const todosDoneWeek = wTodos.filter(td => td.done && td.updated_at && new Date(td.updated_at) >= weekStart).length;

  // ── Build HTML ──
  let html = '';

  // Header
  html += `<div class="welcome-header">`;
  html += `<div class="welcome-greeting">${esc(getGreeting())}</div>`;
  html += `<div class="welcome-date">${esc(formatDateLocale())}</div>`;
  html += `</div>`;

  // Section nav buttons — quick shortcuts to welcome page buckets
  html += `<div class="welcome-nav-shortcuts">`;
  // TODOs bucket
  const todoPending = wTodos.filter(td => !td.done).length;
  html += `<button class="category-nav-btn" style="--cat-color:#22c55e" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-todos" title="${esc(t('welcome.focus_todos'))}">${lucideIcon('list-checks', 12, '#22c55e')} ${esc(t('welcome.focus_todos'))}${todoPending > 0 ? ' (' + todoPending + ')' : ''}</button>`;
  // Habits bucket
  const habitsDueNavCount = wHabits.filter(c => !c.is_draft && c.next_due && startOfDay(parseLocalDate(c.next_due)) <= todayStart).length;
  html += `<button class="category-nav-btn" style="--cat-color:#ec4899" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-habits" title="${esc(t('welcome.habits_due'))}">${lucideIcon('repeat', 12, '#ec4899')} ${esc(t('welcome.habits_due'))}${habitsDueNavCount > 0 ? ' (' + habitsDueNavCount + ')' : ''}</button>`;
  // Flashcards bucket
  const fcDueNav = wFlashcards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now)).length;
  const fcNewNav = wFlashcards.filter(c => !c.last_review).length;
  const fcTotalNav = fcDueNav + fcNewNav;
  html += `<button class="category-nav-btn" style="--cat-color:#06b6d4" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-flashcards" title="${esc(t('welcome.flashcards'))}">${lucideIcon('brain', 12, '#06b6d4')} ${esc(t('welcome.flashcards'))}${fcTotalNav > 0 ? ' (' + fcTotalNav + ')' : ''}</button>`;
  // Birthdays bucket
  html += `<button class="category-nav-btn" style="--cat-color:#f97316" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-birthdays" title="${esc(t('welcome.upcoming_birthdays'))}">${lucideIcon('cake', 12, '#f97316')} ${esc(t('welcome.upcoming_birthdays'))}${upcomingBDs.length > 0 ? ' (' + upcomingBDs.length + ')' : ''}</button>`;
  // Stats bucket
  html += `<button class="category-nav-btn" style="--cat-color:var(--accent)" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-stats" title="${esc(t('welcome.stats'))}">${lucideIcon('bar-chart-3', 12, 'var(--accent)')} ${esc(t('welcome.stats'))}</button>`;
  // Calendar bucket
  html += `<button class="category-nav-btn" style="--cat-color:var(--accent)" data-action="scroll-to-welcome-bucket" data-bucket-id="welcome-bucket-calendar" title="${esc(t('welcome.coming_up'))}">${lucideIcon('calendar-days', 12, 'var(--accent)')} ${esc(t('welcome.coming_up'))}</button>`;
  html += `</div>`;

  // Focus TODOs + Habits due — side by side
  html += `<div class="welcome-grid">`;

  // Focus TODOs section
  html += `<div class="welcome-section" id="welcome-bucket-todos" style="--cat-color:#22c55e">`;
  html += `<div class="welcome-section-header">${lucideIcon('list-checks', 18)} <span>${esc(t('welcome.focus_todos'))}</span></div>`;
  // Quick-add TODO with category selector — buckets only (never
  // sections), in tree order, labelled by full path
  const todoCatIds = Array.from(getTodoCategories().values())
    .filter(c => c.name !== SHARED_CATEGORY && c.kind !== 'section')
    .sort((a, b) => compareOrderKeys(getTodoCatOrderKey(a.id), getTodoCatOrderKey(b.id)))
    .map(c => c.id);
  html += `<div class="welcome-quick-add">`;
  html += `<select class="welcome-quick-cat-select" data-action="update-next-sibling-category">`;
  for (const catId of todoCatIds) {
    const label = getTodoCatPath(catId);
    html += `<option value="${esc(catId)}">${esc(label)}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" placeholder="${esc(t('todos.add_todo_placeholder'))}" maxlength="2000" class="todo-cat-input" data-category="${esc(todoCatIds[0] || '')}" data-priority="medium" data-action="welcome-quick-add-todo-on-enter">`;
  html += `<button class="todo-add-priority-btn" data-action="open-quick-add-priority-picker" title="${esc(t('todos.set_priority'))}">${lucideIcon('flag', 16, '#eab308')}</button>`;
  html += `<button data-action="welcome-add-todo-from-quick">+</button>`;
  html += `</div>`;
  if (focusTodos.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.all_clear'))}</div>`;
  } else {
    // Group todos by category_id
    const todosByCategory = {};
    for (const td of focusTodos) {
      const catId = catIdForTodo(td);
      if (!todosByCategory[catId]) todosByCategory[catId] = [];
      todosByCategory[catId].push(td);
    }
    html += `<div class="welcome-items welcome-focus-todos">`;
    const catKeys = Object.keys(todosByCategory);
    for (const catId of catKeys) {
      const catColor = getCategoryColor(catId);
      const catName = getTodoCatPath(catId);
      if (catKeys.length > 1 || catName) {
        html += `<div class="welcome-todo-cat-label" style="--cat-color:${catColor}"><span class="welcome-todo-cat-dot"></span>${esc(catName)}</div>`;
      }
      for (const td of todosByCategory[catId]) {
        html += renderFocusTodoItem(td);
      }
    }
    html += `</div>`;
  }
  html += `</div>`;

  // Habits due
  html += `<div class="welcome-section" id="welcome-bucket-habits" style="--cat-color:#ec4899">`;
  html += `<div class="welcome-section-header">${lucideIcon('repeat', 18)} <span>${esc(t('welcome.habits_due'))}</span></div>`;
  // Quick-add Habit (opens modal pre-filled with name + category)
  const habitCatIds = Array.from(getHabitCategories().values())
    .filter(c => c.name !== SHARED_CATEGORY && c.kind !== 'section')
    .sort((a, b) => compareOrderKeys(getHabitCatOrderKey(a.id), getHabitCatOrderKey(b.id)))
    .map(c => c.id);
  html += `<div class="welcome-quick-add">`;
  html += `<select class="welcome-quick-cat-select" data-action="update-next-sibling-category">`;
  for (const catId of habitCatIds) {
    const label = getHabitCatPath(catId);
    html += `<option value="${esc(catId)}">${esc(label)}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" placeholder="${esc(t('habits.quick_add_placeholder'))}" maxlength="200" class="todo-cat-input habit-add-input" data-category="${esc(habitCatIds[0] || '')}" data-action="welcome-quick-add-habit-on-enter">`;
  html += `<button data-action="welcome-add-habit-from-quick">+</button>`;
  html += `</div>`;
  if (habitsDue.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.no_habits_due'))}</div>`;
  } else {
    // Group habits by category_id
    const habitsByCategory = {};
    for (const ch of habitsDue) {
      const catId = catIdForHabit(ch);
      if (!habitsByCategory[catId]) habitsByCategory[catId] = [];
      habitsByCategory[catId].push(ch);
    }
    html += `<div class="welcome-items welcome-focus-habits">`;
    const habitCatKeys = Object.keys(habitsByCategory);
    for (const catId of habitCatKeys) {
      const catColor = getHabitCategoryColor(catId);
      const catLabel = getHabitCatPath(catId);
      html += `<div class="welcome-todo-cat-label" style="--cat-color:${catColor}"><span class="welcome-todo-cat-dot"></span>${esc(catLabel)}</div>`;
      for (const ch of habitsByCategory[catId]) {
        html += renderFocusHabitItem(ch);
      }
    }
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`; // close welcome-grid

  // Calendar — week strip, same cells as the Calendar tab's week view
  html += renderWelcomeCalendar();

  // Flashcards + Birthdays — second row grid
  html += `<div class="welcome-grid">`;

  // Flashcard reminder
  html += `<div class="welcome-section" id="welcome-bucket-flashcards" style="--cat-color:#06b6d4">`;
  html += `<div class="welcome-section-header">${lucideIcon('brain', 18)} <span>${esc(t('welcome.flashcards'))}</span></div>`;
  if (practicedToday) {
    // Already practiced today — show positive state
    const todayCount = todayReviewedCards.length;
    html += `<div class="welcome-flash-done">${lucideIcon('circle-check', 16, '#22c55e')} ${esc(t('welcome.practiced_today', todayCount))}</div>`;
    if (dueCards.length > 0) {
      html += `<div class="welcome-flash-detail">${esc(t('welcome.cards_still_due', dueCards.length))}</div>`;
    }
    if (reviewedCards.length > 0) {
      html += `<div class="welcome-flash-detail">${esc(t('welcome.avg_retrievability'))}: ${Math.round(avgR * 100)}%</div>`;
    }
    if (dueCards.length > 0) {
      html += `<button class="welcome-flash-btn welcome-flash-btn--secondary" data-action="go-to-practice">${lucideIcon('play', 14)} ${esc(t('welcome.continue_practicing'))}</button>`;
    }
  } else if (dueCards.length > 0 || newCards.length > 0) {
    // Not practiced today — prompt to review
    html += `<div class="welcome-flash-counts">`;
    if (dueCards.length > 0) {
      html += `<span class="welcome-flash-due">${esc(t('welcome.cards_due', dueCards.length))}</span>`;
    }
    if (newCards.length > 0) {
      html += `<span class="welcome-flash-new">${esc(t('welcome.new_cards', newCards.length))}</span>`;
    }
    html += `</div>`;
    if (reviewedCards.length > 0) {
      html += `<div class="welcome-flash-detail">${esc(t('welcome.avg_retrievability'))}: ${Math.round(avgR * 100)}%</div>`;
    }
    html += `<button class="welcome-flash-btn welcome-flash-btn--primary" data-action="go-to-practice">${lucideIcon('play', 14)} ${esc(t('welcome.go_to_flashcards'))}</button>`;
  } else {
    html += `<div class="welcome-empty">${esc(t('welcome.up_to_date'))}</div>`;
    if (reviewedCards.length > 0) {
      html += `<div class="welcome-flash-detail">${esc(t('welcome.avg_retrievability'))}: ${Math.round(avgR * 100)}%</div>`;
    }
  }
  // Text revision section
  const textDueChunks = wTextProgress.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now));
  const textNewChunks = wTextProgress.filter(c => !c.last_review);
  const textTotalDue = textDueChunks.length + textNewChunks.length;
  const textReviewedChunks = wTextProgress.filter(c => c.last_review);
  // Text revision "day" uses same 06:00→06:00 window as flashcards
  const textReviewedToday = wTextProgress.filter(c => c.last_review && new Date(c.last_review) >= fcDayStart);
  const textPracticedToday = textReviewedToday.length >= 1; // 1 chunk = 1 session
  if (wTexts.length > 0) {
    html += `<div class="welcome-flash-separator"></div>`;
    if (textPracticedToday) {
      html += `<div class="welcome-flash-done">${lucideIcon('circle-check', 16, '#22c55e')} ${esc(t('welcome.revised_today', textReviewedToday.length))}</div>`;
      if (textTotalDue > 0) {
        html += `<div class="welcome-flash-detail">${esc(t('welcome.chunks_still_due', textTotalDue))}</div>`;
        html += `<button class="welcome-flash-btn welcome-flash-btn--secondary" data-action="go-to-revise">${lucideIcon('book-open', 14)} ${esc(t('welcome.continue_revising'))}</button>`;
      }
    } else if (textTotalDue > 0) {
      html += `<div class="welcome-flash-counts">`;
      if (textDueChunks.length > 0) {
        html += `<span class="welcome-flash-due">${esc(t('welcome.chunks_due', textDueChunks.length))}</span>`;
      }
      if (textNewChunks.length > 0) {
        html += `<span class="welcome-flash-new">${esc(t('welcome.new_chunks', textNewChunks.length))}</span>`;
      }
      html += `</div>`;
      html += `<button class="welcome-flash-btn welcome-flash-btn--primary" data-action="go-to-revise">${lucideIcon('book-open', 14)} ${esc(t('welcome.revise_now'))}</button>`;
    } else {
      html += `<div class="welcome-flash-done">${lucideIcon('circle-check', 16, '#22c55e')} ${esc(t('welcome.texts_up_to_date'))}</div>`;
    }
  }
  html += `</div>`;

  // Upcoming birthdays
  html += `<div class="welcome-section" id="welcome-bucket-birthdays" style="--cat-color:#f97316">`;
  html += `<div class="welcome-section-header">${lucideIcon('cake', 18)} <span>${esc(t('welcome.upcoming_birthdays'))}</span></div>`;
  if (upcomingBDs.length > 0) {
    html += `<div class="welcome-items">`;
    for (const b of upcomingBDs) {
      const dayLabel = b.daysUntil === 0 ? t('welcome.today_birthday')
        : b.daysUntil === 1 ? t('welcome.tomorrow_birthday')
        : t('welcome.in_days', b.daysUntil);
      const avatarHtml = b.avatar_url
        ? `<img src="${b.avatar_url}" alt="${esc(b.name)}" class="welcome-birthday-avatar-img">`
        : lucideIcon('user', 16);
      const occDate = new Date(todayStart);
      occDate.setDate(occDate.getDate() + b.daysUntil);
      const occStr = occDate.getFullYear() + '-' + String(occDate.getMonth() + 1).padStart(2, '0') + '-' + String(occDate.getDate()).padStart(2, '0');
      html += `<div class="welcome-item" data-action="open-welcome-birthday" data-date="${occStr}">`;
      html += `<div class="welcome-item-main">`;
      html += `<span class="welcome-birthday-avatar${b.daysUntil === 0 ? ' birthday-today-avatar' : ''}">${avatarHtml}</span>`;
      html += `<span class="welcome-item-text">${esc(b.name)}</span>`;
      html += `<span class="welcome-badge birthday-badge">${esc(dayLabel)}</span>`;
      html += `</div>`;
      if (b.age > 0) {
        html += `<div class="welcome-item-meta">${esc(t('welcome.turning', b.age + (b.daysUntil === 0 ? 0 : 1)))}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="welcome-empty">${esc(t('welcome.no_birthdays'))}</div>`;
  }
  html += `</div>`;
  html += `</div>`; // close second welcome-grid

  // Stats overview
  html += `<div class="welcome-section" id="welcome-bucket-stats" style="--cat-color:var(--accent)">`;
  html += `<div class="welcome-section-header">${lucideIcon('bar-chart-3', 18)} <span>${esc(t('welcome.stats'))}</span></div>`;
  html += `<div class="welcome-stats-grid">`;
  const stats = [
    { icon: 'list-checks', value: todosPending, label: t('welcome.todos_pending'), color: '#22c55e' },
    { icon: 'circle-check', value: todosDoneWeek, label: t('welcome.todos_done_week'), color: '#10b981' },
    { icon: 'repeat', value: wHabitCompletionsWeek, label: t('welcome.habits_done_week'), color: '#ec4899' },
    { type: 'memory', color: '#06b6d4' },
    { icon: 'layout-grid', value: wProjectCount, label: t('welcome.projects'), color: '#6366f1' },
  ];
  for (const s of stats) {
    html += `<div class="welcome-stat-card" style="--stat-color:${s.color}">`;
    if (s.type === 'memory') {
      const fcDue = dueCards.length + newCards.length;
      const textDue = textDueChunks.length + textNewChunks.length;
      html += `<div class="welcome-stat-memory">`;
      html += `<div class="welcome-stat-memory-row">`;
      html += `<span class="welcome-stat-icon">${lucideIcon('brain', 18, s.color)}</span>`;
      html += `<span class="welcome-stat-value">${fcDue}</span>`;
      html += `<span class="welcome-stat-sub-label">${esc(t('welcome.due'))}</span>`;
      html += `<span class="welcome-stat-total">/ ${wFlashcards.length}</span>`;
      html += `</div>`;
      if (wTexts.length > 0) {
        html += `<div class="welcome-stat-memory-row">`;
        html += `<span class="welcome-stat-icon">${lucideIcon('book-open', 18, s.color)}</span>`;
        html += `<span class="welcome-stat-value">${textDue}</span>`;
        html += `<span class="welcome-stat-sub-label">${esc(t('welcome.due'))}</span>`;
        html += `<span class="welcome-stat-total">/ ${wTextProgress.length}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
      html += `<div class="welcome-stat-label">${esc(t('welcome.total_flashcards'))}</div>`;
    } else {
      html += `<div class="welcome-stat-top">`;
      html += `<span class="welcome-stat-icon">${lucideIcon(s.icon, 22, s.color)}</span>`;
      html += `<span class="welcome-stat-value">${s.value}</span>`;
      html += `</div>`;
      html += `<div class="welcome-stat-label">${esc(s.label)}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  const scrollY = window.scrollY;
  const innerScrolls = captureInnerScrollPositions(container);
  container.innerHTML = html;
  window.scrollTo(0, scrollY);
  restoreInnerScrollPositions(container, innerScrolls);

  // Init hover delay for focus TODO items (action buttons appear on hover/long-press)
  initWelcomeFocusHover();

  // Init hover delay for focus habit items (same behavior)
  initWelcomeFocusHabitHover();
}

export { refreshWelcome, renderWelcome };

// ── Go to Flashcards tab AND auto-start practice ──
function goToPractice() {
  window['_pendingPracticeStart'] = 1;
  if (typeof switchView === 'function') switchView('flashcards');
  else window.switchView('flashcards');
}
window.goToPractice = goToPractice;

function goToRevise() {
  window['_pendingTextPracticeStart'] = 1;
  if (typeof switchView === 'function') switchView('flashcards');
  else window.switchView('flashcards');
}
window.goToRevise = goToRevise;

// ── Header-offset-aware scroll for Welcome nav buttons ──
function scrollToWelcomeBucket(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const header = document.querySelector('.app-header');
  if (header) {
    const headerBottom = header.getBoundingClientRect().bottom;
    const elementTop = el.getBoundingClientRect().top;
    const offset = elementTop - headerBottom - 8;
    window.scrollBy({ top: offset, behavior: 'smooth' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
window.scrollToWelcomeBucket = scrollToWelcomeBucket;
window.welcomeCalNav = welcomeCalNav;
window.welcomeCalToday = welcomeCalToday;

// CSP delegation for welcome handled in js/delegation.js — no per-module listeners

