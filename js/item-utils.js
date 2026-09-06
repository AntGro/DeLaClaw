// ===================================================================
// SHARED ITEM UTILITIES — used by projects.js and todos.js
// ===================================================================

import { showToast, isTouchDevice } from './utils.js';
import { t } from './i18n.js';
import { lucideIcon } from './icons.js';
import db from './db.js';

// ===================================================================
// SHARED DRAG STATE
// ===================================================================
export let isDragging = false;
export function setDragging(v) { isDragging = v; }

export const LONG_PRESS_MS = 100;
export const DRAG_THRESHOLD = 5;
export const DRAG_CLONE_SELECTOR = '[data-drag-clone="true"]';
export const DRAG_SOURCE_SELECTOR = '[data-drag-source="true"]';

const dragCleanupCallbacks = new Set();
let dragCleanupListenersBound = false;

export function markDragClone(clone) {
  clone.dataset.dragClone = 'true';
  clone.setAttribute('aria-hidden', 'true');
  return clone;
}

export function markDragSource(el) {
  if (el) el.dataset.dragSource = 'true';
}

export function unmarkDragSource(el) {
  if (el) delete el.dataset.dragSource;
}

function removeDragArtifacts() {
  document.querySelectorAll(DRAG_CLONE_SELECTOR).forEach(el => el.remove());
  document.querySelectorAll(DRAG_SOURCE_SELECTOR).forEach(el => {
    el.classList.remove('dragging');
    unmarkDragSource(el);
  });
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.body.style.userSelect = '';
  document.body.style.webkitUserSelect = '';
  setDragging(false);
}

function runDragCleanups({ complete = false } = {}) {
  const callbacks = Array.from(dragCleanupCallbacks);
  for (const cleanup of callbacks) {
    try { cleanup({ complete }); }
    catch (e) { console.warn('Drag cleanup failed:', e); }
  }
  removeDragArtifacts();
}

function ensureDragCleanupListeners() {
  if (dragCleanupListenersBound) return;
  dragCleanupListenersBound = true;
  document.addEventListener('pointerup', () => runDragCleanups({ complete: true }));
  document.addEventListener('pointercancel', () => runDragCleanups({ complete: false }));
  document.addEventListener('contextmenu', () => runDragCleanups({ complete: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) runDragCleanups({ complete: false });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') runDragCleanups({ complete: false });
  });
  window.addEventListener('blur', () => runDragCleanups({ complete: false }));
}

export function registerDragCleanup(cleanup) {
  ensureDragCleanupListeners();
  dragCleanupCallbacks.add(cleanup);
  return () => dragCleanupCallbacks.delete(cleanup);
}

export function cleanupDragArtifacts() {
  runDragCleanups({ complete: false });
}

export function resetDragVisuals() {
  removeDragArtifacts();
}


// ===================================================================
// HOVER DELAY — show action buttons on hover / single-click
// ===================================================================
// Replaces initTaskHoverDelay (projects) and initTodoHoverDelay (todos)
export function initItemHoverDelay(container, {
  itemSelector,
  actionsSelector,
  rowSelector,
  textSelector,
  editingSelector = '.task-edit-input',
  onDblClick,
}) {
  const isTouch = isTouchDevice();

  // Track currently-visible actions so tapping elsewhere hides them
  let _activeActionsItem = null;

  function hideActiveActions() {
    if (_activeActionsItem) {
      const a = _activeActionsItem.querySelector(actionsSelector);
      if (a) a.classList.remove('visible');
      _activeActionsItem = null;
    }
  }

  // Dismiss actions when tapping outside on touch devices
  if (isTouch) {
    document.addEventListener('click', (e) => {
      if (_activeActionsItem && !_activeActionsItem.contains(e.target)) {
        hideActiveActions();
      }
    });
  }

  container.querySelectorAll(itemSelector).forEach(item => {
    let hoverTimer = null;
    let clickTimer = null;
    const actions = item.querySelector(actionsSelector);
    const row = item.querySelector(rowSelector);
    const text = item.querySelector(textSelector);

    if (!isTouch) {
      // Desktop: hover & single-click → show action buttons
      if (actions && row) {
        item.addEventListener('mouseenter', () => {
          hoverTimer = setTimeout(() => {
            if (item.querySelector(editingSelector)) return;
            actions.classList.add('visible');
          }, 2000);
        });

        item.addEventListener('mouseleave', () => {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          actions.classList.remove('visible');
        });

        item.addEventListener('click', (e) => {
          if (e.target.closest(actionsSelector)) return;
          if (item.querySelector(editingSelector)) return;
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            actions.classList.add('visible');
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
          }, 150);
        });
      }
    } else {
      // Touch: single tap → toggle action buttons
      // Exclude taps on show-more/show-less buttons and action buttons themselves
      if (actions) {
        item.addEventListener('click', (e) => {
          // Skip if tapping on action buttons, show-more/less, or while editing/dragging
          if (e.target.closest(actionsSelector)) return;
          if (e.target.closest('.show-more-btn')) return;
          if (e.target.closest('button')) return;
          if (item.querySelector(editingSelector)) return;
          if (isDragging) return;

          const isVisible = actions.classList.contains('visible');
          hideActiveActions();
          if (!isVisible) {
            actions.classList.add('visible');
            _activeActionsItem = item;
          }
        });
      }
    }

    // Double-click → inline edit (all devices)
    item.addEventListener('dblclick', (e) => {
      if (actions && e.target.closest(actionsSelector)) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (onDblClick) {
        e.preventDefault();
        onDblClick(item);
      }
    });
  });
}


