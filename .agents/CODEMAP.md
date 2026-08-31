# DeLaClaw CODEMAP — T2 enriched

> Generated 2026-08-31T15:35:33.991Z from 39 modules (v1.895). Total LOC 32162. Do not hand-edit.
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
| flashcards | 2571 | flashcard_decks,flashcard_notes,flashcards,text_line_progress,texts | currentView,db,js | i18n,icons,item-utils,logo,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 81 | 140 |
| habits | 2757 | habit_categories,habit_completions,habits | _historyHabitId,allHabitCompletions,allHabits,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | calendar-sync.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 54 | 89 |
| lists | 1325 | list_items,lists | allListItems,allLists,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | pendingSet | 24 | 40 |
| projects | 1205 | projects,prompts,settings,tasks | PROJECTS,allTasks,archivedProjectIds,db,js,showArchived | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 37 | 62 |
| todos | 1609 | todo_categories,todos | currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | calendar-sync.js,main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 31 | 66 |
| vestiaire | 953 | vestiaire,vestiaire_categories | allVestiaire,currentView,db,js | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | - | 22 | 54 |
| welcome | 845 | - | PROJECTS,allBirthdays,allHabitCompletions,allHabits,allVestiaire,archivedProjectIds,currentView,db | flashcards,habits,i18n,icons,item-utils,sharing-ui,state,todos,utils | main.js | modal,app-header,btn | pendingSet | 77 | 43 |

## Core modules (31)

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
| main | 5139 | daily_visits,nvidia_usage,projects,settings | ./migrations/supabase-migrations,agents-ui,backend-logos,birthdays | - | esc:48,guard+pendingSet,window:8 |
| i18n | 2445 | - |  | agents-ui.js,birthdays.js,calendar-sync.js,demo-chooser.js | pendingSet |
| sharing-supabase | 1635 | habits,joined_groups,list_items,sharing_groups,sharing_items,sharing_members,todos | crypto-sync,i18n,sharing-envelope,utils | main.js | pendingSet |
| sharing-drive | 1402 | - | sharing-envelope,utils | main.js,sharing.js | - |
| sharing-ui | 1257 | habit_categories,habit_completions,habits,joined_groups,list_items,todo_categories,todos | backend-logos,i18n,icons,sharing-envelope | habits.js,lists.js,main.js,todos.js | esc:41,pendingSet,window:8 |
| item-utils | 1193 | - | db,i18n,icons,utils | agents-ui.js,birthdays.js,calendar-sync.js,demo-chooser.js | - |
| drive | 1101 | - | ../migrations/drive-migrations.js,./../migrations/drive-migrations,./i18n,demo | - | pendingSet |
| utils | 993 | flashcards,settings,x | i18n,icons,state,version | - | esc:9,window:6 |
| calendar-sync | 683 | birthdays,gcal_sync,habits,settings,todos | habits,i18n,icons,state | main.js | - |
| hero | 473 | - | logo,storm3d | main.js | - |
| demo-chooser | 459 | - | i18n,icons,utils | - | - |
| delegation | 432 | - |  | - | window:1 |
| demo | 303 | x |  | drive.js | - |
| offline-cache | 299 | - | ./state,state.js | main.js | - |
| crypto-sync | 297 | settings |  | sharing-supabase.js | - |
| auth | 264 | auth_email_guard,settings |  | - | - |
| logo | 257 | - |  | flashcards.js,hero.js,main.js | - |
| agents-ui | 229 | agent_grants | db,i18n,icons,state | main.js | esc:32,window:5 |
| icons | 210 | - |  | agents-ui.js,birthdays.js,calendar-sync.js,demo-chooser.js | - |
| storm3d | 185 | - |  | hero.js | - |
| rest | 162 | x |  | main.js | - |
| db | 131 | projects | db | agents-ui.js,db.js,item-utils.js,main.js | pendingSet |
| sharing-interface | 124 | - |  | sharing.js | - |
| sharing | 112 | - | sharing-drive,sharing-interface | - | - |
| sharing-envelope | 73 | - |  | sharing-drive.js,sharing-supabase.js,sharing-ui.js | - |
| state | 54 | - | db | agents-ui.js,birthdays.js,calendar-sync.js,flashcards.js | window:1 |
| supabase | 51 | - |  | - | - |
| backend-logos | 26 | - |  | main.js,sharing-ui.js | - |
| bootstrap | 26 | - |  | - | - |
| sw-register | 16 | - |  | - | - |
| version | 5 | - |  | main.js,utils.js | - |

## Tables → used by

| Table | Used by |
|-------|---------|
| birthdays | birthdays, calendar-sync |
| daily_visits | main |
| flashcard_notes | flashcards |
| flashcards | flashcards, utils |
| habit_completions | habits, sharing-ui |
| habits | calendar-sync, habits, sharing-supabase, sharing-ui |
| joined_groups | sharing-supabase, sharing-ui |
| list_items | lists, sharing-supabase, sharing-ui |
| lists | lists |
| nvidia_usage | main |
| projects | db, main, projects |
| prompts | projects |
| settings | auth, calendar-sync, crypto-sync, main, projects, utils |
| sharing_groups | sharing-supabase |
| sharing_items | sharing-supabase |
| sharing_members | sharing-supabase |
| tasks | projects |
| text_line_progress | flashcards |
| texts | flashcards |
| todos | calendar-sync, sharing-supabase, sharing-ui, todos |
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
