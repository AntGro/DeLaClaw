import { lucideIcon } from './icons.js';
import state, { TODO_MAX_LEN } from './state.js';
import { esc, escQ, renderMd, showToast, showDeleteConfirm, formatRelativeDate, truncateWithShowMore, balanceGrid, fetchAll } from './utils.js';
import { isDragging, setDragging, initItemHoverDelay, initItemDragDrop, reorderItems, scrollToAndHighlight, inlineEditText, LONG_PRESS_MS, DRAG_THRESHOLD } from './item-utils.js';
import { t, getLang } from './i18n.js';
import { sharedBadge, openSharePopover } from './sharing-ui.js';

// ===================================================================
// TODOS — DATA & CRUD (Category Card Layout)
// ===================================================================
// ===================================================================
let allTodos = [];
let todoFilter = 'pending';
let todoSearchQuery = '';
const CATEGORIES_KEY = 'todo_categories';
const CATEGORY_COLORS_KEY = 'todo_category_colors';
const DEFAULT_CATEGORY_PALETTE = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
const CATEGORY_SHORTNAMES_KEY = 'todo_category_shortnames';
const GENERAL_CATEGORY_COLOR = '#6c6f7e';

// DB keys for settings table
const TODO_COLORS_DB_KEY = 'todo_category_colors';
const TODO_SHORTNAMES_DB_KEY = 'todo_category_shortnames';
let _todoCategoryColors = {};
let _todoCategoryShortnames = {};

function getCategoryColors() { return _todoCategoryColors; }

async function loadTodoCategoryMeta() {
  // Try DB first, fall back to localStorage
  if (state.db.connected) {
    try {
      const { data: d1 } = await state.db.from('settings').select('key,value').eq('key', TODO_COLORS_DB_KEY);
      const { data: d2 } = await state.db.from('settings').select('key,value').eq('key', TODO_SHORTNAMES_DB_KEY);
      const data = [...(d1 || []), ...(d2 || [])];
      if (data.length) {
        for (const row of data) {
          if (row.key === TODO_COLORS_DB_KEY && row.value) {
            _todoCategoryColors = JSON.parse(row.value);
            localStorage.setItem(CATEGORY_COLORS_KEY, row.value);
          }
          if (row.key === TODO_SHORTNAMES_DB_KEY && row.value) {
            _todoCategoryShortnames = JSON.parse(row.value);
            localStorage.setItem(CATEGORY_SHORTNAMES_KEY, row.value);
          }
        }
        return;
      }
    } catch (e) { console.warn('Could not load todo category meta from DB:', e.message); }
  }
  try { _todoCategoryColors = JSON.parse(localStorage.getItem(CATEGORY_COLORS_KEY) || '{}'); } catch { _todoCategoryColors = {}; }
  try { _todoCategoryShortnames = JSON.parse(localStorage.getItem(CATEGORY_SHORTNAMES_KEY) || '{}'); } catch { _todoCategoryShortnames = {}; }
}

async function saveCategoryColors(map) {
  _todoCategoryColors = map;
  const json = JSON.stringify(map);
  localStorage.setItem(CATEGORY_COLORS_KEY, json);
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings')
        .update({ value: json, updated_at: new Date().toISOString() })
        .eq('key', TODO_COLORS_DB_KEY).select();
      if (!data || data.length === 0) {
        await state.db.from('settings')
          .insert({ key: TODO_COLORS_DB_KEY, value: json, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('Could not save todo colors to DB:', e.message); }
  }
}

function getCategoryColor(catName) {
  if (!catName) return GENERAL_CATEGORY_COLOR;
  if (_todoCategoryColors[catName]) return _todoCategoryColors[catName];
  // Auto-assign a color from the palette
  const usedColors = new Set(Object.values(_todoCategoryColors));
  const available = DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c)) || DEFAULT_CATEGORY_PALETTE[Object.keys(_todoCategoryColors).length % DEFAULT_CATEGORY_PALETTE.length];
  _todoCategoryColors[catName] = available;
  saveCategoryColors(_todoCategoryColors);
  return available;
}

