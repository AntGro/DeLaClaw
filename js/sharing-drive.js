// ===================================================================
// DRIVE SHARING ADAPTER — implements SharingInterface for Google Drive
// ===================================================================

import { deepEqual } from './utils.js';
import { driveFolderNames, currentHostname } from './drive-folders.js';
import { encodeInviteEnvelope } from './sharing-envelope.js';
import {
  createIntentState,
  markCreated,
  markDeleted,
  discardIntent,
  unionItems,
  reconcileItems,
  reconcileMembers,
  mergeMemberLists,
  captureIntents,
  acknowledgeIntents,
} from './sharing-file-reconcile.js';
import { t } from './i18n.js';
//
// See sharing-interface.js for the abstract contract this implements.
//
// HYBRID MODEL: two ways to join a shared group
//
//   1. LINK JOIN (drive.file scope — default, no scary permissions)
//      A creates group → A invites B by email (shares folder) →
//      A sends B invite code → B pastes code →
//      Google Picker opens → B selects the shared files →
//      Picker grants drive.file access → B saves the file IDs in the
//      groups table → done.
//
//   2. AUTO-DISCOVERY (full drive scope — opt-in via Settings)
//      A creates group → A invites B → B has A in trusted contacts →
//      B's app auto-discovers via sharedWithMe query → loads group.
//
// Both paths produce the same GroupEntry. A single group can have
// members using either path. Invite codes always work regardless of
// scope.
//
// Scenarios (A=Alice, B=Bob, C=Carol, D=Dave):
//
//   S1: A(file) creates group, invites B(file) via link
//       A creates folder+files (app owns → drive.file OK)
//       A shares folder with B (app owns → OK)
//       A copies invite code → sends to B
//       B pastes invite code → Picker → selects files → joined
//
//   S2: B leaves a joined group
//       B removes the groups-table row → polling stops
//       Drive permissions untouched (B still has user-level access
//       but DeLaClaw no longer loads it)
//
// Folder structure (inside the user's Google Drive).
// Production names shown; dev/preview builds use the DeLaClawDev* variants
// (see js/drive-folders.js):
//
//   My Drive/
//   ├── DeLaClaw/                          ← personal data (existing)
//   │   └── groups.json                    ← joined pointers + created-group names (a personal table)
//   └── DeLaClaw-Shared/                   ← shared root (one per user)
//       └── DeLaClaw-Shared-{groupId}/     ← per-group subfolder
//           ├── group.json                 ← metadata + member list
//           ├── todos.json                 ← shared todos
//           ├── habits.json                ← shared habits
//           └── lists.json                 ← shared list items
//
// Identity:
//   User email comes from the Drive About API (no extra OAuth scope needed).
//
// Scope:
//   drive.file — app-created files + Picker-granted access for joining.
//
// Trust model:
//   Link join: explicit user consent (clicking a link + using Picker).
//
// ===================================================================

// `DeLaClaw-Shared/` on production, `DeLaClawDev-Shared/` everywhere else
// (see js/drive-folders.js). Group subfolders always live under the shared root.
const { sharedRoot: SHARED_ROOT_NAME, groupPrefix: GROUP_PREFIX } =
  driveFolderNames(currentHostname());
const POLL_MS          = 15_000;      // 15s — faster than personal (30s)
const MAX_RETRIES      = 2;
const ITEM_TYPES       = ['todos', 'habits', 'lists'];
const EXTRA_COUNT      = 12;
const EXTRA_FILES      = Array.from({ length: EXTRA_COUNT }, (_, i) => `extra_${i + 1}`);
// The complete file set a group folder must contain. Joining is gated on ALL of
// these: the pending → 'joined' flip only happens when the joiner has access to
// every file, so a partial grant (e.g. group.json alone) can never half-join.
const REQUIRED_GROUP_FILES = ['group', ...ITEM_TYPES, ...EXTRA_FILES, 'revoked'];
// group.json is written LAST during createGroup: its presence marks creation as
// complete. The created row in the groups table is only written afterwards,
// so a row always points at a fully created group.

// ── Drive API helpers (self-contained, no drive.js dependency) ──

async function driveGet(token, url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Drive GET ${res.status}`), { code: res.status });
  return res;
}

async function driveAboutUser(token) {
  const res = await driveGet(token,
    'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName,photoLink)');
  const { user } = await res.json();
  return { email: user.emailAddress, name: user.displayName || '', photo: user.photoLink || '' };
}

async function driveFindFolder(token, name, parentId) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
  const { files } = await res.json();
  return files?.[0] ?? null;
}

async function driveCreateFolder(token, name, parentId) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw new Error(`Drive createFolder ${res.status}`);
  return res.json();
}

async function driveFindOrCreateFolder(token, name, parentId) {
  return await driveFindFolder(token, name, parentId) ?? await driveCreateFolder(token, name, parentId);
}

async function driveListChildren(token, folderId, mime) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (mime) q += ` and mimeType='${mime}'`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=200&orderBy=name`);
  const { files } = await res.json();
  return files || [];
}

/**
 * Find a file by name inside a folder.
 * Works for both owned and shared-with-me files.
 */
async function driveFindFile(token, folderId, fileName) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=1`);
  const { files } = await res.json();
  return files?.[0] ?? null;
}

async function driveDownload(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return { data: await res.json(), etag: res.headers.get('ETag') };
}

/**
 * Wrap a file-download failure with file context, preserving the Drive
 * status code so callers can distinguish access loss (403/404) from
 * transient failures.
 */
function downloadError(what, err) {
  const e = new Error(`sharing: failed to download ${what}: ${err?.message || err}`);
  if (err?.code != null) e.code = err.code;
  else if (err?.status != null) e.code = err.status;
  return e;
}

async function driveUpload(token, folderId, fileId, fileName, data, etag) {
  const json = JSON.stringify(data, null, 2);
  const boundary = '---dlc-sharing';
  const meta = { name: fileName, mimeType: 'application/json' };
  if (!fileId) meta.parents = [folderId];

  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `--${boundary}--`,
  ].join('\r\n');

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': `multipart/related; boundary=${boundary}`,
  };
  if (etag) headers['If-Match'] = etag;

  const res = await fetch(url, { method: fileId ? 'PATCH' : 'POST', headers, body });
  if (res.status === 412) throw Object.assign(new Error('ETag conflict'), { code: 412 });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);

  const result = await res.json();
  return { id: result.id, etag: res.headers.get('ETag'), modifiedTime: result.modifiedTime };
}

async function driveFileMeta(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`);
  return res.json();
}

/** Move a file or folder to Drive trash (recoverable for ~30 days). */
async function driveTrashFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive trash ${res.status}: ${await res.text()}`);
}

async function driveShareWithUser(token, fileId, email, role = 'writer') {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&fields=id,emailAddress,role,type`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email }),
    });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Share failed: ${res.status}`);
  }
  return res.json();
}

async function driveListPermissions(token, fileId) {
  const res = await driveGet(token,
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress,role,type)`);
  const { permissions } = await res.json();
  return permissions || [];
}

async function driveRemovePermission(token, fileId, permissionId) {
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permissionId}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
}

// ── Merge ───────────────────────────────────────────────────────
// Item merging lives in sharing-file-reconcile.js (backend-agnostic):
// unionItems for remote-vs-remote snapshots, reconcileItems for
// intent-aware local-vs-remote reconciliation.

function _itemsChangedDrive(oldArr, newArr) {
  if (oldArr.length !== newArr.length) return true;
  const oldById = new Map(oldArr.map(it => [it.id, it]));
  for (const n of newArr) {
    const o = oldById.get(n.id);
    if (!o) return true;
    if (!deepEqual(o, n)) return true;
  }
  return false;
}

// ── Migration: items.json → per-type files ──────────────────────

/**
 * If a legacy items.json exists, split its contents into per-type files
 * and trash items.json. Idempotent.
 */
