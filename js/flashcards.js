import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state, { GENERAL_CATEGORY_COLOR, SHARED_CATEGORY as SHARED_CAT_CONST } from './state.js';
import { esc, escQ, showToast, showConfirmAction, applySectionGrid, fetchAll, isMobileUA, backfillCategoryColors, nextPaletteColor, autoResizeTextarea, onColorFor } from './utils.js';
import { scrollToAndHighlight, inlineEditText, initItemHoverDelay, initItemDragDrop, reorderItems, bulkSortOrder, initNavBtnReorder, snapshotBuckets, animateBucketsFromSnapshot, captureInnerScrollPositions, restoreInnerScrollPositions, animateItemRemoval } from './item-utils.js';
import { generateStorm, LOGO_DEFAULTS } from './logo.js';
import { parseSceneContent, splitSceneIntoChunks, sceneLineText, sceneBlockText, sceneSpeakersEqual, groupLinesBySpeaker, buildRoleColorMap, persistTextEdit, leadingRevealCount, trailingRevealCount, getTextChunks, isChunkDue, chunkReviseMode, applyChunkEdit } from './scene-parse.js';
import { isSectionRow, normalizeSectionFields, buildSectionTree, pathLabelOf, descendantBucketIds, descendantsOf, siblingNameTaken, planNodeMove, resolveSectionPath, parseSectionPath, flattenTree, runDeckToSectionMigration } from './sections-pure.js';

// ===================================================================
// FLASHCARDS — Spaced Repetition (Algo-style intervals)
// ===================================================================

// ── SM-2 / Algo-style Spaced Repetition Core ──
// Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy
// Stability ≈ target interval in days. Next review = stability days from now.
//
// Lapses follow Anki: Again on a review card puts it into relearning
// (one 10-minute step), and it comes back in-session once the step is
// due — never early: a card whose step has not elapsed waits for the
// next session. Good graduates it to 1 day, Easy to 4 days, Hard to
// 12 hours, Again repeats the step. There is deliberately no leech
// mechanism: no lapse counter, no suspension.
const RELEARN_STEP_MS = 10 * 60 * 1000; // one relearning step: 10 minutes
const RELEARN_STABILITY = 0.007;        // ≈10 minutes, in days
const GRADUATING_INTERVAL = 1;          // days after Good on a relearning card
const HARD_RELEARN_INTERVAL = 0.5;      // days after Hard on a relearning card: 12 hours (Anki: the average of the step and the graduating interval)
const EASY_INTERVAL = 4;                // days after Easy on a relearning card

const DECAY = 0.5;
const FACTOR = Math.pow(0.9, 1 / -DECAY) - 1; // ≈ 0.2346 — power forgetting curve constant

function clamp(x, lo, hi) { return Math.max(lo, Math.min(x, hi)); }
function daysBetween(d1, d2) { return (new Date(d2) - new Date(d1)) / 86400000; }

// Power forgetting curve (FSRS v5 style): R(S,S)=0.9 by construction
function retrievability(S, lastReview, now) {
  if (!lastReview || !S) return 0;
  const t = daysBetween(lastReview, now);
  return Math.pow(t / S * FACTOR + 1, -DECAY);
}

// Interval ≈ stability (for 90% target retention)
function nextInterval(S) { return Math.max(1, Math.round(S)); }

// New card: initial stabilities per rating
function initStability(rating) {
  return [0.007, 1, 1, 4][rating - 1] || 1; // Again≈10min, Hard=1d, Good=1d, Easy=4d
}

// New card: initial difficulty (Easy→low, Again→high)
function initDifficulty(rating) {
  return clamp(7 - 1.5 * (rating - 1), 1, 10); // Again=7, Hard=5.5, Good=4, Easy=2.5
}

// Successful review: multiply stability by rating-dependent factor
function stabilityAfterSuccess(S, D, R, rating) {
  const baseMult = { 2: 0.7, 3: 2.5, 4: 2.5 }[rating] || 2.5;
  const easyBonus = rating === 4 ? 1.3 : 1.0;
  const diffFactor = clamp(1 + (5 - D) * 0.05, 0.75, 1.25); // easy cards grow faster
  return S * baseMult * easyBonus * diffFactor;
}

// Difficulty drifts toward 5 (mean reversion), adjusted by rating
function updateDifficulty(D, rating) {
  const delta = -(rating - 3) * 0.5; // Easy→-0.5, Good→0, Hard→+0.5, Again→+1.0
  const Dnew = D + delta;
  return clamp(Dnew * 0.9 + 5 * 0.1, 1, 10); // 10% mean reversion toward 5
}

function fuzz(interval) {
  if (interval < 2) return interval;
  return interval * (1 + (Math.random() - 0.5) * 0.1);
}

function fsrsUpdate(card, rating, now) {
  const isNew = !card.last_review || card.stability === 0;
  let S, D, relearning = 0, nextReview;
  if (isNew) {
    D = initDifficulty(rating); S = initStability(rating);
    const interval = fuzz(nextInterval(S));
    nextReview = new Date(now.getTime() + interval * 86400000);
  } else if (rating === 1) {
    // Lapse (Again on a review card): into relearning, not a 30% cut
    // of a multi-year interval. Due again after one 10-minute step.
    S = RELEARN_STABILITY;
    D = updateDifficulty(card.difficulty, rating);
    relearning = 1;
    nextReview = new Date(now.getTime() + RELEARN_STEP_MS);
  } else if (card.relearning) {
    // In relearning: Good/Easy graduate, Hard graduates at 12 hours,
    // Again repeats the step.
    D = updateDifficulty(card.difficulty, rating);
    if (rating === 3) {
      S = GRADUATING_INTERVAL;
      nextReview = new Date(now.getTime() + GRADUATING_INTERVAL * 86400000);
    } else if (rating === 4) {
      S = EASY_INTERVAL;
      nextReview = new Date(now.getTime() + fuzz(EASY_INTERVAL) * 86400000);
    } else if (rating === 2) {
      S = HARD_RELEARN_INTERVAL;
      nextReview = new Date(now.getTime() + HARD_RELEARN_INTERVAL * 86400000);
    } else {
      S = RELEARN_STABILITY;
      relearning = 1;
      nextReview = new Date(now.getTime() + RELEARN_STEP_MS);
    }
  } else {
    const R = retrievability(card.stability, card.last_review, now.toISOString());
    S = stabilityAfterSuccess(card.stability, card.difficulty, R, rating);
    D = updateDifficulty(card.difficulty, rating);
    const interval = fuzz(nextInterval(S));
    nextReview = new Date(now.getTime() + interval * 86400000);
  }
  return {
    stability: Math.round(S * 100) / 100,
    difficulty: Math.round(D * 100) / 100,
    relearning,
    last_review: now.toISOString(),
    next_review: nextReview.toISOString(),
    review_count: (card.review_count || 0) + 1,
  };
}

// ── State ──
let allCards = [];
let allDrafts = [];
let allTexts = [];
let allChunkProgress = [];
let sessionActive = false;
let sessionQueue = [];
let sessionRelearning = []; // lapsed cards waiting out their 10-min step
let sessionRatedIds = new Set(); // unique cards rated this session (summary count)
let sessionDone = 0;
let sessionCorrect = 0;
let sessionTotal = 0;
let sessionDeck = null;
let trSessionActive = false;
let trSessionDeck = null;
let trSessionTextId = null;
let trFreePractice = false;      // extra practice: revision without scheduling updates
let trFreePracticeLastChunk = null; // chunk_index just practiced (excluded from re-sampling)

// ── Deck table state ──
// Decks live in the flashcard_decks DB table. Loaded into maps for fast lookup.
const SHARED_CATEGORY = SHARED_CAT_CONST;
let _deckMap = new Map();     // id → row
let _deckByName = new Map();  // name → row (backward compat)
let _defaultDeckId = null;    // protected default row
let _sharedDeckId = null;     // protected __shared__ row
let _deckTree = null;         // buildSectionTree over deck rows (sections + buckets)
const FLASH_SECTION_DEFAULT_COLOR = '#3b82f6';

async function loadFlashcardDecks() {
  const { data, error } = await state.db.from('flashcard_decks').select('*').order('sort_order', { ascending: true });
  if (error) { console.warn('loadFlashcardDecks error:', error); return; }
  _deckMap.clear();
  _deckByName.clear();
  _defaultDeckId = null;
  _sharedDeckId = null;
  for (const row of (data || [])) {
    normalizeSectionFields(row);
    _deckMap.set(row.id, row);
    // First wins: with sibling-scoped names, two decks in different
    // sections can share a name, and legacy name lookups (cards/texts
    // without deck_id, draft proposals) must resolve stably to the
    // oldest one instead of drifting to the newest duplicate.
    if (!_deckByName.has(row.name)) _deckByName.set(row.name, row);
    if (row.is_protected && row.name === SHARED_CATEGORY) _sharedDeckId = row.id;
    else if (row.is_protected && row.name !== SHARED_CATEGORY) _defaultDeckId = row.id;
  }
  _deckTree = buildSectionTree([..._deckMap.values()]);
  await backfillCategoryColors('flashcard_decks', _deckMap);
}

function getDeckTree() {
  if (!_deckTree) _deckTree = buildSectionTree([..._deckMap.values()]);
  return _deckTree;
}

// Item count for one deck bucket (cards for card decks, texts for text decks).
function deckItemCount(deckId) {
  return getDeckType(deckId) === 'text'
    ? allTexts.filter(tx => deckIdForText(tx) === deckId).length
    : allCards.filter(c => deckIdForCard(c) === deckId).length;
}

// Item count for a section node: the sum over its descendant buckets.
function deckSectionItemCount(node) {
  return descendantBucketIds(node).reduce((sum, id) => sum + deckItemCount(id), 0);
}

function getFlashcardDecks() { return _deckMap; }

// ── Deck helpers ──
function getDeckColorById(deckId) { return _deckMap.get(deckId)?.color || FLASH_DEFAULT_COLOR; }
function getDeckShortname(deckId) { return _deckMap.get(deckId)?.shortname || ''; }
function getDeckName(deckId) { return _deckMap.get(deckId)?.name ?? ''; }
function getDeckDisplayName(deckId) {
  const deck = _deckMap.get(deckId);
  if (!deck) return t('common.category_default');
  if (deck.name === '') return t('common.category_default');
  if (deck.name === SHARED_CATEGORY) return t('sharing.shared');
  return deck.name;
}
function deckIdForCard(card) { return card.deck_id || _deckByName.get(card.deck ?? '')?.id || _defaultDeckId; }
function deckIdForText(text) { return text.deck_id || _deckByName.get(text.deck ?? '')?.id || _defaultDeckId; }

// Backward-compat: accepts name or ID
const FLASH_DEFAULT_COLOR = '#8b5cf6';
function getDeckColor(nameOrId) {
  if (_deckMap.has(nameOrId)) return _deckMap.get(nameOrId).color || FLASH_DEFAULT_COLOR;
  const byName = _deckByName.get(nameOrId);
  if (byName) return byName.color || FLASH_DEFAULT_COLOR;
  return FLASH_DEFAULT_COLOR;
}

function getFlashShortname(nameOrId) {
  if (_deckMap.has(nameOrId)) return _deckMap.get(nameOrId).shortname || '';
  const byName = _deckByName.get(nameOrId);
  if (byName) return byName.shortname || '';
  return '';
}

const DRAFT_COLOR = '#6b7280';

// ── Data Loading ──
async function refreshFlashcards() {
  if (!state.db.connected) return;
  await loadFlashcardDecks();
  allCards = await fetchAll(() => state.db.from('flashcards').select('*').order('created_at'));
  allDrafts = await fetchAll(() => state.db.from('flashcard_notes').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: false }));
  try {
    allTexts = await fetchAll(() => state.db.from('texts').select('*').order('created_at'));
  } catch (e) { allTexts = []; }
  // A failed progress read must never be mistaken for an empty progress
  // table: auto-repair only runs when the read actually succeeded, so a
  // transient backend error can't trigger blank inserts that would wipe
  // real FSRS state.
  let progressReadOk = false;
  try {
    allChunkProgress = await fetchAll(() => state.db.from('text_line_progress').select('*').order('chunk_index'));
    progressReadOk = true;
  } catch (e) { allChunkProgress = []; }
  // Auto-repair: progress rows must match the current chunking. Regenerate
  // when missing entirely or when the count mismatches (partial insert, or
  // chunking changed without invalidation) — stale rows are dropped first.
  // Backend mutations are error-checked: in-memory state is only touched
  // after successful writes, otherwise the next load retries.
  if (progressReadOk) for (const tx of allTexts) {
    if (!tx.content) continue;
    const existing = allChunkProgress.filter(ch => ch.text_id === tx.id);
    const chunkCount = getTextChunks(tx).length;
    if (existing.length !== chunkCount) {
      try {
        if (existing.length > 0 && state.db.connected) {
          const { error: delError } = await state.db.from('text_line_progress').delete().eq('text_id', tx.id);
          if (delError) throw delError;
          allChunkProgress = allChunkProgress.filter(ch => ch.text_id !== tx.id);
        }
        const rows = Array.from({ length: chunkCount }, (_, idx) => ({ text_id: tx.id, chunk_index: idx }));
        if (rows.length > 0 && state.db.connected) {
          const { data: inserted, error: insError } = await state.db.from('text_line_progress').insert(rows).select('*');
          if (insError) throw insError;
          if (inserted) allChunkProgress.push(...inserted);
        }
      } catch (_) { /* silent — will retry next load */ }
    }
  }
  // Decks already loaded via loadFlashcardDecks() above
  if (state.currentView === 'flashcards') renderFlashcards();
}

// ── Deck Nav Buttons ──
// ── Deck Type helpers ──
// A deck is either 'flashcard' or 'text', stored on the deck row at creation.
// Legacy rows without a stored type fall back to inferring from content.
function getDeckType(deckId) {
  const row = _deckMap.get(deckId);
  if (row?.deck_type === 'text' || row?.deck_type === 'flashcard') return row.deck_type;
  const hasCards = allCards.some(c => deckIdForCard(c) === deckId);
  const hasTexts = allTexts.some(tx => deckIdForText(tx) === deckId);
  // If somehow both (shouldn't happen), prefer flashcard
  if (hasCards) return 'flashcard';
  if (hasTexts) return 'text';
  return 'flashcard'; // default
}

// Deck options for the edit modals: only same-type buckets, never
// __shared__ and never sections (bucket-only pickers). A card in a
// text deck (or a text in a flashcard deck) would be invisible, since
// deck buckets render by deck type — so cross-type moves are excluded.
// Labels carry the section path, so two same-name decks in different
// sections are distinguishable (values are ids, so the choice is exact).
function deckOptionsForEdit(type, currentDeckId) {
  const tree = getDeckTree();
  // Tree display order (DFS), so decks inside a section sit under it
  // in the picker instead of interleaving by global sort_order.
  return flattenTree(tree.roots)
    .filter(n => n.kind === 'bucket')
    .map(n => n.row)
    .filter(d => d.id !== _sharedDeckId && getDeckType(d.id) === type)
    .map(d => {
      const node = tree.byId.get(d.id);
      const label = node ? pathLabelOf(node, tree.byId) : (d.name || t('common.category_default'));
      return `<option value="${esc(d.id)}" ${d.id === currentDeckId ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

// __shared__ deck is shown only when it has items
function hasSharedDeckItems() {
  return allCards.some(c => deckIdForCard(c) === _sharedDeckId) || allTexts.some(tx => deckIdForText(tx) === _sharedDeckId);
}

function renderDeckNavButtons() {
  const container = document.getElementById('flashcardNavButtons');
  if (!container) return;
  const tree = getDeckTree();
  const showShared = hasSharedDeckItems();
  // Top-level nav only: sections and top-level buckets, in tree order.
  // Section buttons navigate to the section block; their count is the
  // sum over descendant buckets. The shared deck stays in nav only
  // while it has items, like before.
  const roots = tree.roots.filter(n => n.kind !== 'bucket' || n.id !== _sharedDeckId || showShared);

  // Draft nav button first
  let html = `<button class="category-nav-btn" style="--cat-color:${DRAFT_COLOR}" data-action="navigate-to-flash-deck" data-deck="__drafts">${lucideIcon('file-edit', 14, DRAFT_COLOR)} ${t('flashcards.draft')} (${allDrafts.length})</button>`;

  html += roots.map(node => {
    const row = node.row;
    const color = row.color || FLASH_DEFAULT_COLOR;
    if (node.kind === 'section') {
      const display = row.shortname || row.name || '';
      return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-flash-section" data-deck="${esc(row.id)}" title="${esc(row.name || '')}">${lucideIcon('folder', 12, color)} ${esc(display)} (${deckSectionItemCount(node)})</button>`;
    }
    const deckId = row.id;
    const sn = getDeckShortname(deckId);
    const display = sn || getDeckDisplayName(deckId);
    const type = getDeckType(deckId);
    const icon = type === 'text' ? lucideIcon('book-open', 12, color) : lucideIcon('layers', 12, color);
    return `<button class="category-nav-btn" style="--cat-color:${color}" data-action="navigate-to-flash-deck" data-deck="${esc(deckId)}" title="${esc(getDeckDisplayName(deckId))}">${icon} ${esc(display)} (${deckItemCount(deckId)})</button>`;
  }).join('');

  container.innerHTML = html;
}

window.navigateToFlashDeck = function(deck) {
  const el = document.getElementById(deck === '__drafts' ? 'flashDraftsDeck' : `flashDeck-${deck}`);
  scrollToAndHighlight(el, null);
};

window.navigateToFlashSection = function(sectionId) {
  const el = document.getElementById(`flashSection-${sectionId}`);
  const color = _deckMap.get(sectionId)?.color || FLASH_SECTION_DEFAULT_COLOR;
  scrollToAndHighlight(el, color);
};

// Renumber exactly the ids passed (top-level roots from the nav, or one
// section's children from its chips row) — sort_order is per parent.
async function reorderDeckSiblings(orderedIds) {
  const reorderable = orderedIds.filter(id => id !== '__drafts' && id !== _sharedDeckId);
  const deckRows = reorderable.map(id => _deckMap.get(id)).filter(Boolean);
  const updates = [];
  deckRows.forEach((d, i) => {
    if (Number(d.sort_order ?? 0) !== i) updates.push({ id: d.id, sort_order: i });
    d.sort_order = i;
  });
  await bulkSortOrder('flashcard_decks', updates);
  await loadFlashcardDecks();
  const grid = document.getElementById('flashcardGrid');
  const snapshot = snapshotBuckets(grid);
  renderFlashcards();
  animateBucketsFromSnapshot(grid, snapshot, 600);
  showToast(t('toast.reordered'), 'success');
}

/** Cross-section chip drag — mirrors listNavCrossDrop in lists.js. */
function flashDeckCrossDrop() {
  return {
    rootEl: document.getElementById('flashcardsView'),
    rowOwner: (rowEl) => rowEl.id === 'flashcardNavButtons' ? null
      : rowEl.id.startsWith('flashSectionChips-') ? rowEl.id.slice('flashSectionChips-'.length) : undefined,
    canDrop: (dragId, parentId) => {
      const node = getDeckTree().byId.get(dragId);
      if (!node) return false;
      // Protected decks (default, shared) never move into a section.
      if (node.row.is_protected) return false;
      if ((node.parentId || null) === (parentId || null)) return false;
      return !planNodeMove([..._deckMap.values()], dragId, parentId, null).error;
    },
    onMove: (dragId, parentId, beforeId) => moveDeckNodeToParent(dragId, parentId, beforeId),
  };
}

async function moveDeckNodeToParent(dragId, parentId, beforeId) {
  const plan = planNodeMove([..._deckMap.values()], dragId, parentId, beforeId);
  if (plan.error || !plan.updates?.length) return;
  const grid = document.getElementById('flashcardGrid');
  const snapshot = snapshotBuckets(grid);
  for (const u of plan.updates) {
    await state.db.from('flashcard_decks').update({ parent_id: u.parent_id, sort_order: u.sort_order }).eq('id', u.id);
  }
  await refreshFlashcards();
  animateBucketsFromSnapshot(grid, snapshot, 600);
}

function initFlashDeckNavBtnReorder() {
  const skipIds = new Set(['__drafts']);
  if (_sharedDeckId) skipIds.add(_sharedDeckId);
  initNavBtnReorder('flashcardNavButtons', {
    idAttr: 'deck',
    skipIds,
    onReorder: reorderDeckSiblings,
    crossDrop: flashDeckCrossDrop(),
  });
}

function initFlashSectionNavBtnReorder(sectionId) {
  initNavBtnReorder('flashSectionChips-' + sectionId, {
    idAttr: 'deck',
    skipIds: new Set(),
    onReorder: reorderDeckSiblings,
    crossDrop: flashDeckCrossDrop(),
  });
}

// ── Search State ──
let searchQuery = '';
let flashcardFilter = 'all';

