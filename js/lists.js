import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, escQ, renderMd, showToast, showDeleteConfirm, balanceGrid, truncateWithShowMore, fetchAll, createSettingsAccessor } from './utils.js';
import { cleanupDragArtifacts, scrollToAndHighlight, initItemHoverDelay, initItemDragDrop, reorderItems, inlineEditText } from './item-utils.js';
import { t } from './i18n.js';
import { sharedBadge, assigneeDots, openSharePopover } from './sharing-ui.js';

// ===================================================================
// LISTS — GENERIC USER-CREATED LISTS (bucket-card layout)
// ===================================================================

let listSearchQuery = '';

// Shortnames
// DB-synced settings accessor
const _listShortnamesAccessor = createSettingsAccessor('list_shortnames', 'list_shortnames');

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
  await _listShortnamesAccessor.load();
}

function getListShortname(listId) { return _listShortnamesAccessor.get()[listId] || null; }

function setListShortname(listId, shortname) {
  const map = _listShortnamesAccessor.get();
  if (shortname) { map[listId] = shortname; }
  else { delete map[listId]; }
  _listShortnamesAccessor.save(map);
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

  // Enrich shared list item pointers with live data from Drive
  if (state.sharing) {
    const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'list_item');
    const sharedById = new Map(sharedItems.map(i => [i.id, i]));

    for (const item of state.allListItems) {
      if (!item.shared_id) continue;
      const sh = sharedById.get(item.shared_id);
      if (sh) {
        item.text = sh.payload?.text || sh.payload?.title || '';
        item.note = sh.payload?.note || null;
        item.checked = sh.done ? 1 : 0;
        item._shared = sh;
      }
    }

    // Precompute which shared list items the current user created
    _myCreatedSharedListItemIds.clear();
    if (typeof state.sharing.getCurrentMember === 'function') {
      const groupIds = new Set(state.allListItems.filter(i => i.shared_group_id).map(i => i.shared_group_id));
      const memberIdPerGroup = new Map();
      const gidArr = [...groupIds];
      const members = await Promise.all(gidArr.map(gid => Promise.resolve(state.sharing.getCurrentMember(gid))));
      gidArr.forEach((gid, i) => { if (members[i]?.memberId) memberIdPerGroup.set(gid, members[i].memberId); });
      for (const item of state.allListItems) {
        if (!item._shared || !item.shared_group_id) continue;
        const myId = memberIdPerGroup.get(item.shared_group_id);
        if (myId && item._shared.created_by === myId) _myCreatedSharedListItemIds.add(item.shared_id);
      }
    }
  }

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
  cleanupDragArtifacts();

  const lists = state.allLists || [];
  const allItems = state.allListItems || [];

  // Empty state
  if (lists.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list', 48, 'var(--muted)')}</div>
      <h3>${t('lists.empty_title')}</h3>
      <p>${t('lists.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-list">${lucideIcon('plus', 16)} ${t('lists.empty_cta')}</button>
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
  // Always hide the Shared list when it has no items
  let visibleLists = listSearchQuery
    ? sortedLists.filter(l => (grouped[l.id] || []).length > 0 || l.name.toLowerCase().includes(listSearchQuery.toLowerCase()))
    : sortedLists;
  visibleLists = visibleLists.filter(l => l.name !== SHARED_LIST_NAME || (grouped[l.id] || []).length > 0);
  // Shared list always first when visible
  visibleLists.sort((a, b) => {
    const aShared = a.name === SHARED_LIST_NAME ? 0 : 1;
    const bShared = b.name === SHARED_LIST_NAME ? 0 : 1;
    return aShared - bShared;
  });

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
  const isSharedList = list.name === SHARED_LIST_NAME;
  const displayName = isSharedList ? t('sharing.shared') : list.name;
  const listIcon = isSharedList ? 'users' : (list.icon || 'list');

  let itemsHtml = '';
  if (count === 0 && !listSearchQuery) {
    itemsHtml = `<div class="list-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">${t('lists.no_items')}</div>`;
  } else {
    itemsHtml = items.map(item => renderListItem(item)).join('');
  }

  // Quick-add input — not shown for the auto-managed Shared list
  const quickAddHtml = isSharedList ? '' : `<div class="list-quick-add">
    <input type="text" class="list-quick-input" placeholder="${esc(t('lists.add_item'))}" maxlength="2000"
      data-action="quick-add-input" data-list-id="${esc(list.id)}">
    <button class="list-quick-add-btn" data-action="quick-add-list-item" data-list-id="${esc(list.id)}" title="${esc(t('lists.add_item'))}">${lucideIcon('plus', 16)}</button>
    ${state.sharing?.getAllGroups().length ? `<button class="sharing-share-btn" data-action="share-list-item-from-add" data-list-id="${esc(list.id)}" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
  </div>`;

  const headerActions = isSharedList ? '' : `<div class="project-header-actions" style="opacity:1;">
        <button class="archive-project-btn" data-action="open-edit-list" data-id="${esc(list.id)}" title="${t('lists.edit_list')}">
          ${lucideIcon('pencil', 14)}
        </button>
        <button class="todo-cat-delete-btn" data-action="delete-list" data-id="${esc(list.id)}" title="${t('common.delete')}">
          ${lucideIcon('trash-2', 16)}
        </button>
      </div>`;

  return `<div class="project-card list-bucket" data-list-id="${esc(list.id)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span>${lucideIcon(listIcon, 18)}</span>
        <strong style="font-size:1rem;">${esc(displayName)}</strong>
        <span style="font-size:0.78rem;opacity:0.75;">(${count})</span>
      </div>
      ${headerActions}
    </div>
    ${quickAddHtml}
    <div class="task-list list-item-list" data-list-id="${esc(list.id)}">
      ${itemsHtml}
    </div>
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

  // Shared list item badge
  const isShared = item.shared_id && item.shared_group_id;
  let sharedHtml = '';
  if (isShared && state.sharing) {
    const group = state.sharing.getAllGroups().find(g => g.id === item.shared_group_id);
    sharedHtml = sharedBadge(group?.name || '', item.shared_group_id);
  }

  return `<div class="bucket-item list-item${checkedCls}" data-item-id="${item.id}">
    ${sharedHtml}
    <div class="list-item-row">
      <button class="list-check-btn" data-action="toggle-list-item-check" data-id="${esc(item.id)}" title="Toggle">${checkIcon}</button>
      <div style="flex:1;min-width:0;">
        <span class="list-item-text">${truncateWithShowMore(item.text, 120, item.id, 'listtext')}</span>
        ${noteHtml}
      </div>
      <div class="list-item-actions">
        ${!isShared && state.sharing?.getAllGroups().length ? `<button data-action="share-existing-list-item" data-id="${esc(item.id)}" title="${t('sharing.share')}">${lucideIcon('share', 14)}</button>` : ''}
        ${isShared && _myCreatedSharedListItemIds.has(item.shared_id) ? `<button data-action="unshare-list-item" data-id="${esc(item.id)}" title="${t('sharing.unshare')}">${lucideIcon('share-off', 14)}</button>` : ''}
        ${isShared && !_myCreatedSharedListItemIds.has(item.shared_id) ? `<button data-action="copy-list-item-to-personal" data-id="${esc(item.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon('copy', 14)}</button>` : ''}
        <button data-action="edit-list-item-inline" data-id="${esc(item.id)}" title="Edit">${lucideIcon('pencil', 14)}</button>
        <button data-action="delete-list-item" data-id="${esc(item.id)}" title="Delete">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderListNavButtons(lists, grouped) {
  const container = document.getElementById('listsNavButtons');
  if (!container) return;
  // Hide shared list from nav when empty
  const navLists = lists.filter(l => l.name !== SHARED_LIST_NAME || (grouped[l.id] || []).length > 0);
  // Shared list always first in nav when visible
  navLists.sort((a, b) => {
    const aShared = a.name === SHARED_LIST_NAME ? 0 : 1;
    const bShared = b.name === SHARED_LIST_NAME ? 0 : 1;
    return aShared - bShared;
  });
  container.innerHTML = navLists.map((list, idx) => {
    const count = (grouped[list.id] || []).length;
    const color = getListColor(list, idx);
    const shortname = getListShortname(list.id);
    const isSharedList = list.name === SHARED_LIST_NAME;
    const displayName = isSharedList ? t('sharing.shared') : (shortname || list.name);
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-list" data-id="${esc(list.id)}" title="${esc(isSharedList ? t('sharing.shared') : list.name)} (${count})">${esc(displayName)} (${count})</button>`;
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

function editListItemInline(id) {
  return editListItemInlineFull(id);
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

  // Note row
  const row = document.createElement('div');
  row.className = 'inline-edit-row inline-edit-row-note';
  const label = document.createElement('label');
  label.className = 'inline-edit-label';
  label.textContent = t('common.notes');
  const input = document.createElement('textarea');
  input.className = 'inline-edit-input';
  input.value = item.note || '';
  input.placeholder = t('lists.note_placeholder');
  input.rows = 2;
  input.style.resize = 'vertical';
  input.style.fontFamily = 'inherit';
  // Allow Enter to create newlines — stop propagation so extraEl handler doesn't finishEdit
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.stopPropagation();
  });
  // Auto-size the textarea
  input.addEventListener('input', () => {
    input.style.height = '0';
    input.style.height = input.scrollHeight + 'px';
  });
  row.appendChild(label);
  row.appendChild(input);
  extras.appendChild(row);

  // List selector row — move item between lists
  const allLists = state.allLists || [];
  if (allLists.length > 1) {
    const listRow = document.createElement('div');
    listRow.className = 'inline-edit-row';
    const listLabel = document.createElement('label');
    listLabel.className = 'inline-edit-label';
    listLabel.textContent = t('common.list');
    const listSelect = document.createElement('select');
    listSelect.className = 'inline-edit-input';
    allLists
      .filter(l => l.name !== SHARED_LIST_NAME || l.id === item.list_id)
      .forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name === SHARED_LIST_NAME ? t('sharing.shared') : l.name;
        if (l.id === item.list_id) opt.selected = true;
        listSelect.appendChild(opt);
      });
    listRow.appendChild(listLabel);
    listRow.appendChild(listSelect);
    extras.appendChild(listRow);
  }

  const listSelect = extras.querySelector('select');

  inlineEditText(el, item.text, {
    maxLength: 2000,
    extraEl: extras,
    collectExtra: () => ({
      note: input.value.trim(),
      list_id: listSelect ? listSelect.value : item.list_id,
    }),
    saveFn: async (newText, extra) => {
      const updates = {};
      if (newText !== item.text) updates.text = newText;
      if (extra && (extra.note || '') !== (item.note || '')) updates.note = extra.note || null;
      if (extra && extra.list_id && extra.list_id !== item.list_id) updates.list_id = extra.list_id;
      if (Object.keys(updates).length === 0) return;

      // Shared → text & note go to Drive payload
      if (item.shared_id && item.shared_group_id && state.sharing) {
        const drivePayload = {};
        if ('text' in updates) drivePayload.text = updates.text;
        if ('note' in updates) drivePayload.note = updates.note;
        if (Object.keys(drivePayload).length > 0) {
          const currentPayload = item._shared?.payload || {};
          await state.sharing.updateItem(item.shared_group_id, item.shared_id, { payload: { ...currentPayload, ...drivePayload } });
        }
        // list_id is local-only — update pointer directly
        if ('list_id' in updates) {
          await state.db.from('list_items').update({ list_id: updates.list_id }).eq('id', id);
        }
        Object.assign(item, updates);
        showToast(t('toast.updated'), 'success');
        return;
      }

      // Normal → local DB
      updates.updated_at = new Date().toISOString();
      const { error } = await state.db.from('list_items').update(updates).eq('id', id);
      if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
      Object.assign(item, updates);
      showToast(t('toast.updated'), 'success');
    },
    refreshFn: renderLists,
  });
}


// ===================================================================
// CRUD — ITEMS
// ===================================================================

async function quickAddListItem(inputEl, listId) {
  // Support delegation: inputEl may be event or element, listId may be in dataset
  let actualInput = null;
  let actualListId = listId;

  if (inputEl && inputEl.target) {
    // Called as event handler wrapper via delegation - resolve
    const el = inputEl.target.closest ? inputEl.target.closest('[data-action="quick-add-list-item"]') : null;
    if (el) {
      actualListId = el.dataset.listId || actualListId;
      const wrapper = el.closest('.list-quick-add');
      actualInput = wrapper ? wrapper.querySelector('.list-quick-input') : null;
    }
  } else if (typeof inputEl === 'string' && !listId) {
    // Called as quickAddListItem(listId) from old onkeydown handler - not used anymore
    actualListId = inputEl;
    actualInput = null;
  } else if (inputEl && inputEl.dataset && inputEl.dataset.listId) {
    // inputEl is actually the input with data-list-id
    actualInput = inputEl;
    actualListId = inputEl.dataset.listId || listId;
  } else {
    actualInput = inputEl;
  }

  // If called via button click delegation, actualInput is the input element sibling
  if (!actualInput && typeof actualListId === 'string') {
    // fallback: try to find via DOM if we have listId but no input
    // Will search for quick-input in same list-bucket
    const card = document.querySelector(`.list-bucket[data-list-id="${actualListId}"]`);
    if (card) actualInput = card.querySelector('.list-quick-input');
  }

  // If actualInput is still the button, find its sibling input
  if (actualInput && actualInput.classList && actualInput.classList.contains('list-quick-add-btn')) {
    const wrapper = actualInput.closest('.list-quick-add');
    actualInput = wrapper ? wrapper.querySelector('.list-quick-input') : null;
  }

  // For quick-add-input Enter handler: actualInput is the input itself
  if (actualInput && !actualListId) {
    actualListId = actualInput.dataset.listId || actualInput.getAttribute('data-list-id');
  }

  const inputToUse = actualInput;
  if (!inputToUse) return;
  const text = inputToUse.value.trim();
  if (!text) return;

  // Show saving state on the quick-add row
  const wrapper = inputToUse.closest('.list-quick-add');
  const btn = wrapper && wrapper.querySelector('.list-quick-add-btn');
  const btnHtml = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = `<span class="list-saving-spinner"></span>`;
  inputToUse.disabled = true;

  const items = (state.allListItems || []).filter(i => i.list_id === actualListId);
  const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);

  const { error } = await state.db.from('list_items').insert({
    list_id: actualListId,
    text,
    sort_order: maxOrder + 1,
  });

  // Restore input state
  inputToUse.disabled = false;
  if (btn) btn.innerHTML = btnHtml;

  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  inputToUse.value = '';
  showToast(t('toast.added'), 'success');
  await refreshLists();
}

const _pendingListItemToggles = new Set();

async function toggleListItemCheck(id, btnEl) {
  if (!id) return;
  if (_pendingListItemToggles.has(id)) return;
  _pendingListItemToggles.add(id);

  const safeId = CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\"');
  const allBtns = document.querySelectorAll(`button[data-action="toggle-list-item-check"][data-id="${safeId}"]`);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : (allBtns[0] || null);
  const toToggle = new Set([...allBtns, ...(targetBtn ? [targetBtn] : [])]);
  toToggle.forEach(b => { b.disabled = true; b.classList.add('saving', 'is-pending'); b.setAttribute('aria-busy', 'true'); });

  try {
    const item = (state.allListItems || []).find(x => x.id === id);
    if (!item) return;
    const newVal = item.checked ? 0 : 1;

    // Shared → Drive only
    if (item.shared_id && item.shared_group_id && state.sharing) {
      try {
        if (newVal) {
          await state.sharing.completeItem(item.shared_group_id, item.shared_id);
        } else {
          await state.sharing.uncompleteItem(item.shared_group_id, item.shared_id);
        }
        item.checked = newVal;
        renderLists();
      } catch (e) { showToast(e.message, 'error'); }
      return;
    }

    // Normal → local DB
    const { error } = await state.db.from('list_items').update({
      checked: newVal,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
    item.checked = newVal;
    renderLists();
  } finally {
    _pendingListItemToggles.delete(id);
    toToggle.forEach(b => { b.disabled = false; b.classList.remove('saving', 'is-pending'); b.removeAttribute('aria-busy'); });
  }
}

async function deleteListItem(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  showDeleteConfirm(
    t('common.delete'),
    `Remove "${item.text}"?`,
    async () => {
      // Shared → delete from Drive + delete local pointer
      if (item.shared_id && item.shared_group_id && state.sharing) {
        try {
          await state.sharing.deleteItem(item.shared_group_id, item.shared_id);
        } catch (e) { /* item may already be gone from Drive */ }
      }
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
      data-action="save-new-list-on-enter">
    <label>${t('lists.color')}</label>
    <input type="color" id="newListColor" value="#14b8a6">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-list">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-list">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit List Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editListModal';
  m2.dataset.action = 'close-edit-list';
  m2.dataset.overlayClose = 'true';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('lists.edit_list')}</h2>
    <input type="hidden" id="editListId">
    <label>${t('common.name')}</label>
    <input type="text" id="editListName" maxlength="100"
      data-action="save-edit-list-on-enter">
    <label>Shortname</label>
    <input type="text" id="editListShortname" maxlength="20" placeholder="e.g. GRC"
      data-action="save-edit-list-on-enter">
    <label>${t('lists.color')}</label>
    <input type="color" id="editListColor">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-list">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-list">${t('common.save')}</button>
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
  const items = (state.allListItems || []).filter(i => i.list_id === listId);
  const itemCount = items.length;
  const msg = itemCount > 0
    ? `Delete "${list.name}" and its ${itemCount} item(s)?`
    : `Delete "${list.name}"?`;
  showDeleteConfirm(
    t('common.delete'),
    msg,
    async () => {
      // Delete shared items from Drive first
      if (state.sharing) {
        for (const item of items) {
          if (item.shared_id && item.shared_group_id) {
            try { await state.sharing.deleteItem(item.shared_group_id, item.shared_id); } catch { /* ok */ }
          }
        }
      }
      // Delete items in bulk from local DB
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

// ── Shared List Items — sync pointers ─────────────────────────────

let _syncingListItems = false;
// ── Shared list: auto-created landing list for received shared items ──
const SHARED_LIST_NAME = '__shared__';
const _myCreatedSharedListItemIds = new Set(); // shared_ids where current user is creator

async function getOrCreateSharedList(localLists) {
  // Look for existing shared list (by internal name)
  let existing = localLists.find(l => l.name === SHARED_LIST_NAME);
  if (existing) return existing;

  const maxOrder = localLists.reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
  const { data: created, error } = await state.db.from('lists').insert({
    name: SHARED_LIST_NAME,
    color: '#a78bfa',
    icon: 'users',
    sort_order: maxOrder + 1,
  }).select().single();

  if (error) {
    console.warn('getOrCreateSharedList: failed to create', error);
    return null;
  }

  let result = created;
  if (!result?.id) {
    // Fallback: query for it
    const rows = await fetchAll(() => state.db.from('lists').select('id,name,sort_order,color,icon').eq('name', SHARED_LIST_NAME));
    result = rows?.[0] || null;
  }
  if (result) localLists.push(result);
  return result;
}

async function syncSharedListItems() {
  if (_syncingListItems) return;
  _syncingListItems = true;
  try {
    await _doSyncSharedListItems();
  } finally {
    _syncingListItems = false;
  }
}
async function _doSyncSharedListItems() {
  if (!state.sharing || !state.db.connected) return;

  const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'list_item');
  const sharedById = new Map(sharedItems.map(i => [i.id, i]));

  // Get current local pointers
  let localPointers;
  try {
    const res = await fetchAll(() => state.db
      .from('list_items')
      .select('id,shared_id,shared_group_id,list_id')
      .not('shared_id', 'is', null));
    localPointers = res || [];
  } catch { localPointers = []; }

  const existingSharedIds = new Set(localPointers.map(p => p.shared_id));

  let localLists = state.allLists || [];
  if (localLists.length === 0) {
    try {
      localLists = await fetchAll(() => state.db
        .from('lists')
        .select('id,name,sort_order')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }));
    } catch { localLists = []; }
  }

  let localItemsForOrder = state.allListItems || [];
  if (localItemsForOrder.length === 0) {
    try {
      localItemsForOrder = await fetchAll(() => state.db
        .from('list_items')
        .select('id,list_id,sort_order'));
    } catch { localItemsForOrder = []; }
  }

  let needsRefresh = false;

  // Create pointers for new shared items — always land in the "Shared" list
  for (const sh of sharedItems) {
    if (existingSharedIds.has(sh.id)) continue;

    let targetList = await getOrCreateSharedList(localLists);
    if (!targetList) continue;

    // DB check to prevent race duplicates
    try {
      const existing = await fetchAll(() => state.db
        .from('list_items')
        .select('id')
        .eq('shared_id', sh.id));
      if (existing && existing.length > 0) continue;
    } catch { /* proceed */ }

    const items = localItemsForOrder.filter(i => i.list_id === targetList.id);
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);

    await state.db.from('list_items').insert({
      list_id: targetList.id,
      text: '',
      sort_order: maxOrder + 1,
      shared_id: sh.id,
      shared_group_id: sh.group_id,
    });
    needsRefresh = true;
  }

  // Remove pointers for deleted shared items
  for (const ptr of localPointers) {
    if (!sharedById.has(ptr.shared_id)) {
      await state.db.from('list_items').delete().eq('id', ptr.id);
      needsRefresh = true;
    }
  }

  if (needsRefresh) {
    await refreshLists();
  }
}

async function shareListItemFromAdd(btn, listId) {
  // Delegation support: btn may be an event, button element, or legacy list id.
  let actualBtn = btn;
  let actualListId = listId;
  if (typeof btn === 'string') {
    actualListId = btn;
    const safeListId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(btn) : btn.replace(/"/g, '\"');
    actualBtn = document.querySelector(`[data-action="share-list-item-from-add"][data-list-id="${safeListId}"]`);
  } else if (btn && btn.target) {
    // event case
    actualBtn = btn.target.closest ? btn.target.closest('[data-action="share-list-item-from-add"]') : btn.target;
    actualListId = actualBtn ? actualBtn.dataset.listId : listId;
  } else if (btn && btn.dataset && btn.dataset.listId) {
    actualListId = btn.dataset.listId || listId;
    actualBtn = btn;
  }
  const addRow = actualBtn && typeof actualBtn.closest === 'function' ? actualBtn.closest('.list-quick-add') : null;
  if (!addRow) return;
  const input = addRow.querySelector('.list-quick-input');
  const text = input?.value.trim();
  if (!text) return;

  // Find list name for payload context
  const listObj = (state.allLists || []).find(l => l.id === actualListId);

  openSharePopover(actualBtn, async (groupId) => {
    // Pre-generate UUID for pointer → Drive linkage
    const presetId = crypto.randomUUID();

    // 1. Insert local pointer FIRST (prevents race with syncSharedListItems)
    const items = (state.allListItems || []).filter(i => i.list_id === actualListId);
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
    const { error: ptrErr } = await state.db.from('list_items').insert({
      list_id: actualListId,
      text: '',
      sort_order: maxOrder + 1,
      shared_id: presetId,
      shared_group_id: groupId,
    });
    if (ptrErr) { showToast(t('toast.failed_to_add') + ': ' + ptrErr.message, 'error'); return; }

    // 2. Write to Drive with the same ID
    try {
      await state.sharing.addItem(groupId, {
        id: presetId,
        item_type: 'list_item',
        payload: { text, list_name: listObj?.name || '' },
      });
      input.value = '';
      showToast(t('sharing.shared') + '!', 'success');
      await refreshLists();
    } catch (e) {
      // Drive failed — clean up local pointer
      await state.db.from('list_items').delete().eq('shared_id', presetId);
      showToast(e.message, 'error');
    }
  }, { showAssignees: false });
}
window.shareListItemFromAdd = shareListItemFromAdd;

async function shareExistingListItem(id, el) {
  if (!state.sharing) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || item.shared_id) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-list-item"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  const listObj = (state.allLists || []).find(l => l.id === item.list_id);
  openSharePopover(btn, async (groupId) => {
    try {
      const sharedId = crypto.randomUUID();
      // 1. Create shared item on the sharing layer
      await state.sharing.addItem(groupId, {
        id: sharedId,
        item_type: 'list_item',
        payload: { text: item.text, list_name: listObj?.name || '', note: item.note || '' },
      });
      // 2. Create local pointer
      const items = (state.allListItems || []).filter(i => i.list_id === item.list_id);
      const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
      const { error: ptrErr } = await state.db.from('list_items').insert({
        list_id: item.list_id,
        text: '',
        sort_order: maxOrder + 1,
        shared_id: sharedId,
        shared_group_id: groupId,
      });
      if (ptrErr) { showToast(t('toast.failed_to_add') + ': ' + ptrErr.message, 'error'); return; }
      // 3. Delete the personal item
      await state.db.from('list_items').delete().eq('id', item.id);
      showToast(t('sharing.shared') + '!', 'success');
      await refreshLists();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, { showAssignees: false });
}
window.shareExistingListItem = shareExistingListItem;

// ── Unshare list item (creator only): move shared item back to personal ──
async function unshareListItem(id, el) {
  if (!state.sharing) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || !item.shared_id || !item.shared_group_id) return;

  showDeleteConfirm(
    t('sharing.unshare'),
    t('sharing.unshare_confirm'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unshare-list-item"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        // 1. Create personal list item (same list)
        const { error: insErr } = await state.db.from('list_items').insert({
          list_id: item.list_id,
          text: item.text || '',
          note: item.note || '',
          checked: item.checked ? 1 : 0,
          sort_order: item.sort_order || 0,
        });
        if (insErr) { showToast(insErr.message, 'error'); return; }
        // 2. Delete shared item from sharing layer
        await state.sharing.deleteItem(item.shared_group_id, item.shared_id);
        // 3. Delete the local pointer
        await state.db.from('list_items').delete().eq('id', item.id);
        showToast(t('sharing.unshared'), 'success');
        await refreshLists();
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
      }
    }
  );
}
window.unshareListItem = unshareListItem;

// ── Copy list item to personal (non-creator) ──
async function copyListItemToPersonal(id, el) {
  if (!state.sharing) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || !item.shared_id || !item.shared_group_id) return;

  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="copy-list-item-to-personal"][data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try {
    // Find the first user-owned list (non-shared) to place the copy
    let personalList = (state.allLists || []).find(l => l.name !== '__shared__');
    if (!personalList) {
      // Auto-create a personal list
      const maxOrder = (state.allLists || []).reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
      const { data: newList, error: listErr } = await state.db.from('lists').insert({
        name: t('lists.default_list_name') || 'My List',
        sort_order: maxOrder + 1,
      }).select().single();
      if (listErr || !newList) { showToast(listErr?.message || 'Failed to create list', 'error'); return; }
      personalList = newList;
    }
    const items = (state.allListItems || []).filter(i => i.list_id === personalList.id);
    const maxItemOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
    const { error: insErr } = await state.db.from('list_items').insert({
      list_id: personalList.id,
      text: item.text || '',
      note: item.note || '',
      checked: item.checked ? 1 : 0,
      sort_order: maxItemOrder + 1,
    });
    if (insErr) { showToast(insErr.message, 'error'); return; }
    showToast(t('sharing.copied_to_personal'), 'success');
    await refreshLists();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}
window.copyListItemToPersonal = copyListItemToPersonal;

export { refreshLists, renderLists, initListModals, syncSharedListItems };

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
window.editListItemInline = editListItemInline;
window.editListItemInlineFull = editListItemInlineFull;
window.deleteListItem = deleteListItem;
window.filterLists = function(e) { listSearchQuery = e.target.value; renderLists(); };
