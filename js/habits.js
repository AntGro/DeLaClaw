import { lucideIcon } from './icons.js';
import state, { DEFAULT_CATEGORY_PALETTE, GENERAL_CATEGORY_COLOR, SHARED_CATEGORY as SHARED_CAT_CONST } from './state.js';
import { esc, escQ, renderMd, showToast, showConfirmAction, balanceGrid, fetchAll, backfillCategoryColors } from './utils.js';
import { initItemHoverDelay, scrollToAndHighlight, inlineEditText } from './item-utils.js';
import { t, getLang } from './i18n.js';
import { sharedBadge, openSharePopover } from './sharing-ui.js';

// ===================================================================
// HABITS — DATA, CRUD & RENDERING
// ===================================================================
// (state managed in state.js)
// (state managed in state.js)
let habitFilter = 'all';
let habitSearchQuery = '';
let habitViewMode = 'list'; // 'list' or 'calendar'
let habitCalMonth = null; // { year, month } for calendar navigation
let habitCalSelectedDay = null; // ISO string of selected day (mobile tap-to-expand)
let habitCalScale = 'month'; // 'month' or 'week'
let habitCalWeekStart = null; // Date object for the start of the current week view (today-based)
// ── Shortnames (synced via settings table) ──
const SHARED_CATEGORY = SHARED_CAT_CONST;

// ── Category table state ──
// Categories live in the habit_categories DB table. Loaded into maps for fast lookup.
let _habitCatMap = new Map();    // id → row
let _habitCatByName = new Map(); // name → row (backward compat)
let _defaultHabitCatId = null;   // protected General row
let _sharedHabitCatId = null;    // protected __shared__ row
const _myCreatedSharedHabitIds = new Set(); // shared_ids where current user is creator

async function loadHabitCategories() {
  const { data, error } = await state.db.from('habit_categories').select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('loadHabitCategories error:', error); return; }
  _habitCatMap.clear();
  _habitCatByName.clear();
  _defaultHabitCatId = null;
  _sharedHabitCatId = null;
  for (const row of (data || [])) {
    _habitCatMap.set(row.id, row);
    _habitCatByName.set(row.name, row);
    if (row.is_protected && row.name === SHARED_CATEGORY) _sharedHabitCatId = row.id;
    else if (row.is_protected && row.name !== SHARED_CATEGORY) _defaultHabitCatId = row.id;
  }
  await backfillCategoryColors('habit_categories', _habitCatMap);
}

function getHabitCategories() { return _habitCatMap; }

// ── Category helpers ──
function getHabitCatColor(catId) { return _habitCatMap.get(catId)?.color || GENERAL_CATEGORY_COLOR; }
function getHabitCatShortname(catId) { return _habitCatMap.get(catId)?.shortname || ''; }
function getHabitCatName(catId) { return _habitCatMap.get(catId)?.name ?? ''; }
function getHabitCatDisplayName(catId) {
  const cat = _habitCatMap.get(catId);
  if (!cat) return t('common.category_default');
  if (cat.name === '') return t('common.category_default');
  if (cat.name === SHARED_CATEGORY) return t('sharing.shared');
  return cat.name;
}
function catIdForHabit(habit) { return habit.category_id || _habitCatByName.get(habit.category ?? '')?.id || _defaultHabitCatId; }

// Backward-compat: accepts name or ID. Used by welcome.js for habit category colors.
function getHabitCategoryColor(nameOrId) {
  if (_habitCatMap.has(nameOrId)) return _habitCatMap.get(nameOrId).color || GENERAL_CATEGORY_COLOR;
  const byName = _habitCatByName.get(nameOrId);
  if (byName) return byName.color || GENERAL_CATEGORY_COLOR;
  return GENERAL_CATEGORY_COLOR;
}
function openEditHabitCategoryModal(catId) {
  const cat = _habitCatMap.get(catId);
  if (!cat) return;
  document.getElementById('editHabitCatOldName').value = catId; // store ID, not name
  document.getElementById('editHabitCatName').value = cat.name;
  document.getElementById('editHabitCatShortname').value = cat.shortname || '';
  document.getElementById('editHabitCatColor').value = cat.color || GENERAL_CATEGORY_COLOR;
  document.getElementById('editHabitCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('editHabitCatName').focus(), 50);
}

function closeEditHabitCategoryModal() {
  document.getElementById('editHabitCategoryModal').classList.remove('visible');
}

async function saveEditHabitCategory() {
  const catId = document.getElementById('editHabitCatOldName').value;
  const cat = _habitCatMap.get(catId);
  if (!cat) return;
  const newName = document.getElementById('editHabitCatName').value.trim();
  const shortname = document.getElementById('editHabitCatShortname').value.trim();
  const color = document.getElementById('editHabitCatColor').value;
  if (!newName && !cat.is_protected) { showToast(t('toast.name_required'), 'error'); return; }

  // Update the DB row directly
  const updates = { shortname: shortname || null, color };
  if (!cat.is_protected) updates.name = newName;
  await state.db.from('habit_categories').update(updates).eq('id', catId);
  Object.assign(cat, updates);
  _habitCatByName.clear();
  for (const row of _habitCatMap.values()) _habitCatByName.set(row.name, row);

  closeEditHabitCategoryModal();
  renderHabits();
  showToast(t('toast.updated'), 'success');
}


// ===================================================================
// NEXT_DUE — structured rules computed client-side, custom rules by heartbeat
// ===================================================================
// Structured frequency_rule formats:
//   daily, every_N_days:X, weekly:Mon,Wed,Fri, every_N_weeks:2:Mon,
//   monthly:1, monthly_weekday:first:Mon, every_N_months:3:1, yearly:MM-DD
// Custom (free-text) rules → next_due = null → heartbeat handles them.

const STRUCTURED_PREFIXES = ['daily', 'every_N_days:', 'weekly:', 'every_N_weeks:', 'monthly:', 'monthly_weekday:', 'every_N_months:', 'yearly:'];
const DOW_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_JS   = [1, 2, 3, 4, 5, 6, 0]; // JS getDay(): Sun=0

function isStructuredRule(rule) {
  if (!rule) return false;
  return STRUCTURED_PREFIXES.some(p => rule === p.replace(/:$/, '') || rule.startsWith(p));
}

/** Format a Date as YYYY-MM-DD in local time (not UTC). */
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function computeNextDue(frequencyRule, lastDoneDate) {
  if (!frequencyRule || !isStructuredRule(frequencyRule)) return null;
  const today = new Date(); today.setHours(0,0,0,0);

  // No completions yet — due today
  if (!lastDoneDate) return localDateStr(today);

  const base = new Date(lastDoneDate);
  const baseDay = new Date(base.getFullYear(), base.getMonth(), base.getDate());

  if (frequencyRule === 'daily') {
    const next = new Date(baseDay); next.setDate(next.getDate() + 1);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  if (frequencyRule.startsWith('every_N_days:')) {
    const n = parseInt(frequencyRule.split(':')[1], 10) || 1;
    const next = new Date(baseDay); next.setDate(next.getDate() + n);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  if (frequencyRule.startsWith('weekly:')) {
    const days = frequencyRule.split(':')[1].split(',');
    const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
    if (dayIndices.length === 0) return null;
    // Find next occurrence after base
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(baseDay); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay())) {
        return candidate < today ? localDateStr(today) : localDateStr(candidate);
      }
    }
    return null;
  }

  if (frequencyRule.startsWith('every_N_weeks:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;
    const days = (parts[2] || '').split(',');
    const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
    if (dayIndices.length === 0) return null;
    const next = new Date(baseDay); next.setDate(next.getDate() + n * 7);
    // Find the first matching day in that week
    const weekStart = new Date(next);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() + (weekStart.getDay() === 0 ? -6 : 1)); // Monday
    for (let offset = 0; offset < 7; offset++) {
      const candidate = new Date(weekStart); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay()) && candidate > baseDay) {
        return candidate < today ? localDateStr(today) : localDateStr(candidate);
      }
    }
    return null;
  }

  if (frequencyRule.startsWith('monthly:')) {
    const dom = parseInt(frequencyRule.split(':')[1], 10);
    if (!dom || dom < 1 || dom > 31) return null;
    let next = new Date(baseDay.getFullYear(), baseDay.getMonth(), dom);
    if (next <= baseDay) next = new Date(baseDay.getFullYear(), baseDay.getMonth() + 1, dom);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  if (frequencyRule.startsWith('monthly_weekday:')) {
    const parts = frequencyRule.split(':');
    const position = parts[1]; // 'first' or 'last'
    const dayName = parts[2];
    const dayIdx = DOW_JS[DOW_KEYS.indexOf(dayName)];
    if (dayIdx === undefined) return null;
    function findNthWeekday(year, month, targetDay, pos) {
      if (pos === 'first') {
        const d = new Date(year, month, 1);
        while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
        return d;
      } else {
        const d = new Date(year, month + 1, 0); // last day
        while (d.getDay() !== targetDay) d.setDate(d.getDate() - 1);
        return d;
      }
    }
    let next = findNthWeekday(baseDay.getFullYear(), baseDay.getMonth(), dayIdx, position);
    if (next <= baseDay) next = findNthWeekday(baseDay.getFullYear(), baseDay.getMonth() + 1, dayIdx, position);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  if (frequencyRule.startsWith('every_N_months:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;
    const dom = parseInt(parts[2], 10) || 1;
    let next = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, dom);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  if (frequencyRule.startsWith('yearly:')) {
    const mmdd = frequencyRule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    if (!mm || !dd) return null;
    let next = new Date(baseDay.getFullYear(), mm - 1, dd);
    if (next <= baseDay) next = new Date(baseDay.getFullYear() + 1, mm - 1, dd);
    return next < today ? localDateStr(today) : localDateStr(next);
  }

  return null;
}

function formatFrequency(rule) {
  if (!rule) return '';
  if (!isStructuredRule(rule)) return rule; // legacy free-text: show as-is

  if (rule === 'daily') return t('habits.freq_display_daily');

  if (rule.startsWith('every_N_days:')) {
    const n = rule.split(':')[1];
    return t('habits.freq_display_every_n_days', n);
  }

  if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',');
    const dayLabels = days.map(d => t('habits.day_' + d.toLowerCase()));
    return t('habits.freq_display_weekly', dayLabels.join(', '));
  }

  if (rule.startsWith('every_N_weeks:')) {
    const parts = rule.split(':');
    const n = parts[1];
    const days = (parts[2] || '').split(',');
    const dayLabels = days.map(d => t('habits.day_' + d.toLowerCase()));
    return t('habits.freq_display_every_n_weeks', n, dayLabels.join(', '));
  }

  if (rule.startsWith('monthly:')) {
    const dom = rule.split(':')[1];
    return t('habits.freq_display_monthly', ordinalSuffix(parseInt(dom, 10)));
  }

  if (rule.startsWith('monthly_weekday:')) {
    const parts = rule.split(':');
    const pos = t('habits.freq_' + parts[1]);
    const dayLabel = t('habits.day_' + parts[2].toLowerCase());
    return t('habits.freq_display_monthly_weekday', pos, dayLabel);
  }

  if (rule.startsWith('every_N_months:')) {
    const parts = rule.split(':');
    return t('habits.freq_display_every_n_months', parts[1], ordinalSuffix(parseInt(parts[2], 10)));
  }

  if (rule.startsWith('yearly:')) {
    const mmdd = rule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    const d = new Date(2000, mm - 1, dd);
    return t('habits.freq_display_yearly', d.toLocaleDateString([], { month: 'long', day: 'numeric' }));
  }

  return rule;
}

