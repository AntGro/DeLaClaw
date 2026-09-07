import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state, { DEFAULT_CATEGORY_PALETTE } from './state.js';
import { APP_VERSION } from './version.js';

// ===================================================================
// UTILS
// ===================================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g, '\x26quot;'); }
function escQ(s) { return esc(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Lightweight markdown renderer: escapes HTML first, then applies markdown formatting */
function renderMd(text) {
  if (!text) return '';
  let html = esc(text);
  // Code blocks (``` ... ```) — must come before inline code
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre class="md-code-block"><code>${code.trim()}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (single * not preceded/followed by space only)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Links [text](url) — supports https://, http://, and www. prefixes
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\[([^\]]+)\]\((www\.[^\s)]+)\)/g, '<a href="https://$2" target="_blank" rel="noopener">$1</a>');
  // Internal deep links [text](#type/id)
  html = html.replace(/\[([^\]]+)\]\(#((?:todo|habit|project|task|birthday|vest|flashcard|list|listitem)\/[\w-]+)\)/g, (_, text, ref) => {
    if (!parseDeepLink('#' + ref)) return `[${text}](#${ref})`;
    return `<a href="#${ref}" class="deep-link" data-deep-link="${ref}">${text}</a>`;
  });
  // Bare URLs (not already in an <a> tag)
  html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<&]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(?<!href="|"|\/)(www\.[^\s<&]+)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>');
  // Markdown tables — detect pipe-delimited rows and convert to <table>
  html = renderMdTables(html);
  // Line breaks (only on remaining text, not inside <table> blocks)
  html = html.replace(/\n/g, '<br>');
  return html;
}

/** Parse pipe-delimited markdown tables within already-escaped HTML */
function renderMdTables(html) {
  // Split by newlines, identify contiguous table blocks, convert them
  const lines = html.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    // A table needs at least: header row, separator row (with ---), and optionally data rows
    // Check if current line looks like a table row: starts/contains pipes
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      // Collect all contiguous table rows
      const tableLines = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      result.push(buildTable(tableLines));
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join('\n');
}

function isTableRow(line) {
  if (!line) return false;
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').length >= 2;
}

function isTableSeparator(line) {
  if (!line) return false;
  const trimmed = line.trim();
  // Separator row: cells contain only dashes, colons, spaces, and pipes
  const cells = splitTableRow(trimmed);
  return cells.length >= 1 && cells.every(c => /^[\s:]*-{1,}[\s:]*$/.test(c));
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(c => c.trim());
}

function buildTable(tableLines) {
  const headerCells = splitTableRow(tableLines[0]);
  // Parse alignment from separator row
  const sepCells = splitTableRow(tableLines[1]);
  const aligns = sepCells.map(c => {
    const t = c.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    return 'left';
  });

  let tableHtml = '<table class="md-table"><thead><tr>';
  headerCells.forEach((cell, idx) => {
    const align = aligns[idx] || 'left';
    tableHtml += `<th style="text-align:${align}">${cell}</th>`;
  });
  tableHtml += '</tr></thead><tbody>';

  for (let r = 2; r < tableLines.length; r++) {
    const cells = splitTableRow(tableLines[r]);
    tableHtml += '<tr>';
    headerCells.forEach((_, idx) => {
      const align = aligns[idx] || 'left';
      tableHtml += `<td style="text-align:${align}">${cells[idx] || ''}</td>`;
    });
    tableHtml += '</tr>';
  }

  tableHtml += '</tbody></table>';
  return tableHtml;
}

function showToast(msg, type = 'info', duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.className = 'toast', duration);
}




// ===================================================================
// DELETE CONFIRMATION MODAL
// ===================================================================
// ===================================================================
let _confirmActionCallback = null;
let _confirmCancelCallback = null;
let _confirmActionKeepOpen = false;
let _confirmActionLocked = false;

