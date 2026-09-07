import { lucideIcon } from './icons.js';
import { initHero, showHero, hideHero, injectGateLogo } from './hero.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import { renderStorm, generateStorm, LOGO_DEFAULTS, animLoading, animLock, animUnlock } from './logo.js';
import { LOGOS, LABELS } from './backend-logos.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY } from './state.js';
import db from './db.js';
import { createRestAdapter } from './adapters/rest.js';
import { wrapWithOfflineCache } from './adapters/offline-cache.js';
import { DRIVE_SCOPE_FILE } from './adapters/drive.js';
import { initCalSync, enableCalSync, disableCalSync, getCalSyncPrefs, reconcileAll as reconcileCalendar, syncTable as syncCalendarTable, markDirty as markCalDirty, markCategoryRenamed, deleteTypeEvents, pushType as pushCalType, resetCalendar as resetCalendarForImport, CAT_TABLE_TO_ITEM_TABLE } from './calendar-sync.js';

import { esc, showToast, showConfirmAction, closeConfirmAction, updateFooterStats, updateTaskListMaxHeight, isEditing, fetchAll, isInstalledPWA, deviceClass, isMobileUA, parseDeepLink, highlightItem, DEEP_LINK_TYPE_MAP } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, renderAllTasks, loadPrompts, initProjectModals } from './projects.js';

const SETTINGS_PANES = ['general', 'calendar', 'sharing', 'data', 'stats', 'account'];
import { refreshTodos, renderTodos, getTodoCounts, initTodoModals, syncSharedTodos } from './todos.js';
import { refreshHabits, renderHabits, initHabitModals, syncSharedHabits } from './habits.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';
import { refreshLists, renderLists, initListModals, syncSharedListItems } from './lists.js';
import { updateSharingNavVisibility, renderSharingPane, applySettingsI18n as applySharingI18n } from './sharing-ui.js';
import { refreshWelcome, renderWelcome } from './welcome.js';
import { DEFAULT_CATEGORY_PALETTE, GENERAL_CATEGORY_COLOR } from './state.js';
import { compareVersions } from '../migrations/version-compare.js';

// Last-updated tracking (declared early so renderLastUpdated can be called from updateStaticLabels)
let _lastUpdatedAt = null;
let _lastUpdatedTimer = null;

// ===================================================================
// BACKEND-SCOPED localStorage — isolate per-backend settings so switching
// between Supabase, Local, and Demo never leaks data across modes.
// Keys listed here are saved/restored under `scope:{mode}:{key}`.
// Global keys (STAY_CONNECTED_KEY, cc-lang, install-dismiss) are never scoped.
// ===================================================================
const SCOPED_LS_KEYS = [
  'claw_cc_theme',
  'claw_cc_current_view',
  'claw_cc_ideas',
];
const ACTIVE_MODE_KEY = 'claw_cc_active_mode';

/** Save all scoped keys into scope:{mode}:* and clear the bare keys. */
function saveLsScope(mode) {
  if (!mode) return;
  for (const key of SCOPED_LS_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) localStorage.setItem(`scope:${mode}:${key}`, val);
    else localStorage.removeItem(`scope:${mode}:${key}`);
    localStorage.removeItem(key);
  }
}

/** Restore bare keys from scope:{mode}:* (missing keys are cleared). */
function restoreLsScope(mode) {
  for (const key of SCOPED_LS_KEYS) {
    const scoped = localStorage.getItem(`scope:${mode}:${key}`);
    if (scoped !== null) localStorage.setItem(key, scoped);
    else localStorage.removeItem(key);
  }
  localStorage.setItem(ACTIVE_MODE_KEY, mode);
}

/** Swap scoped localStorage from the previous active mode to newMode. */
function swapLsScope(newMode) {
  const prev = localStorage.getItem(ACTIVE_MODE_KEY);
  if (prev && prev !== newMode) {
    saveLsScope(prev);
    restoreLsScope(newMode);
  } else if (!prev) {
    // First use ever: existing bare keys belong to 'googledrive' (legacy default)
    if (newMode !== 'googledrive') {
      saveLsScope('googledrive');
      restoreLsScope(newMode);
    } else {
      localStorage.setItem(ACTIVE_MODE_KEY, 'googledrive');
    }
  }
  // Same mode → nothing to swap, just ensure marker is set
  localStorage.setItem(ACTIVE_MODE_KEY, newMode);
}

