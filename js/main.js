import { lucideIcon } from './icons.js';
import { initHero, showHero, hideHero, injectGateLogo } from './hero.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import { renderStorm, generateStorm, LOGO_DEFAULTS, animLoading, animLock, animUnlock } from './logo.js';
import { LOGOS, LABELS } from './backend-logos.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY, TAB_VISIBILITY_KEY, TAB_ORDER_KEY } from './state.js';
import db from './db.js';
import { createSupabaseAdapter } from './adapters/supabase.js';
import { createRestAdapter } from './adapters/rest.js';
import { wrapWithOfflineCache } from './adapters/offline-cache.js';

import { esc, showToast, showDeleteConfirm, updateFooterStats, updateTaskListMaxHeight, isEditing, fetchAll, isInstalledPWA, deviceClass, isMobileUA, getSupabaseKeyRole } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, renderAllTasks, loadPrompts } from './projects.js';
import { refreshTodos, renderTodos, getTodoCounts, initTodoModals } from './todos.js';
import { refreshHabits, renderHabits, initHabitModals } from './habits.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';
import { refreshLists, renderLists, initListModals } from './lists.js';
import { updateSharingNavVisibility, renderSharingPane, handleJoinHash, applySettingsI18n as applySharingI18n } from './sharing-ui.js';
import { refreshWelcome, renderWelcome } from './welcome.js';
import { HABIT_CATEGORIES_KEY } from './state.js';
import { APP_VERSION, LATEST_COMPAT, LATEST_COMPAT_DEPREC } from './version.js';
import { SUPABASE_MIGRATIONS } from '../migrations/supabase-migrations.js';

// --- sec-003 envelope decoder (inline, mirrors js/sharing-envelope.js, envelope-only no legacy) ---
function _decodeInviteEnvelopeInline(str) {
  if (!str || typeof str !== 'string') return null;
  if (str.includes(':')) return null;
  if (str.length < 20) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  try {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json);
    if (!obj || obj.v !== 1 || !obj.g || obj.b !== 'supabase') return null;
    return obj;
  } catch { return null; }
}
function _isSupabaseJoinHash(joinHash) {
  return !!_decodeInviteEnvelopeInline(joinHash);
}

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
  'claw_cc_archived_projects',
  'claw_cc_show_archived',
  'claw_cc_ideas',
  'claw_cc_habit_categories',
  'claw_cc_tab_visibility',
  'claw_cc_tab_order',
  'claw_cc_compact_nav',
  'claw_cc_vestiaire_categories',
  'claw_cc_vest_shortnames',
  'claw_flash_shortnames',
  'claw_habit_shortnames',
  'todo_categories',
  'todo_category_colors',
  'todo_category_shortnames',
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

