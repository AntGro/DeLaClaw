// variant.js — per-variant constants, STAMPED by extension/package.mjs.
// Never hand-edit the stamped copies under extension/dist/; edit the
// template values in package.mjs instead. The folder is fixed per variant
// (spec §5): it is never derived from a hostname and never a setting.
export const VARIANT = {
  name: '__NAME__',
  folder: '__FOLDER__',
  appUrl: '__APP_URL__',
  extensionId: '__EXTENSION_ID__',
  isDev: __IS_DEV__,
  // Schema version the extension knows, stamped from the repo's latest
  // DRIVE_MIGRATIONS key at packaging time. A live schema_version newer
  // than this refuses all writes (contracts §6).
  knownSchemaVersion: '__KNOWN_SCHEMA_VERSION__',
};
