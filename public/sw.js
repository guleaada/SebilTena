/* MedaGuard service worker — app shell + audio (Milestones 3–4).
   Caches the app shell, locale JSON, icons, and the safety-critical audio clips
   (emergency / verdict / route / PPE / hazard) for every AVAILABLE language, so
   the emergency path speaks with zero signal. The currently-used language's
   other clips are cached opportunistically as they play (lean on low-RAM
   phones). The pesticide registry and scan-queue sync are still NOT cached —
   that is M6. API calls are network-first with graceful offline fallback. */
const CACHE = "medaguard-shell-v2";

const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/js/audio.js",
  "/manifest.json",
  "/audio/manifest.json",
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

// Safety-critical clip keys precached for EVERY available language (emergency
// must work offline). Numbers/other clips runtime-cache as used.
const CRITICAL_AUDIO = [
  "verdict_verified", "verdict_banned", "verdict_unregistered", "verdict_expired",
  "verdict_suspended", "verdict_unconfirmed", "verdict_confirm",
  "route_skin", "route_eyes", "route_swallowed", "route_breathed",
  "emergency_title", "emergency_choose_route", "emergency_call_help", "next", "firstaid_intro",
  "wear_this", "dose_is", "point", "days", "wait_before_harvest",
  "ppe_gloves", "ppe_face_mask", "ppe_goggles", "ppe_long_sleeves", "ppe_boots",
  "hazard_Ia", "hazard_Ib", "hazard_II", "hazard_III", "hazard_U",
];

async function precacheAudio(cache) {
  try {
    const manifest = await fetch("/audio/manifest.json").then((r) => r.json());
    const urls = [];
    for (const [lang, keys] of Object.entries(manifest.languages || {})) {
      if (!keys || !keys.length) continue;
      const fmt = (manifest.formats && manifest.formats[lang]) || manifest.format || "mp3";
      for (const key of CRITICAL_AUDIO) {
        if (keys.includes(key)) urls.push(`/audio/${lang}/${encodeURIComponent(key)}.${fmt}`);
      }
    }
    await Promise.allSettled(urls.map((u) => cache.add(u)));
  } catch {
    /* manifest missing -> app still works with icon+colour+text */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await precacheAudio(cache);
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

  // Shell + locales + icons + audio: cache-first, runtime-cache full (200)
  // responses only (never a 206 partial from an audio range request), fall back
  // to the app shell for navigations so deep links open offline.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.status === 200 && url.origin === self.location.origin) {
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