// ===================================================================
// ITEM-LEVEL DRAG & DROP
// ===================================================================
// Replaces initDragDrop (projects) and initTodoDragDropForCard (todos)
export function initItemDragDrop(container, {
  itemSelector,
  excludeSelector = 'button, a, input, textarea, select',
  skipInsideSelector = null,
  idAttr,
  onReorder,
  crossContainerSelector = null,
  getContainerId = null,
  crossOnly = false,
  actionsSelector = null,
}) {
  cleanupDragArtifacts();
  let dragState = null;

  // Abort previous listeners on this container to prevent stacking
  if (container._itemDragAC) container._itemDragAC.abort();
  const ac = new AbortController();
  container._itemDragAC = ac;
  const sig = { signal: ac.signal };

  const itemsIn = (c) => Array.from(c.querySelectorAll(itemSelector));

  container.querySelectorAll(itemSelector).forEach(item => {
    if (skipInsideSelector && item.closest(skipInsideSelector)) return;
    item.style.touchAction = 'pan-y';
    item.setAttribute('draggable', 'false');
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;
    let preventScroll = null;
    let unregisterCleanup = null;

    const unregisterGlobalCleanup = () => {
      if (unregisterCleanup) {
        unregisterCleanup();
        unregisterCleanup = null;
      }
    };

    const cleanup = (wasDrag) => {
      unregisterGlobalCleanup();
      if (preventScroll) { item.removeEventListener('touchmove', preventScroll); preventScroll = null; }
      item.style.touchAction = 'pan-y';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      if (wasDrag) window.getSelection()?.removeAllRanges();
    };

    const finishDrag = async ({ complete = true } = {}) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      const active = dragState && dragState.el === item ? dragState : null;
      if (!active) { cleanup(false); return; }

      const ph = active.placeholder;

      // Stop auto-scroll loop
      if (active.scrollRAF) { cancelAnimationFrame(active.scrollRAF); active.scrollRAF = null; }

      // The placeholder may have moved to a different container
      const dropContainer = (ph?.parentNode?.matches?.(crossContainerSelector || '____'))
        ? ph.parentNode : container;

      // Build final order from the drop container
      let finalOrder = null;
      if (complete) {
        finalOrder = [];
        for (const child of dropContainer.children) {
          if (child === ph) finalOrder.push(active.id);
          else if (child === item) continue;
          else if (child.matches?.(itemSelector)) {
            finalOrder.push(child.dataset[idAttr]);
          }
        }
      }

      // Move item to placeholder position, then remove placeholder
      if (ph?.parentNode) {
        ph.parentNode.insertBefore(item, ph);
        ph.remove();
      }
      item.style.cssText = active.originalCssText || '';
      item.classList.remove('item-dragging');

      // Clear FLIP transforms on all containers' items
      if (crossContainerSelector) {
        document.querySelectorAll(crossContainerSelector).forEach(c => {
          itemsIn(c).forEach(el => { el.style.transition = ''; el.style.transform = ''; });
        });
      } else {
        itemsIn(container).forEach(el => { el.style.transition = ''; el.style.transform = ''; });
      }

      try {
        if (active.pointerId && item.hasPointerCapture?.(active.pointerId)) item.releasePointerCapture(active.pointerId);
      } catch (_) {}

      // Detect change: either order changed within same container, or container changed
      const sourceId = getContainerId ? getContainerId(container) : null;
      const targetId = getContainerId ? getContainerId(dropContainer) : null;
      const crossMove = sourceId != null && targetId != null && sourceId !== targetId;
      const orderChanged = complete && finalOrder && finalOrder.join('\x00') !== active.initialOrder.join('\x00');
      const changed = complete && (crossMove || orderChanged);

      dragState = null;
      setDragging(false);
      cleanup(true);

      if (changed) {
        try {
          await onReorder(finalOrder, {
            draggedId: active.id,
            sourceContainerId: sourceId,
            targetContainerId: targetId,
            sourceContainer: container,
            targetContainer: dropContainer,
          });
        } catch (e) { console.error('Item reorder failed:', e); }
      } else if (actionsSelector) {
        // Long press that ended in place — show action buttons as fallback
        const actions = item.querySelector(actionsSelector);
        if (actions) actions.classList.add('visible');
      }
    };

    const cancelDrag = () => { void finishDrag({ complete: false }); };

    // Prevent native drag ghost
    item.addEventListener('dragstart', e => e.preventDefault(), sig);

    item.addEventListener('pointerdown', e => {
      if (e.target.closest(excludeSelector)) return;
      if (dragState) return;
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      unregisterGlobalCleanup();
      unregisterCleanup = registerDragCleanup(({ complete }) => {
        void finishDrag({ complete });
      });

      preventScroll = (ev) => { if (activated) ev.preventDefault(); };
      item.addEventListener('touchmove', preventScroll, { passive: false });

      pressTimer = setTimeout(() => {
        activated = true;
        e.preventDefault();
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        const rect = item.getBoundingClientRect();
        const initialOrder = itemsIn(container).map(el => el.dataset[idAttr]).filter(Boolean);
        const originalCssText = item.style.cssText;

        // Placeholder holds the gap
        const placeholder = document.createElement('div');
        placeholder.className = 'item-drag-placeholder';
        placeholder.style.cssText = `height:${rect.height}px;`;
        container.insertBefore(placeholder, item);

        // Real item goes position:fixed
        item.style.position = 'fixed';
        item.style.left = rect.left + 'px';
        item.style.top = rect.top + 'px';
        item.style.width = rect.width + 'px';
        item.style.boxSizing = 'border-box';
        item.style.zIndex = '1000';
        item.style.transition = 'none';
        item.style.margin = '0';
        item.classList.add('item-dragging');

        dragState = {
          el: item,
          id: item.dataset[idAttr],
          offsetX: e.clientX - rect.left,
          offsetY: e.clientY - rect.top,
          pointerId: e.pointerId,
          placeholder,
          initialOrder,
          originalCssText,
          lastClientX: e.clientX,
          lastClientY: e.clientY,
          activeContainer: container,
          scrollRAF: null,
        };

        // Continuous auto-scroll loop during drag
        const scrollLoop = () => {
          if (!dragState || dragState.el !== item) return;
          const y = dragState.lastClientY;
          const edgeSize = 40;
          const ac = dragState.activeContainer || container;
          const scrollable = ac.scrollHeight > ac.clientHeight;
          if (scrollable) {
            const cRect = ac.getBoundingClientRect();
            if (y < cRect.top + edgeSize && ac.scrollTop > 0) {
              ac.scrollTop -= 6;
            } else if (y > cRect.bottom - edgeSize && ac.scrollTop < ac.scrollHeight - ac.clientHeight) {
              ac.scrollTop += 6;
            }
          }
          // Always allow page-level scroll too
          if (y < edgeSize) window.scrollBy(0, -6);
          else if (y > window.innerHeight - edgeSize) window.scrollBy(0, 6);
          dragState.scrollRAF = requestAnimationFrame(scrollLoop);
        };
        dragState.scrollRAF = requestAnimationFrame(scrollLoop);

        try { item.setPointerCapture(e.pointerId); } catch (_) {}
      }, LONG_PRESS_MS);
    }, sig);

    item.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer);
          pressTimer = null;
          cleanup(false);
        }
        return;
      }
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();

      // Move the fixed item with cursor
      item.style.left = (e.clientX - dragState.offsetX) + 'px';
      item.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.lastClientX = e.clientX;
      dragState.lastClientY = e.clientY;

      const ph = dragState.placeholder;

      // Determine active container (cross-container or original)
      let activeContainer = dragState.activeContainer;
      if (crossContainerSelector) {
        const allContainers = Array.from(document.querySelectorAll(crossContainerSelector));
        for (const c of allContainers) {
          const r = c.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            activeContainer = c;
            break;
          }
        }
        // If the cursor is between containers (e.g. over a header), also check
        // if it's within the parent card's bounds — use that card's list container
        if (activeContainer === dragState.activeContainer) {
          for (const c of allContainers) {
            const card = c.closest('.project-card, .list-bucket, .bucket-card');
            if (card) {
              const r = card.getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                activeContainer = c;
                break;
              }
            }
          }
        }
      }

      // Container changed — move placeholder to new container
      if (activeContainer !== dragState.activeContainer) {
        // FLIP: capture old positions in previous container
        const oldSiblings = itemsIn(dragState.activeContainer).filter(el => el !== item);
        const oldRects = new Map();
        oldSiblings.forEach(el => oldRects.set(el, el.getBoundingClientRect()));

        // Move placeholder to new container
        // crossOnly returning home: restore placeholder next to the fixed item
        if (crossOnly && activeContainer === container) {
          container.insertBefore(ph, item);
        } else {
          activeContainer.appendChild(ph);
        }
        dragState.activeContainer = activeContainer;

        // FLIP: animate old container siblings
        oldSiblings.forEach(el => {
          const oldR = oldRects.get(el);
          const newR = el.getBoundingClientRect();
          const dy = oldR.top - newR.top;
          if (Math.abs(dy) < 1) return;
          el.style.transition = 'none';
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.15s ease';
            el.style.transform = '';
          });
        });
      }

      // crossOnly: skip within-container reorder when still in the original container
      if (crossOnly && activeContainer === container) return;

      // Find insertion point within active container — vertical only
      // Clamp to the container's visible scroll area so the placeholder
      // never lands among items scrolled out of view.
      const cRect = activeContainer.getBoundingClientRect();
      const siblings = itemsIn(activeContainer).filter(el => el !== item);
      let insertBefore = null;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        if (r.top > cRect.bottom) { insertBefore = sib; break; }  // below visible area
        if (r.bottom < cRect.top) continue;                        // above visible area
        const midY = r.top + r.height / 2;
        if (e.clientY < midY) { insertBefore = sib; break; }
      }

      // "Already at target" check
      if (insertBefore) {
        if (ph.nextElementSibling === insertBefore) return;
      } else {
        let afterPh = ph.nextElementSibling;
        while (afterPh === item) afterPh = afterPh.nextElementSibling;
        if (!afterPh || !afterPh.matches?.(itemSelector)) return;
      }

      // FLIP: capture old positions
      const rects = new Map();
      siblings.forEach(el => rects.set(el, el.getBoundingClientRect()));

      // Move placeholder
      if (insertBefore) {
        activeContainer.insertBefore(ph, insertBefore);
      } else {
        activeContainer.appendChild(ph);
      }

      // Keep placeholder visible inside scrollable container
      const phR = ph.getBoundingClientRect();
      if (phR.top < cRect.top) {
        activeContainer.scrollTop -= (cRect.top - phR.top);
      } else if (phR.bottom > cRect.bottom) {
        activeContainer.scrollTop += (phR.bottom - cRect.bottom);
      }

      // FLIP: animate from old to new
      siblings.forEach(el => {
        const oldR = rects.get(el);
        const newR = el.getBoundingClientRect();
        const dy = oldR.top - newR.top;
        if (Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform 0.15s ease';
          el.style.transform = '';
        });
      });
    }, sig);

    item.addEventListener('pointerup', () => { void finishDrag({ complete: true }); }, sig);
    item.addEventListener('pointercancel', cancelDrag, sig);
    item.addEventListener('lostpointercapture', cancelDrag, sig);
  });
}

