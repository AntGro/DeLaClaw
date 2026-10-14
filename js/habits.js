import { lucideIcon } from './icons.js';
import state, { GENERAL_CATEGORY_COLOR, SHARED_CATEGORY as SHARED_CAT_CONST } from './state.js';
import { esc, escQ, renderMd, showToast, showConfirmAction, balanceGrid, fetchAll, backfillCategoryColors, nextPaletteColor, autoResizeTextarea, snapshotTextInputs, restoreTextInputs } from './utils.js';
import { initItemHoverDelay, initItemDragDrop, scrollToAndHighlight, inlineEditText, initNavBtnReorder, bulkSortOrder, snapshotBuckets, animateBucketsFromSnapshot, captureInnerScrollPositions, restoreInnerScrollPositions, animateItemRemoval } from './item-utils.js';
import { t, getLang } from './i18n.js';
import { pendingSharedNextDue as _pendingSharedNextDue } from './pending-next-due.js';
import { sharedBadge, openSharePopover } from './sharing-ui.js';

// ===================================================================
// HABITS — DATA, CRUD & RENDERING
// ===================================================================
// (state managed in state.js)
// (state managed in state.js)
let habitFilter = 'all';
let habitSearchQuery = '';
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
  const modal = document.getElementById('editHabitCategoryModal');
  modal.innerHTML = editHabitCategoryModalHTML();
  document.getElementById('editHabitCatOldName').value = catId; // store ID, not name
  document.getElementById('editHabitCatName').value = cat.name;
  document.getElementById('editHabitCatShortname').value = cat.shortname || '';
  document.getElementById('editHabitCatColor').value = cat.color || GENERAL_CATEGORY_COLOR;
  modal.classList.add('visible');
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
  const oldShortname = cat.shortname;
  const oldName = cat.name;
  const updates = { shortname: shortname || null, color };
  if (!cat.is_protected) updates.name = newName;
  await state.db.from('habit_categories').update(updates).eq('id', catId);
  Object.assign(cat, updates);
  _habitCatByName.clear();
  for (const row of _habitCatMap.values()) _habitCatByName.set(row.name, row);

  // Calendar: only resync items if the label used in event summaries changed
  if (updates.shortname !== oldShortname || updates.name !== oldName) {
    window.markCategoryRenamed?.('habit_categories');
  }

  closeEditHabitCategoryModal();
  renderHabits();
  showToast(t('toast.updated'), 'success');
}


// ===================================================================
// NEXT_DUE — structured rules computed client-side, custom rules by heartbeat
// ===================================================================
// Structured frequency_rule formats live in js/frequency-rule.js (single
// source of truth, re-exported below); local helpers follow.

import { STRUCTURED_PREFIXES, DOW_KEYS, DOW_JS, isStructuredRule, normalizeFrequencyRule } from './frequency-rule.js';
import { parseLocalDate } from './calendar-pure.js';
// (re-exported in the export list at the bottom of this file)

/** Format a Date as YYYY-MM-DD in local time (not UTC). */
function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Returns the next due date after lastDoneDate, which may be in the past:
// a habit neglected for more than one period is overdue, and the UI has a
// dedicated overdue state for exactly that (never clamp to today here).
function computeNextDue(frequencyRule, lastDoneDate) {
  if (!frequencyRule || !isStructuredRule(frequencyRule)) return null;
  const today = new Date(); today.setHours(0,0,0,0);

  // No completions yet: for pure interval rules, due today;
  // for anchored rules (specific weekdays, day-of-month, yearly date),
  // find the next valid occurrence from today by using yesterday as the base.
  const noHistory = !lastDoneDate;
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  // lastDoneDate may be a full timestamp (marking done — parsed as an
  // instant, converted to the local day) or a date-only string (a stored
  // next_due, a picked last-done date, a Calendar expansion cursor —
  // parsed as that local calendar date, never as UTC midnight).
  const base = noHistory ? yesterday : parseLocalDate(lastDoneDate);
  const baseDay = new Date(base.getFullYear(), base.getMonth(), base.getDate());

  if (frequencyRule.startsWith('every_N_days:')) {
    if (noHistory) return localDateStr(today);
    const n = parseInt(frequencyRule.split(':')[1], 10) || 1;
    const next = new Date(baseDay); next.setDate(next.getDate() + n);
    return localDateStr(next);
  }

  if (frequencyRule.startsWith('every_N_weeks:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;
    const daysStr = parts[2] || '';

    if (!daysStr) {
      // Pure interval: N weeks from last done (or today if new)
      if (noHistory) return localDateStr(today);
      const next = new Date(baseDay); next.setDate(next.getDate() + n * 7);
      return localDateStr(next);
    }

    const days = daysStr.split(',');
    const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
    if (dayIndices.length === 0) {
      if (noHistory) return localDateStr(today);
      const next = new Date(baseDay); next.setDate(next.getDate() + n * 7);
      return localDateStr(next);
    }

    if (n === 1) {
      // Weekly: find next matching day within 7 days
      for (let offset = 1; offset <= 7; offset++) {
        const candidate = new Date(baseDay); candidate.setDate(candidate.getDate() + offset);
        if (dayIndices.includes(candidate.getDay())) {
          return localDateStr(candidate);
        }
      }
      return null;
    }

    // N > 1: check remaining matching days this ISO week first
    const isoDow = baseDay.getDay() || 7; // Mon=1..Sun=7
    for (let offset = 1; offset <= 7 - isoDow; offset++) {
      const candidate = new Date(baseDay); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay())) {
        return localDateStr(candidate);
      }
    }
    // No more matching days this week — jump to Nth week after
    const nextWeekMon = new Date(baseDay);
    nextWeekMon.setDate(nextWeekMon.getDate() + (8 - isoDow)); // next Monday
    nextWeekMon.setDate(nextWeekMon.getDate() + (n - 1) * 7);  // skip N-1 more weeks
    for (let offset = 0; offset < 7; offset++) {
      const candidate = new Date(nextWeekMon); candidate.setDate(candidate.getDate() + offset);
      if (dayIndices.includes(candidate.getDay())) {
        return localDateStr(candidate);
      }
    }
    return null;
  }

  if (frequencyRule.startsWith('every_N_months:')) {
    const parts = frequencyRule.split(':');
    const n = parseInt(parts[1], 10) || 1;

    // Day-of-month mode: every_N_months:N:DD (part[2] is numeric)
    if (!isNaN(parseInt(parts[2], 10))) {
      const dom = parseInt(parts[2], 10);
      if (!dom || dom < 1 || dom > 31) return null;
      let next = new Date(baseDay.getFullYear(), baseDay.getMonth(), dom);
      if (next <= baseDay) next = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, dom);
      return localDateStr(next);
    }

    // Weekday mode: every_N_months:N:first|last:Days
    if (parts[2] === 'first' || parts[2] === 'last') {
      const position = parts[2];
      const days = (parts[3] || '').split(',');
      const dayIndices = days.map(d => DOW_JS[DOW_KEYS.indexOf(d)]).filter(d => d !== undefined);
      if (dayIndices.length === 0) return null;

      function findPositionWeekdays(year, month, targetDays, pos) {
        const results = [];
        for (const targetDay of targetDays) {
          if (pos === 'first') {
            const d = new Date(year, month, 1);
            while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
            results.push(new Date(d));
          } else {
            const d = new Date(year, month + 1, 0);
            while (d.getDay() !== targetDay) d.setDate(d.getDate() - 1);
            results.push(new Date(d));
          }
        }
        return results.sort((a, b) => a - b);
      }

      // Check current month for remaining candidates after baseDay
      let candidates = findPositionWeekdays(baseDay.getFullYear(), baseDay.getMonth(), dayIndices, position)
        .filter(d => d > baseDay);
      if (candidates.length === 0) {
        // Advance N months
        const nextMonth = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, 1);
        candidates = findPositionWeekdays(nextMonth.getFullYear(), nextMonth.getMonth(), dayIndices, position);
      }
      if (candidates.length === 0) return null;
      const next = candidates[0];
      return localDateStr(next);
    }

    return null;
  }

  if (frequencyRule.startsWith('yearly:')) {
    const mmdd = frequencyRule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    if (!mm || !dd) return null;
    let next = new Date(baseDay.getFullYear(), mm - 1, dd);
    if (next <= baseDay) next = new Date(baseDay.getFullYear() + 1, mm - 1, dd);
    return localDateStr(next);
  }

  return null;
}

