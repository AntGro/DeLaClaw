// ===================================================================
// frequency-rule.js — Pure structured frequency_rule helpers.
//
// Single source of truth for habit frequency rules (moved out of
// js/habits.js so Node contexts — tests, the import validator — can use
// them without the browser module; js/habits.js re-exports them).
// Structured frequency_rule formats:
//   daily, every_N_days:X, weekly:Mon,Wed,Fri, every_N_weeks:2:Mon,
//   monthly:1, monthly_weekday:first:Mon, every_N_months:3:1, yearly:MM-DD
// Custom (free-text) rules → next_due = null → heartbeat handles them.
// computeNextDue lives here too (moved from js/habits.js) so migrations
// and Node contexts share the single source of truth for next_due.
// ===================================================================

import { parseLocalDate } from './calendar-pure.js';

export const STRUCTURED_PREFIXES = ['every_N_days:', 'every_N_weeks:', 'every_N_months:', 'yearly:'];
export const DOW_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DOW_JS   = [1, 2, 3, 4, 5, 6, 0]; // JS getDay(): Sun=0

export function isStructuredRule(rule) {
  if (!rule) return false;
  return STRUCTURED_PREFIXES.some(p => rule === p.replace(/:$/, '') || rule.startsWith(p));
}

/** Convert legacy frequency_rule formats to the consolidated format.
 *  daily → every_N_days:1, weekly:X → every_N_weeks:1:X,
 *  monthly:X → every_N_months:1:X, monthly_weekday:X:Y → every_N_months:1:X:Y */
export function normalizeFrequencyRule(rule) {
  if (!rule) return rule;
  if (rule === 'daily') return 'every_N_days:1';
  if (rule.startsWith('weekly:')) return 'every_N_weeks:1:' + rule.slice(7);
  if (rule.startsWith('monthly_weekday:')) return 'every_N_months:1:' + rule.slice(16);
  if (rule.startsWith('monthly:') && !rule.startsWith('monthly_weekday:')) return 'every_N_months:1:' + rule.slice(8);
  return rule;
}

/**
 * The 2.27.0 migration's per-habit decision: the corrected
 * { next_due, is_finished } for a habit — a pure recompute,
 * next_due = f(rule, latest completion) — or null when the habit
 * must be left alone (free-text rule: next_due is not derivable;
 * no completion: no last done to anchor on, the stored first due
 * date stands).
 *
 * Pure means it can move a due date earlier than the stored one,
 * including resurrecting an occurrence an early completion had
 * skipped (updateHabitNextDue's guard) — accepted for this one-shot
 * repair migration (Antoine's call, Oct 2026: beta stage, the simple
 * semantics win). The finished state follows the recomputed value
 * exactly like the app's recompute choke point: strictly past
 * end_date → finished, next_due cleared.
 */
export function recomputeNextDueForMigration(habit, lastDoneRaw) {
  const rule = normalizeFrequencyRule(habit.frequency_rule || '');
  if (!isStructuredRule(rule)) return null;
  if (!lastDoneRaw) return null;
  const candidate = computeNextDue(rule, lastDoneRaw);
  if (!candidate) return null;
  const endDate = habit.end_date ? String(habit.end_date).slice(0, 10) : null;
  const finished = !!(endDate && candidate > endDate);
  return { next_due: finished ? null : candidate, is_finished: finished ? 1 : 0 };
}


/** Format a Date as YYYY-MM-DD in local time (not UTC). */
export function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Returns the next due date after lastDoneDate, which may be in the past:
// a habit neglected for more than one period is overdue, and the UI has a
// dedicated overdue state for exactly that (never clamp to today here).
export function computeNextDue(frequencyRule, lastDoneDate) {
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
      if (noHistory) {
        let next = new Date(baseDay.getFullYear(), baseDay.getMonth(), dom);
        if (next <= baseDay) next = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, dom);
        return localDateStr(next);
      }
      // A completion anchors the cycle in its own month and covers that
      // month's occurrence — early, on the day, or late (the same premise
      // as the early-completion skip in updateHabitNextDue). The next due
      // is the day-of-month N months on, never a date later in the
      // completion's own month: 'every 6 months on the 28th' done Aug 14
      // is due Feb 28, not Aug 28.
      return localDateStr(new Date(baseDay.getFullYear(), baseDay.getMonth() + n, dom));
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

      // With a completion, the same anchor rule as day-of-month mode:
      // the completion covers its own month's occurrence(s), so the
      // next due is N months on. Without history, the first occurrence
      // from today stands.
      if (!noHistory) {
        const nextMonth = new Date(baseDay.getFullYear(), baseDay.getMonth() + n, 1);
        const anchored = findPositionWeekdays(nextMonth.getFullYear(), nextMonth.getMonth(), dayIndices, position);
        return anchored.length ? localDateStr(anchored[0]) : null;
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
