// ===================================================================
// WELCOME / TODAY — Daily briefing dashboard
// ===================================================================
import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state, { ARCHIVED_PROJECTS_KEY } from './state.js';
import { esc, escQ, renderMd, showToast, showDeleteConfirm, formatRelativeDate, truncateWithShowMore } from './utils.js';
import { initItemHoverDelay, inlineEditText } from './item-utils.js';
import { formatFrequency, formatHabitDue, habitDueStatus, getHabitLastDone, formatHabitRelative, getHabitCompletionCount, updateHabitNextDue, refreshHabits } from './habits.js';
import { getCategoryColor, getTodos, refreshTodos } from './todos.js';
import { getFlashcards, getTexts, getTextProgress } from './flashcards.js';
import { sharedBadge } from './sharing-ui.js';

// ── Local data cache ──
let wTodos = [];
let wHabits = [];
let wHabitCompletionsWeek = 0;
let wFlashcards = [];
let wTexts = [];
let wTextProgress = [];
let wBirthdays = [];
let wProjectCount = 0;
let wVestiaireCount = 0;

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
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  wTodos = getTodos();
  wHabits = state.allHabits;
  wHabitCompletionsWeek = state.allHabitCompletions.filter(c => new Date(c.completed_at) >= weekAgo).length;
  wFlashcards = getFlashcards();
  wTexts = getTexts();
  wTextProgress = getTextProgress();
  wBirthdays = state.allBirthdays;
  const archivedIds = (() => { try { return JSON.parse(localStorage.getItem(ARCHIVED_PROJECTS_KEY) || '[]'); } catch { return []; } })();
  wProjectCount = state.PROJECTS.filter(p => !archivedIds.includes(p.id)).length;
  wVestiaireCount = state.allVestiaire.length;
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

// ── Welcome-specific TODO action handlers ──

async function welcomeToggleTodo(id, done) {
  const { error } = await state.db.from('todos').update({ done }).eq('id', id);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success');
  await refreshTodos();
  refreshWelcome();
  renderWelcome();
}

async function welcomeDeleteTodo(id) {
  showDeleteConfirm(
    t('common.delete'),
    'Delete this TODO? This cannot be undone.',
    async () => {
      const { error } = await state.db.from('todos').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('toast.deleted'), 'info');
      await refreshTodos();
      refreshWelcome();
      renderWelcome();
    }
  );
}

const W_PRIORITY_LEVELS = [
  { key: 'urgent', color: '#ef4444', icon: 'alert-triangle' },
  { key: 'high', color: '#f97316', icon: 'flag' },
  { key: 'medium', color: '#eab308', icon: 'flag' },
  { key: 'low', color: '#3b82f6', icon: 'flag' },
  { key: 'normal', color: null, icon: 'circle-off' },
];

function welcomeOpenPriorityPicker(id, event, triggerEl) {
  event.stopPropagation();
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
}

