// ===================================================================
// SHARING UI — Settings pane, share popovers, completion modal
// ===================================================================
//
// Renders the sharing settings pane (groups, invite codes, trusted
// contacts) and provides helpers for share badges, share-to-group
// popovers, and multi-assignee completion modals used by
// todos.js, habits.js, lists.js.
//
// Requires state.sharing (Drive sharing module) to be initialized.
// All UI is hidden when state.sharing is null.
//
// HYBRID MODEL:
//   - Sharing is always available with Drive backend (no scope gate)
//   - Groups + invite codes work with drive.file scope
//   - Auto-discovery (trusted contacts) is optional (full drive scope)
//   - Join via invite code uses Google Picker for drive.file access
// ===================================================================

import state, { STAY_CONNECTED_KEY } from './state.js';
import { t } from './i18n.js';
import { esc, escQ, showToast, showConfirmAction, getSupabaseProjectRef, buildAuthSteps } from './utils.js';
import { lucideIcon } from './icons.js';
import { LOGOS } from './backend-logos.js';
import { decodeInviteEnvelope } from './sharing-envelope.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Generate a deterministic color from a stable member id. */
function memberColor(seed) {
  let hash = 0;
  seed = String(seed || 'member');
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hues = [210, 340, 150, 30, 270, 190, 50, 310, 80, 230];
  return `oklch(0.65 0.15 ${hues[Math.abs(hash) % hues.length]})`;
}

