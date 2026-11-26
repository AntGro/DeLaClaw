import { lucideIcon } from './icons.js';
import state, { LIST_NOTE_MAX_LEN, MAX_META_DISPLAY } from './state.js';
import { esc, escQ, renderMd, showToast, showConfirmAction, balanceGrid, applySectionGrid, truncateWithShowMore, fetchAll, nextPaletteColor, onColorFor, autoResizeTextarea, snapshotTextInputs, restoreTextInputs } from './utils.js';
import { isSectionRow, normalizeSectionFields, parseSectionPath, buildSectionTree, pathLabelOf, descendantsOf, descendantBucketIds, siblingNameTaken, planNodeMove, runBucketToSectionMigration } from './sections-pure.js';
import { cleanupDragArtifacts, scrollToAndHighlight, initItemHoverDelay, initItemDragDrop, reorderItems, bulkSortOrder, inlineEditText, initNavBtnReorder, snapshotBuckets, animateBucketsFromSnapshot, captureInnerScrollPositions, restoreInnerScrollPositions, animateItemRemoval } from './item-utils.js';
import { t } from './i18n.js';
import { sharedBadge, assigneeDots, openSharePopover } from './sharing-ui.js';

// ===================================================================
// LISTS — GENERIC USER-CREATED LISTS (bucket-card layout)
// ===================================================================

