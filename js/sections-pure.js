// ===================================================================
// sections-pure.js — Nested sections: pure tree + layout logic.
//
// Category-style rows (todo_categories, habit_categories, lists) can be
// buckets (kind='bucket', the default — they hold items) or sections
// (kind='section' — they hold buckets and sub-sections, never items).
// A row's parent_id points at its containing section row, or is null for
// the top level. parent_id is a plain field, deliberately not a foreign
// key: the tree is derived here, in one place, and bad links degrade to
// the top level instead of corrupting the tree.
//
// This module is DOM-free and DB-free so tests can import it directly
// (same pattern as calendar-pure.js). Views build the tree from their
// rows, render it, and hand layout to layoutLevel().
// ===================================================================

/** A row is a section iff kind is exactly 'section'; anything else
 *  (including rows from before the 2.23.0 migration) is a bucket. */
export function isSectionRow(row) {
  return !!row && row.kind === 'section';
}

export function isBucketRow(row) {
  return !!row && row.kind !== 'section';
}

/** Fill the 2.23.0 fields with their defaults in place. Returns the row. */
export function normalizeSectionFields(row) {
  if (!row) return row;
  if (row.kind == null) row.kind = 'bucket';
  if (row.parent_id === undefined) row.parent_id = null;
  return row;
}

/** Split a typed category path ("Reading > Fiction") into segments.
 *  Empty segments are dropped; a blank name yields []. */
export function parseSectionPath(name) {
  if (!name || typeof name !== 'string') return [];
  return name.split('>').map(s => s.trim()).filter(Boolean);
}

export function joinSectionPath(segments) {
  return (segments || []).join(' > ');
}

function sortOrderOf(row, index) {
  const n = Number(row?.sort_order);
  return { order: Number.isFinite(n) ? n : 0, index };
}

/**
 * The effective parent of a row: its parent_id when that row exists, is a
 * section, is not the row itself, and following the chain from it never
 * loops back. Anything else (missing parent, bucket parent, cycle) means
 * the row sits at the top level — corrupt links degrade to flat.
 */
function effectiveParentId(row, byId) {
  const pid = row?.parent_id;
  if (!pid || pid === row.id) return null;
  const parent = byId.get(pid);
  if (!parent || parent.kind !== 'section') return null;
  const seen = new Set([row.id]);
  let cur = parent;
  while (cur) {
    if (seen.has(cur.id)) return null; // cycle
    seen.add(cur.id);
    const nextId = cur.parent_id;
    if (!nextId) break;
    cur = byId.get(nextId);
    if (!cur || cur.kind !== 'section') break;
  }
  return pid;
}

/**
 * Build the section tree from flat rows.
 * Returns { roots, byId } where each node is
 * { id, row, kind, parentId, children } and children are sorted by
 * (sort_order, original order). byId maps every row id to its node.
 */
export function buildSectionTree(rows) {
  const byId = new Map();
  (rows || []).forEach((row, index) => {
    if (!row || row.id == null) return;
    normalizeSectionFields(row);
    byId.set(row.id, {
      id: row.id,
      row,
      kind: row.kind === 'section' ? 'section' : 'bucket',
      parentId: null,
      children: [],
      _index: index,
    });
  });
  const roots = [];
  const rowById = new Map([...byId].map(([id, n]) => [id, n.row]));
  for (const node of byId.values()) {
    node.parentId = effectiveParentId(node.row, rowById);
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else {
      node.parentId = null;
      roots.push(node);
    }
  }
  const sortSiblings = (list) => {
    list.sort((a, b) => {
      const sa = sortOrderOf(a.row, a._index), sb = sortOrderOf(b.row, b._index);
      return sa.order - sb.order || sa.index - sb.index;
    });
    for (const n of list) sortSiblings(n.children);
  };
  sortSiblings(roots);
  return { roots, byId };
}

