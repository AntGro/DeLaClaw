# Sync Architecture — In-Memory / Google Drive / Google Calendar

DeLaClaw's Google Drive backend is **local-first**: all reads and writes hit an in-memory store instantly. Two asynchronous layers persist and synchronize that data: **Google Drive** (durable storage) and **Google Calendar** (read-only projection of TODOs, habits, and birthdays).

## Data Flow Overview

```mermaid
flowchart TD
    subgraph Browser["Browser (in-memory)"]
        UI["UI Action<br/>(edit / delete / create)"]
        MEM["In-Memory Store<br/>(demo adapter engine)"]
        RENDER["Render"]
    end

    subgraph Drive["Google Drive"]
        DJSON["Per-table JSON files<br/>in DeLaClaw/ folder<br/>(DeLaClawDev/ on dev)"]
    end

    subgraph GCal["Google Calendar"]
        GCAL["DeLaClaw calendar<br/>(DeLaClawDev on dev)<br/>(events)"]
    end

    UI -->|"1. Instant write"| MEM
    MEM -->|"2. Re-render"| RENDER
    MEM -->|"3. scheduleSave(table)<br/>marks table dirty"| DEBOUNCE
    DEBOUNCE["Debounce timer<br/>(2s per table)"] -->|"4. flushTable()"| DJSON
    DJSON -->|"5. _onTableFlushed"| CALSYNC
    CALSYNC["syncCalendarTable()"] -->|"6. Push dirty items"| GCAL

    DJSON -->|"7. Poll every 30s<br/>(or on tab focus)"| POLL
    POLL["pollForChanges()"] -->|"8. If modifiedTime changed<br/>& table not dirty"| MEM
    MEM -->|"9. _onExternalChange<br/>→ refresh*()"| RENDER
```

## Startup / Connect Flow (target design — all phases)

What is fetched when the user connects, in order, drawn as columns so you can see
*where* each step reads from — including the **Page** column, which shows what is
rendered and when. Steps marked **planned** belong to phases 2–5 and are
not implemented yet; everything else is shipped on `dev`.
Names below are the Google implementation, but the shape is backend-agnostic: any
OAuth2 token issuer + file storage maps 1:1 (e.g. KDrive auth + KDrive folders).
The IndexedDB offline cache is not part of this flow — it only applies to
local-server mode, never to the Drive backend. The calendar is never read at
startup either: it is a write-only projection, synced on table flush.
**1** covers auth, **2** covers what happens at login right after auth (the
personal-data track, which loads the `joined_groups` table alongside the other
personal tables), and **3** covers the sharing startup track, which runs in
parallel with **2**. `loadAll()` reads the already-loaded pointers and runs
only in the sharing track, exactly once.

### 1 · Auth

```mermaid
sequenceDiagram
    participant App as "App (in-memory)"
    participant Page as "Page (rendered)"
    participant LS as "Local storage (browser)"
    participant Auth as "Auth server (token issuer)"

    App->>Page: "Show login screen + progress bar"
    App->>LS: "Read active backend mode, last view, scoped prefs"
    App->>LS: "Check sessionStorage for a cached access token"

    alt Token cached and still valid (~1h)
        rect rgb(232, 245, 233)
        LS-->>App: "Reuse cached token — no network auth"
        end
    else No token or expired
        App->>Page: "Progress: signing in…"
        App->>Auth: "OAuth token request (consent popup if needed)"
        alt Token granted
            rect rgb(232, 245, 233)
            Auth-->>App: "Access token (~1h lifetime)"
            App->>LS: "Cache token in sessionStorage"
            end
        else Sign-in refused or blocked
            rect rgb(253, 237, 236)
            Auth-->>App: "Error (popup closed, access denied,<br/>Drive scope denied, pop-up or script blocked)"
            App->>Page: "Login screen stays — specific error message<br/>(sign-in cancelled, Drive access needed, pop-up blocked…)<br/>Flow ends here — retry by clicking connect again"
            end
        end
    end
```

### 2 · At login — right after auth

Once the app holds a valid access token, login runs. In order:

1. **Find-or-create the personal folder** (`DeLaClaw/`, `DeLaClawDev/` on dev).
   On failure the login screen shows a generic connection error; retrying
   re-runs find-or-create, so a folder created by a timed-out request is found
   and reused — never duplicated.
2. **List the folder's files.** This decides the branch: **existing install**
   (table files found — a retry after a failed fresh install lands here too)
   or **fresh install** (no table files at all).
