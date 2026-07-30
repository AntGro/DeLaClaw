import { t, getLang } from './i18n.js';
import { lucideIcon } from './icons.js';
import state, { ARCHIVED_PROJECTS_KEY, SHOW_ARCHIVED_KEY, MAX_TEXT_LEN, MAX_META_DISPLAY, TODO_MAX_LEN } from './state.js';
import { esc, escQ, renderMd, showToast, showDeleteConfirm,
         updateFooterStats, updateTaskListMaxHeight, truncateWithShowMore, balanceGrid, fetchAll } from './utils.js';
import { cleanupDragArtifacts, markDragClone, markDragSource, unmarkDragSource, registerDragCleanup, isDragging, setDragging, initItemHoverDelay, initItemDragDrop, reorderItems, scrollToAndHighlight, inlineEditText, LONG_PRESS_MS, DRAG_THRESHOLD } from './item-utils.js';

// ===================================================================
// state.PROJECTS (loaded from Supabase)
// ===================================================================
// (state managed in state.js)

// ── Search State ──
let projectSearchQuery = '';
let projectFilter = 'active';

function getArchivedProjectIds() {
  try { return JSON.parse(localStorage.getItem(ARCHIVED_PROJECTS_KEY) || '[]'); } catch { return []; }
}
function saveArchivedProjectIds(ids) { localStorage.setItem(ARCHIVED_PROJECTS_KEY, JSON.stringify(ids)); }

function isShowArchived() { return localStorage.getItem(SHOW_ARCHIVED_KEY) === 'true'; }

function toggleShowArchived() {
  const current = isShowArchived();
  localStorage.setItem(SHOW_ARCHIVED_KEY, String(!current));
  updateArchiveToggleBtn();
  renderArchivedProjects();
  updateArchiveToggleBtn();
  // Nav buttons don't change on archive toggle
}

function renderProjectNavButtons(projects) {
  const container = document.getElementById('projectNavButtons');
  if (!container) return;
  container.innerHTML = projects.map(p =>
    `<button class="category-nav-btn" style="--cat-color:${p.color}" data-action="navigate-to-project" data-id="${esc(p.id)}" title="Go to ${esc(p.name)}">${esc(p.shortname || p.name)}</button>`
  ).join('');
}

function navigateToProject(projectId) {
  const card = document.querySelector(`.project-card[data-project="${projectId}"]`);
  if (!card) return;
  const project = state.PROJECTS.find(p => p.id === projectId);
  const color = project ? project.color : 'var(--accent)';
  scrollToAndHighlight(card, color);
}

function updateArchiveToggleBtn() {
  const btn = document.getElementById('archiveToggleBtn');
  if (!btn) return;
  const active = isShowArchived();
  btn.innerHTML = active ? lucideIcon('folder-open') : lucideIcon('package');
  btn.title = t('projects.toggle_archived');
  btn.classList.toggle('btn-active', active);
}

async function loadProjects() {
  let data;
  try {
    data = await fetchAll(() => state.db.from('projects').select('*').order('sort_order', { ascending: true }));
  } catch (error) { showToast(t('toast.failed_to_load'), 'error'); return; }
  state.PROJECTS = (data || []).map(p => ({
    ...p,
    links: typeof p.links === 'string' ? JSON.parse(p.links) : (p.links || [])
  }));
}

async function archiveProject(id) {
  const ids = getArchivedProjectIds();
  if (!ids.includes(id)) { ids.push(id); saveArchivedProjectIds(ids); }
  buildProjectCards();
  initProjectDragDrop();
  renderArchivedProjects();
  await refreshAll();
  showToast(t('projects.project_archived'), 'info');
}

async function unarchiveProject(id) {
  const ids = getArchivedProjectIds().filter(i => i !== id);
  saveArchivedProjectIds(ids);
  buildProjectCards();
  initProjectDragDrop();
  renderArchivedProjects();
  await refreshAll();
  showToast(t('projects.project_restored'), 'success');
}

async function deleteProject(id, name) {
  const taskCount = state.allTasks.filter(t => t.project === id).length;
  const detail = taskCount > 0 ? `This will also delete ${taskCount} task${taskCount > 1 ? 's' : ''} in this project.` : null;
  showDeleteConfirm(
    t('common.delete'),
    `Delete "${name}"? This cannot be undone.`,
    async () => {
      await state.db.from('tasks').delete().eq('project', id);
      await state.db.from('prompts').delete().eq('key', id);
      const { error } = await state.db.from('projects').delete().eq('id', id);
      if (error) { showToast(t('toast.failed_to_delete') + ': ' + error.message, 'error'); return; }
      const ids = getArchivedProjectIds().filter(i => i !== id);
      saveArchivedProjectIds(ids);
      await loadProjects();
      buildProjectCards();
      await refreshAll();
      initProjectDragDrop();
      showToast(t('projects.project_deleted'), 'info');
    },
    detail
  );
}

