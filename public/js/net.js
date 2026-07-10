/* ==========================================================================
   MedaGuard reachability (M6 Part A.5) — the ONLY place navigator.onLine is read.
   No other module may read it (grep-enforced).

   navigator.onLine reports whether a network *interface* exists, not whether the
   server is reachable. It reads `false` on working connections and `true` on
   dead 2G — we observed exactly `onLine === false` while every fetch succeeded.
   Getting online/offline wrong here flips UNCONFIRMED <-> UNREGISTERED, the most
   dangerous verdict in the app, in BOTH directions. So:

   Online-ness is determined by REQUEST OUTCOME, never by the flag. We always
   attempt the request with a short timeout: success = online; timeout or network
   error = offline. `navigator.onLine` is exposed only as a non-authoritative UI
   hint. See DECISIONS.md.
   ========================================================================== */
window.Net = (() => {
  "use strict";

  // Reachability timeout (config; keep in sync with server config.reachabilityTimeoutMs).
  const TIMEOUT_MS = 4000;

  // Non-authoritative hint for proactive UI only — NEVER branch a verdict on it.
  function onlineHint() {
    return typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  }

  // Attempt a request; decide online-ness by outcome. Never throws for offline.
  async function request(input, init = {}, { timeout = TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      return { online: true, res }; // reached the server = ONLINE (even a 4xx/5xx)
    } catch (err) {
      return { online: false, error: err }; // timeout / network error = OFFLINE
    } finally {
      clearTimeout(timer);
    }
  }

  // JSON convenience. { online:false } on unreachable; { online:true, data } on OK;
  // { online:true, status } when the server answered with a non-2xx.
  async function requestJSON(input, init, opts) {
    const r = await request(input, init, opts);
    if (!r.online) return { online: false, error: r.error };
    if (!r.res.ok) return { online: true, ok: false, status: r.res.status };
    try {
      return { online: true, ok: true, data: await r.res.json() };
    } catch (err) {
      return { online: true, ok: false, error: err };
    }
  }

  return { request, requestJSON, onlineHint, TIMEOUT_MS };
})();
