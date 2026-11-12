// ===================================================================
// import-pure.js — Dependency-free pure helpers for batch JSON imports.
//
// No imports: safe to load in Node (tests) and in any browser module.
// ===================================================================

// -------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------

/**
 * Display names of the default bucket (lowercased). The import prompts are
 * English ("General"); the app may display it localized ("Général").
 * These never become new categories — they map to the default bucket.
 */
export const DEFAULT_CATEGORY_NAMES = ['general', 'général'];

/**
 * Parse pasted/uploaded text into an array of raw item objects.
 * Strips markdown fences (LLMs love them). Throws an Error on any problem.
 */
export function parseImportArray(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message);
  }
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array of objects');
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
 * With opts.preserveDateOnly, a valid 'YYYY-MM-DD' is returned as-is
 * instead of being converted to midnight ISO (TODO due_date: date-only
 * deadlines carry end-of-day semantics; timed fields such as snooze_until
 * keep the default conversion).
 */
export function normalizeImportDate(value, fieldName, opts = {}) {
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
    if (opts.preserveDateOnly) return s;
  } else {
    d = new Date(s);
  }
  if (isNaN(d.getTime())) throw new Error(`"${fieldName}": could not parse date "${s}"`);
  return d.toISOString();
}

/**
 * Validate the "category" field shared by every importable item type.
 * A real category match wins (case-insensitive); the default bucket's
 * display name maps to the default bucket (''); anything else is flagged
 * as new and created on confirm.
 * ctx = { categoryNames: string[] }.
 * Returns { category, categoryIsNew, errors }.
 */
export function validateCategoryField(raw, ctx, label) {
  const errors = [];
  let category = '';
  let categoryIsNew = false;
  const v = raw.category;
  if (v !== undefined && v !== null && String(v).trim() !== '') {
    if (typeof v !== 'string') {
      errors.push({ field: 'category', message: `${label}: "category" must be a string (category name)` });
    } else {
      const name = v.trim();
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
  return { category, categoryIsNew, errors };
}

/**
 * Validate the "group_id" field shared by every importable item type.
 * Must be a group the user belongs to (names aren't unique, so the JSON
 * contract uses ids). ctx = { groupById: Map<id,name>, sharingReady }.
 * Returns { group_id, groupName, errors }.
 */
export function validateGroupField(raw, ctx, label) {
  const errors = [];
  let group_id = null;
  let groupName = null;
  const v = raw.group_id;
  if (v !== undefined && v !== null && String(v).trim() !== '') {
    if (typeof v !== 'string') {
      errors.push({ field: 'group_id', message: `${label}: "group_id" must be a string (group id)` });
    } else if (!ctx.sharingReady) {
      errors.push({ field: 'group_id', message: `${label}: sharing is not connected, so "group_id" cannot be used` });
    } else {
      const gid = v.trim();
      const name = ctx.groupById ? ctx.groupById.get(gid) : undefined;
      if (name === undefined) {
        errors.push({ field: 'group_id', message: `${label}: unknown group id "${gid}" (not one of your groups)` });
      } else {
        group_id = gid;
        groupName = name;
      }
    }
  }
  return { group_id, groupName, errors };
}

