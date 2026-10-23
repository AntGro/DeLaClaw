// ===================================================================
// habit-import.js — Habit-specific validation for the batch import.
//
// Pure helpers (no DOM); the frequency_rule helpers come from js/habits.js
// and the generic modal shell from js/batch-import.js.
// Unit-tested in tests/tests.js.
// ===================================================================

import {
  parseImportArray,
  validateCategoryField,
  validateGroupField,
} from './import-pure.js';
import { isStructuredRule, normalizeFrequencyRule, DOW_KEYS } from './frequency-rule.js';

/** Parse the raw pasted/uploaded text into an array of raw habit objects. */
export function parseHabitImportJSON(raw) {
  return parseImportArray(raw);
}

const FREQ_HINT = 'use every_N_days:N, every_N_weeks:N:Mon,Wed, every_N_months:N:D or yearly:MM-DD';

/**
 * Strict structural check on a normalized rule (the app itself is lenient:
 * e.g. yearly:13-45 silently overflows, every_N_months:1: never becomes due).
 * Returns an error message, or null when the rule is sound.
 */
function strictFrequencyError(rule) {
  const int = (s) => { const n = parseInt(s, 10); return Number.isNaN(n) ? null : n; };
  if (rule.startsWith('every_N_days:')) {
    const n = int(rule.split(':')[1]);
    if (n === null || n < 1) return '"every_N_days:N" needs N ≥ 1';
    return null;
  }
  if (rule.startsWith('every_N_weeks:')) {
    const parts = rule.split(':');
    const n = int(parts[1]);
    if (n === null || n < 1) return '"every_N_weeks:N:…" needs N ≥ 1';
    const daysStr = parts[2] || '';
    if (daysStr) {
      const bad = daysStr.split(',').filter(d => !DOW_KEYS.includes(d));
      if (bad.length > 0) return `unknown day(s) "${bad.join(',')}" — use ${DOW_KEYS.join(' ')}`;
    }
    return null;
  }
  if (rule.startsWith('every_N_months:')) {
    const parts = rule.split(':');
    const n = int(parts[1]);
    if (n === null || n < 1) return '"every_N_months:N:…" needs N ≥ 1';
    const day = parts[2];
    if (day === undefined || day === '') return '"every_N_months:N" needs a day: a day-of-month 1–31 or first|last:Days';
    if (/^\d+$/.test(day)) {
      const dom = int(day);
      if (dom < 1 || dom > 31) return 'day-of-month must be 1–31';
      return null;
    }
    if (day === 'first' || day === 'last') {
      const days = (parts[3] || '').split(',').filter(Boolean);
      if (days.length === 0) return `"${day}" needs days, e.g. "${day}:Mon"`;
      const bad = days.filter(d => !DOW_KEYS.includes(d));
      if (bad.length > 0) return `unknown day(s) "${bad.join(',')}" — use ${DOW_KEYS.join(' ')}`;
      return null;
    }
    return `unrecognized "${day}" — ${FREQ_HINT}`;
  }
  if (rule.startsWith('yearly:')) {
    const m = /^yearly:(\d{2})-(\d{2})$/.exec(rule);
    if (!m) return '"yearly" must look like yearly:MM-DD';
    const mm = +m[1];
    const dd = +m[2];
    if (mm < 1 || mm > 12) return 'month must be 01–12';
    const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1]; // Feb 29 allowed
    if (dd < 1 || dd > dim) return `day must be 01–${dim} for month ${m[1]}`;
    return null;
  }
  return null;
}

/**
 * Validate and normalize one raw habit item.
 *
 * Expected shape:
 *   { name, frequency, category, group_id }
 * - "name": required non-empty string.
 * - "frequency": required; must be a structured rule after normalization
 *   (every_N_days:N, every_N_weeks:N:Mon,Wed, every_N_months:N:D,
 *   yearly:MM-DD — legacy daily/weekly:/monthly: forms accepted and
 *   normalized). Strictly validated: day names must be real, month days
 *   real calendar days (the app itself is lenient here). Normalized to
 *   the canonical form.
 *
 * ctx = {
 *   categoryNames: string[]  — existing category names (for new-detection),
 *   groupById: Map<string,string> — group id → group name (empty when sharing is off),
 *   sharingReady: boolean,
 * }
 *
 * Returns { item, errors } where errors is [{ field, message }, ...] and item
 * is { name, frequency_rule, category, categoryIsNew, group_id, groupName }.
 */
export function validateHabitImportItem(raw, index, ctx) {
  const errors = [];
  const label = `Item ${index + 1}`;
  const err = (field, message) => errors.push({ field, message: `${label}: ${message}` });

  // — name (required) —
  let name = '';
  if (typeof raw.name === 'string') name = raw.name.trim();
  if (!name) err('name', 'missing "name" (non-empty string required)');

  // — frequency (required, structured) —
  let frequency_rule = null;
  const fv = raw.frequency;
  if (fv === undefined || fv === null || String(fv).trim() === '') {
    err('frequency', 'missing "frequency"');
  } else if (typeof fv !== 'string') {
    err('frequency', '"frequency" must be a string');
  } else {
    const normalized = normalizeFrequencyRule(fv.trim());
    if (!isStructuredRule(normalized)) {
      err('frequency', `"frequency" "${fv.trim()}" is not a recognized format — ${FREQ_HINT}`);
    } else {
      const strict = strictFrequencyError(normalized);
      if (strict) err('frequency', `"frequency" "${fv.trim()}": ${strict}`);
      else frequency_rule = normalized;
    }
  }

  // — category + group (shared validators) —
  const cat = validateCategoryField(raw, ctx, label);
  const grp = validateGroupField(raw, ctx, label);
  errors.push(...cat.errors, ...grp.errors);

  return {
    item: {
      name, frequency_rule,
      category: cat.category, categoryIsNew: cat.categoryIsNew,
      group_id: grp.group_id, groupName: grp.groupName,
    },
    errors,
  };
}
