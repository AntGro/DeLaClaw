import { lucideIcon } from './icons.js';
import state, { TODO_MAX_LEN, GENERAL_CATEGORY_COLOR, SHARED_CATEGORY } from './state.js';
import { esc, escQ, renderMd, showToast, showConfirmAction, formatRelativeDate, truncateWithShowMore, balanceGrid, applySectionGrid, fetchAll, backfillCategoryColors, nextPaletteColor, autoResizeTextarea, snapshotTextInputs, restoreTextInputs } from './utils.js';
import { isSectionRow, normalizeSectionFields, parseSectionPath, buildSectionTree, pathLabelOf, descendantsOf, descendantBucketIds, siblingNameTaken, orderKeyOf, compareOrderKeys } from './sections-pure.js';
import { cleanupDragArtifacts, initItemHoverDelay, initItemDragDrop, reorderItems, bulkSortOrder, scrollToAndHighlight, inlineEditText, initNavBtnReorder, snapshotBuckets, animateBucketsFromSnapshot, captureInnerScrollPositions, restoreInnerScrollPositions, animateItemRemoval } from './item-utils.js';
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

let _todoCatByPath = new Map(); // lowercase full path ('Reading > Fiction') → row
let _todoTree = { roots: [], byId: new Map() };

async function loadTodoCategories() {
  const { data, error } = await state.db.from('todo_categories').select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('loadTodoCategories error:', error); return; }
  _todoCatMap.clear();
  _todoCatByName.clear();
  _defaultCatId = null;
  _sharedCatId = null;
  for (const row of (data || [])) {
    normalizeSectionFields(row);
    _todoCatMap.set(row.id, row);
    _todoCatByName.set(row.name, row);
    if (row.is_protected && row.name === SHARED_CATEGORY) _sharedCatId = row.id;
    else if (row.is_protected && row.name !== SHARED_CATEGORY) _defaultCatId = row.id;
  }
  _todoTree = buildSectionTree([..._todoCatMap.values()]);
  _todoCatByPath.clear();
  for (const node of _todoTree.byId.values()) {
    _todoCatByPath.set(pathLabelOf(node, _todoTree.byId).toLowerCase(), node.row);
  }
  await backfillCategoryColors('todo_categories', _todoCatMap);
}

/** Full display path of a category ('Reading > Fiction'); buckets at the
 *  top level and the special rows keep their plain display name. */
function getTodoCatPath(catId) {
  const node = _todoTree.byId.get(catId);
  if (!node || !node.parentId) return getCatDisplayName(catId);
  return pathLabelOf(node, _todoTree.byId);
}

/** Tree ordering key for a category (see sections-pure.orderKeyOf). */
function getTodoCatOrderKey(catId) {
  const node = _todoTree.byId.get(catId);
  return node ? orderKeyOf(node, _todoTree.byId) : [0];
}

// ── Nested sections ────────────────────────────────────────────────
// Sections and buckets share the todo_categories table (kind +
// parent_id). All helpers below reload the category maps after each
// write so callers always resolve rows by (parent, name) against fresh
// state, on every adapter.
const SECTION_DEFAULT_COLOR = '#94a3b8';

function todoChildRow(parentId, name) {
  const target = (name || '').trim().toLowerCase();
  for (const node of _todoTree.byId.values()) {
    if ((node.parentId || null) === (parentId || null) && (node.row.name || '').trim().toLowerCase() === target) return node.row;
  }
  return null;
}

function nextTodoSortOrder(parentId) {
  let max = -1;
  for (const node of _todoTree.byId.values()) {
    if ((node.parentId || null) === (parentId || null)) max = Math.max(max, Number(node.row.sort_order) || 0);
  }
  return max + 1;
}

/** Convert a bucket row into a section: its items move to a new '*'
 *  bucket inside it (items never sit directly at section level). */
async function convertTodoBucketToSection(cat) {
  const { error } = await state.db.from('todo_categories').insert({
    name: '*', shortname: null, color: cat.color || SECTION_DEFAULT_COLOR,
    sort_order: 0, kind: 'bucket', parent_id: cat.id,
  });
  if (error) throw error;
  await loadTodoCategories();
  const star = todoChildRow(cat.id, '*');
  if (star) {
    const { data: items } = await state.db.from('todos').select('id').eq('category_id', cat.id);
    for (const item of (items || [])) {
      await state.db.from('todos').update({ category_id: star.id, category: '*' }).eq('id', item.id);
    }
  }
  await state.db.from('todo_categories').update({ kind: 'section', shortname: null }).eq('id', cat.id);
  await loadTodoCategories();
}

/**
 * Walk path segments from a starting parent, creating sections where
 * missing and converting buckets where one blocks the path. Returns the
 * id of the deepest section (or the starting parent when segments is
 * empty). Throws when a segment would place a row inside itself or one
 * of its own descendants (guardId).
 */
async function ensureTodoSectionChain(segments, startParentId = null, guardId = null) {
  let parentId = startParentId || null;
  for (const seg of (segments || [])) {
    let row = todoChildRow(parentId, seg);
    if (row && guardId && (row.id === guardId || descendantsOf(_todoTree.byId.get(guardId) || { children: [] }).some(n => n.id === row.id))) {
      throw new Error('section-cycle');
    }
    if (!row) {
      const { error } = await state.db.from('todo_categories').insert({
        name: seg, shortname: null, color: SECTION_DEFAULT_COLOR,
        sort_order: nextTodoSortOrder(parentId), kind: 'section', parent_id: parentId,
      });
      if (error) throw error;
      await loadTodoCategories();
      row = todoChildRow(parentId, seg);
      if (!row) throw new Error('section-create-failed');
    } else if (!isSectionRow(row)) {
      await convertTodoBucketToSection(row);
      row = _todoCatMap.get(row.id);
    }
    parentId = row.id;
  }
  return parentId;
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
  const modal = document.getElementById('editCategoryModal');
  modal.innerHTML = editCategoryModalHTML();
  document.getElementById('editCategoryOldName').value = catId; // store ID, not name
  document.getElementById('editCategoryName').value = cat.name;
  document.getElementById('editCategoryShortname').value = cat.shortname || '';
  document.getElementById('editCategoryColor').value = cat.color || GENERAL_CATEGORY_COLOR;
  populateTodoParentSelect(cat);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('editCategoryName').focus(), 50);
}

function closeEditCategoryModal() {
  document.getElementById('editCategoryModal').classList.remove('visible');
}

async function saveEditCategory() {
  const catId = document.getElementById('editCategoryOldName').value;
  const cat = _todoCatMap.get(catId);
  if (!cat) return;
  const rawName = document.getElementById('editCategoryName').value.trim();
  const shortname = document.getElementById('editCategoryShortname').value.trim();
  const color = document.getElementById('editCategoryColor').value;

  // The parent picker chooses the parent; typing a path in the name
  // field overrides it (the last segment becomes the row's own name).
  let targetName = rawName;
  let targetParentId = document.getElementById('editCategoryParent')?.value || null;
  if (!cat.is_protected && rawName.includes('>')) {
    const segments = parseSectionPath(rawName);
    if (!segments.length) { showToast(t('toast.name_required'), 'error'); return; }
    targetName = segments[segments.length - 1];
    try {
      targetParentId = await ensureTodoSectionChain(segments.slice(0, -1), null, catId);
    } catch (e) {
      showToast(t('toast.name_required'), 'error');
      return;
    }
  }
  if (!targetName && !cat.is_protected) { showToast(t('toast.name_required'), 'error'); return; }
  if (cat.is_protected) targetParentId = null;
  if (!cat.is_protected && siblingNameTaken([..._todoCatMap.values()], targetParentId, targetName, catId)) {
    showToast(t('toast.name_required'), 'error');
    return;
  }

  // Update the DB row directly — items reference categories by ID, and
  // a section rename needs no descendant writes (paths are derived).
  const oldShortname = cat.shortname;
  const oldName = cat.name;
  const isSection = isSectionRow(cat);
  const updates = { shortname: isSection ? null : (shortname || null), color, parent_id: targetParentId };
  if (!cat.is_protected) updates.name = targetName;
  if (targetParentId !== (cat.parent_id || null)) updates.sort_order = nextTodoSortOrder(targetParentId);
  await state.db.from('todo_categories').update(updates).eq('id', catId);
  await loadTodoCategories();

  // Calendar: bucket labels appear in event summaries, so a bucket
  // rename resyncs. Sections never appear there — renaming or moving a
  // section must not touch the calendar.
  if (!isSection && (updates.shortname !== oldShortname || updates.name !== oldName)) {
    window.markCategoryRenamed?.('todo_categories');
  }

  closeEditCategoryModal();
  renderTodos();
  showToast(t('toast.updated'), 'success');
}


