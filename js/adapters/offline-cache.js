// ===================================================================
// OFFLINE CACHE — transparent IndexedDB caching for any adapter
// ===================================================================
// Wraps adapter.from() so every successful .select() response is
// cached in IndexedDB keyed by table name. On network failure,
// cached data is returned and state.offlineMode is set.
//
// New tables are cached automatically — only tables in EXCLUDE are
// skipped. The cache is scoped by backend mode + URL so different
// backends never cross-contaminate.
// ===================================================================

import state from '../state.js';

const EXCLUDE      = new Set(['prompts', 'nvidia_usage']);
const STRIP        = { birthdays: ['avatar_url'] };
const IDB_NAME     = 'dlc-offline';
const IDB_VERSION  = 1;
const STORE        = 'cache';
const TIMEOUT_MS   = 4000;

// ── IndexedDB helpers ───────────────────────────────────────────

let _dbP = null;

function idb() {
  if (!_dbP) {
    _dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  return _dbP;
}

async function put(scope, table, rows) {
  const db = await idb();
  const clean = STRIP[table]
    ? rows.map(r => { const c = { ...r }; for (const f of STRIP[table]) delete c[f]; return c; })
    : rows;
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ rows: clean, ts: Date.now() }, `${scope}:${table}`);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

async function get(scope, table) {
  const db = await idb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).get(`${scope}:${table}`);
  return new Promise(res => {
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => res(null);
  });
}

// ── Network-error detection ─────────────────────────────────────

function isNetErr(err) {
  if (!err) return false;
  const m = String(err.message || err).toLowerCase();
  return m.includes('fetch') || m.includes('network') || m.includes('offline') ||
         m.includes('failed to fetch') || m.includes('load failed') ||
         m.includes('timeout') || m.includes('err_internet') ||
         m.includes('abort') || m.includes('the internet connection appears to be offline');
}

function isPausedErr(err) {
  if (!err) return false;
  const code = err.code || err.status || err.statusCode;
  if (code === 540 || code === '540') return true;
  const m = String(err.message || err).toLowerCase();
  return m.includes('project is paused') || m.includes('540');
}

function browserOffline() {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}

// ── Cache fallback helper ───────────────────────────────────────

async function tryCache(scope, table, onOk) {
  const c = await get(scope, table);
  if (c) {
    // Online but DB unreachable → likely paused project (Supabase shuts down the instance)
    if (!browserOffline()) {
      state.pausedMode = true;
      showPausedBanner();
    } else {
      state.offlineMode = true;
      showBanner(c.ts);
    }
    const fallback = { data: c.rows, error: null };
    return onOk ? onOk(fallback) : fallback;
  }
  return null;
}

// ── Proxy wrapper ───────────────────────────────────────────────