function renderArchivedProjects() {
  const section = document.getElementById('archivedProjectsSection');
  const list = document.getElementById('archivedProjectsList');
  const archivedIds = getArchivedProjectIds();
  const archivedProjects = state.PROJECTS.filter(p => archivedIds.includes(p.id));

  if (!isShowArchived()) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  if (!archivedProjects.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;padding:8px 0;">No archived projects</p>';
    return;
  }

  list.innerHTML = archivedProjects.map(p => `
    <div class="archived-project-item">
      <span>${esc(p.name)} <span style="color:var(--muted);font-size:0.72rem;">${esc(p.tech || '')}</span></span>
      <button data-action="unarchive-project" data-id="${esc(p.id)}">Restore</button>
      <button data-action="delete-project" data-id="${esc(p.id)}" data-name="${esc(p.name)}" style="color:var(--red);">${t('common.delete')}</button>
    </div>
  `).join('');
  window.scrollTo(0, scrollY);
}

function copyProjectTitle(e, name) {
  if (e && e.stopPropagation) e.stopPropagation();
  // Support delegation: if name not passed, read from dataset
  const el = e && e.currentTarget ? e.currentTarget : null;
  const actionEl = e && e.target ? (e.target.closest && e.target.closest('[data-action="copy-project-title"]')) : null;
  const resolvedName = name || (actionEl && actionEl.dataset.name) || (el && el.dataset && el.dataset.name) || '';
  const text = 'Last project ' + resolvedName;
  navigator.clipboard.writeText(text).then(() => {
    const tipTarget = actionEl || el || (e && e.currentTarget);
    const tooltip = tipTarget ? tipTarget.querySelector('.copy-tooltip') : null;
    if (tooltip) { tooltip.classList.add('show'); setTimeout(() => tooltip.classList.remove('show'), 1500); }
  });
}