// ── Main Render ──
function setFlashcardFilter(filter) {
  flashcardFilter = filter;
  document.querySelectorAll('#flashcardFilters .filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderFlashcards();
}

function renderFlashcards() {
  renderDeckNavButtons();
  initFlashDeckNavBtnReorder();
  renderAllBuckets();
}

// Render one tree level: sections become section blocks, buckets become
// deck buckets. Under a search query a section shows only when its own
// name matches or one of its descendant decks renders something.
function renderFlashLevel(nodes, q) {
  let html = '';
  for (const node of nodes) {
    if (node.kind === 'section') {
      const nameMatches = q && (node.row.name || '').toLowerCase().includes(q);
      const childrenHtml = renderFlashLevel(node.children, q);
      if (q && !nameMatches && !childrenHtml) continue;
      html += renderFlashSection(node, childrenHtml);
    } else {
      if (node.id === _sharedDeckId && !hasSharedDeckItems()) continue;
      html += renderDeckBucket(node.id, q);
    }
  }
  return html;
}

function renderFlashSection(node, childrenHtml) {
  const section = node.row;
  const color = section.color || FLASH_SECTION_DEFAULT_COLOR;
  const total = deckSectionItemCount(node);
  // Chips row: one nav button per child (sections navigate to their
  // block, buckets to their deck), draggable across sections via the
  // same crossDrop as the top nav.
  const chips = node.children.map(child => {
    const isSec = child.kind === 'section';
    const count = isSec ? deckSectionItemCount(child) : deckItemCount(child.id);
    const childColor = child.row.color || (isSec ? FLASH_SECTION_DEFAULT_COLOR : FLASH_DEFAULT_COLOR);
    const label = child.row.shortname || child.row.name || '';
    const title = child.row.name || '';
    const icon = isSec ? lucideIcon('folder', 12, childColor)
      : (getDeckType(child.id) === 'text' ? lucideIcon('book-open', 12, childColor) : lucideIcon('layers', 12, childColor));
    const action = isSec ? 'navigate-to-flash-section' : 'navigate-to-flash-deck';
    return `<button class="category-nav-btn" style="--cat-color:${childColor}" data-action="${action}" data-deck="${esc(child.id)}" title="${esc(title)}">${icon} ${esc(label)} (${count})</button>`;
  }).join('');
  const inner = childrenHtml || `<p class="empty-msg">${t('common.section_empty')}</p>`;
  return `<div class="section-block" id="flashSection-${esc(section.id)}" data-node-kind="section" data-node-id="${esc(section.id)}" style="--cat-color:${color};--cat-on-color:${onColorFor(color)}">
    <div class="section-header" data-action="toggle-section-chips">
      <div class="section-header-left">
        <h3 class="section-name">${lucideIcon('folder', 16)} ${esc(section.name || '')}</h3>
        <span class="section-stats">(${total})</span>
      </div>
      <div class="section-header-actions">
        <button class="todo-cat-shortname-btn" data-action="open-add-flash-deck-in-section" data-deck="${esc(section.id)}" title="${esc(t('flashcards.new_deck'))}">${lucideIcon('folder-plus', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="flashsection" data-id="${esc(section.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
        <button class="todo-cat-shortname-btn" data-action="prompt-flash-shortname" data-deck="${esc(section.id)}" title="${esc(t('flashcards.edit_deck'))}">${lucideIcon('pencil', 14)}</button>
        <button class="todo-cat-delete-btn" data-action="delete-flash-section" data-deck="${esc(section.id)}" title="${esc(t('common.delete'))}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
    <div class="category-nav-buttons section-chips${node.children.length > 1 ? '' : ' section-chips-collapsed'}" id="flashSectionChips-${esc(section.id)}">${chips}</div>
    <div class="section-level">${inner}</div>
  </div>`;
}

function renderAllBuckets() {
  const grid = document.getElementById('flashcardGrid');
  if (!grid) return;
  grid.className = 'project-grid';

  const q = searchQuery.toLowerCase().trim();

  // Draft bucket first
  let html = renderDraftsBucket(q);

  // Then the deck tree (sections + top-level buckets)
  html += renderFlashLevel(getDeckTree().roots, q);

  if (!html.trim()) {
    html = `<div class="fc-empty-state">
      <div class="fc-empty-icon">${lucideIcon('brain', 40, '#8b5cf6')}</div>
      <h3>${t('flashcards.no_flashcards')}</h3>
      <p>${t('flashcards.no_flashcards_hint')}</p>
    </div>`;
  }

  const scrollY = window.scrollY;
  const innerScrolls = captureInnerScrollPositions(grid);
  grid.innerHTML = html;
  window.scrollTo(0, scrollY);
  restoreInnerScrollPositions(grid, innerScrolls);
  initFlashcardHoverDelay(grid);
  // Init draft reorder
  const draftDeck = document.getElementById('flashDraftsDeck');
  if (draftDeck) {
    const draftList = draftDeck.querySelector('.task-list');
    if (draftList) initDraftDragDrop(draftList);
  }
  // Section chips rows are re-created with the grid, so their drag
  // handlers are (re)bound here after every grid render, like Lists
  // does for its section chips.
  const deckTree = getDeckTree();
  const walkSections = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'section') { initFlashSectionNavBtnReorder(n.id); walkSections(n.children); }
    }
  };
  walkSections(deckTree.roots);
  // Bind expand toggles for text items
  grid.querySelectorAll('.tr-expand-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const textId = e.currentTarget.dataset.textId;
      const body = document.getElementById(`trBody-${textId}`);
      if (body) {
        const showing = body.style.display !== 'none';
        body.style.display = showing ? 'none' : 'block';
        e.currentTarget.querySelector('.lucide-icon').style.transform = showing ? '' : 'rotate(180deg)';
      }
    });
  });
  // Per-level section layout (like Lists): top-level buckets and
  // section blocks share one width, each section's own level is laid
  // out capped at the span it was given. Deck buckets carry
  // data-node-kind so the layout sees them.
  applySectionGrid(grid);
}

function initFlashcardHoverDelay(container) {
  initItemHoverDelay(container, {
    itemSelector: '.todo-item',
    actionsSelector: '.todo-actions',
    rowSelector: '.todo-row',
    textSelector: '.todo-text',
    onDblClick: (item) => {
      const draftId = item.dataset.draftId;
      const cardId = item.dataset.cardId;
      if (draftId) {
        window.startInlineEditDraftById(draftId);
      } else if (cardId) {
        window.editFlashcardInline(cardId);
      }
    },
  });
}

function initDraftDragDrop(listEl) {
  initItemDragDrop(listEl, {
    itemSelector: '.todo-item[data-draft-id]',
    excludeSelector: 'button, a, input, textarea, select, .todo-actions, .fc-proposal',
    idAttr: 'draftId',
    actionsSelector: '.todo-actions',
    onReorder: async (orderedIds) => {
      await reorderItems({
        orderedIds,
        allItems: allDrafts,
        tableName: 'flashcard_notes',
        reinitFn: () => initDraftDragDrop(listEl),
      });
    },
  });
}

// ── Draft Bucket ──
function renderDraftsBucket(q) {
  let drafts = allDrafts;
  if (q) drafts = drafts.filter(d => d.content.toLowerCase().includes(q));

  const pendingCount = drafts.filter(d => d.proposal_status === 'pending').length;
  const readyCount = drafts.filter(d => d.proposal_status === 'ready').length;

  const chips = [];
  if (pendingCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${pendingCount} ${t('flashcards.generating')}</span>`);
  if (readyCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${readyCount} ready</span>`);

  return `<div class="project-card" id="flashDraftsDeck" data-node-kind="bucket" data-node-id="__drafts" style="--cat-color:${DRAFT_COLOR}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('file-edit', 16)} ${t('flashcards.draft')}</strong>
          <span class="tech">${drafts.length} items ${chips.join(' ')}</span>
        </div>
      </div>
      <div class="project-header-actions">
        <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="flashdeck" data-id="__drafts" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
      </div>
    </div>
    <div class="add-task">
      <textarea placeholder="${t('flashcards.draft_placeholder')}" id="draftQuickInput" data-action="handle-draft-input" rows="1" style="resize:none;overflow:hidden;"></textarea>
      <button data-action="quick-add-draft">${lucideIcon('plus', 16)}</button>
    </div>
    <div class="task-list">
      ${drafts.length === 0 ? '<p class="empty-msg">' + t('flashcards.draft_hint') + '</p>' : ''}
      ${drafts.map(d => renderDraftItem(d)).join('')}
    </div>
  </div>`;
}

function renderDraftItem(d) {
  const hasProposal = d.proposal_status === 'ready' && d.proposed_front && d.proposed_back;
  const isPending = d.proposal_status === 'pending';

  let proposalHtml = '';
  if (hasProposal) {
    const suggestedDeck = d.proposed_deck || '';
    const deckOptions = proposalDeckOptions(suggestedDeck);
    proposalHtml = `<div class="fc-proposal">
      <div class="fc-proposal-label">${lucideIcon('sparkles', 14, '#22c55e')} Proposed card:</div>
      <div class="fc-proposal-qa"><strong>Q:</strong> ${esc(d.proposed_front)}</div>
      <div class="fc-proposal-qa"><strong>A:</strong> ${esc(d.proposed_back)}</div>
      <div class="fc-proposal-deck"><strong>${t('flashcards.deck')}:</strong> <select data-action="update-proposed-deck" data-id="${esc(d.id)}">${deckOptions}</select></div>
      <div class="fc-proposal-actions">
        <button class="fc-proposal-accept" data-action="accept-proposal" data-id="${esc(d.id)}" title="${t('flashcards.accept')}">${lucideIcon('check', 14, '#fff')} <span class="btn-label">${t('flashcards.accept')}</span></button>
        <button class="fc-proposal-edit" data-action="edit-proposal" data-id="${esc(d.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 14)} <span class="btn-label">${t('common.edit')}</span></button>
        <button class="fc-proposal-feedback-btn" data-action="toggle-feedback-input" data-id="${esc(d.id)}" title="${t('flashcards.feedback')}">${lucideIcon('message-square', 14)} <span class="btn-label">${t('flashcards.feedback')}</span></button>
        <button class="fc-proposal-reject" data-action="reject-proposal" data-id="${esc(d.id)}" title="${t('flashcards.reject')}">${lucideIcon('x', 14)} <span class="btn-label">${t('flashcards.reject')}</span></button>
      </div>
      <div class="fc-feedback-area" id="feedbackArea-${d.id}" style="display:none;">
        <textarea class="fc-feedback-input" id="feedbackInput-${d.id}" placeholder="${t('flashcards.feedback_placeholder')}" rows="2"></textarea>
        <button class="fc-feedback-submit" data-action="submit-feedback" data-id="${esc(d.id)}">${lucideIcon('send', 14, '#fff')} ${t('flashcards.feedback')}</button>
      </div>
    </div>`;
  }
  const draftCls = hasProposal ? ' draft-ready' : isPending ? ' draft-pending' : ' draft-empty';

  return `<div class="bucket-item todo-item${draftCls}" data-draft-id="${d.id}">
    <div class="todo-row">
      <span class="todo-text" style="cursor:text;">${esc(d.content.length > 120 ? d.content.slice(0, 120) + '…' : d.content)}</span>
      ${isPending ? `<span class="fc-status-badge fc-status-pending">${t('flashcards.generating')}</span>` : ''}
      <div class="todo-actions">
        <button data-action="copy-item-link" data-link-type="flashdraft" data-id="${esc(d.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 16)}</button>
        ${!hasProposal && !isPending ? `<button data-action="request-proposal" data-id="${esc(d.id)}" title="${t('flashcards.propose')}">${lucideIcon('sparkles', 16)}</button>` : ''}
        <button data-action="start-inline-edit-draft" data-id="${esc(d.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button data-action="delete-draft" data-id="${esc(d.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
    ${proposalHtml}
  </div>`;
}

// ── Deck Bucket ──
function renderDeckBucket(deckId, q) {
  const type = getDeckType(deckId);
  return type === 'text' ? renderTextDeck(deckId, q) : renderFlashcardDeck(deckId, q);
}