// ===================================================================
// REORDER ITEMS — update sort_order from ordered ID array
// ===================================================================
export async function reorderItems({
  orderedIds,
  allItems,
  tableName,
  reinitFn,
}) {
  // Diff: only PATCH items whose sort_order actually changed
  const updates = [];
  orderedIds.forEach((id, i) => {
    const item = allItems.find(x => x.id === id);
    if (!item) return;
    if (Number(item.sort_order ?? 0) !== i) updates.push({ id, sort_order: i });
    item.sort_order = i; // optimistic in-memory update after diff
  });

  if (reinitFn) reinitFn();

  if (updates.length === 0) return;

  showToast(t('toast.reordered'), 'success');

  bulkSortOrder(tableName, updates)
    .catch(e => console.error(`${tableName} reorder sync failed:`, e));
}

// ===================================================================
// BULK SORT ORDER — single RPC when available, parallel PATCHes fallback
// ===================================================================
export async function bulkSortOrder(tableName, updates) {
  if (updates.length === 0) return;
  await db.bulkSortOrder(tableName, updates);
}
// ===================================================================
// INNER SCROLL POSITION CAPTURE / RESTORE
// ===================================================================
// When a grid is rebuilt via innerHTML, scrollable inner lists (task-list,
// todo-cat-list, list-item-list, vestiaire-item-list, birthday-bucket-list)
// lose their scrollTop. Capture before innerHTML, restore after.

