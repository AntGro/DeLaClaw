// ===================================================================
// SHARING UI — Settings pane, share popovers, completion modal
// ===================================================================
//
// Renders the sharing settings pane (trusted contacts + group
// management) and provides helpers for share badges, share-to-group
// popovers, and multi-assignee completion modals used by
// todos.js, habits.js, lists.js.
//
// Requires state.sharing (Drive sharing module) to be initialized.
// All UI is hidden when state.sharing is null.
// ===================================================================

import state from './state.js';
import { t, getLang } from './i18n.js';
import { esc, escQ, showToast, showDeleteConfirm } from './utils.js';
import { lucideIcon } from './icons.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Generate a deterministic color from a string (email). */
function emailColor(email) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) | 0;
  const hues = [210, 340, 150, 30, 270, 190, 50, 310, 80, 230];
  return `oklch(0.65 0.15 ${hues[Math.abs(hash) % hues.length]})`;
}

/** Initials from display name or email. */
function initials(name, email) {
  if (name && name.includes(' ')) {
    const parts = name.split(/\s+/);
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (name) return name[0].toUpperCase();
  return (email || '?')[0].toUpperCase();
}

/** Small avatar circle HTML. */
function avatarDot(member, size = 24) {
  const color = emailColor(member.email);
  const ini = initials(member.name || member.display_name, member.email);
  return `<span class="sharing-avatar" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.42)}px" title="${esc(member.email)}">${esc(ini)}</span>`;
}

// ── Settings Pane ────────────────────────────────────────────────

let _currentUser = null;

/** Show or hide the sharing nav button based on state.sharing availability. */
export function updateSharingNavVisibility() {
  const btn = document.getElementById('settingsNavSharingBtn');
  if (btn) btn.style.display = state.sharing ? '' : 'none';
}

/** Render the full sharing settings pane content. */
export async function renderSharingPane() {
  const container = document.getElementById('sharingPaneContent');
  if (!container) return;

  if (!state.sharing) {
    container.innerHTML = `<p class="setting-hint">${t('sharing.no_drive')}</p>`;
    return;
  }

  // Check if sharing (full Drive scope) is enabled
  const sharingEnabled = state.driveAdapter?.sharingEnabled;

  if (!sharingEnabled) {
    container.innerHTML = `
      <div class="page-empty-state">
        ${lucideIcon('shield', 40)}
        <h3>${t('sharing.enable_title')}</h3>
        <p>${t('sharing.enable_hint')}</p>
        <button class="empty-cta" id="enableSharingBtn" onclick="enableSharingMode()">
          ${lucideIcon('unlock', 16)} ${t('sharing.enable_btn')}
        </button>
      </div>`;
    return;
  }

  // Get current user identity
  try {
    if (!_currentUser) _currentUser = await state.sharing.getCurrentUser();
  } catch { _currentUser = null; }

  let html = '';

  // ── Trusted contacts section ──
  const trusted = state.sharing.getTrustedContacts();

  html += `<div class="setting-group">
    <div class="setting-group-label">${t('sharing.trusted_contacts')}</div>
    <p class="setting-hint">${t('sharing.trusted_hint')}</p>`;

  if (trusted.length > 0) {
    html += `<div class="sharing-trusted-list">`;
    for (const email of trusted) {
      html += `<div class="sharing-member">
        ${avatarDot({ email, name: '' }, 22)}
        <span class="sharing-member-email">${esc(email)}</span>
        <button class="sharing-remove-btn" onclick="sharingRemoveTrusted('${escQ(email)}')" title="${t('common.delete')}">${lucideIcon('x', 12)}</button>
      </div>`;
    }
    html += `</div>`;
  }

  html += `<div class="sharing-invite-row">
    <input type="email" class="sharing-invite-input" id="sharingTrustedInput" placeholder="${t('sharing.trusted_placeholder')}" onkeydown="if(event.key==='Enter'){event.preventDefault();sharingAddTrusted();}">
    <button class="sharing-invite-btn" onclick="sharingAddTrusted()">${lucideIcon('user-plus', 14)} ${t('common.add')}</button>
  </div>
  </div>`;

  // ── Groups section ──
  const groups = state.sharing.getAllGroups();

  html += `<div class="setting-group"><div class="setting-group-label">${t('sharing.groups')}</div>`;

  if (groups.length === 0) {
    html += `<p class="setting-hint">${t('sharing.no_groups_hint')}</p>`;
  }

  for (const group of groups) {
    const isCreator = _currentUser && group.created_by?.email === _currentUser.email;
    const memberCount = group.members?.length || 0;
    const itemCount = state.sharing.getItems(group.id).length;
    const memberStr = memberCount === 1 ? t('sharing.member') : t('sharing.members', memberCount);
    const itemStr = itemCount === 1 ? t('sharing.shared_item') : t('sharing.shared_items', itemCount);

    html += `<div class="sharing-group-card">
      <div class="sharing-group-header">
        <div class="sharing-group-info">
          <h4>${esc(group.name)}</h4>
          <span class="sharing-group-stats">${memberStr} · ${itemStr}</span>
        </div>
        <div class="sharing-group-actions">
          ${isCreator ? '' : `<button class="sharing-action-btn sharing-leave-btn" onclick="sharingLeaveGroup('${escQ(group.id)}')" title="${t('sharing.leave')}">${lucideIcon('log-out', 14)} ${t('sharing.leave')}</button>`}
        </div>
      </div>
      <div class="sharing-members">`;

    for (const member of (group.members || [])) {
      const isYou = _currentUser && member.email === _currentUser.email;
      const canRemove = isCreator && !isYou;
      html += `<div class="sharing-member">
          ${avatarDot(member, 22)}
          <span class="sharing-member-email">${esc(member.email)}${isYou ? ` <span class="sharing-you">(${t('sharing.you')})</span>` : ''}</span>
          ${canRemove ? `<button class="sharing-remove-btn" onclick="sharingRemoveMember('${escQ(group.id)}','${escQ(member.email)}')" title="${t('sharing.remove_member')}">${lucideIcon('x', 12)}</button>` : ''}
        </div>`;
    }

    html += `</div>
      <div class="sharing-invite-row">
        <input type="email" class="sharing-invite-input" id="sharingInvite-${esc(group.id)}" placeholder="${t('sharing.invite_placeholder')}" onkeydown="if(event.key==='Enter'){event.preventDefault();sharingInvite('${escQ(group.id)}');}">
        <button class="sharing-invite-btn" onclick="sharingInvite('${escQ(group.id)}')">${lucideIcon('user-plus', 14)} ${t('sharing.invite')}</button>
      </div>
      ${isCreator ? `<button class="sharing-delete-btn" onclick="sharingDeleteGroup('${escQ(group.id)}')">${lucideIcon('trash-2', 14)} ${t('sharing.delete_group')}</button>` : ''}
    </div>`;
  }

  html += `</div>
    <div class="sharing-bottom-actions">
      <button class="sharing-action-btn" onclick="sharingCreateGroup()">${lucideIcon('plus', 14)} ${t('sharing.create_group')}</button>
    </div>`;

  container.innerHTML = html;
}

// ── Actions (exposed on window) ─────────────────────────────────

async function enableSharingMode() {
  const btn = document.getElementById('enableSharingBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    await state.driveAdapter.requestScopeUpgrade();
    await state.sharing.loadTrustedContacts();
    showToast(t('sharing.enabled'), 'success');
    renderSharingPane();
  } catch (e) {
    showToast(e.message || t('sharing.enable_failed'), 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function sharingAddTrusted() {
  const input = document.getElementById('sharingTrustedInput');
  const email = input?.value.trim();
  if (!email) return;
  try {
    await state.sharing.addTrustedContact(email);
    input.value = '';
    showToast(t('sharing.trusted_added'), 'success');
    renderSharingPane();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function sharingRemoveTrusted(email) {
  showDeleteConfirm(
    t('sharing.remove_trusted'),
    t('sharing.remove_trusted_confirm', email),
    async () => {
      try {
        await state.sharing.removeTrustedContact(email);
        showToast(t('sharing.trusted_removed'), 'info');
        renderSharingPane();
      } catch (e) { showToast(e.message, 'error'); }
    }
  );
}

async function sharingCreateGroup() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingCreateGroupModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.create_group')}</h2>
    <div class="sharing-antispam-notice">
      ${lucideIcon('shield-alert', 16)}
      <span>${t('sharing.antispam_notice')}</span>
    </div>
    <label>${t('sharing.group_name')}</label>
    <input type="text" id="sharingNewGroupName" placeholder="${t('sharing.group_name_placeholder')}" maxlength="60" onkeydown="if(event.key==='Enter'){event.preventDefault();sharingCreateGroupSubmit();}">
    <div class="modal-actions">
      <button class="modal-cancel" onclick="document.getElementById('sharingCreateGroupModal').remove()">${t('common.cancel')}</button>
      <button class="modal-save" id="sharingCreateGroupBtn" onclick="sharingCreateGroupSubmit()">${t('common.create')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  setTimeout(() => document.getElementById('sharingNewGroupName')?.focus(), 50);
}

async function sharingCreateGroupSubmit() {
  const input = document.getElementById('sharingNewGroupName');
  const name = input?.value.trim();
  if (!name) return;
  const btn = document.getElementById('sharingCreateGroupBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    await state.sharing.createGroup(name);
    showToast(t('sharing.group_created'), 'success');
    document.getElementById('sharingCreateGroupModal')?.remove();
    renderSharingPane();
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function sharingInvite(groupId) {
  const input = document.getElementById(`sharingInvite-${groupId}`);
  const email = input?.value.trim();
  if (!email) return;
  const btn = input?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    await state.sharing.inviteUser(groupId, email);
    input.value = '';
    showToast(t('sharing.invite_sent'), 'success');
    renderSharingPane();
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function sharingRemoveMember(groupId, email) {
  showDeleteConfirm(
    t('sharing.remove_member'),
    t('sharing.remove_member_confirm', email),
    async () => {
      try {
        await state.sharing.removeUser(groupId, email);
        showToast(t('sharing.member_removed'), 'info');
        renderSharingPane();
      } catch (e) { showToast(e.message, 'error'); }
    }
  );
}

async function sharingLeaveGroup(groupId) {
  showDeleteConfirm(
    t('sharing.leave'),
    t('sharing.leave_confirm'),
    async () => {
      try {
        await state.sharing.leaveGroup(groupId);
        showToast(t('sharing.left_group'), 'info');
        renderSharingPane();
      } catch (e) { showToast(e.message, 'error'); }
    }
  );
}

async function sharingDeleteGroup(groupId) {
  showDeleteConfirm(
    t('sharing.delete_group'),
    t('sharing.delete_group_confirm'),
    async () => {
      try {
        await state.sharing.deleteGroup(groupId);
        showToast(t('sharing.group_deleted'), 'info');
        renderSharingPane();
      } catch (e) { showToast(e.message, 'error'); }
    }
  );
}

// ── Shared badge (used by todos/habits/lists) ───────────────────

/** Return inline HTML for a shared badge showing the group name. */
export function sharedBadge(groupName) {
  return `<span class="shared-badge">${lucideIcon('users', 12)} ${esc(groupName)}</span>`;
}

/** Return inline HTML for assignee avatar dots. */
export function assigneeDots(assignees, maxShow = 3) {
  if (!assignees?.length) return '';
  let html = '<span class="assignee-dots">';
  const show = assignees.slice(0, maxShow);
  for (const a of show) {
    const email = typeof a === 'string' ? a : a.email;
    const name = typeof a === 'string' ? '' : (a.name || a.display_name || '');
    html += avatarDot({ email, name }, 18);
  }
  if (assignees.length > maxShow) {
    html += `<span class="assignee-overflow">+${assignees.length - maxShow}</span>`;
  }
  html += '</span>';
  return html;
}

// ── Share-to-group popover ──────────────────────────────────────

/** Open a share-to-group popover near the given button element. */
export function openSharePopover(anchorEl, onShare) {
  closeSharePopover();
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;

  const popover = document.createElement('div');
  popover.className = 'share-popover';
  popover.id = 'sharePopover';

  let selectedGroupId = groups[0].id;

  const renderPopover = () => {
    const selectedGroup = groups.find(g => g.id === selectedGroupId) || groups[0];
    const members = selectedGroup.members || [];

    popover.innerHTML = `
      <div class="share-popover-section">
        <div class="share-popover-label">${t('sharing.share_to')}</div>
        ${groups.map(g => `
          <label class="share-popover-radio">
            <input type="radio" name="shareGroup" value="${esc(g.id)}" ${g.id === selectedGroupId ? 'checked' : ''}>
            ${esc(g.name)}
          </label>
        `).join('')}
      </div>
      <div class="share-popover-section">
        <div class="share-popover-label">${t('sharing.assign_to')}</div>
        ${members.map(m => `
          <label class="share-popover-check">
            <input type="checkbox" value="${esc(m.email)}" checked>
            ${esc(m.email)}
          </label>
        `).join('')}
      </div>
      <button class="share-popover-submit" onclick="submitSharePopover()">${lucideIcon('share', 14)} ${t('sharing.share')}</button>
    `;

    popover.querySelectorAll('input[name="shareGroup"]').forEach(radio => {
      radio.addEventListener('change', () => {
        selectedGroupId = radio.value;
        renderPopover();
      });
    });
  };

  renderPopover();

  const rect = anchorEl.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.left - 120)}px`;
  popover.style.zIndex = '300';
  document.body.appendChild(popover);

  popover._onShare = onShare;

  setTimeout(() => {
    document.addEventListener('click', _closeSharePopoverOutside, true);
  }, 0);
}

function _closeSharePopoverOutside(e) {
  const pop = document.getElementById('sharePopover');
  if (pop && !pop.contains(e.target)) closeSharePopover();
}

export function closeSharePopover() {
  const pop = document.getElementById('sharePopover');
  if (pop) pop.remove();
  document.removeEventListener('click', _closeSharePopoverOutside, true);
}

function submitSharePopover() {
  const pop = document.getElementById('sharePopover');
  if (!pop) return;
  const groupId = pop.querySelector('input[name="shareGroup"]:checked')?.value;
  const assignees = [...pop.querySelectorAll('.share-popover-check input:checked')].map(cb => cb.value);
  if (pop._onShare && groupId) {
    pop._onShare(groupId, assignees);
  }
  closeSharePopover();
}

// ── Completion modal ────────────────────────────────────────────

/** Show "who did this?" modal for multi-assignee items. */
export function showCompletionModal(groupId, itemId, assignees, currentUserEmail) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingCompletionModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `<div class="modal sharing-completion-modal">
    <h2>${lucideIcon('circle-check', 20)} ${t('sharing.who_did_this')}</h2>
    <div class="sharing-completion-list">
      ${assignees.map(email => `
        <label class="share-popover-check">
          <input type="checkbox" value="${esc(email)}" ${email === currentUserEmail ? 'checked' : ''}>
          ${esc(email)}
        </label>
      `).join('')}
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="document.getElementById('sharingCompletionModal').remove()">${t('common.cancel')}</button>
      <button class="modal-save" onclick="sharingCompleteSubmit('${escQ(groupId)}','${escQ(itemId)}')">${t('common.done')}</button>
    </div>
  </div>`;

  document.getElementById('app').appendChild(overlay);
}

async function sharingCompleteSubmit(groupId, itemId) {
  const modal = document.getElementById('sharingCompletionModal');
  if (!modal) return;
  const doneBy = [...modal.querySelectorAll('.share-popover-check input:checked')].map(cb => cb.value);
  if (!doneBy.length) return;
  const btn = modal.querySelector('.modal-save');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    await state.sharing.completeItem(groupId, itemId, doneBy);
    showToast(t('common.done') + '!', 'success');
    modal.remove();
    document.dispatchEvent(new CustomEvent('sharing-changed'));
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// ── i18n for settings pane labels ───────────────────────────────

export function applySettingsI18n() {
  const titleEl = document.getElementById('settingsPaneSharingTitle');
  if (titleEl) titleEl.textContent = t('sharing.title');
  const navEl = document.getElementById('settingsNavSharing');
  if (navEl) navEl.textContent = t('sharing.title');
}

// ── Expose actions on window ────────────────────────────────────

window.enableSharingMode = enableSharingMode;
window.sharingAddTrusted = sharingAddTrusted;
window.sharingRemoveTrusted = sharingRemoveTrusted;
window.sharingCreateGroup = sharingCreateGroup;
window.sharingCreateGroupSubmit = sharingCreateGroupSubmit;
window.sharingInvite = sharingInvite;
window.sharingRemoveMember = sharingRemoveMember;
window.sharingLeaveGroup = sharingLeaveGroup;
window.sharingDeleteGroup = sharingDeleteGroup;
window.submitSharePopover = submitSharePopover;
window.sharingCompleteSubmit = sharingCompleteSubmit;
