import { lucideIcon } from './icons.js';
import { initHero, showHero, hideHero, injectGateLogo } from './hero.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import { renderStorm, generateStorm, LOGO_DEFAULTS, animLoading, animLock, animUnlock } from './logo.js';
import { LOGOS, LABELS } from './backend-logos.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY } from './state.js';
import db from './db.js';
import { createSupabaseAdapter } from './adapters/supabase.js';
import { createRestAdapter } from './adapters/rest.js';
import { wrapWithOfflineCache } from './adapters/offline-cache.js';
import { DRIVE_SCOPE_FILE } from './adapters/drive.js';
import { initCalSync, enableCalSync, disableCalSync, getCalSyncPrefs, reconcileAll as reconcileCalendar, syncTable as syncCalendarTable, markDirty as markCalDirty, markCategoryRenamed, deleteTypeEvents, pushType as pushCalType, resetCalendar as resetCalendarForImport, CAT_TABLE_TO_ITEM_TABLE } from './calendar-sync.js';

import { esc, showToast, showConfirmAction, closeConfirmAction, updateFooterStats, updateTaskListMaxHeight, isEditing, fetchAll, isInstalledPWA, deviceClass, isMobileUA, getSupabaseKeyRole, getSupabaseProjectRef, buildAuthSteps, parseDeepLink, highlightItem, DEEP_LINK_TYPE_MAP } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, renderAllTasks, loadPrompts, initProjectModals } from './projects.js';

const SETTINGS_PANES = ['general', 'ai', 'calendar', 'sharing', 'data', 'stats', 'agents', 'account'];
import { refreshTodos, renderTodos, getTodoCounts, initTodoModals, syncSharedTodos } from './todos.js';
import { refreshHabits, renderHabits, initHabitModals, syncSharedHabits } from './habits.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';
import { refreshLists, renderLists, initListModals, syncSharedListItems } from './lists.js';
import { updateSharingNavVisibility, renderSharingPane, applySettingsI18n as applySharingI18n } from './sharing-ui.js';
import { renderAgentsPane, applyAgentsI18n } from './agents-ui.js';
import { refreshWelcome, renderWelcome } from './welcome.js';
import { DEFAULT_CATEGORY_PALETTE, GENERAL_CATEGORY_COLOR } from './state.js';

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
    // First use ever: existing bare keys belong to 'supabase' (legacy default)
    if (newMode !== 'supabase') {
      saveLsScope('supabase');
      restoreLsScope(newMode);
    } else {
      localStorage.setItem(ACTIVE_MODE_KEY, 'supabase');
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
  return active ? active.dataset.mode : 'supabase';
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
  } else {
    if (keyField) { keyField.style.display = ''; keyField.style.visibility = ''; }
    if (urlField) { urlField.style.display = ''; urlField.style.visibility = ''; urlField.placeholder = 'https://xyz.supabase.co'; }
    if (urlLabel) { urlLabel.style.display = ''; urlLabel.style.visibility = ''; }
    if (urlLabelLink) { urlLabelLink.textContent = t('login.url_label'); urlLabelLink.href = 'https://supabase.com/dashboard/projects'; urlLabelLink.dataset.tooltip = t('toast.url_tooltip'); }
    if (hintEl) { hintEl.style.display = ''; hintEl.textContent = t('login.hint_supabase'); }
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
  // Update API Key link when project URL changes
  const _urlInput = document.getElementById('username');
  const _keyLink = document.getElementById('keyLabelLink');
  if (_urlInput && _keyLink) {
    const _updateKeyLink = () => {
      const v = _urlInput.value.trim();
      const m = v.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i) || v.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
      if (m) {
        _keyLink.href = `https://supabase.com/dashboard/project/${m[1]}/settings/api-keys`;
      } else {
        _keyLink.removeAttribute('href');
      }
    };
    _urlInput.addEventListener('input', _updateKeyLink);
    _updateKeyLink();
  }
  // Try auto-fill from Credential Management API
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
      renderSchemaMissingError(err, url);
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

// ── Auth prompt modal ─────────────────────────────────────────

/**
 * Show magic-link auth prompt after Supabase connect.
 * @param {Object} rawAdapter — unwrapped Supabase adapter (needs .raw.auth)
 * @param {string} url — Supabase project URL
 * @param {string} key — Supabase anon key
 */