/** Build category table rows in the demo adapter store from item data. */
function setDemoCategoriesFromData(data) {
  if (!state.demoAdapter) return;
  const store = state.demoAdapter._store;

  function buildCatRows(items, nameField, tableName) {
    const names = [...new Set((items || []).map(i => i[nameField]).filter(Boolean))];
    const rows = [
      // Protected default row (empty name, like real DB)
      { id: `demo-cat-${tableName}-default`, name: '', shortname: null, color: GENERAL_CATEGORY_COLOR, sort_order: 0, is_protected: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      // Protected __shared__ row
      { id: `demo-cat-${tableName}-shared`, name: '__shared__', shortname: null, color: GENERAL_CATEGORY_COLOR, sort_order: 9999, is_protected: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      // User-defined categories from data
      ...names.map((name, idx) => ({
        id: `demo-cat-${tableName}-${idx}`,
        name,
        shortname: null,
        color: DEFAULT_CATEGORY_PALETTE[idx % DEFAULT_CATEGORY_PALETTE.length],
        sort_order: idx + 1,
        is_protected: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
    ];
    store[tableName] = rows;
    // Build name→id lookup for enriching items
    const lookup = new Map(rows.map(r => [r.name, r.id]));
    return lookup;
  }

  const todoLookup = buildCatRows(data.todos, 'category', 'todo_categories');
  const habitLookup = buildCatRows(data.habits, 'category', 'habit_categories');
  const vestLookup = buildCatRows(data.vestiaire, 'category', 'vestiaire_categories');
  const deckLookup = buildCatRows([...(data.flashcards || []), ...(data.texts || [])], 'deck', 'flashcard_decks');

  // Enrich items with category_id / deck_id (fall back to default row)
  for (const t of (store.todos || [])) t.category_id = todoLookup.get(t.category) || todoLookup.get('') || null;
  for (const h of (store.habits || [])) h.category_id = habitLookup.get(h.category) || habitLookup.get('') || null;
  for (const v of (store.vestiaire || [])) v.category_id = vestLookup.get(v.category) || vestLookup.get('') || null;
  for (const f of (store.flashcards || [])) f.deck_id = deckLookup.get(f.deck) || deckLookup.get('') || null;
  for (const tx of (store.texts || [])) tx.deck_id = deckLookup.get(tx.deck) || deckLookup.get('') || null;
}

// ===================================================================
// ACTION GUARD — prevents double-fire on async save/add/edit actions.
// Wraps any async function so concurrent calls are silently dropped.
// Also adds .saving class on the triggering button for visual feedback
// (shimmer + disabled appearance via CSS) and disables it to enforce
// core principle: one click → disable till fulfilled.
// ===================================================================
function guard(fn) {
  let inFlight = false;
  return async function(...args) {
    if (inFlight) return;
    inFlight = true;
    // Find the triggering button for visual feedback
    // Prefer explicit button passed as last arg (via this), else activeElement, else modal save
    let btn = null;
    // If last arg is an HTMLElement button (when caller passes `this`), use it
    const lastArg = args[args.length - 1];
    if (lastArg instanceof HTMLElement && lastArg.tagName === 'BUTTON') {
      btn = lastArg;
      args = args.slice(0, -1); // remove button from args
    } else {
      const active = document.activeElement;
      btn = (active && active.tagName === 'BUTTON') ? active
        : document.querySelector('.modal-overlay[style*="flex"] button.modal-save');
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add('saving', 'is-pending');
      btn.setAttribute('aria-busy', 'true');
    }
    try { await fn.apply(this, args); }
    finally {
      inFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('saving', 'is-pending');
        btn.removeAttribute('aria-busy');
      }
    }
  };
}

// ===================================================================
// ICON HYDRATION — replace <span data-icon="..."> with SVGs from icons.js
// ===================================================================
function hydrateIcons() {
  document.querySelectorAll('[data-icon]').forEach(span => {
    const name = span.dataset.icon;
    const size = parseInt(span.dataset.size || '16');
    const color = span.dataset.color || undefined;
    span.outerHTML = lucideIcon(name, size, color);
  });
}
hydrateIcons();

// ===================================================================
// MODAL-WIDE TEXTAREA RESIZE GRIP
// Custom grip at the textarea's bottom-right corner. Dragging it:
//  - Horizontal: modal grows by 2× dx (symmetric centering) so the
//    textarea's right edge tracks the cursor 1:1.
//  - Vertical: textarea height follows cursor 1:1.
// setPointerCapture keeps tracking even when cursor leaves the modal.
// ===================================================================
function _initWideModalResize(modal) {
  if (modal._resizeInit) return;
  modal._resizeInit = true;

  // Remove old standalone handle if present
  const old = modal.querySelector('.modal-resize-handle');
  if (old) old.remove();

  const ta = modal.querySelector('textarea');
  if (!ta) return;

  ta.style.resize = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'textarea-resize-wrap';
  ta.parentNode.insertBefore(wrapper, ta);
  wrapper.appendChild(ta);

  const grip = document.createElement('div');
  grip.className = 'textarea-resize-grip';
  wrapper.appendChild(grip);

  let dragging = false, startX, startY, startW, startH;

  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = modal.offsetWidth;
    startH = ta.offsetHeight;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxW = window.innerWidth * 0.92;
    modal.style.width = Math.min(Math.max(startW + dx * 2, 440), maxW) + 'px';
    ta.style.height = Math.max(startH + dy, 100) + 'px';
  });
  grip.addEventListener('pointerup', () => { dragging = false; });
  grip.addEventListener('pointercancel', () => { dragging = false; });
}

// Init on existing static .modal-wide elements
document.querySelectorAll('.modal-wide').forEach(_initWideModalResize);

// Watch for dynamically-inserted .modal-wide elements
new MutationObserver(muts => {
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('.modal-wide')) _initWideModalResize(node);
      node.querySelectorAll?.('.modal-wide')?.forEach(_initWideModalResize);
    }
    for (const node of m.removedNodes) {
      if (node.nodeType !== 1) continue;
      const modals = node.matches?.('.modal-wide')
        ? [node]
        : [...(node.querySelectorAll?.('.modal-wide') || [])];
      modals.forEach(modal => {
        const ta = modal.querySelector('textarea');
        if (ta?._wideResizeObs) { ta._wideResizeObs.disconnect(); ta._wideResizeObs = null; }
        modal.style.width = '';
      });
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Reset modal-wide width + textarea inline size when overlay closes;
// re-init observer when overlay opens.
new MutationObserver(muts => {
  for (const m of muts) {
    if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
    const el = m.target;
    if (!el.classList.contains('modal-overlay')) continue;
    const modal = el.querySelector('.modal-wide');
    if (!modal) continue;
    if (el.classList.contains('visible')) {
      // Modal opened — (re-)init resize observer
      _initWideModalResize(modal);
    } else {
      // Modal closed — reset dimensions & disconnect observer
      modal.style.width = '';
      const ta = modal.querySelector('textarea');
      if (ta) { ta.style.width = ''; ta.style.height = ''; }
      if (ta?._wideResizeObs) { ta._wideResizeObs.disconnect(); ta._wideResizeObs = null; }
    }
  }
}).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

// ===================================================================
// BACKEND MODE PICKER
// ===================================================================
function getSelectedMode() {
  const active = document.querySelector('.backend-option.active');
  return active ? active.dataset.mode : 'googledrive';
}

function switchBackendMode(mode) {
  document.querySelectorAll('.backend-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Pre-cache the Drive adapter module so the dynamic import() in connect()
  // resolves instantly on click — preserving the user-activation window that
  // mobile browsers require for the Google OAuth popup.
  if (mode === 'googledrive') import('./adapters/drive.js').catch(() => {});

  const keyField = document.getElementById('keyField');
  const urlField = document.getElementById('username');
  const urlLabel = document.getElementById('urlLabel');
  const urlLabelLink = document.getElementById('urlLabelLink');
  const keyLabelLink = document.getElementById('keyLabelLink');
  const hintEl = document.getElementById('loginHint');
  const highlightsEl = document.getElementById('gateHighlights');
  const submitBtn = document.querySelector('#loginForm button[type="submit"]');

  // All fields stay in flow (visibility:hidden, not display:none)
  // so .gate-box height is constant across modes.
  if (mode === 'demo') {
    if (keyField) { keyField.style.display = ''; keyField.style.visibility = 'hidden'; }
    if (urlField) { urlField.style.display = ''; urlField.style.visibility = 'hidden'; }
    if (urlLabel) { urlLabel.style.display = ''; urlLabel.style.visibility = 'hidden'; }
    if (hintEl) { hintEl.style.display = ''; hintEl.textContent = t('login.hint_demo'); }
    if (highlightsEl) highlightsEl.style.display = 'none';
    if (submitBtn) submitBtn.textContent = t('login.btn_demo');
  } else if (mode === 'googledrive') {
    if (keyField) keyField.style.display = 'none';
    if (urlField) urlField.style.display = 'none';
    if (urlLabel) urlLabel.style.display = 'none';
    if (hintEl) hintEl.style.display = 'none';
    if (highlightsEl) highlightsEl.style.display = '';
    if (submitBtn) submitBtn.textContent = t('login.btn_googledrive');
  } else if (mode === 'local') {
    if (keyField) { keyField.style.display = ''; keyField.style.visibility = 'hidden'; }
    if (urlField) { urlField.style.display = ''; urlField.style.visibility = ''; urlField.placeholder = 'http://localhost:3737'; }
    if (urlLabel) { urlLabel.style.display = ''; urlLabel.style.visibility = ''; }
    if (urlLabelLink) { urlLabelLink.textContent = t('login.url_label_local'); urlLabelLink.removeAttribute('href'); }
    if (hintEl) { hintEl.style.display = ''; hintEl.textContent = t('login.hint_local'); }
    if (highlightsEl) highlightsEl.style.display = 'none';
    if (submitBtn) submitBtn.textContent = t('login.connect');
  }
}

// ===================================================================
// GATE LOGIC
// ===================================================================
function initGate() {
  // Populate backend logo placeholders from single source of truth
  document.querySelectorAll('[data-backend-logo]').forEach(el => {
    const mode = el.dataset.backendLogo;
    const size = parseInt(el.dataset.logoSize, 10) || 18;
    if (LOGOS[mode]) el.innerHTML = LOGOS[mode](size);
  });
  document.querySelectorAll('.backend-option[data-mode]').forEach(btn => {
    const mode = btn.dataset.mode;
    if (LOGOS[mode] && !btn.querySelector('svg, .backend-icon-img')) {
      const labelSpan = btn.querySelector('.backend-option-label');
      if (labelSpan) btn.insertAdjacentHTML('afterbegin', LOGOS[mode](16));
      else btn.innerHTML = LOGOS[mode](16);
    }
  });
  // Wire up backend picker
  document.querySelectorAll('.backend-option').forEach(btn => {
    btn.addEventListener('click', () => switchBackendMode(btn.dataset.mode));
  });
  // Wire up compare link
  document.getElementById('backendCompareLink')?.addEventListener('click', (e)=>{e.preventDefault(); showCompareModal();});
  // Hero demo button: click starts demo directly
  const heroDemoBtn = document.getElementById('heroDemoBtn');
  if (heroDemoBtn) {
    heroDemoBtn.addEventListener('click', () => {
      switchBackendMode('demo');
      document.getElementById('loginForm')?.querySelector('button[type="submit"]')?.click();
    });
  }
  // Check if "Stay connected" credentials exist in localStorage
  const saved = getStayConnectedCreds();
  if (saved) {
    // Restore backend mode
    switchBackendMode(saved.mode || 'googledrive');
    // Inject static logo (hero is skipped)
    injectGateLogo();
    // Hide the login form entirely during auto-reconnect — only show the gate logo
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('username').value = saved.url;
    document.getElementById('password').value = saved.key;
    autoConnect(saved.url, saved.key, saved.mode);
    return;
  }
  // Check if returning from signup overlay with a pre-selected backend
  const signupMode = localStorage.getItem('claw_signup_mode');
  localStorage.removeItem('claw_signup_mode');
  // Set login hash (user is on the login page) — preserve #setup if present
  // Skip hero when returning from signup — go straight to the login form
  if (window.location.hash !== '#setup' && !signupMode) {
    history.replaceState(null, '', '#login');
    showHero();
  }
  switchBackendMode(signupMode || 'googledrive');
  // First visit: show welcome panel instead of login form
  // Skip welcome and go straight to login form if coming from signup
  const gateWelcome = document.getElementById('gateWelcome');
  if (signupMode) {
    gateWelcome.style.display = 'none';
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('gateGuideLink').style.display = 'none';
  } else {
    gateWelcome.style.display = 'block';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('gateGuideLink').style.display = 'none';
  }
  // "Try the demo" button
  document.getElementById('gateWelcomeDemo').addEventListener('click', () => {
    switchBackendMode('demo');
    doLogin();
  });
  // "I already have an account" link
  document.getElementById('gateWelcomeLogin').addEventListener('click', (e) => { e.preventDefault();
    gateWelcome.style.display = 'none';
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('gateGuideLink').style.display = 'none';
  });
  // Try auto-fill from Credential Management API
  if (window.PasswordCredential) {
    navigator.credentials.get({ password: true, mediation: 'optional' }).then(cred => {
      if (cred) {
        document.getElementById('username').value = cred.id;
        document.getElementById('password').value = cred.password;
      }
    }).catch(() => {});
  }
}

async function autoConnect(url, key, mode) {
  try {
    await connect(url, key, mode, /* skipDemoChooser */ true, { silentAuth: mode === 'googledrive' });
  } catch (e) {
    console.warn('[DeLaClaw] autoConnect failed:', e.message, e.orig || e);
    if (mode === 'googledrive') {
      // Silent OAuth refresh failed (common on mobile — Safari ITP blocks
      // third-party cookies in the GIS iframe). Show a minimal reconnect
      // screen instead of the full hero/gate. The "Reconnect" tap provides
      // the user gesture the browser needs for the OAuth popup.
      showDriveReconnectScreen(url, key);
      return;
    }
    if (e.message === 'schema_missing') {
      // New project without schema — don't clear creds, show actionable message
      showHero();
      const form = document.getElementById('loginForm');
      if (form) form.style.display = 'flex';
      const err = document.getElementById('loginError');
      renderSchemaMissingError(err);
      // Keep URL/key in form for user to retry after running schema
      const uEl = document.getElementById('username');
      const kEl = document.getElementById('password');
      if (uEl) uEl.value = url;
      if (kEl) kEl.value = key;
      return;
    }
    // Stored credentials are stale — clear them and show the full login form
    clearStayConnectedCreds();
    showHero();
    document.getElementById('loginForm').style.display = 'flex';
    document.getElementById('loginError').textContent = t('toast.session_expired');
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('username').focus();
  }
}

function showDriveReconnectScreen(url, key) {
  // Remove any previous instance
  document.getElementById('driveReconnectScreen')?.remove();

  const screen = document.createElement('div');
  screen.id = 'driveReconnectScreen';
  screen.className = 'drive-reconnect-screen';

  // Reuse the gate logo (storm SVG)
  const logoWrap = document.createElement('div');
  logoWrap.className = 'drive-reconnect-logo';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'storm-logo');
  svg.setAttribute('viewBox', '0 0 400 400');
  // Use the same generator as the gate logo
  svg.innerHTML = generateStorm(LOGO_DEFAULTS, 400);
  logoWrap.appendChild(svg);

  const title = document.createElement('h1');
  title.className = 'drive-reconnect-title';
  title.textContent = 'DeLaClaw';

  const msg = document.createElement('p');
  msg.className = 'drive-reconnect-msg';
  msg.textContent = t('login.drive_session_expired') || 'Your Google Drive session has expired.';

  const actions = document.createElement('div');
  actions.className = 'drive-reconnect-actions';

  const reconnectBtn = document.createElement('button');
  reconnectBtn.className = 'btn-primary drive-reconnect-primary';
  reconnectBtn.textContent = t('login.drive_reconnect') || 'Reconnect';
  reconnectBtn.addEventListener('click', async () => {
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = t('toast.connecting') || 'Connecting…';
    try {
      await connect(url, key, 'googledrive', true, { silentAuth: false });
      screen.remove();
    } catch (err) {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = t('login.drive_reconnect') || 'Reconnect';
      msg.textContent = t('login.drive_reconnect_failed') || 'Could not reconnect — try again.';
    }
  });

  const backBtn = document.createElement('button');
  backBtn.className = 'drive-reconnect-secondary';
  backBtn.textContent = t('login.drive_back_to_login') || 'Switch account';
  backBtn.addEventListener('click', () => {
    screen.remove();
    clearStayConnectedCreds();
    showHero();
    document.getElementById('loginForm').style.display = 'flex';
  });

  actions.appendChild(reconnectBtn);
  actions.appendChild(backBtn);
  screen.appendChild(logoWrap);
  screen.appendChild(title);
  screen.appendChild(msg);
  screen.appendChild(actions);
  document.body.appendChild(screen);
}



function getStayConnectedCreds() {
  try {
    const raw = localStorage.getItem(STAY_CONNECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.mode === 'demo') return parsed;
    if (parsed && parsed.mode === 'googledrive') return parsed;
    if (parsed && parsed.url && parsed.mode === 'local') return parsed;
    return null;
  } catch { return null; }
}

function saveStayConnectedCreds(url, key, mode) {
  const m = mode || 'googledrive';
  // Never persist keys — only URL and mode
  localStorage.setItem(STAY_CONNECTED_KEY, JSON.stringify({ url, key: '', mode: m }));
}

function clearStayConnectedCreds() {
  localStorage.removeItem(STAY_CONNECTED_KEY);
}

async function disconnect() {
  // Force-save and clean up Drive adapter before disconnecting
  if (state.driveMode && state.driveAdapter) {
    try { await state.driveAdapter.forceSave(); } catch {}
    if (state.sharing) { try { state.sharing.destroy(); } catch {} }
    if (state.driveAdapter.destroy) state.driveAdapter.destroy();
  }
  clearStayConnectedCreds();
  location.reload();
}


function renderSchemaMissingError(container) {
  if (!container) return;
  container.textContent = '';
  container.style.lineHeight = '1.4';
  container.style.maxWidth = '360px';

  const title = document.createElement('div');
  title.textContent = t('toast.schema_missing') || 'Tables not found on the server.';
  title.style.fontWeight = '600';
  title.style.marginBottom = '2px';
  container.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = t('toast.schema_missing_hint') || 'Make sure the DeLaClaw server is running with the schema loaded, then retry Connect.';
  hint.style.fontSize = '0.8em';
  hint.style.opacity = '0.75';
  hint.style.marginTop = '8px';
  container.appendChild(hint);
}

async function doLogin() {
  const url = document.getElementById('username').value.trim();
  const key = document.getElementById('password').value.trim();
  const stayConnected = document.getElementById('stayConnected').checked;
  const err = document.getElementById('loginError');
  const mode = getSelectedMode();
  if (mode !== 'demo' && mode !== 'googledrive' && (!url || (!key && mode !== 'local'))) { err.textContent = t('toast.enter_name'); return; }
  err.textContent = t('toast.connecting');
  try {
    const result = await connect(url, key, mode);
    if (result === false) {
      err.textContent = '';
      return;
    }
    err.textContent = '';
    // Save credentials if "Stay connected" is checked
    if (stayConnected) {
      saveStayConnectedCreds(url, key, mode);
    }
    // Hide the form — signals "successful login" to Chrome's password manager
    document.getElementById('loginForm').style.display = 'none';
    // Also explicitly store via Credential Management API
    if (window.PasswordCredential && mode !== 'demo') {
      try {
        const cred = new PasswordCredential({ id: url, password: key });
        await navigator.credentials.store(cred);
      } catch(e) {}
    }
  } catch (e) {
    if (e.message === 'schema_missing') {
      renderSchemaMissingError(err);
    } else if (e.message === 'google_not_loaded') {
      err.textContent = t('login.drive_gis_blocked') || 'Google sign-in is blocked. Disable your ad blocker or allow third-party scripts.';
    } else if (e.message === 'popup_closed_by_user' || e.message === 'access_denied') {
      err.textContent = t('login.drive_cancelled') || 'Google sign-in was cancelled.';
    } else if (e.message === 'drive_scope_denied') {
      err.textContent = t('login.drive_scope_denied') || 'DeLaClaw needs Google Drive access to store your data. Please try again and accept the Drive permission.';
    } else if (e.message === 'popup_failed_to_open') {
      err.textContent = t('login.drive_popup_blocked') || 'Pop-up blocked by your browser — please try again.';
    } else {
      console.error('[DeLaClaw] connect error:', e);
      err.textContent = t('toast.connection_failed');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Wrap all save/add/submit actions with guard() to prevent double-fire
  const guardedNames = [
    'saveNewBirthday', 'saveEditBirthday', 'removeAvatar',
    'saveNewDraft', 'saveEditedProposal', 'saveNewFlashcard', 'saveEditFlashcard',
    'saveNewText', 'saveEditText', 'submitFeedback', 'submitTextReview',
    'saveEditDeck',
    'saveNewHabit', 'saveEditHabit', 'saveHabitCompletion', 'addHabitFromInput',
    'saveNewHabitCategory', 'saveEditHabitCategory',
    'promoteHabit',
    'saveNewList', 'saveEditList',
    'addTask', 'saveNewProject', 'saveEditProject', 'submitRevision',
    'saveNewCategory', 'saveEditCategory', 'snoozeFor', 'submitSnooze', 'addTodoToCategory',
    'saveNewVestiaire', 'saveEditVestiaire',
    'saveNewVestiaireCategory', 'saveEditVestiaireCategory',
    'executeConfirmAction',
    'quickAddDraft', 'quickAddListItem',
    'saveGlobalPrompt', 'saveProjectPrompt',
  ];
  for (const name of guardedNames) {
    if (typeof window[name] === 'function') window[name] = guard(window[name]);
  }

  initGate();
  document.getElementById('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    doLogin();
  });
  // Hero skip link — jump straight to login
  const heroSkip = document.getElementById('heroSkip');
  if (heroSkip) {
    heroSkip.addEventListener('click', e => {
      e.preventDefault();
      // Smooth-scroll to the gate so the storm transition plays out
      const gate = document.getElementById('gate');
      if (gate) {
        gate.scrollIntoView({ behavior: 'smooth' });
        // Focus the username field after scroll finishes
        setTimeout(() => document.getElementById('username')?.focus(), 800);
      } else {
        hideHero();
        window.scrollTo(0, 0);
        document.getElementById('username')?.focus();
      }
    });
  }

  // ── Setup Guide toggle ──
  const guideLink = document.getElementById('gateGuideLink');
  const guidePanel = document.getElementById('setupGuide');
  const gateBox = document.querySelector('.gate-box');
  const setupBack = document.getElementById('setupBack');
  const setupLocalDone = document.getElementById('setupLocalDone');
  const setupDriveDone = document.getElementById('setupDriveDone');

  function showGuide() {
    hideHero();
    window.scrollTo(0, 0);
    if (gateBox) gateBox.style.display = 'none';
    if (guidePanel) guidePanel.style.display = '';
    document.body.style.overflow = 'hidden';
    history.replaceState(null, '', '#setup');
  }
  function hideGuide() {
    if (guidePanel) guidePanel.style.display = 'none';
    if (gateBox) gateBox.style.display = '';
    document.body.style.overflow = '';
    history.replaceState(null, '', '#login');
  }
  function showSteps(path) {
    const local = document.getElementById('setupLocalSteps');
    const drive = document.getElementById('setupDriveSteps');
    const cardLocal = document.getElementById('setupPathLocal');
    const cardDrive = document.getElementById('setupPathDrive');
    [local, drive].forEach(el => el && (el.style.display = 'none'));
    [cardLocal, cardDrive].forEach(el => el?.classList.remove('active'));
    if (path === 'drive') {
      drive.style.display = ''; cardDrive.classList.add('active');
    } else {
      local.style.display = ''; cardLocal.classList.add('active');
    }
  }

  if (guideLink) guideLink.addEventListener('click', e => { e.preventDefault(); showGuide(); });
  if (setupBack) setupBack.addEventListener('click', hideGuide);
  if (setupLocalDone) setupLocalDone.addEventListener('click', hideGuide);
  if (setupDriveDone) setupDriveDone.addEventListener('click', hideGuide);
  document.getElementById('setupPathLocal')?.addEventListener('click', () => showSteps('local'));
  document.getElementById('setupPathDrive')?.addEventListener('click', () => showSteps('drive'));
  document.getElementById('setupCompareLink')?.addEventListener('click', (e) => { e.preventDefault(); showCompareModal(); });

  // ── Setup wizard: one step at a time ──
  document.querySelectorAll('.setup-steps').forEach(container => {
    const bar = container.querySelector('.setup-progress');
    if (!bar) return;
    const progressDots = bar.querySelectorAll('.setup-progress-step');
    const progressLines = bar.querySelectorAll('.setup-progress-line');
    const contentSteps = container.querySelectorAll('.setup-step[data-step]');
    const doneBtn = container.querySelector(':scope > .setup-done-btn');
    const totalSteps = contentSteps.length;
    if (!totalSteps) return;

    // Create nav buttons
    const nav = document.createElement('div');
    nav.className = 'setup-step-nav';
    const backBtn = document.createElement('button');
    backBtn.className = 'setup-nav-btn';
    backBtn.type = 'button';
    backBtn.textContent = t('setup.back') || 'Back';
    const nextBtn = document.createElement('button');
    nextBtn.className = 'setup-nav-btn setup-nav-next';
    nextBtn.type = 'button';
    nextBtn.textContent = t('setup.next') || 'Next';
    nav.appendChild(backBtn);
    nav.appendChild(nextBtn);
    if (doneBtn) container.insertBefore(nav, doneBtn);
    else container.appendChild(nav);

    function goTo(n) {
      // Show/hide content steps
      contentSteps.forEach(s => {
        s.style.display = parseInt(s.dataset.step) === n ? '' : 'none';
      });
      // Update progress dots + lines
      progressDots.forEach((dot, i) => {
        const sn = i + 1;
        dot.classList.toggle('done', sn < n);
        dot.classList.toggle('active', sn === n);
      });
      progressLines.forEach((line, i) => {
        line.classList.toggle('done', i + 1 < n);
      });
      // Nav visibility
      backBtn.style.display = n <= 1 ? 'none' : '';
      nextBtn.style.display = n >= totalSteps ? 'none' : '';
      if (doneBtn) doneBtn.style.display = n >= totalSteps ? '' : 'none';
    }

    backBtn.addEventListener('click', () => {
      const cur = [...progressDots].findIndex(d => d.classList.contains('active')) + 1;
      if (cur > 1) goTo(cur - 1);
    });
    nextBtn.addEventListener('click', () => {
      const cur = [...progressDots].findIndex(d => d.classList.contains('active')) + 1;
      if (cur < totalSteps) goTo(cur + 1);
    });
    progressDots.forEach((dot, i) => {
      dot.style.cursor = 'pointer';
      dot.addEventListener('click', () => goTo(i + 1));
    });

    goTo(1);
  });

  // Auto-show guide if URL hash is #setup
  if (window.location.hash === '#setup') showGuide();
});

// ===================================================================
// UNLOCK & INIT APP
// ===================================================================
async function connect(url, key, mode = 'googledrive', skipDemoChooser = false, { silentAuth = false } = {}) {
  // url/key kept for local REST backend configuration

  let initialSharingLoad = Promise.resolve();
  const loadInitialSharing = (label = 'sharing') => {
    if (!state.sharing?.loadAll) {
      initialSharingLoad = Promise.resolve();
      return initialSharingLoad;
    }
    initialSharingLoad = state.sharing.loadAll()
      .catch(e => console.warn(`${label} loadAll:`, e));
    return initialSharingLoad;
  };
  const loadSharingAndNotify = (label = 'sharing') => {
    const p = loadInitialSharing(label);
    p.then(() => document.dispatchEvent(new CustomEvent('sharing-changed')));
    return p;
  };

  // For demo mode, resolve the chooser BEFORE any state changes.
  // If the user cancels, nothing was modified — clean exit.
  let demoData = null;
  if (mode === 'demo') {
    const { getDemoData, getEmptyData } = await import('./demo-data.js');
    const lang = getLang();

    if (!skipDemoChooser) {
      const { showDemoChooser } = await import('./demo-chooser.js');
      const choice = await showDemoChooser(lang);
      if (choice.type === 'cancelled') return false;
      demoData = (choice.type === 'custom' && choice.data)
        ? Object.assign(getEmptyData(), choice.data)
        : getDemoData(lang);
    } else {
      demoData = getDemoData(lang);
    }
  }

  // Swap scoped localStorage to the target backend
  swapLsScope(mode);
  // Re-apply theme from the restored scope (may differ from pre-swap)
  const scopedTheme = localStorage.getItem(THEME_KEY);
  applyTheme(scopedTheme || getSystemTheme());

  let adapter;
  if (mode === 'demo') {
    const { createDemoAdapter } = await import('./adapters/demo.js');
    adapter = createDemoAdapter(demoData);
    state.demoAdapter = adapter;
    state.demoMode = true;
    setDemoCategoriesFromData(demoData);
    // Initialize sharing stub so share buttons render (groups are gated)
    const { createSharing } = await import('./sharing.js');
    state.sharing = await createSharing('demo');
  } else if (mode === 'googledrive') {
    const { createDriveAdapter } = await import('./adapters/drive.js');
    const errEl = document.getElementById('loginError');
    const progressEl = document.getElementById('driveProgress');
    const progressText = document.getElementById('driveProgressText');
    const progressFill = document.getElementById('driveProgressFill');
    adapter = await createDriveAdapter(GOOGLE_CLIENT_ID, (ev) => {
      if (!ev) return;
      // Hide error text, show progress bar
      if (errEl) errEl.textContent = '';
      if (progressEl) progressEl.style.display = '';
      if (progressText) progressText.textContent = ev.message || '';
      if (progressFill && ev.total > 0) {
        progressFill.style.width = `${Math.round((ev.progress / ev.total) * 100)}%`;
      } else if (progressFill && !ev.total) {
        // Indeterminate: pulse at 40%
        progressFill.style.width = '40%';
      }
      if (ev.status === 'ready' && progressEl) progressEl.style.display = 'none';
    }, { silent: silentAuth });
    state.driveAdapter = adapter;
    state.driveMode = true;

  } else if (mode === 'local') {
    adapter = createRestAdapter(url);
    // Test connection with raw adapter BEFORE wrapping with offline cache
    const { error } = await adapter.from('projects').select('id').limit(1);
    if (error) {
      console.warn('[DeLaClaw] local projects check failed:', error);
      const st = error.status || error.statusCode;
      const m = String(error.message || '').toLowerCase();
      const d = String(error.details || '').toLowerCase();
      const missing = st === 404 || m.includes('does not exist') || d.includes('does not exist') || m.includes('not found') || m.includes('could not find') || m.includes('schema');
      if (missing) {
        const e = new Error('schema_missing');
        e.orig = error;
        throw e;
      }
      throw new Error('Connection failed');
    }
    const scopeRef = url.replace(/^https?:\/\//, '');
    adapter = wrapWithOfflineCache(adapter, `local:${scopeRef}`);
  }
  db.setAdapter(adapter);

  // Flush pending Drive saves and stop polling on page close
  if (mode === 'googledrive' && adapter.forceSave) {
    window.addEventListener('beforeunload', () => {
      // Force-save first, then clean up — destroy() clears timers
      adapter.forceSave().catch(() => {});
      if (adapter.destroy) adapter.destroy();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // Flush when tab goes background (mobile doesn't reliably fire beforeunload)
        adapter.forceSave().catch(() => {});
      } else if (document.visibilityState === 'visible' && adapter.pollNow) {
        // Catch up on external changes immediately when tab comes back
        adapter.pollNow();
      }
    });
    // Poll on window focus (catches desktop window switching, not just tab switching)
    window.addEventListener('focus', () => { if (adapter.pollNow) adapter.pollNow(); });
  }

  document.getElementById('gate').style.display = 'none';
  document.getElementById('gateToolbar').style.display = 'none';
  hideHero();
  document.getElementById('app').classList.add('active');

  // Re-render logos now that the app is visible and layout is computed
  initLogos();

  // Footer backend badge — clickable for backends with a meaningful external URL
  const footerBackend = document.getElementById('footerBackend');
  if (footerBackend && LOGOS[mode]) {
    const logo = LOGOS[mode](14);
    const label = LABELS[mode] || mode;
    let href = null;
    if (mode === 'googledrive') {
      const fid = state.driveAdapter?.driveFolderId;
      // Drive folder ID: allowlist alphanumeric + -_ (Google ID format)
      if (fid && /^[\w-]+$/.test(fid)) {
        href = `https://drive.google.com/drive/folders/${fid}`;
      } else {
        href = 'https://drive.google.com';
      }
    }
    // Safe DOM: href set via property, logo is trusted SVG from LOGOS
    footerBackend.textContent = '';
    if (href && /^https:\/\/drive\.google\.com\//.test(href)) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `${logo} <span>${label} ↗</span>`;
      footerBackend.appendChild(a);
    } else {
      footerBackend.innerHTML = `${logo} <span>${label}</span>`;
    }
  }


  await loadProjects();
  buildProjectCards();
  initProjectModals();
  initProjectDragDrop();
  updateArchiveToggleBtn();
  renderArchivedProjects();

  // Load user settings from DB (before tab visibility / view restore)
  await loadSettings();

  // Init calendar sync module (for Drive and Demo backends only)
  if (state.demoMode || state.driveMode) {
    initCalSync(state.driveMode ? adapter.getToken : null);
    // Hook calendar sync to Drive flush so they stay coupled
    if (state.driveMode) {
      adapter._markCalDirty = markCalDirty;
      adapter._onTableFlushed = (table) => {
        // Category table flush → sync the corresponding item table
        const itemTable = CAT_TABLE_TO_ITEM_TABLE[table];
        const syncTarget = itemTable || table;
        syncCalendarTable(syncTarget).catch(e => console.warn('Calendar table sync:', e));
      };
    }
    // No full sync on page load — trust calendar is already synced.
    // Full push only happens on first enable (toggleCalSync).
  }

  // Restore view early (before async refreshes) to avoid flash
  applyTabVisibility();
  const validViews = ['welcome', 'projects', 'todos', 'habits', 'birthdays', 'vestiaire', 'flashcards', 'lists'];
  const rawHash = location.hash.replace('#', '');
  const isSettingsHash = location.hash === '#settings' || location.hash.startsWith('#settings/');
  const hashView = validViews.includes(rawHash) ? rawHash : null;
  let savedView = hashView || localStorage.getItem(CURRENT_VIEW_KEY) || 'welcome';
  if (!isTabVisible(savedView)) {
    const firstVisible = getVisibleTabs()[0];
    savedView = firstVisible ? firstVisible.key : 'welcome';
  }
  switchView(savedView, isSettingsHash);

  // Listen for back/forward navigation
  window.addEventListener('hashchange', () => {
    const hash = location.hash;
    // Settings deep links
    if (hash === '#settings' || hash.startsWith('#settings/')) {
      const pane = hash.split('/')[1] || 'general';
      const modal = document.getElementById('settingsModal');
      if (!modal?.classList.contains('visible')) openSettings(pane);
      else if (SETTINGS_PANES.includes(pane)) switchSettingsPane(pane);
      return;
    }
    // Close settings if navigating away
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal?.classList.contains('visible')) closeSettings();
    const deepLink = parseDeepLink(hash);
    if (deepLink) {
      navigateToItem(deepLink.type, deepLink.id);
      return;
    }
    const raw = hash.replace('#', '');
    const h = validViews.includes(raw) ? raw : 'welcome';
    if (h !== state.currentView) switchView(h);
  });

  await refreshAll();

  // Calendar sync auto-enable: if Calendar scope was granted at sign-in
  // and the user has never had calendar sync set (key absent), enable it.
  // Once the key exists (true or false), the user's choice is respected.
  if (state.driveMode && state.driveAdapter?.calendarScopeGranted) {
    const { data: syncSetting } = await state.db.from('settings').select('value').eq('key', 'gcal_sync_enabled');
    const keyExists = syncSetting && syncSetting.length > 0;
    if (!keyExists) {
      try {
        const calId = await enableCalSync();
        if (calId) {
          showToast(t('cal_sync.enabled'), 'success');
          await updateCalSyncUI();
          await reconcileCalendar();
        }
      } catch (e) {
        console.warn('Calendar sync auto-enable failed:', e);
      }
    }
  }

  dismissSchemaBanner();
  recordDailyVisit();

  // Clean up any legacy localStorage ideas (one-time)
  localStorage.removeItem(IDEAS_KEY);

  // Realtime subscription (skip for demo/googledrive — no Postgres backend)
  // Debounce: bulk sort_order updates emit one event per row; collapse into a single refresh.
  function debouncedHandler(fn, ms = 300) {
    let timer = null;
    return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
  }
  if (mode !== 'demo' && mode !== 'googledrive') {
    state.db.channel('tasks-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, debouncedHandler(() => { if (!isEditing()) refreshAll().then(() => markLastUpdated()); }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, debouncedHandler(() => loadPrompts()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, debouncedHandler(() => { if (!isEditing()) refreshTodos().then(() => markLastUpdated()); }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'habits' }, debouncedHandler(() => refreshHabits().then(() => markLastUpdated())))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'habit_completions' }, debouncedHandler(() => refreshHabits().then(() => markLastUpdated())))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'birthdays' }, debouncedHandler(() => refreshBirthdays().then(() => markLastUpdated())))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vestiaire' }, debouncedHandler(() => refreshVestiaire().then(() => markLastUpdated())))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcards' }, debouncedHandler(() => refreshFlashcards().then(() => markLastUpdated())))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcard_notes' }, debouncedHandler(() => refreshFlashcards().then(() => markLastUpdated())))
      .subscribe();
  }

  // ── Sharing resilience event listeners (must be registered before any loadAll fires) ──
  document.addEventListener('sharing-group-unreachable', (e) => {
    const name = e.detail?.groupName || '';
    showToast(t('sharing.group_unreachable', name), 'info');
    renderSharingPane();
  });
  document.addEventListener('sharing-group-deletion-confirm', async (e) => {
    const { groupId, groupName } = e.detail || {};
    if (!groupId) return;
    showConfirmAction(
      t('sharing.group_confirm_delete_title'),
      t('sharing.group_confirm_delete_msg', groupName),
      async () => {
        await state.sharing.confirmGroupDeletion(groupId);
        renderSharingPane();
      },
      null,
      {
        btnText: t('sharing.group_confirm_remove_btn'),
        cancelLabel: t('sharing.group_confirm_keep_btn'),
        variant: 'neutral',
        iconSvg: lucideIcon('wifi-off', 24, 'currentColor'),
        onCancel: () => {
          state.sharing.keepGroup(groupId);
          renderSharingPane();
        },
      }
    );
  });
  document.addEventListener('sharing-group-recovered', () => {
    renderSharingPane();
  });

  // Drive: wire poll-based change detection to the same refresh functions
  if (mode === 'googledrive' && state.driveAdapter) {
    const driveRefreshMap = {
      tasks: () => refreshAll(),
      projects: async () => { await loadProjects(); buildProjectCards(); initProjectDragDrop(); await refreshAll(); },
      prompts: () => loadPrompts(),
      todos: () => refreshTodos(),
      habits: () => refreshHabits(),
      habit_completions: () => refreshHabits(),
      birthdays: () => refreshBirthdays(),
      vestiaire: () => refreshVestiaire(),
      flashcards: () => refreshFlashcards(),
      flashcard_notes: () => refreshFlashcards(),
      lists: () => refreshLists(),
      list_items: () => refreshLists(),
      settings: () => loadSettings(),
    };
    state.driveAdapter._onExternalChange = (table) => {
      if (isEditing()) return;
      const fn = driveRefreshMap[table];
      if (fn) fn().then(() => markLastUpdated()).catch(e => console.warn('Drive refresh error:', e));
      else markLastUpdated();
    };

    // Wire up Drive sharing module
    try {
      const { createSharing } = await import('./sharing.js');
      state.sharing = await createSharing('googledrive', {
        getToken: () => state.driveAdapter.getToken(),
        personalFolderId: state.driveAdapter.driveFolderId,
        capabilities: {
          openJoinPicker: (folderId) => state.driveAdapter.openSharedFolderPicker(folderId),
        },
      });
      loadInitialSharing('sharing');
      state.sharing.startPolling();
      state.sharing.onUpdate(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      });
      updateSharingNavVisibility();

    } catch (e) { console.warn('sharing init:', e); }
  }


  // Always update sharing nav visibility (even if sharing init failed or was skipped)
  updateSharingNavVisibility();

  // Ensure shared groups/items are loaded before the first feature refresh.
  // Otherwise local shared pointers render as blank rows until the next poll.
  await initialSharingLoad;

  // Initialize TODOs
  initTodoModals();
  if (state.sharing) await syncSharedTodos();
  await refreshTodos();

  // Initialize Habits
  initHabitModals();
  if (state.sharing) await syncSharedHabits();
  await refreshHabits();

  // Initialize Birthdays
  initBirthdayModals();
  await refreshBirthdays();

  // Initialize Wardrobe
  initVestiaireModals();
  await refreshVestiaire();

  // Initialize Flashcards
  initFlashcardModals();
  await refreshFlashcards();

  // Initialize Lists
  initListModals();
  if (state.sharing) await syncSharedListItems();
  await refreshLists();

  // Re-render Welcome now that all data (birthdays, habits, flashcards…) is loaded.
  // The initial switchView() call above rendered Welcome before async data was ready.
  if (state.currentView === 'welcome') {
    await refreshWelcome();
    renderWelcome();
  }

  markLastUpdated();

  // Deep-link navigation on startup — all page data is loaded, no retry loop needed
  handleStartupDeepLink();

  // Listen for sharing updates (Drive sharing module polls and fires sharing-changed)
  document.addEventListener('sharing-changed', async () => {
    try {
      // syncShared* functions refresh their own data when pointers change;
      // always do a full refresh afterwards so deletions / conversions are
      // picked up even when sync itself found nothing new.
      await syncSharedTodos();
      await syncSharedHabits();
      await syncSharedListItems();
      await refreshTodos();
      await refreshHabits();
      await refreshLists();
    } catch (e) {
      console.warn('sharing refresh:', e);
    }
    // Re-render sharing pane if it's currently visible
    const sharingPane = document.getElementById('settingsPane-sharing');
    if (sharingPane?.classList.contains('active')) renderSharingPane();
    // Update footer groups count
    const footerGc = document.getElementById('footerGroupCount');
    if (footerGc && state.sharing) {
      const gc = state.sharing.getAllGroups().length;
      footerGc.innerHTML = `${lucideIcon('users', 14)} ${gc} group${gc !== 1 ? 's' : ''}`;
    }
  });

  // Notify user when a group is removed remotely (kicked or group deleted)
  document.addEventListener('sharing-group-removed-remotely', (e) => {
    const name = e.detail?.groupName || '';
    showToast(t('sharing.group_removed_remotely', name), 'info');
  });

  // Show demo banner if in demo mode
  if (mode === 'demo') initDemoBanner();

  // Offer PWA install on phones/tablets when not already installed.
  // In demo mode this stacks below the demo banner (see install-banner CSS).
  maybeShowInstallBanner();
}


