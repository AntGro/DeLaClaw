# ADR 0003: Interaction guards for idempotent UI actions

Date: 2026-07-20
Status: Accepted

## Context

DeLaClaw mutates data in place (toggle TODO DONE, mark habit DONE, approve task, save modals). Users sometimes click the same action multiple times. Because network operations (Supabase + offline-cache + Drive) can be slow, the same action may execute multiple times before the first promise settles.

Observed bugs before guards: duplicate tasks, double-toggle creating two completions, modal save inserting twice.

## Decision

All mutating UI actions MUST be guarded against duplicate invocation until the associated asynchronous operation settles (success or failure).

Implementation:

- Modal saves use `guard()` in `js/main.js`, which:
  - returns immediately if already pending;
  - sets `disabled`, `saving` / `is-pending`, and `aria-busy`;
  - clears the pending state in `finally`.
- List actions use per-ID pending `Set`s (`window._pendingHabitDones`, `_pendingTodoToggles`, `_pendingTaskStatus`):
  - different IDs may execute concurrently;
  - repeated actions for the same ID are ignored;
  - pattern: `onclick="fn(id,this)"` + `data-*-id` attribute for queryability.
- Delete confirmation (`executeDeleteConfirm`) uses the same guard pattern and `textContent` (safe).

Enforced from v1.346, verified by `tests/tests.js` which checks for guard usage and pendingSet existence.

## Consequences

- Positive: no duplicate inserts/toggles, no UI jitter, accessible (`aria-busy`), concurrent different IDs still allowed
- Negative: every new mutating action must implement the guard pattern; automated tests enforce this requirement
- Neutral: adds ~3 lines per action but prevents whole class of race conditions

## Alternatives considered

- Debounce/throttle — rejected: hides race, does not prevent second insert if first is slow
- Disable whole UI — rejected: blocks concurrent different IDs, poor UX
- Rely on DB unique constraints — rejected: not all tables have natural uniqueness, UX still flashes duplicate
