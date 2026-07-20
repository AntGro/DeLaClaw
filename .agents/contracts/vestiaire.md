# Vestiaire — Feature Contract

## Purpose
Wardrobe inventory tracker — items with brand, category, photos.

## Entry & Ownership
- **Entry:** `js/vestiaire.js` (904 LOC)
- **State:** `allVestiaire`, `currentView`, `db`, `demoMode`, `js`
- **Tables:** `vestiaire`, `settings` (category shortnames)
- **CODEMAP:** `features[vestiaire]` — loc 904, esc 21, i18n 49, guards []

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `state`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.bucket-card`, `.project-card`, empty-state
- **Categories:** shortnames DB-synced via `vest_category_shortnames` in `settings`
- **Empty state:** shared class with hanger icon + CTA
- **Photos:** avatar-like handling, drag-drop? via item-utils

## Interaction Guards
- **Modal saves:** `guard()` for `saveNewVestiaire`, `saveEditVestiaire`, `saveNewVestiaireCategory`, `saveEditVestiaireCategory`
- Category edit via modal, disable until fulfilled

## Security
- **XSS esc_count=21:** `brand`, `name`, `note` via `esc()`
- Photos not innerHTML

## i18n
- **Prefix:** `vestiaire.` — 49 keys EN/FR/ES

## Business Invariants
- `vestiaire` items: brand, category, size, color, etc.
- Category shortnames DB-synced, not hardcoded
- Demo mode: sandbox prevents real localStorage leaking (category duplication bug fixed May 31)

## Adapter & Backend
- Only `db.from('vestiaire')`
- Offline-cache wraps

## Sharing
- Private

## Cross-Feature Edges
- No Welcome aggregation (but vestiaire data available in state)

## Risks / Gotchas
- Category duplication on lang switch fixed via SW cache awareness — ensure SW caching doesn't serve stale JS
- Photo resolution handling

## Test Hooks
- `bun tests/tests.js`: esc usage, CODEMAP freshness
- Manual: add item with category, switch language, verify no duplicate category

## References
- `CODEMAP.json:features[vestiaire]`
- Entry: `js/vestiaire.js`

