// variant.js — per-variant constants, STAMPED by extension/package.mjs.
// Never hand-edit the stamped copies under extension/dist/; edit the
// template values in package.mjs instead. The folder is fixed per variant
// (spec §5): it is never derived from a hostname and never a setting.
export const VARIANT = {
  name: 'DeLaClaw',
  folder: 'DeLaClaw',
  appUrl: 'https://delaclaw.com',
  extensionId: 'cnpaghkipnignlonpoblbpoceheompap',
  isDev: false,
  // Schema version the extension knows, stamped from the repo's latest
  // DRIVE_MIGRATIONS key at packaging time. A live schema_version newer
  // than this refuses all writes (contracts §6).
  knownSchemaVersion: '2.32.190',
};
