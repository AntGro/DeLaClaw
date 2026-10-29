// ===================================================================
// DRIVE MIGRATIONS — JS transforms for per-table Drive data
// ===================================================================
// Each key is a version string. Migrations run in version order when
// the Drive backend's schema_version is behind the app.
//
// Migration functions receive two arguments:
//   store — the raw in-memory object (store.tableName = array of records)
//   ctx   — Drive API context for file-level operations:
//           { token, folderId, fileMeta, filesByName, getToken,
//             DRIVE_TABLES, uploadFile, downloadFile, deleteFile,
//             listFolderFiles }
//
// Most migrations only need `store` (in-memory transforms).
// Use `ctx` only when the migration needs to create/delete/rename
// Drive files themselves (like the legacy format conversion below).
//
import { toLocalDateString, prevDay, nextDay } from '../js/daily-visits.js';
import { recomputeNextDueForMigration } from '../js/frequency-rule.js';
// After each migration:
//   1. schema_version is bumped in the in-memory settings (never by the
//      migration itself — see rule 5 below)
//   2. Changed tables are flushed to Drive (the runner handles this);
//      settings.json is written ONCE, at the end of the batch, carrying the
//      final schema_version. It is the batch's completion marker: the
//      pre-migration backup/restore policy depends on the version on Drive
//      moving exactly once per batch.
//
// Before any migration runs, a full backup is saved to Drive as
// backup-v{currentVersion}.json.
//
// Adding a migration:
//   1. Add an entry keyed by the version it brings the DB TO
//   2. Modify `store` in place for data transforms
//   3. Use `ctx` for file-level operations if needed
//   4. Return nothing — the runner handles persistence
//   5. NEVER touch the `schema_version` settings entry (read or write), and
//      never upload settings.json with a bumped version: the runner owns the
//      version stamp. A migration that moved it independently would silently
//      break the backup/restore invariant above.
//
// Example (data transform only):
//   '1.150': async (store) => {
//     (store.todos || []).forEach(t => {
//       t.priority = t.importance;
//       delete t.importance;
//     });
//   },
//
// Example (file-level operation):
//   '1.160': async (store, ctx) => {
//     const tok = await ctx.getToken();
//     await ctx.uploadFile(tok, ctx.folderId, null, 'new_table.json', []);
//   },
// ===================================================================

