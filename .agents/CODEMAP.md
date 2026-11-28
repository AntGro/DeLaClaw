# DeLaClaw CODEMAP — T2 enriched

> Generated 2026-11-28T10:15:57.243Z from 50 modules (v2.32.201). Total LOC 41106. Do not hand-edit.
> Source: `scripts/generate-codemap.js`

## How to use (AI agents)

1. Before editing a feature, read its entry here: `CODEMAP.json` → features[feature]
2. Check `depends_on` to reuse, `dependents` to assess blast radius, `tables` + `state` for data impact, `ui_components` for style reuse.
3. `welcome.js` aggregates all others — changes to any feature likely need welcome check.
4. Guards: if modifying interactive element, ensure `guard()` or `pendingSet` pattern per AGENTS.md 1.2.

## Features (8)

| Feature | LOC | Tables | State | Depends | Dependents | UI | Guards | esc | i18n |
|---------|-----|--------|-------|---------|------------|----|--------|-----|------|
| birthdays | 608 | birthdays | allBirthdays,currentView,db,js | calendar-pure,i18n,icons,state,utils | main.js | modal,btn,toast | - | 9 | 31 |
| flashcards | 4603 | flashcard_decks,flashcard_notes,flashcards,settings,text_line_progress,texts | currentView,db,js,readOnlyMode | i18n,icons,item-utils,logo,scene-parse,sections-pure,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 138 | 191 |
| habits | 3714 | habit_categories,habit_completions,habits | _historyHabitId,allHabitCompletions,allHabits,currentView,db,driveAdapter,js,markCalDirty | attachments,calendar-pure,frequency-rule,i18n,icons,item-utils,pending-next-due,sections-pure,sharing-ui,state,utils | calendar-sync.js,calendar.js,demo-chooser.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 62 | 138 |
| lists | 2048 | list_items,lists | allListItems,allLists,currentView,db,driveAdapter,js,sharing | attachments,i18n,icons,item-utils,sections-pure,sharing-ui,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | pendingSet | 42 | 51 |
| todos | 2808 | todo_categories,todos | currentView,db,driveAdapter,js,markCalDirty,sharing,syncCalendarTable | attachments,calendar-pure,i18n,icons,item-utils,sections-pure,sharing-ui,state,utils | calendar-sync.js,calendar.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 57 | 108 |
| welcome | 844 | - | allBirthdays,allHabitCompletions,allHabits,currentView,db,js,sharing | attachments,calendar,calendar-pure,flashcards,habits,i18n,icons,item-utils,sections-pure,sharing-ui,state,todos,utils | main.js | modal,app-header,btn | pendingSet | 85 | 52 |

