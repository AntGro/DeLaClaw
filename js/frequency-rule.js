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
// ===================================================================

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
