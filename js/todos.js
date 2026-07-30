import { lucideIcon } from './icons.js';
import state, { TODO_MAX_LEN, DEFAULT_CATEGORY_PALETTE, GENERAL_CATEGORY_COLOR, SHARED_CATEGORY } from './state.js';
import { esc, escQ, renderMd, showToast, showConfirmAction, formatRelativeDate, truncateWithShowMore, balanceGrid, fetchAll, backfillCategoryColors } from './utils.js';
import { cleanupDragArtifacts, markDragClone, markDragSource, unmarkDragSource, registerDragCleanup, isDragging, setDragging, initItemHoverDelay, initItemDragDrop, reorderItems, scrollToAndHighlight, inlineEditText, LONG_PRESS_MS, DRAG_THRESHOLD } from './item-utils.js';
import { t, getLang } from './i18n.js';
import { sharedBadge, openSharePopover } from './sharing-ui.js';

// ===================================================================
// TODOS — DATA & CRUD (Category Card Layout)
// ===================================================================
let allTodos = [];
let todoFilter = 'pending';
let todoSearchQuery = '';

// ── Category table state ──
// Categories live in the todo_categories DB table. Loaded into maps for fast lookup.
let _todoCatMap = new Map();    // id → row
let _todoCatByName = new Map(); // name → row (backward compat)
let _defaultCatId = null;       // protected General row
let _sharedCatId = null;        // protected __shared__ row
const _myCreatedSharedIds = new Set(); // shared_ids where current user is creator

async function loadTodoCategories() {
  const { data, error } = await state.db.from('todo_categories').select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('loadTodoCategories error:', error); return; }
  _todoCatMap.clear();
  _todoCatByName.clear();
  _defaultCatId = null;
  _sharedCatId = null;
  for (const row of (data || [])) {
    _todoCatMap.set(row.id, row);
    _todoCatByName.set(row.name, row);
    if (row.is_protected && row.name === SHARED_CATEGORY) _sharedCatId = row.id;
    else if (row.is_protected && row.name !== SHARED_CATEGORY) _defaultCatId = row.id;
  }
  await backfillCategoryColors('todo_categories', _todoCatMap);
}

function getTodoCategories() { return _todoCatMap; }

// ── Category helpers ──
function getCatColor(catId) { return _todoCatMap.get(catId)?.color || GENERAL_CATEGORY_COLOR; }
function getCatShortname(catId) { return _todoCatMap.get(catId)?.shortname || null; }
function getCatName(catId) { return _todoCatMap.get(catId)?.name ?? ''; }
function getCatDisplayName(catId) {
  const cat = _todoCatMap.get(catId);
  if (!cat) return t('common.category_default');
  if (cat.name === '') return t('common.category_default');
  if (cat.name === SHARED_CATEGORY) return t('sharing.shared');
  return cat.name;
}
function catIdForTodo(todo) { return todo.category_id || _todoCatByName.get(todo.category ?? '')?.id || _defaultCatId; }

// Backward-compat: accepts name or ID. Used by habits.js and welcome.js.
function getCategoryColor(nameOrId) {
  if (_todoCatMap.has(nameOrId)) return _todoCatMap.get(nameOrId).color || GENERAL_CATEGORY_COLOR;
  const byName = _todoCatByName.get(nameOrId);
  if (byName) return byName.color || GENERAL_CATEGORY_COLOR;
  return GENERAL_CATEGORY_COLOR;
}

async function setCategoryColor(nameOrId, color) {
  const cat = _todoCatMap.get(nameOrId) || _todoCatByName.get(nameOrId);
  if (!cat) return;
  await state.db.from('todo_categories').update({ color }).eq('id', cat.id);
  cat.color = color;
}

function openEditCategoryModal(catId) {
  const cat = _todoCatMap.get(catId);
  if (!cat) return;
  document.getElementById('editCategoryOldName').value = catId; // store ID, not name
  document.getElementById('editCategoryName').value = cat.name;
  document.getElementById('editCategoryShortname').value = cat.shortname || '';
  document.getElementById('editCategoryColor').value = cat.color || GENERAL_CATEGORY_COLOR;
  document.getElementById('editCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('editCategoryName').focus(), 50);
}

function closeEditCategoryModal() {
  document.getElementById('editCategoryModal').classList.remove('visible');
}

async function saveEditCategory() {
  const catId = document.getElementById('editCategoryOldName').value;
  const cat = _todoCatMap.get(catId);
  if (!cat) return;
  const newName = document.getElementById('editCategoryName').value.trim();
  const shortname = document.getElementById('editCategoryShortname').value.trim();
  const color = document.getElementById('editCategoryColor').value;
  if (!newName && !cat.is_protected) { showToast(t('toast.name_required'), 'error'); return; }

  // Update the DB row directly — no need to rename strings on items since they reference by ID
  const updates = { shortname: shortname || null, color };
  if (!cat.is_protected) updates.name = newName;
  await state.db.from('todo_categories').update(updates).eq('id', catId);
  Object.assign(cat, updates);
  _todoCatByName.clear();
  for (const row of _todoCatMap.values()) _todoCatByName.set(row.name, row);

  closeEditCategoryModal();
  renderTodos();
  showToast(t('toast.updated'), 'success');
}


async function refreshTodos() {
  if (!state.db.connected) return;
  await loadTodoCategories();
  let data;
  try {
    data = await fetchAll(() => state.db.from('todos').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true }));
  } catch (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  allTodos = data || [];

  // Enrich shared todo pointers with live data from Drive
  if (state.sharing) {
    const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'todo');
    const sharedById = new Map(sharedItems.map(i => [i.id, i]));

    // Collect group IDs and enrich pointers
    const groupIds = new Set();
    for (const todo of allTodos) {
      if (!todo.shared_id) continue;
      const sh = sharedById.get(todo.shared_id);
      if (sh) {
        todo.text = sh.payload?.text || sh.payload?.title || '';
        todo.priority = sh.payload?.priority || 'medium';
        todo.done = sh.done ? 1 : 0;
        todo.due_date = sh.payload?.due_date || null;
        todo.snooze_until = sh.payload?.snooze_until || null;
        todo._shared = sh;
        if (todo.shared_group_id) groupIds.add(todo.shared_group_id);
      }
    }

    // Precompute which shared items the current user created (for unshare vs copy-to-personal)
    _myCreatedSharedIds.clear();
    if (typeof state.sharing.getCurrentMember === 'function') {
      const memberIdPerGroup = new Map();
      const gidArr = [...groupIds];
      const members = await Promise.all(gidArr.map(gid => Promise.resolve(state.sharing.getCurrentMember(gid))));
      gidArr.forEach((gid, i) => { if (members[i]?.memberId) memberIdPerGroup.set(gid, members[i].memberId); });
      for (const todo of allTodos) {
        if (!todo._shared || !todo.shared_group_id) continue;
        const myId = memberIdPerGroup.get(todo.shared_group_id);
        if (myId && todo._shared.created_by === myId) _myCreatedSharedIds.add(todo.shared_id);
      }
    }

    // Drop shared pointers whose remote data couldn't be resolved
    allTodos = allTodos.filter(t => !t.shared_id || t._shared);
  }

  if (state.currentView === 'todos') {
    renderTodos();
  }
  // Notify other views (e.g. Today) that todo data changed
  document.dispatchEvent(new CustomEvent('todos-changed'));
}