3. **Existing install: download every per-table JSON file in parallel**,
   keeping each file's ETag and modifiedTime. A missing file is not a failure —
   that table simply starts empty. One failed download aborts the whole load
   (all-or-nothing) and returns to the login screen.
4. **Read `schema_version` from settings.json** (missing → version 0). If any
   migration is pending, the backup policy runs before the first one:
   - **A `backup-v{B}.json` exists for the current version** — a previous batch
     did not complete. The app downloads the backup, **replaces the in-memory
     tables with the backup's content**, then overwrites every table file in
     place from it (a table file missing from the folder is *created* from the
     backup, not overwritten). The restore is authoritative — no ETag
     preconditions — because the on-Drive state is known-bad partial-batch
     data and the backup is the source of truth. The batch then re-runs from
     the backup's version on this clean state. If the restore itself fails, the
     backup is untouched (nothing is ever deleted before success) and the retry
     restores again.
   - **No backup, or a stale one** — delete any stale backups, snapshot the
     current tables as `backup-v{currentVersion}.json`, then migrate. If the
     snapshot upload fails, nothing on Drive has changed yet.
5. **Run each pending migration, oldest first**: apply it to the in-memory
   store, bump `schema_version` in memory, upload the changed table files.
   `settings.json` is *not* written per migration. If an upload fails, the
   backup is retained and `settings.json` still carries the pre-batch version,
   so the retry restores from the backup and re-runs the whole batch.
6. **Write `settings.json` once** with the final `schema_version` — the batch
   completion marker — then **delete the backup**. A backup left on Drive always
   means "a batch did not complete".
7. **Fresh install: create one JSON file per table in parallel** (all except
   `settings.json`), seeding the category tables with their protected default
   rows — then **write `settings.json` last** with `schema_version=latest` as
   the completion marker. If the table creation fails midway, the retry lands
   in the existing-install branch with no `schema_version` (version 0), so it
   snapshots and runs all migrations — including the one that re-seeds the
   protected category rows.
8. **Create the in-memory adapter** seeded with the loaded data, hide the login
   screen, show the app shell, and render the current view from memory.
9. **Start the 30s poll and the tab-focus poll** over the personal tables. The
   calendar is never read at startup — it is a write-only projection, synced
   on table flush only.

