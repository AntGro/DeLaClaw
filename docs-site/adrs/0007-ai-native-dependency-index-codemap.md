# ADR 0007: AI-native dependency index (CODEMAP + feature contracts)

Date: 2026-08-21
Status: Accepted

## Context

DeLaClaw is a vanilla JS single-page app with no framework, no build step, and no TypeScript (ADR 0001). This means there is no built-in module graph — no TypeScript project references, no bundler dependency tree, no monorepo tool tracking cross-module relationships.

AI agents (Claude, Codex, Cursor, and others via delegated access per ADR 0004) edit the codebase directly. Before touching any file, an agent needs to know:

- What tables the module reads and writes
- Which modules depend on it (blast radius)
- What UI components it reuses
- What interaction guards it implements
- How many XSS-sensitive interpolations it contains
- What state it touches

Without a machine-readable index, every agent session starts with grep archaeology — scanning imports, searching for table names, tracing `window.*` assignments. This is slow, error-prone, and misses indirect dependencies.

Hand-maintained documentation drifts immediately. Proven empirically: an audit of all 11 feature contracts found every one had stale counts (LOC, esc_count, i18n_count), incorrect table references, and missing features — some within days of being written.

## Decision

### CODEMAP: auto-generated dependency index

An auto-generated JSON dependency index (`.agents/CODEMAP.json`) is the single source of truth for module-level structural facts. It is generated deterministically from source by `scripts/generate-codemap.js` — the index is a function of the code, not a document maintained alongside it.

**What it tracks per module:**

| Field | Purpose |
|---|---|
| `loc` | Lines of code |
| `tables` | Database tables read/written |
| `state` | State keys accessed |
| `depends_on` | Direct import dependencies |
| `dependents` | Reverse dependencies (blast radius) |
| `ui_components` | Reused CSS component classes |
| `i18n_prefix` | Internationalization key namespace |
| `guards` | Interaction guard patterns (guard/pendingSet) |
| `esc_count` | XSS-sensitive `esc()` interpolation count |
| `window_exposed` | Functions assigned to `window.*` |

These are the fields agents need to make safe, informed edits.

**Dual format — JSON + MD:**

- `CODEMAP.json` (~25KB) is machine-readable — agents parse it programmatically to check dependents, tables, and guards before editing.
- `CODEMAP.md` (~6KB) is a human-scannable matrix for quick visual reference.

Both are generated from the same script in the same pass, so the second format has zero additional maintenance cost.

**Enforcement:**

- Pre-commit hook regenerates both files and stages them, so the committed index always matches the code in that commit.
- `tests/tests.js` includes a CODEMAP freshness test — regenerates and diffs against the committed JSON. This catches cases where someone bypasses the hook (`--no-verify`).

**Impact analysis:**

`scripts/impact.js` reads staged diffs and CODEMAP `dependents` to suggest the `Checked:` trailer for commits. The pre-commit hook prints the suggestion; the commit-msg hook enforces the trailer format. This automates blast-radius awareness — changing `todos.js` surfaces that `welcome.js` and `main.js` are dependents and should be checked.

### Feature contracts: business invariants CODEMAP can't extract

Feature contracts (`.agents/contracts/*.md`) sit alongside CODEMAP and capture what static analysis cannot:

- Guard patterns and their rationale (why `_pendingTodoToggles` exists, what race it prevents)
- XSS-sensitive field lists (which user fields need `esc()`)
- Sharing semantics (what happens when a group is deleted, how items sync)
- Category cascade behavior (FK delete cascades, protected rows)
- Cross-feature edges (how Welcome aggregates from other features)
- Adapter constraints (what must stay backend-agnostic)

Contracts describe **what must stay true** (business invariants), not how the UI looks. UI details change frequently and belong in the code. Structural counts (LOC, esc_count, i18n_count) belong in CODEMAP — contracts reference CODEMAP for current stats rather than hardcoding numbers that drift.

**Rule:** before editing any `js/*.js`, agents MUST read `CODEMAP.json` for the relevant feature/core entry AND the matching contract if one exists.

## Consequences

- Positive: agents start every edit with full structural context — dependencies, blast radius, tables, guards, XSS surface — without manual archaeology
- Positive: auto-generation eliminates documentation drift for structural facts; pre-commit + test enforcement ensures the index is never stale
- Positive: contracts capture business invariants that survive code refactors, giving agents guardrails CODEMAP alone cannot provide
- Positive: impact analysis automates the "what else should I check" question via the `Checked:` trailer
- Positive: dual JSON+MD format serves both machine and human readers at zero extra cost
- Negative: `generate-codemap.js` must be maintained as the codebase evolves — new patterns (e.g. a new guard type) require script updates
- Negative: contracts require manual upkeep for business invariants; periodic audits are needed to catch drift (as this session demonstrated)
- Negative: pre-commit hook adds ~1s to every commit for regeneration

## Alternatives considered

- **JSDoc / TypeDoc** — rejected: documents individual functions, not cross-module relationships. Doesn't track tables, guards, blast radius, or XSS surface. Also requires a build step for TypeDoc (violates ADR 0001).
- **Monorepo tools (Nx, Turborepo)** — rejected: DeLaClaw is a single-page app in one directory, not a monorepo. These tools solve cross-package orchestration — overkill here, and they require a build step.
- **Hand-maintained dependency docs** — rejected: proven to drift within days. Every contract audited in this session had stale counts and missing features.
- **Inline code comments only** — rejected: scattered across files, no single queryable index, no blast-radius graph, no automated freshness enforcement.
- **Richer CODEMAP schema (merge contracts into JSON)** — rejected: business invariants are contextual and narrative ("this guard prevents a race when..."); they don't reduce well to JSON fields. The two-layer approach (structural facts in CODEMAP, invariants in contracts) plays to each format's strengths.