function setTodoFilter(filter) {
  todoFilter = filter;
  document.querySelectorAll('#todoFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderTodos();
}

function getFilteredTodosForCategory(catId) {
  const now = new Date();
  let filtered = allTodos.filter(t => catIdForTodo(t) === catId);

  // Apply search filter
  if (todoSearchQuery) {
    const q = todoSearchQuery.toLowerCase();
    filtered = filtered.filter(t =>
      (t.text && t.text.toLowerCase().includes(q)) ||
      (getCatDisplayName(catIdForTodo(t)).toLowerCase().includes(q))
    );
  }

  if (todoFilter === 'pending') {
    filtered = filtered.filter(t => !t.done && (!t.snooze_until || new Date(t.snooze_until) <= now));
  } else if (todoFilter === 'done') {
    filtered = filtered.filter(t => t.done);
  } else if (todoFilter === 'outdated') {
    filtered = filtered.filter(t => isTodoOutdated(t));
  }

  const sortBy = document.getElementById('todoSortBy')?.value || 'manual';
  if (sortBy === 'due') {
    filtered.sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date) - new Date(b.due_date);
    });
  } else if (sortBy === 'priority') {
    const prio = { urgent: 0, high: 1, medium: 2, low: 3, normal: 4 };
    filtered.sort((a, b) => (prio[a.priority] ?? 4) - (prio[b.priority] ?? 4));
  } else if (sortBy === 'created') {
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  return filtered;
}

function renderTodos() {
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;
  cleanupDragArtifacts();

  // Show page-level empty state when user has zero TODOs and no custom categories
  const catRows = Array.from(_todoCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  if (allTodos.length === 0 && catRows.length <= 1) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list-checks', 48, 'var(--muted)')}</div>
      <h3>${t('todos.empty_title')}</h3>
      <p>${t('todos.empty_hint')}</p>
      <button class="empty-cta" data-action="show-todo-general-card">${lucideIcon('plus', 16)} ${t('todos.empty_cta')}</button>
    </div>`;
    renderCategoryToolbarButtons([]);
    return;
  }

  // Build category ID list in sort order
  const categoryIdList = catRows.map(c => c.id);

  // Dynamically include the Shared deck if any received items exist
  const hasSharedItems = allTodos.some(t => t.category_id === _sharedCatId || t.category === SHARED_CATEGORY);
  if (hasSharedItems && _sharedCatId) categoryIdList.unshift(_sharedCatId);

  // Render category navigation buttons in toolbar
  renderCategoryToolbarButtons(categoryIdList);

  let html = '';
  for (const catId of categoryIdList) {
    // Skip empty categories when searching
    if (todoSearchQuery) {
      const matchingItems = getFilteredTodosForCategory(catId);
      const catName = getCatDisplayName(catId);
      if (matchingItems.length === 0 && !catName.toLowerCase().includes(todoSearchQuery.toLowerCase())) continue;
    }
    html += renderCategoryCard(catId);
  }

  const scrollY = window.scrollY;
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);

  // Init drag-and-drop for each card (individual TODO items)
  categoryIdList.forEach(catId => {
    const domId = categoryToDomId(catId);
    initTodoDragDropForCard(domId);
    const catCard = document.getElementById(domId);
    if (catCard) {
      const list = catCard.querySelector('.todo-cat-list');
      if (list) initTodoHoverDelay(list);
    }
  });

  // Init drag-and-drop for category cards themselves
  initCategoryDragDrop();

  balanceGrid(grid);
}

function renderCategoryToolbarButtons(categoryIdList) {
  const container = document.getElementById('todoNavButtons');
  if (!container) return;
  container.innerHTML = categoryIdList.map(catId => {
    const cat = _todoCatMap.get(catId);
    if (!cat) return '';
    const isShared = cat.name === SHARED_CATEGORY;
    const name = getCatDisplayName(catId);
    const shortname = cat.shortname;
    const displayName = isShared ? t('sharing.shared') : (shortname || name);
    const color = cat.color || GENERAL_CATEGORY_COLOR;
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-category" data-category="${esc(catId)}" title="Go to ${esc(name)}">${esc(displayName)}</button>`;
  }).join('');
}

function navigateToCategory(catId) {
  const domId = categoryToDomId(catId);
  const card = document.getElementById(domId);
  if (!card) return;
  scrollToAndHighlight(card, getCatColor(catId));
  setTimeout(() => {
    const input = card.querySelector('.todo-cat-input');
    if (input) input.focus();
  }, 400);
}

function categoryToDomId(catId) {
  return 'todo-cat-' + catId;
}

function updateTodoCharCounter(input) {
  const catId = input.closest('.project-card')?.id;
  if (!catId) return;
  const counter = document.getElementById(`todo-counter-${catId}`);
  if (!counter) return;
  const len = input.value.length;
  if (len === 0) { counter.textContent = ''; return; }
  counter.textContent = `${len}/${TODO_MAX_LEN}`;
  counter.className = 'char-counter' + (len > TODO_MAX_LEN * 0.9 ? ' danger' : len > TODO_MAX_LEN * 0.7 ? ' warn' : '');
}

