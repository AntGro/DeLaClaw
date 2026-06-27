import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, escQ, renderMd, showToast, showDeleteConfirm, balanceGrid, truncateWithShowMore, fetchAll } from './utils.js';
import { scrollToAndHighlight, initItemHoverDelay, initItemDragDrop, reorderItems, inlineEditText } from './item-utils.js';
import { t } from './i18n.js';

// ===================================================================
// LISTS — GENERIC USER-CREATED LISTS (bucket-card layout)
// ===================================================================

let listSearchQuery = '';

// Shortnames
const LIST_SHORTNAMES_LS_KEY = 'list_shortnames';
const LIST_SHORTNAMES_DB_KEY = 'list_shortnames';
let _listShortnames = {};

// Distinct colors for list cards (cycles)
const LIST_COLORS = [
  '#14b8a6', // teal
  '#ef4444', // red
  '#a855f7', // purple
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
];

function getListColor(list, idx) {
  if (list.color) return list.color;
  return LIST_COLORS[(idx >= 0 ? idx : 0) % LIST_COLORS.length];
}

// ===================================================================
// SHORTNAMES
// ===================================================================

async function loadListShortnames() {
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings').select('key,value').eq('key', LIST_SHORTNAMES_DB_KEY);
      if (data && data.length && data[0].value) {
        _listShortnames = JSON.parse(data[0].value);
        localStorage.setItem(LIST_SHORTNAMES_LS_KEY, data[0].value);
        return;
      }
    } catch (e) { console.warn('Could not load list shortnames from DB:', e.message); }
  }
  try { _listShortnames = JSON.parse(localStorage.getItem(LIST_SHORTNAMES_LS_KEY) || '{}'); } catch { _listShortnames = {}; }
}

