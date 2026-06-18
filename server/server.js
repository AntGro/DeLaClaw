// ===================================================================
// DeLaClaw — Local REST API server (Bun + SQLite)
// Drop-in replacement for Supabase PostgREST.
// Usage: bun run server/server.js [--port 3737] [--db server/last.db]
// ===================================================================

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, statSync, copyFileSync } from "fs";
import { join, dirname, extname } from "path";
import { LOCAL_MIGRATIONS } from "../migrations/local-migrations.js";

const PORT = parseInt(process.env.PORT || "3737");
const DB_PATH = process.env.DB_PATH || join(dirname(import.meta.path), "last.db");
const STATIC_ROOT = join(dirname(import.meta.path), "..");

// ── Init DB ──
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
const schema = readFileSync(join(dirname(import.meta.path), "schema.sql"), "utf8");
db.exec(schema);
// Seed schema_version for fresh DBs (existing DBs keep their value via ON CONFLICT)
db.exec(`INSERT INTO settings (key, value) VALUES ('schema_version', '1.000')
  ON CONFLICT (key) DO NOTHING;`);
db.exec(`INSERT INTO settings (key, value) VALUES ('db_created_at', '"' || datetime('now') || '"')
  ON CONFLICT (key) DO NOTHING;`);

// ── Run pending migrations ──
{
  const pendingVersions = Object.keys(LOCAL_MIGRATIONS)
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  if (pendingVersions.length > 0) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
    const currentVersion = row ? String(row.value) : '0';
    const toRun = pendingVersions.filter(v => v > currentVersion);

    if (toRun.length > 0) {
      // Backup the DB file before any migration
      const backupPath = DB_PATH.replace(/\.db$/, `-backup-v${currentVersion}.db`);
      try {
        copyFileSync(DB_PATH, backupPath);
        console.log(`Migration backup saved: ${backupPath}`);
      } catch (e) {
        console.warn(`Migration backup failed: ${e.message} — proceeding anyway`);
      }

      for (const version of toRun) {
        try {
          db.exec("BEGIN TRANSACTION;");
          db.exec(LOCAL_MIGRATIONS[version]);
          db.exec(`UPDATE settings SET value = '${version}', updated_at = datetime('now') WHERE key = 'schema_version';`);
          db.exec("COMMIT;");
          console.log(`Migration ${version} applied successfully`);
        } catch (e) {
          db.exec("ROLLBACK;");
          console.error(`Migration ${version} failed: ${e.message}`);
          console.error(`Database remains at schema_version ${currentVersion}. Backup at: ${backupPath}`);
          break;
        }
      }
    }
  }
}

// ── Helpers ──
function generateId() {
  return crypto.randomUUID();
}

function parseFilters(url) {
  const filters = [];
  for (const [key, raw] of url.searchParams.entries()) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    // PostgREST-style: col=op.val
    const m = raw.match(/^(eq|neq|gt|gte|lt|lte|is|in)\.(.*)/);
    if (m) {
      filters.push({ col: key, op: m[1], val: m[2] });
    }
  }
  return filters;
}

function buildWhere(filters) {
  if (!filters.length) return { clause: "", params: [] };
  const parts = [];
  const params = [];
  for (const f of filters) {
    const col = f.col.replace(/[^a-zA-Z0-9_]/g, "");
    switch (f.op) {
      case "eq":  parts.push(`"${col}" = ?`); params.push(f.val); break;
      case "neq": parts.push(`"${col}" != ?`); params.push(f.val); break;
      case "gt":  parts.push(`"${col}" > ?`); params.push(f.val); break;
      case "gte": parts.push(`"${col}" >= ?`); params.push(f.val); break;
      case "lt":  parts.push(`"${col}" < ?`); params.push(f.val); break;
      case "lte": parts.push(`"${col}" <= ?`); params.push(f.val); break;
      case "is":  parts.push(`"${col}" IS ${f.val === "null" ? "NULL" : "NOT NULL"}`); break;
      case "in":
        const vals = f.val.replace(/^\(|\)$/g, "").split(",");
        parts.push(`"${col}" IN (${vals.map(() => "?").join(",")})`);
        params.push(...vals);
        break;
    }
  }
  return { clause: " WHERE " + parts.join(" AND "), params };
}

function buildOrder(url) {
  const raw = url.searchParams.get("order");
  if (!raw) return "";
  // format: col.asc or col.desc, comma-separated
  const parts = raw.split(",").map(s => {
    const [col, dir] = s.split(".");
    const safeCol = col.replace(/[^a-zA-Z0-9_]/g, "");
    return `"${safeCol}" ${dir === "desc" ? "DESC" : "ASC"}`;
  });
  return " ORDER BY " + parts.join(", ");
}