function renderCategoryCard(catId) {
  const cat = _todoCatMap.get(catId);
  if (!cat) return '';
  const domId = categoryToDomId(catId);
  const isSharedDeck = cat.name === SHARED_CATEGORY;
  const catName = getCatDisplayName(catId);
  const isGeneral = cat.is_protected && cat.name !== SHARED_CATEGORY;
  const shortname = cat.shortname;
  const allInCat = allTodos.filter(t => catIdForTodo(t) === catId);
  const pending = allInCat.filter(t => !t.done).length;
  const doneCount = allInCat.filter(t => t.done).length;

  // Split: active items (not done) and done items
  const activeTodos = getFilteredTodosForCategory(catId).filter(t => !t.done);
  const doneTodos = allInCat.filter(t => t.done)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

  // Show active todos based on filter; done section always available as collapsible
  let displayActive, displayDone;
  if (todoFilter === 'outdated') {
    displayActive = activeTodos;
    displayDone = [];
  } else {
    displayActive = activeTodos;
    displayDone = doneTodos;
  }

  const statsText = `${pending} ${t('todos.pending').toLowerCase()}` + (doneCount > 0 ? ` · ${doneCount} ${t('todos.done').toLowerCase()}` : '');

  const deleteBtn = (!isGeneral && !isSharedDeck && !cat.is_protected)
    ? `<button class="todo-cat-delete-btn" data-action="delete-category" data-category="${esc(catId)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>`
    : '';

  const activeEmptyMsg = displayActive.length === 0
    ? `<p class="empty-msg">${todoFilter === 'pending' ? t('todos.all_caught_up') : t('todos.no_items')}</p>`
    : '';

  const escapedCatId = escQ(catId);

  const catColor = isSharedDeck ? '#a78bfa' : (cat.color || GENERAL_CATEGORY_COLOR);

  const catDragHandle = '';

  // Done toggle (collapsible, like archived tasks in projects)
  let doneToggle = '';
  if (doneCount > 0 && todoFilter !== 'done') {
    const deleteAllBtn = `<button class="delete-all-archived-btn" data-action="delete-all-done" data-category="${esc(catId)}" title="${t('todos.delete_all_done')}">${lucideIcon("trash-2",16)}</button>`;
    doneToggle = `
      <div class="archive-toggle" data-action="toggle-done-todos" data-cat-id="${esc(domId)}" id="done-toggle-${domId}">
        <span class="arrow" id="done-arrow-${domId}">▶</span> ${t('todos.done')} (${doneCount})
        ${deleteAllBtn}
      </div>
      <div class="archived-tasks" id="done-list-${domId}">
        ${doneTodos.map(t => renderTodoItem(t)).join('')}
      </div>`;
  }

  // For the 'done' filter view, show done items in the main list
  const mainListContent = todoFilter === 'done'
    ? (displayDone.length === 0 ? `<p class="empty-msg">${t('todos.no_items')}</p>` : displayDone.map(t2 => renderTodoItem(t2)).join(''))
    : (activeEmptyMsg || displayActive.map(t => renderTodoItem(t)).join(''));

  const shareableCount = allInCat.filter(td => !td.shared_id && !td.done).length;
  const shareAllBtn = (!isSharedDeck && state.sharing?.getAllGroups().length && shareableCount > 0)
    ? `<button class="todo-cat-shortname-btn" data-action="bulk-share-todo-category" data-category="${esc(catId)}" title="${esc(t('sharing.share_all'))}">${lucideIcon("share",14)}</button>`
    : '';

  const shortnameBtn = (!isGeneral && !isSharedDeck && !cat.is_protected)
    ? `<button class="todo-cat-shortname-btn" data-action="open-edit-category-modal" data-category="${esc(catId)}" title="${t('common.edit')}">${lucideIcon("pencil",14)}</button>`
    : '';

  const headerIcon = isSharedDeck ? `${lucideIcon('users', 16)} ` : '';

  const addRow = isSharedDeck ? '' : `<div class="todo-cat-add">
      <input type="text" placeholder="${t('todos.add_todo_placeholder')}" maxlength="2000" class="todo-cat-input" data-category="${esc(catId)}" data-priority="medium" data-action="add-todo-to-category">
      <button class="todo-add-priority-btn" data-action="open-quick-add-priority-picker" title="${esc(t('todos.set_priority'))}">${lucideIcon('flag', 16, '#eab308')}</button>
      <button data-action="add-todo-from-add-row">${lucideIcon('plus', 16)}</button>
      ${state.sharing?.getAllGroups().length ? `<button class="sharing-share-btn" data-action="share-todo-from-add" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
    </div>
    <div class="char-counter" id="todo-counter-${domId}"></div>`;

  return `<div class="project-card" id="${domId}" data-category="${esc(catId)}" style="--cat-color:${catColor}">
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        ${catDragHandle}
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${headerIcon}${esc(catName)}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        ${shareAllBtn}${shortnameBtn}${deleteBtn}
      </div>
    </div>
    ${addRow}
    <div class="task-list todo-cat-list" data-category="${esc(catId)}">
      ${mainListContent}
    </div>
    ${doneToggle}
  </div>`;
}

const TODO_OUTDATED_DAYS = 7;

function isTodoOutdated(td) {
  if (td.done) return false;
  if (!td.due_date) return false;
  const now = new Date();
  const ref = new Date(td.updated_at || td.created_at);
  const diffDays = (now - ref) / (1000 * 60 * 60 * 24);
  return diffDays >= TODO_OUTDATED_DAYS;
}

function renderTodoItem(td) {
  const now = new Date();
  const isOverdue = td.due_date && !td.done && new Date(td.due_date) < now;
  const isSnoozed = td.snooze_until && new Date(td.snooze_until) > now;
  const isOutdated = isTodoOutdated(td);
  const isFlagged = td.priority && td.priority !== 'normal';

  // Priority button: opens picker popover
  const prioColors = { urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6' };
  const flagColor = prioColors[td.priority] || null;
  const flagIconName = td.priority === 'urgent' ? 'alert-triangle' : 'flag';
  const flagIcon = flagColor ? lucideIcon(flagIconName, 14, flagColor) : lucideIcon('flag', 14);
  const flagTitle = t('todos.set_priority');
  const flagBtn = !td.done ? `<button class="todo-flag-btn ${isFlagged ? 'flagged' : ''}" data-action="open-priority-picker" data-id="${esc(td.id)}" title="${flagTitle}">${flagIcon}</button>` : '';

  let dueDateStr = '';
  if (td.due_date) {
    const d = new Date(td.due_date);
    const diffMs = d - now;
    const diffH = Math.round(diffMs / (1000 * 60 * 60));
    if (isOverdue) {
      dueDateStr = `<span class="todo-due overdue">${lucideIcon('alert-triangle', 14)} ${t('todos.overdue')} (${formatRelativeDate(d)})</span>`;
    } else if (diffH < 24) {
      dueDateStr = `<span class="todo-due due-soon">${lucideIcon("bell",16)} ${t('todos.due')} ${formatRelativeDate(d)}</span>`;
    } else {
      dueDateStr = `<span class="todo-due">${lucideIcon("calendar",16)} ${formatRelativeDate(d)}</span>`;
    }
  }

  let snoozeInfo = '';
  if (isSnoozed) {
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon",16)} ${t('todos.snoozed_until')} ${new Date(td.snooze_until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  let outdatedInfo = '';
  if (isOutdated && !td.done) {
    const ref = new Date(td.updated_at || td.created_at);
    const daysAgo = Math.floor((now - ref) / (1000 * 60 * 60 * 24));
    outdatedInfo = `<span class="todo-outdated-badge">${t('todos.days_old', daysAgo)}</span>`;
  }

  const priorityClass = isFlagged ? `todo-priority-${td.priority}` : '';
  const classes = [
    'bucket-item',
    'todo-item',
    td.done ? 'todo-done' : '',
    isOverdue ? 'todo-overdue' : '',
    isOutdated ? 'todo-outdated' : '',
    priorityClass
  ].filter(Boolean).join(' ');

  // Shared TODO badge
  const isShared = td.shared_id && td.shared_group_id;
  let sharedHtml = '';
  if (isShared && state.sharing) {
    const group = state.sharing.getAllGroups().find(g => g.id === td.shared_group_id);
    sharedHtml = sharedBadge(group?.name || '', td.shared_group_id);
  }

  return `<div class="${classes}" data-todo-id="${td.id}">
    ${sharedHtml}
    <div class="todo-row">
      ${flagBtn}
      <span class="todo-text">${td.text.length > 150 ? truncateWithShowMore(td.text, 150, td.id, 'todo') : renderMd(td.text)}</span>
      ${td.done && td.updated_at ? `<span class="todo-completed-date">${new Date(td.updated_at).toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })}</span>` : ''}
      <div class="todo-actions">
        ${!td.done ? `<button data-todo-id="${esc(td.id)}" data-action="toggle-todo" data-id="${esc(td.id)}" data-done="true" title="${t('common.done')}" class="todo-done-btn">${lucideIcon("circle-check",16)}</button>` : `<button data-todo-id="${esc(td.id)}" data-action="toggle-todo" data-id="${esc(td.id)}" data-done="false" title="${t('common.undo')}" class="todo-undo-btn">${lucideIcon("refresh-cw",16)}</button>`}
        ${!td.done ? `<button data-action="open-snooze-modal" data-id="${esc(td.id)}" title="${t('todos.snooze')}">${lucideIcon("moon",16)}</button>` : ''}
        ${!isShared && !td.done && state.sharing?.getAllGroups().length ? `<button data-action="share-existing-todo" data-id="${esc(td.id)}" title="${t('sharing.share')}">${lucideIcon("share",16)}</button>` : ''}
        ${isShared && !td.done && _myCreatedSharedIds.has(td.shared_id) ? `<button data-action="unshare-todo" data-id="${esc(td.id)}" title="${t('sharing.unshare')}">${lucideIcon("share-off",16)}</button>` : ''}
        ${isShared && !td.done && !_myCreatedSharedIds.has(td.shared_id) ? `<button data-action="copy-todo-to-personal" data-id="${esc(td.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon("copy",16)}</button>` : ''}
        <button data-action="copy-item-link" data-link-type="todo" data-id="${esc(td.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",16)}</button>
        <button data-action="edit-todo-inline" data-id="${esc(td.id)}" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button data-action="delete-todo" data-id="${esc(td.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    ${dueDateStr || snoozeInfo || outdatedInfo ? `<div class="todo-meta">${dueDateStr}${snoozeInfo}${outdatedInfo}</div>` : ''}
  </div>`;
}

const PRIORITY_LEVELS = [
  { key: 'urgent', color: '#ef4444', icon: 'alert-triangle' },
  { key: 'high', color: '#f97316', icon: 'flag' },
  { key: 'medium', color: '#eab308', icon: 'flag' },
  { key: 'low', color: '#3b82f6', icon: 'flag' },
  { key: 'normal', color: null, icon: 'circle-off' },
];

function openPriorityPicker(id, event, triggerEl) {
  event.stopPropagation();
  closePriorityPicker();
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  const btn = triggerEl || (event.currentTarget instanceof HTMLElement && event.currentTarget !== document ? event.currentTarget : event.target?.closest('[data-action="open-priority-picker"]')) || event.target;
  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.className = 'priority-picker';
  picker.id = 'priorityPickerPopover';

  picker.innerHTML = PRIORITY_LEVELS.map(lv => {
    const isActive = (todo.priority || 'normal') === lv.key;
    const label = t(`todos.priority_${lv.key}`) || lv.key;
    const dot = lv.color
      ? `<span class="priority-picker-dot" style="background:${lv.color}"></span>`
      : `${lucideIcon('circle-off', 14, 'var(--muted)')}`;
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" data-action="set-todo-priority" data-id="${esc(id)}" data-priority="${esc(lv.key)}">${dot}<span>${label}</span></div>`;
  }).join('');

  document.body.appendChild(picker);

  // Position below the button, flip up if near bottom
  const ph = picker.offsetHeight;
  let top = rect.bottom + 4;
  let left = rect.left;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if (left + picker.offsetWidth > window.innerWidth - 8) left = window.innerWidth - picker.offsetWidth - 8;
  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;

  // Close on outside click (next tick to avoid immediate close)
  setTimeout(() => {
    document.addEventListener('click', closePriorityPicker, { once: true });
  }, 0);
}

