// ===================================================================
// DB ABSTRACTION LAYER
// ===================================================================
// A thin wrapper that delegates to the active adapter.
// The rest of the app imports `db` and calls db.from(), db.channel(),
// db.rpc() — never touching the raw backend SDK directly.
//
// Usage:
//   import db from './db.js';
//   db.setAdapter(someAdapter);     // called once at connect time
//   const { data } = await db.from('projects').select('*');
// ===================================================================

let _adapter = null;
let _pending = 0;

// ── Activity indicator ──────────────────────────────────────────

function getLogo() {
  return document.querySelector('.header-logo');
}

function onStart() {
  _pending++;
  if (_pending === 1) {
    const logo = getLogo();
    if (logo) logo.classList.add('db-busy');
  }
}

function onEnd(error) {
  _pending = Math.max(0, _pending - 1);
  if (_pending === 0) {
    const logo = getLogo();
    if (logo) {
      logo.classList.remove('db-busy');
      if (error) {
        logo.classList.add('db-error');
        setTimeout(() => logo.classList.remove('db-error'), 2000);
      }
    }
  }
}

/**
 * Wrap an adapter query chain in a Proxy so that when the runtime
 * finally awaits it (calls .then()), we track start/end on the logo.
 * Every chained method (.select, .eq, .order …) returns a new proxy
 * so tracking survives across Supabase's multi-object chains.
 */
function tracked(target) {
  let _tracked = false;
  const proxy = new Proxy(target, {
    get(obj, prop) {
      const val = obj[prop];
      if (prop === 'then' && typeof val === 'function') {
        return function (resolve, reject) {
          if (!_tracked) { _tracked = true; onStart(); }
          return val.call(obj,
            (result) => {
              onEnd(result && result.error);
              return resolve ? resolve(result) : result;
            },
            (err) => {
              onEnd(true);
              if (reject) return reject(err);
              throw err;
            }
          );
        };
      }
      if (typeof val === 'function') {
        return function (...args) {
          const next = val.apply(obj, args);
          if (next && typeof next === 'object' && typeof next.then === 'function') {
            // Same object (REST adapter returns `this`) → reuse proxy
            // New object (Supabase returns new builder) → wrap it
            return next === obj ? proxy : tracked(next);
          }
          return next;
        };
      }
      return val;
    }
  });
  return proxy;
}

// ── Public API ──────────────────────────────────────────────────

const db = {
  /** Install a backend adapter (supabase, pocketbase, rest …) */
  setAdapter(adapter) { _adapter = adapter; },

  /** True once an adapter has been installed */
  get connected() { return _adapter !== null; },

  /** Query builder — delegates to adapter.from(table), wrapped for activity tracking */
  from(table) {
    if (!_adapter) throw new Error('db: no adapter set — call db.setAdapter() first');
    return tracked(_adapter.from(table));
  },

  /** Realtime channel (optional — adapter may not support it) */
  channel(name) {
    if (!_adapter?.channel) throw new Error('db: adapter does not support realtime channels');
    return _adapter.channel(name);
  },

  /** Remote procedure call (optional) */
  rpc(fn, params) {
    if (!_adapter?.rpc) throw new Error('db: adapter does not support rpc');
    return _adapter.rpc(fn, params);
  },

};

export default db;