function renderFlashcardDeck(deckId, q) {
  let cards = allCards.filter(c => deckIdForCard(c) === deckId);
  if (q) {
    cards = cards.filter(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
  }

  // Apply flashcard filter
  const now = new Date();
  if (flashcardFilter === 'due') {
    cards = cards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now));
  } else if (flashcardFilter === 'new') {
    cards = cards.filter(c => !c.last_review);
  } else if (flashcardFilter === 'mastered') {
    cards = cards.filter(c => c.last_review && c.stability >= 21 && c.next_review && new Date(c.next_review) > now);
  }

  if (cards.length === 0 && (q || flashcardFilter !== 'all')) return '';

  // Apply sort to cards
  const sortBy = document.getElementById('flashcardSortBy')?.value || 'default';
  const nowStr = now.toISOString();
  if (sortBy === 'strength') {
    cards.sort((a, b) => {
      const rA = a.last_review && a.stability ? retrievability(a.stability, a.last_review, nowStr) : 2;
      const rB = b.last_review && b.stability ? retrievability(b.stability, b.last_review, nowStr) : 2;
      return rA - rB;
    });
  } else if (sortBy === 'last-reviewed') {
    cards.sort((a, b) => {
      const aDate = a.last_review ? new Date(a.last_review).getTime() : 0;
      const bDate = b.last_review ? new Date(b.last_review).getTime() : 0;
      return bDate - aDate;
    });
  } else {
    cards.sort((a, b) => {
      const rA = a.last_review && a.stability ? retrievability(a.stability, a.last_review, nowStr) : 2;
      const rB = b.last_review && b.stability ? retrievability(b.stability, b.last_review, nowStr) : 2;
      return rA - rB;
    });
  }

  const color = getDeckColorById(deckId);
  const allDeckCards = allCards.filter(c => deckIdForCard(c) === deckId);
  const newCount = allDeckCards.filter(c => !c.last_review).length;
  const dueCount = allDeckCards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now)).length;

  const chips = [];
  if (newCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${newCount} ${t('flashcards.new_count')}</span>`);
  if (dueCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${dueCount} ${t('flashcards.due_count')}</span>`);

  const practiceCount = dueCount + newCount;
  let practiceButton = '';
  if (practiceCount > 0) {
    practiceButton = `<button class="fc-practice-btn" data-action="start-practice" data-deck="${esc(deckId)}" title="${t('flashcards.practice')}">${lucideIcon('play', 14, '#fff')} ${practiceCount}</button>`;
  } else if (allDeckCards.length > 0) {
    practiceButton = `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')}</span>`;
  }

  return `<div class="project-card" id="flashDeck-${esc(deckId)}" data-node-kind="bucket" data-node-id="${esc(deckId)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('layers', 14)} ${esc(getDeckDisplayName(deckId))}</strong>
          <span class="tech">${allDeckCards.length} ${t('flashcards.cards')} ${chips.join(' ')}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${practiceButton}
        <div class="project-header-actions">
          <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="flashdeck" data-id="${esc(deckId)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
          ${deckId !== _defaultDeckId ? `<button class="todo-cat-shortname-btn" data-action="prompt-flash-shortname" data-deck="${esc(deckId)}" title="${t('flashcards.edit_deck')}">${lucideIcon("pencil",14)}</button>` : ''}
          <button class="archive-project-btn" data-action="open-add-flashcard" data-deck="${esc(deckId)}" title="${t('flashcards.add_card')}">${lucideIcon('plus', 16)}</button>
          ${deckId !== _defaultDeckId ? `<button class="todo-cat-delete-btn" data-action="delete-deck" data-deck="${esc(deckId)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>` : ''}
        </div>
      </div>
    </div>
    <div class="task-list">
      ${cards.length > 0 ? cards.map(c => renderFlashcardItem(c, color)).join('') : `<div class="page-empty-state" style="padding:24px 16px;"><p style="color:var(--muted);font-size:0.85rem;">${t('flashcards.empty_deck_hint')}</p><button class="empty-cta" data-action="open-add-flashcard" data-deck="${esc(deckId)}">${lucideIcon('plus', 16)} ${t('flashcards.add_card')}</button></div>`}
    </div>
  </div>`;
}

function renderTextDeck(deckId, q) {
  let texts = allTexts.filter(tx => deckIdForText(tx) === deckId);
  if (q) {
    texts = texts.filter(tx => tx.title.toLowerCase().includes(q) || (tx.author || '').toLowerCase().includes(q) || (tx.content || '').toLowerCase().includes(q));
  }

  // Apply filter
  const now = new Date();
  if (flashcardFilter === 'due') {
    texts = texts.filter(tx => {
      const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
      return chunks.some(ch => ch.last_review && (!ch.next_review || new Date(ch.next_review) <= now));
    });
  } else if (flashcardFilter === 'new') {
    texts = texts.filter(tx => {
      const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
      return chunks.some(ch => !ch.last_review);
    });
  } else if (flashcardFilter === 'mastered') {
    texts = texts.filter(tx => {
      const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
      return chunks.length > 0 && chunks.every(ch => ch.last_review && ch.stability >= 21 && ch.next_review && new Date(ch.next_review) > now);
    });
  }

  if (texts.length === 0 && (q || flashcardFilter !== 'all')) return '';

  const color = getDeckColorById(deckId);
  const allDeckTexts = allTexts.filter(tx => deckIdForText(tx) === deckId);

  // Text due/new counts
  const textChunks = allDeckTexts.flatMap(tx => allChunkProgress.filter(ch => ch.text_id === tx.id));
  const textNewCount = textChunks.filter(ch => !ch.last_review).length;
  const textDueCount = textChunks.filter(ch => ch.last_review && (!ch.next_review || new Date(ch.next_review) <= now)).length;

  const chips = [];
  if (textNewCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${textNewCount} ${t('flashcards.new_count')}</span>`);
  if (textDueCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${textDueCount} ${t('flashcards.due_count')}</span>`);

  const trPracticeCount = textDueCount + textNewCount;
  let practiceButton = '';
  if (trPracticeCount > 0) {
    practiceButton = `<button class="fc-practice-btn tr-practice-btn" data-action="start-text-practice" data-deck="${esc(deckId)}" title="${t('text_revision.practice')}">${lucideIcon('book-open', 14, '#fff')} ${trPracticeCount}</button>`;
  } else if (allDeckTexts.length > 0) {
    practiceButton = `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')}</span>`;
  }

  return `<div class="project-card" id="flashDeck-${esc(deckId)}" data-node-kind="bucket" data-node-id="${esc(deckId)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('book-open', 14)} ${esc(getDeckDisplayName(deckId))}</strong>
          <span class="tech">${allDeckTexts.length} ${t('text_revision.texts')} ${chips.join(' ')}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${practiceButton}
        <div class="project-header-actions">
          <button class="todo-cat-shortname-btn" data-action="copy-item-link" data-link-type="flashdeck" data-id="${esc(deckId)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 14)}</button>
          ${deckId !== _defaultDeckId ? `<button class="todo-cat-shortname-btn" data-action="prompt-flash-shortname" data-deck="${esc(deckId)}" title="${t('flashcards.edit_deck')}">${lucideIcon("pencil",14)}</button>` : ''}
          <button class="archive-project-btn" data-action="open-add-text" data-deck="${esc(deckId)}" title="${t('text_revision.add_text')}">${lucideIcon('plus', 16)}</button>
          ${deckId !== _defaultDeckId ? `<button class="todo-cat-delete-btn" data-action="delete-deck" data-deck="${esc(deckId)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>` : ''}
        </div>
      </div>
    </div>
    <div class="task-list">
      ${texts.length > 0 ? texts.map(tx => renderTextItem(tx, color)).join('') : `<div class="page-empty-state" style="padding:24px 16px;"><p style="color:var(--muted);font-size:0.85rem;">${t('flashcards.empty_deck_hint')}</p><button class="empty-cta" data-action="open-add-text" data-deck="${esc(deckId)}">${lucideIcon('plus', 16)} ${t('text_revision.add_text')}</button></div>`}
    </div>
  </div>`;
}

function renderFlashcardItem(c, color) {
  const now = new Date();
  const isNew = !c.last_review;
  const isDue = !isNew && (!c.next_review || new Date(c.next_review) <= now);
  const R = c.last_review && c.stability ? retrievability(c.stability, c.last_review, now.toISOString()) : null;

  let badge = '';
  if (isNew) badge = `<span class="fc-status-badge fc-status-new">${t('flashcards.new_card')}</span>`;
  else if (isDue) badge = `<span class="fc-status-badge fc-status-due">${t('flashcards.due')}</span>`;
  else {
    const daysLeft = c.next_review ? Math.ceil((new Date(c.next_review) - now) / 86400000) : 0;
    badge = `<span class="fc-status-badge fc-status-ok">${t('flashcards.days_left', daysLeft)}</span>`;
  }

  // Left border color: smooth gradient from red (R=0) → amber (R=0.5) → green (R=1), grey for new
  let borderColor = 'var(--muted)';
  if (R !== null) {
    // Interpolate hue: 0 (red) → 38 (amber) → 142 (green) based on R
    const hue = R <= 0.5
      ? Math.round(R * 2 * 38)            // 0→38
      : Math.round(38 + (R - 0.5) * 2 * 104); // 38→142
    const sat = 70 + Math.round(R * 15);   // 70-85%
    const lum = 40 + Math.round(R * 10);   // 40-50%
    borderColor = `hsl(${hue}, ${sat}%, ${lum}%)`;
  }

  const frontTrunc = c.front.length > 90 ? c.front.slice(0, 90) + '…' : c.front;

  return `<div class="bucket-item todo-item${isDue ? ' todo-overdue' : ''}" data-card-id="${c.id}" style="border-left:3px solid ${borderColor};">
    <div class="todo-row">
      <span class="todo-text">${esc(frontTrunc)}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${badge}
      </div>
      <div class="todo-actions">
        <button data-action="copy-item-link" data-link-type="flashcard" data-id="${esc(c.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 16)}</button>
        <button data-action="open-edit-flashcard" data-id="${esc(c.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button data-action="delete-flashcard" data-id="${esc(c.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
  </div>`;
}

window.filterFlashcards = function(e) {
  searchQuery = e.target.value;
  renderAllBuckets();
};

// ── Draft CRUD ──
window.openAddDraftModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addDraftModal" style="display:flex;" data-action="close-add-draft" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('file-edit', 18, DRAFT_COLOR)} ${t('flashcards.add_draft')}</h2>
      <label>${t('flashcards.what_to_learn')}</label>
      <textarea id="newDraftContent" rows="4" placeholder="${t('flashcards.learn_placeholder')}"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-add-draft">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-new-draft">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newDraftContent').focus();
};

window.closeAddDraftModal = function() {
  const m = document.getElementById('addDraftModal'); if (m) m.remove();
};

window.saveNewDraft = async function() {
  const content = document.getElementById('newDraftContent').value.trim();
  if (!content) { showToast(t('toast.content_required')); return; }
  if (state.db.connected) await state.db.from('flashcard_notes').insert({ content });
  closeAddDraftModal();
  await refreshFlashcards();
  showToast(t('flashcards.draft_added'));
};

window.handleDraftInput = function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickAddDraft(); }
  else { setTimeout(() => autoResizeTextarea(e.target), 0); }
};

document.addEventListener('input', e => {
  if (e.target.id === 'draftQuickInput') autoResizeTextarea(e.target);
});

window.quickAddDraft = async function() {
  const input = document.getElementById('draftQuickInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  if (state.db.connected) await state.db.from('flashcard_notes').insert({ content });
  input.value = '';
  input.style.height = '';
  await refreshFlashcards();
  showToast(t('flashcards.draft_added'));
};

// ── Inline Draft Editing (uses shared inlineEditText) ──
window.startInlineEditDraft = function(id, spanEl) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  inlineEditText(spanEl, draft.content, {
    containerEl: spanEl.closest('.todo-item, .draft-item'),
    saveFn: async (content) => {
      if (state.db.connected) {
        await state.db.from('flashcard_notes').update({ content }).eq('id', id);
        draft.content = content;
        showToast(t('flashcards.draft_updated'));
      }
    },
    refreshFn: refreshFlashcards,
  });
};

window.startInlineEditDraftById = function(id) {
  const el = document.querySelector(`[data-draft-id="${id}"] .todo-text`);
  if (el) window.startInlineEditDraft(id, el);
};

window.editFlashcardInline = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  const spanEl = document.querySelector(`[data-card-id="${id}"] .todo-text`);
  if (!spanEl) return;

  // Build answer row as extraEl
  const answerRow = document.createElement('div');
  answerRow.className = 'fc-inline-answer-row';
  const answerLabel = document.createElement('label');
  answerLabel.className = 'fc-inline-answer-label';
  answerLabel.textContent = t('flashcards.answer');
  const answerInput = document.createElement('textarea');
  answerInput.className = 'task-edit-input fc-inline-answer';
  answerInput.value = card.back;
  answerInput.rows = Math.max(1, card.back.split('\n').length);
  answerInput.style.resize = 'none';
  answerInput.style.overflow = 'hidden';
  answerInput.style.flex = 'none';
  answerRow.appendChild(answerLabel);
  answerRow.appendChild(answerInput);

  // Auto-size the answer textarea
  function autoSizeAnswer() {
    answerInput.style.height = '0';
    answerInput.style.height = answerInput.scrollHeight + 'px';
  }
  answerInput.addEventListener('input', autoSizeAnswer);

  inlineEditText(spanEl, card.front, {
    multiline: true,
    extraEl: answerRow,
    containerEl: spanEl.closest('.flashcard-item, .todo-item'),
    collectExtra: () => ({ back: answerInput.value.trim() }),
    saveFn: async (newFront, extra) => {
      const updates = {};
      if (newFront !== card.front) updates.front = newFront;
      if (extra && extra.back && extra.back !== card.back) updates.back = extra.back;
      if (Object.keys(updates).length > 0 && state.db.connected) {
        await state.db.from('flashcards').update(updates).eq('id', id);
        Object.assign(card, updates);
        showToast(t('flashcards.card_updated'));
      }
    },
    refreshFn: refreshFlashcards,
  });
};

window.deleteDraft = function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  showConfirmAction('Delete Draft', 'Are you sure?', async () => {
    if (state.db.connected) await state.db.from('flashcard_notes').delete().eq('id', id);

    const el = document.querySelector(`[data-draft-id="${CSS.escape(id)}"]`);
    await animateItemRemoval(el);

    await refreshFlashcards();
    showToast(t('flashcards.draft_deleted'));
  });
};

// ── Proposal Workflow ──
const _pendingProposal = new Set();

function _setProposalBtns(id, pending) {
  const card = document.querySelector(`.draft-card[data-draft-id="${CSS?.escape ? CSS.escape(id) : id}"]`)
             || document.getElementById(`draft-${id}`);
  if (!card) return;
  card.querySelectorAll('button[data-action="accept-proposal"], button[data-action="reject-proposal"], button[data-action="request-proposal"]')
    .forEach(b => { b.disabled = pending; b.classList.toggle('is-pending', pending); });
}

window.requestProposal = async function(id) {
  if (!state.db.connected || _pendingProposal.has(id)) return;
  _pendingProposal.add(id);
  _setProposalBtns(id, true);
  try {
    await state.db.from('flashcard_notes').update({ proposal_status: 'pending' }).eq('id', id);
    const draft = allDrafts.find(d => d.id === id);
    if (draft) draft.proposal_status = 'pending';
    renderAllBuckets();
    showToast(t('flashcards.generating_proposal'));
  } finally { _pendingProposal.delete(id); }
};

window.acceptProposal = async function(id) {
  if (_pendingProposal.has(id)) return;
  const draft = allDrafts.find(d => d.id === id);
  if (!draft || !draft.proposed_front || !draft.proposed_back) return;
  _pendingProposal.add(id);
  _setProposalBtns(id, true);
  try {
    // Normalize the proposed deck through the deck row — the heartbeat's
    // proposed_deck is TEXT and only needs to match loosely; the write path
    // derives the canonical name + FK from the row. A section row can
    // never receive a card (deck buckets render by bucket only), so a
    // proposal resolving to a section falls back to the default deck.
    const proposedName = draft.proposed_deck || '';
    let deckRow = null;
    const resolvedId = resolveDraftDeckId(proposedName);
    if (resolvedId) deckRow = _deckMap.get(resolvedId);
    if (!deckRow || isSectionRow(deckRow)) deckRow = _deckMap.get(_defaultDeckId);
    const deckName = deckRow?.name ?? '';
    const deckId = deckRow?.id || _defaultDeckId;
    if (state.db.connected) {
      await state.db.from('flashcards').insert({ deck: deckName, front: draft.proposed_front, back: draft.proposed_back, deck_id: deckId });
      await state.db.from('flashcard_notes').delete().eq('id', id);
    }
    await refreshFlashcards();
    showToast(t('flashcards.card_added_to', deckName || t('common.category_default')));
  } finally { _pendingProposal.delete(id); }
};

window.rejectProposal = async function(id) {
  if (!state.db.connected || _pendingProposal.has(id)) return;
  _pendingProposal.add(id);
  _setProposalBtns(id, true);
  try {
    await state.db.from('flashcard_notes').update({
      proposal_status: null, proposed_front: null, proposed_back: null
    }).eq('id', id);
    const draft = allDrafts.find(d => d.id === id);
    if (draft) { draft.proposal_status = null; draft.proposed_front = null; draft.proposed_back = null; }
    renderAllBuckets();
    showToast(t('flashcards.proposal_rejected'));
  } finally { _pendingProposal.delete(id); }
};

window.toggleFeedbackInput = function(id) {
  const area = document.getElementById(`feedbackArea-${id}`);
  if (!area) return;
  const isHidden = area.style.display === 'none';
  area.style.display = isHidden ? 'flex' : 'none';
  if (isHidden) {
    const input = document.getElementById(`feedbackInput-${id}`);
    if (input) input.focus();
  }
};

window.submitFeedback = async function(id) {
  const input = document.getElementById(`feedbackInput-${id}`);
  if (!input) return;
  const feedback = input.value.trim();
  if (!feedback) { showToast(t('toast.content_required')); return; }
  if (!state.db.connected) return;
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  // Strip any prior feedback from content, then append new feedback
  const baseContent = draft.content.split('\n===FEEDBACK===\n')[0].trim();
  const prevProposal = (draft.proposed_front && draft.proposed_back)
    ? `\nPrevious Q: ${draft.proposed_front}\nPrevious A: ${draft.proposed_back}`
    : '';
  const newContent = `${baseContent}\n===FEEDBACK===\n${feedback}${prevProposal}`;
  await state.db.from('flashcard_notes').update({
    content: newContent,
    proposal_status: 'pending',
  }).eq('id', id);
  draft.content = newContent;
  draft.proposal_status = 'pending';
  renderAllBuckets();
  showToast(t('flashcards.feedback_sent'));
};

window.editProposal = function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  closeAllFlashModals();
  const currentDeck = draft.proposed_deck || '';
  const deckOptions = proposalDeckOptions(currentDeck);
  const html = `<div class="modal-overlay" id="editProposalModal" style="display:flex;" data-action="close-edit-proposal" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#8b5cf6')} ${t('flashcards.edit_proposal')}</h2>
      <label>${t('flashcards.question')}</label>
      <textarea id="editProposalFront" rows="3">${esc(draft.proposed_front || '')}</textarea>
      <label>${t('flashcards.answer')}</label>
      <textarea id="editProposalBack" rows="4">${esc(draft.proposed_back || '')}</textarea>
      <label>${t('flashcards.deck')}</label>
      <select id="editProposalDeck">${deckOptions}</select>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-edit-proposal">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-edited-proposal" data-id="${esc(draft.id)}">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditProposalModal = function() {
  document.getElementById('editProposalModal')?.remove();
};

window.saveEditedProposal = async function(id) {
  const front = document.getElementById('editProposalFront').value.trim();
  const back = document.getElementById('editProposalBack').value.trim();
  const deck = document.getElementById('editProposalDeck').value;
  if (!front || !back) { showToast(t('toast.both_fields_required')); return; }
  if (state.db.connected) {
    await state.db.from('flashcard_notes').update({ proposed_front: front, proposed_back: back, proposed_deck: deck }).eq('id', id);
  }
  const draft = allDrafts.find(d => d.id === id);
  if (draft) { draft.proposed_front = front; draft.proposed_back = back; draft.proposed_deck = deck; }
  closeEditProposalModal();
  renderAllBuckets();
  showToast(t('flashcards.proposal_updated'));
};

window.updateProposedDeck = async function(id, deck) {
  if (state.db.connected) {
    await state.db.from('flashcard_notes').update({ proposed_deck: deck }).eq('id', id);
  }
  const draft = allDrafts.find(d => d.id === id);
  if (draft) draft.proposed_deck = deck;
};

// ── Flashcard CRUD ──
window.openAddFlashcardModal = function(deck) {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashcardModal" style="display:flex;" data-action="close-add-flashcard" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('plus', 18, '#8b5cf6')} ${t('flashcards.add_card')}</h2>
      <input type="hidden" id="newFlashDeck" value="${esc(deck ?? '')}">
      <label>${t('flashcards.question')}</label>
      <textarea id="newFlashFront" rows="3" placeholder="${t('flashcards.question_placeholder')}"></textarea>
      <label>${t('flashcards.answer')}</label>
      <textarea id="newFlashBack" rows="3" placeholder="${t('flashcards.answer_placeholder')}"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-add-flashcard">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-new-flashcard">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newFlashFront').focus();
};

window.closeAddFlashcardModal = function() {
  const m = document.getElementById('addFlashcardModal'); if (m) m.remove();
};

window.saveNewFlashcard = async function() {
  const deckId = document.getElementById('newFlashDeck').value.trim();
  const front = document.getElementById('newFlashFront').value.trim();
  const back = document.getElementById('newFlashBack').value.trim();
  if (!front || !back) { showToast(t('toast.both_fields_required')); return; }
  const deckRow = _deckMap.get(deckId);
  const deck = deckRow?.name ?? '';
  if (state.db.connected) await state.db.from('flashcards').insert({ deck, front, back, deck_id: deckId || null });
  closeAddFlashcardModal();
  await refreshFlashcards();
  showToast(t('flashcards.card_added'));
};

window.openEditFlashcardModal = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  closeAllFlashModals();
  const currentDeckId = deckIdForCard(card);
  const deckOptions = deckOptionsForEdit('flashcard', currentDeckId);
  const html = `<div class="modal-overlay" id="editFlashcardModal" style="display:flex;" data-action="close-edit-flashcard" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#f59e0b')} ${t('flashcards.edit_card')}</h2>
      <input type="hidden" id="editFlashId" value="${id}">
      <label>${t('flashcards.deck')}</label>
      <select id="editFlashDeck">${deckOptions}</select>
      <label>${t('flashcards.question')}</label>
      <textarea id="editFlashFront" rows="3">${esc(card.front)}</textarea>
      <label>${t('flashcards.answer')}</label>
      <textarea id="editFlashBack" rows="3">${esc(card.back)}</textarea>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-edit-flashcard">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-edit-flashcard">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditFlashcardModal = function() {
  const m = document.getElementById('editFlashcardModal'); if (m) m.remove();
};

window.saveEditFlashcard = async function() {
  const id = document.getElementById('editFlashId').value;
  const deckId = document.getElementById('editFlashDeck').value.trim();
  const deckRow = _deckMap.get(deckId);
  const deck = deckRow?.name ?? deckId;
  const front = document.getElementById('editFlashFront').value.trim();
  const back = document.getElementById('editFlashBack').value.trim();
  if (!front || !back) { showToast(t('toast.both_fields_required')); return; }
  if (state.db.connected) await state.db.from('flashcards').update({ deck, front, back, deck_id: deckId }).eq('id', id);
  closeEditFlashcardModal();
  await refreshFlashcards();
  showToast(t('flashcards.card_updated'));
};

window.deleteFlashcard = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  showConfirmAction('Delete Flashcard', 'Are you sure?', async () => {
    if (state.db.connected) await state.db.from('flashcards').delete().eq('id', id);

    const el = document.querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    await animateItemRemoval(el);

    await refreshFlashcards();
    showToast(t('flashcards.card_deleted'));
  });
};

// ── New Deck ──
// Section helpers — mirrors the Lists page's chain/convert logic.
// nextFlashSortOrder: next sort_order within one parent (0 when empty).
function nextFlashSortOrder(parentId) {
  // Rows are normalized at load (kind/parent_id defaults), so parent_id
  // is either a section id or null here.
  const siblings = [..._deckMap.values()].filter(d => (d.parent_id ?? null) === (parentId ?? null));
  return siblings.reduce((m, d) => Math.max(m, Number(d.sort_order) || 0), -1) + 1;
}

function flashChildRow(parentId, name) {
  return [..._deckMap.values()].find(d => (d.parent_id ?? null) === (parentId ?? null) && (d.name || '').toLowerCase() === name.toLowerCase()) || null;
}

// Convert a bucket deck into a section: its cards and texts move to the
// default deck first, then the row flips to kind='section'. The sequence
// runs through runDeckToSectionMigration (checked writes, flip last,
// id-precise rollback), so a failed move can never strand items inside
// a section row, where deck buckets never render them.
async function convertDeckToSection(row) {
  const targetId = _defaultDeckId;
  const targetName = _deckMap.get(targetId)?.name ?? '';
  await runDeckToSectionMigration(state.db, {
    deckId: row.id, deckName: row.name ?? '', targetId, targetName,
  });
  row.kind = 'section';
  await loadFlashcardDecks();
}

// Create the section chain for path segments (like ensureListSectionChain).
// A segment colliding with an existing bucket converts that bucket.
// guardId (the row being renamed) must never land inside itself or one
// of its own descendants — a typed path resolving there throws.
async function ensureFlashSectionChain(segments, startParentId = null, guardId = null) {
  let parentId = startParentId || null;
  for (const seg of (segments || [])) {
    let row = flashChildRow(parentId, seg);
    if (row && guardId && (row.id === guardId || descendantsOf(getDeckTree().byId.get(guardId) || { children: [] }).some(n => n.id === row.id))) {
      throw new Error('section-cycle');
    }
    if (!row) {
      const { data, error } = await state.db.from('flashcard_decks').insert({
        name: seg, shortname: null, color: FLASH_SECTION_DEFAULT_COLOR,
        sort_order: nextFlashSortOrder(parentId), kind: 'section', parent_id: parentId,
      }).select();
      if (error) throw error;
      row = data?.[0] || null;
      if (!row) throw new Error('section-create-failed');
      await loadFlashcardDecks();
    } else if (!isSectionRow(row)) {
      await convertDeckToSection(row);
      row = _deckMap.get(row.id);
    }
    parentId = row.id;
  }
  return parentId;
}

window.openAddFlashDeckModal = function(sectionId) {
  closeAllFlashModals();
  const defaultColor = nextPaletteColor(_deckMap);
  const html = `<div class="modal-overlay" id="addFlashDeckModal" style="display:flex;" data-action="close-add-flash-deck" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('brain', 18, '#06b6d4')} ${t('flashcards.new_deck')}</h2>
      <label>${t('flashcards.deck_name')}</label>
      <input type="text" id="newDeckName" placeholder="${t('flashcards.deck_placeholder')}">
      <div class="modal-row">
        <div class="modal-field">
          <label>${t('common.shortname')}</label>
          <input type="text" id="newDeckShortname" placeholder="${t('flashcards.shortname_placeholder')}" maxlength="20">
        </div>
        <div class="modal-field">
          <label>${t('common.color')}</label>
          <input type="color" id="newDeckColor" value="${defaultColor}">
        </div>
      </div>
      <label>${t('flashcards.deck_type')}</label>
      <div class="deck-type-selector">
        <button class="deck-type-btn active" id="deckTypeFlashcard" data-action="select-deck-type" data-type="flashcard">${lucideIcon('layers', 14)} ${t('flashcards.type_flashcard')}</button>
        <button class="deck-type-btn" id="deckTypeText" data-action="select-deck-type" data-type="text">${lucideIcon('book-open', 14)} ${t('flashcards.type_text')}</button>
      </div>
      <input type="hidden" id="newDeckType" value="flashcard">
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-add-flash-deck">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-new-flash-deck">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  // Parent section when opened from a section header's add button
  // (open-add-flash-deck-in-section); empty for a top-level deck.
  document.getElementById('addFlashDeckModal').dataset.parentId = sectionId || '';
  document.getElementById('newDeckName').focus();
};

window.selectDeckType = function(type) {
  document.getElementById('newDeckType').value = type;
  document.getElementById('deckTypeFlashcard').classList.toggle('active', type === 'flashcard');
  document.getElementById('deckTypeText').classList.toggle('active', type === 'text');
};

window.closeAddFlashDeckModal = function() {
  const m = document.getElementById('addFlashDeckModal'); if (m) m.remove();
};

window.saveNewFlashDeck = async function() {
  const rawName = document.getElementById('newDeckName').value.trim();
  const segments = parseSectionPath(rawName);
  if (!segments.length) { showToast(t('toast.name_required')); return; }
  // Path syntax ('Geography > World Capitals') creates the section
  // chain, like Lists; a section header's add button fixes the parent.
  const modal = document.getElementById('addFlashDeckModal');
  const startParentId = modal?.dataset.parentId || null;
  const name = segments[segments.length - 1];

  const type = document.getElementById('newDeckType').value === 'text' ? 'text' : 'flashcard';
  if (state.db.connected) {
    const shortname = document.getElementById('newDeckShortname').value.trim() || null;
    const color = document.getElementById('newDeckColor').value;
    let parentId;
    try {
      parentId = await ensureFlashSectionChain(segments.slice(0, -1), startParentId);
    } catch (e) {
      // A cycle is a validation error (same toast as before); anything
      // else is a failed conversion write and must say so.
      if (e?.message === 'section-cycle') showToast(t('toast.name_required'), 'error');
      else showToast(t('toast.update_failed') + ': ' + (e?.message || e), 'error');
      return;
    }
    // Names are unique among siblings only, like the other pages —
    // the same name may exist in another section.
    if (siblingNameTaken([..._deckMap.values()], parentId, name, null)) {
      showToast(t('flashcards.deck_exists_at_level', name), 'error');
      return;
    }
    const sortOrder = nextFlashSortOrder(parentId);
    await state.db.from('flashcard_decks').insert({ name, shortname, color, sort_order: sortOrder, deck_type: type, kind: 'bucket', parent_id: parentId });
    await loadFlashcardDecks();
  }

  closeAddFlashDeckModal();
  showToast(t('toast.added'), 'success');
  await refreshFlashcards();
};

function closeAllFlashModals() {
  ['addFlashcardModal', 'editFlashcardModal', 'addDraftModal', 'addFlashDeckModal', 'addTextModal', 'editTextModal', 'editDeckModal', 'importFlashModal', 'editChunkModal'].forEach(id => {
    const m = document.getElementById(id); if (m) m.remove();
  });
  if (window.closeChunkPanel) window.closeChunkPanel();
}

// ── Pure session helpers ──
// Extracted from startPractice/showNextCard so the session mechanics can
// be tested as state transitions (see tests/tests.js 'relearning: ...').
// They take plain data and return new state; they never touch the DOM,
// the session globals, or the DB.

// Pick the next card to present, honouring relearning steps:
// - a relearning card whose step is due jumps ahead of the queue;
// - a card whose step has not elapsed never comes back early: when
//   the queue empties, the session ends and the card waits for the
//   next session (it stays in `relearning`, due after its step);
// - a card is never queued twice for one scheduled step.
// Returns { next, queue, relearning } with fresh arrays; inputs untouched.
function pickNextCard(queue, relearning, now) {
  const q = [...queue];
  const rl = [...relearning].sort((a, b) => a.dueAt - b.dueAt);
  const due = [];
  while (rl.length > 0 && rl[0].dueAt <= now) due.push(rl.shift().card);
  const fresh = due.filter(c => !q.find(s => s.id === c.id));
  if (fresh.length > 0) q.unshift(...fresh);
  return { next: q[0] || null, queue: q, relearning: rl };
}

// Choose the session's cards from the due pool, grouped by priority:
// relearning/short-interval first (stability ≤ 2 — including a
// card whose 10-minute step elapsed after a session restart), then
// overdue (stalest first), then new cards. New cards wait while
// anything reviewed is due. The cap is applied in priority order.
// Returns { failed, overdue, fresh }; see orderSessionQueue for how
// the groups are presented.
function selectSessionCards(pool, sessionSize) {
  const failed = pool.filter(c => c.last_review && c.stability > 0 && c.stability <= 2);
  const overdue = pool.filter(c => c.last_review && c.stability > 2)
    .sort((a, b) => new Date(a.next_review || 0) - new Date(b.next_review || 0));
  // New cards wait until nothing is due: no new material while
  // unmastered cards are pending.
  const dueCount = pool.filter(c => c.last_review).length;
  const fresh = dueCount > 0 ? [] : pool.filter(c => !c.last_review).sort(() => Math.random() - 0.5);
  const groups = { failed: [], overdue: [], fresh: [] };
  let total = 0;
  for (const [key, group] of [['failed', failed], ['overdue', overdue], ['fresh', fresh]]) {
    for (const card of group) {
      if (total >= sessionSize) break;
      groups[key].push(card);
      total++;
    }
    if (total >= sessionSize) break;
  }
  return groups;
}

// Present the selected groups in priority order, shuffled within each
// group: a lapsed card is always presented before any overdue card,
// and overdue cards before any new card — the order inside a group
// stays random.
function orderSessionQueue(groups) {
  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  return [...shuffle(groups.failed), ...shuffle(groups.overdue), ...shuffle(groups.fresh)];
}

// ── Practice Session ──
function startPractice(deckFilter, anchorEl) {
  const now = new Date();
  let pool = allCards.filter(c => !c.last_review || !c.next_review || new Date(c.next_review) <= now);
  if (deckFilter && deckFilter !== '__all') pool = pool.filter(c => deckIdForCard(c) === deckFilter);
  if (pool.length === 0) { showAllCaughtUp('cards', anchorEl); return; }

  sessionDeck = deckFilter || null;

  const SESSION_SIZE = 10;
  sessionQueue = orderSessionQueue(selectSessionCards(pool, SESSION_SIZE));
  sessionRelearning = [];
  sessionRatedIds = new Set();
  sessionDone = 0;
  sessionCorrect = 0;
  sessionActive = true;
  sessionTotal = sessionQueue.length;
  showPracticeOverlay();
  showNextCard();
}
window.startPractice = startPractice;


// Generate storm logo watermark SVG for practice overlays
function practiceHeaderLogo() {
  return `<svg class="practice-header-logo" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">${generateStorm(LOGO_DEFAULTS, 400)}</svg>`;
}
function practiceSummaryLogo() {
  return `<svg class="practice-summary-logo" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">${generateStorm(LOGO_DEFAULTS, 400)}</svg>`;
}

