// ===================================================================
// data.js — pure data logic for the extension (contracts §§3–6).
//
// No chrome.*, no fetch, no I/O: every function here is a pure
// function of its arguments, so Node tests can import this module
// directly. The app's own pure modules are reused, never reimplemented:
//   js/frequency-rule.js  — computeNextDue, isStructuredRule,
//                           normalizeFrequencyRule, localDateStr
//   js/calendar-pure.js   — isHabitSnoozed, instantToDateStr
//   migrations/version-compare.js — compareVersions
// The packaging script copies those three files next to this one; there
// is no second maintained copy.
// ===================================================================

import {
  computeNextDue,
  isStructuredRule,
  normalizeFrequencyRule,
  localDateStr,
} from './frequency-rule.js';
import { isHabitSnoozed, instantToDateStr } from './calendar-pure.js';
import { compareVersions } from './version-compare.js';

export const TODO_PRIORITIES = ['normal', 'low', 'medium', 'high', 'urgent'];
export const SELECTION_MAX_CHARS = 500;

// The app's normalizeHabitNextDue (habits.js): first 10 chars or null —
// dates are local YYYY-MM-DD throughout, never UTC midnight.
export function normalizeDateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

export function todayLocalStr(now = new Date()) {
  return localDateStr(now);
}

// --- TODOs -----------------------------------------------------------

// The app's insert shape (todos.js): the UI passes text/priority/
// category/category_id/sort_order/due_date and the adapter supplies id +
// timestamps. The extension has no adapter, so it supplies all of them.
// `done: false` is set explicitly; `snooze_until` is omitted — the app
// reads a missing key as not snoozed (todos.js:346).
export function buildTodoRow({ text, priority = 'normal', category = '', categoryId, sortOrder, dueDate }) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    text,
    done: false,
    priority,
    category,
    category_id: categoryId,
    sort_order: sortOrder,
    created_at: now,
    updated_at: now,
  };
  if (dueDate) row.due_date = dueDate;
  return row;
}

// The app's sort_order rule (todos.js): the minimum over PENDING todos
// only in that category, minus 1, else 0. Done rows must not drag new
// items down the list (contracts §3).
export function computeMinSortOrder(todos, categoryId) {
  const pending = todos.filter((t) => !t.done && String(t.category_id) === String(categoryId));
  if (pending.length === 0) return 0;
  return Math.min(...pending.map((t) => Number(t.sort_order || 0))) - 1;
}

// --- Categories ------------------------------------------------------

// The default (General) row, resolved at runtime exactly as the app
// does (todos.js:40): protected, and not the __shared__ row. Never
// hardcode the id — live data carries `_default_todo_categories` while
// the seed constant is `_default_todo_cat` (contracts §4).
export function resolveDefaultCategory(categories) {
  return (categories || []).find((c) => c.is_protected && c.name !== '__shared__') || null;
}

// The picker's offer: real user categories only — no __shared__
// pseudo-category, no protected General row (spec §5).
export function userCategories(categories) {
  const def = resolveDefaultCategory(categories);
  return (categories || []).filter((c) => c.name !== '__shared__' && c !== def && c.id !== def?.id);
}

// --- Capture text ----------------------------------------------------

// Page capture (contracts §3): page title as the text, URL appended as
// a Markdown link. Escape [ and ] in titles, ) in URLs.
export function buildCaptureText(title, url) {
  const safeTitle = String(title || '').replace(/[\[\]]/g, '\\$&');
  const safeUrl = String(url || '').replace(/\)/g, '%29');
  return `${safeTitle}\n[${safeTitle}](${safeUrl})`;
}

export function truncateSelection(text) {
  return String(text || '').slice(0, SELECTION_MAX_CHARS);
}

// --- Habits ----------------------------------------------------------

// The completion row the app's Done path inserts (habits.js:2182), with
// the adapter-supplied fields included (the extension has no adapter).
export function buildCompletionRow(habitId, nowIso) {
  return {
    id: crypto.randomUUID(),
    habit_id: habitId,
    completed_at: nowIso,
    created_at: nowIso,
  };
}

// The app's full updateHabitNextDue algorithm (habits.js:317), early
// guard ON (the default; manual last-done edits use false, the Done
// path never does). The rule is normalized first, matching the
// migration helper (frequency-rule.js recomputeNextDueForMigration);
// live rules are already normalized (heartbeat: 51 structured, 0
// free-text), so this agrees with the app on all real data.
export function recomputeNextDueForDone(habit, completedAtIso) {
  const rule = normalizeFrequencyRule(habit.frequency_rule || '');
  const structured = isStructuredRule(rule);
  let nextDue = structured
    ? normalizeDateOnly(computeNextDue(rule, completedAtIso))
    : null;
  const current = normalizeDateOnly(habit.next_due);
  // Early guard: completing early skips the imminent occurrence.
  if (structured && nextDue && current && nextDue <= current) {
    nextDue = normalizeDateOnly(computeNextDue(rule, current));
  }
  // End date: a recomputed due strictly past it finishes the habit.
  // An occurrence exactly ON the end date is still due.
  const endDate = normalizeDateOnly(habit.end_date);
  const isFinished = structured
    ? !!(nextDue && endDate && nextDue > endDate)
    : !!habit.is_finished;
  if (isFinished) nextDue = null;
  return { next_due: nextDue, is_finished: isFinished ? 1 : 0 };
}

// Latest completion for a habit (max completed_at — the file order is
// not guaranteed, so never take the first match).
export function latestCompletion(completions, habitId) {
  let best = null;
  for (const c of completions || []) {
    if (String(c.habit_id) !== String(habitId)) continue;
    if (!best || String(c.completed_at) > String(best.completed_at)) best = c;
  }
  return best;
}

// The due list (contracts §5): next_due set and on or before today;
// not a draft; not finished; no shared_id; not snoozed (decided
// 15 Nov 2026 — a snoozed habit's state is 'snoozed', not 'due');
// not completed today (latest completion's local date).
export function filterDueHabits(habits, completions, todayStr) {
  return (habits || []).filter((h) => {
    if (!h.next_due || normalizeDateOnly(h.next_due) > todayStr) return false;
    if (h.is_draft) return false;
    if (h.is_finished) return false;
    if (h.shared_id) return false;
    if (isHabitSnoozed(h, todayStr)) return false;
    const last = latestCompletion(completions, h.id);
    if (last && instantToDateStr(last.completed_at) === todayStr) return false;
    return true;
  });
}

// --- Schema-version guard --------------------------------------------

// Returns null when the write may proceed, else the refusal message.
// Missing live version also refuses: it means setup never completed
// (settings.json is written last).
export function checkSchemaVersion(liveVersion, knownVersion) {
  if (liveVersion == null) {
    return 'DeLaClaw setup looks incomplete (no schema version found). Open the app and sign in there first.';
  }
  if (compareVersions(String(liveVersion), String(knownVersion)) > 0) {
    return `Your DeLaClaw data was migrated to schema ${liveVersion}, newer than this extension knows (${knownVersion}). Update the extension before it writes anything.`;
  }
  return null;
}
