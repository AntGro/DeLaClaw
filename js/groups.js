import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc } from './utils.js';
import { t } from './i18n.js';
import { sharingGroupCardHtml, visibleMembers } from './sharing-ui.js';

// ===================================================================
// GROUPS — dedicated tab for managing sharing groups.
// Sidebar lists the groups (+ Add Group at the top); the detail pane shows
// the selected group's management card (members, invite, shared-item count,
// delete/leave). All mutations reuse the sharing-ui.js actions through
// data-action delegation — this module only owns layout + selection state.
// ===================================================================

let selectedGroupId = null;
let _subscribed = false;
let _addMenuOpen = false;

// Dismiss the Add/Join menu on outside click or Escape.
document.addEventListener('click', (e) => {
  if (!_addMenuOpen) return;
  if (e.target?.closest?.('.groups-add-wrap')) return;
  _addMenuOpen = false;
  if (state.currentView === 'groups') renderGroups();
});
document.addEventListener('keydown', (e) => {
  if (!_addMenuOpen || e.key !== 'Escape') return;
  _addMenuOpen = false;
  if (state.currentView === 'groups') renderGroups();
});

// Structural adapter events only: item-level changes (item-added, …) don't
// affect this view, and re-rendering on them could wipe an in-progress invite.
const STRUCTURAL_EVENTS = new Set([
  'group-created', 'group-discovered', 'group-deleted', 'group-joined',
  'member-invited', 'member-removed', 'member-joined', 'group-changed',
]);

function ensureSubscribed() {
  if (_subscribed || !state.sharing || typeof state.sharing.onUpdate !== 'function') return;
  _subscribed = true;
  state.sharing.onUpdate((event, detail) => {
    if (!STRUCTURAL_EVENTS.has(event)) return;
    // Auto-select only on 'group-created' (this device): a group discovered
    // via another device's poll ('group-discovered') must not steal selection.
    if (event === 'group-created' && detail?.group?.id) selectedGroupId = detail.group.id;
    if (event === 'group-deleted' && detail?.groupId === selectedGroupId) selectedGroupId = null;
    if (state.currentView === 'groups') renderGroups();
  });
}

function skippedGroupItemHtml(s) {
  // A group whose files failed to load transiently this session — shown
  // disabled with a chip instead of being silently dropped; retried
  // automatically (poll discovery and page load). Not selectable: its data
  // isn't loaded.
  return `<div class="groups-list-item groups-list-item-skipped" aria-disabled="true">
    <span class="groups-list-item-icon">${lucideIcon('alert-triangle', 16, 'currentColor')}</span>
    <span class="groups-list-item-text">
      <span class="groups-list-item-name">${esc(s.name)}<span class="sharing-group-skipped-stamp">${lucideIcon('alert-triangle', 14, 'currentColor')} ${t('sharing.group_skipped')}</span></span>
    </span>
  </div>`;
}

/** Detail pane HTML for the selected group (or the empty state). */
async function detailPaneHtml(selected) {
  const groups = state.sharing.getAllGroups();
  return selected
    ? `<button class="btn groups-back-btn" data-action="groups-back">${lucideIcon('chevron-left', 16)} ${t('groups.back_to_groups')}</button>
       ${await sharingGroupCardHtml(selected)}`
    : `<div class="page-empty-state">
        <div class="empty-icon">${lucideIcon('users', 48, 'var(--muted)')}</div>
        <h3>${t('sharing.groups')}</h3>
        <p>${groups.length === 0 ? t('sharing.no_groups_hint') : t('groups.select_prompt')}</p>
      </div>`;
}

/**
 * Select a group (null = back to the list). Exposed for data-action delegation.
 * Updates the panes in place and toggles the layout class so narrow screens
 * animate the master-detail slide (list slides left out, detail slides in
 * from the right, and the reverse on back). A full re-render here would
 * destroy the DOM and skip the transition; on wide screens the class is
 * inert so the in-place update is visually identical to a re-render.
 */
export function selectGroup(groupId) {
  selectedGroupId = groupId || null;
  const layout = document.querySelector('#groupsView .groups-layout');
  if (!layout || !state.sharing) { renderGroups(); return; }
  const mySelection = selectedGroupId;
  const selected = mySelection
    ? state.sharing.getAllGroups().find(g => g.id === mySelection)
    : null;
  if (mySelection && !selected) { renderGroups(); return; }
  detailPaneHtml(selected).then(html => {
    if (selectedGroupId !== mySelection) return; // superseded by a newer tap
    const detail = layout.querySelector('.groups-detail');
    if (detail) detail.innerHTML = html;
    layout.querySelectorAll('.groups-list-item').forEach(el => {
      const on = el.dataset.groupId === mySelection;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-current', on ? 'true' : 'false');
    });
    layout.classList.toggle('groups-detail-active', !!mySelection);
  }).catch(e => { console.error('selectGroup:', e); renderGroups(); });
}

