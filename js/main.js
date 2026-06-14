import { lucideIcon } from './icons.js';
import { initHero, showHero, hideHero, injectGateLogo } from './hero.js';
import { t, getLang, setLang, nextLang } from './i18n.js';
import { renderStorm, LOGO_DEFAULTS, animLoading, animLock, animUnlock } from './logo.js';
import state, { IDEAS_KEY, THEME_KEY, CURRENT_VIEW_KEY, STAY_CONNECTED_KEY, TAB_VISIBILITY_KEY, TAB_ORDER_KEY } from './supabase.js';
import db from './db.js';
import { createSupabaseAdapter } from './adapters/supabase.js';
import { createRestAdapter } from './adapters/rest.js';
import { wrapWithOfflineCache } from './adapters/offline-cache.js';

import { esc, showToast, updateFooterStats, updateTaskListMaxHeight, isEditing } from './utils.js';
import { loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
         renderArchivedProjects, refreshAll, renderAllTasks, loadPrompts } from './projects.js';
import { refreshTodos, renderTodos, getTodoCounts, initTodoModals } from './todos.js';
import { refreshHabits, renderHabits, initHabitModals } from './habits.js';
import { refreshBirthdays, renderBirthdays, initBirthdayModals } from './birthdays.js';
import { refreshVestiaire, renderVestiaire, initVestiaireModals } from './vestiaire.js';
import { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts } from './flashcards.js';
import { refreshLists, renderLists, initListModals } from './lists.js';
import { refreshWelcome, renderWelcome } from './welcome.js';
import { HABIT_CATEGORIES_KEY } from './supabase.js';
import { APP_VERSION, LATEST_COMPAT, LATEST_COMPAT_DEPREC } from './version.js';

// ===================================================================
// BACKEND-SCOPED localStorage — isolate per-backend settings so switching
// between Supabase, Local, and Demo never leaks data across modes.
// Keys listed here are saved/restored under `scope:{mode}:{key}`.
// Global keys (STAY_CONNECTED_KEY, cc-lang) are never scoped.
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
    if (urlLabelLink) { urlLabelLink.textContent = t('login.url_label'); urlLabelLink.href = 'https://supabase.com/dashboard/projects'; }
    if (hintEl) hintEl.textContent = t('login.hint_supabase');
    if (submitBtn) submitBtn.textContent = t('login.connect');
  }
}

// ===================================================================
// GATE LOGIC
// ===================================================================
function initGate() {
  // Wire up backend picker
  document.querySelectorAll('.backend-option').forEach(btn => {
    btn.addEventListener('click', () => switchBackendMode(btn.dataset.mode));
  });
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
    switchBackendMode(saved.mode || 'supabase');
    // Inject static logo (hero is skipped)
    injectGateLogo();
    // Show a brief connecting message, then auto-connect
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('loginError').textContent = t('toast.reconnecting');
    document.getElementById('username').value = saved.url;
    document.getElementById('password').value = saved.key;
    autoConnect(saved.url, saved.key, saved.mode);
    return;
  }
  // Set login hash (user is on the login page)
  history.replaceState(null, '', '#login');
  showHero();
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('username').focus();
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
    await connect(url, key, mode, /* skipDemoChooser */ true);
  } catch (e) {
    // Stored credentials are stale — clear them and show the form
    clearStayConnectedCreds();
    showHero();
    document.getElementById('loginError').textContent = t('toast.session_expired');
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('username').focus();
  }
}

function getStayConnectedCreds() {
  try {
    const raw = localStorage.getItem(STAY_CONNECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.mode === 'demo') return parsed;
    if (parsed && parsed.url && (parsed.key || parsed.mode === 'local')) return parsed;
    return null;
  } catch { return null; }
}

function saveStayConnectedCreds(url, key, mode) {
  localStorage.setItem(STAY_CONNECTED_KEY, JSON.stringify({ url, key, mode: mode || 'supabase' }));
}

function clearStayConnectedCreds() {
  localStorage.removeItem(STAY_CONNECTED_KEY);
}

function disconnect() {
  clearStayConnectedCreds();
  location.reload();
}

// Normalize Supabase dashboard URLs to API base URLs
function normalizeSupabaseUrl(raw) {
  const dm = raw.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dm) return `https://${dm[1]}.supabase.co`;
  return raw;
}