// ── Pure attachment helpers ──
// Attachment record: { drive_file_id, name, size, url, uploaded_by }.
// uploaded_by is compulsory — a record without it is invalid and is
// dropped. It is the group member id (a hash, never an email) of the
// member who uploaded the file, so later group flows (revocation,
// delete-cleans-own-files) can tell whose Drive a file lives in. The
// id is the same on shared and personal items: the member id is purely
// a hash of the uploader's email, so a personal item stamps it via the
// group-independent getCurrentUserMemberId, and a shared item via
// getCurrentMemberId(groupId). No attachment has ever been uploaded
// outside dev, so there are no legacy records without the field to
// keep reading.
// Stored on the item as a JSON string in the list_items.attachments
// column (and as a real array in the sharing payload). In-memory
// item.attachments is always the parsed, validated array.
// (Extracted by tests via new Function slicing, same idiom as the
// flashcards pure session helpers.)
function normalizeAttachments(value) {
  let arr = value;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(a => a && typeof a === 'object'
    && typeof a.drive_file_id === 'string' && a.drive_file_id
    && typeof a.name === 'string' && a.name
    && typeof a.url === 'string' && a.url
    && Number.isFinite(a.size) && a.size >= 0
    && typeof a.uploaded_by === 'string' && a.uploaded_by)
    .map(a => ({ drive_file_id: a.drive_file_id, name: a.name, size: a.size, url: a.url, uploaded_by: a.uploaded_by }));
}
function serializeAttachments(list) {
  const arr = normalizeAttachments(list);
  return arr.length ? JSON.stringify(arr) : null;
}
function formatFileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${trimSize10(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${trimSize10(b / (1024 * 1024))} MB`;
  return `${trimSize10(b / (1024 * 1024 * 1024))} GB`;
}
function trimSize10(n) {
  return (Math.round(n * 10) / 10).toString();
}
function isDriveAttachmentUrl(url) {
  return typeof url === 'string' && url.startsWith('https://drive.google.com/');
}
// The payload for a list item going to a group: text, list name and
// note, plus the attachment records when the item has any — the links
// travel with the item so members see them the moment it appears.
function sharedListItemPayload(item, listObj) {
  const payload = { text: item.text, list_name: listObj?.name || '', note: item.note || '' };
  const attachments = normalizeAttachments(item.attachments);
  if (attachments.length) payload.attachments = attachments;
  return payload;
}
// The files the current user may trash on delete: only their own.
// uploaded_by is compulsory on every record since v2.32.127, so a record
// never matches without an uploader — and when the id cannot be resolved
// at all, nothing is trashed.
function ownAttachmentFiles(attachments, myId) {
  if (!myId) return [];
  return normalizeAttachments(attachments).filter(a => a.uploaded_by === myId);
}

// Pure: does a list item match a search query? Text, note, and
// attachment file names all count (v2.32.140) — searching "receipt"
// finds an item whose only match is a receipt.pdf chip. Case-insensitive;
// an empty query matches everything.
function listItemMatchesSearch(item, q) {
  if (!q) return true;
  const query = String(q).toLowerCase();
  return (item.text && item.text.toLowerCase().includes(query))
    || (item.note && item.note.toLowerCase().includes(query))
    || normalizeAttachments(item.attachments).some(a => (a.name || '').toLowerCase().includes(query));
}

// Pure: the display name of a member id in a members list, or null when
// the member is not found (left the group, or the id predates the row).
// The invited label is the fallback — it is what the UI shows for a
// member with no display name yet.
function memberDisplayName(members, memberId) {
  const m = (members || []).find(x => x && x.member_id === memberId);
  return m?.display_name || m?.invited_label || null;
}

// Pure: the drive_file_ids referenced by the given items, excluding any
// item whose local id or shared id is in excludeKeys. An item's
// attachments may be a JSON string, an array, or missing.
function referencedFileIdsFromItems(items, excludeKeys = new Set()) {
  const ids = new Set();
  for (const item of items || []) {
    if (!item || excludeKeys.has(item.id) || (item.shared_id && excludeKeys.has(item.shared_id))) continue;
    for (const a of normalizeAttachments(item.attachments)) ids.add(a.drive_file_id);
  }
  return ids;
}
// ── End pure attachment helpers ──

// The member id my own attachments carry: the group row's id for a shared
// item, the group-independent email-hash id for a personal one — the same
// two sources the upload queue uses. Null when it cannot be resolved,
// in which case no file is trashed at all.
async function myAttachmentUploaderId(item) {
  try {
    if (item.shared_group_id) return await state.sharing?.getCurrentMemberId?.(item.shared_group_id) ?? null;
    return await state.sharing?.getCurrentUserMemberId?.() ?? null;
  } catch { return null; }
}

// All drive_file_ids referenced by list items other than the excluded
// ones — my own items plus the shared payloads in groups I'm in. A file
// referenced by any of these must not be trashed. (v2.32.138)
// Limit: another member's PERSONAL copy is invisible to this client —
// it references the file without any trace here — so the check cannot
// cover it; deleting the last visible reference can still dangle a
// personal copy elsewhere. Only the file owner can trash it, and the
// trash is recoverable from Drive for 30 days.
function referencedAttachmentFileIds(excludeKeys) {
  const ids = referencedFileIdsFromItems(state.allListItems || [], excludeKeys);
  try {
    for (const si of state.sharing?.getAllSharedItems?.() || []) {
      if (!si || excludeKeys.has(si.id)) continue;
      for (const a of normalizeAttachments(si.payload?.attachments)) ids.add(a.drive_file_id);
    }
  } catch {}
  return ids;
}

// The uploader name for a chip tooltip on a shared item: the member's
// display name from the group row. Null on personal items (no group to
// resolve against) and when the member is no longer in the row — the
// chip then shows no uploader, never a raw id. (v2.32.139)
function attachmentUploaderName(item, uploadedBy) {
  if (!item?.shared_group_id || !uploadedBy) return null;
  const group = state.sharing?.getGroup?.(item.shared_group_id);
  return memberDisplayName(group?.members, uploadedBy);
}

// Trash the Drive attachments I own on an item — my files only, never
// another member's — plus my own per-item folder. Best-effort, never
// blocks the deletion. Shared by item delete, list delete and section
// delete: deleting a list is deleting each of its items.
// A file still referenced by another item is never trashed (v2.32.138):
// the same file can be linked from several items since keep-copies and
// copy-to-personal carry the records as-is. excludeKeys is the set of
// item keys (local ids and shared ids) whose references don't count —
// the item(s) being deleted. Defaults to this item's own keys.
async function trashOwnItemAttachments(item, excludeKeys = null) {
  const exclude = excludeKeys || new Set([item.id, item.shared_id].filter(Boolean));
  const referenced = referencedAttachmentFileIds(exclude);
  for (const a of ownAttachmentFiles(item.attachments, await myAttachmentUploaderId(item))) {
    if (referenced.has(a.drive_file_id)) continue;
    try { await state.driveAdapter?.trashAttachmentFile?.(a.drive_file_id); } catch {}
  }
  // …and my own attachments folder for this item, which also holds
  // orphans from cancelled uploads. Same folder key as the upload path.
  // The lookup runs in my Drive, so it can only ever find my folder —
  // another member's folder for the same item lives in their Drive.
  // The adapter spares every file in it that another item still references.
  try { await state.driveAdapter?.trashItemAttachmentsFolder?.(item.shared_id || item.id, referenced); } catch {}
}

let listSearchQuery = '';

// Distinct colors for list cards (cycles)
const LIST_COLORS = [
  '#14b8a6', // teal
  '#ef4444', // red
  '#a855f7', // purple
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
];

function getListColor(list, idx) {
  if (list.color) return list.color;
  // Stable fallback for legacy lists without a stored color:
  // hash the id so the color doesn't change when sort order changes.
  if (list.id) {
    let h = 0;
    for (let i = 0; i < list.id.length; i++) h = (h * 31 + list.id.charCodeAt(i)) | 0;
    return LIST_COLORS[Math.abs(h) % LIST_COLORS.length];
  }
  return LIST_COLORS[(idx >= 0 ? idx : 0) % LIST_COLORS.length];
}

// ── Nested sections ────────────────────────────────────────────────
// Lists have no separate category table: the lists table itself holds
// both buckets (kind='bucket') and sections (kind='section', whose row
// has no items). The tree is rebuilt from state.allLists on refresh.
const SECTION_DEFAULT_COLOR = '#3b82f6';
let _listTree = { roots: [], byId: new Map() };

function rebuildListTree() {
  _listTree = buildSectionTree(state.allLists || []);
}

function listRowById(id) {
  return (state.allLists || []).find(l => l.id === id) || null;
}

function getListPath(listId) {
  const node = _listTree.byId.get(listId);
  const row = listRowById(listId);
  if (!node || !node.parentId || !row) return row?.name || '';
  return pathLabelOf(node, _listTree.byId);
}

function listChildRow(parentId, name) {
  const target = (name || '').trim().toLowerCase();
  for (const node of _listTree.byId.values()) {
    if ((node.parentId || null) === (parentId || null) && (node.row.name || '').trim().toLowerCase() === target) return node.row;
  }
  return null;
}

function nextListSortOrder(parentId) {
  let max = -1;
  for (const node of _listTree.byId.values()) {
    if ((node.parentId || null) === (parentId || null)) max = Math.max(max, Number(node.row.sort_order) || 0);
  }
  return max + 1;
}

/** Convert a bucket list into a section: its items move to a '*' list. */
async function convertListBucketToSection(list) {
  const { data, error } = await state.db.from('lists').insert({
    name: '*', shortname: null, color: list.color || SECTION_DEFAULT_COLOR,
    sort_order: 0, kind: 'bucket', parent_id: list.id,
  }).select();
  if (error) throw error;
  const starId = data?.[0]?.id;
  // Abort without flipping kind if the '*' bucket is missing — see
  // convertTodoBucketToSection.
  if (!starId) throw new Error('section-convert-star-missing');
  await runBucketToSectionMigration(state.db, {
    categoryTable: 'lists', itemTable: 'list_items', itemFk: 'list_id',
    categoryId: list.id, starId,
    itemPatch: { list_id: starId },
    itemRollbackPatch: { list_id: list.id },
    flipPatch: { kind: 'section', updated_at: new Date().toISOString() },
  });
  // Local state only changes once the database sequence succeeded.
  (state.allLists = state.allLists || []).push(normalizeSectionFields(data[0]));
  list.kind = 'section';
  rebuildListTree();
}

async function ensureListSectionChain(segments, startParentId = null, guardId = null) {
  let parentId = startParentId || null;
  for (const seg of (segments || [])) {
    let row = listChildRow(parentId, seg);
    if (row && guardId && (row.id === guardId || descendantsOf(_listTree.byId.get(guardId) || { children: [] }).some(n => n.id === row.id))) {
      throw new Error('section-cycle');
    }
    if (!row) {
      const { data, error } = await state.db.from('lists').insert({
        name: seg, shortname: null, color: SECTION_DEFAULT_COLOR,
        sort_order: nextListSortOrder(parentId), kind: 'section', parent_id: parentId,
      }).select();
      if (error) throw error;
      row = data?.[0] || null;
      if (!row) throw new Error('section-create-failed');
      // Keep local state + tree in sync without a full refresh
      (state.allLists = state.allLists || []).push(normalizeSectionFields(row));
      rebuildListTree();
    } else if (!isSectionRow(row)) {
      await convertListBucketToSection(row);
      row = listRowById(row.id);
      rebuildListTree();
    }
    parentId = row.id;
  }
  return parentId;
}

// ===================================================================
// DATA
// ===================================================================

let _lastRefreshLists = 0;
async function refreshLists() {
  if (!state.db.connected) return;
  // Cooldown: skip if a refresh completed within 500ms (avoids double-fetch
  // when explicit refresh + realtime-triggered refresh fire back-to-back).
  const now = Date.now();
  if (now - _lastRefreshLists < 500) return;
  let lists;
  try {
    lists = await fetchAll(() => state.db
      .from('lists')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }));
  } catch (e1) {
    if (e1.code === '42P01' || e1.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allLists = lists || [];
  for (const row of state.allLists) normalizeSectionFields(row);
  rebuildListTree();

  let items;
  try {
    items = await fetchAll(() => state.db
      .from('list_items')
      .select('*')
      .order('sort_order', { ascending: true }));
  } catch (e2) {
    if (e2.code === '42P01' || e2.message?.includes('does not exist')) return;
    showToast(t('toast.failed_to_load'), 'error');
    return;
  }
  state.allListItems = items || [];
  for (const item of state.allListItems) item.attachments = normalizeAttachments(item.attachments);

  // Enrich shared list item pointers with live data from Drive
  if (state.sharing) {
    const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'list_item');
    const sharedById = new Map(sharedItems.map(i => [i.id, i]));

    for (const item of state.allListItems) {
      if (!item.shared_id) continue;
      const sh = sharedById.get(item.shared_id);
      if (sh) {
        item.text = sh.payload?.text || sh.payload?.title || '';
        item.note = sh.payload?.note || null;
        item.checked = sh.done ? 1 : 0;
        item.attachments = normalizeAttachments(sh.payload?.attachments);
        item._shared = sh;
      }
    }

    // Precompute which shared list items the current user created
    _myCreatedSharedListItemIds.clear();
    if (typeof state.sharing.getCurrentMember === 'function') {
      const groupIds = new Set(state.allListItems.filter(i => i.shared_group_id).map(i => i.shared_group_id));
      const memberIdPerGroup = new Map();
      const gidArr = [...groupIds];
      const members = await Promise.all(gidArr.map(gid => Promise.resolve(state.sharing.getCurrentMember(gid))));
      gidArr.forEach((gid, i) => { if (members[i]?.member_id) memberIdPerGroup.set(gid, members[i].member_id); });
      for (const item of state.allListItems) {
        if (!item._shared || !item.shared_group_id) continue;
        const myId = memberIdPerGroup.get(item.shared_group_id);
        if (myId && item._shared.created_by === myId) _myCreatedSharedListItemIds.add(item.shared_id);
      }
    }

    // Drop shared pointers whose remote data couldn't be resolved
    state.allListItems = state.allListItems.filter(i => !i.shared_id || i._shared);
  }

  _lastRefreshLists = Date.now();

  if (state.currentView === 'lists') {
    renderLists();
  }
}


// ===================================================================
// RENDERING — bucket cards (like Projects)
// ===================================================================

function renderLists() {
  const grid = document.getElementById('listsGrid');
  if (!grid) return;
  cleanupDragArtifacts();

  // A background sharing sync can re-render while the user is typing in a
  // quick-add box — keep the in-progress text (and focus) across the render.
  const pendingInputs = snapshotTextInputs(grid, '.list-quick-input', 'data-list-id');

  const lists = state.allLists || [];
  const allItems = state.allListItems || [];

  // Empty state
  if (lists.length === 0) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list', 48, 'var(--muted)')}</div>
      <h3>${t('lists.empty_title')}</h3>
      <p>${t('lists.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-list">${lucideIcon('plus', 16)} ${t('lists.empty_cta')}</button>
    </div>`;
    renderListNavButtons([], {});
    return;
  }

  // Apply sort
  const sortBy = document.getElementById('listsSortBy')?.value || 'manual';
  const sortedLists = [...lists];
  if (sortBy === 'name') {
    sortedLists.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    sortedLists.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  // Group items by list
  const grouped = {};
  sortedLists.forEach(l => { grouped[l.id] = []; });
  allItems.forEach(item => {
    if (grouped[item.list_id]) {
      // Apply search filter (text, note and attachment file names)
      if (listSearchQuery && !listItemMatchesSearch(item, listSearchQuery)) return;
      grouped[item.list_id].push(item);
    }
  });

  // Sort items within each list: unchecked first by sort_order, checked at bottom
  for (const listId of Object.keys(grouped)) {
    grouped[listId].sort((a, b) => {
      if ((a.checked || 0) !== (b.checked || 0)) return (a.checked || 0) - (b.checked || 0);
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
  }

  // Tree of buckets + sections (the Shared list is a synthetic root
  // bucket, always first, never inside a section). Name sort flattens
  // to the legacy single-level rendering.
  const sharedList = lists.find(l => l.name === SHARED_LIST_NAME) || null;
  const sharedVisible = !!sharedList && (grouped[sharedList.id] || []).length > 0;
  const rootNodes = _listTree.roots.filter(n => !sharedList || n.id !== sharedList.id);
  const navLists = [...(sharedList ? [sharedList] : []), ...rootNodes.map(n => n.row)];

  renderListNavButtons(navLists, grouped);
  initListNavBtnReorder();

  let html = '';
  if (sortBy === 'name') {
    const flat = lists.filter(l => l.name !== SHARED_LIST_NAME || sharedVisible);
    if (listSearchQuery) {
      const q = listSearchQuery.toLowerCase();
      html = flat.filter(l => isSectionRow(l)
        ? l.name.toLowerCase().includes(q)
        : (grouped[l.id] || []).length > 0 || l.name.toLowerCase().includes(q))
        .map((l, idx) => isSectionRow(l) ? '' : renderListCard(l, grouped[l.id] || [], idx)).join('');
    } else {
      html = flat.filter(l => !isSectionRow(l)).map((l, idx) => renderListCard(l, grouped[l.id] || [], idx)).join('');
    }
    if (sharedVisible) {
      html = renderListCard(sharedList, grouped[sharedList.id] || [], 0) + html;
    }
  } else {
    if (sharedVisible) html += renderListCard(sharedList, grouped[sharedList.id] || [], 0);
    html += renderListLevel(rootNodes, grouped, false);
  }

  // Empty state — nothing rendered (e.g. only an empty Shared list)
  if (!html) {
    grid.innerHTML = `<div class="page-empty-state">
      <div class="empty-icon">${lucideIcon('list', 48, 'var(--muted)')}</div>
      <h3>${t('lists.empty_title')}</h3>
      <p>${t('lists.empty_hint')}</p>
      <button class="empty-cta" data-action="open-add-list">${lucideIcon('plus', 16)} ${t('lists.empty_cta')}</button>
    </div>`;
    return;
  }

  const scrollY = window.scrollY;
  const innerScrolls = captureInnerScrollPositions(grid);
  grid.innerHTML = html;
  grid.className = 'project-grid';
  restoreTextInputs(grid, '.list-quick-input', 'data-list-id', pendingInputs);
  window.scrollTo(0, scrollY);
  restoreInnerScrollPositions(grid, innerScrolls);

  // Init hover-delay + drag-drop for each bucket card
  for (const node of _listTree.byId.values()) {
    if (node.kind !== 'bucket') continue;
    const card = grid.querySelector(`.list-bucket[data-list-id="${CSS.escape(node.id)}"]`);
    if (!card) continue;
    const listEl = card.querySelector('.list-item-list');
    if (listEl) {
      initListHoverDelay(listEl);
      initListItemDragDrop(node.id, listEl);
    }
  }
  for (const node of _listTree.byId.values()) {
    if (node.kind === 'section') initListSectionNavBtnReorder(node.id);
  }
  applySectionGrid(grid);
}

/** Is a tree node visible under the current search query? */
function listNodeSearchVisible(node, grouped, ancestorMatched) {
  if (!listSearchQuery) return true;
  const q = listSearchQuery.toLowerCase();
  const name = (node.row.name || '').toLowerCase();
  if (ancestorMatched || name.includes(q)) return true;
  if (node.kind === 'bucket') return (grouped[node.id] || []).length > 0;
  return node.children.some(c => listNodeSearchVisible(c, grouped, false));
}

function renderListLevel(nodes, grouped, ancestorMatched) {
  let html = '';
  for (const node of nodes) {
    if (!listNodeSearchVisible(node, grouped, ancestorMatched)) continue;
    const matched = ancestorMatched || (listSearchQuery && (node.row.name || '').toLowerCase().includes(listSearchQuery.toLowerCase()));
    html += node.kind === 'section'
      ? renderListSection(node, grouped, matched)
      : renderListCard(node.row, grouped[node.id] || [], 0);
  }
  return html;
}

function renderListSection(node, grouped, ancestorMatched = false) {
  const list = node.row;
  const bucketIds = descendantBucketIds(node);
  const total = bucketIds.reduce((sum, id) => sum + (grouped[id] || []).length, 0);
  const chips = node.children.map(child => {
    const isSec = child.kind === 'section';
    const count = isSec
      ? descendantBucketIds(child).reduce((sum, id) => sum + (grouped[id] || []).length, 0)
      : (grouped[child.id] || []).length;
    const isSharedList = !isSec && child.row.name === SHARED_LIST_NAME;
    const label = isSec ? (child.row.shortname || child.row.name || '') : (isSharedList ? t('sharing.shared') : (child.row.shortname || child.row.name || ''));
    const title = isSec ? (child.row.name || '') : (isSharedList ? t('sharing.shared') : (child.row.name || ''));
    const color = getListColor(child.row, 0);
    const action = isSec ? 'navigate-to-list-section' : 'navigate-to-list';
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="${action}" data-id="${esc(child.id)}" title="${esc(title)}">${esc(label)} (${count})</button>`;
  }).join('');
  const childrenHtml = renderListLevel(node.children, grouped, ancestorMatched)
    || `<p class="empty-msg">${t('common.section_empty')}</p>`;
  return `<div class="section-block" id="list-section-${esc(list.id)}" data-list-id="${esc(list.id)}" data-node-kind="section" data-node-id="${esc(list.id)}" style="--cat-color:${list.color || SECTION_DEFAULT_COLOR};--cat-on-color:${onColorFor(list.color || SECTION_DEFAULT_COLOR)}">
    <div class="section-header" data-action="toggle-section-chips">
      <div class="section-header-left">
        <h3 class="section-name">${lucideIcon('folder', 16)} ${esc(list.name || '')}</h3>
        <span class="section-stats">(${total})</span>
      </div>
      <div class="section-header-actions">
        <button class="todo-cat-shortname-btn" data-action="open-add-list-in-section" data-id="${esc(list.id)}" title="${esc(t('lists.add_list'))}">${lucideIcon('folder-plus', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="list" data-id="${esc(list.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="open-edit-list" data-id="${esc(list.id)}" title="${t('lists.edit_list')}">${lucideIcon('pencil', 14)}</button>
        <button class="todo-cat-delete-btn" data-action="delete-list-section" data-id="${esc(list.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
    <div class="category-nav-buttons section-chips${node.children.length > 1 ? '' : ' section-chips-collapsed'}" id="listSectionChips-${esc(list.id)}">${chips}</div>
    <div class="section-level">${childrenHtml}</div>
  </div>`;
}

function navigateToListSection(sectionId) {
  const el = document.getElementById('list-section-' + sectionId);
  if (!el) return;
  const list = listRowById(sectionId);
  scrollToAndHighlight(el, list?.color || SECTION_DEFAULT_COLOR);
}

function renderListCard(list, items, idx) {
  const color = getListColor(list, idx);
  const count = items.length;
  const isSharedList = list.name === SHARED_LIST_NAME;
  const displayName = isSharedList ? t('sharing.shared') : list.name;
  const listIcon = isSharedList ? 'users' : (list.icon || 'list');

  let itemsHtml = '';
  if (count === 0 && !listSearchQuery) {
    itemsHtml = `<div class="list-empty-cat" style="padding:12px 0;color:var(--muted);font-size:0.82rem;text-align:center;">${t('lists.no_items')}</div>`;
  } else {
    itemsHtml = items.map(item => renderListItem(item)).join('');
  }

  // Quick-add input — not shown for the auto-managed Shared list
  const quickAddHtml = isSharedList ? '' : `<div class="list-quick-add">
    <textarea class="list-quick-input" placeholder="${esc(t('lists.add_item'))}" maxlength="2000"
      data-action="quick-add-input" data-list-id="${esc(list.id)}" rows="1" style="resize:none;overflow:hidden;"></textarea>
    <button class="list-quick-add-btn" data-action="quick-add-list-item" data-list-id="${esc(list.id)}" title="${esc(t('lists.add_item'))}">${lucideIcon('plus', 16)}</button>
    ${state.sharing ? `<button class="sharing-share-btn" data-action="share-list-item-from-add" data-list-id="${esc(list.id)}" title="${esc(t('sharing.share'))}">${lucideIcon('share', 16)}</button>` : ''}
  </div>`;

  const shareableItems = items.filter(i => !i.shared_id);
  const shareListBtn = (state.sharing && shareableItems.length > 0)
    ? `<button class="archive-project-btn" data-action="bulk-share-list" data-id="${esc(list.id)}" title="${esc(t('sharing.share_all'))}">
          ${lucideIcon('share', 14)}
        </button>`
    : '';

  const headerActions = isSharedList ? '' : `<div class="project-header-actions">
        ${shareListBtn}
        <button class="archive-project-btn" data-action="copy-item-link" data-link-type="list" data-id="${esc(list.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">
          ${lucideIcon('link', 14)}
        </button>
        <button class="archive-project-btn" data-action="open-edit-list" data-id="${esc(list.id)}" title="${t('lists.edit_list')}">
          ${lucideIcon('pencil', 14)}
        </button>
        <button class="todo-cat-delete-btn" data-action="delete-list" data-id="${esc(list.id)}" title="${t('common.delete')}">
          ${lucideIcon('trash-2', 16)}
        </button>
      </div>`;

  return `<div class="project-card list-bucket" data-list-id="${esc(list.id)}" data-node-kind="bucket" data-node-id="${esc(list.id)}" style="--cat-color:${color};--cat-on-color:${onColorFor(color)}">
    <div class="project-card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span>${lucideIcon(listIcon, 18)}</span>
        <strong style="font-size:1rem;">${esc(displayName)}</strong>
        <span style="font-size:0.78rem;opacity:0.75;">(${count})</span>
      </div>
      ${headerActions}
    </div>
    ${quickAddHtml}
    <div class="task-list list-item-list" data-list-id="${esc(list.id)}">
      ${itemsHtml}
    </div>
  </div>`;
}

function renderListItem(item) {
  const checkedCls = item.checked ? ' list-item-checked' : '';
  const checkIcon = item.checked
    ? lucideIcon('check-square', 16, 'var(--accent)')
    : lucideIcon('square', 16, 'var(--muted)');
  const noteHtml = item.note
    ? `<div class="list-item-note">${truncateWithShowMore(item.note, MAX_META_DISPLAY, item.id, 'listnote')}</div>`
    : '';
  // Attachments render as link chips under the text — only the link is
  // stored on the item, the file itself is never fetched on page load.
  // Pending uploads render as chips too (ring instead of a link), so the
  // user sees them the moment files are picked.
  const attachments = normalizeAttachments(item.attachments);
  const pending = [...(_pendingAttachments.get(item.id)?.values() || [])];
  const attachmentsHtml = (attachments.length || pending.length)
    ? `<div class="list-item-attachments">${attachments.map(a => {
      const uploader = attachmentUploaderName(item, a.uploaded_by);
      const title = uploader ? `${a.name} — ${t('lists.attachment_uploaded_by', uploader)}` : a.name;
      return `
      <span class="list-attachment-chip">
        ${isDriveAttachmentUrl(a.url)
          ? `<a href="${escQ(a.url)}" target="_blank" rel="noopener" title="${escQ(title)}">${lucideIcon('paperclip', 12)} ${esc(a.name)} <span class="list-attachment-size">${esc(formatFileSize(a.size))}</span></a>`
          : `<span title="${escQ(title)}">${lucideIcon('paperclip', 12)} ${esc(a.name)} <span class="list-attachment-size">${esc(formatFileSize(a.size))}</span></span>`}
        <button data-action="remove-list-item-attachment" data-id="${esc(item.id)}" data-attachment-id="${esc(a.drive_file_id)}" title="${t('lists.remove_attachment')}" aria-label="${t('lists.remove_attachment')}">${lucideIcon('x', 12)}</button>
      </span>`;}).join('')}${pending.map(p => pendingAttachmentChipHtml(item, p)).join('')}</div>`
    : '';

  // Shared list item badge
  const isShared = item.shared_id && item.shared_group_id;
  const hasShareBtn = isShared || (!isShared && !!state.sharing);
  // Drive-only: the upload needs the Drive adapter (absent in Demo/Local).
  const canAttach = typeof state.driveAdapter?.uploadAttachment === 'function';
  let sharedHtml = '';
  if (isShared && state.sharing) {
    const group = state.sharing.getAllGroups().find(g => g.id === item.shared_group_id);
    sharedHtml = sharedBadge(group?.name || '', item.shared_group_id);
  }

  return `<div class="bucket-item list-item${checkedCls}" data-item-id="${item.id}">
    ${sharedHtml}
    <div class="list-item-row">
      <button class="list-check-btn" data-action="toggle-list-item-check" data-id="${esc(item.id)}" title="Toggle">${checkIcon}</button>
      <div class="list-item-content">
        <span class="list-item-text">${truncateWithShowMore(item.text, 120, item.id, 'listtext')}</span>
        ${noteHtml}
        ${attachmentsHtml}
      </div>
      <div class="list-item-actions${hasShareBtn ? ' cols-2' : ''}">
        ${!isShared && state.sharing ? `<button data-action="share-existing-list-item" data-id="${esc(item.id)}" title="${t('sharing.share')}">${lucideIcon('share', 14)}</button>` : ''}
        ${isShared && _myCreatedSharedListItemIds.has(item.shared_id) ? `<button data-action="unshare-list-item" data-id="${esc(item.id)}" title="${t('sharing.unshare')}">${lucideIcon('share-off', 14)}</button>` : ''}
        ${isShared && !_myCreatedSharedListItemIds.has(item.shared_id) ? `<button data-action="copy-list-item-to-personal" data-id="${esc(item.id)}" title="${t('sharing.copy_to_personal')}">${lucideIcon('copy', 14)}</button>` : ''}
        ${canAttach ? `<button data-action="attach-to-list-item" data-id="${esc(item.id)}" title="${t('lists.attach_file')}" aria-label="${t('lists.attach_file')}">${lucideIcon('paperclip', 14)}</button>` : ''}
        <button data-action="copy-item-link" data-link-type="listitem" data-id="${esc(item.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
        <button data-action="edit-list-item-inline" data-id="${esc(item.id)}" title="Edit">${lucideIcon('pencil', 14)}</button>
        <button data-action="delete-list-item" data-id="${esc(item.id)}" title="Delete">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderListNavButtons(lists, grouped) {
  const container = document.getElementById('listsNavButtons');
  if (!container) return;
  // Hide shared list from nav when empty
  const navLists = lists.filter(l => l.name !== SHARED_LIST_NAME || (grouped[l.id] || []).length > 0);
  // Shared list always first in nav when visible
  navLists.sort((a, b) => {
    const aShared = a.name === SHARED_LIST_NAME ? 0 : 1;
    const bShared = b.name === SHARED_LIST_NAME ? 0 : 1;
    return aShared - bShared;
  });
  container.innerHTML = navLists.map((list, idx) => {
    const isSection = isSectionRow(list);
    const count = isSection
      ? descendantBucketIds(_listTree.byId.get(list.id) || { kind: 'section', children: [] }).reduce((sum, id) => sum + (grouped[id] || []).length, 0)
      : (grouped[list.id] || []).length;
    const color = getListColor(list, idx);
    const shortname = list.shortname;
    const isSharedList = list.name === SHARED_LIST_NAME;
    const displayName = isSharedList ? t('sharing.shared') : (shortname || list.name);
    const action = isSection ? 'navigate-to-list-section' : 'navigate-to-list';
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="${action}" data-id="${esc(list.id)}" title="${esc(isSharedList ? t('sharing.shared') : list.name)} (${count})">${esc(displayName)} (${count})</button>`;
  }).join('');
}

function navigateToList(listId) {
  const card = document.querySelector(`.list-bucket[data-list-id="${listId}"]`);
  if (!card) return;
  scrollToAndHighlight(card, 'var(--accent)');
}

async function reorderListSiblings(orderedIds) {
  const reorderable = orderedIds.filter(id => {
    const l = (state.allLists || []).find(ls => ls.id === id);
    return l && l.name !== SHARED_LIST_NAME;
  });
  const updates = [];
  reorderable.forEach((id, i) => {
    const l = (state.allLists || []).find(ls => ls.id === id);
    if (l && Number(l.sort_order ?? 0) !== i) updates.push({ id, sort_order: i });
    if (l) l.sort_order = i;
  });
  await bulkSortOrder('lists', updates);
  const grid = document.getElementById('listsGrid');
  const snapshot = snapshotBuckets(grid);
  await refreshLists();
  animateBucketsFromSnapshot(grid, snapshot, 600);
  showToast(t('toast.reordered'), 'success');
}

/** Cross-section chip drag — see todoNavCrossDrop in todos.js. */
function listNavCrossDrop() {
  return {
    rootEl: document.getElementById('listsView'),
    rowOwner: (rowEl) => rowEl.id === 'listsNavButtons' ? null
      : rowEl.id.startsWith('listSectionChips-') ? rowEl.id.slice('listSectionChips-'.length) : undefined,
    canDrop: (dragId, parentId) => {
      const node = _listTree.byId.get(dragId);
      if (!node || (node.parentId || null) === (parentId || null)) return false;
      return !planNodeMove(state.allLists || [], dragId, parentId, null).error;
    },
    onMove: (dragId, parentId, beforeId) => moveListNodeToParent(dragId, parentId, beforeId),
  };
}

async function moveListNodeToParent(dragId, parentId, beforeId) {
  const plan = planNodeMove(state.allLists || [], dragId, parentId, beforeId);
  if (plan.error || !plan.updates?.length) return;
  // FLIP glide around the re-render — see moveTodoNodeToParent.
  const grid = document.getElementById('listsGrid');
  const snapshot = snapshotBuckets(grid);
  for (const u of plan.updates) {
    await state.db.from('lists').update({ parent_id: u.parent_id, sort_order: u.sort_order }).eq('id', u.id);
  }
  await refreshLists();
  animateBucketsFromSnapshot(grid, snapshot, 600);
}

function initListNavBtnReorder() {
  const skipIds = new Set();
  const sharedList = (state.allLists || []).find(l => l.name === SHARED_LIST_NAME);
  if (sharedList) skipIds.add(sharedList.id);
  initNavBtnReorder('listsNavButtons', {
    idAttr: 'id',
    skipIds,
    onReorder: reorderListSiblings,
    crossDrop: listNavCrossDrop(),
  });
}

function initListSectionNavBtnReorder(sectionId) {
  initNavBtnReorder('listSectionChips-' + sectionId, {
    idAttr: 'id',
    skipIds: new Set(),
    onReorder: reorderListSiblings,
    crossDrop: listNavCrossDrop(),
  });
}


// ===================================================================
// HOVER-DELAY, DRAG & DROP, INLINE EDIT
// ===================================================================

function initListHoverDelay(listEl) {
  initItemHoverDelay(listEl, {
    itemSelector: '.list-item',
    rowSelector: '.list-item-row',
    actionsSelector: '.list-item-actions',
    textSelector: '.list-item-text',
    onDblClick: (item) => {
      const id = item.dataset.itemId;
      if (id) editListItemInlineFull(id);
    },
  });
}

function initListItemDragDrop(listId, listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.list-item',
    idAttr: 'itemId',
    actionsSelector: '.list-item-actions',
    crossContainerSelector: '.list-item-list',
    getContainerId: (el) => el.dataset.listId,
    onReorder: async (orderedIds, { draggedId, sourceContainerId, targetContainerId } = {}) => {
      const allItems = state.allListItems || [];
      const crossMove = sourceContainerId && targetContainerId && sourceContainerId !== targetContainerId;

      if (crossMove) {
        // --- Cross-list move ---
        const movedItem = allItems.find(x => x.id === draggedId);
        if (!movedItem) return;

        // Update list_id in memory
        movedItem.list_id = targetContainerId;

        // Diff target list — dragged item handled in FK update below
        const targetUpdates = [];
        let draggedSortOrder = 0;
        orderedIds.forEach((id, i) => {
          const it = allItems.find(x => x.id === id);
          if (!it) return;
          if (id === draggedId) { draggedSortOrder = i; }
          else if (Number(it.sort_order ?? 0) !== i) { targetUpdates.push({ id, sort_order: i }); }
          it.sort_order = i;
        });

        // Diff source list
        const sourceItems = allItems
          .filter(x => x.list_id === sourceContainerId)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        const sourceUpdates = [];
        sourceItems.forEach((it, i) => {
          if (Number(it.sort_order ?? 0) !== i) sourceUpdates.push({ id: it.id, sort_order: i });
          it.sort_order = i;
        });

        // DB: write list_id + sort_order for dragged item, then bulk the rest
        await state.db.from('list_items').update({ list_id: targetContainerId, sort_order: draggedSortOrder }).eq('id', draggedId);
        await Promise.all([
          bulkSortOrder('list_items', targetUpdates),
          bulkSortOrder('list_items', sourceUpdates),
        ]);

        // Refresh: sharing cleanup if needed
        if (movedItem.shared_id && movedItem.shared_group_id && state.sharing) {
          // Shared items keep their sharing data, only list_id is local
        }

        await refreshLists();
        showToast(t('toast.moved'), 'success');
      } else {
        // --- Same-list reorder ---
        await reorderItems({
          orderedIds,
          allItems,
          tableName: 'list_items',
          reinitFn: () => initListItemDragDrop(listId, listEl),
        });
      }
    },
  });
}

function editListItemInline(id) {
  return editListItemInlineFull(id);
}

function editListItemInlineFull(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  const el = document.querySelector(`.list-item[data-item-id="${id}"] .list-item-text`);
  if (!el) return;

  const actionsEl = el.closest('.list-item')?.querySelector('.list-item-actions');
  if (actionsEl) actionsEl.classList.remove('visible');

  const extras = document.createElement('div');
  extras.className = 'inline-edit-extras';

  // Note row
  const row = document.createElement('div');
  row.className = 'inline-edit-row inline-edit-row-note';
  const label = document.createElement('label');
  label.className = 'inline-edit-label';
  label.textContent = t('common.notes');
  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = item.note || '';
  input.placeholder = t('lists.note_placeholder');
  input.rows = 1;
  input.maxLength = LIST_NOTE_MAX_LEN;
  input.style.overflow = 'hidden';
  input.style.resize = 'none';
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.flex = 'none';
  // Allow Enter to create newlines — stop propagation so extraEl handler doesn't finishEdit
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.stopPropagation();
  });
  // Auto-size the textarea
  input.addEventListener('input', () => {
    input.style.height = '0';
    input.style.height = input.scrollHeight + 'px';
  });
  row.appendChild(label);
  row.appendChild(input);
  extras.appendChild(row);

  // List selector row — move item between lists
  const allLists = state.allLists || [];
  if (allLists.length > 1) {
    const listRow = document.createElement('div');
    listRow.className = 'inline-edit-row';
    const listLabel = document.createElement('label');
    listLabel.className = 'inline-edit-label';
    listLabel.textContent = t('common.list');
    const listSelect = document.createElement('select');
    listSelect.className = 'inline-edit-input';
    allLists
      .filter(l => l.name !== SHARED_LIST_NAME || l.id === item.list_id)
      .forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name === SHARED_LIST_NAME ? t('sharing.shared') : l.name;
        if (l.id === item.list_id) opt.selected = true;
        listSelect.appendChild(opt);
      });
    listRow.appendChild(listLabel);
    listRow.appendChild(listSelect);
    extras.appendChild(listRow);
  }

  const listSelect = extras.querySelector('select');

  inlineEditText(el, item.text, {
    maxLength: 2000,
    extraEl: extras,
    containerEl: el.closest('.list-item'),
    collectExtra: () => ({
      note: input.value.trim(),
      list_id: listSelect ? listSelect.value : item.list_id,
    }),
    saveFn: async (newText, extra) => {
      const updates = {};
      if (newText !== item.text) updates.text = newText;
      if (extra && (extra.note || '') !== (item.note || '')) updates.note = extra.note || null;
      if (extra && extra.list_id && extra.list_id !== item.list_id) updates.list_id = extra.list_id;
      if (Object.keys(updates).length === 0) return;

      // Shared → text & note go to Drive payload
      if (item.shared_id && item.shared_group_id && state.sharing) {
        const drivePayload = {};
        if ('text' in updates) drivePayload.text = updates.text;
        if ('note' in updates) drivePayload.note = updates.note;
        if (Object.keys(drivePayload).length > 0) {
          const currentPayload = item._shared?.payload || {};
          // Optimistic: upload in the background; a failure rolls the
          // in-memory shared item back (adapter) and refreshes the view.
          state.sharing.updateItem(item.shared_group_id, item.shared_id, { payload: { ...currentPayload, ...drivePayload } })
            .catch(e => {
              console.warn('Failed to update shared list item:', e);
              renderLists();
              showToast(t('toast.update_failed'), 'error');
            });
        }
        // list_id is local-only — update pointer directly
        if ('list_id' in updates) {
          await state.db.from('list_items').update({ list_id: updates.list_id }).eq('id', id);
        }
        Object.assign(item, updates);
        showToast(t('toast.updated'), 'success');
        return;
      }

      // Normal → local DB
      updates.updated_at = new Date().toISOString();
      const { error } = await state.db.from('list_items').update(updates).eq('id', id);
      if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }
      Object.assign(item, updates);
      showToast(t('toast.updated'), 'success');
    },
    refreshFn: renderLists,
  });
}


// ===================================================================
// CRUD — ITEMS
// ===================================================================

async function quickAddListItem(inputEl, listId) {
  // Support delegation: inputEl may be event or element, listId may be in dataset
  let actualInput = null;
  let actualListId = listId;

  if (inputEl && inputEl.target) {
    // Called as event handler wrapper via delegation - resolve
    const el = inputEl.target.closest ? inputEl.target.closest('[data-action="quick-add-list-item"]') : null;
    if (el) {
      actualListId = el.dataset.listId || actualListId;
      const wrapper = el.closest('.list-quick-add');
      actualInput = wrapper ? wrapper.querySelector('.list-quick-input') : null;
    }
  } else if (typeof inputEl === 'string' && !listId) {
    // Called as quickAddListItem(listId) from old onkeydown handler - not used anymore
    actualListId = inputEl;
    actualInput = null;
  } else if (inputEl && inputEl.dataset && inputEl.dataset.listId) {
    // inputEl is actually the input with data-list-id
    actualInput = inputEl;
    actualListId = inputEl.dataset.listId || listId;
  } else {
    actualInput = inputEl;
  }

  // If called via button click delegation, actualInput is the input element sibling
  if (!actualInput && typeof actualListId === 'string') {
    // fallback: try to find via DOM if we have listId but no input
    // Will search for quick-input in same list-bucket
    const card = document.querySelector(`.list-bucket[data-list-id="${actualListId}"]`);
    if (card) actualInput = card.querySelector('.list-quick-input');
  }

  // If actualInput is still the button, find its sibling input
  if (actualInput && actualInput.classList && actualInput.classList.contains('list-quick-add-btn')) {
    const wrapper = actualInput.closest('.list-quick-add');
    actualInput = wrapper ? wrapper.querySelector('.list-quick-input') : null;
  }

  // For quick-add-input Enter handler: actualInput is the input itself
  if (actualInput && !actualListId) {
    actualListId = actualInput.dataset.listId || actualInput.getAttribute('data-list-id');
  }

  const inputToUse = actualInput;
  if (!inputToUse) return;
  const text = inputToUse.value.trim();
  if (!text) return;

  // Show saving state on the quick-add row
  const wrapper = inputToUse.closest('.list-quick-add');
  const btn = wrapper && wrapper.querySelector('.list-quick-add-btn');
  const btnHtml = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = `<span class="list-saving-spinner"></span>`;
  inputToUse.disabled = true;

  const items = (state.allListItems || []).filter(i => i.list_id === actualListId);
  const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);

  const { error } = await state.db.from('list_items').insert({
    list_id: actualListId,
    text,
    sort_order: maxOrder + 1,
  });

  // Restore input state
  inputToUse.disabled = false;
  if (btn) btn.innerHTML = btnHtml;

  if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }

  inputToUse.value = '';
  if (inputToUse.tagName === 'TEXTAREA') { inputToUse.style.height = ''; }
  showToast(t('toast.added'), 'success');
  await refreshLists();
}

const _pendingListItemToggles = new Set();

async function toggleListItemCheck(id, btnEl) {
  if (!id) return;
  if (_pendingListItemToggles.has(id)) return;
  _pendingListItemToggles.add(id);

  const safeId = CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\"');
  const allBtns = document.querySelectorAll(`button[data-action="toggle-list-item-check"][data-id="${safeId}"]`);
  const targetBtn = btnEl instanceof HTMLElement ? btnEl : (allBtns[0] || null);
  const toToggle = new Set([...allBtns, ...(targetBtn ? [targetBtn] : [])]);
  toToggle.forEach(b => { b.disabled = true; b.classList.add('saving', 'is-pending'); b.setAttribute('aria-busy', 'true'); });

  try {
    const item = (state.allListItems || []).find(x => x.id === id);
    if (!item) return;
    const newVal = item.checked ? 0 : 1;

    // Shared → Drive only (optimistic)
    if (item.shared_id && item.shared_group_id && state.sharing) {
      // Stage locally, refresh on staging; the upload runs in the background.
      // A failure rolls the in-memory shared item back (adapter).
      let onStaged;
      const staged = new Promise(resolve => { onStaged = resolve; });
      const upload = newVal
        ? state.sharing.completeItem(item.shared_group_id, item.shared_id, undefined, { onStaged })
        : state.sharing.uncompleteItem(item.shared_group_id, item.shared_id, { onStaged });
      upload.then(
        () => {},
        (e) => { renderLists(); showToast(e.message, 'error'); }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      item.checked = newVal;
      renderLists();
      return;
    }

    // Normal → local DB
    const { error } = await state.db.from('list_items').update({
      checked: newVal,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (error) { showToast(t('toast.update_failed'), 'error'); return; }
    item.checked = newVal;
    renderLists();
  } finally {
    _pendingListItemToggles.delete(id);
    toToggle.forEach(b => { b.disabled = false; b.classList.remove('saving', 'is-pending'); b.removeAttribute('aria-busy'); });
  }
}

async function deleteListItem(id) {
  const item = (state.allListItems || []).find(x => x.id === id);
  if (!item) return;
  showConfirmAction(
    t('common.delete'),
    `Remove "${renderMd(item.text)}"?`,
    async () => {
      const pointerRow = item.shared_id ? { ...item } : null;
      const { error } = await state.db.from('list_items').delete().eq('id', id);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }

      // Shared → delete from Drive too (removes for all group members).
      // The upload runs in the background; a failure restores the pointer row.
      if (item.shared_id && item.shared_group_id && state.sharing) {
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteItem(item.shared_group_id, item.shared_id, { onStaged });
        upload.then(
          () => {},
          async (e) => {
            console.warn('Failed to delete shared list item from Drive:', e);
            if (pointerRow) await state.db.from('list_items').insert(pointerRow);
            renderLists();
            showToast(t('toast.delete_failed'), 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
      }

      // Animate item out before re-rendering
      const el = document.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
      await animateItemRemoval(el);

      // Best-effort: trash MY Drive attachments so they don't linger
      // orphaned in the attachments folder. Never another member's files:
      // only the file's owner can trash a Drive file, and the decision is
      // to leave other members' files alone entirely — no attempt is made.
      // A failure here never blocks the deletion — the links are already
      // gone with the row.
      await trashOwnItemAttachments(item);

      showToast(t('toast.removed'), 'info');
      await refreshLists();
    },
    null,
    { messageHtml: true }
  );
}

// ── List item attachments ──────────────────────────────────────────
// Pending (optimistic) attachments: uploads in flight or failed,
// keyed by item id, then by a client-side pending id. Memory-only — a
// reload drops them (the XHR dies with the page; a file that already
// landed in Drive stays there, unlinked). The per-item queue processes
// one file at a time so the single save at the end cannot clobber
// itself; files picked while it runs just join the queue. The upload
// and its state live outside the view, so navigating away mid-upload
// changes nothing — the chip re-renders with its current progress
// when the item is shown again.
const _pendingAttachments = new Map(); // itemId -> Map<pendingId, entry>
const _attachmentQueueRunning = new Set(); // itemIds with a processor running
let _pendingAttachmentSeq = 0;

// Circular progress ring: an SVG circle whose stroke fills as bytes go
// out. r=7 → circumference ≈ 43.98; the offset is patched in place by
// updateAttachmentProgress (no full re-render per tick).
const ATTACHMENT_RING_R = 7;
const ATTACHMENT_RING_C = 2 * Math.PI * ATTACHMENT_RING_R;

function attachmentProgressRing(progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  const off = ATTACHMENT_RING_C * (1 - clamped);
  return `<svg class="att-progress-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle class="att-progress-ring-track" cx="8" cy="8" r="${ATTACHMENT_RING_R}"/><circle class="att-progress-ring-fg" cx="8" cy="8" r="${ATTACHMENT_RING_R}" stroke-dasharray="${ATTACHMENT_RING_C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`;
}

/** Patch a pending chip's ring in place; a no-op when the row is not on screen. */
function updateAttachmentProgress(pendingId, progress) {
  const chip = document.querySelector(`.list-attachment-chip[data-pending-id="${CSS.escape(pendingId)}"]`);
  const fg = chip?.querySelector('.att-progress-ring-fg');
  if (fg) fg.style.strokeDashoffset = String(ATTACHMENT_RING_C * (1 - Math.max(0, Math.min(1, progress))));
}

function pendingAttachmentChipHtml(item, p) {
  const actions = p.status === 'error'
    ? `<button data-action="retry-list-item-attachment" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t('lists.retry_upload')}" aria-label="${t('lists.retry_upload')}">${lucideIcon('rotate-ccw', 12)}</button>
       <button data-action="cancel-list-item-attachment" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t('lists.remove_attachment')}" aria-label="${t('lists.remove_attachment')}">${lucideIcon('x', 12)}</button>`
    : `<button data-action="cancel-list-item-attachment" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t('lists.cancel_upload')}" aria-label="${t('lists.cancel_upload')}">${lucideIcon('x', 12)}</button>`;
  return `<span class="list-attachment-chip pending${p.status === 'error' ? ' error' : ''}" data-pending-id="${esc(p.id)}">
    ${attachmentProgressRing(p.progress)}<span class="list-attachment-name" title="${escQ(p.file.name)}">${esc(p.file.name)} <span class="list-attachment-size">${esc(formatFileSize(p.file.size))}</span></span>${actions}
  </span>`;
}

/** Write an item's attachment list — payload for shared items, column for personal ones. */
async function saveListItemAttachments(item, next) {
  if (item.shared_id && item.shared_group_id && state.sharing) {
    const currentPayload = item._shared?.payload || {};
    await state.sharing.updateItem(item.shared_group_id, item.shared_id, {
      payload: { ...currentPayload, attachments: next },
    });
    return;
  }
  const { error } = await state.db.from('list_items')
    .update({ attachments: serializeAttachments(next) })
    .eq('id', item.id);
  if (error) throw error;
}

async function attachToListItem(itemId, btnEl) {
  const item = (state.allListItems || []).find(x => x.id === itemId);
  if (!item) return;
  if (typeof state.driveAdapter?.uploadAttachment !== 'function') {
    showToast(t('lists.attach_unavailable'), 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.className = 'list-attachment-picker';
  // Attached to the DOM (hidden) so the picker works everywhere and
  // automation can set files on it; removed once the pick resolves.
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => {
    const files = [...(input.files || [])];
    input.remove();
    if (!files.length) return;
    // Chips appear immediately, rings at 0% — the uploads run behind them.
    let pending = _pendingAttachments.get(itemId);
    if (!pending) { pending = new Map(); _pendingAttachments.set(itemId, pending); }
    for (const file of files) {
      const id = `pending-${++_pendingAttachmentSeq}`;
      pending.set(id, { id, file, progress: 0, status: 'queued', controller: new AbortController(), error: null });
    }
    renderLists();
    processAttachmentQueue(item);
  };
  input.click();
}

/**
 * Drain one item's pending queue, one file at a time. A failure leaves
 * that chip in an error state with a retry and the queue moves on to
 * the next file; a cancel drops the chip silently. Each finished file
 * is saved onto the item at once, so its chip turns real without
 * waiting for its siblings still in the queue; the save reads the
 * freshly-stored list, so an attachment removed while an upload ran
 * is not resurrected.
 */
async function processAttachmentQueue(item) {
  if (_attachmentQueueRunning.has(item.id)) return;
  _attachmentQueueRunning.add(item.id);
  try {
    const pending = _pendingAttachments.get(item.id);
    if (!pending) return;
    const added = [];
    // Who is uploading: the group member id (a hash, never an email),
    // stamped on every record — uploaded_by is compulsory, so the
    // upload must not start without one. Shared items read the id from
    // the group row; personal items read the group-independent id,
    // which is the same hash of the uploader's email.
    let uploadedBy = null;
    try {
      if (item.shared_id && item.shared_group_id && typeof state.sharing?.getCurrentMemberId === 'function') {
        uploadedBy = await state.sharing.getCurrentMemberId(item.shared_group_id);
      } else if (typeof state.sharing?.getCurrentUserMemberId === 'function') {
        uploadedBy = await state.sharing.getCurrentUserMemberId();
      }
    } catch { uploadedBy = null; }
    if (!uploadedBy) {
      // Refuse before any upload starts: an unattributed record would
      // be dropped by normalizeAttachments on save, orphaning the file
      // in Drive. Entries stay retryable — a retry re-resolves the id.
      for (const e of pending.values()) {
        if (e.status === 'queued') { e.status = 'error'; e.error = new Error('no uploader id'); }
      }
      showToast(t('lists.attachment_no_uploader'), 'error');
      renderLists();
      return;
    }
    let entry;
    while ((entry = [...pending.values()].find(e => e.status === 'queued'))) {
      entry.status = 'uploading';
      try {
        const record = await state.driveAdapter.uploadAttachment(entry.file, {
          signal: entry.controller.signal,
          // Folder key: the shared_id for a shared item (the stable
          // identity across members — the local id is replaced by a fresh
          // pointer row when an item is shared), the local id otherwise.
          itemId: item.shared_id || item.id,
          // The item's own attachment names cover legacy files uploaded
          // before per-item folders (they live in the flat folder).
          existingItemNames: normalizeAttachments(item.attachments).map(a => a.name),
          uploadedBy,
          onProgress: (fraction) => {
            entry.progress = fraction;
            updateAttachmentProgress(entry.id, fraction);
          },
        });
        // Cancelled while the upload or the share below was awaiting —
        // the file is in Drive, unlinked; drop it silently.
        if (entry.status === 'cancelled') continue;
        entry.progress = 1;
        // Shared → the file must be readable by the other members before
        // the link reaches them through the payload. A share failure
        // aborts the attach (the uploaded file stays in the owner's
        // Drive folder, unlinked). The grant issued for this file is
        // rolled back if the attach does not land — a grant with no
        // published link must not linger (006c30f review).
        let grantedIds = [];
        if (item.shared_id && item.shared_group_id && state.sharing) {
          entry.status = 'sharing';
          try {
            grantedIds = await state.sharing.shareFileWithGroup(item.shared_group_id, record.drive_file_id, 'reader') || [];
          } catch (e) {
            console.warn('Failed to share attachment with group:', e);
            showToast(t('lists.attachment_share_failed'), 'error');
            entry.status = 'error';
            entry.error = e;
            renderLists();
            continue;
          }
          if (entry.status === 'cancelled') {
            if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
            continue;
          }
        }
        // Save this record now — the chip turns real without waiting for
        // its siblings still in the queue.
        if (!(state.allListItems || []).some(x => x.id === item.id)) {
          if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
          pending.delete(entry.id);
          continue; // the item was deleted meanwhile; the file stays orphaned in Drive
        }
        const next = [...normalizeAttachments(item.attachments), record];
        try {
          await saveListItemAttachments(item, next);
        } catch {
          if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
          showToast(t('toast.update_failed'), 'error');
          entry.status = 'error';
          entry.error = new Error('save failed');
          renderLists();
          continue;
        }
        pending.delete(entry.id);
        added.push(record);
        item.attachments = next;
        renderLists();
      } catch (e) {
        if (e?.code === 'aborted' || entry.status === 'cancelled') {
          pending.delete(entry.id);
          renderLists();
          continue;
        }
        entry.status = 'error';
        entry.error = e;
        showToast(t('lists.attachment_upload_failed'), 'error');
        renderLists();
      }
    }
    if (!pending.size) _pendingAttachments.delete(item.id);
    if (added.length) showToast(t('lists.attachment_added'), 'success');
  } finally {
    _attachmentQueueRunning.delete(item.id);
  }
}

/** Cancel (or dismiss) a pending attachment: aborts the in-flight XHR when it is uploading. */
function cancelListItemAttachment(itemId, pendingId, btnEl) {
  const pending = _pendingAttachments.get(itemId);
  const entry = pending?.get(pendingId);
  if (!entry) return;
  if (entry.status === 'uploading' || entry.status === 'sharing') {
    entry.status = 'cancelled';
    entry.controller.abort(); // the queue's catch drops the chip
  } else {
    pending.delete(pendingId);
    if (!pending.size) _pendingAttachments.delete(itemId);
    renderLists();
  }
}

/** Re-queue a failed upload (fresh AbortController, progress back to 0). */
function retryListItemAttachment(itemId, pendingId, btnEl) {
  const entry = _pendingAttachments.get(itemId)?.get(pendingId);
  if (!entry || entry.status !== 'error') return;
  entry.status = 'queued';
  entry.progress = 0;
  entry.error = null;
  entry.controller = new AbortController();
  renderLists();
  const item = (state.allListItems || []).find(x => x.id === itemId);
  if (item) processAttachmentQueue(item);
}

async function removeListItemAttachment(itemId, driveFileId, btnEl) {
  const item = (state.allListItems || []).find(x => x.id === itemId);
  if (!item) return;
  const attachments = normalizeAttachments(item.attachments);
  const target = attachments.find(a => a.drive_file_id === driveFileId);
  if (!target) return;
  showConfirmAction(
    t('common.delete'),
    `Remove "${target.name}"?`,
    async () => {
      const next = attachments.filter(a => a.drive_file_id !== driveFileId);
      try {
        await saveListItemAttachments(item, next);
      } catch {
        showToast(t('toast.update_failed'), 'error');
        return;
      }
      item.attachments = next;
      renderLists();
      // Best-effort: trash the Drive file so it doesn't linger orphaned —
      // but only when it is mine. Removing another member's chip removes
      // the record from the payload (any member may edit a shared item);
      // their file stays untouched in their Drive.
      const myId = await myAttachmentUploaderId(item);
      if (myId && target.uploaded_by === myId) {
        // Reference check (v2.32.138): another item may still link this
        // file — the record is already gone from this item, so any hit
        // is a surviving reference, and the file is left alone.
        const referenced = referencedAttachmentFileIds(new Set([item.id, item.shared_id].filter(Boolean)));
        if (!referenced.has(driveFileId)) {
          try { await state.driveAdapter?.trashAttachmentFile?.(driveFileId); } catch {}
        }
      }
      showToast(t('lists.attachment_removed'), 'success');
    }
  );
}


// ===================================================================
// CRUD — LISTS
// ===================================================================

function addListModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('list', 20)} ${t('lists.add_list')}</h2>
    <label>${t('common.name')}</label>
    <input type="text" id="newListName" placeholder="${t('lists.name_placeholder')}" maxlength="100"
      data-action="save-new-list-on-enter">
    <div class="modal-row">
      <div class="modal-field">
        <label>${t('common.shortname')}</label>
        <input type="text" id="newListShortname" placeholder="${t('common.shortname_placeholder')}" maxlength="20"
          data-action="save-new-list-on-enter">
      </div>
      <div class="modal-field">
        <label>${t('common.color')}</label>
        <input type="color" id="newListColor">
      </div>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-add-list">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-new-list">${t('common.add')}</button>
    </div>
  </div>`;
}

function editListModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('pencil', 20)} ${t('lists.edit_list')}</h2>
    <input type="hidden" id="editListId">
    <label>${t('common.name')}</label>
    <input type="text" id="editListName" maxlength="100"
      data-action="save-edit-list-on-enter">
    <label>${t('common.section_parent')}</label>
    <select id="editListParent"></select>
    <div class="modal-row">
      <div class="modal-field">
        <label>${t('common.shortname')}</label>
        <input type="text" id="editListShortname" maxlength="20" placeholder="${t('common.shortname_placeholder')}"
          data-action="save-edit-list-on-enter">
      </div>
      <div class="modal-field">
        <label>${t('common.color')}</label>
        <input type="color" id="editListColor">
      </div>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-edit-list">${t('common.cancel')}</button>
      <button class="modal-save" data-action="save-edit-list">${t('common.save')}</button>
    </div>
  </div>`;
}

function initListModals() {
  const app = document.getElementById('app');

  const m1 = document.createElement('div');
  m1.className = 'modal-overlay';
  m1.id = 'addListModal';
  m1.innerHTML = addListModalHTML();
  app.appendChild(m1);

  const m2 = document.createElement('div');
  m2.className = 'modal-overlay';
  m2.id = 'editListModal';
  m2.dataset.action = 'close-edit-list';
  m2.dataset.overlayClose = 'true';
  m2.innerHTML = editListModalHTML();
  app.appendChild(m2);

  const m3 = document.createElement('div');
  m3.className = 'modal-overlay';
  m3.id = 'deleteListSectionModal';
  m3.dataset.action = 'close-delete-list-section-modal';
  m3.dataset.overlayClose = 'true';
  m3.innerHTML = deleteListSectionModalHTML();
  app.appendChild(m3);
}

function openAddListModal(parentId = null) {
  const modal = document.getElementById('addListModal');
  modal.innerHTML = addListModalHTML();
  modal.dataset.parentId = parentId || '';
  document.getElementById('newListName').value = '';
  document.getElementById('newListShortname').value = '';
  document.getElementById('newListColor').value = nextPaletteColor(state.allLists);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('newListName').focus(), 100);
}

function openAddListInSection(sectionId) {
  openAddListModal(sectionId);
}

function closeAddListModal() {
  document.getElementById('addListModal').classList.remove('visible');
}

async function saveNewList() {
  const segments = parseSectionPath(document.getElementById('newListName').value.trim());
  const shortname = document.getElementById('newListShortname').value.trim();
  const color = document.getElementById('newListColor').value;

  if (!segments.length) { showToast(t('toast.enter_name'), 'error'); return; }
  const modal = document.getElementById('addListModal');
  const startParentId = modal?.dataset.parentId || null;
  const name = segments[segments.length - 1];
  try {
    const parentId = await ensureListSectionChain(segments.slice(0, -1), startParentId);
    if (siblingNameTaken(state.allLists || [], parentId, name, null)) {
      showToast(t('toast.list_exists_at_level', name), 'error'); return;
    }
    const { error } = await state.db.from('lists').insert({
      name,
      shortname: shortname || null,
      color: color || '#14b8a6',
      sort_order: nextListSortOrder(parentId),
      kind: 'bucket', parent_id: parentId,
    });
    if (error) { showToast(t('toast.failed_to_add') + ': ' + error.message, 'error'); return; }
  } catch (e) {
    showToast(t('toast.failed_to_add') + ': ' + e.message, 'error'); return;
  }

  closeAddListModal();
  showToast(t('toast.added'), 'success');
  await refreshLists();
}

/** Fill the edit modal's parent picker: Root + sections, excluding the
 *  row being edited and its descendants. */
function populateListParentSelect(currentRow) {
  const sel = document.getElementById('editListParent');
  if (!sel) return;
  const excluded = new Set();
  if (currentRow) {
    excluded.add(currentRow.id);
    const node = _listTree.byId.get(currentRow.id);
    if (node) for (const d of descendantsOf(node)) excluded.add(d.id);
  }
  const sections = [..._listTree.byId.values()]
    .filter(n => n.kind === 'section' && !excluded.has(n.id) && n.row.name !== SHARED_LIST_NAME);
  sel.innerHTML = `<option value="">${esc(t('common.section_root'))}</option>` + sections
    .map(n => `<option value="${esc(n.id)}">${esc(pathLabelOf(n, _listTree.byId))}</option>`).join('');
  sel.value = currentRow?.parent_id || '';
}

function openEditListModal(listId) {
  const list = (state.allLists || []).find(l => l.id === listId);
  if (!list) return;
  const modal = document.getElementById('editListModal');
  modal.innerHTML = editListModalHTML();
  document.getElementById('editListId').value = listId;
  document.getElementById('editListName').value = list.name || '';
  document.getElementById('editListShortname').value = list.shortname || '';
  document.getElementById('editListColor').value = list.color || '#14b8a6';
  populateListParentSelect(list);
  modal.classList.add('visible');
  setTimeout(() => document.getElementById('editListName').focus(), 100);
}

function closeEditListModal() {
  document.getElementById('editListModal').classList.remove('visible');
}

async function saveEditList() {
  const id = document.getElementById('editListId').value;
  const list = listRowById(id);
  if (!list) return;
  const rawName = document.getElementById('editListName').value.trim();
  const shortname = document.getElementById('editListShortname').value.trim();
  const color = document.getElementById('editListColor').value;

  // Parent picker chooses the parent; a typed path overrides it.
  let targetName = rawName;
  let targetParentId = document.getElementById('editListParent')?.value || null;
  if (rawName.includes('>')) {
    const segments = parseSectionPath(rawName);
    if (!segments.length) { showToast(t('toast.enter_name'), 'error'); return; }
    targetName = segments[segments.length - 1];
    try {
      targetParentId = await ensureListSectionChain(segments.slice(0, -1), null, id);
    } catch (e) {
      showToast(t('toast.name_required'), 'error'); return;
    }
  }
  if (!targetName) { showToast(t('toast.enter_name'), 'error'); return; }
  if (siblingNameTaken(state.allLists || [], targetParentId, targetName, id)) {
    showToast(t('toast.list_exists_at_level', targetName), 'error'); return;
  }
  const isSection = isSectionRow(list);
  const updates = {
    name: targetName,
    shortname: shortname || null,
    color: color || '#14b8a6',
    parent_id: targetParentId,
    updated_at: new Date().toISOString(),
  };
  if (targetParentId !== (list.parent_id || null)) updates.sort_order = nextListSortOrder(targetParentId);

  const { error } = await state.db.from('lists').update(updates).eq('id', id);
  if (error) { showToast(t('toast.update_failed') + ': ' + error.message, 'error'); return; }

  closeEditListModal();
  showToast(t('toast.updated'), 'success');
  await refreshLists();
}

async function deleteList(listId) {
  const list = (state.allLists || []).find(l => l.id === listId);
  if (!list) return;
  if (isSectionRow(list)) { deleteListSection(listId); return; }
  const items = (state.allListItems || []).filter(i => i.list_id === listId);
  const itemCount = items.length;
  const msg = itemCount > 0
    ? `Delete "${list.name}" and its ${itemCount} item(s)?`
    : `Delete "${list.name}"?`;
  showConfirmAction(
    t('common.delete'),
    msg,
    async () => {
      // Snapshots for rollback.
      const listRow = { ...list };
      const itemRows = items.map(i => ({ ...i }));
      // Delete locally first to unblock the UI.
      if (itemCount > 0) await state.db.from('list_items').delete().eq('list_id', listId);
      const { error } = await state.db.from('lists').delete().eq('id', listId);
      if (error) { showToast(t('toast.delete_failed'), 'error'); return; }
      // Deleting a list is deleting each of its items: trash my own
      // attachments on every item, like deleteListItem does. Best-effort.
      // Exclude the whole batch from the reference check: every item in
      // this list is being deleted, so none of them counts as a surviving
      // reference to another's file.
      const excludeKeys = new Set();
      for (const item of items) { excludeKeys.add(item.id); if (item.shared_id) excludeKeys.add(item.shared_id); }
      for (const item of items) {
        try { await trashOwnItemAttachments(item, excludeKeys); } catch {}
      }
      showToast(t('toast.removed'), 'info');
      await refreshLists();
      // Delete shared items from Drive in the background (sequential, etag
      // order). A failure restores the list and its items locally.
      if (state.sharing) {
        const sharedItems = items.filter(i => i.shared_id && i.shared_group_id);
        if (sharedItems.length) {
          const upload = (async () => {
            for (const item of sharedItems) {
              await state.sharing.deleteItem(item.shared_group_id, item.shared_id);
            }
          })();
          upload.catch(async (e) => {
            console.warn('Failed to delete shared list items from Drive:', e);
            await state.db.from('lists').insert(listRow);
            for (const r of itemRows) await state.db.from('list_items').insert(r);
            await refreshLists();
            showToast(t('toast.delete_failed'), 'error');
          });
        }
      }
    }
  );
}


// ===================================================================
// EXPORTS
// ===================================================================

// ── Section delete (Lists) ───────────────────────────────────────
// Empty sections delete directly; non-empty sections ask: delete the
// subtree, or move its children up one level.
let _pendingListSectionDelete = null;

function deleteListSection(sectionId) {
  const node = _listTree.byId.get(sectionId);
  const list = listRowById(sectionId);
  if (!node || !list || !isSectionRow(list)) return;
  if (!node.children.length) {
    showConfirmAction(t('common.delete'), t('common.section_delete_empty', list.name), async () => {
      await state.db.from('lists').delete().eq('id', sectionId);
      showToast(t('toast.deleted'), 'info');
      await refreshLists();
    });
    return;
  }
  _pendingListSectionDelete = sectionId;
  const modal = document.getElementById('deleteListSectionModal');
  if (!modal) return;
  modal.innerHTML = deleteListSectionModalHTML();
  document.getElementById('deleteListSectionName').textContent = list.name;
  modal.classList.add('visible');
}

function deleteListSectionModalHTML() {
  return `<div class="modal">
    <h2>${lucideIcon('folder', 20)} ${t('common.section_delete_title')}</h2>
    <p>${t('common.section_delete_msg')} <strong id="deleteListSectionName"></strong></p>
    <div class="modal-actions">
      <button class="modal-cancel" data-action="close-delete-list-section-modal">${t('common.cancel')}</button>
      <button class="btn" data-action="delete-list-section-move-up">${t('common.section_delete_move_up')}</button>
      <button class="modal-save" data-action="delete-list-section-subtree">${t('common.section_delete_subtree')}</button>
    </div>
  </div>`;
}

function closeDeleteListSectionModal() {
  _pendingListSectionDelete = null;
  document.getElementById('deleteListSectionModal')?.classList.remove('visible');
}

async function deleteListSectionMoveUp() {
  const sectionId = _pendingListSectionDelete;
  if (!sectionId) return;
  _pendingListSectionDelete = null;
  document.getElementById('deleteListSectionModal')?.classList.remove('visible');
  const node = _listTree.byId.get(sectionId);
  if (!node) return;
  const parentId = node.parentId || null;
  const parentChildren = [..._listTree.byId.values()]
    .filter(n => (n.parentId || null) === parentId)
    .sort((a, b) => (Number(a.row.sort_order) || 0) - (Number(b.row.sort_order) || 0));
  const moving = [...node.children];
  const movingIds = new Set(moving.map(n => n.id));
  const rest = parentChildren.filter(n => n.id !== sectionId);
  const at = Math.max(0, parentChildren.findIndex(n => n.id === sectionId));
  const finalOrder = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  for (let i = 0; i < finalOrder.length; i++) {
    const n = finalOrder[i];
    const updates = { sort_order: i, updated_at: new Date().toISOString() };
    if (movingIds.has(n.id)) updates.parent_id = parentId;
    if (Number(n.row.sort_order) !== i || updates.parent_id !== undefined) {
      await state.db.from('lists').update(updates).eq('id', n.id);
    }
  }
  await state.db.from('lists').delete().eq('id', sectionId);
  showToast(t('toast.deleted'), 'info');
  await refreshLists();
}

async function deleteListSectionSubtree() {
  const sectionId = _pendingListSectionDelete;
  if (!sectionId) return;
  _pendingListSectionDelete = null;
  document.getElementById('deleteListSectionModal')?.classList.remove('visible');
  const node = _listTree.byId.get(sectionId);
  if (!node) return;
  const subtree = [node, ...descendantsOf(node)];
  const bucketIds = subtree.filter(n => n.kind === 'bucket').map(n => n.id);
  const sectionIds = subtree.filter(n => n.kind === 'section').map(n => n.id).reverse();
  const listRows = subtree.map(n => ({ ...n.row }));
  const itemRows = [];
  for (const bid of bucketIds) {
    const { data } = await state.db.from('list_items').select('*').eq('list_id', bid);
    for (const r of (data || [])) itemRows.push(r);
  }
  for (const bid of bucketIds) await state.db.from('list_items').delete().eq('list_id', bid);
  for (const bid of bucketIds) await state.db.from('lists').delete().eq('id', bid);
  for (const sid of sectionIds) await state.db.from('lists').delete().eq('id', sid);
  // Same as deleting each list: trash my own attachments on every item
  // in the subtree. Best-effort. Exclude the whole subtree from the
  // reference check — every item in it is being deleted.
  const excludeKeys = new Set();
  for (const item of itemRows) { excludeKeys.add(item.id); if (item.shared_id) excludeKeys.add(item.shared_id); }
  for (const item of itemRows) {
    try { await trashOwnItemAttachments(item, excludeKeys); } catch {}
  }
  showToast(t('toast.deleted'), 'info');
  await refreshLists();
  if (state.sharing) {
    const sharedItems = itemRows.filter(i => i.shared_id && i.shared_group_id);
    if (sharedItems.length) {
      (async () => {
        for (const item of sharedItems) await state.sharing.deleteItem(item.shared_group_id, item.shared_id);
      })().catch(async (e) => {
        console.warn('Failed to delete shared list items from Drive:', e);
        for (const r of listRows) await state.db.from('lists').insert(r);
        for (const r of itemRows) await state.db.from('list_items').insert(r);
        await refreshLists();
        showToast(t('toast.delete_failed'), 'error');
      });
    }
  }
}

// ── Shared List Items — sync pointers ─────────────────────────────

let _syncingListItems = false;
let _bulkShareInProgress = new Set();
const _pendingShare = new Set();
// ── Shared list: auto-created landing list for received shared items ──
const SHARED_LIST_NAME = '__shared__';
const _myCreatedSharedListItemIds = new Set(); // shared_ids where current user is creator

async function getOrCreateSharedList(localLists) {
  // Look for existing shared list (by internal name)
  let existing = localLists.find(l => l.name === SHARED_LIST_NAME);
  if (existing) return existing;

  const maxOrder = localLists.reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
  const { data: created, error } = await state.db.from('lists').insert({
    name: SHARED_LIST_NAME,
    color: '#a78bfa',
    icon: 'users',
    sort_order: maxOrder + 1,
  }).select().single();

  if (error) {
    console.warn('getOrCreateSharedList: failed to create', error);
    return null;
  }

  let result = created;
  if (!result?.id) {
    // Fallback: query for it
    const rows = await fetchAll(() => state.db.from('lists').select('id,name,sort_order,color,icon').eq('name', SHARED_LIST_NAME));
    result = rows?.[0] || null;
  }
  if (result) localLists.push(result);
  return result;
}

// Last-seen updated_at per shared list item: detects remote content edits,
// which change the in-memory item (and therefore the rendered view) without
// touching any local pointer row.
const _sharedListItemSeenAt = new Map();

async function syncSharedListItems() {
  if (_syncingListItems) return false;
  _syncingListItems = true;
  try {
    return await _doSyncSharedListItems();
  } finally {
    _syncingListItems = false;
  }
}
async function _doSyncSharedListItems() {
  if (!state.sharing || !state.db.connected) return;

  const sharedItems = state.sharing.getAllSharedItems().filter(i => i.item_type === 'list_item');
  const sharedById = new Map(sharedItems.map(i => [i.id, i]));

  // Get current local pointers
  let localPointers;
  try {
    const res = await fetchAll(() => state.db
      .from('list_items')
      .select('id,shared_id,shared_group_id,list_id')
      .not('shared_id', 'is', null));
    localPointers = res || [];
  } catch { localPointers = []; }

  const existingSharedIds = new Set(localPointers.map(p => p.shared_id));

  let localLists = state.allLists || [];
  if (localLists.length === 0) {
    try {
      localLists = await fetchAll(() => state.db
        .from('lists')
        .select('id,name,sort_order')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }));
    } catch { localLists = []; }
  }

  let localItemsForOrder = state.allListItems || [];
  if (localItemsForOrder.length === 0) {
    try {
      localItemsForOrder = await fetchAll(() => state.db
        .from('list_items')
        .select('id,list_id,sort_order'));
    } catch { localItemsForOrder = []; }
  }

  let needsRefresh = false;

  // Remote content edits bump updated_at on every mutation — a change here
  // means the rendered item changed even though no pointer row moved.
  for (const sh of sharedItems) {
    const prevSeen = _sharedListItemSeenAt.get(sh.id);
    _sharedListItemSeenAt.set(sh.id, sh.updated_at);
    if (prevSeen !== undefined && prevSeen !== sh.updated_at) needsRefresh = true;
  }

  // Create pointers for new shared items — always land in the "Shared" list
  for (const sh of sharedItems) {
    if (existingSharedIds.has(sh.id)) continue;

    // Skip items this tab staged but hasn't planted a pointer for yet —
    // the share flow inserts the real pointer right after staging. Without
    // this the sync would plant a duplicate in the Shared list.
    if (state.sharing.hasPendingCreate(sh.group_id, sh.id)) continue;

    let targetList = await getOrCreateSharedList(localLists);
    if (!targetList) continue;

    // DB check to prevent race duplicates
    try {
      const existing = await fetchAll(() => state.db
        .from('list_items')
        .select('id')
        .eq('shared_id', sh.id));
      if (existing && existing.length > 0) continue;
    } catch { /* proceed */ }

    const items = localItemsForOrder.filter(i => i.list_id === targetList.id);
    const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);

    await state.db.from('list_items').insert({
      list_id: targetList.id,
      text: '',
      sort_order: maxOrder + 1,
      shared_id: sh.id,
      shared_group_id: sh.group_id,
    });
    needsRefresh = true;
  }

  // Remove pointers for deleted shared items
  for (const ptr of localPointers) {
    if (!sharedById.has(ptr.shared_id)) {
      const group = state.sharing?.getAllGroups().find(g => g.id === ptr.shared_group_id);
      if (group) {
        // Group exists but item gone from remote → delete local pointer
        await state.db.from('list_items').delete().eq('id', ptr.id);
        _sharedListItemSeenAt.delete(ptr.shared_id);
        needsRefresh = true;
      }
      // else: group not loaded — transient skip, or the group was dropped and
      // its pointers were already purged. Leave the pointer; the next sync
      // re-evaluates it.
    }
  }

  return needsRefresh;
}

async function shareListItemFromAdd(btn, listId) {
  // Delegation support: btn may be an event, button element, or legacy list id.
  let actualBtn = btn;
  let actualListId = listId;
  if (typeof btn === 'string') {
    actualListId = btn;
    const safeListId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(btn) : btn.replace(/"/g, '\\"');
    actualBtn = document.querySelector(`[data-action="share-list-item-from-add"][data-list-id="${safeListId}"]`);
  } else if (btn && btn.target) {
    // event case
    actualBtn = btn.target.closest ? btn.target.closest('[data-action="share-list-item-from-add"]') : btn.target;
    actualListId = actualBtn ? actualBtn.dataset.listId : listId;
  } else if (btn && btn.dataset && btn.dataset.listId) {
    actualListId = btn.dataset.listId || listId;
    actualBtn = btn;
  }
  const addRow = actualBtn && typeof actualBtn.closest === 'function' ? actualBtn.closest('.list-quick-add') : null;
  if (!addRow) return;
  const input = addRow.querySelector('.list-quick-input');
  const text = input?.value.trim();
  if (!text) return;
  const guardKey = `add-${actualListId}`;
  if (_pendingShare.has(guardKey)) return;

  // Find list name for payload context
  const listObj = (state.allLists || []).find(l => l.id === actualListId);

  openSharePopover(actualBtn, (groupId) => {
    if (_pendingShare.has(guardKey)) return;
    _pendingShare.add(guardKey);
    if (actualBtn) { actualBtn.disabled = true; actualBtn.classList.add('is-pending'); actualBtn.setAttribute('aria-busy', 'true'); }

    // Resolves once the shared item is staged in memory, before the Drive upload.
    let onStaged;
    const staged = new Promise(resolve => { onStaged = resolve; });

    (async () => {
      // Pre-generate UUID for pointer → Drive linkage
      const presetId = crypto.randomUUID();

      // 1. Insert local pointer FIRST (prevents race with syncSharedListItems)
      const items = (state.allListItems || []).filter(i => i.list_id === actualListId);
      const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
      const { error: ptrErr } = await state.db.from('list_items').insert({
        list_id: actualListId,
        text: '',
        sort_order: maxOrder + 1,
        shared_id: presetId,
        shared_group_id: groupId,
      });
      if (ptrErr) { showToast(t('toast.failed_to_add') + ': ' + ptrErr.message, 'error'); return; }

      // 2. The shared upload runs in the background: success toasts, failure
      // rolls the pointer row back and restores the typed text.
      const upload = state.sharing.addItem(groupId, {
        id: presetId,
        item_type: 'list_item',
        payload: { text, list_name: listObj?.name || '' },
        onStaged,
      });
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (driveErr) => {
          await state.db.from('list_items').delete().eq('shared_id', presetId);
          input.value = text;
          await refreshLists();
          showToast(driveErr.message, 'error');
        }
      );

      // Unblock the UI once the item is staged in memory — don't wait for the
      // upload. If the upload fails before staging, the failure branch above
      // handles the rollback, so don't hang here.
      await Promise.race([staged, upload.then(() => {}, () => {})]);

      input.value = '';
      await refreshLists();
    })().catch(e => showToast(e.message, 'error'))
      .finally(() => {
        _pendingShare.delete(guardKey);
        if (actualBtn) { actualBtn.disabled = false; actualBtn.classList.remove('is-pending'); actualBtn.removeAttribute('aria-busy'); }
      });
  }, { showAssignees: false });
}
window.shareListItemFromAdd = shareListItemFromAdd;

// Grant every other joined member reader access to the item's attached
// files, before the payload carrying their links goes out. Returns
// { ok, granted } — granted lists, per file, the member ids newly granted
// in this call (shareFileWithGroup reports only the members it newly
// granted, never members who already had access). On the first failure
// the grants already issued are rolled back, so a failed share leaves
// nothing readable behind; the caller must not publish the payload then.
// (The upload path shares the same way, after the upload and before the
// payload save.)
async function shareAttachmentsWithGroup(groupId, attachments) {
  const granted = [];
  for (const a of attachments) {
    try {
      const memberIds = await state.sharing.shareFileWithGroup(groupId, a.drive_file_id, 'reader');
      if (memberIds && memberIds.length) granted.push({ fileId: a.drive_file_id, memberIds });
    } catch (e) {
      console.warn('Failed to share attachment with group:', e);
      await rollbackAttachmentGrants(groupId, granted);
      return { ok: false, granted: [] };
    }
  }
  return { ok: true, granted };
}

// Best-effort rollback of grants issued by shareAttachmentsWithGroup:
// revoke only the members newly granted in this operation, never members
// who already had access. A failed revoke is logged, never thrown.
async function rollbackAttachmentGrants(groupId, granted) {
  for (const g of granted || []) {
    try {
      await state.sharing.revokeFileWithGroup?.(groupId, g.fileId, g.memberIds);
    } catch (e) {
      console.warn('Failed to roll back attachment grants:', e);
    }
  }
}

async function shareExistingListItem(id, el) {
  if (!state.sharing) return;
  if (_pendingShare.has(id)) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || item.shared_id) return;
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="share-existing-list-item"][data-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  const listObj = (state.allLists || []).find(l => l.id === item.list_id);
  openSharePopover(btn, async (groupId) => {
    if (_pendingShare.has(id)) return;
    _pendingShare.add(id);
    if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
    try {
      const sharedId = crypto.randomUUID();
      const attachments = normalizeAttachments(item.attachments);
      const payload = sharedListItemPayload(item, listObj);
      // Share each attached file with the group BEFORE the payload goes
      // out — members must be able to open the links the moment the item
      // appears for them. A failure aborts the share outright: the item
      // stays personal and nothing is staged (a partial grant is rolled
      // back inside shareAttachmentsWithGroup).
      const shareResult = attachments.length
        ? await shareAttachmentsWithGroup(groupId, attachments)
        : { ok: true, granted: [] };
      if (!shareResult.ok) {
        showToast(t('lists.share_attachments_failed'), 'error');
        return;
      }
      // The grants went out before the payload — every failure path below
      // rolls them back, or the group keeps read access to files that were
      // never shared. Exactly once: the background rejection handler and
      // the !wasStaged branch below can both fire for one failed upload,
      // and the revoke is idempotent but the Drive calls should not double.
      let grantsRolledBack = false;
      const rollBackGrantsOnce = async () => {
        if (grantsRolledBack) return;
        grantsRolledBack = true;
        await rollbackAttachmentGrants(groupId, shareResult.granted);
      };
      // 1. Stage the shared item in memory first: this marks the created
      // intent and the dirty type, so the poll skips it and the
      // orphan-pointer cleanup can't see a pointer whose item isn't staged.
      // The snapshot allows a full rollback if the Drive upload fails.
      const personalItem = { ...item };
      let onStaged;
      let wasStaged = false;
      const staged = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
      let localStaged = false;
      // 2. The shared upload runs in the background: success toasts, failure
      // drops the pointer and restores the personal item — but only when the
      // local staging below actually happened.
      const upload = state.sharing.addItem(groupId, {
        id: sharedId,
        item_type: 'list_item',
        payload,
        onStaged,
      });
      upload.then(
        () => showToast(t('sharing.shared') + '!', 'success'),
        async (e) => {
          console.error('[DeLaClaw] share existing list item failed:', e);
          await rollBackGrantsOnce();
          if (localStaged) {
            await state.db.from('list_items').delete().eq('shared_id', sharedId);
            await state.db.from('list_items').insert(personalItem);
            await refreshLists();
          }
          showToast(e.message, 'error');
        }
      );
      await Promise.race([staged, upload.then(() => {}, () => {})]);
      if (!wasStaged) {
        await rollBackGrantsOnce();
        return;
      }
      // 3. Stage locally: pointer in, personal item out.
      const { error: ptrErr } = await state.db.from('list_items').insert({
        list_id: item.list_id,
        text: '',
        sort_order: item.sort_order || 0,
        shared_id: sharedId,
        shared_group_id: groupId,
      });
      if (ptrErr) {
        // Back out the staged shared item — it hasn't uploaded yet — and
        // the grants, or the group keeps access to files never shared.
        state.sharing.deleteItem(groupId, sharedId).catch(() => {});
        await rollBackGrantsOnce();
        showToast(t('toast.failed_to_add') + ': ' + ptrErr.message, 'error');
        return;
      }
      await state.db.from('list_items').delete().eq('id', item.id);
      localStaged = true;
      await refreshLists();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      _pendingShare.delete(id);
      if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
    }
  }, { showAssignees: false });
}
window.shareExistingListItem = shareExistingListItem;

// ── Bulk share all personal items in a list ──
async function bulkShareList(listId, el) {
  if (!state.sharing) return;
  if (_bulkShareInProgress.has(listId)) return;
  const listItems = (state.allListItems || []).filter(i => i.list_id === listId && !i.shared_id);
  if (!listItems.length) { showToast(t('sharing.share_all_nothing'), 'info'); return; }
  const listObj = (state.allLists || []).find(l => l.id === listId);
  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="bulk-share-list"][data-id="${CSS.escape(listId)}"]`);
  if (!btn) return;
  openSharePopover(btn, async (groupId) => {
    const msg = t('sharing.share_all_confirm', listItems.length);
    showConfirmAction(
      t('sharing.share_all'),
      msg,
      async () => {
        if (_bulkShareInProgress.has(listId)) return;
        _bulkShareInProgress.add(listId);
        if (btn) { btn.disabled = true; btn.classList.add('is-pending'); btn.setAttribute('aria-busy', 'true'); }
        try {
          // Stage each item in the shared memory first, then plant the local
          // pointer: the created intent and dirty type keep the poll and the
          // orphan-pointer cleanup from misreading the in-between state. The
          // debounced flush uploads everything in one go.
          const staged = [];
          for (const item of listItems) {
            const sharedId = crypto.randomUUID();
            const attachments = normalizeAttachments(item.attachments);
            const payload = sharedListItemPayload(item, listObj);
            // Files first, payload second — same as the single-item share.
            // A file-share failure skips this item (it stays personal);
            // the partial grant is rolled back inside
            // shareAttachmentsWithGroup. The final toast reports the
            // partial share.
            const shareResult = attachments.length
              ? await shareAttachmentsWithGroup(groupId, attachments)
              : { ok: true, granted: [] };
            if (!shareResult.ok) {
              console.error('[DeLaClaw] bulk share list item file-share failed:', sharedId);
              continue;
            }
            let onStaged;
            let wasStaged = false;
            const stagedP = new Promise(resolve => { onStaged = () => { wasStaged = true; resolve(); }; });
            const upload = state.sharing.addItem(groupId, {
              id: sharedId,
              item_type: 'list_item',
              payload,
              onStaged,
            });
            await Promise.race([stagedP, upload.then(() => {}, () => {})]);
            if (!wasStaged) {
              console.error('[DeLaClaw] bulk share list item staging failed:', sharedId);
              await rollbackAttachmentGrants(groupId, shareResult.granted);
              continue;
            }
            const { error: ptrErr } = await state.db.from('list_items').insert({
              list_id: listId,
              text: '',
              sort_order: item.sort_order ?? 0,
              shared_id: sharedId,
              shared_group_id: groupId,
            });
            if (ptrErr) {
              // Back out the staged shared item — it hasn't uploaded yet —
              // and the grants, or the group keeps access to files never shared.
              state.sharing.deleteItem(groupId, sharedId).catch(() => {});
              await rollbackAttachmentGrants(groupId, shareResult.granted);
              continue;
            }
            await state.db.from('list_items').delete().eq('id', item.id);
            staged.push({
              sharedId,
              upload,
              granted: shareResult.granted,
              personalItem: { ...item },
            });
          }
          // Unblock the UI on staging.
          await refreshLists();
          _bulkShareInProgress.delete(listId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
          let ok = 0;
          for (const s of staged) {
            try {
              await s.upload;
              ok++;
            } catch (e) {
              console.error('[DeLaClaw] bulk share list item failed:', e);
              await rollbackAttachmentGrants(groupId, s.granted);
              await state.db.from('list_items').delete().eq('shared_id', s.sharedId);
              await state.db.from('list_items').insert(s.personalItem);
            }
          }
          await refreshLists();
          if (ok === staged.length && ok > 0) showToast(t('sharing.share_all_done', ok), 'success');
          else if (ok > 0) showToast(t('sharing.share_all_partial', ok, staged.length), 'error');
          else if (staged.length > 0) showToast(t('toast.failed_to_add'), 'error');
        } finally {
          _bulkShareInProgress.delete(listId);
          if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); btn.removeAttribute('aria-busy'); }
        }
      },
      null,
      { variant: 'neutral', btnText: t('sharing.share_all'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
    );
  }, { showAssignees: false });
}
window.bulkShareList = bulkShareList;

// ── Unshare list item (creator only): move shared item back to personal ──
async function unshareListItem(id, el) {
  if (!state.sharing) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || !item.shared_id || !item.shared_group_id) return;

  showConfirmAction(
    t('sharing.unshare'),
    t('sharing.unshare_confirm'),
    async () => {
      const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="unshare-list-item"][data-id="${CSS.escape(id)}"]`);
      if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
      try {
        const pointerRow = { ...item };
        // 1. Create personal list item (same list) — keeping the original
        // attachments, still pointing at the shared files (v2.32.136).
        const { data: newItem, error: insErr } = await state.db.from('list_items').insert({
          list_id: item.list_id,
          text: item.text || '',
          note: item.note || '',
          checked: item.checked ? 1 : 0,
          sort_order: item.sort_order || 0,
          attachments: serializeAttachments(item.attachments),
        }).select().single();
        if (insErr) { showToast(insErr.message, 'error'); return; }
        // 2. Delete the local pointer
        await state.db.from('list_items').delete().eq('id', item.id);
        // 3. Unblock the UI on local staging; the shared delete runs in the
        // background. A failure drops the personal copy and restores the pointer.
        await refreshLists();
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
        let onStaged;
        const staged = new Promise(resolve => { onStaged = resolve; });
        const upload = state.sharing.deleteItem(item.shared_group_id, item.shared_id, { onStaged });
        upload.then(
          async () => {
            // Revoke on unshare (v2.32.135): the group loses access to MY
            // files on this item. Another member's files keep their grants
            // — only their owner can revoke them. Best-effort, silent.
            for (const a of ownAttachmentFiles(item.attachments, await myAttachmentUploaderId(item))) {
              try { await state.sharing?.revokeFileWithGroup?.(item.shared_group_id, a.drive_file_id); } catch (err) {
                console.warn(`sharing: revoke on unshare failed for ${a.drive_file_id}:`, err);
              }
            }
            showToast(t('sharing.unshared'), 'success');
          },
          async (e) => {
            console.warn('Failed to delete shared list item from Drive:', e);
            if (newItem?.id) await state.db.from('list_items').delete().eq('id', newItem.id);
            await state.db.from('list_items').insert(pointerRow);
            await refreshLists();
            showToast(e.message, 'error');
          }
        );
        await Promise.race([staged, upload.then(() => {}, () => {})]);
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
      }
    },
    null,
    { variant: 'neutral', btnText: t('sharing.unshare'), iconSvg: lucideIcon('share', 28), btnIconSvg: lucideIcon('share', 15, 'currentColor') }
  );
}
window.unshareListItem = unshareListItem;

