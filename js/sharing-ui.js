// ===================================================================
// SHARING UI — Settings pane, share popovers, completion modal
// ===================================================================
//
// Renders the sharing settings pane (groups, invite links, trusted
// contacts) and provides helpers for share badges, share-to-group
// popovers, and multi-assignee completion modals used by
// todos.js, habits.js, lists.js.
//
// Requires state.sharing (Drive sharing module) to be initialized.
// All UI is hidden when state.sharing is null.
//
// HYBRID MODEL:
//   - Sharing is always available with Drive backend (no scope gate)
//   - Groups + invite links work with drive.file scope
//   - Auto-discovery (trusted contacts) is optional (full drive scope)
//   - Join via invite link uses Google Picker for drive.file access
// ===================================================================

import state, { STAY_CONNECTED_KEY } from './state.js';
import { t, getLang } from './i18n.js';
import { esc, escQ, showToast, showDeleteConfirm } from './utils.js';
import { lucideIcon } from './icons.js';
import { LOGOS } from './backend-logos.js';
import { decodeInviteEnvelope } from './sharing-envelope.js';

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
  if (!btn) return;
  // Show sharing nav for Drive users with sharing, or Supabase users (even if not yet authenticated)
  const activeMode = localStorage.getItem('claw_cc_active_mode');
  btn.style.display = (state.sharing || activeMode === 'supabase') ? '' : 'none';
}