```mermaid
sequenceDiagram
    participant App as "App (in-memory)"
    participant Page as "Page (rendered)"
    participant PF as "Personal folder (DeLaClaw/)"

    App->>Page: "Progress: connecting…"
    App->>PF: "Find-or-create DeLaClaw/ (DeLaClawDev/ on dev)"
    rect rgb(253, 237, 236)
    opt Creation or listing fails
        PF-->>App: "Error"
        App->>Page: "Login screen — generic connection error<br/>Retry re-runs find-or-create: a folder created by a timed-out request<br/>is found and reused, so no duplicate folder<br/>Flow ends here — back to the login screen"
    end
    end
    App->>PF: "List folder files"

    alt Existing install — or retry after a failed fresh install — (table files found)
        App->>PF: "Download per-table JSON files in parallel (keep ETag + modifiedTime)"
        rect rgb(253, 237, 236)
        opt A download fails
            PF-->>App: "Error"
            App->>Page: "Login screen — generic connection error<br/>All-or-nothing: one failed table aborts the whole load<br/>(a missing file is not a failure — that table just starts empty)<br/>Flow ends here — back to the login screen"
        end
        end
        PF-->>Page: "Progress: loading tables (per-table progress)"
        App->>App: "Read schema_version from settings.json"
        alt settings.json missing → version 0
            App->>App: "Every migration is pending"
        else schema_version older than latest
            App->>App: "Only migrations newer than schema_version are pending"
        else schema_version is latest
            App->>App: "Nothing pending — skip to adapter creation"
        end
        opt At least one migration is pending
            App->>App: "Look for backup-v*.json files from a previous attempt"
            alt A backup-v{B}.json exists for the current schema_version<br/>(a previous batch did not complete — settings.json is written once, at the end of the batch)
                App->>PF: "Overwrite every table file in place from the backup<br/>(never delete-then-restore)"
                rect rgb(253, 237, 236)
                opt The restore fails
                    PF-->>App: "Error"
                    App->>Page: "Login screen — generic connection error<br/>State on Drive: the backup is intact (nothing is ever deleted before success)<br/>Retry re-enters as an Existing install (branch above) → restores from the backup again<br/>Flow ends here — back to the login screen"
                end
                end
                App->>App: "Re-run the batch from the backup's version on the clean restored state"
            else No backup — or its batch completed (stale)
                App->>PF: "Delete stale backups — upload full backup of the pre-migration Drive state<br/>(backup-v{currentVersion}.json)"
                rect rgb(253, 237, 236)
                opt The backup upload fails
                    PF-->>App: "Error"
                    App->>Page: "Login screen — generic connection error<br/>State on Drive: unchanged — the backup is the first write, nothing migrated yet<br/>Retry re-enters as an Existing install (branch above)<br/>Flow ends here — back to the login screen"
                end
                end
            end
            loop For each pending migration, oldest first
                App->>App: "Apply the migration to the in-memory store,<br/>bump schema_version in memory"
                App->>PF: "Upload the changed table files (settings.json is NOT written per migration)"
                rect rgb(253, 237, 236)
                opt A migration upload fails
                    PF-->>App: "Error"
                    App->>Page: "Login screen — generic connection error<br/>State on Drive: the pre-migration backup is retained —<br/>settings.json still carries the pre-batch schema_version (it is written once, at the end)<br/>Retry re-enters as an Existing install (branch above) → restores the tables<br/>from the backup and re-runs the batch from the backup's version<br/>Flow ends here — back to the login screen"
                end
                end
            end
            App->>PF: "Write settings.json once with the final schema_version — the batch completion marker"
            App->>PF: "Delete the backup — the batch succeeded"
        end
    else Fresh install (no table files)
        App->>PF: "(1) Create one JSON file per table in parallel (all except settings.json) —<br/>seed the category tables in memory with the protected default rows<br/>and flush them to Drive"
        rect rgb(253, 237, 236)
        opt Step 1 fails
            PF-->>App: "Error"
            App->>Page: "Login screen — generic connection error<br/>State on Drive: some table files exist, settings.json does NOT exist,<br/>no schema_version stamp anywhere<br/>Retry re-enters as an Existing install (branch above)<br/>Flow ends here — back to the login screen"
        end
        end
        App->>PF: "(2) Write settings.json with schema_version=latest — the completion marker"
        rect rgb(253, 237, 236)
        opt Step 2 fails
            PF-->>App: "Error"
            App->>Page: "Login screen — generic connection error<br/>State on Drive: ALL table files exist, category tables already hold<br/>the seeded protected rows, only settings.json is missing<br/>Retry re-enters as an Existing install (branch above)<br/>Flow ends here — back to the login screen"
        end
        end
    end

    App->>App: "Create in-memory adapter seeded with loaded data"
    App->>Page: "Hide login — show app shell"
    App->>Page: "Render current view from in-memory data (welcome / todos / …)"
    App->>PF: "Start 30s poll + tab-focus poll (personal tables)"

    Note over App,Page: "Calendar is NOT synced on page load<br/>trusted already in sync, syncs on table flush only"
```

### 3 · Sharing startup