function closePriorityPicker() {
  const el = document.getElementById('priorityPickerPopover');
  if (el) el.remove();
}

function updateQuickAddPriorityBtn(btn, level) {
  const lv = PRIORITY_LEVELS.find(l => l.key === level) || PRIORITY_LEVELS[4];
  const color = lv.color || 'var(--muted)';
  const iconName = level === 'urgent' ? 'alert-triangle' : 'flag';
  btn.innerHTML = lucideIcon(iconName, 16, color);
  btn.dataset.priority = level;
}

function openQuickAddPriorityPicker(btn, event) {
  event.stopPropagation();
  closePriorityPicker();
  _lastQuickAddPrioBtn = btn;
  const rect = btn.getBoundingClientRect();
  const container = btn.closest('.todo-cat-add, .welcome-quick-add');
  const inputEl = container?.querySelector('.todo-cat-input');
  const currentPriority = inputEl?.dataset.priority || 'medium';

  const picker = document.createElement('div');
  picker.className = 'priority-picker';
  picker.id = 'priorityPickerPopover';

  picker.innerHTML = PRIORITY_LEVELS.map(lv => {
    const isActive = currentPriority === lv.key;
    const label = t(`todos.priority_${lv.key}`) || lv.key;
    const dot = lv.color
      ? `<span class="priority-picker-dot" style="background:${lv.color}"></span>`
      : `${lucideIcon('circle-off', 14, 'var(--muted)')}`;
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" data-action="set-quick-add-priority" data-priority="${esc(lv.key)}">${dot}<span>${label}</span></div>`;
  }).join('');

  document.body.appendChild(picker);

  const ph = picker.offsetHeight;
  let top = rect.bottom + 4;
  let left = rect.left;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  if (left + picker.offsetWidth > window.innerWidth - 8) left = window.innerWidth - picker.offsetWidth - 8;
  picker.style.top = top + 'px';
  picker.style.left = left + 'px';
}

function setQuickAddPriority(optionEl, level) {
  const picker = optionEl.closest('.priority-picker');
  if (!picker) { closePriorityPicker(); return; }
  closePriorityPicker();
  // Find the button that opened the picker by scanning all quick-add priority buttons
  // The most reliable way: find the one whose bounding rect was used to position the picker
  // Instead, store a reference: use the last-opened btn
  if (_lastQuickAddPrioBtn) {
    const container = _lastQuickAddPrioBtn.closest('.todo-cat-add, .welcome-quick-add');
    const inputEl = container?.querySelector('.todo-cat-input');
    if (inputEl) inputEl.dataset.priority = level;
    updateQuickAddPriorityBtn(_lastQuickAddPrioBtn, level);
  }
}

let _lastQuickAddPrioBtn = null;

async function setTodoPriority(id, level) {
  closePriorityPicker();
  const todo = allTodos.find(t => t.id === id);

  if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
    // ─── Shared: write only to Drive ───
    try {
      const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'medium' };
      await state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
        payload: { ...currentPayload, priority: level },
      });
    } catch (e) { console.warn('Failed to update shared todo priority on Drive:', e); showToast(t('toast.update_failed'), 'error'); return; }
  } else {
    // ─── Normal: write to local DB ───
    const { error } = await state.db.from('todos').update({ priority: level }).eq('id', id);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  }

  const label = t(`todos.priority_${level}`) || level;
  showToast(label, 'success');
  await refreshTodos();
}


async function addTodoToCategory(inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  const catId = inputEl.dataset.category || _defaultCatId;
  const cat = _todoCatMap.get(catId);
  const priority = inputEl.dataset.priority || 'medium';

  const pendingTodos = allTodos.filter(t => !t.done && catIdForTodo(t) === catId);
  const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;

  const { error } = await state.db.from('todos').insert({ text, priority, category: cat?.name ?? '', category_id: catId, sort_order: minOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  inputEl.value = '';
  // Reset priority to medium after adding
  inputEl.dataset.priority = 'medium';
  const prioBtn = inputEl.closest('.todo-cat-add, .welcome-quick-add')?.querySelector('.todo-add-priority-btn');
  if (prioBtn) updateQuickAddPriorityBtn(prioBtn, 'medium');
  showToast(t('toast.added'), 'success');
  await refreshTodos();
}

const _pendingTodoToggles = new Set();

async function toggleTodo(id, done, btnEl) {
  if (!id) return;
  if (_pendingTodoToggles.has(id)) return;
  _pendingTodoToggles.add(id);

  const sel = `button[data-todo-id="${CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')}"]`;
  const allBtns = document.querySelectorAll(sel);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : (allBtns[0] || null);
  const toToggle = new Set([...allBtns, ...(targetBtn ? [targetBtn] : [])]);
  toToggle.forEach(b => { b.disabled = true; b.classList.add('saving', 'is-pending'); b.setAttribute('aria-busy', 'true'); });

  try {
    const todo = allTodos.find(t => t.id === id);

    if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
      try {
        if (done) {
          await state.sharing.completeItem(todo.shared_group_id, todo.shared_id);
        } else {
          await state.sharing.uncompleteItem(todo.shared_group_id, todo.shared_id);
        }
      } catch (e) { console.warn('Failed to toggle shared todo on Drive:', e); showToast(t('toast.update_failed'), 'error'); return; }
    } else {
      const { error } = await state.db.from('todos').update({ done }).eq('id', id);
      if (error) { showToast(t('toast.update_failed'), 'error'); return; }
    }

    showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success');
    await refreshTodos();
  } finally {
    _pendingTodoToggles.delete(id);
    toToggle.forEach(b => { b.disabled = false; b.classList.remove('saving', 'is-pending'); b.removeAttribute('aria-busy'); });
  }
}

async function deleteTodo(id) {
  showConfirmAction(
    t('common.delete'),
    'Delete this TODO? This cannot be undone.',
    async () => {
      const todo = allTodos.find(t => t.id === id);
      const { error } = await state.db.from('todos').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }

      // Delete from Drive if shared (removes for all group members)
      if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
        try {
          await state.sharing.deleteItem(todo.shared_group_id, todo.shared_id);
        } catch (e) { console.warn('Failed to delete shared todo from Drive:', e); }
      }

      showToast(t('toast.deleted'), 'info');
      await refreshTodos();
    }
  );
}

