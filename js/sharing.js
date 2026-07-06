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
//   - 'supabase'    → sharing-supabase.js (createSupabaseSharing)
//
// ===================================================================

import { validateSharingAdapter } from './sharing-interface.js';

/**
 * Create a sharing adapter for the given backend type.
 *
 * @param {'googledrive'|'supabase'} backendType
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

    case 'supabase': {
      const { createSupabaseSharing } = await import('./sharing-supabase.js');
      adapter = await createSupabaseSharing(config.adapter, {
        getAuthUser: config.getAuthUser,
        supabaseUrl: config.supabaseUrl,
        anonKey: config.anonKey,
        capabilities: config.capabilities || {},
      });
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