function setProjectFilter(filter) {
  projectFilter = filter;
  document.querySelectorAll('#projectFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  buildProjectCards();
  renderAllTasks();
}

function renderProjectGrid() {
  buildProjectCards();
  renderAllTasks();
}

function buildProjectCards() {
  const grid = document.getElementById('projectGrid');
  if (!grid) return;
  cleanupDragArtifacts();
  const archivedIds = getArchivedProjectIds();
  let visibleProjects = projectFilter === 'all'
    ? [...state.PROJECTS]
    : state.PROJECTS.filter(p => !archivedIds.includes(p.id));

  // Apply sort
  const sortBy = document.getElementById('projectSortBy')?.value || 'manual';
  if (sortBy === 'name') {
    visibleProjects.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sortBy === 'tasks') {
    visibleProjects.sort((a, b) => {
      const aCount = state.allTasks.filter(t => t.project === a.id && t.status !== 'approved').length;
      const bCount = state.allTasks.filter(t => t.project === b.id && t.status !== 'approved').length;
      return bCount - aCount;
    });
  }
  // manual = default order from state.PROJECTS

  if (visibleProjects.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('folder-kanban', 48, 'var(--muted)')}</div>
      <h3>${t('projects.empty_title')}</h3>
      <p>${t('projects.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-project">${lucideIcon('plus', 16)} ${t('projects.empty_cta')}</button>
    </div>`;
    renderArchivedProjects();
    renderProjectNavButtons([]);
    return;
  }

  const scrollY = window.scrollY;
  grid.innerHTML = visibleProjects.map(p => `
    <div class="project-card" data-project="${p.id}" style="--cat-color:${p.color}">
      <div class="project-card-header">
        <div style="display:flex;align-items:flex-start;gap:6px;">
          <div class="project-info">
            <strong><span class="project-title-copy" data-action="copy-project-title" data-name="${esc(p.name)}">${esc(p.name)}<span class="copy-tooltip">${t('common.copied')}</span></span></strong>
            <span class="tech">${esc(p.tech || '')}</span>
          </div>
        </div>
        <div class="project-header-actions">
          ${p.links.map(l => `<a class="project-link" href="${l.url}" target="_blank">${l.label} ↗</a>`).join(' ')}
          <button class="archive-project-btn" data-action="copy-item-link" data-link-type="project" data-id="${esc(p.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",14)}</button>
          <button class="expand-project-btn" data-action="toggle-expand-project" data-id="${esc(p.id)}" title="Expand/collapse project" id="expand-btn-${p.id}">${lucideIcon('maximize-2', 14, 'currentColor')}</button>
          <button class="prompt-project-btn" data-action="open-project-prompt" data-id="${esc(p.id)}" title="${t('projects.edit_prompt')}">${lucideIcon("file-text",16)}</button>
          <button class="archive-project-btn" data-action="open-edit-project" data-id="${esc(p.id)}" title="${t('projects.edit_project')}">${lucideIcon("pencil",16)}</button>
          <button class="archive-project-btn" data-action="archive-project" data-id="${esc(p.id)}" title="${t('projects.toggle_archived')}">${lucideIcon("package")}</button>
        </div>
      </div>
      <div class="task-list" id="tasks-${p.id}"><p class="empty-msg">${t('common.loading')}</p></div>
      <div class="archive-toggle" data-action="toggle-archived-tasks" data-id="${esc(p.id)}" id="archive-toggle-${p.id}" style="display:none;">
        <span class="arrow" id="archive-arrow-${p.id}">▶</span> ${t('projects.archived_tasks')} (<span id="archive-count-${p.id}">0</span>)
        <button class="delete-all-archived-btn" data-action="delete-all-archived-tasks" data-id="${esc(p.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
      </div>
      <div class="archived-tasks" id="archived-tasks-${p.id}"></div>
      <div class="add-task">
        <textarea placeholder="${t('projects.add_task_placeholder')}" maxlength="${MAX_TEXT_LEN}" id="input-${p.id}" data-action="task-input" data-id="${esc(p.id)}" rows="1" style="resize:none;overflow:hidden;"></textarea>
        <label class="draft-slider" title="${t('projects.status_draft')}"><input type="checkbox" id="draft-${p.id}"><span class="draft-slider-track"><span class="draft-slider-thumb"></span></span><span class="draft-slider-label">${t('projects.status_draft')}</span></label>
        <button data-action="add-task" data-id="${esc(p.id)}">${lucideIcon('plus', 16)}</button>
      </div>
      <div class="char-counter" id="counter-${p.id}"></div>
    </div>
  `).join('');

  renderArchivedProjects();
  renderProjectNavButtons(visibleProjects);
  balanceGrid(grid);
}

function updateCharCounter(input) {
  const projectId = input.id.replace('input-', '');
  const counter = document.getElementById(`counter-${projectId}`);
  if (!counter) return;
  const len = input.value.length;
  if (len === 0) { counter.textContent = ''; return; }
  counter.textContent = `${len}/${MAX_TEXT_LEN}`;
  counter.className = 'char-counter' + (len > MAX_TEXT_LEN * 0.9 ? ' danger' : len > MAX_TEXT_LEN * 0.7 ? ' warn' : '');
}



// ===================================================================
// SUPABASE TASK CRUD
// ===================================================================
// (state managed in state.js)

async function refreshAll() {
  if (!state.db.connected || isDragging) return;
  let all;
  try {
    all = await fetchAll(() => state.db.from('tasks').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true }));
  } catch (error) { showToast(t('toast.failed_to_load'), 'error'); return; }
  state.allTasks = all;
  renderAllTasks();
}

function renderAllTasks() {
  cleanupDragArtifacts();
  const archivedIds = getArchivedProjectIds();
  const visibleProjects = state.PROJECTS.filter(p => !archivedIds.includes(p.id));

  visibleProjects.forEach(p => {
    const container = document.getElementById(`tasks-${p.id}`);
    if (!container) return;
    let projectTasks = state.allTasks.filter(t => t.project === p.id);

    // Apply search filter
    if (projectSearchQuery) {
      const q = projectSearchQuery.toLowerCase();
      projectTasks = projectTasks.filter(t =>
        (t.text && t.text.toLowerCase().includes(q)) ||
        (t.hatch_response && t.hatch_response.toLowerCase().includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q))
      );
      // Hide the entire card if no tasks match (and project name doesn't match)
      const card = container.closest('.project-card');
      if (card) {
        const nameMatches = p.name && p.name.toLowerCase().includes(q);
        card.style.display = (projectTasks.length === 0 && !nameMatches) ? 'none' : '';
      }
    } else {
      const card = container.closest('.project-card');
      if (card) card.style.display = '';
    }

    const activeTasks = projectTasks.filter(t => t.status !== 'approved');
    // Sort: non-draft tasks first, then drafts, preserving sort_order within each group
    activeTasks.sort((a, b) => {
      const aDraft = a.status === 'draft' ? 1 : 0;
      const bDraft = b.status === 'draft' ? 1 : 0;
      if (aDraft !== bDraft) return aDraft - bDraft;
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
    const archivedTasks = projectTasks.filter(t => t.status === 'approved');

    // Active tasks
    if (!activeTasks.length) { container.innerHTML = '<p class="empty-msg">No tasks yet</p>'; }
    else { container.innerHTML = activeTasks.map(t => renderTask(t)).join(''); initDragDrop(container, p.id); initTaskHoverDelay(container); }

    // Archived tasks toggle
    const toggleEl = document.getElementById(`archive-toggle-${p.id}`);
    const archivedContainer = document.getElementById(`archived-tasks-${p.id}`);
    const countEl = document.getElementById(`archive-count-${p.id}`);
    if (archivedTasks.length > 0) {
      toggleEl.style.display = 'flex';
      countEl.textContent = archivedTasks.length;
      archivedContainer.innerHTML = archivedTasks.map(t => renderTask(t, true)).join('');
      initTaskHoverDelay(archivedContainer);
    } else {
      toggleEl.style.display = 'none';
      archivedContainer.innerHTML = '';
      archivedContainer.classList.remove('visible');
    }
  });
  updateTaskListMaxHeight();
}

function toggleArchivedTasks(projectId) {
  const container = document.getElementById(`archived-tasks-${projectId}`);
  const arrow = document.getElementById(`archive-arrow-${projectId}`);
  container.classList.toggle('visible');
  arrow.classList.toggle('open');
}

async function deleteAllArchivedTasks(projectId) {
  const archivedTasks = state.allTasks.filter(t => t.project === projectId && t.status === 'approved');
  if (!archivedTasks.length) return;
  const project = state.PROJECTS.find(p => p.id === projectId);
  const name = project ? project.name : projectId;
  showDeleteConfirm(
    t('common.delete'),
    `Delete all ${archivedTasks.length} archived task${archivedTasks.length > 1 ? 's' : ''} in "${name}"? This cannot be undone.`,
    async () => {
      for (const task of archivedTasks) {
        await state.db.from('tasks').delete().eq('id', task.id);
      }
      showToast(t('projects.deleted_tasks', archivedTasks.length), 'info');
      await refreshAll();
    }
  );
}


function renderTask(task, isArchived = false) {
  const isDraft = task.status === 'draft';
  let meta = '';
  if (task.plan_note) meta += `<div class="task-meta-item"><span class="task-meta-label plan">${lucideIcon("clipboard-list",16)} Plan:</span>${truncateWithShowMore(task.plan_note, MAX_META_DISPLAY, task.id, 'plan')}</div>`;
  if (task.hatch_response) meta += `<div class="task-meta-item response"><span class="task-meta-label claw">${lucideIcon('feather', 14)} ${t('projects.claw')}:</span>${truncateWithShowMore(task.hatch_response, MAX_META_DISPLAY, task.id, 'response')}</div>`;

  let actionBtns = '';
  if (isDraft) {
    actionBtns += `<button class="promote-btn" data-task-id="${esc(task.id)}" data-action="update-task-status" data-id="${esc(task.id)}" data-status="todo" title="${t('projects.promote_todo')}">▶ ${t('projects.promote_todo')}</button>`;
  }
  if (task.status === 'review') {
    actionBtns += `<button data-task-id="${esc(task.id)}" data-action="update-task-status" data-id="${esc(task.id)}" data-status="approved" title="${t('projects.status_approved')}">${lucideIcon("circle-check",16)}</button>`;
    actionBtns += `<button data-action="open-revision-modal" data-id="${esc(task.id)}" title="${t('projects.status_revision')}">${lucideIcon("refresh-cw",16)}</button>`;
  }
  if (task.status === 'approved' && isArchived) {
    actionBtns += `<button data-task-id="${esc(task.id)}" data-action="update-task-status" data-id="${esc(task.id)}" data-status="todo" title="${t('common.reopen')}">${lucideIcon('undo-2', 14)}</button>`;
  }
  actionBtns += `<button data-action="copy-item-link" data-link-type="task" data-id="${esc(task.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",16)}</button>`;
  actionBtns += `<button data-action="prompt-edit-task" data-id="${esc(task.id)}" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>`;
  actionBtns += `<button data-action="delete-task" data-id="${esc(task.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>`;

  const draftClass = isDraft ? ' task-draft' : '';

  return `<div class="bucket-item task-item${draftClass} task-status-${task.status}" data-task-id="${task.id}">
    <div class="task-row">
      <span class="task-text">${truncateWithShowMore(task.text, 120, task.id, 'text')}</span>
      ${isArchived && task.updated_at ? `<span class="task-completed-date">${new Date(task.updated_at).toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })}</span>` : ''}
      <div class="task-actions">${actionBtns}</div>
    </div>
    ${meta ? `<div class="task-meta">${meta}</div>` : ''}
  </div>`;
}