function ordinalSuffix(n) {
  if (!n) return '';
  const lang = getLang();
  if (lang === 'fr') return n === 1 ? '1er' : String(n);
  if (lang === 'es') return n === 1 ? '1.º' : String(n) + '.º';
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function normalizeHabitNextDue(value) {
  return value ? String(value).slice(0, 10) : null;
}

async function updateHabitNextDue(habitId, frequencyRule, lastDoneDate) {
  const nextDue = isStructuredRule(frequencyRule)
    ? normalizeHabitNextDue(computeNextDue(frequencyRule, lastDoneDate))
    : null;
  const habit = state.allHabits.find(h => String(h.id) === String(habitId));
  const currentNextDue = normalizeHabitNextDue(habit?.next_due);

  if (habit && currentNextDue === nextDue) return;

  const { error } = await state.db.from('habits').update({ next_due: nextDue }).eq('id', habitId);
  if (error) {
    console.warn(nextDue ? 'Failed to update next_due:' : 'Failed to clear next_due:', error.message);
    return;
  }
  if (habit) habit.next_due = nextDue;
}

async function clearHabitNextDue(habitId) {
  await updateHabitNextDue(habitId, '', null);
}

// ===================================================================
// FREQUENCY PICKER — shared UI builder for add/edit/inline
// ===================================================================
const FREQ_TYPES = [
  'daily', 'every_N_days', 'weekly', 'every_N_weeks',
  'monthly', 'monthly_weekday', 'every_N_months', 'yearly', 'custom'
];

function buildFrequencyPicker(container, currentRule) {
  container.innerHTML = '';
  container.className = (container.className.replace(/\bfreq-picker\b/, '') + ' freq-picker').trim();

  // Detect current type from rule (default to 'weekly' for new habits)
  let currentType = currentRule ? 'custom' : 'weekly';
  let parsed = {};
  if (currentRule) {
    if (currentRule === 'daily') { currentType = 'daily'; }
    else if (currentRule.startsWith('every_N_days:')) { currentType = 'every_N_days'; parsed.n = currentRule.split(':')[1]; }
    else if (currentRule.startsWith('weekly:')) { currentType = 'weekly'; parsed.days = currentRule.split(':')[1].split(','); }
    else if (currentRule.startsWith('every_N_weeks:')) { currentType = 'every_N_weeks'; const p = currentRule.split(':'); parsed.n = p[1]; parsed.days = (p[2]||'').split(','); }
    else if (currentRule.startsWith('monthly:')) { currentType = 'monthly'; parsed.dom = currentRule.split(':')[1]; }
    else if (currentRule.startsWith('monthly_weekday:')) { currentType = 'monthly_weekday'; const p = currentRule.split(':'); parsed.position = p[1]; parsed.day = p[2]; }
    else if (currentRule.startsWith('every_N_months:')) { currentType = 'every_N_months'; const p = currentRule.split(':'); parsed.n = p[1]; parsed.dom = p[2]; }
    else if (currentRule.startsWith('yearly:')) { currentType = 'yearly'; parsed.mmdd = currentRule.split(':')[1]; }
    else { currentType = 'custom'; parsed.text = currentRule; }
  }

  // Type selector
  const sel = document.createElement('select');
  sel.className = 'inline-edit-input freq-type-select';
  FREQ_TYPES.forEach(ft => {
    // Hide 'custom' (free-text) for new habits; only show it for existing habits that already use it
    if (ft === 'custom' && currentType !== 'custom') return;
    const opt = document.createElement('option');
    opt.value = ft;
    opt.textContent = t('habits.freq_' + ft.toLowerCase());
    if (ft === currentType) opt.selected = true;
    sel.appendChild(opt);
  });
  container.appendChild(sel);

  // Options container
  const opts = document.createElement('div');
  opts.className = 'freq-options';
  container.appendChild(opts);

  function renderOptions() {
    opts.innerHTML = '';
    const type = sel.value;

    if (type === 'every_N_days') {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '2'; inp.max = '365'; inp.className = 'inline-edit-input freq-n-input';
      inp.value = parsed.n || '2';
      inp.dataset.freqField = 'n';
      const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_n_label');
      opts.appendChild(label); opts.appendChild(inp);
    }

    if (type === 'weekly' || type === 'every_N_weeks') {
      if (type === 'every_N_weeks') {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '2'; inp.max = '52'; inp.className = 'inline-edit-input freq-n-input';
        inp.value = parsed.n || '2';
        inp.dataset.freqField = 'n';
        const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_n_label');
        opts.appendChild(label); opts.appendChild(inp);
      }
      const dayBar = document.createElement('div'); dayBar.className = 'freq-day-bar';
      DOW_KEYS.forEach(d => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'freq-day-btn';
        btn.textContent = t('habits.day_' + d.toLowerCase());
        btn.dataset.day = d;
        if (parsed.days && parsed.days.includes(d)) btn.classList.add('active');
        btn.addEventListener('click', () => btn.classList.toggle('active'));
        dayBar.appendChild(btn);
      });
      opts.appendChild(dayBar);
    }

    if (type === 'monthly' || type === 'every_N_months') {
      if (type === 'every_N_months') {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '2'; inp.max = '12'; inp.className = 'inline-edit-input freq-n-input';
        inp.value = parsed.n || '2';
        inp.dataset.freqField = 'n';
        const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_n_label');
        opts.appendChild(label); opts.appendChild(inp);
      }
      const domSel = document.createElement('select'); domSel.className = 'inline-edit-input freq-dom-select';
      domSel.dataset.freqField = 'dom';
      for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option'); opt.value = i; opt.textContent = ordinalSuffix(i);
        if (String(i) === String(parsed.dom || '1')) opt.selected = true;
        domSel.appendChild(opt);
      }
      const domLabel = document.createElement('span'); domLabel.className = 'freq-option-label'; domLabel.textContent = t('habits.freq_day_of_month');
      opts.appendChild(domLabel); opts.appendChild(domSel);
    }

    if (type === 'monthly_weekday') {
      const posSel = document.createElement('select'); posSel.className = 'inline-edit-input freq-pos-select';
      posSel.dataset.freqField = 'position';
      ['first', 'last'].forEach(p => {
        const opt = document.createElement('option'); opt.value = p; opt.textContent = t('habits.freq_' + p);
        if (p === (parsed.position || 'first')) opt.selected = true;
        posSel.appendChild(opt);
      });
      opts.appendChild(posSel);

      const daySel = document.createElement('select'); daySel.className = 'inline-edit-input freq-weekday-select';
      daySel.dataset.freqField = 'day';
      DOW_KEYS.forEach(d => {
        const opt = document.createElement('option'); opt.value = d; opt.textContent = t('habits.day_' + d.toLowerCase());
        if (d === (parsed.day || 'Mon')) opt.selected = true;
        daySel.appendChild(opt);
      });
      opts.appendChild(daySel);
    }

    if (type === 'yearly') {
      const mSel = document.createElement('select'); mSel.className = 'inline-edit-input freq-month-select';
      mSel.dataset.freqField = 'month';
      for (let i = 1; i <= 12; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0');
        opt.textContent = new Date(2000, i - 1, 1).toLocaleString([], { month: 'long' });
        const curM = parsed.mmdd ? parsed.mmdd.split('-')[0] : '01';
        if (String(i).padStart(2, '0') === curM) opt.selected = true;
        mSel.appendChild(opt);
      }
      opts.appendChild(mSel);

      const dSel = document.createElement('select'); dSel.className = 'inline-edit-input freq-dom-select';
      dSel.dataset.freqField = 'yearday';
      for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0'); opt.textContent = String(i);
        const curD = parsed.mmdd ? parsed.mmdd.split('-')[1] : '01';
        if (String(i).padStart(2, '0') === curD) opt.selected = true;
        dSel.appendChild(opt);
      }
      opts.appendChild(dSel);
    }

    if (type === 'custom') {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'inline-edit-input freq-custom-input';
      inp.value = parsed.text || '';
      inp.dataset.freqField = 'text';
      inp.placeholder = 'e.g. "every other weekend"';
      inp.maxLength = 300;
      opts.appendChild(inp);
    }
  }

  sel.addEventListener('change', () => { parsed = {}; renderOptions(); });
  renderOptions();
  return container;
}

