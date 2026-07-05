// ===================================================================
// SHARING FACTORY — selects the right sharing adapter by backend type
// ===================================================================
//
// Entry point for all sharing initialization. Consumers call
// createSharing(backendType, ...) and get back an object that
// conforms to the SharingInterface contract (sharing-interface.js).
//
// Currently supported:
//   - 'googledrive' → sharing-drive.js (createDriveSharing)
//
// Future:
//   - 'supabase'    → sharing-supabase.js
//   - 'local'       → sharing-local.js
//
// ===================================================================

/**
 * Create a sharing adapter for the given backend type.
 *
 * @param {'googledrive'|'supabase'|'local'} backendType
 * @param {Object} config — backend-specific configuration
 *
 * For googledrive:
 *   config.getToken           — () => Promise<string>
 *   config.personalFolderId   — string (DeLaClaw/ folder ID)
 *   config.capabilities       — { openJoinPicker? }
 *
 * Future backends will define their own config shapes.
 *
 * @returns {Promise<SharingAdapter>}
 */
export async function createSharing(backendType, config = {}) {
  switch (backendType) {
    case 'googledrive': {
      const { createDriveSharing } = await import('./sharing-drive.js');
      return createDriveSharing(
        config.getToken,
        config.personalFolderId,
        config.capabilities,
      );
    }

    case 'supabase': {
      const { createSupabaseSharing } = await import('./sharing-supabase.js');
      return createSupabaseSharing(config.adapter, {
        getAuthUser: config.getAuthUser,
        supabaseUrl: config.supabaseUrl,
        anonKey: config.anonKey,
        capabilities: config.capabilities || {},
      });
    }

    // case 'local': {
    //   const { createLocalSharing } = await import('./sharing-local.js');
    //   return createLocalSharing(config.serverUrl, ...);
    // }

    default:
      throw new Error(`Sharing not supported for backend: ${backendType}`);
  }
}

// Re-export createDriveSharing for backward compatibility
// (direct import from sharing.js still works during migration)
export { createDriveSharing } from './sharing-drive.js';
