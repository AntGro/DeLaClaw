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
//
// ===================================================================

import { SHARING_INTERFACE, validateSharingAdapter } from './sharing-interface.js';

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
        'getRevokedMembers',
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

/**
 * Create a sharing adapter for the given backend type.
 *
 * @param {'googledrive'|'demo'} backendType
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
      );
      break;
    }

    case 'demo': {
      adapter = createDemoSharingStub();
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
