// Minimal service worker — its only job is to exist, since a fetch handler
// is one of the browser's requirements for the "Add to Home Screen" /
// install prompt to become available. It doesn't cache anything, so it
// never serves stale content; every request just passes straight through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
