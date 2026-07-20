# Birthdays — Feature Contract

## Purpose
Birthday reminders with avatar photos, crop modal, and upcoming list.

User jobs:
- add birthday with name, date, avatar photo (crop/pan/zoom)
- see upcoming birthdays sorted, avatar picker
- filter via view tabs

## Entry & Ownership
- **Entry:** `js/birthdays.js` (811 LOC)
- **State:** `allBirthdays`, `currentView`, `db`, `js`
- **Tables:** `birthdays`, `settings` (avatar crop metadata)
- **CODEMAP:** `features[birthdays]` — loc 811, esc 11, i18n 36, guards []

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `state`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, bucket layout
- **Avatar:** interactive crop modal drag/pan/zoom, 384px resolution, migration `003_birthday_avatars.sql`
- **Empty state:** shared class with Lucide gift icon + CTA
- **View tabs:** `.view-tab` uppercase + letter-spacing 0.14em, accent per tab via nth-child

## Interaction Guards
- **Modal saves:** `guard()` for `saveNewBirthday`, `saveEditBirthday`
- **Crop modal:** single-action save, disable until upload complete

## Security
- **XSS esc_count=11:** `name` wrapped in `esc()`
- Avatar handling: photos as data URLs / Supabase storage, never innerHTML
- `showDeleteConfirm` via textContent

## i18n
- **Prefix:** `birthdays.` — 36 keys EN/FR/ES
- Date formatting via `t()` + locale, no hardcoded month names

## Business Invariants
- `birthdays` table: `name`, `date` (MM-DD), optional `avatar_url`, crop metadata in `settings`
- Sort by next occurrence, not birth year
- Avatar crop persists resolution 384px, centered
- Filter `setBirthdayFilter` → affects list + Welcome

## Adapter & Backend
- Only `db.from('birthdays')`
- Offline-cache wraps; avatar binary not cached (fetch on demand)
- Migration `003_birthday_avatars.sql` not yet applied to prod Supabase (check)

## Sharing
- Private (birthdays not shared)

## Cross-Feature Edges
- Welcome aggregates upcoming birthdays (next 7 days)
- Changing avatar → verify Welcome birthday cards show new crop

## Risks / Gotchas
- Crop modal symmetric resize with custom grip — must preserve aspect
- SW cache must include avatar handling JS, else 404 on install

## Test Hooks
- `bun tests/tests.js`: modal existence, esc usage, CODEMAP freshness
- Manual: add birthday with avatar, reload, verify crop persists

## References
- `CODEMAP.json:features[birthdays]`
- Entry: `js/birthdays.js`, Migration: `migrations/003_birthday_avatars.sql`