function showAuthPrompt(rawAdapter, url, key) {
  const overlay = document.getElementById('authPromptOverlay');
  const content = document.getElementById('authPromptContent');
  if (!overlay || !content) return;

  // Build Supabase dashboard URL for Site URL config — use direct url param first, fall back to stored creds
  const creds = (() => { try { return JSON.parse(localStorage.getItem(STAY_CONNECTED_KEY) || '{}'); } catch { return {}; } })();
  const projRef = getSupabaseProjectRef(url) || getSupabaseProjectRef(creds.url || '') || null;
  const authConfigUrl = projRef ? `https://supabase.com/dashboard/project/${projRef}/auth/url-configuration` : 'https://supabase.com/dashboard/projects';

  // ── Sign-in form state ──
  function renderForm() {
    const steps = buildAuthSteps('auth', authConfigUrl);
    content.innerHTML = `
      <div class="auth-icon">${lucideIcon('lock', 28)}</div>
      <h3>${t('auth.sign_in')}</h3>
      <p class="auth-hint">${t('auth.sign_in_hint_mandatory')}</p>
      ${steps.html}
    `;
    steps.wireUp(content);
    const emailEl = content.querySelector('#authEmail');
    const errEl = content.querySelector('#authError');
    const sendBtn = content.querySelector('#authSendBtn');

    sendBtn.addEventListener('click', async () => {
      const email = emailEl.value.trim();
      if (!email || !email.includes('@')) {
        errEl.textContent = t('auth.error');
        errEl.style.display = '';
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = t('auth.sending');
      errEl.style.display = 'none';
      try {
        // ── Email guard: block mismatched email before sending ──
        const { checkEmailGuard, sendMagicLink } = await import('./auth.js');
        const { allowed } = await checkEmailGuard(rawAdapter, email);
        if (!allowed) {
          errEl.textContent = t('auth.email_mismatch');
          errEl.style.display = '';
          sendBtn.disabled = false;
          sendBtn.textContent = t('auth.send_magic_link');
          return;
        }
        const { error } = await sendMagicLink(rawAdapter, email);
        if (error) {
          const isRateLimit = error.status === 429 || (error.message || '').toLowerCase().includes('rate');
          errEl.textContent = isRateLimit ? t('auth.rate_limit') : t('auth.error');
          errEl.style.display = '';
          sendBtn.disabled = false;
          sendBtn.textContent = t('auth.send_magic_link');
        } else {
          renderInbox(email);
        }
      } catch {
        errEl.textContent = t('auth.error');
        errEl.style.display = '';
        sendBtn.disabled = false;
        sendBtn.textContent = t('auth.send_magic_link');
      }
    });

    emailEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
    });
  }

  // ── Check-inbox state ──
  function renderInbox(email) {
    const isStandalonePWA = (() => { try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch { return false; } })();
    const pwaAckKey = 'cc-pwa-copy-hint-ack';
    const pwaAlreadyAcked = (() => { try { return localStorage.getItem(pwaAckKey) === '1'; } catch { return true; } })();
    const needsPwaAck = isStandalonePWA && !pwaAlreadyAcked;

    content.innerHTML = `
      <div class="auth-icon">${lucideIcon('mail', 28)}</div>
      <h3>${t('auth.check_inbox')}</h3>
      <p class="auth-hint">${t('auth.check_inbox_hint', esc(email))}</p>
      <div style="margin:14px 0; padding:10px 14px; border:1px solid var(--warning-border, #e6a817); border-radius:10px; background:color-mix(in srgb, var(--warning-border, #e6a817) 10%, var(--bg)); display:flex; gap:10px; align-items:flex-start;">
        <span style="flex-shrink:0; margin-top:1px; color:var(--warning-border, #e6a817);">${lucideIcon('alert-triangle', 18)}</span>
        <p style="margin:0; font-size:0.9em; line-height:1.45; color:var(--text);">${t('auth.do_not_click')}</p>
      </div>
      <div id="authPwaHint" style="${needsPwaAck ? '' : 'display:none;'} margin:16px 0; padding:12px 14px; border:1px solid var(--accent); border-radius:10px; background:color-mix(in srgb, var(--accent) 8%, var(--bg));">
        <div style="display:flex; gap:10px; align-items:flex-start;">
          <div style="margin-top:2px;">${lucideIcon('smartphone', 20)}</div>
          <div style="flex:1;">
            <strong style="display:block; margin-bottom:4px; font-size:0.95em;">${t('auth.pwa_copy_title')}</strong>
            <p style="margin:0 0 10px 0; font-size:0.9em; line-height:1.4; color:var(--text-muted);">${t('auth.pwa_copy_body')}</p>
            <button id="authPwaAckBtn" class="auth-send-btn" style="width:auto; padding:6px 14px; font-size:0.9em;">${t('auth.pwa_copy_ack')}</button>
          </div>
        </div>
      </div>
      <div class="auth-otp-box" style="margin:16px 0; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--bg-subtle,#f8f9fa);">
        <p class="auth-hint" style="font-size:0.9em; margin-bottom:8px;">${t('auth.otp_hint')}</p>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" id="authOtpInput" placeholder="${t('auth.otp_placeholder')}" inputmode="text" autocomplete="one-time-code" maxlength="500" style="flex:1; min-width:0; padding:10px 12px; font-size:14px; text-align:left; border:1px solid var(--border); border-radius:6px; overflow:hidden; text-overflow:ellipsis;" ${needsPwaAck ? 'disabled' : ''}>
          <button class="auth-send-btn" id="authVerifyBtn" style="width:auto; flex:0 0 auto; white-space:nowrap;" ${needsPwaAck ? 'disabled' : ''}>${t('auth.verify_code')}</button>
        </div>
        <div class="auth-error" id="authOtpError" style="display:none; margin-top:8px;"></div>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="auth-send-btn" id="authResendBtn" style="flex:0 0 auto; width:auto;">${t('auth.resend')}</button>
        <button class="auth-skip" id="authCloseBtn">${t('auth.close')}</button>
      </div>
      <div class="auth-status" id="authResendStatus" style="display:none; margin-top:8px;"></div>
    `;
    const resendBtn = content.querySelector('#authResendBtn');
    const closeBtn = content.querySelector('#authCloseBtn');
    const statusEl = content.querySelector('#authResendStatus');
    const otpInput = content.querySelector('#authOtpInput');
    const verifyBtn = content.querySelector('#authVerifyBtn');
    const otpErrEl = content.querySelector('#authOtpError');

    async function doVerify() {
      const code = (otpInput?.value || '').trim();
      if (!code || code.length < 6) {
        if (otpErrEl) { otpErrEl.textContent = t('auth.otp_invalid') || 'Paste the confirmation link or token from your email.'; otpErrEl.style.display = ''; }
        return;
      }
      verifyBtn.disabled = true;
      verifyBtn.textContent = t('auth.verifying') || 'Verifying...';
      if (otpErrEl) otpErrEl.style.display = 'none';
      try {
        const { verifyOtpCode } = await import('./auth.js');
        const { user, error } = await verifyOtpCode(rawAdapter, email, code);
        if (error || !user) {
          const msg = error?.message || '';
          const isExpired = msg.toLowerCase().includes('expired');
          otpErrEl.textContent = isExpired ? (t('auth.otp_expired') || 'Link expired — resend a new one.') : (t('auth.otp_invalid') || 'Invalid link or token. Check the email and paste it again.');
          otpErrEl.style.display = '';
          verifyBtn.disabled = false;
          verifyBtn.textContent = t('auth.verify_code') || 'Verify';
          return;
        }
        // Success — close prompt, session will be handled by onAuthStateChange + init logic
        // Store email guard hash (no-op if already set)
        try {
          const { setEmailGuard } = await import('./auth.js');
          await setEmailGuard(rawAdapter, email);
        } catch { /* guard table may not exist yet */ }
        statusEl.textContent = t('auth.verified') || 'Verified! Signing you in...';
        statusEl.style.display = '';
        overlay.classList.remove('visible');
        // Force reload to pick up session (initAuth runs on next connect)
        window.location.reload();
      } catch (e) {
        console.warn('otp verify failed', e);
        if (otpErrEl) { otpErrEl.textContent = t('auth.error'); otpErrEl.style.display = ''; }
        verifyBtn.disabled = false;
        verifyBtn.textContent = t('auth.verify_code') || 'Verify';
      }
    }

    verifyBtn.addEventListener('click', doVerify);
    otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
    // Auto-focus verification input for PWA users (only if not blocked by PWA ack)
    if (!needsPwaAck) {
      setTimeout(() => { try { otpInput.focus(); } catch {} }, 100);
    }

    const pwaAckBtn = content.querySelector('#authPwaAckBtn');
    const pwaHint = content.querySelector('#authPwaHint');
    if (pwaAckBtn) {
      pwaAckBtn.addEventListener('click', () => {
        try { localStorage.setItem(pwaAckKey, '1'); } catch {}
        if (pwaHint) pwaHint.style.display = 'none';
        verifyBtn.disabled = false;
        otpInput.disabled = false;
        setTimeout(() => { try { otpInput.focus(); } catch {} }, 50);
      });
    }

    resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true;
      resendBtn.textContent = t('auth.sending');
      try {
        const { sendMagicLink } = await import('./auth.js');
        const { error } = await sendMagicLink(rawAdapter, email);
        if (error) {
          const isRateLimit = error.status === 429 || (error.message || '').toLowerCase().includes('rate');
          statusEl.textContent = isRateLimit ? t('auth.rate_limit') : t('auth.error');
          statusEl.style.color = 'var(--danger,#e74c3c)';
        } else {
          statusEl.textContent = t('auth.sent');
          statusEl.style.color = '';
        }
        statusEl.style.display = '';
      } catch { /* ignore */ }
      resendBtn.disabled = false;
      resendBtn.textContent = t('auth.resend');
    });

    closeBtn.addEventListener('click', () => {
      overlay.classList.remove('visible');
    });
  }

  renderForm();
  overlay.style.removeProperty('display');
  overlay.classList.add('visible');
}