// ===================================================================
// ===================================================================
// TASK HOVER DELAY (delegates to shared item-utils)
// ===================================================================
function initTaskHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.task-item',
    actionsSelector: '.task-actions',
    rowSelector: '.task-row',
    textSelector: '.task-text',
    editingSelector: '.task-edit-input',
    onDblClick: (item) => {
      const id = item.dataset.taskId;
      if (id) promptEditTask(id);
    },
  });
}


// ===================================================================
// DRAG & DROP REORDER (delegates to shared item-utils)
// ===================================================================

function initDragDrop(container, projectId) {
  initItemDragDrop(container, {
    itemSelector: '.task-item',
    excludeSelector: 'button, a, input, textarea, select, .task-actions',
    skipInsideSelector: '.archived-tasks',
    idAttr: 'taskId',
    onReorder: async (draggedId, targetId) => {
      const projectTasks = state.allTasks.filter(t => t.project === projectId && t.status !== 'approved');
      await reorderItems({
        items: projectTasks,
        allItems: state.allTasks,
        draggedId,
        targetId,
        container,
        itemSelector: '.task-item',
        idAttr: 'taskId',
        tableName: 'tasks',
        reinitFn: () => initDragDrop(container, projectId),
      });
    },
  });
}

async function addTask(projectId) {
  const input = document.getElementById(`input-${projectId}`);
  const text = input.value.trim();
  if (!text) return;
  if (text.length > MAX_TEXT_LEN) { showToast(t('projects.max_chars', MAX_TEXT_LEN), 'error'); return; }
  const draftCheckbox = document.getElementById(`draft-${projectId}`);
  const isDraft = draftCheckbox && draftCheckbox.checked;
  input.value = '';
  const counter = document.getElementById(`counter-${projectId}`);
  if (counter) counter.textContent = '';
  // Get min sort_order for this project (insert at top)
  const projectTasks = state.allTasks.filter(t => t.project === projectId && t.status !== 'approved');
  const minOrder = projectTasks.length > 0 ? Math.min(...projectTasks.map(t => t.sort_order || 0)) - 1 : 0;
  const status = isDraft ? 'draft' : 'todo';
  const { error } = await state.db.from('tasks').insert({ project: projectId, text, status, sort_order: minOrder });
  if (error) showToast(t('toast.failed_to_add'), 'error');
  else { showToast(t('toast.added'), 'success'); await refreshAll(); }
}