// ===================================================================
// DEMO BANNER
// ===================================================================
function initDemoBanner() {
  // Remove any existing banner
  document.querySelector('.demo-banner')?.remove();

  const banner = document.createElement('div');
  banner.className = 'demo-banner';

  const left = document.createElement('span');
  left.textContent = t('demo.banner');

  const right = document.createElement('div');
  right.className = 'demo-banner-right';

  // Toggle demo data / empty
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = t('demo.show_empty');
  let showingData = true;
  toggleBtn.addEventListener('click', async () => {
    const { getDemoData, getEmptyData } = await import('./demo-data.js');
    if (showingData) {
      const empty = getEmptyData();
      state.demoAdapter.reseed(empty);
      setDemoCategoriesFromData(empty);
      toggleBtn.textContent = t('demo.show_data');
    } else {
      const data = getDemoData(getLang());
      state.demoAdapter.reseed(data);
      setDemoCategoriesFromData(data);
      toggleBtn.textContent = t('demo.show_empty');
    }
    showingData = !showingData;
    await loadProjects();
    buildProjectCards();
    initProjectDragDrop();
    updateArchiveToggleBtn();
    renderArchivedProjects();
    await refreshAll();
    await refreshTodos();
    await refreshHabits();
    await refreshBirthdays();
    await refreshVestiaire();
    await refreshFlashcards();
    await refreshLists();
    refreshWelcome();
  });

  // Start my own space — opens login overlay on top of demo
  const startOwnBtn = document.createElement('button');
  startOwnBtn.className = 'demo-banner-start';
  startOwnBtn.textContent = t('demo.start_own');
  startOwnBtn.addEventListener('click', () => {
    clearStayConnectedCreds();
    location.hash = '#setup';
    location.reload();
  });

  // Exit demo
  const exitBtn = document.createElement('button');
  exitBtn.textContent = t('demo.exit');
  exitBtn.addEventListener('click', () => disconnect());

  right.appendChild(toggleBtn);
  right.appendChild(startOwnBtn);
  right.appendChild(exitBtn);
  banner.appendChild(left);
  banner.appendChild(right);
  document.body.prepend(banner);
  document.body.classList.add('demo-mode');
  // Measure actual banner height and expose as CSS variable
  requestAnimationFrame(() => {
    document.body.style.setProperty('--demo-banner-h', banner.offsetHeight + 'px');
  });
}

function removeDemoBanner() {
  document.querySelector('.demo-banner')?.remove();
  document.body.classList.remove('demo-mode');
  document.body.style.removeProperty('--demo-banner-h');
}


// ===================================================================
// ORPHAN SHARED-ITEM HANDLER (module-level, survives reconnect)
// ===================================================================
const _orphanCounts = {};    // groupId -> consecutive detection count
const _orphanConfirmed = new Set();  // groups already unlinked
const _orphanQueue = [];     // queued groupIds awaiting dialog
let _orphanDialogOpen = false;

const ORPHAN_THRESHOLD = 2; // require N consecutive sync detections before prompting

