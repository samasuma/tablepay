// Cache the app shell so pages open instantly on patchy restaurant Wi-Fi.
// API calls always go to the network (bills and payments must be live).
const CACHE = "tablepay-v2";
const SHELL = ["/app.css", "/common.js", "/icon.svg", "/table.html", "/receipt.html"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
);
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // network first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || (url.pathname.startsWith("/t/") ? caches.match("/table.html") : undefined)))
  );
});
