// ===================================================================
// todo-import.js — TODO-specific validation for the batch import.
//
// Pure helpers (no DOM, no app state); the generic modal shell lives in
// js/batch-import.js. Unit-tested in tests/tests.js.
// ===================================================================

import {
  parseImportArray,
  normalizeImportDate,
  validateCategoryField,
  validateGroupField,
} from './import-pure.js';

/** Priorities accepted by the import. Missing/empty priority → 'normal'. */
export const TODO_IMPORT_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'normal'];

/** Parse the raw pasted/uploaded text into an array of raw TODO objects. */
export function parseTodoImportJSON(raw) {
  return parseImportArray(raw);
}

/** Kept for symmetry with validateTodoImportItem; delegates to the shared date normalizer. */
export function normalizeTodoImportDate(value, fieldName, opts) {
  return normalizeImportDate(value, fieldName, opts);
}

/**
 * Validate and normalize one raw TODO item.
 *
 * ctx = {
 *   categoryNames: string[]  — existing category names (for new-detection),
 *   groupById: Map<string,string> — group id → group name (empty when sharing is off),
 *   sharingReady: boolean,
 * }
 *
 * Returns { item, errors } where errors is [{ field, message }, ...] and item
 * is the normalized shape:
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
  // due_date preserves date-only strings (end-of-day semantics);
  // snooze_until stays timed (local-midnight ISO for a bare date).
  let due_date = null;
  let snooze_until = null;
  try {
    due_date = normalizeImportDate(raw.due_date, 'due_date', { preserveDateOnly: true });
  } catch (e) {
    err('due_date', e.message);
  }
  try {
    snooze_until = normalizeImportDate(raw.snooze_until, 'snooze_until');
  } catch (e) {
    err('snooze_until', e.message);
  }

  // — category + group (shared validators) —
  const cat = validateCategoryField(raw, ctx, label);
  const grp = validateGroupField(raw, ctx, label);
  errors.push(...cat.errors, ...grp.errors);

  return {
    item: {
      title, priority, due_date, snooze_until,
      category: cat.category, categoryIsNew: cat.categoryIsNew,
      group_id: grp.group_id, groupName: grp.groupName,
    },
    errors,
  };
}