function getFrequencyFromPicker(container) {
  const sel = container.querySelector('.freq-type-select');
  if (!sel) return container.querySelector('input')?.value?.trim() || '';
  const type = sel.value;
  const opts = container.querySelector('.freq-options');

  if (type === 'daily') return 'daily';

  if (type === 'every_N_days') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    return 'every_N_days:' + n;
  }

  if (type === 'weekly') {
    const days = Array.from(opts.querySelectorAll('.freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'weekly:' + days.join(',') : '';
  }

  if (type === 'every_N_weeks') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    const days = Array.from(opts.querySelectorAll('.freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'every_N_weeks:' + n + ':' + days.join(',') : '';
  }

  if (type === 'monthly') {
    const dom = opts.querySelector('[data-freq-field="dom"]')?.value || '1';
    return 'monthly:' + dom;
  }

  if (type === 'monthly_weekday') {
    const pos = opts.querySelector('[data-freq-field="position"]')?.value || 'first';
    const day = opts.querySelector('[data-freq-field="day"]')?.value || 'Mon';
    return 'monthly_weekday:' + pos + ':' + day;
  }

  if (type === 'every_N_months') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '2';
    const dom = opts.querySelector('[data-freq-field="dom"]')?.value || '1';
    return 'every_N_months:' + n + ':' + dom;
  }

  if (type === 'yearly') {
    const m = opts.querySelector('[data-freq-field="month"]')?.value || '01';
    const d = opts.querySelector('[data-freq-field="yearday"]')?.value || '01';
    return 'yearly:' + m + '-' + d;
  }

  if (type === 'custom') {
    return opts.querySelector('[data-freq-field="text"]')?.value?.trim() || '';
  }

  return '';
}

// getHabitCategories / saveHabitCategories / syncHabitCategoriesFromData — removed (now DB table-based via loadHabitCategories)

async function refreshHabits() {
  if (!state.db.connected) return;
  await loadHabitCategories();
  let habits;
  try {
    habits = await fetchAll(() => state.db.from('habits').select('*').order('created_at', { ascending: true }));
  } catch (chErr) {
    if (chErr.code === '42P01' || chErr.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allHabits = habits || [];

  try {
    state.allHabitCompletions = await fetchAll(() => state.db.from('habit_completions').select('*').order('completed_at', { ascending: false }));
  } catch (compErr) { /* leave existing completions as-is */ }

  // Enrich shared habit pointers with live data from Drive
  if (state.sharing) {
    const sharedHabits = state.sharing.getAllSharedHabits();
    const sharedById = new Map(sharedHabits.map(h => [h.id, h]));

    for (const habit of state.allHabits) {
      if (!habit.shared_id) continue;
      const sh = sharedById.get(habit.shared_id);
      if (sh) {
        // Enrich pointer with Drive data (keep local category for deck placement)
        habit.name = sh.name;
        habit.frequency_rule = sh.frequency_rule || '';
        habit.is_draft = 0;
        habit._shared = sh; // keep reference for completions/metadata
        // Inject shared completions into allHabitCompletions
        if (sh.completions?.length) {
          for (const c of sh.completions) {
            // Avoid duplicates (use shared habit id + completed_at as key)
            const exists = state.allHabitCompletions.some(
              lc => lc.habit_id === habit.id && (lc.id === c.id || lc.completed_at === c.completed_at)
            );
            if (!exists) {
              state.allHabitCompletions.push({
                id: c.id,
                habit_id: habit.id,
                completed_at: c.completed_at,
                completed_by: c.completed_by || '',
                note: null,
                _shared: true,
              });
            }
          }
          // Re-sort after injection
          state.allHabitCompletions.sort((a, b) => b.completed_at.localeCompare(a.completed_at));
          // Compute next_due from latest completion
          const latest = sh.completions[sh.completions.length - 1];
          await updateHabitNextDue(habit.id, sh.frequency_rule, latest.completed_at);
        } else {
          // No completions yet — compute first next_due from now
          await updateHabitNextDue(habit.id, sh.frequency_rule, null);
        }
      }
    }

    // Precompute which shared habits the current user created
    _myCreatedSharedHabitIds.clear();
    if (typeof state.sharing.getCurrentMember === 'function') {
      const groupIds = new Set(state.allHabits.filter(h => h.shared_group_id).map(h => h.shared_group_id));
      const memberIdPerGroup = new Map();
      const gidArr = [...groupIds];
      const members = await Promise.all(gidArr.map(gid => Promise.resolve(state.sharing.getCurrentMember(gid))));
      gidArr.forEach((gid, i) => { if (members[i]?.memberId) memberIdPerGroup.set(gid, members[i].memberId); });
      for (const habit of state.allHabits) {
        if (!habit._shared || !habit.shared_group_id) continue;
        const myId = memberIdPerGroup.get(habit.shared_group_id);
        if (myId && habit._shared.created_by === myId) _myCreatedSharedHabitIds.add(habit.shared_id);
      }
    }

    // Drop shared pointers whose remote data couldn't be resolved
    state.allHabits = state.allHabits.filter(h => !h.shared_id || h._shared);
  }

  // Categories already loaded via loadHabitCategories() above
  if (state.currentView === 'habits') {
    renderHabits();
  }
  document.dispatchEvent(new CustomEvent('habits-changed'));
}

function getHabitLastDone(habitId) {
  const comp = state.allHabitCompletions.find(c => c.habit_id === habitId);
  return comp ? new Date(comp.completed_at) : null;
}

function getHabitCompletionCount(habitId) {
  return state.allHabitCompletions.filter(c => c.habit_id === habitId).length;
}

function getHabitCompletions(habitId) {
  return state.allHabitCompletions.filter(c => c.habit_id === habitId);
}

function habitDateInputToIso(value) {
  return new Date(value + 'T12:00:00').toISOString();
}

function sortHabitCompletionList(completions) {
  return [...(completions || [])].sort((a, b) =>
    String(a.completed_at || '').localeCompare(String(b.completed_at || ''))
  );
}

function latestHabitCompletion(completions) {
  const sorted = sortHabitCompletionList(completions);
  return sorted[sorted.length - 1] || null;
}

function getLatestLocalHabitCompletion(habitId) {
  return latestHabitCompletion(getHabitCompletions(habitId));
}

function getSharedHabitForLocalHabit(habit) {
  if (!habit?.shared_id || !state.sharing) return null;
  return state.sharing.getAllSharedHabits().find(h => h.id === habit.shared_id) || null;
}

async function getSharedHabitCompletionActor(groupId) {
  if (typeof state.sharing?.getCurrentMemberId === 'function') {
    const memberId = await state.sharing.getCurrentMemberId(groupId);
    if (memberId) return memberId;
  }
  if (typeof state.sharing?.getCurrentMember === 'function') {
    const member = await state.sharing.getCurrentMember(groupId);
    if (member?.memberId) return member.memberId;
  }
  return '';
}

async function setSharedHabitLastDone(habit, newIso) {
  const sh = getSharedHabitForLocalHabit(habit);
  if (!sh) throw new Error('Shared habit not found');

  const completions = sortHabitCompletionList(sh.completions).map(c => ({ ...c }));
  if (newIso) {
    const latest = completions[completions.length - 1];
    if (latest) {
      latest.completed_at = newIso;
    } else {
      completions.push({
        id: crypto.randomUUID(),
        completed_at: newIso,
        completed_by: await getSharedHabitCompletionActor(habit.shared_group_id),
      });
    }
  } else if (completions.length > 0) {
    completions.pop();
  }

  const nextCompletions = sortHabitCompletionList(completions);
  await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, { completions: nextCompletions });
  return latestHabitCompletion(nextCompletions)?.completed_at || null;
}

async function setLocalHabitLastDone(habitId, newIso) {
  const latest = getLatestLocalHabitCompletion(habitId);
  const projected = getHabitCompletions(habitId).map(c => ({ ...c }));

  if (newIso) {
    if (latest) {
      const { error } = await state.db.from('habit_completions').update({ completed_at: newIso }).eq('id', latest.id);
      if (error) throw new Error(error.message || 'Failed to update completion');
      const idx = projected.findIndex(c => c.id === latest.id);
      if (idx >= 0) projected[idx].completed_at = newIso;
    } else {
      const { error } = await state.db.from('habit_completions').insert({ habit_id: habitId, completed_at: newIso });
      if (error) throw new Error(error.message || 'Failed to add completion');
      projected.push({ id: crypto.randomUUID(), habit_id: habitId, completed_at: newIso });
    }
  } else if (latest) {
    const { error } = await state.db.from('habit_completions').delete().eq('id', latest.id);
    if (error) throw new Error(error.message || 'Failed to delete completion');
    const idx = projected.findIndex(c => c.id === latest.id);
    if (idx >= 0) projected.splice(idx, 1);
  }

  return latestHabitCompletion(projected)?.completed_at || null;
}

function habitDueStatus(habit) {
  if (!habit.next_due) return 'no-date';
  const now = new Date();
  const due = new Date(habit.next_due);
  // Compare calendar dates, not timestamps
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'due-today';
  if (diffDays === 1) return 'due-tomorrow';
  if (diffDays <= 7) return 'due-soon';
  return 'on-track';
}

function formatHabitDue(habit) {
  if (!habit.next_due) return `<span class="habit-due no-date">${t('habits.awaiting_schedule')}</span>`;
  const due = new Date(habit.next_due);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  const status = habitDueStatus(habit);

  const dateStr = due.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (status === 'overdue') return `<span class="habit-due overdue">${lucideIcon('alert-triangle', 14)} ${t('habits.overdue')} (${dateStr}, ${t('habits.days_ago', Math.abs(diffDays))})</span>`;
  if (status === 'due-today') return `<span class="habit-due due-today">${lucideIcon("bell",16)} ${t('habits.due_today')}</span>`;
  if (status === 'due-tomorrow') return `<span class="habit-due due-today">${lucideIcon("calendar",16)} ${t('habits.tomorrow')} (${dateStr})</span>`;
  if (status === 'due-soon') return `<span class="habit-due due-soon">${lucideIcon("calendar",16)} ${dateStr} (${t('habits.in_days', diffDays)})</span>`;
  return `<span class="habit-due on-track">${lucideIcon("circle-check",16)} ${dateStr} (${t('habits.in_days', diffDays)})</span>`;
}

function getFilteredHabitsForCategory(catId) {
  let filtered = state.allHabits.filter(c => catIdForHabit(c) === catId);

  // Apply search filter
  if (habitSearchQuery) {
    const q = habitSearchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (getHabitCatDisplayName(catIdForHabit(c)).toLowerCase().includes(q))
    );
  }

  if (habitFilter === 'overdue') filtered = filtered.filter(c => habitDueStatus(c) === 'overdue');
  else if (habitFilter === 'today') filtered = filtered.filter(c => ['overdue', 'due-today'].includes(habitDueStatus(c)));
  else if (habitFilter === 'tomorrow') filtered = filtered.filter(c => habitDueStatus(c) === 'due-tomorrow');

  const sortBy = document.getElementById('habitSortBy')?.value || 'due';
  if (sortBy === 'due') {
    filtered.sort((a, b) => {
      if (!a.next_due && !b.next_due) return 0;
      if (!a.next_due) return 1;
      if (!b.next_due) return -1;
      return new Date(a.next_due) - new Date(b.next_due);
    });
  } else if (sortBy === 'name') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy === 'last-done') {
    filtered.sort((a, b) => {
      const la = getHabitLastDone(a.id);
      const lb = getHabitLastDone(b.id);
      if (!la && !lb) return 0;
      if (!la) return 1;
      if (!lb) return -1;
      return lb - la;
    });
  }
  return filtered;
}

