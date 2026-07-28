// Dailylocke service worker: app-shell precache plus same-origin runtime cache.
//
// Paths are RELATIVE to the worker's own URL, not root-absolute: the game is
// served from a GitHub Pages project subpath (/Dailylocke/), where '/src/...'
// resolves outside the scope and every precache entry 404s -- which fails the
// whole install() and leaves the app permanently uninstallable.
const CACHE_NAME = 'dailylocke-v6';
const SCOPE = new URL('./', self.location).pathname;   // e.g. '/Dailylocke/'
const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'assets/css/app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/pkmn-sim.js',
  'vendor/pkmn-learnsets.js',
  'vendor/three.min.js',
  'vendor/battle-ui.js',
  'vendor/lz-string.min.js',
  'vendor/qrcode.js',
  'src/pokedata.js',
  'src/core.js',
  'src/nuzlocke.js',
  'src/evolution.js',
  'src/mega.js',
  'src/forme.js',
  'src/itemart.js',
  'src/audio.js',
  'src/tooltip.js',
  'src/ui-patch.js',
  'src/battle.js',
  'src/savecode.js',
  'src/safari-compat.js',
  'src/pwa.js',
  'src/app.js'
].map((path) => new URL(path, self.location).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll() is atomic: a single 404 rejects the install and the app is
      // never installable. Cache what we can and let the runtime handler pick
      // up the rest on first use.
      .then((cache) => Promise.all(APP_SHELL.map(
        (url) => cache.add(url).catch((err) => console.warn('[sw] skipped', url, err))
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Prefer fresh HTML, but keep the cached shell as an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(SCOPE)))
    );
    return;
  }

  // Cache-first is fast and deterministic for versioned app assets. New
  // deployments update CACHE_NAME, replacing the complete app shell.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