export const DRIVE_MIGRATIONS = {
  // 1.393: indexes for owner_id / shared_id — perf only for Postgres/SQLite, no-op for Drive (in-memory)
  // Drive has no seq scans: whole tables are loaded into memory. Bump version only.
  '1.393': async (_store) => {},
  '1.398': async (store) => {
    // 1.398: add owner_id to previously open tables — ensure field exists
    // No data deletion needed, Drive is single-user single-tenant
    for (const tbl of ['flashcards', 'texts', 'text_line_progress', 'nvidia_usage', 'daily_visits']) {
      for (const row of (store[tbl] || [])) {
        if (row.owner_id == null) row.owner_id = null; // ensure key exists for future claim logic if needed
      }
    }
  },
  '1.410': async (store) => {
    // 1.410: agent_grants – no-op for Drive (single-user), bump version only
    if (!store.agent_grants) store.agent_grants = [];
  },
  '1.436': async (_store) => {
    // 1.436: sharing-only invited_label migration.
    // Drive shared group JSON is normalized lazily by js/sharing-drive.js.
  },

  '1.474': async (store) => {
    // Category tables: discover existing categories from items, seed protected rows, backfill FKs.
    const catTables = [
      { table: 'todo_categories',      itemTable: 'todos',      field: 'category', fkField: 'category_id' },
      { table: 'habit_categories',     itemTable: 'habits',     field: 'category', fkField: 'category_id' },
      { table: 'vestiaire_categories', itemTable: 'vestiaire',  field: 'category', fkField: 'category_id' },
      { table: 'flashcard_decks',      itemTable: 'flashcards', field: 'deck',     fkField: 'deck_id' },
    ];

    // Helper: deterministic UUID-like ID from a seed string
    const makeId = (seed) => {
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
      return '_cat_' + Math.abs(h).toString(16).padStart(8, '0');
    };

    // Settings JSON helpers for shortnames/colors
    const settingsMap = {};
    for (const s of (store.settings || [])) settingsMap[s.key] = s.value;
    const parseJson = (key) => {
      try { return JSON.parse(settingsMap[key] || '{}'); } catch { return {}; }
    };
    const todoColors = parseJson('todo_category_colors');
    const shortnames = {
      todo_categories: parseJson('todo_category_shortnames'),
      habit_categories: parseJson('habit_category_shortnames'),
      vestiaire_categories: parseJson('vest_category_shortnames'),
      flashcard_decks: parseJson('flash_shortnames'),
    };

    for (const { table, itemTable, field, fkField } of catTables) {
      if (!store[table]) store[table] = [];
      const now = new Date().toISOString();

      // Seed protected default row (name='')
      if (!store[table].some(r => r.is_protected && r.name === '')) {
        store[table].push({ id: '_default_' + table, name: '', shortname: null, color: null, sort_order: 0, is_protected: 1, owner_id: null, created_at: now, updated_at: now });
      }
      // Seed protected __shared__ row
      if (!store[table].some(r => r.is_protected && r.name === '__shared__')) {
        store[table].push({ id: '_shared_' + table, name: '__shared__', shortname: null, color: null, sort_order: 9999, is_protected: 1, owner_id: null, created_at: now, updated_at: now });
      }

      // Discover distinct categories from items
      const existing = new Set(store[table].map(r => r.name));
      const items = store[itemTable] || [];
      const distinct = [...new Set(items.map(i => i[field]).filter(v => v && v !== '' && v !== '__shared__' && !existing.has(v)))];
      distinct.sort();
      for (let i = 0; i < distinct.length; i++) {
        const name = distinct[i];
        const sn = (shortnames[table] || {})[name] || null;
        const color = table === 'todo_categories' ? (todoColors[name] || null) : null;
        store[table].push({ id: makeId(table + name), name, shortname: sn, color, sort_order: i + 1, is_protected: 0, owner_id: null, created_at: now, updated_at: now });
      }

      // Also discover decks from texts table for flashcard_decks
      if (table === 'flashcard_decks') {
        const textsExisting = new Set(store[table].map(r => r.name));
        const textDecks = [...new Set((store.texts || []).map(t => t.deck).filter(v => v && v !== '' && v !== '__shared__' && !textsExisting.has(v)))];
        textDecks.sort();
        const base = store[table].length;
        for (let i = 0; i < textDecks.length; i++) {
          const name = textDecks[i];
          const sn = (shortnames[table] || {})[name] || null;
          store[table].push({ id: makeId('texts_' + name), name, shortname: sn, color: null, sort_order: base + i, is_protected: 0, owner_id: null, created_at: now, updated_at: now });
        }
      }

      // Build name→id lookup and backfill FK on items
      const lookup = {};
      for (const row of store[table]) lookup[row.name] = row.id;
      for (const item of items) {
        item[fkField] = lookup[item[field]] || null;
      }
      // Also backfill texts.deck_id
      if (table === 'flashcard_decks') {
        for (const txt of (store.texts || [])) {
          txt.deck_id = lookup[txt.deck] || null;
        }
      }
    }

    // Clean up dead settings keys
    const deadKeys = new Set(['todo_category_colors', 'todo_category_shortnames', 'habit_category_shortnames', 'vest_category_shortnames', 'flash_shortnames']);
    store.settings = (store.settings || []).filter(s => !deadKeys.has(s.key));
  },

  '1.482': async (store) => {
    // Uniform default names: 'General'→'', 'Général'→'' on protected rows + items
    for (const row of (store.habit_categories || [])) {
      if (row.is_protected && row.name === 'General') row.name = '';
    }
    for (const row of (store.flashcard_decks || [])) {
      if (row.is_protected && row.name === 'Général') row.name = '';
    }
    for (const h of (store.habits || [])) {
      if (h.category === 'General') h.category = '';
    }
    for (const f of (store.flashcards || [])) {
      if (f.deck === 'Général') f.deck = '';
    }
    for (const t of (store.texts || [])) {
      if (t.deck === 'Général') t.deck = '';
    }
  },

  '1.484': async (_store) => {
    // Category integrity hardening — triggers are Postgres/SQLite only.
    // Drive protection is enforced at the adapter/app level.
    // Version bump only.
  },

  '1.573': async (store) => {
    // Move list shortnames from settings accessor to a proper column on lists
    const settingsRow = (store.settings || []).find(s => s.key === 'list_shortnames');
    if (settingsRow) {
      let map = {};
      try { map = typeof settingsRow.value === 'string' ? JSON.parse(settingsRow.value) : settingsRow.value; } catch (_) {}
      for (const list of (store.lists || [])) {
        if (map[list.id] && !list.shortname) {
          list.shortname = map[list.id];
        }
      }
      // Remove dead settings key
      store.settings = store.settings.filter(s => s.key !== 'list_shortnames');
    }
  },

  '1.608': async (store) => {
    // Add sort_order to flashcard_notes
    for (const note of (store.flashcard_notes || [])) {
      if (note.sort_order === undefined) note.sort_order = 0;
    }
  },

  '1.651': async (store) => {
    // Consolidate frequency_rule formats
    for (const h of (store.habits || [])) {
      if (!h.frequency_rule) continue;
      if (h.frequency_rule === 'daily') { h.frequency_rule = 'every_N_days:1'; }
      else if (h.frequency_rule.startsWith('weekly:')) { h.frequency_rule = 'every_N_weeks:1:' + h.frequency_rule.slice(7); }
      else if (h.frequency_rule.startsWith('monthly_weekday:')) { h.frequency_rule = 'every_N_months:1:' + h.frequency_rule.slice(16); }
      else if (h.frequency_rule.startsWith('monthly:')) { h.frequency_rule = 'every_N_months:1:' + h.frequency_rule.slice(8); }
    }
  },

  '2.0.9': async (store, ctx) => {
    // Drop tables for removed features (NVIDIA usage tracking, agent tokens).
    // No code reads them anymore; delete the in-memory data and the Drive files.
    delete store.nvidia_usage;
    delete store.agent_grants;
    const tok = await ctx.getToken();
    if (!tok) return;
    for (const name of ['nvidia_usage.json', 'agent_grants.json']) {
      const file = ctx.filesByName.get(name);
      if (file) await ctx.deleteFile(tok, file.id);
    }
    // The adapter tracks file ids per table: forget the deleted files,
    // or a later flush keeps PATCHing a dead id and fails forever
    // (agent_grants comes back in 2.0.10, so its flush is guaranteed).
    if (ctx.fileMeta) {
      ctx.fileMeta.nvidia_usage = { fileId: null, etag: null, modifiedTime: null, size: 0 };
      ctx.fileMeta.agent_grants = { fileId: null, etag: null, modifiedTime: null, size: 0 };
    }
  },

  '2.0.10': async (store) => {
    // Restore agent_grants store (agents settings pane kept).
    if (!store.agent_grants) store.agent_grants = [];
  },

  '2.9.17': async (store, ctx) => {
    // Wardrobe tab removed: migrate vestiaire_categories -> lists
    // inside a "Wardrobe" section (one list per category, named just
    // <name>) and vestiaire -> list_items, folding brand/size/color/
    // purchase status into the item note. Items whose category is the
    // protected default (or unknown) land in a '*' list inside the
    // section, like items directly under any section.
    // The vestiaire files are not in DRIVE_TABLES anymore, so they are
    // fetched and deleted explicitly via ctx.
    const tok = await ctx.getToken();
    if (!tok) return;
    const readFile = async (name) => {
      const f = ctx.filesByName.get(name);
      if (!f) return [];
      try {
        const { data } = await ctx.downloadFile(tok, f.id);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    };
    const buildNote = (v) => {
      const lines = [];
      if (v.brand) lines.push(`Brand / Make: ${v.brand}`);
      if (v.size) lines.push(`Size: ${v.size}`);
      if (v.color) lines.push(`Color: ${v.color}`);
      if (v.purchase_status === 'achete') lines.push('Status: Purchased');
      else if (v.purchase_status === 'essaye') lines.push('Status: Tried');
      let note = lines.join('\n');
      if (v.note) note += (note ? '\n\n' : '') + v.note;
      return note;
    };
    // Source of the wardrobe data: a backup restore reseeds the store
    // with the backup's own vestiaire tables, while a plain upgrade
    // never loads them (no longer in DRIVE_TABLES) — there the data
    // still lives in the Drive files. Prefer the store when it
    // carries rows; the files are the fallback. (Reading only the
    // files made restores lose the wardrobe whenever vestiaire.json
    // was no longer in the folder — e.g. deleted by an earlier
    // migration run.)
    const cats = (Array.isArray(store.vestiaire_categories) && store.vestiaire_categories.length)
      ? store.vestiaire_categories
      : await readFile('vestiaire_categories.json');
    const items = (Array.isArray(store.vestiaire) && store.vestiaire.length)
      ? store.vestiaire
      : await readFile('vestiaire.json');
    store.lists = store.lists || [];
    store.list_items = store.list_items || [];
    const namedCats = cats.filter((c) => !c.is_protected && c.name);
    // Build the Wardrobe structure only when there is anything to
    // move — an account that never used the wardrobe gets no section.
    if (namedCats.length || items.length) {
      const now = new Date().toISOString();
      const sectionId = 'vest_wardrobe';
      store.lists.push({
        id: sectionId, name: 'Wardrobe',
        shortname: null, color: '#8b5cf6', icon: null,
        sort_order: 9999, archived: 0, kind: 'section', parent_id: null,
        owner_id: null, created_at: now, updated_at: now,
      });
      const listIdFor = new Map();
      for (const c of namedCats) {
        const id = `vest_${c.id}`;
        store.lists.push({
          id, name: c.name,
          shortname: c.shortname ?? null, color: c.color ?? null, icon: null,
          sort_order: c.sort_order ?? 0, archived: 0, kind: 'bucket', parent_id: sectionId,
          owner_id: c.owner_id ?? null, created_at: c.created_at, updated_at: c.updated_at,
        });
        listIdFor.set(c.id, id);
      }
      let starId = null;
      if (items.some((v) => !listIdFor.has(v.category_id))) {
        starId = 'vest_wardrobe_star';
        store.lists.push({
          id: starId, name: '*',
          shortname: null, color: '#8b5cf6', icon: null,
          sort_order: 0, archived: 0, kind: 'bucket', parent_id: sectionId,
          owner_id: null, created_at: now, updated_at: now,
        });
      }
      for (const v of items) {
        const listId = listIdFor.get(v.category_id) || starId;
        if (!listId) continue;
        store.list_items.push({
          id: `vest_${v.id}`, list_id: listId, text: v.name, checked: 0,
          note: buildNote(v), sort_order: v.sort_order ?? 0,
          shared_id: null, shared_group_id: null,
          owner_id: v.owner_id ?? null, created_at: v.created_at, updated_at: v.updated_at,
        });
      }
    }
    for (const name of ['vestiaire.json', 'vestiaire_categories.json']) {
      const f = ctx.filesByName.get(name);
      if (f) { try { await ctx.deleteFile(tok, f.id); } catch {} }
    }
    delete store.vestiaire;
    delete store.vestiaire_categories;
  },
  '2.10.18': async (store) => {
    // 2.10.18: scene (role-based) text revision — ensure focus_role exists
    for (const row of (store.texts || [])) {
      if (row.focus_role == null) row.focus_role = null;
    }
    // 2.10.18: persist deck type at creation (new-deck modal choice was dropped)
    for (const row of (store.flashcard_decks || [])) {
      if (row.deck_type == null) row.deck_type = null;
    }
  },
  '2.10.43': async (store) => {
    // 2.10.43: block nomenclature — rename text chunking settings
    for (const row of (store.texts || [])) {
      if ('lines_per_chunk' in row) {
        row.blocks_per_chunk = row.lines_per_chunk;
        delete row.lines_per_chunk;
      }
      if ('context_lines' in row) {
        row.context_blocks = row.context_lines;
        delete row.context_lines;
      }
    }
  },
  '2.11.1': async (store) => {
    // 2.11.1: daily_visits becomes a single aggregate row.
    // Limitation: per-date history on Drive was destroyed by the composite
    // onConflict bug (each day's visit overwrote the previous one), so at
    // most one date survives and the true historical max_streak is
    // unrecoverable. The migration still computes the longest consecutive
    // run over whatever dates are present, honestly.
    const dates = [...new Set((store.daily_visits || []).map(r => r.visit_date).filter(Boolean))].sort();
    const maxDate = dates.length ? dates[dates.length - 1] : null;
    const set = new Set(dates);
    let trailing = 0;
    for (let d = maxDate; d && set.has(d); d = prevDay(d)) trailing++;
    let maxRun = 0, run = 0, prev = null;
    for (const d of dates) {
      run = (prev && nextDay(prev) === d) ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
      prev = d;
    }
    store.daily_visits = [{
      id: 'singleton',
      created_at: dates.length ? dates[0] : toLocalDateString(new Date()),
      num_active_days: dates.length,
      current_streak: trailing,
      max_streak: maxRun,
      last_connection_date: maxDate,
    }];
  },
  '2.18.0': async (store) => {
    // 2.18.0: habit end date — ensure the additive fields exist with their
    // defaults on existing rows (no end date, not finished).
    for (const row of (store.habits || [])) {
      if (row.end_date == null) row.end_date = null;
      if (row.is_finished == null) row.is_finished = 0;
    }
  },
  '2.19.0': async (store) => {
    // 2.19.0: habit snooze — ensure the additive field exists (null = not
    // snoozed) on existing rows, preserving any snooze already set.
    for (const row of (store.habits || [])) {
      if (row.snoozed_until === undefined) row.snoozed_until = null;
    }
  },
  '2.20.0': async (store) => {
    // 2.20.0: automatic habits — default is_auto to 0 on habit rows and
    // on completion rows, preserving any value already set.
    for (const row of (store.habits || [])) {
      if (row.is_auto == null) row.is_auto = 0;
    }
    for (const row of (store.habit_completions || [])) {
      if (row.is_auto == null) row.is_auto = 0;
    }
  },
  '2.23.0': async (store) => {
    // 2.23.0: nested sections — category/list rows gain kind ('bucket' by
    // default, 'section' for section rows) and parent_id (null = top level).
    // parent_id is a plain field, deliberately not a foreign key.
    for (const table of ['todo_categories', 'habit_categories', 'lists']) {
      for (const row of (store[table] || [])) {
        if (row.kind == null) row.kind = 'bucket';
        if (row.parent_id === undefined) row.parent_id = null;
      }
    }
  },
  '2.27.0': async (store) => {
    // 2.27.0: recompute habits.next_due from (rule, latest completion).
    // Rule fixes since v1.651 (local-date parsing of the last-done base,
    // monthly rule normalization) mean long-untouched habits can carry a
    // next_due the current code would never produce. The per-habit
    // decision (pure f(rule, latest completion); skip free-text /
    // completion-less habits; finished follows the value) lives in
    // recomputeNextDueForMigration — shared with the local backend.
    const latestByHabit = new Map();
    for (const c of store.habit_completions || []) {
      const ts = Date.parse(c.completed_at) || 0;
      const cur = latestByHabit.get(c.habit_id);
      if (!cur || ts >= cur.ts) latestByHabit.set(c.habit_id, { raw: c.completed_at, ts });
    }
    for (const h of store.habits || []) {
      const latest = latestByHabit.get(h.id);
      const result = recomputeNextDueForMigration(h, latest ? latest.raw : null);
      if (!result) continue;
      h.next_due = result.next_due;
      h.is_finished = result.is_finished;
    }
  },
  '2.28.0': async (store) => {
    // 2.28.0: user calendar events get their own per-table file
    // (events.json), registered in DRIVE_TABLES. Existing stores
    // simply start with an empty table.
    if (!store.events) store.events = [];
  },
  '2.29.0': async (store) => {
    // 2.29.0: repair dangling deck/category FKs left by the 1.474 →
    // 1.482 sequence: 1.474 created a deterministic deck row for the
    // legacy 'Général' string (e.g. _cat_72921675) and 1.482 renamed
    // the cards' deck string to '' without remapping the FK; the row
    // itself is gone from stores that later deleted the duplicate, so
    // those cards point at a deck that no longer exists and render in
    // no bucket (grouping is by deck_id; a non-empty dangling FK
    // short-circuits the name fallback in deckIdForCard/catIdFor*).
    // Remap by the legacy string: '' → the protected default row, a
    // name → the row with that name. FKs that already resolve, and
    // names that match no row, are left untouched — never guess a
    // named item into the default deck. Null FKs are repaired the
    // same way. Idempotent: a second run finds no dangling FKs.
    const specs = [
      { table: 'flashcard_decks', items: [
        { table: 'flashcards', field: 'deck', fk: 'deck_id' },
        { table: 'texts', field: 'deck', fk: 'deck_id' },
      ] },
      { table: 'todo_categories', items: [
        { table: 'todos', field: 'category', fk: 'category_id' },
      ] },
      { table: 'habit_categories', items: [
        { table: 'habits', field: 'category', fk: 'category_id' },
      ] },
    ];
    for (const { table, items } of specs) {
      const rows = store[table] || [];
      const ids = new Set(rows.map(r => r.id));
      const defaultRow = rows.find(r => r.is_protected && r.name === '');
      const byName = new Map();
      for (const r of rows) if (!byName.has(r.name)) byName.set(r.name, r.id);
      for (const { table: itemTable, field, fk } of items) {
        for (const item of (store[itemTable] || [])) {
          if (item[fk] && ids.has(item[fk])) continue;
          const name = item[field] ?? '';
          if (name === '' && defaultRow) { item[fk] = defaultRow.id; continue; }
          const named = byName.get(name);
          if (named) item[fk] = named;
          // else: leave untouched (no row to resolve to)
        }
      }
    }
  },
};
