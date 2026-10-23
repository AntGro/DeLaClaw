// ===================================================================
// VERSION COMPARISON — shared X.Y.Z comparator
// ===================================================================
// Compares version strings part-by-part as integers (NOT as floats).
// parseFloat('1.939.1') === 1.939 would silently collapse the patch,
// and string comparison breaks as soon as a part exceeds one digit.
//
// Tolerates legacy two-part versions (X.Y, e.g. '1.809'): missing parts
// count as 0, so '1.809' === '1.809.0' < '1.809.1'.
// Non-numeric parts are treated as 0.
//
// Returns -1, 0, or 1. Use with Array.sort and for >= checks:
//   versions.sort(compareVersions)
//   compareVersions(dbVer, '1.295') >= 0
// ===================================================================

export function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(pa[i], 10);
    const y = parseInt(pb[i], 10);
    const xn = Number.isNaN(x) ? 0 : x;
    const yn = Number.isNaN(y) ? 0 : y;
    if (xn !== yn) return xn < yn ? -1 : 1;
  }
  return 0;
}
