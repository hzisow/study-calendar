/* Recall service worker — offline app shell + notification handling.
 * Bump CACHE when you change cached files so clients pick up the update. */
const CACHE = 'recall-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './ics.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache cross-origin requests (e.g. the Blackbaud CORS proxy) — always go to network.
  if (url.origin !== self.location.origin) return;
  // Cache-first for our own app shell, with a network fallback that refreshes the cache.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Messages from the page tell the SW to show a notification (used by the
// in-app reminder scheduler so notifications survive even when the tab blurs).
self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'notify') {
    self.registration.showNotification(data.title || 'Time to review', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.tag || 'recall-review',
      data: { url: './index.html' },
    });
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
