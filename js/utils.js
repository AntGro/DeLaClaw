import { lucideIcon } from './icons.js';
import { t } from './i18n.js';
import state from './supabase.js';
import { APP_VERSION } from './version.js';

// ===================================================================
// UTILS
// ===================================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escQ(s) { return esc(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function linkify(html) { return html.replace(/https?:\/\/[^\s<&]+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`); }

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

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.className = 'toast', 2500);
}




// ===================================================================
// DELETE CONFIRMATION MODAL
// ===================================================================
// ===================================================================
let _deleteConfirmCallback = null;

function showDeleteConfirm(title, message, onConfirm, detail) {
  document.getElementById('deleteConfirmTitle').textContent = title;
  document.getElementById('deleteConfirmMessage').textContent = message;
  const detailEl = document.getElementById('deleteConfirmDetail');
  if (detail) {
    detailEl.textContent = detail;
    detailEl.style.display = 'block';
  } else {
    detailEl.style.display = 'none';
  }
  _deleteConfirmCallback = onConfirm;
  document.getElementById('deleteConfirmModal').classList.add('visible');
}

function closeDeleteConfirm() {
  document.getElementById('deleteConfirmModal').classList.remove('visible');
  _deleteConfirmCallback = null;
}

async function executeDeleteConfirm() {
  if (_deleteConfirmCallback) {
    const cb = _deleteConfirmCallback;
    closeDeleteConfirm();
    await cb();
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
  if (e.target.id === 'deleteConfirmModal') closeDeleteConfirm();
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
  if (e.key === 'Escape') { closeAddProjectModal(); closeEditProjectModal(); closeTaskExpandModal(); closeRevisionModal(); closePromptEditor(); closeProjectPrompt(); closeSnoozeModal(); closeDeleteConfirm(); closeAddCategoryModal(); if (window.closeAddVestiaireModal) closeAddVestiaireModal(); if (window.closeEditVestiaireModal) closeEditVestiaireModal(); if (window.closeAddVestiaireCategoryModal) closeAddVestiaireCategoryModal(); if (window.closeAddHabitModal) closeAddHabitModal(); if (window.closeEditHabitModal) closeEditHabitModal(); if (window.closeHabitHistoryModal) closeHabitHistoryModal(); if (window.closeAddHabitCategoryModal) closeAddHabitCategoryModal(); if (window.closeAddBirthdayModal) closeAddBirthdayModal(); if (window.closeEditBirthdayModal) closeEditBirthdayModal(); if (window.closeAddListModal) closeAddListModal(); if (window.closeEditListModal) closeEditListModal(); }
});




// ===================================================================
// FOOTER STATS
// ===================================================================
// ===================================================================
function updateFooterStats(viewCountsGetter) {
  const container = document.getElementById('dbStatsContainer');
  if (!container) return;

  // Get view-specific stats from the getter if provided
  const counts = viewCountsGetter ? viewCountsGetter() : null;
  let statsHtml = '';

  if (counts && counts.length) {
    statsHtml = counts.map(s => `<div class="db-stat">${s}</div>`).join('');
  }

  // Always add DB size
  statsHtml += `<div class="db-stat">${lucideIcon('hard-drive', 14)} ${t('utils.db')}: <span id="dbSizeMb">—</span> / 500 MB</div>`;
  // App + DB version
  const dbVer = state.dbSchemaVersion || '—';
  statsHtml += `<div class="db-stat">${lucideIcon('git-branch', 14)} v${APP_VERSION} · DB v${dbVer}</div>`;
  container.innerHTML = statsHtml;

  // Set dashboard link using the connected URL
  const urlInput = document.getElementById('username');
  if (urlInput && urlInput.value) {
    const projectRef = urlInput.value.replace('https://', '').replace('.supabase.co', '');
    document.getElementById('supabaseDashLink').href = `https://supabase.com/dashboard/project/${projectRef}`;
  }
  // Fetch DB size via RPC
  if (state.db.connected) {
    state.db.rpc('db_size_mb').then(({ data, error }) => {
      const el = document.getElementById('dbSizeMb');
      if (el) el.textContent = error ? '?' : `${data} MB`;
    });
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
  const footer = document.querySelector('.footer-stats');
  
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
  const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return t('common.date_at', dateStr, timeStr);
}

// ===================================================================
// TRUNCATE WITH SHOW MORE (shared between projects & todos)
// ===================================================================
function truncateWithShowMore(text, maxLen, id, field) {
  if (!text) return '';
  const firstLine = text.split('\n')[0].slice(0, 120);
  const renderedFirstLine = renderMd(firstLine + (text.length > firstLine.length ? '…' : ''));
  const renderedFull = renderMd(text);
  if (text.length <= 120 && !text.includes('\n')) return renderedFull;
  return `<span id="meta-${id}-${field}-short">${renderedFirstLine} <button class="show-more-btn" onclick="expandMeta('${id}','${field}')" title="Show more">▼</button></span><span id="meta-${id}-${field}-full" style="display:none;">${renderedFull} <button class="show-more-btn" onclick="collapseMeta('${id}','${field}')" title="Show less">▲</button></span>`;
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

// Exports
export {
  esc, escQ, linkify, renderMd, showToast, formatRelativeDate,
  showDeleteConfirm, closeDeleteConfirm, executeDeleteConfirm,
  updateFooterStats, updateTaskListMaxHeight, truncateWithShowMore,
  isEditing, balanceGrid,
};

window.closeDeleteConfirm = closeDeleteConfirm;
window.executeDeleteConfirm = executeDeleteConfirm;
window.expandMeta = expandMeta;
window.collapseMeta = collapseMeta;