const _pendingTaskStatus = new Set();

async function updateTaskStatus(id, status, btnEl) {
  if (!id) return;
  if (_pendingTaskStatus.has(id)) return;
  _pendingTaskStatus.add(id);
  const sel = `.task-item[data-task-id="${CSS && CSS.escape ? CSS.escape(id) : id}"] button`;
  const allBtns = document.querySelectorAll(sel);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : document.activeElement;
  if (targetBtn && targetBtn.tagName === 'BUTTON') {
    targetBtn.disabled = true;
    targetBtn.classList.add('saving', 'is-pending');
    targetBtn.setAttribute('aria-busy', 'true');
  }
  try {
    const { error } = await state.db.from('tasks').update({ status }).eq('id', id);
    if (error) showToast(t('toast.update_failed'), 'error');
    else { showToast(t('toast.updated'), 'success'); await refreshAll(); }
  } finally {
    _pendingTaskStatus.delete(id);
    if (targetBtn && targetBtn.tagName === 'BUTTON') {
      targetBtn.disabled = false;
      targetBtn.classList.remove('saving', 'is-pending');
      targetBtn.removeAttribute('aria-busy');
    }
  }
}

async function promptEditTask(id) {
  const task = state.allTasks.find(t => t.id === id);
  if (!task) return;
  const taskEl = document.querySelector(`.task-item[data-task-id="${id}"]`);
  if (!taskEl) return;
  const textSpan = taskEl.querySelector('.task-text');
  if (!textSpan || textSpan.dataset.editing) return;

  const originalText = task.text;
  // Hide action buttons while editing
  const actionsEl = taskEl.querySelector('.task-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  inlineEditText(textSpan, originalText, {
    maxLength: MAX_TEXT_LEN,
    saveFn: async (trimmed) => {
      const { error } = await state.db.from('tasks').update({ text: trimmed }).eq('id', id);
      if (error) showToast(t('toast.update_failed'), 'error');
      else showToast(t('projects.task_updated'), 'success');
    },
    refreshFn: refreshAll,
  });
}

async function deleteTask(id) {
  showDeleteConfirm(
    t('common.delete'),
    'Delete this task? This cannot be undone.',
    async () => {
      const { error } = await state.db.from('tasks').delete().eq('id', id);
      if (error) showToast(t('toast.delete_failed'), 'error');
      else { showToast(t('toast.deleted'), 'success'); await refreshAll(); }
    }
  );
}


// ===================================================================
// ADD PROJECT MODAL
// ===================================================================
// ===================================================================
function openAddProjectModal() {
  document.getElementById('addProjectModal').classList.add('visible');
  document.getElementById('newProjectId').value = '';
  document.getElementById('newProjectName').value = '';
  document.getElementById('newProjectShortname').value = '';
  document.getElementById('newProjectColor').value = '#646cff';
  document.getElementById('newProjectTech').value = '';
  document.getElementById('newProjectGithub').value = '';
  document.getElementById('newProjectLive').value = '';
  document.getElementById('newProjectId').focus();
}

function closeAddProjectModal() {
  document.getElementById('addProjectModal').classList.remove('visible');
}

// Close modal on overlay click
document.addEventListener('click', e => {
  if (e.target.id === 'addProjectModal') closeAddProjectModal();
});

async function saveNewProject() {
  const id = document.getElementById('newProjectId').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = document.getElementById('newProjectName').value.trim();
  const shortname = document.getElementById('newProjectShortname').value.trim() || null;
  const color = document.getElementById('newProjectColor').value;
  const tech = document.getElementById('newProjectTech').value.trim();
  const github = document.getElementById('newProjectGithub').value.trim();
  const live = document.getElementById('newProjectLive').value.trim();

  if (!id || !name) { showToast(t('toast.name_required'), 'error'); return; }
  if (state.PROJECTS.find(p => p.id === id)) { showToast(t('projects.id_exists'), 'error'); return; }

  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });

  const maxOrder = state.PROJECTS.length > 0 ? Math.max(...state.PROJECTS.map(p => p.sort_order || 0)) + 1 : 0;

  const { error } = await state.db.from('projects').insert({ id, name, shortname, color, tech, links, sort_order: maxOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + (error.message || ''), 'error'); return; }

  closeAddProjectModal();
  await loadProjects();
  buildProjectCards();
  await refreshAll();
  showToast(t('toast.added'), 'success');
}