function toggleDoneTodos(catId) {
  const container = document.getElementById(`done-list-${catId}`);
  const arrow = document.getElementById(`done-arrow-${catId}`);
  if (container) container.classList.toggle('visible');
  if (arrow) arrow.classList.toggle('open');
}

async function deleteAllDoneTodos(catId) {
  const doneTodos = allTodos.filter(t => catIdForTodo(t) === catId && t.done);
  if (!doneTodos.length) return;
  const catName = getCatDisplayName(catId);
  showConfirmAction(
    t('todos.delete_all_done'),
    `Delete all ${doneTodos.length} completed TODO${doneTodos.length > 1 ? 's' : ''} in "${catName}"? This cannot be undone.`,
    async () => {
      for (const td of doneTodos) {
        await state.db.from('todos').delete().eq('id', td.id);
        // Delete from Drive if shared
        if (td.shared_id && td.shared_group_id && state.sharing) {
          try { await state.sharing.deleteItem(td.shared_group_id, td.shared_id); }
          catch (e) { console.warn('Failed to delete shared todo from Drive:', e); }
        }
      }
      showToast(t('toast.deleted'), 'info');
      await refreshTodos();
    }
  );
}

async function editTodoInline(id, itemEl) {
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  if (!itemEl) itemEl = document.querySelector(`.todo-item[data-todo-id="${id}"]`);
  if (!itemEl) return;
  const textEl = itemEl.querySelector('.todo-text');
  if (!textEl || textEl.dataset.editing) return;

  // Hide action buttons while editing
  const actionsEl = itemEl.querySelector('.todo-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  // Build deadline date input as extra element
  const deadlineRow = document.createElement('div');
  deadlineRow.className = 'todo-edit-deadline-row';
  const deadlineLabel = document.createElement('label');
  deadlineLabel.innerHTML = lucideIcon('calendar') + ' ' + t('todos.deadline') + ':';
  deadlineLabel.className = 'todo-edit-deadline-label';
  const deadlineInput = document.createElement('input');
  deadlineInput.type = 'datetime-local';
  deadlineInput.className = 'todo-edit-deadline-input';
  if (todo.due_date) {
    const d = new Date(todo.due_date);
    deadlineInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'todo-edit-deadline-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = t('common.close');
  clearBtn.addEventListener('click', (e) => { e.stopPropagation(); deadlineInput.value = ''; });
  deadlineRow.appendChild(deadlineLabel);
  deadlineRow.appendChild(deadlineInput);
  deadlineRow.appendChild(clearBtn);

  // Category row
  const catRow = document.createElement('div');
  catRow.className = 'inline-edit-row';
  const catLabel = document.createElement('label');
  catLabel.className = 'inline-edit-label';
  catLabel.textContent = t('common.category');
  const catSelect = document.createElement('select');
  catSelect.className = 'inline-edit-input';
  const catRows = Array.from(_todoCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  // Include Shared in dropdown if the todo is in the shared deck (so user can move it out)
  const todoCatId = catIdForTodo(todo);
  if (todoCatId === _sharedCatId) {
    const sharedCat = _todoCatMap.get(_sharedCatId);
    if (sharedCat) catRows.unshift(sharedCat);
  }
  catRows.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name === SHARED_CATEGORY ? t('sharing.shared') : (c.name === '' ? t('common.category_default') : c.name);
    if (c.id === todoCatId) opt.selected = true;
    catSelect.appendChild(opt);
  });
  catRow.appendChild(catLabel);
  catRow.appendChild(catSelect);

  // Wrap deadline + category in extras container
  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';
  extras.appendChild(deadlineRow);
  extras.appendChild(catRow);

  inlineEditText(textEl, todo.text, {
    maxLength: 2000,
    extraEl: extras,
    collectExtra: () => {
      const newDeadline = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null;
      const selectedCatId = catSelect.value;
      const selectedCat = _todoCatMap.get(selectedCatId);
      return { due_date: newDeadline, category_id: selectedCatId, category: selectedCat?.name ?? '' };
    },
    saveFn: async (newText, extra) => {
      const updates = {};
      if (newText !== todo.text) updates.text = newText;
      if (extra) {
        const oldDeadline = todo.due_date || null;
        if (extra.due_date !== oldDeadline) updates.due_date = extra.due_date;
        const oldCatId = catIdForTodo(todo);
        if (extra.category_id !== oldCatId) {
          updates.category_id = extra.category_id;
          updates.category = extra.category;
        }
      }
      if (Object.keys(updates).length > 0) {
        if (todo.shared_id && todo.shared_group_id && state.sharing) {
          // ─── Shared: category to local pointer, text/priority/due_date to Drive ───
          if (updates.category_id !== undefined) {
            await state.db.from('todos').update({ category_id: updates.category_id, category: updates.category }).eq('id', id);
          }
          try {
            const driveUpdates = {};
            if (updates.text) driveUpdates.text = updates.text;
            if (updates.due_date !== undefined) driveUpdates.due_date = updates.due_date;
            if (Object.keys(driveUpdates).length > 0) {
              const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'medium' };
              await state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
                payload: { ...currentPayload, ...driveUpdates },
              });
            }
          } catch (e) { console.warn('Failed to update shared todo on Drive:', e); showToast(t('toast.update_failed'), 'error'); return; }
          showToast(t('todos.todo_updated'), 'success');
        } else {
          // ─── Normal: write all to local DB ───
          const { error } = await state.db.from('todos').update(updates).eq('id', id);
          if (error) showToast(t('toast.update_failed'), 'error');
          else showToast(t('todos.todo_updated'), 'success');
        }
      }
    },
    refreshFn: refreshTodos,
  });
}

// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================
function initTodoModals() {
  const app = document.getElementById('app');

  // Snooze Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'snoozeModal';
  m1.innerHTML = `<div class="modal snooze-modal"><h2>${lucideIcon("clock",20)} ${t('todos.snooze')}</h2><p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">${t('todos.snooze_hint')}</p><div class="snooze-options"><button data-action="snooze-for" data-amount="1" data-unit="h">${t('todos.snooze_1h')}</button><button data-action="snooze-for" data-amount="3" data-unit="h">${t('todos.snooze_3h')}</button><button data-action="snooze-for" data-amount="1" data-unit="d">${t('todos.snooze_1d')}</button><button data-action="snooze-for" data-amount="3" data-unit="d">${t('todos.snooze_3d')}</button><button data-action="snooze-for" data-amount="7" data-unit="d">${t('todos.snooze_1w')}</button><button data-action="snooze-for" data-amount="1" data-unit="M">${t('todos.snooze_1m')}</button></div><label style="margin-top:12px;">Or pick a date & time:</label><input type="datetime-local" id="snoozeCustomDate" style="width:100%;margin-top:4px;"><input type="hidden" id="snoozeTaskId"><div class="modal-actions"><button class="modal-cancel" data-action="close-snooze-modal">${t('common.cancel')}</button><button class="modal-save" data-action="submit-snooze">${t('todos.snooze')}</button></div></div>`;
  app.appendChild(m1);

  // Add Category Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'addCategoryModal';
  m2.innerHTML = `<div class="modal"><h2>${lucideIcon("folder-plus",20)} ${t('todos.add_category')}</h2><label>${t('todos.category_name')}</label><input type="text" id="newCategoryName" placeholder="${t('todos.category_placeholder')}" maxlength="40" data-action="save-new-category-on-enter"><div class="modal-actions"><button class="modal-cancel" data-action="close-add-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-category">${t('common.add')}</button></div></div>`;
  app.appendChild(m2);
}

function openAddCategoryModal() {
  document.getElementById('newCategoryName').value = '';
  document.getElementById('addCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newCategoryName').focus(), 100);
}

function closeAddCategoryModal() {
  document.getElementById('addCategoryModal').classList.remove('visible');
}

