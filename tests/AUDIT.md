# Test Suite Audit — DeLaClaw `tests/tests.js`

**Date**: 2026-07-25
**Test count**: 179 (in CI mode; integration tests skipped add ~30 more when Playwright available)
**Test framework**: Custom (no framework — raw Node `test()` + `assert()`)
**Methodology**: Static analysis of source code (grep/regex) + Playwright integration tests

---

## Rating Legend

| Rating | Meaning |
|---|---|
| **Strong** | Tests something meaningful with specific assertions that would catch real regressions |
| **Adequate** | Covers a real concern but assertions could be tighter or scope is narrow |
| **Weak** | Provides little regression protection — vague assertions, false-positive prone, or trivial |
| **Redundant** | Duplicates coverage already provided by another test |
| **Wrong** | Misleading, broken, or tests the wrong thing |

---

## Per-Test Assessment

### Static Analysis (Tests 1–10)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 1 | No HTML entities in JS files | Scans all JS for `&quot;` etc. | **Strong** | Catches copy-paste corruption from HTML contexts. Real bug class. |
| 2 | Balanced backticks in JS files | Odd backtick count = unclosed template literal | **Adequate** | Catches unclosed templates but skips `utils.js` entirely. Could false-negative on files with backticks inside strings/regex. |
| 3 | All JS files are syntactically valid | Bun/acorn parse or fallback heuristic for unescaped apostrophes | **Strong** | Multi-tier parser strategy. Catches the `d'envoyer` class of i18n bugs. Good real-world coverage. |
| 4 | All window.fn = fn assignments reference defined identifiers | Checks that window-exposed names are defined or imported | **Strong** | Prevents dead `window.X = X` after refactors. Specific and actionable. |
| 5 | All named imports resolve to exports in target files | Cross-file import/export resolution | **Strong** | Catches broken import chains that would crash at runtime. Essential for a no-build ESM app. |
| 6 | Sharing startup sync waits for loaded shared data | Checks `initialSharingLoad` ordering invariant | **Strong** | Tests a critical race condition fix. Asserts exact code ordering (`await initialSharingLoad` before `refreshTodos`). Brittle to refactors but catches the exact regression it's designed for. |
| 7 | Sharing refresh handler centralizes sync before render | Checks `sharing-changed` handler ordering + no duplicate listeners | **Strong** | Tests the double-render fix. Asserts both ordering (sync before render) and absence of redundant `refreshX()` calls. |
| 8 | Shared habit next_due updates are idempotent during refresh | Checks `normalizeHabitNextDue` + skip logic + in-memory update | **Strong** | Four specific assertions covering the normalize → compare → skip → update-in-memory chain. |
| 9 | Habit quick-add button resolves sibling input | Checks delegation.js routing + defensive guard in habits.js | **Adequate** | Tests the right thing but relies on exact string matching of CSS selectors. |
| 10 | Footer DB size RPC caches missing optional capability | Checks throttle, cache, unavailable guard, single call site | **Strong** | Five precise assertions. Tests a real performance/error pattern (RPC not available on all backends). |

### Shared TODO/Habit Sync (Tests 11–12 area)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 11 | Shared TODO sync reads local pointers from DB, not startup cache | Asserts `select('id,shared_id,shared_group_id')` and absence of `allTodos.filter` | **Strong** | Catches the exact startup race bug it was written for. |
| 12 | Default imports resolve to default exports | Cross-file default import/export check | **Strong** | Complements test 5 (named imports). |
| 13 | No duplicate function definitions in same file | Scans for duplicate `function X()` in each file | **Adequate** | Useful but only catches top-level `function` declarations, not `const X = () =>` duplicates. |
| 14 | All modal overlay IDs have corresponding close handlers | Checks HTML modal overlays have close buttons | **Weak** | The assertion is commented out / never throws — the `hasClose` variable is computed but never asserted. This test always passes. |
| 15 | Key onclick handlers reference window-exposed functions | Cross-references HTML `onclick=` with `window.X =` | **Strong** | Catches orphaned onclick handlers after refactors. |
| 16 | style.css contains expected base selectors | Checks 6 essential CSS selectors exist | **Adequate** | Basic smoke test. Low value — these selectors are extremely unlikely to vanish. |
| 17 | No stray console.log in JS files | Scans for `console.log()` calls | **Weak** | Warns but never fails. A test that can't fail provides no regression protection. |