/** Initials from display name. */
function initials(name, fallback = '?') {
  if (name && name.includes(' ')) {
    const parts = name.split(/\s+/);
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (name) return name[0].toUpperCase();
  return String(fallback || '?')[0].toUpperCase();
}

function memberLabel(member) {
  return member?.displayName || member?.invitedLabel || member?.name || member?.memberId || 'Member';
}

/** Extract Supabase project ref from URL (shared logic with main.js) */
/** Small avatar circle HTML. */
function avatarDot(member, size = 24) {
  const label = memberLabel(member);
  const color = memberColor(member?.memberId || label);
  const ini = initials(label, member?.memberId);
  return `<span class="sharing-avatar" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.42)}px" title="${esc(label)}">${esc(ini)}</span>`;
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

  // Drive sharing is not yet ready — show "coming soon" placeholder
  if (activeMode === 'googledrive') {
    container.innerHTML = `<div class="auth-inline-prompt">
      <div class="auth-icon">${lucideIcon('clock', 28)}</div>
      <h4>${t('sharing.coming_soon')}</h4>
      <p class="auth-inline-hint">${t('sharing.coming_soon_hint')}</p>
    </div>`;
    return;
  }

  if (!state.sharing) {
    // Supabase without auth: show inline sign-in prompt (only if DB has auth tables)
    const dbReady = parseFloat(state.dbSchemaVersion || '0') >= 1.294;
    if (activeMode === 'supabase' && !state.authUser && dbReady) {
      const creds = (() => { try { return JSON.parse(localStorage.getItem(STAY_CONNECTED_KEY) || '{}'); } catch { return {}; } })();
      const projRef = getSupabaseProjectRef(creds.url || '') || null;
      const authConfigUrl = projRef ? `https://supabase.com/dashboard/project/${projRef}/auth/url-configuration` : 'https://supabase.com/dashboard/projects';
      const steps = buildAuthSteps('sharingAuth', authConfigUrl, { sendAction: 'send-auth-from-sharing', showStatus: true });
      container.innerHTML = `<div class="auth-inline-prompt">
        <div class="auth-icon">${lucideIcon('lock', 28)}</div>
        <h4>${t('auth.sign_in_to_share')}</h4>
        <p class="auth-inline-hint">${t('auth.sign_in_to_share_hint')}</p>
        ${steps.html}
      </div>`;
      steps.wireUp(container);
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
    </div>`;
  }

  // Get current user identity
  try {
    _currentUser = await state.sharing.getCurrentUser();
  } catch { _currentUser = null; }

  let html = authBadgeHtml;

  // ── Groups section ──
  const groups = state.sharing.getAllGroups();

  html += `<div class="setting-group"><div class="setting-group-label">${t('sharing.groups')}</div>`;

  if (groups.length === 0) {
    html += `<p class="setting-hint">${t('sharing.no_groups_hint')}</p>`;
  }

  for (const group of groups) {
    let currentMember = null;
    try { currentMember = await state.sharing.getCurrentMember(group.id); } catch { currentMember = null; }
    const isCreator = !!currentMember && currentMember.memberId === group.created_by;
    const isJoined = state.sharing.isJoinedViaLink(group.id);
    const memberCount = group.members?.length || 0;
    const itemCount = state.sharing.getItems(group.id).length;
    const memberStr = memberCount === 1 ? t('sharing.member') : t('sharing.members', memberCount);
    const itemStr = itemCount === 1 ? t('sharing.shared_item') : t('sharing.shared_items', itemCount);
    const inviteCode = isCreator ? state.sharing.getInviteLink(group.id) : null;
    const invitePlaceholder = group.backendType === 'supabase' ? t('sharing.invite_name_placeholder') : t('sharing.invite_placeholder');

    html += `<div class="sharing-group-card">
      <div class="sharing-group-header">
        <div class="sharing-group-info">
          <h4>${esc(group.name)}</h4>
          <span class="sharing-group-stats">${memberStr} \u00b7 ${itemStr}</span>
        </div>
        <div class="sharing-group-actions">
          ${group.folderId ? `<a class="sharing-action-btn sharing-drive-link" href="https://drive.google.com/drive/folders/${encodeURIComponent(group.folderId)}" target="_blank" rel="noopener" title="${t('sharing.open_drive_folder')}">${LOGOS.googledrive(14)} ${t('sharing.open_drive_folder')}</a>` : ''}
          ${inviteCode ? `<button class="sharing-action-btn sharing-copy-link-btn" data-action="sharing-copy-code" data-group-id="${esc(group.id)}" title="${t('sharing.copy_code')}">${lucideIcon('key', 14)} ${t('sharing.copy_code')}</button>` : ''}
          ${!isCreator ? (isJoined ? `<button class="sharing-action-btn sharing-leave-btn" data-action="sharing-unjoin-group" data-group-id="${esc(group.id)}" title="${t('sharing.leave')}">${lucideIcon('log-out', 14)} ${t('sharing.leave')}</button>` : `<button class="sharing-action-btn sharing-leave-btn" data-action="sharing-leave-group" data-group-id="${esc(group.id)}" title="${t('sharing.leave')}">${lucideIcon('log-out', 14)} ${t('sharing.leave')}</button>`) : ''}
        </div>
      </div>
      <div class="sharing-members">`;

    for (const member of (group.members || [])) {
      const isYou = !!currentMember && member.memberId === currentMember.memberId;
      const canRemove = isCreator && !isYou;
      const hasJoined = member.status === 'joined' || member.role === 'owner' || member.role === 'creator' || !!member.joinedAt || !!member.joined_at;
      const isCreatorMember = member.role === 'creator';
      const label = memberLabel(member);
      const statusHtml = isYou ? ` <span class="sharing-you">(${t('sharing.you')})</span>`
        : isCreatorMember ? ` <span class="sharing-member-creator">${lucideIcon('crown', 12)} ${t('sharing.creator')}</span>`
        : hasJoined ? ` <span class="sharing-member-joined">${lucideIcon('check', 12)}</span>`
        : ` <span class="sharing-member-pending">${t('sharing.pending')}</span>`;
      const canCopyCode = isCreator && !isYou && !hasJoined && member.token && state.sharing.getMemberInviteLink;
      html += `<div class="sharing-member">
          ${avatarDot(member, 22)}
          <span class="sharing-member-email">${esc(label)}${statusHtml}</span>
          ${isYou ? `<button class="sharing-action-btn sharing-action-btn-compact" data-action="sharing-edit-my-name" data-group-id="${esc(group.id)}" data-member-id="${esc(member.memberId)}" data-current-name="${esc(label)}" title="${t('sharing.edit_name')}" aria-label="${t('sharing.edit_name')}">${lucideIcon('pencil', 12)}</button>` : ''}
          ${canCopyCode ? `<button class="sharing-action-btn sharing-action-btn-compact" data-action="sharing-copy-member-code" data-group-id="${esc(group.id)}" data-token="${esc(member.token)}" title="${t('sharing.copy_code')}" aria-label="${t('sharing.copy_code')}">${lucideIcon('key', 12)}</button>` : ''}
          ${canRemove ? `<button class="sharing-remove-btn" data-action="sharing-remove-member" data-group-id="${esc(group.id)}" data-member-id="${esc(member.memberId)}" title="${t('sharing.remove_member')}">${lucideIcon('x', 12)}</button>` : ''}
        </div>`;
    }

    // Revoked members toggle (archive-toggle pattern)
    const revokedMembers = state.sharing?.getRevokedMembers?.(group.id) || [];
    if (isCreator && revokedMembers.length > 0) {
      const toggleId = `revoked-toggle-${group.id}`;
      const listId = `revoked-list-${group.id}`;
      html += `<div class="archive-toggle" data-action="toggle-revoked-members" data-group-id="${esc(group.id)}" id="${toggleId}">
          <span class="arrow" id="revoked-arrow-${esc(group.id)}">▶</span> ${t('sharing.removed')} (${revokedMembers.length})
        </div>
        <div class="archived-tasks" id="${listId}">`;
      for (const member of revokedMembers) {
        const label = memberLabel(member);
        html += `<div class="sharing-member sharing-member-revoked">
            ${avatarDot(member, 22)}
            <span class="sharing-member-email">${esc(label)} <span class="sharing-member-revoked-tag">${t('sharing.revoked')}</span></span>
          </div>`;
      }
      html += `</div>`;
    }

    html += `</div>
      ${isCreator ? `<div class="sharing-invite-row">
        <input type="text" class="sharing-invite-input" id="sharingInvite-${esc(group.id)}" placeholder="${invitePlaceholder}" data-action="sharing-invite-on-enter" data-group-id="${esc(group.id)}">
        <button class="sharing-invite-btn" data-action="sharing-invite" data-group-id="${esc(group.id)}">${lucideIcon('user-plus', 14)} ${t('sharing.invite')}</button>
      </div>` : ''}
      ${isCreator ? `<button class="sharing-delete-btn" data-action="sharing-delete-group" data-group-id="${esc(group.id)}">${lucideIcon('trash-2', 14)} ${t('sharing.delete_group')}</button>` : ''}
    </div>`;
  }

  html += `</div>
    <div class="sharing-bottom-actions">
      <button class="sharing-action-btn" data-action="sharing-create-group">${lucideIcon('plus', 14)} ${t('sharing.create_group')}</button>
      <button class="sharing-action-btn" data-action="sharing-open-join-code">${lucideIcon('log-in', 14)} ${t('sharing.join_group')}</button>
    </div>`;

  container.innerHTML = html;
}

// ── Actions (exposed on window) ─────────────────────────────────

async function sharingCreateGroup() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingCreateGroupModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.create_group')}</h2>
    <label>${t('sharing.group_name')}</label>
    <input type="text" id="sharingNewGroupName" placeholder="${t('sharing.group_name_placeholder')}" maxlength="60" data-action="sharing-create-group-on-enter">
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingCreateGroupModal">${t('common.cancel')}</button>
      <button class="modal-save" id="sharingCreateGroupBtn" data-action="sharing-create-group-submit">${t('common.create')}</button>
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

/** Show a modal with an invite code (after group creation or member invite). */
function showInviteCodeModal(name, code, isNewGroup) {
  const env = decodeInviteEnvelope(code);
  const isSingleUse = env?.b !== 'googledrive';
  const title = isNewGroup ? t('sharing.group_created') : t('sharing.member_added');
  const hint = isNewGroup
    ? t('sharing.invite_code_hint', name)
    : t('sharing.member_code_hint', name);
  const warn = `<p class="sharing-warning" style="margin-top:10px;font-size:0.82rem;color:var(--warn,#d97706);background:color-mix(in srgb,var(--warn,#d97706) 12%, transparent);border:1px solid color-mix(in srgb,var(--warn,#d97706) 30%, transparent);border-radius:8px;padding:8px 10px">${lucideIcon('shield-alert', 12)} ${t(isSingleUse ? 'sharing.invite_secret_warn' : 'sharing.invite_drive_warn')}</p>`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingInviteCodeModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('key', 20)} ${title}</h2>
    <p>${hint}</p>
    <div class="sharing-invite-link-box sharing-invite-code-box">
      <input id="sharingInviteCodeInput" class="sharing-code-input" type="text" readonly value="${escQ(code)}" data-action="select-all-on-click">
      <button class="sharing-invite-btn" data-action="sharing-copy-code-value">${lucideIcon('copy', 14)} ${t('sharing.copy')}</button>
    </div>
    ${warn}
    <div class="modal-actions">
      <button class="modal-save" data-action="close-modal" data-modal-id="sharingInviteCodeModal">${t('common.close')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  setTimeout(() => document.getElementById('sharingInviteCodeInput')?.select(), 50);
}

function sharingCopyCodeValue() {
  const input = document.getElementById('sharingInviteCodeInput');
  if (input) {
    navigator.clipboard.writeText(input.value).then(() => {
      showToast(t('common.copied'), 'success');
    });
  }
}

async function sharingCopyCode(groupId) {
  const code = state.sharing?.getInviteLink(groupId);
  if (code) {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('common.copied'), 'success');
    } catch {
      showInviteCodeModal('', code, true);
    }
  }
}

async function sharingCopyMemberCode(groupId, token) {
  const code = state.sharing?.getMemberInviteLink?.(groupId, token);
  if (code) {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('common.copied'), 'success');
    } catch {
      showInviteCodeModal('', code);
    }
  }
}

async function sharingInvite(groupId) {
  const input = document.getElementById(`sharingInvite-${groupId}`);
  const name = input?.value.trim();
  if (!name) return;
  const btn = input?.nextElementSibling;
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.setAttribute('aria-busy', 'true'); }
  try {
    const result = await state.sharing.inviteUser(groupId, name);
    input.value = '';
    const inviteCode = result?.inviteCode
      || (result?.token && state.sharing.getMemberInviteLink ? state.sharing.getMemberInviteLink(groupId, result.token, result.expiresAt) : null)
      || state.sharing.getInviteLink?.(groupId)
      || null;
    renderSharingPane();
    if (inviteCode) {
      showInviteCodeModal(name, inviteCode);
    } else {
      showToast(t('sharing.member_added'), 'success');
    }
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.removeAttribute('aria-busy'); }
  }
}

async function sharingRemoveMember(groupId, memberId) {
  const group = state.sharing?.getGroup?.(groupId);
  const member = (group?.members || []).find(m => m.memberId === memberId);
  const label = memberLabel(member);
  showConfirmAction(
    t('sharing.remove_member'),
    t('sharing.remove_member_confirm', label),
    async () => {
      try {
        await state.sharing.removeUser(groupId, memberId);
        showToast(t('sharing.member_removed'), 'info');
        renderSharingPane();
      } catch (e) { showToast(e.message, 'error'); }
    }
  );
}

async function sharingLeaveGroup(groupId) {
  showConfirmAction(
    t('sharing.leave'),
    t('sharing.leave_confirm'),
    async (keepCopies) => {
      try {
        if (keepCopies) {
          await _convertGroupItemsToPersonal(groupId);
        }
        await state.sharing.leaveGroup(groupId);
        showToast(t('sharing.left_group'), 'info');
        renderSharingPane();
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      } catch (e) { showToast(e.message, 'error'); }
    },
    null,
    { toggleLabel: t('sharing.leave_keep_copies') }
  );
}

async function sharingUnjoinGroup(groupId) {
  showConfirmAction(
    t('sharing.leave'),
    t('sharing.leave_confirm'),
    async (keepCopies) => {
      try {
        if (keepCopies) {
          await _convertGroupItemsToPersonal(groupId);
        }
        await state.sharing.unjoinGroup(groupId);
        showToast(t('sharing.left_group'), 'info');
        renderSharingPane();
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      } catch (e) { showToast(e.message, 'error'); }
    },
    null,
    { toggleLabel: t('sharing.leave_keep_copies') }
  );
}

async function sharingEditMyName(groupId, memberId, currentName) {
  // Replace the member row with an inline input
  const row = document.querySelector(`.sharing-member [data-action="sharing-edit-my-name"][data-group-id="${CSS.escape(groupId)}"][data-member-id="${CSS.escape(memberId)}"]`)?.closest('.sharing-member');
  if (!row) return;
  const nameSpan = row.querySelector('.sharing-member-email');
  if (!nameSpan || nameSpan.querySelector('.sharing-edit-name-input')) return;

  const prevHtml = nameSpan.innerHTML;
  nameSpan.innerHTML = `<input class="sharing-edit-name-input" type="text" value="${esc(currentName)}" maxlength="50" autocomplete="off">`;
  const input = nameSpan.querySelector('input');
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      nameSpan.innerHTML = prevHtml;
      return;
    }
    input.disabled = true;
    try {
      await state.sharing.updateMyDisplayName(groupId, newName);
      showToast(t('sharing.name_updated'), 'info');
      renderSharingPane();
    } catch (e) {
      showToast(e.message, 'error');
      nameSpan.innerHTML = prevHtml;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { nameSpan.innerHTML = prevHtml; }
  });
  input.addEventListener('blur', save);
}

// ── Group cleanup helpers ──────────────────────────────────────

/**
 * Convert all items belonging to a group into personal items.
 * Nulls shared_id and shared_group_id; moves items in __shared__ category to General.
 */
async function _convertGroupItemsToPersonal(groupId) {
  const nullShared = { shared_id: null, shared_group_id: null };

  // Build a lookup of shared-layer data so we can enrich pointers (which store
  // text/name as '' locally) before severing the shared link.
  const sharedLookup = new Map();
  if (state.sharing) {
    for (const si of state.sharing.getAllSharedItems()) {
      if (si.group_id === groupId) sharedLookup.set(si.id, si);
    }
  }

  // Build a separate lookup for habits via getAllSharedHabits() which normalizes
  // name/frequency_rule to top-level (Supabase keeps them inside payload) and
  // merges completions from child items + legacy payload.
  const sharedHabitLookup = new Map();
  if (state.sharing?.getAllSharedHabits) {
    for (const sh of state.sharing.getAllSharedHabits()) {
      if (sh.group_id === groupId) sharedHabitLookup.set(sh.id, sh);
    }
  }

  // ── Todos ──
  {
    const { data: cats } = await state.db.from('todo_categories').select('id, name, is_protected');
    const sharedCat = cats?.find(c => c.is_protected && c.name === '__shared__');
    const defaultCat = cats?.find(c => c.is_protected && c.name !== '__shared__');

    const { data: rows } = await state.db.from('todos').select('id, text, shared_id, category_id')
      .eq('shared_group_id', groupId);
    for (const row of (rows || [])) {
      const sh = row.shared_id ? sharedLookup.get(row.shared_id) : null;
      const enriched = {};
      if (sh) {
        enriched.text = sh.payload?.text || sh.payload?.title || row.text || '';
        if (sh.payload?.priority) enriched.priority = sh.payload.priority;
        if (sh.payload?.due_date) enriched.due_date = sh.payload.due_date;
      }
      // Move __shared__ category items to General
      if (sharedCat && defaultCat && row.category_id === sharedCat.id) {
        enriched.category = '';
        enriched.category_id = defaultCat.id;
      }
      await state.db.from('todos').update({ ...nullShared, ...enriched }).eq('id', row.id);
    }
  }

  // ── Habits ──
  {
    const { data: cats } = await state.db.from('habit_categories').select('id, name, is_protected');
    const sharedCat = cats?.find(c => c.is_protected && c.name === '__shared__');
    const defaultCat = cats?.find(c => c.is_protected && c.name !== '__shared__');

    const { data: rows } = await state.db.from('habits').select('id, name, shared_id, category_id, frequency_rule')
      .eq('shared_group_id', groupId);
    for (const row of (rows || [])) {
      const sh = row.shared_id ? sharedHabitLookup.get(row.shared_id) : null;
      const enriched = {};
      if (sh) {
        enriched.name = sh.name || sh.payload?.name || row.name || '';
        enriched.frequency_rule = sh.frequency_rule || sh.payload?.frequency_rule || row.frequency_rule || '';
      }
      if (sharedCat && defaultCat && row.category_id === sharedCat.id) {
        enriched.category = '';
        enriched.category_id = defaultCat.id;
      }
      await state.db.from('habits').update({ ...nullShared, ...enriched }).eq('id', row.id);

      // Restore completions from the shared layer — they were deleted locally
      // when the habit was originally shared.
      if (sh?.completions?.length && row.id) {
        for (const c of sh.completions) {
          await state.db.from('habit_completions').insert({
            habit_id: row.id,
            completed_at: c.completed_at,
            note: c.note || null,
          });
        }
      }
    }
  }

  // ── List items ──
  {
    const { data: rows } = await state.db.from('list_items').select('id, text, note, shared_id')
      .eq('shared_group_id', groupId);
    for (const row of (rows || [])) {
      const sh = row.shared_id ? sharedLookup.get(row.shared_id) : null;
      const enriched = {};
      if (sh) {
        enriched.text = sh.payload?.text || sh.payload?.title || row.text || '';
        if (sh.payload?.note != null) enriched.note = sh.payload.note;
      }
      await state.db.from('list_items').update({ ...nullShared, ...enriched }).eq('id', row.id);
    }
  }
}

/**
 * Delete all local items belonging to a group.
 */
async function _deleteGroupItems(groupId) {
  await state.db.from('todos').delete().eq('shared_group_id', groupId);
  await state.db.from('habits').delete().eq('shared_group_id', groupId);
  await state.db.from('list_items').delete().eq('shared_group_id', groupId);
}

async function sharingDeleteGroup(groupId) {
  const group = state.sharing.getGroup(groupId);
  // Count active members (excluding creator)
  const otherMembers = (group?.members || []).filter(m => m.status === 'joined' && m.role !== 'creator' && m.role !== 'owner');
  const detail = otherMembers.length > 0 ? t('sharing.delete_group_has_members').replace('{0}', otherMembers.length) : null;

  showConfirmAction(
    t('sharing.delete_group'),
    t('sharing.delete_group_confirm'),
    async (keepItems) => {
      try {
        if (keepItems) {
          await _convertGroupItemsToPersonal(groupId);
        } else {
          await _deleteGroupItems(groupId);
        }
        await state.sharing.deleteGroup(groupId);
        showToast(t('sharing.group_deleted'), 'info');
        renderSharingPane();
        // Refresh all pages to reflect changes
        document.dispatchEvent(new CustomEvent('sharing-changed'));
      } catch (e) { showToast(e.message, 'error'); }
    },
    detail,
    { toggleLabel: t('sharing.delete_group_keep_items') }
  );
}

// ── Join via invite code ───────────────────────────────────────

function showJoinCodeError(msg, errEl) {
  if (errEl) {
    errEl.textContent = msg;
    errEl.style.display = '';
  } else {
    showToast(msg, 'error');
  }
}

export async function handleJoinCode(rawCode, opts = {}) {
  const errEl = opts.errorEl || null;
  const code = String(rawCode || '').trim();
  const env = decodeInviteEnvelope(code);
  if (!env) {
    showJoinCodeError(t('sharing.join_code_invalid'), errEl);
    return false;
  }
  if (!state.sharing) {
    showJoinCodeError(t('sharing.join_unavailable'), errEl);
    return false;
  }

  const activeMode = localStorage.getItem('claw_cc_active_mode');
  if (env.b === 'supabase' && activeMode !== 'supabase') {
    showJoinCodeError(t('sharing.join_backend_supabase'), errEl);
    return false;
  }
  if (env.b === 'googledrive' && activeMode !== 'googledrive') {
    showJoinCodeError(t('sharing.join_backend_drive'), errEl);
    return false;
  }

  const connectionRef = env.b === 'googledrive' ? env.f : code;

  // Check if already joined via this folderId / invite code.
  const existing = state.sharing.getGroupByFolderId?.(connectionRef);
  if (existing) {
    showToast(t('sharing.already_joined', existing.name || ''), 'info');
    renderSharingPane();
    return true;
  }

  // For Supabase, also check local group cache by group id before verifying token.
  if (env.g) {
    const alreadyJoined = state.sharing.getAllGroups?.()?.find(g => g.id === env.g);
    if (alreadyJoined) {
      // Check if the invite URL differs from the stored remote — owner may have migrated
      if (env.u && state.sharing.reconnectGroup) {
        const { data: jgRow } = await state.db.from('joined_groups').select('remote_url').eq('group_id', env.g).limit(1);
        const storedUrl = jgRow?.[0]?.remote_url?.replace(/\/+$/, '');
        if (storedUrl && storedUrl !== env.u?.replace(/\/+$/, '')) {
          showReconnectConfirmModal(alreadyJoined, env);
          return true;
        }
      }
      showToast(t('sharing.already_joined', alreadyJoined.name || ''), 'info');
      renderSharingPane();
      return true;
    }
    // Group not loaded (remote unreachable?) but exists in joined_groups — check for reconnect
    if (env.u && state.sharing.reconnectGroup) {
      const { data: jgRow } = await state.db.from('joined_groups').select('remote_url,group_name').eq('group_id', env.g).limit(1);
      if (jgRow?.[0] && jgRow[0].remote_url?.replace(/\/+$/, '') !== env.u?.replace(/\/+$/, '')) {
        const stubGroup = { id: env.g, name: jgRow[0].group_name || env.g };
        showReconnectConfirmModal(stubGroup, env);
        return true;
      }
    }
  }

  const group = await state.sharing.tryDirectJoin(connectionRef);
  if (group) {
    if (group._pendingJoin) {
      showJoinConfirmModal(group);
    } else {
      showToast(t('sharing.joined_group', group.name || ''), 'success');
      renderSharingPane();
    }
    return true;
  }

  if (env.b === 'supabase') {
    showJoinCodeError(t('sharing.join_code_used'), errEl);
    return false;
  }

  if (!state.sharing.openJoinPicker) {
    showJoinCodeError(t('sharing.join_failed'), errEl);
    return false;
  }

  showJoinPickerModal(connectionRef);
  return true;
}

function sharingOpenJoinCodeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingJoinCodeModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('log-in', 20)} ${t('sharing.join_group')}</h2>
    <p>${t('sharing.join_code_hint')}</p>
    <label for="sharingJoinCodeInput">${t('sharing.invite_code_label')}</label>
    <textarea id="sharingJoinCodeInput" class="sharing-code-textarea" rows="4" placeholder="${t('sharing.invite_code_placeholder')}" data-action="sharing-join-code-on-enter"></textarea>
    <div id="sharingJoinCodeError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingJoinCodeModal">${t('common.cancel')}</button>
      <button class="modal-save" id="sharingJoinCodeBtn" data-action="sharing-join-code-submit">${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  setTimeout(() => document.getElementById('sharingJoinCodeInput')?.focus(), 50);
}

async function sharingJoinCodeSubmit() {
  const modal = document.getElementById('sharingJoinCodeModal');
  const input = document.getElementById('sharingJoinCodeInput');
  const errEl = document.getElementById('sharingJoinCodeError');
  const btn = document.getElementById('sharingJoinCodeBtn');
  const code = input?.value.trim() || '';
  if (errEl) errEl.style.display = 'none';
  if (!code) {
    showJoinCodeError(t('sharing.join_code_invalid'), errEl);
    return;
  }
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }
  try {
    const ok = await handleJoinCode(code, { errorEl: errEl });
    if (ok) modal?.remove();
  } catch (e) {
    console.warn('join code failed:', e);
    showJoinCodeError(e.message || t('sharing.join_failed'), errEl);
  } finally {
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.innerHTML = `${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}`;
    }
  }
}

function showJoinConfirmModal(group) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingJoinConfirmModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const ownerLine = group._creatorName
    ? `<p class="sharing-join-owner">${lucideIcon('user', 14)} ${t('sharing.join_confirm_owner', esc(group._creatorName))}</p>` : '';
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.join_confirm_title')}</h2>
    <p>${t('sharing.join_confirm_hint', esc(group.name || ''))}</p>
    ${ownerLine}
    <input type="text" id="joinDisplayName" class="sharing-invite-input"
      placeholder="${t('sharing.join_confirm_name')}"
      value="${esc(group._suggestedName || '')}" />
    <div id="joinConfirmError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingJoinConfirmModal">${t('common.cancel')}</button>
      <button class="modal-save" id="joinConfirmBtn">${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  document.getElementById('joinConfirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('joinConfirmBtn');
    const errEl = document.getElementById('joinConfirmError');
    if (errEl) errEl.style.display = 'none';
    if (btn?.disabled) return;
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
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('log-in', 16)} ${t('sharing.join_confirm_btn')}`; }
    }
  });
}