// ===================================================================
// PROJECT DRAG & DROP REORDER
// ===================================================================
function initProjectDragDrop() {
  const grid = document.getElementById('projectGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.project-card');
  let dragState = null;

  cards.forEach(card => {
    const header = card.querySelector('.project-card-header');
    if (!header) return;

    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;
    let unregisterCleanup = null;

    const unregisterGlobalCleanup = () => {
      if (unregisterCleanup) {
        unregisterCleanup();
        unregisterCleanup = null;
      }
    };

    const finishDrag = async ({ complete = true } = {}) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      unregisterGlobalCleanup();
      const activeState = dragState && dragState.el === card ? dragState : null;
      if (!activeState) return;

      if (activeState.clone) activeState.clone.remove();
      card.classList.remove('dragging');
      unmarkDragSource(card);
      let targetId = null;
      grid.querySelectorAll('.project-card').forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset.project; }
        el.classList.remove('drag-over');
      });
      const draggedId = activeState.id;
      try {
        if (activeState.pointerId && header.hasPointerCapture?.(activeState.pointerId)) header.releasePointerCapture(activeState.pointerId);
      } catch (_) {}
      dragState = null;
      setDragging(false);
      window.getSelection()?.removeAllRanges();
      if (complete && targetId && targetId !== draggedId) await reorderProjects(draggedId, targetId);
    };

    const cancelDrag = () => {
      void finishDrag({ complete: false });
    };

    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .project-header-actions')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      unregisterGlobalCleanup();
      unregisterCleanup = registerDragCleanup(({ complete }) => {
        void finishDrag({ complete });
      });

      pressTimer = setTimeout(() => {
        activated = true;
        const rect = card.getBoundingClientRect();
        setDragging(true);
        dragState = { el: card, id: card.dataset.project, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null, pointerId: e.pointerId };

        const clone = markDragClone(card.cloneNode(true));
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);border-radius:12px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        markDragSource(card);
        card.classList.add('dragging');
        try { header.setPointerCapture(e.pointerId); } catch (_) {}
      }, LONG_PRESS_MS);
    });

    header.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer); pressTimer = null; unregisterGlobalCleanup();
        }
        return;
      }
      if (!dragState || dragState.el !== card) return;
      e.preventDefault();
      if (!dragState.clone) return;
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.clone.style.left = (e.clientX - dragState.offsetX) + 'px';
      grid.querySelectorAll('.project-card:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });

    header.addEventListener('pointerup', () => { void finishDrag({ complete: true }); });
    header.addEventListener('pointercancel', cancelDrag);
    header.addEventListener('lostpointercapture', cancelDrag);
  });
}

async function reorderProjects(draggedId, targetId) {
  const grid = document.getElementById('projectGrid');
  const archivedIds = getArchivedProjectIds();
  const visible = state.PROJECTS.filter(p => !archivedIds.includes(p.id));
  const draggedIdx = visible.findIndex(p => p.id === draggedId);
  const targetIdx = visible.findIndex(p => p.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = visible.splice(draggedIdx, 1);
  visible.splice(targetIdx, 0, dragged);

  // Update sort_order in memory
  visible.forEach((p, i) => { p.sort_order = i; });
  visible.forEach(p => {
    const sp = state.PROJECTS.find(x => x.id === p.id);
    if (sp) sp.sort_order = p.sort_order;
  });
  state.PROJECTS.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // Move DOM elements
  const cards = Array.from(grid.querySelectorAll('.project-card'));
  visible.forEach(p => {
    const card = cards.find(c => c.dataset.project === p.id);
    if (card) grid.appendChild(card);
  });

  // Re-init drag
  initProjectDragDrop();
  showToast(t('toast.reordered'), 'success');

  // Background Supabase sync
  Promise.all(visible.map((p, i) =>
    state.db.from('projects').update({ sort_order: i }).eq('id', p.id)
  )).catch(e => console.error('Project reorder sync failed:', e));
}


// ===================================================================
// EDIT PROJECT MODAL
// ===================================================================
function openEditProjectModal(id) {
  const p = state.PROJECTS.find(pr => pr.id === id);
  if (!p) return;
  document.getElementById('editProjectId').value = p.id;
  document.getElementById('editProjectName').value = p.name;
  document.getElementById('editProjectShortname').value = p.shortname || '';
  document.getElementById('editProjectColor').value = p.color;
  document.getElementById('editProjectTech').value = p.tech || '';
  const github = (p.links || []).find(l => l.label === 'GitHub');
  const live = (p.links || []).find(l => l.label === 'Live' || l.label === 'Play');
  document.getElementById('editProjectGithub').value = github ? github.url : '';
  document.getElementById('editProjectLive').value = live ? live.url : '';
  document.getElementById('editProjectModal').classList.add('visible');
}

function closeEditProjectModal() {
  document.getElementById('editProjectModal').classList.remove('visible');
}

async function saveEditProject() {
  const id = document.getElementById('editProjectId').value;
  const name = document.getElementById('editProjectName').value.trim();
  const shortname = document.getElementById('editProjectShortname').value.trim() || null;
  const color = document.getElementById('editProjectColor').value;
  const tech = document.getElementById('editProjectTech').value.trim();
  const github = document.getElementById('editProjectGithub').value.trim();
  const live = document.getElementById('editProjectLive').value.trim();
  if (!name) { showToast(t('toast.name_required'), 'error'); return; }
  const links = [];
  if (github) links.push({ label: 'GitHub', url: github });
  if (live) links.push({ label: 'Live', url: live });
  const { error } = await state.db.from('projects').update({ name, shortname, color, tech, links }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + (error.message || ''), 'error'); return; }
  closeEditProjectModal();
  await loadProjects();
  buildProjectCards();
  initProjectDragDrop();
  await refreshAll();
  showToast(t('toast.updated'), 'success');
}