function showConfirmAction(title, message, onConfirm, detail, opts) {
  document.getElementById('confirmActionTitle').textContent = title;
  document.getElementById('confirmActionMessage').textContent = message;
  const detailEl = document.getElementById('confirmActionDetail');
  if (detail) {
    if (opts?.detailHtml) {
      detailEl.innerHTML = detail;
    } else {
      detailEl.textContent = detail;
    }
    detailEl.style.display = 'block';
  } else {
    detailEl.style.display = 'none';
  }
  // Toggle checkbox (optional)
  const toggleWrap = document.getElementById('confirmActionToggle');
  const toggleInput = document.getElementById('confirmActionToggleInput');
  const toggleLabel = document.getElementById('confirmActionToggleLabel');
  if (opts?.toggleLabel) {
    toggleLabel.textContent = opts.toggleLabel;
    toggleInput.checked = opts.toggleChecked !== false; // default true
    toggleWrap.style.display = '';
  } else {
    toggleWrap.style.display = 'none';
  }
  // Custom confirm button text (default: Delete)
  const btnTextEl = document.getElementById('confirmActionBtnText');
  if (btnTextEl) btnTextEl.textContent = opts?.btnText || 'Delete';
  // Custom icon (swap trash SVG for another Lucide icon)
  const iconWrap = document.querySelector('.confirm-action-icon-wrap');
  if (iconWrap) {
    if (opts?.iconSvg) {
      iconWrap.dataset.originalHtml = iconWrap.innerHTML;
      iconWrap.innerHTML = opts.iconSvg;
    }
  }
  // Custom button icon (swap trash SVG on the action button)
  const btnEl = document.getElementById('confirmActionBtn');
  if (btnEl) {
    const btnSvg = btnEl.querySelector('svg');
    if (opts?.btnIconSvg && btnSvg) {
      btnEl.dataset.originalBtnSvg = btnSvg.outerHTML;
      btnSvg.outerHTML = opts.btnIconSvg;
    }
  }
  // Translate Cancel button (allow custom label via opts)
  const cancelBtn = document.getElementById('confirmActionCancelBtn');
  if (cancelBtn) cancelBtn.textContent = opts?.cancelLabel || t('common.cancel');
  // Variant: 'neutral' uses accent color instead of red
  const modal = document.querySelector('.confirm-action-modal');
  if (modal) {
    modal.classList.toggle('confirm-neutral', opts?.variant === 'neutral');
  }
  // Confirm word (type "DELETE" to confirm)
  const confirmWordWrap = document.getElementById('confirmWordWrap');
  const confirmWordInput = document.getElementById('confirmWordInput');
  if (opts?.confirmWord && confirmWordWrap && confirmWordInput) {
    confirmWordInput.value = '';
    confirmWordInput.placeholder = opts.confirmPlaceholder || `Type ${opts.confirmWord} to confirm`;
    confirmWordWrap.style.display = '';
    // Disable confirm button until word matches
    const btn = document.getElementById('confirmActionBtn');
    if (btn) btn.disabled = true;
    confirmWordInput._handler = () => {
      if (btn) btn.disabled = confirmWordInput.value.trim() !== opts.confirmWord;
    };
    confirmWordInput.addEventListener('input', confirmWordInput._handler);
  } else if (confirmWordWrap) {
    confirmWordWrap.style.display = 'none';
  }
  _confirmActionCallback = onConfirm;
  _confirmActionKeepOpen = !!opts?.keepOpen;
  _confirmCancelCallback = opts?.onCancel || null;
  document.getElementById('confirmActionModal').classList.add('visible');
}

