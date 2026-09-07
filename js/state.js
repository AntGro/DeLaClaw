// ===================================================================
// SHARED STATE — mutable state accessible by all modules
// ===================================================================

import db from './db.js';

const state = {
  /** @type {import('./db.js').default} */
  db,
  PROJECTS: [],
  allTasks: [],
  allHabits: [],
  allHabitCompletions: [],
  allBirthdays: [],
  allVestiaire: [],
  allLists: [],
  allListItems: [],
  vestiaireFilter: 'all',
  currentView: 'projects',
  dbSchemaVersion: '0.000',
  offlineMode: false,
  pausedMode: false,
  sharing: null,
  authUser: null,
  tabVisibility: null,    // {key: bool} from settings DB
  tabOrder: null,         // [key, …] from settings DB
  archivedProjectIds: [], // [id, …] from settings DB
  showArchived: false,    // bool from settings DB
};

export default state;

// Debug: expose state on window for console access
if (typeof window !== 'undefined') window.__dlc = state;

// Constants
export const IDEAS_KEY = 'claw_cc_ideas';
export const THEME_KEY = 'claw_cc_theme';
export const CURRENT_VIEW_KEY = 'claw_cc_current_view';
// Security note: credentials are never persisted — only URL and mode are stored.
// Keys/secrets are held in memory (and cleared on disconnect).
export const STAY_CONNECTED_KEY = 'claw_cc_stay_connected';
export const MAX_TEXT_LEN = 5000;
export const MAX_META_DISPLAY = 500;
export const TODO_MAX_LEN = 2000;

// ── Default category palette ──
// Shared across modules for auto-assigning colors to new categories.
export const DEFAULT_CATEGORY_PALETTE = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
export const GENERAL_CATEGORY_COLOR = '#6c6f7e';
export const SHARED_CATEGORY = '__shared__';