let _lastRefreshTodos = 0;
async function refreshTodos() {
  if (!state.db.connected) return;
  // Cooldown: skip if a refresh completed within 500ms (avoids double-fetch
  // when explicit refresh + realtime-triggered refresh fire back-to-back).
  const now = Date.now();
  if (now - _lastRefreshTodos < 500) return;
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
        todo.priority = sh.payload?.priority || 'normal';
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
      gidArr.forEach((gid, i) => { if (members[i]?.member_id) memberIdPerGroup.set(gid, members[i].member_id); });
      for (const todo of allTodos) {
        if (!todo._shared || !todo.shared_group_id) continue;
        const myId = memberIdPerGroup.get(todo.shared_group_id);
        if (myId && todo._shared.created_by === myId) _myCreatedSharedIds.add(todo.shared_id);
      }
    }

    // Drop shared pointers whose remote data couldn't be resolved
    allTodos = allTodos.filter(t => !t.shared_id || t._shared);
  }

  _lastRefreshTodos = Date.now();

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
  } else if (todoFilter === 'snoozed') {
    filtered = filtered.filter(t => !t.done && t.snooze_until && new Date(t.snooze_until) > now);
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

  // A background sharing sync can re-render while the user is typing in a
  // quick-add box — keep the in-progress text (and focus) across the render.
  const pendingInputs = snapshotTextInputs(grid, '.todo-cat-input', 'data-category');

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

  // Root-level nodes (buckets + sections) in tree order. The Shared deck
  // is a synthetic root bucket, always first, never inside a section.
  const rootNodes = _todoTree.roots.filter(n => n.id !== _sharedCatId);
  const rootIds = rootNodes.map(n => n.id);
  const hasSharedItems = allTodos.some(td => catIdForTodo(td) === _sharedCatId);
  const toolbarIds = hasSharedItems && _sharedCatId ? [_sharedCatId, ...rootIds] : rootIds;

  renderCategoryToolbarButtons(toolbarIds);
  initTodoNavBtnReorder();

  let html = '';
  if (hasSharedItems && _sharedCatId) html += renderCategoryCard(_sharedCatId);
  html += renderTodoLevel(rootNodes, false);

  const scrollY = window.scrollY;
  const innerScrolls = captureInnerScrollPositions(grid);
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);
  restoreInnerScrollPositions(grid, innerScrolls);
  restoreTextInputs(grid, '.todo-cat-input', 'data-category', pendingInputs);

  // Init drag-and-drop for each bucket card (individual TODO items)
  const bucketIds = [];
  if (hasSharedItems && _sharedCatId) bucketIds.push(_sharedCatId);
  for (const node of _todoTree.byId.values()) if (node.kind === 'bucket' && node.id !== _sharedCatId) bucketIds.push(node.id);
  bucketIds.forEach(catId => {
    const domId = categoryToDomId(catId);
    initTodoDragDropForCard(domId);
    const catCard = document.getElementById(domId);
    if (catCard) {
      const list = catCard.querySelector('.todo-cat-list');
      if (list) initTodoHoverDelay(list);
    }
  });
  // Chip reorder inside each section (sibling group only)
  for (const node of _todoTree.byId.values()) {
    if (node.kind === 'section') initTodoSectionNavBtnReorder(node.id);
  }

  applySectionGrid(grid);
}

/** Is a tree node visible under the current search query? */
function todoNodeSearchVisible(node, ancestorMatched) {
  if (!todoSearchQuery) return true;
  const q = todoSearchQuery.toLowerCase();
  const name = (node.row.name || '').toLowerCase();
  if (ancestorMatched || name.includes(q)) return true;
  if (node.kind === 'bucket') {
    return getFilteredTodosForCategory(node.id).length > 0;
  }
  return node.children.some(c => todoNodeSearchVisible(c, false));
}

function renderTodoLevel(nodes, ancestorMatched) {
  let html = '';
  for (const node of nodes) {
    if (!todoNodeSearchVisible(node, ancestorMatched)) continue;
    const matched = ancestorMatched || (todoSearchQuery && (node.row.name || '').toLowerCase().includes(todoSearchQuery.toLowerCase()));
    html += node.kind === 'section' ? renderTodoSection(node, matched) : renderCategoryCard(node.id);
  }
  return html;
}

function renderTodoSection(node, ancestorMatched = false) {
  const cat = node.row;
  const bucketIds = descendantBucketIds(node);
  const total = allTodos.filter(td => bucketIds.includes(catIdForTodo(td))).length;
  const pending = allTodos.filter(td => bucketIds.includes(catIdForTodo(td)) && !td.done).length;
  const chips = node.children.map(child => {
    const childCat = child.row;
    const isSec = child.kind === 'section';
    const count = isSec
      ? allTodos.filter(td => descendantBucketIds(child).includes(catIdForTodo(td))).length
      : allTodos.filter(td => catIdForTodo(td) === child.id).length;
    const label = isSec ? (childCat.name || '') : getCatDisplayName(child.id);
    const color = childCat.color || GENERAL_CATEGORY_COLOR;
    const action = isSec ? 'navigate-to-todo-section' : 'navigate-to-category';
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="${action}" data-category="${esc(child.id)}" title="${esc(label)}">${esc(label)} (${count})</button>`;
  }).join('');
  const childrenHtml = renderTodoLevel(node.children, ancestorMatched)
    || `<p class="empty-msg">${t('common.section_empty')}</p>`;
  return `<div class="section-block" id="todo-section-${esc(cat.id)}" data-node-kind="section" data-node-id="${esc(cat.id)}" style="--cat-color:${cat.color || SECTION_DEFAULT_COLOR}">
    <div class="section-header">
      <div class="section-header-left">
        <h3 class="section-name">${lucideIcon('folder', 16)} ${esc(cat.name || '')}</h3>
        <span class="section-stats">${pending} ${t('todos.pending').toLowerCase()} · ${total}</span>
      </div>
      <div class="section-header-actions">
        <button class="todo-cat-shortname-btn" data-action="open-add-category-in-section" data-category="${esc(cat.id)}" title="${esc(t('todos.add_category'))}">${lucideIcon('folder-plus', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="todocat" data-id="${esc(cat.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="open-edit-category-modal" data-category="${esc(cat.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 14)}</button>
        <button class="todo-cat-delete-btn" data-action="delete-section" data-category="${esc(cat.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
    <div class="category-nav-buttons section-chips" id="todoSectionChips-${esc(cat.id)}">${chips}</div>
    <div class="section-level">${childrenHtml}</div>
  </div>`;
}

function navigateToTodoSection(sectionId) {
  const el = document.getElementById('todo-section-' + sectionId);
  if (!el) return;
  const cat = _todoCatMap.get(sectionId);
  scrollToAndHighlight(el, cat?.color || SECTION_DEFAULT_COLOR);
}

function renderCategoryToolbarButtons(categoryIdList) {
  const container = document.getElementById('todoNavButtons');
  if (!container) return;
  container.innerHTML = categoryIdList.map(catId => {
    const cat = _todoCatMap.get(catId);
    if (!cat) return '';
    const isShared = cat.name === SHARED_CATEGORY;
    const isSection = isSectionRow(cat);
    const name = getCatDisplayName(catId);
    const shortname = isSection ? null : cat.shortname;
    const displayName = isShared ? t('sharing.shared') : (shortname || name);
    const color = cat.color || GENERAL_CATEGORY_COLOR;
    const action = isSection ? 'navigate-to-todo-section' : 'navigate-to-category';
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="${action}" data-category="${esc(catId)}" title="Go to ${esc(name)}">${esc(displayName)}</button>`;
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
  if (todoFilter === 'snoozed') {
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
  const shareAllBtn = (!isSharedDeck && state.sharing && shareableCount > 0)
    ? `<button class="todo-cat-shortname-btn" data-action="bulk-share-todo-category" data-category="${esc(catId)}" title="${esc(t('sharing.share_all'))}">${lucideIcon("share",14)}</button>`
    : '';

  const shortnameBtn = (!isGeneral && !isSharedDeck && !cat.is_protected)
    ? `<button class="todo-cat-shortname-btn" data-action="open-edit-category-modal" data-category="${esc(catId)}" title="${t('common.edit')}">${lucideIcon("pencil",14)}</button>`
    : '';

  const headerIcon = isSharedDeck ? `${lucideIcon('users', 16)} ` : '';

  const addRow = isSharedDeck ? '' : `<div class="todo-cat-add">
      <textarea placeholder="${t('todos.add_todo_placeholder')}" maxlength="2000" class="todo-cat-input" data-category="${esc(catId)}" data-priority="normal" data-action="add-todo-to-category" rows="1" style="resize:none;overflow:hidden;"></textarea>
      <button class="todo-add-priority-btn" data-action="open-quick-add-priority-picker" title="${esc(t('todos.set_priority'))}">${lucideIcon('circle-off', 16, 'var(--muted)')}</button>
      <button data-action="add-todo-from-add-row">${lucideIcon('plus', 16)}</button>
      ${state.sharing ? `<button class="sharing-share-btn" data-action="share-todo-from-add" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
    </div>
    <div class="char-counter" id="todo-counter-${domId}"></div>`;

  return `<div class="project-card" id="${domId}" data-category="${esc(catId)}" data-node-kind="bucket" data-node-id="${esc(catId)}" style="--cat-color:${catColor}">
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

function renderTodoItem(td) {
  const now = new Date();
  const isOverdue = td.due_date && !td.done && new Date(td.due_date) < now;
  const isSnoozed = td.snooze_until && new Date(td.snooze_until) > now;
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
    snoozeInfo = `<span class="todo-snoozed">${lucideIcon("moon",16)} ${t('todos.snoozed_until')} ${new Date(td.snooze_until).toLocaleString(getLang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  const priorityClass = isFlagged ? `todo-priority-${td.priority}` : '';
  const classes = [
    'bucket-item',
    'todo-item',
    td.done ? 'todo-done' : '',
    isOverdue ? 'todo-overdue' : '',
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
        ${!td.done ? (isSnoozed ? `<button data-action="unsnooze-todo" data-id="${esc(td.id)}" title="${t('todos.unsnooze')}">${lucideIcon("moon-off",16)}</button>` : `<button data-action="open-snooze-modal" data-id="${esc(td.id)}" title="${t('todos.snooze')}">${lucideIcon("moon",16)}</button>`) : ''}
        ${!isShared && !td.done && state.sharing ? `<button data-action="share-existing-todo" data-id="${esc(td.id)}" title="${t('sharing.share')}">${lucideIcon("share",16)}</button>` : ''}
        ${isShared && !td.done && _myCreatedSharedIds.has(td.shared_id) ? `<button data-action="unshare-todo" data-id="${esc(td.id)}" title="${t('sharing.unshare')}">${lucideIcon("share-off",16)}</button>` : ''}
        ${isShared && !td.done && !_myCreatedSharedIds.has(td.shared_id) ? `<button data-action="copy-todo-to-personal" data-id="${esc(td.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon("copy",16)}</button>` : ''}
        <button data-action="copy-item-link" data-link-type="todo" data-id="${esc(td.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon("link",16)}</button>
        <button data-action="edit-todo-inline" data-id="${esc(td.id)}" title="${t('common.edit')}">${lucideIcon("pencil",16)}</button>
        <button data-action="delete-todo" data-id="${esc(td.id)}" title="${t('common.delete')}">${lucideIcon("trash-2",16)}</button>
      </div>
    </div>
    ${dueDateStr || snoozeInfo ? `<div class="todo-meta">${dueDateStr}${snoozeInfo}</div>` : ''}
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
  const existing = document.getElementById('priorityPickerPopover');
  if (existing) { closePriorityPicker(); return; }
  closePriorityPicker();
  const todo = allTodos.find(t => t.id === id);
  if (!todo) return;
  const btn = triggerEl || (event.currentTarget instanceof HTMLElement && event.currentTarget !== document ? event.currentTarget : event.target?.closest('[data-action="open-priority-picker"]')) || event.target;
  const itemEl = btn.closest('.todo-item');
  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.className = 'priority-picker';
  picker.id = 'priorityPickerPopover';

  // If inline edit is active, use the pending priority for the active marker
  const flagBtn = btn.closest('.todo-item')?.querySelector('.todo-flag-btn');
  const currentPrio = flagBtn?.dataset.pendingPriority || todo.priority || 'normal';

  picker.innerHTML = PRIORITY_LEVELS.map(lv => {
    const isActive = currentPrio === lv.key;
    const label = t(`todos.priority_${lv.key}`) || lv.key;
    const dot = lv.color
      ? `<span class="priority-picker-dot" style="background:${lv.color}"></span>`
      : `${lucideIcon('circle-off', 14, 'var(--muted)')}`;
    return `<div class="priority-picker-option${isActive ? ' active' : ''}" data-action="set-todo-priority" data-id="${esc(id)}" data-priority="${esc(lv.key)}">${dot}<span>${label}</span></div>`;
  }).join('');

  document.body.appendChild(picker);

  // If inline edit is active, prevent picker interactions from triggering
  // the focusout→cancel handler by keeping focus on the edit input.
  const editWrapper = itemEl?.querySelector('.todo-edit-wrapper');
  if (editWrapper) {
    picker.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus on the edit input
    });
  }

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
    window.addEventListener('scroll', closePriorityPicker, { once: true, capture: true });
  }, 0);
}

function closePriorityPicker() {
  const el = document.getElementById('priorityPickerPopover');
  if (el) el.remove();
  document.removeEventListener('click', closePriorityPicker);
  window.removeEventListener('scroll', closePriorityPicker, { capture: true });
}

function updateQuickAddPriorityBtn(btn, level) {
  const lv = PRIORITY_LEVELS.find(l => l.key === level) || PRIORITY_LEVELS.find(l => l.key === 'normal');
  const color = lv.color || 'var(--muted)';
  const iconName = level === 'urgent' ? 'alert-triangle' : (level === 'normal' ? 'circle-off' : 'flag');
  btn.innerHTML = lucideIcon(iconName, 16, color);
  btn.dataset.priority = level;
}

function openQuickAddPriorityPicker(btn, event) {
  event.stopPropagation();
  const existing = document.getElementById('priorityPickerPopover');
  if (existing) { closePriorityPicker(); return; }
  closePriorityPicker();
  _lastQuickAddPrioBtn = btn;
  const rect = btn.getBoundingClientRect();
  const container = btn.closest('.todo-cat-add, .welcome-quick-add');
  const inputEl = container?.querySelector('.todo-cat-input');
  const currentPriority = inputEl?.dataset.priority || 'normal';

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

  setTimeout(() => {
    document.addEventListener('click', closePriorityPicker, { once: true });
    window.addEventListener('scroll', closePriorityPicker, { once: true, capture: true });
  }, 0);
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

  // If inline edit is active for this TODO, defer the change — save it
  // visually and let collectExtra pick it up on confirm.
  const itemEl = document.querySelector(`.todo-item[data-todo-id="${id}"]`);
  const isEditing = itemEl?.querySelector('.todo-edit-wrapper');
  if (isEditing) {
    const flagBtn = itemEl.querySelector('.todo-flag-btn');
    if (flagBtn) {
      flagBtn.dataset.pendingPriority = level;
      // Update flag icon visually
      const prioColors = { urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6' };
      const color = prioColors[level] || null;
      const iconName = level === 'urgent' ? 'alert-triangle' : (level === 'normal' ? 'circle-off' : 'flag');
      flagBtn.innerHTML = color ? lucideIcon(iconName, 14, color) : lucideIcon('circle-off', 14, 'var(--muted)');
      flagBtn.classList.toggle('flagged', level && level !== 'normal');
    }
    // Refocus the edit textarea so focusout/cancel mechanics stay intact
    const editInput = isEditing.querySelector('textarea');
    if (editInput) editInput.focus();
    return;
  }

  const todo = allTodos.find(t => t.id === id);

  if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
    // ─── Shared: write only to Drive (optimistic — refresh on staging) ───
    let onStaged;
    const staged = new Promise(resolve => { onStaged = resolve; });
    const label = t(`todos.priority_${level}`) || level;
    const upload = state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
      payload: { text: todo.text, category: todo.category || '', priority: level },
    }, { onStaged });
    upload.then(
      () => showToast(label, 'success'),
      async (e) => {
        console.warn('Failed to update shared todo priority on Drive:', e);
        await refreshTodos();
        showToast(t('toast.update_failed'), 'error');
      }
    );
    await Promise.race([staged, upload.then(() => {}, () => {})]);
  } else {
    // ─── Normal: write to local DB ───
    const { error } = await state.db.from('todos').update({ priority: level }).eq('id', id);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
    const label = t(`todos.priority_${level}`) || level;
    showToast(label, 'success');
  }

  await refreshTodos();
}