async function doLogin() {
  const url = normalizeSupabaseUrl(document.getElementById('username').value.trim());
  const key = document.getElementById('password').value.trim();
  const stayConnected = document.getElementById('stayConnected').checked;
  const err = document.getElementById('loginError');
  const mode = getSelectedMode();
  if (mode !== 'demo' && (!url || (!key && mode !== 'local'))) { err.textContent = t('toast.enter_name'); return; }
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
    if (e.message === 'project_paused') {
      err.innerHTML = `${t('toast.project_paused')} <a href="${e.dashboardUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;">Check on Supabase ↗</a>`;
    } else {
      err.textContent = t('toast.connection_failed');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
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

  function showGuide() {
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
    const cardCloud = document.getElementById('setupPathCloud');
    const cardLocal = document.getElementById('setupPathLocal');
    if (path === 'cloud') {
      cloud.style.display = ''; local.style.display = 'none';
      cardCloud.classList.add('active'); cardLocal.classList.remove('active');
    } else {
      local.style.display = ''; cloud.style.display = 'none';
      cardLocal.classList.add('active'); cardCloud.classList.remove('active');
    }
  }

  if (guideLink) guideLink.addEventListener('click', e => { e.preventDefault(); showGuide(); });
  if (setupBack) setupBack.addEventListener('click', hideGuide);
  if (setupCloudDone) setupCloudDone.addEventListener('click', hideGuide);
  if (setupLocalDone) setupLocalDone.addEventListener('click', hideGuide);
  document.getElementById('setupPathCloud')?.addEventListener('click', () => showSteps('cloud'));
  document.getElementById('setupPathLocal')?.addEventListener('click', () => showSteps('local'));

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
          if (e.message === 'project_paused') {
            _setupLoginError.innerHTML = `${t('toast.project_paused')} <a href="${e.dashboardUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;">Check on Supabase ↗</a>`;
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
async function connect(url, key, mode = 'supabase', skipDemoChooser = false) {
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
  } else if (mode === 'local') {
    adapter = createRestAdapter(url);
    // Test connection with raw adapter BEFORE wrapping with offline cache
    const { error } = await adapter.from('projects').select('id').limit(1);
    if (error) throw new Error('Connection failed');
    const scopeRef = url.replace(/^https?:\/\//, '');
    adapter = wrapWithOfflineCache(adapter, `local:${scopeRef}`);
  } else {
    adapter = createSupabaseAdapter(url, key);
    // Test connection with raw adapter BEFORE wrapping with offline cache
    const { error } = await adapter.from('projects').select('id').limit(1);
    if (error) {
      const msg = String(error.message || '').toLowerCase();
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

  document.getElementById('gate').style.display = 'none';
  document.getElementById('gateToolbar').style.display = 'none';
  hideHero();
  document.getElementById('app').classList.add('active');

  // Re-render logos now that the app is visible and layout is computed
  initLogos();

  // Set Supabase dashboard link (hide in local/demo mode)
  const dashLink = document.getElementById('supabaseDashLink');
  if (mode === 'local' || mode === 'demo') {
    dashLink.style.display = 'none';
  } else {
    const projectRef = url.replace('https://', '').replace('.supabase.co', '');
    dashLink.href = `https://supabase.com/dashboard/project/${projectRef}`;
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

  // Realtime subscription (skip for demo — no backend)
  if (mode !== 'demo') {
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

  markLastUpdated();

  // Show demo banner if in demo mode
  if (mode === 'demo') initDemoBanner();
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

  // Exit demo
  const exitBtn = document.createElement('button');
  exitBtn.textContent = t('demo.exit');
  exitBtn.addEventListener('click', () => disconnect());

  right.appendChild(toggleBtn);
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
  // Login — mode-aware labels
  const loginMode = getSelectedMode();
  const urlLabel = document.getElementById('urlLabel');
  const keyLabel = document.getElementById('keyLabel');
  const urlLabelLink = document.getElementById('urlLabelLink');
  const keyLabelLink = document.getElementById('keyLabelLink');
  const loginHint = document.getElementById('loginHint');
  if (urlLabelLink) { urlLabelLink.textContent = t(loginMode === 'local' ? 'login.url_label_local' : 'login.url_label'); urlLabelLink.dataset.tooltip = t('toast.url_tooltip'); }
  else if (urlLabel) urlLabel.textContent = t(loginMode === 'local' ? 'login.url_label_local' : 'login.url_label');
  if (keyLabelLink) keyLabelLink.textContent = t('login.key_label');
  else if (keyLabel) keyLabel.textContent = t('login.key_label');
  if (loginMode === 'demo') {
    if (loginHint) loginHint.textContent = t('login.hint_demo');
  } else {
    if (loginHint) loginHint.textContent = t(loginMode === 'local' ? 'login.hint_local' : 'login.hint_supabase');
  }
  const stayLabel = document.querySelector('.stay-connected-label span');
  if (stayLabel) stayLabel.textContent = t('login.stay_connected');
  const connectBtn = document.querySelector('#loginForm button[type="submit"]');
  if (connectBtn) connectBtn.textContent = t(loginMode === 'demo' ? 'login.btn_demo' : 'login.connect');
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
  const todoFilterMap = { pending: 'todos.pending', done: 'todos.done', all: 'todos.all' };
  document.querySelectorAll('#todoFilters .filter-btn').forEach(btn => {
    const f = btn.dataset.filter;
    if (f === 'flagged') { const svg = btn.querySelector('svg'); btn.innerHTML = (svg ? svg.outerHTML : '') + ' ' + t('todos.flagged'); }
    else if (f === 'outdated') { const svg = btn.querySelector('svg'); btn.innerHTML = (svg ? svg.outerHTML : '') + ' ' + t('todos.outdated'); }
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
  const setupCloudBadge = document.getElementById('setupCloudBadge');
  if (setupCloudBadge) setupCloudBadge.textContent = t('setup.cloud_badge');
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

function checkSchemaVersion() {
  if (state.demoMode) return;
  const dbVer = state.dbSchemaVersion || '0.00';
  if (cmpVer(dbVer, LATEST_COMPAT) >= 0) return;

  document.getElementById('schema-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'schema-banner';

  const isCritical = cmpVer(dbVer, LATEST_COMPAT_DEPREC) < 0;
  banner.className = isCritical ? 'schema-banner schema-banner-critical' : 'schema-banner';

  const icon = lucideIcon(isCritical ? 'alert-octagon' : 'alert-triangle', 16);
  const label = isCritical
    ? `Database v${dbVer} is too old — DeLaClaw may not work correctly. Run pending migrations.`
    : `Some features are unavailable (DB v${dbVer}, full support needs v${LATEST_COMPAT}). Run pending migrations.`;
  banner.innerHTML = `${icon}<span>${label}</span><button onclick="this.parentElement.remove()">Dismiss</button>`;
  document.body.prepend(banner);
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

async function exportBackup() {
  const btn = document.querySelector('.settings-data-btn[onclick="exportBackup()"]');
  if (btn) btn.disabled = true;
  try {
    const backup = { _meta: { version: 1, exported_at: new Date().toISOString(), tables: [] } };
    for (const table of BACKUP_TABLES) {
      try {
        const { data, error } = await state.db.from(table).select('*');
        if (error) { console.warn(`Skipping ${table}:`, error.message); continue; }
        backup[table] = data || [];
        backup._meta.tables.push(table);
      } catch (e) { console.warn(`Skipping ${table}:`, e.message); }
    }
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

function importBackup() {
  const input = document.getElementById('backupFileInput');
  if (!input) return;
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (!confirm(t('menu.settings_restore_confirm'))) return;
    const btn = document.querySelector('.settings-data-btn[onclick="importBackup()"]');
    if (btn) btn.disabled = true;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup._meta || backup._meta.version !== 1) {
        showToast(t('menu.settings_restore_invalid'));
        return;
      }
      // Delete in reverse order (children before parents)
      const tables = [...(backup._meta.tables || [])].reverse();
      for (const table of tables) {
        try {
          // Delete all rows — use a broadly matching filter
          // settings/prompts use 'key' as PK, others use 'id'
          const pk = (table === 'settings' || table === 'prompts') ? 'key' : 'id';
          await state.db.from(table).delete().neq(pk, '___nonexistent___');
        } catch (e) { console.warn(`Could not clear ${table}:`, e.message); }
      }
      // Insert in forward order (parents before children)
      const importOrder = backup._meta.tables || [];
      let totalRows = 0;
      for (const table of importOrder) {
        const rows = backup[table];
        if (!rows || !rows.length) continue;
        try {
          // Insert in batches of 100
          for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            const { error } = await state.db.from(table).insert(batch);
            if (error) { console.warn(`Insert into ${table} batch ${i}:`, error.message); }
          }
          totalRows += rows.length;
        } catch (e) { console.warn(`Failed to restore ${table}:`, e.message); }
      }
      showToast(t('menu.settings_restore_done', totalRows));
      // Reload to reflect new data
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      console.error('Import failed:', e);
      showToast(t('menu.settings_restore_error'));
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  input.click();
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
  // Sync URL hash (no reload)
  const newHash = '#' + view;
  if (location.hash !== newHash) history.replaceState(null, '', newHash);
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
let _lastUpdatedAt = null;
let _lastUpdatedTimer = null;

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
  let label;
  if (secs < 5) label = 'just now';
  else if (secs < 60) label = `${secs}s ago`;
  else if (secs < 3600) label = `${Math.floor(secs / 60)}m ago`;
  else label = `${Math.floor(secs / 3600)}h ago`;
  el.textContent = `Updated ${label}`;
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

// --- Environment badge + dev favicon/manifest ---
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
  // Swap manifest for dev PWA icon + name
  const manLink = document.querySelector('link[rel="manifest"]');
  if (manLink) manLink.href = 'manifest-dev.json';
})();
