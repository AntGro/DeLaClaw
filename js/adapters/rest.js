// ===================================================================
// REST ADAPTER — PostgREST-compatible adapter for the local Bun+SQLite backend
// ===================================================================
// Exposes the same chainable interface: .from().select().eq().order()
// Talks to the local REST server (server/server.js) via plain HTTP.
// ===================================================================

export function createRestAdapter(baseUrl) {
  const adapter = {
    from(table) { return new QueryBuilder(baseUrl, table); },
    channel() { return new NoopChannel(); },
    rpc(fn, params) {
      return fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      }).then(r => r.json()).then(data => ({ data, error: null }))
        .catch(error => ({ data: null, error }));
    },
    /** Batch-update sort_order via individual PATCHes (local latency) */
    async bulkSortOrder(table, updates) {
      if (updates.length === 0) return;
      await Promise.all(
        updates.map(u => adapter.from(table).update({ sort_order: u.sort_order }).eq('id', u.id))
      );
    },
  };
  return adapter;
}

// ── Chainable query builder ──
class QueryBuilder {
  constructor(baseUrl, table) {
    this._baseUrl = baseUrl;
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

  select(_cols) { return this; }

  eq(col, val)  { this._filters.push({ col, op: 'eq',  val }); return this; }
  neq(col, val) { this._filters.push({ col, op: 'neq', val }); return this; }
  gt(col, val)  { this._filters.push({ col, op: 'gt',  val }); return this; }
  gte(col, val) { this._filters.push({ col, op: 'gte', val }); return this; }
  lt(col, val)  { this._filters.push({ col, op: 'lt',  val }); return this; }
  lte(col, val) { this._filters.push({ col, op: 'lte', val }); return this; }
  is(col, val)  { this._filters.push({ col, op: 'is',  val: val === null ? 'null' : val }); return this; }

  order(col, opts) {
    const dir = opts?.ascending === false ? 'desc' : 'asc';
    this._orders.push(`${col}.${dir}`);
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

  // After insert/update, re-enter select mode to return rows
  // PostgREST pattern: .insert({...}).select().single()
  _afterWrite() {
    this._returnRow = true;
    return this;
  }

  // Intercept: if called after insert/update, set return flag
  // The real .select() after .insert() returns the inserted row
  // We override select behavior when _method is not GET
  // This is handled by making select() context-aware:

  // ── Execution ──
  async _execute() {
    const url = new URL(`${this._baseUrl}/rest/v1/${this._table}`);

    // Filters as query params
    for (const f of this._filters) {
      url.searchParams.set(f.col, `${f.op}.${f.val}`);
    }
    if (this._orders.length) url.searchParams.set('order', this._orders.join(','));
    if (this._limitVal != null) url.searchParams.set('limit', String(this._limitVal));
    if (this._onConflict) url.searchParams.set('on_conflict', this._onConflict);

    const headers = { 'Content-Type': 'application/json' };
    if (this._returnRow) headers['Prefer'] = 'return=representation';

    const opts = { method: this._method, headers };
    if (this._body && ['POST', 'PATCH', 'PUT'].includes(this._method)) {
      opts.body = JSON.stringify(this._body);
    }

    try {
      const resp = await fetch(url.toString(), opts);
      if (resp.status === 204) return { data: null, error: null };
      const data = await resp.json();
      if (!resp.ok) return { data: null, error: data.error || data };
      if (this._singleRow && Array.isArray(data)) {
        return { data: data[0] || null, error: null };
      }
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message } };
    }
  }

  // Make thenable so `await db.from('x').select('*')` works
  then(resolve, reject) {
    this._execute().then(resolve, reject);
  }
}

// Override select to be context-aware (after insert/update = return row)
const origSelect = QueryBuilder.prototype.select;
QueryBuilder.prototype.select = function(_cols) {
  if (this._method !== 'GET') {
    this._returnRow = true;
    return this;
  }
  return this;
};

// ── Noop channel for realtime (not supported in local mode) ──
class NoopChannel {
  on() { return this; }
  subscribe() { return this; }
  unsubscribe() { return this; }
}
