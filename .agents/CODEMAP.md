# DeLaClaw CODEMAP — T2 enriched

> Generated 2026-09-07T00:10:29.505Z from 35 modules (v2.0.9). Total LOC 27883. Do not hand-edit.
> Source: `scripts/generate-codemap.js`

## How to use (AI agents)

1. Before editing a feature, read its entry here: `CODEMAP.json` → features[feature]
2. Check `depends_on` to reuse, `dependents` to assess blast radius, `tables` + `state` for data impact, `ui_components` for style reuse.
3. `welcome.js` aggregates all others — changes to any feature likely need welcome check.
4. Guards: if modifying interactive element, ensure `guard()` or `pendingSet` pattern per AGENTS.md 1.2.

## Features (8)

| Feature | LOC | Tables | State | Depends | Dependents | UI | Guards | esc | i18n |
|---------|-----|--------|-------|---------|------------|----|--------|-----|------|
| birthdays | 861 | birthdays | allBirthdays,currentView,db,js | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,empty-state,toast | - | 16 | 37 |
| flashcards | 2577 | flashcard_decks,flashcard_notes,flashcards,text_line_progress,texts | currentView,db,js | i18n,icons,item-utils,logo,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 82 | 140 |
| habits | 2759 | habit_categories,habit_completions,habits | _historyHabitId,allHabitCompletions,allHabits,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | calendar-sync.js,demo-chooser.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 54 | 89 |
| lists | 1325 | list_items,lists | allListItems,allLists,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | pendingSet | 24 | 40 |
| projects | 1205 | projects,prompts,settings,tasks | PROJECTS,allTasks,archivedProjectIds,db,js,showArchived | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 37 | 62 |
| todos | 1646 | todo_categories,todos | currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | calendar-sync.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 31 | 68 |
| vestiaire | 953 | vestiaire,vestiaire_categories | allVestiaire,currentView,db,js | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | - | 22 | 54 |
| welcome | 854 | - | PROJECTS,allBirthdays,allHabitCompletions,allHabits,allVestiaire,archivedProjectIds,currentView,db | flashcards,habits,i18n,icons,item-utils,sharing-ui,state,todos,utils | main.js | modal,app-header,btn | pendingSet | 79 | 44 |

## Core modules (27)

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
| main | 3607 | daily_visits,projects,settings | ./migrations/version-compare,backend-logos,birthdays,calendar-sync | - | esc:8,guard+pendingSet,window:8 |
| i18n | 2067 | - |  | birthdays.js,calendar-sync.js,demo-chooser.js,drive.js | pendingSet |
| sharing-drive | 1402 | - | sharing-envelope,utils | main.js,sharing.js | - |
| sharing-ui | 1220 | habit_categories,habit_completions,habits,joined_groups,list_items,todo_categories,todos | backend-logos,i18n,icons,sharing-envelope | habits.js,lists.js,main.js,todos.js | esc:38,pendingSet,window:8 |
| item-utils | 1209 | - | db,i18n,icons,utils | birthdays.js,calendar-sync.js,demo-chooser.js,flashcards.js | - |
| drive | 1102 | - | ../migrations/drive-migrations.js,../migrations/version-compare.js,./../migrations/drive-migrations,./../migrations/version-compare | - | pendingSet |
| utils | 830 | flashcards,x | i18n,icons,state,version | - | esc:7,window:6 |
| calendar-sync | 694 | birthdays,gcal_sync,habits,settings,todos | habits,i18n,icons,state | main.js | - |
| hero | 473 | - | logo,storm3d | main.js | - |
| demo-chooser | 464 | - | habits,i18n,icons,utils | - | - |
| delegation | 422 | - |  | - | window:1 |
| demo | 303 | x |  | drive.js | - |
| offline-cache | 281 | - | ./state,state.js | main.js | - |
| crypto-sync | 265 | settings |  | - | - |
| logo | 257 | - |  | flashcards.js,hero.js,main.js | - |
| icons | 210 | - |  | birthdays.js,calendar-sync.js,demo-chooser.js,flashcards.js | - |
| storm3d | 185 | - |  | hero.js | - |
| rest | 162 | x |  | main.js | - |
| db | 131 | projects | db | db.js,item-utils.js,main.js,state.js | pendingSet |
| sharing-interface | 124 | - |  | sharing.js | - |
| sharing | 100 | - | sharing-drive,sharing-interface | - | - |
| sharing-envelope | 73 | - |  | sharing-drive.js,sharing-ui.js | - |
| state | 52 | - | db | birthdays.js,calendar-sync.js,flashcards.js,habits.js | window:1 |
| bootstrap | 26 | - |  | - | - |
| backend-logos | 23 | - |  | main.js,sharing-ui.js | - |
| sw-register | 16 | - |  | - | - |
| version | 5 | - |  | utils.js | - |

## Tables → used by

| Table | Used by |
|-------|---------|
| birthdays | birthdays, calendar-sync |
| daily_visits | main |
| flashcard_notes | flashcards |
| flashcards | flashcards, utils |
| habit_completions | habits, sharing-ui |
| habits | calendar-sync, habits, sharing-ui |
| joined_groups | sharing-ui |
| list_items | lists, sharing-ui |
| lists | lists |
| projects | db, main, projects |
| prompts | projects |
| settings | calendar-sync, crypto-sync, main, projects |
| tasks | projects |
| text_line_progress | flashcards |
| texts | flashcards |
| todos | calendar-sync, sharing-ui, todos |
| vestiaire | vestiaire |

## Adapters

All business logic talks to `db.js` proxy. Implementations in `js/adapters/` must expose `from(table).select/insert/update/delete`.

- supabase.js: PostgREST + Realtime + auth
- rest.js: Bun+SQLite REST
- demo.js: in-memory (seeded)
- drive.js: in-memory + Drive JSON persistence
- offline-cache.js: wraps any adapter, IndexedDB

## CSS registry (reusable)

- view-tab, page-empty-state, modal, settings-data-btn, bucket-card, usage-stats-container, app-header, search-wrap, btn, project-card, card-header, card-body, empty-state, toast, pill

## Freshness

- Pre-commit: regenerates JSON+MD, fails if not staged
- Test: `bun tests/tests.js` asserts JSON is up-to-date (soon)
