/* ==========================================================================
   OFFLINE REGISTRY CACHE (M6 Part B). Stores a compact registry snapshot in
   IndexedDB (not localStorage — size + it doesn't block the main thread) and
   resolves scans against it with zero signal.

   Asymmetric merge: safety expires, danger is STICKY. A BANNED/SUSPENDED reg-no
   stays dangerous locally even if a later sync omits it or downgrades it — a
   partial sync must never silently clear a danger flag. Anomalies are logged to
   `events`. The verdict itself comes from verdict.js (computeVerdict).
   See SAFETY.md.
   ========================================================================== */
window.Registry = (() => {
  "use strict";

  const DB_NAME = "medaguard";
  const DB_VERSION = 1;
  const STORE = "registry";   // key: normalized reg-no
  const META = "meta";        // key: "bundle" -> { generated_at, checked_at, count }
  const FUZZY_THRESHOLD = 0.82;

  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function tx(store, mode) {
    return openDB().then((db) => db.transaction(store, mode).objectStore(store));
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function getAll(store) { return reqP((await tx(store, "readonly")).getAll()); }
  async function getOne(store, key) { return reqP((await tx(store, "readonly")).get(key)); }
  async function putMany(store, items) {
    const os = await tx(store, "readwrite");
    await Promise.all(items.map((it) => reqP(os.put(it))));
  }

  // ---- Matching (mirrors server src/match.js) -----------------------------
  const normalizeRegNo = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function bigrams(s) {
    const t = String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const out = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  }
  function similarity(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return 0;
    const counts = new Map();
    for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
    let inter = 0;
    for (const g of B) { const c = counts.get(g) || 0; if (c > 0) { inter++; counts.set(g, c - 1); } }
    return (2 * inter) / (A.length + B.length);
  }
  function matchAnchor(candidateStrings, records) {
    const strings = (candidateStrings || []).map((s) => String(s || "")).filter((s) => s.trim());
    if (!strings.length || !records.length) return { tier: 3, record: null, score: 0 };
    const blob = normalizeRegNo(strings.join(" "));
    for (const r of records) {
      const rn = normalizeRegNo(r.registration_no);
      if (rn.length >= 5 && blob.includes(rn)) return { tier: 1, record: r, score: 1 };
    }
    const joined = strings.join(" ");
    let best = { record: null, score: 0 };
    for (const r of records) {
      for (const val of [r.product_name, r.active_ingredient]) {
        if (!val) continue;
        let s = similarity(joined, val);
        for (const c of strings) { const sc = similarity(c, val); if (sc > s) s = sc; }
        if (s > best.score) best = { record: r, score: s };
      }
    }
    if (best.record && best.score >= FUZZY_THRESHOLD) return { tier: 2, record: best.record, score: Number(best.score.toFixed(3)) };
    return { tier: 3, record: null, score: 0 };
  }

  // ---- Bundle merge (sticky danger) ---------------------------------------
  function beaconEvent(type, payload) {
    try {
      const body = JSON.stringify({ type, payload });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/client-event", new Blob([body], { type: "application/json" }));
      else fetch("/api/client-event", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    } catch { /* never break the UI */ }
  }

  async function saveBundle(bundle) {
    if (!bundle || !Array.isArray(bundle.products)) return { saved: 0 };
    const existing = await getAll(STORE);
    // Pure sticky-danger merge (shared with the Node test).
    const { records, anomalies } = window.OfflineVerdict.mergeBundle(existing, bundle);
    for (const a of anomalies) beaconEvent(a.type, a);
    await putMany(STORE, records);
    await putMany(META, [{ id: "bundle", generated_at: bundle.generated_at, checked_at: bundle.checked_at, count: records.length, saved_at: new Date().toISOString() }]);
    return { saved: records.length, anomalies: anomalies.length };
  }

  async function meta() { return getOne(META, "bundle"); }
  async function isEmpty() { return (await getAll(STORE)).length === 0; }

  // ---- Offline verification ------------------------------------------------
  // candidateStrings: OCR lines/tokens, or a single reg-no string.
  async function verifyOffline(candidateStrings, { now = new Date(), staleAfterDays } = {}) {
    const records = await getAll(STORE);
    const match = matchAnchor(Array.isArray(candidateStrings) ? candidateStrings : [candidateStrings], records);
    if (match.tier === 3) {
      // Unknown offline -> UNCONFIRMED, NEVER UNREGISTERED (can't prove counterfeit offline).
      return { matchTier: 3, verdict: window.OfflineVerdict.computeVerdict(null, { now, staleAfterDays }), record: null };
    }
    if (match.tier === 2) {
      return { matchTier: 2, needsConfirmation: true, record: match.record, candidate: {
        registration_no: match.record.registration_no, product_name: match.record.product_name, active_ingredient: match.record.active_ingredient,
      } };
    }
    return { matchTier: 1, record: match.record, verdict: window.OfflineVerdict.computeVerdict(match.record, { now, staleAfterDays }) };
  }

  return { openDB, saveBundle, meta, isEmpty, verifyOffline, matchAnchor, normalizeRegNo, similarity, _store: STORE };
})();