function setCategoryColor(catName, color) {
  _todoCategoryColors[catName] = color;
  saveCategoryColors(_todoCategoryColors);
}

function getCategoryShortnames() { return _todoCategoryShortnames; }

async function saveCategoryShortnames(map) {
  _todoCategoryShortnames = map;
  const json = JSON.stringify(map);
  localStorage.setItem(CATEGORY_SHORTNAMES_KEY, json);
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings')
        .update({ value: json, updated_at: new Date().toISOString() })
        .eq('key', TODO_SHORTNAMES_DB_KEY).select();
      if (!data || data.length === 0) {
        await state.db.from('settings')
          .insert({ key: TODO_SHORTNAMES_DB_KEY, value: json, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('Could not save todo shortnames to DB:', e.message); }
  }
}

function getCategoryShortname(catName) {
  if (!catName) return null;
  return _todoCategoryShortnames[catName] || null;
}

function setCategoryShortname(catName, shortname) {
  if (shortname) { _todoCategoryShortnames[catName] = shortname; }
  else { delete _todoCategoryShortnames[catName]; }
  saveCategoryShortnames(_todoCategoryShortnames);
}

function openEditCategoryModal(catName) {
  document.getElementById('editCategoryOldName').value = catName;
  document.getElementById('editCategoryName').value = catName;
  document.getElementById('editCategoryShortname').value = getCategoryShortname(catName) || '';
  document.getElementById('editCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('editCategoryName').focus(), 50);
}

function closeEditCategoryModal() {
  document.getElementById('editCategoryModal').classList.remove('visible');
}

async function saveEditCategory() {
  const oldName = document.getElementById('editCategoryOldName').value;
  const newName = document.getElementById('editCategoryName').value.trim();
  const shortname = document.getElementById('editCategoryShortname').value.trim();
  if (!newName) { showToast(t('toast.name_required'), 'error'); return; }

  // Update shortname
  setCategoryShortname(newName, shortname);

  // Rename category if changed
  if (newName !== oldName) {
    // Update localStorage categories list
    const cats = getCategories();
    const idx = cats.indexOf(oldName);
    if (idx !== -1) { cats[idx] = newName; saveCategories(cats); }

    // Move old shortname to new name if different
    if (newName !== oldName) {
      const oldSn = getCategoryShortname(oldName);
      if (oldSn && !shortname) setCategoryShortname(newName, oldSn);
      setCategoryShortname(oldName, ''); // clear old
    }

    // Update all todos in Supabase
    const todosToUpdate = allTodos.filter(t => (t.category || 'General') === oldName);
    if (todosToUpdate.length > 0) {
      await Promise.all(todosToUpdate.map(t =>
        state.db.from('todos').update({ category: newName }).eq('id', t.id)
      ));
      todosToUpdate.forEach(t => { t.category = newName; });
    }
  }

  closeEditCategoryModal();
  renderTodos();
  showToast(t('toast.updated'), 'success');
}

function getCategories() {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCategories(cats) {
  localStorage.setItem(CATEGORIES_KEY, JSON.stringify(cats));
}

function syncCategoriesFromTodos() {
  const known = getCategories();
  const knownSet = new Set(known.map(c => c.toLowerCase()));
  const discovered = new Set();
  allTodos.forEach(t => {
    if (t.category && !knownSet.has(t.category.toLowerCase())) {
      discovered.add(t.category);
    }
  });
  if (discovered.size > 0) {
    saveCategories([...known, ...Array.from(discovered)]);
  }
}

// Also migrate old bucket localStorage key if present
function migrateBucketsToCategories() {
  const oldKey = 'todo_buckets';
  const old = localStorage.getItem(oldKey);
  if (old) {
    try {
      const buckets = JSON.parse(old);
      const existing = getCategories();
      const existingSet = new Set(existing.map(c => c.toLowerCase()));
      const newOnes = buckets.filter(b => !existingSet.has(b.toLowerCase()));
      if (newOnes.length) saveCategories([...existing, ...newOnes]);
    } catch {}
    localStorage.removeItem(oldKey);
  }
}

async function refreshTodos() {
  if (!state.db.connected) return;
  await loadTodoCategoryMeta();
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

    for (const todo of allTodos) {
      if (!todo.shared_id) continue;
      const sh = sharedById.get(todo.shared_id);
      if (sh) {
        // Enrich pointer with Drive data (keep local category + sort_order)
        todo.text = sh.payload?.text || sh.payload?.title || '';
        todo.priority = sh.payload?.priority || 'medium';
        todo.done = sh.done ? 1 : 0;
        todo.due_date = sh.payload?.due_date || null;
        todo.snooze_until = sh.payload?.snooze_until || null;
        todo._shared = sh; // keep reference for metadata
      }
    }
  }

  migrateBucketsToCategories();
  syncCategoriesFromTodos();
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

function getFilteredTodosForCategory(category) {
  const now = new Date();
  let filtered = allTodos.filter(t => {
    const cat = t.category || '';
    return cat === category;
  });

  // Apply search filter
  if (todoSearchQuery) {
    const q = todoSearchQuery.toLowerCase();
    filtered = filtered.filter(t =>
      (t.text && t.text.toLowerCase().includes(q)) ||
      ((t.category || '').toLowerCase().includes(q))
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

  // Show page-level empty state when user has zero TODOs and no custom categories
  const categories = getCategories();
  if (allTodos.length === 0 && categories.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list-checks', 48, 'var(--muted)')}</div>
      <h3>${t('todos.empty_title')}</h3>
      <p>${t('todos.empty_hint')}</p>
      <button class="empty-cta" onclick="showTodoGeneralCard()">${lucideIcon('plus', 16)} ${t('todos.empty_cta')}</button>
    </div>`;
    renderCategoryToolbarButtons([]);
    return;
  }

  // Always show General first, then user categories
  const categoryList = ['', ...categories];

  // Render category navigation buttons in toolbar
  renderCategoryToolbarButtons(categoryList);

  let html = '';
  for (const cat of categoryList) {
    // Skip empty categories when searching
    if (todoSearchQuery) {
      const matchingItems = getFilteredTodosForCategory(cat);
      const catName = cat || 'General';
      if (matchingItems.length === 0 && !catName.toLowerCase().includes(todoSearchQuery.toLowerCase())) continue;
    }
    html += renderCategoryCard(cat);
  }

  const scrollY = window.scrollY;
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);

  // Init drag-and-drop for each card (individual TODO items)
  categoryList.forEach(cat => {
    const catId = categoryToDomId(cat);
    initTodoDragDropForCard(catId);
    // Init hover delay for TODO action buttons (same as project tasks)
    const catCard = document.getElementById(catId);
    if (catCard) {
      const list = catCard.querySelector('.todo-cat-list');
      if (list) initTodoHoverDelay(list);
    }
  });

  // Init drag-and-drop for category cards themselves
  initCategoryDragDrop();

  balanceGrid(grid);
}

function renderCategoryToolbarButtons(categoryList) {
  const container = document.getElementById('todoNavButtons');
  if (!container) return;
  container.innerHTML = categoryList.map(cat => {
    const name = cat || 'General';
    const shortname = getCategoryShortname(cat);
    const displayName = shortname || name;
    const color = getCategoryColor(cat);
    return `<button class="category-nav-btn" style="--cat-color:${color}" onclick="navigateToCategory('${escQ(cat)}')" title="Go to ${esc(name)}">${esc(displayName)}</button>`;
  }).join('');
}

function navigateToCategory(category) {
  const catId = categoryToDomId(category);
  const card = document.getElementById(catId);
  if (!card) return;
  scrollToAndHighlight(card, getCategoryColor(category));
  // Focus the input for adding a new TODO
  setTimeout(() => {
    const input = card.querySelector('.todo-cat-input');
    if (input) input.focus();
  }, 400);
}

function categoryToDomId(cat) {
  if (!cat) return 'todo-cat-general';
  return 'todo-cat-' + cat.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
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

function renderCategoryCard(category) {
  const catId = categoryToDomId(category);
  const catName = category || 'General';
  const isGeneral = !category;
  const shortname = getCategoryShortname(category);
  const allInCat = allTodos.filter(t => (t.category || '') === category);
  const pending = allInCat.filter(t => !t.done).length;
  const doneCount = allInCat.filter(t => t.done).length;

  // Split: active items (not done) and done items
  const activeTodos = getFilteredTodosForCategory(category).filter(t => !t.done);
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

  const deleteBtn = !isGeneral
    ? `<button class="todo-cat-delete-btn" onclick="deleteCategory('${escQ(category)}')" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>`
    : '';

  const activeEmptyMsg = displayActive.length === 0
    ? `<p class="empty-msg">${todoFilter === 'pending' ? t('todos.all_caught_up') : t('todos.no_items')}</p>`
    : '';

  const escapedCat = escQ(category);

  const catColor = getCategoryColor(category);

  const catDragHandle = '';

  // Done toggle (collapsible, like archived tasks in projects)
  let doneToggle = '';
  if (doneCount > 0 && todoFilter !== 'done') {
    const deleteAllBtn = `<button class="delete-all-archived-btn" onclick="event.stopPropagation();deleteAllDoneTodos('${escapedCat}')" title="${t('todos.delete_all_done')}">${lucideIcon("trash-2",16)}</button>`;
    doneToggle = `
      <div class="archive-toggle" onclick="toggleDoneTodos('${catId}')" id="done-toggle-${catId}">
        <span class="arrow" id="done-arrow-${catId}">▶</span> ${t('todos.done')} (${doneCount})
        ${deleteAllBtn}
      </div>
      <div class="archived-tasks" id="done-list-${catId}">
        ${doneTodos.map(t => renderTodoItem(t)).join('')}
      </div>`;
  }

  // For the 'done' filter view, show done items in the main list
  const mainListContent = todoFilter === 'done'
    ? (displayDone.length === 0 ? `<p class="empty-msg">${t('todos.no_items')}</p>` : displayDone.map(t2 => renderTodoItem(t2)).join(''))
    : (activeEmptyMsg || displayActive.map(t => renderTodoItem(t)).join(''));

  const shortnameBtn = !isGeneral
    ? `<button class="todo-cat-shortname-btn" onclick="openEditCategoryModal('${escQ(category)}')" title="${t('common.edit')}">${lucideIcon("pencil",14)}</button>`
    : '';

  return `<div class="project-card" id="${catId}" data-category="${esc(category)}" style="--cat-color:${catColor}">
    <div class="todo-cat-header">
      <div class="todo-cat-header-left">
        ${catDragHandle}
        <div class="todo-cat-info">
          <h3 class="todo-cat-name">${esc(catName)}</h3>
          <span class="todo-cat-stats">${statsText}</span>
        </div>
      </div>
      <div class="todo-cat-header-actions">
        ${shortnameBtn}${deleteBtn}
      </div>
    </div>
    <div class="todo-cat-add">
      <input type="text" placeholder="${t('todos.add_todo_placeholder')}" maxlength="2000" class="todo-cat-input" data-category="${esc(category)}" data-priority="medium" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addTodoToCategory(this);}" oninput="updateTodoCharCounter(this)">
      <button class="todo-add-priority-btn" onclick="openQuickAddPriorityPicker(this,event)" title="${esc(t('todos.set_priority'))}">${lucideIcon('flag', 16, '#eab308')}</button>
      <button onclick="addTodoToCategory(this.closest('.todo-cat-add').querySelector('.todo-cat-input'))">${lucideIcon('plus', 16)}</button>
      ${state.sharing?.getAllGroups().length ? `<button class="sharing-share-btn" onclick="shareTodoFromAdd(this)" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
    </div>
    <div class="char-counter" id="todo-counter-${catId}"></div>
    <div class="task-list todo-cat-list" data-category="${esc(category)}">
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
  const flagBtn = !td.done ? `<button class="todo-flag-btn ${isFlagged ? 'flagged' : ''}" onclick="openPriorityPicker('${td.id}', event)" title="${flagTitle}">${flagIcon}</button>` : '';

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
    sharedHtml = sharedBadge(group?.name || '');
  }

  return `<div class="${classes}" data-todo-id="${td.id}">
    <div class="todo-row">
      ${flagBtn}
      <span class="todo-text">${td.text.length > 150 ? truncateWithShowMore(td.text, 150, td.id, 'todo') : renderMd(td.text)}</span>${sharedHtml}
      ${td.done && td.updated_at ? `<span class="todo-completed-date">${new Date(td.updated_at).toLocaleDateString(getLang(), { month: 'short', day: 'numeric' })}</span>` : ''}
      <div class="todo-actions">
        ${!td.done ? `<button onclick="toggleTodo('${td.id}', true)" title="${t('common.done')}">${lucideIcon("circle-check",16)}</button>` : `<button onclick="toggleTodo('${td.id}', false)" title="${t('common.undo')}">${lucideIcon("refresh-cw",16)}</button>`}
        ${!td.done ? `<button onclick="openSnoozeModal('${td.id}')" title="${t('todos.snooze')}">${lucideIcon("moon",16)}</button>` : ''}
        <button onclick="editTodoInline('${td.id}')" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button onclick="deleteTodo('${td.id}')" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
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

function openPriorityPicker(id, event) {
  event.stopPropagation();
  closePriorityPicker();
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  const btn = event.currentTarget;
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
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" onclick="setTodoPriority('${id}','${lv.key}')">${dot}<span>${label}</span></div>`;
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
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" onclick="setQuickAddPriority(this,'${lv.key}')">${dot}<span>${label}</span></div>`;
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
  const category = inputEl.dataset.category || '';
  const priority = inputEl.dataset.priority || 'medium';

  const pendingTodos = allTodos.filter(t => !t.done && (t.category || '') === category);
  const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;

  const { error } = await state.db.from('todos').insert({ text, priority, category, sort_order: minOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  inputEl.value = '';
  // Reset priority to medium after adding
  inputEl.dataset.priority = 'medium';
  const prioBtn = inputEl.closest('.todo-cat-add, .welcome-quick-add')?.querySelector('.todo-add-priority-btn');
  if (prioBtn) updateQuickAddPriorityBtn(prioBtn, 'medium');
  showToast(t('toast.added'), 'success');
  await refreshTodos();
}

async function toggleTodo(id, done) {
  const todo = allTodos.find(t => t.id === id);

  if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
    // ─── Shared: write only to Drive ───
    try {
      if (done) {
        const currentUser = await state.sharing.getCurrentUser();
        await state.sharing.completeItem(todo.shared_group_id, todo.shared_id, [currentUser?.email || '']);
      } else {
        await state.sharing.uncompleteItem(todo.shared_group_id, todo.shared_id);
      }
    } catch (e) { console.warn('Failed to toggle shared todo on Drive:', e); showToast(t('toast.update_failed'), 'error'); return; }
  } else {
    // ─── Normal: write to local DB ───
    const { error } = await state.db.from('todos').update({ done }).eq('id', id);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  }

  showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success');
  await refreshTodos();
}

async function deleteTodo(id) {
  showDeleteConfirm(
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

async function deleteAllDoneTodos(category) {
  const doneTodos = allTodos.filter(t => (t.category || '') === category && t.done);
  if (!doneTodos.length) return;
  const catName = category || 'General';
  showDeleteConfirm(
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
  clearBtn.onclick = (e) => { e.stopPropagation(); deadlineInput.value = ''; };
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
  const cats = ['', ...getCategories()];
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c || 'General';
    if (c === (todo.category || '')) opt.selected = true;
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
      return { due_date: newDeadline, category: catSelect.value };
    },
    saveFn: async (newText, extra) => {
      const updates = {};
      if (newText !== todo.text) updates.text = newText;
      if (extra) {
        const oldDeadline = todo.due_date || null;
        if (extra.due_date !== oldDeadline) updates.due_date = extra.due_date;
        const oldCategory = todo.category || '';
        if (extra.category !== oldCategory) updates.category = extra.category;
      }
      if (Object.keys(updates).length > 0) {
        if (todo.shared_id && todo.shared_group_id && state.sharing) {
          // ─── Shared: category to local pointer, text/priority/due_date to Drive ───
          if (updates.category !== undefined) {
            await state.db.from('todos').update({ category: updates.category }).eq('id', id);
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

  // Re-render shared TODOs when sharing data changes (poll, join, etc.)
  document.addEventListener('sharing-changed', () => syncSharedTodos());

  // Snooze Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'snoozeModal';
  m1.innerHTML = `<div class="modal snooze-modal"><h2>${lucideIcon("clock",20)} ${t('todos.snooze')}</h2><p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">${t('todos.snooze_hint')}</p><div class="snooze-options"><button onclick="snoozeFor(1,'h')">${t('todos.snooze_1h')}</button><button onclick="snoozeFor(3,'h')">${t('todos.snooze_3h')}</button><button onclick="snoozeFor(1,'d')">${t('todos.snooze_1d')}</button><button onclick="snoozeFor(3,'d')">${t('todos.snooze_3d')}</button><button onclick="snoozeFor(7,'d')">${t('todos.snooze_1w')}</button><button onclick="snoozeFor(1,'M')">${t('todos.snooze_1m')}</button></div><label style="margin-top:12px;">Or pick a date & time:</label><input type="datetime-local" id="snoozeCustomDate" style="width:100%;margin-top:4px;"><input type="hidden" id="snoozeTaskId"><div class="modal-actions"><button class="modal-cancel" onclick="closeSnoozeModal()">${t('common.cancel')}</button><button class="modal-save" onclick="submitSnooze()">${t('todos.snooze')}</button></div></div>`;
  app.appendChild(m1);

  // Add Category Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'addCategoryModal';
  m2.innerHTML = `<div class="modal"><h2>${lucideIcon("folder-plus",20)} ${t('todos.add_category')}</h2><label>${t('todos.category_name')}</label><input type="text" id="newCategoryName" placeholder="${t('todos.category_placeholder')}" maxlength="40" onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewCategory();}"><div class="modal-actions"><button class="modal-cancel" onclick="closeAddCategoryModal()">${t('common.cancel')}</button><button class="modal-save" onclick="saveNewCategory()">${t('common.add')}</button></div></div>`;
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

function saveNewCategory() {
  const input = document.getElementById('newCategoryName');
  const name = input.value.trim();
  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  const categories = getCategories();
  if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
    showToast(t('toast.name_required'), 'error');
    return;
  }

  categories.push(name);
  saveCategories(categories);
  closeAddCategoryModal();
  showToast(t('toast.added'), 'success');
  renderTodos();
}

async function deleteCategory(name) {
  const todosInCat = allTodos.filter(t => t.category === name);
  const msg = todosInCat.length > 0
    ? `Delete "${name}" and its ${todosInCat.length} TODO(s)?`
    : `Delete empty category "${name}"?`;

  showDeleteConfirm(t('common.delete'), msg, async () => {
    // Delete all todos in this category in bulk
    if (todosInCat.length) await state.db.from('todos').delete().eq('category', name);
    const categories = getCategories();
    const idx = categories.findIndex(c => c === name);
    if (idx !== -1) {
      categories.splice(idx, 1);
      saveCategories(categories);
    }
    // Clean up color
    const colorMap = getCategoryColors();
    delete colorMap[name];
    saveCategoryColors(colorMap);
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

    header.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a, input, textarea, select, .todo-cat-header-actions')) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      pressTimer = setTimeout(() => {
        activated = true;
        const rect = card.getBoundingClientRect();
        setDragging(true);
        dragState = { el: card, category, offsetY: e.clientY - rect.top, offsetX: e.clientX - rect.left, clone: null };
        const clone = card.cloneNode(true);
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);border-radius:12px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        card.classList.add('dragging');
        header.setPointerCapture(e.pointerId);
      }, LONG_PRESS_MS);
    });

    header.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer); pressTimer = null;
        }
        return;
      }
      if (!dragState || dragState.el !== card) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.clone.style.left = (e.clientX - dragState.offsetX) + 'px';
      grid.querySelectorAll('.project-card:not(.dragging)').forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });

    const finishDrag = async () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!dragState || dragState.el !== card) return;
      if (dragState.clone) dragState.clone.remove();
      card.classList.remove('dragging');
      let targetCategory = null;
      grid.querySelectorAll('.project-card').forEach(el => {
        if (el.classList.contains('drag-over')) { targetCategory = el.dataset.category || ''; el.classList.remove('drag-over'); }
      });
      const draggedCategory = dragState.category;
      dragState = null;
      setDragging(false);
      if (targetCategory !== null && targetCategory !== draggedCategory && draggedCategory !== '' && targetCategory !== '') {
        await reorderCategories(draggedCategory, targetCategory);
      }
    };

    header.addEventListener('pointerup', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    header.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    header.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragState && dragState.el === card) {
        if (dragState.clone) dragState.clone.remove();
        card.classList.remove('dragging');
        grid.querySelectorAll('.project-card').forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        setDragging(false);
      }
    });
  });
}