function setHabitFilter(filter) {
  habitFilter = filter;
  document.querySelectorAll('#habitFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderHabits();
}

function renderHabits() {
  const grid = document.getElementById('habitCategoryGrid');
  if (!grid) return;

  // If in calendar mode, render calendar instead
  if (habitViewMode === 'calendar') {
    renderHabitCalendar();
    return;
  }

  // Show page-level empty state when user has zero habits AND no custom categories
  const customCatCount = Array.from(_habitCatMap.values()).filter(c => !c.is_protected).length;
  if (state.allHabits.length === 0 && customCatCount === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('calendar-check', 48, 'var(--muted)')}</div>
      <h3>${t('habits.empty_title')}</h3>
      <p>${t('habits.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-habit-modal">${lucideIcon('plus', 16)} ${t('habits.empty_cta')}</button>
    </div>`;
    renderHabitNavButtons([]);
    return;
  }

  // Build category ID list from DB table rows (sorted by sort_order)
  const catRows = Array.from(_habitCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  const categoryIdList = catRows.map(c => c.id);

  // Dynamically include the Shared deck if any received habits exist
  const hasSharedItems = state.allHabits.some(c => c.category_id === _sharedHabitCatId || c.category === SHARED_CATEGORY);
  if (hasSharedItems && _sharedHabitCatId) categoryIdList.unshift(_sharedHabitCatId);

  let html = '';
  for (const catId of categoryIdList) {
    // Skip empty categories when searching
    if (habitSearchQuery) {
      const matchingItems = getFilteredHabitsForCategory(catId);
      const catName = getHabitCatDisplayName(catId);
      if (matchingItems.length === 0 && !catName.toLowerCase().includes(habitSearchQuery.toLowerCase())) continue;
    }
    html += renderHabitCategoryCard(catId);
  }
  const scrollY = window.scrollY;
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);
  initHabitHoverDelay(grid);
  renderHabitNavButtons(categoryIdList);
  balanceGrid(grid);
}

function initHabitHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.habit-item',
    actionsSelector: '.habit-actions',
    rowSelector: '.habit-row',
    textSelector: '.habit-name',
    onDblClick: (item) => {
      const id = item.dataset.habitId;
      if (id) editHabitInline(id, item);
    },
  });
}

function renderHabitNavButtons(categoryIdList) {
  const container = document.getElementById('habitNavButtons');
  if (!container) return;
  container.innerHTML = categoryIdList.map(catId => {
    const cat = _habitCatMap.get(catId);
    const color = cat?.color || GENERAL_CATEGORY_COLOR;
    const shortname = cat?.shortname || '';
    const isShared = cat?.name === SHARED_CATEGORY;
    const displayName = isShared ? t('sharing.shared') : (shortname || cat?.name || t('common.category_default'));
    const count = state.allHabits.filter(c => catIdForHabit(c) === catId).length;
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-habit-category" data-category="${esc(catId)}" title="${esc(isShared ? t('sharing.shared') : (cat?.name || t('common.category_default')))}">${esc(displayName)} (${count})</button>`;
  }).join('');
}

function navigateToHabitCategory(catId) {
  const card = document.querySelector(`.project-card[data-category="${CSS.escape(catId)}"]`);
  if (!card) return;
  const color = getHabitCatColor(catId);
  scrollToAndHighlight(card, color);
}

function renderHabitCategoryCard(catId) {
  const cat = _habitCatMap.get(catId);
  const isSharedDeck = cat?.name === SHARED_CATEGORY;
  const catName = isSharedDeck ? t('sharing.shared') : (cat?.name || t('common.category_default'));
  const isGeneral = !isSharedDeck && cat?.is_protected;
  const habitsInCat = getFilteredHabitsForCategory(catId);
  const totalInCat = state.allHabits.filter(c => catIdForHabit(c) === catId).length;
  const overdueCount = state.allHabits.filter(c => catIdForHabit(c) === catId && habitDueStatus(c) === 'overdue').length;

  const catColor = cat?.color || GENERAL_CATEGORY_COLOR;
  const statsText = `${totalInCat} habit${totalInCat !== 1 ? 's' : ''}` + (overdueCount > 0 ? ` · <span style="color:var(--red)">${overdueCount} ${t('habits.overdue').toLowerCase()}</span>` : '');

  const shareableHabits = state.allHabits.filter(h => catIdForHabit(h) === catId && !h.shared_id);
  const shareAllBtn = (!isSharedDeck && state.sharing?.getAllGroups().length && shareableHabits.length > 0)
    ? `<button class="todo-cat-shortname-btn" data-action="bulk-share-habit-category" data-category="${esc(catId)}" title="${esc(t('sharing.share_all'))}">${lucideIcon("share",14)}</button>`
    : '';

  const deleteBtn = (!isGeneral && !isSharedDeck)
    ? `<button class="todo-cat-delete-btn" data-action="delete-habit-category" data-category="${esc(catId)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>`
    : '';

  const items = habitsInCat.length === 0
    ? '<p class="empty-msg">No habits here</p>'
    : habitsInCat.map(c => renderHabitItem(c)).join('');

  const headerIcon = isSharedDeck ? `${lucideIcon('users', 16)} ` : '';

  const editBtn = (!isSharedDeck && !isGeneral)
    ? `<button class="todo-cat-shortname-btn" data-action="open-edit-habit-category-modal" data-category="${esc(catId)}" title="${t('common.edit')}">${lucideIcon("pencil",14)}</button>`
    : '';

  const addRow = isSharedDeck ? '' : `<div class="todo-cat-add">
      <input type="text" placeholder="${t('habits.quick_add_placeholder')}" maxlength="200" class="todo-cat-input habit-add-input" data-category="${esc(catId)}" data-action="add-habit-from-input">
      <button data-action="add-habit-from-input">${lucideIcon('plus', 16)}</button>
      ${state.sharing?.getAllGroups().length ? `<button class="sharing-share-btn" data-action="share-habit-from-add" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
    </div>`;

  return `<div class="project-card" data-category="${esc(catId)}" style="--cat-color:${catColor}">
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${headerIcon}${esc(catName)}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        ${shareAllBtn}
        ${editBtn}
        ${deleteBtn}
      </div>
    </div>
    ${addRow}
    <div class="task-list habit-list todo-cat-list">
      ${items}
    </div>
  </div>`;
}

function renderHabitItem(habit) {
  const lastDone = getHabitLastDone(habit.id);
  const completionCount = getHabitCompletionCount(habit.id);
  const isDraft = habit.is_draft;
  const status = isDraft ? 'draft' : habitDueStatus(habit);
  const dueHtml = isDraft ? `<span class="habit-due draft">${lucideIcon("file-text",16)} ${t('habits.draft')}</span>` : formatHabitDue(habit);

  const lastDoneStr = lastDone
    ? `${t('habits.last_done')}: ${lastDone.toLocaleDateString([], { month: 'short', day: 'numeric' })} (${formatHabitRelative(lastDone)})`
    : t('habits.never_done');

  const promoteBtn = isDraft ? `<button data-action="promote-habit" data-id="${esc(habit.id)}" title="${t('habits.promote')}" class="habit-promote-btn">▶ ${t('habits.promote')}</button>` : '';

  // Shared habit badge
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
        ${promoteBtn}
        ${!isDraft ? `<button data-habit-id="${esc(habit.id)}" data-action="mark-habit-done" data-id="${esc(habit.id)}" title="${t('habits.mark_done')}" class="habit-done-btn">${lucideIcon("circle-check",16)}</button>` : ''}
        <button data-action="open-habit-history" data-id="${esc(habit.id)}" title="${t('habits.habit_history')} (${completionCount})" class="habit-history-btn">${lucideIcon("clipboard-list",16)} ${completionCount}</button>
        ${!isShared && !isDraft && state.sharing?.getAllGroups().length ? `<button data-action="share-existing-habit" data-id="${esc(habit.id)}" title="${t('sharing.share')}">${lucideIcon("share",16)}</button>` : ''}
        ${isShared && !isDraft && _myCreatedSharedHabitIds.has(habit.shared_id) ? `<button data-action="unshare-habit" data-id="${esc(habit.id)}" title="${t('sharing.unshare')}">${lucideIcon("share-off",16)}</button>` : ''}
        ${isShared && !isDraft && !_myCreatedSharedHabitIds.has(habit.shared_id) ? `<button data-action="copy-habit-to-personal" data-id="${esc(habit.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon("copy",16)}</button>` : ''}
        <button data-action="copy-item-link" data-link-type="habit" data-id="${esc(habit.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",16)}</button>
        <button data-action="open-edit-habit-modal" data-id="${esc(habit.id)}" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button data-action="delete-habit" data-id="${esc(habit.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    <div class="habit-meta">
      ${dueHtml}
      ${!isDraft ? `<span class="habit-last-done habit-last-done-editable" data-action="edit-habit-last-done" data-id="${esc(habit.id)}" title="${t('habits.click_to_edit_last_done')}">${lastDoneStr}</span>` : ''}
    </div>
  </div>`;
}

function formatHabitRelative(d) {
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return t('habits.today');
  if (diffDays === 1) return t('habits.yesterday');
  if (diffDays < 7) return t('habits.days_ago', diffDays);
  if (diffDays < 30) return t('habits.weeks_ago', Math.floor(diffDays / 7));
  return t('habits.months_ago', Math.floor(diffDays / 30));
}

// ===================================================================
// HABIT CRUD
// ===================================================================
function initHabitModals() {
  const app = document.getElementById('app');

  // Add Habit Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'addHabitModal';
  m1.innerHTML = `<div class="modal"><h2>` + lucideIcon("repeat",20) + ` ${t('habits.add_habit')}</h2><label>${t('common.name')}</label><input type="text" id="newHabitName" placeholder="${t('habits.habit_placeholder')}" maxlength="200" data-action="save-new-habit-on-enter"><label>${t('habits.frequency_rule_label')}</label><div id="newHabitFreqPicker"></div><label>${t('common.category')}</label><select id="newHabitCategory"></select><div id="newHabitGroupRow" style="display:none"><label>${t('sharing.group')}</label><select id="newHabitGroup"><option value="">${t('sharing.no_group')}</option></select></div><label>${t('habits.last_done_optional')}</label><input type="date" id="newHabitLastDone"><label class="habit-draft-toggle"><input type="checkbox" id="newHabitDraft"><span>${t("habits.save_as_draft")} (${t("habits.draft_no_due")})</span></label><div class="modal-actions"><button class="modal-cancel" data-action="close-add-habit-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-habit">${t("common.create")}</button></div></div>`;
  app.appendChild(m1);

  // Edit Habit Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'editHabitModal';
  m2.innerHTML = `<div class="modal"><h2 id="editHabitTitle">` + lucideIcon("pencil",20) + ` ${t('habits.edit_habit')}</h2><input type="hidden" id="editHabitId"><label id="editHabitNameLabel">${t('common.name')}</label><input type="text" id="editHabitName" maxlength="200"><label id="editHabitFreqLabel">${t('habits.frequency_rule')}</label><div id="editHabitFreqPicker"></div><label id="editHabitCategoryLabel">${t('common.category')}</label><select id="editHabitCategory"></select><label id="editHabitLastDoneLabel">${t('habits.last_done_optional')}</label><input type="date" id="editHabitLastDone"><div class="modal-actions"><button class="modal-cancel" data-action="close-edit-habit-modal" id="editHabitCancelBtn">${t('common.cancel')}</button><button class="modal-save" data-action="save-edit-habit" id="editHabitSaveBtn">${t('common.save')}</button></div></div>`;
  app.appendChild(m2);

  // Habit History Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay'; m3.id = 'habitHistoryModal';
  m3.innerHTML = `<div class="modal habit-history-modal"><h2>` + lucideIcon("clipboard-list",20) + ` ${t('habits.habit_history')}</h2><p id="habitHistoryName" style="font-size:0.88rem;color:var(--muted);margin-bottom:12px;"></p><div id="habitHistoryList"></div><div class="modal-actions"><button class="modal-cancel" data-action="close-habit-history-modal">${t('common.close')}</button></div></div>`;
  app.appendChild(m3);

  // Add Habit Category Modal
  const m5 = document.createElement('div');
  m5.className = 'modal-overlay'; m5.id = 'addHabitCategoryModal';
  m5.innerHTML = `<div class="modal"><h2>` + lucideIcon("folder-plus",20) + ` ${t('habits.add_category')}</h2><label>${t('habits.category_name')}</label><input type="text" id="newHabitCategoryName" placeholder="${t('habits.category_placeholder')}" maxlength="40" data-action="save-new-habit-category-on-enter"><div class="modal-actions"><button class="modal-cancel" data-action="close-add-habit-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-habit-category">${t("common.create")}</button></div></div>`;
  app.appendChild(m5);

  // Edit Habit Category Modal
  const m6 = document.createElement('div');
  m6.className = 'modal-overlay'; m6.id = 'editHabitCategoryModal';
  m6.dataset.action = 'close-edit-habit-category-modal';
  m6.dataset.overlayClose = 'true';
  m6.innerHTML = `<div class="modal"><h2>` + lucideIcon("pencil",20) + ` ${t('habits.edit_category')}</h2><input type="hidden" id="editHabitCatOldName"><label>${t('habits.category_name')}</label><input type="text" id="editHabitCatName" maxlength="40" data-action="save-edit-habit-category-on-enter"><label>Shortname</label><input type="text" id="editHabitCatShortname" maxlength="20" placeholder="e.g. STR" data-action="save-edit-habit-category-on-enter"><label>${t('lists.color')}</label><input type="color" id="editHabitCatColor"><div class="modal-actions"><button class="modal-cancel" data-action="close-edit-habit-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-edit-habit-category">${t('common.save')}</button></div></div>`;
  app.appendChild(m6);
}

function openAddHabitModal(preselectedGroupId) {
  document.getElementById('newHabitName').value = '';
  document.getElementById('newHabitLastDone').value = '';
  document.getElementById('newHabitDraft').checked = false;
  buildFrequencyPicker(document.getElementById('newHabitFreqPicker'), '');
  populateHabitCategorySelect('newHabitCategory');
  // Show group selector if user belongs to any sharing groups
  const groupRow = document.getElementById('newHabitGroupRow');
  const groupSel = document.getElementById('newHabitGroup');
  if (state.sharing) {
    const groups = state.sharing.getAllGroups();
    if (groups.length > 0) {
      groupSel.innerHTML = `<option value="">${t('sharing.no_group')}</option>` +
        groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
      groupRow.style.display = '';
      if (preselectedGroupId) groupSel.value = preselectedGroupId;
    } else {
      groupRow.style.display = 'none';
    }
  } else {
    groupRow.style.display = 'none';
  }
  const modal = document.getElementById('addHabitModal');
  modal.style.setProperty('--cat-color', getHabitCatColor(_defaultHabitCatId));
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('newHabitName').focus(), 100);
}

function closeAddHabitModal() {
  document.getElementById('addHabitModal').classList.remove('visible');
}

function shareHabitFromAdd(btn) {
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  openSharePopover(btn, (groupId) => {
    openAddHabitModal(groupId);
  }, { showAssignees: false });
}

function populateHabitCategorySelect(selectId) {
  const sel = document.getElementById(selectId);
  const catRows = Array.from(_habitCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  // Include Shared in dropdown if any habit uses it (so user can move habits in/out)
  const hasShared = state.allHabits.some(h => h.category === SHARED_CATEGORY || h.category_id === _sharedHabitCatId);
  sel.innerHTML = catRows.map(c => {
    const label = c.is_protected ? t('common.category_default') : c.name;
    return `<option value="${esc(c.id)}">${esc(label)}</option>`;
  }).join('') + (hasShared && _sharedHabitCatId ? `<option value="${esc(_sharedHabitCatId)}">${esc(t('sharing.shared'))}</option>` : '');
}

async function addHabitFromInput(inputEl) {
  if (!inputEl || typeof inputEl.value !== 'string') return;
  const name = inputEl.value.trim();
  if (!name) return;
  const catId = inputEl.dataset.category || _defaultHabitCatId;

  // Quick-add: opens the full modal pre-filled with name + category
  document.getElementById('newHabitName').value = name;
  document.getElementById('newHabitLastDone').value = '';
  document.getElementById('newHabitDraft').checked = false;
  buildFrequencyPicker(document.getElementById('newHabitFreqPicker'), '');
  populateHabitCategorySelect('newHabitCategory');
  document.getElementById('newHabitCategory').value = catId;
  // Show group selector if user belongs to any sharing groups
  const groupRow = document.getElementById('newHabitGroupRow');
  const groupSel = document.getElementById('newHabitGroup');
  if (state.sharing) {
    const groups = state.sharing.getAllGroups();
    if (groups.length > 0) {
      groupSel.innerHTML = `<option value="">${t('sharing.no_group')}</option>` +
        groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
      groupRow.style.display = '';
    } else {
      groupRow.style.display = 'none';
    }
  } else {
    groupRow.style.display = 'none';
  }
  const addModal = document.getElementById('addHabitModal');
  const addCatColor = getHabitCatColor(catId);
  addModal.style.setProperty('--cat-color', addCatColor);
  addModal.classList.add('visible');
  inputEl.value = '';
  setTimeout(() => document.getElementById('newHabitFreqPicker').querySelector('select')?.focus(), 100);
}

async function saveNewHabit() {
  const name = document.getElementById('newHabitName').value.trim();
  const freq = getFrequencyFromPicker(document.getElementById('newHabitFreqPicker'));
  const catId = document.getElementById('newHabitCategory').value || _defaultHabitCatId;
  const catRow = _habitCatMap.get(catId);
  const catName = catRow?.name ?? '';
  const lastDoneVal = document.getElementById('newHabitLastDone').value;
  const isDraft = document.getElementById('newHabitDraft').checked;
  const groupId = document.getElementById('newHabitGroup')?.value || '';

  if (!name) { showToast(t('habits.enter_habit_name'), 'error'); return; }
  if (!freq) { showToast(t('habits.enter_frequency'), 'error'); return; }

  if (groupId && state.sharing) {
    // ─── Shared habit: local pointer + canonical shared data ───
    const sharedId = crypto.randomUUID();
    // Insert local pointer FIRST to prevent syncSharedHabits race
    // (addSharedHabit emits sharing-changed before we return here)
    const { data: pointerData, error: pointerErr } = await state.db.from('habits').insert({
      name: '', frequency_rule: '', category: catName, category_id: catId, is_draft: 0,
      shared_id: sharedId, shared_group_id: groupId,
    }).select().single();
    if (pointerErr) {
      console.warn('Failed to create local pointer:', pointerErr);
      showToast(t('toast.failed_to_add') + ': ' + pointerErr.message, 'error');
      return;
    }
    try {
      const actor = await getSharedHabitCompletionActor(groupId);
      const sharedItem = {
        id: sharedId,
        item_type: 'habit',
        name,
        frequency_rule: freq,
        creator_category: catName,
        created_by: actor,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completions: [],
      };
      if (lastDoneVal) {
        sharedItem.completions.push({
          id: crypto.randomUUID(),
          completed_at: habitDateInputToIso(lastDoneVal),
          completed_by: actor,
        });
      }
      await state.sharing.addSharedHabit(groupId, sharedItem);
    } catch (e) {
      console.warn('Failed to write shared habit:', e);
      // Clean up the local pointer since the shared write failed
      if (pointerData?.id) await state.db.from('habits').delete().eq('id', pointerData.id);
      showToast(t('toast.failed_to_add') + ' (shared)', 'error');
      return;
    }
    // Compute next_due on the pointer immediately
    if (pointerData?.id) {
      await updateHabitNextDue(pointerData.id, freq, lastDoneVal || null);
    }
  } else {
    // ─── Normal (non-shared) habit ───
    const { data, error } = await state.db.from('habits').insert({
      name, frequency_rule: freq, category: catName, category_id: catId, is_draft: isDraft,
    }).select().single();
    if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

    if (lastDoneVal && data?.id) {
      await state.db.from('habit_completions').insert({ habit_id: data.id, completed_at: new Date(lastDoneVal).toISOString() });
    }
    if (data?.id) {
      await updateHabitNextDue(data.id, freq, lastDoneVal || null);
    }
  }

  closeAddHabitModal();
  showToast(t('habits.habit_added', name), 'success');
  await refreshHabits();
}

function editHabitInline(habitId, itemEl) {
  const habit = state.allHabits.find(c => c.id === habitId);
  if (!habit) return;
  const nameEl = itemEl
    ? itemEl.querySelector('.habit-name')
    : document.querySelector(`.habit-item[data-habit-id="${habitId}"] .habit-name`);
  if (!nameEl) return;

  // Hide actions while editing
  const actionsEl = nameEl.closest('.habit-item')?.querySelector('.habit-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  // Build extra fields
  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  // Frequency picker row
  const freqRow = document.createElement('div');
  freqRow.className = 'inline-edit-row inline-edit-row-freq';
  const freqLabel = document.createElement('label');
  freqLabel.className = 'inline-edit-label';
  freqLabel.textContent = t('habits.frequency_rule');
  const freqContainer = document.createElement('div');
  freqContainer.className = 'freq-picker-inline';
  buildFrequencyPicker(freqContainer, habit.frequency_rule || '');
  freqRow.appendChild(freqLabel);
  freqRow.appendChild(freqContainer);

  // Category row
  const catRow = document.createElement('div');
  catRow.className = 'inline-edit-row';
  const catLabel = document.createElement('label');
  catLabel.className = 'inline-edit-label';
  catLabel.textContent = t('common.category');
  const catSelect = document.createElement('select');
  catSelect.className = 'inline-edit-input';
  const catRows = Array.from(_habitCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  catRows.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.is_protected ? t('common.category_default') : c.name;
    if (c.id === catIdForHabit(habit)) opt.selected = true;
    catSelect.appendChild(opt);
  });
  catRow.appendChild(catLabel);
  catRow.appendChild(catSelect);

  extras.appendChild(freqRow);
  extras.appendChild(catRow);

  inlineEditText(nameEl, habit.name, {
    maxLength: 200,
    extraEl: extras,
    collectExtra: () => ({
      frequency_rule: getFrequencyFromPicker(freqContainer),
      category_id: catSelect.value || _defaultHabitCatId,
    }),
    saveFn: async (newName, extra) => {
      const updates = {};
      if (newName !== habit.name) updates.name = newName;
      if (extra) {
        if (extra.frequency_rule && extra.frequency_rule !== habit.frequency_rule) updates.frequency_rule = extra.frequency_rule;
        const currentCatId = catIdForHabit(habit);
        if (extra.category_id !== currentCatId) {
          const newCatRow = _habitCatMap.get(extra.category_id);
          updates.category_id = extra.category_id;
          updates.category = newCatRow?.name ?? '';
        }
      }
      if (Object.keys(updates).length > 0) {
        if (habit.shared_id && habit.shared_group_id && state.sharing) {
          if (updates.category_id !== undefined) {
            const { error } = await state.db.from('habits').update({ category: updates.category, category_id: updates.category_id }).eq('id', habitId);
            if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
          }
          const sharedUpdates = {};
          if (updates.name !== undefined) sharedUpdates.name = updates.name;
          if (updates.frequency_rule !== undefined) sharedUpdates.frequency_rule = updates.frequency_rule;
          try {
            if (Object.keys(sharedUpdates).length > 0) {
              await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, sharedUpdates);
            }
          } catch (e) {
            console.warn('Failed to update shared habit:', e);
            showToast(t('toast.update_failed'), 'error');
            return;
          }
        } else {
          const { error } = await state.db.from('habits').update(updates).eq('id', habitId);
          if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        }
        if (updates.frequency_rule) {
          const lastDone = getHabitLastDone(habitId);
          await updateHabitNextDue(habitId, updates.frequency_rule, lastDone);
        }
        showToast(t('habits.habit_updated'), 'success');
      }
    },
    refreshFn: refreshHabits,
  });
}

function openEditHabitModal(habitId) {
  const habit = state.allHabits.find(c => c.id === habitId);
  if (!habit) return;
  // Refresh i18n labels on the modal
  const titleEl = document.getElementById('editHabitTitle');
  if (titleEl) titleEl.innerHTML = lucideIcon("pencil",20) + ` ${t('habits.edit_habit')}`;
  const nameLabel = document.getElementById('editHabitNameLabel');
  if (nameLabel) nameLabel.textContent = t('common.name');
  const freqLabel = document.getElementById('editHabitFreqLabel');
  if (freqLabel) freqLabel.textContent = t('habits.frequency_rule');
  const catLabel = document.getElementById('editHabitCategoryLabel');
  if (catLabel) catLabel.textContent = t('common.category');
  const lastDoneLabel = document.getElementById('editHabitLastDoneLabel');
  if (lastDoneLabel) lastDoneLabel.textContent = t('habits.last_done_optional');
  const cancelBtn = document.getElementById('editHabitCancelBtn');
  if (cancelBtn) cancelBtn.textContent = t('common.cancel');
  const saveBtn = document.getElementById('editHabitSaveBtn');
  if (saveBtn) saveBtn.textContent = t('common.save');

  document.getElementById('editHabitId').value = habitId;
  document.getElementById('editHabitName').value = habit.name;
  buildFrequencyPicker(document.getElementById('editHabitFreqPicker'), habit.frequency_rule);
  populateHabitCategorySelect('editHabitCategory');
  document.getElementById('editHabitCategory').value = catIdForHabit(habit);
  // Populate last done date
  const lastDone = getHabitLastDone(habitId);
  const lastDoneInput = document.getElementById('editHabitLastDone');
  if (lastDoneInput) {
    lastDoneInput.value = lastDone ? localDateStr(lastDone) : '';
    lastDoneInput.max = localDateStr(new Date());
  }
  const modal = document.getElementById('editHabitModal');
  const catColor = getHabitCatColor(catIdForHabit(habit));
  modal.style.setProperty('--cat-color', catColor);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('editHabitName').focus(), 100);
}

function closeEditHabitModal() {
  document.getElementById('editHabitModal').classList.remove('visible');
}

async function saveEditHabit() {
  const id = document.getElementById('editHabitId').value;
  const name = document.getElementById('editHabitName').value.trim();
  const freq = getFrequencyFromPicker(document.getElementById('editHabitFreqPicker'));
  const catId = document.getElementById('editHabitCategory').value || _defaultHabitCatId;
  const catRow = _habitCatMap.get(catId);
  const catName = catRow?.name ?? '';
  const lastDoneVal = document.getElementById('editHabitLastDone').value;
  const habit = state.allHabits.find(c => c.id === id);

  if (!name) { showToast(t('habits.enter_habit_name'), 'error'); return; }
  if (!freq) { showToast(t('habits.enter_frequency'), 'error'); return; }

  const prevLastDone = getHabitLastDone(id);
  const prevDateStr = prevLastDone ? localDateStr(prevLastDone) : '';
  let latestForNextDue = lastDoneVal ? habitDateInputToIso(lastDoneVal) : (prevLastDone?.toISOString() || null);

  if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
    await state.db.from('habits').update({ category: catName, category_id: catId }).eq('id', id);
    try {
      await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, {
        name,
        frequency_rule: freq,
      });
      if (lastDoneVal !== prevDateStr) {
        latestForNextDue = await setSharedHabitLastDone(habit, lastDoneVal ? habitDateInputToIso(lastDoneVal) : null);
      }
    } catch (e) {
      console.warn('Failed to update shared habit:', e);
      showToast(t('toast.update_failed'), 'error');
      return;
    }
  } else {
    const { error } = await state.db.from('habits').update({ name, frequency_rule: freq, category: catName, category_id: catId }).eq('id', id);
    if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

    if (lastDoneVal !== prevDateStr) {
      try {
        latestForNextDue = await setLocalHabitLastDone(id, lastDoneVal ? habitDateInputToIso(lastDoneVal) : null);
      } catch (e) {
        console.warn('Failed to update habit completion:', e);
        showToast(t('toast.update_failed'), 'error');
        return;
      }
    }
  }

  await updateHabitNextDue(id, freq, latestForNextDue);
  closeEditHabitModal();
  showToast(t('habits.habit_updated'), 'success');
  await refreshHabits();
}

async function deleteHabit(habitId) {
  const habit = state.allHabits.find(c => c.id === habitId);
  if (!habit) return;
  showConfirmAction(
    t('common.delete'),
    `Delete "${habit.name}"? All completion history will be lost.`,
    async () => {
      // If shared, also delete from Drive (removes for all group members)
      if (habit.shared_id && habit.shared_group_id && state.sharing) {
        try {
          await state.sharing.deleteSharedHabit(habit.shared_group_id, habit.shared_id);
        } catch (e) {
          console.warn('Failed to delete shared habit from Drive:', e);
        }
      }
      const { error } = await state.db.from('habits').delete().eq('id', habitId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('habits.habit_deleted'), 'info');
      await refreshHabits();
    }
  );
}

async function promoteHabit(habitId) {
  const { error } = await state.db.from('habits').update({ is_draft: false }).eq('id', habitId);
  if (error) { showToast(t('habits.failed_promote'), 'error'); return; }
  showToast(t('habits.habit_activated'), 'success');
  await refreshHabits();
}


// ===================================================================
// HABIT DONE FLOW — per-id guard: disable button until fulfilled (core principle)
// ===================================================================
const _pendingHabitDones = new Set();

async function markHabitDone(habitId, btnEl) {
  if (!habitId) return;
  if (_pendingHabitDones.has(habitId)) return;
  _pendingHabitDones.add(habitId);

  // Disable all matching buttons (safety across views)
  const sel = `button.habit-done-btn[data-habit-id="${CSS && CSS.escape ? CSS.escape(habitId) : habitId.replace(/"/g, '\\"')}"]`;
  const allBtns = document.querySelectorAll(sel);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : (allBtns[0] || null);
  const toToggle = new Set([...allBtns, ...(targetBtn ? [targetBtn] : [])]);
  toToggle.forEach(b => { b.disabled = true; b.classList.add('saving', 'is-pending'); b.setAttribute('aria-busy', 'true'); });

  try {
    const habit = state.allHabits.find(c => c.id === habitId);
    const now = new Date().toISOString();

    if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
      try {
        const completion = {
          id: crypto.randomUUID(),
          completed_at: now,
          completed_by: await getSharedHabitCompletionActor(habit.shared_group_id),
        };
        await state.sharing.addSharedHabitCompletion(habit.shared_group_id, habit.shared_id, completion);
        await updateHabitNextDue(habitId, habit.frequency_rule, now);
      } catch (e) {
        console.warn('Failed to push shared habit completion:', e);
        showToast(t('habits.failed_record'), 'error');
        return;
      }
    } else {
      const { error } = await state.db.from('habit_completions').insert({ habit_id: habitId, completed_at: now });
      if (error) { showToast(t('habits.failed_record'), 'error'); return; }

      if (habit) {
        await updateHabitNextDue(habitId, habit.frequency_rule, now);
      } else {
        await clearHabitNextDue(habitId);
      }
    }

    showToast(t('habits.habit_done'), 'success');
    await refreshHabits();
  } finally {
    _pendingHabitDones.delete(habitId);
    // Re-enable in case refresh didn't recreate buttons (e.g. on error)
    toToggle.forEach(b => { b.disabled = false; b.classList.remove('saving', 'is-pending'); b.removeAttribute('aria-busy'); });
  }
}