function initMarquee() {
  document.querySelectorAll('.practice-meta').forEach(el => {
    const txt = el.querySelector('.practice-meta-text');
    if (!txt) return;
    el.classList.remove('marquee');
    if (txt.scrollWidth > el.clientWidth + 1) {
      const offset = -(txt.scrollWidth - el.clientWidth);
      el.style.setProperty('--marquee-offset', offset + 'px');
      const dur = Math.max(4, Math.abs(offset) / 20);
      el.style.setProperty('--marquee-duration', dur + 's');
      el.classList.add('marquee');
    }
  });
}

function showPracticeOverlay() {
  let overlay = document.getElementById('practiceOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'practiceOverlay';
    overlay.className = 'practice-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function hidePracticeOverlay() {
  const overlay = document.getElementById('practiceOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  sessionActive = false;
}

function showNextCard() {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  // Relearning cards whose step is due jump the queue; a card whose
  // step has not elapsed never comes back early — when the queue
  // empties, the session ends and the card waits for the next session.
  const picked = pickNextCard(sessionQueue, sessionRelearning, new Date());
  sessionQueue = picked.queue;
  sessionRelearning = picked.relearning;
  if (!picked.next) { showSessionSummary(); return; }

  const card = picked.next;
  const pct = sessionTotal > 0 ? Math.min(100, Math.round((sessionDone / sessionTotal) * 100)) : 0;

  overlay.innerHTML = `
    <div class="practice-header">
      ${practiceHeaderLogo()}
      <div class="practice-progress-bar"><div class="practice-progress-fill" style="width:${pct}%;"></div></div>
      <div class="practice-meta"><span class="practice-meta-text">${sessionDone} / ${sessionTotal} · ${esc(getDeckDisplayName(deckIdForCard(card)))}${card.relearning ? ` · ${t('flashcards.relearning')}` : ''}</span></div>
      <button class="practice-close" data-action="end-practice">✕</button>
    </div>
    <div class="practice-card-area" data-action="reveal-card">
      <div class="practice-card" id="practiceCard">
        <div class="practice-card-front">
          <div class="practice-card-label">${t('flashcards.question')}</div>
          <div class="practice-card-text">${esc(card.front)}</div>
        </div>
        <div class="practice-card-back">
          <div class="practice-card-label">${t('flashcards.answer')}</div>
          <div class="practice-card-text">${esc(card.back)}</div>
        </div>
      </div>
    </div>
    <div class="practice-hint" id="practiceHint">${t('flashcards.tap_to_reveal')}</div>
    <div class="practice-buttons" id="practiceButtons" style="display:none;">
      <button class="rating-btn rating-again" data-action="rate-card" data-rating="1"><span class="rating-num">1</span> ${t('flashcards.again')}</button>
      <button class="rating-btn rating-hard" data-action="rate-card" data-rating="2"><span class="rating-num">2</span> ${t('flashcards.hard')}</button>
      <button class="rating-btn rating-good" data-action="rate-card" data-rating="3"><span class="rating-num">3</span> ${t('flashcards.good')}</button>
      <button class="rating-btn rating-easy" data-action="rate-card" data-rating="4"><span class="rating-num">4</span> ${t('flashcards.easy')}</button>
    </div>`;
  initMarquee();
}

window.revealCard = function() {
  const card = document.getElementById('practiceCard');
  if (!card || card.classList.contains('flipped')) return;
  card.classList.add('flipped');
  document.getElementById('practiceHint').style.display = 'none';
  document.getElementById('practiceButtons').style.display = 'flex';
};

let _ratingInProgress = false;
window.rateCard = async function(rating) {
  // Delegation passes el.dataset.rating — a string. The FSRS core
  // compares ratings strictly (rating === 1), so coerce here: without
  // it, clicking Again was silently treated as a success.
  rating = Number(rating);
  if (_ratingInProgress) return;
  if (sessionQueue.length === 0) return;
  _ratingInProgress = true;
  // Disable buttons visually while processing
  document.querySelectorAll('#practiceButtons .rating-btn').forEach(b => b.disabled = true);
  const headerLogo = document.querySelector('.practice-header-logo');
  if (headerLogo) headerLogo.classList.add('spinning');
  try {
    const card = sessionQueue.shift();
    sessionDone++;
    sessionRatedIds.add(card.id);
    if (rating >= 3) sessionCorrect++;
    // Read-only mode: the session still advances, but the rating is not
    // recorded — no FSRS update in memory or in the DB, so the card
    // stays due exactly as the last online version left it.
    if (!state.readOnlyMode) {
      const now = new Date();
      const updates = fsrsUpdate(card, rating, now);
      Object.assign(card, updates);
      const idx = allCards.findIndex(c => c.id === card.id);
      if (idx >= 0) Object.assign(allCards[idx], updates);
      if (state.db.connected) await state.db.from('flashcards').update(updates).eq('id', card.id);
      // Lapsed (or still relearning) card: back in-session once its
      // 10-minute step is due. Read-only sessions never schedule.
      // The re-presentation is a scheduled rating of its own, so the
      // session total grows with it — otherwise the header reads 12/10.
      if (updates.relearning === 1) {
        sessionRelearning.push({ card, dueAt: new Date(updates.next_review) });
        sessionTotal++;
      }
    }
    showNextCard();
  } finally {
    _ratingInProgress = false;
  }
};

window.endPractice = function() {
  hidePracticeOverlay();
  renderFlashcards();
};

function showSessionSummary() {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  const accuracy = sessionDone > 0 ? Math.round((sessionCorrect / sessionDone) * 100) : 0;

  // Check if there are more cards due for continue option
  const now = new Date();
  let remainingPool = allCards.filter(c => !c.next_review || new Date(c.next_review) <= now);
  if (sessionDeck && sessionDeck !== '__all') remainingPool = remainingPool.filter(c => deckIdForCard(c) === sessionDeck);
  const hasMore = remainingPool.length > 0;

  const continueBtn = hasMore
    ? `<button class="btn practice-continue-btn" data-action="start-practice" data-deck="${esc(sessionDeck || '')}">${t('flashcards.continue_session')}</button>`
    : '';

  overlay.innerHTML = `
    <div class="practice-summary">
      ${practiceSummaryLogo()}
      <div class="practice-summary-emoji">${accuracy >= 80 ? lucideIcon('trophy', 32) : accuracy >= 50 ? lucideIcon('flame', 32) : lucideIcon('book-open', 32)}</div>
      <h2>${t('flashcards.session_complete')}</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionRatedIds.size}</span><span class="practice-stat-lbl">${t('flashcards.cards_reviewed')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionCorrect}</span><span class="practice-stat-lbl">${t('flashcards.good_plus')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${accuracy}%</span><span class="practice-stat-lbl">${t('flashcards.accuracy')}</span></div>
      </div>
      <div class="practice-summary-actions">
        ${continueBtn}
        <button class="btn practice-done-btn" data-action="end-practice">${t('common.close')}</button>
      </div>
    </div>`;
}

// Show "all caught up" overlay when no cards/texts are due
function showAllCaughtUp(kind, anchorEl) {
  const subtitle = kind === 'texts'
    ? t('text_revision.all_caught_up_texts')
    : t('flashcards.all_caught_up_cards');
  const msg = `${t('flashcards.all_caught_up')} ${subtitle}`;

  // Show as an anchored tooltip near the clicked button
  if (anchorEl) {
    // Remove any existing tooltip
    document.querySelectorAll('.caught-up-tooltip').forEach(el => el.remove());
    const tip = document.createElement('div');
    tip.className = 'caught-up-tooltip';
    tip.textContent = msg;
    document.body.appendChild(tip);
    const rect = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    tip.style.top = `${rect.bottom + 8}px`;
    // Position centered on button, then clamp to 12px from each edge
    requestAnimationFrame(() => {
      const tipW = tip.offsetWidth;
      const center = rect.left + rect.width / 2;
      let left = center - tipW / 2;
      left = Math.max(12, Math.min(left, vw - tipW - 12));
      tip.style.left = `${left}px`;
    });
    setTimeout(() => tip.classList.add('caught-up-tooltip-visible'), 10);
    setTimeout(() => {
      tip.classList.remove('caught-up-tooltip-visible');
      setTimeout(() => tip.remove(), 200);
    }, 2500);
  } else {
    showToast(msg, 'success');
  }
}

// ===================================================================
// TEXT REVISION — Spaced Repetition for Poems / Texts
// ===================================================================

// ── Text Item Rendering ──
// Segments shown on the chunk bar before Show more; the rest stay in the
// DOM (hidden by CSS) so expanding needs no re-render.
const TR_BAR_COLLAPSED_COUNT = 16;
function renderTextItem(tx, color) {
  const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id)
    .sort((a, b) => a.chunk_index - b.chunk_index);
  const now = new Date();
  const totalChunks = chunks.length;
  const masteredChunks = chunks.filter(ch => ch.last_review && ch.stability >= 21 && ch.next_review && new Date(ch.next_review) > now).length;
  const dueChunks = chunks.filter(ch => !ch.last_review || !ch.next_review || new Date(ch.next_review) <= now).length;
  const lines = tx.content.split('\n');
  const lineCount = lines.length;

  const titleTrunc = tx.title.length > 70 ? tx.title.slice(0, 70) + '...' : tx.title;
  const authorStr = tx.author ? ` — ${esc(tx.author)}` : '';

  // Chunk-level progress bar, full item width so segments keep a usable
  // size on phone. Each segment is a button: tap (or long hover, via its
  // title) opens that chunk's stats / revise / edit menu.
  let progressBar = '';
  let borderColor = color;
  if (totalChunks > 0) {
    let newCount = 0, dueCount = 0, okCount = 0, mastCount = 0;
    const segments = chunks.map(ch => {
      const isNew = !ch.last_review;
      const isDue = !isNew && (!ch.next_review || new Date(ch.next_review) <= now);
      let cls = 'tr-seg-ok';
      if (isNew) { cls = 'tr-seg-new'; newCount++; }
      else if (isDue) { cls = 'tr-seg-due'; dueCount++; }
      else if (ch.stability >= 21) { cls = 'tr-seg-mastered'; mastCount++; }
      else { okCount++; }
      const chunkLabel = t('text_revision.chunk_title', ch.chunk_index + 1, totalChunks);
      return `<button type="button" class="tr-seg ${cls}" data-action="open-chunk-panel" data-text-id="${esc(tx.id)}" data-chunk-index="${ch.chunk_index}" aria-label="${esc(chunkLabel)}"></button>`;
    }).join('');
    const hiddenCount = totalChunks - TR_BAR_COLLAPSED_COUNT;
    progressBar = `<div class="tr-progress-wrap"><div class="tr-progress-bar">${segments}</div>${hiddenCount > 0 ? `<button type="button" class="tr-bar-toggle" data-action="toggle-chunk-bar" data-text-id="${esc(tx.id)}" data-hidden="${hiddenCount}"><span class="tr-bar-toggle-label">${t('text_revision.chunk_show_more', hiddenCount)}</span> ${lucideIcon('chevron-down', 14)}</button>` : ''}</div>`;
    // Border = majority chunk status color
    const counts = [
      { n: mastCount, c: 'var(--fc-mastered)' },
      { n: okCount, c: 'var(--fc-ok)' },
      { n: dueCount, c: 'var(--fc-due)' },
      { n: newCount, c: 'var(--fc-new)' },
    ];
    borderColor = counts.reduce((a, b) => b.n > a.n ? b : a).c;
  }

  const previewLines = lines.slice(0, 3).map(l => esc(l || '\u00A0')).join('<br>');

  return `<div class="bucket-item todo-item tr-text-item" data-text-id="${tx.id}" style="border-left:3px solid ${borderColor};">
    <div class="todo-row">
      <div class="tr-text-info">
        <span class="todo-text"><strong>${esc(titleTrunc)}</strong><span class="tr-author">${authorStr}</span></span>
        <span class="tr-meta">${lineCount} lines ${lucideIcon('layers', 12)} ${masteredChunks}/${totalChunks} chunks${dueChunks > 0 ? ` <span class="tr-due-badge">${dueChunks} due</span>` : ''}${tx.focus_role ? ` <span class="tr-role-badge">${t('text_revision.role_badge_prefix')}${esc(tx.focus_role)}</span>` : ''}</span>
      </div>
      <div class="todo-actions">
        <button data-action="copy-item-link" data-link-type="flashtext" data-id="${esc(tx.id)}" title="${t('common.copy_link')}" aria-label="${t('common.copy_link')}">${lucideIcon('link', 16)}</button>
        <button data-action="start-text-practice-for-text" data-id="${esc(tx.id)}" title="${t('text_revision.revise_this')}">${lucideIcon('book-open', 16)}</button>
        <button class="tr-expand-toggle" data-text-id="${tx.id}" title="Expand">${lucideIcon('chevron-down', 16)}</button>
        <button data-action="open-edit-text" data-id="${esc(tx.id)}" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button data-action="delete-text" data-id="${esc(tx.id)}" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
    ${progressBar}
    <div class="tr-text-body" id="trBody-${tx.id}" style="display:none;">
      <div class="tr-text-preview">${previewLines}${lineCount > 3 ? '<br><span class="tr-more">...</span>' : ''}</div>
    </div>
  </div>`;
}

// ── Chunk Menu (stats / revise / edit for one chunk) ──
function findChunk(textId, chunkIndex) {
  const tx = allTexts.find(t => t.id === textId);
  if (!tx) return null;
  const chunk = allChunkProgress.find(ch => ch.text_id === textId && ch.chunk_index === chunkIndex);
  if (!chunk) return null;
  return { tx, chunk };
}

function chunkFmtDate(s) {
  try {
    return new Date(s).toLocaleDateString(getLang(), { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return s || ''; }
}

// ── Chunk panel: a small popover by the segment, not a modal ──
// Click opens it at once; desktop hover waits 2s (same delay as the
// item row actions). It offers three actions: Show stats renders the
// stats inside the same panel — stats only, no text, with a recall
// ring, a recall-decay curve and stability/difficulty bars — Revise
// starts the revision overlay directly, and only Edit opens a modal.
// Opening: panel follows the segment; closing: the close button,
// tapping/clicking elsewhere, Escape, or moving away from both segment
// and panel. Scrolling moves the panel with its segment (it only closes
// once the segment leaves the viewport). While open, the owning text item
// carries .chunk-panel-open, which freezes its row actions in whatever
// state they had (see item-utils: the hover timer skips panel-open
// items and mouseleave never hides them, and segment hover never shows
// them) so the bar never shifts under the panel. Moving to another
// segment while the pointer stays inside the bar opens that segment's
// panel at once; leaving the bar breaks that chain.
let _chunkPanelEl = null, _chunkPanelSeg = null, _chunkPanelItem = null;
let _chunkPanelTextId = null, _chunkPanelIndex = null, _chunkPanelView = 'options';
// Side the panel opened on ('above' | 'below'), frozen for its
// lifetime — see chunkPanelPosition.
let _chunkPanelSide = null;
let _chunkPanelHideTimer = null, _chunkPanelHoverBound = false;
let _chunkPanelHoverTimer = null, _chunkPanelHoverSeg = null;
// True while the pointer stays inside the segments area (the bar, gaps
// included) with a panel open: moving to another segment then opens its
// panel at once, without paying the 2s hover delay again. Leaving the
// bar resets it, so the next segment hover costs 2s again.
let _chunkPanelSegChain = false;
// Same 2s delay as the item row actions: hovering a segment must not
// pop the panel open on a mere pass-over; a click opens it at once.
const CHUNK_PANEL_HOVER_DELAY_MS = 2000;

function _chunkPanelCancelHoverTimer() {
  if (_chunkPanelHoverTimer) { clearTimeout(_chunkPanelHoverTimer); _chunkPanelHoverTimer = null; }
  _chunkPanelHoverSeg = null;
}

// Recall-decay curve for the stats view: the same FSRS curve the app
// schedules from, sampled from the last review to the next one (or past
// today when there is no next review), with today marked on it.
function chunkRecallCurveSvg(S, lastReview, horizon, now) {
  const W = 256, H = 84, padX = 4, padTop = 12, padBottom = 6;
  const start = new Date(lastReview).getTime(), end = horizon.getTime();
  const span = Math.max(1, end - start);
  const xFor = (ms) => padX + (W - 2 * padX) * clamp((ms - start) / span, 0, 1);
  const yFor = (r) => padTop + (H - padTop - padBottom) * (1 - clamp(r, 0, 1));
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const ms = start + span * i / 48;
    pts.push([xFor(ms), yFor(retrievability(S, lastReview, new Date(ms).toISOString()))]);
  }
  const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L ${line.split(' ').slice(1).join(' L ')} L ${pts[pts.length - 1][0].toFixed(1)},${(H - padBottom).toFixed(1)} L ${pts[0][0].toFixed(1)},${(H - padBottom).toFixed(1)} Z`;
  const nowMs = now.getTime();
  const nowX = xFor(nowMs), nowY = yFor(retrievability(S, lastReview, now.toISOString()));
  const todayX = Math.max(22, Math.min(W - 22, nowX));
  return `<svg class="tr-chunk-curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('text_revision.chunk_retrievability')}">
    <path d="${area}" fill="var(--accent-dim)" stroke="none"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="${nowX.toFixed(1)}" y1="${padTop}" x2="${nowX.toFixed(1)}" y2="${(H - padBottom).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
    <circle cx="${nowX.toFixed(1)}" cy="${nowY.toFixed(1)}" r="3.5" fill="var(--accent)"/>
    <text x="${todayX.toFixed(1)}" y="10" text-anchor="middle" class="tr-chunk-curve-label">${t('common.today')}</text>
  </svg>`;
}

function chunkPanelStatsHtml(tx, chunk, chunkIndex, chunks) {
  const now = new Date();
  const isNew = !chunk.last_review;
  const isDue = isChunkDue(chunk, now);
  const statusKey = isNew ? 'new' : isDue ? 'due' : (chunk.stability >= 21 ? 'mastered' : 'ok');
  const statusLabel = isNew ? t('flashcards.new_card')
    : isDue ? t('flashcards.due')
    : (chunk.stability >= 21 ? t('flashcards.filter_mastered') : t('text_revision.chunk_status_ok'));
  const statusColor = { new: 'var(--fc-new)', due: 'var(--fc-due)', ok: 'var(--fc-mastered)', mastered: 'var(--fc-mastered)' }[statusKey];
  const r = (!isNew && chunk.stability)
    ? retrievability(chunk.stability, chunk.last_review, now.toISOString()) : null;
  const mode = chunkReviseMode(chunk, now);
  // Recall ring: circumference for r=30 is 188.5.
  const ring = r === null
    ? `<div class="tr-chunk-ring"><svg viewBox="0 0 76 76" class="tr-chunk-ring-svg"><circle cx="38" cy="38" r="30" fill="none" stroke="var(--border)" stroke-width="7" stroke-dasharray="3 5"/></svg><span class="tr-chunk-ring-center">—</span></div>`
    : `<div class="tr-chunk-ring"><svg viewBox="0 0 76 76" class="tr-chunk-ring-svg"><circle cx="38" cy="38" r="30" fill="none" stroke="var(--border)" stroke-width="7"/><circle cx="38" cy="38" r="30" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(188.5 * r).toFixed(1)} 188.5" transform="rotate(-90 38 38)"/></svg><span class="tr-chunk-ring-center">${Math.round(r * 100)}%</span></div>`;
  // Decay curve horizon: the next review when there is one (never
  // before today, so today stays on the chart), otherwise far enough
  // past the last review to show the decay, and never before today.
  let curve = '';
  if (!isNew) {
    const lastMs = new Date(chunk.last_review).getTime();
    const nextMs = chunk.next_review ? new Date(chunk.next_review).getTime() : null;
    const horizonMs = nextMs ? Math.max(nextMs, now.getTime())
      : Math.max(lastMs + Math.max(2 * (chunk.stability || 1), 7) * 86400000, now.getTime());
    const horizon = new Date(horizonMs);
    curve = `<div class="tr-chunk-curve-wrap">${chunkRecallCurveSvg(chunk.stability, chunk.last_review, horizon, now)}
      <div class="tr-chunk-curve-axis"><span>${chunkFmtDate(chunk.last_review)}</span><span>${chunkFmtDate(horizon.toISOString())}</span></div></div>`;
  } else {
    curve = `<p class="tr-chunk-panel-note">${t('text_revision.chunk_no_reviews')}</p>`;
  }
  const stabilityBar = isNew ? '' : `<div class="tr-chunk-bar"><span style="width:${Math.min(100, Math.round(chunk.stability / 21 * 100))}%"></span></div>`;
  const difficultyDots = isNew ? '' : `<div class="tr-chunk-dots">${Array.from({ length: 10 }, (_, i) =>
    `<span class="${i < Math.round(Number(chunk.difficulty) || 0) ? 'filled' : ''}"></span>`).join('')}</div>`;
  return `<div class="tr-chunk-viz">
      <div class="tr-chunk-viz-recall">${ring}<span class="tr-chunk-viz-label">${t('text_revision.chunk_retrievability')}</span></div>
      <div class="tr-chunk-viz-status"><span class="tr-chunk-status-badge" style="--status-color:${statusColor}">${esc(statusLabel)}</span></div>
    </div>
    ${curve}
    <div class="tr-chunk-panel-stats">
      <div class="tr-chunk-stat-row"><span class="tr-chunk-stat-label">${t('text_revision.chunk_stability')}</span><strong>${isNew ? '—' : String(chunk.stability)}</strong></div>
      ${stabilityBar}
      <div class="tr-chunk-stat-row"><span class="tr-chunk-stat-label">${t('text_revision.chunk_difficulty')}</span><strong>${isNew ? '—' : (Number(chunk.difficulty) || 0).toFixed(1)}</strong></div>
      ${difficultyDots}
      <div class="tr-chunk-stat-row"><span class="tr-chunk-stat-label">${t('text_revision.chunk_reviews')}</span><strong>${String(chunk.review_count || 0)}</strong></div>
      <div class="tr-chunk-stat-row"><span class="tr-chunk-stat-label">${t('text_revision.chunk_last_review')}</span><strong>${isNew ? t('text_revision.chunk_never') : chunkFmtDate(chunk.last_review)}</strong></div>
      <div class="tr-chunk-stat-row"><span class="tr-chunk-stat-label">${t('text_revision.chunk_next_review')}</span><strong>${(isNew || !chunk.next_review) ? t('text_revision.chunk_never') : chunkFmtDate(chunk.next_review)}</strong></div>
    </div>
    ${mode === 'practice' ? `<p class="tr-chunk-note">${t('text_revision.chunk_practice_note')}</p>` : ''}
    ${!chunkHasRoleLines(tx, chunkIndex) ? `<p class="tr-chunk-note">${t('text_revision.chunk_no_role_lines')}</p>` : ''}`;
}

function chunkPanelOptionsHtml(tx, chunkIndex, chunks) {
  const canRevise = chunkHasRoleLines(tx, chunkIndex);
  return `<div class="tr-chunk-panel-actions">
      <button type="button" class="tr-chunk-panel-btn" data-action="show-chunk-stats" data-text-id="${esc(tx.id)}" data-chunk-index="${chunkIndex}">${lucideIcon('bar-chart-3', 16)} ${t('text_revision.chunk_show_stats')}</button>
      <button type="button" class="tr-chunk-panel-btn" data-action="open-edit-chunk" data-text-id="${esc(tx.id)}" data-chunk-index="${chunkIndex}">${lucideIcon('pencil', 16)} ${t('text_revision.chunk_edit')}</button>
      <button type="button" class="tr-chunk-panel-btn" data-action="revise-chunk" data-text-id="${esc(tx.id)}" data-chunk-index="${chunkIndex}" ${canRevise ? '' : 'disabled'}>${lucideIcon('book-open', 16)} ${t('text_revision.chunk_revise')}</button>
    </div>
    ${canRevise ? '' : `<p class="tr-chunk-panel-note">${t('text_revision.chunk_no_role_lines')}</p>`}`;
}

function chunkPanelHeaderHtml(title, withBack) {
  return `<div class="tr-chunk-panel-header">
    ${withBack ? `<button type="button" class="tr-chunk-panel-nav" data-action="back-to-chunk-panel" data-text-id="${esc(_chunkPanelTextId)}" data-chunk-index="${_chunkPanelIndex}">${lucideIcon('chevron-left', 14)} ${t('text_revision.chunk_back')}</button>` : ''}
    <span class="tr-chunk-panel-title">${esc(title)}</span>
    <button type="button" class="tr-chunk-panel-close" data-action="close-chunk-panel" aria-label="${t('common.close')}">${lucideIcon('x', 14)}</button>
  </div>`;
}

function chunkPanelRender() {
  if (!_chunkPanelEl) return;
  const found = findChunk(_chunkPanelTextId, _chunkPanelIndex);
  if (!found) { window.closeChunkPanel(); return; }
  const { tx, chunk } = found;
  const chunks = getTextChunks(tx);
  const title = `${tx.title} — ${t('text_revision.chunk_title', _chunkPanelIndex + 1, chunks.length)}`;
  _chunkPanelEl.innerHTML = _chunkPanelView === 'stats'
    ? chunkPanelHeaderHtml(title, true) + chunkPanelStatsHtml(tx, chunk, _chunkPanelIndex, chunks)
    : chunkPanelHeaderHtml(title, false) + chunkPanelOptionsHtml(tx, _chunkPanelIndex, chunks);
  chunkPanelPosition();
}

function chunkPanelPosition() {
  if (!_chunkPanelEl || !_chunkPanelSeg) return;
  const rect = _chunkPanelSeg.getBoundingClientRect();
  const panel = _chunkPanelEl;
  panel.style.visibility = 'hidden';
  panel.style.display = 'block';
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 6;
  const below = vh - rect.bottom - gap;
  // The side is decided once, from the opening (options) view, and
  // frozen for the panel's lifetime. The stats view is much taller
  // than the options view, so re-deciding the flip on every render
  // would jump the panel to the other side of the segment when the
  // user clicks Show stats near the bottom of the page — leaving the
  // cursor hovering neither panel nor segment, and the mouseout timer
  // then closes the stats panel before it can be read. With the side
  // frozen, the taller view only grows within its side (clamped to
  // the viewport, scrollable via CSS max-height), so it always still
  // covers the spot the cursor is on.
  if (!_chunkPanelSide) {
    _chunkPanelSide = (below < h && rect.top - gap > below) ? 'above' : 'below';
  }
  const top = _chunkPanelSide === 'above'
    ? Math.max(8, rect.top - h - gap)
    : Math.min(rect.bottom + gap, Math.max(8, vh - h - 8));
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, vw - w - 8));
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.visibility = 'visible';
}