/** Render the full sharing settings pane content. */
export async function renderSharingPane() {
  const container = document.getElementById('sharingPaneContent');
  if (!container) return;

  const activeMode = localStorage.getItem('claw_cc_active_mode');

  if (!state.sharing) {
    // Supabase without auth: show inline sign-in prompt (only if DB has auth tables)
    const dbReady = parseFloat(state.dbSchemaVersion || '0') >= 1.294;
    if (activeMode === 'supabase' && !state.authUser && dbReady) {
      const creds = (() => { try { return JSON.parse(localStorage.getItem(STAY_CONNECTED_KEY) || '{}'); } catch { return {}; } })();
      const projRef = (creds.url || '').replace('https://', '').replace('.supabase.co', '');
      const authConfigUrl = projRef ? `https://supabase.com/dashboard/project/${projRef}/auth/url-configuration` : 'https://supabase.com/dashboard';
      const siteOrigin = location.origin;
      container.innerHTML = `<div class="auth-inline-prompt">
        <div class="auth-icon">${lucideIcon('lock', 28)}</div>
        <h4>${t('auth.sign_in_to_share')}</h4>
        <p class="auth-inline-hint">${t('auth.sign_in_to_share_hint')}</p>

        <div class="auth-step" id="sharingStep1">
          <div class="auth-step-header">
            <span class="auth-step-num">1</span>
            <span>${t('auth.step_site_url')}</span>
          </div>
          <p class="auth-step-detail">${t('auth.step_site_url_detail')}</p>
          <div class="auth-site-url-value">
            <code id="sharingSiteUrlValue">${esc(siteOrigin)}</code>
            <button class="auth-copy-url-btn" id="sharingCopyUrlBtn" title="${t('sharing.copy')}">${lucideIcon('copy', 14)}</button>
          </div>
          <a class="auth-config-link" href="${authConfigUrl}" target="_blank" rel="noopener">${lucideIcon('external-link', 14)} ${t('auth.open_supabase_settings')}</a>
          <label class="auth-toggle-label" id="sharingConfirmLabel">
            <input type="checkbox" id="sharingSiteUrlConfirm">
            <span>${t('auth.site_url_confirmed')}</span>
          </label>
        </div>

        <div class="auth-step auth-step-locked" id="sharingStep2">
          <div class="auth-step-header">
            <span class="auth-step-num">2</span>
            <span>${t('auth.step_magic_link')}</span>
          </div>
          <div id="sharingStep2Body" style="display:none">
            <input type="email" id="sharingAuthEmail" placeholder="${t('auth.email_placeholder')}" autocomplete="email">
            <div class="auth-inline-error" id="sharingAuthError" style="display:none"></div>
            <button class="auth-send-btn" id="sharingAuthSendBtn" onclick="window.sendAuthFromSharing()">${t('auth.send_magic_link')}</button>
            <div class="auth-inline-status" id="sharingAuthStatus" style="display:none"></div>
          </div>
        </div>
      </div>`;
      // Wire up step 1 → step 2 unlock
      const confirmBox = container.querySelector('#sharingSiteUrlConfirm');
      const step2 = container.querySelector('#sharingStep2');
      const step2Body = container.querySelector('#sharingStep2Body');
      const copyUrlBtn = container.querySelector('#sharingCopyUrlBtn');
      if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(siteOrigin).then(() => showToast(t('common.copied'), 'success'));
        });
      }
      if (confirmBox) {
        confirmBox.addEventListener('change', () => {
          if (confirmBox.checked) {
            step2.classList.remove('auth-step-locked');
            step2Body.style.display = '';
            const emailEl = container.querySelector('#sharingAuthEmail');
            if (emailEl) emailEl.focus();
          } else {
            step2.classList.add('auth-step-locked');
            step2Body.style.display = 'none';
          }
        });
      }
    } else if (activeMode === 'supabase' && state.authUser) {
      // Authenticated but sharing adapter failed to initialise
      const errMsg = state._sharingInitError ? esc(String(state._sharingInitError.message || state._sharingInitError)) : '';
      const dbVer = esc(state.dbSchemaVersion || '?');
      container.innerHTML = `<div class="auth-inline-prompt">
        <div class="auth-icon">${lucideIcon('refresh-cw', 28)}</div>
        <h4>${t('sharing.init_failed')}</h4>
        <p class="auth-inline-hint">${t('sharing.init_failed_hint')}</p>
        ${errMsg ? `<p class="setting-hint" style="font-size:0.75rem;opacity:0.6;margin-top:8px">Error: ${errMsg} (DB ${dbVer})</p>` : ''}
      </div>`;
    } else {
      container.innerHTML = `<p class="setting-hint">${t('sharing.no_drive')}</p>`;
    }
    return;
  }

  // Show auth status for authenticated Supabase users
  let authBadgeHtml = '';
  if (activeMode === 'supabase' && state.authUser) {
    const email = esc(state.authUser.email || '');
    authBadgeHtml = `<div class="setting-group">
      <div class="auth-signed-in-badge">${lucideIcon('shield-check', 14)} ${t('auth.signed_in_as', email)}</div>
      <button class="btn-secondary sharing-danger-btn" onclick="window.signOutFromSharing()" style="font-size:0.8rem;padding:4px 12px;margin-top:0">${t('auth.sign_out')}</button>
    </div>`;
  }

  // Get current user identity
  try {
    if (!_currentUser) _currentUser = await state.sharing.getCurrentUser();
  } catch { _currentUser = null; }

  let html = authBadgeHtml;

  // ── Groups section ──
  const groups = state.sharing.getAllGroups();

  html += `<div class="setting-group"><div class="setting-group-label">${t('sharing.groups')}</div>`;

  if (groups.length === 0) {
    html += `<p class="setting-hint">${t('sharing.no_groups_hint')}</p>`;
  }

  for (const group of groups) {
    const isCreator = _currentUser && group.created_by?.email === _currentUser.email;
    const isJoined = state.sharing.isJoinedViaLink(group.id);
    const memberCount = group.members?.length || 0;
    const itemCount = state.sharing.getItems(group.id).length;
    const memberStr = memberCount === 1 ? t('sharing.member') : t('sharing.members', memberCount);
    const itemStr = itemCount === 1 ? t('sharing.shared_item') : t('sharing.shared_items', itemCount);
    const inviteLink = state.sharing.getInviteLink(group.id);

    html += `<div class="sharing-group-card">
      <div class="sharing-group-header">
        <div class="sharing-group-info">
          <h4>${esc(group.name)}</h4>
          <span class="sharing-group-stats">${memberStr} \u00b7 ${itemStr}</span>
        </div>
        <div class="sharing-group-actions">
          ${group.folderId ? `<a class="sharing-action-btn sharing-drive-link" href="https://drive.google.com/drive/folders/${encodeURIComponent(group.folderId)}" target="_blank" rel="noopener" title="${t('sharing.open_drive_folder')}">${LOGOS.googledrive(14)} ${t('sharing.open_drive_folder')}</a>` : ''}
          ${inviteLink && isCreator && group.backendType !== 'supabase' ? `<button class="sharing-action-btn sharing-copy-link-btn" onclick="sharingCopyLink('${escQ(group.id)}')" title="${t('sharing.copy_link')}">${lucideIcon('link', 14)} ${t('sharing.copy_link')}</button>` : ''}
          ${!isCreator ? `<button class="sharing-action-btn sharing-leave-btn" onclick="${isJoined ? `sharingUnjoinGroup('${escQ(group.id)}')` : `sharingLeaveGroup('${escQ(group.id)}')`}" title="${t('sharing.leave')}">${lucideIcon('log-out', 14)} ${t('sharing.leave')}</button>` : ''}
        </div>
      </div>
      <div class="sharing-members">`;

    for (const member of (group.members || [])) {
      const isYou = _currentUser && (member.email === _currentUser.email
        || member.displayName === _currentUser.email
        || member.displayName === _currentUser.email?.split('@')[0]);
      const canRemove = isCreator && !isYou;
      const hasJoined = member.role === 'owner' || member.role === 'creator' || !!member.accepted || !!member.joined_at;
      const isCreatorMember = member.role === 'creator';
      const statusHtml = isYou ? ` <span class="sharing-you">(${t('sharing.you')})</span>`
        : isCreatorMember ? ` <span class="sharing-member-creator">${lucideIcon('crown', 12)} ${t('sharing.creator')}</span>`
        : hasJoined ? ` <span class="sharing-member-joined">${lucideIcon('check', 12)}</span>`
        : ` <span class="sharing-member-pending">${t('sharing.pending')}</span>`;
      const canCopyLink = isCreator && !isYou && !hasJoined && member.token && state.sharing.getMemberInviteLink;
      html += `<div class="sharing-member">
          ${avatarDot(member, 22)}
          <span class="sharing-member-email">${esc(member.email)}${statusHtml}</span>
          ${canCopyLink ? `<button class="sharing-action-btn" onclick="sharingCopyMemberLink('${escQ(group.id)}','${escQ(member.token)}')" title="${t('sharing.copy_link')}" style="font-size:0.75rem;padding:2px 6px">${lucideIcon('link', 12)}</button>` : ''}
          ${canRemove ? `<button class="sharing-remove-btn" onclick="sharingRemoveMember('${escQ(group.id)}','${escQ(member.email)}')" title="${t('sharing.remove_member')}">${lucideIcon('x', 12)}</button>` : ''}
        </div>`;
    }

    html += `</div>
      ${isCreator ? `<div class="sharing-invite-row">
        <input type="text" class="sharing-invite-input" id="sharingInvite-${esc(group.id)}" placeholder="${t('sharing.invite_name_placeholder')}" onkeydown="if(event.key==='Enter'){event.preventDefault();sharingInvite('${escQ(group.id)}');}">
        <button class="sharing-invite-btn" onclick="sharingInvite('${escQ(group.id)}')">${lucideIcon('user-plus', 14)} ${t('sharing.invite')}</button>
      </div>` : ''}
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

async function sharingCreateGroup() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingCreateGroupModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.create_group')}</h2>
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
  if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = t('sharing.creating_group'); }
  try {
    const group = await state.sharing.createGroup(name);
    document.getElementById('sharingCreateGroupModal')?.remove();
    showToast(t('sharing.group_created'), 'success');
    renderSharingPane();
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = t('common.create'); }
  }
}

/** Show a modal with an invite link (after group creation or member invite). */
function showInviteLinkModal(name, link, isNewGroup) {
  const title = isNewGroup ? t('sharing.group_created') : t('sharing.member_added');
  const hint = isNewGroup
    ? t('sharing.invite_link_hint', name)
    : t('sharing.member_link_hint', name);
  // sec-003: warn that link contains secret & is single-use, stays in history
  const warn = `<p class="sharing-warning" style="margin-top:10px;font-size:0.82rem;color:var(--warn,#d97706);background:color-mix(in srgb,var(--warn,#d97706) 12%, transparent);border:1px solid color-mix(in srgb,var(--warn,#d97706) 30%, transparent);border-radius:8px;padding:8px 10px">${lucideIcon('shield-alert', 12)} ${t('sharing.invite_secret_warn') || 'This link contains a secret token (single-use). Anyone with it can join. It stays in browser history — share privately and revoke after use.'}</p>`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingInviteLinkModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('link', 20)} ${title}</h2>
    <p>${hint}</p>
    <div class="sharing-invite-link-box">
      <input type="text" id="sharingInviteLinkInput" value="${esc(link)}" readonly onclick="this.select()">
      <button class="sharing-invite-btn" onclick="sharingCopyLinkValue()">${lucideIcon('copy', 14)} ${t('sharing.copy')}</button>
    </div>
    ${warn}
    <div class="modal-actions">
      <button class="modal-save" onclick="document.getElementById('sharingInviteLinkModal').remove()">${t('common.close')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
}

function sharingCopyLinkValue() {
  const input = document.getElementById('sharingInviteLinkInput');
  if (input) {
    navigator.clipboard.writeText(input.value).then(() => {
      showToast(t('common.copied'), 'success');
    });
  }
}

async function sharingCopyLink(groupId) {
  const link = state.sharing?.getInviteLink(groupId);
  if (link) {
    try {
      await navigator.clipboard.writeText(link);
      showToast(t('common.copied'), 'success');
    } catch {
      showInviteLinkModal('', link);
    }
  }
}

async function sharingCopyMemberLink(groupId, token) {
  const link = state.sharing?.getMemberInviteLink?.(groupId, token);
  if (link) {
    try {
      await navigator.clipboard.writeText(link);
      showToast(t('common.copied'), 'success');
    } catch {
      showInviteLinkModal('', link);
    }
  }
}

async function sharingInvite(groupId) {
  const input = document.getElementById(`sharingInvite-${groupId}`);
  const name = input?.value.trim();
  if (!name) return;
  const btn = input?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const result = await state.sharing.inviteUser(groupId, name);
    input.value = '';
    // Build per-member invite link with token
    const memberLink = state.sharing.getMemberInviteLink
      ? state.sharing.getMemberInviteLink(groupId, result.token)
      : null;
    renderSharingPane();
    if (memberLink) {
      showInviteLinkModal(name, memberLink);
    } else {
      showToast(t('sharing.member_added'), 'success');
    }
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

async function sharingUnjoinGroup(groupId) {
  showDeleteConfirm(
    t('sharing.leave'),
    t('sharing.leave_confirm'),
    async () => {
      try {
        await state.sharing.unjoinGroup(groupId);
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

// ── Join via invite link (#join=<folderId>) ─────────────────────

/** Handle the #join= hash, called from main.js after Drive init. */
export async function handleJoinHash(folderId) {
  if (!state.sharing) return;

  // Envelope decode helper (no legacy)
  const getGidFromRef = (ref) => {
    const env = decodeInviteEnvelope(ref);
    return env?.g || null;
  };

  // Check if already joined via this folderId / envelope
  const existing = state.sharing.getGroupByFolderId?.(folderId);
  if (existing) {
    showToast(t('sharing.already_joined', existing.name || ''), 'info');
    renderSharingPane();
    return;
  }

  // For Supabase envelope, extract group ID and check if already joined
  const gid = getGidFromRef(folderId);
  if (gid) {
    const alreadyJoined = state.sharing.getAllGroups?.()?.find(g => g.id === gid);
    if (alreadyJoined) {
      showToast(t('sharing.already_joined', alreadyJoined.name || ''), 'info');
      renderSharingPane();
      return;
    }
  }

  // Try direct access first
  const group = await state.sharing.tryDirectJoin(folderId);
  if (group) {
    if (group._pendingJoin) {
      showJoinConfirmModal(group);
    } else {
      showToast(t('sharing.joined_group', group.name || ''), 'success');
      renderSharingPane();
    }
    return;
  }

  // Token invalid — envelope was supabase but verify failed
  if (gid) {
    showToast(t('sharing.join_token_used'), 'error');
    return;
  }

  // Drive flow
  if (!state.sharing.openJoinPicker) {
    showToast(t('sharing.join_failed'), 'error');
    return;
  }

  showJoinPickerModal(folderId);
}

function showJoinConfirmModal(group) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingJoinConfirmModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const ownerLine = group._creatorName
    ? `<p class="sharing-join-owner">${lucideIcon('user', 14)} ${t('sharing.join_confirm_owner', esc(group._creatorName))}</p>` : '';
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.join_confirm_title')}</h2>
    <p>${t('sharing.join_confirm_hint', esc(group.name || ''))}</p>
    ${ownerLine}
    <input type="text" id="joinDisplayName" class="sharing-input"
      placeholder="${t('sharing.join_confirm_name')}"
      value="${esc(group._suggestedName || '')}" />
    <div id="joinConfirmError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="document.getElementById('sharingJoinConfirmModal').remove()">${t('common.cancel')}</button>
      <button class="modal-save" id="joinConfirmBtn">${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  document.getElementById('joinConfirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('joinConfirmBtn');
    const errEl = document.getElementById('joinConfirmError');
    if (errEl) errEl.style.display = 'none';
    if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }
    try {
      const displayName = document.getElementById('joinDisplayName')?.value.trim() || '';
      await state.sharing.joinWithFileIds(null, { displayName });
      overlay.remove();
      showToast(t('sharing.joined_group', group.name || ''), 'success');
      renderSharingPane();
    } catch (e) {
      console.warn('join confirm failed:', e);
      if (errEl) { errEl.textContent = t('sharing.join_failed'); errEl.style.display = ''; }
      if (btn) { btn.disabled = false; btn.textContent = `${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}`; }
    }
  });
}

function showJoinPickerModal(folderId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingJoinModal';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.join_group')}</h2>
    <p>${t('sharing.join_picker_hint')}</p>
    <p class="sharing-join-file-list">${t('sharing.join_expected_files')}</p>
    <div id="sharingJoinError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" onclick="document.getElementById('sharingJoinModal').remove()">${t('common.cancel')}</button>
      <button class="modal-save" id="sharingJoinPickerBtn" onclick="sharingOpenJoinPicker('${escQ(folderId)}')">${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
}

function showJoinError(msg) {
  const el = document.getElementById('sharingJoinError');
  if (el) { el.textContent = msg; el.style.display = ''; }
}

async function sharingOpenJoinPicker(folderId) {
  const btn = document.getElementById('sharingJoinPickerBtn');
  const errEl = document.getElementById('sharingJoinError');
  if (errEl) errEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }

  try {
    const docs = await state.sharing.openJoinPicker(folderId);
    if (!docs) {
      // User cancelled — keep modal open, reset button
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}`; }
      return;
    }

    // Map Picker results to fileIds
    const fileIds = {};
    for (const d of docs) {
      const key = d.name.replace('.json', '');
      if (['group', 'todos', 'habits', 'lists'].includes(key) || /^extra_\d+$/.test(key)) {
        fileIds[key] = d.id;
      }
    }

    if (!fileIds.group) {
      // User may have selected the folder itself — try direct access now
      const folderDoc = docs.find(d => d.mimeType === 'application/vnd.google-apps.folder');
      if (folderDoc) {
        const group = await state.sharing.tryDirectJoin(folderDoc.id);
        if (group) {
          document.getElementById('sharingJoinModal')?.remove();
          showToast(t('sharing.joined_group', group.name || ''), 'success');
          renderSharingPane();
          return;
        }
      }
      showJoinError(t('sharing.join_no_files'));
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}`; }
      return;
    }

    // Check all required files are selected
    const required = ['group', 'todos', 'habits', 'lists'];
    const missing = required.filter(k => !fileIds[k]);
    if (missing.length > 0) {
      const names = missing.map(k => `${k}.json`).join(', ');
      showJoinError(t('sharing.join_missing_files', names));
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}`; }
      return;
    }

    const group = await state.sharing.joinWithFileIds(folderId, fileIds);
    document.getElementById('sharingJoinModal')?.remove();
    showToast(t('sharing.joined_group', group?.name || ''), 'success');
    renderSharingPane();
  } catch (e) {
    showJoinError(e.message || t('sharing.join_failed'));
    if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}`; }
  }
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
export function openSharePopover(anchorEl, onShare, opts = {}) {
  closeSharePopover();
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) return;

  const showAssignees = opts.showAssignees !== false;

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
      ${showAssignees ? `<div class="share-popover-section">
        <div class="share-popover-label">${t('sharing.assign_to')}</div>
        ${members.map(m => `
          <label class="share-popover-check">
            <input type="checkbox" value="${esc(m.email)}" checked>
            ${esc(m.email)}
          </label>
        `).join('')}
      </div>` : ''}
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
  popover.style.zIndex = '300';
  document.body.appendChild(popover);

  // Clamp horizontal position so the popover stays within the viewport
  const popW = popover.offsetWidth;
  const maxLeft = window.innerWidth - popW - 8;
  popover.style.left = `${Math.max(8, Math.min(rect.left - 120, maxLeft))}px`;

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

window.sharingCreateGroup = sharingCreateGroup;
window.sharingCreateGroupSubmit = sharingCreateGroupSubmit;
window.sharingInvite = sharingInvite;
window.sharingRemoveMember = sharingRemoveMember;
window.sharingLeaveGroup = sharingLeaveGroup;
window.sharingUnjoinGroup = sharingUnjoinGroup;
window.sharingDeleteGroup = sharingDeleteGroup;
window.sharingCopyLink = sharingCopyLink;
window.sharingCopyMemberLink = sharingCopyMemberLink;
window.sharingCopyLinkValue = sharingCopyLinkValue;
window.sharingOpenJoinPicker = sharingOpenJoinPicker;
window.submitSharePopover = submitSharePopover;
window.sharingCompleteSubmit = sharingCompleteSubmit;
