/* MedaGuard service worker — SHELL CACHE ONLY (Milestone 3).
   Caches the app shell, locale JSON and icons so the UI opens instantly with
   no signal. It does NOT cache the registry or queue scans — that is M6.
   API calls (/api/*) are always network; if offline they fail and the app
   shows a spoken "no connection" state. */
const CACHE = "medaguard-shell-v1";

const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/locales/en.json",
  "/locales/am.json",
  "/locales/om.json",
  "/locales/ti.json",
  "/locales/so.json",
  "/locales/sid.json",
  "/locales/wal.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Add individually so one missing asset can't fail the whole install.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API: network-only. On failure return a JSON error so the app degrades.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ ok: false, offline: true }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  // Shell + locales + icons: cache-first, fall back to network, then to the
  // app shell for navigations (so deep links open offline).
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok && url.origin === self.location.origin) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        if (req.mode === "navigate") return caches.match("/index.html");
        throw new Error("offline and uncached");
      }
    })()
  );
});