async function addTodoToCategory(inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  const catId = inputEl.dataset.category || _defaultCatId;
  const cat = _todoCatMap.get(catId);
  const priority = inputEl.dataset.priority || 'normal';

  const pendingTodos = allTodos.filter(t => !t.done && catIdForTodo(t) === catId);
  const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;

  const { error } = await state.db.from('todos').insert({ text, priority, category: cat?.name ?? '', category_id: catId, sort_order: minOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  inputEl.value = '';
  if (inputEl.tagName === 'TEXTAREA') { inputEl.style.height = ''; }
  // Reset priority to medium after adding
  inputEl.dataset.priority = 'normal';
  const prioBtn = inputEl.closest('.todo-cat-add, .welcome-quick-add')?.querySelector('.todo-add-priority-btn');
  if (prioBtn) updateQuickAddPriorityBtn(prioBtn, 'normal');
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
      // Optimistic: the sharing layer stages the change in memory (onStaged)
      // and uploads in the background; a failed upload rolls the memory back.
      let onStaged;
      const staged = new Promise(resolve => { onStaged = resolve; });
      const upload = done
        ? state.sharing.completeItem(todo.shared_group_id, todo.shared_id, undefined, { onStaged })
        : state.sharing.uncompleteItem(todo.shared_group_id, todo.shared_id, { onStaged });
      upload.then(
        () => showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success'),
        async (e) => {
          console.warn('Failed to toggle shared todo on Drive:', e);
          await refreshTodos();
          showToast(t('toast.update_failed'), 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
    } else {
      const { error } = await state.db.from('todos').update({ done }).eq('id', id);
      if (error) { showToast(t('toast.update_failed'), 'error'); return; }
      showToast(done ? t('common.done') + '!' : t('common.reopen'), 'success');
    }

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
      const pointerRow = todo ? { ...todo } : null;
      const { error } = await state.db.from('todos').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }

      // Delete from Drive if shared (removes for all group members). The
      // upload runs in the background; a failure restores the pointer row.
      if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteItem(todo.shared_group_id, todo.shared_id, { onStaged });
        upload.then(
          () => {},
          async (e) => {
            console.warn('Failed to delete shared todo from Drive:', e);
            if (pointerRow) await state.db.from('todos').insert(pointerRow);
            await refreshTodos();
            showToast(t('toast.delete_failed'), 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
      }

      // Animate item out before re-rendering
      const el = document.querySelector(`[data-todo-id="${CSS.escape(id)}"]`);
      await animateItemRemoval(el);

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
      const pointerRows = [];
      for (const td of doneTodos) {
        if (td.shared_id && td.shared_group_id) pointerRows.push({ ...td });
        await state.db.from('todos').delete().eq('id', td.id);
      }
      // Shared deletes upload in the background; failures restore the pointer rows.
      if (state.sharing && pointerRows.length) {
        (async () => {
          const failed = [];
          for (const pr of pointerRows) {
            try {
              await state.sharing.deleteItem(pr.shared_group_id, pr.shared_id);
            } catch (e) {
              console.warn('Failed to delete shared todo from Drive:', e);
              failed.push(pr);
            }
          }
          if (failed.length) {
            for (const pr of failed) await state.db.from('todos').insert(pr);
            await refreshTodos();
            showToast(t('toast.delete_failed'), 'error');
          }
        })();
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

  // Clear any stale pending priority from a previous cancelled edit
  const existingFlag = itemEl.querySelector('.todo-flag-btn');
  if (existingFlag) delete existingFlag.dataset.pendingPriority;

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
  // Buckets only (a TODO can never sit in a section), tree order, full
  // path labels so same-named buckets stay distinguishable.
  const catRows = [..._todoTree.byId.values()]
    .filter(n => n.kind === 'bucket' && n.id !== _sharedCatId)
    .sort((a, b) => compareOrderKeys(orderKeyOf(a, _todoTree.byId), orderKeyOf(b, _todoTree.byId)))
    .map(n => n.row);
  // Include Shared in dropdown if the todo is in the shared deck (so user can move it out)
  const todoCatId = catIdForTodo(todo);
  if (todoCatId === _sharedCatId) {
    const sharedCat = _todoCatMap.get(_sharedCatId);
    if (sharedCat) catRows.unshift(sharedCat);
  }
  catRows.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name === SHARED_CATEGORY ? t('sharing.shared') : (c.name === '' ? t('common.category_default') : getTodoCatPath(c.id));
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
    containerEl: itemEl,
    collectExtra: () => {
      const newDeadline = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null;
      const selectedCatId = catSelect.value;
      const selectedCat = _todoCatMap.get(selectedCatId);
      const flagBtn = itemEl.querySelector('.todo-flag-btn');
      const pendingPriority = flagBtn?.dataset.pendingPriority || null;
      return { due_date: newDeadline, category_id: selectedCatId, category: selectedCat?.name ?? '', priority: pendingPriority };
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
        if (extra.priority && extra.priority !== (todo.priority || 'normal')) {
          updates.priority = extra.priority;
        }
      }
      if (Object.keys(updates).length > 0) {
        if (todo.shared_id && todo.shared_group_id && state.sharing) {
          // ─── Shared: category to local pointer, text/priority/due_date to Drive (optimistic) ───
          if (updates.category_id !== undefined) {
            await state.db.from('todos').update({ category_id: updates.category_id, category: updates.category }).eq('id', id);
          }
          const driveUpdates = {};
          if (updates.text) driveUpdates.text = updates.text;
          if (updates.due_date !== undefined) driveUpdates.due_date = updates.due_date;
          if (updates.priority) driveUpdates.priority = updates.priority;
          let failed = false;
          if (Object.keys(driveUpdates).length > 0) {
            const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'normal' };
            let onStaged;
            const staged = new Promise(resolve => { onStaged = resolve; });
            const upload = state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
              payload: { ...currentPayload, ...driveUpdates },
            }, { onStaged });
            upload.then(
              () => showToast(t('todos.todo_updated'), 'success'),
              async (e) => {
                failed = true;
                console.warn('Failed to update shared todo on Drive:', e);
                await refreshTodos();
                showToast(t('toast.update_failed'), 'error');
              }
            );
            // Unblock on staging; a pre-staging failure is caught by the
            // failure branch above, so don't hang here.
            await Promise.race([staged, upload.then(() => {}, () => {})]);
          } else {
            showToast(t('todos.todo_updated'), 'success');
          }
          if (!failed) Object.assign(todo, updates);
        } else {
          // ─── Normal: write all to local DB ───
          const { error } = await state.db.from('todos').update(updates).eq('id', id);
          if (error) { showToast(t('toast.update_failed'), 'error'); return; }
          Object.assign(todo, updates);
          showToast(t('todos.todo_updated'), 'success');
        }
      }
    },
    refreshFn: refreshTodos,
  });
}

// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================
function snoozeModalHTML() {
  return `<div class="modal snooze-modal"><h2>${lucideIcon("clock",20)} ${t('todos.snooze')}</h2><p style="font-size:0.82rem;color:var(--muted);margin-bottom:12px;">${t('todos.snooze_hint')}</p><div class="snooze-options"><button data-action="snooze-for" data-amount="1" data-unit="h">${t('todos.snooze_1h')}</button><button data-action="snooze-for" data-amount="3" data-unit="h">${t('todos.snooze_3h')}</button><button data-action="snooze-for" data-amount="1" data-unit="d">${t('todos.snooze_1d')}</button><button data-action="snooze-for" data-amount="3" data-unit="d">${t('todos.snooze_3d')}</button><button data-action="snooze-for" data-amount="7" data-unit="d">${t('todos.snooze_1w')}</button><button data-action="snooze-for" data-amount="1" data-unit="M">${t('todos.snooze_1m')}</button></div><label style="margin-top:12px;">${t('todos.snooze_custom')}</label><input type="datetime-local" id="snoozeCustomDate" style="width:100%;margin-top:4px;"><input type="hidden" id="snoozeTaskId"><div class="modal-actions"><button class="modal-cancel" data-action="close-snooze-modal">${t('common.cancel')}</button><button class="modal-save" data-action="submit-snooze">${t('todos.snooze')}</button></div></div>`;
}

function addCategoryModalHTML() {
  return `<div class="modal"><h2>${lucideIcon("folder-plus",20)} ${t('todos.add_category')}</h2><label>${t('todos.category_name')}</label><input type="text" id="newCategoryName" placeholder="${t('todos.category_placeholder')}" maxlength="40" data-action="save-new-category-on-enter"><div class="modal-row"><div class="modal-field"><label>${t('common.shortname')}</label><input type="text" id="newCategoryShortname" placeholder="${t('common.shortname_placeholder')}" maxlength="20" data-action="save-new-category-on-enter"></div><div class="modal-field"><label>${t('common.color')}</label><input type="color" id="newCategoryColor"></div></div><div class="modal-actions"><button class="modal-cancel" data-action="close-add-category-modal">${t('common.cancel')}</button><button class="modal-save" data-action="save-new-category">${t('common.add')}</button></div></div>`;
}

function editCategoryModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('todos.edit_category')}</h2>
    <input type="hidden" id="editCategoryOldName">
    <label>${t('todos.category_name')}</label>
    <input type="text" id="editCategoryName" maxlength="80" data-action="save-edit-category-on-enter">
    <label>${t('common.section_parent')}</label>
    <select id="editCategoryParent"></select>
    <div class="modal-row">
      <div class="modal-field">
        <label>${t('common.shortname')}</label>
        <input type="text" id="editCategoryShortname" maxlength="20" data-action="save-edit-category-on-enter">
      </div>
      <div class="modal-field">
        <label>${t('common.color')}</label>
        <input type="color" id="editCategoryColor">
      </div>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-category">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-category">${t('common.save')}</button>
    </div>
  </div>`;
}

/** Fill the edit modal's parent picker: Root + section rows, excluding
 *  the row being edited and its descendants (never move into itself). */
function populateTodoParentSelect(currentRow) {
  const sel = document.getElementById('editCategoryParent');
  if (!sel) return;
  const excluded = new Set();
  if (currentRow) {
    excluded.add(currentRow.id);
    const node = _todoTree.byId.get(currentRow.id);
    if (node) for (const d of descendantsOf(node)) excluded.add(d.id);
  }
  const sections = [..._todoTree.byId.values()]
    .filter(n => n.kind === 'section' && !excluded.has(n.id) && !n.row.is_protected);
  sel.innerHTML = `<option value="">${esc(t('common.section_root'))}</option>` + sections
    .map(n => `<option value="${esc(n.id)}">${esc(pathLabelOf(n, _todoTree.byId))}</option>`).join('');
  sel.value = currentRow?.parent_id || '';
  const shortField = document.getElementById('editCategoryShortname')?.closest('.modal-field');
  if (shortField) shortField.style.display = currentRow && isSectionRow(currentRow) ? 'none' : '';
}

function initTodoModals() {
  const app = document.getElementById('app');

  // Snooze Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay'; m1.id = 'snoozeModal';
  m1.innerHTML = snoozeModalHTML();
  app.appendChild(m1);

  // Add Category Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay'; m2.id = 'addCategoryModal';
  m2.innerHTML = addCategoryModalHTML();
  app.appendChild(m2);

  // Edit Category Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay'; m3.id = 'editCategoryModal';
  m3.dataset.action = 'close-edit-category';
  m3.dataset.overlayClose = 'true';
  m3.innerHTML = editCategoryModalHTML();
  app.appendChild(m3);

  // Section Delete Choice Modal
  const m4 = document.createElement('div');
  m4.className = 'modal-overlay'; m4.id = 'deleteSectionModal';
  m4.dataset.action = 'close-delete-section-modal';
  m4.dataset.overlayClose = 'true';
  m4.innerHTML = deleteSectionModalHTML();
  app.appendChild(m4);
}

function openAddCategoryModal(parentId = null) {
  const modal = document.getElementById('addCategoryModal');
  modal.innerHTML = addCategoryModalHTML();
  modal.dataset.parentId = parentId || '';
  document.getElementById('newCategoryName').value = '';
  document.getElementById('newCategoryShortname').value = '';
  document.getElementById('newCategoryColor').value = nextPaletteColor(_todoCatMap);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('newCategoryName').focus(), 100);
}

function openAddCategoryInSection(sectionId) {
  openAddCategoryModal(sectionId);
}

function closeAddCategoryModal() {
  document.getElementById('addCategoryModal').classList.remove('visible');
}

async function saveNewCategory() {
  const input = document.getElementById('newCategoryName');
  const segments = parseSectionPath(input.value.trim());
  if (!segments.length) { showToast(t('toast.enter_name'), 'error'); return; }
  const modal = document.getElementById('addCategoryModal');
  const startParentId = modal?.dataset.parentId || null;
  const shortname = document.getElementById('newCategoryShortname').value.trim() || null;
  const color = document.getElementById('newCategoryColor').value;

  try {
    // All but the last segment are sections (created / converted on the
    // way); the last segment is the new bucket.
    const parentId = await ensureTodoSectionChain(segments.slice(0, -1), startParentId);
    const name = segments[segments.length - 1];
    if (siblingNameTaken([..._todoCatMap.values()], parentId, name, null)) {
      showToast(t('toast.name_required'), 'error');
      return;
    }
    const { error } = await state.db.from('todo_categories').insert({
      name, shortname, color, sort_order: nextTodoSortOrder(parentId),
      kind: 'bucket', parent_id: parentId,
    });
    if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  } catch (e) {
    showToast(t('toast.failed_to_add') + ': ' + e.message, 'error');
    return;
  }

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
    // Snapshots for rollback.
    const catRow = { ...cat };
    const todoRows = todosInCat.map(td => ({ ...td }));
    // Delete locally first to unblock the UI. Explicitly delete items so
    // calendar sync (markDirty) fires for each. SQL CASCADE would handle this
    // where the backend enforces FKs, but Drive/Demo have no FK enforcement.
    for (const todo of todosInCat) {
      await state.db.from('todos').delete().eq('id', todo.id);
    }
    await state.db.from('todo_categories').delete().eq('id', catId);
    showToast(t('toast.deleted'), 'info');
    await refreshTodos();
    // Propagate deletion of shared items to the sharing layer in the
    // background (sequential, etag order). A failure restores the category
    // and its items locally.
    if (state.sharing) {
      const sharedTodos = todosInCat.filter(t => t.shared_id && t.shared_group_id);
      if (sharedTodos.length) {
        const upload = (async () => {
          for (const todo of sharedTodos) {
            await state.sharing.deleteItem(todo.shared_group_id, todo.shared_id);
          }
        })();
        upload.catch(async (e) => {
          console.warn('Failed to delete shared todos from Drive:', e);
          await state.db.from('todo_categories').insert(catRow);
          for (const r of todoRows) await state.db.from('todos').insert(r);
          await refreshTodos();
          showToast(t('toast.delete_failed'), 'error');
        });
      }
    }
  });
}


// ── Section delete ─────────────────────────────────────────────────
// Empty sections delete directly. A non-empty section asks first:
// delete the whole subtree, or move its children up one level.
let _pendingTodoSectionDelete = null;

function deleteSection(sectionId) {
  const node = _todoTree.byId.get(sectionId);
  const cat = _todoCatMap.get(sectionId);
  if (!node || !cat || !isSectionRow(cat) || cat.is_protected) return;
  if (!node.children.length) {
    showConfirmAction(t('common.delete'), t('common.section_delete_empty', cat.name), async () => {
      await state.db.from('todo_categories').delete().eq('id', sectionId);
      showToast(t('toast.deleted'), 'info');
      await refreshTodos();
    });
    return;
  }
  _pendingTodoSectionDelete = sectionId;
  const modal = document.getElementById('deleteSectionModal');
  if (!modal) return;
  modal.innerHTML = deleteSectionModalHTML();
  document.getElementById('deleteSectionName').textContent = cat.name;
  modal.classList.add('visible');
}

function deleteSectionModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('folder', 20)} ${t('common.section_delete_title')}</h2>
    <p>${t('common.section_delete_msg')} <strong id="deleteSectionName"></strong></p>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-delete-section-modal">${t('common.cancel')}</button>
      <button class="btn" data-action="delete-section-move-up">${t('common.section_delete_move_up')}</button>
      <button class="modal-save" data-action="delete-section-subtree">${t('common.section_delete_subtree')}</button>
    </div>
  </div>`;
}

