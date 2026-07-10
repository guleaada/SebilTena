/* ==========================================================================
   OFFLINE VERDICT (M6 Part B) — the asymmetric-caching safety core.

   "Cache pessimistically: safety expires, danger does not."

   | cached status        | offline verdict                                    |
   |----------------------|----------------------------------------------------|
   | banned               | BANNED  — permanent, never downgrades              |
   | suspended            | SUSPENDED — permanent                              |
   | registered, expired  | EXPIRED — re-evaluated vs the device clock         |
   | registered, fresh    | VERIFIED — "verified as of <checked_at>", show dose|
   | registered, stale    | STALE — caution, "check again", NO dose            |
   | (no cached record)   | UNCONFIRMED — handled by the caller, NEVER UNREGISTERED |

   Offline you cannot tell a fake from a stale cache, so counterfeit is an
   ONLINE-ONLY verdict. A wrong/backdated device clock makes records STALE, not
   fresh (fail toward caution). This module is a pure function so it is unit-
   tested in Node (scripts/test-offline.js) against the very same file the
   browser runs. See SAFETY.md.
   ========================================================================== */
window.OfflineVerdict = (function () {
  "use strict";

  const DAY_MS = 86400000;

  function isExpired(expiry, now) {
    if (!expiry) return false;
    const d = new Date(expiry);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() < now.getTime();
  }

  /**
   * @param {object} record cached registry record (or null for "not found")
   * @param {{now:Date, staleAfterDays:number}} opts
   * @returns {{status, offline, checked_at, stale, clockSuspect, showSafety, showDose}}
   */
  function computeVerdict(record, opts) {
    const now = opts.now instanceof Date ? opts.now : new Date(opts.now);
    const staleAfterDays = Number(opts.staleAfterDays);

    // No cached record -> the caller returns UNCONFIRMED (never UNREGISTERED).
    if (!record) {
      return { status: "UNCONFIRMED", offline: true, checked_at: null, stale: false, clockSuspect: false, showSafety: false, showDose: false };
    }

    const base = { offline: true, checked_at: record.checked_at || null, stale: false, clockSuspect: false };

    // Danger is permanent — no staleness, no clock, no downgrade.
    if (record.status === "banned") return { ...base, status: "BANNED", showSafety: false, showDose: false };
    if (record.status === "suspended") return { ...base, status: "SUSPENDED", showSafety: false, showDose: false };

    // Expiry re-evaluated against the device clock every time.
    if (isExpired(record.expiry_date, now)) {
      return { ...base, status: "EXPIRED", showSafety: true, showDose: false };
    }

    // Registered + not expired: apply the staleness / clock rules.
    const checkedAt = record.checked_at ? new Date(record.checked_at) : null;
    const clockSuspect = checkedAt ? now.getTime() < checkedAt.getTime() : true; // clock before checked_at (or unknown) => suspect
    const ageDays = checkedAt ? (now.getTime() - checkedAt.getTime()) / DAY_MS : Infinity;

    if (clockSuspect || ageDays > staleAfterDays) {
      // Fail toward caution: cannot trust freshness -> STALE, no dose.
      return { ...base, status: "STALE", stale: true, clockSuspect, showSafety: true, showDose: false };
    }

    // Fresh -> VERIFIED as of checked_at, dose allowed.
    return { ...base, status: "VERIFIED", showSafety: true, showDose: true };
  }

  const isDanger = (s) => s === "banned" || s === "suspended";
  const normKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  /**
   * Merge an incoming bundle over the existing cached records. Pure (no IO) so
   * it is Node-testable. Danger is STICKY: a locally-known BANNED/SUSPENDED
   * reg-no is never un-banned by a sync that omits or downgrades it. Non-danger
   * records omitted by a sync are left in place (merge, not replace).
   * @returns {{records: object[], anomalies: object[]}}
   */
  function mergeBundle(existingRecords, bundle) {
    const existing = existingRecords || [];
    const byKey = new Map(existing.map((r) => [r.key || normKey(r.registration_no), r]));
    const incomingKeys = new Set();
    const records = [];
    const anomalies = [];

    for (const p of (bundle && bundle.products) || []) {
      const key = normKey(p.registration_no);
      incomingKeys.add(key);
      const prev = byKey.get(key);
      let rec = { ...p, key };
      if (prev && isDanger(prev.status) && !isDanger(rec.status)) {
        anomalies.push({ type: "sticky_ban_kept", registration_no: p.registration_no, wasStatus: prev.status, incomingStatus: rec.status });
        rec = { ...rec, status: prev.status, sticky_danger: true };
      }
      records.push(rec);
    }
    for (const prev of existing) {
      const key = prev.key || normKey(prev.registration_no);
      if (!incomingKeys.has(key) && isDanger(prev.status)) {
        anomalies.push({ type: "sticky_ban_orphan_kept", registration_no: prev.registration_no, status: prev.status });
        records.push({ ...prev, key, sticky_danger: true });
      }
    }
    return { records, anomalies };
  }

  return { computeVerdict, mergeBundle };
})();