const SCROLLABLE_LIST_SELECTOR = '.task-list, .todo-cat-list, .list-item-list, .vestiaire-item-list, .birthday-bucket-list, .welcome-items';

function scrollContainerKey(el) {
  if (el.id) return 'id:' + el.id;
  const cat = el.dataset?.category;
  if (cat) return 'cat:' + cat;
  const card = el.closest('[id]');
  if (card?.id) return 'id:' + card.id;
  return null;
}

export function captureInnerScrollPositions(gridEl) {
  const map = new Map();
  if (!gridEl) return map;
  gridEl.querySelectorAll(SCROLLABLE_LIST_SELECTOR).forEach(el => {
    if (el.scrollTop <= 0) return;
    const key = scrollContainerKey(el);
    if (key) map.set(key, el.scrollTop);
  });
  return map;
}

export function restoreInnerScrollPositions(gridEl, map) {
  if (!gridEl || !map.size) return;
  gridEl.querySelectorAll(SCROLLABLE_LIST_SELECTOR).forEach(el => {
    const key = scrollContainerKey(el);
    if (key && map.has(key)) el.scrollTop = map.get(key);
  });
}


// ===================================================================
// ITEM REMOVAL ANIMATION
// ===================================================================
// Smoothly collapses and fades an item out. Returns a Promise that
// resolves when the transition finishes (or after a safety timeout).
export function animateItemRemoval(el) {
  return new Promise(resolve => {
    if (!el) { resolve(); return; }
    const h = el.offsetHeight;
    // Lock current height so it can be transitioned to 0
    el.style.height = h + 'px';
    el.style.overflow = 'hidden';
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight; // force reflow
    el.classList.add('item-removing');
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    el.addEventListener('transitionend', function handler(e) {
      if (e.propertyName === 'height') {
        el.removeEventListener('transitionend', handler);
        done();
      }
    });
    // Safety: resolve even if transitionend never fires
    setTimeout(done, 350);
    requestAnimationFrame(() => {
      el.style.height = '0';
    });
  });
}