```mermaid
sequenceDiagram
    participant App as "App (in-memory)"
    participant Page as "Page (rendered)"
    participant PF as "Personal folder (DeLaClaw/)"
    participant OWN as "Owned shared folders (DeLaClaw-Shared/)"
    participant JOIN as "Joined group folders"

    App->>Page: "Sharing nav appears immediately with loading state (before load finishes)"
    App->>App: "Read joined_groups pointers (already loaded with personal tables)"
    App->>OWN: "Find DeLaClaw-Shared/ root, list dlc-group-* subfolders"

    rect rgb(253, 237, 236)
    opt The root find or the folder listing fails
        OWN-->>App: "Error"
        App->>App: "Error is logged — the app keeps running<br/>Owned groups simply don't load this time<br/>They reappear on the next page load (the listing re-runs)"
    end
    end

    par Per owned folder
        App->>OWN: "Find group.json + revoked.json + todos/habits/lists.json in parallel"
        rect rgb(253, 237, 236)
        opt The file listing itself fails
            OWN-->>App: "Error"
            App->>App: "Group skipped this cycle — never treated as incomplete,<br/>never trashed (the folder couldn't be looked at properly)<br/>Retried on the next page load"
        end
        end
        alt group.json missing on an owned folder (partial creation)
            App->>App: "Older than 15 minutes → folder trashed (recoverable on Drive)<br/>Younger → left alone (creation may still be in progress on another device)"
        else group.json found
            App->>OWN: "Download group.json + revoked.json + todos/habits/lists.json in parallel"
            rect rgb(253, 237, 236)
            opt Any required file (group.json, revoked.json, todos/habits/lists.json) fails to download
                OWN-->>App: "Error for that file"
                App->>App: "Group skipped this cycle — never partially loaded<br/>(a half-loaded group could show items as missing, and the user might recreate them,<br/>then the real file loads and there are duplicates)<br/>Retried on the next page load — the 15s poll does not re-attempt it<br/>Other groups are unaffected"
            end
            end
        end
    and Per joined pointer
        App->>JOIN: "Download group.json + todos/habits/lists.json via saved file IDs<br/>(revoked.json content is NOT downloaded here — only its fileId is recorded)"
        rect rgb(253, 237, 236)
        opt Download fails with 403/404 (our access is gone)
            App->>JOIN: "Read revoked.json via its saved fileId<br/>(the file-level read grant survives folder revocation)"
            alt own member ID found in revoked.json
                App->>App: "Verdict 'removed' → pointer purged silently<br/>+ local item pointers purged (no dialog)"
            else no entry — or revoked.json itself gone (404)
                App->>App: "Verdict 'deleted' → pointer purged + group-deleted notice"
            end
            opt revoked.json unreadable (transient)
                App->>App: "No verdict → group skipped this cycle,<br/>retried on the next page load"
            end
        end
        opt Download fails otherwise (transient)
            JOIN-->>App: "Error for that file"
            App->>App: "Group skipped this cycle — never partially loaded<br/>(same duplicate risk as an owned folder)<br/>Retried on the next page load — the 15s poll does not re-attempt it"
        end
        end
    end

    App->>App: "Init in-memory sync intents per item file (createdIds / deletedIds)"
    App->>App: "normalizeEntry → _groups map"
    App->>Page: "Render sharing pane (fills in if already open)"
    App->>OWN: "Poll every 15s (per-group files)"
    App->>JOIN: "Poll every 15s (per-group files)"
    App->>Page: "On sharing-changed → re-render sharing UI"

    Note over App,JOIN: "revoked.json is read at startup when a joined download fails with 403/404<br/>(access gone — the file-level read grant survives), and in the poll<br/>when a loaded group's files become unreachable:<br/>'removed' → silent auto-purge, 'deleted' → group-deleted notice"

    rect rgb(255, 243, 205)
    Note over App,OWN: "Planned · phase 4: startup sweep permanently deletes<br/>group folders whose deletedAt is older than 30 days"
    end
```
## Write Path (User Edits an Item)

```mermaid
sequenceDiagram
    participant UI as User Action
    participant DB as db.from(table)
    participant MEM as In-Memory Store
    participant DT as Dirty Tracking
    participant TIMER as Debounce (2s)
    participant DRIVE as Google Drive
    participant CAL as Calendar Sync

    UI->>DB: .update() / .insert() / .delete()
    DB->>MEM: Execute query instantly
    MEM-->>UI: Result → re-render

    DB->>DT: scheduleSave(table)<br/>dirtyTables.add(table)
    DB->>DT: markCalDirty(table, itemId)

    Note over TIMER: Previous timer for this<br/>table is cleared & reset

    DT->>TIMER: setTimeout(2000ms)

    TIMER->>DRIVE: flushTable(table)<br/>Upload JSON with ETag
    DRIVE-->>TIMER: Success
    TIMER->>DT: dirtyTables.delete(table)
    TIMER->>CAL: _onTableFlushed(table)

    CAL->>CAL: syncTable(table)<br/>Consume _dirtyItems set
    CAL->>CAL: For each dirty ID:<br/>compare DB row ↔ existing event

    alt Item has no event yet
        CAL->>CAL: Create event via Calendar API
    else Item changed (title, date, done status)
        CAL->>CAL: Patch event via Calendar API
    else Item deleted or completed
        CAL->>CAL: Delete event via Calendar API
    end
```

## Polling Path (External Change from Another Device or Agent)

