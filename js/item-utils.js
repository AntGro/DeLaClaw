// ===================================================================
// SHARED ITEM UTILITIES — used by projects.js and todos.js
// ===================================================================

import { showToast } from './utils.js';
import { t } from './i18n.js';
import db from './db.js';

// ===================================================================
// SHARED DRAG STATE
// ===================================================================
export let isDragging = false;
export function setDragging(v) { isDragging = v; }

export const LONG_PRESS_MS = 250;
export const DRAG_THRESHOLD = 5;

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
  const isTouchDevice = window.matchMedia('(max-width:480px)').matches || 'ontouchstart' in window;

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
  if (isTouchDevice) {
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

    if (!isTouchDevice) {
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
          }, 250);
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
}) {
  let dragState = null;

  container.querySelectorAll(itemSelector).forEach(item => {
    if (skipInsideSelector && item.closest(skipInsideSelector)) return;
    item.style.touchAction = 'pan-y';
    let pressTimer = null;
    let startX = 0, startY = 0;
    let activated = false;
    let preventScroll = null;

    item.addEventListener('pointerdown', e => {
      if (e.target.closest(excludeSelector)) return;
      if (dragState) return;
      startX = e.clientX;
      startY = e.clientY;
      activated = false;

      // Prevent scrolling once long-press activates
      preventScroll = (ev) => { if (activated) ev.preventDefault(); };
      item.addEventListener('touchmove', preventScroll, { passive: false });

      pressTimer = setTimeout(() => {
        activated = true;
        e.preventDefault();
        item.style.touchAction = 'none';
        const rect = item.getBoundingClientRect();
        isDragging = true;
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        dragState = { el: item, id: item.dataset[idAttr], offsetY: e.clientY - rect.top, clone: null, pointerId: e.pointerId };

        const clone = item.cloneNode(true);
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.85;z-index:1000;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,0.3);background:var(--surface);border-radius:8px;border:2px solid var(--accent);transition:none;`;
        document.body.appendChild(clone);
        dragState.clone = clone;
        item.classList.add('dragging');
        try { item.setPointerCapture(e.pointerId); } catch (_) {}
      }, LONG_PRESS_MS);
    });

    item.addEventListener('pointermove', e => {
      if (pressTimer && !activated) {
        if (Math.abs(e.clientX - startX) > DRAG_THRESHOLD || Math.abs(e.clientY - startY) > DRAG_THRESHOLD) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
        return;
      }
      if (!dragState || dragState.el !== item) return;
      e.preventDefault();
      dragState.clone.style.top = (e.clientY - dragState.offsetY) + 'px';

      // Auto-scroll
      const cRect = container.getBoundingClientRect();
      const edge = 40;
      if (e.clientY < cRect.top + edge && container.scrollTop > 0) container.scrollTop -= 5;
      else if (e.clientY > cRect.bottom - edge && container.scrollTop < container.scrollHeight - container.clientHeight) container.scrollTop += 5;

      container.querySelectorAll(`${itemSelector}:not(.dragging)`).forEach(el => {
        el.classList.remove('drag-over');
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) el.classList.add('drag-over');
      });
    });

    const cleanup = (wasDrag) => {
      if (preventScroll) { item.removeEventListener('touchmove', preventScroll); preventScroll = null; }
      item.style.touchAction = 'pan-y';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      if (wasDrag) window.getSelection()?.removeAllRanges();
    };

    const finishDrag = async () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!dragState || dragState.el !== item) { cleanup(false); return; }
      if (dragState.clone) dragState.clone.remove();
      item.classList.remove('dragging');

      let targetId = null;
      container.querySelectorAll(itemSelector).forEach(el => {
        if (el.classList.contains('drag-over')) { targetId = el.dataset[idAttr]; el.classList.remove('drag-over'); }
      });
      const draggedId = dragState.id;
      dragState = null;
      isDragging = false;
      cleanup(true);
      if (targetId && targetId !== draggedId) await onReorder(draggedId, targetId);
    };

    item.addEventListener('pointerup', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } finishDrag(); });
    item.addEventListener('lostpointercapture', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (dragState && dragState.el === item) {
        if (dragState.clone) dragState.clone.remove();
        item.classList.remove('dragging');
        container.querySelectorAll(itemSelector).forEach(el => el.classList.remove('drag-over'));
        dragState = null;
        isDragging = false;
        cleanup();
      }
    });
  });
}


// ===================================================================
// REORDER ITEMS — splice array, move DOM, sync to Supabase
// ===================================================================
// Replaces reorderTasks (projects) and reorderTodosInCategory (todos)
export async function reorderItems({
  items,
  allItems,
  draggedId,
  targetId,
  container,
  itemSelector,
  idAttr,
  tableName,
  reinitFn,
}) {
  const draggedIdx = items.findIndex(t => t.id === draggedId);
  const targetIdx = items.findIndex(t => t.id === targetId);
  if (draggedIdx === -1 || targetIdx === -1) return;

  const [dragged] = items.splice(draggedIdx, 1);
  items.splice(targetIdx, 0, dragged);

  items.forEach((t, i) => { t.sort_order = i; });
  items.forEach(t => {
    const st = allItems.find(x => x.id === t.id);
    if (st) st.sort_order = t.sort_order;
  });

  const domItems = Array.from(container.querySelectorAll(itemSelector));
  const ordered = items.map(t => domItems.find(el => el.dataset[idAttr] === t.id)).filter(Boolean);
  ordered.forEach(el => container.appendChild(el));

  if (reinitFn) reinitFn();
  showToast(t('toast.reordered'), 'success');

  Promise.all(items.map((t, i) =>
    db.from(tableName).update({ sort_order: i }).eq('id', t.id)
  )).catch(e => console.error(`${tableName} reorder sync failed:`, e));
}


// ===================================================================
// SCROLL TO & HIGHLIGHT
// ===================================================================
export function scrollToAndHighlight(element, color, durationMs = 1500) {
  if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

export function inlineEditText(spanEl, originalText, { maxLength, saveFn, refreshFn, extraEl, onStart, onFinish, collectExtra, multiline }) {
  if (spanEl.dataset.editing) return;

  // Cancel any other active inline edit first (save + restore span)
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

  let root = input;
  if (extraEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'todo-edit-wrapper';
    wrapper.appendChild(input);
    wrapper.appendChild(extraEl);
    root = wrapper;
  }

  // Auto-expand parent containers to prevent edit area from being clipped
  const _editList = spanEl.closest('.task-list, .vestiaire-item-list');
  const _editCard = spanEl.closest('.project-card');
  const _saved = {};
  if (_editList) {
    _saved.listMaxHeight = _editList.style.maxHeight;
    _saved.listOverflowY = _editList.style.overflowY;
    _editList.style.maxHeight = 'none';
    _editList.style.overflowY = 'visible';
  }
  if (_editCard) {
    _saved.cardOverflow = _editCard.style.overflow;
    _saved.cardZIndex = _editCard.style.zIndex;
    _saved.cardMaxHeight = _editCard.style.maxHeight;
    _editCard.style.overflow = 'visible';
    _editCard.style.zIndex = '20';
    _editCard.style.maxHeight = 'none';
  }

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
    // Restore parent containers
    if (_editList) {
      _editList.style.maxHeight = _saved.listMaxHeight;
      _editList.style.overflowY = _saved.listOverflowY;
    }
    if (_editCard) {
      _editCard.style.overflow = _saved.cardOverflow;
      _editCard.style.zIndex = _saved.cardZIndex;
      _editCard.style.maxHeight = _saved.cardMaxHeight;
    }
    if (onFinish) onFinish();
    delete spanEl.dataset.editing;

    // Always restore the span in-place (fast, keeps DOM stable)
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

  // Register cancel function: save + restore span, defer refresh (caller clears the timer)
  _activeInlineEdit = () => finishEdit(true, true);

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !multiline) { e.preventDefault(); finishEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  });
  input.addEventListener('input', autoSize);

  if (extraEl) {
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) finishEdit(true, true);
      }, 150);
    });
    extraEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
  } else {
    input.addEventListener('blur', () => finishEdit(true, true));
  }

  spanEl.replaceWith(root);
  requestAnimationFrame(() => {
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
    });
  });
}
