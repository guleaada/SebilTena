/* ==========================================================================
   OFFLINE SCAN QUEUE (M6 Part C). Offline scans (and offline CONFIRM
   resolutions) queue in IndexedDB with a client-generated UUID, then flush to
   /api/scans/sync on reconnect. The UUID makes sync IDEMPOTENT — a replay adds
   no duplicate rows. Anonymized: location + product read + verdict only, never
   any identity. The queue is capped; a full queue NEVER blocks a new scan.
   ========================================================================== */
window.Queue = (() => {
  "use strict";
  const DB_NAME = "medaguard-queue"; // separate DB from the registry cache
  const DB_VERSION = 1;
  const STORE = "scans";
  const CAP = 200;

  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "uuid" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function store(mode) { return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE)); }
  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : "u" + Date.now() + Math.random().toString(16).slice(2);
  }

  async function all() { return reqP((await store("readonly")).getAll()); }
  async function count() { return reqP((await store("readonly")).count()); }

  async function enqueue(item) {
    const rec = { uuid: item.uuid || uuid(), created_at: item.created_at || new Date().toISOString(), ...item };
    try {
      const os = await store("readwrite");
      await reqP(os.put(rec));
      trim().catch(() => {}); // fire-and-forget; never blocks the caller
    } catch (e) { console.warn("queue enqueue failed:", e); }
    return rec.uuid;
  }

  // Cap the queue — drop the OLDEST beyond CAP. A full queue never blocks a scan.
  async function trim() {
    const items = await all();
    if (items.length <= CAP) return;
    items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const drop = items.slice(0, items.length - CAP);
    const os = await store("readwrite");
    await Promise.all(drop.map((d) => reqP(os.delete(d.uuid))));
  }

  // Patch a queued item (e.g. record an offline CONFIRM resolution before sync).
  async function update(id, patch) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const os = db.transaction(STORE, "readwrite").objectStore(STORE);
      const g = os.get(id);
      g.onsuccess = () => {
        if (!g.result) return resolve(false);
        const p = os.put({ ...g.result, ...patch });
        p.onsuccess = () => resolve(true);
        p.onerror = () => reject(p.error);
      };
      g.onerror = () => reject(g.error);
    });
  }

  async function remove(uuids) {
    const os = await store("readwrite");
    await Promise.all(uuids.map((u) => reqP(os.delete(u))));
  }

  // Flush to the server (idempotent). Removes flushed items on success; returns
  // any upgrades (offline verdict -> authoritative online verdict). Sends the
  // app-issued write token (M7.5 B) — an expired/absent token yields 401, which
  // the caller handles by re-registering and retrying once. The token is opaque
  // and PII-free; it is never stored with the scans.
  async function flush() {
    const items = await all();
    if (!items.length) return { flushed: 0, upgrades: [] };
    const token = (typeof localStorage !== "undefined" && localStorage.getItem("mg_device_token")) || "";
    const r = await window.Net.requestJSON("/api/scans/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-device-token": token },
      body: JSON.stringify({ scans: items }),
    });
    if (r.online && !r.ok && r.status === 401) return { flushed: 0, tokenExpired: true };
    if (!r.online || !r.ok) return { flushed: 0, offline: true }; // incl. 429 rate-limit -> retry later
    await remove(items.map((i) => i.uuid)); // server is idempotent -> safe to clear
    return { flushed: items.length, upgrades: (r.data && r.data.upgrades) || [] };
  }

  return { enqueue, update, flush, all, count, uuid, CAP };
})();
