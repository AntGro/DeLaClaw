# AGENTS.md

Your operating manual for this workspace, written by you. Your main instructions cover how Hatch works in general. This file is where you keep the specific, durable lessons and conventions you pick up as you work, the kind of thing you'd want a future session to know. It's not about the user (that goes in `USER.md` and your memory) or your personality (that's `SOUL.md`); it's about how you get work done here.

## First Run
If `BOOTSTRAP.md` exists in your home directory, follow it to set yourself up, then delete it.

## Conventions
- **Supabase auth**: use the `anon_key` (`sb_publishable_*`) in BOTH `apikey:` and `Authorization: Bearer` headers. The `service_role_key` (`sb_secret_*`) doesn't resolve to a valid JWT in curl context. Confirmed working June 11, 2026.
- **DeLaClaw commit checklist**: before writing the `Checked:` line, review the staged diff and decide each item individually — no batch-marking in either direction. Three states: `[x]` = diff touches this area, `[~]` = diff doesn't touch this area, bare item (no marker) = not yet decided — hook must reject. Lesson from v1.145: `tests` and `xss` were left unmarked by inertia when neither was impacted.
- **DeLaClaw git hooks**: ALWAYS run `git config core.hooksPath .githooks` before committing to the DeLaClaw repo (`~/workspace/command-center`). Without this, the pre-commit (version bump, emoji lint) and commit-msg (checklist) hooks won't fire. This must be done on every fresh clone or subagent checkout. Discovered June 18, 2026 when a heartbeat commit bypassed all hooks.
- **Core UX principle — one click → disable until fulfilled**: Every action button (Mark done, toggle done, save, delete confirm) MUST disable itself on click until the async action resolves. Use `guard()` in `js/main.js` (disables + `saving`/`is-pending` + `aria-busy`) for modal saves, and per-ID pending Sets (`_pendingHabitDones`, `_pendingTodoToggles`, `_pendingTaskStatus`) for list items to allow concurrent different IDs but block double-click on same ID. Always pass `this` from onclick and add `data-*-id` attributes for queryability. Enforced from v1.346. See user request July 16 2026.

Add an entry whenever you work something out worth keeping, for example:
- a convention you've settled on ("keep data exports in `workspace/exports/` and clean them up monthly")
- a tool or site quirk worth remembering ("site X hides its form behind a cookie banner; dismiss it first")
- a workflow that worked, or a mistake not to repeat

It starts empty and is meant to grow slowly. Don't pad it; a short, accurate file beats a long, stale one.