function closeConfirmAction() {
  if (_confirmActionLocked) return; // deletion in progress
  document.getElementById('confirmActionModal').classList.remove('visible');
  const cancelCb = _confirmCancelCallback;
  _confirmActionCallback = null;
  _confirmCancelCallback = null;
  _confirmActionKeepOpen = false;
  if (cancelCb) try { cancelCb(); } catch {}
  // Reset variant
  const modal = document.querySelector('.confirm-action-modal');
  if (modal) modal.classList.remove('confirm-neutral');
  // Reset toggle
  const toggleWrap = document.getElementById('confirmActionToggle');
  if (toggleWrap) toggleWrap.style.display = 'none';
  // Reset confirm word input
  const confirmWordWrap = document.getElementById('confirmWordWrap');
  const confirmWordInput = document.getElementById('confirmWordInput');
  if (confirmWordWrap) confirmWordWrap.style.display = 'none';
  if (confirmWordInput) {
    if (confirmWordInput._handler) {
      confirmWordInput.removeEventListener('input', confirmWordInput._handler);
      delete confirmWordInput._handler;
    }
    confirmWordInput.value = '';
  }
  const confirmBtn = document.getElementById('confirmActionBtn');
  if (confirmBtn) confirmBtn.disabled = false;
  // Reset custom button text
  const btnTextEl = document.getElementById('confirmActionBtnText');
  if (btnTextEl) btnTextEl.textContent = 'Delete';
  // Reset custom icon if it was changed
  const iconWrap = document.querySelector('.confirm-action-icon-wrap');
  if (iconWrap && iconWrap.dataset.originalHtml) {
    iconWrap.innerHTML = iconWrap.dataset.originalHtml;
    delete iconWrap.dataset.originalHtml;
  }
  // Reset custom button icon if it was changed
  const btnEl = document.getElementById('confirmActionBtn');
  if (btnEl && btnEl.dataset.originalBtnSvg) {
    const curSvg = btnEl.querySelector('svg');
    if (curSvg) curSvg.outerHTML = btnEl.dataset.originalBtnSvg;
    delete btnEl.dataset.originalBtnSvg;
  }
}

async function executeConfirmAction() {
  if (_confirmActionCallback) {
    const cb = _confirmActionCallback;
    const keepOpen = _confirmActionKeepOpen;
    const toggleInput = document.getElementById('confirmActionToggleInput');
    const toggleChecked = toggleInput ? toggleInput.checked : false;
    _confirmCancelCallback = null; // confirm path — do not fire cancel
    if (keepOpen) {
      // Lock modal open for progress display (e.g. account deletion)
      _confirmActionLocked = true;
      const btn = document.getElementById('confirmActionBtn');
      const cancelBtn = document.getElementById('confirmActionCancelBtn');
      if (btn) btn.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      const wordWrap = document.getElementById('confirmWordWrap');
      if (wordWrap) wordWrap.style.display = 'none';
      _confirmActionCallback = null;
      _confirmActionKeepOpen = false;
      try {
        await cb(toggleChecked);
      } finally {
        _confirmActionLocked = false;
      }
    } else {
      closeConfirmAction();
      await cb(toggleChecked);
    }
  }
}