function formatFrequency(rule) {
  if (!rule) return '';
  if (!isStructuredRule(rule)) return rule; // legacy free-text: show as-is

  if (rule.startsWith('every_N_days:')) {
    const n = parseInt(rule.split(':')[1], 10);
    if (n === 1) return t('habits.freq_display_daily');
    return t('habits.freq_display_every_n_days', n);
  }

  if (rule.startsWith('every_N_weeks:')) {
    const parts = rule.split(':');
    const n = parseInt(parts[1], 10);
    const daysStr = parts[2] || '';
    if (!daysStr) {
      if (n === 1) return t('habits.freq_display_every_week');
      return t('habits.freq_display_every_n_weeks_no_days', n);
    }
    const days = daysStr.split(',');
    const dayLabels = days.map(d => t('habits.day_' + d.toLowerCase()));
    if (n === 1) return t('habits.freq_display_weekly', dayLabels.join(', '));
    return t('habits.freq_display_every_n_weeks', n, dayLabels.join(', '));
  }

  if (rule.startsWith('every_N_months:')) {
    const parts = rule.split(':');
    const n = parseInt(parts[1], 10);
    // Day-of-month mode
    if (!isNaN(parseInt(parts[2], 10))) {
      const dom = parseInt(parts[2], 10);
      if (n === 1) return t('habits.freq_display_monthly', ordinalSuffix(dom));
      return t('habits.freq_display_every_n_months', n, ordinalSuffix(dom));
    }
    // Weekday mode
    if (parts[2] === 'first' || parts[2] === 'last') {
      const pos = t('habits.freq_' + parts[2]);
      const days = (parts[3] || '').split(',');
      const dayLabels = days.map(d => t('habits.day_' + d.toLowerCase()));
      if (n === 1) return t('habits.freq_display_monthly_weekday', pos, dayLabels.join(', '));
      return t('habits.freq_display_every_n_months_weekday', n, pos, dayLabels.join(', '));
    }
    return rule;
  }

  if (rule.startsWith('yearly:')) {
    const mmdd = rule.split(':')[1];
    const [mm, dd] = mmdd.split('-').map(Number);
    const d = new Date(2000, mm - 1, dd);
    return t('habits.freq_display_yearly', d.toLocaleDateString(getLang(), { month: 'long', day: 'numeric' }));
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

// A habit finishes when its recomputed next due date falls strictly past
// its end date (an occurrence exactly ON the end date is still due).
// Pure date-string comparison — both values are local YYYY-MM-DD.
function habitFinishedFor(computedNextDue, endDate) {
  return !!(computedNextDue && endDate && computedNextDue > endDate);
}

async function updateHabitNextDue(habitId, frequencyRule, lastDoneDate, { earlyGuard = true, endDate, out } = {}) {
  const structured = isStructuredRule(frequencyRule);
  let nextDue = structured
    ? normalizeHabitNextDue(computeNextDue(frequencyRule, lastDoneDate))
    : null;
  const habit = state.allHabits.find(h => String(h.id) === String(habitId));
  const currentNextDue = normalizeHabitNextDue(habit?.next_due);

  // Manual edits (earlyGuard: false) recompute honestly from the asserted
  // last-done date — no min(), no skip. next_due is always f(rule,
  // last_done): a backdate can move it earlier (even overdue), and asserting
  // a recent completion moves it forward. There is no double-advance: edits
  // rewrite the latest completion, they never append one.
  if (earlyGuard) {
    if (nextDue && currentNextDue && nextDue <= currentNextDue) {
      nextDue = normalizeHabitNextDue(computeNextDue(frequencyRule, currentNextDue));
    }
  }

  // End date: a structured habit whose recomputed next due falls strictly
  // past its end date is finished — next_due is cleared and is_finished set,
  // here at the single recompute choke point so completion, creation and
  // every edit path agree. Extending or clearing the end date revives the
  // habit (the recompute then lands on or before it). Free-text rules keep
  // their previous finished state: their next due is resolved externally,
  // so the app cannot decide they are finished. `endDate` overrides the
  // stored value when the caller is changing it in the same save; `out`,
  // when given, receives the outcome so shared chains can publish it from
  // this recompute, never from a captured habit object.
  const effEndDate = normalizeHabitNextDue(endDate !== undefined ? endDate : habit?.end_date);
  const isFinished = structured ? habitFinishedFor(nextDue, effEndDate) : !!habit?.is_finished;
  if (isFinished) nextDue = null;
  if (out) out.isFinished = isFinished;

  if (habit && currentNextDue === nextDue && !!habit.is_finished === isFinished) return nextDue;

  const { error } = await state.db.from('habits').update({ next_due: nextDue, is_finished: isFinished ? 1 : 0 }).eq('id', habitId);
  if (error) {
    console.warn(nextDue ? 'Failed to update next_due:' : 'Failed to clear next_due:', error.message);
    return nextDue;
  }
  if (habit) habit.next_due = nextDue;
  if (habit) habit.is_finished = isFinished ? 1 : 0;
  return nextDue;
}

async function clearHabitNextDue(habitId) {
  await updateHabitNextDue(habitId, '', null);
}

// ===================================================================
// FREQUENCY PICKER — shared UI builder for add/edit/inline
// ===================================================================
const FREQ_TYPES = [
  'every_N_days', 'every_N_weeks', 'every_N_months', 'yearly', 'custom'
];

function buildFrequencyPicker(container, currentRule) {
  container.innerHTML = '';
  container.className = (container.className.replace(/\bfreq-picker\b/, '') + ' freq-picker').trim();

  // Normalize legacy rules before parsing
  const rule = normalizeFrequencyRule(currentRule);

  // Detect current type from rule (default to 'every_N_weeks' for new habits)
  let currentType = rule ? 'custom' : 'every_N_weeks';
  let parsed = {};
  if (rule) {
    if (rule.startsWith('every_N_days:')) { currentType = 'every_N_days'; parsed.n = rule.split(':')[1]; }
    else if (rule.startsWith('every_N_weeks:')) { currentType = 'every_N_weeks'; const p = rule.split(':'); parsed.n = p[1]; parsed.days = p[2] ? p[2].split(',') : []; }
    else if (rule.startsWith('every_N_months:')) {
      currentType = 'every_N_months';
      const p = rule.split(':');
      parsed.n = p[1];
      if (p[2] === 'first' || p[2] === 'last') {
        parsed.monthMode = 'weekday'; parsed.position = p[2]; parsed.days = p[3] ? p[3].split(',') : [];
      } else {
        parsed.monthMode = 'dom'; parsed.dom = p[2] || '1';
      }
    }
    else if (rule.startsWith('yearly:')) { currentType = 'yearly'; parsed.mmdd = rule.split(':')[1]; }
    else { currentType = 'custom'; parsed.text = rule; }
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
      const row = document.createElement('div'); row.className = 'freq-n-row';
      const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_every');
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.max = '365'; inp.className = 'inline-edit-input freq-n-input';
      inp.value = parsed.n || '1';
      inp.dataset.freqField = 'n';
      const unit = document.createElement('span'); unit.className = 'freq-option-label'; unit.textContent = t('habits.freq_n_days_label');
      row.appendChild(label); row.appendChild(inp); row.appendChild(unit);
      opts.appendChild(row);
    }

    if (type === 'every_N_weeks') {
      const row = document.createElement('div'); row.className = 'freq-n-row';
      const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_every');
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.max = '52'; inp.className = 'inline-edit-input freq-n-input';
      inp.value = parsed.n || '1';
      inp.dataset.freqField = 'n';
      const unit = document.createElement('span'); unit.className = 'freq-option-label'; unit.textContent = t('habits.freq_n_weeks_label');
      row.appendChild(label); row.appendChild(inp); row.appendChild(unit);
      opts.appendChild(row);
      // Optional weekday bar
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

    if (type === 'every_N_months') {
      const row = document.createElement('div'); row.className = 'freq-n-row';
      const label = document.createElement('span'); label.className = 'freq-option-label'; label.textContent = t('habits.freq_every');
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '1'; inp.max = '12'; inp.className = 'inline-edit-input freq-n-input';
      inp.value = parsed.n || '1';
      inp.dataset.freqField = 'n';
      const unit = document.createElement('span'); unit.className = 'freq-option-label'; unit.textContent = t('habits.freq_n_months_label');
      row.appendChild(label); row.appendChild(inp); row.appendChild(unit);
      opts.appendChild(row);

      // Mode toggle row: day-of-month vs weekday
      const modeRow = document.createElement('div'); modeRow.className = 'freq-n-row';
      const onLabel = document.createElement('span'); onLabel.className = 'freq-option-label'; onLabel.textContent = t('habits.freq_on');
      const modeSel = document.createElement('select'); modeSel.className = 'inline-edit-input freq-mode-select';
      modeSel.dataset.freqField = 'monthMode';
      [{ v: 'dom', l: t('habits.freq_mode_dom') }, { v: 'weekday', l: t('habits.freq_mode_weekday') }].forEach(m => {
        const opt = document.createElement('option'); opt.value = m.v; opt.textContent = m.l;
        if (m.v === (parsed.monthMode || 'dom')) opt.selected = true;
        modeSel.appendChild(opt);
      });
      modeRow.appendChild(onLabel); modeRow.appendChild(modeSel);
      opts.appendChild(modeRow);

      const subOpts = document.createElement('div'); subOpts.className = 'freq-month-sub-options';
      opts.appendChild(subOpts);

      function renderMonthSub() {
        subOpts.innerHTML = '';
        const mode = modeSel.value;
        if (mode === 'dom') {
          const domRow = document.createElement('div'); domRow.className = 'freq-n-row';
          const domSel = document.createElement('select'); domSel.className = 'inline-edit-input freq-dom-select';
          domSel.dataset.freqField = 'dom';
          for (let i = 1; i <= 31; i++) {
            const opt = document.createElement('option'); opt.value = i; opt.textContent = ordinalSuffix(i);
            if (String(i) === String(parsed.dom || '1')) opt.selected = true;
            domSel.appendChild(opt);
          }
          domRow.appendChild(domSel);
          subOpts.appendChild(domRow);
        } else {
          // Weekday mode: position + multi-day bar
          const posRow = document.createElement('div'); posRow.className = 'freq-n-row';
          const posSel = document.createElement('select'); posSel.className = 'inline-edit-input freq-pos-select';
          posSel.dataset.freqField = 'position';
          ['first', 'last'].forEach(p => {
            const opt = document.createElement('option'); opt.value = p; opt.textContent = t('habits.freq_' + p);
            if (p === (parsed.position || 'first')) opt.selected = true;
            posSel.appendChild(opt);
          });
          posRow.appendChild(posSel);
          subOpts.appendChild(posRow);
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
          subOpts.appendChild(dayBar);
        }
      }
      modeSel.addEventListener('change', () => { parsed.monthMode = modeSel.value; renderMonthSub(); });
      renderMonthSub();
    }

    if (type === 'yearly') {
      const row = document.createElement('div'); row.className = 'freq-n-row';
      const mSel = document.createElement('select'); mSel.className = 'inline-edit-input freq-month-select';
      mSel.dataset.freqField = 'month';
      for (let i = 1; i <= 12; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0');
        opt.textContent = new Date(2000, i - 1, 1).toLocaleString(getLang(), { month: 'long' });
        const curM = parsed.mmdd ? parsed.mmdd.split('-')[0] : '01';
        if (String(i).padStart(2, '0') === curM) opt.selected = true;
        mSel.appendChild(opt);
      }
      row.appendChild(mSel);

      const dSel = document.createElement('select'); dSel.className = 'inline-edit-input freq-dom-select';
      dSel.dataset.freqField = 'yearday';
      for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option'); opt.value = String(i).padStart(2, '0'); opt.textContent = String(i);
        const curD = parsed.mmdd ? parsed.mmdd.split('-')[1] : '01';
        if (String(i).padStart(2, '0') === curD) opt.selected = true;
        dSel.appendChild(opt);
      }
      row.appendChild(dSel);
      opts.appendChild(row);
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

  if (type === 'every_N_days') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '1';
    return 'every_N_days:' + n;
  }

  if (type === 'every_N_weeks') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '1';
    const days = Array.from(opts.querySelectorAll('.freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'every_N_weeks:' + n + ':' + days.join(',') : 'every_N_weeks:' + n;
  }

  if (type === 'every_N_months') {
    const n = opts.querySelector('[data-freq-field="n"]')?.value || '1';
    const mode = opts.querySelector('[data-freq-field="monthMode"]')?.value || 'dom';
    if (mode === 'dom') {
      const dom = opts.querySelector('[data-freq-field="dom"]')?.value || '1';
      return 'every_N_months:' + n + ':' + dom;
    }
    // weekday mode
    const pos = opts.querySelector('[data-freq-field="position"]')?.value || 'first';
    const days = Array.from(opts.querySelectorAll('.freq-month-sub-options .freq-day-btn.active')).map(b => b.dataset.day);
    return days.length ? 'every_N_months:' + n + ':' + pos + ':' + days.join(',') : '';
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

let _lastRefreshHabits = 0;
async function refreshHabits() {
  if (!state.db.connected) return;
  // Cooldown: skip if a refresh completed within 500ms (avoids double-fetch
  // when explicit refresh + realtime-triggered refresh fire back-to-back).
  const now = Date.now();
  if (now - _lastRefreshHabits < 500) return;
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
  // Normalize any legacy frequency_rule formats
  for (const h of state.allHabits) {
    if (h.frequency_rule) h.frequency_rule = normalizeFrequencyRule(h.frequency_rule);
  }

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
        // The pointer row's stored end fields, captured before the mirror
        // below overwrites them — the row sync further down compares the
        // shared values against these, not against the mirrored ones.
        habit._rowEndDate = habit.end_date || null;
        habit._rowFinished = habit.is_finished ? 1 : 0;
        habit.end_date = sh.end_date || null;
        habit.is_finished = sh.is_finished ? 1 : 0;
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
        }
        // Read next_due from shared storage — no local recomputation — unless
        // we have a next_due publish in flight for this habit: shared storage
        // is then stale by construction and the local row (just recomputed)
        // is newer. end_date / is_finished mirror from shared storage in the
        // same write (they only change alongside a next_due publish).
        const sharedNextDue = sh.next_due != null ? normalizeHabitNextDue(sh.next_due) : null;
        const sharedFinished = sh.is_finished ? 1 : 0;
        const sharedEndDate = sh.end_date || null;
        if ((sharedNextDue !== normalizeHabitNextDue(habit.next_due)
             || sharedFinished !== habit._rowFinished
             || sharedEndDate !== habit._rowEndDate)
            && !_pendingSharedNextDue.has(habit.shared_id)) {
          const { error } = await state.db.from('habits').update({ next_due: sharedNextDue, is_finished: sharedFinished, end_date: sharedEndDate }).eq('id', habit.id);
          if (!error) { habit.next_due = sharedNextDue; habit.is_finished = sharedFinished; habit.end_date = sharedEndDate; }
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
      gidArr.forEach((gid, i) => { if (members[i]?.member_id) memberIdPerGroup.set(gid, members[i].member_id); });
      for (const habit of state.allHabits) {
        if (!habit._shared || !habit.shared_group_id) continue;
        const myId = memberIdPerGroup.get(habit.shared_group_id);
        if (myId && habit._shared.created_by === myId) _myCreatedSharedHabitIds.add(habit.shared_id);
      }
    }

    // Drop shared pointers whose remote data couldn't be resolved
    state.allHabits = state.allHabits.filter(h => !h.shared_id || h._shared);
  }

  _lastRefreshHabits = Date.now();

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
    if (member?.member_id) return member.member_id;
  }
  return '';
}

// Pure decision logic for editing last-done: returns which completions to
// keep, which to delete, and whether an insert or update is needed.
function planLastDoneEdit(completions, newIso) {
  const sorted = sortHabitCompletionList(completions.map(c => ({ ...c })));
  if (!newIso) {
    // null → clear the latest
    const latest = sorted[sorted.length - 1] || null;
    return { kept: latest ? sorted.slice(0, -1) : [...sorted], toDelete: latest ? [latest] : [], updateId: null, needsInsert: false };
  }
  const newDateStr = localDateStr(new Date(newIso));
  const kept = [];
  const toDelete = [];
  for (const c of sorted) {
    if (localDateStr(new Date(c.completed_at)) > newDateStr) toDelete.push(c);
    else kept.push(c);
  }
  const hasExact = kept.some(c => localDateStr(new Date(c.completed_at)) === newDateStr);
  if (hasExact) return { kept, toDelete, updateId: null, needsInsert: false };
  // No completion on the target date — reuse the latest kept, or insert
  const latestKept = kept[kept.length - 1] || null;
  return { kept, toDelete, updateId: latestKept?.id || null, needsInsert: !latestKept };
}

// Preview the latest completion ISO a last-done edit would produce, without
// staging anything. Mirrors setSharedHabitLastDone's apply logic so a local
// next_due recompute can run BEFORE the shared uploads (immediate UI).
function previewLastDoneLatest(completions, newIso) {
  const plan = planLastDoneEdit(completions, newIso);
  const result = [...plan.kept];
  if (newIso) {
    if (plan.updateId) {
      const c = result.find(c => c.id === plan.updateId);
      if (c) c.completed_at = newIso;
    } else if (plan.needsInsert) {
      result.push({ completed_at: newIso });
    }
  }
  return latestHabitCompletion(result)?.completed_at || null;
}

async function computeSharedLastDoneCompletions(habit, newIso) {
  const sh = getSharedHabitForLocalHabit(habit);
  if (!sh) throw new Error('Shared habit not found');

  const completions = sortHabitCompletionList(sh.completions).map(c => ({ ...c }));
  const plan = planLastDoneEdit(completions, newIso);

  // Apply: remove deleted, update or insert as needed
  const result = [...plan.kept];
  if (newIso) {
    if (plan.updateId) {
      const c = result.find(c => c.id === plan.updateId);
      if (c) c.completed_at = newIso;
    } else if (plan.needsInsert) {
      result.push({
        id: crypto.randomUUID(),
        completed_at: newIso,
        completed_by: await getSharedHabitCompletionActor(habit.shared_group_id),
      });
    }
  }

  return sortHabitCompletionList(result);
}

async function setSharedHabitLastDone(habit, newIso, opts = {}) {
  const nextCompletions = await computeSharedLastDoneCompletions(habit, newIso);
  // Fold an optional next_due into the same staged mutation (one upload).
  const changes = { completions: nextCompletions };
  if (opts.next_due !== undefined) changes.next_due = opts.next_due;
  if (opts.is_finished !== undefined) changes.is_finished = opts.is_finished;
  await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, changes, opts);
  return latestHabitCompletion(nextCompletions)?.completed_at || null;
}

async function setLocalHabitLastDone(habitId, newIso) {
  const allComps = getHabitCompletions(habitId).map(c => ({ ...c }));
  const plan = planLastDoneEdit(allComps, newIso);

  // Delete removed completions from DB
  for (const c of plan.toDelete) {
    const { error } = await state.db.from('habit_completions').delete().eq('id', c.id);
    if (error) throw new Error(error.message || 'Failed to delete completion');
  }

  if (newIso) {
    if (plan.updateId) {
      const { error } = await state.db.from('habit_completions').update({ completed_at: newIso }).eq('id', plan.updateId);
      if (error) throw new Error(error.message || 'Failed to update completion');
      const c = plan.kept.find(c => c.id === plan.updateId);
      if (c) c.completed_at = newIso;
    } else if (plan.needsInsert) {
      const { error } = await state.db.from('habit_completions').insert({ habit_id: habitId, completed_at: newIso });
      if (error) throw new Error(error.message || 'Failed to add completion');
      plan.kept.push({ id: crypto.randomUUID(), habit_id: habitId, completed_at: newIso });
    }
  }

  return latestHabitCompletion(plan.kept)?.completed_at || null;
}

function habitDueStatus(habit) {
  if (!habit.next_due) return 'no-date';
  const now = new Date();
  const due = parseLocalDate(habit.next_due);
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
  const due = parseLocalDate(habit.next_due);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay - todayStart) / (1000 * 60 * 60 * 24));
  const status = habitDueStatus(habit);

  const dateStr = due.toLocaleDateString(getLang(), { month: 'short', day: 'numeric' });
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
      // Date-only strings sort chronologically as plain strings.
      return String(a.next_due).slice(0, 10).localeCompare(String(b.next_due).slice(0, 10));
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

  // A background sharing sync can re-render while the user is typing in a
  // quick-add box — keep the in-progress text (and focus) across the render.
  const pendingInputs = snapshotTextInputs(grid, '.todo-cat-input', 'data-category');

  // If in calendar mode, render calendar instead

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
  const hasSharedItems = state.allHabits.some(c => catIdForHabit(c) === _sharedHabitCatId);
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
  const innerScrolls = captureInnerScrollPositions(grid);
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);
  restoreInnerScrollPositions(grid, innerScrolls);
  restoreTextInputs(grid, '.todo-cat-input', 'data-category', pendingInputs);
  initHabitHoverDelay(grid);
  // Init cross-category drag (no within-category reorder)
  for (const catId of categoryIdList) {
    const card = grid.querySelector(`.project-card[data-category="${CSS.escape(catId)}"]`);
    if (card) {
      const listEl = card.querySelector('.habit-list');
      if (listEl) initHabitCrossDrag(catId, listEl);
    }
  }
  renderHabitNavButtons(categoryIdList);
  initHabitNavBtnReorder();
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

