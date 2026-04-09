// sw.js — Service worker for Treads of War PWA
// Cache-first strategy; bump CACHE_NAME on every deploy to invalidate old caches

const CACHE_NAME = 'treads-v1';

const PRECACHE = [
  './index.html',
  './css/style.css',
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const url = new URL(event.request.url);
          const ext = url.pathname.split('.').pop();
          if (['html', 'css', 'js', 'json', 'png', 'jpg'].includes(ext)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
        }
        return response;
      }).catch(() => cached);
    })
  );
});
