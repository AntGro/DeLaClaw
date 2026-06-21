import { lucideIcon } from './icons.js';
import { t, getLang } from './i18n.js';
import state from './supabase.js';
import { esc, escQ, showToast, showDeleteConfirm, balanceGrid } from './utils.js';
import { scrollToAndHighlight, inlineEditText, initItemHoverDelay } from './item-utils.js';
import { generateStorm, LOGO_DEFAULTS } from './logo.js';

// ===================================================================
// FLASHCARDS — Spaced Repetition (Algo-style intervals)
// ===================================================================

// ── SM-2 / Algo-style Spaced Repetition Core ──
// Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy
// Stability ≈ target interval in days. Next review = stability days from now.

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

// Lapse (Again on review): reduce interval significantly
function stabilityAfterLapse(S, D, R) {
  return Math.max(0.5, S * 0.3);
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
  let S, D;
  if (isNew) { D = initDifficulty(rating); S = initStability(rating); }
  else {
    const R = retrievability(card.stability, card.last_review, now.toISOString());
    S = rating === 1 ? stabilityAfterLapse(card.stability, card.difficulty, R)
      : stabilityAfterSuccess(card.stability, card.difficulty, R, rating);
    D = updateDifficulty(card.difficulty, rating);
  }
  const interval = fuzz(nextInterval(S));
  return {
    stability: Math.round(S * 100) / 100,
    difficulty: Math.round(D * 100) / 100,
    last_review: now.toISOString(),
    next_review: new Date(now.getTime() + interval * 86400000).toISOString(),
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
let sessionDone = 0;
let sessionCorrect = 0;
let sessionTotal = 0;
let sessionDeck = null;
let trSessionActive = false;
let trSessionDeck = null;
let trSessionTextId = null;

const DECK_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#f97316',
  '#6366f1', '#14b8a6',
];

// ── Shortnames (synced via settings table, localStorage fallback) ──
const FLASH_SHORTNAMES_KEY = 'claw_flash_shortnames';
const FLASH_SHORTNAMES_DB_KEY = 'flash_shortnames';
let _shortnames = {};

function getFlashShortnames() { return _shortnames; }

function getFlashShortname(deckName) {
  if (!deckName) return '';
  return _shortnames[deckName] || '';
}

async function loadFlashShortnames() {
  // Try DB first
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings').select('value').eq('key', FLASH_SHORTNAMES_DB_KEY);
      if (data && data.length > 0 && data[0].value) {
        _shortnames = JSON.parse(data[0].value);
        localStorage.setItem(FLASH_SHORTNAMES_KEY, data[0].value);
        return;
      }
    } catch (e) { console.warn('Could not load shortnames from DB:', e.message); }
  }
  // Fallback to localStorage
  try { _shortnames = JSON.parse(localStorage.getItem(FLASH_SHORTNAMES_KEY) || '{}'); } catch { _shortnames = {}; }
}