function _chunkPanelDetachListeners() {
  if (_chunkPanelEl?._outsideClick) document.removeEventListener('click', _chunkPanelEl._outsideClick, true);
  if (_chunkPanelEl?._keyDown) document.removeEventListener('keydown', _chunkPanelEl._keyDown);
  if (_chunkPanelEl?._scrollReposition) { window.removeEventListener('scroll', _chunkPanelEl._scrollReposition, true); window.removeEventListener('resize', _chunkPanelEl._scrollReposition); }
}

// Scrolling must not close the panel: the scroll that brings a segment
// into view fires asynchronously, after the panel already opened, so a
// scroll-to-close would dismiss the panel on the very tap that opened
// it. Instead the panel follows its segment while scrolling, and only
// closes once the segment itself leaves the viewport.
function _chunkPanelOnScroll() {
  if (!_chunkPanelEl || !_chunkPanelSeg) return;
  const rect = _chunkPanelSeg.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) { window.closeChunkPanel(); return; }
  chunkPanelPosition();
}

window.closeChunkPanel = function() {
  _chunkPanelCancelHoverTimer();
  if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
  if (_chunkPanelEl) _chunkPanelDetachListeners();
  if (_chunkPanelEl) _chunkPanelEl.remove();
  if (_chunkPanelItem) {
    _chunkPanelItem.classList.remove('chunk-panel-open');
    // While the panel was open the row actions were frozen (neither
    // shown nor hidden, so the bar could not shift under the panel).
    // Only unfreeze them if the pointer has really left the item;
    // otherwise they keep whatever state they had.
    if (!_chunkPanelItem.matches(':hover')) {
      const actions = _chunkPanelItem.querySelector('.todo-actions');
      if (actions) actions.classList.remove('visible');
    }
  }
  _chunkPanelEl = null; _chunkPanelSeg = null; _chunkPanelItem = null;
  _chunkPanelTextId = null; _chunkPanelIndex = null; _chunkPanelView = 'options';
  _chunkPanelSide = null;
};

window.openChunkPanel = function(textId, chunkIndex, segEl) {
  _chunkPanelCancelHoverTimer();
  const found = findChunk(textId, chunkIndex);
  if (!found) { showToast(t('common.item_not_found'), 'error'); return; }
  const seg = segEl && segEl.classList && segEl.classList.contains('tr-seg') && segEl.isConnected ? segEl
    : Array.from(document.querySelectorAll('.tr-seg')).find(s => s.dataset.textId === textId && parseInt(s.dataset.chunkIndex || '0', 10) === chunkIndex);
  if (!seg) return;
  // Re-opening the same segment keeps the current view (options or stats);
  // it must not reset stats back to options or close the panel, or a
  // hover-then-click would dismiss what the user just opened.
  if (_chunkPanelEl && _chunkPanelTextId === textId && _chunkPanelIndex === chunkIndex) {
    _chunkPanelSeg = seg;
    if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
    chunkPanelPosition();
    return;
  }
  window.closeChunkPanel();
  const panel = document.createElement('div');
  panel.id = 'chunkPanel';
  panel.className = 'tr-chunk-panel';
  panel.setAttribute('role', 'dialog');
  document.body.appendChild(panel);
  _chunkPanelEl = panel; _chunkPanelSeg = seg;
  _chunkPanelItem = seg.closest('.tr-text-item');
  _chunkPanelTextId = textId; _chunkPanelIndex = chunkIndex; _chunkPanelView = 'options';
  _chunkPanelSegChain = true;
  if (_chunkPanelItem) {
    // Marker only: it tells the row-action hover timer to stay out
    // (see item-utils.js). It must NOT hide already-visible actions —
    // while the panel is open the actions are frozen in whatever state
    // they had, so the bar cannot shift under the panel.
    _chunkPanelItem.classList.add('chunk-panel-open');
  }
  chunkPanelRender();
  panel._outsideClick = (e) => {
    if (!_chunkPanelEl) return;
    if (e.target.closest('#chunkPanel') || e.target.closest('.tr-seg')) return;
    window.closeChunkPanel();
  };
  panel._keyDown = (e) => { if (e.key === 'Escape') window.closeChunkPanel(); };
  panel._scrollReposition = _chunkPanelOnScroll;
  document.addEventListener('click', panel._outsideClick, true);
  document.addEventListener('keydown', panel._keyDown);
  window.addEventListener('scroll', panel._scrollReposition, true);
  window.addEventListener('resize', panel._scrollReposition);
};

window.showChunkStats = function(textId, chunkIndex) {
  if (!_chunkPanelEl || _chunkPanelTextId !== textId || _chunkPanelIndex !== chunkIndex) {
    window.openChunkPanel(textId, chunkIndex);
    if (!_chunkPanelEl) return;
  }
  _chunkPanelView = 'stats';
  chunkPanelRender();
  const back = _chunkPanelEl.querySelector('[data-action="back-to-chunk-panel"]');
  if (back) back.focus();
};

window.backToChunkPanel = function(textId, chunkIndex) {
  if (!_chunkPanelEl) return;
  _chunkPanelView = 'options';
  chunkPanelRender();
  const stats = _chunkPanelEl.querySelector('[data-action="show-chunk-stats"]');
  if (stats) stats.focus();
};

// Hover / focus handling for segments (delegation covers clicks only).
// Click opens the panel at once; mouse hover waits 2s (same delay as
// the item row actions) so passing over a segment does not pop it open.
// Moving to another segment restarts the timer for that segment, and
// leaving segment and panel cancels it. Focus opens at once for
// keyboard users (tabbing through segments must not wait 2s per stop).
// The 150ms grace lets the pointer travel from a segment to the panel
// without it flickering shut.
if (!_chunkPanelHoverBound) {
  _chunkPanelHoverBound = true;
  const _chunkPanelInPanelOrSeg = (el) => !!el && !!el.closest && !!(el.closest('#chunkPanel') || el.closest('.tr-seg'));
  // The segments area is the whole bar (segments plus the 2px gaps
  // between them), so sliding from one segment to the next never
  // counts as leaving it.
  const _chunkPanelInSegArea = (el) => !!el && !!el.closest && !!(el.closest('.tr-progress-bar') || el.closest('.tr-seg'));
  const _chunkPanelScheduleClose = () => {
    if (_chunkPanelHideTimer) clearTimeout(_chunkPanelHideTimer);
    _chunkPanelHideTimer = setTimeout(() => { if (_chunkPanelEl) window.closeChunkPanel(); }, 150);
  };
  document.addEventListener('mouseover', (e) => {
    const seg = e.target.closest ? e.target.closest('.tr-seg') : null;
    if (seg) {
      if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
      if (_chunkPanelEl && _chunkPanelTextId === seg.dataset.textId
        && _chunkPanelIndex === parseInt(seg.dataset.chunkIndex || '0', 10)) {
        _chunkPanelCancelHoverTimer();
        return;
      }
      // Chain: the panel is already open and the pointer never left
      // the bar since it opened, so the newly hovered segment's panel
      // opens at once instead of costing another 2s.
      if (_chunkPanelEl && _chunkPanelSegChain) {
        window.openChunkPanel(seg.dataset.textId, parseInt(seg.dataset.chunkIndex || '0', 10), seg);
        return;
      }
      if (_chunkPanelHoverSeg !== seg) {
        _chunkPanelCancelHoverTimer();
        _chunkPanelHoverSeg = seg;
        _chunkPanelHoverTimer = setTimeout(() => {
          _chunkPanelHoverTimer = null;
          if (!_chunkPanelHoverSeg || !_chunkPanelHoverSeg.isConnected) { _chunkPanelHoverSeg = null; return; }
          const s = _chunkPanelHoverSeg; _chunkPanelHoverSeg = null;
          window.openChunkPanel(s.dataset.textId, parseInt(s.dataset.chunkIndex || '0', 10), s);
        }, CHUNK_PANEL_HOVER_DELAY_MS);
      }
    } else if (e.target.closest && e.target.closest('#chunkPanel')) {
      if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
      _chunkPanelCancelHoverTimer();
    }
  });
  document.addEventListener('mouseout', (e) => {
    // Leaving the bar (to the item body, the panel, or elsewhere)
    // breaks the chain: the next segment hover costs 2s again.
    if (_chunkPanelInSegArea(e.target) && !_chunkPanelInSegArea(e.relatedTarget)) _chunkPanelSegChain = false;
    if (_chunkPanelInPanelOrSeg(e.target) && !_chunkPanelInPanelOrSeg(e.relatedTarget)) {
      _chunkPanelCancelHoverTimer();
      if (_chunkPanelEl) _chunkPanelScheduleClose();
    }
  });
  document.addEventListener('focusin', (e) => {
    const seg = e.target.closest ? e.target.closest('.tr-seg') : null;
    if (seg) {
      _chunkPanelCancelHoverTimer();
      if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
      window.openChunkPanel(seg.dataset.textId, parseInt(seg.dataset.chunkIndex || '0', 10), seg);
    } else if (e.target.closest && e.target.closest('#chunkPanel')) {
      if (_chunkPanelHideTimer) { clearTimeout(_chunkPanelHideTimer); _chunkPanelHideTimer = null; }
    }
  });
  document.addEventListener('focusout', (e) => {
    if (!_chunkPanelEl) return;
    // A null relatedTarget means focus went nowhere (e.g. the focused
    // panel button was replaced when switching views) — not a genuine
    // move out of the panel, and outside clicks close it separately.
    if (_chunkPanelInPanelOrSeg(e.target) && e.relatedTarget && !_chunkPanelInPanelOrSeg(e.relatedTarget)) _chunkPanelScheduleClose();
  });
}

window.toggleChunkBar = function(textId, el) {
  const item = el ? el.closest('.tr-text-item') : null;
  const bar = item ? item.querySelector('.tr-progress-bar') : null;
  if (!bar || !el) return;
  const expanded = bar.classList.toggle('tr-bar-expanded');
  const hidden = parseInt(el.dataset.hidden || '0', 10);
  el.innerHTML = `<span class="tr-bar-toggle-label">${expanded ? t('text_revision.chunk_show_less') : t('text_revision.chunk_show_more', hidden)}</span> ${lucideIcon(expanded ? 'chevron-up' : 'chevron-down', 14)}`;
  el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
};

window.reviseChunk = function(textId, chunkIndex) {
  const found = findChunk(textId, chunkIndex);
  if (!found) return;
  const { tx, chunk } = found;
  if (!chunkHasRoleLines(tx, chunkIndex)) return;
  window.closeChunkPanel();
  trSessionActive = true;
  trSessionDeck = deckIdForText(tx);
  trSessionTextId = tx.id;
  const mode = chunkReviseMode(chunk, new Date());
  if (mode === 'practice') trFreePracticeLastChunk = chunkIndex;
  showTextPracticeOverlay(tx, chunk, { freePractice: mode === 'practice' });
};

// Background scroll lock for the chunk edit modal, same pattern as the
// calendar day modal: the body is fixed at the current scroll offset, so
// the page behind the modal cannot scroll. Owned by a flag, so closing
// never steals another modal's lock (day modal, Settings).
function lockFlashModalScroll() {
  // Already locked by this modal, or by the day modal (which owns the
  // body position) — either way there is nothing more to lock.
  if (document.body.dataset.flashModalScroll || document.body.dataset.dayModalScroll) return;
  const scrollY = window.scrollY;
  document.body.classList.add('no-scroll');
  document.body.style.top = `-${scrollY}px`;
  document.body.dataset.flashModalScrollY = scrollY;
  document.body.dataset.flashModalScroll = '1';
}

function unlockFlashModalScroll() {
  if (!document.body.dataset.flashModalScroll) return;
  const scrollY = parseInt(document.body.dataset.flashModalScrollY || '0', 10);
  delete document.body.dataset.flashModalScroll;
  delete document.body.dataset.flashModalScrollY;
  if (document.body.dataset.dayModalScroll) return;
  document.body.classList.remove('no-scroll');
  document.body.style.top = '';
  window.scrollTo(0, scrollY);
}

window.closeEditChunkModal = function() {
  const m = document.getElementById('editChunkModal'); if (m) m.remove();
  unlockFlashModalScroll();
};

window.openEditChunkModal = function(textId, chunkIndex) {
  const found = findChunk(textId, chunkIndex);
  if (!found) return;
  const { tx } = found;
  const chunks = getTextChunks(tx);
  const content = chunks[chunkIndex];
  if (content === undefined) return;
  window.closeChunkPanel();
  closeAllFlashModals();
  closeEditChunkModal();
  let fields = '';
  if (!tx.focus_role) {
    const text = typeof content === 'string' ? content : String(content);
    const rows = Math.min(12, Math.max(4, text.split('\n').length + 1));
    fields = `<label>${t('text_revision.content_label')}</label>
      <textarea id="editChunkContent" rows="${rows}">${esc(text)}</textarea>`;
  } else {
    fields = content.map((ln, i) => {
      const label = ln.speaker || t('text_revision.stage_directions');
      const text = sceneBlockText(ln);
      const rows = Math.min(6, Math.max(2, text.split('\n').length + 1));
      return `<label>${esc(label)}</label>
      <textarea data-chunk-block="${i}" rows="${rows}">${esc(text)}</textarea>`;
    }).join('');
  }
  const html = `<div class="modal-overlay" id="editChunkModal" style="display:flex;" data-action="close-edit-chunk" data-overlay-close="true">
    <div class="modal">
      <h2>${t('text_revision.chunk_edit_title', chunkIndex + 1, chunks.length)}</h2>
      <p class="tr-chunk-note">${tx.focus_role ? t('text_revision.chunk_edit_hint_scene') : t('text_revision.chunk_edit_hint_plain')}</p>
      ${fields}
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-edit-chunk">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-edit-chunk" data-text-id="${esc(tx.id)}" data-chunk-index="${chunkIndex}">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  lockFlashModalScroll();
};

window.saveEditChunk = async function(textId, chunkIndex) {
  const found = findChunk(textId, chunkIndex);
  if (!found) return;
  const { tx, chunk } = found;
  let edited;
  if (!tx.focus_role) {
    const el = document.getElementById('editChunkContent');
    if (!el) return;
    edited = el.value;
  } else {
    edited = Array.from(document.querySelectorAll('#editChunkModal [data-chunk-block]'))
      .sort((a, b) => parseInt(a.dataset.chunkBlock, 10) - parseInt(b.dataset.chunkBlock, 10))
      .map(el => el.value);
  }
  const result = applyChunkEdit(tx, chunkIndex, edited);
  if (!result.ok) { showToast(t('text_revision.chunk_edit_boundary'), 'error'); return; }
  if (!result.changed) { closeEditChunkModal(); return; }
  const oldContent = tx.content;
  const reset = { stability: 0, difficulty: 5, last_review: null, next_review: null, review_count: 0 };
  if (state.db.connected) {
    const { error: updateError } = await state.db.from('texts').update({ content: result.content }).eq('id', textId);
    if (updateError) { showToast(t('toast.failed_to_save'), 'error'); return; }
    const { error: resetError } = await state.db.from('text_line_progress').update(reset).eq('id', chunk.id);
    if (resetError) {
      // Roll the text back so the old progress never attaches to new text.
      await state.db.from('texts').update({ content: oldContent }).eq('id', textId);
      showToast(t('toast.failed_to_save'), 'error');
      return;
    }
  }
  tx.content = result.content;
  Object.assign(chunk, reset);
  closeEditChunkModal();
  await refreshFlashcards();
  if (!state.db.connected && state.currentView === 'flashcards') renderFlashcards();
  showToast(t('text_revision.chunk_updated'));
};

// Chunking lives in scene-parse.js (single source of truth for both modes);
// getTextChunks is imported from there.
// In scene mode, chunks holding none of the role's lines carry nothing to
// learn and are skipped by the revision pickers.
function chunkHasRoleLines(tx, chunkIndex) {
  if (!tx.focus_role) return true;
  const chunks = getTextChunks(tx);
  const ch = chunks[chunkIndex];
  return !!ch && ch.some(ln => sceneSpeakersEqual(ln.speaker, tx.focus_role));
}

// Rendered HTML for a parsed scene line: direction spans dimmed italic.
// A block may span lines: inner newlines render as breaks inside the bubble.
function renderSceneLineHtml(line) {
  const br = t => esc(t).replace(/\n/g, '<br>');
  return line.segments.map(sg =>
    sg.kind === 'dir'
      ? `<span class='tr-inline-dir'>${br(sg.text)}</span>`
      : br(sg.text)
  ).join('');
}

// ── Add Text Modal ──
window.openAddTextModal = function(deck) {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addTextModal" style="display:flex;" data-action="close-add-text" data-overlay-close="true">
    <div class="modal modal-wide">
      <h2>${lucideIcon('file-text', 18, '#6366f1')} ${t('text_revision.add_text')}</h2>
      <input type="hidden" id="newTextDeck" value="${esc(deck ?? '')}">
      <label>${t('text_revision.title_label')}</label>
      <input type="text" id="newTextTitle" placeholder="${t('text_revision.title_placeholder')}">
      <label>${t('text_revision.author_label')}</label>
      <input type="text" id="newTextAuthor" placeholder="${t('text_revision.author_placeholder')}">
      <label>${t('text_revision.content_label')}</label>
      <textarea id="newTextContent" rows="10" placeholder="${t('text_revision.content_placeholder')}" data-action="update-scene-preview"></textarea>
      <div class="tr-modal-row">
        <div class="tr-modal-field">
          <label>${t('text_revision.my_role_label')}</label>
          <input type="text" id="newTextRole" list="newTextRoleList" placeholder="${t('text_revision.my_role_placeholder')}" data-action="update-scene-preview" autocomplete="off">
          <datalist id="newTextRoleList"></datalist>
        </div>
      </div>
      <div class="tr-format-hint">${t('text_revision.scene_format_hint')}</div>
      <div class="tr-scene-preview" id="newTextScenePreview"></div>
      <div class="tr-modal-row">
        <div class="tr-modal-field">
          <label>${t('text_revision.blocks_per_chunk')}</label>
          <input type="number" id="newTextBlocksPerChunk" value="4" min="1" max="20">
        </div>
        <div class="tr-modal-field">
          <label>${t('text_revision.context_blocks')}</label>
          <input type="number" id="newTextContextBlocks" value="3" min="0" max="10">
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-add-text">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-new-text">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('newTextTitle').focus();
};

window.closeAddTextModal = function() {
  const m = document.getElementById('addTextModal'); if (m) m.remove();
};

window.saveNewText = async function() {
  const deckId = document.getElementById('newTextDeck').value.trim();
  const title = document.getElementById('newTextTitle').value.trim();
  const author = document.getElementById('newTextAuthor').value.trim() || null;
  const content = document.getElementById('newTextContent').value;
  const blocksPerChunk = parseInt(document.getElementById('newTextBlocksPerChunk').value) || 4;
  const contextBlocks = parseInt(document.getElementById('newTextContextBlocks').value) || 3;
  const role = document.getElementById('newTextRole').value.trim() || null;

  if (!title) { showToast(t('toast.name_required')); return; }
  if (!content.trim()) { showToast(t('toast.content_required')); return; }

  if (!state.db.connected) return;

  const deckRow = _deckMap.get(deckId);
  const deck = deckRow?.name ?? '';

  // Insert text
  const { data: inserted } = await state.db.from('texts').insert({
    deck, title, author, content, blocks_per_chunk: blocksPerChunk, context_blocks: contextBlocks, deck_id: deckId || null,
    focus_role: role
  }).select('*');

  if (!inserted || inserted.length === 0) { showToast(t('toast.failed_to_add')); return; }
  const textRow = inserted[0];

  // Generate chunk progress rows
  const chunks = getTextChunks({ content, blocks_per_chunk: blocksPerChunk, focus_role: role });
  const chunkRows = chunks.map((_, idx) => ({ text_id: textRow.id, chunk_index: idx }));
  if (chunkRows.length > 0) {
    await state.db.from('text_line_progress').insert(chunkRows);
  }

  closeAddTextModal();
  await refreshFlashcards();
  showToast(t('text_revision.text_added'));
};

// ── Delete Text ──
window.deleteText = function(id) {
  const tx = allTexts.find(t => t.id === id);
  if (!tx) return;
  showConfirmAction(t('text_revision.delete_text'), t('text_revision.delete_confirm'), async () => {
    if (state.db.connected) await state.db.from('texts').delete().eq('id', id);

    const el = document.querySelector(`[data-text-id="${CSS.escape(id)}"]`);
    await animateItemRemoval(el);

    await refreshFlashcards();
    showToast(t('text_revision.text_deleted'));
  });
};

// Live parse preview for the scene role field (add/edit text modals).
window.updateScenePreview = function(el) {
  if (!el) return;
  const overlay = el.closest('.modal-overlay');
  const isAdd = overlay && overlay.id === 'addTextModal';
  const pfx = isAdd ? 'newText' : 'editText';
  const contentEl = document.getElementById(pfx + 'Content');
  const roleEl = document.getElementById(pfx + 'Role');
  const listEl = document.getElementById(pfx + 'RoleList');
  const prevEl = document.getElementById(pfx + 'ScenePreview');
  if (!contentEl || !prevEl) return;
  const content = contentEl.value;
  const role = (roleEl ? roleEl.value : '').trim();
  const hasBlocks = content.includes('<') && content.includes('>');
  if (!role && !hasBlocks) {
    prevEl.innerHTML = '';
    if (listEl) listEl.innerHTML = '';
    return;
  }
  const { lines, speakers, unparsedBlocks } = parseSceneContent(content);
  if (listEl) listEl.innerHTML = speakers.map(sp => `<option value="${esc(sp)}"></option>`).join('');
  const warnings = [];
  if (unparsedBlocks > 0) warnings.push(t('text_revision.scene_warn_unparsed'));
  if (role && !speakers.includes(role)) warnings.push(t('text_revision.scene_warn_role_missing'));
  if (role && lines.length === 0) warnings.push(t('text_revision.scene_warn_no_blocks'));
  const shown = lines.slice(0, 30);
  const body = shown.map(ln => {
    const text = esc(sceneLineText(ln) || '\u00A0').replace(/\n/g, '<br>');
    if (ln.unparsed) return `<div class="tr-sprev-line tr-sprev-warn">${text}</div>`;
    if (!ln.speaker) return `<div class="tr-sprev-line tr-sprev-dir">${text}</div>`;
    const mine = role && ln.speaker === role;
    return `<div class="tr-sprev-line${mine ? ' tr-sprev-mine' : ''}"><span class="tr-sprev-speaker">${esc(ln.speaker)}:</span> ${text}</div>`;
  }).join('');
  const more = lines.length > shown.length ? `<div class="tr-sprev-more">+${lines.length - shown.length}</div>` : '';
  const warnHtml = warnings.map(w => `<div class="tr-sprev-warn">${esc(w)}</div>`).join('');
  prevEl.innerHTML = warnHtml + body + more;
};

window.openEditTextModal = function(id) {
  const tx = allTexts.find(t => t.id === id);
  if (!tx) return;
  closeAllFlashModals();
  const currentDeckId = deckIdForText(tx);
  const deckOptions = deckOptionsForEdit('text', currentDeckId);
  const html = `<div class="modal-overlay" id="editTextModal" style="display:flex;" data-action="close-edit-text" data-overlay-close="true">
    <div class="modal modal-wide">
      <h2>${lucideIcon('pencil', 18, '#f59e0b')} ${t('text_revision.edit_text')}</h2>
      <input type="hidden" id="editTextId" value="${id}">
      <label>${t('flashcards.deck')}</label>
      <select id="editTextDeck">${deckOptions}</select>
      <label>${t('text_revision.title_label')}</label>
      <input type="text" id="editTextTitle" value="${esc(tx.title)}">
      <label>${t('text_revision.author_label')}</label>
      <input type="text" id="editTextAuthor" value="${esc(tx.author || '')}">
      <label>${t('text_revision.content_label')}</label>
      <textarea id="editTextContent" rows="10" style="font-family:monospace;font-size:0.85rem;" data-action="update-scene-preview">${esc(tx.content)}</textarea>
      <div class="tr-modal-row">
        <div class="tr-modal-field">
          <label>${t('text_revision.my_role_label')}</label>
          <input type="text" id="editTextRole" list="editTextRoleList" placeholder="${t('text_revision.my_role_placeholder')}" value="${esc(tx.focus_role || '')}" data-action="update-scene-preview" autocomplete="off">
          <datalist id="editTextRoleList"></datalist>
        </div>
      </div>
      <div class="tr-format-hint">${t('text_revision.scene_format_hint')}</div>
      <div class="tr-scene-preview" id="editTextScenePreview"></div>
      <div class="tr-modal-row">
        <div class="tr-modal-field">
          <label>${t('text_revision.blocks_per_chunk')}</label>
          <input type="number" id="editTextBlocksPerChunk" value="${tx.blocks_per_chunk ?? 4}" min="1" max="20">
        </div>
        <div class="tr-modal-field">
          <label>${t('text_revision.context_blocks')}</label>
          <input type="number" id="editTextContextBlocks" value="${tx.context_blocks ?? 3}" min="0" max="10">
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-edit-text">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-edit-text">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  updateScenePreview(document.getElementById('editTextContent'));
};

