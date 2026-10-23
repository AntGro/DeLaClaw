// Environment-aware Google Drive folder names.
//
// Production (delaclaw.com) uses `DeLaClaw/`, `DeLaClaw Backups/` and
// `DeLaClaw-Shared/`. Every other host — dev.delaclaw.pages.dev, Cloudflare
// PR previews, localhost — uses isolated `DeLaClawDev*` folders so that
// preview/test builds can never read or write production data.
//
// Pure functions of the hostname (no `location` access) so they are
// unit-testable in Node. Call sites pass `currentHostname()`.

const PROD_HOSTNAMES = ['delaclaw.com', 'www.delaclaw.com'];

/** True only on the production host. Case-insensitive. */
export function isProdHostname(hostname) {
  return PROD_HOSTNAMES.includes(String(hostname || '').toLowerCase());
}

/** '' on production, 'Dev' everywhere else. */
export function driveFolderSuffix(hostname) {
  return isProdHostname(hostname) ? '' : 'Dev';
}

/** The current hostname in browser contexts; '' under Node (→ 'Dev'). */
export function currentHostname() {
  return typeof location === 'undefined' ? '' : location.hostname;
}

/**
 * All Drive folder names for the given hostname.
 * @returns {{personal: string, backups: string, sharedRoot: string, groupPrefix: string}}
 */
export function driveFolderNames(hostname) {
  const suffix = driveFolderSuffix(hostname);
  const personal = `DeLaClaw${suffix}`;
  const sharedRoot = `DeLaClaw${suffix}-Shared`;
  return {
    personal,
    backups: `${personal} Backups`,
    sharedRoot,
    groupPrefix: `${sharedRoot}-`,
  };
}
