# Memory (Flashcards & Texts) — Feature Contract

## Purpose
The Memory page: spaced-repetition flashcards, text revision, draft proposal workflow, AI-assisted import, and deck management.

User jobs:
- create draft note (topic/question) → system proposes Q/A via background worker
- review flashcards with FSRS v5-style spaced repetition
- text revision with per-line progress tracking
- import flashcards/texts via AI-assisted JSON conversion
- manage decks: create, rename, reorder, delete
- practice via Welcome

## Entry & Ownership
- **Entry:** `js/flashcards.js`
- **State:** see `CODEMAP.json:features[flashcards]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `flashcards`, `flashcard_notes`, `flashcard_decks`, `texts`, `text_line_progress`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `logo`, `state`, `utils`
- **Dependents:** `main.js`, `welcome.js` → Welcome shows due reviews + text reading progress

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.card-header`, `.category-nav-btn`, empty-state, toast
- **Status colors:** CSS vars `--fc-mastered`, `--fc-ok`, `--fc-due`, `--fc-new`, `--fc-draft`
- **Text:** `pre-line` whitespace for flashcard text
- **Deck nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted
- **Draft reorder:** drafts reorderable via `initItemDragDrop`, `sort_order` persisted
- **Draft workflow:** `proposal_status=pending|ready`, feedback loop via `===FEEDBACK===` marker parsed by background worker
- **`__shared__` deck:** hidden when empty, shown only when it has items

## Interaction Guards
- **Pending sets:** CODEMAP reports `pendingSet` — used for draft and card actions to block same-ID double-clicks while allowing concurrent different IDs
- **Modal saves:** `guard()` for `saveNewDraft`, `saveEditedProposal`, `saveNewFlashcard`, `saveEditFlashcard`, `saveNewText`, `saveEditText`, `submitFeedback`, `saveNewFlashDeck`, `saveEditDeck`
- **Quick add:** `quickAddDraft` guarded

## Security
- **XSS:** see CODEMAP for current esc_count — wrap `front`, `back`, `note`, `content`, `text title` in `esc()` except `renderMd()` which escapes internally
- No innerHTML with user data; draft content uses textContent

## i18n
- **Prefix:** `flashcards.` — see CODEMAP for current key count (EN/FR/ES)
- Nav label: "Memory" (EN) / "Mémoire" (FR) / "Memoria" (ES)

## Business Invariants

### Spaced Repetition Algorithm
- FSRS v5-style power forgetting curve: `R(S, t) = (t/S × F + 1)^(-0.5)` where F ≈ 0.2346
- Stability ≈ target interval in days; next review = stability days from now; 90% target retention
- Ratings: 1=Again, 2=Hard, 3=Good, 4=Easy
- New cards: initial stability set by rating (Again=0.5, Hard=1, Good=3, Easy=7)
- Success: stability multiplied by rating-dependent factor adjusted for retrievability and difficulty
- Lapse (Again on review): stability reduced, difficulty increased
- Status mapping: mastered (stability ≥ 21, not yet due), ok (reviewed, due later), due (past due date), new (never reviewed), draft (proposal stage)

### Decks
- Default decks: Général, Histoire de France, Vocabulaire + user-created decks
- **Deck FK**: `flashcards.deck_id` and `texts.deck_id` FK → `flashcard_decks(id)`, CASCADE on delete — deleting a deck deletes all its flashcards and texts
- Protected default row (`name=''`, `is_protected=1`) cannot be deleted
- Deck nav order persisted via `sort_order`, reorderable by long-press drag
- Général deck header color distinct from Drafts color

### Drafts
- `flashcard_notes.proposed_deck` stays TEXT (not FK) — stores deck names as proposals, intentional design decision
- Draft proposal: raw `content` → background worker researches → `proposed_front/back/deck` + `proposal_status=ready`; Accept/Feedback/Reject in UI
- Feedback loop: `===FEEDBACK===` marker in content → worker reworks proposal applying feedback → resets content to original topic
- Only propose, never direct-create via background worker
- Drafts reorderable via drag-and-drop, `sort_order` persisted
- Creating a new deck does not auto-open an add-entry modal; empty decks show empty-state add button

### Texts
- `text_line_progress` tracks per-line revision for long texts
- Text practice: chunked display, line-by-line click-to-reveal, chunk review submission

### Import
- AI-assisted import modal: generates JSON conversion prompt for both flashcards and texts
- User pastes source material → AI prompt templates structure it → JSON imported into target deck

## Adapter & Backend
- Via `db.from('flashcards')`, `db.from('flashcard_notes')`, `db.from('flashcard_decks')`, `db.from('texts')`, `db.from('text_line_progress')`
- Offline-cache wraps

## Sharing
- Private currently; `__shared__` deck infrastructure exists but hidden when empty

## Cross-Feature Edges
- Welcome aggregates due flashcard reviews (count + deck) and text reading progress
- Changing deck structure → verify Welcome counts update
- Draft proposal worker (heartbeat) reads `flashcard_notes` with `proposal_status=pending`

## Risks / Gotchas
- `pre-line` must be preserved for flashcard text — avoid trimming whitespace
- Draft proposal feedback parsing splits on `===FEEDBACK===` — must strip marker before reusing `content`
- Status colors must use CSS vars, not hardcoded hex
- Deck delete cascades to all cards + texts in that deck — destructive, confirm first

## Test Hooks
- `bun tests/tests.js`: esc usage, pendingSet existence, CODEMAP freshness
- Manual: create draft, verify proposal appears with ready status
- Manual: reorder deck nav buttons, reload, verify order persists
- Manual: import flashcards via AI modal, verify cards land in correct deck

## References
- `CODEMAP.json:features[flashcards]`
- Entry: `js/flashcards.js`