// ── Copy list item to personal (non-creator) ──
async function copyListItemToPersonal(id, el) {
  if (!state.sharing) return;
  const item = (state.allListItems || []).find(i => i.id === id);
  if (!item || !item.shared_id || !item.shared_group_id) return;

  const btn = el instanceof HTMLElement ? el : document.querySelector(`[data-action="copy-list-item-to-personal"][data-id="${CSS.escape(id)}"]`);
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try {
    // Place copy in the same list as the shared item, unless it's the __shared__ list
    const itemList = (state.allLists || []).find(l => l.id === item.list_id);
    let personalList = (itemList && itemList.name !== '__shared__' && !isSectionRow(itemList)) ? itemList : (state.allLists || []).find(l => l.name !== '__shared__' && !isSectionRow(l));
    if (!personalList) {
      // Auto-create a personal list
      const maxOrder = (state.allLists || []).reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
      const { data: newList, error: listErr } = await state.db.from('lists').insert({
        name: t('lists.default_list_name') || 'My List',
        sort_order: maxOrder + 1,
      }).select().single();
      if (listErr || !newList) { showToast(listErr?.message || 'Failed to create list', 'error'); return; }
      personalList = newList;
    }
    const items = (state.allListItems || []).filter(i => i.list_id === personalList.id);
    const maxItemOrder = items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
    const { error: insErr } = await state.db.from('list_items').insert({
      list_id: personalList.id,
      text: item.text || '',
      note: item.note || '',
      checked: item.checked ? 1 : 0,
      sort_order: maxItemOrder + 1,
      // Keep the original attachments, still pointing at the shared files
      // (v2.32.136) — same rule as the leave-flow keep-copies.
      attachments: serializeAttachments(item.attachments),
    });
    if (insErr) { showToast(insErr.message, 'error'); return; }
    showToast(t('sharing.copied_to_personal'), 'success');
    await refreshLists();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}
window.copyListItemToPersonal = copyListItemToPersonal;

document.addEventListener('input', e => {
  if (e.target.tagName === 'TEXTAREA' && e.target.classList.contains('list-quick-input')) {
    autoResizeTextarea(e.target);
  }
});

export { refreshLists, renderLists, initListModals, syncSharedListItems, getListPath };

// Window bindings
window.openAddListModal = openAddListModal;
window.openAddListInSection = openAddListInSection;
window.closeAddListModal = closeAddListModal;
window.saveNewList = saveNewList;
window.openEditListModal = openEditListModal;
window.closeEditListModal = closeEditListModal;
window.saveEditList = saveEditList;
window.deleteList = deleteList;
window.deleteListSection = deleteListSection;
window.closeDeleteListSectionModal = closeDeleteListSectionModal;
window.deleteListSectionMoveUp = deleteListSectionMoveUp;
window.deleteListSectionSubtree = deleteListSectionSubtree;
window.navigateToList = navigateToList;
window.navigateToListSection = navigateToListSection;
window.renderLists = renderLists;
window.quickAddListItem = quickAddListItem;
window.toggleListItemCheck = toggleListItemCheck;
window.editListItemInline = editListItemInline;
window.editListItemInlineFull = editListItemInlineFull;
window.deleteListItem = deleteListItem;
window.attachToListItem = attachToListItem;
window.removeListItemAttachment = removeListItemAttachment;
window.cancelListItemAttachment = cancelListItemAttachment;
window.retryListItemAttachment = retryListItemAttachment;
window.filterLists = function(e) { listSearchQuery = e.target.value; renderLists(); };
