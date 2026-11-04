const CACHE_NAME = 'praha-stream-shell-v2.3';
const ARTWORK_CACHE = 'praha-stream-tmdb-artwork-v1';
const MAX_ARTWORK = 120;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith('praha-stream-') && key !== CACHE_NAME && key !== ARTWORK_CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only public TMDB image URLs are cached; never cache API calls, addon
  // requests, credentials, or video streams. Android WebView uses its own HTTP cache.
  if (request.destination === 'image' && url.protocol === 'https:' && url.hostname === 'image.tmdb.org' && url.pathname.startsWith('/t/p/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ARTWORK_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') {
        try {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ARTWORK)).map((key) => cache.delete(key)));
        } catch { /* Playback and browsing do not depend on the cache. */ }
      }
      return response;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (/^\/(sanka|sanka-mirror|sanka-img|anicore|anikura|imdx)(\/|$)/.test(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
