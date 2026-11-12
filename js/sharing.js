// ===================================================================
// SHARING FACTORY — selects the right sharing adapter by backend type
// ===================================================================
//
// Entry point for all sharing initialization. Consumers call
// createSharing(backendType, ...) and get back an object validated
// against the canonical SharingInterface (sharing-interface.js).
//
// Any missing or mistyped method is a hard error at init time,
// not a silent runtime crash.
//
// Currently supported:
//   - 'googledrive' → sharing-drive.js (createDriveSharing)
//   - 'demo'        → read-only stub (UI visible, group creation gated)
//   - 'cache'       → read-only sharing from the offline-cache snapshot
//                     (Drive auth lost; groups/items resolve, mutations
//                     reject — see createCachedSharing)
//
// ===================================================================

import { SHARING_INTERFACE, validateSharingAdapter } from './sharing-interface.js';
import { encodeInviteEnvelope } from './sharing-envelope.js';
import { makeReadOnlyError } from './adapters/offline-cache.js';

// ── Demo stub ─────────────────────────────────────────────────────
// Satisfies the full SharingInterface so state.sharing is truthy and
// share buttons render, but every mutation is a no-op.  Group queries
// return empty → the share popover shows "no groups, go to Settings"
// where the demo-specific message lives.
function createDemoSharingStub() {
  const noop = () => {};
  const asyncNoop = async () => {};
  const stub = {};
  for (const [key, kind] of Object.entries(SHARING_INTERFACE)) {
    if (kind === 'fn') {
      // Query methods that return arrays → return []
      // Query methods that return a single value → return null
      // Mutation / lifecycle methods → no-op
      const isArrayQuery = [
        'getAllGroups', 'getItems', 'getAllSharedItems',
        'getAllSharedHabits', 'getAllSharedTodos', 'getAllSharedListItems',
      ].includes(key);
      const isSyncQuery = ['getGroup', 'getGroupByFolderId', 'getInviteLink',
        'isJoinedViaLink', 'getCurrentMember', 'getAgentSafeGroup'].includes(key);
      if (key === 'loadAll') stub[key] = async () => [];
      else if (isArrayQuery) stub[key] = () => [];
      else if (isSyncQuery) stub[key] = () => null;
      else if (key === 'getCurrentUser') stub[key] = () => ({ id: 'demo', displayName: 'Demo' });
      else if (key === 'getCurrentMemberId') stub[key] = async () => 'demo';
      else if (key === 'isJoinedViaLink') stub[key] = () => false;
      else if (key === 'poll') stub[key] = async () => false;
      else stub[key] = asyncNoop;
    } else {
      stub[key] = null;
    }
  }
  // Sync lifecycle helpers
  stub.startPolling = noop;
  stub.stopPolling = noop;
  stub.onUpdate = noop;
  stub.destroy = noop;
  stub.forceSave = asyncNoop;
  return stub;
}

// ── Cached (read-only) sharing ────────────────────────────────
// Built from the snapshot blob main.js mirrors into the offline cache
// whenever the live Drive sharing adapter loads or syncs. Blob shape:
// { v, groups, itemsByGroup: { [groupId]: { todos, habits, lists } },
//   currentUser, currentMemberIds: { [groupId]: memberId } } — groups
// are the Drive adapter's public groups and the item arrays are its
// per-group file contents, so reads match the live adapter's shapes.
// Every mutation rejects with the shared read-only error; no polling.
const SHARING_TYPE_KEY = { todo: 'todos', habit: 'habits', list_item: 'lists', event: 'events' };

