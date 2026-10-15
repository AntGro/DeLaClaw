// ===================================================================
// calendar-pure.js — Dependency-free date logic for the Calendar page.
//
// No imports: safe to load in Node (tests) and in any browser module.
// All dates are local 'YYYY-MM-DD' strings; weeks start on Monday.
// ===================================================================

/** Local 'YYYY-MM-DD' from date parts (month 0-based). */
export function toDateStr(y, m, d) {
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(m + 1)}-${p(d)}`;
}

/**
 * Parse a date value as a local calendar date.
 * A date-only string ('YYYY-MM-DD') is NOT parsed with `new Date()`:
 * that treats it as UTC midnight, which is the previous local day in
 * every timezone west of UTC. Date-only strings are built from their
 * parts instead. Anything else (a full timestamp) keeps the normal
 * parse, which converts the instant to local time correctly.
 * Shared by every reader of date-only fields (e.g. habit next_due).
 */
// A habit is snoozed while its snooze date is still ahead: `snoozed_until`
// is a local YYYY-MM-DD date (same convention as `next_due` / `end_date`)
// and the habit wakes ON that date — snoozed strictly before it. Snoozing
// never moves `next_due`: when the snooze ends, a habit whose due date
// passed during the window is simply overdue (defer, not skip).
export function isHabitSnoozed(habit, todayStr) {
  return !!(habit && habit.snoozed_until && todayStr && habit.snoozed_until > todayStr);
}

export function parseLocalDate(value) {
  const s = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(s);
}

/**
 * Month grid: array of weeks; each week is 7 { date, inMonth } cells,
 * Monday-first, including leading/trailing days from adjacent months.
 * year: full year, month: 0-based.
 */
export function getMonthGrid(year, month) {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Mon-first offset
  const cur = new Date(year, month, 1 - lead);
  const weeks = [];
  for (;;) {
    const week = [];
    let hasInMonth = false;
    for (let d = 0; d < 7; d++) {
      const inMonth = cur.getMonth() === month;
      if (inMonth) hasInMonth = true;
      week.push({ date: toDateStr(cur.getFullYear(), cur.getMonth(), cur.getDate()), inMonth });
      cur.setDate(cur.getDate() + 1);
    }
    if (!hasInMonth) break; // trailing week fully outside the month
    weeks.push(week);
  }
  return weeks;
}

/**
 * All occurrence dates ('YYYY-MM-DD') of a habit within [monthStart, monthEnd].
 * habit: { frequency_rule, next_due }.
 * nextDueFn(rule, lastDoneDateStr|null) → 'YYYY-MM-DD'|null — injected so this
 * stays pure (the app passes a wrapper around computeNextDue).
 * Free-text / missing rules pin a single occurrence on next_due when in range.
 */
export function expandHabitOccurrences(habit, monthStart, monthEnd, nextDueFn) {
  const out = [];
  const rule = habit.frequency_rule || '';
  // End date: no occurrence is ever shown strictly past it (an occurrence
  // exactly on the end date still counts). The range end is capped, so
  // stepping also stops there instead of walking to monthEnd.
  const endDate = (habit.end_date || '').slice(0, 10);
  const limit = endDate && endDate < monthEnd ? endDate : monthEnd;
  if (!rule) {
    const nd = (habit.next_due || '').slice(0, 10);
    if (nd && nd >= monthStart && nd <= limit) out.push(nd);
    return out;
  }
  let cursor = (habit.next_due || '').slice(0, 10) || null;
  if (!cursor) {
    const first = nextDueFn(rule, null);
    cursor = first ? String(first).slice(0, 10) : null;
  }
  const step = () => {
    const n = nextDueFn(rule, cursor);
    const ns = n ? String(n).slice(0, 10) : null;
    if (!ns || ns <= cursor) return null; // no progress → bail
    cursor = ns;
    return ns;
  };
  // Safety bound: 500 steps per loop is plenty for real schedules
  // (deliberately not exhaustive years out — his call, Oct 2026).
  let guard = 0;
  while (cursor && cursor < monthStart && guard++ < 500) {
    if (!step()) { cursor = null; break; }
  }
  guard = 0;
  while (cursor && cursor <= limit && guard++ < 500) {
    if (cursor >= monthStart) out.push(cursor);
    if (!step()) break;
  }
  return out;
}

/**
 * Birthday occurrence within a given month: { date, turningAge } | null.
 * birthdayStr: 'YYYY-MM-DD'. Uses JS Date overflow semantics (Feb 29 →
 * Mar 1 on non-leap years), matching getNextBirthday() elsewhere in the app.
 */
export function birthdayInMonth(birthdayStr, year, month) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdayStr || '');
  if (!m) return null;
  const birthY = +m[1];
  const occ = new Date(year, +m[2] - 1, +m[3]);
  if (occ.getFullYear() !== year || occ.getMonth() !== month) return null;
  return { date: toDateStr(occ.getFullYear(), occ.getMonth(), occ.getDate()), turningAge: year - birthY };
}

/**
 * All birthday occurrences within [start, end] ('YYYY-MM-DD' strings):
 * [{ date, turningAge }]. Iterates every month the range spans — the
 * occurrence depends only on the range, never on a view's anchor month
 * (a year range or a week crossing a month boundary must see them all).
 */
export function birthdaysInRange(birthdayStr, start, end) {
  const out = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  const count = (ey - sy) * 12 + (em - sm) + 1;
  for (let i = 0; i < count; i++) {
    const total = (sm - 1) + i;
    const occ = birthdayInMonth(birthdayStr, sy + Math.floor(total / 12), total % 12);
    if (occ && occ.date >= start && occ.date <= end) out.push(occ);
  }
  return out;
}

/**
 * Toggle one key of a { todo, habit, birthday } visibility map.
 * Returns the same object reference when the type is unknown.
 */
export function toggleShow(show, type) {
  if (!show || !(type in show)) return show;
  return { ...show, [type]: !show[type] };
}

/** Add n days to a 'YYYY-MM-DD' string (n may be negative). */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return toDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/**
 * The 7 date strings ('YYYY-MM-DD') of the Monday-first week containing dateStr.
 */
export function getWeekDates(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const mondayOffset = (dt.getDay() + 6) % 7;
  const monday = new Date(y, m - 1, d - mondayOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const t = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
  });
}