async function welcomeSetPriority(id, level) {
  welcomeClosePriorityPicker();
  const { error } = await state.db.from('todos').update({ priority: level }).eq('id', id);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  const label = t(`todos.priority_${level}`) || level;
  showToast(label, 'success');
  await refreshTodos();
  refreshWelcome();
  renderWelcome();
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
  const isOverdue = td.due_date && !td.done && new Date(td.due_date) < now;
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
    const d = new Date(td.due_date);
    const diffMs = d - now;
    const diffH = Math.round(diffMs / (1000 * 60 * 60));
    if (isOverdue) {
      dueDateStr = `<span class="todo-due overdue">${lucideIcon('alert-triangle', 14)} ${t('todos.overdue')} (${formatRelativeDate(d)})</span>`;
    } else if (diffH < 24) {
      dueDateStr = `<span class="todo-due due-soon">${lucideIcon("bell", 16)} ${t('todos.due')} ${formatRelativeDate(d)}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">${lucideIcon("calendar", 16)} ${formatRelativeDate(d)}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon", 16)} ${t('todos.snoozed_until')} ${new Date(td.snooze_until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
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
    sharedHtml = sharedBadge(group?.name || '');
  }

  return `<div class="${classes}" data-todo-id="${td.id}">
    <div class="todo-row">
      ${flagBtn}
      <span class="todo-text">${td.text.length > 150 ? truncateWithShowMore(td.text, 150, td.id, 'todo') : renderMd(td.text)}</span>${sharedHtml}
      <div class="todo-actions">
        <button data-action="welcome-toggle-todo" data-todo-id="${esc(td.id)}" data-done="true" title="${t('common.done')}">${lucideIcon("circle-check", 16)}</button>
        <button data-action="welcome-snooze" data-todo-id="${esc(td.id)}" title="${t('todos.snooze')}">${lucideIcon("moon", 16)}</button>
        <button data-action="edit-todo-inline" data-todo-id="${esc(td.id)}" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
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

async function welcomeMarkHabitDone(habitId, btnEl) {
  if (!habitId) return;
  // Per-id guard
  const pendingSet = window._pendingWelcomeHabitDones || (window._pendingWelcomeHabitDones = new Set());
  if (pendingSet.has(habitId)) return;
  pendingSet.add(habitId);
  const sel = `button.habit-done-btn[data-habit-id="${CSS && CSS.escape ? CSS.escape(habitId) : habitId.replace(/"/g, '\\"')}"]`;
  const allBtns = document.querySelectorAll(sel);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : (allBtns[0] || null);
  const toToggle = new Set([...allBtns, ...(targetBtn ? [targetBtn] : [])]);
  toToggle.forEach(b => { b.disabled = true; b.classList.add('saving','is-pending'); b.setAttribute('aria-busy','true'); });
  try {
    const habit = (state.allHabits || []).find(c => c.id === habitId);
    const now = new Date().toISOString();
    const { error } = await state.db.from('habit_completions').insert({ habit_id: habitId, completed_at: now });
    if (error) { showToast(t('habits.failed_record'), 'error'); return; }
    if (habit) await updateHabitNextDue(habitId, habit.frequency_rule, now);
    showToast(t('habits.habit_done'), 'success');
    await refreshHabits();
    refreshWelcome();
    renderWelcome();
  } finally {
    pendingSet.delete(habitId);
    toToggle.forEach(b => { b.disabled = false; b.classList.remove('saving','is-pending'); b.removeAttribute('aria-busy'); });
  }
}

async function welcomeDeleteHabit(habitId) {
  const habit = (state.allHabits || []).find(c => c.id === habitId);
  if (!habit) return;
  showDeleteConfirm(
    t('common.delete'),
    `Delete "${habit.name}"? All completion history will be lost.`,
    async () => {
      const { error } = await state.db.from('habits').delete().eq('id', habitId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('habits.habit_deleted'), 'info');
      await refreshHabits();
      refreshWelcome();
      renderWelcome();
    }
  );
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
    ? `${t('habits.last_done')}: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatHabitRelative(lastDone)})`
    : 'Never done';

  return `<div class="bucket-item habit-item habit-status-${status}" data-habit-id="${habit.id}">
    <div class="habit-row">
      <div class="habit-info">
        <span class="habit-name">${esc(habit.name)}</span>
        <span class="habit-frequency">${esc(formatFrequency(habit.frequency_rule))}</span>
      </div>
      <div class="habit-actions">
        <button data-habit-id="${esc(habit.id)}" data-action="welcome-mark-habit-done" title="${t('habits.mark_done')}" class="habit-done-btn">${lucideIcon("circle-check", 16)}</button>
        <button data-action="welcome-open-habit-history" data-habit-id="${esc(habit.id)}" title="${t('habits.habit_history')} (${completionCount})" class="habit-history-btn">${lucideIcon("clipboard-list", 16)} ${completionCount}</button>
        <button data-action="edit-habit-inline" data-habit-id="${esc(habit.id)}" title="${t('common.edit')}">${lucideIcon("pencil", 16)}</button>
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
// WELCOME — Calendar 7-day lookahead
// ===================================================================
function renderWelcomeCalendar(allBirthdays, allHabits, todayStart) {
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  // Month context — if the 7 days span two months, show both
  const firstMonth = days[0].toLocaleDateString(locale, { month: 'long' });
  const lastMonth = days[6].toLocaleDateString(locale, { month: 'long' });
  const monthLabel = firstMonth === lastMonth ? firstMonth : `${firstMonth} – ${lastMonth}`;
  const yearLabel = days[0].getFullYear();

  let html = `<div class="welcome-section" id="welcome-bucket-calendar" style="--cat-color:var(--accent)">`;
  html += `<div class="welcome-section-header">${lucideIcon('calendar-days', 18)} <span>${esc(t('welcome.coming_up'))}</span><span class="welcome-cal-month-ctx">${esc(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))} ${yearLabel}</span></div>`;
  html += `<div class="welcome-calendar-strip">`;

  for (const day of days) {
    const dayStart = startOfDay(day);
    const isToday = dayStart.getTime() === todayStart.getTime();
    const dayName = day.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '');
    const dayNum = day.getDate();

    // Find birthdays on this day
    const bdOnDay = allBirthdays.filter(b => {
      const bd = new Date(b.birthday + 'T00:00:00');
      return bd.getMonth() === day.getMonth() && bd.getDate() === day.getDate();
    });

    // Find habits due on this day
    const habitsOnDay = allHabits.filter(h => {
      if (h.is_draft || !h.next_due) return false;
      const dueDay = startOfDay(new Date(h.next_due));
      return dueDay.getTime() === dayStart.getTime();
    });

    // For overdue habits, show them on today
    const overdueOnDay = isToday ? allHabits.filter(h => {
      if (h.is_draft || !h.next_due) return false;
      const dueDay = startOfDay(new Date(h.next_due));
      return dueDay < todayStart;
    }) : [];

    const allHabitsOnDay = [...overdueOnDay, ...habitsOnDay];

    html += `<div class="welcome-cal-day${isToday ? ' is-today' : ''}${(day.getDay() === 0 || day.getDay() === 6) ? ' is-weekend' : ''}">`;
    html += `<span class="welcome-cal-day-name">${esc(isToday ? t('welcome.cal_today') : dayName)}</span>`;
    html += `<span class="welcome-cal-day-num${isToday ? ' today-num' : ''}">${dayNum}</span>`;
    html += `<div class="welcome-cal-dots">`;
    for (const b of bdOnDay) {
      html += `<span class="welcome-cal-dot birthday" title="${esc(b.name)}"></span>`;
    }
    for (let idx = 0; idx < Math.min(allHabitsOnDay.length, 4); idx++) {
      const hColor = getCategoryColor(allHabitsOnDay[idx].category || 'General');
      html += `<span class="welcome-cal-dot habit" style="background:${hColor}" title="${esc(allHabitsOnDay[idx].name)}"></span>`;
    }
    html += `</div>`;

    // Show item labels (max 2)
    const items = [];
    for (const b of bdOnDay) items.push({ type: 'birthday', name: b.name });
    for (const h of allHabitsOnDay) {
      const isOverdue = overdueOnDay.includes(h);
      items.push({ type: isOverdue ? 'habit-overdue' : 'habit-due', name: h.name });
    }
    if (items.length > 0) {
      html += `<div class="welcome-cal-day-items">`;
      for (let k = 0; k < Math.min(items.length, 2); k++) {
        html += `<span class="welcome-cal-item ${items[k].type}" title="${esc(items[k].name)}">${esc(items[k].name)}</span>`;
      }
      if (items.length > 2) {
        html += `<span class="welcome-cal-item habit-due" style="opacity:0.7">+${items.length - 2}</span>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  html += `</div>`;
  return html;
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
      const due = startOfDay(new Date(td.due_date));
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
    if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  // ── 2. Habits due ──
  const habitsDue = wHabits.filter(c => {
    if (c.is_draft) return false;
    if (!c.next_due) return false;
    return startOfDay(new Date(c.next_due)) <= todayStart;
  });
  habitsDue.sort((a, b) => new Date(a.next_due) - new Date(b.next_due));

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
  const habitsDueNavCount = wHabits.filter(c => !c.is_draft && c.next_due && startOfDay(new Date(c.next_due)) <= todayStart).length;
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
  if (focusTodos.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.all_clear'))}</div>`;
  } else {
    // Group todos by category
    const todosByCategory = {};
    for (const td of focusTodos) {
      const cat = td.category || '';
      if (!todosByCategory[cat]) todosByCategory[cat] = [];
      todosByCategory[cat].push(td);
    }
    html += `<div class="welcome-items welcome-focus-todos">`;
    const catKeys = Object.keys(todosByCategory);
    for (const cat of catKeys) {
      const catColor = getCategoryColor(cat);
      const catName = cat || 'General';
      if (catKeys.length > 1 || cat) {
        html += `<div class="welcome-todo-cat-label" style="--cat-color:${catColor}"><span class="welcome-todo-cat-dot"></span>${esc(catName)}</div>`;
      }
      for (const td of todosByCategory[cat]) {
        html += renderFocusTodoItem(td);
      }
    }
    html += `</div>`;
  }
  // Quick-add TODO with category selector
  const todoCats = [...new Set(wTodos.map(td => td.category || ''))].sort();
  if (!todoCats.includes('')) todoCats.unshift('');
  html += `<div class="welcome-quick-add">`;
  html += `<select class="welcome-quick-cat-select" data-action="update-next-sibling-category">`;
  for (const cat of todoCats) {
    html += `<option value="${esc(cat)}">${esc(cat || 'General')}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" placeholder="${esc(t('todos.add_todo_placeholder'))}" maxlength="2000" class="todo-cat-input" data-category="${esc(todoCats[0])}" data-priority="medium" data-action="welcome-quick-add-todo-on-enter">`;
  html += `<button class="todo-add-priority-btn" data-action="open-quick-add-priority-picker" title="${esc(t('todos.set_priority'))}">${lucideIcon('flag', 16, '#eab308')}</button>`;
  html += `<button data-action="welcome-add-todo-from-quick">+</button>`;
  html += `</div>`;
  html += `</div>`;

  // Habits due
  html += `<div class="welcome-section" id="welcome-bucket-habits" style="--cat-color:#ec4899">`;
  html += `<div class="welcome-section-header">${lucideIcon('repeat', 18)} <span>${esc(t('welcome.habits_due'))}</span></div>`;
  if (habitsDue.length === 0) {
    html += `<div class="welcome-empty">${esc(t('welcome.no_habits_due'))}</div>`;
  } else {
    // Group habits by category
    const habitsByCategory = {};
    for (const ch of habitsDue) {
      const cat = ch.category || 'General';
      if (!habitsByCategory[cat]) habitsByCategory[cat] = [];
      habitsByCategory[cat].push(ch);
    }
    html += `<div class="welcome-items welcome-focus-habits">`;
    const habitCatKeys = Object.keys(habitsByCategory).sort();
    for (const cat of habitCatKeys) {
      const catColor = getCategoryColor(cat);
      html += `<div class="welcome-todo-cat-label" style="--cat-color:${catColor}"><span class="welcome-todo-cat-dot"></span>${esc(cat)}</div>`;
      for (const ch of habitsByCategory[cat]) {
        html += renderFocusHabitItem(ch);
      }
    }
    html += `</div>`;
  }
  // Quick-add Habit (opens modal pre-filled with name + category)
  const habitCats = [...new Set(wHabits.map(c => c.category || 'General'))].sort();
  if (!habitCats.includes('General')) habitCats.unshift('General');
  html += `<div class="welcome-quick-add">`;
  html += `<select class="welcome-quick-cat-select" data-action="update-next-sibling-category">`;
  for (const cat of habitCats) {
    html += `<option value="${esc(cat)}">${esc(cat)}</option>`;
  }
  html += `</select>`;
  html += `<input type="text" placeholder="${esc(t('habits.quick_add_placeholder'))}" maxlength="200" class="todo-cat-input habit-add-input" data-category="${esc(habitCats[0])}" data-action="welcome-quick-add-habit-on-enter">`;
  html += `<button data-action="welcome-add-habit-from-quick">+</button>`;
  html += `</div>`;
  html += `</div>`;
  html += `</div>`; // close welcome-grid

  // Calendar — 7-day lookahead with birthdays + habits
  html += renderWelcomeCalendar(wBirthdays, wHabits, todayStart);

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
      html += `<div class="welcome-item" data-action="switch-view" data-view="birthdays">`;
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
    { icon: 'shirt', value: wVestiaireCount, label: t('welcome.wardrobe_items'), color: '#8b5cf6' },
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

  container.innerHTML = html;

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

// CSP delegation for welcome handled in js/delegation.js — no per-module listeners