// Close modals on overlay click / Escape
document.addEventListener('click', e => {
  if (e.target.id === 'editProjectModal') closeEditProjectModal();
  if (e.target.id === 'taskExpandModal') closeTaskExpandModal();
  if (e.target.id === 'revisionModal') closeRevisionModal();
  if (e.target.id === 'promptEditorModal') closePromptEditor();
  if (e.target.id === 'projectPromptModal') closeProjectPrompt();
  if (e.target.id === 'snoozeModal') closeSnoozeModal();
  if (e.target.id === 'confirmActionModal') closeConfirmAction();
  if (e.target.id === 'addCategoryModal') closeAddCategoryModal();
  if (e.target.id === 'addVestiaireModal') closeAddVestiaireModal();
  if (e.target.id === 'editVestiaireModal') closeEditVestiaireModal();
  if (e.target.id === 'addVestiaireCategoryModal') closeAddVestiaireCategoryModal();
  if (e.target.id === 'addHabitModal') closeAddHabitModal();
  if (e.target.id === 'editHabitModal') closeEditHabitModal();
  if (e.target.id === 'habitHistoryModal') closeHabitHistoryModal();
  if (e.target.id === 'addHabitCategoryModal') closeAddHabitCategoryModal();
  if (e.target.id === 'addBirthdayModal') closeAddBirthdayModal();
  if (e.target.id === 'editBirthdayModal') closeEditBirthdayModal();
  if (e.target.id === 'addListModal') closeAddListModal();
  if (e.target.id === 'editListModal') closeEditListModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAddProjectModal(); closeEditProjectModal(); closeTaskExpandModal(); closeRevisionModal(); closePromptEditor(); closeProjectPrompt(); closeSnoozeModal(); closeConfirmAction(); closeAddCategoryModal(); if (window.closeAddVestiaireModal) closeAddVestiaireModal(); if (window.closeEditVestiaireModal) closeEditVestiaireModal(); if (window.closeAddVestiaireCategoryModal) closeAddVestiaireCategoryModal(); if (window.closeAddHabitModal) closeAddHabitModal(); if (window.closeEditHabitModal) closeEditHabitModal(); if (window.closeHabitHistoryModal) closeHabitHistoryModal(); if (window.closeAddHabitCategoryModal) closeAddHabitCategoryModal(); if (window.closeAddBirthdayModal) closeAddBirthdayModal(); if (window.closeEditBirthdayModal) closeEditBirthdayModal(); if (window.closeAddListModal) closeAddListModal(); if (window.closeEditListModal) closeEditListModal(); if (window.closeMigrationModal) closeMigrationModal(); if (window.closeCompareModal) closeCompareModal(); }
});




// ===================================================================
// FOOTER STATS
// ===================================================================
// ===================================================================
const DB_SIZE_REFRESH_MS = 60 * 1000;
const _dbSizeByBackend = new Map();

function dbSizeBackendKey() {
  if (state.demoMode) return 'demo';
  if (state.driveMode) return 'googledrive';
  return document.getElementById('username')?.value?.trim() || 'default';
}

function dbSizeStateForCurrentBackend() {
  const key = dbSizeBackendKey();
  if (!_dbSizeByBackend.has(key)) {
    _dbSizeByBackend.set(key, { text: '—', fetchedAt: 0, unavailable: false, inFlight: null });
  }
  return _dbSizeByBackend.get(key);
}

function isMissingDbSizeRpc(error) {
  if (!error) return false;
  const code = String(error.code || '').toUpperCase();
  const status = error.status || error.statusCode;
  const msg = String(error.message || error.error || '').toLowerCase();
  const details = String(error.details || '').toLowerCase();
  const combined = `${msg} ${details}`;
  return status === 404
    || code === 'PGRST202'
    || code === '42883'
    || (combined.includes('db_size_mb') && (
      combined.includes('could not find')
      || combined.includes('not found')
      || combined.includes('does not exist')
      || combined.includes('unknown rpc')
    ));
}

function setDbSizeText(text) {
  const el = document.getElementById('dbSizeMb');
  if (el) el.textContent = text;
}

