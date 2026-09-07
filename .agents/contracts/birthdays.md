# Birthdays — Feature Contract

## Purpose
Birthday reminders with avatar photos, crop modal, month-section navigation, inline editing, and search/filter.

User jobs:
- add birthday with name, date, avatar photo (crop/pan/zoom)
- see upcoming birthdays sorted into month sections with hue-gradient nav
- search by name, filter by upcoming/this month
- inline edit name, date, note

## Entry & Ownership
- **Entry:** `js/birthdays.js`
- **State:** see `CODEMAP.json:features[birthdays]` for current loc, esc_count, i18n_count, state, guards
- **Tables:** `birthdays`

## Dependencies
- **Depends on:** `i18n`, `icons`, `item-utils`, `state`, `utils`
- **Dependents:** `main.js`

## UI / UX
- **Reused components:** `.page-empty-state`, `.modal`, `.project-card`, `.bucket-item`, `.category-nav-btn`, toast
- **Avatar:** interactive crop modal with drag/pan/zoom, 384px resolution, migration `003_birthday_avatars.sql`
- **Month sections:** birthdays grouped into "Coming Up" (next 30 days) + per-month sections, each with a hue-rotated `--cat-color`, nav buttons scroll to section
- **Inline edit:** `inlineEditText` for name, with inline date and note edit rows as extras
- **Empty state:** shared class with Lucide gift icon + CTA
- **Search:** text search filters by name across all sections

## Interaction Guards
- **Modal saves:** `guard()` for `saveNewBirthday`, `saveEditBirthday`
- **Crop modal:** single-action save, disable until upload complete

## Security
- **XSS:** see CODEMAP for current esc_count — `name` and section keys wrapped in `esc()`
- Avatar handling: photos as data URLs, never innerHTML
- `showDeleteConfirm` via textContent

## i18n
- **Prefix:** `birthdays.` — see CODEMAP for current key count
- Date formatting via `t()` + locale, no hardcoded month names

## Business Invariants
- `birthdays` table: `name`, `birthday` (date), optional `avatar_url`, crop state held in modal UI (not persisted separately)
- Sort by next occurrence, not birth year
- "Coming Up" section: next 30 days; remaining birthdays grouped by calendar month
- Avatar crop persists at 384px resolution, centered
- Inline edit: save on Enter/confirm, cancel on blur (standard DeLaClaw inline edit UX)
- Filter `setBirthdayFilter` → affects list + Welcome

## Adapter & Backend
- Only `db.from('birthdays')`
- Offline-cache wraps; avatar binary not cached (fetch on demand)

## Sharing
- Private (birthdays not shared)

## Cross-Feature Edges
- Welcome aggregates upcoming birthdays (next 7 days)
- Changing avatar → verify Welcome birthday cards show new crop
- **Calendar sync**: birthdays participate in calendar sync as yearly recurring events (`RRULE:FREQ=YEARLY`). Delete, rename, and date changes trigger calendar event updates

## Risks / Gotchas
- Crop modal symmetric resize with custom grip — must preserve aspect
- SW cache must include avatar handling JS, else 404 on install
- esc_count is among the higher ones — easy to miss esc on new aggregated fields in section headers or nav buttons

## Test Hooks
- `bun tests/tests.js`: modal existence, esc usage, CODEMAP freshness
- Manual: add birthday with avatar, reload, verify crop persists
- Manual: inline edit name + date, confirm saves, blur cancels

## References
- `CODEMAP.json:features[birthdays]`
- Entry: `js/birthdays.js`, Migration: `migrations/003_birthday_avatars.sql`