// ===================================================================
// EDIT LAST DONE DATE — INLINE
// ===================================================================
function editHabitLastDone(habitId, event, triggerEl) {
  event.stopPropagation();
  const span = triggerEl || (event.currentTarget instanceof HTMLElement && event.currentTarget !== document ? event.currentTarget : event.target?.closest('[data-action="edit-habit-last-done"]')) || event.target;
  const lastDone = getHabitLastDone(habitId);
  const currentDateStr = lastDone ? localDateStr(lastDone) : '';

  // Replace span with a date input
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'habit-last-done-input';
  input.value = currentDateStr;
  // Max = today
  input.max = localDateStr(new Date());

  span.replaceWith(input);
  input.focus();

  let didSave = false;
  async function save() {
    if (didSave) return;
    didSave = true;
    const newVal = input.value;
    const newIso = newVal ? habitDateInputToIso(newVal) : null;
    const habit = state.allHabits.find(c => c.id === habitId);

    try {
      let latestForNextDue = newIso;
      if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
        latestForNextDue = await setSharedHabitLastDone(habit, newIso);
      } else {
        latestForNextDue = await setLocalHabitLastDone(habitId, newIso);
      }

      if (habit) {
        await updateHabitNextDue(habitId, habit.frequency_rule, latestForNextDue);
      }

      showToast(t('habits.last_done_updated'), 'success');
    } catch (e) {
      console.warn('Failed to update habit completion:', e);
      showToast(t('toast.failed_to_update'), 'error');
    }
    await refreshHabits();
  }

  input.addEventListener('change', save);
  input.addEventListener('blur', () => {
    // Small delay to avoid race with change event
    setTimeout(() => { if (!didSave && document.contains(input)) refreshHabits(); }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { didSave = true; refreshHabits(); }
    if (e.key === 'Enter') { save(); }
  });
}