function updateFooterStats(viewCountsGetter) {
  const container = document.getElementById('dbStatsContainer');
  if (!container) return;

  // Get view-specific stats from the getter if provided
  const counts = viewCountsGetter ? viewCountsGetter() : null;
  let statsHtml = '';

  if (counts && counts.length) {
    statsHtml = counts.map(s => `<div class="db-stat">${s}</div>`).join('');
  }

  // DB size — only for backends with meaningful storage metrics
  if (state.demoMode) {
    // Demo mode: no persistent storage, skip DB size
    statsHtml += `<div class="db-stat">${lucideIcon('hard-drive', 14)} Demo</div>`;
  } else if (state.driveMode) {
    // Google Drive: show estimated data size from in-memory store
    statsHtml += `<div class="db-stat">${lucideIcon('hard-drive', 14)} Google Drive · <span id="dbSizeMb">—</span></div>`;
  } else {
    // Local: show DB size with limit
    statsHtml += `<div class="db-stat">${lucideIcon('hard-drive', 14)} ${t('utils.db')}: <span id="dbSizeMb">—</span> / 500 MB</div>`;
  }
  // Sharing groups count
  if (state.sharing) {
    try {
      const groupCount = state.sharing.getAllGroups().length;
      statsHtml += `<div class="db-stat" id="footerGroupCount">${lucideIcon('users', 14)} ${groupCount} group${groupCount !== 1 ? 's' : ''}</div>`;
    } catch { /* sharing not ready */ }
  }
  // App + DB version
  const dbVer = state.dbSchemaVersion || '—';
  statsHtml += `<div class="db-stat">${lucideIcon('git-branch', 14)} v${APP_VERSION} · DB v${dbVer}</div>`;
  container.innerHTML = statsHtml;

  // Fetch DB size via RPC (only relevant for the Local backend).
  // Some servers do not install the optional db_size_mb() function;
  // cache that capability miss so realtime footer refreshes do not spam 404s.
  if (state.db.connected && !state.demoMode && !state.driveMode) {
    const dbSizeState = dbSizeStateForCurrentBackend();
    setDbSizeText(dbSizeState.text);

    const stale = Date.now() - dbSizeState.fetchedAt > DB_SIZE_REFRESH_MS;
    if (!dbSizeState.unavailable && !dbSizeState.inFlight && stale) {
      dbSizeState.inFlight = state.db.rpc('db_size_mb')
        .then(({ data, error }) => {
          const rpcError = error || (data && typeof data === 'object' && data.error ? data : null);
          if (rpcError) {
            if (isMissingDbSizeRpc(rpcError)) dbSizeState.unavailable = true;
            dbSizeState.text = '—';
          } else {
            dbSizeState.text = data == null ? '—' : `${data} MB`;
          }
          dbSizeState.fetchedAt = Date.now();
          setDbSizeText(dbSizeState.text);
        })
        .catch(error => {
          if (isMissingDbSizeRpc(error)) dbSizeState.unavailable = true;
          dbSizeState.text = '—';
          dbSizeState.fetchedAt = Date.now();
          setDbSizeText(dbSizeState.text);
        })
        .finally(() => {
          dbSizeState.inFlight = null;
        });
    }
  }
  // Estimate data size for Google Drive from in-memory store
  if (state.driveMode && state.driveAdapter && state.driveAdapter._store) {
    try {
      const store = state.driveAdapter._store;
      let totalBytes = 0;
      for (const table of Object.keys(store)) {
        totalBytes += new Blob([JSON.stringify(store[table])]).size;
      }
      const el = document.getElementById('dbSizeMb');
      if (el) {
        el.textContent = totalBytes < 1024 * 1024
          ? `~${Math.max(1, Math.round(totalBytes / 1024))} KB`
          : `~${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
      }
    } catch { /* non-critical */ }
  }
}


// ===================================================================
// DYNAMIC TASK LIST HEIGHT
// ===================================================================
// ===================================================================
function updateTaskListMaxHeight() {
  const app = document.getElementById('app');
  if (!app || !app.classList.contains('active')) return;
  const header = document.querySelector('.app-header');
  const footer = document.querySelector('.site-footer');
  
  // Calculate occupied height (header + footer + padding)
  const occupiedHeight = (header?.offsetHeight || 0) + 
(footer?.offsetHeight || 0) + 80; // 80px for padding/margins
  
  const availableHeight = window.innerHeight - occupiedHeight;
  // Each card has ~80px overhead (header, add-task, archive toggle, padding)
  const cardOverhead = 100;
  const maxHeight = Math.max(300, availableHeight - cardOverhead);
  
  document.documentElement.style.setProperty('--task-list-max-height', maxHeight + 'px');
}

// Run on load and resize
window.addEventListener('resize', updateTaskListMaxHeight);



function formatRelativeDate(d) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return t('common.today_at', timeStr);
  if (diffDays === 1) return t('common.tomorrow_at', timeStr);
  if (diffDays === -1) return t('common.yesterday_at', timeStr);
  if (diffDays > 1 && diffDays <= 7) return t('common.in_days', diffDays);
  if (diffDays < -1 && diffDays >= -7) return t('common.days_ago', Math.abs(diffDays));
  const dateStr = d.toLocaleDateString(getLang(), { month: 'short', day: 'numeric' });
  return t('common.date_at', dateStr, timeStr);
}

// ===================================================================
// TRUNCATE WITH SHOW MORE (shared between projects & todos)
// ===================================================================
/** Visible length of text, counting [label](url) as just the label length */
function visibleLength(str) {
  return str.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').length;
}

function truncateWithShowMore(text, maxLen, id, field) {
  if (!text) return '';
  const firstLine = text.split('\n')[0];
  const renderedFull = renderMd(text);
  if (visibleLength(firstLine) <= maxLen && !text.includes('\n')) return renderedFull;
  // Truncate by visible length, keeping markdown links intact
  let cut = '';
  let vis = 0;
  const linkRe = /\[([^\]]*)\]\([^)]*\)/g;
  let last = 0;
  let m;
  while ((m = linkRe.exec(firstLine)) !== null) {
    // Plain text before this link
    const plain = firstLine.slice(last, m.index);
    if (vis + plain.length >= maxLen) {
      cut += plain.slice(0, maxLen - vis);
      vis = maxLen;
      break;
    }
    cut += plain;
    vis += plain.length;
    // The link — count only the label
    const label = m[1];
    if (vis + label.length > maxLen) {
      cut += plain.length ? '' : label.slice(0, maxLen - vis);
      vis = maxLen;
      break;
    }
    cut += m[0]; // keep full markdown link
    vis += label.length;
    last = m.index + m[0].length;
  }
  if (vis < maxLen) {
    const remaining = firstLine.slice(last);
    cut += remaining.slice(0, maxLen - vis);
  }
  const renderedFirstLine = renderMd(cut + '…');
  return `<span id="meta-${id}-${field}-short">${renderedFirstLine} <button class="show-more-btn" data-action="expand-meta" data-meta-id="${esc(id)}" data-meta-field="${esc(field)}" title="Show more">▼</button></span><span id="meta-${id}-${field}-full" style="display:none;">${renderedFull} <button class="show-more-btn" data-action="collapse-meta" data-meta-id="${esc(id)}" data-meta-field="${esc(field)}" title="Show less">▲</button></span>`;
}

function expandMeta(id, field) {
  document.getElementById(`meta-${id}-${field}-short`).style.display = 'none';
  document.getElementById(`meta-${id}-${field}-full`).style.display = 'inline';
}
function collapseMeta(id, field) {
  document.getElementById(`meta-${id}-${field}-short`).style.display = 'inline';
  document.getElementById(`meta-${id}-${field}-full`).style.display = 'none';
}

function isEditing() {
  return document.querySelector('.task-edit-input, .todo-edit-wrapper, [data-editing="true"]') !== null;
}

// ── Balanced Grid Layout ──
const _gridObservers = new WeakMap();
function balanceGrid(gridEl, { min = 400, max = 700, gap = 14 } = {}) {
  if (!gridEl) return;
  const apply = () => {
    const n = gridEl.children.length;
    if (n === 0) { gridEl.style.gridTemplateColumns = ''; return; }
    const w = gridEl.clientWidth;
    if (w === 0) return;
    const maxCols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    const minRows = Math.ceil(n / maxCols);
    const cols = Math.min(n, Math.ceil(n / minRows));
    if (cols <= 1) { gridEl.style.gridTemplateColumns = '1fr'; return; }
    const colW = Math.min(max, (w - (cols - 1) * gap) / cols);
    gridEl.style.gridTemplateColumns = `repeat(${cols}, ${colW}px)`;
  };
  apply();
  if (!_gridObservers.has(gridEl)) {
    const ro = new ResizeObserver(apply);
    ro.observe(gridEl);
    _gridObservers.set(gridEl, ro);
  }
}

// ===================================================================
// fetchAll — paginated read that defeats server-side row caps
// ===================================================================
// Some REST layers cap any unpaginated GET (PostgREST's default is
// 1000 rows). A plain `.from('x').select('*')` therefore silently
// truncates to the first rows once a table grows past that — the rows
// exist in the DB but never reach the client. This pages through with
// .range() until a short page is returned, so every row loads.
//
// Backends differ: only adapters that expose .range() page; the local
// REST, demo, and Drive adapters load whole tables in one shot and
// have no server-side row cap. So we only page when .range() exists,
// and otherwise run the query once.
//
// Usage — pass a factory that builds a FRESH query chain each call
// (a chain can't be re-awaited), without .range()/.limit():
//   const rows = await fetchAll(() =>
//     state.db.from('flashcards').select('*').order('created_at'));
//
// @param {() => object} buildQuery  — returns a fresh awaitable query
// @param {number} pageSize          — rows per page (default 1000)
// @returns {Promise<Array>}         — all rows (never the {data,error} envelope)
async function fetchAll(buildQuery, pageSize = 1000) {
  const probe = buildQuery();

  // Adapter without .range() (local REST / demo / Drive): no row cap,
  // one round-trip returns everything.
  if (typeof probe.range !== 'function') {
    const { data, error } = await probe;
    if (error) throw error;
    return data || [];
  }

  const all = [];
  let from = 0;
  let first = true;
  // Cap iterations as a belt-and-braces guard against a backend that
  // ignores range and keeps returning full pages.
  for (let guard = 0; guard < 10000; guard++) {
    const to = from + pageSize - 1;
    // First page reuses the probe chain; later pages need a fresh one.
    const q = first ? probe : buildQuery();
    first = false;
    const { data, error } = await q.range(from, to);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < pageSize) break; // short page → last page
    from += pageSize;
  }
  return all;
}

// Exports
// ===================================================================
// ENVIRONMENT DETECTION
// ===================================================================

/**
 * True when DeLaClaw is running as an installed PWA (launched from the home
 * screen / app icon) rather than inside a normal browser tab.
 * Uses the standard display-mode media query plus the iOS Safari fallback.
 */
function isInstalledPWA() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || window.navigator.standalone === true; // iOS Safari
}

/**
 * Best-effort device class: 'phone' | 'tablet' | 'computer'.
 * Web platforms cannot identify device type reliably, so this combines a
 * coarse-pointer check (touch-first device) with viewport width. The 768px
 * phone/tablet split is a convention, not ground truth — large phones in
 * landscape and small tablets sit near the boundary.
 */
function deviceClass() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (!coarse) return 'computer';
  const w = Math.min(window.innerWidth, window.innerHeight); // orientation-agnostic
  return w < 768 ? 'phone' : 'tablet';
}

/**
 * True when the primary pointer is touch or the screen is phone-sized.
 * This is an *interaction* signal (should we use tap-to-reveal UI?), not a
 * device identity. Centralises the check previously inlined in item-utils.
 */
function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches
    || window.matchMedia('(max-width:480px)').matches
    || 'ontouchstart' in window;
}

/**
 * True for iOS/Android user agents. Intended only for deciding whether to
 * open a native-app deep link (appUrl) vs a web URL — a deliberately
 * UA-based check, since a touch laptop should NOT get a mobile app link.
 */
function isMobileUA() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}



/**
 * Auto-assign palette colors to category/deck rows that have no color.
 * Called after loading each category table. Persists to DB so it's one-time.
 * @param {string} table - DB table name (e.g. 'todo_categories')
 * @param {Map} catMap - the in-memory map of rows (id → row)
 */
async function backfillCategoryColors(table, catMap) {
  const missing = [];
  for (const row of catMap.values()) {
    if (!row.color && !row.is_protected) missing.push(row);
  }
  if (!missing.length) return;
  const palette = DEFAULT_CATEGORY_PALETTE;
  // Assign colors cycling through palette by sort_order position
  missing.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const updates = missing.map((row, i) => {
    const color = palette[i % palette.length];
    row.color = color;
    return { id: row.id, color };
  });
  // Persist each color to DB (fire-and-forget, already set in memory)
  for (const u of updates) {
    state.db.from(table).update({ color: u.color }).eq('id', u.id).then(() => {});
  }
}

// ===================================================================
// DEEP-LINK UTILITIES
// ===================================================================

/** Map item type prefix to its view name */
const DEEP_LINK_TYPE_MAP = {
  todo: 'todos', habit: 'habits', project: 'projects', task: 'projects',
  birthday: 'birthdays', vest: 'vestiaire', flashcard: 'flashcards',
  list: 'lists', listitem: 'lists',
};

/** Parse a deep-link hash like #todo/abc123 → { type, id } or null */
function parseDeepLink(hash) {
  if (!hash || !hash.startsWith('#')) return null;
  const parts = hash.slice(1).split('/');
  if (parts.length !== 2) return null;
  const [type, id] = parts;
  if (!DEEP_LINK_TYPE_MAP[type] || !id) return null;
  return { type, id };
}

/** Copy an item's deep link to clipboard and show toast */
function copyItemLink(type, id, btnEl) {
  const base = location.origin + location.pathname;
  const url = base + '#' + type + '/' + id;
  const animateBtn = () => {
    if (!btnEl) return;
    btnEl.classList.remove('copy-link-done');
    void btnEl.offsetWidth;
    btnEl.classList.add('copy-link-done');
    setTimeout(() => btnEl.classList.remove('copy-link-done'), 2000);
  };
  navigator.clipboard.writeText(url).then(() => {
    showToast(t('common.link_copied'), 'success');
    animateBtn();
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(t('common.link_copied'), 'success');
    animateBtn();
  });
}

/** Scroll to an item element and apply the highlight animation */
function highlightItem(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  el.classList.remove('deep-link-highlight');
  void el.offsetWidth;
  el.classList.add('deep-link-highlight');
  el.addEventListener('animationend', () => el.classList.remove('deep-link-highlight'), { once: true });
}

/** Pick the next palette color not yet used by any entry in `catMapOrArray`.
 *  Accepts a Map (values iterated) or an Array of objects with optional `.color`. */
function nextPaletteColor(catMapOrArray) {
  const entries = catMapOrArray instanceof Map ? catMapOrArray.values() : (catMapOrArray || []);
  const usedColors = new Set();
  let count = 0;
  for (const c of entries) { if (c.color) usedColors.add(c.color); count++; }
  return DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c))
    || DEFAULT_CATEGORY_PALETTE[count % DEFAULT_CATEGORY_PALETTE.length];
}

// ── Auto-resize textarea (shared across all quick-add inputs) ──
function autoResizeTextarea(ta, maxHeight = 120) {
  ta.style.height = '0';
  const newHeight = Math.min(ta.scrollHeight, maxHeight);
  ta.style.height = newHeight + 'px';
  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
window.autoResizeTextarea = autoResizeTextarea;

export {
  esc, escQ, deepEqual, renderMd, showToast, formatRelativeDate,
  showConfirmAction, closeConfirmAction, executeConfirmAction,
  updateFooterStats, updateTaskListMaxHeight, truncateWithShowMore,
  isEditing, balanceGrid, fetchAll,
  isInstalledPWA, deviceClass, isTouchDevice, isMobileUA,
  backfillCategoryColors, nextPaletteColor,
  parseDeepLink, copyItemLink, highlightItem, DEEP_LINK_TYPE_MAP,
  autoResizeTextarea,
};

window.closeConfirmAction = closeConfirmAction;

// CSP delegation for utils handled in js/delegation.js — no per-module listeners

window.executeConfirmAction = executeConfirmAction;
window.expandMeta = expandMeta;
window.collapseMeta = collapseMeta;
window.copyItemLink = copyItemLink;
