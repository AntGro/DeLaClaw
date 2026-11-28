import { lucideIcon } from './icons.js';
import state from './state.js';
import { esc, escQ, showToast, showConfirmAction } from './utils.js';
import { t } from './i18n.js';

// ===================================================================
// ATTACHMENTS — SHARED MECHANISM FOR LIST ITEMS, TODOS AND HABITS
// ===================================================================
// Drive-only (the upload needs the Drive adapter, absent in Demo/Local).
// One record shape everywhere: { drive_file_id, name, size, url,
// uploaded_by }. Canonical storage is a JSON string in the item's
// `attachments` TEXT column (and a real array in the sharing payload);
// in-memory item.attachments is always the parsed, validated array.
// The Drive transport itself (upload, resumable chunks, folder ops)
// lives in js/adapters/drive.js and is item-type-agnostic: the caller
// supplies the folder key (shared_id when shared, local id otherwise).

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
// The files the current user may trash on delete: only their own.
// uploaded_by is compulsory on every record since v2.32.127, so a record
// never matches without an uploader — and when the id cannot be resolved
// at all, nothing is trashed.
function ownAttachmentFiles(attachments, myId) {
  if (!myId) return [];
  return normalizeAttachments(attachments).filter(a => a.uploaded_by === myId);
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

// Pure: the display name of a member id in a members list, or null when
// the member is not found (left the group, or the id predates the row).
// The invited label is the fallback — it is what the UI shows for a
// member with no display name yet.
function memberDisplayName(members, memberId) {
  const m = (members || []).find(x => x && x.member_id === memberId);
  return m?.display_name || m?.invited_label || null;
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

// All drive_file_ids referenced by local items other than the excluded
// ones — plus the shared payloads in groups I'm in. A file referenced by
// any of these must not be trashed. (v2.32.138)
// The shared scan reads both shapes: TODOs and list items carry their
// attachments in the payload, habits carry them top-level on the shared
// item. Limit: another member's PERSONAL copy is invisible to this
// client — it references the file without any trace here — so the check
// cannot cover it; deleting the last visible reference can still dangle
// a personal copy elsewhere. Only the file owner can trash it, and the
// trash is recoverable from Drive for 30 days.
function referencedAttachmentFileIds(localItems, excludeKeys) {
  const ids = referencedFileIdsFromItems(localItems || [], excludeKeys);
  try {
    for (const si of state.sharing?.getAllSharedItems?.() || []) {
      if (!si || excludeKeys.has(si.id)) continue;
      for (const a of normalizeAttachments(si.payload?.attachments ?? si.attachments)) ids.add(a.drive_file_id);
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
// blocks the deletion. Shared by item delete, list/category delete and
// section delete: deleting a container is deleting each of its items.
// A file still referenced by another item is never trashed (v2.32.138):
// the same file can be linked from several items since keep-copies and
// copy-to-personal carry the records as-is. excludeKeys is the set of
// item keys (local ids and shared ids) whose references don't count —
// the item(s) being deleted. Defaults to this item's own keys.
async function trashOwnItemAttachments(item, localItems, excludeKeys = null) {
  const exclude = excludeKeys || new Set([item.id, item.shared_id].filter(Boolean));
  const referenced = referencedAttachmentFileIds(localItems, exclude);
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

// Share each attached file with the group BEFORE the payload goes out —
// members must be able to open the links the moment the item appears
// for them. Returns { ok, granted } where granted is per file the member
// ids newly granted in this call; on the first failure the grants
// already issued are rolled back, so a failed share leaves nothing
// readable behind; the caller must not publish the payload then.
// (The upload path shares the same way, after the upload and before
// the payload save.)
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

// ── Chips ──
// Attachments render as link chips under the item — only the link is
// stored on the item, the file itself is never fetched on page load.
// Pending uploads render as chips too (ring instead of a link), so the
// user sees them the moment files are picked.
function attachmentsHtml(item, { pending = [], actions = null, removable = true, i18nPrefix = 'lists' } = {}) {
  const attachments = normalizeAttachments(item.attachments);
  if (!attachments.length && !pending.length) return '';
  return `<div class="item-attachments">${attachments.map(a => {
    const uploader = attachmentUploaderName(item, a.uploaded_by);
    const title = uploader ? `${a.name} — ${t(`${i18nPrefix}.attachment_uploaded_by`, uploader)}` : a.name;
    return `
      <span class="attachment-chip">
        ${isDriveAttachmentUrl(a.url)
          ? `<a href="${escQ(a.url)}" target="_blank" rel="noopener" title="${escQ(title)}">${lucideIcon('paperclip', 12)} ${esc(a.name)} <span class="attachment-size">${esc(formatFileSize(a.size))}</span></a>`
          : `<span title="${escQ(title)}">${lucideIcon('paperclip', 12)} ${esc(a.name)} <span class="attachment-size">${esc(formatFileSize(a.size))}</span></span>`}
        ${removable && actions?.remove ? `<button data-action="${actions.remove}" data-id="${esc(item.id)}" data-attachment-id="${esc(a.drive_file_id)}" title="${t(`${i18nPrefix}.remove_attachment`)}" aria-label="${t(`${i18nPrefix}.remove_attachment`)}">${lucideIcon('x', 12)}</button>` : ''}
      </span>`;}).join('')}${pending.map(p => pendingAttachmentChipHtml(item, p, actions, i18nPrefix)).join('')}</div>`;
}

// ── Upload queue ──
// Pending state is memory-only (itemId -> pendingId -> entry with
// file/progress/status/AbortController) — a reload drops it and the
// upload dies with the page. The upload and its state live outside the
// view, so navigating away mid-upload changes nothing — the chip
// re-renders with its current progress when the item is shown again.
// One queue per item type (one file at a time per item); the pending
// maps are shared because item ids are UUIDs across all types.
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
  const chip = document.querySelector(`.attachment-chip[data-pending-id="${CSS.escape(pendingId)}"]`);
  const fg = chip?.querySelector('.att-progress-ring-fg');
  if (fg) fg.style.strokeDashoffset = String(ATTACHMENT_RING_C * (1 - Math.max(0, Math.min(1, progress))));
}

function pendingAttachmentChipHtml(item, p, actions, i18nPrefix) {
  const act = actions || {};
  const btns = p.status === 'error'
    ? `${act.retry ? `<button data-action="${act.retry}" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t(`${i18nPrefix}.retry_upload`)}" aria-label="${t(`${i18nPrefix}.retry_upload`)}">${lucideIcon('rotate-ccw', 12)}</button>` : ''}
       ${act.cancel ? `<button data-action="${act.cancel}" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t(`${i18nPrefix}.remove_attachment`)}" aria-label="${t(`${i18nPrefix}.remove_attachment`)}">${lucideIcon('x', 12)}</button>` : ''}`
    : `${act.cancel ? `<button data-action="${act.cancel}" data-id="${esc(item.id)}" data-pending-id="${esc(p.id)}" title="${t(`${i18nPrefix}.cancel_upload`)}" aria-label="${t(`${i18nPrefix}.cancel_upload`)}">${lucideIcon('x', 12)}</button>` : ''}`;
  return `<span class="attachment-chip pending${p.status === 'error' ? ' error' : ''}" data-pending-id="${esc(p.id)}">
    ${attachmentProgressRing(p.progress)}<span class="attachment-name" title="${escQ(p.file.name)}">${esc(p.file.name)} <span class="attachment-size">${esc(formatFileSize(p.file.size))}</span></span>${btns}
  </span>`;
}

// One queue per item type. The per-type parts are the item lookup, the
// save path (column for personal items, shared payload/object for shared
// ones), the re-render, and the data-action names on the chips.
// getLocalItems supplies the collection for the reference check on remove.
function createAttachmentQueue({ getItem, getLocalItems, itemAlive, saveAttachments, render, actions, i18nPrefix }) {
  async function attach(itemId, btnEl) {
    const item = getItem(itemId);
    if (!item) return;
    if (typeof state.driveAdapter?.uploadAttachment !== 'function') {
      showToast(t(`${i18nPrefix}.attach_unavailable`), 'error');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'attachment-picker';
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
      render();
      processQueue(item);
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
  async function processQueue(item) {
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
        showToast(t(`${i18nPrefix}.attachment_no_uploader`), 'error');
        render();
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
          // published link must not linger.
          let grantedIds = [];
          if (item.shared_id && item.shared_group_id && state.sharing) {
            entry.status = 'sharing';
            try {
              grantedIds = await state.sharing.shareFileWithGroup(item.shared_group_id, record.drive_file_id, 'reader') || [];
            } catch (e) {
              console.warn('Failed to share attachment with group:', e);
              showToast(t(`${i18nPrefix}.attachment_share_failed`), 'error');
              entry.status = 'error';
              entry.error = e;
              render();
              continue;
            }
            if (entry.status === 'cancelled') {
              if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
              continue;
            }
          }
          // Save this record now — the chip turns real without waiting for
          // its siblings still in the queue.
          if (!itemAlive(item)) {
            if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
            pending.delete(entry.id);
            continue; // the item was deleted meanwhile; the file stays orphaned in Drive
          }
          const next = [...normalizeAttachments(item.attachments), record];
          try {
            await saveAttachments(item, next);
          } catch {
            if (grantedIds.length) await rollbackAttachmentGrants(item.shared_group_id, [{ fileId: record.drive_file_id, memberIds: grantedIds }]);
            showToast(t('toast.update_failed'), 'error');
            entry.status = 'error';
            entry.error = new Error('save failed');
            render();
            continue;
          }
          pending.delete(entry.id);
          added.push(record);
          item.attachments = next;
          render();
        } catch (e) {
          if (e?.code === 'aborted' || entry.status === 'cancelled') {
            pending.delete(entry.id);
            render();
            continue;
          }
          entry.status = 'error';
          entry.error = e;
          showToast(t(`${i18nPrefix}.attachment_upload_failed`), 'error');
          render();
        }
      }
      if (!pending.size) _pendingAttachments.delete(item.id);
      if (added.length) showToast(t(`${i18nPrefix}.attachment_added`), 'success');
    } finally {
      _attachmentQueueRunning.delete(item.id);
    }
  }

  /** Cancel (or dismiss) a pending attachment: aborts the in-flight XHR when it is uploading. */
  function cancel(itemId, pendingId, btnEl) {
    const pending = _pendingAttachments.get(itemId);
    const entry = pending?.get(pendingId);
    if (!entry) return;
    if (entry.status === 'uploading' || entry.status === 'sharing') {
      entry.status = 'cancelled';
      entry.controller.abort(); // the queue's catch drops the chip
    } else {
      pending.delete(pendingId);
      if (!pending.size) _pendingAttachments.delete(itemId);
      render();
    }
  }

  /** Re-queue a failed upload (fresh AbortController, progress back to 0). */
  function retry(itemId, pendingId, btnEl) {
    const entry = _pendingAttachments.get(itemId)?.get(pendingId);
    if (!entry || entry.status !== 'error') return;
    entry.status = 'queued';
    entry.progress = 0;
    entry.error = null;
    entry.controller = new AbortController();
    render();
    const item = getItem(itemId);
    if (item) processQueue(item);
  }

  async function remove(itemId, driveFileId, btnEl) {
    const item = getItem(itemId);
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
          await saveAttachments(item, next);
        } catch {
          showToast(t('toast.update_failed'), 'error');
          return;
        }
        item.attachments = next;
        render();
        // Best-effort: trash the Drive file so it doesn't linger orphaned —
        // but only when it is mine. Removing another member's chip removes
        // the record from the payload (any member may edit a shared item);
        // their file stays untouched in their Drive.
        const myId = await myAttachmentUploaderId(item);
        if (myId && target.uploaded_by === myId) {
          // Reference check (v2.32.138): another item may still link this
          // file — the record is already gone from this item, so any hit
          // is a surviving reference, and the file is left alone.
          const referenced = referencedAttachmentFileIds(getLocalItems(), new Set([item.id, item.shared_id].filter(Boolean)));
          if (!referenced.has(driveFileId)) {
            try { await state.driveAdapter?.trashAttachmentFile?.(driveFileId); } catch {}
          }
        }
        showToast(t(`${i18nPrefix}.attachment_removed`), 'success');
      }
    );
  }

  return {
    attach,
    cancel,
    retry,
    remove,
    pendingFor: (itemId) => [...(_pendingAttachments.get(itemId)?.values() || [])],
  };
}

export {
  normalizeAttachments, serializeAttachments, formatFileSize, isDriveAttachmentUrl,
  ownAttachmentFiles, referencedFileIdsFromItems, memberDisplayName,
  myAttachmentUploaderId, referencedAttachmentFileIds, attachmentUploaderName,
  trashOwnItemAttachments, shareAttachmentsWithGroup, rollbackAttachmentGrants,
  attachmentsHtml, createAttachmentQueue,
};