function buildLimit(url) {
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");
  let s = "";
  if (limit) s += ` LIMIT ${parseInt(limit)}`;
  if (offset) s += ` OFFSET ${parseInt(offset)}`;
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ── RPC handlers ──
const rpcHandlers = {
  db_size_mb: () => {
    const row = db.prepare("SELECT (page_count * page_size) / (1024.0 * 1024.0) as size_mb FROM pragma_page_count(), pragma_page_size()").get();
    return row?.size_mb || 0;
  },
};

// ── Static file serving ──
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(pathname) {
  let filePath = join(STATIC_ROOT, pathname === '/' ? 'index.html' : pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(STATIC_ROOT)) return new Response('Forbidden', { status: 403 });
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  return new Response(Bun.file(filePath), { headers: { 'Content-Type': mime } });
}

// ── HTTP handler ──
function handleRequest(req) {
  const url = new URL(req.url);
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, Prefer",
      },
    });
  }

  // RPC: POST /rest/v1/rpc/<fn>
  const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)/);
  if (rpcMatch) {
    const fn = rpcMatch[1];
    if (rpcHandlers[fn]) return json(rpcHandlers[fn]());
    return json({ error: `Unknown RPC: ${fn}` }, 404);
  }

  // REST: /rest/v1/<table>
  const tableMatch = url.pathname.match(/^\/rest\/v1\/([a-z_]+)/);
  if (!tableMatch) {
    // Static file serving (for the DeLaClaw frontend)
    return serveStatic(url.pathname);
  }
  const table = tableMatch[1].replace(/[^a-z_]/g, "");

  // Verify table exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!tableCheck) return json({ error: `Table '${table}' not found` }, 404);

  const filters = parseFilters(url);
  const { clause: where, params } = buildWhere(filters);
  const prefer = req.headers.get("Prefer") || "";
  const returnRow = prefer.includes("return=representation");

  try {
    // SELECT
    if (method === "GET") {
      const order = buildOrder(url);
      const limit = buildLimit(url);
      const sql = `SELECT * FROM "${table}"${where}${order}${limit}`;
      const rows = db.prepare(sql).all(...params);
      return json(rows);
    }

    // INSERT
    if (method === "POST") {
      return handleInsert(req, table, returnRow);
    }

    // UPDATE (PATCH)
    if (method === "PATCH") {
      return handleUpdate(req, table, where, params, returnRow);
    }

    // UPSERT (PUT)
    if (method === "PUT") {
      return handleUpsert(req, table, url, returnRow);
    }

    // DELETE
    if (method === "DELETE") {
      const sql = `DELETE FROM "${table}"${where}`;
      db.prepare(sql).run(...params);
      return json(null, 204);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleInsert(req, table, returnRow) {
  const body = await req.json();
  const rows = Array.isArray(body) ? body : [body];
  const results = [];

  for (const row of rows) {
    if (!row.id) row.id = generateId();
    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(", ");
    const safeCols = cols.map(c => `"${c.replace(/[^a-zA-Z0-9_]/g, "")}"`).join(", ");
    const sql = `INSERT INTO "${table}" (${safeCols}) VALUES (${placeholders})`;
    db.prepare(sql).run(...cols.map(c => row[c] === undefined ? null : row[c]));
    if (returnRow) {
      const inserted = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(row.id);
      results.push(inserted);
    }
  }
  return json(returnRow ? results : null, 201);
}

async function handleUpdate(req, table, where, params, returnRow) {
  const body = await req.json();
  const cols = Object.keys(body);
  if (!cols.length) return json(null, 200);
  const sets = cols.map(c => `"${c.replace(/[^a-zA-Z0-9_]/g, "")}" = ?`).join(", ");
  const vals = cols.map(c => body[c] === undefined ? null : body[c]);
  const sql = `UPDATE "${table}" SET ${sets}${where}`;
  db.prepare(sql).run(...vals, ...params);

  if (returnRow) {
    const selectSql = `SELECT * FROM "${table}"${where}`;
    const rows = db.prepare(selectSql).all(...params);
    return json(rows);
  }
  return json(null, 200);
}

async function handleUpsert(req, table, url, returnRow) {
  const body = await req.json();
  const rows = Array.isArray(body) ? body : [body];
  const conflictCol = url.searchParams.get("on_conflict") || "id";
  const results = [];

  for (const row of rows) {
    if (!row.id && !row[conflictCol]) row.id = generateId();
    const cols = Object.keys(row);
    const safeCols = cols.map(c => `"${c.replace(/[^a-zA-Z0-9_]/g, "")}"`);
    const placeholders = cols.map(() => "?");
    const updates = cols.filter(c => c !== conflictCol).map(c => `"${c.replace(/[^a-zA-Z0-9_]/g, "")}" = excluded."${c.replace(/[^a-zA-Z0-9_]/g, "")}"`);
    const sql = `INSERT INTO "${table}" (${safeCols.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT("${conflictCol}") DO UPDATE SET ${updates.join(", ")}`;
    db.prepare(sql).run(...cols.map(c => row[c] === undefined ? null : row[c]));
    if (returnRow) {
      const inserted = db.prepare(`SELECT * FROM "${table}" WHERE "${conflictCol}" = ?`).get(row[conflictCol] || row.id);
      results.push(inserted);
    }
  }
  return json(returnRow ? results : null, 201);
}

// ── Start ──
const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});
console.log(`Last REST server running on http://localhost:${PORT}`);