function showReconnectConfirmModal(group, env) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingReconnectModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('refresh-cw', 20)} ${t('sharing.reconnect_title')}</h2>
    <p>${t('sharing.reconnect_hint', esc(group.name || ''))}</p>
    <div id="reconnectError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingReconnectModal">${t('common.cancel')}</button>
      <button class="modal-save" id="reconnectConfirmBtn">${lucideIcon('refresh-cw', 16)} ${t('sharing.reconnect_btn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(overlay);
  document.getElementById('reconnectConfirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('reconnectConfirmBtn');
    const errEl = document.getElementById('reconnectError');
    if (errEl) errEl.style.display = 'none';
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }
    try {
      await state.sharing.reconnectGroup(env.g, env.u, env.k, env.t);
      overlay.remove();
      showToast(t('sharing.reconnected', group.name || ''), 'success');
      renderSharingPane();
    } catch (e) {
      console.warn('reconnect failed:', e);
      if (errEl) { errEl.textContent = e.message || t('sharing.reconnect_failed'); errEl.style.display = ''; }
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('refresh-cw', 16)} ${t('sharing.reconnect_btn')}`; }
    }
  });
}

function showJoinPickerModal(folderId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingJoinModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `<div class="modal">
    <h2>${lucideIcon('users', 20)} ${t('sharing.join_group')}</h2>
    <p>${t('sharing.join_picker_hint')}</p>
    <p class="sharing-join-file-list">${t('sharing.join_expected_files')}</p>
    <div id="sharingJoinError" class="sharing-join-error" style="display:none"></div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingJoinModal">${t('common.cancel')}</button>
      <button class="modal-save" id="sharingJoinPickerBtn" data-action="sharing-open-join-picker" data-folder-id="${esc(folderId)}">${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}</button>
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
      if (btn) { btn.disabled = false; btn.innerHTML = `${lucideIcon('folder-open', 16)} ${t('sharing.select_files')}`; }
      return;
    }

    const fileIds = {};
    for (const d of docs) {
      const key = d.name.replace('.json', '');
      if (['group', 'todos', 'habits', 'lists'].includes(key) || /^extra_\d+$/.test(key)) {
        fileIds[key] = d.id;
      }
    }

    if (!fileIds.group) {
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
export function sharedBadge(groupName, groupId) {
  return `<span class="shared-badge" ${groupId ? `data-group-id="${esc(groupId)}"` : ''}>${lucideIcon('users', 12)} ${esc(groupName)}</span>`;
}

// ── Shared-badge hover tooltip (1s delay, shows group members) ──

let _badgeHoverTimer = null;
let _badgeTooltip = null;

function removeBadgeTooltip() {
  if (_badgeHoverTimer) { clearTimeout(_badgeHoverTimer); _badgeHoverTimer = null; }
  if (_badgeTooltip) { _badgeTooltip.remove(); _badgeTooltip = null; }
}

function showBadgeTooltip(badge) {
  const groupId = badge.dataset.groupId;
  if (!groupId || !state.sharing) return;
  const group = state.sharing.getGroup(groupId);
  if (!group?.members?.length) return;

  removeBadgeTooltip();

  const tip = document.createElement('div');
  tip.className = 'shared-badge-tooltip';

  const activeMembers = group.members.filter(m => m.status !== 'revoked');
  tip.innerHTML = activeMembers.map(m => {
    const label = memberLabel(m);
    return `<div class="shared-badge-tooltip-row">${avatarDot(m, 20)}<span>${esc(label)}</span></div>`;
  }).join('');

  document.body.appendChild(tip);
  _badgeTooltip = tip;

  // Position relative to badge, flip if overflowing
  const br = badge.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;

  let top = br.bottom + 6;
  let left = br.left + (br.width / 2) - (tw / 2);

  // Flip above if overflows bottom
  if (top + th > window.innerHeight - 8) top = br.top - th - 6;
  // Clamp horizontal
  if (left < 8) left = 8;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - 8 - tw;

  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;

  // Dismiss on scroll or outside interaction
  const dismissOnScroll = () => removeBadgeTooltip();
  window.addEventListener('scroll', dismissOnScroll, { once: true, capture: true });

  tip.addEventListener('mouseleave', removeBadgeTooltip);
}

function initBadgeHover() {
  document.body.addEventListener('mouseenter', (e) => {
    const badge = e.target.closest?.('.shared-badge[data-group-id]');
    if (!badge) return;
    removeBadgeTooltip();
    _badgeHoverTimer = setTimeout(() => showBadgeTooltip(badge), 1000);
  }, true);

  document.body.addEventListener('mouseleave', (e) => {
    const badge = e.target.closest?.('.shared-badge[data-group-id]');
    if (!badge) return;
    // Cancel pending hover timer
    if (_badgeHoverTimer) { clearTimeout(_badgeHoverTimer); _badgeHoverTimer = null; }
    // Allow moving from badge into tooltip
    setTimeout(() => {
      if (_badgeTooltip && !_badgeTooltip.matches(':hover') && !badge.matches(':hover')) {
        removeBadgeTooltip();
      }
    }, 100);
  }, true);

  // Click: toggle tooltip immediately
  document.body.addEventListener('click', (e) => {
    const badge = e.target.closest?.('.shared-badge[data-group-id]');
    if (!badge) {
      if (_badgeTooltip && !e.target.closest('.shared-badge-tooltip')) removeBadgeTooltip();
      return;
    }
    if (_badgeHoverTimer) { clearTimeout(_badgeHoverTimer); _badgeHoverTimer = null; }
    if (_badgeTooltip) { removeBadgeTooltip(); } else { showBadgeTooltip(badge); }
  }, { passive: false });
}

// Init once on load
if (typeof document !== 'undefined') initBadgeHover();

/** Return inline HTML for assignee avatar dots. */
export function assigneeDots(assignees, maxShow = 3) {
  if (!assignees?.length) return '';
  let html = '<span class="assignee-dots">';
  const show = assignees.slice(0, maxShow);
  for (const a of show) {
    const member = typeof a === 'string' ? { memberId: a, displayName: a } : a;
    html += avatarDot(member, 18);
  }
  if (assignees.length > maxShow) {
    html += `<span class="assignee-overflow">+${assignees.length - maxShow}</span>`;
  }
  html += '</span>';
  return html;
}

// ── Share-to-group popover ──────────────────────────────────────

function positionSharePopover(popover, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const maxViewportHeight = Math.max(0, viewportH - margin * 2);

  popover.style.position = 'fixed';
  popover.style.zIndex = '300';
  popover.style.setProperty('--share-popover-max-height', `${maxViewportHeight}px`);

  const popW = popover.offsetWidth;
  const naturalH = Math.min(popover.scrollHeight, maxViewportHeight);
  const availableBelow = Math.max(0, viewportH - rect.bottom - gap - margin);
  const availableAbove = Math.max(0, rect.top - gap - margin);
  const openAbove = naturalH > availableBelow && availableAbove > availableBelow;
  const available = openAbove ? availableAbove : availableBelow;
  const maxH = Math.min(naturalH, Math.max(96, available), maxViewportHeight);

  popover.style.setProperty('--share-popover-max-height', `${maxH}px`);

  const preferredTop = openAbove ? rect.top - gap - maxH : rect.bottom + gap;
  const top = Math.max(margin, Math.min(preferredTop, viewportH - margin - maxH));
  const preferredLeft = rect.left + rect.width / 2 - popW / 2;
  const left = Math.max(margin, Math.min(preferredLeft, viewportW - margin - popW));

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

/** Open a share-to-group popover near the given button element. */
export function openSharePopover(anchorEl, onShare, opts = {}) {
  closeSharePopover();
  if (!state.sharing) return;
  const groups = state.sharing.getAllGroups();
  if (!groups.length) {
    // Show popover with a prompt to create a group
    const popover = document.createElement('div');
    popover.className = 'share-popover';
    popover.id = 'sharePopover';
    popover.style.visibility = 'hidden';
    popover.innerHTML = `
      <div class="share-popover-body">
        <div class="share-popover-section">
          <p class="share-popover-empty-hint">${t('sharing.no_groups_create_hint')}</p>
          <a class="share-popover-create-link" data-action="share-popover-open-sharing">${lucideIcon('settings', 14)} ${t('sharing.open_sharing_settings')}</a>
        </div>
      </div>
    `;
    document.body.appendChild(popover);
    positionSharePopover(popover, anchorEl);
    popover.style.visibility = '';
    setTimeout(() => {
      document.addEventListener('click', _closeSharePopoverOutside, true);
    }, 0);
    return;
  }

  const showAssignees = opts.showAssignees !== false;

  const popover = document.createElement('div');
  popover.className = 'share-popover';
  popover.id = 'sharePopover';
  popover.style.visibility = 'hidden';

  let selectedGroupId = groups[0].id;

  const renderPopover = () => {
    const selectedGroup = groups.find(g => g.id === selectedGroupId) || groups[0];
    const members = selectedGroup.members || [];

    popover.innerHTML = `
      <div class="share-popover-body">
        <div class="share-popover-section">
          <div class="share-popover-label">${t('sharing.share_to')}</div>
          <div class="share-popover-option-list share-popover-group-list">
            ${groups.map(g => `
              <label class="share-popover-radio">
                <input type="radio" name="shareGroup" value="${esc(g.id)}" ${g.id === selectedGroupId ? 'checked' : ''}>
                ${esc(g.name)}
              </label>
            `).join('')}
          </div>
        </div>
        ${showAssignees ? `<div class="share-popover-section">
          <div class="share-popover-label">${t('sharing.assign_to')}</div>
          <div class="share-popover-option-list share-popover-member-list">
            ${members.map(m => `
              <label class="share-popover-check">
                <input type="checkbox" value="${esc(m.memberId)}" checked>
                ${esc(memberLabel(m))}
              </label>
            `).join('')}
          </div>
        </div>` : ''}
      </div>
      <button class="share-popover-submit" data-action="submit-share-popover">${lucideIcon('share', 14)} ${t('sharing.share')}</button>
    `;

    popover.querySelectorAll('input[name="shareGroup"]').forEach(radio => {
      radio.addEventListener('change', () => {
        selectedGroupId = radio.value;
        renderPopover();
      });
    });

    if (popover.isConnected) positionSharePopover(popover, anchorEl);
  };

  renderPopover();

  document.body.appendChild(popover);
  positionSharePopover(popover, anchorEl);
  popover.style.visibility = '';

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
export async function showCompletionModal(groupId, itemId, assignees, currentMemberId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'sharingCompletionModal';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `<div class="modal sharing-completion-modal">
    <h2>${lucideIcon('circle-check', 20)} ${t('sharing.who_did_this')}</h2>
    <div class="sharing-completion-list">
      ${assignees.map(memberId => {
        const member = state.sharing?.getGroup?.(groupId)?.members?.find(m => m.memberId === memberId) || { memberId, displayName: memberId };
        return `
        <label class="share-popover-check">
          <input type="checkbox" value="${esc(memberId)}" ${memberId === currentMemberId ? 'checked' : ''}>
          ${esc(memberLabel(member))}
        </label>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-modal" data-modal-id="sharingCompletionModal">${t('common.cancel')}</button>
      <button class="modal-save" data-action="sharing-complete-submit" data-group-id="${esc(groupId)}" data-item-id="${esc(itemId)}">${t('common.done')}</button>
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


// ── Expose actions on window (CSP delegation handled in js/delegation.js) ──

function toggleRevokedMembers(groupId) {
  const container = document.getElementById(`revoked-list-${groupId}`);
  const arrow = document.getElementById(`revoked-arrow-${groupId}`);
  if (container) container.classList.toggle('visible');
  if (arrow) arrow.classList.toggle('open');
}

window.sharingCreateGroup = sharingCreateGroup;
window.sharingCreateGroupSubmit = sharingCreateGroupSubmit;
window.sharingInvite = sharingInvite;
window.sharingRemoveMember = sharingRemoveMember;
window.sharingLeaveGroup = sharingLeaveGroup;
window.sharingUnjoinGroup = sharingUnjoinGroup;
window.sharingEditMyName = sharingEditMyName;
window.sharingDeleteGroup = sharingDeleteGroup;
window.sharingCopyCode = sharingCopyCode;
window.sharingCopyMemberCode = sharingCopyMemberCode;
window.sharingCopyCodeValue = sharingCopyCodeValue;
window.sharingOpenJoinCodeModal = sharingOpenJoinCodeModal;
window.sharingJoinCodeSubmit = sharingJoinCodeSubmit;
window.sharingCopyLink = sharingCopyCode;
window.sharingCopyMemberLink = sharingCopyMemberCode;
window.sharingCopyLinkValue = sharingCopyCodeValue;
window.sharingOpenJoinPicker = sharingOpenJoinPicker;
window.toggleRevokedMembers = toggleRevokedMembers;
window.submitSharePopover = submitSharePopover;
window.sharePopoverOpenSharing = function() {
  closeSharePopover();
  if (typeof window.openSettings === 'function') window.openSettings('sharing');
  else location.hash = '#settings/sharing';
};
window.sharingCompleteSubmit = sharingCompleteSubmit;
