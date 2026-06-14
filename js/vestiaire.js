import { lucideIcon } from './icons.js';
import state from './supabase.js';
import { esc, escQ, showToast, showDeleteConfirm, balanceGrid } from './utils.js';
import { scrollToAndHighlight, initItemHoverDelay, initItemDragDrop, reorderItems, inlineEditText } from './item-utils.js';
import { t } from './i18n.js';

// ===================================================================
// VESTIAIRE — WARDROBE TRACKER (bucket-card layout)
// ===================================================================

const DEFAULT_CATEGORIES = [];
let vestSearchQuery = '';
let vestFilter = 'all';
const VESTIAIRE_CATEGORIES_KEY = 'claw_cc_vestiaire_categories';
const VEST_SHORTNAMES_KEY = 'claw_cc_vest_shortnames';
const VEST_SHORTNAMES_DB_KEY = 'vest_category_shortnames';
let _vestShortnames = {};

// ── Category shortnames (synced via settings table) ──
function getVestShortnames() { return _vestShortnames; }
function getVestShortname(catName) {
  return _vestShortnames[catName] || '';
}

async function loadVestShortnames() {
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings').select('value').eq('key', VEST_SHORTNAMES_DB_KEY);
      if (data && data.length > 0 && data[0].value) {
        _vestShortnames = JSON.parse(data[0].value);
        localStorage.setItem(VEST_SHORTNAMES_KEY, data[0].value);
        return;
      }
    } catch (e) { console.warn('Could not load vest shortnames from DB:', e.message); }
  }
  try { _vestShortnames = JSON.parse(localStorage.getItem(VEST_SHORTNAMES_KEY) || '{}'); } catch { _vestShortnames = {}; }
}

