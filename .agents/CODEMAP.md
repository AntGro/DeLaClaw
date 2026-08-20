# DeLaClaw CODEMAP — T2 enriched

> Generated 2026-08-20T09:34:16.937Z from 38 modules (v1.705). Total LOC 29914. Do not hand-edit.
> Source: `scripts/generate-codemap.js`

## How to use (AI agents)

1. Before editing a feature, read its entry here: `CODEMAP.json` → features[feature]
2. Check `depends_on` to reuse, `dependents` to assess blast radius, `tables` + `state` for data impact, `ui_components` for style reuse.
3. `welcome.js` aggregates all others — changes to any feature likely need welcome check.
4. Guards: if modifying interactive element, ensure `guard()` or `pendingSet` pattern per AGENTS.md 1.2.

## Features (8)

| Feature | LOC | Tables | State | Depends | Dependents | UI | Guards | esc | i18n |
|---------|-----|--------|-------|---------|------------|----|--------|-----|------|
| birthdays | 859 | birthdays | allBirthdays,currentView,db,js | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,empty-state,toast | - | 16 | 37 |
| flashcards | 2561 | flashcard_decks,flashcard_notes,flashcards,text_line_progress,texts | currentView,db,js | i18n,icons,item-utils,logo,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 81 | 141 |
| habits | 2674 | habit_categories,habit_completions,habits | _historyHabitId,allHabitCompletions,allHabits,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 54 | 89 |
| lists | 1312 | list_items,lists | allListItems,allLists,currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | pendingSet | 24 | 40 |
| projects | 1183 | projects,prompts,settings,tasks | PROJECTS,allTasks,archivedProjectIds,db,js,showArchived | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,btn,project-card,card-header,empty-state,toast | pendingSet | 37 | 66 |
| todos | 1562 | todo_categories,todos | currentView,db,js,sharing | i18n,icons,item-utils,sharing-ui,state,utils | main.js,welcome.js | page-empty-state,modal,btn,project-card,empty-state,toast | pendingSet | 31 | 66 |
| vestiaire | 927 | vestiaire,vestiaire_categories | allVestiaire,currentView,db,js | i18n,icons,item-utils,state,utils | main.js | page-empty-state,modal,bucket-card,btn,project-card,card-header,empty-state,toast | - | 22 | 54 |
| welcome | 839 | - | PROJECTS,allBirthdays,allHabitCompletions,allHabits,allVestiaire,archivedProjectIds,currentView,db | flashcards,habits,i18n,icons,item-utils,sharing-ui,state,todos,utils | main.js | modal,app-header,btn | pendingSet | 77 | 43 |

## Core modules (30)

| Module | LOC | Tables | Depends | Dependents | Risks |
|--------|-----|--------|---------|------------|-------|
| main | 4705 | daily_visits,nvidia_usage,projects,settings | ./migrations/supabase-migrations,agents-ui,backend-logos,birthdays | - | esc:49,guard+pendingSet,window:8 |
| i18n | 2253 | - |  | agents-ui.js,birthdays.js,demo-chooser.js,drive.js | pendingSet |
| sharing-drive | 1402 | - | sharing-envelope,utils | main.js,sharing.js | - |
| sharing-supabase | 1369 | habits,joined_groups,list_items,sharing_groups,sharing_items,sharing_members,todos | crypto-sync,sharing-envelope,utils | main.js | pendingSet |
| sharing-ui | 1213 | habit_categories,habit_completions,habits,joined_groups,list_items,todo_categories,todos | backend-logos,i18n,icons,sharing-envelope | habits.js,lists.js,main.js,todos.js | esc:41,pendingSet,window:8 |
| item-utils | 1156 | - | db,i18n,icons,utils | agents-ui.js,birthdays.js,demo-chooser.js,flashcards.js | - |
| utils | 935 | flashcards,settings,x | i18n,icons,state,version | - | esc:9,window:6 |
| drive | 856 | - | ../migrations/drive-migrations.js,./../migrations/drive-migrations,./i18n,demo | - | pendingSet |
| hero | 473 | - | logo,storm3d | main.js | - |
| demo-chooser | 459 | - | i18n,icons,utils | - | - |
| delegation | 429 | - |  | - | window:1 |
| offline-cache | 299 | - | ./state,state.js | main.js | - |
| crypto-sync | 297 | settings |  | sharing-supabase.js | - |
| demo | 293 | x |  | drive.js | - |
| auth | 264 | auth_email_guard,settings |  | - | - |
| logo | 257 | - |  | flashcards.js,hero.js,main.js | - |
| agents-ui | 229 | agent_grants | db,i18n,icons,state | main.js | esc:32,window:5 |
| icons | 208 | - |  | agents-ui.js,birthdays.js,demo-chooser.js,flashcards.js | - |
| storm3d | 185 | - |  | hero.js | - |
| rest | 154 | x |  | main.js | - |
| db | 128 | projects | db | agents-ui.js,db.js,item-utils.js,main.js | pendingSet |
| sharing-interface | 124 | - |  | sharing.js | - |
| sharing-envelope | 73 | - |  | sharing-drive.js,sharing-supabase.js,sharing-ui.js | - |
| sharing | 64 | - | sharing-drive,sharing-interface | - | - |
| state | 54 | - | db | agents-ui.js,birthdays.js,flashcards.js,habits.js | window:1 |
| supabase | 45 | - |  | - | - |
| backend-logos | 26 | - |  | main.js,sharing-ui.js | - |
| bootstrap | 26 | - |  | - | - |
| sw-register | 16 | - |  | - | - |
| version | 5 | - |  | main.js,utils.js | - |

## Tables → used by

| Table | Used by |
|-------|---------|
| birthdays | birthdays |
| daily_visits | main |
| flashcard_notes | flashcards |
| flashcards | flashcards, utils |
| habit_completions | habits, sharing-ui |
| habits | habits, sharing-supabase, sharing-ui |
| joined_groups | sharing-supabase, sharing-ui |
| list_items | lists, sharing-supabase, sharing-ui |
| lists | lists |
| nvidia_usage | main |
| projects | db, main, projects |
| prompts | projects |
| settings | auth, crypto-sync, main, projects, utils |
| sharing_groups | sharing-supabase |
| sharing_items | sharing-supabase |
| sharing_members | sharing-supabase |
| tasks | projects |
| text_line_progress | flashcards |
| texts | flashcards |
| todos | sharing-supabase, sharing-ui, todos |
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
