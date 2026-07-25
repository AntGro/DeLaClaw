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
  nvidiaApiKey: null,
  nvidiaModel: 'meta/llama-3.1-8b-instruct',
  dbSchemaVersion: '0.000',
  offlineMode: false,
  pausedMode: false,
  sharing: null,
  authUser: null,
};

export default state;

// Debug: expose state on window for console access
if (typeof window !== 'undefined') window.__dlc = state;

// Constants
export const IDEAS_KEY = 'claw_cc_ideas';
export const THEME_KEY = 'claw_cc_theme';
export const ARCHIVED_PROJECTS_KEY = 'claw_cc_archived_projects';
export const SHOW_ARCHIVED_KEY = 'claw_cc_show_archived';
export const CURRENT_VIEW_KEY = 'claw_cc_current_view';
// Security note: anon key is public by design (PostgREST) — RLS is the boundary.
// service_role / sb_secret_ must never be stored here (rejected in saveStayConnectedCreds).
export const STAY_CONNECTED_KEY = 'claw_cc_stay_connected';
export const MAX_TEXT_LEN = 5000;
export const MAX_META_DISPLAY = 500;
export const TODO_MAX_LEN = 2000;
export const TAB_VISIBILITY_KEY = 'claw_cc_tab_visibility';
export const TAB_ORDER_KEY = 'claw_cc_tab_order';

// ── Default category palette ──
// Shared across modules for auto-assigning colors to new categories.
export const DEFAULT_CATEGORY_PALETTE = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
export const GENERAL_CATEGORY_COLOR = '#6c6f7e';
export const SHARED_CATEGORY = '__shared__';