async function saveVestShortnames(map) {
  _vestShortnames = map;
  const json = JSON.stringify(map);
  localStorage.setItem(VEST_SHORTNAMES_KEY, json);
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings')
        .update({ value: json, updated_at: new Date().toISOString() })
        .eq('key', VEST_SHORTNAMES_DB_KEY).select();
      if (!data || data.length === 0) {
        await state.db.from('settings')
          .insert({ key: VEST_SHORTNAMES_DB_KEY, value: json, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('Could not save vest shortnames to DB:', e.message); }
  }
}

function setVestShortname(catName, shortname) {
  if (shortname) _vestShortnames[catName] = shortname; else delete _vestShortnames[catName];
  saveVestShortnames(_vestShortnames);
}
function promptVestShortname(catName) {
  const current = getVestShortname(catName) || '';
  const result = prompt(`Short name for "${catName}" (leave empty to clear):`, current);
  if (result === null) return;
  setVestShortname(catName, result.trim());
  renderVestiaire();
}

// Distinct colors per category (cycles if more categories are added)
const CATEGORY_COLORS = [
  '#8b5cf6', // purple — Haut
  '#3b82f6', // blue — Bas
  '#f59e0b', // amber — Shoes
  '#10b981', // emerald — Outerwear
  '#ef4444', // red
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
  '#14b8a6', // teal
];

function getCategoryColor(cat) {
  const cats = getVestiaireCategories();
  const idx = cats.indexOf(cat);
  return CATEGORY_COLORS[(idx >= 0 ? idx : cats.length) % CATEGORY_COLORS.length];
}

function getVestiaireCategories() {
  try {
    const raw = localStorage.getItem(VESTIAIRE_CATEGORIES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [...DEFAULT_CATEGORIES];
}

function saveVestiaireCategories(cats) {
  localStorage.setItem(VESTIAIRE_CATEGORIES_KEY, JSON.stringify(cats));
}


// ===================================================================
// DATA
// ===================================================================

async function refreshVestiaire() {
  if (!state.db.connected) return;
  await loadVestShortnames();
  const { data, error } = await state.db
    .from('vestiaire')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allVestiaire = data || [];
  syncCategoriesFromData();
  if (state.currentView === 'vestiaire') {
    renderVestiaire();
  }
}

function syncCategoriesFromData() {
  const cats = getVestiaireCategories();
  const dataCats = [...new Set((state.allVestiaire || []).map(v => v.category).filter(Boolean))];
  let changed = false;
  dataCats.forEach(c => {
    if (!cats.includes(c)) { cats.push(c); changed = true; }
  });
  // In demo mode, remove categories that have no items in data
  if (state.demoMode) {
    const pruned = cats.filter(c => dataCats.includes(c));
    if (pruned.length !== cats.length) {
      saveVestiaireCategories(pruned);
      return;
    }
  }
  if (changed) saveVestiaireCategories(cats);
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

  let items = state.allVestiaire || [];
  let cats = getVestiaireCategories();

  // In demo mode, only show categories that have items in data
  if (state.demoMode) {
    const dataCats = new Set(items.map(v => v.category).filter(Boolean));
    cats = cats.filter(c => dataCats.has(c));
  }

  // Show page-level empty state when no items and no categories
  if (items.length === 0 && cats.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('shirt', 48, 'var(--muted)')}</div>
      <h3>${t('vestiaire.empty_title')}</h3>
      <p>${t('vestiaire.empty_hint')}</p>
      <button class="empty-cta" onclick="openAddVestiaireCategoryModal()">${lucideIcon('plus', 16)} ${t('vestiaire.empty_cta')}</button>
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

  renderVestiaireNavButtons(cats, items);

  // Apply sort
  const sortBy = document.getElementById('vestiaireSortBy')?.value || 'manual';
  const sortFn = sortBy === 'name'
    ? (a, b) => (a.name || '').localeCompare(b.name || '')
    : sortBy === 'brand'
    ? (a, b) => (a.brand || '').localeCompare(b.brand || '')
    : (a, b) => (a.sort_order || 0) - (b.sort_order || 0);

  // Group items by category
  const grouped = {};
  cats.forEach(c => { grouped[c] = []; });
  items.forEach(v => {
    const cat = v.category || 'Autre';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(v);
  });
  // Sort within each group
  Object.values(grouped).forEach(arr => arr.sort(sortFn));

  // Render a card per category (skip empty when searching)
  let html = '';
  cats.forEach(cat => {
    const catItems = grouped[cat] || [];
    if (vestSearchQuery && catItems.length === 0 && !cat.toLowerCase().includes(vestSearchQuery.toLowerCase())) return;
    html += renderCategoryCard(cat, catItems);
  });

  // "Autre" for uncategorized
  if (grouped['Autre'] && grouped['Autre'].length > 0 && !cats.includes('Autre')) {
    html += renderCategoryCard('Autre', grouped['Autre']);
  }

  grid.innerHTML = html;
  grid.className = 'project-grid';

  // Init hover-delay action buttons & drag-drop for each category card
  cats.forEach(cat => {
    const card = grid.querySelector(`.vestiaire-bucket[data-category="${esc(cat)}"]`);
    if (!card) return;
    const list = card.querySelector('.vestiaire-item-list');
    if (list) {
      initVestiaireHoverDelay(list);
      initVestiaireDragDrop(cat, list);
    }
  });
  // Also handle 'Autre' if present
  const autreCard = grid.querySelector('.vestiaire-bucket[data-category="Autre"]');
  if (autreCard) {
    const list = autreCard.querySelector('.vestiaire-item-list');
    if (list) {
      initVestiaireHoverDelay(list);
      initVestiaireDragDrop('Autre', list);
    }
  }
  balanceGrid(grid);
}

function renderCategoryCard(cat, items) {
  const icon = getCategoryIcon(cat);
  const escapedCat = esc(cat);
  const count = items.length;
  const color = getCategoryColor(cat);

  let itemsHtml = '';
  if (count === 0) {
    itemsHtml = `<div class="vestiaire-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">No items yet</div>`;
  } else {
    itemsHtml = items.map(v => renderVestiaireItem(v)).join('');
  }

  return `<div class="project-card vestiaire-bucket" data-category="${escapedCat}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span>${icon}</span>
        <strong style="font-size:1rem;">${escapedCat}</strong>
        <span style="font-size:0.78rem;opacity:0.75;">(${count})</span>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button class="todo-cat-shortname-btn" onclick="promptVestShortname('${escQ(cat)}')" title="${getVestShortname(cat) ? 'Edit short name' : 'Set short name'}">${lucideIcon("pencil",14)}</button>
        <button class="archive-project-btn" onclick="openAddVestiaireModal('${escapedCat}')" title="Add to ${escapedCat}">
          ${lucideIcon('plus', 16)}
        </button>
        <button class="archive-project-btn" onclick="deleteVestiaireCategory('${escapedCat}')" title="Delete category">
          ${lucideIcon('trash-2', 14)}
        </button>
      </div>
    </div>
    <div class="vestiaire-item-list" data-category="${escapedCat}">
      ${itemsHtml}
    </div>
  </div>`;
}

function renderVestiaireItem(v) {
  const brandHtml = v.brand
    ? `<span class="vest-brand" onclick="editVestiaireBrandInline('${v.id}')" title="Click to edit brand">${esc(v.brand)}</span>`
    : `<span class="vest-brand vest-brand-empty" onclick="editVestiaireBrandInline('${v.id}')" title="Click to add brand">${t('vestiaire.add_brand')}</span>`;
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
    statusBadge = `<span class="vest-status-badge vest-status-achete" onclick="cycleVestiaireStatus('${v.id}')" title="Click to cycle status">${t('vestiaire.purchased')}</span>`;
  } else if (v.purchase_status === 'essaye') {
    statusBadge = `<span class="vest-status-badge vest-status-essaye" onclick="cycleVestiaireStatus('${v.id}')" title="Click to cycle status">${t('vestiaire.tried')}</span>`;
  } else {
    statusBadge = `<span class="vest-status-badge vest-status-none" onclick="cycleVestiaireStatus('${v.id}')" title="Click to set status">○</span>`;
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
        <button onclick="editVestiaireInline('${v.id}')" title="Edit name">${lucideIcon('pencil', 14)}</button>
        <button onclick="openEditVestiaireModal('${v.id}')" title="Edit all fields">${lucideIcon('settings', 14)}</button>
        <button onclick="deleteVestiaire('${v.id}')" title="Delete">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderVestiaireNavButtons(cats, items) {
  const container = document.getElementById('vestiaireNavButtons');
  if (!container) return;
  container.innerHTML = cats.map(cat => {
    const count = items.filter(v => v.category === cat).length;
    const color = getCategoryColor(cat);
    const sn = getVestShortname(cat);
    const display = sn || cat;
    return `<button class="category-nav-btn" style="--cat-color:${color}" onclick="navigateToVestiaireCat('${escQ(cat)}')" title="${esc(cat)} (${count})">${esc(display)} (${count})</button>`;
  }).join('');
}

function navigateToVestiaireCat(cat) {
  const card = document.querySelector(`.vestiaire-bucket[data-category="${cat}"]`);
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
function initVestiaireDragDrop(category, listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.vestiaire-item',
    idAttr: 'vestId',
    onReorder: async (draggedId, targetId) => {
      const items = (state.allVestiaire || []).filter(v => v.category === category).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      await reorderItems({
        items,
        allItems: state.allVestiaire || [],
        draggedId,
        targetId,
        container: listEl,
        itemSelector: '.vestiaire-item',
        idAttr: 'vestId',
        tableName: 'vestiaire',
        reinitFn: () => initVestiaireDragDrop(category, listEl),
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
    refreshFn: renderVestiaire,
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
    refreshFn: renderVestiaire,
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
        showToast(t('toast.updated'), 'success');
      }
    },
    refreshFn: renderVestiaire,
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
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewVestiaire();}">
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
      <button class="modal-cancel" onclick="closeAddVestiaireModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveNewVestiaire()">${t('common.add')}</button>
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
      <button class="modal-cancel" onclick="closeEditVestiaireModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveEditVestiaire()">${t('common.save')}</button>
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
      onkeydown="if(event.key==='Enter'){event.preventDefault();saveNewVestiaireCategory();}">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="closeAddVestiaireCategoryModal()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="saveNewVestiaireCategory()">${t('common.add')}</button>
    </div>
  </div>`;
  app.appendChild(m3);
}

function populateCategorySelect(selectId, preselect) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const cats = getVestiaireCategories();
  sel.innerHTML = cats.map(c => `<option value="${esc(c)}" ${c === preselect ? 'selected' : ''}>${esc(c)}</option>`).join('');
}


// ===================================================================
// CRUD
// ===================================================================

function openAddVestiaireModal(preselectedCategory) {
  document.getElementById('newVestiaireName').value = '';
  document.getElementById('newVestiaireBrand').value = '';
  document.getElementById('newVestiaireSize').value = '';
  document.getElementById('newVestiaireColor').value = '';
  document.getElementById('newVestiaireNotes').value = '';
  document.getElementById('newVestiairePurchaseStatus').value = '';
  document.getElementById('newVestiaireCategory').value = preselectedCategory || getVestiaireCategories()[0] || '';
  document.getElementById('addVestiaireModal').classList.add('visible');
  setTimeout(() => document.getElementById('newVestiaireName').focus(), 100);
}

function closeAddVestiaireModal() {
  document.getElementById('addVestiaireModal').classList.remove('visible');
}

async function saveNewVestiaire() {
  const name = document.getElementById('newVestiaireName').value.trim();
  const brand = document.getElementById('newVestiaireBrand').value.trim();
  const size = document.getElementById('newVestiaireSize').value.trim();
  const category = document.getElementById('newVestiaireCategory').value;
  const color = document.getElementById('newVestiaireColor').value.trim();
  const notes = document.getElementById('newVestiaireNotes').value.trim();
  const purchaseStatus = document.getElementById('newVestiairePurchaseStatus').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  // Compute sort_order: place new item at end of its category
  const catItems = (state.allVestiaire || []).filter(v => v.category === category);
  const maxOrder = catItems.reduce((m, v) => Math.max(m, v.sort_order || 0), 0);
  const row = { name, category, sort_order: maxOrder + 1 };
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
  populateCategorySelect('editVestiaireCategory', v.category);
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
  const category = document.getElementById('editVestiaireCategory').value;
  const color = document.getElementById('editVestiaireColor').value.trim();
  const notes = document.getElementById('editVestiaireNotes').value.trim();
  const purchaseStatus = document.getElementById('editVestiairePurchaseStatus').value;

  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }

  const { error } = await state.db.from('vestiaire').update({
    name, brand: brand || null, size: size || null, category,
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

function saveNewVestiaireCategory() {
  const name = document.getElementById('newVestiaireCategoryName').value.trim();
  if (!name) { showToast(t('toast.enter_name'), 'error'); return; }
  const cats = getVestiaireCategories();
  if (cats.includes(name)) { showToast(t('toast.failed_to_add'), 'error'); return; }
  cats.push(name);
  saveVestiaireCategories(cats);
  closeAddVestiaireCategoryModal();
  showToast(t('toast.added'), 'success');
  renderVestiaire();
}

function deleteVestiaireCategory(cat) {
  const items = (state.allVestiaire || []).filter(v => v.category === cat);
  if (items.length > 0) {
    showToast(t('vestiaire.category_has_items', cat, items.length), 'error');
    return;
  }
  showDeleteConfirm(
    t('vestiaire.delete_category'),
    `Remove the "${cat}" category?`,
    () => {
      const cats = getVestiaireCategories().filter(c => c !== cat);
      saveVestiaireCategories(cats);
      showToast(t('toast.removed'), 'info');
      renderVestiaire();
    }
  );
}


// ===================================================================
// EXPORTS
// ===================================================================

export { refreshVestiaire, renderVestiaire, initVestiaireModals };

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

window.promptVestShortname = promptVestShortname;
window.filterVestiaire = function(e) { vestSearchQuery = e.target.value; renderVestiaire(); };
