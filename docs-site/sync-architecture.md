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
        DJSON["Per-table JSON files<br/>in DeLaClaw/ folder"]
    end

    subgraph GCal["Google Calendar"]
        GCAL["DeLaClaw calendar<br/>(events)"]
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

    POLL->>DRIVE: files.list(DeLaClaw/ folder)
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