document.addEventListener('sharing-orphan-detected', (e) => {
  const groupId = e.detail?.groupId;
  if (!groupId || _orphanConfirmed.has(groupId)) return;

  // Increment counter — only prompt after threshold consecutive detections
  _orphanCounts[groupId] = (_orphanCounts[groupId] || 0) + 1;
  if (_orphanCounts[groupId] < ORPHAN_THRESHOLD) return;

  // Avoid duplicate queue entries
  if (_orphanQueue.includes(groupId)) return;
  _orphanQueue.push(groupId);
  _processOrphanQueue();
});

function _processOrphanQueue() {
  if (_orphanDialogOpen || _orphanQueue.length === 0) return;
  const groupId = _orphanQueue[0];
  _orphanDialogOpen = true;
  const label = state.sharing?.getGroupName?.(groupId) || groupId.slice(0, 8);
  showConfirmAction(
    t('sharing.orphan_detected_title'),
    t('sharing.orphan_detected_message', label),
    async () => {
      _orphanConfirmed.add(groupId);
      _orphanQueue.shift();
      _orphanDialogOpen = false;
      // Delete pointer items with no local content; nullify ones that have text
      for (const table of ['habits', 'todos', 'list_items']) {
        const nameCol = table === 'habits' ? 'name' : 'text';
        const { data: rows } = await state.db.from(table).select('id,' + nameCol).eq('shared_group_id', groupId);
        if (!rows) continue;
        for (const row of rows) {
          const hasContent = (row[nameCol] || '').trim() !== '';
          if (hasContent) {
            await state.db.from(table).update({ shared_id: null, shared_group_id: null }).eq('id', row.id);
          } else {
            await state.db.from(table).delete().eq('id', row.id);
          }
        }
      }
      await refreshHabits(); await refreshTodos(); await refreshLists();
      showToast(t('sharing.group_deleted'), 'info');
      _processOrphanQueue(); // next in queue
    },
    null,
    {
      variant: 'neutral',
      btnText: t('sharing.orphan_unlink'),
      iconSvg: lucideIcon('unlink', 24),
      btnIconSvg: lucideIcon('unlink', 15, 'currentColor'),
      onCancel: () => {
        // Cancel — allow retry on next sync cycle
        delete _orphanCounts[groupId];
        _orphanQueue.shift();
        _orphanDialogOpen = false;
        _processOrphanQueue(); // next in queue
      },
    }
  );
}


// ===================================================================
// INSTALL BANNER (PWA)
// ===================================================================
const INSTALL_DISMISS_KEY = 'claw_cc_install_dismissed';

// How-to-install YouTube Shorts, per platform (same videos embedded in the docs).
const INSTALL_VIDEOS = {
  ios: 'uRh2HcT_KcY',      // iPhone — Safari Share → Add to Home Screen
  android: '54JBnBFZM_I',  // Android — Chrome → Add to Home Screen
};

function isIOSDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Show an "install the app" banner when the user is on a phone or tablet,
 * is NOT already running the installed PWA, and hasn't dismissed it before.
 * Android/Chromium gets a native install button (beforeinstallprompt).
 * Both platforms get a "Watch how" action that opens the matching install
 * video in an in-app lightbox (iOS has no programmatic install, so the video
 * is its primary path).
 */
function maybeShowInstallBanner() {
  if (isInstalledPWA()) return;                 // already installed — nothing to do
  if (deviceClass() === 'computer') return;     // laptops/desktops excluded
  if (localStorage.getItem(INSTALL_DISMISS_KEY) === '1') return; // user said not now
  if (document.getElementById('installBanner')) return;

  const isIOS = isIOSDevice();
  // Android/Chromium native install: if the event hasn't arrived yet, wait for
  // it before showing (so the Install button is live). iOS shows immediately.
  if (!isIOS && !window.__bipEvent) {
    window.addEventListener('bip-ready', () => maybeShowInstallBanner(), { once: true });
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'installBanner';
  banner.className = 'install-banner';

  const left = document.createElement('span');
  left.className = 'install-banner-msg';
  left.textContent = t('install.banner');

  const right = document.createElement('div');
  right.className = 'install-banner-right';

  // Native install button — Android/Chromium only (iOS has no programmatic install)
  if (!isIOS) {
    const installBtn = document.createElement('button');
    installBtn.className = 'install-banner-go';
    installBtn.textContent = t('install.btn');
    installBtn.addEventListener('click', async () => {
      const evt = window.__bipEvent;
      if (!evt) { removeInstallBanner(); return; }
      evt.prompt();
      try { await evt.userChoice; } catch (e) {}
      delete window.__bipEvent;
      removeInstallBanner();
    });
    right.appendChild(installBtn);
  }

  // "Watch how" — opens the platform-matched install video in a lightbox.
  // On iOS this is the primary (and only) action, so style it accordingly.
  const watchBtn = document.createElement('button');
  watchBtn.textContent = t('install.watch');
  if (isIOS) watchBtn.className = 'install-banner-go';
  watchBtn.addEventListener('click', () => showInstallHowModal(isIOS ? 'ios' : 'android'));
  right.appendChild(watchBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = t('install.dismiss');
  dismissBtn.addEventListener('click', () => {
    localStorage.setItem(INSTALL_DISMISS_KEY, '1');
    removeInstallBanner();
  });
  right.appendChild(dismissBtn);

  banner.appendChild(left);
  banner.appendChild(right);
  document.body.prepend(banner);
  document.body.classList.add('install-mode');
  requestAnimationFrame(() => {
    document.body.style.setProperty('--install-banner-h', banner.offsetHeight + 'px');
  });

  // If the app gets installed while the banner is up, clear it.
  window.addEventListener('app-installed', removeInstallBanner, { once: true });
}

function removeInstallBanner() {
  document.getElementById('installBanner')?.remove();
  document.body.classList.remove('install-mode');
  document.body.style.removeProperty('--install-banner-h');
}

/** Lightbox that plays the platform-matched install Short inside the app. */
function showInstallHowModal(platform) {
  const videoId = INSTALL_VIDEOS[platform] || INSTALL_VIDEOS.ios;
  document.getElementById('installHowModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'installHowModal';
  overlay.className = 'modal-overlay visible';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeInstallHowModal(); });

  const modal = document.createElement('div');
  modal.className = 'modal install-how-modal';

  const h2 = document.createElement('h2');
  h2.textContent = t('install.how_title');

  const frameWrap = document.createElement('div');
  frameWrap.className = 'install-how-video';
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
  iframe.title = t('install.how_title');
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  frameWrap.appendChild(iframe);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = t('common.close') || 'Close';
  closeBtn.addEventListener('click', closeInstallHowModal);
  actions.appendChild(closeBtn);

  modal.appendChild(h2);
  modal.appendChild(frameWrap);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function closeInstallHowModal() {
  // Removing the iframe stops playback.
  document.getElementById('installHowModal')?.remove();
}

async function onLangSwitchDemo(lang) {
  if (!state.demoMode || !state.demoAdapter) return;
  const { getDemoData } = await import('./demo-data.js');
  const data = getDemoData(lang);
  state.demoAdapter.reseed(data);
  setDemoCategoriesFromData(data);
  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  updateArchiveToggleBtn();
  renderArchivedProjects();
  await refreshAll();
  await refreshTodos();
  await refreshHabits();
  await refreshBirthdays();
  await refreshVestiaire();
  await refreshFlashcards();
  refreshWelcome();
  // Re-render banner text
  initDemoBanner();
}


// ===================================================================
// HEADER MENU (3-dot dropdown)
// ===================================================================
function applyLang() {
  // Highlight active language in menu
  const lang = getLang();
  document.querySelectorAll('.header-menu-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  // Highlight active language in gate toolbar
  document.querySelectorAll('.gate-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  updateStaticLabels();
}

function initHeaderMenu() {
  const menu = document.getElementById('headerMenu');
  const toggle = document.getElementById('headerMenuToggle');
  const dropdown = document.getElementById('headerMenuDropdown');
  if (!menu || !toggle || !dropdown) return;

  // Toggle dropdown
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
    // Update theme icon/label when opening
    if (menu.classList.contains('open')) updateMenuThemeItem();
  });

  // Language buttons (header menu)
  dropdown.querySelectorAll('.header-menu-lang-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const lang = btn.dataset.lang;
      if (lang && lang !== getLang()) {
        setLang(lang);
        applyLang();
        await onLangSwitchDemo(lang);
        reRenderCurrentView();
      }
    });
  });

  // Language buttons (settings modal)
  document.querySelectorAll('.settings-lang-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      if (lang && lang !== getLang()) {
        setLang(lang);
        applyLang();
        await onLangSwitchDemo(lang);
        reRenderCurrentView();
      }
    });
  });

  // Theme toggle
  document.getElementById('menuThemeToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTheme();
    updateMenuThemeItem();
  });

  // Settings
  document.getElementById('menuSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.remove('open');
    openSettings();
  });

  // Disconnect
  document.getElementById('menuDisconnect').addEventListener('click', () => {
    disconnect();
  });

  // Close on outside click
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', (e) => e.stopPropagation());
}

function updateMenuThemeItem() {
  const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
  const iconEl = document.getElementById('menuThemeIcon');
  if (iconEl) iconEl.innerHTML = current === 'light' ? lucideIcon('sun', 16) : lucideIcon('moon', 16);
  const themeSwitch = document.getElementById('themeToggle');
  if (themeSwitch) themeSwitch.classList.toggle('checked', current === 'dark');
  // Update gate theme button icon
  const gateBtn = document.getElementById('gateThemeBtn');
  if (gateBtn) gateBtn.innerHTML = current === 'light' ? lucideIcon('sun', 16) : lucideIcon('moon', 16);
}

function reRenderCurrentView() {
  const view = state.currentView;
  if (view === 'welcome') renderWelcome();
  else if (view === 'projects') refreshAll();
  else if (view === 'todos') renderTodos();
  else if (view === 'habits') renderHabits();
  else if (view === 'birthdays') renderBirthdays();
  else if (view === 'vestiaire') renderVestiaire();
  else if (view === 'flashcards') renderFlashcards();
  else if (view === 'lists') renderLists();
}