// ===================================================================
// HABIT HISTORY
// ===================================================================
function openHabitHistory(habitId) {
  const habit = state.allHabits.find(c => c.id === habitId);
  if (!habit) return;
  state._historyHabitId = habitId;
  renderHabitHistoryList(habitId, habit);
  const histModal = document.getElementById('habitHistoryModal');
  histModal.style.setProperty('--cat-color', getHabitCatColor(catIdForHabit(habit)));
  histModal.classList.add('visible');
}

function renderHabitHistoryList(habitId, habit) {
  if (!habit) habit = state.allHabits.find(c => c.id === habitId);
  if (!habit) return;
  const completions = getHabitCompletions(habitId);
  document.getElementById('habitHistoryName').innerHTML = `${lucideIcon("repeat",16)} ${esc(habit.name)} — ${esc(formatFrequency(habit.frequency_rule))}`;

  if (completions.length === 0) {
    document.getElementById('habitHistoryList').innerHTML = '<p class="empty-msg">No completions recorded yet</p>';
  } else {
    const items = completions.map(comp => {
      const d = new Date(comp.completed_at);
      const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const noteStr = comp.note ? ` — <em>${esc(comp.note)}</em>` : '';
      return `<div class="habit-history-item" data-comp-id="${comp.id}">
        <span class="habit-history-date">${lucideIcon("circle-check",16)} ${dateStr}</span>
        ${noteStr}
        <span class="habit-history-actions">
          <button data-action="edit-habit-completion" data-id="${esc(comp.id)}" title="${t('common.edit')}" class="habit-hist-btn">${lucideIcon("pencil",14,"#f59e0b")}</button>
          <button data-action="delete-habit-completion" data-id="${esc(comp.id)}" title="${t('common.delete')}" class="habit-hist-btn">${lucideIcon("trash-2",14,"#ef4444")}</button>
        </span>
      </div>`;
    }).join('');
    document.getElementById('habitHistoryList').innerHTML = items;
  }
}

async function deleteHabitCompletion(compId) {
  const comp = state.allHabitCompletions.find(c => c.id === compId);
  if (!comp) return;
  const habit = state.allHabits.find(h => h.id === comp.habit_id);
  const dateStr = new Date(comp.completed_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  showConfirmAction(
    t('common.delete'),
    'Are you sure you want to delete this completion record?',
    async () => {
      if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
        // ─── Shared: remove from shared completions ───
        try {
          const sharedHabits = state.sharing.getAllSharedHabits();
          const sh = sharedHabits.find(h => h.id === habit.shared_id);
          if (sh?.completions) {
            const idx = sh.completions.findIndex(c => c.id === comp.id || c.completed_at === comp.completed_at);
            if (idx >= 0) sh.completions.splice(idx, 1);
            await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, { completions: sh.completions });
            // Recompute next_due from new latest completion (or null if none left)
            const latest = sh.completions.length ? sh.completions[sh.completions.length - 1].completed_at : null;
            await updateHabitNextDue(habit.id, habit.frequency_rule, latest);
          }
        } catch (e) { showToast(t('toast.failed_to_delete'), 'error'); return; }
      } else {
        // ─── Normal: delete from local DB ───
        const { error } = await state.db.from('habit_completions').delete().eq('id', compId);
        if (error) { showToast(t('toast.failed_to_delete'), 'error'); return; }
      }

      showToast(t('habits.completion_deleted'), 'success');
      await refreshHabits();
      if (state._historyHabitId) {
        await clearHabitNextDue(state._historyHabitId);
        renderHabitHistoryList(state._historyHabitId);
      }
    },
    dateStr + (comp.note ? ` — ${comp.note}` : '')
  );
}

async function editHabitCompletion(compId) {
  const comp = state.allHabitCompletions.find(c => c.id === compId);
  if (!comp) return;
  const d = new Date(comp.completed_at);
  const dateVal = localDateStr(d);
  const noteVal = comp.note || '';

  const item = document.querySelector(`.habit-history-item[data-comp-id="${compId}"]`);
  if (!item) return;
  item.innerHTML = `
    <div class="habit-history-edit">
      <label>${t('habits.edit_date')}</label>
      <input type="date" id="editCompDate_${compId}" value="${dateVal}">
      <label>${t('habits.edit_note')}</label>
      <input type="text" id="editCompNote_${compId}" value="${esc(noteVal)}" placeholder="${t('habits.note_optional')}" maxlength="500">
      <div class="habit-history-edit-actions">
        <button data-action="save-habit-completion" data-id="${esc(compId)}" class="modal-save">${t('common.save')}</button>
        <button data-action="cancel-edit-completion" class="modal-cancel">${t('common.cancel')}</button>
      </div>
    </div>`;
}

async function saveHabitCompletion(compId) {
  const dateEl = document.getElementById(`editCompDate_${compId}`);
  const noteEl = document.getElementById(`editCompNote_${compId}`);
  if (!dateEl) return;
  const comp = state.allHabitCompletions.find(c => c.id === compId);
  if (!comp) return;
  const habit = state.allHabits.find(h => h.id === comp.habit_id);
  const oldCompletedAt = comp.completed_at;
  const newDate = new Date(dateEl.value + 'T12:00:00Z').toISOString();
  const newNote = noteEl ? noteEl.value.trim() : null;

  if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
    // ─── Shared: update in shared completions ───
    try {
      const sharedHabits = state.sharing.getAllSharedHabits();
      const sh = sharedHabits.find(h => h.id === habit.shared_id);
      if (sh?.completions) {
        const sharedComp = sh.completions.find(c => c.id === comp.id || c.completed_at === oldCompletedAt);
        if (sharedComp) {
          sharedComp.completed_at = newDate;
          await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, { completions: sh.completions });
          // Recompute next_due from latest completion
          const latest = sh.completions[sh.completions.length - 1]?.completed_at || null;
          await updateHabitNextDue(habit.id, habit.frequency_rule, latest);
        }
      }
    } catch (e) { showToast(t('toast.failed_to_update'), 'error'); return; }
  } else {
    // ─── Normal: update in local DB ───
    const updates = { completed_at: newDate };
    if (newNote !== null) updates.note = newNote || null;
    const { error } = await state.db.from('habit_completions').update(updates).eq('id', compId);
    if (error) { showToast(t('toast.failed_to_update'), 'error'); return; }
  }

  showToast(t('habits.completion_updated'), 'success');
  await refreshHabits();
  if (state._historyHabitId) {
    await clearHabitNextDue(state._historyHabitId);
    renderHabitHistoryList(state._historyHabitId);
  }
}

function cancelEditCompletion() {
  if (state._historyHabitId) renderHabitHistoryList(state._historyHabitId);
}

function closeHabitHistoryModal() {
  document.getElementById('habitHistoryModal').classList.remove('visible');
}

// ===================================================================
// HABIT CATEGORY MANAGEMENT
// ===================================================================
function openAddHabitCategoryModal() {
  document.getElementById('newHabitCategoryName').value = '';
  document.getElementById('addHabitCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newHabitCategoryName').focus(), 100);
}

function closeAddHabitCategoryModal() {
  document.getElementById('addHabitCategoryModal').classList.remove('visible');
}

async function saveNewHabitCategory() {
  const name = document.getElementById('newHabitCategoryName').value.trim();
  if (!name) { showToast(t('habits.enter_habit_name'), 'error'); return; }
  // Check for duplicates in DB table
  for (const cat of _habitCatMap.values()) {
    if (cat.name.toLowerCase() === name.toLowerCase()) {
      showToast(t('habits.category_exists'), 'error'); return;
    }
  }
  const usedColors = new Set(Array.from(_habitCatMap.values()).map(c => c.color).filter(Boolean));
  const color = DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c)) || DEFAULT_CATEGORY_PALETTE[_habitCatMap.size % DEFAULT_CATEGORY_PALETTE.length];
  const sortOrder = Math.max(0, ...Array.from(_habitCatMap.values()).map(c => c.sort_order || 0)) + 1;
  const { error } = await state.db.from('habit_categories').insert({ name, color, sort_order: sortOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  await loadHabitCategories();
  closeAddHabitCategoryModal();
  showToast(t('habits.category_created', name), 'success');
  renderHabits();
}

async function deleteHabitCategory(catId) {
  const cat = _habitCatMap.get(catId);
  if (!cat) return;
  const habitsInCat = state.allHabits.filter(c => catIdForHabit(c) === catId);
  const msg = habitsInCat.length > 0
    ? `Delete "${cat.name}" and its ${habitsInCat.length} habit(s)? This cannot be undone.`
    : `Delete empty category "${cat.name}"?`;

  showConfirmAction(t('common.delete'), msg, async () => {
    // Propagate deletion of shared habits to sharing layer before CASCADE removes local rows
    if (state.sharing) {
      for (const habit of habitsInCat) {
        if (habit.shared_id && habit.shared_group_id) {
          try { await state.sharing.deleteItem(habit.shared_group_id, habit.shared_id); }
          catch (e) { console.warn('Failed to delete shared habit:', e); }
        }
      }
    }
    // CASCADE on FK — deleting the category removes all its habits + completions
    const { error } = await state.db.from('habit_categories').delete().eq('id', catId);
    if (error) { showToast(t('toast.delete_failed') + ': ' + error.message, 'error'); return; }
    showToast(t('habits.category_deleted', cat.name), 'info');
    await refreshHabits();
  });
}


// ===================================================================
// HABIT CALENDAR VIEW — Month grid showing habit due dates
// ===================================================================
function setHabitViewMode(mode) {
  habitViewMode = mode;
  document.querySelectorAll('#habitViewToggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  const grid = document.getElementById('habitCategoryGrid');
  const cal = document.getElementById('habitCalendarContainer');
  if (mode === 'calendar') {
    if (grid) grid.style.display = 'none';
    if (cal) cal.style.display = '';
    if (!habitCalMonth) {
      const now = new Date();
      habitCalMonth = { year: now.getFullYear(), month: now.getMonth() };
    }
    // Auto-select today so the detail panel is visible immediately
    if (!habitCalSelectedDay) {
      const now = new Date(); now.setHours(0,0,0,0);
      habitCalSelectedDay = now.toISOString().slice(0, 10);
    }
    renderHabitCalendar();
  } else {
    if (grid) grid.style.display = '';
    if (cal) cal.style.display = 'none';
    renderHabits();
  }
}

function navigateHabitCalendar(delta) {
  if (habitCalScale === 'week') {
    if (!habitCalWeekStart) _initWeekStart();
    habitCalWeekStart.setDate(habitCalWeekStart.getDate() + delta * 7);
    renderHabitCalendar();
    return;
  }
  if (!habitCalMonth) {
    const now = new Date();
    habitCalMonth = { year: now.getFullYear(), month: now.getMonth() };
  }
  habitCalMonth.month += delta;
  if (habitCalMonth.month > 11) { habitCalMonth.month = 0; habitCalMonth.year++; }
  if (habitCalMonth.month < 0) { habitCalMonth.month = 11; habitCalMonth.year--; }
  renderHabitCalendar();
}

function navigateHabitCalendarToday() {
  const now = new Date();
  habitCalMonth = { year: now.getFullYear(), month: now.getMonth() };
  _initWeekStart();
  habitCalSelectedDay = null;
  renderHabitCalendar();
}

function toggleHabitCalScale() {
  habitCalScale = habitCalScale === 'month' ? 'week' : 'month';
  habitCalSelectedDay = null;
  if (habitCalScale === 'week' && !habitCalWeekStart) _initWeekStart();
  renderHabitCalendar();
}

function _initWeekStart() {
  const now = new Date(); now.setHours(0,0,0,0);
  habitCalWeekStart = new Date(now);
}

function _buildHabitsByDay() {
  const habitsByDay = {};
  for (const h of state.allHabits) {
    if (h.is_draft || !h.next_due) continue;
    const dueDate = new Date(h.next_due);
    const key = `${dueDate.getFullYear()}-${dueDate.getMonth()}-${dueDate.getDate()}`;
    if (!habitsByDay[key]) habitsByDay[key] = [];
    const status = habitDueStatus(h);
    habitsByDay[key].push({ name: h.name, id: h.id, status, category: getHabitCatDisplayName(catIdForHabit(h)), color: getHabitCatColor(catIdForHabit(h)) });
  }
  return habitsByDay;
}

function _getItemsForDay(d, habitsByDay, today) {
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const items = habitsByDay[key] || [];
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const isToday = dayStart.getTime() === today.getTime();
  let overdueItems = [];
  if (isToday) {
    for (const h of state.allHabits) {
      if (h.is_draft || !h.next_due) continue;
      const dueDate = new Date(h.next_due);
      const dueStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      if (dueStart < today && !items.find(i => i.id === h.id)) {
        overdueItems.push({ name: h.name, id: h.id, status: 'overdue', category: getHabitCatDisplayName(catIdForHabit(h)), color: getHabitCatColor(catIdForHabit(h)) });
      }
    }
  }
  return [...overdueItems, ...items];
}

function renderHabitCalendar() {
  const container = document.getElementById('habitCalendarContainer');
  if (!container) return;

  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const habitsByDay = _buildHabitsByDay();

  // Day headers (Mon-Sun)
  const dayNames = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 1 + i); // Jan 1 2024 is a Monday
    dayNames.push(d.toLocaleDateString(locale, { weekday: 'short' }).replace('.', ''));
  }

  if (habitCalScale === 'week') {
    _renderWeekView(container, dayNames, habitsByDay, today, locale);
  } else {
    _renderMonthView(container, dayNames, habitsByDay, today, locale);
  }
}