/** Replace demo category keys to match the current demo dataset. */
function setDemoCategoriesFromData(data) {
  const todoCats = [...new Set((data.todos || []).map(t => t.category).filter(c => c && c !== 'General'))];
  const habitCats = [...new Set((data.habits || []).map(h => h.category).filter(c => c && c !== 'General'))];
  const vestCats = [...new Set((data.vestiaire || []).map(v => v.category).filter(Boolean))];
  localStorage.setItem('todo_categories', JSON.stringify(todoCats));
  localStorage.setItem(HABIT_CATEGORIES_KEY, JSON.stringify(habitCats));
  localStorage.setItem('claw_cc_vestiaire_categories', JSON.stringify(vestCats));
  localStorage.setItem('todo_category_colors', '{}');
  localStorage.setItem('todo_category_shortnames', '{}');
  localStorage.setItem('claw_habit_shortnames', '{}');
  localStorage.setItem('claw_cc_vest_shortnames', '{}');
  localStorage.setItem('claw_flash_shortnames', '{}');
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
  const submitBtn = document.querySelector('#loginForm button[type="submit"]');

  // All fields stay in flow (visibility:hidden, not display:none)
  // so .gate-box height is constant across modes.
  if (mode === 'demo') {
    if (keyField) keyField.style.visibility = 'hidden';
    if (urlField) urlField.style.visibility = 'hidden';
    if (urlLabel) urlLabel.style.visibility = 'hidden';
    if (hintEl) hintEl.textContent = t('login.hint_demo');
    if (submitBtn) submitBtn.textContent = t('login.btn_demo');
  } else if (mode === 'googledrive') {
    if (keyField) keyField.style.visibility = 'hidden';
    if (urlField) urlField.style.visibility = 'hidden';
    if (urlLabel) urlLabel.style.visibility = 'hidden';
    if (hintEl) hintEl.textContent = t('login.hint_googledrive');
    if (submitBtn) submitBtn.textContent = t('login.btn_googledrive');
  } else if (mode === 'local') {
    if (keyField) keyField.style.visibility = 'hidden';
    if (urlField) { urlField.style.visibility = ''; urlField.placeholder = 'http://localhost:3737'; }
    if (urlLabel) urlLabel.style.visibility = '';
    if (urlLabelLink) { urlLabelLink.textContent = t('login.url_label_local'); urlLabelLink.removeAttribute('href'); }
    if (hintEl) hintEl.textContent = t('login.hint_local');
    if (submitBtn) submitBtn.textContent = t('login.connect');
  } else {
    if (keyField) keyField.style.visibility = '';
    if (urlField) { urlField.style.visibility = ''; urlField.placeholder = 'https://xyz.supabase.co'; }
    if (urlLabel) urlLabel.style.visibility = '';
    if (urlLabelLink) { urlLabelLink.textContent = t('login.url_label'); urlLabelLink.href = 'https://supabase.com/dashboard/projects'; urlLabelLink.dataset.tooltip = t('toast.url_tooltip'); }
    if (hintEl) hintEl.textContent = t('login.hint_supabase');
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
  const isJoinLink = window.location.hash.startsWith('#join=');
  if (window.location.hash !== '#setup' && !signupMode && !isJoinLink) {
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
    document.getElementById('gateGuideLink').style.display = '';
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
    document.getElementById('gateGuideLink').style.display = '';
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
    const siteOrigin = location.origin;
    content.innerHTML = `
      <div class="auth-icon">${lucideIcon('lock', 28)}</div>
      <h3>${t('auth.sign_in')}</h3>
      <p class="auth-hint">${t('auth.sign_in_hint_mandatory')}</p>

      <div class="auth-step" id="authStep1">
        <div class="auth-step-header">
          <span class="auth-step-num">1</span>
          <span>${t('auth.step_site_url')}</span>
        </div>
        <p class="auth-step-detail">${t('auth.step_site_url_detail')}</p>
        <div class="auth-site-url-value">
          <code id="authSiteUrlValue">${esc(siteOrigin)}</code>
          <button class="auth-copy-url-btn" id="authCopyUrlBtn" title="${t('sharing.copy')}">${lucideIcon('copy', 14)}</button>
        </div>
        <a class="auth-config-link" href="${authConfigUrl}" target="_blank" rel="noopener">${lucideIcon('external-link', 14)} ${t('auth.open_supabase_settings')}</a>
        <label class="auth-toggle-label" id="authConfirmLabel">
          <input type="checkbox" id="authSiteUrlConfirm">
          <span>${t('auth.site_url_confirmed')}</span>
        </label>
      </div>

      <div class="auth-step auth-step-locked" id="authStep2">
        <div class="auth-step-header">
          <span class="auth-step-num">2</span>
          <span>${t('auth.step_magic_link')}</span>
        </div>
        <div class="auth-step2-body" id="authStep2Body" style="display:none">
          <input type="email" id="authEmail" placeholder="${t('auth.email_placeholder')}" autocomplete="email">
          <div class="auth-error" id="authError" style="display:none"></div>
          <button class="auth-send-btn" id="authSendBtn">${t('auth.send_magic_link')}</button>
        </div>
      </div>
    `;
    const confirmBox = content.querySelector('#authSiteUrlConfirm');
    const step2 = content.querySelector('#authStep2');
    const step2Body = content.querySelector('#authStep2Body');
    const emailEl = content.querySelector('#authEmail');
    const errEl = content.querySelector('#authError');
    const sendBtn = content.querySelector('#authSendBtn');
    const copyUrlBtn = content.querySelector('#authCopyUrlBtn');

    copyUrlBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(siteOrigin).then(() => showToast(t('common.copied'), 'success'));
    });

    confirmBox.addEventListener('change', () => {
      if (confirmBox.checked) {
        step2.classList.remove('auth-step-locked');
        step2Body.style.display = '';
        emailEl.focus();
      } else {
        step2.classList.add('auth-step-locked');
        step2Body.style.display = 'none';
      }
    });

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
        const { sendMagicLink } = await import('./auth.js');
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
    content.innerHTML = `
      <div class="auth-icon">${lucideIcon('mail', 28)}</div>
      <h3>${t('auth.check_inbox')}</h3>
      <p class="auth-hint">${t('auth.check_inbox_hint', esc(email))}</p>
      <div class="auth-otp-box" style="margin:16px 0; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--bg-subtle,#f8f9fa);">
        <p class="auth-hint" style="font-size:0.9em; margin-bottom:8px;">${t('auth.otp_hint')}</p>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" id="authOtpInput" placeholder="${t('auth.otp_placeholder')}" inputmode="text" autocomplete="one-time-code" maxlength="500" style="flex:1; padding:8px 10px; font-size:16px; letter-spacing:0.1em; text-align:center; border:1px solid var(--border); border-radius:6px;">
          <button class="auth-send-btn" id="authVerifyBtn" style="white-space:nowrap;">${t('auth.verify_code')}</button>
        </div>
        <div class="auth-error" id="authOtpError" style="display:none; margin-top:8px;"></div>
      </div>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="auth-send-btn" id="authResendBtn" style="flex:0;">${t('auth.resend')}</button>
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
        if (otpErrEl) { otpErrEl.textContent = t('auth.otp_invalid') || 'Enter the 6-digit code from your email.'; otpErrEl.style.display = ''; }
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
          otpErrEl.textContent = isExpired ? (t('auth.otp_expired') || 'Code expired — resend a new code.') : (t('auth.otp_invalid') || 'Invalid code. Check the 6-digit code from the email.');
          otpErrEl.style.display = '';
          verifyBtn.disabled = false;
          verifyBtn.textContent = t('auth.verify_code') || 'Verify code';
          return;
        }
        // Success — close prompt, session will be handled by onAuthStateChange + init logic
        statusEl.textContent = t('auth.verified') || 'Verified! Signing you in...';
        statusEl.style.display = '';
        overlay.classList.remove('visible');
        // Force reload to pick up session (initAuth runs on next connect)
        window.location.reload();
      } catch (e) {
        console.warn('otp verify failed', e);
        if (otpErrEl) { otpErrEl.textContent = t('auth.error'); otpErrEl.style.display = ''; }
        verifyBtn.disabled = false;
        verifyBtn.textContent = t('auth.verify_code') || 'Verify code';
      }
    }

    verifyBtn.addEventListener('click', doVerify);
    otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
    // Auto-focus OTP for PWA users
    setTimeout(() => { try { otpInput.focus(); } catch {} }, 100);

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

/** Sign out from Settings > Sharing pane. */
async function signOutFromSharing() {
  try {
    const { signOut } = await import('./auth.js');
    await signOut(state._rawSupabaseAdapter);
  } catch { /* ignore */ }
  state.authUser = null;
  if (state.sharing) { try { state.sharing.destroy(); } catch {} }
  state.sharing = null;
  location.reload();
}
window.signOutFromSharing = signOutFromSharing;

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

function getSupabaseProjectRef(url) {
  if (!url) return null;
  const m1 = url.match(/https?:\/\/([a-z0-9]{20,})\.supabase\.co/i);
  if (m1) return m1[1];
  const m2 = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (m2) return m2[1];
  return null;
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
    } else if (e.message === 'popup_failed_to_open') {
      err.textContent = t('login.drive_popup_blocked') || 'Pop-up blocked by your browser — please try again.';
    } else {
      err.textContent = t('toast.connection_failed');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Wrap all save/add/submit actions with guard() to prevent double-fire
  const guardedNames = [
    'saveNewBirthday', 'saveEditBirthday',
    'saveNewDraft', 'saveEditedProposal', 'saveNewFlashcard', 'saveEditFlashcard',
    'saveNewText', 'saveEditText', 'submitFeedback', 'submitTextReview',
    'saveNewHabit', 'saveEditHabit', 'saveHabitCompletion', 'addHabitFromInput',
    'saveNewHabitCategory', 'saveEditHabitCategory',
    'saveNewList', 'saveEditList',
    'addTask', 'saveNewProject', 'saveEditProject', 'submitRevision',
    'saveNewCategory', 'saveEditCategory', 'submitSnooze', 'addTodoToCategory',
    'saveNewVestiaire', 'saveEditVestiaire',
    'saveNewVestiaireCategory', 'saveEditVestiaireCategory',
    'executeDeleteConfirm',
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
// UNLOCK & INIT APP
// ===================================================================
async function connect(url, key, mode = 'supabase', skipDemoChooser = false, { silentAuth = false } = {}) {
  state.supabaseUrl = url;
  state.supabaseKey = key;

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

  // Initialize Supabase Auth (check for existing session / magic link callback)
  if (mode === 'supabase') {
    try {
      const { initAuth, claimOwnership } = await import('./auth.js');
      const authResult = await initAuth(state._rawSupabaseAdapter);
      state.authUser = authResult.user;
      if (authResult.user) {
        await claimOwnership(adapter, authResult.user.id);
      }
    } catch (e) { console.warn('auth init:', e); }
    // Mandatory auth since 1.300 owner-only: show prompt if not signed in
    if (!state.authUser) {
      showAuthPrompt(state._rawSupabaseAdapter, url, key);
    }
    // Listen for late auth events (magic link callback may resolve after getSession)
    try {
      const { onAuthStateChange, claimOwnership: claimOwn } = await import('./auth.js');
      onAuthStateChange(state._rawSupabaseAdapter, async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user && !state.authUser) {
          state.authUser = session.user;
          // Claim unclaimed rows
          try { await claimOwn(adapter, session.user.id); } catch {}
          // Close auth prompt if open
          const overlay = document.getElementById('authPromptOverlay');
          if (overlay) overlay.classList.remove('visible');
          // Initialize sharing if not already done
          const ver = parseFloat(state.dbSchemaVersion || '0');
          if (!state.sharing && ver >= 1.295) {
            try {
              const { createSharing } = await import('./sharing.js');
              state.sharing = await createSharing('supabase', {
                adapter,
                getAuthUser: () => state.authUser,
                supabaseUrl: url,
                anonKey: key,
              });
              state.sharing.loadAll().then(() => {
                document.dispatchEvent(new CustomEvent('sharing-changed'));
              }).catch(e => console.warn('sharing loadAll:', e));
              state.sharing.startPolling();
              state.sharing.onUpdate(() => {
                document.dispatchEvent(new CustomEvent('sharing-changed'));
              });
            } catch (e) { console.warn('late sharing init:', e); }
          }
          updateSharingNavVisibility();
        }
      });
    } catch {}
  }

  // Flush pending Drive saves and stop polling on page close
  if (mode === 'googledrive' && adapter.forceSave) {
    window.addEventListener('beforeunload', () => {
      // Force-save first, then clean up — destroy() clears timers
      adapter.forceSave().catch(() => {});
      if (adapter.destroy) adapter.destroy();
    });
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
  initProjectDragDrop();
  updateArchiveToggleBtn();
  renderArchivedProjects();

  // Restore view early (before async refreshes) to avoid flash
  applyTabVisibility();
  const validViews = ['welcome', 'projects', 'todos', 'habits', 'birthdays', 'vestiaire', 'flashcards'];
  const rawHash = location.hash.replace('#', '');
  const hashView = validViews.includes(rawHash) ? rawHash : null;
  let savedView = hashView || localStorage.getItem(CURRENT_VIEW_KEY) || 'welcome';
  if (!isTabVisible(savedView)) {
    const firstVisible = getVisibleTabs()[0];
    savedView = firstVisible ? firstVisible.key : 'welcome';
  }
  switchView(savedView);

  // Listen for back/forward navigation
  window.addEventListener('hashchange', () => {
    // Handle #join= invite links while app is running
    if (location.hash.startsWith('#join=') && state.sharing) {
      const joinVal = location.hash.slice(6);
      history.replaceState(null, '', location.pathname + location.search);
      if (joinVal) {
        // Supabase join: strip "supabase:" prefix before passing to handler (legacy)
        // New envelope has no prefix — pass as-is
        if (joinVal.startsWith('supabase:')) {
          handleJoinHash(joinVal.slice(9));
        } else {
          handleJoinHash(joinVal);
        }
      }
      return;
    }
    const raw = location.hash.replace('#', '');
    const h = validViews.includes(raw) ? raw : 'welcome';
    if (h !== state.currentView) switchView(h);
  });

  await refreshAll();

  // Load user settings from DB
  await loadSettings();
  checkSchemaVersion();
  recordDailyVisit();

  // Clean up any legacy localStorage ideas (one-time)
  localStorage.removeItem(IDEAS_KEY);

  // Realtime subscription (skip for demo/googledrive — no Postgres backend)
  if (mode !== 'demo' && mode !== 'googledrive') {
    state.db.channel('tasks-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => { if (!isEditing()) { refreshAll().then(() => markLastUpdated()); } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, async () => { if (isEditing()) return; await loadProjects(); buildProjectCards(); initProjectDragDrop(); await refreshAll(); markLastUpdated(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts' }, () => loadPrompts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, () => { if (!isEditing()) { refreshTodos().then(() => markLastUpdated()); } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'habits' }, () => refreshHabits().then(() => markLastUpdated()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'habit_completions' }, () => refreshHabits().then(() => markLastUpdated()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'birthdays' }, () => refreshBirthdays().then(() => markLastUpdated()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vestiaire' }, () => refreshVestiaire().then(() => markLastUpdated()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcards' }, () => refreshFlashcards().then(() => markLastUpdated()))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'flashcard_notes' }, () => refreshFlashcards().then(() => markLastUpdated()))
      .subscribe();
  }

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
      state.sharing.loadAll().then(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      }).catch(e => console.warn('sharing loadAll:', e));
      state.sharing.startPolling();
      state.sharing.onUpdate(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      });
      updateSharingNavVisibility();

      // Handle #join=<folderId> invite link
      if (location.hash.startsWith('#join=')) {
        const joinFolderId = location.hash.slice(6);
        history.replaceState(null, '', location.pathname + location.search);
        if (joinFolderId) {
          // Wait for loadAll to finish before joining
          state.sharing.loadAll().then(() => {
            handleJoinHash(joinFolderId);
          }).catch(e => console.warn('sharing join after load:', e));
        }
      }
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
      state.sharing.loadAll().then(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      }).catch(e => console.warn('supabase sharing loadAll:', e));
      state.sharing.startPolling();
      state.sharing.onUpdate(() => {
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      });
      updateSharingNavVisibility();
    } catch (e) { console.warn('supabase sharing init:', e); state._sharingInitError = e; }
  }

  // Handle #join= invite links (both Drive and Supabase)
  if (location.hash.startsWith('#join=') && !state.sharing) {
    const joinHash = location.hash.slice(6);
    if (_isSupabaseJoinHash(joinHash) && mode !== 'googledrive') {
      try {
        const { createSharing } = await import('./sharing.js');
        state.sharing = await createSharing('supabase', {
          adapter,
          getAuthUser: () => state.authUser || null,
          supabaseUrl: url,
          anonKey: key,
        });
        state.sharing.loadAll().catch(() => {});
        history.replaceState(null, '', location.pathname + location.search);
        handleJoinHash(joinHash);
      } catch (e) { console.warn('sharing join init:', e); }
    }
  }

  // Always update sharing nav visibility (even if sharing init failed or was skipped)
  updateSharingNavVisibility();

  // Initialize TODOs
  initTodoModals();
  await refreshTodos();

  // Initialize Habits
  initHabitModals();
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
  await refreshLists();

  // Re-render Welcome now that all data (birthdays, habits, flashcards…) is loaded.
  // The initial switchView() call above rendered Welcome before async data was ready.
  if (state.currentView === 'welcome') {
    await refreshWelcome();
    renderWelcome();
  }

  markLastUpdated();

  // Listen for sharing updates (Drive sharing module polls and fires sharing-changed)
  document.addEventListener('sharing-changed', () => {
    refreshTodos().then(renderTodos);
    refreshHabits().then(renderHabits);
    refreshLists().then(renderLists);
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
  startOwnBtn.addEventListener('click', () => showSignupOverlay());

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
  // Re-render schema banner in new language (if visible)
  checkSchemaVersion();
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
    const iconOnlyThreshold = 60;
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
  try {
    const raw = localStorage.getItem(TAB_VISIBILITY_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveTabVisibility(vis) {
  localStorage.setItem(TAB_VISIBILITY_KEY, JSON.stringify(vis));
}

function isTabVisible(key) {
  const vis = getTabVisibility();
  if (!vis) return true; // all visible by default
  return vis[key] !== false;
}

// ── Tab Order ──
function getTabOrder() {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveTabOrder(order) {
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
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

function openSettings() {
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
  // Reset to first pane
  switchSettingsPane('general');
  // Init theme toggle state
  updateMenuThemeItem();
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

async function loadSettings() {
  try {
    const { data, error } = await state.db.from('settings').select('key,value');
    if (error) { console.warn('Settings table not available:', error.message); return; }
    if (data) {
      for (const row of data) {
        if (row.key === 'nvidia_api_key') state.nvidiaApiKey = row.value || null;
        if (row.key === 'nvidia_model') state.nvidiaModel = row.value || 'meta/llama-3.1-8b-instruct';
        if (row.key === 'schema_version') state.dbSchemaVersion = row.value || '0.00';
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
    await state.db.from('daily_visits').upsert({ visit_date: today }, { onConflict: 'visit_date' });
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

/** Compare two version strings "X.Y". Returns -1, 0, or 1. */
function cmpVer(a, b) {
  const [aMaj, aMin] = a.split('.').map(Number);
  const [bMaj, bMin] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  return 0;
}

/** Collect pending migration SQL from dbVer up to LATEST_COMPAT. */
function getPendingMigrationSQL(dbVer) {
  const versions = Object.keys(SUPABASE_MIGRATIONS)
    .filter(v => cmpVer(v, dbVer) > 0 && cmpVer(v, LATEST_COMPAT) <= 0)
    .sort((a, b) => cmpVer(a, b));
  if (!versions.length) return null;
  const sql = versions.map(v => SUPABASE_MIGRATIONS[v]).join('\n\n');
  return sql + "\n\n-- Refresh PostgREST schema cache so new columns are visible immediately\nNOTIFY pgrst, 'reload schema';";
}

function checkSchemaVersion() {
  if (state.demoMode || state.driveMode || !state.db?.connected) {
    document.getElementById('schema-banner')?.remove();
    return;
  }
  const dbVer = state.dbSchemaVersion || '0.00';
  if (cmpVer(dbVer, LATEST_COMPAT) >= 0) {
    dismissSchemaBanner();
    return;
  }

  document.getElementById('schema-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'schema-banner';

  const isCritical = cmpVer(dbVer, LATEST_COMPAT_DEPREC) < 0;

  // Non-critical migration banners: hide on phone (Supabase SQL Editor is not phone-friendly)
  if (!isCritical && deviceClass() === 'phone') {
    dismissSchemaBanner();
    return;
  }

  banner.className = isCritical ? 'schema-banner schema-banner-critical' : 'schema-banner';

  const icon = lucideIcon(isCritical ? 'alert-octagon' : 'alert-triangle', 16);
  const label = isCritical
    ? t('schema.banner_critical', { dbVer, latest: LATEST_COMPAT })
    : t('schema.banner_warning', { dbVer, latest: LATEST_COMPAT });

  const sql = getPendingMigrationSQL(dbVer);
  const updateBtn = sql
    ? `<button data-action="show-migration-modal">${esc(t('schema.how_to_update'))}</button>`
    : '';
  banner.innerHTML = `${icon}<span>${label}</span>${updateBtn}<button data-action="dismiss-schema-banner">${esc(t('schema.dismiss'))}</button>`;
  document.body.prepend(banner);
  // Measure actual banner height and expose as CSS variable (handles multi-line text on mobile)
  const updateSchemaH = () => {
    if (banner.isConnected) document.body.style.setProperty('--schema-banner-h', banner.offsetHeight + 'px');
  };
  requestAnimationFrame(updateSchemaH);
  const ro = new ResizeObserver(updateSchemaH);
  ro.observe(banner);
  banner._schemaRO = ro;
}

/** Render two version strings with differing characters highlighted. */
function highlightVersionDiff(dbVer, latest) {
  function mark(ver, other) {
    let html = 'v';
    for (let i = 0; i < ver.length; i++) {
      if (i < other.length && ver[i] === other[i]) {
        html += esc(ver[i]);
      } else {
        html += `<span class="ver-diff">${esc(ver[i])}</span>`;
      }
    }
    return html;
  }
  return { db: mark(dbVer, latest), app: mark(latest, dbVer) };
}

function showMigrationModal() {
  const dbVer = state.dbSchemaVersion || '0.00';
  const sql = getPendingMigrationSQL(dbVer);
  if (!sql) return;

  // Remove existing modal if any
  document.getElementById('migrationModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'migrationModal';
  overlay.className = 'modal-overlay visible';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeMigrationModal(); });

  const projectRef = state.supabaseUrl?.replace('https://', '').replace('.supabase.co', '') || '_';
  const sqlEditorUrl = `https://supabase.com/dashboard/project/${projectRef}/sql/new?skip=true`;

  // Build hint with highlighted version diffs
  const verHL = highlightVersionDiff(dbVer, LATEST_COMPAT);
  const hintTemplate = t('schema.modal_hint', { dbVer: '{{DB}}', latest: '{{APP}}' });
  const hintHTML = esc(hintTemplate).replace('{{DB}}', verHL.db).replace('{{APP}}', verHL.app);

  overlay.innerHTML = `<div class="modal migration-modal">
    <h2>${LOGOS.supabase(18)} ${esc(t('schema.modal_title'))}</h2>
    <p class="migration-hint">${hintHTML}</p>
    <ol class="migration-steps">
      <li>${t('schema.step_1')}
        <div class="migration-sql-wrap">
          <div class="migration-sql-header">
            <span>SQL</span>
            <button class="migration-copy-btn" id="migrationCopyBtn">${lucideIcon('copy', 14)} ${esc(t('schema.copy'))}</button>
          </div>
          <pre class="migration-sql-code" id="migrationSqlCode">${esc(sql)}</pre>
        </div>
      </li>
      <li>${t('schema.step_2', { url: sqlEditorUrl })}</li>
      <li>${t('schema.step_3')}</li>
    </ol>
    <div class="migration-actions">
      <button class="migration-check-btn" id="migrationCheckBtn" data-action="check-migration-status">${lucideIcon('refresh-cw', 14)} ${esc(t('schema.check_migration'))}</button>
      <button class="migration-close-btn" data-action="close-migration-modal">${esc(t('schema.close'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Wire copy button
  document.getElementById('migrationCopyBtn').addEventListener('click', async () => {
    const code = document.getElementById('migrationSqlCode')?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      const btn = document.getElementById('migrationCopyBtn');
      btn.innerHTML = `${lucideIcon('check', 14)} ${esc(t('schema.copied'))}`;
      setTimeout(() => { btn.innerHTML = `${lucideIcon('copy', 14)} ${esc(t('schema.copy'))}`; }, 2000);
    } catch { showToast(t('schema.copy_fallback')); }
  });
}

/** Re-fetch schema_version from DB and report whether migration succeeded. */
async function checkMigrationStatus() {
  const btn = document.getElementById('migrationCheckBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = `${lucideIcon('loader', 14)} ${esc(t('common.loading'))}`;
  try {
    const { data } = await state.db.from('settings').select('value').eq('key', 'schema_version').single();
    const newVer = data?.value || '0.00';
    state.dbSchemaVersion = newVer;
    if (cmpVer(newVer, LATEST_COMPAT) >= 0) {
      btn.innerHTML = `${lucideIcon('check-circle', 14)} ${esc(t('schema.check_success', { ver: newVer }))}`;
      btn.classList.add('migration-check-ok');
      // Dismiss banner after short delay, refresh footer & trigger auth
      setTimeout(() => {
        closeMigrationModal();
        checkSchemaVersion();
        markLastUpdated();
        // Mandatory auth since 1.300 — show prompt if not signed in
        if (getSelectedMode() === 'supabase' && !state.authUser) {
          showAuthPrompt(state._rawSupabaseAdapter);
        }
      }, 1500);
    } else {
      btn.innerHTML = `${lucideIcon('alert-triangle', 14)} ${esc(t('schema.check_still_old', { ver: newVer }))}`;
      btn.classList.add('migration-check-fail');
      setTimeout(() => {
        btn.classList.remove('migration-check-fail');
        btn.disabled = false;
        btn.innerHTML = `${lucideIcon('refresh-cw', 14)} ${esc(t('schema.check_migration'))}`;
      }, 3000);
    }
  } catch {
    btn.disabled = false;
    btn.innerHTML = `${lucideIcon('refresh-cw', 14)} ${esc(t('schema.check_migration'))}`;
    showToast(t('schema.check_error'), 'error');
  }
}

function closeMigrationModal() {
  document.getElementById('migrationModal')?.remove();
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
    { key: 'compare.setup', vals: ['compare.setup_drive', 'compare.setup_supa', 'compare.setup_local'] },
    { key: 'compare.multi_device', vals: [check + ' ' + esc(t('compare.polling')), check + ' ' + esc(t('compare.live')), cross], raw: true },
    { key: 'compare.offline', vals: [cross, cross, check], raw: true },
    { key: 'compare.data_location', vals: ['compare.loc_drive', 'compare.loc_supa', 'compare.loc_local'] },
    { key: 'compare.storage', vals: ['compare.sto_drive', 'compare.sto_supa', 'compare.sto_local'] },
    { key: 'compare.cost', vals: ['compare.free', 'compare.free', 'compare.free'] },
  ];

  const backends = ['googledrive', 'supabase', 'local'];
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
  guideLink.href = '#';;
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
  // parent tables first (import order matters for FK)
  'projects', 'habits', 'texts', 'lists',
  // child / independent tables
  'todos', 'tasks', 'habit_completions', 'flashcards', 'flashcard_notes',
  'text_line_progress', 'birthdays', 'vestiaire', 'list_items',
  'settings', 'prompts', 'nvidia_usage', 'daily_visits',
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
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function getGoogleAccessToken() {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined' || !google.accounts) {
      reject(new Error('Google Identity Services not loaded'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
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
    showDeleteConfirm(
      t('menu.settings_restore'),
      t('menu.settings_restore_confirm'),
      () => performImport(file),
      null,
      {
        btnText: t('menu.settings_restore') || 'Restore',
        iconSvg: '<svg class="delete-confirm-icon-svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
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
    // Delete in reverse order (children before parents)
    const tables = [...(backup._meta.tables || [])].reverse();
    const totalSteps = tables.length + (backup._meta.tables || []).length;
    let step = 0;
    for (const table of tables) {
      showProgress(t('menu.settings_restore_clearing', table), ++step, totalSteps);
      try {
        const pk = (table === 'settings' || table === 'prompts') ? 'key' : 'id';
        await state.db.from(table).delete().neq(pk, '___nonexistent___');
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
          const batch = rows.slice(i, i + 100);
          const { error } = await state.db.from(table).insert(batch);
          if (error) { console.warn(`Insert into ${table} batch ${i}:`, error.message); }
        }
        totalRows += rows.length;
      } catch (e) { console.warn(`Failed to restore ${table}:`, e.message); }
    }
    hideProgress();
    showToast(t('menu.settings_restore_done', totalRows));
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
      setDemoCategoriesFromData(reseedData);
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

function switchView(view) {
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
  // Sync URL hash (no reload) — but preserve #join= invite links
  const newHash = '#' + view;
  if (location.hash !== newHash && !location.hash.startsWith('#join=')) history.replaceState(null, '', newHash);
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
        input.dispatchEvent(new Event('input'));
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
function clearPageSearch(btn) {
  const input = btn.closest('.search-input-wrap').querySelector('.page-search');
  if (input) {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
}

window.toggleTheme = toggleTheme;
window.disconnect = disconnect;
window.toggleSearch = toggleSearch;
window.clearPageSearch = clearPageSearch;
window.dismissSchemaBanner = dismissSchemaBanner;
window.showMigrationModal = showMigrationModal;
window.closeMigrationModal = closeMigrationModal;
window.checkMigrationStatus = checkMigrationStatus;
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
