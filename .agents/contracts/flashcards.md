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
- New cards: initial stability set by rating (Again≈0.007 ≈10min, Hard=1, Good=1, Easy=4)
- Success: stability multiplied by rating-dependent factor adjusted for retrievability and difficulty
- Lapse (Again on review, Anki-style): card enters relearning — stability reset to ≈10min, next review after one 10-minute step, `relearning=1`; a flashcard re-enters the practice session once the step is due (or early, when the queue empties — learn-ahead). Text chunks share the scheduling (10-minute due, graduation) but have no session queue: a lapsed chunk reappears at the next revise, not in-session. Good on a relearning card/chunk graduates it to 1 day, Easy to 4 days, Hard/Again repeat the step. Difficulty increases. Deliberately no leech mechanism: no lapse counter, no suspension.
- Session counts: the header counts ratings vs scheduled presentations (`sessionDone / sessionTotal`; the total grows when a lapsed card is queued for re-presentation), while the summary's "cards reviewed" counts unique cards rated.
- Status mapping: mastered (stability ≥ 21, not yet due), ok (reviewed, due later), due (past due date), new (never reviewed), draft (proposal stage)

### Decks
- Default decks: Général, Histoire de France, Vocabulaire + user-created decks
- **Deck FK**: `flashcards.deck_id` and `texts.deck_id` FK → `flashcard_decks(id)`, CASCADE on delete — deleting a deck deletes all its flashcards and texts
- **Grouping is by FK, not name**: all grouping, filtering, nav, practice pools, and counts use the resolved `deck_id` (`deckIdForCard()` / `deckIdForText()` helpers); the `deck` string is a display/backward-compatibility cache only and never decides grouping. Use `??` (not `||`) when deriving the name from a deck row, since the protected default row has `name=''`
- Protected default row (`name=''`, `is_protected=1`) cannot be deleted
- Deck nav order persisted via `sort_order`, reorderable by long-press drag
- Général deck header color distinct from Drafts color
- **Deck sections (2.32.34, like Lists/TODOs/Habits since 2.23.0):** `flashcard_decks` rows carry `kind` (`bucket`/`section`) and `parent_id` (plain column, not a FK); the tree comes from `sections-pure.js` (`buildSectionTree`, `planNodeMove`), never from a flashcards-local copy. `sort_order` is per parent. Top nav holds sections + top-level buckets; each section block has its own chips row; decks and sections move across sections by long-press drag of nav buttons/chips (bucket cards are not drag sources). Sections may mix card and text decks; pickers are bucket-only and show section paths.
- **Deck names are sibling-scoped, not global:** the same name may exist in different sections. Legacy name lookups (`_deckByName`, draft proposals, import) resolve first-wins so duplicates stay stable; proposal pickers store section paths (`Geography > World Capitals`) resolved by `resolveSectionPath`. A proposal resolving to a section falls back to the default deck — a section never receives cards directly.
- **Section creation:** path syntax in the new-deck name (`Geography > World Capitals`) builds the chain; a segment colliding with an existing bucket converts that bucket, moving its cards/texts to the default deck first so a failed flip can never strand items inside a section row. The conversion runs through `runDeckToSectionMigration` (`sections-pure.js`, 2.32.39): every write is checked, the flip is last, and the rollback is id-precise (the moved rows' ids are captured first — a rollback by destination would move the default deck's own items too). A failed rollback is reported alongside the original error (the items stay in the visible default deck, so nothing is lost, but the caller is told the move-back did not happen). Section delete: empty deletes directly, non-empty asks move-up (children take the section's place) or subtree delete (explicit item deletes, cross-backend safe).
- **Section rename (2.32.35):** the rename field accepts the same path syntax — renaming deck B to `A > B` nests B under A (creating A, or converting A from bucket to section, as needed), like creation and like Lists/TODOs/Habits renames. Renaming a section by path moves the whole subtree. The moved row is re-sorted at the end of its new parent; sibling uniqueness is checked in the target parent even when only the parent changes (same name, new parent). A path resolving inside the renamed row itself or one of its descendants is refused (`section-cycle` guard in `ensureFlashSectionChain`, same as the other pages) and the modal stays open. A plain name keeps the current parent.
- **Renames are checked writes (2.32.39, all pages):** the deck/category update error is checked before any local mutation, calendar resync, modal close or success toast; a failed deck rename whose item name-cache update then fails rolls the deck row back to its pre-edit values (`rollbackDeckRow`) — the rename is one logical operation. A section-chain failure reports a cycle as a validation error and any other failure as an update failure, never as a name error.
- **Special decks stay top-level:** the protected default and `__shared__` rows are never moved into a section and never converted; Drafts is not a deck row and is unaffected.

### Drafts
- `flashcard_notes.proposed_deck` stays TEXT (not FK) — stores deck paths as proposals (`Geography > World Capitals`, plain names for legacy/top-level), intentional design decision
- Draft proposal: raw `content` → background worker researches → `proposed_front/back/deck` + `proposal_status=ready`; Accept/Feedback/Reject in UI
- Feedback loop: `===FEEDBACK===` marker in content → worker reworks proposal applying feedback → resets content to original topic
- Only propose, never direct-create via background worker
- Drafts reorderable via drag-and-drop, `sort_order` persisted
- Creating a new deck does not auto-open an add-entry modal; empty decks show empty-state add button

### Texts
- `text_line_progress` tracks per-line revision for long texts
- Text practice: chunked display, line-by-line click-to-reveal, chunk review submission
- **Deck type is stored** (`flashcard_decks.deck_type`): the new-deck modal choice is persisted at creation; legacy rows without a stored type fall back to inferring from content (cards → flashcard, texts → text, empty → flashcard). The edit modals only list same-type decks and never `__shared__` (`deckOptionsForEdit`): a card in a text deck would be invisible since buckets render by deck type.
- **Scene mode** (role-based text revision): `texts.focus_role` holds the role being learned (null = plain text). Scene content uses `<...>` blocks — `<ROLE: ...>` dialogue (may span lines), `<**...**>` direction (the `**` wrapper is mandatory and checked before any speaker prefix, so a direction containing `NAME:` is never read as dialogue), `**...**` for inline directions. Lines outside blocks are ignored by the parser. Speaker cues are case-insensitive (`<Rodrigue:` works); the name displays as written and role matching ignores case.
- Scene parsing lives in `js/scene-parse.js` (pure, no imports): `parseSceneContent`, `splitSceneIntoChunks`, `sceneLineText`, `parseInlineDirs`
- Chunking goes through `getTextChunks(tx)` everywhere (chunk generation, auto-repair, overlay, import) so `chunk_index` stays aligned with `text_line_progress` rows in both modes
- Chunk-progress invariant: `text_line_progress` is valid only for an unchanged `(content, blocks_per_chunk, focus_role)` tuple (renamed from lines_per_chunk/context_lines in migration 2.10.43; DB columns renamed, not just the labels). Editing any of those drops progress (`isTextChunkingStale`) so auto-repair regenerates it; stale FSRS state must never attach to re-chunked material. Persisted via `persistTextEdit()`: both mutations checked for `{ data, error }` failures and thrown errors converted to `{ ok: false }`; a failed text update never triggers progress deletion; a failed deletion — returned as `{ error }` or thrown — rolls the text back to pre-edit values so the (content, progress) tuple stays consistent. Auto-repair also heals count-mismatched progress (not just missing), but never runs on a failed progress read, and only touches in-memory state after successful backend writes. Speaker cues are NFC-normalized at parse so NFD input parses.
- Revision: all lines masked, revealed in order; only the role's lines toggle known/failed and count toward the rating — cues/directions reveal neutrally. Revealed lines use theatrical typesetting: consecutive lines from the same speaker are grouped under a single name header outside the line boxes (book-like): one color per role (reserved accent for the revised role, 6-color palette cycling for the rest — header only, never the lines), left-aligned for the revised role, right-aligned for other roles; standalone directions centered, muted italic, under a localized “didascalies” header (centered, muted) like the role headers; consecutive direction lines merge into a single reveal block. Chat-bubble layout (scene mode only): lines shrink to fit content (max-width 85%), anchored left for the revised role, right for other roles, centered for didascalies; text inside blocks is always left-aligned. Masked bubbles render at max width (no content-length hint). Leading cues/directions auto-reveal up to the first line of the revised role. Revealing one of the revised role's lines also auto-reveals every following cue/direction up to the next own line (`trailingRevealCount` in scene-parse.js) — non-role lines are never practised, so they never wait for a tap; consecutive blocks of other roles (same role included) all cascade, and the cascade stops at the next own line, which stays masked for recall. The header progress bar fills with revealed/total lines (starts after auto-reveal, updates on each tap). One <ROLE:> block is one reveal unit — inner newlines render as breaks inside the bubble (revealed, mask, and preview); splitting into units is done with several <ROLE:> entries. Single-character speaker names parse. The edit-text modal exposes blocks-per-chunk and context blocks; a changed blocks-per-chunk invalidates progress (regenerated by auto-repair), and the persist rollback reverts every updated field. Pickers skip chunks holding none of the role's lines. Changing `focus_role` resets that text's chunk progress (auto-repair regenerates it).
- **Free practice**: the per-text revise button with nothing due samples a random chunk (role lines only, never the just-practiced one) and revises without touching scheduling — no FSRS update, no DB write, no rating shown; the overlay carries a Practice badge and the summary states scheduling was untouched. Scoped to per-text revise; deck-wide revise and flashcards keep the caught-up notice.
- **Chunk panel (chunk bar hover/tap)**: the chunk bar is a full-width row under the text row; each segment is a button, 16px minimum in both dimensions, first 16 shown with a Show more pill (accent tint + border + chevron + hidden count) that expands it to a wrapped grid (Show less collapses it). Segments carry `data-action="open-chunk-panel"` with `data-text-id`/`data-chunk-index` and explicit delegation cases — never the default fallback, which cannot read those attributes. Clicking a segment opens a small fixed panel at once; hovering waits 2s (same delay as the item row actions) so passing over a segment never pops it open, and moving to another segment restarts the timer for it — unless the panel is already open and the pointer never left the bar (segments plus gaps), in which case the newly hovered segment's panel opens at once; leaving the bar breaks that chain and the next segment hover costs 2s again. The panel is positioned by the segment (flipped above when space below is short, clamped to the viewport), and the side is decided once, from the opening view, and frozen for the panel's lifetime (`_chunkPanelSide`, reset on close): the stats view is much taller than the options view, so re-deciding the flip on Show stats near the bottom of the page used to jump the panel above the segment, leaving the cursor hovering neither panel nor segment, and the mouseout timer closed the stats panel before it could be read (fixed 2.32.36). The taller view only grows within its side, clamped to the viewport (scrollable via the panel's CSS max-height). Three options — Show stats, Edit, Revise. Only Edit opens a modal. Show stats renders stats only, no chunk text, inside the same panel — a status badge, a recall-chance ring, a recall-decay curve drawn from the same FSRS curve the app schedules from (last review to next review, today marked on it), stability as a bar toward the 21-day mastered threshold, difficulty as a 10-segment bar, plus reviews and last/next review rows — with Back returning to the options; Revise starts the revision overlay directly. The panel closes via its close button, a click/tap elsewhere, Escape, or moving away from both segment and panel (150ms grace for travelling to the panel); scrolling moves the panel with its segment and only closes it once the segment leaves the viewport (a scroll-to-close would dismiss the panel on the very tap that opened it, since the bring-into-view scroll fires after the panel opens). Re-opening the same segment keeps the current view; it never resets stats back to options or closes the panel. While the panel is open the owning text item carries `.chunk-panel-open`, which freezes its row actions in whatever state they had: the row-action hover timer in `item-utils.js` skips panel-open items and never shows actions while the pointer is on a segment (`.tr-seg:hover` check, since both delays are 2s and the firing order is a race), mouseleave never hides them while the panel is open, and segment clicks never trigger row actions — so hovering a segment with hidden actions opens only the panel, and hovering a segment with visible actions never hides them; closing the panel hides them only once the pointer has left the item.
- **Modal opacity and scroll lock**: `.modal` uses the opaque `var(--dropdown-bg)` background (tinted variant for `--cat-color` overlays) with no backdrop blur through the box itself. The chunk edit modal locks background scroll via `lockFlashModalScroll()` (body `no-scroll` at the current offset, same pattern as the day modal, with its own flag so it never steals the day modal's lock); closing the modal unlocks it.
- **Targeted revise**: a chunk's Revise button opens the normal overlay for that chunk. Due/new chunks get the FSRS update on submit; not-due chunks — including a chunk already revised today — revise through the free-practice path (Practice badge, no rating, no FSRS/DB write). Scene chunks with no role lines cannot be revised, same as the pickers.
- **Chunk edit (sole exception to the tuple invariant)**: edits one chunk only, rewording only — plain texts get one textarea, scene texts one textarea per block (speaker and direction wrappers are preserved, never edited). `applyChunkEdit()` in `scene-parse.js` splices the edit back and refuses it when re-chunking would move any other chunk (added/removed line, blanked counted line, wrong block count). On save, only that chunk's row is reset (stability 0, difficulty 5, last/next review null, review count 0); every other row is untouched. This is safe only because `applyChunkEdit` proves all other chunks identical after re-chunking. A failed reset rolls the text back to its old content. Whole-text edits still drop all progress via `persistTextEdit`.

### Deep links
- Copy-link buttons (same `copy-item-link` pattern as the other pages) exist on section headers (`flashsection`), deck bucket headers — card and text decks, plus the Drafts bucket as `flashdeck/__drafts` (`data-node-id="__drafts"`) — draft items (`flashdraft`, `data-draft-id`), and text items (`flashtext`, `data-text-id`). Flashcard cards already had `flashcard`.
- All four types map to the `flashcards` view in `DEEP_LINK_TYPE_MAP` and resolve in `findItemElement`: sections and decks via `#flashcardsView [data-node-id]`, texts via `[data-text-id]`, drafts via `[data-draft-id]`. Opening a link switches to the Memory tab, scrolls to the element and highlights it; an unknown id toasts `common.item_not_found` after the retries.

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
