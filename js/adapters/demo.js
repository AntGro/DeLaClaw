// ===================================================================
// DEMO ADAPTER — fully in-memory, drop-in for Supabase/REST adapters
// ===================================================================
// All data lives in a plain JS object { tableName: [rows] }.
// Supports the same chainable API: .from().select().eq().insert() etc.
// Nothing persists across page refresh.
// ===================================================================

// CHECK constraints — mirrors Supabase / SQLite schema constraints
const CHECK_CONSTRAINTS = {
  todos:          { priority: ['urgent', 'high', 'medium', 'low', 'normal'] },
  tasks:          { status: ['todo', 'in-progress', 'review', 'approved', 'revision'] },
  flashcard_notes:{ proposal_status: ['pending', 'ready', 'accepted', 'rejected'] },
};

function validateRow(table, row) {
  const constraints = CHECK_CONSTRAINTS[table];
  if (!constraints) return null;
  for (const [col, allowed] of Object.entries(constraints)) {
    if (col in row && !allowed.includes(row[col])) {
      return { message: `CHECK constraint failed: ${table}.${col} must be one of [${allowed.join(', ')}], got "${row[col]}"` };
    }
  }
  return null;
}

export function createDemoAdapter(initialData) {
  const store = {};

  function seed(data) {
    // Clear and re-populate
    for (const key of Object.keys(store)) delete store[key];
    for (const [table, rows] of Object.entries(data || {})) {
      store[table] = JSON.parse(JSON.stringify(rows)); // deep clone
    }
  }

  seed(initialData);

  const adapter = {
    from(table) { return new DemoQueryBuilder(store, table); },
    channel() { return new NoopChannel(); },
    rpc(_fn, _params) { return Promise.resolve({ data: null, error: null }); },
    /** Re-seed all in-memory data (for demo toggle) */
    reseed(data) { seed(data); },
    /** Return a reference to the raw store (for debugging) */
    get _store() { return store; },
  };
  return adapter;
}

// ── Helpers ──
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function now() { return new Date().toISOString(); }

function matchFilter(row, col, op, val) {
  const rv = row[col];
  switch (op) {
    case 'eq':  return String(rv) === String(val);
    case 'neq': return String(rv) !== String(val);
    case 'gt':  return rv > val;
    case 'gte': return rv >= val;
    case 'lt':  return rv < val;
    case 'lte': return rv <= val;
    case 'is':  return val === 'null' ? rv == null : String(rv) === String(val);
    default:    return true;
  }
}

// ── Chainable query builder ──
class DemoQueryBuilder {
  constructor(store, table) {
    this._store = store;
    this._table = table;
    this._filters = [];
    this._orders = [];
    this._limitVal = null;
    this._singleRow = false;
    this._method = 'GET';
    this._body = null;
    this._returnRow = false;
    this._onConflict = null;
  }

  select(_cols) {
    if (this._method !== 'GET') {
      this._returnRow = true;
      return this;
    }
    return this;
  }

  eq(col, val)  { this._filters.push({ col, op: 'eq',  val }); return this; }
  neq(col, val) { this._filters.push({ col, op: 'neq', val }); return this; }
  gt(col, val)  { this._filters.push({ col, op: 'gt',  val }); return this; }
  gte(col, val) { this._filters.push({ col, op: 'gte', val }); return this; }
  lt(col, val)  { this._filters.push({ col, op: 'lt',  val }); return this; }
  lte(col, val) { this._filters.push({ col, op: 'lte', val }); return this; }
  is(col, val)  { this._filters.push({ col, op: 'is',  val: val === null ? 'null' : val }); return this; }

  order(col, opts) {
    const dir = opts?.ascending === false ? 'desc' : 'asc';
    this._orders.push({ col, dir });
    return this;
  }

  limit(n) { this._limitVal = n; return this; }

  single() {
    this._singleRow = true;
    this._limitVal = 1;
    return this;
  }

  insert(data) {
    this._method = 'POST';
    this._body = data;
    return this;
  }

  update(data) {
    this._method = 'PATCH';
    this._body = data;
    return this;
  }

  upsert(data, opts) {
    this._method = 'PUT';
    this._body = data;
    if (opts?.onConflict) this._onConflict = opts.onConflict;
    return this;
  }

  delete() {
    this._method = 'DELETE';
    return this;
  }