// ===================================================================

// ===================================================================
// PROJECT EXPAND (INLINE)
// ===================================================================
const EXPAND_SVG = lucideIcon('maximize-2', 14, 'currentColor');
const COLLAPSE_SVG = lucideIcon('minimize-2', 14, 'currentColor');

function toggleExpandProject(projectId) {
  const card = document.querySelector(`.project-card[data-project="${projectId}"]`);
  if (!card) return;
  const isExpanded = card.classList.contains('expanded');
  // Collapse all other cards first
  document.querySelectorAll('.project-card.expanded').forEach(c => {
    c.classList.remove('expanded');
    const btn = c.querySelector('.expand-project-btn');
    if (btn) btn.innerHTML = EXPAND_SVG;
  });
  if (!isExpanded) {
    card.classList.add('expanded');
    const btn = card.querySelector('.expand-project-btn');
    if (btn) btn.innerHTML = COLLAPSE_SVG;
    // Smooth scroll to the expanded card
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}


// ===================================================================
// EXPAND TASK VIEW (modal)
// ===================================================================
function expandTask(id) {
  const tk = state.allTasks.find(task => task.id === id);
  if (!tk) return;
  const project = state.PROJECTS.find(p => p.id === tk.project);
  const content = document.getElementById('taskExpandContent');
  let meta = '';
  if (tk.plan_note) meta += `<div class="task-full-meta-item"><strong style="color:var(--accent);">${lucideIcon("clipboard-list",16)} Plan:</strong><br>${renderMd(tk.plan_note)}</div>`;
  if (tk.hatch_response) meta += `<div class="task-full-meta-item response"><strong style="color:var(--yellow);">${lucideIcon('feather', 14)} ${t('projects.claw')}:</strong><br>${renderMd(tk.hatch_response)}</div>`;

  let actions = '';
  if (tk.status === 'review') {
    actions = `<div style="display:flex;gap:8px;margin-top:12px;"><button class="btn" data-task-id="${esc(tk.id)}" data-action="approve-task-and-close" data-id="${esc(tk.id)}" data-status="approved">${lucideIcon("circle-check",16)} ${t('projects.status_approved')}</button><button class="btn" data-action="close-and-open-revision" data-id="${esc(tk.id)}">${lucideIcon("refresh-cw",16)} ${t('projects.status_revision')}</button></div>`;
  }

  content.innerHTML = `
    <h2><span class="status-dot ${tk.status}"></span> ${project ? esc(project.name) : esc(tk.project)}</h2>
    <div class="task-full-text">${esc(tk.text)}</div>
    ${meta ? `<div class="task-full-meta">${meta}</div>` : ''}
    <div style="font-size:0.72rem;color:var(--muted);">Created: ${new Date(tk.created_at).toLocaleString()} · Status: ${tk.status}</div>
    ${actions}
    <div style="margin-top:16px;text-align:right;"><button class="btn" data-action="close-task-expand">${t('common.close')}</button></div>
  `;
  document.getElementById('taskExpandModal').classList.add('visible');
}

function closeTaskExpandModal() {
  document.getElementById('taskExpandModal').classList.remove('visible');
}


// ===================================================================
// REVISION FEEDBACK MODAL
// ===================================================================
function openRevisionModal(taskId) {
  document.getElementById('revisionTaskId').value = taskId;
  document.getElementById('revisionFeedback').value = '';
  document.getElementById('revisionModal').classList.add('visible');
  const ta = document.getElementById('revisionFeedback');
  ta.focus();
  // Enter submits, Shift+Enter inserts newline
  ta.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitRevision();
    }
  });
}

function closeRevisionModal() {
  document.getElementById('revisionModal').classList.remove('visible');
}

async function submitRevision() {
  const taskId = document.getElementById('revisionTaskId').value;
  const feedback = document.getElementById('revisionFeedback').value.trim();
  if (!taskId) return;

  const updates = { status: 'revision' };
  if (feedback) {
    // Prepend feedback to plan_note so Claw sees it when picking up
    const task = state.allTasks.find(t => t.id === taskId);
    const existing = task?.plan_note || '';
    updates.plan_note = `[REVISION FEEDBACK]: ${feedback}\n\n${existing}`.slice(0, 5000);
  }

  const { error } = await state.db.from('tasks').update(updates).eq('id', taskId);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  closeRevisionModal();
  showToast(t('toast.updated'), 'success');
  await refreshAll();
}


// ===================================================================
// TASK-PICKUP PROMPT EDITOR (Supabase-backed)
// ===================================================================
// ===================================================================
let promptsCache = {};

async function loadPrompts() {
  if (!state.db.connected) return;
  let data;
  try {
    data = await fetchAll(() => state.db.from('prompts').select('*'));
  } catch (error) { return; }
  promptsCache = {};
  (data || []).forEach(p => { promptsCache[p.key] = p.text; });
}