function closeDeleteSectionModal() {
  _pendingTodoSectionDelete = null;
  document.getElementById('deleteSectionModal')?.classList.remove('visible');
}

async function deleteSectionMoveUp() {
  const sectionId = _pendingTodoSectionDelete;
  if (!sectionId) return;
  _pendingTodoSectionDelete = null;
  document.getElementById('deleteSectionModal')?.classList.remove('visible');
  const node = _todoTree.byId.get(sectionId);
  if (!node) return;
  const parentId = node.parentId || null;
  const parentChildren = [..._todoTree.byId.values()]
    .filter(n => (n.parentId || null) === parentId)
    .sort((a, b) => (Number(a.row.sort_order) || 0) - (Number(b.row.sort_order) || 0));
  const moving = [...node.children];
  const movingIds = new Set(moving.map(n => n.id));
  const rest = parentChildren.filter(n => n.id !== sectionId);
  const at = Math.max(0, parentChildren.findIndex(n => n.id === sectionId));
  const finalOrder = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  for (let i = 0; i < finalOrder.length; i++) {
    const n = finalOrder[i];
    const updates = { sort_order: i };
    if (movingIds.has(n.id)) updates.parent_id = parentId;
    if (Number(n.row.sort_order) !== i || updates.parent_id !== undefined) {
      await state.db.from('todo_categories').update(updates).eq('id', n.id);
    }
  }
  await state.db.from('todo_categories').delete().eq('id', sectionId);
  showToast(t('toast.deleted'), 'info');
  await refreshTodos();
}

async function deleteSectionSubtree() {
  const sectionId = _pendingTodoSectionDelete;
  if (!sectionId) return;
  _pendingTodoSectionDelete = null;
  document.getElementById('deleteSectionModal')?.classList.remove('visible');
  const node = _todoTree.byId.get(sectionId);
  if (!node) return;
  const subtree = [node, ...descendantsOf(node)];
  const bucketIds = subtree.filter(n => n.kind === 'bucket').map(n => n.id);
  const sectionIds = subtree.filter(n => n.kind === 'section').map(n => n.id).reverse();
  // Snapshots for the sharing-failure rollback, like deleteCategory.
  const catRows = subtree.map(n => ({ ...n.row }));
  const itemRows = [];
  for (const bid of bucketIds) {
    const { data } = await state.db.from('todos').select('*').eq('category_id', bid);
    for (const r of (data || [])) itemRows.push(r);
  }
  // Explicit per-item deletion so calendar dirty tracking fires.
  for (const item of itemRows) await state.db.from('todos').delete().eq('id', item.id);
  for (const bid of bucketIds) await state.db.from('todo_categories').delete().eq('id', bid);
  for (const sid of sectionIds) await state.db.from('todo_categories').delete().eq('id', sid);
  showToast(t('toast.deleted'), 'info');
  await refreshTodos();
  if (state.sharing) {
    const sharedItems = itemRows.filter(t2 => t2.shared_id && t2.shared_group_id);
    if (sharedItems.length) {
      (async () => {
        for (const item of sharedItems) await state.sharing.deleteItem(item.shared_group_id, item.shared_id);
      })().catch(async (e) => {
        console.warn('Failed to delete shared todos from Drive:', e);
        for (const r of catRows) await state.db.from('todo_categories').insert(r);
        for (const r of itemRows) await state.db.from('todos').insert(r);
        await refreshTodos();
        showToast(t('toast.delete_failed'), 'error');
      });
    }
  }
}

// ===================================================================
// SNOOZE MODAL
// ===================================================================
function openSnoozeModal(todoId) {
  const modal = document.getElementById('snoozeModal');
  modal.innerHTML = snoozeModalHTML();
  document.getElementById('snoozeTaskId').value = todoId;
  document.getElementById('snoozeCustomDate').value = '';
  modal.classList.add('visible');
}

function closeSnoozeModal() {
  document.getElementById('snoozeModal').classList.remove('visible');
}

async function snoozeFor(amount, unit) {
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
  await doSnooze(target);
}

async function submitSnooze() {
  const customDate = document.getElementById('snoozeCustomDate').value;
  if (!customDate) { showToast(t('toast.content_required'), 'error'); return; }
  await doSnooze(new Date(customDate));
}