async function saveFlashShortnames(map) {
  _shortnames = map;
  const json = JSON.stringify(map);
  localStorage.setItem(FLASH_SHORTNAMES_KEY, json);
  if (state.db.connected) {
    try {
      const { data } = await state.db.from('settings')
        .update({ value: json, updated_at: new Date().toISOString() })
        .eq('key', FLASH_SHORTNAMES_DB_KEY)
        .select();
      if (!data || data.length === 0) {
        await state.db.from('settings')
          .insert({ key: FLASH_SHORTNAMES_DB_KEY, value: json, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('Could not save shortnames to DB:', e.message); }
  }
}

async function setFlashShortname(deckName, shortname) {
  const map = { ..._shortnames };
  if (shortname) { map[deckName] = shortname; } else { delete map[deckName]; }
  await saveFlashShortnames(map);
}

async function promptFlashShortname(deckName) {
  const current = getFlashShortname(deckName) || '';
  const result = prompt('Short name for "' + deckName + '" (leave empty to remove):', current);
  if (result === null) return;
  await setFlashShortname(deckName, result.trim());
  refreshFlashcards();
}
const DRAFT_COLOR = '#6b7280';

function getDeckColor(deck) {
  const cardDecks = allCards.map(c => c.deck);
  const textDecks = allTexts.map(tx => tx.deck);
  const decks = [...new Set([...cardDecks, ...textDecks])].sort();
  const idx = decks.indexOf(deck);
  return DECK_COLORS[(idx >= 0 ? idx : 0) % DECK_COLORS.length];
}

// ── Data Loading ──
async function refreshFlashcards() {
  if (!state.db.connected) return;
  await loadFlashShortnames();
  const { data } = await state.db.from('flashcards').select('*').order('created_at');
  allCards = data || [];
  const { data: drafts } = await state.db.from('flashcard_notes').select('*').order('created_at', { ascending: false });
  allDrafts = drafts || [];
  try {
    const { data: texts } = await state.db.from('texts').select('*').order('created_at');
    allTexts = texts || [];
    const { data: chunks } = await state.db.from('text_line_progress').select('*').order('chunk_index');
    allChunkProgress = chunks || [];
  } catch (e) { allTexts = []; allChunkProgress = []; }
  // Auto-repair: generate missing chunk progress rows for texts with content
  for (const tx of allTexts) {
    if (!tx.content) continue;
    const hasChunks = allChunkProgress.some(ch => ch.text_id === tx.id);
    if (!hasChunks) {
      const generated = splitTextIntoChunks(tx.content, tx.lines_per_chunk || 4);
      const rows = generated.map((_, idx) => ({ text_id: tx.id, chunk_index: idx }));
      if (rows.length > 0 && state.db.connected) {
        try {
          const { data: inserted } = await state.db.from('text_line_progress').insert(rows).select('*');
          if (inserted) allChunkProgress.push(...inserted);
        } catch (_) { /* silent — will retry next load */ }
      }
    }
  }
  // Prune orphan shortnames (deck was renamed or deleted)
  const liveDecks = new Set([...allCards.map(c => c.deck), ...allTexts.map(t => t.deck)]);
  const orphans = Object.keys(_shortnames).filter(k => !liveDecks.has(k));
  if (orphans.length) {
    for (const k of orphans) delete _shortnames[k];
    await saveFlashShortnames(_shortnames);
  }
  if (state.currentView === 'flashcards') renderFlashcards();
}

// ── Deck Nav Buttons ──
// ── Deck Type helpers ──
// A deck is either 'flashcard' or 'text', inferred from which table has data for it.
function getDeckType(deck) {
  const hasCards = allCards.some(c => c.deck === deck);
  const hasTexts = allTexts.some(tx => tx.deck === deck);
  // If somehow both (shouldn't happen), prefer flashcard
  if (hasCards) return 'flashcard';
  if (hasTexts) return 'text';
  return 'flashcard'; // default
}

function renderDeckNavButtons() {
  const container = document.getElementById('flashcardNavButtons');
  if (!container) return;
  const cardDecks = allCards.map(c => c.deck);
  const textDecks = allTexts.map(t => t.deck);
  const decks = [...new Set([...cardDecks, ...textDecks])].sort();

  // Draft nav button first
  let html = `<button class="category-nav-btn" style="--cat-color:${DRAFT_COLOR}" onclick="navigateToFlashDeck('__drafts')">${lucideIcon('file-edit', 14, DRAFT_COLOR)} ${t('flashcards.draft')} (${allDrafts.length})</button>`;

  html += decks.map(deck => {
    const color = getDeckColor(deck);
    const sn = getFlashShortname(deck);
    const display = sn || deck;
    const type = getDeckType(deck);
    const icon = type === 'text' ? lucideIcon('book-open', 12, color) : lucideIcon('layers', 12, color);
    const count = type === 'text'
      ? allTexts.filter(tx => tx.deck === deck).length
      : allCards.filter(c => c.deck === deck).length;
    return `<button class="category-nav-btn" style="--cat-color:${color}" onclick="navigateToFlashDeck('${escQ(deck)}')" title="${esc(deck)}">${icon} ${esc(display)} (${count})</button>`;
  }).join('');

  container.innerHTML = html;
}

window.navigateToFlashDeck = function(deck) {
  const el = document.getElementById(deck === '__drafts' ? 'flashDraftsDeck' : `flashDeck-${CSS.escape(deck)}`);
  scrollToAndHighlight(el, null);
};

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
  renderAllBuckets();
}

function renderAllBuckets() {
  const grid = document.getElementById('flashcardGrid');
  if (!grid) return;
  grid.className = 'project-grid';

  const cardDecks = allCards.map(c => c.deck);
  const textDecks = allTexts.map(tx => tx.deck);
  const decks = [...new Set([...cardDecks, ...textDecks])].sort();
  const q = searchQuery.toLowerCase().trim();

  // Draft bucket first
  let html = renderDraftsBucket(q);

  // Then deck buckets
  html += decks.map(deck => renderDeckBucket(deck, q)).join('');

  if (!html.trim()) {
    html = `<div class="fc-empty-state">
      <div class="fc-empty-icon">${lucideIcon('brain', 40, '#8b5cf6')}</div>
      <h3>${t('flashcards.no_flashcards')}</h3>
      <p>${t('flashcards.no_flashcards_hint')}</p>
    </div>`;
  }

  grid.innerHTML = html;
  initFlashcardHoverDelay(grid);
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
  balanceGrid(grid);
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

// ── Draft Bucket ──
function renderDraftsBucket(q) {
  let drafts = allDrafts;
  if (q) drafts = drafts.filter(d => d.content.toLowerCase().includes(q));

  const pendingCount = drafts.filter(d => d.proposal_status === 'pending').length;
  const readyCount = drafts.filter(d => d.proposal_status === 'ready').length;

  const chips = [];
  if (pendingCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${pendingCount} ${t('flashcards.generating')}</span>`);
  if (readyCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${readyCount} ready</span>`);

  return `<div class="project-card" id="flashDraftsDeck" style="--cat-color:${DRAFT_COLOR}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('file-edit', 16)} ${t('flashcards.draft')}</strong>
          <span class="tech">${drafts.length} items ${chips.join(' ')}</span>
        </div>
      </div>
    </div>
    <div class="add-task">
      <textarea placeholder="${t('flashcards.draft_placeholder')}" id="draftQuickInput" onkeydown="handleDraftInput(event)" rows="1" style="resize:none;overflow:hidden;"></textarea>
      <button onclick="quickAddDraft()">${lucideIcon('plus', 16)}</button>
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
    const suggestedDeck = d.proposed_deck || 'General';
    const deckOptions = [...new Set([...allCards.map(c => c.deck), suggestedDeck])].sort().map(dk =>
      `<option value="${esc(dk)}"${dk === suggestedDeck ? ' selected' : ''}>${esc(dk)}</option>`
    ).join('');
    proposalHtml = `<div class="fc-proposal">
      <div class="fc-proposal-label">${lucideIcon('sparkles', 14, '#22c55e')} Proposed card:</div>
      <div class="fc-proposal-qa"><strong>Q:</strong> ${esc(d.proposed_front)}</div>
      <div class="fc-proposal-qa"><strong>A:</strong> ${esc(d.proposed_back)}</div>
      <div class="fc-proposal-deck"><strong>${t('flashcards.deck')}:</strong> <select onchange="updateProposedDeck('${d.id}', this.value)">${deckOptions}</select></div>
      <div class="fc-proposal-actions">
        <button class="fc-proposal-accept" onclick="acceptProposal('${d.id}')" title="${t('flashcards.accept')}">${lucideIcon('check', 14, '#fff')} <span class="btn-label">${t('flashcards.accept')}</span></button>
        <button class="fc-proposal-edit" onclick="editProposal('${d.id}')" title="${t('common.edit')}">${lucideIcon('pencil', 14)} <span class="btn-label">${t('common.edit')}</span></button>
        <button class="fc-proposal-feedback-btn" onclick="toggleFeedbackInput('${d.id}')" title="${t('flashcards.feedback')}">${lucideIcon('message-square', 14)} <span class="btn-label">${t('flashcards.feedback')}</span></button>
        <button class="fc-proposal-reject" onclick="rejectProposal('${d.id}')" title="${t('flashcards.reject')}">${lucideIcon('x', 14)} <span class="btn-label">${t('flashcards.reject')}</span></button>
      </div>
      <div class="fc-feedback-area" id="feedbackArea-${d.id}" style="display:none;">
        <textarea class="fc-feedback-input" id="feedbackInput-${d.id}" placeholder="${t('flashcards.feedback_placeholder')}" rows="2"></textarea>
        <button class="fc-feedback-submit" onclick="submitFeedback('${d.id}')">${lucideIcon('send', 14, '#fff')} ${t('flashcards.feedback')}</button>
      </div>
    </div>`;
  }
  const draftCls = hasProposal ? ' draft-ready' : isPending ? ' draft-pending' : ' draft-empty';

  return `<div class="bucket-item todo-item${draftCls}" data-draft-id="${d.id}">
    <div class="todo-row">
      <span class="todo-text" style="cursor:text;">${esc(d.content.length > 120 ? d.content.slice(0, 120) + '…' : d.content)}</span>
      ${isPending ? `<span class="fc-status-badge fc-status-pending">${t('flashcards.generating')}</span>` : ''}
      <div class="todo-actions">
        ${!hasProposal && !isPending ? `<button onclick="requestProposal('${d.id}')" title="${t('flashcards.propose')}">${lucideIcon('sparkles', 16)}</button>` : ''}
        <button onclick="startInlineEditDraftById('${d.id}')" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button onclick="deleteDraft('${d.id}')" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
    ${proposalHtml}
  </div>`;
}

// ── Deck Bucket ──
function renderDeckBucket(deck, q) {
  const type = getDeckType(deck);
  return type === 'text' ? renderTextDeck(deck, q) : renderFlashcardDeck(deck, q);
}

function renderFlashcardDeck(deck, q) {
  let cards = allCards.filter(c => c.deck === deck);
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
  if (cards.length === 0 && !q) return '';

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

  const color = getDeckColor(deck);
  const allDeckCards = allCards.filter(c => c.deck === deck);
  const newCount = allDeckCards.filter(c => !c.last_review).length;
  const dueCount = allDeckCards.filter(c => c.last_review && (!c.next_review || new Date(c.next_review) <= now)).length;

  const chips = [];
  if (newCount > 0) chips.push(`<span class="fc-chip fc-chip-new">${newCount} ${t('flashcards.new_count')}</span>`);
  if (dueCount > 0) chips.push(`<span class="fc-chip fc-chip-due">${dueCount} ${t('flashcards.due_count')}</span>`);

  const practiceCount = dueCount + newCount;
  let practiceButton = '';
  if (practiceCount > 0) {
    practiceButton = `<button class="fc-practice-btn" onclick="startPractice('${escQ(deck)}')" title="${t('flashcards.practice')}">${lucideIcon('play', 14, '#fff')} ${practiceCount}</button>`;
  } else {
    practiceButton = `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')} Caught up</span>`;
  }

  return `<div class="project-card" id="flashDeck-${esc(deck)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('layers', 14)} ${esc(deck)}${getFlashShortname(deck) ? '<span class="todo-cat-shortname-label">' + esc(getFlashShortname(deck)) + '</span>' : ''}</strong>
          <span class="tech">${allDeckCards.length} ${t('flashcards.cards')} ${chips.join(' ')}</span>
        </div>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button class="todo-cat-shortname-btn" onclick="promptFlashShortname('${escQ(deck)}')" title="${getFlashShortname(deck) ? 'Edit short name' : 'Set short name'}">${lucideIcon("pencil",14)}</button>
        ${practiceButton}
        <button class="archive-project-btn" onclick="openAddFlashcardModal('${escQ(deck)}')" title="${t('flashcards.add_card')}">${lucideIcon('plus', 16)}</button>
        <button class="todo-cat-delete-btn" onclick="deleteDeck('${escQ(deck)}')" title="${t('common.delete')}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
    <div class="task-list">
      ${cards.map(c => renderFlashcardItem(c, color)).join('')}
    </div>
  </div>`;
}

function renderTextDeck(deck, q) {
  let texts = allTexts.filter(tx => tx.deck === deck);
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
  if (texts.length === 0 && !q) return '';

  const color = getDeckColor(deck);
  const allDeckTexts = allTexts.filter(tx => tx.deck === deck);

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
    practiceButton = `<button class="fc-practice-btn tr-practice-btn" onclick="startTextPractice('${escQ(deck)}')" title="${t('text_revision.practice')}">${lucideIcon('book-open', 14, '#fff')} ${trPracticeCount}</button>`;
  } else {
    practiceButton = `<span class="fc-all-done">${lucideIcon('circle-check', 14, '#22c55e')} Caught up</span>`;
  }

  return `<div class="project-card" id="flashDeck-${esc(deck)}" style="--cat-color:${color}">
    <div class="project-card-header">
      <div style="display:flex;align-items:flex-start;gap:6px;">
        <div class="project-info">
          <strong>${lucideIcon('book-open', 14)} ${esc(deck)}${getFlashShortname(deck) ? '<span class="todo-cat-shortname-label">' + esc(getFlashShortname(deck)) + '</span>' : ''}</strong>
          <span class="tech">${allDeckTexts.length} ${t('text_revision.texts')} ${chips.join(' ')}</span>
        </div>
      </div>
      <div class="project-header-actions" style="opacity:1;">
        <button class="todo-cat-shortname-btn" onclick="promptFlashShortname('${escQ(deck)}')" title="${getFlashShortname(deck) ? 'Edit short name' : 'Set short name'}">${lucideIcon("pencil",14)}</button>
        ${practiceButton}
        <button class="archive-project-btn" onclick="openAddTextModal('${escQ(deck)}')" title="${t('text_revision.add_text')}">${lucideIcon('plus', 16)}</button>
        <button class="todo-cat-delete-btn" onclick="deleteDeck('${escQ(deck)}')" title="${t('common.delete')}">${lucideIcon('trash-2', 14)}</button>
      </div>
    </div>
    <div class="task-list">
      ${texts.map(tx => renderTextItem(tx, color)).join('')}
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
        <button onclick="openEditFlashcardModal('${c.id}')" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button onclick="deleteFlashcard('${c.id}')" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
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
  const html = `<div class="modal-overlay" id="addDraftModal" style="display:flex;" onclick="if(event.target===this)closeAddDraftModal()">
    <div class="modal">
      <h2>${lucideIcon('file-edit', 18, DRAFT_COLOR)} ${t('flashcards.add_draft')}</h2>
      <label>${t('flashcards.what_to_learn')}</label>
      <textarea id="newDraftContent" rows="4" placeholder="${t('flashcards.learn_placeholder')}"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddDraftModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveNewDraft()">${t('common.save')}</button>
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
};

window.quickAddDraft = async function() {
  const input = document.getElementById('draftQuickInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  if (state.db.connected) await state.db.from('flashcard_notes').insert({ content });
  input.value = '';
  await refreshFlashcards();
  showToast(t('flashcards.draft_added'));
};

// ── Inline Draft Editing (uses shared inlineEditText) ──
window.startInlineEditDraft = function(id, spanEl) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  inlineEditText(spanEl, draft.content, {
    saveFn: async (content) => {
      if (state.db.connected) {
        await state.db.from('flashcard_notes').update({ content }).eq('id', id);
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
    collectExtra: () => ({ back: answerInput.value.trim() }),
    saveFn: async (newFront, extra) => {
      const updates = {};
      if (newFront !== card.front) updates.front = newFront;
      if (extra && extra.back && extra.back !== card.back) updates.back = extra.back;
      if (Object.keys(updates).length > 0 && state.db.connected) {
        await state.db.from('flashcards').update(updates).eq('id', id);
        showToast(t('flashcards.card_updated'));
      }
    },
    refreshFn: refreshFlashcards,
  });
};

window.deleteDraft = function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft) return;
  showDeleteConfirm('Delete Draft', 'Are you sure?', async () => {
    if (state.db.connected) await state.db.from('flashcard_notes').delete().eq('id', id);
    await refreshFlashcards();
    showToast(t('flashcards.draft_deleted'));
  });
};

// ── Proposal Workflow ──
window.requestProposal = async function(id) {
  if (!state.db.connected) return;
  await state.db.from('flashcard_notes').update({ proposal_status: 'pending' }).eq('id', id);
  const draft = allDrafts.find(d => d.id === id);
  if (draft) draft.proposal_status = 'pending';
  renderAllBuckets();
  showToast(t('flashcards.generating_proposal'));
};

window.acceptProposal = async function(id) {
  const draft = allDrafts.find(d => d.id === id);
  if (!draft || !draft.proposed_front || !draft.proposed_back) return;
  const deck = draft.proposed_deck || 'General';
  if (state.db.connected) {
    await state.db.from('flashcards').insert({ deck, front: draft.proposed_front, back: draft.proposed_back });
    await state.db.from('flashcard_notes').delete().eq('id', id);
  }
  await refreshFlashcards();
  showToast(t('flashcards.card_added_to', deck));
};

window.rejectProposal = async function(id) {
  if (!state.db.connected) return;
  await state.db.from('flashcard_notes').update({
    proposal_status: null, proposed_front: null, proposed_back: null
  }).eq('id', id);
  const draft = allDrafts.find(d => d.id === id);
  if (draft) { draft.proposal_status = null; draft.proposed_front = null; draft.proposed_back = null; }
  renderAllBuckets();
  showToast(t('flashcards.proposal_rejected'));
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
  const currentDeck = draft.proposed_deck || 'General';
  const deckOptions = [...new Set([...allCards.map(c => c.deck), currentDeck])].sort().map(dk =>
    `<option value="${esc(dk)}"${dk === currentDeck ? ' selected' : ''}>${esc(dk)}</option>`
  ).join('');
  const html = `<div class="modal-overlay" id="editProposalModal" style="display:flex;" onclick="if(event.target===this)closeEditProposalModal()">
    <div class="modal">
      <h2>${lucideIcon('pencil', 18, '#8b5cf6')} ${t('flashcards.edit_proposal')}</h2>
      <label>${t('flashcards.question')}</label>
      <textarea id="editProposalFront" rows="3">${esc(draft.proposed_front || '')}</textarea>
      <label>${t('flashcards.answer')}</label>
      <textarea id="editProposalBack" rows="4">${esc(draft.proposed_back || '')}</textarea>
      <label>${t('flashcards.deck')}</label>
      <select id="editProposalDeck">${deckOptions}</select>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeEditProposalModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveEditedProposal('${draft.id}')">${t('common.save')}</button>
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
  const html = `<div class="modal-overlay" id="addFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashcardModal()">
    <div class="modal">
      <h2>${lucideIcon('plus', 18, '#8b5cf6')} ${t('flashcards.add_card')}</h2>
      <input type="hidden" id="newFlashDeck" value="${esc(deck || 'General')}">
      <label>${t('flashcards.question')}</label>
      <textarea id="newFlashFront" rows="3" placeholder="${t('flashcards.question_placeholder')}"></textarea>
      <label>${t('flashcards.answer')}</label>
      <textarea id="newFlashBack" rows="3" placeholder="${t('flashcards.answer_placeholder')}"></textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddFlashcardModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveNewFlashcard()">${t('common.save')}</button>
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
  const deck = document.getElementById('newFlashDeck').value.trim();
  const front = document.getElementById('newFlashFront').value.trim();
  const back = document.getElementById('newFlashBack').value.trim();
  if (!front || !back) { showToast(t('toast.both_fields_required')); return; }
  if (state.db.connected) await state.db.from('flashcards').insert({ deck, front, back });
  closeAddFlashcardModal();
  await refreshFlashcards();
  showToast(t('flashcards.card_added'));
};

window.openEditFlashcardModal = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  closeAllFlashModals();
  const decks = [...new Set(allCards.map(c => c.deck))].sort();
  const deckOptions = decks.map(d => `<option value="${esc(d)}" ${d === card.deck ? 'selected' : ''}>${esc(d)}</option>`).join('');
  const html = `<div class="modal-overlay" id="editFlashcardModal" style="display:flex;" onclick="if(event.target===this)closeEditFlashcardModal()">
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
        <button class="modal-cancel" onclick="closeEditFlashcardModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveEditFlashcard()">${t('common.save')}</button>
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
  const deck = document.getElementById('editFlashDeck').value.trim();
  const front = document.getElementById('editFlashFront').value.trim();
  const back = document.getElementById('editFlashBack').value.trim();
  if (!front || !back) { showToast(t('toast.both_fields_required')); return; }
  if (state.db.connected) await state.db.from('flashcards').update({ deck, front, back }).eq('id', id);
  closeEditFlashcardModal();
  await refreshFlashcards();
  showToast(t('flashcards.card_updated'));
};

window.deleteFlashcard = function(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  showDeleteConfirm('Delete Flashcard', 'Are you sure?', async () => {
    if (state.db.connected) await state.db.from('flashcards').delete().eq('id', id);
    await refreshFlashcards();
    showToast(t('flashcards.card_deleted'));
  });
};

// ── New Deck ──
window.openAddFlashDeckModal = function() {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addFlashDeckModal" style="display:flex;" onclick="if(event.target===this)closeAddFlashDeckModal()">
    <div class="modal">
      <h2>${lucideIcon('brain', 18, '#06b6d4')} ${t('flashcards.new_deck')}</h2>
      <label>${t('flashcards.deck_name')}</label>
      <input type="text" id="newDeckName" placeholder="${t('flashcards.deck_placeholder')}">
      <label>${t('flashcards.deck_type')}</label>
      <div class="deck-type-selector">
        <button class="deck-type-btn active" id="deckTypeFlashcard" onclick="selectDeckType('flashcard')">${lucideIcon('layers', 14)} ${t('flashcards.type_flashcard')}</button>
        <button class="deck-type-btn" id="deckTypeText" onclick="selectDeckType('text')">${lucideIcon('book-open', 14)} ${t('flashcards.type_text')}</button>
      </div>
      <input type="hidden" id="newDeckType" value="flashcard">
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddFlashDeckModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveNewFlashDeck()">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
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

window.saveNewFlashDeck = function() {
  const name = document.getElementById('newDeckName').value.trim();
  if (!name) { showToast(t('toast.name_required')); return; }
  const type = document.getElementById('newDeckType').value;
  closeAddFlashDeckModal();
  if (type === 'text') {
    openAddTextModal(name);
  } else {
    openAddFlashcardModal(name);
  }
};

function closeAllFlashModals() {
  ['addFlashcardModal', 'editFlashcardModal', 'addDraftModal', 'addFlashDeckModal', 'addTextModal', 'editTextModal', 'importFlashModal'].forEach(id => {
    const m = document.getElementById(id); if (m) m.remove();
  });
}

// ── Practice Session ──
function startPractice(deckFilter) {
  const now = new Date();
  let pool = allCards.filter(c => !c.last_review || !c.next_review || new Date(c.next_review) <= now);
  if (deckFilter && deckFilter !== '__all') pool = pool.filter(c => c.deck === deckFilter);
  if (pool.length === 0) { showAllCaughtUp('cards'); return; }

  sessionDeck = deckFilter || null;

  const SESSION_SIZE = 10;
  const failed = pool.filter(c => c.last_review && c.stability > 0 && c.stability <= 2);
  const overdue = pool.filter(c => c.last_review && c.stability > 2)
    .sort((a, b) => new Date(a.next_review || 0) - new Date(b.next_review || 0));
  const fresh = pool.filter(c => !c.last_review).sort(() => Math.random() - 0.5);

  let selected = [];
  for (const group of [failed, overdue, fresh]) {
    for (const card of group) {
      if (selected.length >= SESSION_SIZE) break;
      if (!selected.find(s => s.id === card.id)) selected.push(card);
    }
    if (selected.length >= SESSION_SIZE) break;
  }
  selected.sort(() => Math.random() - 0.5);

  sessionQueue = selected;
  sessionDone = 0;
  sessionCorrect = 0;
  sessionActive = true;
  sessionTotal = selected.length;
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
  if (sessionQueue.length === 0) { showSessionSummary(); return; }

  const card = sessionQueue[0];
  const pct = sessionTotal > 0 ? Math.round((sessionDone / sessionTotal) * 100) : 0;

  overlay.innerHTML = `
    <div class="practice-header">
      ${practiceHeaderLogo()}
      <div class="practice-progress-bar"><div class="practice-progress-fill" style="width:${pct}%;"></div></div>
      <div class="practice-meta"><span class="practice-meta-text">${sessionDone} / ${sessionTotal} · ${card.deck}</span></div>
      <button class="practice-close" onclick="endPractice()">✕</button>
    </div>
    <div class="practice-card-area" onclick="revealCard()">
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
      <button class="rating-btn rating-again" onclick="rateCard(1)"><span class="rating-num">1</span> ${t('flashcards.again')}</button>
      <button class="rating-btn rating-hard" onclick="rateCard(2)"><span class="rating-num">2</span> ${t('flashcards.hard')}</button>
      <button class="rating-btn rating-good" onclick="rateCard(3)"><span class="rating-num">3</span> ${t('flashcards.good')}</button>
      <button class="rating-btn rating-easy" onclick="rateCard(4)"><span class="rating-num">4</span> ${t('flashcards.easy')}</button>
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
  if (_ratingInProgress) return;
  if (sessionQueue.length === 0) return;
  _ratingInProgress = true;
  // Disable buttons visually while processing
  document.querySelectorAll('#practiceButtons .rating-btn').forEach(b => b.disabled = true);
  const headerLogo = document.querySelector('.practice-header-logo');
  if (headerLogo) headerLogo.classList.add('spinning');
  try {
    const card = sessionQueue.shift();
    const now = new Date();
    const updates = fsrsUpdate(card, rating, now);
    Object.assign(card, updates);
    const idx = allCards.findIndex(c => c.id === card.id);
    if (idx >= 0) Object.assign(allCards[idx], updates);
    if (state.db.connected) await state.db.from('flashcards').update(updates).eq('id', card.id);
    sessionDone++;
    if (rating >= 3) sessionCorrect++;
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
  if (sessionDeck && sessionDeck !== '__all') remainingPool = remainingPool.filter(c => c.deck === sessionDeck);
  const hasMore = remainingPool.length > 0;

  const continueBtn = hasMore
    ? `<button class="btn practice-continue-btn" onclick="startPractice('${escQ(sessionDeck || '')}')">${t('flashcards.continue_session')}</button>`
    : '';

  overlay.innerHTML = `
    <div class="practice-summary">
      ${practiceSummaryLogo()}
      <div class="practice-summary-emoji">${accuracy >= 80 ? lucideIcon('trophy', 32) : accuracy >= 50 ? lucideIcon('flame', 32) : lucideIcon('book-open', 32)}</div>
      <h2>${t('flashcards.session_complete')}</h2>
      <div class="practice-summary-stats">
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionDone}</span><span class="practice-stat-lbl">${t('flashcards.cards_reviewed')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${sessionCorrect}</span><span class="practice-stat-lbl">${t('flashcards.good_plus')}</span></div>
        <div class="practice-summary-stat"><span class="practice-stat-val">${accuracy}%</span><span class="practice-stat-lbl">${t('flashcards.accuracy')}</span></div>
      </div>
      <div class="practice-summary-actions">
        ${continueBtn}
        <button class="btn practice-done-btn" onclick="endPractice()">${t('common.close')}</button>
      </div>
    </div>`;
}

// Show "all caught up" overlay when no cards/texts are due
function showAllCaughtUp(kind) {
  showPracticeOverlay();
  const overlay = document.getElementById('practiceOverlay');
  if (!overlay) return;
  const subtitle = kind === 'texts'
    ? t('text_revision.all_caught_up_texts')
    : t('flashcards.all_caught_up_cards');
  overlay.innerHTML = `
    <div class="practice-summary">
      ${practiceSummaryLogo()}
      <div class="practice-summary-emoji">${lucideIcon('circle-check', 32, '#22c55e')}</div>
      <h2>${t('flashcards.all_caught_up')}</h2>
      <p class="all-caught-up-detail">${subtitle}</p>
      <div class="practice-summary-actions">
        <button class="btn practice-done-btn" onclick="endPractice()">${t('common.close')}</button>
      </div>
    </div>`;
}

// ===================================================================
// TEXT REVISION — Spaced Repetition for Poems / Texts
// ===================================================================

// ── Text Item Rendering ──
function renderTextItem(tx, color) {
  const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
  const now = new Date();
  const totalChunks = chunks.length;
  const masteredChunks = chunks.filter(ch => ch.last_review && ch.stability >= 21 && ch.next_review && new Date(ch.next_review) > now).length;
  const dueChunks = chunks.filter(ch => !ch.last_review || !ch.next_review || new Date(ch.next_review) <= now).length;
  const lines = tx.content.split('\n');
  const lineCount = lines.length;

  const titleTrunc = tx.title.length > 70 ? tx.title.slice(0, 70) + '...' : tx.title;
  const authorStr = tx.author ? ` — ${esc(tx.author)}` : '';

  // Chunk-level progress bar
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
      return `<div class="tr-seg ${cls}"></div>`;
    }).join('');
    progressBar = `<div class="tr-progress-bar">${segments}</div>`;
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
        <span class="tr-meta">${lineCount} lines ${lucideIcon('layers', 12)} ${masteredChunks}/${totalChunks} chunks${dueChunks > 0 ? ` <span class="tr-due-badge">${dueChunks} due</span>` : ''}</span>
        ${progressBar}
      </div>
      <div class="todo-actions">
        <button onclick="startTextPracticeForText('${tx.id}')" title="${t('text_revision.revise_this')}">${lucideIcon('book-open', 16)}</button>
        <button class="tr-expand-toggle" data-text-id="${tx.id}" title="Expand">${lucideIcon('chevron-down', 16)}</button>
        <button onclick="openEditTextModal('${tx.id}')" title="${t('common.edit')}">${lucideIcon('pencil', 16)}</button>
        <button onclick="deleteText('${tx.id}')" title="${t('common.delete')}">${lucideIcon('trash-2', 16)}</button>
      </div>
    </div>
    <div class="tr-text-body" id="trBody-${tx.id}" style="display:none;">
      <div class="tr-text-preview">${previewLines}${lineCount > 3 ? '<br><span class="tr-more">...</span>' : ''}</div>
    </div>
  </div>`;
}

// ── Chunk Splitting ──
function splitTextIntoChunks(content, linesPerChunk) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let nonEmptyCount = 0;
  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);
    if (lines[i].trim() !== '') nonEmptyCount++;
    if (nonEmptyCount >= linesPerChunk) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      nonEmptyCount = 0;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk.join('\n'));
  return chunks;
}

// ── Add Text Modal ──
window.openAddTextModal = function(deck) {
  closeAllFlashModals();
  const html = `<div class="modal-overlay" id="addTextModal" style="display:flex;" onclick="if(event.target===this)closeAddTextModal()">
    <div class="modal modal-wide">
      <h2>${lucideIcon('file-text', 18, '#6366f1')} ${t('text_revision.add_text')}</h2>
      <input type="hidden" id="newTextDeck" value="${esc(deck || 'General')}">
      <label>${t('text_revision.title_label')}</label>
      <input type="text" id="newTextTitle" placeholder="${t('text_revision.title_placeholder')}">
      <label>${t('text_revision.author_label')}</label>
      <input type="text" id="newTextAuthor" placeholder="${t('text_revision.author_placeholder')}">
      <label>${t('text_revision.content_label')}</label>
      <textarea id="newTextContent" rows="10" placeholder="${t('text_revision.content_placeholder')}"></textarea>
      <div class="tr-modal-row">
        <div class="tr-modal-field">
          <label>${t('text_revision.lines_per_chunk')}</label>
          <input type="number" id="newTextLinesPerChunk" value="4" min="1" max="20">
        </div>
        <div class="tr-modal-field">
          <label>${t('text_revision.context_lines')}</label>
          <input type="number" id="newTextContextLines" value="3" min="0" max="10">
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeAddTextModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveNewText()">${t('common.save')}</button>
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
  const deck = document.getElementById('newTextDeck').value.trim();
  const title = document.getElementById('newTextTitle').value.trim();
  const author = document.getElementById('newTextAuthor').value.trim() || null;
  const content = document.getElementById('newTextContent').value;
  const linesPerChunk = parseInt(document.getElementById('newTextLinesPerChunk').value) || 4;
  const contextLines = parseInt(document.getElementById('newTextContextLines').value) || 3;

  if (!title) { showToast(t('toast.name_required')); return; }
  if (!content.trim()) { showToast(t('toast.content_required')); return; }

  if (!state.db.connected) return;

  // Insert text
  const { data: inserted } = await state.db.from('texts').insert({
    deck, title, author, content, lines_per_chunk: linesPerChunk, context_lines: contextLines
  }).select('*');

  if (!inserted || inserted.length === 0) { showToast(t('toast.failed_to_add')); return; }
  const textRow = inserted[0];

  // Generate chunk progress rows
  const chunks = splitTextIntoChunks(content, linesPerChunk);
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
  showDeleteConfirm(t('text_revision.delete_text'), t('text_revision.delete_confirm'), async () => {
    if (state.db.connected) await state.db.from('texts').delete().eq('id', id);
    await refreshFlashcards();
    showToast(t('text_revision.text_deleted'));
  });
};