/** Global entry point for sending auth link from Settings > Sharing pane. */
async function sendAuthFromSharing() {
  const emailEl = document.getElementById('sharingAuthEmail');
  const errEl = document.getElementById('sharingAuthError');
  const statusEl = document.getElementById('sharingAuthStatus');
  const btn = document.getElementById('sharingAuthSendBtn');
  if (!emailEl || !btn) return;
  const email = emailEl.value.trim();
  if (!email || !email.includes('@')) {
    if (errEl) { errEl.textContent = t('auth.error'); errEl.style.display = ''; }
    return;
  }
  btn.disabled = true;
  btn.textContent = t('auth.sending');
  if (errEl) errEl.style.display = 'none';
  try {
    const { sendMagicLink } = await import('./auth.js');
    const { error } = await sendMagicLink(state._rawSupabaseAdapter, email);
    if (error) {
      const isRateLimit = error.status === 429 || (error.message || '').toLowerCase().includes('rate');
      if (errEl) { errEl.textContent = isRateLimit ? t('auth.rate_limit') : t('auth.error'); errEl.style.display = ''; }
      btn.disabled = false;
      btn.textContent = t('auth.send_magic_link');
    } else {
      if (statusEl) { statusEl.textContent = t('auth.check_inbox_hint', esc(email)); statusEl.style.display = ''; }
      btn.textContent = t('auth.sent');
      setTimeout(() => { btn.disabled = false; btn.textContent = t('auth.send_magic_link'); }, 5000);
    }
  } catch {
    if (errEl) { errEl.textContent = t('auth.error'); errEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = t('auth.send_magic_link');
  }
}
window.sendAuthFromSharing = sendAuthFromSharing;



function getStayConnectedCreds() {
  try {
    const raw = localStorage.getItem(STAY_CONNECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Self-heal: purge if service_role was ever stored (pre-fix data)
    if (parsed && parsed.key) {
      const role = getSupabaseKeyRole(parsed.key);
      if (role === 'service_role' || parsed.key.startsWith('sb_secret_')) {
        try { localStorage.removeItem(STAY_CONNECTED_KEY); } catch {}
        return null;
      }
    }
    if (parsed && parsed.mode === 'demo') return parsed;
    if (parsed && parsed.mode === 'googledrive') return parsed;
    if (parsed && parsed.url && (parsed.key || parsed.mode === 'local')) return parsed;
    return null;
  } catch { return null; }
}

function saveStayConnectedCreds(url, key, mode) {
  const m = mode || 'supabase';
  // Defense in depth: never persist service_role, never persist key for local/demo/drive
  if (m === 'local' || m === 'demo' || m === 'googledrive') {
    key = '';
  }
  if (key) {
    const role = getSupabaseKeyRole(key);
    if (role === 'service_role' || key.startsWith('sb_secret_')) {
      // Do not persist — caller should have already blocked, but belt-and-braces
      return;
    }
  }
  // For supabase, strip whitespace; for local/demo/drive key is already ''
  localStorage.setItem(STAY_CONNECTED_KEY, JSON.stringify({ url, key: key || '', mode: m }));
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
  // Clean up Supabase sharing
  if (state.sharing && !state.driveMode) {
    try { state.sharing.destroy(); } catch {}
  }
  state.authUser = null;
  clearStayConnectedCreds();
  location.reload();
}

// Normalize Supabase dashboard URLs to API base URLs
function normalizeSupabaseUrl(raw) {
  const dm = raw.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dm) return `https://${dm[1]}.supabase.co`;
  return raw;
}


function renderSchemaMissingError(container, projectUrl) {
  if (!container) return;
  container.textContent = '';
  container.style.lineHeight = '1.4';
  container.style.maxWidth = '360px';

  const title = document.createElement('div');
  title.textContent = t('toast.schema_missing') || 'Tables not found — run sql/supabase_schema.sql in Supabase SQL Editor.';
  title.style.fontWeight = '600';
  title.style.marginBottom = '2px';
  container.appendChild(title);

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.flexWrap = 'wrap';
  actions.style.gap = '8px';
  actions.style.marginTop = '10px';

  const ref = getSupabaseProjectRef(projectUrl);
  const sqlEditorUrl = ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'https://supabase.com/dashboard/projects';

  // Primary: Copy schema (nice UI) — first left to right
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  const copyLabel = t('toast.copy_schema') || t('setup.copy_btn') || 'Copy schema';
  copyBtn.innerHTML = `${lucideIcon('copy', 14)} ${copyLabel}`;
  copyBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:0.85rem;font-weight:600;cursor:pointer;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,0.12);transition:all 0.15s;';
  copyBtn.addEventListener('click', async () => {
    try {
      let sql = window._SUPABASE_SCHEMA_CACHED || '';
      if (!sql) {
        const r = await fetch('./sql/supabase_schema.sql', { cache: 'no-store' });
        if (!r.ok) throw new Error('fetch failed ' + r.status);
        sql = await r.text();
        window._SUPABASE_SCHEMA_CACHED = sql;
      }
      await navigator.clipboard.writeText(sql);
      copyBtn.innerHTML = `${lucideIcon('check', 14)} ${t('toast.copied') || t('setup.copy_done') || 'Copied!'}`;
      copyBtn.style.opacity = '0.9';
      setTimeout(() => {
        copyBtn.innerHTML = `${lucideIcon('copy', 14)} ${copyLabel}`;
        copyBtn.style.opacity = '1';
      }, 2000);
    } catch {
      window.open('https://raw.githubusercontent.com/AntGro/DeLaClaw/dev/sql/supabase_schema.sql', '_blank');
    }
  });
  copyBtn.addEventListener('mouseenter', () => { copyBtn.style.transform = 'translateY(-1px)'; copyBtn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.18)'; });
  copyBtn.addEventListener('mouseleave', () => { copyBtn.style.transform = 'none'; copyBtn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'; });
  actions.appendChild(copyBtn);

  // Secondary: Open SQL Editor
  const openLink = document.createElement('a');
  openLink.href = sqlEditorUrl;
  openLink.target = '_blank';
  openLink.rel = 'noopener';
  openLink.innerHTML = `${lucideIcon('external-link', 14)} ${t('toast.open_sql_editor') || 'Open SQL Editor'}`;
  openLink.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);text-decoration:none;font-size:0.85rem;font-weight:600;line-height:1;transition:all 0.15s;';
  actions.appendChild(openLink);

  container.appendChild(actions);

  const hint = document.createElement('div');
  hint.textContent = t('toast.schema_missing_hint') || 'Paste in SQL Editor → Run, then retry Connect.';
  hint.style.fontSize = '0.8em';
  hint.style.opacity = '0.75';
  hint.style.marginTop = '8px';
  container.appendChild(hint);
}

async function doLogin() {
  const url = normalizeSupabaseUrl(document.getElementById('username').value.trim());
  const key = document.getElementById('password').value.trim();
  const stayConnected = document.getElementById('stayConnected').checked;
  const err = document.getElementById('loginError');
  const mode = getSelectedMode();
  if (mode !== 'demo' && mode !== 'googledrive' && (!url || (!key && mode !== 'local'))) { err.textContent = t('toast.enter_name'); return; }
  // sec: reject service_role / sb_secret_ — anon / sb_publishable_ only
  if (mode === 'supabase' && key) {
    const role = getSupabaseKeyRole(key);
    if (role === 'service_role' || key.startsWith('sb_secret_')) {
      err.textContent = t('login.err_service_role');
      return;
    }
  }
  // Detect org URL
  if (/supabase\.com\/dashboard\/org\//i.test(url)) {
    err.innerHTML = t('toast.org_url_tip');
    return;
  }
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
      renderSchemaMissingError(err, url);
    } else if (e.message === 'project_paused') {
      // Safe DOM — no innerHTML with URL interpolation (P0 sec-002)
      const safeUrl = /^https:\/\/supabase\.com\/dashboard\/project\/[a-z0-9]+$/i.test(e.dashboardUrl) ? e.dashboardUrl : 'https://supabase.com/dashboard/projects';
      err.textContent = '';
      err.appendChild(document.createTextNode((t('toast.project_paused') ? t('toast.project_paused') + ' ' : 'Database paused — ')));
      const a = document.createElement('a');
      a.href = safeUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.color = 'var(--accent)';
      a.style.textDecoration = 'underline';
      a.textContent = 'Check on Supabase ↗';
      err.appendChild(a);
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
  const setupCloudDone = document.getElementById('setupCloudDone');
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
    const cloud = document.getElementById('setupCloudSteps');
    const local = document.getElementById('setupLocalSteps');
    const drive = document.getElementById('setupDriveSteps');
    const cardCloud = document.getElementById('setupPathCloud');
    const cardLocal = document.getElementById('setupPathLocal');
    const cardDrive = document.getElementById('setupPathDrive');
    [cloud, local, drive].forEach(el => el && (el.style.display = 'none'));
    [cardCloud, cardLocal, cardDrive].forEach(el => el?.classList.remove('active'));
    if (path === 'cloud') {
      cloud.style.display = ''; cardCloud.classList.add('active');
    } else if (path === 'drive') {
      drive.style.display = ''; cardDrive.classList.add('active');
    } else {
      local.style.display = ''; cardLocal.classList.add('active');
    }
  }

  if (guideLink) guideLink.addEventListener('click', e => { e.preventDefault(); showGuide(); });
  if (setupBack) setupBack.addEventListener('click', hideGuide);
  if (setupCloudDone) setupCloudDone.addEventListener('click', hideGuide);
  if (setupLocalDone) setupLocalDone.addEventListener('click', hideGuide);
  if (setupDriveDone) setupDriveDone.addEventListener('click', hideGuide);
  document.getElementById('setupPathCloud')?.addEventListener('click', () => showSteps('cloud'));
  document.getElementById('setupPathLocal')?.addEventListener('click', () => showSteps('local'));
  document.getElementById('setupPathDrive')?.addEventListener('click', () => showSteps('drive'));
  document.getElementById('setupCompareLink')?.addEventListener('click', (e) => { e.preventDefault(); showCompareModal(); });

  // ── Schema copy + toggle ──
  let SUPABASE_SCHEMA = '';
  fetch('./sql/supabase_schema.sql').then(r => r.text()).then(sql => {
    SUPABASE_SCHEMA = sql;
    const schemaSql = document.getElementById('setupSchemaSql');
    if (schemaSql) schemaSql.textContent = sql;
  }).catch(() => {});

  const schemaSql = document.getElementById('setupSchemaSql');

  const schemaToggle = document.getElementById('setupSchemaToggle');
  const schemaBox = document.getElementById('setupSchemaBox');
  if (schemaToggle && schemaBox) {
    schemaToggle.addEventListener('click', () => {
      const open = schemaBox.classList.toggle('visible');
      schemaToggle.classList.toggle('open', open);
    });
  }

  const copyBtn = document.getElementById('setupCopySchema');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SUPABASE_SCHEMA);
        copyBtn.classList.add('copied');
        const label = document.getElementById('setupCopyLabel');
        const prev = label ? label.textContent : '';
        if (label) label.textContent = t('setup.copy_done') || 'Copied!';
        setTimeout(() => { copyBtn.classList.remove('copied'); if (label) label.textContent = prev; }, 2000);
      } catch { /* clipboard denied — the pre is still selectable */ }
    });
  }

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

  // ── Project URL validation + link rewriting ──
  const _projectUrlInput = document.getElementById('setupProjectUrl');
  const _projectUrlError = document.getElementById('setupProjectUrlError');
  const _projectUrlPattern = /^https?:\/\/(?:supabase\.com\/dashboard\/project\/([a-z0-9]+)|([a-z0-9]+)\.supabase\.co)/i;
  let _projectRef = '';

  function _updateProjectLinks(ref) {
    _projectRef = ref;
    const s2 = document.getElementById('setupCloud2Desc');
    if (s2) { const a = s2.querySelector('a[href*="supabase.com/dashboard/project/"]'); if (a) a.href = 'https://supabase.com/dashboard/project/' + ref + '/sql'; }
    const s3 = document.getElementById('setupCloud3Desc');
    if (s3) { const a = s3.querySelector('a[href*="supabase.com/dashboard/project/"]'); if (a) a.href = 'https://supabase.com/dashboard/project/' + ref + '/settings/api-keys'; }
    const skl = document.getElementById('setupKeyLabelLink');
    if (skl) {
      if (ref && ref !== '_') {
        skl.href = 'https://supabase.com/dashboard/project/' + ref + '/settings/api-keys';
      } else {
        skl.removeAttribute('href');
      }
    }
  }

  // Block clicks on step 2/3 dashboard links when no project URL provided
  function _guardProjectLink(e) {
    if (!_projectRef || _projectRef === '_') {
      e.preventDefault();
      e.stopPropagation();
      // Show inline warning
      const step = e.target.closest('.setup-step');
      if (step) {
        let warn = step.querySelector('.setup-url-required-msg');
        if (!warn) {
          warn = document.createElement('p');
          warn.className = 'setup-url-required-msg';
          step.querySelector('.setup-step-body')?.appendChild(warn);
        }
        warn.textContent = t('setup.cloud_url_required') || 'Please provide your project URL in Step 1 first.';
        warn.style.display = '';
        clearTimeout(warn._hideTimer);
        warn._hideTimer = setTimeout(() => { warn.style.display = 'none'; }, 4000);
      }
    }
  }
  document.getElementById('setupCloud2Desc')?.addEventListener('click', e => { if (e.target.closest('a[href*="supabase.com/dashboard/project/"]')) _guardProjectLink(e); });
  document.getElementById('setupCloud3Desc')?.addEventListener('click', e => { if (e.target.closest('a[href*="supabase.com/dashboard/project/"]')) _guardProjectLink(e); });

  if (_projectUrlInput) {
    _projectUrlInput.addEventListener('input', () => {
      const val = _projectUrlInput.value.trim();
      if (!val) {
        _projectUrlInput.classList.remove('valid', 'invalid');
        if (_projectUrlError) { _projectUrlError.classList.remove('visible'); _projectUrlError.textContent = ''; }
        _updateProjectLinks('_');
        return;
      }
      // Detect org URL and show tip
      if (/supabase\.com\/dashboard\/org\//i.test(val)) {
        _projectUrlInput.classList.add('invalid');
        _projectUrlInput.classList.remove('valid');
        if (_projectUrlError) {
          _projectUrlError.innerHTML = t('toast.org_url_tip');
          _projectUrlError.classList.add('visible');
        }
        _updateProjectLinks('_');
        return;
      }
      const m = val.match(_projectUrlPattern);
      if (m) {
        _projectUrlInput.classList.add('valid');
        _projectUrlInput.classList.remove('invalid');
        if (_projectUrlError) { _projectUrlError.classList.remove('visible'); _projectUrlError.textContent = ''; }
        _updateProjectLinks(m[1] || m[2]);
      } else {
        _projectUrlInput.classList.add('invalid');
        _projectUrlInput.classList.remove('valid');
        if (_projectUrlError) {
          _projectUrlError.textContent = t('toast.invalid_project_url');
          _projectUrlError.classList.add('visible');
        }
        _updateProjectLinks('_');
      }
    });
  }

  // ── Setup login form (step 4) ──
  const _setupLoginForm = document.getElementById('setupLoginForm');
  const _setupLoginUrl = document.getElementById('setupLoginUrl');
  const _setupLoginKey = document.getElementById('setupLoginKey');
  const _setupLoginError = document.getElementById('setupLoginError');

  // Pre-fill URL from step 1 project URL input
  if (_projectUrlInput && _setupLoginUrl) {
    _projectUrlInput.addEventListener('input', () => {
      const val = _projectUrlInput.value.trim();
      const m = val.match(_projectUrlPattern);
      if (m) {
        _setupLoginUrl.value = 'https://' + (m[1] || m[2]) + '.supabase.co';
      }
    });
  }

  if (_setupLoginForm) {
    _setupLoginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const url = normalizeSupabaseUrl(_setupLoginUrl?.value.trim() || '');
      const key = _setupLoginKey?.value.trim();
      if (!url || !key) {
        if (_setupLoginError) _setupLoginError.textContent = t('toast.enter_name') || 'Please fill in both fields.';
        return;
      }
      // sec: anon only
      if (key && (getSupabaseKeyRole(key)==='service_role' || key.startsWith('sb_secret_'))) {
        if (_setupLoginError) _setupLoginError.textContent = t('login.err_service_role');
        return;
      }
      if (_setupLoginError) _setupLoginError.textContent = t('toast.connecting') || 'Connecting…';
      try {
        const result = await connect(url, key, 'supabase');
        if (result === false) { if (_setupLoginError) _setupLoginError.textContent = ''; return; }
        if (_setupLoginError) _setupLoginError.textContent = '';
        const setupStay = document.getElementById('setupStayConnected');
        if (setupStay?.checked) saveStayConnectedCreds(url, key, 'supabase');
        _setupLoginForm.style.display = 'none';
        document.body.style.overflow = '';
        if (window.PasswordCredential) {
          try { await navigator.credentials.store(new PasswordCredential({ id: url, password: key })); } catch {}
        }
      } catch (e) {
        if (_setupLoginError) {
          if (e.message === 'schema_missing') {
            renderSchemaMissingError(_setupLoginError, url);
          } else if (e.message === 'project_paused') {
            // Safe DOM — no innerHTML with URL interpolation (P0 sec-002)
            const safeUrl = /^https:\/\/supabase\.com\/dashboard\/project\/[a-z0-9]+$/i.test(e.dashboardUrl) ? e.dashboardUrl : 'https://supabase.com/dashboard/projects';
            _setupLoginError.textContent = '';
            _setupLoginError.appendChild(document.createTextNode((t('toast.project_paused') ? t('toast.project_paused') + ' ' : 'Database paused — ')));
            const a = document.createElement('a');
            a.href = safeUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.style.color = 'var(--accent)';
            a.style.textDecoration = 'underline';
            a.textContent = 'Check on Supabase ↗';
            _setupLoginError.appendChild(a);
          } else {
            _setupLoginError.textContent = t('toast.connection_failed') || 'Connection failed.';
          }
        }
      }
    });
  }

  // Auto-show guide if URL hash is #setup
  if (window.location.hash === '#setup') showGuide();
});

