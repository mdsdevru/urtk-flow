const CACHE_NAME = "urtk-flow-pwa-v8";
const SHELL_ASSETS = [
  "/app/",
  "/app/index.html",
  "/app/app.css?v=8",
  "/app/app.js?v=8",
  "/app/manifest.webmanifest",
  "/app/icons/icon-180.png",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Network-first for API requests and HTML document so updates apply immediately
  if (
    url.pathname.endsWith("/api.php") ||
    event.request.mode === "navigate" ||
    url.pathname === "/app/" ||
    url.pathname.endsWith("/index.html")
  ) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Stale-while-revalidate for App Shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