## Core modules (44)

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
| main | 4144 | daily_visits,settings,todos | ./migrations/version-compare,agents-ui,backend-logos,birthdays | - | esc:12,guard+pendingSet,window:8 |
| sharing-drive | 2735 | groups | drive-folders,i18n,sharing-envelope,sharing-file-reconcile | main.js,sharing.js | - |
| i18n | 2600 | - |  | agents-ui.js,attachments.js,birthdays.js,calendar-sync.js | pendingSet |
| drive | 2063 | - | ../migrations/drive-migrations.js,../migrations/version-compare.js,./../migrations/drive-migrations,./../migrations/version-compare | - | pendingSet |
| item-utils | 1691 | - | db,i18n,icons,state | agents-ui.js,attachments.js,batch-import.js,birthdays.js | - |
| sharing-ui | 1287 | events,habit_categories,habit_completions,habits,list_items,todo_categories,todos | attachments,backend-logos,i18n,icons | calendar.js,events.js,groups.js,habits.js | esc:38,guard+pendingSet,window:8 |
| calendar-sync | 1269 | birthdays,events,gcal_sync,habits,settings,todos | calendar-pure,drive-folders,habits,i18n | main.js | - |
| utils | 1064 | flashcards,x | calendar-pure,i18n,icons,sections-pure | - | esc:8,window:6 |
| calendar | 1056 | - | attachments,calendar-pure,habits,i18n | main.js,welcome.js | esc:26,window:8 |
| events | 845 | events | attachments,calendar-pure,i18n,icons | main.js | esc:20,pendingSet,window:8 |
| attachments | 586 | - | i18n,icons,state,utils | calendar.js,events.js,habits.js,lists.js | esc:15,pendingSet |
| sections-pure | 570 | flashcard_decks,flashcards,texts |  | calendar.js,flashcards.js,habits.js,lists.js | - |
| batch-import | 564 | - | calendar-pure,icons,import-pure,state | - | esc:14 |
| delegation | 546 | - |  | - | window:1 |
| calendar-pure | 500 | - |  | batch-import.js,birthdays.js,calendar-sync.js,calendar.js | - |
| demo-chooser | 488 | - | calendar-pure,habits,i18n,icons | - | - |
| hero | 448 | - | logo | main.js | - |
| offline-cache | 439 | - | ./i18n,./state,i18n.js,state.js | drive.js,main.js,sharing.js | - |
| scene-parse | 403 | text_line_progress,texts |  | flashcards.js | - |
| demo | 355 | x | ../migrations/drive-migrations.js,../migrations/version-compare.js,./../migrations/drive-migrations,./../migrations/version-compare | drive.js | - |
| logo | 257 | - |  | flashcards.js,hero.js,main.js | - |
| frequency-rule | 231 | - | calendar-pure | habit-import.js,habits.js | - |
| icons | 218 | - |  | agents-ui.js,attachments.js,batch-import.js,birthdays.js | - |
| sharing-file-reconcile | 217 | - |  | drive.js,sharing-drive.js | - |
| groups | 214 | - | i18n,icons,sharing-ui,state | main.js | esc:3,window:4 |
| agents-ui | 207 | agent_grants | db,i18n,icons,state | main.js | esc:31,window:5 |
| sharing | 185 | - | offline-cache,sharing-drive,sharing-envelope,sharing-interface | - | - |
| rest | 162 | x |  | main.js | - |
| habit-import | 143 | - | frequency-rule,import-pure | - | - |
| sharing-interface | 142 | - |  | sharing.js | - |
| import-pure | 135 | - |  | batch-import.js,habit-import.js,todo-import.js | - |
| db | 131 | todos | db | agents-ui.js,db.js,item-utils.js,main.js | pendingSet |
| todo-import | 94 | - | import-pure | - | - |
| sharing-mutation-queue | 83 | - |  | sharing-drive.js | - |
| daily-visits | 77 | - |  | main.js | - |
| sharing-envelope | 67 | - |  | sharing-drive.js,sharing-ui.js,sharing.js | - |
| drive-backup-policy | 67 | - | ../migrations/version-compare.js,./../migrations/version-compare | drive.js | - |
| state | 55 | - | db | agents-ui.js,attachments.js,batch-import.js,birthdays.js | window:1 |
| drive-folders | 43 | - |  | calendar-sync.js,drive.js,main.js,sharing-drive.js | - |
| pending-next-due | 32 | - |  | habits.js | - |
| bootstrap | 26 | - |  | - | - |
| backend-logos | 23 | - |  | main.js,sharing-ui.js | - |
| sw-register | 16 | - |  | - | - |
| version | 3 | - |  | utils.js | - |

## Tables → used by

| Table | Used by |
|-------|---------|
| birthdays | birthdays, calendar-sync |
| daily_visits | main |
| flashcard_notes | flashcards |
| flashcards | flashcards, sections-pure, utils |
| groups | sharing-drive |
| habit_completions | habits, sharing-ui |
| habits | calendar-sync, habits, sharing-ui |
| list_items | lists, sharing-ui |
| lists | lists |
| projects | - |
| prompts | - |
| settings | calendar-sync, flashcards, main |
| tasks | - |
| text_line_progress | flashcards, scene-parse |
| texts | flashcards, scene-parse, sections-pure |
| todos | calendar-sync, db, main, sharing-ui, todos |

## Adapters

All business logic talks to `db.js` proxy. Implementations in `js/adapters/` must expose `from(table).select/insert/update/delete`.

- rest.js: Bun+SQLite REST
- demo.js: in-memory (seeded)
- drive.js: in-memory + Drive JSON persistence
- offline-cache.js: wraps any adapter, IndexedDB

## CSS registry (reusable)

- view-tab, page-empty-state, modal, settings-data-btn, bucket-card, usage-stats-container, app-header, search-wrap, btn, project-card, card-header, card-body, empty-state, toast, pill

## Freshness

- Pre-commit: regenerates JSON+MD, fails if not staged
- Test: `bun tests/tests.js` asserts JSON is up-to-date (soon)
