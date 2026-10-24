/* Only a fixed, public offline document and app icons enter this cache.
   Authenticated pages, APIs, storage URLs, images and billing are network-only. */
const CACHE = "atelier-public-shell-v1";
const PUBLIC = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
self.addEventListener("install", (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC))); self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))); self.clients.claim(); });
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (PUBLIC.includes(url.pathname) && !url.search) { event.respondWith(caches.match(url.pathname).then((cached) => cached || fetch(event.request))); return; }
  if (event.request.mode === "navigate") event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
});