function _renderWeekView(container, dayNames, habitsByDay, today, locale) {
  if (!habitCalWeekStart) _initWeekStart();
  const weekStart = new Date(habitCalWeekStart);

  // Week label
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const startLabel = weekStart.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const endLabel = weekEnd.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const navLabel = `${startLabel} – ${endLabel}`;

  let html = '';
  // Navigation
  html += `<div class="habit-cal-nav">`;
  html += `<button data-action="navigate-habit-calendar" data-delta="-1" title="Previous">${lucideIcon('chevron-left', 18)}</button>`;
  html += `<span class="habit-cal-month-label">${esc(navLabel)}</span>`;
  html += `<button data-action="navigate-habit-calendar-today" title="Today" style="font-size:0.75rem;padding:4px 10px;">${esc(t('welcome.cal_today'))}</button>`;
  html += `<button data-action="navigate-habit-calendar" data-delta="1" title="Next">${lucideIcon('chevron-right', 18)}</button>`;
  html += `<button data-action="toggle-habit-cal-scale" title="Month" class="habit-cal-scale-btn">${lucideIcon('calendar', 16)}</button>`;
  html += `</div>`;

  // Week grid — vertical list on mobile, horizontal row on desktop
  html += `<div class="habit-cal-week">`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const isToday = dayStart.getTime() === today.getTime();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const allItems = _getItemsForDay(d, habitsByDay, today);
    const dayIso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    const classes = ['habit-cal-week-day', isToday ? 'today' : '', isWeekend ? 'weekend' : ''].filter(Boolean).join(' ');
    html += `<div class="${classes}" data-cal-day="${dayIso}">`;
    html += `<div class="habit-cal-week-day-header">`;
    const dayLabel = d.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '');
    html += `<span class="habit-cal-week-day-name">${esc(dayLabel)}</span>`;
    html += `<span class="habit-cal-cell-num${isToday ? ' today-num' : ''}">${d.getDate()}</span>`;
    html += `</div>`;
    html += `<div class="habit-cal-week-items">`;
    if (allItems.length === 0) {
      html += `<span class="habit-cal-week-empty">—</span>`;
    }
    for (const it of allItems) {
      const overdueFlag = it.status === 'overdue' ? ' overdue' : '';
      html += `<div class="habit-cal-item${overdueFlag}" style="--item-color:${it.color}" data-action="open-edit-habit-modal" data-id="${esc(it.id)}" title="${esc(it.name)}">${esc(it.name)}</div>`;
    }
    html += `</div>`;
    html += `</div>`;
  }
  html += `</div>`;

  container.innerHTML = html;

  // Swipe on week view
  _initCalendarSwipe(container);
}

function _renderMonthView(container, dayNames, habitsByDay, today, locale) {
  if (!habitCalMonth) {
    const now = new Date();
    habitCalMonth = { year: now.getFullYear(), month: now.getMonth() };
  }

  const year = habitCalMonth.year;
  const month = habitCalMonth.month;
  const monthLabel = new Date(year, month, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  // Build calendar grid cells
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    cells.push({ date: d, outside: true });
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    cells.push({ date: new Date(year, month, d), outside: false });
  }
  while (cells.length % 7 !== 0) {
    const idx = cells.length - startDow - lastDay.getDate();
    cells.push({ date: new Date(year, month + 1, idx + 1), outside: true });
  }

  let html = '';
  // Navigation
  html += `<div class="habit-cal-nav">`;
  html += `<button data-action="navigate-habit-calendar" data-delta="-1" title="Previous">${lucideIcon('chevron-left', 18)}</button>`;
  html += `<span class="habit-cal-month-label">${esc(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1))}</span>`;
  html += `<button data-action="navigate-habit-calendar-today" title="Today" style="font-size:0.75rem;padding:4px 10px;">${esc(t('welcome.cal_today'))}</button>`;
  html += `<button data-action="navigate-habit-calendar" data-delta="1" title="Next">${lucideIcon('chevron-right', 18)}</button>`;
  html += `<button data-action="toggle-habit-cal-scale" title="Week" class="habit-cal-scale-btn">${lucideIcon('list', 16)}</button>`;
  html += `</div>`;

  // Day headers
  html += `<div class="habit-cal-grid">`;
  for (const dn of dayNames) {
    html += `<div class="habit-cal-header-cell">${esc(dn)}</div>`;
  }

  // Day cells
  for (const cell of cells) {
    const d = cell.date;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const isToday = dayStart.getTime() === today.getTime();
    const allItems = _getItemsForDay(d, habitsByDay, today);

    const dayIso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const isSelected = habitCalSelectedDay === dayIso;
    const classes = ['habit-cal-cell', cell.outside ? 'outside' : '', isToday ? 'today' : '', isSelected ? 'selected' : '', (d.getDay() === 0 || d.getDay() === 6) ? 'weekend' : ''].filter(Boolean).join(' ');
    html += `<div class="${classes}" data-cal-day="${dayIso}">`;
    html += `<span class="habit-cal-cell-num${isToday ? ' today-num' : ''}">${d.getDate()}</span>`;

    if (allItems.length > 0) {
      html += `<div class="habit-cal-items">`;
      const maxShow = 3;
      for (let k = 0; k < Math.min(allItems.length, maxShow); k++) {
        const it = allItems[k];
        const overdueFlag = it.status === 'overdue' ? ' overdue' : '';
        html += `<div class="habit-cal-item${overdueFlag}" style="--item-color:${it.color}" data-action="open-edit-habit-modal" data-id="${esc(it.id)}" title="${esc(it.name)}">${esc(it.name)}</div>`;
      }
      if (allItems.length > maxShow) {
        html += `<div class="habit-cal-more">+${allItems.length - maxShow}</div>`;
      }
      html += `</div>`;
      // Mobile dots fallback
      html += `<div class="habit-cal-dots-only">`;
      for (const it of allItems) {
        const dotColor = it.status === 'overdue' ? '#ef4444' : it.color;
        html += `<span class="habit-cal-dot-sm" style="background:${dotColor}"></span>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;

  // Day detail panel (mobile tap-to-expand)
  html += `<div class="habit-cal-day-detail" id="habitCalDayDetail"></div>`;

  container.innerHTML = html;

  // Wire up mobile interactions
  _initCalendarMobileInteractions(container, habitsByDay, today);
}

function _initCalendarSwipe(container) {
  let touchStartX = null;
  let touchStartY = null;
  const swipeTarget = container.querySelector('.habit-cal-grid') || container.querySelector('.habit-cal-week');
  if (swipeTarget) {
    swipeTarget.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });
    swipeTarget.addEventListener('touchend', e => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        habitCalSelectedDay = null;
        if (dx < 0) navigateHabitCalendar(1);
        else navigateHabitCalendar(-1);
      }
    }, { passive: true });
  }
}

function _initCalendarMobileInteractions(container, habitsByDay, today) {
  // Tap-to-select day cells
  container.querySelectorAll('.habit-cal-cell[data-cal-day]').forEach(cell => {
    cell.addEventListener('click', () => {
      const dayIso = cell.dataset.calDay;
      if (habitCalSelectedDay === dayIso) {
        habitCalSelectedDay = null;
        cell.classList.remove('selected');
        const detail = document.getElementById('habitCalDayDetail');
        if (detail) { detail.classList.remove('visible'); detail.innerHTML = ''; }
      } else {
        habitCalSelectedDay = dayIso;
        container.querySelectorAll('.habit-cal-cell.selected').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        _renderCalDayDetail(dayIso, habitsByDay, today);
      }
    });
  });

  // Swipe
  _initCalendarSwipe(container);
}

function _renderCalDayDetail(dayIso, habitsByDay, today) {
  const detail = document.getElementById('habitCalDayDetail');
  if (!detail) return;
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-GB';
  const [y, m, d] = dayIso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayStart = new Date(y, m - 1, d); dayStart.setHours(0,0,0,0);
  const isToday = dayStart.getTime() === today.getTime();

  const dateLabel = isToday
    ? t('welcome.cal_today') + ' — ' + date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })
    : date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const items = habitsByDay[key] || [];

  // Also include overdue habits if this is today
  let overdueItems = [];
  if (isToday) {
    for (const h of state.allHabits) {
      if (h.is_draft || !h.next_due) continue;
      const dueDate = new Date(h.next_due);
      const dueStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      if (dueStart < today && !items.find(i => i.id === h.id)) {
        overdueItems.push({ name: h.name, id: h.id, status: 'overdue', category: getHabitCatDisplayName(catIdForHabit(h)), color: getHabitCatColor(catIdForHabit(h)) });
      }
    }
  }
  const allItems = [...overdueItems, ...items];

  let html = `<div class="habit-cal-day-detail-header">${lucideIcon('calendar-days', 16)} ${esc(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1))}</div>`;
  if (allItems.length === 0) {
    html += `<div class="habit-cal-detail-empty">${esc(t('habits.no_habits_due') || 'Nothing due')}</div>`;
  } else {
    html += `<div class="habit-cal-day-detail-list">`;
    for (const it of allItems) {
      const statusLabel = it.status === 'overdue' ? (t('habits.overdue') || 'Overdue') : it.status === 'due-today' ? (t('habits.due_today') || 'Due today') : '';
      html += `<div class="habit-cal-detail-item" style="--item-color:${it.color}" data-action="open-edit-habit-modal" data-id="${esc(it.id)}">`;
      html += `<span class="habit-cal-detail-dot" style="background:${it.color}"></span>`;
      html += `<span class="habit-cal-detail-name">${esc(it.name)}</span>`;
      if (statusLabel) html += `<span class="habit-cal-detail-status">${esc(statusLabel)}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  detail.innerHTML = html;
  detail.classList.add('visible');
}

// ── Shared Habits ───────────────────────────────────────────────

// ===================================================================
// SHARED HABIT SYNC — import / update / delete / completions
// ===================================================================

/**
 * Sync shared habits from Drive to local DB.
 * Called on 'sharing-changed' event (poll detected changes).
 *
 * For each group:
 * - New shared habit not in local DB → create local habit in "General"
 * - Shared habit name/frequency changed → update local habit
 * - Shared habit deleted from Drive → delete local habit + completions
 * - New completions → insert into local habit_completions
 */
/**
 * Sync shared habits: manage local pointers only.
 * - New shared habit with no local pointer → create pointer in "General"
 * - Shared habit deleted from shared storage → delete local pointer
 * - Data (name, frequency, completions) is read live from shared storage in refreshHabits()
 */
let _syncingHabits = false;
let _bulkShareInProgress = false;
async function syncSharedHabits() {
  if (_syncingHabits) return;
  _syncingHabits = true;
  try {
    await _doSyncSharedHabits();
  } finally {
    _syncingHabits = false;
  }
}
async function _doSyncSharedHabits() {
  if (!state.sharing || !state.db?.connected) return;

  const sharedHabits = state.sharing.getAllSharedHabits();
  // Read local pointers from DB so startup sync works before refreshHabits()
  // has populated state.allHabits.
  let localShared = [];
  try {
    const rows = await fetchAll(() => state.db.from('habits').select('id,shared_id,shared_group_id'));
    localShared = (rows || []).filter(h => h.shared_id);
  } catch (e) {
    console.warn('syncSharedHabits: failed to load local pointers', e);
    localShared = (state.allHabits || []).filter(h => h.shared_id);
  }
  const localBySharedId = new Map(localShared.map(h => [h.shared_id, h]));
  const driveSharedIds = new Set(sharedHabits.map(h => h.id));

  let needsRefresh = false;

  // Create or repair pointers for shared habits
  for (const sh of sharedHabits) {
    const currentPointer = localBySharedId.get(sh.id);

    // Repair old Supabase pointers created before the shared record id was canonical.
    // Prefer the legacy pointer because it preserves the creator's local deck.
    const legacySharedId = sh._payload_id && sh._payload_id !== sh.id ? sh._payload_id : null;
    const legacyPointer = legacySharedId ? localBySharedId.get(legacySharedId) : null;
    if (legacyPointer) {
      if (currentPointer && currentPointer.id !== legacyPointer.id) {
        await state.db.from('habits').delete().eq('id', currentPointer.id);
      }
      const { error } = await state.db.from('habits')
        .update({ shared_id: sh.id, shared_group_id: sh.group_id })
        .eq('id', legacyPointer.id);
      if (error) { console.warn('syncSharedHabits: failed to repair pointer', sh.id, error); continue; }
      legacyPointer.shared_id = sh.id;
      legacyPointer.shared_group_id = sh.group_id;
      localBySharedId.delete(legacySharedId);
      localBySharedId.set(sh.id, legacyPointer);
      needsRefresh = true;
      continue;
    }

    if (currentPointer) continue;

    // Double-check DB to avoid races with local pointer creation.
    const { data: existing } = await state.db.from('habits').select('id').eq('shared_id', sh.id).limit(1);
    if (existing?.length) continue;
    const { error } = await state.db.from('habits').insert({
      name: '', frequency_rule: '', category: SHARED_CATEGORY, category_id: _sharedHabitCatId, is_draft: 0,
      shared_id: sh.id, shared_group_id: sh.group_id,
    });
    if (error) { console.warn('syncSharedHabits: failed to create pointer', sh.id, error); continue; }
    needsRefresh = true;
  }

  // Clean up pointers for removed shared habits
  for (const local of localShared) {
    if (!driveSharedIds.has(local.shared_id)) {
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        // Group exists but item gone from remote → delete local pointer
        await state.db.from('habits').delete().eq('id', local.id);
        needsRefresh = true;
      } else if (state.sharing.isReady?.()) {
        // Groups loaded but this one is gone → ask user before clearing
        try { document.dispatchEvent(new CustomEvent('sharing-orphan-detected', { detail: { groupId: local.shared_group_id } })); } catch {}
      }
      // else: sharing not loaded yet — skip, will retry on next sync
    }
  }

  if (needsRefresh) {
    await refreshHabits();
  }
}

window.syncSharedHabits = syncSharedHabits;

export { refreshHabits, renderHabits, initHabitModals, formatFrequency, formatHabitDue, habitDueStatus, getHabitLastDone, formatHabitRelative, getHabitCompletionCount, updateHabitNextDue, initHabitHoverDelay, isStructuredRule, STRUCTURED_PREFIXES, syncSharedHabits, loadHabitCategories, getHabitCategories, getHabitCategoryColor, getHabitCatColor, catIdForHabit, getHabitCatDisplayName };

window.setHabitFilter = setHabitFilter;
window.openAddHabitModal = openAddHabitModal;
window.shareHabitFromAdd = shareHabitFromAdd;

async function shareExistingHabit(id, el) {
  if (!state.sharing) return;
  const habit = state.allHabits.find(h => h.id === id);
  if (!habit || habit.shared_id) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-habit"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    try {
      const sharedId = crypto.randomUUID();
      const actor = await getSharedHabitCompletionActor(groupId);
      const catRow = _habitCatMap.get(habit.category_id || _defaultHabitCatId);
      // Build completions list from local records
      const localCompletions = (state.allHabitCompletions || [])
        .filter(c => c.habit_id === habit.id)
        .map(c => ({
          id: crypto.randomUUID(),
          completed_at: c.completed_at,
          completed_by: actor,
        }));
      const sharedItem = {
        id: sharedId,
        item_type: 'habit',
        name: habit.name,
        frequency_rule: habit.frequency_rule,
        creator_category: catRow?.name ?? habit.category ?? '',
        created_by: actor,
        created_at: habit.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completions: localCompletions,
      };
      // 1. Create shared habit on the sharing layer
      await state.sharing.addSharedHabit(groupId, sharedItem);
      // 2. Create local pointer
      const { data: pointer, error: ptrErr } = await state.db.from('habits').insert({
        name: '', frequency_rule: '', category: catRow?.name ?? habit.category ?? '',
        category_id: habit.category_id || _defaultHabitCatId, is_draft: 0,
        shared_id: sharedId, shared_group_id: groupId,
      }).select().single();
      if (ptrErr) { showToast(ptrErr.message, 'error'); return; }
      // 3. Delete local completions then the personal habit
      await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
      await state.db.from('habits').delete().eq('id', habit.id);
      // Compute next_due on the pointer
      if (pointer?.id) {
        await updateHabitNextDue(pointer.id, habit.frequency_rule,
          localCompletions.length ? localCompletions[localCompletions.length - 1].completed_at : null);
      }
      showToast(t('sharing.shared') + '!', 'success');
      await refreshHabits();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, { showAssignees: false });
}
window.shareExistingHabit = shareExistingHabit;