async function reorderCategories(draggedName, targetName) {
  const grid = document.getElementById('todoCategoryGrid');
  const categories = getCategories();
  const draggedIdx = categories.findIndex(c => c === draggedName);
  const targetIdx = categories.findIndex(c => c === targetName);
  if (draggedIdx === -1 || targetIdx === -1) return;
  const [dragged] = categories.splice(draggedIdx, 1);
  categories.splice(targetIdx, 0, dragged);
  saveCategories(categories);

  // Move DOM elements instead of full re-render
  const cards = Array.from(grid.querySelectorAll('.project-card'));
  // General card (empty category) stays first
  const generalCard = cards.find(c => (c.dataset.category || '') === '');
  // Reorder non-general cards to match categories order
  categories.forEach(catName => {
    const card = cards.find(c => c.dataset.category === catName);
    if (card) grid.appendChild(card);
  });

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
  // Index local shared todos by shared_id
  const localShared = allTodos.filter(t => t.shared_id);
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
        text: '', category: '', priority: 'medium', done: false,
        shared_id: sh.id, shared_group_id: sh.group_id,
      });
      if (error) { console.warn('syncSharedTodos: failed to create pointer', sh.id, error); continue; }
      needsRefresh = true;
    }
  }

  // ─── Deletion: local shared todos whose shared_id no longer exists on Drive ───
  for (const local of localShared) {
    if (!driveSharedIds.has(local.shared_id)) {
      // Check the group still exists (don't delete if group just hasn't loaded yet)
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        await state.db.from('todos').delete().eq('id', local.id);
        needsRefresh = true;
      }
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
  const category = input.dataset.category || '';
  const priority = input.dataset.priority || 'medium';

  openSharePopover(btn, async (groupId, assignees) => {
    try {
      // Insert local pointer FIRST to prevent syncSharedTodos race
      // (addItem emits sharing-changed before we return here)
      const sharedId = crypto.randomUUID();
      const pendingTodos = allTodos.filter(t => !t.done && (t.category || '') === category);
      const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;
      const { data: localRow, error: localErr } = await state.db.from('todos').insert({
        text: '', priority: 'medium', done: false,
        category,
        sort_order: minOrder,
        shared_id: sharedId,
        shared_group_id: groupId,
      }).select().single();
      if (localErr) { showToast(localErr.message, 'error'); return; }

      try {
        await state.sharing.addItem(groupId, {
          id: sharedId,
          item_type: 'todo',
          payload: { text, category, priority },
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
  });
}

window.shareTodoFromAdd = shareTodoFromAdd;

export { refreshTodos, renderTodos, getCategoryColor, getCategoryColors, setCategoryColor, loadTodoCategoryMeta, initTodoModals, getTodoCounts, getTodos };

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
  const categoryList = [''];
  grid.innerHTML = renderCategoryCard('');
  const catId = categoryToDomId('');
  initTodoDragDropForCard(catId);
  const catCard = document.getElementById(catId);
  if (catCard) {
    const list = catCard.querySelector('.todo-cat-list');
    if (list) initTodoHoverDelay(list);
    const input = catCard.querySelector('.todo-cat-input');
    if (input) setTimeout(() => input.focus(), 100);
  }
  renderCategoryToolbarButtons(categoryList);
  balanceGrid(grid);
};
window.filterTodos = function(e) { todoSearchQuery = e.target.value; renderTodos(); };
window.renderTodos = renderTodos;