function updateStaticLabels() {
  // Nav tabs
  const tabLabels = { tabWelcome: 'nav.today', tabProjects: 'nav.projects', tabTodos: 'nav.todos', tabHabits: 'nav.habits',
    tabBirthdays: 'nav.birthdays', tabVestiaire: 'nav.wardrobe', tabFlashcards: 'nav.flashcards', tabLists: 'nav.lists' };
  for (const [id, key] of Object.entries(tabLabels)) {
    const el = document.getElementById(id);
    if (el) {
      // Keep the icon SVG, wrap text label in <span class="tab-label">
      const svg = el.querySelector('svg');
      const svgHtml = svg ? svg.outerHTML : '';
      el.innerHTML = svgHtml + ' <span class="tab-label">' + t(key) + '</span>';
    }
  }
  // Login — re-apply all mode-specific labels (hint, button, url/key labels, visibility)
  const loginMode = getSelectedMode();
  switchBackendMode(loginMode);
  const stayLabel = document.querySelector('.stay-connected-label span');
  if (stayLabel) stayLabel.textContent = t('login.stay_connected');
  // Search inputs
  const searchMap = {
    'projectsView': 'common.search',
    'todosView': 'common.search',
    'habitsView': 'common.search',
    'birthdaysView': 'common.search',
    'vestiaireView': 'common.search',
    'flashcardsView': 'flashcards.search_placeholder',
    'listsView': 'lists.search_placeholder',
  };
  for (const [viewId, key] of Object.entries(searchMap)) {
    const view = document.getElementById(viewId);
    if (view) {
      const input = view.querySelector('.page-search');
      if (input) input.placeholder = t(key) + '…';
      const toggle = view.querySelector('.search-toggle');
      if (toggle) toggle.title = t('common.search');
    }
  }
  // Todo filters
  const todoFilterMap = { pending: 'todos.pending' };
  document.querySelectorAll('#todoFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (todoFilterMap[f]) btn.textContent = t(todoFilterMap[f]);
  });
  // Todo sort
  const todoSort = document.getElementById('todoSortBy');
  if (todoSort) {
    todoSort.options[0].text = t('todos.sort_manual');
    todoSort.options[1].text = t('todos.sort_due');
    todoSort.options[2].text = t('todos.sort_priority');
    todoSort.options[3].text = t('todos.sort_created');
  }
  // Habit filters
  const habitFilterMap = { all: 'habits.filter_all', overdue: 'habits.filter_overdue', today: 'habits.filter_today', tomorrow: 'habits.filter_tomorrow' };
  document.querySelectorAll('#habitFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (habitFilterMap[f]) btn.textContent = t(habitFilterMap[f]);
  });
  // Habit sort
  const habitSort = document.getElementById('habitSortBy');
  if (habitSort) {
    habitSort.options[0].text = t('habits.sort_due');
    habitSort.options[1].text = t('habits.sort_name');
    habitSort.options[2].text = t('habits.sort_last_done');
  }
  // Project sort
  const projectSort = document.getElementById('projectSortBy');
  if (projectSort) {
    projectSort.options[0].text = t('projects.sort_manual');
    projectSort.options[1].text = t('projects.sort_name');
    projectSort.options[2].text = t('projects.sort_tasks');
  }
  // Lists sort
  const listsSort = document.getElementById('listsSortBy');
  if (listsSort) {
    listsSort.options[0].text = t('lists.sort_manual');
    listsSort.options[1].text = t('lists.sort_name');
  }
  // Birthday sort
  const birthdaySort = document.getElementById('birthdaySortBy');
  if (birthdaySort) {
    birthdaySort.options[0].text = t('birthdays.sort_upcoming');
    birthdaySort.options[1].text = t('birthdays.sort_name');
    birthdaySort.options[2].text = t('birthdays.sort_age');
  }
  // Vestiaire sort
  const vestSort = document.getElementById('vestiaireSortBy');
  if (vestSort) {
    vestSort.options[0].text = t('vestiaire.sort_manual');
    vestSort.options[1].text = t('vestiaire.sort_name');
    vestSort.options[2].text = t('vestiaire.sort_brand');
  }
  // Setup Guide
  const guideEl = document.getElementById('gateGuideLink');
  if (guideEl) guideEl.textContent = t('setup.guide_link');
  const compareLink = document.getElementById('backendCompareLink');
  if (compareLink) compareLink.textContent = t('compare.link');
  const setupBackLabel = document.getElementById('setupBackLabel');
  if (setupBackLabel) setupBackLabel.textContent = t('setup.back');
  const setupTitle = document.getElementById('setupTitle');
  if (setupTitle) setupTitle.textContent = t('setup.title');
  const setupSubtitle = document.getElementById('setupSubtitle');
  if (setupSubtitle) setupSubtitle.textContent = t('setup.subtitle');
  const schemaToggleLabel = document.getElementById('setupSchemaToggleLabel');
  if (schemaToggleLabel) schemaToggleLabel.textContent = t('setup.schema_toggle');
  const copyLabel = document.getElementById('setupCopyLabel');
  if (copyLabel) copyLabel.textContent = t('setup.copy_btn');
  const setupLocal1T = document.getElementById('setupLocal1Title');
  if (setupLocal1T) setupLocal1T.textContent = t('setup.local_1_title');
  const setupLocal1D = document.getElementById('setupLocal1Desc');
  if (setupLocal1D) setupLocal1D.textContent = t('setup.local_1_desc');
  const setupLocal2T = document.getElementById('setupLocal2Title');
  if (setupLocal2T) setupLocal2T.textContent = t('setup.local_2_title');
  const setupLocal2D = document.getElementById('setupLocal2Desc');
  if (setupLocal2D) setupLocal2D.innerHTML = t('setup.local_2_desc');
  const setupLocal3T = document.getElementById('setupLocal3Title');
  if (setupLocal3T) setupLocal3T.textContent = t('setup.local_3_title');
  const setupLocal3D = document.getElementById('setupLocal3Desc');
  if (setupLocal3D) setupLocal3D.innerHTML = t('setup.local_3_desc');
  // Drive setup guide
  const setupDriveName = document.getElementById('setupDriveName');
  if (setupDriveName) setupDriveName.textContent = t('setup.drive_name');
  const setupDriveDesc = document.getElementById('setupDriveDesc');
  if (setupDriveDesc) setupDriveDesc.textContent = t('setup.drive_desc');
  const setupDrive1T = document.getElementById('setupDrive1Title');
  if (setupDrive1T) setupDrive1T.textContent = t('setup.drive_1_title');
  const setupDrive1D = document.getElementById('setupDrive1Desc');
  if (setupDrive1D) setupDrive1D.innerHTML = t('setup.drive_1_desc');
  const setupDrive2T = document.getElementById('setupDrive2Title');
  if (setupDrive2T) setupDrive2T.textContent = t('setup.drive_2_title');
  const setupDrive2D = document.getElementById('setupDrive2Desc');
  if (setupDrive2D) setupDrive2D.innerHTML = t('setup.drive_2_desc');
  document.querySelectorAll('.setup-done-btn:not(#setupLoginBtn)').forEach(btn => btn.textContent = t('setup.done_btn'));
  // Header menu labels
  const menuLangLabel = document.getElementById('menuLangLabel');
  if (menuLangLabel) menuLangLabel.textContent = t('menu.language');
  const menuThemeLabel = document.getElementById('menuThemeLabel');
  if (menuThemeLabel) menuThemeLabel.textContent = t('menu.toggle_theme');
  const menuSettingsLabel = document.getElementById('menuSettingsLabel');
  if (menuSettingsLabel) menuSettingsLabel.textContent = t('menu.settings');
  const menuDisconnectLabel = document.getElementById('menuDisconnectLabel');
  if (menuDisconnectLabel) menuDisconnectLabel.textContent = t('menu.disconnect');
  // Settings modal
  const settingsTitle = document.getElementById('settingsTitle');
  if (settingsTitle) settingsTitle.textContent = t('menu.settings_title');
  const settingsNavGeneral = document.getElementById('settingsNavGeneral');
  if (settingsNavGeneral) settingsNavGeneral.textContent = t('menu.settings_general');
  const settingsPaneGeneralTitle = document.getElementById('settingsPaneGeneralTitle');
  if (settingsPaneGeneralTitle) settingsPaneGeneralTitle.textContent = t('menu.settings_general');
  const settingsNavCalendar = document.getElementById('settingsNavCalendar');
  if (settingsNavCalendar) settingsNavCalendar.textContent = t('cal_sync.nav');
  const settingsPaneCalendarTitle = document.getElementById('settingsPaneCalendarTitle');
  if (settingsPaneCalendarTitle) settingsPaneCalendarTitle.textContent = t('cal_sync.pane_title');
  const settingsCalSyncLabel = document.getElementById('settingsCalSyncLabel');
  if (settingsCalSyncLabel) settingsCalSyncLabel.textContent = t('cal_sync.label');
  const settingsCalSyncHint = document.getElementById('settingsCalSyncHint');
  if (settingsCalSyncHint) settingsCalSyncHint.textContent = t('cal_sync.hint');
  const settingsCalSyncToggleLabel = document.getElementById('settingsCalSyncToggleLabel');
  if (settingsCalSyncToggleLabel) settingsCalSyncToggleLabel.textContent = t('cal_sync.toggle');
  const settingsCalSyncHabitsLabel = document.getElementById('settingsCalSyncHabitsLabel');
  if (settingsCalSyncHabitsLabel) settingsCalSyncHabitsLabel.textContent = t('cal_sync.habits');
  const settingsCalSyncTodosLabel = document.getElementById('settingsCalSyncTodosLabel');
  if (settingsCalSyncTodosLabel) settingsCalSyncTodosLabel.textContent = t('cal_sync.todos');
  const settingsCalSyncBirthdaysLabel = document.getElementById('settingsCalSyncBirthdaysLabel');
  if (settingsCalSyncBirthdaysLabel) settingsCalSyncBirthdaysLabel.textContent = t('cal_sync.birthdays');
  const settingsTabsLabel = document.getElementById('settingsTabsLabel');
  if (settingsTabsLabel) settingsTabsLabel.textContent = t('menu.settings_tabs');
  const settingsTabsHint = document.getElementById('settingsTabsHint');
  if (settingsTabsHint) settingsTabsHint.textContent = t('menu.settings_tabs_hint');
  const settingsLanguageLabel = document.getElementById('settingsLanguageLabel');
  if (settingsLanguageLabel) settingsLanguageLabel.textContent = t('menu.settings_language');
  // Highlight active language in settings picker
  document.querySelectorAll('.settings-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === getLang());
  });
  const settingsNavStats = document.getElementById('settingsNavStats');
  if (settingsNavStats) settingsNavStats.textContent = t('menu.settings_stats');
  const settingsPaneStatsTitle = document.getElementById('settingsPaneStatsTitle');
  if (settingsPaneStatsTitle) settingsPaneStatsTitle.textContent = t('menu.settings_stats');
  applySharingI18n();
  // Account pane i18n
  const settingsNavAccountLabel = document.getElementById('settingsNavAccountLabel');
  if (settingsNavAccountLabel) settingsNavAccountLabel.textContent = t('account.nav');
  const settingsPaneAccountTitle = document.getElementById('settingsPaneAccountTitle');
  if (settingsPaneAccountTitle) settingsPaneAccountTitle.textContent = t('account.title');
  const settingsDangerZoneLabel = document.getElementById('settingsDangerZoneLabel');
  if (settingsDangerZoneLabel) settingsDangerZoneLabel.textContent = t('account.danger_zone');
  const settingsDangerZoneHint = document.getElementById('settingsDangerZoneHint');
  if (settingsDangerZoneHint) settingsDangerZoneHint.textContent = t('account.danger_hint');
  const deleteAccountBtnText = document.getElementById('deleteAccountBtnText');
  if (deleteAccountBtnText) deleteAccountBtnText.textContent = t('account.delete_btn');
  const settingsDisplayLabel = document.getElementById('settingsDisplayLabel');
  if (settingsDisplayLabel) settingsDisplayLabel.textContent = t('menu.settings_display');
  // Data pane
  const settingsNavData = document.getElementById('settingsNavData');
  if (settingsNavData) settingsNavData.textContent = t('menu.settings_data');
  const settingsPaneDataTitle = document.getElementById('settingsPaneDataTitle');
  if (settingsPaneDataTitle) settingsPaneDataTitle.textContent = t('menu.settings_data');
  const settingsBackupLabel = document.getElementById('settingsBackupLabel');
  if (settingsBackupLabel) settingsBackupLabel.textContent = t('menu.settings_backup');
  const settingsBackupHint = document.getElementById('settingsBackupHint');
  if (settingsBackupHint) settingsBackupHint.textContent = t('menu.settings_backup_hint');
  const settingsExportBtn = document.getElementById('settingsExportBtn');
  if (settingsExportBtn) settingsExportBtn.textContent = t('menu.settings_export_btn');
  const settingsDriveExportBtn = document.getElementById('settingsDriveExportBtn');
  if (settingsDriveExportBtn) settingsDriveExportBtn.textContent = t('menu.settings_drive_export_btn');
  const settingsRestoreLabel = document.getElementById('settingsRestoreLabel');
  if (settingsRestoreLabel) settingsRestoreLabel.textContent = t('menu.settings_restore');
  const settingsRestoreHint = document.getElementById('settingsRestoreHint');
  if (settingsRestoreHint) settingsRestoreHint.textContent = t('menu.settings_restore_hint');
  const settingsImportBtn = document.getElementById('settingsImportBtn');
  if (settingsImportBtn) settingsImportBtn.textContent = t('menu.settings_import_btn');
  // Flashcard toolbar buttons
  const flashPracticeBtn = document.getElementById('flashcardPracticeAllBtn');
  if (flashPracticeBtn) {
    const lbl = flashPracticeBtn.querySelector('.btn-label');
    if (lbl) lbl.textContent = t('flashcards.type_flashcard');
  }
  const flashTextBtn = document.getElementById('flashcardTextPracticeAllBtn');
  if (flashTextBtn) {
    const lbl = flashTextBtn.querySelector('.btn-label');
    if (lbl) lbl.textContent = t('flashcards.type_text');
    flashTextBtn.title = t('text_revision.practice') + ' ' + t('text_revision.texts');
  }
  // Flashcard filter buttons
  const flashFilterMap = { all: 'flashcards.filter_all', due: 'flashcards.filter_due', new: 'flashcards.filter_new', mastered: 'flashcards.filter_mastered' };
  document.querySelectorAll('#flashcardFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (flashFilterMap[f]) btn.textContent = t(flashFilterMap[f]);
  });
  // Flashcard sort options
  const flashSort = document.getElementById('flashcardSortBy');
  if (flashSort) {
    flashSort.options[0].text = t('flashcards.sort_default');
    flashSort.options[1].text = t('flashcards.sort_strength');
    flashSort.options[2].text = t('flashcards.sort_last_reviewed');
  }
  // Edit Habit modal labels (keep in sync on language switch)
  const editHabitTitle = document.getElementById('editHabitTitle');
  if (editHabitTitle) editHabitTitle.innerHTML = editHabitTitle.querySelector('svg')?.outerHTML + ' ' + t('habits.edit_habit');
  const editHabitNameLabel = document.getElementById('editHabitNameLabel');
  if (editHabitNameLabel) editHabitNameLabel.textContent = t('common.name');
  const editHabitFreqLabel = document.getElementById('editHabitFreqLabel');
  if (editHabitFreqLabel) editHabitFreqLabel.textContent = t('habits.frequency_rule');
  const editHabitCatLabel = document.getElementById('editHabitCategoryLabel');
  if (editHabitCatLabel) editHabitCatLabel.textContent = t('common.category');
  const editHabitLastDoneLabel = document.getElementById('editHabitLastDoneLabel');
  if (editHabitLastDoneLabel) editHabitLastDoneLabel.textContent = t('habits.last_done_optional');
  const editHabitCancelBtn = document.getElementById('editHabitCancelBtn');
  if (editHabitCancelBtn) editHabitCancelBtn.textContent = t('common.cancel');
  const editHabitSaveBtn = document.getElementById('editHabitSaveBtn');
  if (editHabitSaveBtn) editHabitSaveBtn.textContent = t('common.save');
  // Re-render tab config labels in settings (if settings modal is open)
  if (document.getElementById('settingsModal')?.classList.contains('visible')) {
    renderTabConfigList();
  }
  // Generic data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (val) el.textContent = val;
  });
  // Re-render footer "Updated" label in the new language
  renderLastUpdated();
}

// ── Storm Logo Initialization ──

function initLogos() {
  document.querySelectorAll('svg.storm-logo').forEach(svg => {
    renderStorm(svg, LOGO_DEFAULTS);
  });
}

// Re-render logos when theme changes (opacity might need refresh)
const _origToggleTheme = window.toggleTheme;
if (_origToggleTheme) {
  window.toggleTheme = function() {
    _origToggleTheme();
  };
}

// Expose for use in app.js or other modules
window.initLogos = initLogos;
window.renderStormLogo = renderStorm;

// ===================================================================
// GATE TOOLBAR (theme + language on login page)
// ===================================================================
function initGateToolbar() {
  // Theme toggle
  const themeBtn = document.getElementById('gateThemeBtn');
  if (themeBtn) themeBtn.addEventListener('click', () => toggleTheme());

  // Language buttons
  document.querySelectorAll('.gate-lang-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      if (lang && lang !== getLang()) {
        setLang(lang);
        applyLang();
        await onLangSwitchDemo(lang);
        reRenderCurrentView();
      }
    });
  });
}

// Init lang and header menu on page load
(function() { applyLang(); initHeaderMenu(); initGateToolbar(); initLogos(); })();

// Auto-collapse title and switch to icon-only tabs when header is cramped
(function() {
  const header = document.querySelector('.app-header');
  const switcher = document.querySelector('.view-switcher');
  if (!header || !switcher) return;

  let rafId = null;
  function scheduleCheck() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = null; checkOverflow(); });
  }

  function checkOverflow() {
    // Disconnect observers while measuring to prevent feedback loops
    ro.disconnect();
    mo.disconnect();

    // Reset to full state to measure natural width
    header.classList.remove('title-collapsed');
    switcher.classList.remove('icon-only');
    void switcher.scrollWidth;

    const tabs = switcher.querySelectorAll('.view-tab');
    const isCramped = () => {
      const anyTruncated = Array.from(tabs).some(tab => tab.style.display !== 'none' && tab.scrollWidth > tab.clientWidth + 1);
      return anyTruncated || switcher.scrollWidth > switcher.clientWidth + 1;
    };

    // Step 1: collapse title text if cramped
    if (isCramped()) {
      header.classList.add('title-collapsed');
      void switcher.scrollWidth;
    }

    // Step 2: if any tab is narrower than 2.5× the icon size, switch to icon-only
    const ICON_SIZE = 18;
    const iconOnlyThreshold = 85;
    const visibleTabs = Array.from(tabs).filter(tab => tab.style.display !== 'none');
    if (visibleTabs.some(tab => tab.clientWidth < iconOnlyThreshold)) {
      switcher.classList.add('icon-only');
    }

    // Re-observe after state is settled
    ro.observe(switcher);
    mo.observe(switcher, { childList: true, subtree: true });
  }

  const ro = new ResizeObserver(scheduleCheck);
  ro.observe(switcher);
  // MO for child/subtree changes only (not attributes — we toggle classes ourselves)
  const mo = new MutationObserver(scheduleCheck);
  mo.observe(switcher, { childList: true, subtree: true });
  checkOverflow();
})();


// ===================================================================
// THEME
// ===================================================================
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Keep mobile browser chrome in sync
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#edeeed' : '#08090d';
  updateMenuThemeItem();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || getSystemTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// Init theme on page load
(function() {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored || getSystemTheme());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(getSystemTheme());
  });
})();


// ===================================================================
// TAB VISIBILITY
// ===================================================================
const ALL_TABS = [
  { key: 'welcome', tabId: 'tabWelcome', icon: 'home', color: '#3b82f6', labelKey: 'nav.today' },
  { key: 'projects', tabId: 'tabProjects', icon: 'layout-grid', color: '#6366f1', labelKey: 'nav.projects' },
  { key: 'todos', tabId: 'tabTodos', icon: 'list-checks', color: '#22c55e', labelKey: 'nav.todos' },
  { key: 'habits', tabId: 'tabHabits', icon: 'repeat', color: '#ec4899', labelKey: 'nav.habits' },
  { key: 'birthdays', tabId: 'tabBirthdays', icon: 'cake', color: '#f97316', labelKey: 'nav.birthdays' },
  { key: 'vestiaire', tabId: 'tabVestiaire', icon: 'shirt', color: '#8b5cf6', labelKey: 'nav.wardrobe' },
  { key: 'flashcards', tabId: 'tabFlashcards', icon: 'brain', color: '#06b6d4', labelKey: 'nav.flashcards' },
  { key: 'lists', tabId: 'tabLists', icon: 'list', color: '#14b8a6', labelKey: 'nav.lists' },
];

function getTabVisibility() {
  return state.tabVisibility;
}

function saveTabVisibility(vis) {
  state.tabVisibility = vis;
  _persistSetting('tab_visibility', JSON.stringify(vis));
}

function isTabVisible(key) {
  const vis = state.tabVisibility;
  if (!vis) return true; // all visible by default
  return vis[key] !== false;
}

// ── Tab Order ──
function getTabOrder() {
  return state.tabOrder;
}

function saveTabOrder(order) {
  state.tabOrder = order;
  _persistSetting('tab_order', JSON.stringify(order));
}

function getOrderedTabs() {
  const order = getTabOrder();
  if (!order) return ALL_TABS;
  // Sort ALL_TABS by the stored order, falling back to original position
  return [...ALL_TABS].sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function applyTabVisibility() {
  const vis = getTabVisibility();
  const ordered = getOrderedTabs();
  const switcher = document.querySelector('.view-switcher');
  // Apply visibility and reorder DOM
  ordered.forEach(tab => {
    const el = document.getElementById(tab.tabId);
    if (el) {
      const visible = !vis || vis[tab.key] !== false;
      el.style.display = visible ? '' : 'none';
      switcher.appendChild(el); // moves element to end → builds correct order
    }
  });
}

function getVisibleTabs() {
  return getOrderedTabs().filter(t => isTabVisible(t.key));
}

// ── Settings Modal ──
let _tabConfigState = {};
let _tabConfigOrder = []; // current order of tab keys in the settings list

function openSettings(pane) {
  const vis = getTabVisibility() || {};
  _tabConfigState = {};
  const ordered = getOrderedTabs();
  _tabConfigOrder = ordered.map(t => t.key);
  ordered.forEach(tab => {
    _tabConfigState[tab.key] = vis[tab.key] !== false;
  });
  renderTabConfigList();
  // Reset to first pane (or target pane if specified)
  switchSettingsPane(pane && SETTINGS_PANES.includes(pane) ? pane : 'general');
  // Init theme toggle state
  updateMenuThemeItem();
  // Init calendar sync toggles
  updateCalSyncUI().catch(() => {});
  // Calendar sync click handlers: all handled via delegation.js
  // (data-action="toggle-cal-sync" → window.toggleCalSync,
  //  data-action="toggle-cal-sync-*" → explicit cases calling toggleCalSyncSub)
  hydrateIcons();
  document.getElementById('settingsModal').classList.add('visible');
  const scrollY = window.scrollY;
  document.body.classList.add('no-scroll');
  document.body.style.top = `-${scrollY}px`;
  document.body.dataset.scrollY = scrollY;
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('visible');
  document.body.classList.remove('no-scroll');
  const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.style.top = '';
  window.scrollTo(0, scrollY);
  // Restore view hash
  const viewHash = '#' + (state.currentView || 'welcome');
  if (location.hash.startsWith('#settings')) history.replaceState(null, '', viewHash);
}

function switchSettingsPane(paneKey) {
  document.querySelectorAll('.settings-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pane === paneKey);
  });
  document.querySelectorAll('.settings-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `settingsPane-${paneKey}`);
  });
  if (paneKey === 'stats') { loadUsageStats(); }
  if (paneKey === 'sharing') { renderSharingPane(); }
  // Sync URL hash
  const settingsHash = paneKey === 'general' ? '#settings' : '#settings/' + paneKey;
  if (location.hash !== settingsHash) history.replaceState(null, '', settingsHash);
}