window.closeEditTextModal = function() {
  const m = document.getElementById('editTextModal'); if (m) m.remove();
};

window.saveEditText = async function() {
  const id = document.getElementById('editTextId').value;
  const tx = allTexts.find(t => t.id === id);
  const deckId = document.getElementById('editTextDeck').value.trim();
  const deckRow = _deckMap.get(deckId);
  const deck = deckRow?.name ?? deckId;
  const title = document.getElementById('editTextTitle').value.trim();
  const author = document.getElementById('editTextAuthor').value.trim();
  const content = document.getElementById('editTextContent').value;
  if (!title || !content.trim()) { showToast('Title and content are required'); return; }
  const role = document.getElementById('editTextRole').value.trim() || null;
  const blocksPerChunk = Math.max(1, parseInt(document.getElementById('editTextBlocksPerChunk').value, 10) || 4);
  const contextBlocks = Math.max(0, parseInt(document.getElementById('editTextContextBlocks').value, 10) || 0);
  const updates = { deck, title, author: author || null, content, deck_id: deckId, focus_role: role,
    blocks_per_chunk: blocksPerChunk, context_blocks: contextBlocks };
  if (state.db.connected) {
    // A changed blocks-per-chunk invalidates chunk progress via
    // isTextChunkingStale, so auto-repair regenerates it.
    const { ok } = await persistTextEdit(state.db, id, tx, updates,
      { content, blocks_per_chunk: blocksPerChunk, focus_role: role });
    if (!ok) { showToast(t('toast.failed_to_save'), 'error'); return; }
  }
  closeEditTextModal();
  await refreshFlashcards();
  showToast(t('text_revision.text_updated'));
};

// ── Text Practice Session ──
function startTextPractice(deckFilter, anchorEl) {
  const now = new Date();
  let pool = [];

  // Gather all chunks that are due or new, from texts in this deck
  const deckTexts = deckFilter && deckFilter !== '__all'
    ? allTexts.filter(tx => deckIdForText(tx) === deckFilter)
    : allTexts;

  for (const tx of deckTexts) {
    const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
    for (const ch of chunks) {
      if (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now) {
        if (!chunkHasRoleLines(tx, ch.chunk_index)) continue;
        pool.push({ chunk: ch, text: tx });
      }
    }
  }

  if (pool.length === 0) { showAllCaughtUp('texts', anchorEl); return; }
  // New chunks wait until nothing is due: no new material while
  // unmastered chunks are pending.
  const due = pool.filter(p => p.chunk.last_review);
  const candidates = due.length > 0 ? due : pool;

  // Pick the single most due chunk (one revision per session).
  // Ties break by chunk order so a text is learned following its flow.
  const nowStr = now.toISOString();
  candidates.sort((a, b) => {
    const rA = a.chunk.last_review && a.chunk.stability ? retrievability(a.chunk.stability, a.chunk.last_review, nowStr) : -1;
    const rB = b.chunk.last_review && b.chunk.stability ? retrievability(b.chunk.stability, b.chunk.last_review, nowStr) : -1;
    return rA - rB;
  });

  const lowestR = candidates[0].chunk.last_review && candidates[0].chunk.stability
    ? retrievability(candidates[0].chunk.stability, candidates[0].chunk.last_review, nowStr) : -1;
  const tied = candidates.filter(p => {
    const r = p.chunk.last_review && p.chunk.stability
      ? retrievability(p.chunk.stability, p.chunk.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });
  tied.sort((a, b) => (a.chunk.chunk_index - b.chunk.chunk_index) ||
    (a.text.id < b.text.id ? -1 : a.text.id > b.text.id ? 1 : 0));

  const picked = tied[0];
  trSessionActive = true;
  trSessionDeck = deckFilter || null;
  trSessionTextId = picked.text.id;
  showTextPracticeOverlay(picked.text, picked.chunk);
}
window.startTextPractice = startTextPractice;

function startTextPracticeForText(textId) {
  const now = new Date();
  const tx = allTexts.find(t => t.id === textId);
  if (!tx) return;

  const chunks = allChunkProgress.filter(ch => ch.text_id === textId);
  const pool = [];
  for (const ch of chunks) {
    if (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now) {
      if (!chunkHasRoleLines(tx, ch.chunk_index)) continue;
      pool.push({ chunk: ch, text: tx });
    }
  }

  if (pool.length === 0) { startFreePractice(textId); return; }
  // New chunks wait until nothing is due: no new material while
  // unmastered chunks are pending.
  const due = pool.filter(p => p.chunk.last_review);
  const candidates = due.length > 0 ? due : pool;

  // Pick the single most due chunk (one revision per session).
  // Ties break by chunk order so a text is learned following its flow.
  const nowStr = now.toISOString();
  candidates.sort((a, b) => {
    const rA = a.chunk.last_review && a.chunk.stability ? retrievability(a.chunk.stability, a.chunk.last_review, nowStr) : -1;
    const rB = b.chunk.last_review && b.chunk.stability ? retrievability(b.chunk.stability, b.chunk.last_review, nowStr) : -1;
    return rA - rB;
  });

  const lowestR = candidates[0].chunk.last_review && candidates[0].chunk.stability
    ? retrievability(candidates[0].chunk.stability, candidates[0].chunk.last_review, nowStr) : -1;
  const tied = candidates.filter(p => {
    const r = p.chunk.last_review && p.chunk.stability
      ? retrievability(p.chunk.stability, p.chunk.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });
  tied.sort((a, b) => (a.chunk.chunk_index - b.chunk.chunk_index) ||
    (a.text.id < b.text.id ? -1 : a.text.id > b.text.id ? 1 : 0));

  const picked = tied[0];
  trSessionActive = true;
  trSessionDeck = deckIdForText(tx);
  trSessionTextId = picked.text.id;
  showTextPracticeOverlay(picked.text, picked.chunk);
}
window.startTextPracticeForText = startTextPracticeForText;

let trOverlayLines = []; // parsed line objects for the open revision overlay

// Free practice: nothing is due, so sample a random chunk and let the
// user revise without touching scheduling (no FSRS update, no DB write).
function startFreePractice(textId, excludeChunkIndex = null) {
  const tx = allTexts.find(t => t.id === textId);
  if (!tx) return;
  const eligible = ch => ch.text_id === textId && chunkHasRoleLines(tx, ch.chunk_index);
  let candidates = allChunkProgress.filter(ch => eligible(ch) && ch.chunk_index !== excludeChunkIndex);
  if (candidates.length === 0) {
    // Single-chunk text (or everything excluded): allow repeating the chunk.
    candidates = allChunkProgress.filter(eligible);
  }
  if (candidates.length === 0) { showToast(t('text_revision.no_chunks_due')); return; }
  // Random sample (never the just-practiced chunk): repeated clicks revise
  // different chunks instead of always returning the stalest one.
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  trSessionActive = true;
  trSessionDeck = deckIdForText(tx);
  trSessionTextId = tx.id;
  trFreePracticeLastChunk = picked.chunk_index;
  showTextPracticeOverlay(tx, picked, { freePractice: true });
}
window.startFreePractice = startFreePractice;

window.continueFreePractice = function() {
  if (!trSessionTextId) { endTextPractice(); return; }
  startFreePractice(trSessionTextId, trFreePracticeLastChunk);
};

function showTextPracticeOverlay(text, chunk, opts = {}) {
  trFreePractice = !!opts.freePractice;
  let overlay = document.getElementById('practiceOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'practiceOverlay';
    overlay.className = 'practice-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const sceneMode = !!text.focus_role;
  const allChunks = getTextChunks(text);
  const rawChunk = allChunks[chunk.chunk_index] || [];
  // Normalize to line objects: scene lines carry speaker/segments, plain
  // lines behave as the user's own (today's behavior, unchanged).
  // Didascalies are a single reveal unit: consecutive direction lines merge
  // into one block, even when spanning several lines.
  const chunkLines = [];
  const pushLine = (entry) => { entry.idx = chunkLines.length; chunkLines.push(entry); return entry; };
  if (sceneMode) {
    let openDir = null;
    let openDirParts = [];
    for (const ln of rawChunk) {
      const kind = sceneSpeakersEqual(ln.speaker, text.focus_role) ? 'mine' : (ln.speaker ? 'cue' : 'dir');
      const content = renderSceneLineHtml(ln) || '\u00A0';
      if (kind === 'dir') {
        if (openDir) {
          openDir.plain += '\n' + sceneLineText(ln);
          openDirParts.push(content);
          openDir.html = `<div class='tr-reveal-dir'>${openDirParts.join('<br>')}</div>`;
        } else {
          openDirParts = [content];
          // The speaker's name is shown once per group, outside the line boxes
          // (see the lines container below); directions stay centered.
          openDir = pushLine({ kind, speaker: null, plain: sceneLineText(ln),
            html: `<div class='tr-reveal-dir'>${content}</div>` });
        }
      } else {
        openDir = null;
        pushLine({ kind, speaker: ln.speaker, plain: sceneLineText(ln), html: content });
      }
    }
  } else {
    // Plain-text chunks are joined strings; split back into lines
    // (iterating the string would yield one "line" per character).
    const rawLines = typeof rawChunk === 'string' ? rawChunk.split('\n') : rawChunk;
    for (const line of rawLines) pushLine({ kind: 'mine', speaker: null, plain: line, html: esc(line || '\u00A0') });
  }
  trOverlayLines = chunkLines;
  const roleColorMap = sceneMode
    ? buildRoleColorMap(parseSceneContent(text.content).speakers, text.focus_role)
    : new Map();
  const myLineCount = chunkLines.filter(l => l.kind === 'mine').length;

  // Compute context: preceding lines
  let contextBlocks = [];
  if (chunk.chunk_index === 0) {
    contextBlocks = null; // beginning of text
  } else {
    const preceding = [];
    for (const c of allChunks.slice(0, chunk.chunk_index)) {
      if (sceneMode) { for (const ln of c) preceding.push(ln); }
      else { for (const s of c.split('\n')) preceding.push(s); }
    }
    contextBlocks = preceding.slice(-text.context_blocks);
  }

  const authorStr = text.author ? ` — ${esc(text.author)}` : '';
  const contextHtml = contextBlocks === null
    ? `<div class="tr-context-marker">${t('text_revision.beginning')}</div>`
    : contextBlocks.map(l => {
        if (!sceneMode) return `<div class="tr-context-line">${esc(l || '\u00A0')}</div>`;
        const sp = l.speaker ? `<span class='tr-speaker'>${esc(l.speaker)}:</span> ` : '';
        const cls = l.speaker ? 'tr-context-line' : 'tr-context-line tr-context-dir';
        return `<div class="${cls}">${sp}${esc(sceneLineText(l) || '\u00A0').replace(/\n/g, '<br>')}</div>`;
      }).join('');

  overlay.innerHTML = `
    <div class="practice-header">
      ${practiceHeaderLogo()}
      <div class="practice-progress-bar"><div class="practice-progress-fill" style="width:0%;"></div></div>
      <div class="practice-meta"><span class="practice-meta-text">${esc(text.title)}${authorStr}</span>${trFreePractice ? ` <span class="tr-practice-badge">${t('text_revision.free_practice')}</span>` : ''}</div>
      <button class="practice-close" data-action="end-text-practice">X</button>
    </div>
    <div class="tr-practice-area">
      <div class="tr-context-section">
        <div class="tr-context-label">${esc(text.title)}${authorStr}</div>
        ${contextHtml}
      </div>
      <div class="tr-lines-container${sceneMode ? ' tr-scene' : ''}" id="trLinesContainer">
        ${groupLinesBySpeaker(chunkLines).map(group => {
          let header = '';
          if (group.speaker) {
            const isMine = sceneSpeakersEqual(group.speaker, text.focus_role);
            const colorCls = isMine ? 'tr-role-mine' : (roleColorMap.get(group.speaker.toLowerCase()) || '');
            header = `<div class="tr-group-speaker ${colorCls} ${isMine ? 'tr-spk-left' : 'tr-spk-right'}">${esc(group.speaker)}</div>`;
          } else if (group.lines[0] && group.lines[0].kind === 'dir') {
            // Didascalies get a header like the roles: centered, muted, localized.
            // (Plain-text lines have no speaker but kind 'mine', so no header.)
            header = `<div class="tr-group-speaker tr-role-dir tr-spk-center">${t('text_revision.stage_directions')}</div>`;
          }
          return `
          <div class="tr-line-group"${group.speaker ? ` data-speaker="${esc(group.speaker)}"` : ''}>
            ${header}
            ${group.lines.map(line => {
              const bullets = (line.plain || '').split('\n')
                .map(part => '• '.repeat(Math.max(1, Math.ceil(part.length / 6))))
                .join('<br>');
              return `<div class="tr-line tr-line-masked${line.idx === 0 ? ' tr-line-next' : ''}" data-line-idx="${line.idx}" data-kind="${line.kind}" data-action="handle-line-click">${bullets}</div>`;
            }).join('')}
          </div>`; }).join('')}
      </div>
      <div class="tr-hint" id="trHint">${t('text_revision.tap_to_reveal')}</div>
      <div class="tr-submit-section" id="trSubmitSection" style="display:none;">
        <button class="btn practice-done-btn" data-action="submit-text-review" data-id="${esc(chunk.id)}" data-lines="${myLineCount}">${t('text_revision.submit')}</button>
      </div>
    </div>`;
  initMarquee();

  // Auto-reveal leading cues/directions up to the first line of the
  // revised role (no-op when the chunk opens with the role's line).
  const autoReveal = leadingRevealCount(chunkLines.map(l => l.kind));
  if (autoReveal > 0) {
    const container = document.getElementById('trLinesContainer');
    const lines = container.querySelectorAll('.tr-line');
    for (let i = 0; i < autoReveal; i++) {
      const el = lines[i];
      el.classList.remove('tr-line-masked', 'tr-line-next');
      el.classList.add('tr-line-shown');
      const lineObj = trOverlayLines[parseInt(el.dataset.lineIdx, 10)];
      el.innerHTML = lineObj ? lineObj.html : '';
    }
    lines[autoReveal].classList.add('tr-line-next');
  }
  updateTextPracticeProgress();
}

// Progress bar for text revision: fills as blocks are revealed.
function updateTextPracticeProgress() {
  const container = document.getElementById('trLinesContainer');
  const fill = document.querySelector('#practiceOverlay .practice-header .practice-progress-fill');
  if (!container || !fill) return;
  const total = container.querySelectorAll('.tr-line').length;
  const masked = container.querySelectorAll('.tr-line-masked').length;
  fill.style.width = (total > 0 ? Math.round(((total - masked) / total) * 100) : 100) + '%';
}

window.handleLineClick = function(el) {
  const idx = parseInt(el.dataset.lineIdx, 10);
  const container = document.getElementById('trLinesContainer');
  const lines = container.querySelectorAll('.tr-line');
  const kind = el.dataset.kind || 'mine';

  if (el.classList.contains('tr-line-masked')) {
    // Only allow revealing the next unmasked line in order
    let nextMaskedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].classList.contains('tr-line-masked')) { nextMaskedIdx = i; break; }
    }
    if (idx !== nextMaskedIdx) return; // can only reveal in order

    const lineObj = trOverlayLines[idx];
    el.classList.remove('tr-line-masked', 'tr-line-next');
    if (kind === 'mine') {
      // Own line: reveal as known (toggleable to failed below)
      el.classList.add('tr-line-known');
    } else {
      // Cue / direction: revealed neutrally, never evaluated
      el.classList.add('tr-line-shown');
    }
    el.innerHTML = lineObj ? lineObj.html : '';

    if (kind === 'mine') {
      // Revealing an own line also reveals everything that follows it up
      // to the next own line: cues and directions are not practised, so
      // there is nothing to recall in them — tapping through them one by
      // one (several blocks of the same other role included) only slows
      // the rehearsal down. They reveal neutrally, like a manual tap.
      const follow = trailingRevealCount(trOverlayLines.map(l => l.kind), idx);
      for (let j = idx + 1; j <= idx + follow; j++) {
        const fel = lines[j];
        if (!fel || !fel.classList.contains('tr-line-masked')) break;
        fel.classList.remove('tr-line-masked', 'tr-line-next');
        fel.classList.add('tr-line-shown');
        const fObj = trOverlayLines[parseInt(fel.dataset.lineIdx, 10)];
        fel.innerHTML = fObj ? fObj.html : '';
      }
    }

    // Mark next masked line as the active target
    const nextMasked = container.querySelector('.tr-line-masked');
    if (nextMasked) {
      nextMasked.classList.add('tr-line-next');
    }

    // Check if all lines revealed — show submit
    const remaining = container.querySelectorAll('.tr-line-masked');
    if (remaining.length === 0) {
      document.getElementById('trHint').style.display = 'none';
      document.getElementById('trSubmitSection').style.display = 'block';
    }
    updateTextPracticeProgress();
  } else {
    // Toggle between known and failed (own lines only)
    if (kind !== 'mine') return;
    el.classList.toggle('tr-line-known');
    el.classList.toggle('tr-line-failed');
  }
};

