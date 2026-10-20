# DeLaClaw CODEMAP — T2 enriched

> Generated 2026-10-20T23:06:53.738Z from 50 modules (v2.25.4). Total LOC 36001. Do not hand-edit.
> Source: `scripts/generate-codemap.js`

## How to use (AI agents)

1. Before editing a feature, read its entry here: `CODEMAP.json` → features[feature]
2. Check `depends_on` to reuse, `dependents` to assess blast radius, `tables` + `state` for data impact, `ui_components` for style reuse.
3. `welcome.js` aggregates all others — changes to any feature likely need welcome check.
4. Guards: if modifying interactive element, ensure `guard()` or `pendingSet` pattern per AGENTS.md 1.2.

## Features (8)

| Feature | LOC | Tables | State | Depends | Dependents | UI | Guards | esc | i18n |
|---------|-----|--------|-------|---------|------------|----|--------|-----|------|
| birthdays | 562 | birthdays | allBirthdays,currentView,db,js | i18n,icons,state,utils | main.js | modal,btn,toast | - | 7 | 28 |
| flashcards | 2941 | flashcard_decks,flashcard_notes,flashcards,text_line_progress,texts | currentView,db,js,readOnlyMode | i18n,icons,item-utils,logo,scene-parse,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 91 | 152 |
| habits | 3741 | habit_categories,habit_completions,habits | _historyHabitId,allHabitCompletions,allHabits,currentView,db,js,markCalDirty,sharing | calendar-pure,frequency-rule,i18n,icons,item-utils,pending-next-due,sections-pure,sharing-ui,state,utils | calendar-sync.js,calendar.js,demo-chooser.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 60 | 136 |
| lists | 1879 | list_items,lists | allListItems,allLists,currentView,db,js,sharing | i18n,icons,item-utils,sections-pure,sharing-ui,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | pendingSet | 41 | 49 |
| projects | 1205 | projects,prompts,settings,tasks | PROJECTS,allTasks,archivedProjectIds,db,js,showArchived | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 37 | 62 |
| todos | 2515 | todo_categories,todos | currentView,db,js,markCalDirty,sharing,syncCalendarTable | i18n,icons,item-utils,sections-pure,sharing-ui,state,utils | calendar-sync.js,calendar.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 51 | 103 |
| welcome | 867 | - | PROJECTS,allBirthdays,allHabitCompletions,allHabits,archivedProjectIds,currentView,db,js | calendar-pure,flashcards,habits,i18n,icons,item-utils,sections-pure,sharing-ui,state,todos,utils | main.js | modal,app-header,btn | pendingSet | 83 | 47 |

## Core modules (43)

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
| main | 3960 | daily_visits,projects,settings | ./migrations/version-compare,agents-ui,backend-logos,birthdays | - | esc:8,guard+pendingSet,window:8 |
| sharing-drive | 2525 | groups | drive-folders,i18n,sharing-envelope,sharing-file-reconcile | main.js,sharing.js | - |
| i18n | 2448 | - |  | agents-ui.js,birthdays.js,calendar-sync.js,calendar.js | pendingSet |
| drive | 1548 | - | ../migrations/drive-migrations.js,../migrations/version-compare.js,./../migrations/drive-migrations,./../migrations/version-compare | - | pendingSet |
| item-utils | 1358 | - | db,i18n,icons,state | agents-ui.js,batch-import.js,birthdays.js,calendar-sync.js | - |
| sharing-ui | 1235 | habit_categories,habit_completions,habits,list_items,todo_categories,todos | backend-logos,i18n,icons,sharing-envelope | calendar.js,groups.js,habits.js,lists.js | esc:38,guard+pendingSet,window:8 |
| calendar-sync | 1203 | birthdays,gcal_sync,habits,settings,todos | calendar-pure,drive-folders,habits,i18n | main.js | - |
| utils | 995 | flashcards,x | i18n,icons,sections-pure,state | - | esc:7,window:6 |
| calendar | 662 | - | calendar-pure,habits,i18n,icons | main.js | esc:17,window:8 |
| batch-import | 559 | - | icons,import-pure,state,utils | - | esc:13 |
| delegation | 512 | - |  | - | window:1 |
| hero | 473 | - | logo,storm3d | main.js | - |
| demo-chooser | 464 | - | habits,i18n,icons,utils | - | - |
| offline-cache | 439 | - | ./i18n,./state,i18n.js,state.js | drive.js,main.js,sharing.js | - |
| sections-pure | 412 | - |  | calendar.js,habits.js,lists.js,todos.js | - |
| demo | 310 | x |  | drive.js | - |
| logo | 257 | - |  | flashcards.js,hero.js,main.js | - |
| sharing-file-reconcile | 217 | - |  | drive.js,sharing-drive.js | - |
| scene-parse | 215 | text_line_progress,texts |  | flashcards.js | - |
| icons | 212 | - |  | agents-ui.js,batch-import.js,birthdays.js,calendar-sync.js | - |
| calendar-pure | 207 | - |  | calendar-sync.js,calendar.js,habits.js,main.js | - |
| groups | 202 | - | i18n,icons,sharing-ui,state | main.js | esc:3,window:4 |
| agents-ui | 200 | agent_grants | db,i18n,icons,utils | main.js | esc:29,window:5 |
| storm3d | 185 | - |  | hero.js | - |
| sharing | 179 | - | offline-cache,sharing-drive,sharing-envelope,sharing-interface | - | - |
| rest | 162 | x |  | main.js | - |
| habit-import | 143 | - | frequency-rule,import-pure | - | - |
| sharing-interface | 135 | - |  | sharing.js | - |
| db | 131 | projects | db | agents-ui.js,db.js,item-utils.js,main.js | pendingSet |
| import-pure | 130 | - |  | batch-import.js,habit-import.js,todo-import.js | - |
| todo-import | 92 | - | import-pure | - | - |
| sharing-mutation-queue | 83 | - |  | sharing-drive.js | - |
| daily-visits | 77 | - |  | main.js | - |
| sharing-envelope | 67 | - |  | sharing-drive.js,sharing-ui.js,sharing.js | - |
| drive-backup-policy | 67 | - | ../migrations/version-compare.js,./../migrations/version-compare | drive.js | - |
| state | 51 | - | db | batch-import.js,birthdays.js,calendar-sync.js,calendar.js | window:1 |
| drive-folders | 43 | - |  | calendar-sync.js,drive.js,main.js,sharing-drive.js | - |
| frequency-rule | 33 | - |  | habit-import.js,habits.js | - |
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
| flashcards | flashcards, utils |
| groups | sharing-drive |
| habit_completions | habits, sharing-ui |
| habits | calendar-sync, habits, sharing-ui |
| list_items | lists, sharing-ui |
| lists | lists |
| projects | db, main, projects |
| prompts | projects |
| settings | calendar-sync, main, projects |
| tasks | projects |
| text_line_progress | flashcards, scene-parse |
| texts | flashcards, scene-parse |
| todos | calendar-sync, sharing-ui, todos |

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