/** Cross-category drag only (no within-category reorder) */
function initHabitCrossDrag(catId, listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.habit-item',
    excludeSelector: 'button, a, input, textarea, select, .habit-actions',
    idAttr: 'habitId',
    actionsSelector: '.habit-actions',
    crossContainerSelector: '.habit-list',
    getContainerId: (el) => el.dataset.category,
    crossOnly: true,
    onReorder: async (orderedIds, { draggedId, sourceContainerId, targetContainerId } = {}) => {
      const crossMove = sourceContainerId && targetContainerId && sourceContainerId !== targetContainerId;
      if (!crossMove) return;
      const movedItem = state.allHabits.find(x => String(x.id) === String(draggedId));
      if (!movedItem) return;
      movedItem.category_id = targetContainerId;
      const targetCatName = _habitCatMap.get(targetContainerId)?.name ?? '';
      movedItem.category = targetCatName;
      await state.db.from('habits').update({ category_id: targetContainerId, category: targetCatName }).eq('id', draggedId);
      await refreshHabits();
      showToast(t('toast.moved'), 'success');
    },
  });
}

function renderHabitNavButtons(categoryIdList) {
  const container = document.getElementById('habitNavButtons');
  if (!container) return;
  container.innerHTML = categoryIdList.map(catId => {
    const cat = _habitCatMap.get(catId);
    const isShared = cat?.name === SHARED_CATEGORY;
    const color = isShared ? '#a78bfa' : (cat?.color || GENERAL_CATEGORY_COLOR);
    const shortname = cat?.shortname || '';
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

function initHabitNavBtnReorder() {
  const skipIds = new Set();
  if (_sharedHabitCatId) skipIds.add(_sharedHabitCatId);
  initNavBtnReorder('habitNavButtons', {
    idAttr: 'category',
    skipIds,
    async onReorder(orderedIds) {
      const reorderable = orderedIds.filter(id => id !== _sharedHabitCatId);
      const updates = [];
      reorderable.forEach((id, i) => {
        const cat = _habitCatMap.get(id);
        if (cat && Number(cat.sort_order ?? 0) !== i) updates.push({ id, sort_order: i });
        if (cat) cat.sort_order = i;
      });
      await bulkSortOrder('habit_categories', updates);
      await loadHabitCategories();
      const grid = document.getElementById('habitCategoryGrid');
      const snapshot = snapshotBuckets(grid);
      renderHabits();
      animateBucketsFromSnapshot(grid, snapshot, 600);
      showToast(t('toast.reordered'), 'success');
    },
  });
}

function renderHabitCategoryCard(catId) {
  const cat = _habitCatMap.get(catId);
  const isSharedDeck = cat?.name === SHARED_CATEGORY;
  const catName = isSharedDeck ? t('sharing.shared') : (cat?.name || t('common.category_default'));
  const isGeneral = !isSharedDeck && cat?.is_protected;
  const habitsInCat = getFilteredHabitsForCategory(catId);
  const totalInCat = state.allHabits.filter(c => catIdForHabit(c) === catId).length;
  const overdueCount = state.allHabits.filter(c => catIdForHabit(c) === catId && habitDueStatus(c) === 'overdue').length;

  const catColor = isSharedDeck ? '#a78bfa' : (cat?.color || GENERAL_CATEGORY_COLOR);
  const statsText = `${totalInCat} habit${totalInCat !== 1 ? 's' : ''}` + (overdueCount > 0 ? ` · <span style="color:var(--red)">${overdueCount} ${t('habits.overdue').toLowerCase()}</span>` : '');

  const shareableHabits = state.allHabits.filter(h => catIdForHabit(h) === catId && !h.shared_id);
  const shareAllBtn = (!isSharedDeck && state.sharing && shareableHabits.length > 0)
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
      <textarea placeholder="${t('habits.quick_add_placeholder')}" maxlength="1000" class="todo-cat-input habit-add-input" data-category="${esc(catId)}" data-action="add-habit-from-input" rows="1" style="resize:none;overflow:hidden;"></textarea>
      <button data-action="add-habit-from-input">${lucideIcon('plus', 16)}</button>
      ${state.sharing ? `<button class="sharing-share-btn" data-action="share-habit-from-add" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
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
    <div class="task-list habit-list todo-cat-list" data-category="${esc(catId)}">
      ${items}
    </div>
  </div>`;
}

function renderHabitItem(habit) {
  const lastDone = getHabitLastDone(habit.id);
  const completionCount = getHabitCompletionCount(habit.id);
  const isDraft = habit.is_draft;
  const isFinished = !isDraft && !!habit.is_finished;
  const status = isFinished ? 'finished' : isDraft ? 'draft' : habitDueStatus(habit);
  const dueHtml = isFinished ? `<span class="habit-due finished">${lucideIcon("flag",16)} ${t('habits.finished')}</span>` : isDraft ? `<span class="habit-due draft">${lucideIcon("file-text",16)} ${t('habits.draft')}</span>` : formatHabitDue(habit);
  const endsHtml = !isFinished && !isDraft && habit.end_date
    ? `<span class="habit-ends">${t('habits.ends_on', parseLocalDate(habit.end_date).toLocaleDateString(getLang(), { month: 'short', day: 'numeric', year: 'numeric' }))}</span>`
    : '';

  const lastDoneStr = lastDone
    ? `${t('habits.last_done')}: ${lastDone.toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })} (${formatHabitRelative(lastDone)})`
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
        ${!isDraft && !isFinished ? `<button data-habit-id="${esc(habit.id)}" data-action="mark-habit-done" data-id="${esc(habit.id)}" title="${t('habits.mark_done')}" class="habit-done-btn">${lucideIcon("circle-check",16)}</button>` : ''}
        <button data-action="open-habit-history" data-id="${esc(habit.id)}" title="${t('habits.habit_history')} (${completionCount})" class="habit-history-btn">${lucideIcon("clipboard-list",16)} ${completionCount}</button>
        ${!isShared && !isDraft && state.sharing ? `<button data-action="share-existing-habit" data-id="${esc(habit.id)}" title="${t('sharing.share')}">${lucideIcon("share",16)}</button>` : ''}
        ${isShared && !isDraft && _myCreatedSharedHabitIds.has(habit.shared_id) ? `<button data-action="unshare-habit" data-id="${esc(habit.id)}" title="${t('sharing.unshare')}">${lucideIcon("share-off",16)}</button>` : ''}
        ${isShared && !isDraft && !_myCreatedSharedHabitIds.has(habit.shared_id) ? `<button data-action="copy-habit-to-personal" data-id="${esc(habit.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon("copy",16)}</button>` : ''}
        <button data-action="copy-item-link" data-link-type="habit" data-id="${esc(habit.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",16)}</button>
        <button data-action="open-edit-habit-modal" data-id="${esc(habit.id)}" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button data-action="delete-habit" data-id="${esc(habit.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    <div class="habit-meta">
      ${dueHtml}
      ${endsHtml}
      ${!isDraft ? `<span class="habit-last-done habit-last-done-editable" data-action="edit-habit-last-done" data-id="${esc(habit.id)}" title="${t('habits.click_to_edit_last_done')}">${lastDoneStr}</span>` : ''}
    </div>
  </div>`;
}

function formatHabitRelative(d) {
  const now = new Date();
  const diffMs = now - d;
  // A date picked for "today" is stamped at noon local time, so before noon
  // it reads as a few hours in the future — clamp to today, never "-1d ago"
  // (Math.floor of a negative fraction is -1).
  const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  if (diffDays === 0) return t('habits.today');
  if (diffDays === 1) return t('habits.yesterday');
  if (diffDays < 7) return t('habits.days_ago', diffDays);
  if (diffDays < 30) return t('habits.weeks_ago', Math.floor(diffDays / 7));
  return t('habits.months_ago', Math.floor(diffDays / 30));
}

// ===================================================================
// HABIT CRUD
// ===================================================================
function addHabitModalHTML() {
  return `<div class="modal"><h2>` + lucideIcon("repeat",20) + ` ${t('habits.add_habit')}</h2><label>${t('common.name')}</label><textarea id="newHabitName" placeholder="${t('habits.habit_placeholder')}" maxlength="1000" data-action="save-new-habit-on-enter" rows="1" style="resize:none;overflow:hidden;"></textarea><label>${t('habits.frequency_rule_label')}</label><div id="newHabitFreqPicker"></div><label>${t('common.category')}</label><select id="newHabitCategory"></select><div id="newHabitGroupRow" style="display:none"><label>${t('sharing.group')}</label><select id="newHabitGroup"><option value="">${t('sharing.no_group')}</option></select></div><label>${t('habits.last_done_optional')}</label><input type="date" id="newHabitLastDone"><label>${t('habits.end_date_optional')}</label><input type="date" id="newHabitEndDate"><label class="habit-draft-toggle"><input type="checkbox" id="newHabitDraft"><span>${t("habits.save_as_draft")} (${t("habits.draft_no_due")})</span></label><div class="modal-actions"><button class="modal-cancel" data-action="close-add-habit-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-habit">${t("common.create")}</button></div></div>`;
}

function editHabitModalHTML() {
  return `<div class="modal"><h2 id="editHabitTitle">` + lucideIcon("pencil",20) + ` ${t('habits.edit_habit')}</h2><input type="hidden" id="editHabitId"><label id="editHabitNameLabel">${t('common.name')}</label><textarea id="editHabitName" maxlength="1000" rows="1" style="resize:none;overflow:hidden;"></textarea><label id="editHabitFreqLabel">${t('habits.frequency_rule')}</label><div id="editHabitFreqPicker"></div><label id="editHabitCategoryLabel">${t('common.category')}</label><select id="editHabitCategory"></select><label id="editHabitLastDoneLabel">${t('habits.last_done_optional')}</label><input type="date" id="editHabitLastDone"><label id="editHabitEndDateLabel">${t('habits.end_date_optional')}</label><input type="date" id="editHabitEndDate"><div class="modal-actions"><button class="modal-cancel" data-action="close-edit-habit-modal" id="editHabitCancelBtn">${t('common.cancel')}</button><button class="modal-save" data-action="save-edit-habit" id="editHabitSaveBtn">${t('common.save')}</button></div></div>`;
}

function habitHistoryModalHTML() {
  return `<div class="modal habit-history-modal"><h2>` + lucideIcon("clipboard-list",20) + ` ${t('habits.habit_history')}</h2><p id="habitHistoryName" style="font-size:0.88rem;color:var(--muted);margin-bottom:12px;"></p><div id="habitHistoryList"></div><div class="modal-actions"><button class="modal-cancel" data-action="close-habit-history-modal">${t('common.close')}</button></div></div>`;
}

function addHabitCategoryModalHTML() {
  return `<div class="modal"><h2>` + lucideIcon("folder-plus",20) + ` ${t('habits.add_category')}</h2><label>${t('habits.category_name')}</label><input type="text" id="newHabitCategoryName" placeholder="${t('habits.category_placeholder')}" maxlength="40" data-action="save-new-habit-category-on-enter"><div class="modal-row"><div class="modal-field"><label>${t('common.shortname')}</label><input type="text" id="newHabitCategoryShortname" placeholder="${t('common.shortname_placeholder')}" maxlength="20" data-action="save-new-habit-category-on-enter"></div><div class="modal-field"><label>${t('common.color')}</label><input type="color" id="newHabitCategoryColor"></div></div><div class="modal-actions"><button class="modal-cancel" data-action="close-add-habit-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-habit-category">${t("common.create")}</button></div></div>`;
}

function editHabitCategoryModalHTML() {
  return `<div class="modal"><h2>` + lucideIcon("pencil",20) + ` ${t('habits.edit_category')}</h2><input type="hidden" id="editHabitCatOldName"><label>${t('habits.category_name')}</label><input type="text" id="editHabitCatName" maxlength="40" data-action="save-edit-habit-category-on-enter"><div class="modal-row"><div class="modal-field"><label>${t('common.shortname')}</label><input type="text" id="editHabitCatShortname" maxlength="20" placeholder="${t('common.shortname_placeholder')}" data-action="save-edit-habit-category-on-enter"></div><div class="modal-field"><label>${t('common.color')}</label><input type="color" id="editHabitCatColor"></div></div><div class="modal-actions"><button class="modal-cancel" data-action="close-edit-habit-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-edit-habit-category">${t('common.save')}</button></div></div>`;
}

function initHabitModals() {
  const app = document.getElementById('app');

  // Add Habit Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'addHabitModal';
  m1.innerHTML = addHabitModalHTML();
  app.appendChild(m1);

  // Edit Habit Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'editHabitModal';
  m2.innerHTML = editHabitModalHTML();
  app.appendChild(m2);

  // Habit History Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay'; m3.id = 'habitHistoryModal';
  m3.innerHTML = habitHistoryModalHTML();
  app.appendChild(m3);

  // Add Habit Category Modal
  const m5 = document.createElement('div');
  m5.className = 'modal-overlay'; m5.id = 'addHabitCategoryModal';
  m5.innerHTML = addHabitCategoryModalHTML();
  app.appendChild(m5);

  // Edit Habit Category Modal
  const m6 = document.createElement('div');
  m6.className = 'modal-overlay'; m6.id = 'editHabitCategoryModal';
  m6.dataset.action = 'close-edit-habit-category-modal';
  m6.dataset.overlayClose = 'true';
  m6.innerHTML = editHabitCategoryModalHTML();
  app.appendChild(m6);
}

function openAddHabitModal(opts = {}) {
  const { name = '', categoryId, groupId } = typeof opts === 'string' ? { groupId: opts } : opts;
  const catId = categoryId || _defaultHabitCatId;
  const modal = document.getElementById('addHabitModal');
  modal.innerHTML = addHabitModalHTML();
  const nameEl = document.getElementById('newHabitName');
  nameEl.value = name;
  if (name) setTimeout(() => autoResizeTextarea(nameEl), 0);
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
      if (groupId) groupSel.value = groupId;
    } else {
      groupRow.style.display = 'none';
    }
  } else {
    groupRow.style.display = 'none';
  }
  modal.style.setProperty('--cat-color', getHabitCatColor(catId));
  modal.classList.add('visible');
  // Focus frequency picker when name is pre-filled, name field otherwise
  if (name) {
    setTimeout(() => document.getElementById('newHabitFreqPicker').querySelector('select')?.focus(), 100);
  } else {
    setTimeout(() => nameEl.focus(), 100);
  }
}

function closeAddHabitModal() {
  document.getElementById('addHabitModal').classList.remove('visible');
}

function shareHabitFromAdd(btn) {
  if (!state.sharing) return;
  const inputEl = btn.closest('.todo-cat-add, .welcome-quick-add')?.querySelector('.habit-add-input, .todo-cat-input');
  const name = inputEl?.value?.trim() || '';
  const catId = inputEl?.dataset?.category || _defaultHabitCatId;
  openSharePopover(btn, (groupId) => {
    openAddHabitModal({ name, categoryId: catId, groupId });
    if (inputEl) { inputEl.value = ''; if (inputEl.tagName === 'TEXTAREA') inputEl.style.height = ''; }
  }, { showAssignees: false });
}

function populateHabitCategorySelect(selectId, currentCatId) {
  const sel = document.getElementById(selectId);
  const catRows = Array.from(_habitCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  // Include Shared only if the habit being edited is already in __shared__
  const includeShared = currentCatId && currentCatId === _sharedHabitCatId;
  sel.innerHTML = catRows.map(c => {
    const label = c.is_protected ? t('common.category_default') : c.name;
    return `<option value="${esc(c.id)}">${esc(label)}</option>`;
  }).join('') + (includeShared ? `<option value="${esc(_sharedHabitCatId)}">${esc(t('sharing.shared'))}</option>` : '');
}

async function addHabitFromInput(inputEl) {
  if (!inputEl || typeof inputEl.value !== 'string') return;
  const name = inputEl.value.trim();
  if (!name) return;
  const catId = inputEl.dataset.category || _defaultHabitCatId;
  openAddHabitModal({ name, categoryId: catId });
  inputEl.value = '';
  if (inputEl.tagName === 'TEXTAREA') { inputEl.style.height = ''; }
}

async function saveNewHabit() {
  const name = document.getElementById('newHabitName').value.trim();
  const freq = getFrequencyFromPicker(document.getElementById('newHabitFreqPicker'));
  const catId = document.getElementById('newHabitCategory').value || _defaultHabitCatId;
  const catRow = _habitCatMap.get(catId);
  const catName = catRow?.name ?? '';
  const lastDoneVal = document.getElementById('newHabitLastDone').value;
  const endDateVal = document.getElementById('newHabitEndDate')?.value || '';
  const isDraft = document.getElementById('newHabitDraft').checked;
  const groupId = document.getElementById('newHabitGroup')?.value || '';

  if (!name) { showToast(t('habits.enter_habit_name'), 'error'); return; }
  if (!freq) { showToast(t('habits.enter_frequency'), 'error'); return; }

  if (groupId && state.sharing) {
    // ─── Shared habit: canonical shared data + local pointer (optimistic) ───
    const sharedId = crypto.randomUUID();
    // Compute next_due purely — a new habit has no existing next_due to guard.
    let nextDue = isStructuredRule(freq)
      ? normalizeHabitNextDue(computeNextDue(freq, lastDoneVal || null))
      : null;
    // End date: a first due strictly past it means the habit starts finished.
    const startsFinished = habitFinishedFor(nextDue, endDateVal || null);
    if (startsFinished) nextDue = null;
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
    if (endDateVal) sharedItem.end_date = endDateVal;
    if (startsFinished) sharedItem.is_finished = 1;
    if (nextDue != null) sharedItem.next_due = nextDue;
    if (lastDoneVal) {
      sharedItem.completions.push({
        id: crypto.randomUUID(),
        completed_at: habitDateInputToIso(lastDoneVal),
        completed_by: actor,
      });
    }

    // Stage the shared item in memory first: this marks the created intent
    // and the dirty type, so the poll skips it and the orphan-pointer
    // cleanup can't see a pointer whose item isn't staged yet.
    let onStaged;
    let wasStaged = false;
    const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
    let localStaged = false;
    let pointerId = null;
    // The shared upload runs in the background: unblock the UI on staging.
    // A failure drops the pointer row again — but only when the local
    // staging below actually happened.
    const upload = state.sharing.addSharedHabit(groupId, sharedItem, { onStaged });
    upload.then(
      () => showToast(t('habits.habit_added', name), 'success'),
      async (e) => {
        console.warn('Failed to write shared habit:', e);
        if (localStaged && pointerId) {
          await state.db.from('habits').delete().eq('id', pointerId);
          await refreshHabits();
        }
        showToast(t('toast.failed_to_add') + ' (shared)', 'error');
      }
    );
    await Promise.race([staged, upload.then(() => {}, () => {})]);
    if (wasStaged) {
      const { data, error } = await state.db.from('habits').insert({
        name: '', frequency_rule: '', category: catName, category_id: catId, is_draft: 0,
        shared_id: sharedId, shared_group_id: groupId, next_due: nextDue,
        end_date: endDateVal || null, is_finished: startsFinished ? 1 : 0,
      }).select().single();
      if (error) {
        // Back out the staged shared item — it hasn't uploaded yet.
        state.sharing.deleteSharedHabit(groupId, sharedId).catch(() => {});
        console.warn('Failed to create local pointer:', error);
        showToast(t('toast.failed_to_add') + ': ' + error.message, 'error');
        return;
      }
      pointerId = data?.id;
      localStaged = true;
    }
    closeAddHabitModal();
    await refreshHabits();
    return;
  }
    // ─── Normal (non-shared) habit ───
    const { data, error } = await state.db.from('habits').insert({
      name, frequency_rule: freq, category: catName, category_id: catId, is_draft: isDraft,
      end_date: endDateVal || null,
    }).select().single();
    if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

    if (lastDoneVal && data?.id) {
      await state.db.from('habit_completions').insert({ habit_id: data.id, completed_at: habitDateInputToIso(lastDoneVal) });
    }
    if (data?.id) {
      await updateHabitNextDue(data.id, freq, lastDoneVal || null, { endDate: endDateVal || null });
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
    maxLength: 1000,
    extraEl: extras,
    containerEl: nameEl.closest('.habit-item'),
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
        // Background upload promise for shared flows (null for personal).
        let sharedUpload = null;
        const sharedUpdates = {};
        if (habit.shared_id && habit.shared_group_id && state.sharing) {
          if (updates.category_id !== undefined) {
            const { error } = await state.db.from('habits').update({ category: updates.category, category_id: updates.category_id }).eq('id', habitId);
            if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
          }
          if (updates.name !== undefined) sharedUpdates.name = updates.name;
          if (updates.frequency_rule !== undefined) sharedUpdates.frequency_rule = updates.frequency_rule;
        } else {
          const { error } = await state.db.from('habits').update(updates).eq('id', habitId);
          if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        }
        Object.assign(habit, updates);
        let newNextDue = null;
        if (updates.frequency_rule && habit.shared_id) {
          const lastDone = getHabitLastDone(habitId);
          // Register before the recompute: a refresh racing the awaits below
          // must not overwrite the fresh local value with stale shared
          // storage. Removed on settlement below — and here if the recompute
          // itself throws, so the id is never stranded.
          const fin = {};
          _pendingSharedNextDue.add(habit.shared_id);
          try {
            newNextDue = await updateHabitNextDue(habitId, updates.frequency_rule, lastDone, { earlyGuard: false, out: fin });
          } catch (e) {
            _pendingSharedNextDue.release(habit.shared_id);
            throw e;
          }
          // Fold the recomputed next_due into the same staged mutation so the
          // whole edit lands in one debounced upload, not two.
          sharedUpdates.next_due = newNextDue;
          sharedUpdates.is_finished = fin.isFinished ? 1 : 0;
        }
        if (habit.shared_id) {
          // Optimistic: upload in the background. A failure rolls the in-memory
          // shared item back (adapter) and refreshes the view.
          sharedUpload = Object.keys(sharedUpdates).length > 0
            ? state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, sharedUpdates)
            : Promise.resolve();
        }
        if (sharedUpload) {
          // Publish the recompute's return value, not habit.next_due: the
          // closure's habit object can go stale if a refresh replaces
          // state.allHabits before this callback runs.
          sharedUpload.then(
            () => {
              // Release the pending id. No re-render: the optimistic refresh
              // already shows the published values — a second full render
              // here would tear down in-flight edits and drags.
              _pendingSharedNextDue.release(habit.shared_id);
            },
            e => {
              _pendingSharedNextDue.release(habit.shared_id);
              console.warn('Failed to update shared habit:', e);
              refreshHabits();
              showToast(t('toast.update_failed'), 'error');
            }
          );
        } else {
          // No shared upload to settle the pending id — release it here.
          _pendingSharedNextDue.release(habit.shared_id);
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
  const modal = document.getElementById('editHabitModal');
  modal.innerHTML = editHabitModalHTML();

  document.getElementById('editHabitId').value = habitId;
  const editNameEl = document.getElementById('editHabitName');
  editNameEl.value = habit.name;
  setTimeout(() => autoResizeTextarea(editNameEl), 0);
  buildFrequencyPicker(document.getElementById('editHabitFreqPicker'), habit.frequency_rule);
  populateHabitCategorySelect('editHabitCategory', catIdForHabit(habit));
  document.getElementById('editHabitCategory').value = catIdForHabit(habit);
  // Populate last done date
  const lastDone = getHabitLastDone(habitId);
  const lastDoneInput = document.getElementById('editHabitLastDone');
  if (lastDoneInput) {
    lastDoneInput.value = lastDone ? localDateStr(lastDone) : '';
    lastDoneInput.max = localDateStr(new Date());
  }
  const endDateInput = document.getElementById('editHabitEndDate');
  if (endDateInput) endDateInput.value = habit.end_date || '';
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
  const endDateVal = document.getElementById('editHabitEndDate')?.value || null;
  const habit = state.allHabits.find(c => c.id === id);

  if (!name) { showToast(t('habits.enter_habit_name'), 'error'); return; }
  if (!freq) { showToast(t('habits.enter_frequency'), 'error'); return; }

  const prevLastDone = getHabitLastDone(id);
  const prevDateStr = prevLastDone ? localDateStr(prevLastDone) : '';
  let latestForNextDue = lastDoneVal ? habitDateInputToIso(lastDoneVal) : (prevLastDone?.toISOString() || null);

  if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
    await state.db.from('habits').update({ category: catName, category_id: catId, end_date: endDateVal }).eq('id', id);
    // Recompute next_due locally NOW so the list behind the modal shows the
    // new date immediately (see _pendingSharedNextDue) — not only once the
    // debounced uploads land. previewLastDoneLatest mirrors the staging
    // logic exactly, including the clear-date case. Never strand the id.
    const sh = getSharedHabitForLocalHabit(habit);
    const effLatest = previewLastDoneLatest(sh?.completions || [], lastDoneVal ? habitDateInputToIso(lastDoneVal) : null);
    _pendingSharedNextDue.add(habit.shared_id);
    let newNextDue;
    const fin = {};
    try {
      newNextDue = await updateHabitNextDue(id, freq, effLatest, { earlyGuard: false, endDate: endDateVal, out: fin });
    } catch (e) {
      _pendingSharedNextDue.release(habit.shared_id);
      throw e;
    }
    // Optimistic: close the modal on local staging; the shared uploads run in
    // the background. A failure rolls the in-memory shared state back (adapter)
    // and refreshes the view.
    const upload = (async () => {
      // Single staged mutation: name, frequency, completions (if last-done
      // changed) and the recomputed next_due land in one debounced upload.
      // end_date / is_finished ride the same mutation — the finished state is
      // the recompute's outcome (fin), never the captured habit object.
      const changes = { name, frequency_rule: freq, next_due: newNextDue, end_date: endDateVal, is_finished: fin.isFinished ? 1 : 0 };
      if (lastDoneVal !== prevDateStr) {
        changes.completions = await computeSharedLastDoneCompletions(habit, lastDoneVal ? habitDateInputToIso(lastDoneVal) : null);
      }
      await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, changes);
    })();
    upload.then(
      () => {
        // Release the pending id. No re-render: the optimistic refresh
        // already shows the published values — a second full render
        // here would tear down in-flight edits and drags.
        _pendingSharedNextDue.release(habit.shared_id);
      },
      e => {
        _pendingSharedNextDue.release(habit.shared_id);
        console.warn('Failed to update shared habit:', e);
        refreshHabits();
        showToast(t('toast.update_failed'), 'error');
      }
    );
  } else {
    const { error } = await state.db.from('habits').update({ name, frequency_rule: freq, category: catName, category_id: catId, end_date: endDateVal }).eq('id', id);
    if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
    if (habit) habit.end_date = endDateVal;

    if (lastDoneVal !== prevDateStr) {
      try {
        latestForNextDue = await setLocalHabitLastDone(id, lastDoneVal ? habitDateInputToIso(lastDoneVal) : null);
      } catch (e) {
        console.warn('Failed to update habit completion:', e);
        showToast(t('toast.update_failed'), 'error');
        return;
      }
    }
    await updateHabitNextDue(id, freq, latestForNextDue, { earlyGuard: false, endDate: endDateVal });
  }

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
      const pointerRow = habit.shared_id ? { ...habit } : null;
      const { error } = await state.db.from('habits').delete().eq('id', habitId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }

      // If shared, also delete from Drive (removes for all group members).
      // The upload runs in the background; a failure restores the pointer row.
      if (habit.shared_id && habit.shared_group_id && state.sharing) {
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteSharedHabit(habit.shared_group_id, habit.shared_id, { onStaged });
        upload.then(
          () => {},
          async (e) => {
            console.warn('Failed to delete shared habit from Drive:', e);
            if (pointerRow) await state.db.from('habits').insert(pointerRow);
            await refreshHabits();
            showToast(t('toast.delete_failed'), 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
      }

      // Animate item out before re-rendering
      const el = document.querySelector(`[data-habit-id="${CSS.escape(habitId)}"]`);
      await animateItemRemoval(el);

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
// In-flight next_due publishes, tracked per shared habit id (see
// pending-next-due.js). While an id is present, refreshHabits trusts the
// locally recomputed next_due over shared storage (stale until the publish
// lands), so the new due date renders immediately instead of trailing the
// background upload by seconds. Reference-counted: overlapping mutations on
// the same habit must not release each other's marker.

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
      // Recompute next_due locally BEFORE staging: the optimistic refresh
      // below must render the new due date immediately (see
      // _pendingSharedNextDue) — not only once the debounced uploads land.
      // The whole pre-upload section is under the cleanup guarantee: a
      // throwing recompute OR actor lookup releases the marker, so it is
      // never stranded with no upload to settle it.
      const fin = {};
      _pendingSharedNextDue.add(habit.shared_id);
      let newNextDue;
      let completion;
      try {
        newNextDue = await updateHabitNextDue(habitId, habit.frequency_rule, now, { out: fin });
        // Optimistic: refresh on staging; the uploads run in the background.
        // A failure rolls the in-memory completion back (adapter) and refreshes.
        completion = {
          id: crypto.randomUUID(),
          completed_at: now,
          completed_by: await getSharedHabitCompletionActor(habit.shared_group_id),
        };
      } catch (e) {
        _pendingSharedNextDue.release(habit.shared_id);
        throw e;
      }
      let onStaged;
      const staged = new Promise(resolve => { onStaged = resolve; });
      const upload = (async () => {
        // Publish the locally recomputed next_due in the same staged mutation
        // so other members read it directly — one debounced upload, not two.
        await state.sharing.addSharedHabitCompletion(habit.shared_group_id, habit.shared_id, completion, { onStaged, next_due: newNextDue, is_finished: fin.isFinished ? 1 : 0 });
      })();
      upload.then(
        () => {
          // Release the pending id. No re-render: the optimistic refresh
          // already shows the published values — a second full render
          // here would tear down in-flight edits and drags.
          _pendingSharedNextDue.release(habit.shared_id);
        },
        async (e) => {
          _pendingSharedNextDue.release(habit.shared_id);
          console.warn('Failed to push shared habit completion:', e);
          await refreshHabits();
          showToast(t('habits.failed_record'), 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
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
        // Recompute next_due locally BEFORE staging so the optimistic
        // refresh renders the new date immediately (see
        // _pendingSharedNextDue) — not only once the debounced uploads land.
        // previewLastDoneLatest mirrors the staging logic exactly (clear,
        // rewrite and future-completion pruning). Never strand the id.
        const sh = getSharedHabitForLocalHabit(habit);
        const effLatest = previewLastDoneLatest(sh?.completions || [], newIso);
        _pendingSharedNextDue.add(habit.shared_id);
        let newNextDue;
        const fin = {};
        try {
          newNextDue = await updateHabitNextDue(habitId, habit.frequency_rule, effLatest, { earlyGuard: false, out: fin });
        } catch (e) {
          _pendingSharedNextDue.release(habit.shared_id);
          throw e;
        }
        // Optimistic: refresh on staging; the shared uploads run in the
        // background. A failure rolls the in-memory state back (adapter)
        // and refreshes the view.
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = (async () => {
          latestForNextDue = await setSharedHabitLastDone(habit, newIso, { onStaged, next_due: newNextDue, is_finished: fin.isFinished ? 1 : 0 });
        })();
        upload.then(
          () => {
            // Release the pending id. No re-render: the optimistic refresh
            // already shows the published values — a second full render
            // here would tear down in-flight edits and drags.
            _pendingSharedNextDue.release(habit.shared_id);
          },
          (e) => {
            _pendingSharedNextDue.release(habit.shared_id);
            console.warn('Failed to update habit completion:', e);
            refreshHabits();
            showToast(t('toast.failed_to_update'), 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
      } else {
        latestForNextDue = await setLocalHabitLastDone(habitId, newIso);
        if (habit) {
          await updateHabitNextDue(habitId, habit.frequency_rule, latestForNextDue, { earlyGuard: false });
        }
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
    // The native date-picker popup may fire blur while staying open.
    // Wait long enough for the popup interaction to finish, then clean up
    // only if the input truly lost focus and no save happened.
    setTimeout(() => {
      if (!didSave && document.contains(input) && document.activeElement !== input) {
        const restored = span.cloneNode(true);
        input.replaceWith(restored);
      }
    }, 300);
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
  const histModal = document.getElementById('habitHistoryModal');
  histModal.innerHTML = habitHistoryModalHTML();
  renderHabitHistoryList(habitId, habit);
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
      const dateStr = d.toLocaleDateString(getLang(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
  const dateStr = new Date(comp.completed_at).toLocaleDateString(getLang(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  showConfirmAction(
    t('common.delete'),
    'Are you sure you want to delete this completion record?',
    async () => {
      if (habit?.shared_id && habit?.shared_group_id && state.sharing) {
        // ─── Shared: remove from shared completions (optimistic) ───
        const sharedHabits = state.sharing.getAllSharedHabits();
        const sh = sharedHabits.find(h => h.id === habit.shared_id);
        if (sh?.completions) {
          const idx = sh.completions.findIndex(c => c.id === comp.id || c.completed_at === comp.completed_at);
          // Fresh array (no in-place splice) so the adapter rollback can restore it.
          const nextCompletions = idx >= 0
            ? [...sh.completions.slice(0, idx), ...sh.completions.slice(idx + 1)]
            : [...sh.completions];
          // Recompute next_due from new latest completion (or null if none left)
          const latest = nextCompletions.length ? nextCompletions[nextCompletions.length - 1].completed_at : null;
          // Register before the recompute (see _pendingSharedNextDue): a
          // refresh racing the awaits must not clobber the fresh local
          // value. Never strand the id if the recompute throws.
          _pendingSharedNextDue.add(habit.shared_id);
          let newNextDue;
          const fin = {};
          try {
            newNextDue = await updateHabitNextDue(habit.id, habit.frequency_rule, latest, { earlyGuard: false, out: fin });
          } catch (e) {
            _pendingSharedNextDue.release(habit.shared_id);
            throw e;
          }
          // The uploads run in the background: a failure rolls the in-memory
          // shared item back (adapter) and refreshes the view.
          const upload = (async () => {
            // Publish the recompute's return value, not habit.next_due: the
            // closure's habit object can go stale if a refresh replaces
            // state.allHabits before this runs.
            await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, { completions: nextCompletions, next_due: newNextDue, is_finished: fin.isFinished ? 1 : 0 });
          })();
          upload.then(
            // No success re-render (see below): the failure branch still
            // refreshes to roll the optimistic staging back.
            () => {
              // Release the pending id. No re-render: the optimistic refresh
              // already shows the published values — a second full render
              // here would tear down in-flight edits and drags.
              _pendingSharedNextDue.release(habit.shared_id);
            },
            e => {
              _pendingSharedNextDue.release(habit.shared_id);
              console.warn('Failed to delete shared habit completion:', e);
              refreshHabits();
              showToast(t('toast.failed_to_delete'), 'error');
            }
          );
        }
      } else {
        // ─── Normal: delete from local DB ───
        const { error } = await state.db.from('habit_completions').delete().eq('id', compId);
        if (error) { showToast(t('toast.failed_to_delete'), 'error'); return; }
      }

      showToast(t('habits.completion_deleted'), 'success');
      await refreshHabits();
      if (state._historyHabitId) {
        const h = state.allHabits.find(x => String(x.id) === String(state._historyHabitId));
        const comps = state.allHabitCompletions
          .filter(c => String(c.habit_id) === String(state._historyHabitId))
          .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
        const latest = comps.length ? comps[comps.length - 1].completed_at : null;
        if (h) await updateHabitNextDue(h.id, h.frequency_rule, latest, { earlyGuard: false });
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
      <div class="habit-history-edit-actions modal-actions">
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
    // ─── Shared: update in shared completions (optimistic) ───
    const sharedHabits = state.sharing.getAllSharedHabits();
    const sh = sharedHabits.find(h => h.id === habit.shared_id);
    const sharedComp = sh?.completions?.find(c => c.id === comp.id || c.completed_at === oldCompletedAt);
    if (sharedComp) {
      // Fresh array (no in-place mutation) so the adapter rollback can restore it.
      const nextCompletions = sh.completions.map(c =>
        c === sharedComp ? { ...c, completed_at: newDate } : c);
      // Recompute next_due from latest completion
      const latest = nextCompletions[nextCompletions.length - 1]?.completed_at || null;
      // Register before the recompute (see _pendingSharedNextDue); never
      // strand the id if the recompute throws.
      _pendingSharedNextDue.add(habit.shared_id);
      let newNextDue;
      const fin = {};
      try {
        newNextDue = await updateHabitNextDue(habit.id, habit.frequency_rule, latest, { earlyGuard: false, out: fin });
      } catch (e) {
        _pendingSharedNextDue.release(habit.shared_id);
        throw e;
      }
      // The uploads run in the background: a failure rolls the in-memory
      // shared item back (adapter) and refreshes the view.
      const upload = (async () => {
        // Publish the recompute's return value, not habit.next_due (stale
        // closure — see markHabitDone).
        await state.sharing.updateSharedHabit(habit.shared_group_id, habit.shared_id, { completions: nextCompletions, next_due: newNextDue, is_finished: fin.isFinished ? 1 : 0 });
      })();
      upload.then(
        // No success re-render (see below): the failure branch still
        // refreshes to roll the optimistic staging back.
        () => {
          // Release the pending id. No re-render: the optimistic refresh
          // already shows the published values — a second full render
          // here would tear down in-flight edits and drags.
          _pendingSharedNextDue.release(habit.shared_id);
        },
        e => {
          _pendingSharedNextDue.release(habit.shared_id);
          console.warn('Failed to update shared habit completion:', e);
          refreshHabits();
          showToast(t('toast.failed_to_update'), 'error');
        }
      );
    }
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
    const h = state.allHabits.find(x => String(x.id) === String(state._historyHabitId));
    const comps = state.allHabitCompletions
      .filter(c => String(c.habit_id) === String(state._historyHabitId))
      .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
    const latest = comps.length ? comps[comps.length - 1].completed_at : null;
    if (h) await updateHabitNextDue(h.id, h.frequency_rule, latest, { earlyGuard: false });
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
  const modal = document.getElementById('addHabitCategoryModal');
  modal.innerHTML = addHabitCategoryModalHTML();
  document.getElementById('newHabitCategoryName').value = '';
  document.getElementById('newHabitCategoryShortname').value = '';
  document.getElementById('newHabitCategoryColor').value = nextPaletteColor(_habitCatMap);
  modal.classList.add('visible');
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
  const shortname = document.getElementById('newHabitCategoryShortname').value.trim() || null;
  const color = document.getElementById('newHabitCategoryColor').value;
  const sortOrder = Math.max(0, ...Array.from(_habitCatMap.values()).map(c => c.sort_order || 0)) + 1;
  const { error } = await state.db.from('habit_categories').insert({ name, shortname, color, sort_order: sortOrder });
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
    // Snapshots for rollback.
    const catRow = { ...cat };
    const habitRows = habitsInCat.map(h => ({ ...h }));
    // Delete locally first to unblock the UI. Explicitly delete items so
    // calendar sync (markDirty) fires for each. SQL CASCADE would handle this
    // on SQLite, but Drive/Demo have no FK enforcement.
    for (const habit of habitsInCat) {
      await state.db.from('habits').delete().eq('id', habit.id);
    }
    const { error } = await state.db.from('habit_categories').delete().eq('id', catId);
    if (error) { showToast(t('toast.delete_failed') + ': ' + error.message, 'error'); return; }
    showToast(t('habits.category_deleted', cat.name), 'info');
    await refreshHabits();
    // Propagate deletion of shared habits to the sharing layer in the
    // background (sequential, etag order). A failure restores the category
    // and its habits locally.
    if (state.sharing) {
      const sharedHabits = habitsInCat.filter(h => h.shared_id && h.shared_group_id);
      if (sharedHabits.length) {
        const upload = (async () => {
          for (const habit of sharedHabits) {
            await state.sharing.deleteItem(habit.shared_group_id, habit.shared_id);
          }
        })();
        upload.catch(async (e) => {
          console.warn('Failed to delete shared habits from Drive:', e);
          await state.db.from('habit_categories').insert(catRow);
          for (const r of habitRows) await state.db.from('habits').insert(r);
          await refreshHabits();
          showToast(t('toast.delete_failed'), 'error');
        });
      }
    }
  });
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

// Calendar sync: fingerprint of the shared-payload fields that feed calendar
// events. Remote changes (another member completes the habit) touch only the
// shared payload, never the local pointer row, so the adapter's dirty
// tracking can't see them — diff here and mark the pointer dirty instead.
const _sharedHabitCalFp = new Map();
// Last-seen updated_at per shared habit: detects remote content edits, which
// change the in-memory item (and therefore the rendered view) without
// touching any local pointer row.
const _sharedHabitSeenAt = new Map();
function sharedHabitCalFingerprint(sh) {
  return JSON.stringify([
    sh.next_due || null,
    sh.name || '',
    sh.frequency_rule || '',
    sh.creator_category || '',
    sh.group_name || '',
  ]);
}
let _bulkShareInProgress = new Set();
const _pendingShare = new Set();
// Consecutive syncs in which a shared habit was missing from shared storage.
// The pointer cleanup only deletes after two consecutive misses: a single
// empty read is treated as transient (in-flight flush, momentary read skew)
// and must never wipe local pointers.
const _syncMissStrikes = new Map();

async function syncSharedHabits() {
  if (_syncingHabits) return false;
  _syncingHabits = true;
  try {
    return await _doSyncSharedHabits();
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

    // Repair old pointers created before the shared record id was canonical.
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

    // Skip items this tab staged but hasn't planted a pointer for yet —
    // the share flow inserts the real pointer right after staging. Without
    // this the sync would plant a __shared__-category duplicate.
    if (state.sharing.hasPendingCreate(sh.group_id, sh.id)) continue;
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

  // ─── Calendar: mark pointers dirty when a remote change touched event fields ───
  // (first sight only initializes the fingerprint — pointer creation already dirties)
  // A rename or remote edit writes no local row, so no Drive flush would consume
  // the dirty marks — drive the calendar sync directly when anything was marked.
  let calDirtyMarked = false;
  for (const sh of sharedHabits) {
    const fp = sharedHabitCalFingerprint(sh);
    const prev = _sharedHabitCalFp.get(sh.id);
    _sharedHabitCalFp.set(sh.id, fp);
    if (prev !== undefined && prev !== fp) {
      const pointer = localBySharedId.get(sh.id);
      if (pointer) { state.markCalDirty?.('habits', pointer.id); calDirtyMarked = true; }
    }
    // Remote content edits bump updated_at on every mutation — a change here
    // means the rendered habit changed even though no pointer row moved.
    const prevSeen = _sharedHabitSeenAt.get(sh.id);
    _sharedHabitSeenAt.set(sh.id, sh.updated_at);
    if (prevSeen !== undefined && prevSeen !== sh.updated_at) needsRefresh = true;
  }
  if (calDirtyMarked) await state.syncCalendarTable?.('habits');

  // Clean up pointers for removed shared habits
  for (const local of localShared) {
    const strikeKey = local.shared_group_id + ':' + local.shared_id;
    if (!driveSharedIds.has(local.shared_id)) {
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        // Require two consecutive misses before deleting: a single empty
        // read (transient skew around a flush) must never wipe pointers.
        const strikes = (_syncMissStrikes.get(strikeKey) || 0) + 1;
        if (strikes < 2) {
          _syncMissStrikes.set(strikeKey, strikes);
          continue;
        }
        _syncMissStrikes.delete(strikeKey);
        // Group exists but item gone from remote → delete local pointer
        await state.db.from('habits').delete().eq('id', local.id);
        _sharedHabitSeenAt.delete(local.shared_id);
        needsRefresh = true;
      } else {
        // Group not loaded — transient skip, or the group was dropped and its
        // pointers were already purged. Leave the pointer; the next sync
        // re-evaluates it.
      }
    } else {
      // Seen — clear any pending strike.
      _syncMissStrikes.delete(strikeKey);
    }
  }

  return needsRefresh;
}

window.syncSharedHabits = syncSharedHabits;

document.addEventListener('input', e => {
  if (e.target.tagName === 'TEXTAREA' && (e.target.classList.contains('habit-add-input') || e.target.id === 'newHabitName' || e.target.id === 'editHabitName')) {
    autoResizeTextarea(e.target);
  }
});

export { refreshHabits, renderHabits, initHabitModals, formatFrequency, formatHabitDue, habitDueStatus, getHabitLastDone, formatHabitRelative, getHabitCompletionCount, updateHabitNextDue, habitFinishedFor, initHabitHoverDelay, isStructuredRule, normalizeFrequencyRule, STRUCTURED_PREFIXES, syncSharedHabits, loadHabitCategories, getHabitCategories, getHabitCategoryColor, getHabitCatColor, catIdForHabit, getHabitCatDisplayName, computeNextDue };

window.setHabitFilter = setHabitFilter;
window.openAddHabitModal = openAddHabitModal;
window.shareHabitFromAdd = shareHabitFromAdd;

async function shareExistingHabit(id, el) {
  if (!state.sharing) return;
  if (_pendingShare.has(id)) return;
  const habit = state.allHabits.find(h => h.id === id);
  if (!habit || habit.shared_id) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-habit"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    if (_pendingShare.has(id)) return;
    _pendingShare.add(id);
    if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
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
      const lastDone = localCompletions.length ? localCompletions[localCompletions.length - 1].completed_at : null;
      let nextDue = isStructuredRule(habit.frequency_rule)
        ? normalizeHabitNextDue(computeNextDue(habit.frequency_rule, lastDone))
        : null;
      // The end date travels with the habit; a recomputed due past it means
      // the shared copy starts finished, like the personal one was.
      const sharedFinished = habitFinishedFor(nextDue, habit.end_date || null);
      if (sharedFinished) nextDue = null;
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
      if (habit.end_date) sharedItem.end_date = habit.end_date;
      if (sharedFinished) sharedItem.is_finished = 1;
      if (nextDue != null) sharedItem.next_due = nextDue;
      // 1. Stage the shared item in memory first: this marks the created
      // intent and the dirty type, so the poll skips it and the
      // orphan-pointer cleanup can't see a pointer whose item isn't staged.
      // Snapshots allow a full rollback if the Drive upload fails.
      const personalHabit = { ...habit };
      const personalCompletions = (state.allHabitCompletions || [])
        .filter(c => c.habit_id === habit.id)
        .map(c => ({ ...c }));
      let onStaged;
      let wasStaged = false;
      const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
      let localStaged = false;
      let pointerId = null;
      // 2. The shared upload runs in the background: success toasts, failure
      // restores the personal habit and its completions and drops the
      // pointer — but only when the local staging below actually happened.
      const upload = state.sharing.addSharedHabit(groupId, sharedItem, { onStaged });
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (e) => {
          console.error('[DeLaClaw] share existing habit failed:', e);
          if (localStaged) {
            if (pointerId) await state.db.from('habits').delete().eq('id', pointerId);
            await state.db.from('habits').insert(personalHabit);
            for (const c of personalCompletions) await state.db.from('habit_completions').insert(c);
            await refreshHabits();
          }
          showToast(e.message, 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      if (!wasStaged) return;
      // 3. Stage locally: pointer in, personal habit + completions out.
      const { data: pointer, error: ptrErr } = await state.db.from('habits').insert({
        name: '', frequency_rule: '', category: catRow?.name ?? habit.category ?? '',
        category_id: habit.category_id || _defaultHabitCatId, is_draft: 0,
        shared_id: sharedId, shared_group_id: groupId, next_due: nextDue,
        end_date: habit.end_date || null, is_finished: sharedFinished ? 1 : 0,
      }).select().single();
      if (ptrErr) {
        // Back out the staged shared item — it hasn't uploaded yet.
        state.sharing.deleteSharedHabit(groupId, sharedId).catch(() => {});
        showToast(ptrErr.message, 'error');
        return;
      }
      await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
      await state.db.from('habits').delete().eq('id', habit.id);
      pointerId = pointer?.id;
      localStaged = true;
      await refreshHabits();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      _pendingShare.delete(id);
      if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
    }
  }, { showAssignees: false });
}
window.shareExistingHabit = shareExistingHabit;

// ── Bulk share all personal habits in a category ──
async function bulkShareHabitCategory(catId, el) {
  if (!state.sharing) return;
  if (_bulkShareInProgress.has(catId)) return;
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
        if (_bulkShareInProgress.has(catId)) return;
        _bulkShareInProgress.add(catId);
        if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
        try {
          const actor = await getSharedHabitCompletionActor(groupId);
          // Stage each item in the shared memory first, then plant the local
          // pointer: the created intent and dirty type keep the poll and the
          // orphan-pointer cleanup from misreading the in-between state. The
          // debounced flush uploads everything in one go.
          const staged = [];
          for (const habit of items) {
            const sharedId = crypto.randomUUID();
            const catRow = _habitCatMap.get(habit.category_id || _defaultHabitCatId);
            const localCompletions = (state.allHabitCompletions || [])
              .filter(c => c.habit_id === habit.id)
              .map(c => ({ id: crypto.randomUUID(), completed_at: c.completed_at, completed_by: actor }));
            const lastDone = localCompletions.length ? localCompletions[localCompletions.length - 1].completed_at : null;
            let nextDue = isStructuredRule(habit.frequency_rule)
              ? normalizeHabitNextDue(computeNextDue(habit.frequency_rule, lastDone))
              : null;
            const sharedFinished = habitFinishedFor(nextDue, habit.end_date || null);
            if (sharedFinished) nextDue = null;
            const sharedItem = {
              id: sharedId, item_type: 'habit',
              name: habit.name, frequency_rule: habit.frequency_rule,
              creator_category: catRow?.name ?? habit.category ?? '',
              created_by: actor,
              created_at: habit.created_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completions: localCompletions,
            };
            if (habit.end_date) sharedItem.end_date = habit.end_date;
            if (sharedFinished) sharedItem.is_finished = 1;
            if (nextDue != null) sharedItem.next_due = nextDue;
            // Snapshots for rollback — taken before the local deletes below.
            const personalHabit = { ...habit };
            const personalCompletions = (state.allHabitCompletions || [])
              .filter(c => c.habit_id === habit.id).map(c => ({ ...c }));
            let onStaged;
            let wasStaged = false;
            const stagedP = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
            const upload = state.sharing.addSharedHabit(groupId, sharedItem, { onStaged });
            await Promise.race([stagedP, upload.then(() => {}, () => {})]);
            if (!wasStaged) {
              console.error('[DeLaClaw] bulk share habit staging failed:', sharedId);
              continue;
            }
            const { data: pointer, error: ptrErr } = await state.db.from('habits').insert({
              name: '', frequency_rule: '', category: catRow?.name ?? habit.category ?? '',
              category_id: habit.category_id || _defaultHabitCatId, is_draft: 0,
              created_at: habit.created_at || new Date().toISOString(),
              shared_id: sharedId, shared_group_id: groupId, next_due: nextDue,
              end_date: habit.end_date || null, is_finished: sharedFinished ? 1 : 0,
            }).select().single();
            if (ptrErr) {
              // Back out the staged shared item — it hasn't uploaded yet.
              state.sharing.deleteSharedHabit(groupId, sharedId).catch(() => {});
              continue;
            }
            await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
            await state.db.from('habits').delete().eq('id', habit.id);
            staged.push({
              sharedId,
              upload,
              personalHabit,
              personalCompletions,
              pointerId: pointer?.id,
            });
          }
          // Unblock the UI on staging.
          await refreshHabits();
          _bulkShareInProgress.delete(catId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
          let ok = 0;
          for (const s of staged) {
            try {
              await s.upload;
              ok++;
            } catch (e) {
              console.error('[DeLaClaw] bulk share habit failed:', e);
              if (s.pointerId) await state.db.from('habits').delete().eq('id', s.pointerId);
              await state.db.from('habits').insert(s.personalHabit);
              for (const c of s.personalCompletions) await state.db.from('habit_completions').insert(c);
            }
          }
          await refreshHabits();
          if (ok === staged.length && ok > 0) showToast(t('sharing.share_all_done', ok), 'success');
          else if (ok > 0) showToast(t('sharing.share_all_partial', ok, staged.length), 'error');
          else if (staged.length > 0) showToast(t('toast.failed_to_add'), 'error');
        } finally {
          _bulkShareInProgress.delete(catId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
        }
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
        // Snapshots for rollback: pointer row + its completions.
        const pointerRow = { ...habit };
        const pointerCompletions = (state.allHabitCompletions || [])
          .filter(c => c.habit_id === habit.id).map(c => ({ ...c }));
        // 1. Create personal habit
        const { data: newHabit, error: insErr } = await state.db.from('habits').insert({
          name: habit.name || '',
          frequency_rule: habit.frequency_rule || '',
          category: catRow?.name ?? habit.category ?? '',
          category_id: habit.category_id || _defaultHabitCatId,
          is_draft: 0,
          next_due: habit.next_due || null,
          end_date: habit.end_date || null,
          is_finished: habit.is_finished ? 1 : 0,
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
        // 3. Delete local pointer + its completions
        await state.db.from('habit_completions').delete().eq('habit_id', habit.id);
        await state.db.from('habits').delete().eq('id', habit.id);
        // 4. Unblock the UI on local staging; the shared delete runs in the
        // background. A failure drops the personal copy and restores the pointer.
        await refreshHabits();
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteSharedHabit(habit.shared_group_id, habit.shared_id, { onStaged });
        upload.then(
          () => showToast(t('sharing.unshared'), 'success'),
          async (e) => {
            console.warn('Failed to delete shared habit from Drive:', e);
            await state.db.from('habit_completions').delete().eq('habit_id', newHabit.id);
            await state.db.from('habits').delete().eq('id', newHabit.id);
            await state.db.from('habits').insert(pointerRow);
            for (const c of pointerCompletions) await state.db.from('habit_completions').insert(c);
            await refreshHabits();
            showToast(e.message, 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
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
      end_date: habit.end_date || null,
      is_finished: habit.is_finished ? 1 : 0,
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

// ===================================================================
// HABIT BATCH IMPORT
// ===================================================================
// Thin wrapper over the shared import shell (js/batch-import.js), mirroring
// the TODO import: Convert via LLM prompt / Upload JSON → paste → review →
// create. Per-item "category" names are created on confirm when missing;
// "group_id" must be a group the user belongs to (names aren't unique).
// next_due is computed purely from the frequency rule (same as new habits);
// calendar events come free via the Drive adapter's dirty marking.

function buildHabitImportPrompt(selectedCatNames, groups) {
  const catLine = selectedCatNames.length > 0
    ? `- "category": assign each habit to exactly one of these categories: ${selectedCatNames.map(n => `"${n}"`).join(', ')}. If none fits, you may propose a new category name.`
    : `- "category": a category name for the habit (a short label like "Health" or "Learning").`;
  const groupLine = (groups && groups.length > 0)
    ? `- "group_id": only for habits shared with a group; use one of these group ids: ${groups.map(g => `"${g.name}" → "${g.id}"`).join(', ')}. Omit otherwise.`
    : `- "group_id": only for habits shared with a group; omit otherwise (optional)`;
  return `Convert the following text into habits for DeLaClaw, a personal task manager (delaclaw.com).

Output a JSON array of objects, each with:
- "name": string (required, the habit)
- "frequency": string (required) — one of:
  - "every_N_days:N" (e.g. "every_N_days:1" for daily, "every_N_days:2" for every 2 days)
  - "every_N_weeks:N:Day1,Day2" (e.g. "every_N_weeks:1:Mon,Wed,Fri"; days: Mon Tue Wed Thu Fri Sat Sun)
  - "every_N_months:N:D" (e.g. "every_N_months:1:15" for monthly on the 15th)
  - "yearly:MM-DD" (e.g. "yearly:06-15")
${catLine}
${groupLine}

Example:
[
  { "name": "Read 20 pages", "frequency": "every_N_days:1", "category": "General" },
  { "name": "Gym", "frequency": "every_N_weeks:1:Mon,Wed,Fri", "category": "Health" }
]

Output ONLY valid JSON, no markdown fences, no commentary.

Paste your text below and I will convert it:`;
}

const HABIT_IMPORT_FREQ_EXAMPLES = [
  'every_N_days:1',
  'every_N_weeks:1:Mon,Wed,Fri',
  'every_N_months:1:1',
  'yearly:01-01',
];

window.openHabitImportModal = async function() {
  const { openBatchImportModal, ensureImportCategories, chunkedBatchInsert } = await import('./batch-import.js');
  const { parseHabitImportJSON, validateHabitImportItem } = await import('./habit-import.js');

  const cats = Array.from(_habitCatMap.values())
    .filter(c => c.name !== SHARED_CATEGORY)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const groups = (state.sharing && state.sharing.isReady()) ? state.sharing.getAllGroups() : [];

  await openBatchImportModal({
    modalId: 'importHabitModal',
    title: t('habits.import_title'),
    subtitle: t('habits.import_subtitle'),
    convertTitle: t('habits.import_convert_title'),
    convertDesc: t('habits.import_convert_desc'),
    uploadTitle: t('habits.import_upload_title'),
    uploadDesc: t('habits.import_upload_desc'),
    categoriesLabel: t('habits.import_categories_label'),
    selectAll: t('habits.import_select_all'),
    deselectAll: t('habits.import_deselect_all'),
    step1: t('habits.import_step1'),
    copy: t('habits.import_copy'),
    copied: t('habits.import_copied'),
    step2: t('habits.import_step2'),
    step3: t('habits.import_step3'),
    pastePlaceholder: t('habits.import_paste_placeholder'),
    uploadFile: t('habits.import_upload_file'),
    review: t('habits.import_review'),
    back: t('habits.import_back'),
    backToPaste: t('habits.import_back_to_paste'),
    ready: n => t('habits.import_ready', n),
    andMore: n => t('habits.import_and_more', n),
    reviewHeader: n => t('habits.import_review_header', n),
    selectedCount: (a, b) => t('habits.import_selected_count', a, b),
    confirm: n => t('habits.import_confirm', n),
    importing: t('habits.import_importing'),
    success: n => t('habits.import_success', n),
    failedPrefix: t('habits.import_failed'),
    newCategory: t('habits.import_new_category'),

    categories: [{ name: '', display: t('common.category_default') },
      ...cats.map(c => ({ name: c.name, display: c.name }))],
    promptDefaultCategory: 'General',
    groups: groups.map(g => ({ id: g.id, name: g.name })),
    sharingReady: !!(state.sharing && state.sharing.isReady()),

    buildPrompt: buildHabitImportPrompt,
    parse: parseHabitImportJSON,
    validate: validateHabitImportItem,
    getTitle: it => it.name,
    fields: [
      { key: 'name', label: t('habits.import_field_name'), type: 'text' },
      { key: 'frequency_rule', label: t('habits.import_field_frequency'), type: 'datalist', options: HABIT_IMPORT_FREQ_EXAMPLES },
      { key: 'category', label: t('habits.import_field_category'), type: 'datalist',
        options: ['General', ...cats.map(c => c.name)] },
      { key: 'group_id', label: t('habits.import_field_group'), type: 'grouplist' },
    ],
    previewMeta: (it) => {
      const nc = (it.categoryIsNew && it.category) ? ` <span class="import-badge new-cat">${t('habits.import_new_category')}</span>` : '';
      const grp = it.groupName ? ` <span class="import-badge">${esc(it.groupName)}</span>` : '';
      const freq = it.frequency_rule ? ` <span class="import-preview-cat">${esc(it.frequency_rule)}</span>` : '';
      const cat = it.category ? ` <span class="import-preview-cat">${esc(it.category)}</span>` : '';
      return `${freq}${cat}${nc}${grp}`;
    },
    reviewBadges: (it, errors) => {
      let html = '';
      if (it.categoryIsNew && it.category) html += `<span class="import-badge new-cat">${t('habits.import_new_category')}: ${esc(it.category)}</span>`;
      if (errors.length > 0) {
        html += `<div class="import-item-errors">${errors.map(e => `<span>${esc(e.message)}</span>`).join('')}</div>`;
      }
      return html;
    },

    ensureCategories: (names) => ensureImportCategories(names, {
      table: 'habit_categories', getMap: () => _habitCatMap, reload: loadHabitCategories,
    }),

    createItems: async (validItems, catMap) => {
      const resolveCat = (name) => {
        if (!name) return { id: _defaultHabitCatId, name: '' };
        const hit = catMap.get(name.toLowerCase());
        return hit ? { id: hit.id, name: hit.name } : { id: _defaultHabitCatId, name: '' };
      };

      const personalRows = [];
      const sharedItems = [];
      for (const it of validItems) {
        const { id: catId, name: catName } = resolveCat(it.category);
        // next_due computed purely — a new habit has no history to guard.
        const nextDue = it.frequency_rule ? normalizeHabitNextDue(computeNextDue(it.frequency_rule, null)) : null;
        if (it.group_id) sharedItems.push({ ...it, catId, catName, nextDue });
        else personalRows.push({
          name: it.name, frequency_rule: it.frequency_rule,
          category: catName, category_id: catId, is_draft: 0, next_due: nextDue,
        });
      }

      await chunkedBatchInsert('habits', personalRows);

      // Shared: same two-step as manual shared-habit creation
      // (addSharedHabit staged in memory + local pointer row).
      for (const it of sharedItems) {
        const sharedId = crypto.randomUUID();
        const actor = await getSharedHabitCompletionActor(it.group_id);
        const now = new Date().toISOString();
        const sharedItem = {
          id: sharedId, item_type: 'habit', name: it.name,
          frequency_rule: it.frequency_rule, creator_category: it.catName,
          created_by: actor, created_at: now, updated_at: now,
          completions: [],
        };
        if (it.nextDue != null) sharedItem.next_due = it.nextDue;
        let onStaged;
        let wasStaged = false;
        const stagedP = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
        const upload = state.sharing.addSharedHabit(it.group_id, sharedItem, { onStaged });
        await Promise.race([stagedP, upload.then(() => {}, () => {})]);
        if (!wasStaged) throw new Error(`Could not stage "${it.name}" in the group`);
        const { data, error: ptrErr } = await state.db.from('habits').insert({
          name: '', frequency_rule: '', category: it.catName, category_id: it.catId, is_draft: 0,
          shared_id: sharedId, shared_group_id: it.group_id, next_due: it.nextDue,
        }).select().single();
        if (ptrErr) {
          state.sharing.deleteSharedHabit(it.group_id, sharedId).catch(() => {});
          throw new Error(ptrErr.message);
        }
        upload.then(() => {}, async () => {
          if (data?.id) await state.db.from('habits').delete().eq('id', data.id);
          await refreshHabits();
          showToast(`${t('habits.import_failed')} "${it.name}"`, 'error');
        });
      }
    },

    afterCreate: refreshHabits,
  });
};