function renderTabConfigList() {
  const list = document.getElementById('tabConfigList');
  if (!list) return;
  list.innerHTML = _tabConfigOrder.map(key => {
    const tab = ALL_TABS.find(t => t.key === key);
    if (!tab) return '';
    const locked = tab.key === 'welcome';
    const checked = locked || _tabConfigState[tab.key] ? 'checked' : '';
    const lockedClass = locked ? ' locked' : '';
    return `<div class="tab-config-item ${checked}${lockedClass}" data-tab-key="${tab.key}">
      <span class="tab-config-drag">${lucideIcon('grip-vertical', 14, 'var(--muted)')}</span>
      <span class="tab-config-icon">${lucideIcon(tab.icon, 18, tab.color)}</span>
      <span class="tab-config-label">${t(tab.labelKey)}</span>
      <span class="tab-config-toggle"></span>
    </div>`;
  }).join('');
  initTabConfigDrag(list);
  initTabConfigToggle(list);
}

function initTabConfigToggle(list) {
  list.querySelectorAll('.tab-config-item').forEach(item => {
    const toggle = item.querySelector('.tab-config-toggle');
    if (!toggle) return;
    const key = item.dataset.tabKey;
    if (key === 'welcome') return; // locked
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTabConfigItem(key);
    });
  });
}

function initTabConfigDrag(list) {
  let dragState = null;
  list.querySelectorAll('.tab-config-item').forEach(item => {
    item.addEventListener('pointerdown', e => {
      // Only initiate drag from the drag handle
      if (!e.target.closest('.tab-config-drag')) return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      dragState = { el: item, key: item.dataset.tabKey, offsetY: e.clientY - rect.top, clone: null };
      const clone = item.cloneNode(true);
      clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);`;
      document.body.appendChild(clone);
      dragState.clone = clone;
      item.classList.add('dragging');
      try { item.setPointerCapture(e.pointerId); } catch (_) {}
    });
    item.addEventListener('pointermove', e => {
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      list.querySelectorAll('.tab-config-item:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });
    const finishDrag = () => {
      if (!dragState || dragState.el !== item) return;
      if (dragState.clone) dragState.clone.remove();
      item.classList.remove('dragging');
      let targetKey = null;
      list.querySelectorAll('.tab-config-item').forEach(el => {
        if (el.classList.contains('drag-over')) { targetKey = el.dataset.tabKey; el.classList.remove('drag-over'); }
      });
      const draggedKey = dragState.key;
      dragState = null;
      if (targetKey && targetKey !== draggedKey) {
        const fromIdx = _tabConfigOrder.indexOf(draggedKey);
        const toIdx = _tabConfigOrder.indexOf(targetKey);
        if (fromIdx !== -1 && toIdx !== -1) {
          _tabConfigOrder.splice(fromIdx, 1);
          _tabConfigOrder.splice(toIdx, 0, draggedKey);
          saveTabOrder(_tabConfigOrder);
          renderTabConfigList();
          applyTabVisibility();
        }
      }
    };
    item.addEventListener('pointerup', finishDrag);
    item.addEventListener('pointercancel', finishDrag);
  });
}

function toggleTabConfigItem(key) {
  if (key === 'welcome') return;
  _tabConfigState[key] = !_tabConfigState[key];
  // Ensure at least one tab remains visible (besides Today which is always on)
  const anyVisible = Object.values(_tabConfigState).some(v => v);
  if (!anyVisible) {
    _tabConfigState[key] = true;
    showToast(t('menu.settings_tabs_hint'));
    return;
  }
  renderTabConfigList();
  // Apply immediately
  saveTabVisibility(_tabConfigState);
  applyTabVisibility();
  if (!_tabConfigState[state.currentView]) {
    const firstVisible = getOrderedTabs().find(t => _tabConfigState[t.key]);
    if (firstVisible) switchView(firstVisible.key);
  }
}

// ── AI Settings ──

// Fire-and-forget upsert to settings table (used by tab config + project archive)
function _persistSetting(key, value) {
  if (!state.db?.connected) return;
  state.db.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }).then(({ error }) => {
    if (error) console.warn(`Could not save setting ${key}:`, error.message);
  });
}

async function loadSettings() {
  try {
    const { data, error } = await state.db.from('settings').select('key,value');
    if (error) { console.warn('Settings table not available:', error.message); return; }
    if (data) {
      for (const row of data) {
        if (row.key === 'schema_version') state.dbSchemaVersion = row.value || '0.00';
        if (row.key === 'tab_visibility') { try { state.tabVisibility = JSON.parse(row.value); } catch { /* keep null */ } }
        if (row.key === 'tab_order') { try { state.tabOrder = JSON.parse(row.value); } catch { /* keep null */ } }
        if (row.key === 'archived_project_ids') { try { state.archivedProjectIds = JSON.parse(row.value) || []; } catch { /* keep [] */ } }
        if (row.key === 'show_archived') state.showArchived = row.value === 'true';
      }
    }
  } catch (e) { console.warn('Could not load settings:', e.message); }
}

// ── Daily Visit Tracking ──
async function recordDailyVisit() {
  if (state.demoMode || !state.db?.connected) return;
  try {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    try {
      await state.db.from('daily_visits').upsert({ visit_date: today }, { onConflict: 'visit_date,owner_id' });
    } catch {
      // fallback for pre-1.398 DBs with old PK
      await state.db.from('daily_visits').upsert({ visit_date: today }, { onConflict: 'visit_date' });
    }
  } catch (e) { console.warn('Could not record visit:', e.message); }
}

async function loadUsageStats() {
  const container = document.getElementById('usageStatsContainer');
  if (!container) return;
  if (state.demoMode || !state.db?.connected) {
    container.innerHTML = `<span class="setting-hint">${t('menu.settings_stats_unavailable')}</span>`;
    return;
  }
  try {
    // Load db_created_at
    const { data: settingsData } = await state.db.from('settings').select('value').eq('key', 'db_created_at').single();
    const dbCreated = settingsData?.value ? new Date(JSON.parse(settingsData.value)) : null;

    // Load all visits
    const { data: visits } = await state.db.from('daily_visits').select('visit_date').order('visit_date', { ascending: false });
    const totalDays = visits ? visits.length : 0;

    // Compute streak
    let streak = 0;
    if (visits && visits.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sorted = visits.map(v => v.visit_date).sort().reverse();
      // Allow streak to start from today or yesterday
      const latest = new Date(sorted[0] + 'T00:00:00');
      const diffToday = Math.round((today - latest) / 86400000);
      if (diffToday <= 1) {
        streak = 1;
        for (let i = 1; i < sorted.length; i++) {
          const curr = new Date(sorted[i] + 'T00:00:00');
          const prev = new Date(sorted[i - 1] + 'T00:00:00');
          const gap = Math.round((prev - curr) / 86400000);
          if (gap === 1) streak++;
          else break;
        }
      }
    }

    // DB age in calendar days (midnight-normalised to avoid sub-24h rounding)
    let dbAgeDays = null;
    if (dbCreated) {
      const now = new Date(); now.setHours(0,0,0,0);
      const inst = new Date(dbCreated); inst.setHours(0,0,0,0);
      dbAgeDays = Math.round((now - inst) / 86400000);
    }

    let html = '';
    if (dbAgeDays !== null) {
      html += `<div class="usage-stat-card">
        <div class="usage-stat-value">${dbAgeDays}</div>
        <div class="usage-stat-label">${t('menu.settings_stats_db_age')}</div>
        <div class="usage-stat-sub">${dbCreated.toLocaleDateString()}</div>
      </div>`;
    }
    html += `<div class="usage-stat-card">
      <div class="usage-stat-value">${totalDays}</div>
      <div class="usage-stat-label">${t('menu.settings_stats_total_days')}</div>
    </div>`;
    html += `<div class="usage-stat-card">
      <div class="usage-stat-value">${streak}</div>
      <div class="usage-stat-label">${t('menu.settings_stats_streak')}</div>
    </div>`;
    container.innerHTML = html;
  } catch (e) {
    console.warn('Could not load usage stats:', e.message);
    container.innerHTML = `<span class="setting-hint">${t('menu.settings_stats_unavailable')}</span>`;
  }
}

function showCompareModal() {
  document.getElementById('compareModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'compareModal';
  overlay.className = 'modal-overlay visible';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCompareModal(); });

  const check = '<span class="compare-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
  const cross = '<span class="compare-cross"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';

  const rows = [
    { key: 'compare.setup', vals: ['compare.setup_drive', 'compare.setup_local'] },
    { key: 'compare.multi_device', vals: [check + ' ' + esc(t('compare.polling')), cross], raw: true },
    { key: 'compare.offline', vals: [cross, check], raw: true },
    { key: 'compare.data_location', vals: ['compare.loc_drive', 'compare.loc_local'] },
    { key: 'compare.storage', vals: ['compare.sto_drive', 'compare.sto_local'] },
    { key: 'compare.cost', vals: ['compare.free', 'compare.free'] },
  ];

  const backends = ['googledrive', 'local'];
  const thead = `<tr><th></th>${backends.map(b =>
    `<th class="compare-th-${b}"><span class="compare-th-inner">${LOGOS[b](16)}${esc(LABELS[b])}</span></th>`
  ).join('')}</tr>`;
  const tbody = rows.map(r => {
    const cells = r.vals.map(v => `<td>${r.raw ? v : esc(t(v))}</td>`).join('');
    return `<tr><td class="compare-label">${esc(t(r.key))}</td>${cells}</tr>`;
  }).join('');

  overlay.innerHTML = `<div class="modal compare-modal">
    <h2>${esc(t('compare.title'))}</h2>
    <p class="compare-subtitle">${esc(t('compare.subtitle'))}</p>
    <div class="compare-table-wrap">
      <table class="compare-table">${thead}${tbody}</table>
    </div>
    <p class="compare-footnote">${esc(t('compare.storage_note'))}</p>
    <button class="compare-close-btn" data-action="close-compare-modal">${esc(t('schema.close'))}</button>
  </div>`;
  document.body.appendChild(overlay);
}

function closeCompareModal() {
  document.getElementById('compareModal')?.remove();
}

/** Login overlay shown from demo "Start my own" button */
function showSignupOverlay() {
  document.getElementById('signupOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'signupOverlay';
  overlay.className = 'signup-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSignupOverlay(); });

  const box = document.createElement('div');
  box.className = 'gate-box';

  const title = document.createElement('h1');
  title.textContent = 'DeLaClaw';

  const hint = document.createElement('p');
  hint.className = 'gate-storage-hint';
  hint.textContent = t('login.storage_hint');

  const compareLink = document.createElement('a');
  compareLink.className = 'backend-compare-link';
  compareLink.href = '#';;
  compareLink.textContent = t('compare.link');
  compareLink.addEventListener('click', showCompareModal);

  // Build a clean form (not a clone) with only what's needed
  const form = document.createElement('form');
  form.id = 'signupForm';
  form.style.display = 'flex';
  form.style.flexDirection = 'column';
  form.style.alignItems = 'center';
  form.style.width = '100%';

  // Backend picker
  const picker = document.createElement('div');
  picker.className = 'backend-picker';
  const modes = [
    { mode: 'googledrive', label: t('login.mode_drive'), title: 'Google Drive' },
    { mode: 'local', label: t('login.mode_local'), title: 'Local' },
  ];
  let activeMode = 'googledrive';
  const fieldsDiv = document.createElement('div');
  fieldsDiv.className = 'gate-fields';
  fieldsDiv.style.display = 'none';
  fieldsDiv.style.alignSelf = 'stretch';

  const hintP = document.createElement('p');
  hintP.className = 'hint';

  const urlLabel = document.createElement('label');
  urlLabel.className = 'gate-label';
  const urlLabelLink = document.createElement('a');
  urlLabelLink.target = '_blank';
  urlLabelLink.rel = 'noopener';
  urlLabelLink.textContent = t('login.url_label');
  urlLabelLink.dataset.tooltip = t('toast.url_tooltip');
  urlLabel.appendChild(urlLabelLink);
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'http://localhost:3737';

  const keyDiv = document.createElement('div');
  const keyLabel = document.createElement('label');
  keyLabel.className = 'gate-label';
  const keyLabelLink = document.createElement('a');
  keyLabelLink.target = '_blank';
  keyLabelLink.rel = 'noopener';
  keyLabelLink.textContent = t('login.key_label');
  keyLabel.appendChild(keyLabelLink);
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'eyJhbG...';
  keyDiv.appendChild(keyLabel);
  keyDiv.appendChild(keyInput);

  fieldsDiv.appendChild(hintP);
  fieldsDiv.appendChild(urlLabel);
  fieldsDiv.appendChild(urlInput);
  fieldsDiv.appendChild(keyDiv);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-primary';
  submitBtn.style.alignSelf = 'stretch';
  submitBtn.textContent = t('login.btn_googledrive');

  function updateSignupFields() {
    if (activeMode === 'googledrive') {
      fieldsDiv.style.display = 'none';
      submitBtn.textContent = t('login.btn_googledrive');
    } else {
      fieldsDiv.style.display = '';
      hintP.textContent = t('login.hint_local');
      keyDiv.style.display = 'none';
      submitBtn.textContent = t('login.connect');
      // Match the gate's label behaviour for local mode
      urlLabelLink.textContent = t('login.url_label_local');
      urlLabelLink.removeAttribute('href');
      urlInput.placeholder = 'http://localhost:3737';
    }
  }

  modes.forEach(m => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'backend-option' + (m.mode === 'googledrive' ? ' active' : '');
    btn.dataset.mode = m.mode;
    btn.title = m.title;
    // Icon from the real picker
    const realBtn = document.querySelector(`.backend-option[data-mode="${m.mode}"]`);
    const iconEl = realBtn?.querySelector('svg, img, .backend-icon-img');
    if (iconEl) btn.appendChild(iconEl.cloneNode(true));
    const labelSpan = document.createElement('span');
    labelSpan.className = 'backend-option-label';
    labelSpan.textContent = m.label;
    btn.appendChild(labelSpan);
    btn.addEventListener('click', () => {
      picker.querySelectorAll('.backend-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMode = m.mode;
      updateSignupFields();
    });
    picker.appendChild(btn);
  });

  form.appendChild(picker);
  form.appendChild(fieldsDiv);
  form.appendChild(submitBtn);

  // Handle form submit — exit demo and reload to the gate with the chosen backend
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearStayConnectedCreds();
    // For Local, pre-fill creds so the gate auto-connects on reload
    if (activeMode === 'local') {
      const url = urlInput.value.trim();
      const key = keyInput.value.trim();
      if (url) saveStayConnectedCreds(url, key, activeMode);
    }
    // Store chosen mode so the gate can pre-select it
    localStorage.setItem('claw_signup_mode', activeMode);
    closeSignupOverlay();
    location.hash = '#login';
    location.reload();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'compare-close-btn';
  cancelBtn.style.marginTop = '8px';
  cancelBtn.textContent = t('schema.close');
  cancelBtn.addEventListener('click', closeSignupOverlay);

  const guideLink = document.createElement('a');
  guideLink.className = 'gate-guide-link';
  guideLink.href = '#';
  guideLink.style.display = 'none';
  guideLink.textContent = t('setup.guide_link');
  guideLink.addEventListener('click', (e) => {
    e.preventDefault();
    closeSignupOverlay();
    clearStayConnectedCreds();
    location.hash = '#setup';
    location.reload();
  });

  box.appendChild(title);
  box.appendChild(hint);
  box.appendChild(compareLink);
  box.appendChild(form);
  box.appendChild(cancelBtn);
  box.appendChild(guideLink);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function closeSignupOverlay() {
  document.getElementById('signupOverlay')?.remove();
}


function dismissSchemaBanner() {
  const banner = document.getElementById('schema-banner');
  if (banner) {
    banner._schemaRO?.disconnect();
    banner.remove();
  }
  document.body.style.removeProperty('--schema-banner-h');
}

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsPane = switchSettingsPane;
window.toggleTabConfigItem = toggleTabConfigItem;

// ── Data Backup & Restore ──

const BACKUP_TABLES = [
  // category / deck parents first (items FK into these)
  'todo_categories', 'habit_categories', 'vestiaire_categories', 'flashcard_decks',
  // parent tables
  'projects', 'habits', 'texts', 'lists',
  // child / independent tables
  'todos', 'tasks', 'habit_completions', 'flashcards', 'flashcard_notes',
  'text_line_progress', 'birthdays', 'vestiaire', 'list_items',
  'settings', 'prompts', 'daily_visits',
  // sharing: owned groups (creator side) — FK order: groups → members → items
  'sharing_groups', 'sharing_members', 'sharing_items',
  // sharing: joined groups (joiner side)
  'joined_groups',
];

async function generateBackupJSON() {
  const backup = { _meta: { version: 1, exported_at: new Date().toISOString(), tables: [] } };
  for (const table of BACKUP_TABLES) {
    try {
      backup[table] = await fetchAll(() => state.db.from(table).select('*'));
      backup._meta.tables.push(table);
    } catch (e) { console.warn(`Skipping ${table}:`, e.message); }
  }
  return backup;
}

async function exportBackup() {
  const btn = document.querySelector('.settings-data-btn[data-action="export-backup"]');
  if (btn) btn.disabled = true;
  try {
    const backup = await generateBackupJSON();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `delaclaw-backup-${date}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast(t('menu.settings_backup_done'));
  } catch (e) {
    console.error('Export failed:', e);
    showToast(t('menu.settings_backup_error'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

const GOOGLE_CLIENT_ID = '883846698493-5v6hfn0vvnq7mn5gua454cgvibbgqt8i.apps.googleusercontent.com';

function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined' || !google.accounts) {
      reject(new Error('Google Identity Services not loaded'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE_FILE,
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.access_token);
      },
    });
    client.requestAccessToken();
  });
}

const DRIVE_FOLDER_NAME = 'DeLaClaw Backups';

async function getOrCreateDriveFolder(token) {
  // Check settings for cached folder ID (all adapters return arrays here)
  if (state.db.connected) {
    const { data } = await state.db.from('settings').select('value').eq('key', 'drive_backup_folder_id');
    const cached = data && data.length ? data[0].value : null;
    if (cached) {
      // Verify folder still exists
      const check = await fetch(`https://www.googleapis.com/drive/v3/files/${cached}?fields=id,trashed`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (check.ok) {
        const f = await check.json();
        if (!f.trashed) return cached;
      }
    }
  }

  // Search for existing folder
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (search.ok) {
    const { files } = await search.json();
    if (files && files.length > 0) {
      const folderId = files[0].id;
      if (state.db.connected) await state.db.from('settings').upsert({ key: 'drive_backup_folder_id', value: folderId });
      return folderId;
    }
  }

  // Create folder
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!create.ok) throw new Error('Failed to create Drive folder');
  const folder = await create.json();
  if (state.db.connected) await state.db.from('settings').upsert({ key: 'drive_backup_folder_id', value: folder.id });
  return folder.id;
}

async function exportToGoogleDrive() {
  const btn = document.querySelector('.settings-data-btn[data-action="export-to-drive"]');
  const label = document.getElementById('settingsDriveExportBtn');
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Authenticating…';
  try {
    // In Drive mode reuse the adapter's token (same drive.file scope, deduped + refreshed).
    // Other modes get their own standalone token since no Drive session exists.
    const inDriveMode = localStorage.getItem('claw_cc_active_mode') === 'googledrive';
    const token = (inDriveMode && state.driveAdapter)
      ? await state.driveAdapter.getToken()
      : await getGoogleAccessToken();
    if (label) label.textContent = 'Exporting…';
    const backup = await generateBackupJSON();
    const json = JSON.stringify(backup, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    const fileName = `delaclaw-backup-${date}.json`;

    const folderId = await getOrCreateDriveFolder(token);

    // Multipart upload: metadata + file content
    const metadata = { name: fileName, mimeType: 'application/json', parents: [folderId] };
    const boundary = '---delaclaw-backup-boundary';
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
      `--${boundary}--`
    ].join('\r\n');

    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Drive API error ${resp.status}: ${err}`);
    }

    const result = await resp.json();
    showToast(`Saved to Google Drive: ${DRIVE_FOLDER_NAME}/${result.name}`);
    // Show link to folder
    const linkEl = document.getElementById('driveBackupLink');
    if (linkEl) {
      // Safe DOM — validate folderId (P0 sec-002)
      const safeFid = /^[\w-]+$/.test(folderId) ? folderId : '';
      const safeHref = safeFid ? `https://drive.google.com/drive/folders/${safeFid}` : 'https://drive.google.com';
      linkEl.textContent = '';
      const iconSpan = document.createElement('span');
      iconSpan.innerHTML = lucideIcon('external-link', 14, 'var(--accent)');
      linkEl.appendChild(iconSpan);
      linkEl.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = safeHref;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `Open ${DRIVE_FOLDER_NAME}`;
      linkEl.appendChild(a);
      linkEl.style.display = '';
    }
  } catch (e) {
    if (e.message === 'Google Identity Services not loaded') {
      showToast('Google sign-in not available — check your connection');
    } else if (e.message === 'popup_closed_by_user') {
      // User cancelled — no toast needed
    } else {
      console.error('Drive export failed:', e);
      showToast('Drive export failed: ' + e.message);
    }
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = t('menu.settings_drive_export_btn') || 'Save to Google Drive';
  }
}

