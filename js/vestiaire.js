import { lucideIcon } from './icons.js';
import state, { DEFAULT_CATEGORY_PALETTE, GENERAL_CATEGORY_COLOR, SHARED_CATEGORY as SHARED_CAT_CONST } from './state.js';
import { esc, escQ, showToast, showDeleteConfirm, balanceGrid, fetchAll, backfillCategoryColors } from './utils.js';
import { cleanupDragArtifacts, scrollToAndHighlight, initItemHoverDelay, initItemDragDrop, reorderItems, inlineEditText } from './item-utils.js';
import { t } from './i18n.js';

// ===================================================================
// VESTIAIRE — WARDROBE TRACKER (bucket-card layout)
// ===================================================================

let vestSearchQuery = '';
let vestFilter = 'all';

// ── Category table state ──
// Categories live in the vestiaire_categories DB table. Loaded into maps for fast lookup.
const SHARED_CATEGORY = SHARED_CAT_CONST;
let _vestCatMap = new Map();    // id → row
let _vestCatByName = new Map(); // name → row (backward compat)
let _defaultVestCatId = null;   // protected default row
let _sharedVestCatId = null;    // protected __shared__ row

async function loadVestiaireCategories() {
  const { data, error } = await state.db.from('vestiaire_categories').select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('loadVestiaireCategories error:', error); return; }
  _vestCatMap.clear();
  _vestCatByName.clear();
  _defaultVestCatId = null;
  _sharedVestCatId = null;
  for (const row of (data || [])) {
    _vestCatMap.set(row.id, row);
    _vestCatByName.set(row.name, row);
    if (row.is_protected && row.name === SHARED_CATEGORY) _sharedVestCatId = row.id;
    else if (row.is_protected && row.name !== SHARED_CATEGORY) _defaultVestCatId = row.id;
  }
  await backfillCategoryColors('vestiaire_categories', _vestCatMap);
}

function getVestiaireCategories() { return _vestCatMap; }

// ── Category helpers ──
function getVestCatColor(catId) { return _vestCatMap.get(catId)?.color || GENERAL_CATEGORY_COLOR; }
function getVestCatShortname(catId) { return _vestCatMap.get(catId)?.shortname || ''; }
function getVestCatName(catId) { return _vestCatMap.get(catId)?.name ?? ''; }
function getVestCatDisplayName(catId) {
  const cat = _vestCatMap.get(catId);
  if (!cat) return t('common.category_default');
  if (cat.name === '') return t('common.category_default');
  if (cat.name === SHARED_CATEGORY) return t('sharing.shared');
  return cat.name;
}
function catIdForVest(item) { return item.category_id || _vestCatByName.get(item.category ?? '')?.id || _defaultVestCatId; }


// ===================================================================
// DATA
// ===================================================================

async function refreshVestiaire() {
  if (!state.db.connected) return;
  await loadVestiaireCategories();
  let data;
  try {
    data = await fetchAll(() => state.db
      .from('vestiaire')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }));
  } catch (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allVestiaire = data || [];
  // Categories already loaded via loadVestiaireCategories() above
  if (state.currentView === 'vestiaire') {
    renderVestiaire();
  }
}


// ===================================================================
// RENDERING — bucket cards (like Projects)
// ===================================================================