  // ── Execution ──
  _execute() {
    const table = this._table;
    if (!this._store[table]) this._store[table] = [];
    const rows = this._store[table];

    try {
      if (this._method === 'GET') {
        return this._doSelect(rows);
      } else if (this._method === 'POST') {
        return this._doInsert(rows);
      } else if (this._method === 'PATCH') {
        return this._doUpdate(rows);
      } else if (this._method === 'PUT') {
        return this._doUpsert(rows);
      } else if (this._method === 'DELETE') {
        return this._doDelete(rows);
      }
    } catch (e) {
      return { data: null, error: { message: e.message } };
    }
  }

  _filtered(rows) {
    return rows.filter(row =>
      this._filters.every(f => matchFilter(row, f.col, f.op, f.val))
    );
  }

  _sorted(rows) {
    if (this._orders.length === 0) return rows;
    const sorted = [...rows];
    sorted.sort((a, b) => {
      for (const { col, dir } of this._orders) {
        const av = a[col], bv = b[col];
        if (av == null && bv == null) continue;
        if (av == null) return dir === 'asc' ? -1 : 1;
        if (bv == null) return dir === 'asc' ? 1 : -1;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
    return sorted;
  }

  _doSelect(rows) {
    let result = this._filtered(rows);
    result = this._sorted(result);
    if (this._limitVal != null) result = result.slice(0, this._limitVal);
    // Return deep clones
    result = result.map(r => ({ ...r }));
    if (this._singleRow) {
      return { data: result[0] || null, error: null };
    }
    return { data: result, error: null };
  }

  _doInsert(rows) {
    const items = Array.isArray(this._body) ? this._body : [this._body];
    const inserted = [];
    for (const item of items) {
      const err = validateRow(this._table, item);
      if (err) return { data: null, error: err };
      const row = { ...item };
      if (!row.id) row.id = uid();
      if (!row.created_at) row.created_at = now();
      if (!row.updated_at) row.updated_at = now();
      rows.push(row);
      inserted.push({ ...row });
    }
    if (this._returnRow) {
      if (this._singleRow) return { data: inserted[0] || null, error: null };
      return { data: inserted, error: null };
    }
    return { data: null, error: null };
  }

  _doUpdate(rows) {
    const err = validateRow(this._table, this._body);
    if (err) return { data: null, error: err };
    const matching = this._filtered(rows);
    const updated = [];
    for (const row of matching) {
      Object.assign(row, this._body);
      if (!this._body.updated_at) row.updated_at = now();
      updated.push({ ...row });
    }
    if (this._returnRow) {
      if (this._singleRow) return { data: updated[0] || null, error: null };
      return { data: updated, error: null };
    }
    return { data: null, error: null };
  }

  _doUpsert(rows) {
    const items = Array.isArray(this._body) ? this._body : [this._body];
    const conflictCol = this._onConflict || 'id';
    const upserted = [];
    for (const item of items) {
      const err = validateRow(this._table, item);
      if (err) return { data: null, error: err };
      const existing = rows.find(r => r[conflictCol] === item[conflictCol]);
      if (existing) {
        Object.assign(existing, item);
        if (!item.updated_at) existing.updated_at = now();
        upserted.push({ ...existing });
      } else {
        const row = { ...item };
        if (!row.id) row.id = uid();
        if (!row.created_at) row.created_at = now();
        if (!row.updated_at) row.updated_at = now();
        rows.push(row);
        upserted.push({ ...row });
      }
    }
    if (this._returnRow) {
      if (this._singleRow) return { data: upserted[0] || null, error: null };
      return { data: upserted, error: null };
    }
    return { data: null, error: null };
  }

  _doDelete(rows) {
    const matching = this._filtered(rows);
    const ids = new Set(matching.map(r => r.id));
    const before = rows.length;
    this._store[this._table] = rows.filter(r => !ids.has(r.id));
    return { data: null, error: null };
  }

  // Make thenable so `await db.from('x').select('*')` works
  then(resolve, reject) {
    try {
      resolve(this._execute());
    } catch (e) {
      reject(e);
    }
  }
}

// ── Noop channel for realtime (not supported in demo mode) ──
class NoopChannel {
  on() { return this; }
  subscribe() { return this; }
  unsubscribe() { return this; }
}
