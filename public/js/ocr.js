/* ==========================================================================
   CLIENT-SIDE OCR (M6 Part A) — tesseract.js in the browser.

   M2's OCR ran server-side, so scanning needed a network. This runs it locally.
   The worker + wasm core + eng.traineddata are served from OUR origin
   (/vendor/tesseract/) — never a CDN — so they are service-worker cacheable and
   work offline. tesseract also caches the traineddata in IndexedDB, so once the
   ~5MB pack is downloaded it is never re-downloaded (don't restart from zero on
   every app open); a failed warm-up simply retries next time.

   The download happens in the BACKGROUND and NEVER blocks the UI. If it never
   completes, the app still works online. See DECISIONS.md.
   ========================================================================== */
window.OCR = (() => {
  "use strict";
  // ABSOLUTE URL — tesseract's blob worker does importScripts(workerPath), which
  // rejects a root-relative path ("URL invalid"). Must be a full origin URL.
  const BASE = new URL("/vendor/tesseract/", location.href).href;

  let workerP = null;
  let ready = false;
  let progress = 0;
  const listeners = new Set();
  function emit(p) { progress = Math.max(0, Math.min(1, p || 0)); listeners.forEach((f) => { try { f(progress, ready); } catch {} }); }

  function ensureWorker() {
    if (workerP) return workerP;
    if (!window.Tesseract) return Promise.reject(new Error("tesseract not loaded"));
    workerP = window.Tesseract.createWorker("eng", 1, {
      workerPath: BASE + "worker.min.js",
      corePath: BASE,             // dir with tesseract-core*.wasm.js
      langPath: BASE,             // fetches eng.traineddata.gz here
      cacheMethod: "write",       // persist traineddata in IndexedDB
      logger: (m) => { if (typeof m.progress === "number") emit(m.progress); },
    }).then((w) => { ready = true; emit(1); return w; })
      .catch((err) => { workerP = null; throw err; });
    return workerP;
  }

  // Background warm-up. Resolves true once OCR is usable offline, false on failure.
  async function warmUp() {
    try { await ensureWorker(); return true; }
    catch (err) { console.warn("OCR warm-up failed (will retry):", err && err.message); return false; }
  }

  async function recognize(imageDataUrl) {
    const w = await ensureWorker();
    const { data } = await w.recognize(imageDataUrl);
    return (data && data.text) || "";
  }

  return {
    warmUp, recognize,
    isReady: () => ready,
    progress: () => progress,
    onProgress: (cb) => listeners.add(cb),
  };
})();
