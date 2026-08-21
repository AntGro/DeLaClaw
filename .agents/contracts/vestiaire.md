# Vestiaire — Feature Contract

## Purpose
Wardrobe inventory tracker — items with brand, size, color, purchase status, organized by categories with search, filtering, cross-category drag, and inline editing.

User jobs:
- add wardrobe items with name, brand, size, color, notes
- organize items into categories
- track purchase status (tried / purchased / untracked) via click-to-cycle badge
- filter by purchase status
- drag items between categories
- reorder category nav buttons
- inline edit items (full fields or brand only)
- search across items
- manage categories (create, edit name/shortname/color, delete)

## Entry & Ownership
- **Entry:** `js/vestiaire.js`
- **State:** see `CODEMAP.json:features[vestiaire]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `vestiaire`, `vestiaire_categories`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils` (drag-drop + inline edit), `state`, `utils`
- **Dependents (blast radius):** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.bucket-card`, `.btn`, `.project-card`, `.card-header`, `.category-nav-btn`, `.empty-state`, toast
- **Filter tabs:** `setVestiaireFilter` — filter by purchase status: all, purchased (`achete`), tried (`essaye`), untracked
- **Search:** `filterVestiaire` / `vestSearchQuery` — filters across item names and brands; skips empty categories when searching
- **Category nav:** reorderable via long-press drag (`initNavBtnReorder`), `sort_order` persisted; displays shortname or name with item count and `--cat-color`
- **Cross-category drag:** `initItemDragDrop` with `crossContainerSelector: '.vestiaire-item-list'` — items draggable between categories, updates `category_id` FK and re-numbers `sort_order`
- **Inline edit:** `editVestiaireInline` — full inline editor (name + brand + size + color + notes on dblclick); `editVestiaireBrandInline` — brand-only quick edit
- **Purchase status badge:** click-to-cycle inline: `○` (none) → Tried → Purchased → none (`cycleVestiaireStatus`)
- **Copy link:** `copy-item-link` action for sharing item deep-links
- **Empty state:** shared `.page-empty-state` with hanger icon + CTA

## Interaction Guards
- **Guards:** none in vestiaire.js itself (CODEMAP guards=[])
- Modal saves (`saveNewVestiaire`, `saveEditVestiaire`, `saveNewVestiaireCategory`, `saveEditVestiaireCategory`) do not use `guard()` or pendingSets
- Delete via `showDeleteConfirm` → global `executeDeleteConfirm` guarded in `main.js`

## Security
- **XSS:** see CODEMAP for current esc_count — `brand`, `name`, `note`, `color`, `size` via `esc()`

## i18n
- **Prefix:** `vestiaire.` — see CODEMAP for current key count (EN/FR/ES)
- All UI via `t()`, no hardcoded strings

## Business Invariants

### Items
- Fields: `name`, `brand`, `size`, `color`, `purchase_status`, `notes`, `sort_order`, `category_id`
- `purchase_status ∈ {null, 'essaye', 'achete'}` — cycles via badge click
- `sort_order` monotonic per category
- New items inserted via modal with name, brand, size, color, notes

### Category CRUD
- `openAddVestiaireCategoryModal` / `saveNewVestiaireCategory` — create with name, shortname, color
- `openEditVestiaireCategoryModal` / `saveEditVestiaireCategory` — edit name, shortname, color
- `deleteVestiaireCategory` — deletes category (CASCADE deletes all its items)
- Shortnames live directly on `vestiaire_categories` rows as a `shortname` column
- Protected default row (`name=''`, `is_protected=1`) cannot be deleted
- `sort_order` on categories persisted and reorderable via nav button drag

## Adapter & Backend
- Only via `db.from('vestiaire')`, `db.from('vestiaire_categories')`
- Offline-cache wraps transparently

## Sharing
- Private — not sharing-enabled

## Cross-Feature Edges
- No Welcome aggregation

## Risks / Gotchas
- Category duplication on lang switch (fixed May 31) — root cause SW caching stale JS
- No guard() on modal saves — concurrent saves theoretically possible
- Cross-category drag updates `category_id` FK — must re-number `sort_order` in target
- Category cascade: deleting a category deletes all its items

## Test Hooks
- `bun tests/tests.js`: esc usage, CODEMAP freshness
- Manual: cycle purchase status, verify filter tabs reflect change
- Manual: drag item between categories, verify FK updated
- Manual: inline edit brand, verify persists on reload

## References
- `CODEMAP.json:features[vestiaire]`
- Entry: `js/vestiaire.js`