window.openEditTextModal = function(id) {
  const tx = allTexts.find(t => t.id === id);
  if (!tx) return;
  closeAllFlashModals();
  const decks = [...new Set([...allTexts.map(t => t.deck), ...allCards.map(c => c.deck)])].sort();
  const deckOptions = decks.map(d => `<option value="${esc(d)}" ${d === tx.deck ? 'selected' : ''}>${esc(d)}</option>`).join('');
  const html = `<div class="modal-overlay" id="editTextModal" style="display:flex;" onclick="if(event.target===this)closeEditTextModal()">
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
      <textarea id="editTextContent" rows="10" style="font-family:monospace;font-size:0.85rem;">${esc(tx.content)}</textarea>
      <div class="modal-actions">
        <button class="modal-cancel" onclick="closeEditTextModal()">${t('common.cancel')}</button>
        <button class="modal-save" onclick="saveEditText()">${t('common.save')}</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.closeEditTextModal = function() {
  const m = document.getElementById('editTextModal'); if (m) m.remove();
};

window.saveEditText = async function() {
  const id = document.getElementById('editTextId').value;
  const deck = document.getElementById('editTextDeck').value.trim();
  const title = document.getElementById('editTextTitle').value.trim();
  const author = document.getElementById('editTextAuthor').value.trim();
  const content = document.getElementById('editTextContent').value;
  if (!title || !content.trim()) { showToast('Title and content are required'); return; }
  const updates = { deck, title, author: author || null, content };
  if (state.db.connected) await state.db.from('texts').update(updates).eq('id', id);
  closeEditTextModal();
  await refreshFlashcards();
  showToast(t('text_revision.text_updated'));
};

// ── Text Practice Session ──
function startTextPractice(deckFilter) {
  const now = new Date();
  let pool = [];

  // Gather all chunks that are due or new, from texts in this deck
  const deckTexts = deckFilter && deckFilter !== '__all'
    ? allTexts.filter(tx => tx.deck === deckFilter)
    : allTexts;

  for (const tx of deckTexts) {
    const chunks = allChunkProgress.filter(ch => ch.text_id === tx.id);
    for (const ch of chunks) {
      if (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now) {
        pool.push({ chunk: ch, text: tx });
      }
    }
  }

  if (pool.length === 0) { showAllCaughtUp('texts'); return; }

  // Pick the single most due chunk (one revision per session)
  // Among chunks with the same priority, pick randomly
  const nowStr = now.toISOString();
  pool.sort((a, b) => {
    const rA = a.chunk.last_review && a.chunk.stability ? retrievability(a.chunk.stability, a.chunk.last_review, nowStr) : -1;
    const rB = b.chunk.last_review && b.chunk.stability ? retrievability(b.chunk.stability, b.chunk.last_review, nowStr) : -1;
    return rA - rB;
  });

  // Find all chunks tied at the lowest retrievability
  const lowestR = pool[0].chunk.last_review && pool[0].chunk.stability
    ? retrievability(pool[0].chunk.stability, pool[0].chunk.last_review, nowStr) : -1;
  const tied = pool.filter(p => {
    const r = p.chunk.last_review && p.chunk.stability
      ? retrievability(p.chunk.stability, p.chunk.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });

  const picked = tied[Math.floor(Math.random() * tied.length)];
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
      pool.push({ chunk: ch, text: tx });
    }
  }

  if (pool.length === 0) { showToast(t('text_revision.no_chunks_due')); return; }

  const nowStr = now.toISOString();
  pool.sort((a, b) => {
    const rA = a.chunk.last_review && a.chunk.stability ? retrievability(a.chunk.stability, a.chunk.last_review, nowStr) : -1;
    const rB = b.chunk.last_review && b.chunk.stability ? retrievability(b.chunk.stability, b.chunk.last_review, nowStr) : -1;
    return rA - rB;
  });

  const lowestR = pool[0].chunk.last_review && pool[0].chunk.stability
    ? retrievability(pool[0].chunk.stability, pool[0].chunk.last_review, nowStr) : -1;
  const tied = pool.filter(p => {
    const r = p.chunk.last_review && p.chunk.stability
      ? retrievability(p.chunk.stability, p.chunk.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });

  const picked = tied[Math.floor(Math.random() * tied.length)];
  trSessionActive = true;
  trSessionDeck = tx.deck || null;
  trSessionTextId = picked.text.id;
  showTextPracticeOverlay(picked.text, picked.chunk);
}
window.startTextPracticeForText = startTextPracticeForText;

function showTextPracticeOverlay(text, chunk) {
  let overlay = document.getElementById('practiceOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'practiceOverlay';
    overlay.className = 'practice-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const allChunks = splitTextIntoChunks(text.content, text.lines_per_chunk);
  const chunkLines = (allChunks[chunk.chunk_index] || '').split('\n');
  const allLines = text.content.split('\n');

  // Compute context: preceding lines
  let contextLines = [];
  if (chunk.chunk_index === 0) {
    contextLines = null; // beginning of text
  } else {
    let precedingContent = allChunks.slice(0, chunk.chunk_index).join('\n');
    let precedingLines = precedingContent.split('\n');
    contextLines = precedingLines.slice(-text.context_lines);
  }

  const authorStr = text.author ? ` — ${esc(text.author)}` : '';
  const contextHtml = contextLines === null
    ? `<div class="tr-context-marker">${t('text_revision.beginning')}</div>`
    : contextLines.map(l => `<div class="tr-context-line">${esc(l || '\u00A0')}</div>`).join('');

  overlay.innerHTML = `
    <div class="practice-header">
      ${practiceHeaderLogo()}
      <div class="practice-progress-bar"><div class="practice-progress-fill" style="width:100%;"></div></div>
      <div class="practice-meta"><span class="practice-meta-text">${esc(text.title)}${authorStr}</span></div>
      <button class="practice-close" onclick="endTextPractice()">X</button>
    </div>
    <div class="tr-practice-area">
      <div class="tr-context-section">
        <div class="tr-context-label">${esc(text.title)}${authorStr}</div>
        ${contextHtml}
      </div>
      <div class="tr-lines-container" id="trLinesContainer">
        ${chunkLines.map((line, i) => `<div class="tr-line tr-line-masked${i === 0 ? ' tr-line-next' : ''}" data-line-idx="${i}" data-text="${esc(line || '\u00A0')}" onclick="handleLineClick(this)">${'• '.repeat(Math.max(1, Math.ceil((line || ' ').length / 6)))}</div>`).join('')}
      </div>
      <div class="tr-hint" id="trHint">${t('text_revision.tap_to_reveal')}</div>
      <div class="tr-submit-section" id="trSubmitSection" style="display:none;">
        <button class="btn practice-done-btn" onclick="submitTextReview('${chunk.id}', ${chunkLines.length})">${t('text_revision.submit')}</button>
      </div>
    </div>`;
  initMarquee();
}

window.handleLineClick = function(el) {
  const idx = parseInt(el.dataset.lineIdx, 10);
  const container = document.getElementById('trLinesContainer');
  const lines = container.querySelectorAll('.tr-line');

  if (el.classList.contains('tr-line-masked')) {
    // Only allow revealing the next unmasked line in order
    let nextMaskedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].classList.contains('tr-line-masked')) { nextMaskedIdx = i; break; }
    }
    if (idx !== nextMaskedIdx) return; // can only reveal in order

    // Reveal as known
    el.classList.remove('tr-line-masked', 'tr-line-next');
    el.classList.add('tr-line-known');
    el.innerHTML = el.dataset.text;

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
  } else {
    // Toggle between known and failed
    el.classList.toggle('tr-line-known');
    el.classList.toggle('tr-line-failed');
  }
};

window.submitTextReview = async function(chunkId, totalLines) {
  const lineEls = document.querySelectorAll('#trLinesContainer .tr-line');
  let knownCount = 0;
  lineEls.forEach(el => { if (el.classList.contains('tr-line-known')) knownCount++; });

  const ratio = totalLines > 0 ? knownCount / totalLines : 0;
  let rating;
  if (ratio >= 1) rating = 3; // Good (perfect)
  else if (ratio >= 0.5) rating = 2; // Hard (partial)
  else rating = 1; // Again (less than half)

  // Apply FSRS update
  const chunk = allChunkProgress.find(ch => ch.id === chunkId);
  if (!chunk) { endTextPractice(); return; }

  const now = new Date();
  const updates = fsrsUpdate(chunk, rating, now);
  Object.assign(chunk, updates);

  if (state.db.connected) {
    await state.db.from('text_line_progress').update(updates).eq('id', chunkId);
  }

  // Show summary
  showTextPracticeSummary(knownCount, totalLines, rating);
};

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
    ? allTexts.filter(tx => tx.deck === trSessionDeck)
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
    actionButtons += `<button class="btn practice-continue-btn" onclick="continueTextSameText()">${t('text_revision.continue_same_text')}</button>`;
  }
  if (anyMore) {
    actionButtons += `<button class="btn practice-continue-btn practice-continue-alt" onclick="startTextPractice('${escQ(trSessionDeck || '')}')">${t('text_revision.continue_another')}</button>`;
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
        <button class="btn practice-done-btn" onclick="endTextPractice()">${t('common.close')}</button>
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
    (!ch.last_review || !ch.next_review || new Date(ch.next_review) <= now)
  );
  if (chunks.length === 0) { showToast(t('text_revision.no_chunks_due')); endTextPractice(); return; }

  const nowStr = now.toISOString();
  chunks.sort((a, b) => {
    const rA = a.last_review && a.stability ? retrievability(a.stability, a.last_review, nowStr) : -1;
    const rB = b.last_review && b.stability ? retrievability(b.stability, b.last_review, nowStr) : -1;
    return rA - rB;
  });

  // Find all chunks tied at the lowest retrievability
  const lowestR = chunks[0].last_review && chunks[0].stability
    ? retrievability(chunks[0].stability, chunks[0].last_review, nowStr) : -1;
  const tied = chunks.filter(ch => {
    const r = ch.last_review && ch.stability
      ? retrievability(ch.stability, ch.last_review, nowStr) : -1;
    return Math.abs(r - lowestR) < 0.01;
  });

  const picked = tied[Math.floor(Math.random() * tied.length)];
  showTextPracticeOverlay(text, picked);
};

window.endTextPractice = function() {
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

function buildImportPrompt(mode, deck, deckType) {
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
    const existing = allTexts.filter(tx => tx.deck === deck);
    let ctx = '';
    if (existing.length > 0) {
      const samples = existing.slice(0, 3).map(tx =>
        `  - "${tx.title}"${tx.author ? ` by ${tx.author}` : ''}`
      ).join('\n');
      ctx = `\n\nExisting texts in "${deck}" deck:\n${samples}\n\nGenerate texts that complement this collection.`;
    }
    return `Generate texts for a text-revision/memorisation app, for the "${deck}" deck.${ctx}

Output a JSON array. Each element must have:
- "title": string
- "author": string or null
- "content": string (the full text, line breaks as \\n)

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
  const existing = allCards.filter(c => c.deck === deck);
  let ctx = '';
  if (existing.length > 0) {
    const samples = existing.slice(0, 8).map(c =>
      `  - Q: "${c.front}" → A: "${c.back}"`
    ).join('\n');
    ctx = `\n\nExisting cards in "${deck}" deck (${existing.length} total):\n${samples}${existing.length > 8 ? `\n  ... and ${existing.length - 8} more` : ''}\n\nGenerate cards that complement this collection — avoid duplicates, match the style and depth.`;
  }
  return `Generate flashcards for a spaced-repetition app, for the "${deck}" deck.${ctx}

Output a JSON array of objects, each with:
- "front": string (the question)
- "back": string (the answer)

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

window.openImportModal = async function(presetDeck) {
  closeAllFlashModals();
  const { LLM_SERVICES, escHtml } = await import('./demo-chooser.js');

  const cardDecks = [...new Set(allCards.map(c => c.deck))].sort();
  const textDecks = [...new Set(allTexts.map(c => c.deck))].sort();
  const allDecks = [...new Set([...cardDecks, ...textDecks])].sort();

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const serviceButtons = LLM_SERVICES.map(s => {
    const href = isMobile && s.appUrl ? s.appUrl : s.url;
    return `<a href="${href}" target="_blank" rel="noopener" class="dc-llm-btn">${s.svg}<span>${s.name}</span></a>`;
  }).join('');

  const deckOptions = allDecks.map(d =>
    `<option value="${esc(d)}" ${d === presetDeck ? 'selected' : ''}>${esc(d)}</option>`
  ).join('');

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

  function selectedDeck() {
    if (deckSelect.value === '__new') {
      const name = newDeckInput.value.trim();
      return name || null;
    }
    return deckSelect.value;
  }
  function selectedType() { return typeSelect.value; }

  function updatePrompt() {
    const deck = selectedDeck() || 'General';
    const type = selectedType();
    promptPre.value = buildImportPrompt(importMode, deck, type);
  }

  // Auto-detect type from selected deck
  function autoDetectType() {
    const deck = selectedDeck();
    if (!deck) return;
    const hasCards = allCards.some(c => c.deck === deck);
    const hasTexts = allTexts.some(tx => tx.deck === deck);
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

    let deck = selectedDeck();
    if (!deck) {
      showToast(t('flashcards.import_no_deck'));
      return;
    }
    if (!state.db.connected) { showToast('Not connected'); return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = t('flashcards.import_importing');

    try {
      if (type === 'text') {
        for (const item of selectedItems) {
          const linesPerChunk = 4;
          const { data: inserted } = await state.db.from('texts').insert({
            deck, title: item.title, author: item.author || null,
            content: item.content, lines_per_chunk: linesPerChunk, context_lines: 3
          }).select('*');
          if (inserted && inserted.length > 0) {
            const textRow = inserted[0];
            const chunks = splitTextIntoChunks(item.content, linesPerChunk);
            const chunkRows = chunks.map((_, idx) => ({ text_id: textRow.id, chunk_index: idx }));
            if (chunkRows.length > 0) await state.db.from('text_line_progress').insert(chunkRows);
          }
        }
      } else {
        const rows = selectedItems.map(item => ({ deck, front: item.front, back: item.back }));
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

export { refreshFlashcards, renderFlashcards, initFlashcardModals, getFlashcardCounts, getFlashcards, getTexts, getTextProgress };
window.renderFlashcards = renderFlashcards;
window.setFlashcardFilter = setFlashcardFilter;
window.refreshFlashcards = refreshFlashcards;

window.promptFlashShortname = promptFlashShortname;

async function deleteDeck(deck) {
  const cards = allCards.filter(c => c.deck === deck);
  const texts = allTexts.filter(tx => tx.deck === deck);
  const drafts = allDrafts.filter(d => d.proposed_deck === deck);
  const total = cards.length + texts.length;
  const msg = total > 0
    ? `Delete "${deck}" and its ${total} item(s)?`
    : `Delete empty deck "${deck}"?`;

  showDeleteConfirm(t('common.delete'), msg, async () => {
    // Delete flashcards
    for (const c of cards) {
      await state.db.from('flashcards').delete().eq('id', c.id);
    }
    // Delete texts and their chunk progress
    for (const tx of texts) {
      await state.db.from('text_line_progress').delete().eq('text_id', tx.id);
      await state.db.from('texts').delete().eq('id', tx.id);
    }
    // Delete drafts targeting this deck
    for (const d of drafts) {
      await state.db.from('flashcard_notes').delete().eq('id', d.id);
    }
    showToast(t('toast.deleted'), 'info');
    await refreshFlashcards();
  });
}
window.deleteDeck = deleteDeck;