window.exportToGoogleDrive = exportToGoogleDrive;

function importBackup() {
  const input = document.getElementById('backupFileInput');
  if (!input) return;
  input.value = '';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    showConfirmAction(
      t('menu.settings_restore'),
      t('menu.settings_restore_confirm'),
      () => performImport(file),
      null,
      {
        btnText: t('menu.settings_restore') || 'Restore',
        iconSvg: '<svg class="confirm-action-icon-svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
        btnIconSvg: '<svg class="lucide-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
      }
    );
  }, { once: true });
  input.click();
}

async function performImport(file) {
  const btn = document.querySelector('.settings-data-btn[data-action="import-backup"]');
  if (btn) btn.disabled = true;

  const progressEl = document.getElementById('importProgress');
  const progressText = document.getElementById('importProgressText');
  const progressFill = document.getElementById('importProgressFill');
  const showProgress = (msg, current, total) => {
    if (progressEl) progressEl.style.display = '';
    if (progressText) progressText.textContent = msg;
    if (progressFill && total > 0) progressFill.style.width = `${Math.round((current / total) * 100)}%`;
  };
  const hideProgress = () => { if (progressEl) progressEl.style.display = 'none'; };

  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!backup._meta || backup._meta.version !== 1) {
      showToast(t('menu.settings_restore_invalid'));
      return;
    }
    // ── Snapshot calendar settings BEFORE any table is touched ──
    // The backup's own calendar keys are meaningless in this account, so we
    // always re-inject the pre-import values after reseed.
    const CAL_KEYS = ['gcal_sync_enabled', 'gcal_calendar_id',
      'gcal_sync_habits', 'gcal_sync_todos', 'gcal_sync_birthdays'];
    const savedCalSettings = {};
    if (state.driveMode) {
      for (const k of CAL_KEYS) {
        const { data } = await state.db.from('settings').select('value').eq('key', k).single();
        if (data?.value != null) savedCalSettings[k] = data.value;
      }
    }

    // ── Clear existing calendar events BEFORE the delete loop wipes
    //    gcal_sync records and settings from the in-memory store. ──
    const syncWasEnabled = savedCalSettings.gcal_sync_enabled === 'true';
    if (syncWasEnabled && savedCalSettings.gcal_calendar_id) {
      for (const itemType of ['todo', 'habit', 'birthday']) {
        try { await deleteTypeEvents(itemType); } catch (_) { /* best effort */ }
      }
    }

    // Delete in reverse order (children before parents)
    const tables = [...(backup._meta.tables || [])].reverse();
    const CATEGORY_TABLES = new Set(['todo_categories', 'habit_categories', 'vestiaire_categories', 'flashcard_decks']);
    const PROTECTED_IDS = new Set([
      '_default_todo_cat', '_shared_todo_cat',
      '_default_habit_cat', '_shared_habit_cat',
      '_default_vest_cat', '_shared_vest_cat',
      '_default_deck', '_shared_deck',
    ]);
    const totalSteps = tables.length + (backup._meta.tables || []).length;
    let step = 0;
    for (const table of tables) {
      showProgress(t('menu.settings_restore_clearing', table), ++step, totalSteps);
      try {
        const pk = (table === 'settings' || table === 'prompts') ? 'key'
          : table === 'sharing_items' ? 'item_id'
          : table === 'sharing_members' ? 'member_id'
          : 'id';
        if (CATEGORY_TABLES.has(table)) {
          // Delete non-protected rows individually — bulk delete would be blocked
          // by the protect trigger when it hits a protected row (rolls back entire statement)
          const { data: rows } = await state.db.from(table).select('id,is_protected');
          for (const row of (rows || [])) {
            if (row.is_protected) continue;
            try { await state.db.from(table).delete().eq('id', row.id); } catch {}
          }
        } else {
          await state.db.from(table).delete().neq(pk, '___nonexistent___');
        }
      } catch (e) { console.warn(`Could not clear ${table}:`, e.message); }
    }
    // Insert in forward order (parents before children)
    const importOrder = backup._meta.tables || [];
    let totalRows = 0;
    for (const table of importOrder) {
      showProgress(t('menu.settings_restore_restoring', table), ++step, totalSteps);
      const rows = backup[table];
      if (!rows || !rows.length) continue;
      try {
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100)
            .filter(r => !PROTECTED_IDS.has(r.id))        // skip protected defaults (already exist)
            .map(r => {
              const { owner_id, ...rest } = r;            // strip owner_id — trigger stamps new uid
              return rest;
            });
          if (!batch.length) continue;
          const { error } = await state.db.from(table).insert(batch);
          if (error) { console.warn(`Insert into ${table} batch ${i}:`, error.message); }
        }
        totalRows += rows.length;
      } catch (e) { console.warn(`Failed to restore ${table}:`, e.message); }
    }
    // Validate shared items: clear stale group refs if sharing is connected
    let sharedCleaned = 0;
    if (state.sharing?.isReady()) {
      showProgress(t('menu.settings_restore_sharing'), step, totalSteps);
      const validGroupIds = new Set(state.sharing.getAllGroups().map(g => g.id));
      const sharedTables = ['todos', 'habits', 'list_items'];
      for (const table of sharedTables) {
        try {
          const { data: rows } = await state.db.from(table).select('id,shared_group_id');
          if (!rows) continue;
          for (const row of rows) {
            if (row.shared_group_id && !validGroupIds.has(row.shared_group_id)) {
              await state.db.from(table).update({ shared_id: null, shared_group_id: null }).eq('id', row.id);
              sharedCleaned++;
            }
          }
        } catch (e) { console.warn(`Shared cleanup for ${table}:`, e.message); }
      }
    }
    hideProgress();
    showToast(t('menu.settings_restore_done', totalRows));
    if (sharedCleaned > 0) {
      showToast(t('menu.settings_restore_shared_cleaned', sharedCleaned), 'info');
    }
    // In demo/drive mode, reseed the in-memory adapter instead of reloading
    // (reload would re-create the adapter with default/empty data)
    const inMemAdapter = (state.demoMode && state.demoAdapter) ? state.demoAdapter
      : (state.driveMode && state.driveAdapter) ? state.driveAdapter : null;
    if (inMemAdapter) {
      const reseedData = {};
      for (const table of (backup._meta.tables || [])) {
        reseedData[table] = backup[table] || [];
      }
      inMemAdapter.reseed(reseedData);

      // Run pending migrations if the backup's schema is behind the app
      if (inMemAdapter.runPendingMigrations) {
        const migrated = await inMemAdapter.runPendingMigrations();
        if (migrated > 0) {
          showToast(t('menu.settings_restore_migrated', migrated), 'info');
        }
      }
      setDemoCategoriesFromData(reseedData);

      // Re-inject saved calendar settings over whatever the backup had
      if (state.driveMode && Object.keys(savedCalSettings).length > 0) {
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(savedCalSettings)) {
          await state.db.from('settings').upsert(
            { key: k, value: v, updated_at: now },
            { onConflict: 'key' }
          );
        }
      }
      await loadProjects();
      buildProjectCards();
      initProjectDragDrop();
      updateArchiveToggleBtn();
      renderArchivedProjects();
      await refreshAll();
      await refreshTodos();
      await refreshHabits();
      await refreshBirthdays();
      await refreshVestiaire();
      await refreshFlashcards();
      await refreshLists();
      refreshWelcome();
      // Reconcile calendar AFTER refreshes so state.allHabits / state.allBirthdays
      // are populated (syncTable reads them from state, not from the DB).
      if (syncWasEnabled) {
        await reconcileCalendar();
      }
      closeSettings();
    } else {
      // Reload to reflect new data
      setTimeout(() => location.reload(), 1200);
    }
  } catch (e) {
    console.error('Import failed:', e);
    showToast(t('menu.settings_restore_error'));
  } finally {
    hideProgress();
    if (btn) btn.disabled = false;
  }
}

window.exportBackup = exportBackup;
window.importBackup = importBackup;


// ===================================================================
// VIEW SWITCHER (Projects / TODOs / Habits)
// ===================================================================
// currentView is in state

function switchView(view, skipHash) {
  // Animate header logo on page transition
  const headerLogo = document.querySelector('.header-logo');
  if (headerLogo && view !== state.currentView) {
    if (window._logoAnim) window._logoAnim.stop();
    const px = headerLogo.getBoundingClientRect().width || 28;
    const base = { ...LOGO_DEFAULTS };
    const anim = animUnlock(headerLogo, base);
    window._logoAnim = anim;
    anim.promise.then(() => renderStorm(headerLogo, base));
  }
  state.currentView = view;
  localStorage.setItem(CURRENT_VIEW_KEY, view);
  // Sync URL hash (no reload)
  if (!skipHash) {
    const newHash = '#' + view;
    if (location.hash !== newHash) history.replaceState(null, '', newHash);
  }
  const welcomeView = document.getElementById('welcomeView');
  const projectsView = document.getElementById('projectsView');
  const todosView = document.getElementById('todosView');
  const habitsView = document.getElementById('habitsView');
  const birthdaysView = document.getElementById('birthdaysView');
  const vestiaireView = document.getElementById('vestiaireView');
  const flashcardsView = document.getElementById('flashcardsView');
  const listsView = document.getElementById('listsView');
  const tabWelcome = document.getElementById('tabWelcome');
  const tabProjects = document.getElementById('tabProjects');
  const tabTodos = document.getElementById('tabTodos');
  const tabHabits = document.getElementById('tabHabits');
  const tabBirthdays = document.getElementById('tabBirthdays');
  const tabVestiaire = document.getElementById('tabVestiaire');
  const tabFlashcards = document.getElementById('tabFlashcards');
  const tabLists = document.getElementById('tabLists');

  // Hide all
  if (welcomeView) welcomeView.style.display = 'none';
  projectsView.style.display = 'none';
  todosView.style.display = 'none';
  if (habitsView) habitsView.style.display = 'none';
  if (birthdaysView) birthdaysView.style.display = 'none';
  if (vestiaireView) vestiaireView.style.display = 'none';
  if (flashcardsView) flashcardsView.style.display = 'none';
  if (listsView) listsView.style.display = 'none';
  if (tabWelcome) tabWelcome.classList.remove('active');
  tabProjects.classList.remove('active');
  tabTodos.classList.remove('active');
  if (tabHabits) tabHabits.classList.remove('active');
  if (tabBirthdays) tabBirthdays.classList.remove('active');
  if (tabVestiaire) tabVestiaire.classList.remove('active');
  if (tabFlashcards) tabFlashcards.classList.remove('active');
  if (tabLists) tabLists.classList.remove('active');

  if (view === 'welcome') {
    if (welcomeView) welcomeView.style.display = '';
    if (tabWelcome) tabWelcome.classList.add('active');
    // Welcome aggregates its own stats (weekly completions, etc.) — refresh needed
    refreshWelcome().then(() => { renderWelcome(); markLastUpdated(); });
  } else if (view === 'projects') {
    projectsView.style.display = '';
    tabProjects.classList.add('active');
    renderAllTasks();
  } else if (view === 'todos') {
    todosView.style.display = '';
    tabTodos.classList.add('active');
    renderTodos();
  } else if (view === 'habits') {
    if (habitsView) habitsView.style.display = '';
    if (tabHabits) tabHabits.classList.add('active');
    renderHabits();
  } else if (view === 'birthdays') {
    if (birthdaysView) birthdaysView.style.display = '';
    if (tabBirthdays) tabBirthdays.classList.add('active');
    renderBirthdays();
  } else if (view === 'vestiaire') {
    if (vestiaireView) vestiaireView.style.display = '';
    if (tabVestiaire) tabVestiaire.classList.add('active');
    renderVestiaire();
  } else if (view === 'flashcards') {
    if (flashcardsView) flashcardsView.style.display = '';
    if (tabFlashcards) tabFlashcards.classList.add('active');
    renderFlashcards(); if (window._pendingPracticeStart) { delete window._pendingPracticeStart; if (typeof window.startPractice === 'function') window.startPractice('__all'); } if (window._pendingTextPracticeStart) { delete window._pendingTextPracticeStart; if (typeof window.startTextPractice === 'function') window.startTextPractice('__all'); }
  } else if (view === 'lists') {
    if (listsView) listsView.style.display = '';
    if (tabLists) tabLists.classList.add('active');
    renderLists();
  }

  // Scroll active tab into view on mobile (horizontal carousel)
  const activeTab = document.querySelector('.view-tab.active');
  if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

  updateViewFooterStats();
}

// ===================================================================

