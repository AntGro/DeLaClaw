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
/**
 * Plan the auto-validation roll for an automatic habit: every occurrence
 * strictly before `todayStr` that has not been validated yet (the stored
 * next_due is the oldest unvalidated one) is due to be recorded as an
 * automatic completion, stepping with the same nextDueFn the Calendar
 * expansion uses so the two can never disagree. Returns null when there
 * is nothing to do (next due is today or later — today's occurrence is
 * NOT pre-validated, it shows as due today and rolls tomorrow).
 * Otherwise { missed: ['YYYY-MM-DD', ...], nextDue, finished } where
 * nextDue is the first occurrence on/after today, and finished applies
 * the end-date rule to it (strictly past end_date → finished, nextDue
 * null). Occurrences past end_date are never recorded.
 */
export function planAutoRoll(habit, todayStr, nextDueFn) {
  const rule = habit.frequency_rule || '';
  const start = (habit.next_due || '').slice(0, 10);
  if (!rule || !start || start >= todayStr) return null;
  const endDate = (habit.end_date || '').slice(0, 10);
  const missed = [];
  let cursor = start;
  let guard = 0;
  while (cursor && cursor < todayStr && guard++ < 1000) {
    if (endDate && cursor > endDate) break;
    missed.push(cursor);
    const n = nextDueFn(rule, cursor);
    const ns = n ? String(n).slice(0, 10) : null;
    if (!ns || ns <= cursor) { cursor = null; break; }
    cursor = ns;
  }
  const finished = !!(endDate && cursor && cursor > endDate);
  if (!missed.length && !finished) return null;
  return { missed, nextDue: finished ? null : cursor, finished };
}

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
 * Whole days by which a due date ('YYYY-MM-DD') is overdue relative to
 * today ('YYYY-MM-DD'): 1 when due yesterday, 0 when due today or
 * later. Computed on local midnights with rounding, so a 23h/25h
 * daylight-saving day still counts as exactly one day. An invalid or
 * missing date counts as 0 (not overdue).
 */
export function overdueDays(dueStr, todayStr) {
  if (!dueStr || !todayStr) return 0;
  const diff = Math.round((parseLocalDate(dueStr) - parseLocalDate(todayStr)) / 86400000);
  return diff < 0 ? -diff : 0;
}

// ===================================================================
// USER EVENTS — instant model (v2.31.0)
// ===================================================================
// Timed events store absolute instants (start_ts / end_ts, UTC ISO)
// plus the IANA timezone they were entered in. Display converts to
// the VIEWER's timezone: an event's days are the days its instant
// interval overlaps in the viewer's timezone, so it can sit on a
// different date for a viewer in another zone — standard calendar
// semantics. Full-day events store an inclusive date range
// (start_date..end_date) and never convert.