function setVestiaireFilter(filter) {
  vestFilter = filter;
  document.querySelectorAll('#vestiaireFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderVestiaire();
}

function renderVestiaire() {
  const grid = document.getElementById('vestiaireGrid');
  if (!grid) return;
  cleanupDragArtifacts();

  let items = state.allVestiaire || [];
  const catRows = Array.from(_vestCatMap.values()).sort((a, b) => a.sort_order - b.sort_order);

  // Show page-level empty state when no items and only protected (default) categories
  const userCats = catRows.filter(c => !c.is_protected);
  if (items.length === 0 && userCats.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('shirt', 48, 'var(--muted)')}</div>
      <h3>${t('vestiaire.empty_title')}</h3>
      <p>${t('vestiaire.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-vestiaire-category">${lucideIcon('plus', 16)} ${t('vestiaire.empty_cta')}</button>
    </div>`;
    renderVestiaireNavButtons([], []);
    return;
  }

  // Apply status filter
  if (vestFilter === 'owned') {
    items = items.filter(v => v.purchase_status === 'achete');
  } else if (vestFilter === 'tried') {
    items = items.filter(v => v.purchase_status === 'essaye');
  } else if (vestFilter === 'wishlist') {
    items = items.filter(v => !v.purchase_status);
  }

  // Apply search filter
  if (vestSearchQuery) {
    const q = vestSearchQuery.toLowerCase();
    items = items.filter(v =>
      (v.name && v.name.toLowerCase().includes(q)) ||
      (v.brand && v.brand.toLowerCase().includes(q)) ||
      (v.category && v.category.toLowerCase().includes(q))
    );
  }

  renderVestiaireNavButtons(catRows, items);

  // Apply sort
  const sortBy = document.getElementById('vestiaireSortBy')?.value || 'manual';
  const sortFn = sortBy === 'name'
    ? (a, b) => (a.name || '').localeCompare(b.name || '')
    : sortBy === 'brand'
    ? (a, b) => (a.brand || '').localeCompare(b.brand || '')
    : (a, b) => (a.sort_order || 0) - (b.sort_order || 0);

  // Group items by category ID
  const grouped = {};
  catRows.forEach(c => { grouped[c.id] = []; });
  items.forEach(v => {
    const cId = catIdForVest(v);
    if (cId && !grouped[cId]) grouped[cId] = [];
    if (cId) grouped[cId].push(v);
    else {
      // Uncategorized
      if (!grouped['_autre']) grouped['_autre'] = [];
      grouped['_autre'].push(v);
    }
  });
  // Sort within each group
  Object.values(grouped).forEach(arr => arr.sort(sortFn));

  // Render a card per category (skip empty protected + empty when searching)
  let html = '';
  catRows.forEach(cat => {
    const catItems = grouped[cat.id] || [];
    if (cat.is_protected && catItems.length === 0) return;
    if (vestSearchQuery && catItems.length === 0 && !cat.name.toLowerCase().includes(vestSearchQuery.toLowerCase())) return;
    html += renderCategoryCard(cat.id, catItems);
  });

  // "Autre" for uncategorized
  if (grouped['_autre'] && grouped['_autre'].length > 0) {
    html += renderCategoryCard(null, grouped['_autre']);
  }

  const scrollY = window.scrollY;
  grid.innerHTML = html;
  grid.className = 'project-grid';
  window.scrollTo(0, scrollY);

  // Init hover-delay action buttons & drag-drop for each category card
  catRows.forEach(cat => {
    const card = grid.querySelector(`.vestiaire-bucket[data-category="${CSS.escape(cat.id)}"]`);
    if (!card) return;
    const list = card.querySelector('.vestiaire-item-list');
    if (list) {
      initVestiaireHoverDelay(list);
      initVestiaireDragDrop(cat.id, list);
    }
  });
  // Also handle uncategorized if present
  const autreCard = grid.querySelector('.vestiaire-bucket[data-category="_autre"]');
  if (autreCard) {
    const list = autreCard.querySelector('.vestiaire-item-list');
    if (list) {
      initVestiaireHoverDelay(list);
      initVestiaireDragDrop('_autre', list);
    }
  }
  balanceGrid(grid);
}

function renderCategoryCard(catId, items) {
  const cat = catId ? _vestCatMap.get(catId) : null;
  const catName = catId ? getVestCatDisplayName(catId) : 'Autre';
  const icon = getCategoryIcon(catName);
  const escapedCatId = esc(catId || '_autre');
  const count = items.length;
  const color = cat?.color || GENERAL_CATEGORY_COLOR;

  let itemsHtml = '';
  if (count === 0) {
    itemsHtml = `<div class="vestiaire-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">No items yet</div>`;
  } else {
    itemsHtml = items.map(v => renderVestiaireItem(v)).join('');
  }

  return `<div class="project-card vestiaire-bucket" data-category="${escapedCatId}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span>${icon}</span>
        <strong style="font-size:1rem;">${esc(catName)}</strong>
        <span style="font-size:0.78rem;opacity:0.75;">(${count})</span>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        ${catId ? `<button class="todo-cat-shortname-btn" data-action="open-edit-vestiaire-category" data-category="${escapedCatId}" title="${t('vestiaire.edit_category')}">${lucideIcon("pencil",14)}</button>` : ''}
        <button class="archive-project-btn" data-action="open-add-vestiaire" data-category="${escapedCatId}" title="${t('vestiaire.add_to_category', esc(catName))}">
          ${lucideIcon('plus', 16)}
        </button>
        ${catId ? `<button class="todo-cat-delete-btn" data-action="delete-vestiaire-category" data-category="${escapedCatId}" title="${t('vestiaire.delete_category')}">
          ${lucideIcon('trash-2', 16)}
        </button>` : ''}
      </div>
    </div>
    <div class="task-list vestiaire-item-list" data-category="${escapedCatId}">
      ${itemsHtml}
    </div>
  </div>`;
}

function renderVestiaireItem(v) {
  const brandHtml = v.brand
    ? `<span class="vest-brand" data-action="edit-vestiaire-brand-inline" data-id="${esc(v.id)}" title="${t('vestiaire.click_edit_brand')}">${esc(v.brand)}</span>`
    : `<span class="vest-brand vest-brand-empty" data-action="edit-vestiaire-brand-inline" data-id="${esc(v.id)}" title="${t('vestiaire.click_add_brand')}">${t('vestiaire.add_brand')}</span>`;
  const metaParts = [];
  if (v.size) metaParts.push(`${lucideIcon('ruler', 12)} ${esc(v.size)}`);
  if (v.color) metaParts.push(`${lucideIcon('palette', 12)} ${esc(v.color)}`);
  if (v.note) metaParts.push(`${esc(v.note)}`);
  const metaHtml = metaParts.length
    ? `<div class="vest-meta">${metaParts.join('')}</div>`
    : '';

  // Purchase status badge (click to cycle: none → Tried → Purchased → none)
  let statusBadge = '';
  if (v.purchase_status === 'achete') {
    statusBadge = `<span class="vest-status-badge vest-status-achete" data-action="cycle-vestiaire-status" data-id="${esc(v.id)}" title="${t('vestiaire.cycle_status')}">${t('vestiaire.purchased')}</span>`;
  } else if (v.purchase_status === 'essaye') {
    statusBadge = `<span class="vest-status-badge vest-status-essaye" data-action="cycle-vestiaire-status" data-id="${esc(v.id)}" title="${t('vestiaire.cycle_status')}">${t('vestiaire.tried')}</span>`;
  } else {
    statusBadge = `<span class="vest-status-badge vest-status-none" data-action="cycle-vestiaire-status" data-id="${esc(v.id)}" title="${t('vestiaire.set_status')}">○</span>`;
  }

  const statusCls = v.purchase_status === 'achete' ? ' vest-purchased' : v.purchase_status === 'essaye' ? ' vest-tried' : '';

  return `<div class="bucket-item vestiaire-item${statusCls}" data-vest-id="${v.id}">
    <div class="vest-row">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;">
          <span class="vest-text">${esc(v.name)}</span>
          ${brandHtml}
          ${statusBadge}
        </div>
        ${metaHtml}
      </div>
      <div class="vest-actions">
        <button data-action="copy-item-link" data-link-type="vest" data-id="${esc(v.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
        <button data-action="edit-vestiaire-inline" data-id="${esc(v.id)}" title="${t('vestiaire.edit_name')}">${lucideIcon('pencil', 14)}</button>
        <button data-action="open-edit-vestiaire" data-id="${esc(v.id)}" title="${t('vestiaire.edit_all_fields')}">${lucideIcon('settings', 14)}</button>
        <button data-action="delete-vestiaire" data-id="${esc(v.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderVestiaireNavButtons(catRows, items) {
  const container = document.getElementById('vestiaireNavButtons');
  if (!container) return;
  container.innerHTML = catRows.map(cat => {
    const count = items.filter(v => catIdForVest(v) === cat.id).length;
    const color = cat.color || GENERAL_CATEGORY_COLOR;
    const sn = cat.shortname || '';
    const display = sn || cat.name || t('common.category_default');
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-vestiaire-cat" data-category="${esc(cat.id)}" title="${esc(getVestCatDisplayName(cat.id))} (${count})">${esc(display)} (${count})</button>`;
  }).join('');
}

function navigateToVestiaireCat(catId) {
  const card = document.querySelector(`.vestiaire-bucket[data-category="${CSS.escape(catId)}"]`);
  if (!card) return;
  scrollToAndHighlight(card, 'var(--accent)');
}

function getCategoryIcon(cat) {
  const lower = (cat || '').toLowerCase();
  if (lower.includes('haut') || lower.includes('top') || lower.includes('chemis') || lower.includes('pull') || lower.includes('t-shirt'))
    return lucideIcon('shirt', 18);
  if (lower.includes('bas') || lower.includes('pantal') || lower.includes('jean') || lower.includes('short'))
    return lucideIcon('scissors', 18);
  if (lower.includes('costume') || lower.includes('suit'))
    return lucideIcon('briefcase', 18);
  if (lower.includes('chaussur') || lower.includes('shoe') || lower.includes('basket') || lower.includes('boot'))
    return lucideIcon('footprints', 18);
  if (lower.includes('mante') || lower.includes('vest') || lower.includes('jacket') || lower.includes('blouson'))
    return lucideIcon('cloud-rain', 18);
  if (lower.includes('access') || lower.includes('ceintur') || lower.includes('montre') || lower.includes('écharpe'))
    return lucideIcon('watch', 18);
  if (lower.includes('sous-vêtement') || lower.includes('underwear') || lower.includes('chaussett'))
    return lucideIcon('layers', 18);
  return lucideIcon('tag', 18);
}

// ===================================================================
// HOVER-DELAY, DRAG & DROP, INLINE EDIT
// ===================================================================

/** Hover-delay for vest-actions (matches todo / task pattern) */
function initVestiaireHoverDelay(listEl) {
  initItemHoverDelay(listEl, {
    itemSelector: '.vestiaire-item',
    rowSelector: '.vest-row',
    actionsSelector: '.vest-actions',
    textSelector: '.vest-text',
    onDblClick: (item) => {
      const id = item.dataset.vestId;
      if (id) editVestiaireInlineFull(id);
    },
  });
}

/** Drag-and-drop reorder within a category card */
function initVestiaireDragDrop(catId, listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.vestiaire-item',
    idAttr: 'vestId',
    onReorder: async (draggedId, targetId) => {
      const items = (state.allVestiaire || []).filter(v => catIdForVest(v) === catId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      await reorderItems({
        items,
        allItems: state.allVestiaire || [],
        draggedId,
        targetId,
        container: listEl,
        itemSelector: '.vestiaire-item',
        idAttr: 'vestId',
        tableName: 'vestiaire',
        reinitFn: () => initVestiaireDragDrop(catId, listEl),
      });
    },
  });
}

/** Inline-edit the name field via double-click or pencil button */
async function editVestiaireInline(id) {
  const el = document.querySelector(`.vestiaire-item[data-vest-id="${id}"] .vest-text`);
  if (!el) return;
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;

  inlineEditText(el, v.name, {
    maxLength: 200,
    saveFn: async (newName) => {
      const { error } = await state.db.from('vestiaire').update({
        name: newName,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
      v.name = newName;
      showToast(t('toast.renamed'), 'success');
    },
    refreshFn: refreshVestiaire,
  });
}
/** Inline-edit the brand via click on brand badge */
async function editVestiaireBrandInline(id) {
  const el = document.querySelector(`.vestiaire-item[data-vest-id="${id}"] .vest-brand`);
  if (!el) return;
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;

  inlineEditText(el, v.brand || '', {
    maxLength: 200,
    saveFn: async (newBrand) => {
      const { error } = await state.db.from('vestiaire').update({
        brand: newBrand || null,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
      v.brand = newBrand || null;
      showToast(t('toast.updated'), 'success');
    },
    refreshFn: refreshVestiaire,
  });
}

/** Full inline edit on dblclick — name + brand + size + color + notes */
function editVestiaireInlineFull(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  const nameEl = document.querySelector(`.vestiaire-item[data-vest-id="${id}"] .vest-text`);
  if (!nameEl) return;

  // Hide actions while editing
  const actionsEl = nameEl.closest('.vestiaire-item')?.querySelector('.vest-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  function addRow(labelText, value, placeholder) {
    const row = document.createElement('div');
    row.className = 'inline-edit-row';
    const label = document.createElement('label');
    label.className = 'inline-edit-label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit-input';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    row.appendChild(label);
    row.appendChild(input);
    extras.appendChild(row);
    return input;
  }

  const brandInput = addRow(t('vestiaire.brand'), v.brand);
  const sizeInput = addRow(t('vestiaire.size'), v.size);
  const colorInput = addRow(t('vestiaire.color'), v.color);
  const noteInput = addRow(t('common.notes'), v.note, t('vestiaire.notes_placeholder'));

  inlineEditText(nameEl, v.name, {
    maxLength: 200,
    extraEl: extras,
    collectExtra: () => ({
      brand: brandInput.value.trim(),
      size: sizeInput.value.trim(),
      color: colorInput.value.trim(),
      note: noteInput.value.trim(),
    }),
    saveFn: async (newName, extra) => {
      const updates = {};
      if (newName !== v.name) updates.name = newName;
      if (extra) {
        if ((extra.brand || '') !== (v.brand || '')) updates.brand = extra.brand || null;
        if ((extra.size || '') !== (v.size || '')) updates.size = extra.size || null;
        if ((extra.color || '') !== (v.color || '')) updates.color = extra.color || null;
        if ((extra.note || '') !== (v.note || '')) updates.note = extra.note || null;
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        const { error } = await state.db.from('vestiaire').update(updates).eq('id', id);
        if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
        // Update local state so re-render shows new values immediately
        if (updates.name !== undefined) v.name = updates.name;
        if (updates.brand !== undefined) v.brand = updates.brand;
        if (updates.size !== undefined) v.size = updates.size;
        if (updates.color !== undefined) v.color = updates.color;
        if (updates.note !== undefined) v.note = updates.note;
        showToast(t('toast.updated'), 'success');
      }
    },
    refreshFn: refreshVestiaire,
  });
}

/** Cycle purchase status inline: click on badge cycles → essaye → achete → (none) */
async function cycleVestiaireStatus(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  const cycle = [null, 'essaye', 'achete'];
  const idx = cycle.indexOf(v.purchase_status || null);
  const next = cycle[(idx + 1) % cycle.length];
  const { error } = await state.db.from('vestiaire').update({
    purchase_status: next,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
  v.purchase_status = next;
  const label = next === 'achete' ? t('vestiaire.purchased') : next === 'essaye' ? t('vestiaire.tried') : t('vestiaire.no_status');
  showToast(label, 'success');
  renderVestiaire();
}



function initVestiaireModals() {
  const app = document.getElementById('app');

  // Add Item Modal
  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addVestiaireModal';
  m1.innerHTML = `<div class="modal">
    <h2>${lucideIcon('shirt', 20)} ${t('vestiaire.add_item')}</h2>
    <input type="hidden" id="newVestiaireCategory">
    <label>${t('common.name')}</label>
    <input type="text" id="newVestiaireName" placeholder="${t('vestiaire.name_placeholder')}" maxlength="200"
      data-action="save-new-vestiaire-on-enter">
    <label>${t('vestiaire.brand')}</label>
    <input type="text" id="newVestiaireBrand" placeholder="${t('vestiaire.brand_placeholder')}" maxlength="200">
    <label>${t('vestiaire.size')}</label>
    <input type="text" id="newVestiaireSize" placeholder="${t('vestiaire.size_placeholder')}" maxlength="100">
    <label>${t('vestiaire.color_optional')}</label>
    <input type="text" id="newVestiaireColor" placeholder="${t('vestiaire.color_placeholder')}" maxlength="100">
    <label>${t('vestiaire.notes_optional')}</label>
    <input type="text" id="newVestiaireNotes" placeholder="${t('vestiaire.notes_placeholder')}" maxlength="500">
    <label>${t('vestiaire.status')}</label>
    <select id="newVestiairePurchaseStatus">
      <option value="">—</option>
      <option value="essaye">${t('vestiaire.tried')}</option>
      <option value="achete">${t('vestiaire.purchased')}</option>
    </select>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-vestiaire">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-vestiaire">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m1);

  // Edit Item Modal
  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editVestiaireModal';
  m2.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('vestiaire.edit_item')}</h2>
    <input type="hidden" id="editVestiaireId">
    <label>${t('common.name')}</label>
    <input type="text" id="editVestiaireName" maxlength="200">
    <label>${t('vestiaire.brand')}</label>
    <input type="text" id="editVestiaireBrand" maxlength="200">
    <label>${t('vestiaire.size')}</label>
    <input type="text" id="editVestiaireSize" maxlength="100">
    <label>${t('common.category')}</label>
    <select id="editVestiaireCategory"></select>
    <label>${t('vestiaire.color_optional')}</label>
    <input type="text" id="editVestiaireColor" maxlength="100">
    <label>${t('vestiaire.notes_optional')}</label>
    <input type="text" id="editVestiaireNotes" maxlength="500">
    <label>${t('vestiaire.status')}</label>
    <select id="editVestiairePurchaseStatus">
      <option value="">—</option>
      <option value="essaye">${t('vestiaire.tried')}</option>
      <option value="achete">${t('vestiaire.purchased')}</option>
    </select>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-vestiaire">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-vestiaire">${t('common.save')}</button>
    </div>
  </div>`;
  app.appendChild(m2);

  // Add Category Modal
  const m3 = document.createElement('div');
  m3.className = 'modal-overlay';
  m3.id = 'addVestiaireCategoryModal';
  m3.innerHTML = `<div class="modal">
    <h2>${lucideIcon('folder-plus', 20)} ${t('vestiaire.add_category')}</h2>
    <label>${t('common.name')}</label>
    <input type="text" id="newVestiaireCategoryName" placeholder="${t('vestiaire.category_placeholder')}" maxlength="40"
      data-action="save-new-vestiaire-category-on-enter">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-vestiaire-category">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-vestiaire-category">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m3);

  // Edit Category Modal
  const m4 = document.createElement('div');
  m4.className = 'modal-overlay';
  m4.id = 'editVestiaireCategoryModal';
  m4.dataset.action = 'close-edit-vestiaire-category';
  m4.dataset.overlayClose = 'true';
  m4.innerHTML = `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('vestiaire.edit_category')}</h2>
    <input type="hidden" id="editVestiaireCategoryOldName">
    <label>${t('common.name')}</label>
    <input type="text" id="editVestiaireCategoryName" maxlength="40"
      data-action="save-edit-vestiaire-category-on-enter">
    <label>${t('vestiaire.shortname')}</label>
    <input type="text" id="editVestiaireCategoryShortname" maxlength="20" placeholder="${t('vestiaire.shortname_placeholder')}"
      data-action="save-edit-vestiaire-category-on-enter">
    <label>${t('lists.color')}</label>
    <input type="color" id="editVestiaireCategoryColor">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-vestiaire-category">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-vestiaire-category">${t('common.save')}</button>
    </div>
  </div>`;
  app.appendChild(m4);
}

function populateCategorySelect(selectId, preselectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const catRows = Array.from(_vestCatMap.values()).sort((a, b) => a.sort_order - b.sort_order);
  sel.innerHTML = catRows.map(c => `<option value="${esc(c.id)}" ${c.id === preselectId ? 'selected' : ''}>${esc(getVestCatDisplayName(c.id))}</option>`).join('');
}


// ===================================================================
// CRUD
// ===================================================================

function openAddVestiaireModal(preselectedCatId) {
  document.getElementById('newVestiaireName').value = '';
  document.getElementById('newVestiaireBrand').value = '';
  document.getElementById('newVestiaireSize').value = '';
  document.getElementById('newVestiaireColor').value = '';
  document.getElementById('newVestiaireNotes').value = '';
  document.getElementById('newVestiairePurchaseStatus').value = '';
  const catRows = Array.from(_vestCatMap.values()).sort((a, b) => a.sort_order - b.sort_order);
  const firstCatId = preselectedCatId || (catRows[0]?.id || '');
  populateCategorySelect('newVestiaireCategory', firstCatId);
  document.getElementById('addVestiaireModal').classList.add('visible');
  setTimeout(() => document.getElementById('newVestiaireName').focus(), 100);
}

function closeAddVestiaireModal() {
  document.getElementById('addVestiaireModal')?.classList.remove('visible');
}

async function saveNewVestiaire() {
  const name = document.getElementById('newVestiaireName').value.trim();
  const brand = document.getElementById('newVestiaireBrand').value.trim();
  const size = document.getElementById('newVestiaireSize').value.trim();
  const catId = document.getElementById('newVestiaireCategory').value;
  const catRow = _vestCatMap.get(catId);
  const catName = catRow?.name || '';
  const color = document.getElementById('newVestiaireColor').value.trim();
  const notes = document.getElementById('newVestiaireNotes').value.trim();
  const purchaseStatus = document.getElementById('newVestiairePurchaseStatus').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  // Compute sort_order: place new item at end of its category
  const catItems = (state.allVestiaire || []).filter(v => catIdForVest(v) === catId);
  const maxOrder = catItems.reduce((m, v) => Math.max(m, v.sort_order || 0), 0);
  const row = { name, category: catName, category_id: catId, sort_order: maxOrder + 1 };
  if (brand) row.brand = brand;
  if (size) row.size = size;
  if (color) row.color = color;
  if (notes) row.note = notes;
  if (purchaseStatus) row.purchase_status = purchaseStatus;

  const { error } = await state.db.from('vestiaire').insert(row);
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  closeAddVestiaireModal();
  showToast(t('vestiaire.item_added', name), 'success');
  await refreshVestiaire();
}

function openEditVestiaireModal(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  document.getElementById('editVestiaireId').value = id;
  document.getElementById('editVestiaireName').value = v.name || '';
  document.getElementById('editVestiaireBrand').value = v.brand || '';
  document.getElementById('editVestiaireSize').value = v.size || '';
  document.getElementById('editVestiaireColor').value = v.color || '';
  document.getElementById('editVestiaireNotes').value = v.note || '';
  document.getElementById('editVestiairePurchaseStatus').value = v.purchase_status || '';
  populateCategorySelect('editVestiaireCategory', catIdForVest(v));
  document.getElementById('editVestiaireModal').classList.add('visible');
  setTimeout(() => document.getElementById('editVestiaireName').focus(), 100);
}

function closeEditVestiaireModal() {
  document.getElementById('editVestiaireModal').classList.remove('visible');
}

async function saveEditVestiaire() {
  const id = document.getElementById('editVestiaireId').value;
  const name = document.getElementById('editVestiaireName').value.trim();
  const brand = document.getElementById('editVestiaireBrand').value.trim();
  const size = document.getElementById('editVestiaireSize').value.trim();
  const catId = document.getElementById('editVestiaireCategory').value;
  const catRow = _vestCatMap.get(catId);
  const catName = catRow?.name || '';
  const color = document.getElementById('editVestiaireColor').value.trim();
  const notes = document.getElementById('editVestiaireNotes').value.trim();
  const purchaseStatus = document.getElementById('editVestiairePurchaseStatus').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  const { error } = await state.db.from('vestiaire').update({
    name, brand: brand || null, size: size || null, category: catName, category_id: catId,
    color: color || null, note: notes || null,
    purchase_status: purchaseStatus || null,
    updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  closeEditVestiaireModal();
  showToast(t('toast.updated'), 'success');
  await refreshVestiaire();
}

async function deleteVestiaire(id) {
  const v = (state.allVestiaire || []).find(x => x.id === id);
  if (!v) return;
  showDeleteConfirm(
    t('common.delete'),
    `Remove "${v.name}" from your wardrobe?`,
    async () => {
      const { error } = await state.db.from('vestiaire').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      showToast(t('toast.removed'), 'info');
      await refreshVestiaire();
    }
  );
}


// ===================================================================
// CATEGORY MANAGEMENT
// ===================================================================

function openAddVestiaireCategoryModal() {
  document.getElementById('newVestiaireCategoryName').value = '';
  document.getElementById('addVestiaireCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('newVestiaireCategoryName').focus(), 100);
}

function closeAddVestiaireCategoryModal() {
  document.getElementById('addVestiaireCategoryModal').classList.remove('visible');
}

async function saveNewVestiaireCategory() {
  const name = document.getElementById('newVestiaireCategoryName').value.trim();
  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }
  for (const cat of _vestCatMap.values()) {
    if (cat.name.toLowerCase() === name.toLowerCase()) {
      showToast(t('toast.failed_to_add'), 'error'); return;
    }
  }
  const usedColors = new Set(Array.from(_vestCatMap.values()).map(c => c.color).filter(Boolean));
  const color = DEFAULT_CATEGORY_PALETTE.find(c => !usedColors.has(c)) || DEFAULT_CATEGORY_PALETTE[_vestCatMap.size % DEFAULT_CATEGORY_PALETTE.length];
  const sortOrder = Math.max(0, ...Array.from(_vestCatMap.values()).map(c => c.sort_order || 0)) + 1;
  const { error } = await state.db.from('vestiaire_categories').insert({ name, color, sort_order: sortOrder });
  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  await loadVestiaireCategories();
  closeAddVestiaireCategoryModal();
  showToast(t('toast.added'), 'success');
  renderVestiaire();
}

function openEditVestiaireCategoryModal(catId) {
  const cat = _vestCatMap.get(catId);
  if (!cat) return;
  document.getElementById('editVestiaireCategoryOldName').value = catId; // store ID
  document.getElementById('editVestiaireCategoryName').value = cat.name;
  document.getElementById('editVestiaireCategoryShortname').value = cat.shortname || '';
  document.getElementById('editVestiaireCategoryColor').value = cat.color || GENERAL_CATEGORY_COLOR;
  document.getElementById('editVestiaireCategoryModal').classList.add('visible');
  setTimeout(() => document.getElementById('editVestiaireCategoryName').focus(), 100);
}

function closeEditVestiaireCategoryModal() {
  document.getElementById('editVestiaireCategoryModal').classList.remove('visible');
}

async function saveEditVestiaireCategory() {
  const catId = document.getElementById('editVestiaireCategoryOldName').value;
  const cat = _vestCatMap.get(catId);
  if (!cat) return;
  const newName = document.getElementById('editVestiaireCategoryName').value.trim();
  const shortname = document.getElementById('editVestiaireCategoryShortname').value.trim();
  const color = document.getElementById('editVestiaireCategoryColor').value;

  if (!newName) { showToast(t('toast.enter_name'), 'error'); return; }

  // Update the DB row directly — items reference by category_id FK
  const updates = { name: newName, shortname: shortname || null, color };
  await state.db.from('vestiaire_categories').update(updates).eq('id', catId);
  Object.assign(cat, updates);
  _vestCatByName.clear();
  for (const row of _vestCatMap.values()) _vestCatByName.set(row.name, row);

  closeEditVestiaireCategoryModal();
  showToast(t('toast.updated'), 'success');
  await refreshVestiaire();
}

async function deleteVestiaireCategory(catId) {
  const cat = _vestCatMap.get(catId);
  if (!cat) return;
  const items = (state.allVestiaire || []).filter(v => catIdForVest(v) === catId);
  const msg = items.length > 0
    ? t('vestiaire.delete_category_confirm', cat.name) + ` — ${items.length} item${items.length > 1 ? 's' : ''} will be deleted. This cannot be undone.`
    : t('vestiaire.delete_category_confirm', cat.name);
  showDeleteConfirm(
    t('vestiaire.delete_category'),
    msg,
    async () => {
      // CASCADE on FK — deleting the category removes all its items
      const { error } = await state.db.from('vestiaire_categories').delete().eq('id', catId);
      if (error) { showToast(t('toast.delete_failed') + ': ' + error.message, 'error'); return; }
      showToast(t('toast.removed'), 'info');
      await refreshVestiaire();
    }
  );
}


// ===================================================================
// EXPORTS
// ===================================================================

export { refreshVestiaire, renderVestiaire, initVestiaireModals, loadVestiaireCategories, getVestiaireCategories };

// Window bindings
window.openAddVestiaireModal = openAddVestiaireModal;
window.closeAddVestiaireModal = closeAddVestiaireModal;
window.saveNewVestiaire = saveNewVestiaire;
window.openEditVestiaireModal = openEditVestiaireModal;
window.closeEditVestiaireModal = closeEditVestiaireModal;
window.saveEditVestiaire = saveEditVestiaire;
window.deleteVestiaire = deleteVestiaire;
window.openAddVestiaireCategoryModal = openAddVestiaireCategoryModal;
window.closeAddVestiaireCategoryModal = closeAddVestiaireCategoryModal;
window.saveNewVestiaireCategory = saveNewVestiaireCategory;
window.deleteVestiaireCategory = deleteVestiaireCategory;
window.navigateToVestiaireCat = navigateToVestiaireCat;
window.renderVestiaire = renderVestiaire;
window.setVestiaireFilter = setVestiaireFilter;
window.editVestiaireInline = editVestiaireInline;
window.editVestiaireBrandInline = editVestiaireBrandInline;
window.cycleVestiaireStatus = cycleVestiaireStatus;

window.openEditVestiaireCategoryModal = openEditVestiaireCategoryModal;
window.closeEditVestiaireCategoryModal = closeEditVestiaireCategoryModal;
window.saveEditVestiaireCategory = saveEditVestiaireCategory;
window.filterVestiaire = function(e) { vestSearchQuery = e.target.value; renderVestiaire(); };