async function saveNewCategory() {
  const input = document.getElementById('newCategoryName');
  const name = input.value.trim();
  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  // Check for duplicates in existing categories
  for (const cat of _todoCatMap.values()) {
    if (cat.name.toLowerCase() === name.toLowerCase()) {
      showToast(t('toast.name_required'), 'error');
      return;
    }
  }

  // Auto-assign color from palette
  const usedColors = new Set(Array.from(_todoCatMap.values()).map(c => c.color).filter(Boolean));
  const color = DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c)) || DEFAULT_CATEGORY_PALETTE[_todoCatMap.size % DEFAULT_CATEGORY_PALETTE.length];
  const sortOrder = Math.max(0, ...Array.from(_todoCatMap.values()).map(c => c.sort_order || 0)) + 1;

  const { error } = await state.db.from('todo_categories').insert({ name, color, sort_order: sortOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  closeAddCategoryModal();
  showToast(t('toast.added'), 'success');
  await refreshTodos();
}

async function deleteCategory(catId) {
  const cat = _todoCatMap.get(catId);
  if (!cat || cat.is_protected) return;
  const todosInCat = allTodos.filter(t => catIdForTodo(t) === catId);
  const msg = todosInCat.length > 0
    ? `Delete "${cat.name}" and its ${todosInCat.length} TODO(s)? This cannot be undone.`
    : `Delete empty category "${cat.name}"?`;

  showConfirmAction(t('common.delete'), msg, async () => {
    // Propagate deletion of shared items to sharing layer before CASCADE removes local rows
    if (state.sharing) {
      for (const todo of todosInCat) {
        if (todo.shared_id && todo.shared_group_id) {
          try { await state.sharing.deleteItem(todo.shared_group_id, todo.shared_id); }
          catch (e) { console.warn('Failed to delete shared todo:', e); }
        }
      }
    }
    // CASCADE on FK — deleting the category removes all its items
    await state.db.from('todo_categories').delete().eq('id', catId);
    showToast(t('toast.deleted'), 'info');
    await refreshTodos();
  });
}


// ===================================================================
// SNOOZE MODAL
// ===================================================================
function openSnoozeModal(todoId) {
  document.getElementById('snoozeTaskId').value = todoId;
  document.getElementById('snoozeCustomDate').value = '';
  document.getElementById('snoozeModal').classList.add('visible');
}

function closeSnoozeModal() {
  document.getElementById('snoozeModal').classList.remove('visible');
}

function snoozeFor(amount, unit) {
  const now = new Date();
  let target;
  if (unit === 'h') {
    target = new Date(now.getTime() + amount * 60 * 60 * 1000);
  } else if (unit === 'd') {
    target = new Date(now.getTime() + amount * 24 * 60 * 60 * 1000);
    if (amount === 1) { target.setHours(9, 0, 0, 0); }
  } else if (unit === 'M') {
    target = new Date(now);
    target.setMonth(target.getMonth() + amount);
    target.setHours(9, 0, 0, 0);
  }
  doSnooze(target);
}

async function submitSnooze() {
  const customDate = document.getElementById('snoozeCustomDate').value;
  if (!customDate) { showToast(t('toast.content_required'), 'error'); return; }
  doSnooze(new Date(customDate));
}

async function doSnooze(snoozeUntil) {
  const taskId = document.getElementById('snoozeTaskId').value;
  if (!taskId) return;
  const todo = allTodos.find(t => t.id === taskId);

  if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
    // ─── Shared: write snooze to Drive payload ───
    try {
      const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'medium' };
      await state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
        payload: { ...currentPayload, snooze_until: snoozeUntil.toISOString() },
      });
    } catch (e) { console.warn('Failed to snooze shared todo on Drive:', e); showToast(t('toast.update_failed'), 'error'); return; }
  } else {
    // ─── Normal: write to local DB ───
    const { error } = await state.db.from('todos').update({ snooze_until: snoozeUntil.toISOString() }).eq('id', taskId);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  }
  closeSnoozeModal();
  showToast(`${t('todos.snoozed_until')} ${snoozeUntil.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 'success');
  await refreshTodos();
}


// ===================================================================
// TODO DRAG & DROP REORDER (delegates to shared item-utils)
// ===================================================================

function initTodoDragDropForCard(catId) {
  const card = document.getElementById(catId);
  if (!card) return;
  const container = card.querySelector('.todo-cat-list');
  if (!container) return;

  initItemDragDrop(container, {
    itemSelector: '.todo-item:not(.todo-done)',
    excludeSelector: 'button, a, input, textarea, select, .todo-actions',
    idAttr: 'todoId',
    onReorder: async (draggedId, targetId) => {
      const catKey = container.dataset.category || '';
      const filtered = getFilteredTodosForCategory(catKey);
      await reorderItems({
        items: filtered,
        allItems: allTodos,
        draggedId,
        targetId,
        container,
        itemSelector: '.todo-item',
        idAttr: 'todoId',
        tableName: 'todos',
        reinitFn: () => initTodoDragDropForCard(catId),
      });
    },
  });
}


// ===================================================================
// CATEGORY CARD DRAG & DROP REORDER
// ===================================================================
function initCategoryDragDrop() {
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;
  const cards = grid.querySelectorAll('.project-card');
  let dragState = null;

  cards.forEach(card => {
    const category = card.dataset.category;
    // General category (empty string) is not draggable
    if (category === '' || category === undefined) return;
    const header = card.querySelector('.todo-cat-header');
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
      let targetCategory = null;
      grid.querySelectorAll('.project-card').forEach(el => {
        if (el.classList.contains('drag-over')) { targetCategory = el.dataset.category || ''; }
        el.classList.remove('drag-over');
      });
      const draggedCategory = activeState.category;
      try {
        if (activeState.pointerId && header.hasPointerCapture?.(activeState.pointerId)) header.releasePointerCapture(activeState.pointerId);
      } catch (_) {}
      dragState = null;
      setDragging(false);
      window.getSelection()?.removeAllRanges();
      if (complete && targetCategory !== null && targetCategory !== draggedCategory && draggedCategory !== '' && targetCategory !== '') {
        await reorderCategories(draggedCategory, targetCategory);
      }
    };

    const cancelDrag = () => {
      void finishDrag({ complete: false });
    };

    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .todo-cat-header-actions')) return;
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
        dragState = { el: card, category, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null, pointerId: e.pointerId };
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

async function reorderCategories(draggedCatId, targetCatId) {
  const grid = document.getElementById('todoCategoryGrid');
  const catRows = Array.from(_todoCatMap.values()).filter(c => c.name !== SHARED_CATEGORY).sort((a, b) => a.sort_order - b.sort_order);
  const draggedIdx = catRows.findIndex(c => c.id === draggedCatId);
  const targetIdx = catRows.findIndex(c => c.id === targetCatId);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = catRows.splice(draggedIdx, 1);
  catRows.splice(targetIdx, 0, dragged);

  // Update sort_order in DB
  const updates = catRows.map((cat, i) => state.db.from('todo_categories').update({ sort_order: i }).eq('id', cat.id));
  await Promise.all(updates);

  // Move DOM elements instead of full re-render
  catRows.forEach(cat => {
    const card = grid.querySelector(`.project-card[data-category="${CSS.escape(cat.id)}"]`);
    if (card) grid.appendChild(card);
  });

  await loadTodoCategories();
  initCategoryDragDrop();
  showToast(t('toast.reordered'), 'success');
}



function initTodoHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.todo-item',
    actionsSelector: '.todo-actions',
    rowSelector: '.todo-row',
    textSelector: '.todo-text',
    editingSelector: '.task-edit-input, .todo-edit-wrapper',
    onDblClick: (item) => {
      const id = item.dataset.todoId;
      if (id) editTodoInline(id, item);
    },
  });
}

/** Return the in-memory todos array (no DB fetch). */
function getTodos() { return allTodos; }

// ── Shared TODOs — Sync (mirrors shared habit sync) ─────────────

/**
 * Sync shared TODOs from Drive to local DB.
 * Called on 'sharing-changed' event (poll detected changes).
 *
 * For each group:
 * - New shared TODO not in local DB → create local todo
 * - Shared TODO text/done/priority changed → update local todo
 * - Shared TODO deleted from Drive → delete local todo
 */
let _syncingTodos = false;
async function syncSharedTodos() {
  if (_syncingTodos) return;
  _syncingTodos = true;
  try {
    await _doSyncSharedTodos();
  } finally {
    _syncingTodos = false;
  }
}

async function _doSyncSharedTodos() {
  if (!state.sharing || !state.db?.connected) return;

  const allShared = state.sharing.getAllSharedItems().filter(i => i.item_type === 'todo');
  // Index local shared todos by shared_id from DB, not the in-memory allTodos cache.
  // Startup sync runs before refreshTodos(), so the cache may still be empty.
  let localShared = [];
  try {
    const rows = await fetchAll(() => state.db.from('todos').select('id,shared_id,shared_group_id'));
    localShared = (rows || []).filter(t => t.shared_id);
  } catch (e) {
    console.warn('syncSharedTodos: failed to load local pointers', e);
    localShared = (allTodos || []).filter(t => t.shared_id);
  }
  const localBySharedId = new Map(localShared.map(t => [t.shared_id, t]));

  // Track which shared_ids still exist on Drive (for deletion detection)
  const driveSharedIds = new Set(allShared.map(i => i.id));

  let needsRefresh = false;

  // Create pointers for new shared TODOs
  for (const sh of allShared) {
    if (!localBySharedId.has(sh.id)) {
      // Double-check DB to avoid race with shareTodoFromAdd
      const { data: existing } = await state.db.from('todos').select('id').eq('shared_id', sh.id).limit(1);
      if (existing?.length) continue;
      const { error } = await state.db.from('todos').insert({
        text: '', category: SHARED_CATEGORY, priority: 'medium', done: false,
        shared_id: sh.id, shared_group_id: sh.group_id,
      });
      if (error) { console.warn('syncSharedTodos: failed to create pointer', sh.id, error); continue; }
      needsRefresh = true;
    }
  }

  // ─── Cleanup: local shared todos whose shared_id no longer exists on remote ───
  for (const local of localShared) {
    if (!driveSharedIds.has(local.shared_id)) {
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        // Group exists but item gone from remote → delete local pointer
        await state.db.from('todos').delete().eq('id', local.id);
        needsRefresh = true;
      } else if (state.sharing.isReady?.()) {
        // Groups loaded but this one is gone → ask user before clearing
        try { document.dispatchEvent(new CustomEvent('sharing-orphan-detected', { detail: { groupId: local.shared_group_id } })); } catch {}
      }
      // else: sharing not loaded yet — skip, will retry on next sync
    }
  }

  if (needsRefresh) {
    await refreshTodos();
  }
}

window.syncSharedTodos = syncSharedTodos;

async function shareTodoFromAdd(btn) {
  const addRow = btn.closest('.todo-cat-add');
  if (!addRow) return;
  const input = addRow.querySelector('.todo-cat-input');
  const text = input?.value.trim();
  if (!text) return;
  const catId = input.dataset.category || _defaultCatId;
  const cat = _todoCatMap.get(catId);
  const priority = input.dataset.priority || 'medium';

  openSharePopover(btn, async (groupId, assignees) => {
    try {
      const sharedId = crypto.randomUUID();
      const pendingTodos = allTodos.filter(t => !t.done && catIdForTodo(t) === catId);
      const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;
      const { data: localRow, error: localErr } = await state.db.from('todos').insert({
        text: '', priority: 'medium', done: false,
        category: cat?.name ?? '', category_id: catId,
        sort_order: minOrder,
        shared_id: sharedId,
        shared_group_id: groupId,
      }).select().single();
      if (localErr) { showToast(localErr.message, 'error'); return; }

      try {
        await state.sharing.addItem(groupId, {
          id: sharedId,
          item_type: 'todo',
          payload: { text, category: cat?.name ?? '', priority },
          assignees,
        });
      } catch (driveErr) {
        // Clean up local row since Drive write failed
        if (localRow?.id) await state.db.from('todos').delete().eq('id', localRow.id);
        throw driveErr;
      }

      input.value = '';
      input.dataset.priority = 'medium';
      const prioBtn = addRow.querySelector('.todo-add-priority-btn');
      if (prioBtn) updateQuickAddPriorityBtn(prioBtn, 'medium');
      showToast(t('sharing.shared') + '!', 'success');
      await refreshTodos();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, { showAssignees: false });
}

window.shareTodoFromAdd = shareTodoFromAdd;

async function shareExistingTodo(id, el) {
  if (!state.sharing) return;
  const todo = allTodos.find(t => t.id === id);
  if (!todo || todo.shared_id) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-todo"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    try {
      const sharedId = crypto.randomUUID();
      const cat = _todoCatMap.get(catIdForTodo(todo));
      const pendingTodos = allTodos.filter(t => !t.done && catIdForTodo(t) === catIdForTodo(todo));
      const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;
      // 1. Create shared item on the sharing layer
      await state.sharing.addItem(groupId, {
        id: sharedId,
        item_type: 'todo',
        payload: { text: todo.text, category: cat?.name ?? '', priority: todo.priority || 'medium', note: todo.note || '' },
      });
      // 2. Create local pointer
      const { error: ptrErr } = await state.db.from('todos').insert({
        text: '', priority: 'medium', done: false,
        category: cat?.name ?? '', category_id: catIdForTodo(todo),
        sort_order: minOrder,
        shared_id: sharedId,
        shared_group_id: groupId,
      });
      if (ptrErr) { showToast(ptrErr.message, 'error'); return; }
      // 3. Delete the personal item
      await state.db.from('todos').delete().eq('id', todo.id);
      showToast(t('sharing.shared') + '!', 'success');
      await refreshTodos();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, { showAssignees: false });
}
window.shareExistingTodo = shareExistingTodo;

// ── Bulk share all personal items in a category ──
async function bulkShareTodoCategory(catId, el) {
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  const items = allTodos.filter(td => catIdForTodo(td) === catId && !td.shared_id && !td.done);
  if (!items.length) { showToast(t('sharing.share_all_nothing'), 'info'); return; }
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="bulk-share-todo-category"][data-category="${CSS.escape(catId)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    const cat = _todoCatMap.get(catId);
    const msg = t('sharing.share_all_confirm', items.length);
    showConfirmAction(
      t('sharing.share_all'),
      msg,
      async () => {
        let shared = 0;
        for (const todo of items) {
          try {
            const sharedId = crypto.randomUUID();
            await state.sharing.addItem(groupId, {
              id: sharedId,
              item_type: 'todo',
              payload: { text: todo.text, category: cat?.name ?? '', priority: todo.priority || 'medium', note: todo.note || '' },
            });
            const { error: ptrErr } = await state.db.from('todos').insert({
              text: '', priority: 'medium', done: false,
              category: cat?.name ?? '', category_id: catId,
              sort_order: todo.sort_order ?? 0,
              shared_id: sharedId,
              shared_group_id: groupId,
            });
            if (ptrErr) continue;
            await state.db.from('todos').delete().eq('id', todo.id);
            shared++;
          } catch (e) { console.error('[DeLaClaw] bulk share todo failed:', e); }
        }
        if (shared > 0) showToast(t('sharing.share_all_done', shared), 'success');
        await refreshTodos();
      },
      null,
      { variant: 'neutral', btnText: t('sharing.share_all'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
    );
  }, { showAssignees: false });
}
window.bulkShareTodoCategory = bulkShareTodoCategory;

// ── Unshare (creator only): move shared item back to personal ──
async function unshareTodo(id, el) {
  if (!state.sharing) return;
  const todo = allTodos.find(t => t.id === id);
  if (!todo || !todo.shared_id || !todo.shared_group_id) return;

  showConfirmAction(
    t('sharing.unshare'),
    t('sharing.unshare_confirm'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unshare-todo"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        const cat = _todoCatMap.get(catIdForTodo(todo));
        // 1. Create personal todo (same category, keep text/priority/note)
        const { error: insErr } = await state.db.from('todos').insert({
          text: todo.text || '',
          priority: todo.priority || 'medium',
          done: todo.done ? 1 : 0,
          category: cat?.name ?? '',
          category_id: catIdForTodo(todo),
          sort_order: todo.sort_order || 0,
        });
        if (insErr) { showToast(insErr.message, 'error'); return; }
        // 2. Delete shared item from sharing layer
        await state.sharing.deleteItem(todo.shared_group_id, todo.shared_id);
        // 3. Delete the local pointer
        await state.db.from('todos').delete().eq('id', todo.id);
        showToast(t('sharing.unshared'), 'success');
        await refreshTodos();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
      }
    },
    null,
    { variant: 'neutral', btnText: t('sharing.unshare'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
  );
}
window.unshareTodo = unshareTodo;

// ── Copy to personal (non-creator): duplicate shared item as personal ──
async function copyTodoToPersonal(id, el) {
  if (!state.sharing) return;
  const todo = allTodos.find(t => t.id === id);
  if (!todo || !todo.shared_id || !todo.shared_group_id) return;

  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="copy-todo-to-personal"][data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try {
    // Keep current category unless it's __shared__, then fall back to General
    const itemCatId = catIdForTodo(todo);
    const targetCatId = (itemCatId === _sharedCatId) ? _defaultCatId : itemCatId;
    const targetCatName = _todoCatMap.get(targetCatId)?.name ?? '';
    const pendingInCat = allTodos.filter(t => !t.done && catIdForTodo(t) === targetCatId);
    const minOrder = pendingInCat.length > 0 ? Math.min(...pendingInCat.map(t => t.sort_order || 0)) - 1 : 0;
    const { error: insErr } = await state.db.from('todos').insert({
      text: todo.text || '',
      priority: todo.priority || 'medium',
      done: todo.done ? 1 : 0,
      category: targetCatName,
      category_id: targetCatId,
      sort_order: minOrder,
    });
    if (insErr) { showToast(insErr.message, 'error'); return; }
    // Do NOT delete shared item — it stays for other members
    showToast(t('sharing.copied_to_personal'), 'success');
    await refreshTodos();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}
window.copyTodoToPersonal = copyTodoToPersonal;

export { refreshTodos, renderTodos, getCategoryColor, setCategoryColor, loadTodoCategories, getTodoCategories, initTodoModals, getTodoCounts, getTodos, syncSharedTodos, SHARED_CATEGORY, catIdForTodo, getCatDisplayName };

window.setTodoFilter = setTodoFilter;
window.addTodoToCategory = addTodoToCategory;
window.toggleTodo = toggleTodo;
window.deleteTodo = deleteTodo;
window.editTodoInline = editTodoInline;
window.toggleDoneTodos = toggleDoneTodos;
function getTodoCounts() {
  return { total: allTodos.length, pending: allTodos.filter(t => !t.done).length, done: allTodos.filter(t => t.done).length };
}

window.deleteAllDoneTodos = deleteAllDoneTodos;
window.openPriorityPicker = openPriorityPicker;
window.openQuickAddPriorityPicker = openQuickAddPriorityPicker;
window.setQuickAddPriority = setQuickAddPriority;
window.updateQuickAddPriorityBtn = updateQuickAddPriorityBtn;
window.setTodoPriority = setTodoPriority;
window.closePriorityPicker = closePriorityPicker;
window.openSnoozeModal = openSnoozeModal;
window.closeSnoozeModal = closeSnoozeModal;
window.snoozeFor = snoozeFor;
window.submitSnooze = submitSnooze;
window.openAddCategoryModal = openAddCategoryModal;
window.closeAddCategoryModal = closeAddCategoryModal;
window.saveNewCategory = saveNewCategory;
window.deleteCategory = deleteCategory;
window.navigateToCategory = navigateToCategory;
window.updateTodoCharCounter = updateTodoCharCounter;
window.openEditCategoryModal = openEditCategoryModal;
window.closeEditCategoryModal = closeEditCategoryModal;
window.saveEditCategory = saveEditCategory;
window.showTodoGeneralCard = function() {
  // Force render the normal view (General card) even when empty, then focus the input
  const grid = document.getElementById('todoCategoryGrid');
  if (!grid) return;
  cleanupDragArtifacts();
  if (!_defaultCatId) return;
  grid.innerHTML = renderCategoryCard(_defaultCatId);
  const domId = categoryToDomId(_defaultCatId);
  initTodoDragDropForCard(domId);
  const catCard = document.getElementById(domId);
  if (catCard) {
    const list = catCard.querySelector('.todo-cat-list');
    if (list) initTodoHoverDelay(list);
    const input = catCard.querySelector('.todo-cat-input');
    if (input) setTimeout(() => input.focus(), 100);
  }
  renderCategoryToolbarButtons([_defaultCatId]);
  balanceGrid(grid);
};
window.filterTodos = function(e) { todoSearchQuery = e.target.value; renderTodos(); };
window.renderTodos = renderTodos;
