// Dailylocke service worker: app-shell precache plus bounded runtime caches.
//
// Paths are RELATIVE to the worker's own URL, not root-absolute: the game is
// served from a GitHub Pages project subpath (/Dailylocke/), where '/src/...'
// resolves outside the scope and every precache entry 404s -- which fails the
// whole install() and leaves the app permanently uninstallable.
//
// CACHE OWNERSHIP
//   The Cache API never expires or revalidates anything on its own, and the
//   storage quota is browser-specific, so every cache here is explicitly
//   owned, versioned and BOUNDED:
//
//   dailylocke-shell-<rev>   the app itself. `rev` is generated from the
//                            content of the shell files by tools/build-sw.mjs,
//                            so a deploy that changes any file automatically
//                            gets a new cache and the old one is deleted. No
//                            more hand-incrementing a version number and
//                            shipping stale JS when someone forgets.
//   dailylocke-img-v1        remote sprites/item art, capped at MAX_IMG entries
//   dailylocke-audio-v1      remote cries, capped at MAX_AUDIO entries
//
//   The sprite catalogue is thousands of files and the audio catalogue is
//   hundreds of megabytes; neither is ever precached wholesale. Only what the
//   player actually encountered is kept, and the oldest entries are evicted
//   once the cap is hit.
const CACHE_PREFIX = 'dailylocke-';

// ---- GENERATED: do not edit by hand -------------------------------------
// `npm run build:sw --prefix tools` recomputes this from the shell contents.
const SHELL_REV = 'ddea30c5e014';
// -------------------------------------------------------------------------

const SHELL_CACHE = `${CACHE_PREFIX}shell-${SHELL_REV}`;
const IMG_CACHE = `${CACHE_PREFIX}img-v1`;
const AUDIO_CACHE = `${CACHE_PREFIX}audio-v1`;
const KEEP = new Set([SHELL_CACHE, IMG_CACHE, AUDIO_CACHE]);

// Runtime cache bounds. Generous enough to make a repeat encounter instant,
// small enough that the game never becomes the reason a phone runs out of
// space (an eviction of our whole origin would take the app shell with it).
const MAX_IMG = 360;
const MAX_AUDIO = 60;

const SCOPE = new URL('./', self.location).pathname;   // e.g. '/Dailylocke/'
const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'assets/css/app.css',
  'assets/fonts/vt323-latin-400.woff2',
  'assets/fonts/vt323-latin-ext-400.woff2',
  'assets/img/fallback-sprite.svg',
  'assets/img/fallback-icon.svg',
  'assets/img/fallback-item.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  // Manifest screenshots: the install dialog can be shown offline too.
  'assets/screenshots/narrow-title.png',
  'assets/screenshots/wide-title.png',
  'vendor/pkmn-sim.js',
  'vendor/pkmn-learnsets.js',
  'vendor/three.min.js',
  'vendor/battle-ui.js',
  'src/pokedata.js',
  'src/champions-loader.js',
  'src/champions-learnsets.js',
  'src/core.js',
  'src/storage.js',
  'src/modal.js',
  'src/daily.js',
  'src/nuzlocke.js',
  'src/evolution.js',
  'src/mega.js',
  'src/forme.js',
  'src/itemart.js',
  'src/coach.js',
  'src/audio.js',
  'src/tooltip.js',
  'src/ui-patch.js',
  'src/battle.js',
  'src/savecode.js',
  'src/safari-compat.js',
  'src/pwa.js',
  'src/renderer-loader.js',
  'src/app-loader.js',
  'src/app.js'
].map((path) => new URL(path, self.location).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
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
        keys
          // Only ever delete OUR caches, and only the ones this version has
          // replaced -- the image/audio caches survive a shell update, which
          // is the whole point of keeping them separate.
          .filter((key) => key.startsWith(CACHE_PREFIX) && !KEEP.has(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Keep a cache under its entry cap, evicting oldest-first. Cache.keys()
// resolves in insertion order, so the head of the list is the least recently
// ADDED entry.
async function trim(cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch (err) {
    console.warn('[sw] trim failed', cacheName, err);
  }
}

// Cache-first with a bound. Used for remote sprites and cries: they are
// immutable per URL, so a hit is always correct, and the cap stops the
// catalogue from being hoovered up over a long play session.
async function boundedCacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque (no-cors) responses have status 0 but are still usable as an
  // <img>/<audio> source, so they are worth keeping. They do inflate the
  // quota opaquely, which is exactly why the cap exists.
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone())
      .then(() => trim(cacheName, max))
      .catch(() => {});
  }
  return response;
}

const IMG_HOSTS = new Set(['play.pokemonshowdown.com', 'raw.githubusercontent.com']);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ---- remote assets ------------------------------------------------------
  if (url.origin !== self.location.origin) {
    if (!IMG_HOSTS.has(url.hostname)) return;      // not ours to manage
    const isAudio = /\.(mp3|ogg|wav|m4a)$/i.test(url.pathname);
    const isImage = /\.(png|gif|jpe?g|webp|svg)$/i.test(url.pathname);
    if (!isAudio && !isImage) return;
    event.respondWith(
      boundedCacheFirst(request, isAudio ? AUDIO_CACHE : IMG_CACHE,
                        isAudio ? MAX_AUDIO : MAX_IMG)
        // Offline with nothing cached: fall back to the bundled placeholder so
        // the UI keeps its shape instead of showing a broken-image icon.
        .catch(() => (isImage
          ? caches.match(new URL('assets/img/fallback-sprite.svg', self.location).href)
          : Response.error()))
        .then((r) => r || Response.error())
    );
    return;
  }

  // ---- our own app --------------------------------------------------------
  // Prefer fresh HTML, but keep the cached shell as an offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(SCOPE)))
    );
    return;
  }

  // Cache-first is fast and deterministic for versioned app assets. A deploy
  // changes SHELL_REV, which creates a new cache and drops the old one, so
  // this can never serve last week's JavaScript.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
