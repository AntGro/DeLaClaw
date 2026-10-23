// ===================================================================
// DRIVE PRE-MIGRATION BACKUP POLICY (pure logic, no I/O)
// ===================================================================
// A `backup-v{B}.json` file snapshots the whole store at version B before the
// batch of migrations newer than B ran. The backup is deleted once its batch
// succeeds, so it never accumulates: a lingering backup always means "a
// migration batch failed and will be retried from clean state".
//
// Invariant (guaranteed by the migration runner): settings.json is written
// exactly ONCE per batch, at the very end, carrying the final schema_version.
// The version on Drive therefore moves exactly once per batch, so:
//
//   backup version == current schema_version  ⟺  its batch did not complete
//   backup version <  current schema_version  ⟺  its batch completed
//       (its delete crashed — the backup is stale)
//
// Decision table (newest backup found, if any):
//   no backup                       → 'snapshot'
//   backup version == current       → 'restore'
//   otherwise                       → 'stale'
//
// 'restore'  — a previous batch failed: overwrite every table file in place
//              from the backup (never delete-then-restore) and re-run the
//              migrations newer than the backup's version. Every migration
//              then runs on the exact state the previous one produced, so
//              migrations do NOT need to be idempotent.
// 'stale'    — the backup's batch completed but its delete crashed: delete it.
// 'snapshot' — no backup: snapshot the current tables before migrating.
//
// Validation: the backup bytes are validated BEFORE upload (the store is
// plain JSON-serializable data; JSON.stringify either succeeds completely
// or throws before any network call), and a Drive upload either lands as
// one atomic revision or fails — Drive never exposes a half-written file.
// So a successfully downloaded backup is exactly what was written; no
// restore-time re-validation is needed beyond the download's own parse.

import { compareVersions } from '../../migrations/version-compare.js';

/** Extract the version from a `backup-v{version}.json` filename, else null. */
export function parseBackupVersion(fileName) {
  const m = /^backup-v(.+)\.json$/.exec(fileName);
  return m ? m[1] : null;
}

/** Newest backup version among Drive file names, else null. */
export function newestBackupVersion(fileNames) {
  let best = null;
  for (const name of fileNames) {
    const v = parseBackupVersion(name);
    if (v !== null && (best === null || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/**
 * Decide what to do before running pending migrations.
 * @param {string|null} backupVersion  newest backup-v*.json version, if any
 * @param {string} currentVersion      schema_version from settings.json ('0' if missing)
 * @returns {'snapshot'|'restore'|'stale'}
 */
export function decideBackupAction(backupVersion, currentVersion) {
  if (backupVersion === null) return 'snapshot';
  // The policy assumes the settings-at-end ordering held for existing
  // installs too — no rescue logic for older regimes.
  return compareVersions(backupVersion, currentVersion) === 0 ? 'restore' : 'stale';
}