async function saveListShortnames() {
  const json = JSON.stringify(_listShortnames);
  localStorage.setItem(LIST_SHORTNAMES_LS_KEY, json);
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings')
        .update({ value: json, updated_at: new Date().toISOString() })
        .eq('key', LIST_SHORTNAMES_DB_KEY).select();
      if (!data || data.length === 0) {
        await state.db.from('settings')
          .insert({ key: LIST_SHORTNAMES_DB_KEY, value: json, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('Could not save list shortnames to DB:', e.message); }
  }
}

function getListShortname(listId) { return _listShortnames[listId] || null; }

function setListShortname(listId, shortname) {
  if (shortname) { _listShortnames[listId] = shortname; }
  else { delete _listShortnames[listId]; }
  saveListShortnames();
}


// ===================================================================
// DATA
// ===================================================================

async function refreshLists() {
  if (!state.db.connected) return;
  await loadListShortnames();
  let lists;
  try {
    lists = await fetchAll(() => state.db
      .from('lists')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }));
  } catch (e1) {
    if (e1.code === '42P01' || e1.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allLists = lists || [];

  let items;
  try {
    items = await fetchAll(() => state.db
      .from('list_items')
      .select('*')
      .order('sort_order', { ascending: true }));
  } catch (e2) {
    if (e2.code === '42P01' || e2.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allListItems = items || [];

  if (state.currentView === 'lists') {
    renderLists();
  }
}


// ===================================================================
// RENDERING — bucket cards (like Projects / Wardrobe)
// ===================================================================

function renderLists() {
  const grid = document.getElementById('listsGrid');
  if (!grid) return;

  const lists = state.allLists || [];
  const allItems = state.allListItems || [];

  // Empty state
  if (lists.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list', 48, 'var(--muted)')}</div>
      <h3>${t('lists.empty_title')}</h3>
      <p>${t('lists.empty_hint')}</p>
      <button class="empty-cta" onclick="openAddListModal()">${lucideIcon('plus', 16)} ${t('lists.empty_cta')}</button>
    </div>`;
    renderListNavButtons([], {});
    return;
  }

  // Apply sort
  const sortBy = document.getElementById('listsSortBy')?.value || 'manual';
  const sortedLists = [...lists];
  if (sortBy === 'name') {
    sortedLists.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    sortedLists.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  // Group items by list
  const grouped = {};
  sortedLists.forEach(l => { grouped[l.id] = []; });
  allItems.forEach(item => {
    if (grouped[item.list_id]) {
      // Apply search filter
      if (listSearchQuery) {
        const q = listSearchQuery.toLowerCase();
        if (!(item.text && item.text.toLowerCase().includes(q)) &&
            !(item.note && item.note.toLowerCase().includes(q))) return;
      }
      grouped[item.list_id].push(item);
    }
  });

  // Also filter lists when searching — hide lists with no matching items
  const visibleLists = listSearchQuery
    ? sortedLists.filter(l => (grouped[l.id] || []).length > 0 || l.name.toLowerCase().includes(listSearchQuery.toLowerCase()))
    : sortedLists;

  renderListNavButtons(sortedLists, grouped);

  // Sort items within each list: unchecked first by sort_order, checked at bottom
  for (const listId of Object.keys(grouped)) {
    grouped[listId].sort((a, b) => {
      if ((a.checked || 0) !== (b.checked || 0)) return (a.checked || 0) - (b.checked || 0);
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
  }

  let html = '';
  visibleLists.forEach((list, idx) => {
    const items = grouped[list.id] || [];
    html += renderListCard(list, items, idx);
  });

  const scrollY = window.scrollY;
  grid.innerHTML = html;
  grid.className = 'project-grid';
  window.scrollTo(0, scrollY);

  // Init hover-delay + drag-drop for each list card
  visibleLists.forEach(list => {
    const card = grid.querySelector(`.list-bucket[data-list-id="${list.id}"]`);
    if (!card) return;
    const listEl = card.querySelector('.list-item-list');
    if (listEl) {
      initListHoverDelay(listEl);
      initListItemDragDrop(list.id, listEl);
    }
  });
  balanceGrid(grid);
}

function renderListCard(list, items, idx) {
  const color = getListColor(list, idx);
  const count = items.length;

  let itemsHtml = '';
  if (count === 0 && !listSearchQuery) {
    itemsHtml = `<div class="list-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">${t('lists.no_items')}</div>`;
  } else {
    itemsHtml = items.map(item => renderListItem(item)).join('');
  }

  // Quick-add input
  const quickAddHtml = `<div class="list-quick-add">
    <input type="text" class="list-quick-input" placeholder="${esc(t('lists.add_item'))}" maxlength="2000"
      onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();quickAddListItem(this,'${escQ(list.id)}');}">
    <button class="list-quick-add-btn" onclick="quickAddListItem(this.previousElementSibling,'${escQ(list.id)}')" title="${esc(t('lists.add_item'))}">${lucideIcon('plus', 16)}</button>
  </div>`;

  return `<div class="project-card list-bucket" data-list-id="${esc(list.id)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span>${lucideIcon(list.icon || 'list', 18)}</span>
        <strong style="font-size:1rem;">${esc(list.name)}</strong>
        <span style="font-size:0.78rem;opacity:0.75;">(${count})</span>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button class="archive-project-btn" onclick="openEditListModal('${escQ(list.id)}')" title="${t('lists.edit_list')}">
          ${lucideIcon('pencil', 14)}
        </button>
        <button class="todo-cat-delete-btn" onclick="deleteList('${escQ(list.id)}')" title="${t('common.delete')}">
          ${lucideIcon('trash-2', 16)}
        </button>
      </div>
    </div>
    <div class="task-list list-item-list" data-list-id="${esc(list.id)}">
      ${itemsHtml}
    </div>
    ${quickAddHtml}
  </div>`;
}

function renderListItem(item) {
  const checkedCls = item.checked ? ' list-item-checked' : '';
  const checkIcon = item.checked
    ? lucideIcon('check-square', 16, 'var(--accent)')
    : lucideIcon('square', 16, 'var(--muted)');
  const noteHtml = item.note
    ? `<div class="list-item-note">${esc(item.note)}</div>`
    : '';

  return `<div class="bucket-item list-item${checkedCls}" data-item-id="${item.id}">
    <div class="list-item-row">
      <button class="list-check-btn" onclick="toggleListItemCheck('${escQ(item.id)}')" title="Toggle">${checkIcon}</button>
      <div style="flex:1;min-width:0;">
        <span class="list-item-text">${truncateWithShowMore(item.text, 120, item.id, 'listtext')}</span>
        ${noteHtml}
      </div>
      <div class="list-item-actions">
        <button onclick="editListItemInlineFull('${escQ(item.id)}')" title="Edit">${lucideIcon('pencil', 14)}</button>
        <button onclick="deleteListItem('${escQ(item.id)}')" title="Delete">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderListNavButtons(lists, grouped) {
  const container = document.getElementById('listsNavButtons');
  if (!container) return;
  container.innerHTML = lists.map((list, idx) => {
    const count = (grouped[list.id] || []).length;
    const color = getListColor(list, idx);
    const shortname = getListShortname(list.id);
    const displayName = shortname || list.name;
    return `<button class="category-nav-btn" style="--cat-color:${color}" onclick="navigateToList('${escQ(list.id)}')" title="${esc(list.name)} (${count})">${esc(displayName)} (${count})</button>`;
  }).join('');
}

function navigateToList(listId) {
  const card = document.querySelector(`.list-bucket[data-list-id="${listId}"]`);
  if (!card) return;
  scrollToAndHighlight(card, 'var(--accent)');
}


// ===================================================================
// HOVER-DELAY, DRAG & DROP, INLINE EDIT
// ===================================================================

function initListHoverDelay(listEl) {
  initItemHoverDelay(listEl, {
    itemSelector: '.list-item',
    rowSelector: '.list-item-row',
    actionsSelector: '.list-item-actions',
    textSelector: '.list-item-text',
    onDblClick: (item) => {
      const id = item.dataset.itemId;
      if (id) editListItemInlineFull(id);
    },
  });
}

function initListItemDragDrop(listId, listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.list-item',
    idAttr: 'itemId',
    onReorder: async (draggedId, targetId) => {
      const items = (state.allListItems || []).filter(i => i.list_id === listId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      await reorderItems({
        items,
        allItems: state.allListItems || [],
        draggedId,
        targetId,
        container: listEl,
        itemSelector: '.list-item',
        idAttr: 'itemId',
        tableName: 'list_items',
        reinitFn: () => initListItemDragDrop(listId, listEl),
      });
    },
  });
}

async function editListItemInline(id) {
  const el = document.querySelector(`.list-item[data-item-id="${id}"] .list-item-text`);
  if (!el) return;
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;

  inlineEditText(el, item.text, {
    maxLength: 2000,
    saveFn: async (newText) => {
      const { error } = await state.db.from('list_items').update({
        text: newText,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
      item.text = newText;
      showToast(t('toast.updated'), 'success');
    },
    refreshFn: renderLists,
  });
}

function editListItemInlineFull(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  const el = document.querySelector(`.list-item[data-item-id="${id}"] .list-item-text`);
  if (!el) return;

  const actionsEl = el.closest('.list-item')?.querySelector('.list-item-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  const row = document.createElement('div');
  row.className = 'inline-edit-row';
  const label = document.createElement('label');
  label.className = 'inline-edit-label';
  label.textContent = t('common.notes');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input';
  input.value = item.note || '';
  input.placeholder = t('lists.note_placeholder');
  row.appendChild(label);
  row.appendChild(input);
  extras.appendChild(row);

  inlineEditText(el, item.text, {
    maxLength: 2000,
    extraEl: extras,
    collectExtra: () => ({ note: input.value.trim() }),
    saveFn: async (newText, extra) => {
      const updates = {};
      if (newText !== item.text) updates.text = newText;
      if (extra && (extra.note || '') !== (item.note || '')) updates.note = extra.note || null;
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { error } = await state.db.from('list_items').update(updates).eq('id', id);
        if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        Object.assign(item, updates);
        showToast(t('toast.updated'), 'success');
      }
    },
    refreshFn: renderLists,
  });
}


// ===================================================================
// CRUD — ITEMS
// ===================================================================

async function quickAddListItem(inputEl, listId) {
  const text = inputEl.value.trim();
  if (!text) return;

  // Show saving state on the quick-add row
  const wrapper = inputEl.closest('.list-quick-add');
  const btn = wrapper && wrapper.querySelector('.list-quick-add-btn');
  const btnHtml = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = `<span class="list-saving-spinner"></span>`;
  inputEl.disabled = true;

  const items = (state.allListItems || []).filter(i => i.list_id === listId);
  const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);

  const { error } = await state.db.from('list_items').insert({
    list_id: listId,
    text,
    sort_order: maxOrder + 1,
  });

  // Restore input state
  inputEl.disabled = false;
  if (btn) btn.innerHTML = btnHtml;

  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  inputEl.value = '';
  showToast(t('toast.added'), 'success');
  await refreshLists();
}

async function toggleListItemCheck(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  const newVal = item.checked ? 0 : 1;
  const { error } = await state.db.from('list_items').update({
    checked: newVal,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed'), 'error'); return; }
  item.checked = newVal;
  renderLists();
}

async function deleteListItem(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  showDeleteConfirm(
    t('common.delete'),
    `Remove "${item.text}"?`,
    async () => {
      const { error } = await state.db.from('list_items').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('toast.removed'), 'info');
      await refreshLists();
    }
  );
}


// ===================================================================
// CRUD — LISTS
// ===================================================================

function initListModals() {
  const app = document.getElementById('app');

  // Add List Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addListModal';
  m1.innerHTML = `<div class="modal">
    <h2>${lucideIcon('list', 20)} ${t('lists.add_list')}</h2>
    <label>${t('common.name')}</label>
    <input type="text" id="newListName" placeholder="${t('lists.name_placeholder')}" maxlength="100"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewList();}">
    <label>${t('lists.color')}</label>
    <input type="color" id="newListColor" value="#14b8a6">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddListModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveNewList()">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit List Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editListModal';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('lists.edit_list')}</h2>
    <input type="hidden" id="editListId">
    <label>${t('common.name')}</label>
    <input type="text" id="editListName" maxlength="100"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveEditList();}">
    <label>Shortname</label>
    <input type="text" id="editListShortname" maxlength="20" placeholder="e.g. GRC"
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveEditList();}">
    <label>${t('lists.color')}</label>
    <input type="color" id="editListColor">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeEditListModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveEditList()">${t('common.save')}</button>
    </div>
  </div>`;
  app.appendChild(m2);
}

function openAddListModal() {
  document.getElementById('newListName').value = '';
  document.getElementById('newListColor').value = '#14b8a6';
  document.getElementById('addListModal').classList.add('visible');
  setTimeout(() => document.getElementById('newListName').focus(), 100);
}

function closeAddListModal() {
  document.getElementById('addListModal').classList.remove('visible');
}

async function saveNewList() {
  const name = document.getElementById('newListName').value.trim();
  const color = document.getElementById('newListColor').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  const maxOrder = (state.allLists || []).reduce((m, l) => Math.max(m, l.sort_order || 0), 0);

  const { error } = await state.db.from('lists').insert({
    name,
    color: color || '#14b8a6',
    sort_order: maxOrder + 1,
  });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  closeAddListModal();
  showToast(t('toast.added'), 'success');
  await refreshLists();
}

function openEditListModal(listId) {
  const list = (state.allLists || []).find(l => l.id === listId);
  if (!list) return;
  document.getElementById('editListId').value = listId;
  document.getElementById('editListName').value = list.name || '';
  document.getElementById('editListShortname').value = getListShortname(listId) || '';
  document.getElementById('editListColor').value = list.color || '#14b8a6';
  document.getElementById('editListModal').classList.add('visible');
  setTimeout(() => document.getElementById('editListName').focus(), 100);
}

function closeEditListModal() {
  document.getElementById('editListModal').classList.remove('visible');
}

async function saveEditList() {
  const id = document.getElementById('editListId').value;
  const name = document.getElementById('editListName').value.trim();
  const shortname = document.getElementById('editListShortname').value.trim();
  const color = document.getElementById('editListColor').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  setListShortname(id, shortname);

  const { error } = await state.db.from('lists').update({
    name,
    color: color || '#14b8a6',
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  closeEditListModal();
  showToast(t('toast.updated'), 'success');
  await refreshLists();
}

async function deleteList(listId) {
  const list = (state.allLists || []).find(l => l.id === listId);
  if (!list) return;
  const itemCount = (state.allListItems || []).filter(i => i.list_id === listId).length;
  const msg = itemCount > 0
    ? `Delete "${list.name}" and its ${itemCount} item(s)?`
    : `Delete "${list.name}"?`;
  showDeleteConfirm(
    t('common.delete'),
    msg,
    async () => {
      // Delete items in bulk
      if (itemCount > 0) await state.db.from('list_items').delete().eq('list_id', listId);
      const { error } = await state.db.from('lists').delete().eq('id', listId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('toast.removed'), 'info');
      await refreshLists();
    }
  );
}


// ===================================================================
// EXPORTS
// ===================================================================

export { refreshLists, renderLists, initListModals };

// Window bindings
window.openAddListModal = openAddListModal;
window.closeAddListModal = closeAddListModal;
window.saveNewList = saveNewList;
window.openEditListModal = openEditListModal;
window.closeEditListModal = closeEditListModal;
window.saveEditList = saveEditList;
window.deleteList = deleteList;
window.navigateToList = navigateToList;
window.renderLists = renderLists;
window.quickAddListItem = quickAddListItem;
window.toggleListItemCheck = toggleListItemCheck;
window.editListItemInlineFull = editListItemInlineFull;
window.deleteListItem = deleteListItem;
window.filterLists = function(e) { listSearchQuery = e.target.value; renderLists(); };