/** Toggle the Add/Join chooser menu. Exposed for data-action delegation. */
export function groupsAddMenu() {
  _addMenuOpen = !_addMenuOpen;
  renderGroups();
}

/** Run the chosen Add/Join action and close the menu. Exposed for data-action delegation. */
export function groupsAddChoice(choice) {
  _addMenuOpen = false;
  renderGroups();
  if (choice === 'create') window.sharingCreateGroup?.();
  else window.sharingOpenJoinCodeModal?.();
}

function addMenuHtml() {
  return `<div class="groups-add-wrap${_addMenuOpen ? ' open' : ''}">
    <button class="btn groups-add-btn" data-action="groups-add-menu" aria-haspopup="menu" aria-expanded="${_addMenuOpen ? 'true' : 'false'}">${lucideIcon('plus', 16)} ${t('groups.add_join_group')} ${lucideIcon('chevron-down', 14)}</button>
    ${_addMenuOpen ? `<div class="groups-add-menu" role="menu">
      <button class="header-menu-item" role="menuitem" data-action="groups-add-choice" data-choice="create"><span class="header-menu-icon">${lucideIcon('plus', 16)}</span> ${t('sharing.create_group')}</button>
      <button class="header-menu-item" role="menuitem" data-action="groups-add-choice" data-choice="join"><span class="header-menu-icon">${lucideIcon('log-in', 16)}</span> ${t('sharing.join_group')}</button>
    </div>` : ''}
  </div>`;
}

function groupListItemHtml(group, selected) {
  const memberCount = visibleMembers(group).length;
  const itemCount = state.sharing.getItems(group.id).length;
  const memberStr = memberCount === 1 ? t('sharing.member') : t('sharing.members', memberCount);
  const itemStr = itemCount === 1 ? t('sharing.shared_item') : t('sharing.shared_items', itemCount);
  return `<button class="groups-list-item${selected ? ' selected' : ''}" data-action="groups-select" data-group-id="${esc(group.id)}" aria-current="${selected ? 'true' : 'false'}">
    <span class="groups-list-item-icon">${lucideIcon('users', 16)}</span>
    <span class="groups-list-item-text">
      <span class="groups-list-item-name">${esc(group.name)}</span>
      <span class="groups-list-item-meta">${memberStr} \u00b7 ${itemStr}</span>
    </span>
  </button>`;
}

/** Render the Group tab. */
export async function renderGroups() {
  const container = document.getElementById('groupsView');
  if (!container) return;

  const activeMode = localStorage.getItem('claw_cc_active_mode');

  // Demo mode — group management is not available in the demo.
  if (activeMode === 'demo') {
    container.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('users', 48, 'var(--muted)')}</div>
      <h3>${t('sharing.demo_title')}</h3>
      <p>${t('sharing.demo_hint')}</p>
    </div>`;
    return;
  }

  if (!state.sharing) {
    container.innerHTML = activeMode === 'googledrive' && !state.sharingInitFailed
      ? `<p class="setting-hint">${t('common.loading')}</p>`
      : `<p class="setting-hint">${t('sharing.no_drive')}</p>`;
    return;
  }

  ensureSubscribed();

  const groups = state.sharing.getAllGroups();
  if (selectedGroupId && !groups.some(g => g.id === selectedGroupId)) selectedGroupId = null;
  const selected = selectedGroupId ? groups.find(g => g.id === selectedGroupId) : null;

  // Groups whose files failed to load transiently this session — listed
  // disabled with a chip instead of being silently dropped.
  const skippedGroups = state.sharing.getSkippedGroups?.() || [];

  const listHtml = groups.length === 0 && skippedGroups.length === 0
    ? `<p class="setting-hint">${t('sharing.no_groups_hint')}</p>`
    : groups.map(g => groupListItemHtml(g, g.id === selectedGroupId)).join('')
      + skippedGroups.map(skippedGroupItemHtml).join('');

  const detailHtml = await detailPaneHtml(selected);

  container.innerHTML = `<div class="groups-layout${selected ? ' groups-detail-active' : ''}">
    <aside class="groups-sidebar" aria-label="${t('sharing.groups')}">
      <div class="groups-sidebar-actions">
        ${addMenuHtml()}
      </div>
      <div class="groups-list">${listHtml}</div>
    </aside>
    <section class="groups-detail">${detailHtml}</section>
  </div>`;
}

window.selectGroup = selectGroup;
window.groupsAddMenu = groupsAddMenu;
window.groupsAddChoice = groupsAddChoice;
window.renderGroups = renderGroups;
