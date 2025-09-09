const VERSION = 'v3';
const STATIC_CACHE = `audioplayer-static-${VERSION}`;
const DATA_CACHE = `audioplayer-data-${VERSION}`;
const STATIC_ASSETS = [
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== STATIC_CACHE ? caches.delete(k) : undefined)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Ignore cross-origin requests (let the browser handle them)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations: network-first, fallback to cached index, then offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(STATIC_CACHE);
        cache.put('/index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/offline.html'));
      }
    })());
    return;
  }

  // Cache folder listings and metadata under /music/ with stale-while-revalidate
  if (url.origin === self.location.origin && url.pathname.startsWith('/music/') && req.method === 'GET') {
    const accept = req.headers.get('accept') || '';
    const isHtmlLike = accept.includes('text/html') || accept.includes('application/xhtml+xml');
    if (isHtmlLike) {
      event.respondWith((async () => {
        const cache = await caches.open(DATA_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req).then(res => { cache.put(req, res.clone()); return res; }).catch(() => undefined);
        if (cached) { event.waitUntil(network); return cached; }
        return (await network) || (await caches.open(STATIC_CACHE).then(c => c.match('/offline.html')));
      })());
      return;
    }
  }

  const isStatic = ['style', 'script', 'image', 'font', 'manifest'].includes(req.destination);

  // Same-origin static: cache-first
  if (isStatic) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Audio: network-only to avoid filling cache
  if (req.destination === 'audio' || /\.mp3$/i.test(url.pathname)) {
    event.respondWith(fetch(req));
    return;
  }

  // Default: cache, then network
  event.respondWith(caches.match(req).then((c) => c || fetch(req)));
});

// Focus app when user taps a notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        if ('focus' in client) { await client.focus(); return; }
      } catch {}
    }
    if (self.clients && self.clients.openWindow) {
      await self.clients.openWindow('/index.html');
    }
  })());
});