function createCachedSharing(blob) {
  const groups = Array.isArray(blob?.groups) ? blob.groups : [];
  const itemsByGroup = blob?.itemsByGroup || {};
  const memberIds = blob?.currentMemberIds || {};
  const stub = createDemoSharingStub();

  const fileItems = (groupId, key) => itemsByGroup[groupId]?.[key] || [];
  const allItems = (key) => {
    const out = [];
    for (const g of groups) {
      for (const k of (key ? [key] : ['todos', 'habits', 'lists'])) {
        for (const item of fileItems(g.id, k)) out.push({ ...item, group_id: g.id, group_name: g.name });
      }
    }
    return out;
  };

  stub.loadAll = async () => groups;
  stub.getAllGroups = () => groups;
  stub.getGroup = (groupId) => groups.find(g => g.id === groupId) || null;
  stub.getAgentSafeGroup = stub.getGroup;
  stub.getGroupByFolderId = (folderId) => groups.find(g => g.folderId === folderId);
  stub.getItems = (groupId, itemType) => {
    if (itemType) return [...fileItems(groupId, SHARING_TYPE_KEY[itemType])];
    const out = [];
    for (const k of ['todos', 'habits', 'lists']) out.push(...fileItems(groupId, k));
    return out;
  };
  stub.getAllSharedItems = (itemType) => allItems(itemType ? SHARING_TYPE_KEY[itemType] : null);
  stub.getAllSharedTodos = () => allItems('todos');
  stub.getAllSharedListItems = () => allItems('lists');
  stub.getAllSharedEvents = () => allItems('events');
  stub.getAllSharedHabits = () => allItems('habits').filter(i => i.item_type === 'habit' && i.completions !== undefined);
  stub.getCurrentUser = () => blob?.currentUser || { display_name: 'Member', backendUserId: 'googledrive' };
  stub.getCurrentMemberId = async (groupId) => memberIds[groupId] || null;
  stub.getCurrentMember = (groupId) => {
    const g = groups.find(g => g.id === groupId);
    return g?.members?.find(m => m.member_id === memberIds[groupId]) || null;
  };
  stub.getInviteLink = (groupId) => {
    const g = groups.find(g => g.id === groupId);
    return g?.folderId ? encodeInviteEnvelope({ v: 1, b: 'googledrive', f: g.folderId }) : null;
  };
  stub.getMemberInviteLink = stub.getInviteLink;
  stub.getRequiredGroupFiles = () => [];
  stub.mapDocsToFileIds = () => ({});
  stub.hasPendingCreate = () => false;
  stub.poll = async () => false;

  const rejectReadOnly = async () => { throw makeReadOnlyError(); };
  for (const key of [
    'createGroup', 'deleteGroup', 'renameGroup', 'deleteOwnedGroups', 'leaveJoinedGroups',
    'inviteUser', 'removeUser', 'unjoinGroup', 'tryDirectJoin', 'joinWithFileIds', 'reconnectGroup',
    'addItem', 'updateItem', 'deleteItem', 'completeItem', 'uncompleteItem',
    'addSharedHabit', 'updateSharedHabit', 'deleteSharedHabit', 'addSharedHabitCompletion',
  ]) stub[key] = rejectReadOnly;
  return stub;
}

/**
 * Create a sharing adapter for the given backend type.
 *
 * @param {'googledrive'|'demo'|'cache'} backendType
 * @param {Object} config — backend-specific configuration
 * @returns {Promise<SharingAdapter>}
 */
export async function createSharing(backendType, config = {}) {
  let adapter;

  switch (backendType) {
    case 'googledrive': {
      const { createDriveSharing } = await import('./sharing-drive.js');
      adapter = createDriveSharing(
        config.getToken,
        config.personalFolderId,
        config.capabilities,
        config.db,
        { onSyncActivity: config.onSyncActivity },
      );
      break;
    }

    case 'demo': {
      adapter = createDemoSharingStub();
      break;
    }

    case 'cache': {
      adapter = createCachedSharing(config.snapshot);
      break;
    }

    default:
      throw new Error(`Sharing not supported for backend: ${backendType}`);
  }

  // Validate against the canonical interface — fail loud at init
  validateSharingAdapter(adapter, backendType);

  return adapter;
}

// Re-export createDriveSharing for backward compatibility
export { createDriveSharing } from './sharing-drive.js';