// ===================================================================
// VIEW-AWARE FOOTER STATS
// ===================================================================
function updateViewFooterStats() {
  const view = state.currentView;
  const icon = (name, sz = 14) => lucideIcon(name, sz);
  const viewCountsMap = {
    welcome: () => [
      `${icon('home')} ${t('nav.today')}`,
    ],
    projects: () => [
      `${icon('folder')} Projects: ${state.PROJECTS.length}`,
      `${icon('list-checks')} Tasks: ${state.allTasks.length}`,
    ],
    todos: () => {
      const c = getTodoCounts();
      return [
        `${icon('circle-dot')} Pending: ${c.pending}`,
        `${icon('circle-check')} Done: ${c.done}`,
      ];
    },
    habits: () => {
      const overdue = state.allHabits.filter(c => c.next_due && new Date(c.next_due) < new Date()).length;
      return [
        `${icon('repeat')} Habits: ${state.allHabits.length}`,
        `${icon('alert-triangle')} Overdue: ${overdue}`,
      ];
    },
    birthdays: () => [
      `${icon('cake')} Birthdays: ${state.allBirthdays.length}`,
    ],
    vestiaire: () => [
      `${icon('shirt')} Items: ${state.allVestiaire.length}`,
    ],
    flashcards: () => {
      const c = getFlashcardCounts();
      return [
        `${icon('book-open')} Cards: ${c.cards}`,
        `${icon('file-text')} Drafts: ${c.drafts}`,
      ];
    },
    lists: () => [
      `${icon('list')} Lists: ${(state.allLists || []).length}`,
      `${icon('list-checks')} Items: ${(state.allListItems || []).length}`,
    ],
  };
  updateFooterStats(viewCountsMap[view] || null);
}

// ===================================================================
// LAST UPDATED LABEL
// ===================================================================

function markLastUpdated() {
  _lastUpdatedAt = Date.now();
  renderLastUpdated();
  updateViewFooterStats();
  if (!_lastUpdatedTimer) {
    _lastUpdatedTimer = setInterval(renderLastUpdated, 60000);
  }
}

function renderLastUpdated() {
  const el = document.getElementById('lastUpdatedLabel');
  if (!el || !_lastUpdatedAt) return;
  const secs = Math.round((Date.now() - _lastUpdatedAt) / 1000);
  let text;
  if (secs < 5) text = t('utils.updated_just_now');
  else if (secs < 60) text = t('utils.updated_s_ago', secs);
  else if (secs < 3600) text = t('utils.updated_m_ago', Math.floor(secs / 60));
  else text = t('utils.updated_h_ago', Math.floor(secs / 3600));
  el.textContent = text;
}

// ===================================================================
// STALE-TAB REFRESH — re-fetch data when returning to a hidden tab
// ===================================================================
const STALE_TAB_MS = 2 * 60 * 1000; // 2 minutes

const _viewRefreshMap = {
  welcome:    () => refreshWelcome().then(() => { renderWelcome(); markLastUpdated(); }),
  projects:   () => refreshAll().then(() => markLastUpdated()),
  todos:      () => refreshTodos().then(() => { renderTodos(); markLastUpdated(); }),
  habits:     () => refreshHabits().then(() => { renderHabits(); markLastUpdated(); }),
  birthdays:  () => refreshBirthdays().then(() => { renderBirthdays(); markLastUpdated(); }),
  vestiaire:  () => refreshVestiaire().then(() => { renderVestiaire(); markLastUpdated(); }),
  flashcards: () => refreshFlashcards().then(() => markLastUpdated()),
  lists:      () => refreshLists().then(() => { renderLists(); markLastUpdated(); }),
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.db?.connected) return;
  const staleSince = _lastUpdatedAt ? Date.now() - _lastUpdatedAt : Infinity;
  if (staleSince < STALE_TAB_MS) return;
  const fn = _viewRefreshMap[state.currentView];
  if (fn) fn();
});

// ===================================================================
// SEARCH TOGGLE — collapsible search input
// ===================================================================
function toggleSearch(btn) {
  const wrapper = btn.closest('.search-wrapper');
  wrapper.classList.add('expanded');
  const input = wrapper.querySelector('.page-search');
  input.focus();
  if (!input.dataset.searchBlur) {
    input.dataset.searchBlur = '1';
    input.addEventListener('blur', function() {
      if (!input.value.trim()) {
        wrapper.classList.remove('expanded');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
}

// ===================================================================
// KEYBOARD SHORTCUT — Alt+Arrow to switch pages
// ===================================================================
document.addEventListener('keydown', e => {
  // Only respond to Alt+Left / Alt+Right (Option+Left/Right on Mac)
  if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  // Skip if focus is inside an input/textarea/select (avoid hijacking text editing)
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Skip if any modal is open
  if (document.querySelector('.modal-overlay.visible, .modal.visible')) return;
  e.preventDefault();
  const tabs = getVisibleTabs();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex(t => t.key === state.currentView);
  const cur = idx === -1 ? 0 : idx;
  const next = e.key === 'ArrowRight'
    ? (cur + 1) % tabs.length
    : (cur - 1 + tabs.length) % tabs.length;
  switchView(tabs[next].key);
});

window.switchView = switchView;

// ===================================================================
// DEEP-LINK NAVIGATION
// ===================================================================
function navigateToItem(type, id) {
  const view = DEEP_LINK_TYPE_MAP[type];
  if (!view) { showToast(t('common.item_not_found'), 'error'); return; }

  if (state.currentView !== view) {
    switchView(view);
  }
  let attempts = 0;
  const maxAttempts = 3;
  const tryFind = () => {
    attempts++;
    const el = findItemElement(type, id);
    if (el) {
      expandParentIfNeeded(type, id, el);
      highlightItem(el);
    } else if (attempts < maxAttempts) {
      setTimeout(tryFind, 150);
    } else {
      showToast(t('common.item_not_found'), 'error');
    }
  };
  requestAnimationFrame(() => setTimeout(tryFind, 150));
}

function findItemElement(type, id) {
  const eid = CSS.escape(id);
  const selectors = {
    todo: `[data-todo-id="${eid}"]`,
    habit: `[data-habit-id="${eid}"]`,
    project: `[data-project="${eid}"]`,
    task: `[data-task-id="${eid}"]`,
    birthday: `.birthday-card[data-id="${eid}"]`,
    vest: `[data-vest-id="${eid}"]`,
    flashcard: `[data-card-id="${eid}"]`,
    list: `[data-list-id="${eid}"]`,
    listitem: `[data-item-id="${eid}"]`,
  };
  const sel = selectors[type];
  return sel ? document.querySelector(sel) : null;
}

function expandParentIfNeeded(type, id, el) {
  if (type === 'task') {
    const archivedSection = el.closest('.archived-tasks');
    if (archivedSection && archivedSection.style.display === 'none') {
      const toggle = el.closest('.project-card')?.querySelector('.archive-toggle');
      if (toggle) toggle.click();
    }
  }
  const bucket = el.closest('.bucket-collapsed');
  if (bucket) {
    const header = bucket.querySelector('.bucket-header, .project-card-header');
    if (header) header.click();
  }
}

function handleStartupDeepLink() {
  // Settings deep link on startup
  if (location.hash === '#settings' || location.hash.startsWith('#settings/')) {
    const pane = location.hash.split('/')[1] || 'general';
    openSettings(pane);
    return;
  }
  const deepLink = parseDeepLink(location.hash);
  if (deepLink) {
    navigateToItem(deepLink.type, deepLink.id);
  }
}

// Delegated click handler for deep links in rendered markdown
document.addEventListener('click', (e) => {
  // Explicit deep links rendered by renderMd [text](#type/id)
  const deepLink = e.target.closest('a.deep-link[data-deep-link]');
  if (deepLink) {
    e.preventDefault();
    const val = deepLink.dataset.deepLink;
    const parts = val.split('/');
    if (parts.length === 2) {
      const [type, id] = parts;
      history.pushState(null, '', '#' + val);
      navigateToItem(type, id);
    }
    return;
  }
  // Full-URL links that point back to this app with a deep-link hash
  const anyLink = e.target.closest('a[href]');
  if (anyLink) {
    try {
      const url = new URL(anyLink.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.hash) {
        const parsed = parseDeepLink(url.hash);
        if (parsed) {
          e.preventDefault();
          history.pushState(null, '', url.hash);
          navigateToItem(parsed.type, parsed.id);
        }
      }
    } catch (_) { /* invalid URL, let browser handle */ }
  }
});

window.navigateToItem = navigateToItem;

function clearPageSearch(btn) {
  const input = btn.closest('.search-input-wrap').querySelector('.page-search');
  if (input) {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }
}

window.toggleTheme = toggleTheme;
window.disconnect = disconnect;

// ── Calendar sync settings ──

async function updateCalSyncUI() {
  const prefs = await getCalSyncPrefs();
  const mainRow = document.querySelector('[data-action="toggle-cal-sync"]');
  const subSettings = document.getElementById('calSyncSubSettings');
  if (mainRow) mainRow.classList.toggle('checked', prefs.enabled);
  if (subSettings) subSettings.style.display = prefs.enabled ? '' : 'none';
  // Sub-toggles
  const hRow = document.querySelector('[data-action="toggle-cal-sync-habits"]');
  const tRow = document.querySelector('[data-action="toggle-cal-sync-todos"]');
  const bRow = document.querySelector('[data-action="toggle-cal-sync-birthdays"]');
  if (hRow) hRow.classList.toggle('checked', prefs.habits);
  if (tRow) tRow.classList.toggle('checked', prefs.todos);
  if (bRow) bRow.classList.toggle('checked', prefs.birthdays);
  // Show calendar nav button only for Drive and Demo backends
  const calNavBtn = document.getElementById('settingsNavCalendarBtn');
  if (calNavBtn) calNavBtn.style.display = (state.demoMode || state.driveMode) ? '' : 'none';
}

let _calSyncBusy = false;

function _calSyncProgressCb(progressEl, progressText, progressFill, msgKey, doneKey) {
  return (ev) => {
    if (!ev) return;
    if (ev.done) {
      if (progressText) progressText.textContent = t(`cal_sync.${doneKey}`);
      if (progressFill) progressFill.style.width = '100%';
      setTimeout(() => { if (progressEl) progressEl.style.display = 'none'; }, 1500);
    } else {
      const label = t(`cal_sync.${ev.type === 'habit' ? 'habits' : ev.type === 'todo' ? 'todos' : 'birthdays'}`);
      if (progressText) progressText.textContent = t(`cal_sync.${msgKey}`, label);
      if (progressFill && ev.total > 0) progressFill.style.width = `${Math.round(((ev.index + 0.5) / ev.total) * 100)}%`;
    }
  };
}

async function toggleCalSync() {
  if (_calSyncBusy) return;
  _calSyncBusy = true;
  const row = document.querySelector('[data-action="toggle-cal-sync"]');
  if (row) row.classList.add('is-pending');
  const progressEl = document.getElementById('calSyncProgress');
  const progressText = document.getElementById('calSyncProgressText');
  const progressFill = document.getElementById('calSyncProgressFill');
  try {
    const prefs = await getCalSyncPrefs();
    if (prefs.enabled) {
      if (progressEl) progressEl.style.display = '';
      if (progressFill) progressFill.style.width = '0%';
      await disableCalSync({
        onProgress: _calSyncProgressCb(progressEl, progressText, progressFill, 'removing_type', 'remove_complete'),
      });
      showToast(t('cal_sync.disabled'), 'success');
    } else {
      const calId = await enableCalSync();
      if (!calId) return;
      if (progressEl) progressEl.style.display = '';
      if (progressFill) progressFill.style.width = '0%';
      await updateCalSyncUI();
      await reconcileCalendar(
        _calSyncProgressCb(progressEl, progressText, progressFill, 'syncing_type', 'sync_complete'),
      );
      showToast(t('cal_sync.enabled'), 'success');
    }
    await updateCalSyncUI();
  } finally {
    _calSyncBusy = false;
    if (row) row.classList.remove('is-pending');
  }
}

async function toggleCalSyncSub(subKey) {
  if (_calSyncBusy) return;
  _calSyncBusy = true;
  const row = document.querySelector(`[data-action="toggle-cal-sync-${subKey}"]`);
  if (row) row.classList.add('is-pending');
  const progressEl = document.getElementById('calSyncProgress');
  const progressText = document.getElementById('calSyncProgressText');
  const progressFill = document.getElementById('calSyncProgressFill');
  try {
    const settingKey = `gcal_sync_${subKey}`;
    const { data } = await state.db.from('settings').select('value').eq('key', settingKey).single();
    const current = data?.value !== 'false'; // defaults to true
    const newVal = !current;
    await state.db.from('settings').upsert(
      { key: settingKey, value: newVal ? 'true' : 'false', updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    await updateCalSyncUI();
    // subKey is 'habits', 'todos', or 'birthdays' → item type is singular
    const itemType = subKey.replace(/s$/, ''); // 'habit', 'todo', 'birthday'
    const label = t(`cal_sync.${subKey}`);
    const msgKey = newVal ? 'syncing_type' : 'removing_type';
    const doneKey = newVal ? 'sync_complete' : 'remove_complete';
    if (progressEl) progressEl.style.display = '';
    if (progressFill) progressFill.style.width = '40%'; // indeterminate pulse
    if (progressText) progressText.textContent = t(`cal_sync.${msgKey}`, label);
    if (!newVal) {
      await deleteTypeEvents(itemType);
    } else {
      await pushCalType(itemType);
    }
    if (progressText) progressText.textContent = t(`cal_sync.${doneKey}`);
    if (progressFill) progressFill.style.width = '100%';
    setTimeout(() => { if (progressEl) progressEl.style.display = 'none'; }, 1500);
  } finally {
    _calSyncBusy = false;
    if (row) row.classList.remove('is-pending');
  }
}

window.toggleCalSync = toggleCalSync;
window.toggleCalSyncSub = toggleCalSyncSub;
window.markCategoryRenamed = markCategoryRenamed;

// ── Delete account (Settings > Account > Danger Zone) ──

(function initDeleteAccount() {
  const btn = document.getElementById('deleteAccountBtn');
  if (!btn) return;
  // Hide in demo mode — no account to delete
  if (state.demoMode) {
    const pane = document.getElementById('settingsPane-account');
    if (pane) pane.style.display = 'none';
    const nav = document.querySelector('[data-pane="account"]');
    if (nav) nav.style.display = 'none';
    return;
  }
  btn.addEventListener('click', () => {
    const lang = getLang();
    const confirmWord = lang === 'fr' ? 'SUPPRIMER' : lang === 'es' ? 'ELIMINAR' : 'DELETE';
    // Pick backend-specific message
    const bodyKey = state.driveMode ? 'account.confirm_body_drive' : 'account.confirm_body_local';
    showConfirmAction(
      t('account.confirm_title'),
      t(bodyKey),
      async () => {
        // Show progress inside the modal
        const msgEl = document.getElementById('confirmActionMessage');
        const detailEl = document.getElementById('confirmActionDetail');
        const iconWrap = document.querySelector('.confirm-action-icon-wrap');
        if (detailEl) detailEl.style.display = 'none';
        if (iconWrap) iconWrap.innerHTML = '';

        function setStep(text) {
          if (msgEl) msgEl.textContent = text;
        }

        // 1. Calendar cleanup
        try {
          const prefs = await getCalSyncPrefs();
          if (prefs?.enabled) {
            setStep(t('account.step_calendar'));
            await disableCalSync({ deleteCalendar: true });
          }
        } catch { /* best effort */ }

        // 2. Delete data via adapter
        setStep(t('account.step_data'));
        const result = await (db.adapter?.deleteAccount?.() || { ok: false, error: 'Not supported' });
        if (!result.ok) {
          showToast(t('account.delete_failed'), 'error');
          window.location.href = window.location.origin + window.location.pathname;
          return;
        }

        // 3. Disconnect — tears down adapter, clears creds, reloads to gate
        setStep(t('account.step_signout'));
        await disconnect();
      },
      null,
      {
        keepOpen: true,
        btnText: t('account.delete_btn'),
        iconSvg: lucideIcon('alert-triangle', 32, '#ef4444'),
        btnIconSvg: lucideIcon('trash-2', 16, '#fff'),
        confirmWord,
        confirmPlaceholder: t('account.confirm_placeholder'),
      }
    );
  });
})();

window.toggleSearch = toggleSearch;
window.clearPageSearch = clearPageSearch;
window.dismissSchemaBanner = dismissSchemaBanner;
window.showCompareModal = showCompareModal;
window.closeCompareModal = closeCompareModal;

// CSP delegation for main handled in js/delegation.js — no per-module listeners

// --- Environment badge + dev favicon ---
(function() {
  const h = location.hostname;
  let env = null;
  if (h.startsWith('dev.') || h.includes('dev.delaclaw')) env = 'DEV';
  else if (h === 'localhost' || h === '127.0.0.1') env = 'LOCAL';
  if (!env) return;
  const badge = document.createElement('div');
  badge.className = 'env-badge';
  badge.textContent = env;
  document.body.appendChild(badge);
  // Swap favicon
  const favLink = document.querySelector('link[rel="icon"]');
  if (favLink) favLink.href = 'icons/favicon-dev.png';
})();