window.submitTextReview = async function(chunkId, totalLines) {
  const lineEls = document.querySelectorAll('#trLinesContainer .tr-line');
  let knownCount = 0;
  lineEls.forEach(el => { if (el.classList.contains('tr-line-known')) knownCount++; });

  if (trFreePractice) {
    // Extra practice only: report the score, leave scheduling untouched.
    showFreePracticeSummary(knownCount, totalLines);
    return;
  }

  const ratio = totalLines > 0 ? knownCount / totalLines : 0;
  let rating;
  if (ratio >= 1) rating = 3; // Good (perfect)
  else if (ratio >= 0.5) rating = 2; // Hard (partial)
  else rating = 1; // Again (less than half)

  // Apply FSRS update — except in read-only mode, where the review is
  // session-local like free practice: the summary still shows the
  // score and the rating it would have earned, but nothing is written
  // or applied to the in-memory schedule.
  const chunk = allChunkProgress.find(ch => ch.id === chunkId);
  if (!chunk) { endTextPractice(); return; }

  if (!state.readOnlyMode) {
    const now = new Date();
    const updates = fsrsUpdate(chunk, rating, now);
    Object.assign(chunk, updates);

    if (state.db.connected) {
      await state.db.from('text_line_progress').update(updates).eq('id', chunkId);
    }
  }

  // Show summary
  showTextPracticeSummary(knownCount, totalLines, rating);
};

function showFreePracticeSummary(known, total) {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  const pct = total > 0 ? Math.round((known / total) * 100) : 0;
  overlay.innerHTML = `
    <div class="practice-summary">
      ${practiceSummaryLogo()}
      <div class="practice-summary-emoji">${pct >= 80 ? lucideIcon('trophy', 32) : pct >= 50 ? lucideIcon('flame', 32) : lucideIcon('book-open', 32)}</div>
      <h2>${t('text_revision.free_practice_done')}</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${known}/${total}</span><span class="practice-stat-lbl">${t('text_revision.lines_known')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${pct}%</span><span class="practice-stat-lbl">${t('flashcards.accuracy')}</span></div>
      </div>
      <div class="tr-free-note">${t('text_revision.free_practice_note')}</div>
      <div class="practice-summary-actions">
        <button class="btn practice-continue-btn" data-action="continue-free-practice">${t('text_revision.free_practice_another')}</button>
        <button class="btn practice-done-btn" data-action="end-text-practice">${t('common.close')}</button>
      </div>
    </div>`;
}

function showTextPracticeSummary(known, total, rating) {
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  const pct = total > 0 ? Math.round((known / total) * 100) : 0;
  const ratingLabels = { 1: t('flashcards.again'), 2: t('flashcards.hard'), 3: t('flashcards.good'), 4: t('flashcards.easy') };

  // Check for more due chunks from same text
  const now = new Date();
  let sameTextMore = false;
  let anyMore = false;

  if (trSessionTextId) {
    const sameTextChunks = allChunkProgress.filter(ch =>
      ch.text_id === trSessionTextId &&
      (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now)
    );
    sameTextMore = sameTextChunks.length > 0;
  }

  // Check for any due chunks across the deck
  const deckTexts = trSessionDeck && trSessionDeck !== '__all'
    ? allTexts.filter(tx => deckIdForText(tx) === trSessionDeck)
    : allTexts;
  for (const tx of deckTexts) {
    const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
    for (const ch of chunks) {
      if (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now) {
        anyMore = true;
        break;
      }
    }
    if (anyMore) break;
  }

  let actionButtons = '';
  if (sameTextMore) {
    actionButtons += `<button class="btn practice-continue-btn" data-action="continue-text-same-text">${t('text_revision.continue_same_text')}</button>`;
  }
  if (anyMore) {
    actionButtons += `<button class="btn practice-continue-btn practice-continue-alt" data-action="start-text-practice" data-deck="${esc(trSessionDeck || '')}">${t('text_revision.continue_another')}</button>`;
  }

  overlay.innerHTML = `
    <div class="practice-summary">
      ${practiceSummaryLogo()}
      <div class="practice-summary-emoji">${pct >= 80 ? lucideIcon('trophy', 32) : pct >= 50 ? lucideIcon('flame', 32) : lucideIcon('book-open', 32)}</div>
      <h2>${t('text_revision.session_complete')}</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${known}/${total}</span><span class="practice-stat-lbl">${t('text_revision.lines_known')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${pct}%</span><span class="practice-stat-lbl">${t('flashcards.accuracy')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${ratingLabels[rating] || rating}</span><span class="practice-stat-lbl">${t('text_revision.rating')}</span></div>
      </div>
      <div class="practice-summary-actions">
        ${actionButtons}
        <button class="btn practice-done-btn" data-action="end-text-practice">${t('common.close')}</button>
      </div>
    </div>`;
}

window.continueTextSameText = function() {
  // Start another chunk from the same text
  const now = new Date();
  const text = allTexts.find(tx => tx.id === trSessionTextId);
  if (!text) { showToast(t('text_revision.no_chunks_due')); endTextPractice(); return; }

  const chunks = allChunkProgress.filter(ch =>
    ch.text_id === trSessionTextId &&
    (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now) &&
    chunkHasRoleLines(text, ch.chunk_index)
  );
  if (chunks.length === 0) { showToast(t('text_revision.no_chunks_due')); endTextPractice(); return; }
  // New chunks wait until nothing is due: no new material while
  // unmastered chunks are pending.
  const due = chunks.filter(ch => ch.last_review);
  const candidates = due.length > 0 ? due : chunks;

  // Pick the single most due chunk.
  // Ties break by chunk order so a text is learned following its flow.
  const nowStr = now.toISOString();
  candidates.sort((a, b) => {
    const rA = a.last_review && a.stability ? retrievability(a.stability, a.last_review, nowStr) : -1;
    const rB = b.last_review && b.stability ? retrievability(b.stability, b.last_review, nowStr) : -1;
    return rA - rB;
  });

  const lowestR = candidates[0].last_review && candidates[0].stability
    ? retrievability(candidates[0].stability, candidates[0].last_review, nowStr) : -1;
  const tied = candidates.filter(ch => {
    const r = ch.last_review && ch.stability
      ? retrievability(ch.stability, ch.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });
  tied.sort((a, b) => a.chunk_index - b.chunk_index);

  const picked = tied[0];
  showTextPracticeOverlay(text, picked);
};

window.endTextPractice = function() {
  trFreePractice = false;
  trFreePracticeLastChunk = null;
  const overlay = document.getElementById('practiceOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  trSessionActive = false;
  renderFlashcards();
};

// ── Keyboard shortcuts in practice ──
document.addEventListener('keydown', (e) => {
  if (trSessionActive) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const revealBtn = document.getElementById('trRevealBtn');
      if (revealBtn && document.getElementById('trChallengeSection')?.style.display !== 'none') {
        window.revealTextChunk();
      }
    }
    if (e.key === 'Escape') window.endTextPractice();
    return;
  }
  if (!sessionActive) return;
  const card = document.getElementById('practiceCard');
  if (!card) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!card.classList.contains('flipped')) window.revealCard();
  } else if (card.classList.contains('flipped')) {
    if (e.key === '1') window.rateCard(1);
    else if (e.key === '2') window.rateCard(2);
    else if (e.key === '3') window.rateCard(3);
    else if (e.key === '4') window.rateCard(4);
  }
  if (e.key === 'Escape') window.endPractice();
});

// ===================================================================
// EXPORTS
// ===================================================================
function initFlashcardModals() {}

// ── Bulk Import ──

function buildImportPrompt(mode, deckId, deckLabel, deckType) {
  const lang = getLang();
  const LANG_NAMES = { en: 'English', fr: 'French', es: 'Spanish' };
  const langName = LANG_NAMES[lang] || 'English';
  const langInstruction = lang !== 'en'
    ? `\n\nIMPORTANT: Generate ALL content (titles, questions, answers, text) in ${langName}.`
    : '';

  if (deckType === 'text') {
    if (mode === 'convert') {
      return `I want to convert existing texts into a structured JSON format for import into a flashcard/text-revision app.

Output a JSON array. Each element must have:
- "title": string (the text's title)
- "author": string or null
- "content": string (the full text, with line breaks as \\n)

Example:
[
  {
    "title": "Le Lac",
    "author": "Alphonse de Lamartine",
    "content": "Ainsi, toujours poussés vers de nouveaux rivages,\\nDans la nuit éternelle emportés sans retour,\\nNe pourrons-nous jamais sur l'océan des âges\\nJeter l'ancre un seul jour ?"
  }
]

Output ONLY valid JSON, no markdown fences, no commentary.${langInstruction}
Paste your texts below and I will convert them:`;
    }
    // generate
    const existing = deckId && deckId !== '__new' ? allTexts.filter(tx => deckIdForText(tx) === deckId) : [];
    let ctx = '';
    if (existing.length > 0) {
      const samples = existing.slice(0, 3).map(tx =>
        `  - "${tx.title}"${tx.author ? ` by ${tx.author}` : ''}`
      ).join('\n');
      ctx = `\n\nExisting texts in "${deckLabel}" deck:\n${samples}\n\nGenerate texts that complement this collection.`;
    }
    return `Generate texts for a text-revision/memorisation app, for the "${deckLabel}" deck.${ctx}

Output a JSON array. Each element must have:
- "title": string
- "author": string or null
- "content": string (the full text, line breaks as \\n)

Example:
[
  {
    "title": "Le Lac",
    "author": "Alphonse de Lamartine",
    "content": "Ainsi, toujours poussés vers de nouveaux rivages,\\nDans la nuit éternelle emportés sans retour,\\nNe pourrons-nous jamais sur l'océan des âges\\nJeter l'ancre un seul jour ?"
  }
]

Output ONLY valid JSON, no markdown fences, no commentary.${langInstruction}`;
  }

  // Flashcard mode
  if (mode === 'convert') {
    return `I want to convert existing flashcards into a structured JSON format for import.

Output a JSON array of objects, each with:
- "front": string (the question)
- "back": string (the answer)

Example:
[
  { "front": "What is the capital of France?", "back": "Paris" },
  { "front": "H₂O is the formula for?", "back": "Water" }
]

Output ONLY valid JSON, no markdown fences, no commentary.${langInstruction}
Paste your flashcards below and I will convert them:`;
  }

  // generate
  const existing = deckId && deckId !== '__new' ? allCards.filter(c => deckIdForCard(c) === deckId) : [];
  let ctx = '';
  if (existing.length > 0) {
    const samples = existing.slice(0, 8).map(c =>
      `  - Q: "${c.front}" → A: "${c.back}"`
    ).join('\n');
    ctx = `\n\nExisting cards in "${deckLabel}" deck (${existing.length} total):\n${samples}${existing.length > 8 ? `\n  ... and ${existing.length - 8} more` : ''}\n\nGenerate cards that complement this collection — avoid duplicates, match the style and depth.`;
  }
  return `Generate flashcards for a spaced-repetition app, for the "${deckLabel}" deck.${ctx}

Output a JSON array of objects, each with:
- "front": string (the question)
- "back": string (the answer)

Example:
[
  { "front": "What is the capital of France?", "back": "Paris" },
  { "front": "H₂O is the formula for?", "back": "Water" }
]

Output ONLY valid JSON, no markdown fences, no commentary.${langInstruction}`;
}

function parseImportJSON(raw, deckType) {
  let text = raw.trim();
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let arr;
  try { arr = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
  if (arr.length === 0) throw new Error('Array is empty');
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (deckType === 'text') {
      if (!item.title || typeof item.title !== 'string') throw new Error(`Item ${i + 1}: missing "title"`);
      if (!item.content || typeof item.content !== 'string') throw new Error(`Item ${i + 1}: missing "content"`);
    } else {
      if (!item.front || typeof item.front !== 'string') throw new Error(`Item ${i + 1}: missing "front"`);
      if (!item.back || typeof item.back !== 'string') throw new Error(`Item ${i + 1}: missing "back"`);
    }
  }
  return arr;
}

window.openImportModal = async function() {
  closeAllFlashModals();
  const { LLM_SERVICES, escHtml } = await import('./demo-chooser.js');

  // Bucket-only, tree order, path labels — like deckOptionsForEdit.
  // (Import targets a deck, never a section.)
  const importTree = getDeckTree();
  const deckOptions = flattenTree(importTree.roots)
    .filter(n => n.kind === 'bucket' && n.id !== _sharedDeckId)
    .map(n => {
      const label = pathLabelOf(n, importTree.byId) || t('common.category_default');
      return `<option value="${esc(n.id)}">${esc(label)}</option>`;
    }).join('');

  const isMobile = isMobileUA();
  const serviceButtons = LLM_SERVICES.map(s => {
    const href = isMobile && s.appUrl ? s.appUrl : s.url;
    return `<a href="${href}" target="_blank" rel="noopener" class="dc-llm-btn">${s.svg}<span>${s.name}</span></a>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  overlay.id = 'importFlashModal';

  overlay.innerHTML = `
    <div class="dc-container">
      <div class="dc-header">
        <h2>${lucideIcon('upload', 20, 'var(--accent)')} ${t('flashcards.import_title')}</h2>
        <p class="dc-subtitle">${t('flashcards.import_subtitle')}</p>
      </div>

      <div id="importOptions" class="dc-options">
        <button class="dc-card" id="importConvertCard">
          <div class="dc-card-icon">${lucideIcon('file-text', 28)}</div>
          <div class="dc-card-title">${t('flashcards.import_convert_title')}</div>
          <div class="dc-card-desc">${t('flashcards.import_convert_desc')}</div>
        </button>
        <button class="dc-card" id="importGenerateCard">
          <div class="dc-card-icon">${lucideIcon('sparkles', 28)}</div>
          <div class="dc-card-title">${t('flashcards.import_generate_title')}</div>
          <div class="dc-card-desc">${t('flashcards.import_generate_desc')}</div>
        </button>
      </div>

      <div class="dc-custom-flow" id="importFlow" style="display:none">
        <div class="import-config">
          <label class="import-config-label">${t('flashcards.import_deck')}
            <select id="importDeckSelect" class="page-sort">${deckOptions}
              <option value="__new">+ ${t('flashcards.new_deck')}</option>
            </select>
          </label>
          <div id="importNewDeckWrap" class="import-new-deck-wrap" style="display:none">
            <input type="text" id="importNewDeckName" class="import-new-deck-input" placeholder="${t('flashcards.import_new_deck_prompt')}">
          </div>
          <label class="import-config-label">${t('flashcards.import_type')}
            <select id="importTypeSelect" class="page-sort">
              <option value="flashcard">${t('flashcards.import_flashcards')}</option>
              <option value="text">${t('flashcards.import_texts')}</option>
            </select>
          </label>
        </div>

        <div class="dc-step">
          <div class="dc-step-header">
            <span class="dc-step-num">1</span>
            <span>${t('flashcards.import_step1')}</span>
          </div>
          <div class="dc-prompt-box">
            <textarea class="dc-prompt-text" id="importPromptText" rows="6" spellcheck="false"></textarea>
            <button class="dc-copy-btn" id="importCopyBtn">
              <span class="import-copy-icon">${lucideIcon('copy', 15)}</span>
              <span id="importCopyLabel">${t('flashcards.import_copy')}</span>
            </button>
          </div>
        </div>

        <div class="dc-step">
          <div class="dc-step-header">
            <span class="dc-step-num">2</span>
            <span>${t('flashcards.import_step2')}</span>
          </div>
          <div class="dc-llm-links">${serviceButtons}</div>
        </div>

        <div class="dc-step">
          <div class="dc-step-header">
            <span class="dc-step-num">3</span>
            <span>${t('flashcards.import_step3')}</span>
          </div>
          <textarea class="dc-paste-area" id="importPasteArea" rows="8" placeholder="${t('flashcards.import_paste_placeholder')}"></textarea>
          <div id="importPreview" class="import-preview" style="display:none"></div>
          <div class="dc-error" id="importError" style="display:none"></div>
          <div class="dc-flow-actions" id="importPasteActions">
            <button class="dc-btn-secondary" id="importBackBtn">${t('flashcards.import_back')}</button>
            <button class="dc-btn-primary" id="importReviewBtn" disabled>
              ${lucideIcon('eye', 15)}
              ${t('flashcards.import_review')}
            </button>
          </div>
        </div>
      </div>

      <div id="importReviewStep" style="display:none">
        <div id="importReviewContainer" class="import-review"></div>
        <div class="dc-error" id="importReviewError" style="display:none"></div>
        <div class="dc-flow-actions">
          <button class="dc-btn-secondary" id="importReviewBackBtn">${t('flashcards.import_back_to_paste')}</button>
          <button class="dc-btn-primary" id="importConfirmBtn" disabled>
            ${lucideIcon('check', 15)}
            ${t('flashcards.import_btn')}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // DOM refs
  const optionsDiv = overlay.querySelector('#importOptions');
  const flowDiv = overlay.querySelector('#importFlow');
  const deckSelect = overlay.querySelector('#importDeckSelect');
  const newDeckWrap = overlay.querySelector('#importNewDeckWrap');
  const newDeckInput = overlay.querySelector('#importNewDeckName');
  const typeSelect = overlay.querySelector('#importTypeSelect');
  const promptPre = overlay.querySelector('#importPromptText');
  const copyBtn = overlay.querySelector('#importCopyBtn');
  const copyLabel = overlay.querySelector('#importCopyLabel');
  const copyIcon = overlay.querySelector('.import-copy-icon');
  const pasteArea = overlay.querySelector('#importPasteArea');
  const reviewBtn = overlay.querySelector('#importReviewBtn');
  const backBtn = overlay.querySelector('#importBackBtn');
  const errorDiv = overlay.querySelector('#importError');
  const previewDiv = overlay.querySelector('#importPreview');
  const pasteActions = overlay.querySelector('#importPasteActions');
  const reviewStep = overlay.querySelector('#importReviewStep');
  const reviewContainer = overlay.querySelector('#importReviewContainer');
  const reviewError = overlay.querySelector('#importReviewError');
  const reviewBackBtn = overlay.querySelector('#importReviewBackBtn');
  const confirmBtn = overlay.querySelector('#importConfirmBtn');

  let importMode = null; // 'convert' | 'generate'
  let parsedItems = []; // items currently in review
  let itemStates = []; // {included: bool} per item

  function selectedDeckId() { return deckSelect.value || null; } // deck row ID or '__new'
  function selectedDeckLabel() {
    const sel = selectedDeckId();
    if (sel === '__new') return newDeckInput.value.trim() || t('flashcards.new_deck');
    return sel ? getDeckDisplayName(sel) : t('common.category_default');
  }
  function selectedType() { return typeSelect.value; }

  function updatePrompt() {
    const type = selectedType();
    promptPre.value = buildImportPrompt(importMode, selectedDeckId(), selectedDeckLabel(), type);
  }

  // Auto-detect type from selected deck
  function autoDetectType() {
    const deckId = selectedDeckId();
    if (!deckId || deckId === '__new') return;
    const hasCards = allCards.some(c => deckIdForCard(c) === deckId);
    const hasTexts = allTexts.some(tx => deckIdForText(tx) === deckId);
    if (hasTexts && !hasCards) typeSelect.value = 'text';
    else typeSelect.value = 'flashcard';
  }

  function showFlow(mode) {
    importMode = mode;
    optionsDiv.style.display = 'none';
    flowDiv.style.display = '';
    overlay.querySelector('.dc-subtitle').style.display = 'none';
    // If no existing decks, __new is auto-selected — show the input immediately
    if (deckSelect.value === '__new') {
      newDeckWrap.style.display = '';
      newDeckInput.focus();
    }
    autoDetectType();
    updatePrompt();
  }

  // Card clicks
  overlay.querySelector('#importConvertCard').addEventListener('click', () => showFlow('convert'));
  overlay.querySelector('#importGenerateCard').addEventListener('click', () => showFlow('generate'));

  // Deck/type change → regenerate prompt
  deckSelect.addEventListener('change', () => {
    if (deckSelect.value === '__new') {
      newDeckWrap.style.display = '';
      newDeckInput.value = '';
      newDeckInput.focus();
    } else {
      newDeckWrap.style.display = 'none';
    }
    autoDetectType();
    updatePrompt();
  });
  typeSelect.addEventListener('change', updatePrompt);
  newDeckInput.addEventListener('input', updatePrompt);

  // Copy prompt
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(promptPre.value);
      copyLabel.textContent = t('flashcards.import_copied');
      copyIcon.innerHTML = lucideIcon('clipboard-check', 15);
      setTimeout(() => {
        copyLabel.textContent = t('flashcards.import_copy');
        copyIcon.innerHTML = lucideIcon('copy', 15);
      }, 2000);
    } catch {
      promptPre.select();
    }
  });

  // Validate paste
  pasteArea.addEventListener('input', () => {
    const raw = pasteArea.value.trim();
    errorDiv.style.display = 'none';
    previewDiv.style.display = 'none';
    if (!raw) { reviewBtn.disabled = true; return; }
    try {
      const items = parseImportJSON(raw, selectedType());
      reviewBtn.disabled = false;
      // Show preview
      const type = selectedType();
      const count = items.length;
      const sample = items.slice(0, 3).map(item => {
        if (type === 'text') return `<div class="import-preview-item">${lucideIcon('book-open', 14, 'var(--muted)')} ${esc(item.title)}${item.author ? ` — ${esc(item.author)}` : ''}</div>`;
        return `<div class="import-preview-item">${lucideIcon('brain', 14, 'var(--muted)')} <strong>${esc(item.front)}</strong> → ${esc(item.back)}</div>`;
      }).join('');
      previewDiv.innerHTML = `<div class="import-preview-header">${t('flashcards.import_cards_ready', count, type === 'text' ? (count !== 1 ? t('flashcards.import_text_plural') : t('flashcards.import_text_singular')) : (count !== 1 ? t('flashcards.import_card_plural') : t('flashcards.import_card_singular')))}</div>${sample}${count > 3 ? `<div class="import-preview-more">${t('flashcards.import_and_more', count - 3)}</div>` : ''}`;
      previewDiv.style.display = '';
    } catch (e) {
      reviewBtn.disabled = true;
      errorDiv.textContent = e.message;
      errorDiv.style.display = '';
    }
  });

  // Back from paste to options
  backBtn.addEventListener('click', () => {
    flowDiv.style.display = 'none';
    optionsDiv.style.display = '';
    overlay.querySelector('.dc-subtitle').style.display = '';
    errorDiv.style.display = 'none';
    previewDiv.style.display = 'none';
    pasteArea.value = '';
    reviewBtn.disabled = true;
    importMode = null;
  });

  // --- Review Step ---
  function updateConfirmBtn() {
    const selectedCount = itemStates.filter(s => s.included).length;
    const type = selectedType();
    const label = type === 'text'
      ? (selectedCount !== 1 ? t('flashcards.import_text_plural') : t('flashcards.import_text_singular'))
      : (selectedCount !== 1 ? t('flashcards.import_card_plural') : t('flashcards.import_card_singular'));
    confirmBtn.innerHTML = `${lucideIcon('check', 15)} ${t('flashcards.import_confirm', selectedCount, label)}`;
    confirmBtn.disabled = selectedCount === 0;
  }

  function updateReviewCount() {
    const countEl = reviewContainer.querySelector('.import-review-count');
    if (!countEl) return;
    const selectedCount = itemStates.filter(s => s.included).length;
    countEl.textContent = t('flashcards.import_selected_count', selectedCount, parsedItems.length);
  }

  function renderReview() {
    const type = selectedType();
    const total = parsedItems.length;
    const label = type === 'text'
      ? (total !== 1 ? t('flashcards.import_text_plural') : t('flashcards.import_text_singular'))
      : (total !== 1 ? t('flashcards.import_card_plural') : t('flashcards.import_card_singular'));

    let html = `<div class="import-review-toolbar">
      <div class="import-review-toolbar-left">
        <strong>${t('flashcards.import_review_header', total, label)}</strong>
        <button class="import-review-toggle" id="importToggleAll">${t('flashcards.import_deselect_all')}</button>
      </div>
      <span class="import-review-count">${t('flashcards.import_selected_count', total, total)}</span>
    </div><div class="import-review-list">`;

    parsedItems.forEach((item, i) => {
      const checked = itemStates[i].included ? 'checked' : '';
      const excluded = itemStates[i].included ? '' : ' excluded';
      if (type === 'text') {
        html += `<div class="import-review-card${excluded}" data-idx="${i}">
          <span class="import-review-num">${i + 1}</span>
          <input type="checkbox" class="import-review-check" data-idx="${i}" ${checked}>
          <div class="import-review-fields">
            <div class="import-review-field">
              <span class="import-review-field-label">${t('flashcards.import_edit_title')}</span>
              <input class="import-review-field-input" data-idx="${i}" data-field="title" value="${esc(item.title)}">
            </div>
            <div class="import-review-field">
              <span class="import-review-field-label">${t('flashcards.import_edit_author')}</span>
              <input class="import-review-field-input" data-idx="${i}" data-field="author" value="${esc(item.author || '')}">
            </div>
          </div>
        </div>`;
      } else {
        html += `<div class="import-review-card${excluded}" data-idx="${i}">
          <span class="import-review-num">${i + 1}</span>
          <input type="checkbox" class="import-review-check" data-idx="${i}" ${checked}>
          <div class="import-review-fields">
            <div class="import-review-field">
              <span class="import-review-field-label">${t('flashcards.import_edit_front')}</span>
              <input class="import-review-field-input" data-idx="${i}" data-field="front" value="${esc(item.front)}">
            </div>
            <div class="import-review-field">
              <span class="import-review-field-label">${t('flashcards.import_edit_back')}</span>
              <input class="import-review-field-input" data-idx="${i}" data-field="back" value="${esc(item.back)}">
            </div>
          </div>
        </div>`;
      }
    });

    html += '</div>';
    reviewContainer.innerHTML = html;
    updateConfirmBtn();

    // Toggle all
    const toggleBtn = reviewContainer.querySelector('#importToggleAll');
    toggleBtn.addEventListener('click', () => {
      const allIncluded = itemStates.every(s => s.included);
      const newState = !allIncluded;
      itemStates.forEach(s => s.included = newState);
      reviewContainer.querySelectorAll('.import-review-check').forEach(cb => cb.checked = newState);
      reviewContainer.querySelectorAll('.import-review-card').forEach(card => {
        card.classList.toggle('excluded', !newState);
      });
      toggleBtn.textContent = newState ? t('flashcards.import_deselect_all') : t('flashcards.import_select_all');
      updateConfirmBtn();
      updateReviewCount();
    });

    // Individual checkboxes
    reviewContainer.querySelectorAll('.import-review-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.idx);
        itemStates[idx].included = cb.checked;
        const card = reviewContainer.querySelector(`.import-review-card[data-idx="${idx}"]`);
        card.classList.toggle('excluded', !cb.checked);
        // Update toggle button text
        const allIncluded = itemStates.every(s => s.included);
        const noneIncluded = itemStates.every(s => !s.included);
        toggleBtn.textContent = allIncluded ? t('flashcards.import_deselect_all') : t('flashcards.import_select_all');
        updateConfirmBtn();
        updateReviewCount();
      });
    });

    // Inline edit fields
    reviewContainer.querySelectorAll('.import-review-field-input').forEach(input => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx);
        const field = input.dataset.field;
        parsedItems[idx][field] = input.value;
      });
    });
  }

  // Review button → show review step
  reviewBtn.addEventListener('click', () => {
    const type = selectedType();
    try {
      parsedItems = parseImportJSON(pasteArea.value, type);
    } catch (e) {
      errorDiv.textContent = e.message;
      errorDiv.style.display = '';
      return;
    }
    itemStates = parsedItems.map(() => ({ included: true }));

    // Hide paste step, show review step
    flowDiv.style.display = 'none';
    reviewStep.style.display = '';
    renderReview();
  });

  // Back from review to paste
  reviewBackBtn.addEventListener('click', () => {
    reviewStep.style.display = 'none';
    flowDiv.style.display = '';
    reviewError.style.display = 'none';
  });

  // Confirm import
  confirmBtn.addEventListener('click', async () => {
    const type = selectedType();
    const selectedItems = parsedItems.filter((_, i) => itemStates[i].included);
    if (selectedItems.length === 0) return;

    let deckId = null;
    let deckName = '';
    const sel = selectedDeckId();
    if (!state.db.connected) { showToast('Not connected'); return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = t('flashcards.import_importing');

    // If deck doesn't exist yet, create the deck row (same as manual creation)
    if (sel === '__new') {
      deckName = newDeckInput.value.trim();
      if (!deckName) {
        showToast(t('flashcards.import_no_deck'));
        confirmBtn.disabled = false;
        return;
      }
      const color = nextPaletteColor(_deckMap);
      const sortOrder = nextFlashSortOrder(null);
      // Take the id from the insert itself: with sibling-scoped names
      // the name map is first-wins, so a name lookup could return an
      // older same-name deck instead of the row just created.
      const { data: newDeck } = await state.db.from('flashcard_decks').insert({ name: deckName, color, sort_order: sortOrder, kind: 'bucket', parent_id: null }).select();
      await loadFlashcardDecks();
      deckId = newDeck?.[0]?.id || _deckByName.get(deckName)?.id || null;
    } else if (sel) {
      deckId = sel;
      deckName = _deckMap.get(deckId)?.name ?? '';
    } else {
      showToast(t('flashcards.import_no_deck'));
      confirmBtn.disabled = false;
      return;
    }

    try {
      if (type === 'text') {
        for (const item of selectedItems) {
          const blocksPerChunk = 4;
          const { data: inserted } = await state.db.from('texts').insert({
            deck: deckName, title: item.title, author: item.author || null,
            content: item.content, blocks_per_chunk: blocksPerChunk, context_blocks: 3, deck_id: deckId
          }).select('*');
          if (inserted && inserted.length > 0) {
            const textRow = inserted[0];
            const chunks = getTextChunks({ content: item.content, blocks_per_chunk: blocksPerChunk });
            const chunkRows = chunks.map((_, idx) => ({ text_id: textRow.id, chunk_index: idx }));
            if (chunkRows.length > 0) await state.db.from('text_line_progress').insert(chunkRows);
          }
        }
      } else {
        const rows = selectedItems.map(item => ({ deck: deckName, front: item.front, back: item.back, deck_id: deckId }));
        await state.db.from('flashcards').insert(rows);
      }
      overlay.remove();
      await refreshFlashcards();
      showToast(t('flashcards.import_success', selectedItems.length, type === 'text' ? (selectedItems.length !== 1 ? t('flashcards.import_text_plural') : t('flashcards.import_text_singular')) : (selectedItems.length !== 1 ? t('flashcards.import_card_plural') : t('flashcards.import_card_singular'))));
    } catch (e) {
      reviewError.textContent = t('flashcards.import_failed') + e.message;
      reviewError.style.display = '';
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `${lucideIcon('check', 15)} ${t('flashcards.import_btn')}`;
    }
  });

  // Dismiss by clicking overlay
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
};