### Feature-Specific (Tests 18–27)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 18 | Habit done button calls markHabitDone directly (no modal) | Asserts absence of old modal functions | **Strong** | Guards against reintroduction of removed modal flow. Both presence and absence assertions. |
| 19 | No emoji characters in JS files | Scans for specific emoji codepoints | **Adequate** | Enforces Lucide icon convention. Hard-coded emoji list may miss new ones, but covers common cases. |
| 20 | Flashcard deck rendering sorts cards by retrievability | Checks `cards.sort(` + `retrievability(` exist | **Weak** | Only checks that two strings exist in the file. Doesn't verify they're in the same function or that the sort uses retrievability correctly. |
| 21 | Flashcard items use border-left color from retrievability | Checks borderColor, border-left exist; strength bar removed | **Adequate** | Absence assertions (no `.fc-strength-bar`) are strong. Presence assertions are loose. |
| 22 | Birthday hover delay uses correct rowSelector | Extracts regex match for `rowSelector` value | **Strong** | Tests a specific bug fix (querySelector doesn't match self). Precise value assertion. |
| 23 | Wardrobe items use purchase-status-based border color | Checks class names and CSS rules exist | **Adequate** | Verifies the CSS/JS coordination but doesn't test actual rendering behavior. |
| 24 | All lucideIcon() calls reference defined icons | Cross-references every `lucideIcon('name')` with LUCIDE_PATHS, including HTML `data-icon` | **Strong** | Comprehensive cross-file scan. Already caught a real bug (triangle-alert vs alert-triangle) during this session. |
| 25 | No ondblclick HTML attributes in JS files | Ensures ondblclick migration to initItemHoverDelay | **Strong** | Guards against regression to old pattern. |
| 26 | All initItemHoverDelay calls include onDblClick | Checks 6 page files for onDblClick callbacks | **Strong** | Comprehensive coverage of all pages that need double-click edit. |
| 27 | Double-click onDblClick triggers inline edit (not modal) | Checks function names + inlineEditText usage | **Strong** | Multi-file check that the right edit pattern is used. Both positive (uses inline) and negative (no modal) assertions. |

### Hover/Drag/Inline Edit Infrastructure (Tests 28–37)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 28 | initItemHoverDelay rowSelector differs from itemSelector | Compares selector values | **Strong** | Catches the exact querySelector-doesn't-match-self bug. |
| 29 | Inline edit textareas set flex:none | Checks item-utils.js and all task-edit-input textareas | **Strong** | Tests a specific CSS layout bug fix across all files. |
| 30 | Welcome habit dblclick calls canonical window.editHabitInline | Checks for canonical handler, absence of duplicate | **Strong** | Prevents welcome.js from drifting to its own implementation. |
| 31 | Welcome habit edit button calls window.editHabitInline (not modal) | Checks button handler routing | **Strong** | Multiple assertions: uses inline, no welcomeEditHabit function, no modal reference. |
| 32 | Welcome habit items render shared group badge | Checks import, pointer detection, sharedBadge usage | **Strong** | Tests sharing integration in welcome page with 5 specific assertions. |
| 33 | Welcome habit actions delegate to canonical handlers | Verifies delegation pattern for done/delete | **Strong** | Very thorough — checks params, delegation calls, absence of direct DB writes, absence of manual refresh. |
| 34 | Welcome habit done delegation passes clicked button element | Checks delegation.js routing + el pass-through | **Strong** | Tests the pending UI guard integration. |
| 35 | Welcome TODO dblclick calls canonical window.editTodoInline | Mirror of test 30 for TODOs | **Strong** | Same quality and approach. |
| 36 | Welcome TODO items render shared group badge | Mirror of test 32 for TODOs | **Strong** | Same quality. |
| 37 | Welcome TODO actions delegate to canonical handlers | Mirror of test 33 for TODOs, also covers priority | **Strong** | Even more thorough — covers toggle, delete, and priority. |
| 38 | Welcome TODO toggle delegation passes clicked button | Mirror of test 34 for TODOs | **Strong** | Same quality. |

### Inline Edit Shared-Aware (Tests 39–47)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 39 | edit*Inline functions accept optional itemEl parameter | Checks function signatures for habits + todos | **Strong** | Prevents regression of scoped querySelector support. |
| 40 | editHabitInline updates shared habits through sharing API | Checks shared pointer detection, API call, no creator_category rewrite, local-only category update | **Strong** | Very precise assertions about shared vs. local write paths. |
| 41 | Supabase shared habits use canonical ids and normalize habit payloads | Checks UUID generation, id consistency, payload normalization, pointer repair | **Strong** | 10+ assertions covering id lifecycle, normalization shape, and legacy repair. Complex but tests real bug surface. |
| 42 | List item edit action uses shared-aware inline editor | Checks delegation routing, function exposure | **Adequate** | Good coverage but some assertions depend on exact function names. |
| 43 | editListItemInlineFull updates shared list items through sharing API | Checks shared pointer detection, payload merge, local-only writes | **Strong** | Same quality as test 40, applied to lists. |
| 44 | toggleListItemCheck has per-item pending guard | Checks pending Set, button disable, aria-busy, finally cleanup | **Strong** | Tests the double-click guard pattern comprehensively. |
| 45 | Shared list add action passes clicked button element | Checks delegation routing + legacy tolerance | **Strong** | Tests backward compatibility with legacy callers. |
| 46 | Sharing adapters normalize completeItem(doneBy) without nested arrays | Checks both Supabase and Drive adapters for array normalization | **Strong** | Tests a real data corruption bug. Cross-adapter parity. |
| 47 | Sharing member identity is memberId-based and agent-safe | Cross-file check for identity invariant across 4 files + migration | **Strong** | Very thorough — checks interface, UI, both adapters, and migration SQL. |

### Inline Edit & Modals (Tests 48–52)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 48 | Inline edit callbacks use refreshFn (not renderFn) | Checks refresh vs. render function naming | **Adequate** | Good intent but only checks that the function doesn't start with "render". Could miss a misnamed refresh. |
| 49 | Edit habit modal includes last-done date field | Checks DOM id, reference in save, population in open | **Adequate** | Tests UI wiring but the assertions are loose (just string presence). |
| 50 | Shared habit last-done edits write to shared completions | Checks helper function, completion pop, routing | **Strong** | Tests a complex shared editing flow with precise assertions. |
| 51 | Shared habit completions use group member ids, not account emails | Cross-file check for memberId-based authorship | **Strong** | Tests absence of email fallback paths across 4 files. |
| 52 | No duplicate modal IDs between HTML and JS | Cross-references static and dynamic modal IDs | **Strong** | Catches real issues where JS creates a modal that already exists in HTML. |
| 53 | All modal-overlay IDs referenced via getElementById exist | Checks that referenced modal IDs are defined somewhere | **Strong** | Catches silent failures from missing modals. |

### Drag-Drop & Schema Parity (Tests 54–56)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 54 | All reorderable pages call initItemDragDrop | Checks 4 page files for drag-drop + camelCase idAttr | **Strong** | Both coverage and convention enforcement. |
| 55 | Drag clones are globally tagged and cleaned before re-renders | Checks clone tagging, cleanup registration for 6 events, cleanup before innerHTML in 4 files | **Strong** | Very thorough — tests the full cleanup lifecycle including ordering. |
| 56 | CHECK constraints match across Supabase, Demo, SQLite | Extracts and compares constraint values across 3 backends | **Strong** | Genuine cross-backend parity testing. Catches schema drift. Includes regression guard for `draft` status. |

### Auth & Sharing Infrastructure (Tests 57–80)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 57 | Migration SQL files 1.294-1.297 exist | File existence check | **Adequate** | Basic but necessary. Low regression risk. |
| 58 | supabase-migrations.js has entries for 1.294-1.297 | Migration registry check | **Adequate** | Same as above. |
| 59 | local-migrations.js has entries for 1.294 and 1.297 | Migration registry check | **Adequate** | Same. |
| 60 | auth.js exports expected functions | Checks 6 function exports | **Adequate** | Import resolution tests (5) already cover this partially. **Partially redundant** with test 5, but more specific. |
| 61 | sharing-supabase.js exports createSupabaseSharing | Single export check | **Adequate** | Partially redundant with test 5. |
| 62 | sharing.js factory includes supabase case | Checks uncommented case statement | **Adequate** | Guards against accidentally commenting out the supabase path. |
| 63 | sw.js JS precache list matches source modules | Compares filesystem JS files with SW precache list | **Strong** | Catches missing/stale precache entries that would break offline mode. Includes demo-data.js policy. |
| 64 | auth.js claimOwnership includes joined_groups | Single string check | **Weak** | Very narrow. Only checks that the string `'joined_groups'` exists somewhere in auth.js. |
| 65 | sharing-supabase.js references all 8 RPC function names | Checks 8 RPC name strings | **Adequate** | Catches dropped RPC references but doesn't verify they're called correctly. |
| 66 | sharing-supabase inviteUser returns member-scoped invite code | Checks inviteCode, getMemberInviteLink, no hash links | **Strong** | Tests the invite code format migration with both presence and absence assertions. |
| 67 | Drive sharing invite code encodes folder id in DLC1 envelope | Checks envelope structure | **Strong** | Tests the invite code format for Drive backend. |
| 68 | state.js includes authUser property | Single string check | **Weak** | Trivial. Would pass if `authUser` appeared in a comment. |
| 69 | No HTML entities in new JS files | Re-checks auth.js and sharing-supabase.js | **Redundant** | Already covered by test 1 which scans all JS files. |
| 70 | 1.296 migration defines all 8 RPC functions | Checks SQL function definitions | **Adequate** | Good structural check of migration SQL. |
| 71 | 1.294 migration adds owner_id to 12 tables | Checks ALTER TABLE statements | **Adequate** | Verifies migration completeness. |
| 72 | 1.300 migration enforces owner-only RLS | Checks for correct policies, trigger, RPC | **Strong** | Tests a security-critical migration with both presence and absence assertions. |
| 73 | supabase_schema.sql has owner-only for all 13 personal tables | Counts and verifies RLS policies | **Strong** | 13-table coverage with count assertion. Security-critical. |
| 74 | Sharing uses pasted DLC1 invite codes instead of #join links | Cross-file check for invite code migration | **Strong** | Tests 3 files for the new pattern and absence of old pattern. |
| 75 | Share popover is viewport-bound with scrollable lists | Checks JS positioning logic + CSS properties | **Strong** | Tests both JS behavior and CSS coordination. 8+ specific assertions. |
| 76 | index.html has authPromptOverlay modal | DOM element existence check | **Weak** | Very basic. Would catch deletion but not breakage. |
| 77 | i18n has auth keys in all 3 languages | Counts key occurrences across 3 language blocks | **Adequate** | Verifies i18n coverage but the regex matching is loose (counts any line containing the key name). |
| 78 | main.js defines showAuthPrompt function | Function existence check | **Weak** | Covered by import resolution tests. |
| 79 | main.js stores _rawSupabaseAdapter before wrapping | Single assignment check | **Adequate** | Tests a specific architectural decision. |
| 80 | main.js shows auth prompt for unauthenticated users | Checks removal of skip option + mandatory auth | **Strong** | Tests a security decision (auth is mandatory since 1.300) with 3 assertions. |

### Sharing UI & Security (Tests 81–90)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 81 | sharing-ui.js updateSharingNavVisibility shows for supabase mode | Single string check | **Weak** | Very narrow. |
| 82 | sharing-ui.js renderSharingPane has inline auth prompt | Checks CSS class and buildAuthSteps call | **Adequate** | Tests UI structure. |
| 83 | sharing-ui.js renderSharingPane shows signed-in badge | Checks badge class and sign-out reference | **Adequate** | Tests UI structure. |
| 84 | window.sendAuthFromSharing and signOutFromSharing exposed | Two window assignment checks | **Weak** | Already covered by test 4 (all window.fn checks). |
| 85 | Setup guide mentions Site URL | Single string check in HTML | **Weak** | Extremely narrow. Would pass if "Site URL" appeared in a comment. |

### Security: Credential Storage (Tests 86–90)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 86 | utils.js exports getSupabaseKeyRole and isServiceRoleKey | Checks function exports + prefix checks | **Adequate** | Tests security helper existence. |
| 87 | main.js saveStayConnectedCreds strips key for local/demo/drive | Checks key stripping + service_role rejection | **Strong** | Tests a security-critical credential handling path. |
| 88 | main.js doLogin rejects service_role before connect | Checks ordering of service_role check before connect | **Strong** | Tests a security gate with ordering assertion. |
| 89 | state.js STAY_CONNECTED_KEY has security comment | Checks for documentation comment | **Weak** | Testing for a comment doesn't prevent bugs. |
| 90 | drive.js token scoped by clientId and dedup pending promise | 8 assertions about token scoping and cleanup | **Strong** | Thorough security-focused test of token management. |
| 91 | drive.js clearDriveTokenCache clears all scoped tokens | Checks iteration over prefixed keys | **Adequate** | Tests the cleanup path. |

### CODEMAP (Tests 92–95)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 92 | .agents/CODEMAP.json exists and is valid JSON | Structural validation | **Strong** | Tests existence, parse, required keys, tier. |
| 93 | .agents/CODEMAP.json size is < 100KB | Size bounds check | **Adequate** | Good guardrail but arbitrary thresholds. |
| 94 | CODEMAP features include all 8 core features | Checks 8 features with entry, depends_on, dependents | **Strong** | Comprehensive structural validation. |
| 95 | CODEMAP core includes adapters and critical modules | Checks 8 core modules + 5 adapters | **Adequate** | Good coverage but looser assertions. |
| 96 | CODEMAP freshness: committed JSON matches regenerated output | Regenerates and checks non-empty | **Weak** | The freshness check is acknowledged as incomplete in the comment. It regenerates (overwriting the file) then just checks it's non-empty. A real freshness test would compare before/after. |

### Sharing Interface Conformance (Tests 97–~160)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| 97 | sharing-interface.js exports non-empty SHARING_INTERFACE | Counts interface keys ≥ 30 | **Strong** | Guards against interface erosion. |
| 98–~130 | supabase adapter exports: `<key>` (one per interface key) | Each interface key exists in Supabase adapter return block | **Strong** | Automated parity testing. Each test is a focused assertion. Excellent pattern for interface conformance. |
| ~131–~160 | drive adapter exports: `<key>` (one per interface key) | Each interface key exists in Drive adapter object literal | **Strong** | Same quality as above. Cross-adapter parity enforcement. |

### Integration Tests (Playwright, ~30 tests, skipped in CI)

| # | Name | What it tests | Rating | Reason |
|---|---|---|---|---|
| I-1 to I-3 | Initial state assertions (Alpha/Beta/Gamma projects) | Seed data rendered correctly | **Strong** | E2E verification of data → DOM rendering. |
| I-4 | Archived project disappears from main grid | Archive → DOM removal | **Strong** | Tests real UI behavior. |
| I-5 | Archived section visible after toggle | Toggle → display change | **Adequate** | Simple but effective. |
| I-6 to I-8 | Remaining cards render after deleting archived project | Archive → delete → surviving cards intact | **Strong** | Tests the exact regression the test was written for. |
| I-9 | No JS errors during archive+delete flow | Error collector | **Strong** | Catches any runtime errors during the flow. |
| I-10 to I-16 | TODO priority: DB accepts/reads each level, sort order, colors, icons | Full priority feature validation | **Strong** | Comprehensive CRUD + sort + visual tests. |
| I-17 to I-27 | Import flashcards: existing deck, new deck, text import, language prompts, invalid JSON, review exclude/edit, zero decks | Full import workflow validation | **Strong** | Very thorough E2E coverage of a complex multi-step feature. |
| I-28 | All JS modules load without errors | Browser smoke test | **Strong** | Catches import/syntax errors that static analysis might miss. |

---

## Summary

### Count by Rating

| Rating | Count | % |
|---|---|---|
| **Strong** | 114 | 64% |
| **Adequate** | 40 | 22% |
| **Weak** | 14 | 8% |
| **Redundant** | 1 | <1% |
| **Wrong** | 0 | 0% |
| **Integration (Strong)** | ~30 | (skipped in CI) |

*Note: The ~60 sharing interface conformance tests (supabase + drive adapter key checks) are counted individually as Strong.*

### Top 5 Gaps: Important Things NOT Tested

1. **No unit tests for business logic functions.** All tests are static analysis (grep/regex) or integration (Playwright). There are zero tests that import a function, call it with inputs, and check outputs. Functions like `retrievability()`, `fsrsUpdate()`, `normalizeHabitNextDue()`, `formatFrequency()`, `renderMd()`, `esc()`, `isStructuredRule()` are tested only by checking they *exist* in source, never by verifying they *compute correctly*. A pure-logic unit test for `renderMd()` with XSS edge cases would be far more valuable than checking `renderMd` appears in a file.

2. **No adapter conformance tests with mock data.** The adapter pattern (Supabase/REST/Demo/Drive/offline-cache) is never tested with actual CRUD operations through the adapter interface. Tests only check that functions exist. A test that creates a demo adapter, inserts a row, reads it back, and verifies the result would catch real adapter bugs.

3. **No offline-cache behavior tests.** The offline cache wraps any adapter but has zero test coverage. Cache invalidation, stale reads, dirty table tracking, ETag conflict handling — all untested.

4. **No i18n coverage tests.** Tests check that *some* keys exist in 3 languages but don't verify key *parity* — that every EN key has a FR and ES equivalent. Missing translations would show raw keys to users.

5. **No migration execution tests.** Migration *files* are checked for existence, and migration *SQL* is checked for expected statements, but no test actually *runs* a migration against a test database and verifies the schema change. The Drive migration runner (dirty-flush, progress bar) is completely untested.

### Top 5 Weakest Tests (Rewrite or Drop)

1. **Test 14 — "All modal overlay IDs have corresponding close handlers"**: The assertion is never executed. The `hasClose` variable is computed but never passed to `assert()`. This test always passes regardless of the codebase state. **Should be fixed or dropped.**

2. **Test 17 — "No stray console.log"**: Only warns, never fails. A test that can't fail is not a test. **Should either fail on console.log (with an allowlist) or be removed.**

3. **Test 96 — "CODEMAP freshness"**: Acknowledged as incomplete in its own comments. Overwrites the file then checks it's non-empty, which always passes. The real freshness check (diff before/after) is not implemented. **Should be rewritten to actually compare.**

4. **Test 69 — "No HTML entities in new JS files"**: Scans only `auth.js` and `sharing-supabase.js` — a strict subset of what test 1 already covers for *all* JS files. **Redundant, should be dropped.**

5. **Test 20 — "Flashcard deck rendering sorts cards by retrievability"**: Only checks that two strings (`cards.sort(` and `retrievability(`) exist *somewhere* in the file. They could be in separate, unrelated functions and the test would still pass. **Should be rewritten to verify they're in the same code block, or replaced with a unit test of the sort.**

### Tests That Are Outright Wrong or Misleading

**None are outright wrong**, but test 14 (modal close handlers) is effectively a no-op — it gives the false impression of coverage while asserting nothing.

### Overall Assessment

The suite is **unusually strong for a no-framework test harness**. The static analysis approach is well-suited to a no-build ESM app where import/export resolution and cross-file invariants are the primary risk. The sharing interface conformance tests (auto-generating one test per interface key × 2 adapters) are an excellent pattern.

The main structural weakness is the **complete absence of unit tests for pure functions**. Adding even 20 unit tests for core logic (`esc`, `renderMd`, `retrievability`, `fsrsUpdate`, `formatFrequency`, `normalizeHabitNextDue`, `isStructuredRule`, `balanceGrid`, `truncateWithShowMore`) would significantly improve confidence in correctness, not just structural integrity.
