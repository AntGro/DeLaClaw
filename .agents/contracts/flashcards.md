# Flashcards — Feature Contract

## Purpose
Spaced-repetition flashcards and text revision decks, draft proposals workflow, Général deck.

User jobs:
- create draft note (topic/question) → system proposes Q/A
- review flashcards with pre-line whitespace, status colors
- text revision with `text_line_progress`
- practice via Welcome

## Entry & Ownership
- **Entry:** `js/flashcards.js` (2331 LOC)
- **State:** `currentView`, `db`, `js`
- **Tables:** `flashcards`, `flashcard_notes`, `flashcard_decks`, `texts`, `text_line_progress`, `settings`
- **CODEMAP:** `features[flashcards]` — loc 2331, esc 74, i18n 128, guards []

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `logo`, `state`, `utils`
- **Dependents:** `main.js`, `welcome.js` → Welcome shows due reviews

## UI / UX
- **Reused components:** `.modal`, `.project-card`, `.card-header`, empty-state, toast
- **Status colors:** CSS vars `--fc-mastered`, `--fc-ok`, `--fc-due`, `--fc-new`, `--fc-draft` extracted (commit 9af5f63)
- **Text:** `pre-line` whitespace for flashcard text (commit 018628a)
- **Draft workflow:** `proposal_status=pending|ready`, feedback loop via `===FEEDBACK===` marker parsed externally (contract excludes background worker detail)

## Interaction Guards
- **Modal saves:** `guard()` for `saveNewDraft`, `saveEditedProposal`, `saveNewFlashcard`, `saveEditFlashcard`, `saveNewText`, `saveEditText`, `submitFeedback`
- **Quick add:** `quickAddDraft`, `quickAddListItem` guarded
- PendingSet not used (single modal flow)

## Security
- **XSS esc_count=74:** wrap `front`, `back`, `note`, `text` in `esc()` except `renderMd()` which esc internally
- No innerHTML with user data; draft content uses textContent

## i18n
- **Prefix:** `flashcards.` — 128 keys (largest), EN/FR/ES
- Deck names localized via `flash_shortnames` in `settings` table

## Business Invariants
- Decks: `Général`, `Histoire de France`, `Vocabulaire` + user decks; shortnames DB-synced via `flash_shortnames`
- **Deck FK**: `flashcards.deck_id` and `texts.deck_id` FK → `flashcard_decks(id)`, CASCADE on delete. Deleting a deck deletes all its flashcards and texts. Protected default row (`name=''`, `is_protected=1`) cannot be deleted.
- `flashcard_notes.proposed_deck` stays TEXT (not FK) — stores deck names as proposals, intentional design decision
- Draft proposal: raw `content` → research → `proposed_front/back/deck` + `proposal_status=ready`; Accept/Feedback/Reject in UI; only propose, never direct create via background worker
- `text_line_progress` tracks per-line revision for long texts
- Status: mastered/ok/due/new/draft mapped to CSS vars

## Adapter & Backend
- Only via `db.from('flashcards')`, `db.from('flashcard_notes')`, etc.
- Offline-cache wraps; text progress stored locally

## Sharing
- Private currently

## Cross-Feature Edges
- Welcome aggregates due flashcard reviews (count + deck)
- Changing deck shortnames → check bucket colors, Welcome

## Risks / Gotchas
- `pre-line` must be preserved for flashcard text — avoid trimming whitespace
- Draft proposal feedback parsing splits on `===FEEDBACK===` — must strip marker before reusing `content`
- Status colors must use CSS vars, not hardcoded hex

## Test Hooks
- `bun tests/tests.js`: esc usage, CODEMAP freshness, CSS var existence
- Manual: create draft, verify proposal appears with ready status

## References
- `CODEMAP.json:features[flashcards]`
- Entry: `js/flashcards.js`

