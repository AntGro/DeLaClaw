# ADR 0010: Nested sections for category trees

Date: 2026-10-23 (decided and shipped October 2026, v2.23–v2.25)
Status: Accepted — extends ADR 0008

## Context

Categories (ADR 0008) organise items into flat buckets on the TODOs, Habits and Lists pages. Flat lists stop working once a user has many buckets: there is no way to group "Reading" buckets under one heading and "Admin" buckets under another. Users improvised hierarchy in bucket names, which sorts badly and means nothing to the app.

The options were a folder-style drill-down (open one group at a time) or a visible tree. Drill-down was rejected: the pages' value is seeing everything at once, and hiding buckets behind navigation breaks the drag-and-drop and scanning behaviour the pages are built on.

## Decision

Sections are real objects in the existing category tables, not a naming convention:

- Category rows in `todo_categories`, `habit_categories` and `lists` carry `kind` — `'bucket'` (holds items) or `'section'` (holds buckets and sub-sections, never items directly) — and `parent_id`, the containing section's id or null at the top level.
- `parent_id` is a plain column, deliberately **not** a foreign key, so backup restore never needs topological ordering.
- Each row stores only its own name segment; the full path ("Reading > Fiction") is derived from the parent chain and is how users write nesting when naming. Names are unique per parent across both kinds (case-insensitive), and `sort_order` is per sibling group.
- Converting a bucket into a section moves its items into a new `*` bucket inside it. Deleting a non-empty section asks: delete the whole subtree, or move its children up one level.
- All sections are visible at once; every level is laid out as its own grid. All tree, path and layout logic lives in `js/sections-pure.js` and nowhere else.
- Sections are purely local: they are never shared to a group (sharing stays per bucket, ADR 0005), and renaming or moving a section never affects Google Calendar sync, whose event titles use bucket names only.

## Consequences

- Positive: real hierarchy on all three pages with one shared model and one shared pure-logic module — no per-page variants.
- Positive: buckets keep every existing behaviour (sharing, sync, drag-and-drop); sections only add structure around them.
- Negative: the category schema and every category surface (pickers, chips, drag-and-drop, delete flows) had to learn a second row kind; conversion between kinds needs a checked, rollback-capable migration path because a half-converted category would hide its items.
- Neutral: the vestiaire category tables that ADR 0008 listed are gone — the wardrobe migration (2.9.17) moved wardrobe content into Lists, where it now lives as a section containing one list per former category.

## Alternatives considered

- Drill-down folders — rejected: hides buckets, breaks the see-everything page model.
- Path-prefix naming on flat buckets (display-only grouping) — rejected: grouping would be cosmetic; ordering, deletion and conversion semantics would stay ambiguous.
- A separate sections table — rejected: two sources of truth for ordering and naming; the kind column keeps one row space per page, which the per-parent name uniqueness rule relies on.