function cacheProxy(target, table, scope, isSelect) {
  let proxy;
  proxy = new Proxy(target, {
    get(obj, prop) {
      // Track .select() → this is a read query
      if (prop === 'select') {
        return (...args) => {
          const next = obj.select(...args);
          return (next === obj) ? cacheProxy(obj, table, scope, true) : cacheProxy(next, table, scope, true);
        };
      }

      // Intercept .then() for caching / fallback
      if (prop === 'then') {
        return (onOk, onErr) => {
          // Write queries: pass through unchanged
          if (!isSelect) {
            return new Promise((resolve, reject) => {
              obj.then(
                (r) => resolve(onOk ? onOk(r) : r),
                (e) => reject(onErr ? onErr(e) : e)
              );
            });
          }

          // Fast path: browser says offline → return cache immediately
          if (browserOffline()) {
            return (async () => {
              const hit = await tryCache(scope, table, onOk);
              if (hit) return hit;
              // No cache, let network attempt run (will fail fast)
              return new Promise((resolve, reject) => {
                obj.then(
                  (r) => resolve(onOk ? onOk(r) : r),
                  (e) => reject(onErr ? onErr(e) : e)
                );
              });
            })();
          }

          // Online path: race network against timeout
          return (async () => {
            const networkP = new Promise((resolve) => {
              obj.then(
                (result) => resolve({ t: 'ok', result }),
                (err)    => resolve({ t: 'err', err })
              );
            });
            const timeoutP = new Promise(r =>
              setTimeout(() => r({ t: 'timeout' }), TIMEOUT_MS)
            );

            const outcome = await Promise.race([networkP, timeoutP]);

            // Network succeeded in time
            if (outcome.t === 'ok') {
              const result = outcome.result;
              // Cache successful selects
              if (Array.isArray(result?.data) && !result.error) {
                try { await put(scope, table, result.data); } catch (_) {}
                // Back online — clear offline/paused banners if showing
                if (state.offlineMode) hideBanner();
                if (state.pausedMode) hidePausedBanner();
              }
              // Project paused (Supabase 540) → show paused banner, try cache
              if (result?.error && isPausedErr(result.error)) {
                if (!state.pausedMode) showPausedBanner();
                const hit = await tryCache(scope, table, onOk);
                if (hit) return hit;
              }
              // Error in response → might be network error wrapped by adapter
              if (result?.error && isNetErr(result.error)) {
                const hit = await tryCache(scope, table, onOk);
                if (hit) return hit;
              }
              return onOk ? onOk(result) : result;
            }

            // Network error or timeout → try cache
            const hit = await tryCache(scope, table, onOk);
            if (hit) return hit;

            // No cache available
            if (outcome.t === 'err') {
              return onErr ? onErr(outcome.err) : Promise.reject(outcome.err);
            }
            // Timeout with no cache → return error object
            const err = { message: 'Network timeout' };
            const result = { data: null, error: err };
            return onOk ? onOk(result) : result;
          })();
        };
      }

      const val = obj[prop];
      if (typeof val === 'function') {
        return (...args) => {
          const next = val.apply(obj, args);
          if (next && typeof next === 'object' && typeof next.then === 'function') {
            return (next === obj) ? proxy : cacheProxy(next, table, scope, isSelect);
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

/**
 * Wrap an adapter so all .select() results are cached in IndexedDB.
 * New tables are included automatically.
 * @param {object} adapter  — any adapter with .from()
 * @param {string} scopeKey — unique cache scope (e.g. 'supabase:projectref')
 */
export function wrapWithOfflineCache(adapter, scopeKey) {
  const origFrom = adapter.from.bind(adapter);
  adapter.from = function (table) {
    const builder = origFrom(table);
    if (EXCLUDE.has(table)) return builder;
    return cacheProxy(builder, table, scopeKey, false);
  };
  return adapter;
}

// ── Offline banner ──────────────────────────────────────────────

function showBanner(ts) {
  if (document.getElementById('offlineBanner')) return;
  const el = document.createElement('div');
  el.id = 'offlineBanner';
  el.className = 'offline-banner';
  const when = ts ? new Date(ts).toLocaleString() : '?';
  el.textContent = `Offline \u2014 read-only \xB7 last synced ${when}`;
  document.body.prepend(el);
  document.body.classList.add('offline-mode');
  requestAnimationFrame(() => {
    document.body.style.setProperty('--offline-banner-h', el.offsetHeight + 'px');
  });
}

function hideBanner() {
  const el = document.getElementById('offlineBanner');
  if (el) el.remove();
  document.body.classList.remove('offline-mode');
  document.body.style.removeProperty('--offline-banner-h');
  state.offlineMode = false;
}

// ── Paused-project banner ───────────────────────────────────────

function _projectRef() {
  const url = state.supabaseUrl || '';
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : null;
}

function showPausedBanner() {
  if (document.getElementById('pausedBanner')) return;
  state.pausedMode = true;
  const el = document.createElement('div');
  el.id = 'pausedBanner';
  el.className = 'paused-banner';
  const ref = _projectRef();
  const link = ref
    ? `https://supabase.com/dashboard/project/${ref}`
    : 'https://supabase.com/dashboard/projects';
  // Safe DOM: no innerHTML with URL interpolation (P0 sec-002)
  el.textContent = '';
  el.appendChild(document.createTextNode(`Can\u2019t reach your database \u2014 it may be paused \xB7 `));
  const a = document.createElement('a');
  a.href = link;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = `Check on Supabase \u2197`;
  el.appendChild(a);
  document.body.prepend(el);
  document.body.classList.add('paused-mode');
  requestAnimationFrame(() => {
    document.body.style.setProperty('--paused-banner-h', el.offsetHeight + 'px');
  });
}

function hidePausedBanner() {
  const el = document.getElementById('pausedBanner');
  if (el) el.remove();
  document.body.classList.remove('paused-mode');
  document.body.style.removeProperty('--paused-banner-h');
  state.pausedMode = false;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', hideBanner);
}
