/* MedaGuard service worker — app shell + audio + offline OCR (M3–M6).
   Precaches the app shell, locale JSON, icons, the offline JS (net/verdict/
   registry/ocr + tesseract), and the safety-critical audio clips for every
   AVAILABLE language. The large tesseract wasm + eng.traineddata.gz and the
   audio clips beyond the critical set runtime-cache on first use (lean install).
   API calls are network-first with graceful offline fallback; the registry is
   cached in IndexedDB by the app (not here). */
const CACHE = "medaguard-shell-v15";

const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/js/net.js",
  "/js/verdict.js",
  "/js/registry.js",
  "/js/queue.js",
  "/js/ocr.js",
  "/vendor/tesseract/tesseract.min.js",
  "/vendor/tesseract/worker.min.js",
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
  "/locales/aa.json",
];

// Safety-critical clip keys precached for EVERY available language (emergency
// must work offline). Numbers/other clips runtime-cache as used.
const CRITICAL_AUDIO = [
  // Verdicts + offline/scanning
  "verdict_verified", "verdict_banned", "verdict_unregistered", "verdict_expired",
  "verdict_unconfirmed", "verdict_confirm", "verdict_offline", "scanning",
  // Emergency chrome + routes (must speak offline)
  "emergency_title", "emergency_ask_route", "emergency_call_help",
  "emergency_next_step", "emergency_stay_calm",
  "route_skin", "route_eyes", "route_swallowed", "route_breathed",
  // Universal first-aid steps (must speak offline)
  "aid_move_air", "aid_remove_clothes", "aid_rinse_skin", "aid_rinse_eyes",
  "aid_do_not_vomit", "aid_no_food_drink", "aid_keep_container", "aid_seek_help", "aid_if_unconscious",
  // Safety
  "wear_protection", "dose_is", "point", "days", "wait_before_harvest",
  "ask_agent", "disclaimer", "crop_not_covered",
  "ppe_gloves", "ppe_mask", "ppe_goggles", "ppe_overall", "ppe_boots",
  "hazard_unlikely", "hazard_low", "hazard_moderate", "hazard_high", "hazard_extreme",
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

  // Emergency bundle: network-first, but cache it and fall back to cache when
  // offline so the poison-control path has its data with zero signal.
  if (url.pathname === "/api/emergency-bundle") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.status === 200) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached || new Response(JSON.stringify({ ok: false, offline: true }), {
            status: 503, headers: { "Content-Type": "application/json" },
          });
        }
      })()
    );
    return;
  }

  // Other API: network-only. On failure return a JSON error so the app degrades.
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