async function doSnooze(snoozeUntil) {
  const taskId = document.getElementById('snoozeTaskId').value;
  if (!taskId) return;
  const todo = allTodos.find(t => t.id === taskId);

  // Disable all snooze buttons while in flight
  const snoozeBtns = document.querySelectorAll('.snooze-modal button');
  snoozeBtns.forEach(b => { b.disabled = true; b.classList.add('is-pending'); });

  try {
    const snoozedMsg = `${t('todos.snoozed_until')} ${snoozeUntil.toLocaleString(getLang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
      // ─── Shared: write snooze to Drive payload (optimistic — refresh on staging) ───
      const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'normal' };
      let onStaged;
      const staged = new Promise(resolve => { onStaged = resolve; });
      const upload = state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
        payload: { ...currentPayload, snooze_until: snoozeUntil.toISOString() },
      }, { onStaged });
      upload.then(
        () => showToast(snoozedMsg, 'success'),
        async (e) => {
          console.warn('Failed to snooze todo:', e);
          await refreshTodos();
          showToast(t('toast.update_failed'), 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
    } else {
      // ─── Normal: write to local DB ───
      const { error } = await state.db.from('todos').update({ snooze_until: snoozeUntil.toISOString() }).eq('id', taskId);
      if (error) { showToast(t('toast.update_failed'), 'error'); return; }
      showToast(snoozedMsg, 'success');
    }
    closeSnoozeModal();
    await refreshTodos();
  } catch (e) {
    console.warn('Failed to snooze todo:', e);
    showToast(t('toast.update_failed'), 'error');
  } finally {
    snoozeBtns.forEach(b => { b.disabled = false; b.classList.remove('is-pending'); });
  }
}

function unsnoozeTodo(id, el) {
  showConfirmAction(
    t('todos.unsnooze_confirm_title'),
    t('todos.unsnooze_confirm_msg'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unsnooze-todo"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        const todo = allTodos.find(t => t.id === id);
        if (todo?.shared_id && todo?.shared_group_id && state.sharing) {
          // ─── Shared: clear snooze in the Drive payload (optimistic) ───
          const currentPayload = { text: todo.text, category: todo.category || '', priority: todo.priority || 'normal' };
          let onStaged;
          const staged = new Promise(resolve => { onStaged = resolve; });
          const upload = state.sharing.updateItem(todo.shared_group_id, todo.shared_id, {
            payload: { ...currentPayload, snooze_until: null },
          }, { onStaged });
          upload.then(
            () => showToast(t('todos.unsnoozed'), 'success'),
            async (e) => {
              console.warn('Failed to unsnooze todo:', e);
              await refreshTodos();
              showToast(t('toast.update_failed'), 'error');
            }
          );
          await Promise.race([staged, upload.then(() => {}, () => {})]);
        } else {
          const { error } = await state.db.from('todos').update({ snooze_until: null }).eq('id', id);
          if (error) { showToast(t('toast.update_failed'), 'error'); return; }
          showToast(t('todos.unsnoozed'), 'success');
        }
        await refreshTodos();
      } catch (e) {
        console.warn('Failed to unsnooze todo:', e);
        showToast(t('toast.update_failed'), 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
      }
    },
    null,
    { variant: 'neutral', btnText: t('todos.unsnooze'), iconSvg: lucideIcon('moon-off', 28), btnIconSvg: lucideIcon('moon-off', 15, 'currentColor') }
  );
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
    actionsSelector: '.todo-actions',
    crossContainerSelector: '.todo-cat-list:not(.habit-list)',
    getContainerId: (el) => el.dataset.category,
    onReorder: async (orderedIds, { draggedId, sourceContainerId, targetContainerId } = {}) => {
      const crossMove = sourceContainerId && targetContainerId && sourceContainerId !== targetContainerId;
      if (crossMove) {
        const movedItem = allTodos.find(x => x.id === draggedId);
        if (!movedItem) return;
        movedItem.category_id = targetContainerId;
        const targetCatName = _todoCatMap.get(targetContainerId)?.name ?? '';
        movedItem.category = targetCatName;
        // Diff target list — dragged item always patches (category changed)
        const targetUpdates = [];
        let draggedSortOrder = 0;
        orderedIds.forEach((id, i) => {
          const it = allTodos.find(x => x.id === id);
          if (!it) return;
          if (id === draggedId) { draggedSortOrder = i; }
          else if (Number(it.sort_order ?? 0) !== i) { targetUpdates.push({ id, sort_order: i }); }
          it.sort_order = i;
        });
        // Diff source list
        const sourceItems = allTodos
          .filter(x => catIdForTodo(x) === sourceContainerId && x.id !== draggedId)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        const sourceUpdates = [];
        sourceItems.forEach((it, i) => {
          if (Number(it.sort_order ?? 0) !== i) sourceUpdates.push({ id: it.id, sort_order: i });
          it.sort_order = i;
        });
        await state.db.from('todos').update({ category_id: targetContainerId, category: targetCatName, sort_order: draggedSortOrder }).eq('id', draggedId);
        await Promise.all([
          bulkSortOrder('todos', targetUpdates),
          bulkSortOrder('todos', sourceUpdates),
        ]);
        await refreshTodos();
        showToast(t('toast.moved'), 'success');
      } else {
        await reorderItems({
          orderedIds,
          allItems: allTodos,
          tableName: 'todos',
          reinitFn: () => initTodoDragDropForCard(catId),
        });
      }
    },
  });
}


// ===================================================================
// NAV BUTTON REORDER
// ===================================================================
async function reorderTodoSiblings(orderedIds) {
  const reorderable = orderedIds.filter(id => id !== _sharedCatId);
  const updates = [];
  reorderable.forEach((id, i) => {
    const cat = _todoCatMap.get(id);
    if (cat && Number(cat.sort_order ?? 0) !== i) updates.push({ id, sort_order: i });
  });
  // Optimistic in-memory update (sort_order is per sibling group, so the
  // index within the dragged chip row is the new order for that group)
  reorderable.forEach((id, i) => { const cat = _todoCatMap.get(id); if (cat) cat.sort_order = i; });
  await bulkSortOrder('todo_categories', updates);
  await loadTodoCategories();
  const grid = document.getElementById('todoCategoryGrid');
  const snapshot = snapshotBuckets(grid);
  renderTodos();
  animateBucketsFromSnapshot(grid, snapshot, 600);
  showToast(t('toast.reordered'), 'success');
}

function initTodoNavBtnReorder() {
  const skipIds = new Set();
  if (_sharedCatId) skipIds.add(_sharedCatId);
  initNavBtnReorder('todoNavButtons', {
    idAttr: 'category',
    skipIds,
    onReorder: reorderTodoSiblings,
  });
}

function initTodoSectionNavBtnReorder(sectionId) {
  initNavBtnReorder('todoSectionChips-' + sectionId, {
    idAttr: 'category',
    skipIds: new Set(),
    onReorder: reorderTodoSiblings,
  });
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

// Calendar sync: fingerprint of the shared-payload fields that feed calendar
// events. Remote changes (another member edits a deadline) touch only the
// shared payload, never the local pointer row, so the adapter's dirty
// tracking can't see them — diff here and mark the pointer dirty instead.
// The group name is included because calendar titles embed it ([TODO][Category][Group]).
const _sharedTodoCalFp = new Map();
// Last-seen updated_at per shared item: detects remote content edits, which
// change the in-memory item (and therefore the rendered view) without
// touching any local pointer row.
const _sharedTodoSeenAt = new Map();
function sharedTodoCalFingerprint(sh) {
  return JSON.stringify([
    sh.payload?.due_date || null,
    sh.payload?.snooze_until || null,
    sh.done ? 1 : 0,
    sh.payload?.text || sh.payload?.title || '',
    sh.payload?.category || '',
    sh.group_name || '',
  ]);
}
let _bulkShareInProgress = new Set();
const _pendingShare = new Set();
async function syncSharedTodos() {
  if (_syncingTodos) return false;
  _syncingTodos = true;
  try {
    return await _doSyncSharedTodos();
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
      // Skip items this tab staged but hasn't planted a pointer for yet —
      // the share flow inserts the real pointer right after staging. Without
      // this the sync would plant a __shared__-category duplicate.
      if (state.sharing.hasPendingCreate(sh.group_id, sh.id)) continue;
      // Double-check DB to avoid race with shareTodoFromAdd
      const { data: existing } = await state.db.from('todos').select('id').eq('shared_id', sh.id).limit(1);
      if (existing?.length) continue;
      const { error } = await state.db.from('todos').insert({
        text: '', category: SHARED_CATEGORY, priority: 'normal', done: false,
        shared_id: sh.id, shared_group_id: sh.group_id,
      });
      if (error) { console.warn('syncSharedTodos: failed to create pointer', sh.id, error); continue; }
      needsRefresh = true;
    }
  }

  // ─── Calendar: mark pointers dirty when a remote change touched event fields ───
  // (first sight only initializes the fingerprint — pointer creation already dirties)
  // A rename or remote edit writes no local row, so no Drive flush would consume
  // the dirty marks — drive the calendar sync directly when anything was marked.
  let calDirtyMarked = false;
  for (const sh of allShared) {
    const fp = sharedTodoCalFingerprint(sh);
    const prev = _sharedTodoCalFp.get(sh.id);
    _sharedTodoCalFp.set(sh.id, fp);
    if (prev !== undefined && prev !== fp) {
      const pointer = localBySharedId.get(sh.id);
      if (pointer) { state.markCalDirty?.('todos', pointer.id); calDirtyMarked = true; }
    }
    // Remote content edits bump updated_at on every mutation — a change here
    // means the rendered item changed even though no pointer row moved.
    const prevSeen = _sharedTodoSeenAt.get(sh.id);
    _sharedTodoSeenAt.set(sh.id, sh.updated_at);
    if (prevSeen !== undefined && prevSeen !== sh.updated_at) needsRefresh = true;
  }
  if (calDirtyMarked) await state.syncCalendarTable?.('todos');

  // ─── Cleanup: local shared todos whose shared_id no longer exists on remote ───
  for (const local of localShared) {
    if (!driveSharedIds.has(local.shared_id)) {
      const group = state.sharing.getAllGroups().find(g => g.id === local.shared_group_id);
      if (group) {
        // Group exists but item gone from remote → delete local pointer
        await state.db.from('todos').delete().eq('id', local.id);
        _sharedTodoSeenAt.delete(local.shared_id);
        needsRefresh = true;
      } else {
        // Group not loaded — transient skip, or the group was dropped and its
        // pointers were already purged. Leave the pointer; the next sync
        // re-evaluates it.
      }
    }
  }

  return needsRefresh;
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
  const priority = input.dataset.priority || 'normal';
  const guardKey = `add-${catId}`;
  if (_pendingShare.has(guardKey)) return;

  openSharePopover(btn, (groupId, assignees) => {
    if (_pendingShare.has(guardKey)) return;
    _pendingShare.add(guardKey);
    if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }

    // Resolves once the shared item is staged in memory, before the Drive upload.
    let onStaged;
    let wasStaged = false;
    const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });

    (async () => {
      const sharedId = crypto.randomUUID();
      const pendingTodos = allTodos.filter(t => !t.done && catIdForTodo(t) === catId);
      const minOrder = pendingTodos.length > 0 ? Math.min(...pendingTodos.map(t => t.sort_order || 0)) - 1 : 0;

      // Stage the shared item in memory first: this marks the created intent
      // and the dirty type, so the poll skips it and the orphan-pointer
      // cleanup can't see a pointer whose item isn't staged yet.
      let localStaged = false;
      let localRow = null;
      const upload = state.sharing.addItem(groupId, {
        id: sharedId,
        item_type: 'todo',
        payload: { text, category: cat?.name ?? '', priority },
        assignees,
        onStaged,
      });
      // The shared upload runs in the background: success toasts, failure
      // rolls back only what was actually staged locally.
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (driveErr) => {
          if (localStaged && localRow?.id) {
            await state.db.from('todos').delete().eq('id', localRow.id);
            await refreshTodos();
          }
          input.value = text;
          showToast(driveErr.message, 'error');
        }
      );

      // Unblock the UI once the item is staged in memory — don't wait for the
      // upload. If the upload fails before staging, the failure branch above
      // handles the rollback, so don't hang here.
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      if (!wasStaged) return;

      // Stage the local pointer row (fast local write).
      const { data, error: localErr } = await state.db.from('todos').insert({
        text: '', priority: 'normal', done: false,
        category: cat?.name ?? '', category_id: catId,
        sort_order: minOrder,
        shared_id: sharedId,
        shared_group_id: groupId,
      }).select().single();
      if (localErr) {
        // Back out the staged shared item — it hasn't uploaded yet.
        state.sharing.deleteItem(groupId, sharedId).catch(() => {});
        showToast(localErr.message, 'error');
        return;
      }
      localRow = data;
      localStaged = true;

      input.value = '';
      input.dataset.priority = 'low';
      const prioBtn = addRow.querySelector('.todo-add-priority-btn');
      if (prioBtn) updateQuickAddPriorityBtn(prioBtn, 'normal');
      await refreshTodos();
    })().catch(e => showToast(e.message, 'error'))
      .finally(() => {
        _pendingShare.delete(guardKey);
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
      });
  }, { showAssignees: false });
}

window.shareTodoFromAdd = shareTodoFromAdd;

async function shareExistingTodo(id, el) {
  if (!state.sharing) return;
  if (_pendingShare.has(id)) return;
  const todo = allTodos.find(t => t.id === id);
  if (!todo || todo.shared_id) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-todo"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  openSharePopover(btn, (groupId) => {
    if (_pendingShare.has(id)) return;
    _pendingShare.add(id);
    if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
    (async () => {
      const sharedId = crypto.randomUUID();
      const cat = _todoCatMap.get(catIdForTodo(todo));
      const payload = { text: todo.text, category: cat?.name ?? '', priority: todo.priority || 'normal', note: todo.note || '', due_date: todo.due_date || null, snooze_until: todo.snooze_until || null };
      // Keep the personal row: a failed upload restores it verbatim.
      const personalRow = { ...todo };
      // 1. Stage the shared item in memory first: this marks the created
      // intent and the dirty type, so the poll skips it and the
      // orphan-pointer cleanup can't see a pointer whose item isn't staged.
      let onStaged;
      let wasStaged = false;
      const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
      let locallyStaged = false;
      const upload = state.sharing.addItem(groupId, {
        id: sharedId,
        item_type: 'todo',
        payload,
        onStaged,
      });
      // 2. The shared upload runs in the background: success toasts, failure
      // restores the personal item and drops the pointer — but only when the
      // local staging below actually happened.
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (driveErr) => {
          if (locallyStaged) {
            await state.db.from('todos').delete().eq('shared_id', sharedId);
            await state.db.from('todos').insert(personalRow);
            await refreshTodos();
          }
          showToast(driveErr.message, 'error');
        }
      );
      // Unblock the UI on staging — don't wait for the upload. If the upload
      // fails before staging, the failure branch above handles the rollback.
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      if (!wasStaged) return;
      // 3. Stage locally — pointer in, personal item out — and refresh.
      const { error: ptrErr } = await state.db.from('todos').insert({
        text: '', priority: 'normal', done: false,
        category: cat?.name ?? '', category_id: catIdForTodo(todo),
        sort_order: todo.sort_order || 0,
        shared_id: sharedId,
        shared_group_id: groupId,
      });
      if (ptrErr) {
        // Back out the staged shared item — it hasn't uploaded yet.
        state.sharing.deleteItem(groupId, sharedId).catch(() => {});
        showToast(ptrErr.message, 'error');
        return;
      }
      await state.db.from('todos').delete().eq('id', todo.id);
      locallyStaged = true;
      await refreshTodos();
    })().catch(e => showToast(e.message, 'error'))
      .finally(() => {
        _pendingShare.delete(id);
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
      });
  }, { showAssignees: false });
}
window.shareExistingTodo = shareExistingTodo;

// ── Bulk share all personal items in a category ──
async function bulkShareTodoCategory(catId, el) {
  if (!state.sharing) return;
  if (_bulkShareInProgress.has(catId)) return;
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
        if (_bulkShareInProgress.has(catId)) return;
        _bulkShareInProgress.add(catId);
        if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
        try {
          // Stage each item in the shared memory first, then plant the local
          // pointer: the created intent and dirty type keep the poll and the
          // orphan-pointer cleanup from misreading the in-between state. The
          // debounced flush uploads everything in one go.
          const staged = [];
          for (const todo of items) {
            const sharedId = crypto.randomUUID();
            const payload = { text: todo.text, category: cat?.name ?? '', priority: todo.priority || 'normal', note: todo.note || '', due_date: todo.due_date || null, snooze_until: todo.snooze_until || null };
            let onStaged;
            let wasStaged = false;
            const stagedP = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
            const upload = state.sharing.addItem(groupId, {
              id: sharedId,
              item_type: 'todo',
              payload,
              onStaged,
            });
            await Promise.race([stagedP, upload.then(() => {}, () => {})]);
            if (!wasStaged) {
              console.error('[DeLaClaw] bulk share todo staging failed:', sharedId);
              continue;
            }
            const { error: ptrErr } = await state.db.from('todos').insert({
              text: '', priority: 'normal', done: false,
              category: cat?.name ?? '', category_id: catId,
              sort_order: todo.sort_order ?? 0,
              shared_id: sharedId,
              shared_group_id: groupId,
            });
            if (ptrErr) {
              // Back out the staged shared item — it hasn't uploaded yet.
              state.sharing.deleteItem(groupId, sharedId).catch(() => {});
              continue;
            }
            await state.db.from('todos').delete().eq('id', todo.id);
            staged.push({ todo: { ...todo }, sharedId, upload });
          }
          // Unblock the UI on staging — the uploads run in the background.
          await refreshTodos();
          _bulkShareInProgress.delete(catId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
          let ok = 0;
          for (const s of staged) {
            try {
              await s.upload;
              ok++;
            } catch (e) {
              console.error('[DeLaClaw] bulk share todo failed:', e);
              // Roll the item back: drop the pointer, restore the personal row.
              await state.db.from('todos').delete().eq('shared_id', s.sharedId);
              await state.db.from('todos').insert(s.todo);
            }
          }
          await refreshTodos();
          if (ok === staged.length && ok > 0) showToast(t('sharing.share_all_done', ok), 'success');
          else if (ok > 0) showToast(t('sharing.share_all_partial', ok, staged.length), 'error');
          else if (staged.length > 0) showToast(t('toast.failed_to_add'), 'error');
        } finally {
          _bulkShareInProgress.delete(catId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
        }
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
        const { data: personalRow, error: insErr } = await state.db.from('todos').insert({
          text: todo.text || '',
          priority: todo.priority || 'normal',
          done: todo.done ? 1 : 0,
          category: cat?.name ?? '',
          category_id: catIdForTodo(todo),
          sort_order: todo.sort_order || 0,
          snooze_until: todo.snooze_until || null,
        }).select().single();
        if (insErr) { showToast(insErr.message, 'error'); return; }
        // 2. Delete the local pointer and refresh immediately; the shared
        // item's Drive deletion runs in the background. A failure drops the
        // personal copy again and restores the pointer row.
        const pointerRow = { ...todo };
        await state.db.from('todos').delete().eq('id', todo.id);
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteItem(todo.shared_group_id, todo.shared_id, { onStaged });
        upload.then(
          () => showToast(t('sharing.unshared'), 'success'),
          async (e) => {
            console.warn('Failed to unshare todo on Drive:', e);
            if (personalRow?.id) await state.db.from('todos').delete().eq('id', personalRow.id);
            await state.db.from('todos').insert(pointerRow);
            await refreshTodos();
            showToast(e.message, 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
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
      priority: todo.priority || 'normal',
      done: todo.done ? 1 : 0,
      category: targetCatName,
      category_id: targetCatId,
      sort_order: minOrder,
      snooze_until: todo.snooze_until || null,
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

document.addEventListener('input', e => {
  if (e.target.tagName === 'TEXTAREA' && e.target.classList.contains('todo-cat-input')) {
    autoResizeTextarea(e.target);
  }
});

export { refreshTodos, renderTodos, getCategoryColor, setCategoryColor, loadTodoCategories, getTodoCategories, initTodoModals, getTodoCounts, getTodos, syncSharedTodos, SHARED_CATEGORY, catIdForTodo, getCatDisplayName, getTodoCatPath, getTodoCatOrderKey };

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
window.PRIORITY_LEVELS = PRIORITY_LEVELS;
window.openSnoozeModal = openSnoozeModal;
window.closeSnoozeModal = closeSnoozeModal;
window.snoozeFor = snoozeFor;
window.submitSnooze = submitSnooze;
window.unsnoozeTodo = unsnoozeTodo;
window.openAddCategoryModal = openAddCategoryModal;
window.openAddCategoryInSection = openAddCategoryInSection;
window.closeAddCategoryModal = closeAddCategoryModal;
window.saveNewCategory = saveNewCategory;
window.deleteCategory = deleteCategory;
window.deleteSection = deleteSection;
window.closeDeleteSectionModal = closeDeleteSectionModal;
window.deleteSectionMoveUp = deleteSectionMoveUp;
window.deleteSectionSubtree = deleteSectionSubtree;
window.navigateToCategory = navigateToCategory;
window.navigateToTodoSection = navigateToTodoSection;
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
  applySectionGrid(grid);
};
window.filterTodos = function(e) { todoSearchQuery = e.target.value; renderTodos(); };
window.renderTodos = renderTodos;


// ===================================================================
// TODO BATCH IMPORT
// ===================================================================
// Thin wrapper over the shared import shell (js/batch-import.js): builds
// the TODO-specific config (prompt, validation, fields, creation) and
// hands the modal mechanics to openBatchImportModal.
// Per-item "category" names are created on confirm when they don't exist;
// "group_id" must be a group the user belongs to (names aren't unique).
// Calendar events come free: the Drive adapter marks every insert dirty and
// the debounced flush runs syncTable('todos').

function buildTodoImportPrompt(selectedCatNames, groups) {
  const catLine = selectedCatNames.length > 0
    ? `- "category": assign each TODO to exactly one of these categories: ${selectedCatNames.map(n => `"${n}"`).join(', ')}. If none fits, you may propose a new category name.`
    : `- "category": a category name for the TODO (a short label like "Admin" or "Groceries").`;
  const groupLine = (groups && groups.length > 0)
    ? `- "group_id": only for TODOs shared with a group; use one of these group ids: ${groups.map(g => `"${g.name}" → "${g.id}"`).join(', ')}. Omit otherwise.`
    : `- "group_id": only for TODOs shared with a group; omit otherwise (optional)`;
  return `Convert the following text into TODOs for DeLaClaw, a personal task manager (delaclaw.com).

Output a JSON array of objects, each with:
- "title": string (required, the task)
- "priority": one of "urgent", "high", "medium", "low", "normal" (optional, default "normal")
- "due_date": ISO date or datetime, e.g. "2026-11-02" or "2026-11-02T18:00" (optional)
- "snooze_until": ISO date or datetime (optional)
${catLine}
${groupLine}

Example:
[
  { "title": "Renew passport", "priority": "high", "due_date": "2026-11-02", "category": "Admin" },
  { "title": "Buy milk", "category": "Groceries" }
]

Output ONLY valid JSON, no markdown fences, no commentary.

Paste your text below and I will convert it:`;
}

window.openTodoImportModal = async function() {
  const { openBatchImportModal, ensureImportCategories, chunkedBatchInsert } = await import('./batch-import.js');
  const { parseTodoImportJSON, validateTodoImportItem, TODO_IMPORT_PRIORITIES } = await import('./todo-import.js');

  const cats = [..._todoTree.byId.values()]
    .filter(n => n.kind === 'bucket' && n.id !== _sharedCatId && n.row.name !== '')
    .sort((a, b) => compareOrderKeys(orderKeyOf(a, _todoTree.byId), orderKeyOf(b, _todoTree.byId)))
    .map(n => ({ ...n.row, _path: pathLabelOf(n, _todoTree.byId) }));

  const groups = (state.sharing && state.sharing.isReady()) ? state.sharing.getAllGroups() : [];

  await openBatchImportModal({
    modalId: 'importTodoModal',
    title: t('todos.import_title'),
    subtitle: t('todos.import_subtitle'),
    convertTitle: t('todos.import_convert_title'),
    convertDesc: t('todos.import_convert_desc'),
    uploadTitle: t('todos.import_upload_title'),
    uploadDesc: t('todos.import_upload_desc'),
    categoriesLabel: t('todos.import_categories_label'),
    selectAll: t('todos.import_select_all'),
    deselectAll: t('todos.import_deselect_all'),
    step1: t('todos.import_step1'),
    copy: t('todos.import_copy'),
    copied: t('todos.import_copied'),
    step2: t('todos.import_step2'),
    step3: t('todos.import_step3'),
    pastePlaceholder: t('todos.import_paste_placeholder'),
    uploadFile: t('todos.import_upload_file'),
    review: t('todos.import_review'),
    back: t('todos.import_back'),
    backToPaste: t('todos.import_back_to_paste'),
    ready: n => t('todos.import_ready', n),
    andMore: n => t('todos.import_and_more', n),
    reviewHeader: n => t('todos.import_review_header', n),
    selectedCount: (a, b) => t('todos.import_selected_count', a, b),
    confirm: n => t('todos.import_confirm', n),
    importing: t('todos.import_importing'),
    success: n => t('todos.import_success', n),
    failedPrefix: t('todos.import_failed'),
    newCategory: t('todos.import_new_category'),

    categories: [{ name: '', display: t('common.category_default') },
      ...cats.map(c => ({ name: c._path, display: c._path }))],
    promptDefaultCategory: 'General',
    groups: groups.map(g => ({ id: g.id, name: g.name })),
    sharingReady: !!(state.sharing && state.sharing.isReady()),

    buildPrompt: buildTodoImportPrompt,
    parse: parseTodoImportJSON,
    validate: validateTodoImportItem,
    getTitle: it => it.title,
    fields: [
      { key: 'title', label: t('todos.import_field_title'), type: 'text' },
      { key: 'priority', label: t('todos.import_field_priority'), type: 'select', options: TODO_IMPORT_PRIORITIES },
      { key: 'due_date', label: t('todos.import_field_due'), type: 'datetime' },
      { key: 'snooze_until', label: t('todos.import_field_snooze'), type: 'datetime' },
      { key: 'category', label: t('todos.import_field_category'), type: 'datalist',
        options: ['General', ...cats.map(c => c._path)] },
      { key: 'group_id', label: t('todos.import_field_group'), type: 'grouplist' },
    ],
    previewMeta: (it) => {
      const nc = (it.categoryIsNew && it.category) ? ` <span class="import-badge new-cat">${t('todos.import_new_category')}</span>` : '';
      const grp = it.groupName ? ` <span class="import-badge">${esc(it.groupName)}</span>` : '';
      const cat = it.category ? ` <span class="import-preview-cat">${esc(it.category)}</span>` : '';
      return `${cat}${nc}${grp}`;
    },
    reviewBadges: (it, errors) => {
      let html = '';
      if (it.categoryIsNew && it.category) html += `<span class="import-badge new-cat">${t('todos.import_new_category')}: ${esc(it.category)}</span>`;
      if (errors.length > 0) {
        html += `<div class="import-item-errors">${errors.map(e => `<span>${esc(e.message)}</span>`).join('')}</div>`;
      }
      return html;
    },

    ensureCategories: (names) => ensureImportCategories(names, {
      table: 'todo_categories', getMap: () => _todoCatMap, reload: loadTodoCategories,
      getPathMap: () => _todoCatByPath,
      ensurePath: async (pathName) => {
        const segments = parseSectionPath(pathName);
        if (segments.length < 2) return;
        const parentId = await ensureTodoSectionChain(segments.slice(0, -1));
        const name = segments[segments.length - 1];
        if (!todoChildRow(parentId, name)) {
          const { error } = await state.db.from('todo_categories').insert({
            name, shortname: null, color: nextPaletteColor(_todoCatMap),
            sort_order: nextTodoSortOrder(parentId), kind: 'bucket', parent_id: parentId,
          });
          if (error) throw new Error(error.message);
          await loadTodoCategories();
        }
      },
    }),

    createItems: async (validItems, catMap) => {
      const resolveCat = (name) => {
        if (!name) return { id: _defaultCatId, name: '' };
        const hit = catMap.get(name.toLowerCase());
        return hit ? { id: hit.id, name: hit.name } : { id: _defaultCatId, name: '' };
      };
      // sort_order cursors: new TODOs go on top of their category (contract)
      const orderCursor = new Map();
      const nextOrder = (catId) => {
        if (!orderCursor.has(catId)) {
          const inCat = allTodos.filter(td => catIdForTodo(td) === catId);
          orderCursor.set(catId, inCat.length > 0 ? Math.min(...inCat.map(td => td.sort_order || 0)) - 1 : 0);
        }
        const v = orderCursor.get(catId);
        orderCursor.set(catId, v - 1);
        return v;
      };

      const personalRows = [];
      const sharedItems = [];
      for (const it of validItems) {
        const { id: catId, name: catName } = resolveCat(it.category);
        if (it.group_id) sharedItems.push({ ...it, catId, catName });
        else personalRows.push({
          text: it.title, priority: it.priority,
          due_date: it.due_date, snooze_until: it.snooze_until,
          category: catName, category_id: catId,
          sort_order: nextOrder(catId),
        });
      }

      // Personal: batch insert (chunks of 100, like backup restore).
      // The Drive adapter marks each insert dirty → the debounced flush
      // runs syncTable('todos'), creating calendar events for due dates.
      await chunkedBatchInsert('todos', personalRows);

      // Shared: stage in group memory + local pointer row
      // (same pattern as shareExistingTodo; the sharing poll uploads).
      for (const it of sharedItems) {
        const sharedId = crypto.randomUUID();
        const payload = {
          text: it.title, category: it.catName, priority: it.priority, note: '',
          due_date: it.due_date, snooze_until: it.snooze_until,
        };
        let onStaged;
        let wasStaged = false;
        const stagedP = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
        const upload = state.sharing.addItem(it.group_id, { id: sharedId, item_type: 'todo', payload, onStaged });
        await Promise.race([stagedP, upload.then(() => {}, () => {})]);
        if (!wasStaged) throw new Error(`Could not stage "${it.title}" in the group`);
        const { error: ptrErr } = await state.db.from('todos').insert({
          text: '', priority: 'normal', done: 0,
          category: it.catName, category_id: it.catId,
          sort_order: nextOrder(it.catId),
          shared_id: sharedId, shared_group_id: it.group_id,
        });
        if (ptrErr) {
          state.sharing.deleteItem(it.group_id, sharedId).catch(() => {});
          throw new Error(ptrErr.message);
        }
        upload.then(() => {}, async () => {
          await state.db.from('todos').delete().eq('shared_id', sharedId);
          await refreshTodos();
          showToast(`${t('todos.import_failed')} "${it.title}"`, 'error');
        });
      }
    },

    afterCreate: refreshTodos,
  });
};
