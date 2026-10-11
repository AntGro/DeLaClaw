// ===================================================================
// todo-import.js — Pure helpers for the TODO batch import.
//
// No DOM, no app state: parse, validate and normalize the JSON the user
// pastes (or uploads) in the TODO import modal. Unit-tested in tests/tests.js.
// The modal UI lives in js/todos.js (openTodoImportModal).
// ===================================================================

/** Priorities accepted by the import. Missing/empty priority → 'normal'. */
export const TODO_IMPORT_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'normal'];

/**
 * Display names of the default bucket (lowercased). The import prompt is
 * English ("General"); the app may display it localized ("Général").
 * These never become new categories — they map to the default bucket.
 */
export const DEFAULT_CATEGORY_NAMES = ['general', 'général'];

/**
 * Parse the raw pasted/uploaded text into an array of raw item objects.
 * Strips markdown fences (LLMs love them). Throws an Error on any problem.
 */
export function parseTodoImportJSON(raw) {
  let text = String(raw || '').trim();
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array of TODO objects');
  if (arr.length === 0) throw new Error('Array is empty');
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i] || typeof arr[i] !== 'object' || Array.isArray(arr[i])) {
      throw new Error(`Item ${i + 1}: expected an object`);
    }
  }
  return arr;
}

/**
 * Normalize a date value to an ISO-8601 string (or null when empty).
 * Accepts 'YYYY-MM-DD' (interpreted as local midnight) or any string the
 * Date constructor parses. Throws an Error when the value is not usable.
 */
export function normalizeTodoImportDate(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`"${fieldName}": expected a date string, got ${typeof value}`);
  }
  const s = value.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let d;
  if (m) {
    d = new Date(+m[1], +m[2] - 1, +m[3]); // local midnight
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) {
      throw new Error(`"${fieldName}": "${s}" is not a real calendar date`);
    }
  } else {
    d = new Date(s);
  }
  if (isNaN(d.getTime())) throw new Error(`"${fieldName}": could not parse date "${s}"`);
  return d.toISOString();
}

/**
 * Validate and normalize one raw item.
 *
 * ctx = {
 *   categoryNames: string[]  — existing category names (for new-category detection),
 *   groupById: Map<string,string> — group id → group name (empty when sharing is off),
 *   sharingReady: boolean,
 * }
 *
 * Returns { item, errors } where errors is [{ field, message }, ...] and item
 * is the normalized shape (fields with errors fall back to safe defaults so
 * the review UI can still render the row):
 *   { title, priority, due_date, snooze_until, category, categoryIsNew,
 *     group_id, groupName }
 */
export function validateTodoImportItem(raw, index, ctx) {
  const errors = [];
  const label = `Item ${index + 1}`;
  const err = (field, message) => errors.push({ field, message: `${label}: ${message}` });

  // — title (required) —
  let title = '';
  if (typeof raw.title === 'string') title = raw.title.trim();
  if (!title) err('title', 'missing "title" (non-empty string required)');

  // — priority —
  let priority = 'normal';
  if (raw.priority !== undefined && raw.priority !== null && String(raw.priority).trim() !== '') {
    if (typeof raw.priority !== 'string') {
      err('priority', `"priority" must be one of: ${TODO_IMPORT_PRIORITIES.join(', ')}`);
    } else {
      const p = raw.priority.trim().toLowerCase();
      if (TODO_IMPORT_PRIORITIES.includes(p)) priority = p;
      else err('priority', `"priority" must be one of: ${TODO_IMPORT_PRIORITIES.join(', ')}`);
    }
  }

  // — dates —
  let due_date = null;
  let snooze_until = null;
  try {
    due_date = normalizeTodoImportDate(raw.due_date, 'due_date');
  } catch (e) {
    err('due_date', e.message);
  }
  try {
    snooze_until = normalizeTodoImportDate(raw.snooze_until, 'snooze_until');
  } catch (e) {
    err('snooze_until', e.message);
  }

  // — category (name; created on confirm when unknown) —
  // A real category match wins (case-insensitive); the default bucket's
  // display name ("General"/"Général") maps to the default bucket ('');
  // anything else is flagged as new and created on confirm.
  let category = '';
  let categoryIsNew = false;
  if (raw.category !== undefined && raw.category !== null && String(raw.category).trim() !== '') {
    if (typeof raw.category !== 'string') {
      err('category', '"category" must be a string (category name)');
    } else {
      const name = raw.category.trim();
      const lower = name.toLowerCase();
      const realMatch = (ctx.categoryNames || []).find(n => n !== '' && n.toLowerCase() === lower);
      if (realMatch) {
        category = realMatch;
      } else if (DEFAULT_CATEGORY_NAMES.includes(lower)) {
        category = ''; // default bucket
      } else {
        category = name;
        categoryIsNew = true;
      }
    }
  }

  // — group_id (must be a group the user belongs to) —
  let group_id = null;
  let groupName = null;
  if (raw.group_id !== undefined && raw.group_id !== null && String(raw.group_id).trim() !== '') {
    if (typeof raw.group_id !== 'string') {
      err('group_id', '"group_id" must be a string (group id)');
    } else if (!ctx.sharingReady) {
      err('group_id', 'sharing is not connected, so "group_id" cannot be used');
    } else {
      const gid = raw.group_id.trim();
      const name = ctx.groupById ? ctx.groupById.get(gid) : undefined;
      if (name === undefined) {
        err('group_id', `unknown group id "${gid}" (not one of your groups)`);
      } else {
        group_id = gid;
        groupName = name;
      }
    }
  }

  return {
    item: { title, priority, due_date, snooze_until, category, categoryIsNew, group_id, groupName },
    errors,
  };
}