const _tzFormatters = new Map();
function _tzFormatter(timeZone) {
  let fmt = _tzFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    _tzFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of an instant (ms since epoch) in a timezone. */
function _zonedParts(ms, timeZone) {
  const parts = _tzFormatter(timeZone).formatToParts(new Date(ms));
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out; // { year, month, day, hour, minute, second }
}

/** The local timezone of the current runtime (IANA name). */
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** 'YYYY-MM-DD' of an instant (ISO string) as seen in timeZone. */
export function instantToDateStr(isoTs, timeZone) {
  const ms = Date.parse(isoTs);
  if (!Number.isFinite(ms)) return '';
  const p = _zonedParts(ms, timeZone);
  return toDateStr(p.year, p.month - 1, p.day);
}

/** 'HH:MM' of an instant (ISO string) as seen in timeZone. */
export function instantToTimeStr(isoTs, timeZone) {
  const ms = Date.parse(isoTs);
  if (!Number.isFinite(ms)) return '';
  const p = _zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** UTC offset (ms) of timeZone at an instant: wall reading minus UTC. */
function _tzOffsetMs(ms, timeZone) {
  const p = _zonedParts(ms, timeZone);
  const wallAsUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUTC - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant (UTC ISO string) corresponding to a wall-clock date +
 * 'HH:MM' time in timeZone. Two-pass offset correction so the result
 * is right on both sides of a DST transition; a wall time inside the
 * spring-forward gap resolves to the nearest valid instant.
 */
export function wallTimeToInstant(dateStr, timeStr, timeZone) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  if (!y || !m || !d) return '';
  const wallAsUTC = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let instant = wallAsUTC - _tzOffsetMs(wallAsUTC, timeZone);
  instant = wallAsUTC - _tzOffsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

/**
 * The full day span an event occupies for a viewer in viewerTz:
 * { startDate, endDate } ('YYYY-MM-DD', inclusive) or null when the
 * event carries no usable dates. Timed events: the days overlapped
 * by [start_ts, end_ts) in viewerTz — an end exactly at local
 * midnight does not claim the new day. Full-day: the stored range.
 */
export function eventSpan(ev, viewerTz) {
  if (!ev) return null;
  if (ev.all_day) {
    if (!ev.start_date) return null;
    return { startDate: ev.start_date, endDate: ev.end_date || ev.start_date };
  }
  if (!ev.start_ts || !ev.end_ts) return null;
  const startDate = instantToDateStr(ev.start_ts, viewerTz);
  const endMs = Date.parse(ev.end_ts);
  if (!startDate || !Number.isFinite(endMs)) return null;
  const endDate = instantToDateStr(new Date(endMs - 1).toISOString(), viewerTz);
  return { startDate, endDate: endDate || startDate };
}

/**
 * Placement of an event inside [rangeStart, rangeEnd] for a viewer in
 * viewerTz: one entry per occupied day within the range —
 * { date, startsHere, endsHere } — startsHere/endsHere mark the
 * event's own first/last day (false on days where it merely
 * continues through the range edge). Empty array when outside.
 */
export function eventDatesInRange(ev, rangeStart, rangeEnd, viewerTz) {
  const span = eventSpan(ev, viewerTz);
  if (!span) return [];
  const start = span.startDate < rangeStart ? rangeStart : span.startDate;
  const end = span.endDate > rangeEnd ? rangeEnd : span.endDate;
  if (start > end) return [];
  const out = [];
  for (let d = start; ; d = addDays(d, 1)) {
    out.push({ date: d, startsHere: d === span.startDate, endsHere: d === span.endDate });
    if (d === end) break;
  }
  return out;
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
export function expandHabitOccurrences(habit, monthStart, monthEnd, nextDueFn, todayStr = null) {
  const out = [];
  const rule = habit.frequency_rule || '';
  // End date: no occurrence is ever shown strictly past it (an occurrence
  // exactly on the end date still counts). The range end is capped, so
  // stepping also stops there instead of walking to monthEnd.
  const endDate = (habit.end_date || '').slice(0, 10);
  const limit = endDate && endDate < monthEnd ? endDate : monthEnd;
  // Overdue (next due in the past, todayStr provided): the occurrences
  // between the due date and today will never happen — validating the
  // habit makes today its last completion and the following dues are
  // recomputed from today. So show exactly: the due date itself,
  // today, and the cadence stepped from today. (Without todayStr the
  // historical projection below is kept — other callers rely on it.)
  const nd0 = (habit.next_due || '').slice(0, 10);
  if (todayStr && nd0 && nd0 < todayStr && nd0 <= limit) {
    if (nd0 >= monthStart) out.push(nd0);
    if (todayStr >= monthStart && todayStr <= monthEnd) out.push(todayStr);
    let cursor = todayStr;
    let guard = 0;
    while (guard++ < 500) {
      const n = nextDueFn(rule, cursor);
      const ns = n ? String(n).slice(0, 10) : null;
      if (!ns || ns <= cursor || ns > limit) break;
      cursor = ns;
      if (cursor >= monthStart) out.push(cursor);
    }
    return out;
  }
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
/**
 * 'GMT+2' / 'GMT-4' style offset label for a zone on a date (DST-aware:
 * the offset is read on the given date, default today). '' when the zone
 * is unknown to Intl.
 */
export function gmtOffsetLabel(timeZone, dateStr) {
  try {
    const d = dateStr ? parseLocalDate(dateStr) : new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(d);
    const part = parts.find(p => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch { return ''; }
}

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