// Global prompt (header button)
async function openPromptEditor() {
  await loadPrompts();
  document.getElementById('promptGlobalText').value = promptsCache['global'] || '';
  document.getElementById('promptEditorModal').classList.add('visible');
  document.getElementById('promptGlobalText').focus();
}

function closePromptEditor() {
  document.getElementById('promptEditorModal').classList.remove('visible');
}

async function saveGlobalPrompt() {
  const text = document.getElementById('promptGlobalText').value;
  await state.db.from('prompts').upsert({ key: 'global', text }, { onConflict: 'key' });
  promptsCache['global'] = text;
  closePromptEditor();
  showToast(t('toast.updated'), 'success');
}

// Per-project prompt (card button)
async function openProjectPrompt(projectId) {
  await loadPrompts();
  const project = state.PROJECTS.find(p => p.id === projectId);
  document.getElementById('projectPromptTitle').innerHTML = `${lucideIcon("file-text",20)} ${esc(project ? project.name : projectId)} — ${t('projects.project_prompt')}`;
  document.getElementById('promptProjectId').value = projectId;
  document.getElementById('promptProjectText').value = promptsCache[projectId] || '';
  document.getElementById('projectPromptModal').classList.add('visible');
  document.getElementById('promptProjectText').focus();
}

function closeProjectPrompt() {
  document.getElementById('projectPromptModal').classList.remove('visible');
}

async function saveProjectPrompt() {
  const projectId = document.getElementById('promptProjectId').value;
  const text = document.getElementById('promptProjectText').value;
  if (text.trim()) {
    await state.db.from('prompts').upsert({ key: projectId, text }, { onConflict: 'key' });
    promptsCache[projectId] = text;
  } else {
    await state.db.from('prompts').delete().eq('key', projectId);
    delete promptsCache[projectId];
  }
  closeProjectPrompt();
  showToast(t('toast.updated'), 'success');
}



// ===================================================================
// TEXTAREA AUTO-RESIZE + SHIFT+ENTER
// ===================================================================
// ===================================================================
function handleTaskInput(event, projectId) {
  // Support delegation: projectId may be in dataset
  const pid = projectId || (event && event.target && event.target.dataset && event.target.dataset.id) || (event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id);
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (pid) addTask(pid);
    return;
  }
  // Shift+Enter: let the browser insert the newline, then auto-resize
  if (event.key === 'Enter' && event.shiftKey) {
    // Don't prevent default — let the newline be inserted
    setTimeout(() => autoResizeTextarea(event.target), 0);
    return;
  }
  // Auto-resize on any other input
  setTimeout(() => autoResizeTextarea(event.target), 0);
}

function autoResizeTextarea(ta) {
  ta.style.height = '0';
  const newHeight = Math.min(ta.scrollHeight, 120);
  ta.style.height = newHeight + 'px';
  ta.style.overflowY = ta.scrollHeight > 120 ? 'auto' : 'hidden';
}

// Also auto-resize on input (for paste, etc.)
document.addEventListener('input', e => {
  if (e.target.tagName === 'TEXTAREA' && e.target.id.startsWith('input-')) {
    autoResizeTextarea(e.target);
  }
});
export {
  loadProjects, buildProjectCards, initProjectDragDrop, updateArchiveToggleBtn,
  renderArchivedProjects, refreshAll, renderAllTasks, getArchivedProjectIds, loadPrompts,
};

window.addTask = addTask;
window.updateTaskStatus = updateTaskStatus;
window.promptEditTask = promptEditTask;
window.deleteTask = deleteTask;
window.toggleArchivedTasks = toggleArchivedTasks;
window.deleteAllArchivedTasks = deleteAllArchivedTasks;

window.archiveProject = archiveProject;
window.unarchiveProject = unarchiveProject;
window.deleteProject = deleteProject;
window.copyProjectTitle = copyProjectTitle;
window.navigateToProject = navigateToProject;
window.toggleShowArchived = toggleShowArchived;
window.setProjectFilter = setProjectFilter;
window.renderProjectGrid = renderProjectGrid;
window.toggleExpandProject = toggleExpandProject;
window.closeTaskExpandModal = closeTaskExpandModal;
window.openAddProjectModal = openAddProjectModal;
window.closeAddProjectModal = closeAddProjectModal;
window.saveNewProject = saveNewProject;
window.openEditProjectModal = openEditProjectModal;
window.closeEditProjectModal = closeEditProjectModal;
window.saveEditProject = saveEditProject;
window.openRevisionModal = openRevisionModal;
window.closeRevisionModal = closeRevisionModal;
window.submitRevision = submitRevision;
window.openPromptEditor = openPromptEditor;
window.closePromptEditor = closePromptEditor;
window.saveGlobalPrompt = saveGlobalPrompt;
window.openProjectPrompt = openProjectPrompt;
window.closeProjectPrompt = closeProjectPrompt;
window.saveProjectPrompt = saveProjectPrompt;
window.updateCharCounter = updateCharCounter;
window.handleTaskInput = handleTaskInput;
window.refreshAll = refreshAll;
window.filterProjects = function(e) { projectSearchQuery = e.target.value; renderAllTasks(); };