// SCROLL TO & HIGHLIGHT
// ===================================================================
export function scrollToAndHighlight(element, color, durationMs = 1500) {
  if (!element) return;
  const header = document.querySelector('.app-header');
  if (header) {
    const headerBottom = header.getBoundingClientRect().bottom;
    const elementTop = element.getBoundingClientRect().top;
    const offset = elementTop - headerBottom - 8;
    window.scrollBy({ top: offset, behavior: 'smooth' });
  } else {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (color) {
    element.style.boxShadow = `0 0 0 2px ${color}`;
    setTimeout(() => { element.style.boxShadow = ''; }, durationMs);
  }
}


// ===================================================================
// INLINE TEXT EDIT — generic textarea-replace pattern
// ===================================================================
// Options:
//   maxLength    — textarea maxLength
//   saveFn(text) — called with trimmed new text on save
//   refreshFn()  — called after edit finishes (save or cancel)
//   extraEl      — optional DOM element appended below textarea (e.g. deadline row)
//   onStart()    — called before replacing span (e.g. expand parent)
//   onFinish()   — called after edit ends (e.g. restore parent)
//   collectExtra() — optional fn returning extra update data from extraEl
// Track the active inline edit so we can cancel it cleanly
let _activeInlineEdit = null;
let _inlineEditRefreshTimer = null;
let _datePickerJustClosed = false;

export function inlineEditText(spanEl, originalText, { maxLength, saveFn, refreshFn, extraEl, onStart, onFinish, collectExtra, multiline, containerEl }) {
  if (spanEl.dataset.editing) return;

  // Cancel any other active inline edit first (discard + restore span)
  if (_activeInlineEdit) {
    _activeInlineEdit();
    _activeInlineEdit = null;
  }

  // Clear any deferred refresh timer (including one set by the cancel above or a prior blur)
  if (_inlineEditRefreshTimer) {
    clearTimeout(_inlineEditRefreshTimer);
    _inlineEditRefreshTimer = null;
  }

  spanEl.dataset.editing = 'true';

  const input = document.createElement('textarea');
  input.className = 'task-edit-input';
  input.value = originalText;
  input.rows = 1;
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.flex = 'none';
  if (maxLength) input.maxLength = maxLength;

  // Action buttons (Save + Cancel) at bottom-right of edit form
  const actionRow = document.createElement('div');
  actionRow.className = 'inline-edit-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'inline-edit-cancel-btn';
  cancelBtn.innerHTML = lucideIcon('x', 14) + ' ' + t('common.cancel');
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'inline-edit-save-btn';
  confirmBtn.innerHTML = lucideIcon('check', 14) + ' ' + t('common.save');
  actionRow.appendChild(cancelBtn);
  actionRow.appendChild(confirmBtn);

  // Build edit root: textarea + optional extras + action row
  const wrapper = document.createElement('div');
  wrapper.className = 'todo-edit-wrapper';
  wrapper.appendChild(input);
  if (extraEl) wrapper.appendChild(extraEl);
  wrapper.appendChild(actionRow);
  const root = wrapper;

  if (onStart) onStart();

  function autoSize() {
    input.style.height = '0';
    input.style.height = input.scrollHeight + 'px';
  }

  let finished = false;
  const finishEdit = async (save, deferRefresh = false) => {
    if (finished) return;
    finished = true;
    _activeInlineEdit = null;
    const trimmed = input.value.trim();
    if (save && trimmed && trimmed !== originalText) {
      const extra = collectExtra ? collectExtra() : undefined;
      await saveFn(trimmed, extra);
    } else if (save && collectExtra) {
      const extra = collectExtra();
      if (extra) await saveFn(originalText, extra);
    }
    if (onFinish) onFinish();
    if (_containerMousedownHandler && containerEl) {
      containerEl.removeEventListener('mousedown', _containerMousedownHandler, true);
    }
    delete spanEl.dataset.editing;

    // Fade out the edit wrapper, then restore the span
    root.classList.remove('inline-edit-visible');
    await new Promise(r => {
      const done = () => r();
      root.addEventListener('transitionend', function h(e) {
        if (e.propertyName === 'opacity') { root.removeEventListener('transitionend', h); done(); }
      });
      setTimeout(done, 200);
    });

    spanEl.textContent = save && trimmed ? trimmed : originalText;
    root.replaceWith(spanEl);

    if (deferRefresh) {
      // Defer refresh — will be cancelled if another edit starts soon
      _inlineEditRefreshTimer = setTimeout(() => {
        _inlineEditRefreshTimer = null;
        refreshFn();
      }, 350);
    } else {
      await refreshFn();
    }
  };

  // Register cancel function: discard + restore span, defer refresh (caller clears the timer)
  _activeInlineEdit = () => finishEdit(false, true);

  confirmBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finishEdit(true);
  });
  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finishEdit(false);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !multiline) { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  });
  input.addEventListener('input', autoSize);

  // Track whether the most recent mousedown was inside the container so the
  // focusout handler can distinguish "clicked empty space in the same item"
  // (should keep the edit open) from "clicked outside" (should cancel).
  let _clickedInsideContainer = false;
  let _containerMousedownHandler = null;
  if (containerEl) {
    _containerMousedownHandler = () => { _clickedInsideContainer = true; setTimeout(() => { _clickedInsideContainer = false; }, 200); };
    containerEl.addEventListener('mousedown', _containerMousedownHandler, true);
  }

  // Native date-picker guard: on iOS, tapping "Done" blurs the date input
  // and moves focus to <body>, which would otherwise trigger cancel. On
  // desktop Chrome the picker has no confirm button, so clicking outside to
  // dismiss it can also land outside the edit wrapper. Setting a short flag
  // on date-input blur lets the focusout handler skip cancellation.
  root.querySelectorAll('input[type="date"], input[type="datetime-local"]').forEach(di => {
    di.addEventListener('blur', () => {
      _datePickerJustClosed = true;
      setTimeout(() => { _datePickerJustClosed = false; }, 300);
    });
  });

  // Blur anywhere inside the wrapper → cancel (delay lets button clicks register first)
  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (finished) return;
      if (root.contains(document.activeElement)) return;
      // If focus moved to another interactive element in the same item (e.g.
      // last-done date picker), keep the inline edit open.
      if (containerEl && containerEl.contains(document.activeElement)) return;
      // If the user clicked non-focusable space inside the item, keep open
      // and re-focus the input so the next outside click still triggers focusout.
      if (_clickedInsideContainer) { input.focus(); return; }
      // If a native date picker just closed (iOS Done / Chrome dismiss),
      // keep the edit open — the value landed in the input already.
      if (_datePickerJustClosed) { input.focus(); return; }
      finishEdit(false, true);
    }, 150);
  });
  if (extraEl) {
    extraEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
  }

  spanEl.replaceWith(root);
  requestAnimationFrame(() => {
    root.classList.add('inline-edit-visible');
    requestAnimationFrame(() => {
      autoSize();
      if (extraEl) {
        extraEl.querySelectorAll('textarea').forEach(ta => {
          ta.style.height = '0';
          ta.style.height = ta.scrollHeight + 'px';
        });
      }
      input.focus();
      // Place cursor at end; re-apply after a short delay for mobile
      // browsers where the soft keyboard can reset selection
      const placeCursorAtEnd = () => {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      };
      placeCursorAtEnd();
      setTimeout(placeCursorAtEnd, 50);

      // Scroll the textarea into view within the scrollable task list
      // without changing the deck's maxHeight
      const parentList = input.closest('.task-list, .vestiaire-item-list');
      if (parentList) {
        const parentRect = parentList.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        if (inputRect.bottom > parentRect.bottom) {
          parentList.scrollTop += (inputRect.bottom - parentRect.bottom) + 16;
        } else if (inputRect.top < parentRect.top) {
          parentList.scrollTop -= (parentRect.top - inputRect.top) + 16;
        }
      }
    });
  });
}


