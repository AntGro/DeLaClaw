// ===================================================================
// DAILY VISITS — single-row aggregate tracking (pure, no imports)
// ===================================================================
// The daily_visits table holds exactly one row:
//
//   { id: 'singleton', created_at, num_active_days,
//     current_streak, max_streak, last_connection_date }
//
// Dates are local YYYY-MM-DD strings. Day arithmetic is calendar-day based
// on the local date; timezone edge cases (travel, DST, clock skew) are
// deliberately not handled — simple tracking by design.
//
// Rules:
//  - First ever visit (or a row with no last_connection_date) initializes
//    the row: streak starts at 1.
//  - Same-day reconnect, or a local date at/before last_connection_date
//    (clock moved backwards), changes nothing.
//  - A later date advances last_connection_date and num_active_days; the
//    streak increments when the date is exactly the next day, otherwise it
//    resets to 1. max_streak tracks the highest current_streak seen.

export const VISIT_ROW_ID = 'singleton';

/** Local YYYY-MM-DD for a Date (device timezone, no UTC conversion). */
export function toLocalDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD of the calendar day after the given local date string. */
export function nextDay(dateStr) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + 1);
  return toLocalDateString(d);
}

/** YYYY-MM-DD of the calendar day before the given local date string. */
export function prevDay(dateStr) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() - 1);
  return toLocalDateString(d);
}

/**
 * Pure transition for the daily-visits singleton row.
 *
 * @param {object|null} row  current row, or null on first ever visit
 * @param {string} today     local YYYY-MM-DD
 * @returns {object|null} the row to write, or null when nothing changes
 */
export function nextVisitRow(row, today) {
  if (!row || !row.last_connection_date) {
    return {
      id: VISIT_ROW_ID,
      created_at: row?.created_at || today,
      num_active_days: (row?.num_active_days || 0) + 1,
      current_streak: 1,
      max_streak: Math.max(row?.max_streak || 0, 1),
      last_connection_date: today,
    };
  }
  if (today <= row.last_connection_date) return null;
  const consecutive = nextDay(row.last_connection_date) === today;
  const current_streak = consecutive ? (row.current_streak || 0) + 1 : 1;
  return {
    ...row,
    num_active_days: (row.num_active_days || 0) + 1,
    current_streak,
    max_streak: Math.max(row.max_streak || 0, current_streak),
    last_connection_date: today,
  };
}