// ===================================================================
// SUPABASE DEPRECATION — MIGRATION MODAL
// ===================================================================
let _pendingMigrationBackup = null;

function showSupabaseMigrationModal(backupPromise) {
  console.log('[migration] showSupabaseMigrationModal called');
  const overlay = document.getElementById('sbMigrationOverlay');
  console.log('[migration] overlay element:', overlay);
  if (!overlay) return;

  // Set Supabase logo as icon
  const iconEl = document.getElementById('sbMigrationIcon');
  if (iconEl) iconEl.innerHTML = LOGOS.supabase(36);

  const statusEl = document.getElementById('sbMigrationStatus');
  const downloadBtn = document.getElementById('sbMigrationDownload');
  const driveBtn = document.getElementById('sbMigrationDrive');
  const backBtn = document.getElementById('sbMigrationBack');
  const warnEl = document.getElementById('sbMigrationSharingWarn');

  // Apply i18n first (textContent replaces everything)
  overlay.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val && val !== key) el.textContent = val;
  });

  // Inject icons into buttons after i18n
  if (downloadBtn && !downloadBtn.querySelector('svg')) {
    downloadBtn.insertAdjacentHTML('afterbegin', lucideIcon('download', 16));
  }
  if (driveBtn && !driveBtn.querySelector('img')) {
    driveBtn.insertAdjacentHTML('afterbegin', LOGOS.googledrive(16));
  }

  // Show modal immediately in loading state
  downloadBtn.disabled = true;
  driveBtn.disabled = true;
  if (statusEl) statusEl.textContent = t('migration.preparing');
  overlay.classList.add('visible');
  console.log('[migration] overlay.visible added, computed display:', getComputedStyle(overlay).display);

  // Fetch backup data in background, then enable actions
  let backup = null;
  backupPromise.then(b => {
    backup = b;
    downloadBtn.disabled = false;
    driveBtn.disabled = false;
    if (statusEl) statusEl.textContent = '';
    // Show sharing warning if backup has sharing data
    const hasSharingData = backup.sharing_groups && backup.sharing_groups.length > 0;
    if (warnEl) warnEl.style.display = hasSharingData ? '' : 'none';
  }).catch(e => {
    console.warn('[DeLaClaw] backup generation failed:', e);
    if (statusEl) statusEl.textContent = t('migration.error');
  });

  // Download backup
  downloadBtn.onclick = () => {
    if (!backup) return;
    try {
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = blobUrl; a.download = `delaclaw-backup-${date}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
      if (statusEl) statusEl.textContent = t('menu.settings_backup_done') || 'Backup downloaded.';
    } catch (e) {
      if (statusEl) statusEl.textContent = t('menu.settings_backup_error') || 'Export failed.';
    }
  };

  // Migrate to Google Drive
  driveBtn.onclick = async () => {
    if (!backup) return;
    driveBtn.disabled = true;
    downloadBtn.disabled = true;
    if (statusEl) statusEl.textContent = t('migration.migrating');

    try {
      // Store backup for the Drive connect path to pick up
      _pendingMigrationBackup = backup;

      // Close the modal
      overlay.classList.remove('visible');

      // Clear saved Supabase credentials so auto-connect doesn't loop back
      try { localStorage.removeItem(STAY_CONNECTED_KEY); } catch {}

      // Trigger Drive connect — the Google OAuth popup opens on this user click
      await connect(null, null, 'googledrive');

      // If we get here, Drive connected successfully and the dashboard loaded.
      // Save Drive as the "Stay connected" mode
      saveStayConnectedCreds('', '', 'googledrive');

    } catch (e) {
      // Drive connect failed — show modal again with error
      _pendingMigrationBackup = null;
      overlay.classList.add('visible');
      driveBtn.disabled = false;
      downloadBtn.disabled = false;
      if (statusEl) statusEl.textContent = t('migration.error');
      console.warn('[DeLaClaw] migration to Drive failed:', e.message);
    }
  };

  // Back to login
  backBtn.onclick = (e) => {
    e.preventDefault();
    overlay.classList.remove('visible');
    // Clear saved Supabase credentials
    try { localStorage.removeItem(STAY_CONNECTED_KEY); } catch {}
    // Show login form
    const form = document.getElementById('loginForm');
    if (form) form.style.display = 'flex';
    // Switch mode to googledrive as default
    switchBackendMode('googledrive');
  };
}

// ===================================================================
// UNLOCK & INIT APP
// ===================================================================
async function connect(url, key, mode = 'supabase', skipDemoChooser = false, { silentAuth = false } = {}) {
  state.supabaseUrl = url;
  state.supabaseKey = key;

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

    // ── Supabase → Drive migration: import pending backup ──
    if (_pendingMigrationBackup) {
      const backup = _pendingMigrationBackup;
      _pendingMigrationBackup = null;

      // Filter to Drive-supported tables only
      const driveTables = new Set([
        'projects', 'tasks', 'todos', 'habits', 'habit_completions',
        'flashcards', 'flashcard_notes', 'texts', 'text_line_progress',
        'birthdays', 'vestiaire', 'lists', 'list_items',
        'settings', 'prompts', 'nvidia_usage', 'daily_visits',
        'todo_categories', 'habit_categories', 'vestiaire_categories', 'flashcard_decks',
      ]);
      const reseedData = {};
      const sharingFields = ['shared_id', 'shared_group_id', 'owner_id'];
      let tableCount = 0;
      for (const table of (backup._meta?.tables || [])) {
        if (!driveTables.has(table) || !backup[table]) continue;
        // Strip sharing references and owner_id from items
        reseedData[table] = backup[table].map(row => {
          const clean = { ...row };
          for (const f of sharingFields) delete clean[f];
          return clean;
        });
        tableCount++;
      }
      adapter.reseed(reseedData);
      if (adapter.runPendingMigrations) {
        await adapter.runPendingMigrations();
      }
      // Set category colors from imported data
      setDemoCategoriesFromData(reseedData);
      console.log(`[DeLaClaw] migrated ${tableCount} tables from Supabase to Drive`);
    }
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
  } else {
    adapter = createSupabaseAdapter(url, key);
    state._rawSupabaseAdapter = adapter; // Keep unwrapped for auth calls
    // Test connection with raw adapter BEFORE wrapping with offline cache
    const { error } = await adapter.from('projects').select('id').limit(1);
    if (error) {
      console.warn('[DeLaClaw] supabase projects check failed:', error);
      const msg = String(error.message || '').toLowerCase();
      const details = String(error.details || '').toLowerCase();
      const combined = msg + ' ' + details;
      const status = error.status || error.statusCode;
      const code = String(error.code || '').toUpperCase();
      const isSchemaMissing = status === 404 || code === '42P01' || code.startsWith('PGRST') ||
        combined.includes('does not exist') || combined.includes('schema cache') || combined.includes('could not find') || combined.includes('not found');
      if (isSchemaMissing) {
        const e = new Error('schema_missing');
        e.orig = error;
        throw e;
      }
      const isNetFail = msg.includes('fetch') || msg.includes('network') || msg.includes('cors') || msg.includes('err_failed');
      if (isNetFail && navigator.onLine) {
        const ref = url.replace('https://', '').replace('.supabase.co', '');
        const e = new Error('project_paused');
        e.dashboardUrl = `https://supabase.com/dashboard/project/${ref}`;
        throw e;
      }
      throw new Error('Connection failed');
    }
    const scopeRef = url.replace('https://', '').replace('.supabase.co', '');
    adapter = wrapWithOfflineCache(adapter, `supabase:${scopeRef}`);
  }
  db.setAdapter(adapter);

  // ── Supabase deprecated: show migration modal instead of loading dashboard ──
  if (mode === 'supabase') {
    console.log('[migration] reached deprecation block');
    // Try transparent auth (existing session / magic link callback)
    try {
      console.log('[migration] starting initAuth');
      const { initAuth, claimOwnership } = await import('./auth.js');
      const authResult = await initAuth(state._rawSupabaseAdapter);
      console.log('[migration] initAuth done, user:', authResult.user?.id);
      state.authUser = authResult.user;
      if (authResult.user) {
        await claimOwnership(adapter, authResult.user.id);
      }
    } catch (e) { console.warn('[migration] auth init failed:', e); }

    // Show modal immediately; backup loads in background
    console.log('[migration] calling showSupabaseMigrationModal');
    showSupabaseMigrationModal(generateBackupJSON());
    return false;
  }

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

  // Set Supabase dashboard link (hide — replaced by footer backend badge)
  const dashLink = document.getElementById('supabaseDashLink');
  dashLink.style.display = 'none';

  // Footer backend badge — clickable for backends with a meaningful external URL
  const footerBackend = document.getElementById('footerBackend');
  if (footerBackend && LOGOS[mode]) {
    const logo = LOGOS[mode](14);
    const label = LABELS[mode] || mode;
    let href = null;
    if (mode === 'supabase') {
      // Validate projectRef: alphanumeric only (from _projectRef regex)
      const projectRef = url.replace('https://', '').replace('.supabase.co', '');
      if (/^[a-z0-9]+$/i.test(projectRef)) {
        href = `https://supabase.com/dashboard/project/${projectRef}`;
      }
    } else if (mode === 'googledrive') {
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
    if (href && /^https:\/\/(supabase\.com|drive\.google\.com)\//.test(href)) {
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

  // Supabase sharing init (requires auth + sharing tables ≥ 1.295)
  const dbVerForSharing = parseFloat(state.dbSchemaVersion || '0');
  if (mode === 'supabase' && state.authUser && dbVerForSharing >= 1.295) {
    try {
      const { createSharing } = await import('./sharing.js');
      state.sharing = await createSharing('supabase', {
        adapter,
        getAuthUser: () => state.authUser,
        supabaseUrl: url,
        anonKey: key,
      });
      loadInitialSharing('supabase sharing');
      state.sharing.startPolling();
      state.sharing.onUpdate(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      });
      updateSharingNavVisibility();
    } catch (e) { console.warn('supabase sharing init:', e); state._sharingInitError = e; }
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
    if (f === 'outdated') { const svg = btn.querySelector('svg'); btn.innerHTML = (svg ? svg.outerHTML : '') + ' ' + t('todos.outdated'); }
    else if (todoFilterMap[f]) btn.textContent = t(todoFilterMap[f]);
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
  const setupCloudName = document.getElementById('setupCloudName');
  if (setupCloudName) setupCloudName.textContent = t('setup.cloud_name');
  const setupCloudDesc = document.getElementById('setupCloudDesc');
  if (setupCloudDesc) setupCloudDesc.textContent = t('setup.cloud_desc');
  // setupCloudBadge removed — no longer recommending a single backend
  const setupLocalName = document.getElementById('setupLocalName');
  if (setupLocalName) setupLocalName.textContent = t('setup.local_name');
  const setupLocalDesc = document.getElementById('setupLocalDesc');
  if (setupLocalDesc) setupLocalDesc.textContent = t('setup.local_desc');
  const setupLocalWarn = document.getElementById('setupLocalWarn');
  if (setupLocalWarn) setupLocalWarn.textContent = t('setup.local_warn');
  const setupCloud1T = document.getElementById('setupCloud1Title');
  if (setupCloud1T) setupCloud1T.textContent = t('setup.cloud_1_title');
  const setupCloud1D = document.getElementById('setupCloud1Desc');
  if (setupCloud1D) setupCloud1D.innerHTML = t('setup.cloud_1_desc');
  const _urlLabel = document.getElementById('setupProjectUrlLabel');
  if (_urlLabel) _urlLabel.textContent = t('setup.cloud_1_url_label');
  const _urlHint = document.getElementById('setupProjectUrlHint');
  if (_urlHint) _urlHint.textContent = t('setup.cloud_1_url_hint');
  const _urlErr = document.getElementById('setupProjectUrlError');
  if (_urlErr) _urlErr.textContent = t('setup.cloud_1_url_error');
  const _urlInp = document.getElementById('setupProjectUrl');
  if (_urlInp) _urlInp.placeholder = t('setup.cloud_1_url_placeholder');
  const setupCloud2T = document.getElementById('setupCloud2Title');
  if (setupCloud2T) setupCloud2T.textContent = t('setup.cloud_2_title');
  const setupCloud2D = document.getElementById('setupCloud2Desc');
  if (setupCloud2D) setupCloud2D.innerHTML = t('setup.cloud_2_desc');
  const setupCloud3T = document.getElementById('setupCloud3Title');
  if (setupCloud3T) setupCloud3T.textContent = t('setup.cloud_3_title');
  const setupCloud3D = document.getElementById('setupCloud3Desc');
  if (setupCloud3D) setupCloud3D.innerHTML = t('setup.cloud_3_desc');
  // Re-apply project URL links after translation resets innerHTML
  const _pUrlInp = document.getElementById('setupProjectUrl');
  if (_pUrlInp && _pUrlInp.value.trim()) {
    const _m = _pUrlInp.value.trim().match(/^https?:\/\/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    const _ref = _m ? _m[1] : '_';
    if (setupCloud2D) { const a = setupCloud2D.querySelector('a[href*="supabase.com/dashboard/project/"]'); if (a) a.href = 'https://supabase.com/dashboard/project/' + _ref + '/sql'; }
    if (setupCloud3D) { const a = setupCloud3D.querySelector('a[href*="supabase.com/dashboard/project/"]'); if (a) a.href = 'https://supabase.com/dashboard/project/' + _ref + '/settings/api-keys'; }
  }
  const _sUrlLabel = document.getElementById('setupLoginUrlLabel');
  if (_sUrlLabel) _sUrlLabel.textContent = t('setup.cloud_3_url_label') || 'Project URL';
  const _sKeyLabel = document.getElementById('setupLoginKeyLabel');
  if (_sKeyLabel) _sKeyLabel.textContent = t('setup.cloud_3_key_label') || 'API Key (anon)';
  const _sBtn = document.getElementById('setupLoginBtn');
  if (_sBtn) _sBtn.textContent = t('setup.cloud_3_btn') || 'Connect';
  const _sStayLabel = document.getElementById('setupStayConnectedLabel');
  if (_sStayLabel) _sStayLabel.textContent = t('login.stay_connected') || 'Stay connected';
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
  // Footer
  const dashLink = document.getElementById('supabaseDashLink');
  if (dashLink) dashLink.textContent = t('login.supabase_dashboard') + ' ↗';
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
  const settingsNavAi = document.getElementById('settingsNavAi');
  if (settingsNavAi) settingsNavAi.textContent = t('menu.settings_ai');
  const settingsPaneGeneralTitle = document.getElementById('settingsPaneGeneralTitle');
  if (settingsPaneGeneralTitle) settingsPaneGeneralTitle.textContent = t('menu.settings_general');
  const settingsPaneAiTitle = document.getElementById('settingsPaneAiTitle');
  if (settingsPaneAiTitle) settingsPaneAiTitle.textContent = t('menu.settings_ai');
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
  applyAgentsI18n();
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
  const settingsNvidiaKeyLabel = document.getElementById('settingsNvidiaKeyLabel');
  if (settingsNvidiaKeyLabel) settingsNvidiaKeyLabel.textContent = t('menu.settings_nvidia_key');
  const settingsNvidiaKeyHint = document.getElementById('settingsNvidiaKeyHint');
  if (settingsNvidiaKeyHint) settingsNvidiaKeyHint.textContent = t('menu.settings_nvidia_key_hint');
  const settingsNvidiaModelLabel = document.getElementById('settingsNvidiaModelLabel');
  if (settingsNvidiaModelLabel) settingsNvidiaModelLabel.textContent = t('menu.settings_model');
  const settingsTestLabel = document.getElementById('settingsTestLabel');
  if (settingsTestLabel) settingsTestLabel.textContent = t('menu.settings_test');
  const settingsTestBtnLabel = document.getElementById('settingsTestBtnLabel');
  if (settingsTestBtnLabel) settingsTestBtnLabel.textContent = t('menu.settings_test_btn');
  const settingsUsageLabel = document.getElementById('settingsUsageLabel');
  if (settingsUsageLabel) settingsUsageLabel.textContent = t('menu.settings_usage_label');
  const nvidiaUsageToggleLabel = document.getElementById('nvidiaUsageToggleLabel');
  if (nvidiaUsageToggleLabel) nvidiaUsageToggleLabel.textContent = t('menu.settings_usage_by_model');
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
  // Populate NVIDIA key field
  const inp = document.getElementById('settingsNvidiaKey');
  if (inp) {
    inp.value = state.nvidiaApiKey || '';
    inp.type = 'password';
  }
  // Reset visibility toggle icon
  const toggleBtn = document.getElementById('settingsToggleVis');
  if (toggleBtn) toggleBtn.innerHTML = `<span data-icon="eye" data-size="16"></span>`;
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
  if (paneKey === 'ai') { populateNvidiaModels(); loadNvidiaUsage(); }
  if (paneKey === 'stats') { loadUsageStats(); }
  if (paneKey === 'sharing') { renderSharingPane(); }
  if (paneKey === 'agents') { renderAgentsPane(); }
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
        if (row.key === 'nvidia_api_key') state.nvidiaApiKey = row.value || null;
        if (row.key === 'nvidia_model') state.nvidiaModel = row.value || 'meta/llama-3.1-8b-instruct';
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
    { mode: 'supabase', label: t('login.mode_supabase'), title: 'Supabase' },
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
  urlLabelLink.href = 'https://supabase.com/dashboard/projects';
  urlLabelLink.dataset.tooltip = t('toast.url_tooltip');
  urlLabel.appendChild(urlLabelLink);
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://xyz.supabase.co';

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

  // Dynamic API key link — same behaviour as the gate login form
  const updateKeyLink = () => {
    const v = urlInput.value.trim();
    const m = v.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i) || v.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
    if (m) {
      keyLabelLink.href = `https://supabase.com/dashboard/project/${m[1]}/settings/api-keys`;
    } else {
      keyLabelLink.removeAttribute('href');
    }
  };
  urlInput.addEventListener('input', updateKeyLink);

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
      hintP.textContent = activeMode === 'supabase' ? t('login.hint_supabase') : t('login.hint_local');
      keyDiv.style.display = activeMode === 'local' ? 'none' : '';
      submitBtn.textContent = t('login.connect');
      // Match the gate's label behaviour per mode
      if (activeMode === 'local') {
        urlLabelLink.textContent = t('login.url_label_local');
        urlLabelLink.removeAttribute('href');
        urlInput.placeholder = 'http://localhost:3737';
      } else {
        urlLabelLink.textContent = t('login.url_label');
        urlLabelLink.href = 'https://supabase.com/dashboard/projects';
        urlInput.placeholder = 'https://xyz.supabase.co';
      }
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
    // For Supabase/Local, pre-fill creds so the gate auto-connects on reload
    if (activeMode !== 'googledrive') {
      const url = urlInput.value.trim();
      const key = keyInput.value.trim();
      // sec: reject service_role even here
      if (activeMode === 'supabase' && key && (getSupabaseKeyRole(key)==='service_role' || key.startsWith('sb_secret_'))) {
        showToast(t('login.err_service_role'), 'error');
        return;
      }
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

async function saveNvidiaKey() {
  const inp = document.getElementById('settingsNvidiaKey');
  if (!inp) return;
  const val = inp.value.trim();
  try {
    if (val) {
      // Upsert: try update first, then insert if no rows affected
      const { data, error: upErr } = await state.db.from('settings')
        .update({ value: val, updated_at: new Date().toISOString() })
        .eq('key', 'nvidia_api_key')
        .select();
      if (upErr) throw upErr;
      if (!data || data.length === 0) {
        const { error: insErr } = await state.db.from('settings')
          .insert({ key: 'nvidia_api_key', value: val, updated_at: new Date().toISOString() });
        if (insErr) throw insErr;
      }
      state.nvidiaApiKey = val;
    } else {
      // Delete the key
      await state.db.from('settings').delete().eq('key', 'nvidia_api_key');
      state.nvidiaApiKey = null;
    }
    showToast(t('menu.settings_key_saved'));
  } catch (e) {
    console.error('Failed to save API key:', e);
    showToast(t('menu.settings_key_error'));
  }
}

function toggleNvidiaKeyVisibility() {
  const inp = document.getElementById('settingsNvidiaKey');
  const btn = document.getElementById('settingsToggleVis');
  if (!inp || !btn) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = `<span data-icon="${show ? 'eye-off' : 'eye'}" data-size="16"></span>`;
  hydrateIcons();
}

async function saveNvidiaModel() {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;
  const val = sel.value;
  try {
    const { data } = await state.db.from('settings')
      .update({ value: val, updated_at: new Date().toISOString() })
      .eq('key', 'nvidia_model').select();
    if (!data || data.length === 0) {
      await state.db.from('settings')
        .insert({ key: 'nvidia_model', value: val, updated_at: new Date().toISOString() });
    }
    state.nvidiaModel = val;
  } catch (e) { console.error('Failed to save model:', e); }
}

const NVIDIA_POPULAR_MODELS = [
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-4-maverick-17b-128e-instruct',
  'mistralai/mistral-large-2-instruct',
  'google/gemma-3-27b-it',
  'deepseek-ai/deepseek-v3.2',
  'nvidia/llama-3.1-nemotron-70b-instruct',
];

function renderModelSelect(models, selectedModel) {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;

  const popular = models.filter(id => NVIDIA_POPULAR_MODELS.includes(id));
  const others = models.filter(id => !NVIDIA_POPULAR_MODELS.includes(id));
  const customInList = selectedModel && !models.includes(selectedModel);

  let html = '';
  if (popular.length) {
    html += `<optgroup label="Popular">`;
    html += popular.map(id =>
      `<option value="${esc(id)}"${id === selectedModel ? ' selected' : ''}>${esc(id)}</option>`
    ).join('');
    html += `</optgroup>`;
  }
  if (others.length) {
    html += `<optgroup label="All">`;
    html += others.map(id =>
      `<option value="${esc(id)}"${id === selectedModel ? ' selected' : ''}>${esc(id)}</option>`
    ).join('');
    html += `</optgroup>`;
  }
  if (customInList) {
    html += `<optgroup label="Custom">`;
    html += `<option value="${esc(selectedModel)}" selected>${esc(selectedModel)}</option>`;
    html += `</optgroup>`;
  }
  html += `<option value="__custom">${t('menu.settings_model_custom')}</option>`;
  sel.innerHTML = html;
}

function populateNvidiaModels() {
  const sel = document.getElementById('settingsNvidiaModel');
  if (!sel) return;
  // Render hardcoded fallback first, then fetch live list
  renderModelSelect(NVIDIA_POPULAR_MODELS, state.nvidiaModel);
  fetchNvidiaModelsRpc();
}

async function fetchNvidiaModelsRpc() {
  try {
    const { data, error } = await state.db.rpc('nvidia_list_models');
    if (error || !data?.data) return;
    const chatModels = data.data
      .map(m => m.id)
      .filter(id => /instruct|chat|-it$/i.test(id) && !/guard|safety|embed|retriever/i.test(id))
      .sort((a, b) => {
        const ai = NVIDIA_POPULAR_MODELS.includes(a) ? 0 : 1;
        const bi = NVIDIA_POPULAR_MODELS.includes(b) ? 0 : 1;
        return ai - bi || a.localeCompare(b);
      });
    if (chatModels.length) renderModelSelect(chatModels, state.nvidiaModel);
  } catch (e) { console.warn('Could not fetch NVIDIA models:', e.message); }
}

function handleModelChange() {
  const sel = document.getElementById('settingsNvidiaModel');
  const customRow = document.getElementById('settingsCustomModelRow');
  if (!sel) return;
  if (sel.value === '__custom') {
    if (customRow) customRow.style.display = '';
    document.getElementById('settingsCustomModel')?.focus();
  } else {
    if (customRow) customRow.style.display = 'none';
    saveNvidiaModel();
  }
}

function applyCustomModel() {
  const input = document.getElementById('settingsCustomModel');
  const val = input?.value?.trim();
  if (!val) return;
  state.nvidiaModel = val;
  // Re-render with custom value selected, then save
  const sel = document.getElementById('settingsNvidiaModel');
  const opts = Array.from(sel?.options || []).map(o => o.value).filter(v => v !== '__custom');
  if (!opts.includes(val)) {
    renderModelSelect(opts, val);
  }
  saveNvidiaModel();
  const customRow = document.getElementById('settingsCustomModelRow');
  if (customRow) customRow.style.display = 'none';
}

let _nvidiaAbort = null;

async function testNvidiaApi() {
  const apiKey = state.nvidiaApiKey || document.getElementById('settingsNvidiaKey')?.value?.trim();
  const model = document.getElementById('settingsNvidiaModel')?.value;
  const prompt = document.getElementById('settingsTestPrompt')?.value?.trim();
  const resultEl = document.getElementById('settingsTestResult');
  const btn = document.getElementById('settingsTestBtn');
  if (!resultEl || !btn) return;
  if (!apiKey) {
    resultEl.style.display = 'block';
    resultEl.className = 'settings-test-result error';
    resultEl.textContent = t('menu.settings_test_no_key');
    return;
  }
  if (!prompt) return;

  // If already running, abort
  if (_nvidiaAbort) {
    _nvidiaAbort.abort();
    _nvidiaAbort = null;
    btn.textContent = t('menu.settings_test_btn');
    btn.disabled = false;
    resultEl.className = 'settings-test-result error';
    resultEl.textContent = t('menu.settings_test_cancelled');
    return;
  }

  _nvidiaAbort = new AbortController();
  btn.textContent = t('menu.settings_test_stop');
  btn.disabled = false;
  resultEl.style.display = 'block';
  resultEl.className = 'settings-test-result';
  resultEl.textContent = '';
  try {
    const fetchOpts = (stream) => ({
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.supabaseKey}`,
        'apikey': state.supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_api_key: apiKey, p_model: model, p_prompt: prompt, p_stream: stream }),
      signal: _nvidiaAbort.signal,
    });

    let res = await fetch(`${state.supabaseUrl}/functions/v1/nvidia-chat`, fetchOpts(true));

    // SSE streaming
    if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
      resultEl.className = 'settings-test-result success';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let streamError = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.error) {
                streamError = parsed.error.message || parsed.error.detail || JSON.stringify(parsed.error);
                break;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) { text += delta; resultEl.textContent = text; }
            } catch (_) {}
          }
        }
        if (streamError) break;
      }
      if (streamError) {
        resultEl.className = 'settings-test-result error';
        resultEl.textContent = streamError;
      } else if (!text) {
        resultEl.textContent = '(empty response)';
      }
      loadNvidiaUsage();
      return;
    }

    // Stream failed (model doesn't support it) — retry without streaming
    if (!res.ok) {
      res = await fetch(`${state.supabaseUrl}/functions/v1/nvidia-chat`, fetchOpts(false));
    }

    // Non-streaming JSON response
    const data = await res.json();
    const status = data?.status;
    const body = data?.body;
    if (status && status >= 400) {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = body?.detail || body?.error?.message || `HTTP ${status}`;
    } else {
      resultEl.className = 'settings-test-result success';
      resultEl.textContent = body?.choices?.[0]?.message?.content || JSON.stringify(body);
    }
    loadNvidiaUsage();
  } catch (e) {
    if (e.name === 'AbortError') {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = t('menu.settings_test_cancelled');
    } else {
      resultEl.className = 'settings-test-result error';
      resultEl.textContent = e.message;
    }
  } finally {
    _nvidiaAbort = null;
    btn.textContent = t('menu.settings_test_btn');
    btn.disabled = false;
  }
}

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchSettingsPane = switchSettingsPane;
window.toggleTabConfigItem = toggleTabConfigItem;
window.toggleNvidiaKeyVisibility = toggleNvidiaKeyVisibility;
window.saveNvidiaKey = saveNvidiaKey;
window.saveNvidiaModel = saveNvidiaModel;
window.handleModelChange = handleModelChange;
window.applyCustomModel = applyCustomModel;
window.testNvidiaApi = testNvidiaApi;
window.toggleNvidiaUsageDetail = toggleNvidiaUsageDetail;

// ── Data Backup & Restore ──

const BACKUP_TABLES = [
  // category / deck parents first (items FK into these)
  'todo_categories', 'habit_categories', 'vestiaire_categories', 'flashcard_decks',
  // parent tables
  'projects', 'habits', 'texts', 'lists',
  // child / independent tables
  'todos', 'tasks', 'habit_completions', 'flashcards', 'flashcard_notes',
  'text_line_progress', 'birthdays', 'vestiaire', 'list_items',
  'settings', 'prompts', 'nvidia_usage', 'daily_visits',
  // sharing: owned groups (creator side) — FK order: groups → members → items
  'sharing_groups', 'sharing_members', 'sharing_items',
  // sharing: joined groups (joiner side) + agent access
  'joined_groups', 'agent_grants',
];

async function generateBackupJSON() {
  const backup = { _meta: { version: 1, exported_at: new Date().toISOString(), tables: [] } };
  if (state.supabaseUrl) backup._meta.source_url = state.supabaseUrl;
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
  // Check settings for cached folder ID
  if (state.db.connected) {
    const { data } = await state.db.from('settings').select('value').eq('key', 'drive_backup_folder_id').maybeSingle();
    if (data && data.value) {
      // Verify folder still exists
      const check = await fetch(`https://www.googleapis.com/drive/v3/files/${data.value}?fields=id,trashed`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (check.ok) {
        const f = await check.json();
        if (!f.trashed) return data.value;
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
    const token = await getGoogleAccessToken();
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
    const newUid = state.authUser?.id || null; // for sharing_groups.auth_owner_id rewrite
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
              // sharing_groups uses auth_owner_id instead of owner_id (no trigger)
              if (table === 'sharing_groups' && rest.auth_owner_id != null && newUid) {
                rest.auth_owner_id = newUid;
              }
              // sharing_members: rewrite creator's auth_user_id to new uid
              if (table === 'sharing_members' && rest.role === 'creator' && rest.auth_user_id != null && newUid) {
                rest.auth_user_id = newUid;
              }
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
    // Notify owner if sharing groups were migrated to a different Supabase project
    const hasSharingGroups = backup.sharing_groups && backup.sharing_groups.length > 0;
    const urlChanged = backup._meta.source_url && state.supabaseUrl
      && backup._meta.source_url.replace(/\/+$/, '') !== state.supabaseUrl.replace(/\/+$/, '');
    if (hasSharingGroups && urlChanged) {
      showToast(t('menu.settings_restore_reshare_hint'), 'info', 8000);
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

// ── AI Usage Stats ──

async function loadNvidiaUsage() {
  const container = document.getElementById('nvidiaUsageStats');
  const toggleBtn = document.getElementById('nvidiaUsageToggle');
  const detailEl = document.getElementById('nvidiaUsageDetail');
  if (!container) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await state.db.from('nvidia_usage')
    .select('model,prompt_tokens,completion_tokens,total_tokens,status,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) {
    container.innerHTML = `<span class="nvidia-usage-empty">${t('menu.settings_usage_empty')}</span>`;
    if (toggleBtn) toggleBtn.style.display = 'none';
    if (detailEl) detailEl.style.display = 'none';
    return;
  }

  const totals = { requests: data.length, prompt: 0, completion: 0, total: 0 };
  const byModel = {};
  for (const row of data) {
    totals.prompt += row.prompt_tokens || 0;
    totals.completion += row.completion_tokens || 0;
    totals.total += row.total_tokens || 0;
    const m = row.model || 'unknown';
    if (!byModel[m]) byModel[m] = { requests: 0, prompt: 0, completion: 0, total: 0 };
    byModel[m].requests++;
    byModel[m].prompt += row.prompt_tokens || 0;
    byModel[m].completion += row.completion_tokens || 0;
    byModel[m].total += row.total_tokens || 0;
  }

  container.innerHTML = renderUsageRow(totals);

  const models = Object.keys(byModel).sort((a, b) => byModel[b].total - byModel[a].total);
  if (models.length > 1) {
    if (toggleBtn) toggleBtn.style.display = '';
    if (detailEl) {
      detailEl.innerHTML = models.map(m =>
        `<div class="nvidia-usage-model"><span class="nvidia-usage-model-name">${esc(m)}</span>${renderUsageRow(byModel[m])}</div>`
      ).join('');
    }
  } else if (models.length === 1) {
    if (toggleBtn) toggleBtn.style.display = '';
    if (detailEl) {
      detailEl.innerHTML = `<div class="nvidia-usage-model"><span class="nvidia-usage-model-name">${esc(models[0])}</span></div>`;
    }
  } else {
    if (toggleBtn) toggleBtn.style.display = 'none';
  }
}

function renderUsageRow(s) {
  return `<div class="nvidia-usage-grid">
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.requests}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_requests')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.prompt.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_prompt')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.completion.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_completion')}</span></div>
    <div class="nvidia-usage-cell"><span class="nvidia-usage-val">${s.total.toLocaleString()}</span><span class="nvidia-usage-lbl">${t('menu.settings_usage_total')}</span></div>
  </div>`;
}

function toggleNvidiaUsageDetail() {
  const detailEl = document.getElementById('nvidiaUsageDetail');
  const toggleBtn = document.getElementById('nvidiaUsageToggle');
  if (!detailEl) return;
  const open = detailEl.style.display !== 'none';
  detailEl.style.display = open ? 'none' : '';
  if (toggleBtn) toggleBtn.classList.toggle('open', !open);
}

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
    const bodyKey = state.driveMode ? 'account.confirm_body_drive'
      : state.supabaseUrl ? 'account.confirm_body_supabase'
      : 'account.confirm_body_local';
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