// ===================================================================
// NAV BUTTON REORDER — sortable drag-and-drop for category-nav-btn pills
// ===================================================================
// Shared across all pages. Long-press a nav pill to pick it up; other
// pills slide apart with CSS transitions to show where it will land.
// Drop to commit. `onReorder(orderedIds)` receives the full new order.
export function initNavBtnReorder(containerId, { idAttr, onReorder, skipIds } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const allBtns = () => Array.from(container.querySelectorAll('.category-nav-btn'));
  if (allBtns().length < 2) return;

  let dragState = null;

  const draggableBtns = allBtns().filter(b => {
    const id = b.dataset[idAttr];
    return id && !(skipIds && skipIds.has(id));
  });

  draggableBtns.forEach(btn => {
    const entityId = btn.dataset[idAttr];
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;
    let preventScroll = null;
    let unregisterCleanup = null;

    const unregisterGlobalCleanup = () => {
      if (unregisterCleanup) { unregisterCleanup(); unregisterCleanup = null; }
    };

    const cleanup = (wasDrag) => {
      unregisterGlobalCleanup();
      if (preventScroll) { btn.removeEventListener('touchmove', preventScroll); preventScroll = null; }
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      if (wasDrag) window.getSelection()?.removeAllRanges();
    };

    const finishDrag = async ({ complete = true } = {}) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      const active = dragState && dragState.el === btn ? dragState : null;
      if (!active) { cleanup(false); return; }

      const ph = active.placeholder;

      // Build final order from placeholder position
      let finalOrder;
      if (complete && ph?.parentNode === container) {
        finalOrder = [];
        for (const child of container.children) {
          if (child === ph) finalOrder.push(entityId);
          else if (child === btn) continue;
          else if (child.classList.contains('category-nav-btn')) {
            finalOrder.push(child.dataset[idAttr]);
          }
        }
      }

      // Suppress the click event the browser fires after pointerup —
      // without this, delegation.js would navigate to the category.
      // Self-cleans after 400ms so it never eats a later deliberate click.
      function suppress(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener('click', suppress, true);
        clearTimeout(suppressTimer);
      }
      document.addEventListener('click', suppress, true);
      const suppressTimer = setTimeout(() => {
        document.removeEventListener('click', suppress, true);
      }, 400);

      // Move button to placeholder's DOM position, then remove placeholder.
      // This way the button reappears at its new spot — no flash at the old one.
      if (ph?.parentNode === container) container.insertBefore(btn, ph);
      if (ph?.parentNode) ph.remove();
      btn.style.cssText = active.originalCssText || '';
      btn.classList.remove('nav-btn-dragging');
      allBtns().forEach(b => { b.style.transition = ''; b.style.transform = ''; });

      try {
        if (active.pointerId && btn.hasPointerCapture?.(active.pointerId)) btn.releasePointerCapture(active.pointerId);
      } catch (_) {}

      const changed = complete && finalOrder && finalOrder.join('\x00') !== active.initialOrder.join('\x00');

      dragState = null;
      setDragging(false);
      cleanup(true);

      if (changed) {
        try { await onReorder(finalOrder); }
        catch (e) { console.error('Nav btn reorder failed:', e); }
      }
    };

    const cancelDrag = () => { void finishDrag({ complete: false }); };

    // Prevent native HTML drag ghost on touch/mouse
    btn.addEventListener('dragstart', e => e.preventDefault());
    // Prevent long-press context menu on mobile
    btn.addEventListener('contextmenu', e => { if (activated) e.preventDefault(); });

    btn.addEventListener('pointerdown', e => {
      if (dragState) return;
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      unregisterGlobalCleanup();
      unregisterCleanup = registerDragCleanup(({ complete }) => {
        void finishDrag({ complete });
      });

      preventScroll = (ev) => { if (activated) ev.preventDefault(); };
      btn.addEventListener('touchmove', preventScroll, { passive: false });

      pressTimer = setTimeout(() => {
        activated = true;
        e.preventDefault();
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        const rect = btn.getBoundingClientRect();
        const initialOrder = allBtns().map(b => b.dataset[idAttr]).filter(Boolean);
        const originalCssText = btn.style.cssText; // preserve --cat-color etc.

        // Invisible placeholder takes the button's space in flex flow
        const placeholder = document.createElement('span');
        placeholder.className = 'nav-btn-placeholder';
        placeholder.style.cssText = `display:inline-block;width:${rect.width}px;height:${rect.height}px;flex-shrink:0;visibility:hidden;`;
        container.insertBefore(placeholder, btn);

        // The actual button goes position:fixed — user drags the real thing
        // (same colors, font, styling — no clone needed).
        // It stays at its DOM position so pointer capture is never broken.
        btn.style.position = 'fixed';
        btn.style.left = rect.left + 'px';
        btn.style.top = rect.top + 'px';
        btn.style.width = rect.width + 'px';
        btn.style.boxSizing = 'border-box';
        btn.style.zIndex = '1000';
        btn.style.transition = 'none';
        btn.style.margin = '0';
        btn.classList.add('nav-btn-dragging');

        dragState = {
          el: btn,
          id: entityId,
          offsetX: e.clientX - rect.left,
          offsetY: e.clientY - rect.top,
          pointerId: e.pointerId,
          placeholder,
          initialOrder,
          originalCssText,
        };

        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      }, LONG_PRESS_MS);
    });

    btn.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer); pressTimer = null; cleanup(false);
        }
        return;
      }
      if (!dragState || dragState.el !== btn) return;
      e.preventDefault();

      // Button follows cursor instantly (transition:none already set)
      btn.style.left = (e.clientX - dragState.offsetX) + 'px';
      btn.style.top = (e.clientY - dragState.offsetY) + 'px';

      // Determine insertion point — supports multi-row flex wrapping
      const ph = dragState.placeholder;
      const siblings = allBtns().filter(b => b !== btn);

      // Group siblings into rows by vertical midpoint
      const rows = [];
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        const midY = r.top + r.height / 2;
        let row = rows.find(rw => Math.abs(midY - rw.midY) < r.height * 0.6);
        if (row) { row.items.push({ el: sib, rect: r }); }
        else { rows.push({ midY, items: [{ el: sib, rect: r }] }); }
      }
      rows.sort((a, b) => a.midY - b.midY);
      rows.forEach(rw => rw.items.sort((a, b) => a.rect.left - b.rect.left));

      // Find closest row to cursor Y
      let targetRow = rows[0];
      if (rows.length > 1) {
        let minDist = Infinity;
        for (const rw of rows) {
          const d = Math.abs(e.clientY - rw.midY);
          if (d < minDist) { minDist = d; targetRow = rw; }
        }
      }

      // Within that row, find insertion by X midpoint
      let insertBefore = null;
      if (targetRow) {
        for (const item of targetRow.items) {
          if (e.clientX < item.rect.left + item.rect.width / 2) {
            insertBefore = item.el; break;
          }
        }
        // Past all items in row → insert before first item of next row, or end
        if (!insertBefore) {
          const ri = rows.indexOf(targetRow);
          if (ri < rows.length - 1) insertBefore = rows[ri + 1].items[0].el;
        }
      }

      // Check if placeholder is already at the target position
      if (insertBefore) {
        if (ph.nextElementSibling === insertBefore) return;
      } else {
        // "end" means no visible element after placeholder (btn is fixed, ignore it)
        let afterPh = ph.nextElementSibling;
        while (afterPh === btn) afterPh = afterPh.nextElementSibling;
        if (!afterPh) return;
      }

      // FLIP: clear stale transforms, snapshot current positions
      siblings.forEach(b => { b.style.transition = 'none'; b.style.transform = ''; });
      const oldRects = new Map();
      siblings.forEach(b => oldRects.set(b, b.getBoundingClientRect()));

      // Move placeholder (only this moves — btn stays put in DOM)
      if (insertBefore) {
        container.insertBefore(ph, insertBefore);
      } else {
        // End of list — append so ph is the last flex item
        // (btn is position:fixed, out of flex flow, so DOM order after it is fine)
        container.appendChild(ph);
      }

      // FLIP: inverse-transform then transition to zero
      siblings.forEach(b => {
        const oldR = oldRects.get(b);
        const newR = b.getBoundingClientRect();
        const dx = oldR.left - newR.left;
        const dy = oldR.top - newR.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          b.style.transform = `translate(${dx}px,${dy}px)`;
        }
      });
      container.offsetHeight; // force reflow before enabling transitions
      siblings.forEach(b => {
        if (b.style.transform) {
          b.style.transition = 'transform 0.15s ease';
          b.style.transform = '';
        }
      });
    });

    btn.addEventListener('pointerup', () => { void finishDrag({ complete: true }); });
    btn.addEventListener('pointercancel', cancelDrag);
    btn.addEventListener('lostpointercapture', cancelDrag);
  });
}