/** Ancestor nodes of a node, root first, excluding the node itself. */
export function ancestorsOf(node, byId) {
  const out = [];
  const seen = new Set([node?.id]);
  let cur = node;
  while (cur && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
    cur = byId.get(cur.parentId);
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** Display path segments for a node, e.g. ['Reading', 'Fiction']. */
export function pathSegmentsOf(node, byId) {
  if (!node) return [];
  return [...ancestorsOf(node, byId).map(n => n.row.name ?? ''), node.row.name ?? ''];
}

export function pathLabelOf(node, byId) {
  return joinSectionPath(pathSegmentsOf(node, byId));
}

/** All descendant nodes in display (DFS) order, excluding the node. */
export function descendantsOf(node) {
  const out = [];
  const walk = (n) => { for (const c of (n.children || [])) { out.push(c); walk(c); } };
  if (node) walk(node);
  return out;
}

/** Ids of every bucket in a node's subtree (the node itself included
 *  when it is a bucket). */
export function descendantBucketIds(node) {
  if (!node) return [];
  const ids = [];
  const walk = (n) => {
    if (n.kind === 'bucket') ids.push(n.id);
    for (const c of (n.children || [])) walk(c);
  };
  walk(node);
  return ids;
}

/** Every node in display order (pre-order DFS from the roots). */
export function flattenTree(roots) {
  const out = [];
  const walk = (n) => { out.push(n); for (const c of (n.children || [])) walk(c); };
  for (const r of (roots || [])) walk(r);
  return out;
}

/**
 * Tree ordering key: the sibling sort_orders along the path from the
 * root. Comparing two keys lexicographically (shorter first on a shared
 * prefix) gives the tree-wide display order used by flat pickers.
 */
export function orderKeyOf(node, byId) {
  if (!node) return [];
  const chain = [...ancestorsOf(node, byId), node];
  return chain.map(n => {
    const o = Number(n.row?.sort_order);
    return Number.isFinite(o) ? o : 0;
  });
}

export function compareOrderKeys(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Is `name` already used by a sibling (same effective parent, either
 * kind)? Names share one namespace per parent — a bucket and a section
 * with the same name under one parent would make typed paths ambiguous.
 */
export function siblingNameTaken(rows, parentId, name, excludeId) {
  const { byId } = buildSectionTree(rows || []);
  const target = (name || '').trim().toLowerCase();
  if (!target) return false;
  for (const node of byId.values()) {
    if (node.id === excludeId) continue;
    if ((node.parentId || null) !== (parentId || null)) continue;
    if ((node.row.name || '').trim().toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Plan moving a node under a new parent (null = top level): returns
 * { updates: [{ id, parent_id, sort_order }] } for the caller to
 * persist, or { error }. Moving a section moves its whole subtree —
 * only the section's own parent changes; its children keep pointing
 * at it. `beforeId` inserts at that sibling's position (a positional
 * drop on a visible chips row); null appends at the end (a drop on
 * a section block, and the fallback when the target renders no chips
 * row). Refuses cycles (a section into itself or one of its
 * descendants) and per-parent name collisions. Protected rows are
 * never rewritten, though they still occupy their position when a
 * positional insert is computed.
 */
export function planNodeMove(rows, nodeId, newParentId, beforeId = null) {
  const { byId, roots } = buildSectionTree(rows || []);
  const node = byId.get(nodeId);
  if (!node) return { error: 'not-found' };
  const parentId = newParentId || null;
  let siblings;
  if (parentId === null) {
    siblings = roots;
  } else {
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== 'section') return { error: 'invalid-parent' };
    if (parentId === nodeId) return { error: 'cycle' };
    if (descendantsOf(node).some(n => n.id === parentId)) return { error: 'cycle' };
    siblings = parent.children;
  }
  if (siblingNameTaken(rows, parentId, node.row.name, nodeId)) return { error: 'name-taken' };
  const others = siblings.filter(n => n.id !== nodeId);
  if (beforeId == null) {
    const maxSort = others.reduce((m, n) => Math.max(m, Number(n.row.sort_order) || 0), -1);
    return { updates: [{ id: nodeId, parent_id: parentId, sort_order: maxSort + 1 }] };
  }
  const at = others.findIndex(n => n.id === beforeId);
  const order = [...others];
  order.splice(at < 0 ? order.length : at, 0, node);
  const updates = [];
  order.forEach((n, i) => {
    if (n.id === nodeId) updates.push({ id: n.id, parent_id: parentId, sort_order: i });
    else if (!n.row.is_protected && Number(n.row.sort_order) !== i) {
      updates.push({ id: n.id, parent_id: parentId, sort_order: i });
    }
  });
  return { updates };
}

/**
 * Resolve typed path segments against the tree, starting at the roots.
 * Returns the final node, or null when any segment is missing or a
 * non-final segment is a bucket (buckets have no children to descend
 * into — creating through one is the caller's conversion case).
 */
export function resolveSectionPath(roots, segments) {
  let level = roots || [];
  let node = null;
  for (let i = 0; i < (segments || []).length; i++) {
    const seg = (segments[i] || '').trim().toLowerCase();
    node = level.find(n => (n.row.name || '').trim().toLowerCase() === seg) || null;
    if (!node) return null;
    if (i < segments.length - 1) {
      if (node.kind !== 'section') return null;
      level = node.children;
    }
  }
  return node;
}

// -------------------------------------------------------------------
// Layout — per-level even grid.
//
// At one level, entries are placed in strict order. A bucket occupies
// 1 block; a section occupies a rectangle: C blocks wide (its span at
// this level) and as many cell-rows tall as its own internal layout
// needs at that width. A section that does not fit in the blocks left
// in the current row starts on the next row (a gap is left).
//
// A section's span is chosen bottom-up: the smallest C (at most the
// level's maxCols) that gives its internal layout its minimal row
// count, ties broken by fewest empty cells. The choice depends only on
// child counts/rectangles and maxCols — never on pixel widths further
// down — so the computation cannot be circular.
// -------------------------------------------------------------------

function createLayoutEngine() {
  const footprintMemo = new Map(); // `${id}|${cap}` -> cols
  const heightMemo = new Map();    // `${id}|${cols}` -> rows

  function footprintCols(node, cap) {
    if (!node || node.kind !== 'section') return 1;
    const key = `${node.id}|${cap}`;
    if (footprintMemo.has(key)) return footprintMemo.get(key);
    footprintMemo.set(key, 1); // re-entrancy guard; overwritten below
    const cols = chooseSectionCols(node, cap);
    footprintMemo.set(key, cols);
    return cols;
  }

  function heightRows(node, cols) {
    if (!node || node.kind !== 'section') return 1;
    const key = `${node.id}|${cols}`;
    if (heightMemo.has(key)) return heightMemo.get(key);
    heightMemo.set(key, 1); // re-entrancy guard
    const rows = layoutLevelInternal(node.children || [], cols).rowCount;
    heightMemo.set(key, rows);
    return rows;
  }

  function chooseSectionCols(node, cap) {
    const children = node.children || [];
    if (!children.length) return 1;
    const maxC = Math.max(1, cap | 0);
    let best = null;
    for (let c = 1; c <= maxC; c++) {
      const lay = layoutLevelInternal(children, c);
      const empty = c * lay.rowCount - lay.occupiedCells;
      if (!best || lay.rowCount < best.rows || (lay.rowCount === best.rows && empty < best.empty)) {
        best = { cols: c, rows: lay.rowCount, empty };
      }
    }
    return best.cols;
  }

  function layoutLevelInternal(nodes, cap) {
    const maxCols = Math.max(1, cap | 0);
    const placements = [];
    let rowCount = 0;     // summed height (in cell rows) of closed rows
    let maxBlocks = 0;    // widest row, in blocks
    let occupiedCells = 0;
    let rowWidth = 0, rowHeight = 0, rowOpen = false;
    const closeRow = () => {
      if (!rowOpen) return;
      rowCount += rowHeight;
      if (rowWidth > maxBlocks) maxBlocks = rowWidth;
      rowWidth = 0; rowHeight = 0; rowOpen = false;
    };
    for (const node of (nodes || [])) {
      const w = Math.min(footprintCols(node, maxCols), maxCols);
      const h = heightRows(node, w);
      if (rowOpen && w > maxCols - rowWidth) closeRow();
      rowOpen = true;
      rowWidth += w;
      if (h > rowHeight) rowHeight = h;
      occupiedCells += w * h;
      placements.push({ id: node.id, cols: w, rows: h });
    }
    closeRow();
    return { placements, rowCount, maxBlocks, occupiedCells };
  }

  return { layoutLevelInternal, footprintCols, heightRows };
}

/**
 * Lay out one level.
 * @param {Array} nodes — abstract nodes { id, kind, children } in order
 * @param {number} maxCols — max blocks per row at this level
 * @returns {{ placements: Array<{id, cols, rows}>, rowCount: number,
 *             maxBlocks: number, occupiedCells: number }}
 *   placements preserve the input order; maxBlocks is the widest row
 *   actually used — the caller derives the level's final block width
 *   from it (container width / maxBlocks, within its admissible range).
 */
export function layoutLevel(nodes, maxCols) {
  return createLayoutEngine().layoutLevelInternal(nodes, maxCols);
}

/** The span (in blocks) a node occupies at a level capped at maxCols. */
export function footprintCols(node, maxCols) {
  return createLayoutEngine().footprintCols(node, maxCols);
}