function getFlashcardCounts() {
  return { cards: allCards.length, drafts: allDrafts.length, texts: allTexts.length };
}

/** Return in-memory arrays (no DB fetch). */
function getFlashcards() { return allCards; }
function getTexts() { return allTexts; }
function getTextProgress() { return allChunkProgress; }

export { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts, getFlashcards, getTexts, getTextProgress, loadFlashcardDecks, getFlashcardDecks, getDeckColor };
window.renderFlashcards = renderFlashcards;
window.setFlashcardFilter = setFlashcardFilter;
window.refreshFlashcards = refreshFlashcards;


// Resolve a draft's proposed deck to a bucket id. Proposed values are
// section paths ('Geography > World Capitals') since sections landed;
// legacy plain names fall back to the first-wins name map.
function resolveDraftDeckId(proposed) {
  if (!proposed) return null;
  const node = resolveSectionPath(getDeckTree().roots, parseSectionPath(proposed));
  if (node) return node.id;
  return _deckByName.get(proposed)?.id || null;
}

// Proposal deck pickers: bucket-only options whose values are section
// paths, so two same-name decks in different sections stay distinct.
// A legacy value not matching any current path is kept as an option so
// the select never drops the draft's current choice.
function proposalDeckOptions(current) {
  const tree = getDeckTree();
  const paths = flattenTree(tree.roots)
    .filter(n => n.kind === 'bucket' && n.id !== _sharedDeckId)
    .map(n => pathLabelOf(n, tree.byId));
  const values = [...new Set([...paths, current || ''])];
  return values.map(v =>
    `<option value="${esc(v)}"${v === (current || '') ? ' selected' : ''}>${esc(v || t('common.category_default'))}</option>`
  ).join('');
}

async function deleteDeck(deckId) {
  const deckRow = _deckMap.get(deckId);
  const deckName = deckRow ? (deckRow.name || t('common.category_default')) : deckId;
  const cards = allCards.filter(c => deckIdForCard(c) === deckId);
  const texts = allTexts.filter(tx => deckIdForText(tx) === deckId);
  const drafts = deckRow ? allDrafts.filter(d => resolveDraftDeckId(d.proposed_deck) === deckId) : [];
  const total = cards.length + texts.length;
  const msg = total > 0
    ? `Delete "${deckName}" and its ${total} item(s)? This cannot be undone.`
    : `Delete empty deck "${deckName}"?`;

  showConfirmAction(t('common.delete'), msg, async () => {
    // Delete drafts targeting this deck. Proposed values are paths,
    // not just names, so drafts are deleted by id, not by name match.
    for (const d of drafts) await state.db.from('flashcard_notes').delete().eq('id', d.id);
    // CASCADE on FK — deleting the deck removes all its flashcards + texts
    if (deckRow) {
      await state.db.from('flashcard_decks').delete().eq('id', deckRow.id);
    } else {
      // Fallback for items without a deck row (backward compat)
      for (const c of cards) await state.db.from('flashcards').delete().eq('id', c.id);
      for (const tx of texts) {
        await state.db.from('text_line_progress').delete().eq('text_id', tx.id);
        await state.db.from('texts').delete().eq('id', tx.id);
      }
    }
    showToast(t('toast.deleted'), 'info');
    await refreshFlashcards();
  });
}
window.deleteDeck = deleteDeck;

// ── Delete Section ──
// Mirrors deleteListSection: empty sections delete directly, non-empty
// ones ask whether to move the children up one level or delete the
// whole subtree (decks, their cards/texts, and targeting drafts).
let _pendingFlashSectionDelete = null;

function deleteFlashSection(sectionId) {
  const node = getDeckTree().byId.get(sectionId);
  const row = _deckMap.get(sectionId);
  if (!node || !row || !isSectionRow(row)) return;
  if (!node.children.length) {
    showConfirmAction(t('common.delete'), t('common.section_delete_empty', row.name), async () => {
      await state.db.from('flashcard_decks').delete().eq('id', sectionId);
      showToast(t('toast.deleted'), 'info');
      await refreshFlashcards();
    });
    return;
  }
  _pendingFlashSectionDelete = sectionId;
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="deleteFlashSectionModal" style="display:flex;" data-action="close-delete-flash-section-modal" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('folder', 20)} ${t('common.section_delete_title')}</h2>
      <p>${t('common.section_delete_msg')} <strong>${esc(row.name || '')}</strong></p>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-delete-flash-section-modal">${t('common.cancel')}</button>
        <button class="btn" data-action="delete-flash-section-move-up">${t('common.section_delete_move_up')}</button>
        <button class="modal-save" data-action="delete-flash-section-subtree">${t('common.section_delete_subtree')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}
window.deleteFlashSection = deleteFlashSection;

window.closeDeleteFlashSectionModal = function() {
  _pendingFlashSectionDelete = null;
  const m = document.getElementById('deleteFlashSectionModal'); if (m) m.remove();
};

window.deleteFlashSectionMoveUp = async function() {
  const sectionId = _pendingFlashSectionDelete;
  if (!sectionId) return;
  window.closeDeleteFlashSectionModal();
  const node = getDeckTree().byId.get(sectionId);
  if (!node) return;
  const parentId = node.parentId || null;
  const parentChildren = [...getDeckTree().byId.values()]
    .filter(n => (n.parentId || null) === parentId)
    .sort((a, b) => (Number(a.row.sort_order) || 0) - (Number(b.row.sort_order) || 0));
  const moving = [...node.children];
  const movingIds = new Set(moving.map(n => n.id));
  const rest = parentChildren.filter(n => n.id !== sectionId);
  const at = Math.max(0, parentChildren.findIndex(n => n.id === sectionId));
  const finalOrder = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  for (let i = 0; i < finalOrder.length; i++) {
    const n = finalOrder[i];
    const updates = { sort_order: i };
    if (movingIds.has(n.id)) updates.parent_id = parentId;
    if (Number(n.row.sort_order) !== i || updates.parent_id !== undefined) {
      await state.db.from('flashcard_decks').update(updates).eq('id', n.id);
    }
  }
  await state.db.from('flashcard_decks').delete().eq('id', sectionId);
  showToast(t('toast.deleted'), 'info');
  await refreshFlashcards();
};

window.deleteFlashSectionSubtree = async function() {
  const sectionId = _pendingFlashSectionDelete;
  if (!sectionId) return;
  window.closeDeleteFlashSectionModal();
  const node = getDeckTree().byId.get(sectionId);
  if (!node) return;
  const subtree = [node, ...descendantsOf(node)];
  const bucketIds = subtree.filter(n => n.kind === 'bucket').map(n => n.id);
  // Explicit item deletes: deck-row deletion cascades on Local SQLite
  // only, so subtree removal deletes items itself to stay correct on
  // every backend.
  for (const bid of bucketIds) {
    for (const c of allCards.filter(x => deckIdForCard(x) === bid)) await state.db.from('flashcards').delete().eq('id', c.id);
    for (const tx of allTexts.filter(x => deckIdForText(x) === bid)) {
      await state.db.from('text_line_progress').delete().eq('text_id', tx.id);
      await state.db.from('texts').delete().eq('id', tx.id);
    }
    for (const d of allDrafts.filter(x => resolveDraftDeckId(x.proposed_deck) === bid)) {
      await state.db.from('flashcard_notes').delete().eq('id', d.id);
    }
  }
  for (const n of subtree.filter(n => n.kind === 'section').reverse()) {
    await state.db.from('flashcard_decks').delete().eq('id', n.id);
  }
  for (const bid of bucketIds) {
    await state.db.from('flashcard_decks').delete().eq('id', bid);
  }
  showToast(t('toast.deleted'), 'info');
  await refreshFlashcards();
};

// ── Edit Deck Modal ──
function openEditDeckModal(deckId) {
  const deckRow = _deckMap.get(deckId);
  if (!deckRow) return;
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="editDeckModal" style="display:flex;" data-action="close-edit-deck" data-overlay-close="true">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#f59e0b')} ${t('flashcards.edit_deck')}</h2>
      <input type="hidden" id="editDeckId" value="${esc(deckRow.id)}">
      <label>${t('flashcards.deck_name')}</label>
      <input type="text" id="editDeckName" value="${esc(deckRow.name)}"${deckRow.is_protected ? ' disabled' : ''}>
      <div class="modal-row">
        <div class="modal-field">
          <label>${t('common.shortname')}</label>
          <input type="text" id="editDeckShortname" value="${esc(deckRow.shortname || '')}" placeholder="${t('flashcards.shortname_placeholder')}">
        </div>
        <div class="modal-field">
          <label>${t('common.color')}</label>
          <input type="color" id="editDeckColor" value="${esc(deckRow.color || FLASH_DEFAULT_COLOR)}">
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" data-action="close-edit-deck">${t('common.cancel')}</button>
        <button class="modal-save" data-action="save-edit-deck">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById(deckRow.is_protected ? 'editDeckShortname' : 'editDeckName').focus();
}

window.openEditDeckModal = openEditDeckModal;

window.closeEditDeckModal = function() {
  const m = document.getElementById('editDeckModal'); if (m) m.remove();
};

// Restore a deck row to its pre-edit values after a failed item update
// during rename: the rename is one logical operation, so a half-synced
// name cache must not outlive a rolled-back rename. deckRow is still
// pre-edit here (Object.assign runs only after every write succeeds).
// Returns the rollback's own error (null on success) so the caller can
// report a failed rollback instead of the item error it was covering.
async function rollbackDeckRow(deckId, deckRow) {
  const { error } = await state.db.from('flashcard_decks').update({
    name: deckRow.name, shortname: deckRow.shortname, color: deckRow.color,
    parent_id: deckRow.parent_id ?? null, sort_order: deckRow.sort_order,
  }).eq('id', deckId);
  return error;
}

window.saveEditDeck = async function() {
  const deckId = document.getElementById('editDeckId').value;
  const deckRow = _deckMap.get(deckId);
  if (!deckRow) return;
  const rawName = document.getElementById('editDeckName').value.trim();
  const shortname = document.getElementById('editDeckShortname').value.trim();
  const color = document.getElementById('editDeckColor').value;
  if (!rawName && !deckRow.is_protected) { showToast(t('toast.name_required'), 'error'); return; }
  // A typed path ('A > B') nests the deck under the section chain, like
  // creation and like Lists/TODOs/Habits renames — the last segment is
  // the deck's own name. A plain name keeps the current parent.
  let targetName = rawName;
  let targetParentId = deckRow.parent_id ?? null;
  if (!deckRow.is_protected && rawName.includes('>')) {
    const segments = parseSectionPath(rawName);
    if (!segments.length) { showToast(t('toast.name_required'), 'error'); return; }
    targetName = segments[segments.length - 1];
    try {
      targetParentId = await ensureFlashSectionChain(segments.slice(0, -1), null, deckId);
    } catch (e) {
      // A cycle is a validation error (same toast as before); anything
      // else is a failed conversion write and must say so.
      if (e?.message === 'section-cycle') showToast(t('toast.name_required'), 'error');
      else showToast(t('toast.update_failed') + ': ' + (e?.message || e), 'error');
      return;
    }
  }
  if (deckRow.is_protected) targetParentId = null;
  // Rename keeps sibling-scoped uniqueness (creation already enforces
  // it); previously a rename could silently duplicate any deck name.
  if (!deckRow.is_protected && (targetName !== deckRow.name || targetParentId !== (deckRow.parent_id ?? null))
    && siblingNameTaken([..._deckMap.values()], targetParentId, targetName, deckId)) {
    showToast(t('flashcards.deck_exists_at_level', targetName), 'error');
    return;
  }

  const updates = { shortname: shortname || null, color, parent_id: targetParentId };
  if (!deckRow.is_protected) updates.name = targetName;
  if (targetParentId !== (deckRow.parent_id ?? null)) updates.sort_order = nextFlashSortOrder(targetParentId);
  // Checked writes: the rename is one logical operation. A failed deck
  // update reports failure (modal stays open, nothing mutates), and a
  // failed item update rolls the deck row back to its pre-edit values —
  // no success toast and no local mutation until every write succeeds.
  const { error: deckError } = await state.db.from('flashcard_decks').update(updates).eq('id', deckId);
  if (deckError) { showToast(t('toast.update_failed') + ': ' + deckError.message, 'error'); return; }

  // Update items' deck name string if name changed (grouping is by deck_id;
  // this just keeps the display cache accurate for every card in the deck)
  if (!deckRow.is_protected && targetName !== deckRow.name) {
    const { error: cardsError } = await state.db.from('flashcards').update({ deck: targetName }).eq('deck_id', deckId);
    if (cardsError) {
      const rbError = await rollbackDeckRow(deckId, deckRow);
      showToast(t('toast.update_failed') + ': ' + (rbError?.message || cardsError.message), 'error');
      return;
    }
    const { error: textsError } = await state.db.from('texts').update({ deck: targetName }).eq('deck_id', deckId);
    if (textsError) {
      const rbError = await rollbackDeckRow(deckId, deckRow);
      showToast(t('toast.update_failed') + ': ' + (rbError?.message || textsError.message), 'error');
      return;
    }
  }

  Object.assign(deckRow, updates);
  if (updates.name) deckRow.name = updates.name;
  // First wins, like loadFlashcardDecks — see its comment.
  _deckByName.clear();
  for (const row of _deckMap.values()) if (!_deckByName.has(row.name)) _deckByName.set(row.name, row);

  closeEditDeckModal();
  await refreshFlashcards();
  showToast(t('toast.updated'), 'success');
};