// ===================================================================
// BUCKET FLIP — smooth reorder animation for .project-card containers
// ===================================================================

function bucketKey(el) {
  return el.id || el.dataset.category || el.dataset.project || el.dataset.listId || el.dataset.deck || null;
}

/** Snapshot positions of all .project-card elements inside a container. */
export function snapshotBuckets(container) {
  const map = new Map();
  if (!container) return map;
  container.querySelectorAll('.project-card').forEach(el => {
    const key = bucketKey(el);
    if (key) map.set(key, el.getBoundingClientRect());
  });
  return map;
}

/** FLIP-animate .project-card elements from their snapshotted positions to current ones. */
export function animateBucketsFromSnapshot(container, snapshot, durationMs = 600) {
  if (!container || !snapshot.size) return;
  container.querySelectorAll('.project-card').forEach(el => {
    const key = bucketKey(el);
    const oldRect = key && snapshot.get(key);
    if (!oldRect) return;
    const newRect = el.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight; // force reflow before enabling transition
    el.style.transition = `transform ${durationMs}ms ease`;
    el.style.transform = '';
    el.addEventListener('transitionend', function handler(e) {
      if (e.propertyName !== 'transform') return;
      el.style.transition = '';
      el.removeEventListener('transitionend', handler);
    });
  });
}
