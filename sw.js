// Service Worker for DeLaClaw (PWA)
// CACHE_VERSION is updated by the pre-commit hook from VERSION file
const CACHE_VERSION = 'dlc-1.136';

const PRECACHE_URLS = [
  './',
  'index.html',
  'style.css',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon.png',
  'js/adapters/supabase.js',
  'js/adapters/demo.js',
  'js/adapters/offline-cache.js',
  'js/adapters/rest.js',
  'js/birthdays.js',
  'js/habits.js',
  'js/db.js',
  'js/demo-chooser.js',
  'js/demo-data.js',
  'js/flashcards.js',
  'js/hero.js',
  'js/i18n.js',
  'js/icons.js',
  'js/item-utils.js',
  'js/lists.js',
  'js/logo.js',
  'js/main.js',
  'js/projects.js',
  'js/supabase.js',
  'js/todos.js',
  'js/utils.js',
  'js/version.js',
  'js/vestiaire.js',
  'js/welcome.js',
];

// Install: precache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for all requests, cache as fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for Supabase API calls — pass through, don't intercept
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.com')) {
    return;
  }

  // Network-first for all assets (ensures fresh deploys are served immediately)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === 'GET' && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