```mermaid
sequenceDiagram
    participant POLL as Poll Timer (30s)
    participant DRIVE as Google Drive
    participant DT as Dirty Tracking
    participant MEM as In-Memory Store
    participant UI as UI Refresh

    POLL->>DRIVE: "files.list(DeLaClaw/ folder — DeLaClawDev/ on dev)"
    DRIVE-->>POLL: File list with modifiedTime

    POLL->>POLL: For each file:<br/>compare modifiedTime

    alt modifiedTime unchanged
        Note over POLL: Skip — no change
    else modifiedTime changed but table is dirty
        Note over POLL: Skip — local edit<br/>in flight, don't overwrite
    else modifiedTime changed & table clean
        POLL->>DRIVE: Download new JSON
        DRIVE-->>POLL: File content + ETag

        POLL->>POLL: Compare JSON content<br/>(skip if identical — own flush reflected back)

        alt Data actually changed
            POLL->>MEM: Replace in-memory store
            POLL->>MEM: Update fileMeta (ETag, modifiedTime)
            MEM->>UI: _onExternalChange(table)<br/>→ refresh*() → re-render
        else Same data (own write echoed)
            POLL->>MEM: Update fileMeta only
        end
    end
```

## Calendar Sync — Targeted Dirty Tracking

Calendar sync never does a full scan on every flush. Instead, it tracks which specific items changed.

```mermaid
flowchart LR
    subgraph Writes["On Every Write"]
        W1["db.from('todos').update(...)"]
        W2["markCalDirty('todos', itemId)"]
        W1 --> W2
        W2 --> DS["_dirtyItems Map<br/>todos → Set { itemId }"]
    end

    subgraph Flush["On Table Flush to Drive"]
        F1["_onTableFlushed('todos')"]
        F2["syncTable('todos')"]
        F1 --> F2
        F2 --> DS2["Consume & clear<br/>_dirtyItems['todos']"]
    end

    subgraph Sync["Per Dirty Item"]
        DS2 --> CHECK{"Item has<br/>calendar event?"}
        CHECK -->|"No event + item eligible"| CREATE["Create event"]
        CHECK -->|"Event exists + item changed"| PATCH["Patch event"]
        CHECK -->|"Event exists + item done/deleted"| DELETE["Delete event"]
        CHECK -->|"Event exists + no change"| SKIP["Skip"]
    end
```

**Special cases:**
- **Category rename** → `markCategoryRenamed(catTable)` marks all items of that type with `__all__` sentinel → full scan
- **Bulk operation** (null ID) → `__all__` sentinel → full scan
- **Category table flush** (e.g. `todo_categories`) → `CAT_TABLE_TO_ITEM_TABLE` maps it to the item table (`todos`) for sync
- **Settings table flush** → `TABLE_TO_TYPE` has no entry → no-op (calendar sync ignores settings changes)

## Delete Path

```mermaid
sequenceDiagram
    participant UI as User Action
    participant MEM as In-Memory Store
    participant DRIVE as Google Drive
    participant CAL as Calendar Sync

    UI->>MEM: db.from(table).delete().eq('id', itemId)
    MEM-->>UI: Row removed → re-render

    Note over MEM: scheduleSave(table) — dirty<br/>markCalDirty(table, itemId)

    MEM->>DRIVE: flushTable (2s debounce)
    DRIVE-->>MEM: Success

    MEM->>CAL: _onTableFlushed(table)
    CAL->>CAL: syncTable consumes dirtySet

    CAL->>CAL: Item not in DB anymore →<br/>find matching Calendar event
    CAL->>CAL: Delete event via Calendar API
```

## Sync Bar States

The sync bar reflects the current state of Drive persistence:

| State | Meaning | Visual |
|-------|---------|--------|
| **Idle** | All changes saved | ✓ All changes saved to Drive |
| **Pending** | Debounce timer running | ● Changes waiting to sync |
| **Uploading** | Flush or poll in progress | ↻ Uploading to Drive… |
| **Error** | Flush failed (auto-retry) | ✗ Sync error — retrying |

## Edge Cases & Guards

- **Tab close / visibility hidden** → `forceSave()` fires with `keepalive: true` (skipped if payload > 64 KB)
- **Flush failure** → table stays in `dirtyTables`, `scheduleSave` retries automatically
- **ETag conflict (412)** → Drive adapter re-reads, merges by `updated_at` (newer wins per row), retries
- **Poll skips dirty tables** → prevents overwriting local edits that haven't flushed yet
- **`isEditing()` guard** → external changes don't refresh UI while user is inline-editing
- **Calendar sync disabled** → `syncTable` returns early if `prefs.enabled` is false; `_onTableFlushed` still fires but sync is a no-op