// ── Bulk share all personal habits in a category ──
async function bulkShareHabitCategory(catId, el) {
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  const items = state.allHabits.filter(h => catIdForHabit(h) === catId && !h.shared_id);
  if (!items.length) { showToast(t('sharing.share_all_nothing'), 'info'); return; }
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="bulk-share-habit-category"][data-category="${CSS.escape(catId)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    const msg = t('sharing.share_all_confirm', items.length);
    showConfirmAction(
      t('sharing.share_all'),
      msg,
      async () => {
        if (_bulkShareInProgress) return;
        _bulkShareInProgress = true;
        try {
          const actor = await getSharedHabitCompletionActor(groupId);
          let shared = 0;
          for (const habit of items) {
            try {
              const sharedId = crypto.randomUUID();
              const catRow = _habitCatMap.get(habit.category_id || _defaultHabitCatId);
              const localCompletions = (state.allHabitCompletions || [])
                .filter(c => c.habit_id === habit.id)
                .map(c => ({ id: crypto.randomUUID(), completed_at: c.completed_at, completed_by: actor }));
              await state.sharing.addSharedHabit(groupId, {
                id: sharedId, item_type: 'habit',
                name: habit.name, frequency_rule: habit.frequency_rule,
                creator_category: catRow?.name ?? habit.category ?? '',
                created_by: actor,
                created_at: habit.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                completions: localCompletions,
              });
              const { data: pointer, error: ptrErr } = await state.db.from('habits').insert({
                name: '', frequency_rule: '', category: catRow?.name ?? habit.category ?? '',
                category_id: habit.category_id || _defaultHabitCatId, is_draft: 0,
                created_at: habit.created_at || new Date().toISOString(),
                shared_id: sharedId, shared_group_id: groupId,
              }).select().single();
              if (ptrErr) continue;
              await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
              await state.db.from('habits').delete().eq('id', habit.id);
              if (pointer?.id) {
                await updateHabitNextDue(pointer.id, habit.frequency_rule,
                  localCompletions.length ? localCompletions[localCompletions.length - 1].completed_at : null);
              }
              shared++;
            } catch (e) { console.error('[DeLaClaw] bulk share habit failed:', e); }
          }
          if (shared > 0) showToast(t('sharing.share_all_done', shared), 'success');
          await refreshHabits();
        } finally { _bulkShareInProgress = false; }
      },
      null,
      { variant: 'neutral', btnText: t('sharing.share_all'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
    );
  }, { showAssignees: false });
}
window.bulkShareHabitCategory = bulkShareHabitCategory;

// ── Unshare habit (creator only): move shared habit back to personal ──
async function unshareHabit(id, el) {
  if (!state.sharing) return;
  const habit = state.allHabits.find(h => h.id === id);
  if (!habit || !habit.shared_id || !habit.shared_group_id) return;

  showConfirmAction(
    t('sharing.unshare'),
    t('sharing.unshare_confirm'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unshare-habit"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        const catRow = _habitCatMap.get(habit.category_id || _defaultHabitCatId);
        // 1. Create personal habit
        const { data: newHabit, error: insErr } = await state.db.from('habits').insert({
          name: habit.name || '',
          frequency_rule: habit.frequency_rule || '',
          category: catRow?.name ?? habit.category ?? '',
          category_id: habit.category_id || _defaultHabitCatId,
          is_draft: 0,
          next_due: habit.next_due || null,
        }).select().single();
        if (insErr) { showToast(insErr.message, 'error'); return; }
        // 2. Recreate completions locally
        const sharedCompletions = habit._shared?.completions || [];
        for (const c of sharedCompletions) {
          await state.db.from('habit_completions').insert({
            habit_id: newHabit.id,
            completed_at: c.completed_at,
            note: null,
          });
        }
        // 3. Delete shared habit from sharing layer
        await state.sharing.deleteSharedHabit(habit.shared_group_id, habit.shared_id);
        // 4. Delete local pointer + its completions
        await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
        await state.db.from('habits').delete().eq('id', habit.id);
        showToast(t('sharing.unshared'), 'success');
        await refreshHabits();
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
window.unshareHabit = unshareHabit;

// ── Copy habit to personal (non-creator) ──
async function copyHabitToPersonal(id, el) {
  if (!state.sharing) return;
  const habit = state.allHabits.find(h => h.id === id);
  if (!habit || !habit.shared_id || !habit.shared_group_id) return;

  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="copy-habit-to-personal"][data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try {
    // Keep current category unless it's __shared__, then fall back to General
    const itemCatId = habit.category_id || _defaultHabitCatId;
    const targetCatId = (itemCatId === _sharedHabitCatId) ? _defaultHabitCatId : itemCatId;
    const targetCatName = _habitCatMap.get(targetCatId)?.name ?? '';
    const { data: newHabit, error: insErr } = await state.db.from('habits').insert({
      name: habit.name || '',
      frequency_rule: habit.frequency_rule || '',
      category: targetCatName,
      category_id: targetCatId,
      is_draft: 0,
      next_due: habit.next_due || null,
    }).select().single();
    if (insErr) { showToast(insErr.message, 'error'); return; }
    // Copy completions
    const sharedCompletions = habit._shared?.completions || [];
    for (const c of sharedCompletions) {
      await state.db.from('habit_completions').insert({
        habit_id: newHabit.id,
        completed_at: c.completed_at,
        note: null,
      });
    }
    showToast(t('sharing.copied_to_personal'), 'success');
    await refreshHabits();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}
window.copyHabitToPersonal = copyHabitToPersonal;
window.closeAddHabitModal = closeAddHabitModal;
window.saveNewHabit = saveNewHabit;
window.openEditHabitModal = openEditHabitModal;
window.closeEditHabitModal = closeEditHabitModal;
window.saveEditHabit = saveEditHabit;
window.deleteHabit = deleteHabit;
window.promoteHabit = promoteHabit;
window.markHabitDone = markHabitDone;
window.openHabitHistory = openHabitHistory;
window.closeHabitHistoryModal = closeHabitHistoryModal;
window.editHabitCompletion = editHabitCompletion;
window.saveHabitCompletion = saveHabitCompletion;
window.deleteHabitCompletion = deleteHabitCompletion;
window.cancelEditCompletion = cancelEditCompletion;
window.editHabitLastDone = editHabitLastDone;
window.openAddHabitCategoryModal = openAddHabitCategoryModal;
window.closeAddHabitCategoryModal = closeAddHabitCategoryModal;
window.saveNewHabitCategory = saveNewHabitCategory;
window.deleteHabitCategory = deleteHabitCategory;
window.addHabitFromInput = addHabitFromInput;
window.renderHabits = renderHabits;
window.navigateToHabitCategory = navigateToHabitCategory;
window.editHabitInline = editHabitInline;

window.openEditHabitCategoryModal = openEditHabitCategoryModal;
window.closeEditHabitCategoryModal = closeEditHabitCategoryModal;
window.saveEditHabitCategory = saveEditHabitCategory;
window.filterHabits = function(e) { habitSearchQuery = e.target.value; renderHabits(); };
window.setHabitViewMode = setHabitViewMode;
window.navigateHabitCalendar = navigateHabitCalendar;
window.navigateHabitCalendarToday = navigateHabitCalendarToday;
window.toggleHabitCalScale = toggleHabitCalScale;
