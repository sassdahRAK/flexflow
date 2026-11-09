'use strict';

// FlexFlow app-shell service worker.
// Bump CACHE_NAME whenever the precache list or shell strategy changes.
const CACHE_NAME = 'flexflow-shell-v1';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

const OFFLINE_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE);
    } catch (err) {
      // A single unavailable asset must not brick installation: retry each
      // entry on its own and keep whatever succeeds.
      try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all(PRECACHE.map(async (url) => {
          try {
            await cache.add(url);
          } catch (entryError) {
            // Optional precache entry; ignore.
          }
        }));
      } catch (cacheError) {
        // Cache storage unavailable; still allow the worker to activate.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    } catch (err) {
      // Ignore cache enumeration failures.
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isShellPath(pathname) {
  return pathname === '/' || pathname === '/FlexFlow' || pathname === '/FlexFlow.html';
}

async function handleNavigation(request, url) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      try {
        const cache = await caches.open(CACHE_NAME);
        if (isShellPath(url.pathname)) {
          // Key the app shell at '/' so the offline fallback is predictable.
          await cache.put('/', response.clone());
        } else {
          await cache.put(request, response.clone());
        }
      } catch (err) {
        // Caching is best-effort; the live response still wins.
      }
    }
    return response;
  } catch (err) {
    const shell = await caches.match('/');
    if (shell) return shell;
    const source = await caches.match('/FlexFlow.html');
    if (source) return source;
    return new Response('FlexFlow is offline and its shell is not cached yet.', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: OFFLINE_HEADERS
    });
  }
}

async function handleAsset(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (err) {
    cache = null;
  }

  const cached = cache ? await cache.match(request) : undefined;
  const network = fetch(request)
    .then((response) => {
      if (cache && response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Stale-while-revalidate: return immediately, refresh in the background.
    return cached;
  }

  const fresh = await network;
  if (fresh) return fresh;

  return new Response('', { status: 504, statusText: 'Gateway Timeout' });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request, url));
    return;
  }

  event.respondWith(handleAsset(request));
});
