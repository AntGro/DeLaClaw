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

// Structural adapter events only: item-level changes (item-added, …) don't
// affect this view, and re-rendering on them could wipe an in-progress invite.
const STRUCTURAL_EVENTS = new Set([
  'group-created', 'group-deleted', 'group-joined',
  'member-invited', 'member-removed', 'member-joined', 'group-changed',
]);

function ensureSubscribed() {
  if (_subscribed || !state.sharing || typeof state.sharing.onUpdate !== 'function') return;
  _subscribed = true;
  state.sharing.onUpdate((event, detail) => {
    if (!STRUCTURAL_EVENTS.has(event)) return;
    if (event === 'group-created' && detail?.group?.id) selectedGroupId = detail.group.id;
    if (event === 'group-deleted' && detail?.groupId === selectedGroupId) selectedGroupId = null;
    if (state.currentView === 'groups') renderGroups();
  });
}

/** Select a group (null = back to the list). Exposed for data-action delegation. */
export function selectGroup(groupId) {
  selectedGroupId = groupId || null;
  renderGroups();
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

  // Demo mode — same guard as the Settings → Sharing pane.
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

  const listHtml = groups.length === 0
    ? `<p class="setting-hint">${t('sharing.no_groups_hint')}</p>`
    : groups.map(g => groupListItemHtml(g, g.id === selectedGroupId)).join('');

  const detailHtml = selected
    ? `<button class="btn groups-back-btn" data-action="groups-back">${lucideIcon('chevron-left', 16)} ${t('groups.back_to_groups')}</button>
       ${await sharingGroupCardHtml(selected)}`
    : `<div class="page-empty-state">
        <div class="empty-icon">${lucideIcon('users', 48, 'var(--muted)')}</div>
        <h3>${t('sharing.groups')}</h3>
        <p>${groups.length === 0 ? t('sharing.no_groups_hint') : t('groups.select_prompt')}</p>
      </div>`;

  container.innerHTML = `<div class="groups-layout${selected ? ' groups-detail-active' : ''}">
    <aside class="groups-sidebar" aria-label="${t('sharing.groups')}">
      <div class="groups-sidebar-actions">
        <button class="btn groups-add-btn" data-action="sharing-create-group">${lucideIcon('plus', 16)} ${t('groups.add_group')}</button>
        <button class="btn" data-action="sharing-open-join-code" title="${t('sharing.join_group')}" aria-label="${t('sharing.join_group')}">${lucideIcon('log-in', 16)}</button>
      </div>
      <div class="groups-list">${listHtml}</div>
    </aside>
    <section class="groups-detail">${detailHtml}</section>
  </div>`;
}

window.selectGroup = selectGroup;
window.renderGroups = renderGroups;