async function migrateItemsJson(tok, folderId, entry) {
  const legacyFile = await driveFindFile(tok, folderId, 'items.json');
  if (!legacyFile) return;

  try {
    const { data } = await driveDownload(tok, legacyFile.id);
    const items = Array.isArray(data) ? data : [];

    if (items.length > 0) {
      for (const type of ITEM_TYPES) {
        const itemType = type === 'lists' ? 'list_item' : type.slice(0, -1);
        const typedItems = items.filter(i => i.item_type === itemType);
        if (typedItems.length > 0) {
          entry.typeData[type] = unionItems(entry.typeData[type] || [], typedItems);
        }
      }
      // Save migrated data to per-type files
      for (const type of ITEM_TYPES) {
        if (entry.typeData[type]?.length) {
          const fileName = `${type}.json`;
          const meta = entry.typeMeta[type] || {};
          if (!meta.fileId) {
            const existing = await driveFindFile(tok, folderId, fileName);
            if (existing) meta.fileId = existing.id;
          }
          const r = await driveUpload(tok, folderId, meta.fileId, fileName, entry.typeData[type]);
          entry.typeMeta[type] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
        }
      }
    }

    // Trash legacy file
    await driveTrashFile(tok, legacyFile.id);
    console.log(`sharing: migrated items.json → per-type files for folder ${folderId}`);
  } catch (err) {
    console.warn('sharing: items.json migration error:', err);
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Create a Drive sharing manager.
 *
 * @param {() => Promise<string>} getToken  — returns a valid Google access token
 * @param {string} appId  — Google Cloud project number (numeric prefix of client ID)
 * @returns {DriveSharingManager}
 */
/**
 * @param {() => Promise<string>} getToken
 * @param {string} personalFolderId
 * @param {Object} [capabilities]  — backend-specific hooks so the UI never
 *   reaches past state.sharing. Adapters supply their own
 *   implementations (or omit the ones that don't apply).
 * @param {(folderId: string) => Promise<Array|null>} [capabilities.openJoinPicker]
 * @param {Object} [db] — db proxy (js/db.js). Group rows live in the
 *   groups personal table; the adapter reads/writes them through db so
 *   persistence, ETag handling and cross-device polling come from the Drive
 *   adapter instead of bespoke file code.
 */
export function createDriveSharing(getToken, personalFolderId, capabilities = {}, db = null) {
  let _user   = null;            // { email, name, photo }
  let _rootId  = null;           // DeLaClaw-Shared folder id (own)
  const _groups = new Map();     // groupId → GroupEntry

  let _loaded = false;           // true after loadAll() completes
  let _pollTimer = null;
  let _listeners = [];

  // GroupEntry shape:
  // {
  //   folderId: string,
  //   group: { id, name, created_by, members, created_at },
  //   typeData: { todos: [], habits: [], lists: [] },
  //   typeMeta: { todos: { fileId, etag, modifiedTime }, ... },
  //   typeIntents: { todos: { createdIds, deletedIds }, ... }, // in-memory sync intents
  //   revokedMeta: { fileId, etag, modifiedTime }, // revoked.json (removed-member notices)
  //   gMeta: { fileId, etag, modifiedTime },
  //   joinedViaLink: boolean,   // true if joined via invite code
  // }

  // ── Groups table (joined + created) ──
  // Rows live in the groups personal table (the row id is the group id), seeded into
  // memory by the Drive adapter at connect. _groupRows is a read cache,
  // refreshed from the table after every mutation and at each poll.
  // Joined rows (kind 'joined') are pointers to another user's shared folder:
  //   { id, kind: 'joined', folderId, name, fileIds: { group, todos, habits, lists, extra_1..extra_12, revoked }, memberId, joinedAt, updated_at }
  // Created rows (kind 'created') record groups this user created: the group
  // itself is discovered by scanning Drive, the row only stores { id,
  // kind: 'created', name } so skipped/deleted notices can name it
  // even when its Drive folder is unreachable.
  let _groupRows = [];

  /** Rows for groups joined via invite code (kind !== 'created'). */
  const _joinedRows = () => _groupRows.filter(r => r.kind !== 'created');

  /** Name stored in the groups table for a groupId (joined pointer or created
   *  record), or null. Names groups whose Drive folder is unreachable. */
  const _storedGroupName = (groupId) =>
    _groupRows.find(r => r.id === groupId)?.name || null;

  // Groups whose load failed transiently in the current loadAll() run
  // (a required file failed to download, no removed/deleted verdict).
  // groupId → { name }. Rebuilt on every loadAll; the Sharing pane renders
  // them with a "skipped" chip. A group that loads fine never lands here.
  const _skippedGroups = new Map();

  // ── Internals ──

  function emit(event, detail) {
    for (const fn of _listeners) {
      try { fn(event, detail); } catch (e) { console.error('sharing listener error:', e); }
    }
  }

  async function token() { return getToken(); }

  async function ensureUser() {
    if (!_user) _user = await driveAboutUser(await token());
    return _user;
  }

  async function ensureRoot() {
    if (_rootId) return _rootId;
    const tok = await token();
    const folder = await driveFindOrCreateFolder(tok, SHARED_ROOT_NAME, null);
    _rootId = folder.id;
    return _rootId;
  }

  function fallbackDisplayName(value, fallback = 'Member') {
    const v = String(value || '').trim();
    if (!v) return fallback;
    return v.includes('@') ? v.split('@')[0] : v;
  }

  async function sha256Hex(str) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }

  /** Canonical form of an email for identity purposes. Always lowercases;
   *  for Gmail the local part is normalized too: Google ignores dots and
   *  +tags, and googlemail.com is an alias of gmail.com. Other providers
   *  treat dots as significant, so their local parts are left untouched —
   *  stripping dots globally could merge two distinct mailboxes into one ID. */
  function normalizeEmail(email) {
    const lower = String(email || '').trim().toLowerCase();
    const at = lower.lastIndexOf('@');
    if (at === -1) return lower;
    let local = lower.slice(0, at);
    let domain = lower.slice(at + 1);
    if (domain === 'googlemail.com') domain = 'gmail.com';
    if (domain === 'gmail.com') {
      const plus = local.indexOf('+');
      if (plus !== -1) local = local.slice(0, plus);
      local = local.replace(/\./g, '');
    }
    return `${local}@${domain}`;
  }

  /** Member ID — deterministic per user: 16 hex chars of SHA-256 of the
   *  normalized email. Stable across invites, so a removed-then-reinvited
   *  member keeps the same ID; removal entries in revoked.json are
   *  disambiguated by timestamp instead. The raw email is never persisted
   *  in group.json. */
  async function memberIdFromEmail(email) {
    return (await sha256Hex(normalizeEmail(email))).slice(0, 16);
  }

  async function currentMemberId(groupId) {
    const member = await getCurrentMemberInternal(groupId);
    return member?.memberId || null;
  }

  async function normalizeMember(member = {}) {
    const memberId = member.memberId || member.member_id || null;
    const joinedAt = member.joinedAt ?? member.joined_at ?? null;
    const role = member.role === 'owner' ? 'creator' : (member.role || 'member');
    const invitedLabel = member.invitedLabel ?? member.invited_label ?? null;
    const displayName = fallbackDisplayName(
      member.displayName || member.display_name || invitedLabel || memberId,
    );
    return {
      memberId,
      role,
      status: member.status || (joinedAt || role === 'creator' ? 'joined' : 'pending'),
      displayName,
      invitedLabel,
      joinedAt,
      // Kept so a 'left' marker written by unjoinGroup survives normalization
      // until the creator's poll revokes the Drive permission and clears it.
      leftAt: member.leftAt ?? member.left_at ?? null,
      drivePermissionId: member.drivePermissionId || member.permissionId || null,
    };
  }

  async function normalizeGroup(group, folderId = '') {
    const rawMembers = Array.isArray(group?.members) ? group.members : [];
    const members = [];
    for (const m of rawMembers) members.push(await normalizeMember(m));
    const createdBy = typeof group?.created_by === 'string'
      ? group.created_by
      : (group?.created_by?.memberId || members.find(m => m.role === 'creator' || m.role === 'owner')?.memberId || null);
    return {
      ...(group || {}),
      backendType: group?.backendType || 'googledrive',
      created_by: createdBy,
      members,
    };
  }

  async function normalizeEntry(entry) {
    if (!entry?.group) return entry;
    const rawGroup = entry.group;
    entry.group = await normalizeGroup(rawGroup, entry.folderId);
    const memberIds = new Set(entry.group.members.map(m => m.memberId));
    const normalizeMemberRef = ref => (ref && memberIds.has(ref) ? ref : null);
    for (const type of ITEM_TYPES) {
      entry.typeData[type] = (entry.typeData[type] || []).map(item => ({
        ...item,
        assignees: (item.assignees || []).map(normalizeMemberRef).filter(Boolean),
        done_by: (item.done_by || []).map(normalizeMemberRef).filter(Boolean),
        created_by: normalizeMemberRef(item.created_by) || entry.group.created_by || null,
      }));
    }
    // In-memory sync intents (createdIds/deletedIds) start empty on every
    // load: they only track mutations made by this tab since the load.
    // memberIntents covers the group.json roster; typeIntents covers item files.
    if (!entry.memberIntents) entry.memberIntents = createIntentState();
    if (!entry.typeIntents) entry.typeIntents = {};
    for (const type of ITEM_TYPES) {
      if (!entry.typeIntents[type]) entry.typeIntents[type] = createIntentState();
    }
    // revoked.json metadata: absent for groups created before phase 3.
    if (!entry.revokedMeta) entry.revokedMeta = {};
    return entry;
  }

  /** Intent state for one group entry + item file; created lazily. */
  function intentStateFor(entry, type) {
    if (!entry.typeIntents) entry.typeIntents = {};
    if (!entry.typeIntents[type]) entry.typeIntents[type] = createIntentState();
    return entry.typeIntents[type];
  }

  /** Intent state for one group entry's member roster; created lazily. */
  function memberIntentsFor(entry) {
    if (!entry.memberIntents) entry.memberIntents = createIntentState();
    return entry.memberIntents;
  }

  async function getCurrentMemberInternal(groupId) {
    const user = await ensureUser();
    const entry = _groups.get(groupId);
    if (!entry) return null;
    if (!entry.group?.members?.length) return null;
    if (!user?.email) return null;
    // Member IDs are deterministic per email, so the current user is found by
    // direct ID match — no email hash or hint fallbacks needed.
    const selfId = await memberIdFromEmail(user.email);
    return entry.group.members.find(m => m.memberId === selfId) || null;
  }

  /** Throw unless the current user is the group's creator. */
  async function assertCreator(groupId) {
    const e = _groups.get(groupId);
    if (!e) throw new Error(`Group ${groupId} not loaded`);
    const me = await getCurrentMemberInternal(groupId);
    if (!me || (me.role !== 'creator' && me.memberId !== e.group.created_by)) {
      throw new Error('Only the group creator can do this');
    }
  }

  /** Non-throwing creator check (for poll-time sweeps). */
  async function isCreatorOf(groupId) {
    const e = _groups.get(groupId);
    if (!e) return false;
    const me = await getCurrentMemberInternal(groupId);
    return !!me && (me.role === 'creator' || me.memberId === e.group.created_by);
  }

  // groupIds with a leave-revocation sweep currently in flight (poll re-entry guard).
  const _revokingLeft = new Set();

  /**
   * Creator-side sweep: members who left are kept as `status: 'left'` markers in
   * group.json (never displayed) until the creator's app revokes their Drive
   * permission — only the folder owner can do that — and clears the entry.
   */
  async function revokeLeftMembers(groupId, tok) {
    const e = _groups.get(groupId);
    if (!e || _revokingLeft.has(groupId)) return;
    const leftMembers = (e.group.members || []).filter(m => m.status === 'left');
    if (!leftMembers.length) return;
    _revokingLeft.add(groupId);
    try {
      for (const m of leftMembers) {
        if (m.role === 'creator' || m.role === 'owner') continue; // never revoke the owner
        const permissionId = m.drivePermissionId || (m.memberId || '').replace(/^drive-perm-/, '');
        if (permissionId) await driveRemovePermission(tok, e.folderId, permissionId).catch(() => {});
      }
      const leftIds = new Set(leftMembers.map(m => m.memberId));
      e.group.members = (e.group.members || []).filter(m => !leftIds.has(m.memberId));
      for (const id of leftIds) markDeleted(memberIntentsFor(e), id);
      await saveGroup(groupId);
      emit('group-changed', { groupId, group: e.group });
    } finally {
      _revokingLeft.delete(groupId);
    }
  }

  /**
   * Creator-side permission audit, run once per group load: list the folder's
   * Drive permissions and revoke any writer grant with no matching member row
   * in group.json. Such orphans are left by a failed invite write (grant
   * issued, row never persisted) or a failed revocation. Creator tabs only —
   * a member must never touch another owner's folder ACL. Best-effort: audit
   * failures are logged and never fail the load.
   */
  async function auditFolderPermissions(groupId, tok) {
    const e = _groups.get(groupId);
    if (!e) return;
    if (!(await isCreatorOf(groupId))) return;
    let perms;
    try {
      perms = await driveListPermissions(tok, e.folderId);
    } catch (err) {
      console.warn(`sharing: permission audit list failed for ${groupId}:`, err);
      return;
    }
    const memberIds = new Set((e.group.members || []).map(m => m.memberId));
    for (const p of perms || []) {
      if (p.type !== 'user' || p.role !== 'writer' || !p.emailAddress) continue;
      const id = await memberIdFromEmail(p.emailAddress).catch(() => null);
      if (!id || memberIds.has(id)) continue;
      try {
        await driveRemovePermission(tok, e.folderId, p.id);
      } catch (err) {
        console.warn(`sharing: permission audit revoke failed for ${p.emailAddress}:`, err);
      }
    }
  }

  function publicMember(member) {
    return {
      memberId: member.memberId,
      role: member.role,
      status: member.status,
      displayName: member.displayName,
      invitedLabel: member.invitedLabel,
      joinedAt: member.joinedAt,
    };
  }

  function publicGroup(entry) {
    if (!entry) return null;
    return {
      ...entry.group,
      members: (entry.group.members || []).map(publicMember),
      folderId: entry.folderId,
    };
  }

  /** Re-read group rows from the groups table. */
  async function refreshGroupRows() {
    if (!db) return; // no db wired (tests): keep the in-memory copy
    try {
      const { data } = await db.from('groups').select('*');
      _groupRows = Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('sharing: failed to load groups table:', err);
      _groupRows = [];
    }
  }

  /** Load a joined group using explicit file IDs (no search queries needed). */
  async function loadGroupWithIds(folderId, groupId, fileIds) {
    const tok = await token();

    // Download group.json + all type files in parallel. A failed download
    // aborts the whole group load — groups are never partially loaded (see
    // loadGroup). loadAll() isolates the failure per folder; the group is
    // retried on the next page load. revoked.json is NOT downloaded here:
    // its content is only evaluated at poll time (removed-vs-deleted), so
    // only the fileId is recorded.
    const downloads = [
      fileIds.group
        ? driveDownload(tok, fileIds.group).catch(err => { throw downloadError(`group.json for joined group ${groupId}`, err); })
        : Promise.resolve(null),
      ...ITEM_TYPES.map(type =>
        fileIds[type]
          ? driveDownload(tok, fileIds[type]).catch(err => { throw downloadError(`${type}.json for joined group ${groupId}`, err); })
          : Promise.resolve(null)
      ),
    ];
    const [gResult, ...typeResults] = await Promise.all(downloads);

    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};
    if (gResult) {
      group = gResult.data;
      gMeta = { fileId: fileIds.group, etag: gResult.etag };
    }

    const typeData = {};
    const typeMeta = {};
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const type = ITEM_TYPES[i];
      const r = typeResults[i];
      if (r) {
        typeData[type] = Array.isArray(r.data) ? r.data : [];
        typeMeta[type] = { fileId: fileIds[type], etag: r.etag };
      } else {
        // File absent (not failed — a failed download throws above).
        typeData[type] = [];
        typeMeta[type] = {};
      }
    }
    const revokedMeta = fileIds.revoked ? { fileId: fileIds.revoked } : {};

    const entry = await normalizeEntry({ folderId, group, typeData, typeMeta, gMeta, revokedMeta, joinedViaLink: true });
    _groups.set(groupId, entry);
    return entry;
  }

  /** Map item_type to the per-type file key. */
  function typeKey(itemType) {
    if (itemType === 'list_item') return 'lists';
    return itemType + 's';   // todo → todos, habit → habits
  }

  /** Load a single group from its Drive subfolder. */
  async function loadGroup(folderId, groupId, opts = {}) {
    // opts: { owned } — owned=true only for the user's own groups (kind
    // 'created' rows in the groups table). Joined groups reference someone
    // else's folder and must never be trashed here.
    const { owned = false } = opts;
    const tok = await token();

    // Find all core files in parallel. A throw here means the listing itself
    // failed ("couldn't look properly") — the caller isolates it per folder and
    // must NOT treat the group as incomplete.
    const [gFile, revokedFile, ...typeFiles] = await Promise.all([
      driveFindFile(tok, folderId, 'group.json'),
      driveFindFile(tok, folderId, 'revoked.json'),
      ...ITEM_TYPES.map(type => driveFindFile(tok, folderId, `${type}.json`)),
    ]);

    // The created row is only written after group.json lands, so its absence
    // on an owned folder means the folder's files were deleted on Drive
    // (or the folder was swapped): surface the skipped notice via a throw
    // instead of silently dropping the user's own group.
    if (!gFile && owned) {
      throw downloadError(`group.json for own group ${groupId}`, new Error('not found'));
    }

    // Download all found files in parallel. A failed download aborts the
    // whole group load — groups are never partially loaded (a half-loaded
    // group could show the user's items as missing, inviting recreates that
    // become duplicates once the real file loads). loadAll() isolates the
    // failure per folder; the group is retried on the next page load.
    const downloads = [];
    downloads.push(gFile
      ? driveDownload(tok, gFile.id).then(r => ({ ...r, file: gFile }))
      : Promise.resolve(null));
    downloads.push(revokedFile
      ? driveDownload(tok, revokedFile.id).then(r => ({ ...r, file: revokedFile }))
          .catch(err => { throw downloadError(`revoked.json for group ${groupId}`, err); })
      : Promise.resolve(null));
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const file = typeFiles[i];
      downloads.push(file
        ? driveDownload(tok, file.id).then(r => ({ ...r, file }))
            .catch(err => { throw downloadError(`${ITEM_TYPES[i]}.json for group ${groupId}`, err); })
        : Promise.resolve(null));
    }
    const [gResult, revokedResult, ...typeResults] = await Promise.all(downloads);

    let group = { id: groupId, name: groupId, created_by: null, members: [], created_at: null };
    let gMeta = {};
    if (gResult) {
      group = gResult.data;
      gMeta = { fileId: gFile.id, etag: gResult.etag, modifiedTime: gFile.modifiedTime };
    }

    const typeData = {};
    const typeMeta = {};
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      const type = ITEM_TYPES[i];
      const r = typeResults[i];
      if (r) {
        typeData[type] = Array.isArray(r.data) ? r.data : [];
        typeMeta[type] = { fileId: r.file.id, etag: r.etag, modifiedTime: r.file.modifiedTime };
      } else {
        // File absent (not failed — a failed download throws above).
        typeData[type] = [];
        typeMeta[type] = {};
      }
    }

    const revokedMeta = revokedResult
      ? { fileId: revokedFile.id, etag: revokedResult.etag, modifiedTime: revokedFile.modifiedTime }
      : {};

    const entry = await normalizeEntry({ folderId, group, typeData, typeMeta, gMeta, revokedMeta });
    _groups.set(groupId, entry);

    // Creator-only hygiene: reap folder writer grants with no member row
    // (orphans from failed invite writes or failed revocations). Best-effort,
    // never fails the load.
    if (owned) await auditFolderPermissions(groupId, tok);

    // Migrate legacy items.json if present
    await migrateItemsJson(tok, folderId, entry);

    return entry;
  }

  /** Persist group.json with ETag conflict handling. */
  async function saveGroup(groupId, retries = 0) {
    const e = _groups.get(groupId);
    if (!e) return;
    const tok = await token();

    // If we don't have a fileId for group.json, find it first
    if (!e.gMeta.fileId) {
      const gFile = await driveFindFile(tok, e.folderId, 'group.json');
      if (gFile) {
        const { data, etag } = await driveDownload(tok, gFile.id);
        const remoteGroup = await normalizeGroup(data || {}, groupId);
        e.gMeta = { fileId: gFile.id, etag, modifiedTime: gFile.modifiedTime };
        e.group.members = mergeMemberLists(e.group.members, remoteGroup.members || [], memberIntentsFor(e));
      }
    }

    // Capture exactly which roster intents this upload represents. Only a success
    // acknowledges them — and only the ones still current at that point, so a
    // member added/removed while this request is in flight stays pending.
    const memberIntents = memberIntentsFor(e);
    const capturedMemberIntents = captureIntents(memberIntents, e.group.members.map(m => ({ id: m.memberId })));

    try {
      const r = await driveUpload(tok, e.folderId, e.gMeta.fileId, 'group.json', e.group, e.gMeta.etag);
      e.gMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
      acknowledgeIntents(memberIntents, capturedMemberIntents);
    } catch (err) {
      if (err.code === 412 && retries < MAX_RETRIES) {
        const { data, etag } = await driveDownload(tok, e.gMeta.fileId);
        const remoteGroup = await normalizeGroup(data || {}, groupId);
        e.group.members = mergeMemberLists(e.group.members, remoteGroup.members || [], memberIntentsFor(e));
        e.gMeta.etag = etag;
        return saveGroup(groupId, retries + 1);
      }
      throw err;
    }
  }

  /** Persist a per-type items file with ETag conflict handling. */
  async function saveTypedItems(groupId, type, retries = 0) {
    const e = _groups.get(groupId);
    if (!e) return;
    const tok = await token();
    const fileName = `${type}.json`;
    const meta = e.typeMeta[type] || {};

    // If we don't have a fileId, search for existing file to avoid duplicates
    if (!meta.fileId) {
      const existing = await driveFindFile(tok, e.folderId, fileName);
      if (existing) {
        // Found existing file — download, reconcile (intent-aware), then update
        try {
          const { data, etag } = await driveDownload(tok, existing.id);
          const remoteItems = Array.isArray(data) ? data : [];
          e.typeData[type] = reconcileItems(e.typeData[type] || [], remoteItems, intentStateFor(e, type));
          meta.fileId = existing.id;
          meta.etag = etag;
        } catch (err) {
          meta.fileId = existing.id;
        }
        e.typeMeta[type] = meta;
      }
    }

    // Capture exactly which intents this upload represents. Only a success
    // acknowledges them — and only the ones still current at that point, so
    // an id created/deleted while this request is in flight stays pending.
    const intents = intentStateFor(e, type);
    const payload = e.typeData[type] || [];
    const captured = captureIntents(intents, payload);

    try {
      const r = await driveUpload(tok, e.folderId, meta.fileId, fileName, payload, meta.etag);
      e.typeMeta[type] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
      acknowledgeIntents(intents, captured);
    } catch (err) {
      if (err.code === 412 && retries < MAX_RETRIES) {
        const { data, etag } = await driveDownload(tok, e.typeMeta[type].fileId);
        e.typeData[type] = reconcileItems(e.typeData[type] || [], Array.isArray(data) ? data : [], intentStateFor(e, type));
        e.typeMeta[type].etag = etag;
        return saveTypedItems(groupId, type, retries + 1);
      }
      throw err;
    }
  }

  // ── Public interface ──

  const sharing = {
    // ─── Identity ───

    async getCurrentUser() {
      const user = await ensureUser();
      return { displayName: user.name || fallbackDisplayName(user.email), backendUserId: 'googledrive' };
    },

    async getCurrentMemberId(groupId) {
      return currentMemberId(groupId);
    },

    // ─── Groups ───

    /** Create a new shared group. Returns the group object. */
    /**
     * Create a group folder with group.json, item files and placeholder files.
     * onProgress (optional) receives { step, done, total } where step is one of
     * 'folder' | 'groupFile' | 'itemFiles'; itemFiles reports per-file progress.
     */
    async createGroup(name, onProgress) {
      const user = await ensureUser();
      const rootId = await ensureRoot();
      const tok = await token();
      const groupId = crypto.randomUUID().slice(0, 8);

      onProgress?.({ step: 'folder', done: 0, total: 0 });
      const subfolder = await driveCreateFolder(tok, `${GROUP_PREFIX}${groupId}`, rootId);
      try {
        const creatorMemberId = await memberIdFromEmail(user.email);
        const group = {
          id: groupId,
          name,
          backendType: 'googledrive',
          created_by: creatorMemberId,
          members: [
            {
              memberId: creatorMemberId,
              role: 'creator',
              status: 'joined',
              displayName: user.name || fallbackDisplayName(user.email),
              joinedAt: new Date().toISOString(),
            },
          ],
          created_at: new Date().toISOString(),
        };

        // Create empty per-type files + reserved extras + revoked.json in
        // parallel, reporting per-file progress as each upload resolves.
        // revoked.json starts empty: the creator appends {id, removed_at}
        // entries when removing members (phase 3).
        const allFiles = [
          ...ITEM_TYPES.map(type => ({ key: type, name: `${type}.json` })),
          ...EXTRA_FILES.map(name => ({ key: name, name: `${name}.json` })),
          { key: 'revoked', name: 'revoked.json' },
        ];
        const totalFiles = allFiles.length;
        let doneFiles = 0;
        const results = await Promise.all(
          allFiles.map(f => driveUpload(tok, subfolder.id, null, f.name, []).then(r => {
            doneFiles++;
            onProgress?.({ step: 'itemFiles', done: doneFiles, total: totalFiles });
            return r;
          }))
        );

        // group.json is written LAST: its presence marks the group as fully
        // created. A missing group.json at load time means a partial creation.
        onProgress?.({ step: 'groupFile', done: 0, total: 0 });
        const gRes = await driveUpload(tok, subfolder.id, null, 'group.json', group);

        const typeMeta = {};
        const typeData = {};
        let revokedMeta = {};
        for (let i = 0; i < allFiles.length; i++) {
          const { key } = allFiles[i];
          const r = results[i];
          if (ITEM_TYPES.includes(key)) {
            typeMeta[key] = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
            typeData[key] = [];
          } else if (key === 'revoked') {
            revokedMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
          }
          // Extra files are created on Drive but not tracked in memory (unused for now)
        }

        const typeIntents = {};
        for (const type of ITEM_TYPES) typeIntents[type] = createIntentState();

        const entry = {
          folderId: subfolder.id,
          group,
          typeData,
          typeMeta,
          typeIntents,
          revokedMeta,
          gMeta: { fileId: gRes.id, etag: gRes.etag, modifiedTime: gRes.modifiedTime },
        };
        // Record the created group in the groups table (kind 'created') BEFORE
        // it exists in memory or in the UX: loadAll discovers own groups from
        // these rows (each folder is found by its deterministic
        // DeLaClaw-Shared-{groupId} name). The row is written only after
        // group.json lands, so a row always points at a fully created group;
        // the stored name lets skipped/deleted notices name the group even
        // when its Drive folder is unreachable. A failed upsert throws: the
        // catch below trashes the folder (best effort) and nothing is ever
        // registered or emitted, so creation is all-or-nothing.
        const createdRow = {
          id: groupId, kind: 'created', name,
          createdAt: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        if (db) {
          const { error } = await db.from('groups').upsert(createdRow, { onConflict: 'id' });
          if (error) throw new Error(`Failed to record created group: ${error.message}`);
          await refreshGroupRows();
        } else {
          const ix = _groupRows.findIndex(r => r.id === groupId);
          if (ix >= 0) _groupRows[ix] = createdRow;
          else _groupRows.push(createdRow);
        }
        _groups.set(groupId, entry);

        emit('group-created', { group });
        return group;
      } catch (err) {
        // Best-effort cleanup: trash the partial folder so a failed creation
        // leaves no debris on Drive. A tab killed mid-creation (before this
        // runs) may leave a small orphan folder — accepted: no row is ever
        // written for it, so the app never sees it, and it holds at most a
        // few small JSON files.
        try { await driveTrashFile(tok, subfolder.id); }
        catch (cleanupErr) { console.warn('sharing: failed to trash partial group folder', subfolder.id, cleanupErr); }
        throw err;
      }
    },

    /** Load all groups: own + joined (link) + auto-discovered (if full Drive scope). */
    async loadAll() {
      const tok = await token();
      const promises = [];
      // Skipped marks are rebuilt every run: a group that loads fine this
      // time must not keep a stale chip from a previous failure.
      _skippedGroups.clear();
      // One bad folder must not take down every other group: isolate per-folder
      // load failures. A folder whose listing throws is skipped, never trashed.
      // A skipped group is recorded so the UI can show it with a chip instead
      // of silently dropping it; it is retried on the next page load. The
      // name stored in the groups table (if any) names the group directly.
      const isolate = (p, label, groupId, name) => promises.push(
        p.catch(err => {
          console.warn(`sharing: failed to load ${label}:`, err);
          if (groupId) _skippedGroups.set(groupId, { name: name || _storedGroupName(groupId) || groupId });
          return null;
        })
      );

      // Load the groups table (joined pointers + created records, seeded
      // into memory by the Drive adapter at connect)
      await refreshGroupRows();

      // Own groups: the groups table (kind 'created' rows) is the source of
      // truth — no DeLaClaw-Shared/ folder scan. Each folder is found by its
      // deterministic name DeLaClaw-Shared-{groupId} (one name search per
      // group). A missing folder (trashed or renamed on Drive) surfaces the
      // skipped chip with the stored name instead of silently dropping the
      // group; the row stays until the group is deleted.
      for (const row of _groupRows) {
        if (row.kind !== 'created') continue;
        const gid = row.id;
        if (!gid || _groups.has(gid)) continue;
        const name = row.name || _storedGroupName(gid) || gid;
        isolate(
          driveFindFolder(tok, GROUP_PREFIX + gid, null).then(folder => {
            if (!folder) {
              _skippedGroups.set(gid, { name });
              return null;
            }
            return loadGroup(folder.id, gid, { owned: true });
          }),
          `own group folder (${gid})`,
          gid,
          name
        );
      }

      // Joined groups (link-join): load using saved file IDs (or search for
      // legacy pointers). A 403/404 here means our access is gone (removed
      // from the group, or the group was deleted): consult revoked.json
      // immediately — the poll only covers loaded groups, so a skipped group
      // would otherwise never get its removed/deleted verdict.
      const loadJoined = (joined) => {
        const p = joined.fileIds
          ? loadGroupWithIds(joined.folderId, joined.id, joined.fileIds)
          : loadGroup(joined.folderId, joined.id); // pointer without fileIds: search-based load
        return p.catch(async err => {
          if (err?.code === 403 || err?.code === 404) {
            const verdict = await this.checkRemovalViaRevoked(joined.id, tok).catch(() => null);
            if (verdict) {
              await this.handleStaleGroup(joined.id, verdict);
              return null;
            }
          }
          throw err;
        });
      };
      for (const joined of _joinedRows()) {
        if (_groups.has(joined.id)) continue;
        isolate(loadJoined(joined), `joined group ${joined.id}`, joined.id, joined.name);
      }

      await Promise.all(promises);
      _loaded = true;
      return this.getAllGroups();
    },

    getAllGroups() {
      return Array.from(_groups.values()).map(e => publicGroup(e));
    },

    /** Groups whose load failed transiently in the last loadAll() run.
     *  [{ id, name }]. Rendered by the Sharing pane with a "skipped"
     *  chip; retried on the next page load. */
    getSkippedGroups() {
      return [..._skippedGroups.entries()].map(([id, s]) => ({ id, name: s.name }));
    },

    getGroup(groupId) {
      const e = _groups.get(groupId);
      return e ? publicGroup(e) : null;
    },

    getGroupName(groupId) {
      const e = _groups.get(groupId);
      return e?.group?.name || _storedGroupName(groupId) || '';
    },

    async getCurrentMember(groupId) {
      return getCurrentMemberInternal(groupId);
    },

    getAgentSafeGroup(groupId) {
      const e = _groups.get(groupId);
      return e ? publicGroup(e) : null;
    },

    async deleteGroup(groupId) {
      const e = _groups.get(groupId);
      if (!e) return;
      const user = await ensureUser();

      // Only the creator can delete
      const currentMember = await getCurrentMemberInternal(groupId);
      if (!currentMember || currentMember.memberId !== e.group.created_by) {
        throw new Error('Only the group creator can delete it');
      }

      const tok = await token();

      // Revoke Drive permissions for all non-owner members before trashing
      try {
        const perms = await driveListPermissions(tok, e.folderId);
        for (const perm of perms) {
          // Keep owner permission, revoke everyone else
          if (perm.role === 'owner') continue;
          try { await driveRemovePermission(tok, e.folderId, perm.id); }
          catch (err) { console.warn('sharing: failed to revoke permission for', perm.emailAddress, err); }
        }
      } catch (err) { console.warn('sharing: could not list permissions before delete:', err); }

      // Trash the entire subfolder (recoverable on Drive)
      await driveTrashFile(tok, e.folderId);
      _groups.delete(groupId);
      // Drop the created-group row from the groups table
      if (db) {
        const { error } = await db.from('groups').delete().eq('id', groupId);
        if (error) console.warn('sharing: failed to remove created-group row:', error.message);
        else await refreshGroupRows();
      } else {
        _groupRows = _groupRows.filter(r => r.id !== groupId);
      }
      emit('group-deleted', { groupId });
    },

    // ─── Membership ───

    /** Invite a user. Creator-only. Drive uses the email only for the permission grant;
     *  group.json stores an opaque member id + email hash + label, never the raw email. */
    async inviteUser(groupId, inviteTarget) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      await assertCreator(groupId);
      const tok = await token();
      const email = String(inviteTarget || '').trim();
      if (!email) throw new Error('Invite target required');

      // Member IDs are stable per email: the same person always maps to the same
      // ID. Refuse to invite someone who is already a joined or pending member —
      // checked against the in-memory roster before any Drive call, so a repeated
      // click can neither demote a joined member nor mint a duplicate invite.
      // The raw email is never persisted in group.json.
      const memberId = await memberIdFromEmail(email);
      const existing = e.group.members.find(m => m.memberId === memberId);
      if (existing && existing.role !== 'creator') {
        if (existing.status === 'joined') throw new Error(t('sharing.already_member', email));
        if (existing.status === 'pending') throw new Error(t('sharing.already_invited', email));
      }

      // Grant Drive editor access on the subfolder. The email is permission material only.
      const perm = await driveShareWithUser(tok, e.folderId, email, 'writer');
      // Grant reader access on revoked.json specifically: if this member is
      // later removed, the folder grant is revoked but this file-level grant
      // survives, so their client can read the removal notice.
      if (e.revokedMeta?.fileId) {
        await driveShareWithUser(tok, e.revokedMeta.fileId, email, 'reader')
          .catch(err => console.warn('sharing: failed to grant revoked.json reader', err));
      }
      // Snapshot the roster mutation so a failed group.json write can roll it
      // back: the invite is then exactly as if it never happened, and
      // retrying passes the duplicate-invite guard. (The Drive grant already
      // issued is left alone — the load-time permission audit reaps it if the
      // invite is never retried.)
      let undoRosterChange = null;
      if (existing && existing.role === 'creator') {
        // Inviting the creator's own address: nothing to change.
      } else if (existing) {
        // Re-invite (e.g. after a 'left' marker or a prior removal): reset to
        // a fresh pending invite on the same stable ID.
        const prev = { ...existing };
        existing.role = 'member';
        existing.status = 'pending';
        existing.leftAt = null;
        existing.joinedAt = null;
        existing.displayName = null;
        existing.invitedLabel = fallbackDisplayName(email);
        existing.drivePermissionId = perm.id;
        markCreated(memberIntentsFor(e), memberId);
        undoRosterChange = () => { Object.assign(existing, prev); };
      } else {
        e.group.members.push({
          memberId,
          role: 'member',
          status: 'pending',
          displayName: null,
          invitedLabel: fallbackDisplayName(email),
          joinedAt: null,
          drivePermissionId: perm.id,
        });
        markCreated(memberIntentsFor(e), memberId);
        undoRosterChange = () => {
          e.group.members = e.group.members.filter(m => m.memberId !== memberId);
        };
      }
      try {
        await saveGroup(groupId);
      } catch (err) {
        undoRosterChange?.();
        discardIntent(memberIntentsFor(e), memberId);
        throw err;
      }

      emit('member-invited', { groupId, memberId });
      return { memberId };
    },

    /** Remove a member from a group. Creator-only. Records the removal in
     *  revoked.json, revokes Drive access, updates group.json. */
    async removeUser(groupId, memberId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      await assertCreator(groupId);
      const tok = await token();
      const member = e.group.members.find(m => m.memberId === memberId);
      if (!member) throw new Error('Member not found');
      if (member.role === 'creator') throw new Error('Cannot remove the creator');

      // 1. Record the removal in revoked.json FIRST — the member must be able
      // to read it after their folder access is revoked. Aborts the removal
      // if this write fails, so no one is ever removed without a notice.
      if (e.revokedMeta?.fileId) {
        const { data, etag } = await driveDownload(tok, e.revokedMeta.fileId);
        const removed = Array.isArray(data) ? data : [];
        if (!removed.some(r => r.id === memberId)) {
          removed.push({ id: memberId, removed_at: new Date().toISOString() });
        }
        const r = await driveUpload(tok, e.folderId, e.revokedMeta.fileId, 'revoked.json', removed, etag);
        e.revokedMeta = { fileId: r.id, etag: r.etag, modifiedTime: r.modifiedTime };
      }

      // 2. Revoke folder access. The file-level reader grant on revoked.json
      // (given at invite time) survives, so the member can read the notice.
      const permissionId = member.drivePermissionId || (member.memberId || '').replace(/^drive-perm-/, '');
      if (permissionId) await driveRemovePermission(tok, e.folderId, permissionId).catch(() => {});

      e.group.members = e.group.members.filter(m => m.memberId !== memberId);
      markDeleted(memberIntentsFor(e), memberId);
      await saveGroup(groupId);
      emit('member-removed', { groupId, memberId });
    },

    /** Update your own display name (pseudo) in a group. */
    async updateMyDisplayName(groupId, newName) {
      const e = _groups.get(groupId);
      if (!e) return;
      const currentMember = await getCurrentMemberInternal(groupId);
      if (!currentMember) return;
      const m = e.group.members.find(m => m.memberId === currentMember.memberId);
      if (m) m.displayName = newName;
      await saveGroup(groupId);
      emit('group-changed', { groupId, group: e.group });
    },

    // ─── Items ───

    async addItem(groupId, { id: presetId, item_type, payload, assignees = [] }) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      const memberId = await currentMemberId(groupId);
      if (!memberId) throw new Error('Current group member not found');
      const item = {
        id: presetId || crypto.randomUUID(),
        item_type,             // 'todo' | 'habit' | 'list_item'
        payload,               // mirrors the fields of the native type
        assignees,             // memberIds
        done: false,
        done_by: [],
        done_at: null,
        created_by: memberId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const key = typeKey(item_type);
      if (!e.typeData[key]) e.typeData[key] = [];
      e.typeData[key].push(item);
      markCreated(intentStateFor(e, key), item.id);
      await saveTypedItems(groupId, key);
      emit('item-added', { groupId, item });
      return item;
    },

    async updateItem(groupId, itemId, changes) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      // Find item across all type files
      let item = null;
      let key = null;
      for (const type of ITEM_TYPES) {
        item = (e.typeData[type] || []).find(i => i.id === itemId);
        if (item) { key = type; break; }
      }
      if (!item) throw new Error(`Item ${itemId} not found`);

      Object.assign(item, changes, { updated_at: new Date().toISOString() });
      await saveTypedItems(groupId, key);
      emit('item-updated', { groupId, item });
      return item;
    },

    async deleteItem(groupId, itemId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);

      for (const type of ITEM_TYPES) {
        const idx = (e.typeData[type] || []).findIndex(i => i.id === itemId);
        if (idx >= 0) {
          e.typeData[type].splice(idx, 1);
          markDeleted(intentStateFor(e, type), itemId);
          await saveTypedItems(groupId, type);
          break;
        }
      }
      emit('item-deleted', { groupId, itemId });
    },

    /**
     * Complete a shared item.
     * @param {string[]} doneBy — emails of who did it; defaults to current user
     */
    async completeItem(groupId, itemId, doneBy) {
      const normalizedDoneBy = (Array.isArray(doneBy) ? doneBy : [doneBy]).filter(Boolean);
      if (!normalizedDoneBy.length) {
        const memberId = await currentMemberId(groupId);
        if (memberId) normalizedDoneBy.push(memberId);
      }
      return this.updateItem(groupId, itemId, {
        done: true,
        done_by: normalizedDoneBy,
        done_at: new Date().toISOString(),
      });
    },

    async uncompleteItem(groupId, itemId) {
      return this.updateItem(groupId, itemId, { done: false, done_by: [], done_at: null });
    },

    // ─── Shared Habits (new format) ───

    /**
     * Add a shared habit to a group's habits.json.
     * Uses the new format: { id, item_type:'habit', name, frequency_rule,
     * creator_category, created_by, completions:[] }
     */
    async addSharedHabit(groupId, habitData) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      if (!e.typeData.habits) e.typeData.habits = [];
      e.typeData.habits.push(habitData);
      markCreated(intentStateFor(e, 'habits'), habitData.id);
      await saveTypedItems(groupId, 'habits');
      emit('item-added', { groupId, item: habitData });
      return habitData;
    },

    /**
     * Update a shared habit in a group's habits.json.
     * Merges `changes` into the habit with matching id.
     */
    async updateSharedHabit(groupId, sharedId, changes) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const item = items.find(h => h.id === sharedId);
      if (!item) throw new Error(`Shared habit ${sharedId} not found`);
      Object.assign(item, changes, { updated_at: new Date().toISOString() });
      await saveTypedItems(groupId, 'habits');
      emit('item-updated', { groupId, item });
      return item;
    },

    /**
     * Delete a shared habit from a group's habits.json.
     */
    async deleteSharedHabit(groupId, sharedId) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const idx = items.findIndex(h => h.id === sharedId);
      if (idx >= 0) {
        items.splice(idx, 1);
        markDeleted(intentStateFor(e, 'habits'), sharedId);
        await saveTypedItems(groupId, 'habits');
      }
      emit('item-deleted', { groupId, itemId: sharedId });
    },

    /**
     * Add a completion to a shared habit on Drive.
     */
    async addSharedHabitCompletion(groupId, sharedId, completion) {
      const e = _groups.get(groupId);
      if (!e) throw new Error(`Group ${groupId} not loaded`);
      const items = e.typeData.habits || [];
      const item = items.find(h => h.id === sharedId);
      if (!item) throw new Error(`Shared habit ${sharedId} not found`);
      if (!item.completions) item.completions = [];
      item.completions.push(completion);
      item.updated_at = new Date().toISOString();
      await saveTypedItems(groupId, 'habits');
      emit('item-updated', { groupId, item });
      return item;
    },

    /**
     * Get all shared habits across all groups (new format).
     * Returns items with group_id / group_name annotated.
     */
    getAllSharedHabits() {
      const out = [];
      for (const e of _groups.values()) {
        for (const item of (e.typeData.habits || [])) {
          if (item.item_type === 'habit' && item.completions !== undefined) {
            out.push({ ...item, group_id: e.group.id, group_name: e.group.name });
          }
        }
      }
      return out;
    },

    getAllSharedTodos() {
      return this.getAllSharedItems('todo');
    },

    getAllSharedListItems() {
      return this.getAllSharedItems('list_item');
    },

    /** Get items for one group, optionally filtered by type. */
    getItems(groupId, itemType) {
      const e = _groups.get(groupId);
      if (!e) return [];
      if (itemType) {
        const key = typeKey(itemType);
        return [...(e.typeData[key] || [])];
      }
      const out = [];
      for (const type of ITEM_TYPES) out.push(...(e.typeData[type] || []));
      return out;
    },

    /** Get all shared items across all groups, annotated with group_id / group_name. */
    getAllSharedItems(itemType) {
      const out = [];
      for (const e of _groups.values()) {
        const types = itemType ? [typeKey(itemType)] : ITEM_TYPES;
        for (const type of types) {
          for (const item of (e.typeData[type] || [])) {
            out.push({ ...item, group_id: e.group.id, group_name: e.group.name });
          }
        }
      }
      return out;
    },

    // ─── Polling ───

    startPolling() {
      if (_pollTimer) return;
      _pollTimer = setInterval(() => this.poll().catch(e => console.warn('sharing poll:', e)), POLL_MS);
    },

    stopPolling() {
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    },

    /** Force-save all groups and their items to Drive. */
    async forceSave() {
      for (const [groupId, e] of _groups) {
        if (e.joinedViaLink) continue; // can't write to someone else's group.json as non-owner
        await saveGroup(groupId);
        for (const type of ITEM_TYPES) {
          if (e.typeData[type]?.length) await saveTypedItems(groupId, type);
        }
      }
    },

    /**
     * Consult revoked.json after the group files became unreachable (403/404).
     * Detection is based only on this file — no consecutive-failure counting.
     * Returns 'removed' | 'deleted' | null (transient: leave for the next poll).
     */
    async checkRemovalViaRevoked(groupId, tok) {
      const joined = _joinedRows().find(j => j.id === groupId);
      const revokedFileId = joined?.fileIds?.revoked;
      const selfId = joined?.memberId;
      // No revocation state (e.g. joined before phase 3): nothing to consult.
      if (!revokedFileId || !selfId) return 'deleted';
      let data;
      try {
        ({ data } = await driveDownload(tok, revokedFileId));
      } catch (err) {
        if (err?.code === 404 || err?.status === 404) return 'deleted'; // revoked.json gone too → group deleted
        return null; // transient failure: try again next poll
      }
      const removed = Array.isArray(data) ? data : [];
      // Member IDs are stable per email, so a removed-then-reinvited member keeps
      // the same ID: only a removal recorded after the current join counts.
      // Missing timestamps fall back to the old ID-match behavior (conservative).
      const joinedAt = joined?.joinedAt || null;
      const wasRemoved = removed.some(r =>
        r.id === selfId && (!joinedAt || !r.removed_at || r.removed_at > joinedAt));
      return wasRemoved ? 'removed' : 'deleted';
    },

    async poll() {
      const tok = await token();
      let changed = false;
      const staleGroupIds = [];  // groups to remove after iteration

      // Our own member ID, so the poll never announces our own join back to us.
      const me = await ensureUser().catch(() => null);
      const selfMemberId = me?.email ? await memberIdFromEmail(me.email).catch(() => null) : null;

      // Re-read group rows: the Drive adapter's table poll may have picked
      // up a join/unjoin/group-creation from another device since the last cycle.
      await refreshGroupRows();

      for (const [groupId, e] of _groups) {
        // Poll per-type files
        for (const type of ITEM_TYPES) {
          const meta = e.typeMeta[type];
          if (!meta?.fileId) {
            // For joined groups without a file ID, skip (can't discover by search under drive.file)
            if (e.joinedViaLink) continue;
            // Check if file was created by another user since last poll
            try {
              const file = await driveFindFile(tok, e.folderId, `${type}.json`);
              if (file) {
                const { data, etag } = await driveDownload(tok, file.id);
                e.typeData[type] = reconcileItems(e.typeData[type] || [], Array.isArray(data) ? data : [], intentStateFor(e, type));
                e.typeMeta[type] = { fileId: file.id, etag, modifiedTime: file.modifiedTime };
                changed = true;
              }
            } catch (err) { console.warn(`sharing poll discover ${type} ${groupId}:`, err); }
            continue;
          }
          try {
            const fileMeta = await driveFileMeta(tok, meta.fileId);
            if (fileMeta.modifiedTime > (meta.modifiedTime || '')) {
              const { data, etag } = await driveDownload(tok, meta.fileId);
              const remote = Array.isArray(data) ? data : [];
              if (_itemsChangedDrive(e.typeData[type] || [], remote)) {
                e.typeData[type] = reconcileItems(e.typeData[type] || [], remote, intentStateFor(e, type));
                e.typeMeta[type].etag = etag;
                e.typeMeta[type].modifiedTime = fileMeta.modifiedTime;
                changed = true;
                emit('items-changed', { groupId, type, items: e.typeData[type] });
              }
            }
          } catch (err) { console.warn(`sharing poll ${type} ${groupId}:`, err); }
        }

        // Poll group.json (membership changes)
        if (e.gMeta.fileId) {
          try {
            const meta = await driveFileMeta(tok, e.gMeta.fileId);
            if (meta.modifiedTime > (e.gMeta.modifiedTime || '')) {
              const { data, etag } = await driveDownload(tok, e.gMeta.fileId);
              const normalizedGroup = data ? await normalizeGroup(data, groupId) : null;
              if (normalizedGroup && !deepEqual(normalizedGroup, e.group)) {
                // Members who just joined (pending → joined since our last
                // view): announce them so the UX can toast. Diffed before the
                // local state is overwritten; our own member ID is excluded.
                const wasJoined = new Set((e.group.members || [])
                  .filter(m => m.status === 'joined').map(m => m.memberId));
                const freshJoins = (normalizedGroup.members || []).filter(m =>
                  m.status === 'joined' && m.memberId && !wasJoined.has(m.memberId) && m.memberId !== selfMemberId);
                // Intent-aware roster: rows this tab created but hasn't
                // flushed yet survive the overwrite, so a poll landing
                // mid-upload can't drop them; everything else takes the
                // remote version.
                const members = reconcileMembers(
                  e.group.members || [], normalizedGroup.members || [], memberIntentsFor(e));
                Object.assign(e.group, normalizedGroup);
                e.group.members = members;
                e.gMeta.etag = etag;
                e.gMeta.modifiedTime = meta.modifiedTime;
                changed = true;
                emit('group-changed', { groupId, group: e.group });
                for (const m of freshJoins) emit('member-joined', { groupId, group: e.group, member: m });
              }
            }
          } catch (err) {
            // Group files unreachable (deleted folder or revoked access):
            // consult revoked.json — the only signal. 'removed' → we were
            // kicked; 'deleted' → the group is gone; null → transient.
            if (err?.code === 404 || err?.status === 404 || err?.code === 403 || err?.status === 403) {
              const verdict = await this.checkRemovalViaRevoked(groupId, tok).catch(() => null);
              if (verdict) staleGroupIds.push({ groupId, verdict });
            } else {
              console.warn(`sharing poll group ${groupId}:`, err);
            }
          }
        }

        // Creator-side: process 'left' markers — revoke those members' Drive
        // access (only the folder owner can) and clear the entries.
        try {
          if (await isCreatorOf(groupId)) await revokeLeftMembers(groupId, tok);
        } catch (err) { console.warn(`sharing poll revoke-left ${groupId}:`, err); }
      }

      // Clean up groups whose files are gone (group deleted, or we were removed)
      if (staleGroupIds.length) {
        for (const { groupId: gid, verdict } of staleGroupIds) {
          await this.handleStaleGroup(gid, verdict);
        }
        changed = true;
      }

      return changed;
    },

    /**
     * Apply a removed/deleted verdict for a group: drop it from memory,
     * notify the app, and purge the groups-table row. Shared by the poll
     * and by loadAll — a joined group that fails to load with 403/404 never
     * reaches the poll, so it gets its verdict at startup instead.
     */
    async handleStaleGroup(groupId, verdict) {
      const row = _groupRows.find(r => r.id === groupId);
      // Live group data first, then the name stored in the groups table
      // row (survives an unreachable folder).
      const groupName = _groups.get(groupId)?.group?.name || row?.name || groupId;
      // Capture the folder ID before purging: the 'deleted' notice links to
      // the Drive folder so the user can double-check it is really gone.
      const folderId = row?.folderId || _groups.get(groupId)?.folderId || null;
      _groups.delete(groupId);
      _skippedGroups.delete(groupId); // a verdict beats a transient skip mark
      emit('group-deleted', { groupId, verdict });
      if (verdict === 'removed') {
        // Own memberId found in revoked.json — removal is certain, so purge
        // local item pointers outright (no dialog). The 'deleted' case keeps
        // the orphan dialog: an unreachable group may be an infra issue.
        // Handled in main.js via state.db (the adapter has no db access).
        try { document.dispatchEvent(new CustomEvent('sharing-group-purge-items', { detail: { groupId } })); } catch {}
      }
      try { document.dispatchEvent(new CustomEvent('sharing-group-removed-remotely', { detail: { groupName, verdict, folderId } })); } catch {}
      // Purge the groups-table row
      if (db) {
        const { error } = await db.from('groups').delete().eq('id', groupId);
        if (error) console.warn('sharing: purge groups-row delete failed:', error.message);
        await refreshGroupRows();
      } else {
        _groupRows = _groupRows.filter(r => r.id !== groupId);
      }
    },

    // ─── Events ───

    /** Register a listener. Returns an unsubscribe function. */
    onUpdate(fn) {
      _listeners.push(fn);
      return () => { _listeners = _listeners.filter(f => f !== fn); };
    },

    // ─── Link join ───

    /** Try to join a shared group by direct folder access (needs full Drive scope).
     *  Returns the group object on success, null if scope is insufficient. */
    async tryDirectJoin(folderId) {
      const tok = await token();
      try {
        const children = await driveListChildren(tok, folderId);
        if (children.length === 0) return null;
        const fileIds = {};
        for (const f of children) {
          const key = f.name.replace('.json', '');
          if (REQUIRED_GROUP_FILES.includes(key)) fileIds[key] = f.id;
        }
        if (!fileIds.group) return null;
        // NOTE: `return await` is load-bearing here — a bare `return` of the
        // promise would let a joinWithFileIds rejection escape this try/catch
        // (the try block completes holding the promise; adoption happens
        // outside it). Awaiting surfaces the rejection inside the try so the
        // Picker fallback below actually works.
        return await this.joinWithFileIds(folderId, fileIds);
      } catch {
        return null; // permission denied or incomplete grant → needs Picker
      }
    },

    /** Join a shared group using explicit file IDs (from Picker or direct access).
     *  Requires a matching pending invite (by email hash) — Drive access alone is not enough.
     *  @param {string} folderId — the shared subfolder ID
     *  @param {Object} fileIds — Drive file IDs keyed by every getRequiredGroupFiles() entry (group, todos, habits, lists, the 12 extra_* placeholders, revoked)
     *  @param {Object} [opts] — { displayName } pseudo chosen by the joiner */
    async joinWithFileIds(folderId, fileIds, opts = {}) {
      // Gate the join on the full file set: flipping to 'joined' with only a
      // partial grant (e.g. group.json alone) would leave item sync broken with
      // no recovery except leave + rejoin. The direct-join path's try/catch
      // turns this into a graceful fallback to the Picker.
      const missing = REQUIRED_GROUP_FILES.filter(k => !fileIds?.[k]);
      if (missing.length > 0) {
        throw new Error(
          `Cannot join group: missing files: ${missing.map(k => `${k}.json`).join(', ')}`
        );
      }
      const tok = await token();
      const user = await ensureUser();

      // Read group.json to get groupId
      let groupId, groupData;
      if (fileIds.group) {
        const { data } = await driveDownload(tok, fileIds.group);
        groupData = data;
        groupId = data?.id;
      }
      if (!groupId) throw new Error('Could not read group metadata');

      // Already loaded?
      if (_groups.has(groupId)) {
        emit('group-joined', { groupId, group: _groups.get(groupId).group });
        return _groups.get(groupId).group;
      }

      // Load group data using explicit file IDs
      await loadGroupWithIds(folderId, groupId, fileIds);

      // Pending-invite gate: only a member with a matching pending invite may join.
      // Member IDs are deterministic per email, so the joiner matches their own row directly.
      const e = _groups.get(groupId);
      let joinedMemberId = null;
      if (e) {
        const selfId = await memberIdFromEmail(user.email);
        const member = e.group.members.find(m => m.status === 'pending' && m.memberId === selfId);
        if (!member) throw new Error('No pending invite for this account');
        member.status = 'joined';
        member.joinedAt = new Date().toISOString();
        const pseudo = String(opts?.displayName || '').trim();
        member.displayName = pseudo || user.name || fallbackDisplayName(user.email);
        joinedMemberId = member.memberId;
        markCreated(memberIntentsFor(e), member.memberId);
        await saveGroup(groupId);
      }

      // Persist the pointer in the groups table (memberId lets the
      // client match its own revoked.json entry if this account is later
      // removed from the group). The row id is the group id: the Drive adapter's
      // 412 merge is keyed on id with newer updated_at winning, which preserves
      // the old union-by-folderId conflict behavior across devices.
      const now = new Date().toISOString();
      // name is stored in the pointer so the deleted/skipped notices can name
      // the group even when its Drive folder is unreachable (no group.json).
      const entry = { id: groupId, kind: 'joined', folderId, name: groupData?.name || null, fileIds, memberId: joinedMemberId, joinedAt: now, updated_at: now };
      if (db) {
        const { error } = await db.from('groups').upsert(entry, { onConflict: 'id' });
        if (error) throw new Error(`join: failed to persist joined group: ${error.message}`);
        await refreshGroupRows();
      } else {
        const existing = _groupRows.findIndex(j => j.folderId === folderId || j.id === groupId);
        if (existing >= 0) _groupRows[existing] = entry;
        else _groupRows.push(entry);
      }

      const group = _groups.get(groupId)?.group;
      emit('group-joined', { groupId, group });
      this.startPolling();
      return group;
    },

    /** Leave a joined group (removes the groups-table row + group.json). */
    // reconnectGroup is Supabase-only (remote URL migration); no-op for Drive
    async reconnectGroup() { return null; },

    async unjoinGroup(groupId) {
      // Mark self as 'left' in remote group.json (best-effort). The entry is kept
      // — not deleted — so the creator's next poll can revoke this member's Drive
      // permission (only the folder owner can revoke it) before clearing the entry.
      const e = _groups.get(groupId);
      if (e) {
        try {
          const currentMember = await getCurrentMemberInternal(groupId);
          const self = currentMember && (e.group.members || []).find(m => m.memberId === currentMember.memberId);
          if (self) {
            self.status = 'left';
            self.leftAt = new Date().toISOString();
            await saveGroup(groupId);
          }
        } catch (err) { console.warn('sharing: unjoin group.json update failed (non-fatal):', err); }
      }
      if (db) {
        const { error } = await db.from('groups').delete().eq('id', groupId);
        if (error) console.warn('sharing: unjoin groups-row delete failed:', error.message);
        await refreshGroupRows();
      } else {
        _groupRows = _groupRows.filter(r => r.id !== groupId);
      }
      _groups.delete(groupId);
      emit('group-left', { groupId });
    },

    /** Get the invite code for a group. */
    getInviteLink(groupId) {
      const e = _groups.get(groupId);
      if (!e) return null;
      return encodeInviteEnvelope({ v: 1, b: 'googledrive', f: e.folderId });
    },

    /** Member invite code (Drive: same as getInviteLink, token unused). */
    getMemberInviteLink(groupId, _token) {
      return this.getInviteLink(groupId);
    },

    /** Find a group by its Drive folder ID (for duplicate join detection). */
    getGroupByFolderId(folderId) {
      for (const [, e] of _groups) {
        if (e.folderId === folderId) return e.group;
      }
      return null;
    },

    /** Check if a group was joined via invite code. */
    isJoinedViaLink(groupId) {
      return _groups.get(groupId)?.joinedViaLink === true;
    },

    /** Removed members of a group, from revoked.json: [{ memberId, status: 'revoked', removedAt }]. */
    async getRevokedMembers(groupId) {
      const e = _groups.get(groupId);
      const fileId = e?.revokedMeta?.fileId;
      if (!fileId) return [];
      const tok = await token();
      const { data } = await driveDownload(tok, fileId).catch(() => ({ data: [] }));
      return (Array.isArray(data) ? data : []).map(r => ({
        memberId: r.id,
        status: 'revoked',
        removedAt: r.removed_at || null,
      }));
    },

    // ─── Backend capabilities (injected, backend-agnostic) ───

    /** Open a backend-specific file picker for join-via-link.
     *  Returns array of selected docs or null if cancelled.
     *  Null/undefined when the backend has no picker concept. */
    openJoinPicker: capabilities.openJoinPicker ?? null,

    /** File keys a join must include (group + item files + placeholders).
     *  The pending → 'joined' flip is gated on this full set. */
    getRequiredGroupFiles() { return [...REQUIRED_GROUP_FILES]; },

    isReady() { return _loaded; },

    // ─── Lifecycle ───

    destroy() {
      this.stopPolling();
      _groups.clear();
      _groupRows = [];
      _user = null;
      _rootId = null;
      _listeners = [];
    },

    /** Number of loaded groups (for testing / debugging). */
    get groupCount() { return _groups.size; },
  };

  return sharing;
}
