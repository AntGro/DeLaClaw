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
// After each migration:
//   1. schema_version is bumped in the in-memory settings
//   2. All tables are flushed to Drive (the runner handles this)
//
// Before any migration runs, a full backup is saved to Drive as
// backup-v{currentVersion}.json.
//
// Adding a migration:
//   1. Add an entry keyed by the version it brings the DB TO
//   2. Modify `store` in place for data transforms
//   3. Use `ctx` for file-level operations if needed
//   4. Return nothing — the runner handles persistence
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

const LEGACY_FILE_NAME = 'delaclaw-data.json';

export const DRIVE_MIGRATIONS = {
  // Convert legacy single-file format to per-table files.
  // The adapter has already loaded data into memory from whatever
  // format it found; this migration creates the per-table Drive files
  // and deletes the legacy blob.
  '1.132': async (store, ctx) => {
    const legacyFile = ctx.filesByName.get(LEGACY_FILE_NAME);
    if (!legacyFile) return; // Already per-table or fresh install

    const tok = await ctx.getToken();
    if (!tok) throw new Error('No token for legacy migration');

    // Create per-table files from the in-memory store
    for (const table of ctx.DRIVE_TABLES) {
      const fileName = `${table}.json`;
      const result = await ctx.uploadFile(tok, ctx.folderId, null, fileName, store[table] || []);
      ctx.fileMeta[table] = { fileId: result.id, etag: result.etag, modifiedTime: new Date().toISOString() };
    }

    // Delete legacy file
    await ctx.deleteFile(tok, legacyFile.id);
  },
  // 1.393: indexes for owner_id / shared_id — perf only for Postgres/SQLite, no-op for Drive (in-memory)
  // Drive has no seq scans: whole tables are loaded into memory. Bump version only.
  '1.393': async (_store) => {},
  '1.396': async (store) => {
    // Remove plaintext fallback (>=1.301 assumed)
    for (const row of (store.joined_groups || [])) {
      if (row.token_ciphertext) {
        row.token = null;
        row.remote_anon_key = null;
      }
    }
    // Delete owner_id IS NULL (legacy pre-1.299 rows)
    if (store.joined_groups) {
      store.joined_groups = store.joined_groups.filter(r => r.owner_id != null);
    }
  },
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
    // 1.436: Supabase sharing-only invited_label migration.
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
};
